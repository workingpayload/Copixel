// Extension: copixel
// Renders large tool results as dense PNG pages (via pxpipe) to cut input tokens.
// Runs inside Copilot CLI, so requests still go through Copilot and keep Copilot billing.
//
// Env toggles:
//   COPIXEL_DISABLE=1          turn off
//   COPIXEL_MIN_CHARS=6000     only results at least this long are imaged
//   COPIXEL_MODELS=a,b         model-id prefixes allowed (default: pxpipe's allowlist)
//   COPIXEL_SKIP_TOOLS=x,y     extra tool names to never image
//   COPIXEL_LOG=path           event log for the dashboard (default ~/.copixel/events.jsonl)
//   COPIXEL_SAVE_IMAGES=1      also keep page-1 PNGs for dashboard previews (contains tool output)
//   COPIXEL_HOME=dir           data dir (default ~/.copixel): event log, images, shared contexts/

import { randomUUID } from "node:crypto";
import { joinSession } from "@github/copilot-sdk/extension";
import { CONTEXT_MAX_CHARS, loadContext, saveContext } from "./context.mjs";
import { appendEvent, logPath, saveImage, saveImagesEnabled } from "./eventlog.mjs";

// Never image our own outputs; a lossy picture of the shared context would defeat its purpose.
const SELF_TOOLS = new Set(["copixel_get_text", "copixel_stats", "copixel_load_context", "copixel_save_context"]);
const DEFAULT_SKIP = ["edit", "create", "apply_patch", "ask_user", "sql", "task", "read_agent", "skill"];
const STORE_LIMIT = 50;
// Conservative text estimate (Claude tokenizes code at ~3 chars/token; assume 4) and a safety margin
// on the image side, so we only swap when images are clearly cheaper.
const CHARS_PER_TEXT_TOKEN = 4;
const IMAGE_MARGIN = 1.15;

const env = process.env;
const disabled = /^(1|true|yes)$/i.test(env.COPIXEL_DISABLE ?? "");
const minChars = Math.max(1, parseInt(env.COPIXEL_MIN_CHARS ?? "", 10) || 6000);
const modelPrefixes = (env.COPIXEL_MODELS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const skipTools = new Set([...DEFAULT_SKIP, ...(env.COPIXEL_SKIP_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean)]);

let px; // lazily loaded pxpipe modules
async function pxpipe() {
    if (px) return px;
    const base = new URL("./node_modules/pxpipe-proxy/dist/core/", import.meta.url);
    const [transform, applicability, profiles, cost, facts, render] = await Promise.all([
        import("pxpipe-proxy/transform"),
        import("pxpipe-proxy/applicability"),
        import(new URL("gpt-model-profiles.js", base).href),
        import(new URL("vision-cost.js", base).href),
        import(new URL("factsheet.js", base).href),
        import(new URL("render.js", base).href),
    ]);
    px = {
        renderTextToImages: transform.renderTextToImages,
        isSupported: applicability.isPxpipeSupportedModel,
        resolveProfile: profiles.resolveGptProfile,
        visionTokens: cost.visionTokens,
        factSheetText: facts.factSheetText,
        neutralizeSentinel: render.neutralizeSentinel,
    };
    return px;
}

// Copilot ids use dots for Claude versions (claude-opus-5.5); pxpipe uses dashes (claude-opus-5-5).
function toPxpipeModel(id) {
    const m = String(id ?? "").toLowerCase();
    return m.startsWith("claude-") ? m.replace(/\./g, "-") : m;
}

const store = new Map(); // id -> { toolName, text }
let seq = 0;
const stats = { imaged: 0, skippedUnprofitable: 0, errors: 0, textTokensEst: 0, imageTokensEst: 0 };

function remember(toolName, text) {
    const id = `px${++seq}`;
    store.set(id, { toolName, text });
    while (store.size > STORE_LIMIT) store.delete(store.keys().next().value);
    return id;
}

let session;
// Tool handlers don't get the cwd, so remember the latest one seen by any hook.
let lastCwd = "";
const noteCwd = (input) => {
    if (input?.workingDirectory) lastCwd = input.workingDirectory;
};

async function currentModel() {
    try {
        const r = await session.rpc.model.getCurrent();
        return r?.modelId ?? "";
    } catch {
        return "";
    }
}

async function onPostToolUse(input, invocation) {
    noteCwd(input);
    if (disabled) return;
    const { toolName, toolResult } = input;
    const sessionId = invocation?.sessionId ?? input.sessionId ?? "";
    const cwd = input.workingDirectory ?? "";
    if (!toolResult || SELF_TOOLS.has(toolName) || skipTools.has(toolName)) return;
    if (toolResult.resultType && toolResult.resultType !== "success") return;
    if (toolResult.binaryResultsForLlm?.length) return;
    const text = toolResult.textResultForLlm;
    if (typeof text !== "string" || text.length < minChars) return;

    try {
        const copilotModel = await currentModel();
        const model = toPxpipeModel(copilotModel);
        const p = await pxpipe();
        const allowed = modelPrefixes.length
            ? modelPrefixes.some((pre) => model.startsWith(pre) || copilotModel.toLowerCase().startsWith(pre))
            : p.isSupported(model);
        if (!allowed) return;

        const r = await p.renderTextToImages(p.neutralizeSentinel(text), { model, reflow: true });
        if (!r.pages.length || r.droppedChars > 0) return;

        const profile = p.resolveProfile(model);
        const imageTokens = r.pages.reduce((s, pg) => s + p.visionTokens(profile, pg.width, pg.height), 0);
        const facts = p.factSheetText(text, "compact");
        const textTokens = Math.ceil(text.length / CHARS_PER_TEXT_TOKEN);
        const overheadTokens = Math.ceil((facts.length + 600) / CHARS_PER_TEXT_TOKEN);
        if ((imageTokens + overheadTokens) * IMAGE_MARGIN >= textTokens) {
            stats.skippedUnprofitable++;
            appendEvent({
                type: "skipped", reason: "unprofitable", session: sessionId, cwd, model: copilotModel, tool: toolName,
                chars: text.length, pages: r.pages.length, textTokens, imageTokens: imageTokens + overheadTokens,
            });
            return;
        }

        const id = remember(toolName, text);
        stats.imaged++;
        stats.textTokensEst += textTokens;
        stats.imageTokensEst += imageTokens + overheadTokens;

        const eid = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        const image = saveImagesEnabled() ? saveImage(`${eid}.png`, r.pages[0].png) : null;
        appendEvent({
            type: "imaged", eid, id, session: sessionId, cwd, model: copilotModel, tool: toolName,
            chars: text.length, pages: r.pages.length, width: r.pages[0].width, height: r.pages[0].height,
            textTokens, imageTokens, overheadTokens, savedTokens: textTokens - imageTokens - overheadTokens,
            factsChars: facts.length, ...(image ? { image } : {}),
        });

        const note =
            `[copixel: this ${toolName} output (${text.length} chars) is rendered as ${r.pages.length} image page(s) attached below to save tokens. ` +
            `"↵" in the image marks a newline; indentation is preserved. ` +
            `Image reading is lossy for exact strings: before quoting text verbatim (e.g. edit old_str, hashes, ids), ` +
            `call copixel_get_text with id="${id}" (optionally start_line/end_line) to get the exact original text.]`;

        return {
            modifiedResult: {
                ...toolResult,
                textResultForLlm: facts ? `${note}\n${facts}` : note,
                binaryResultsForLlm: r.pages.map((pg, i) => ({
                    type: "image",
                    mimeType: "image/png",
                    data: Buffer.from(pg.png).toString("base64"),
                    description: `copixel page ${i + 1}/${r.pages.length} of ${toolName} output (${id})`,
                })),
            },
        };
    } catch (err) {
        stats.errors++;
        appendEvent({
            type: "error", session: sessionId, cwd, tool: toolName, chars: text.length,
            message: String(err?.message ?? err).slice(0, 200),
        });
        session?.log(`copixel: render failed, kept text (${err?.message ?? err})`, { level: "warning", ephemeral: true });
    }
}

session = await joinSession({
    hooks: { onPostToolUse, onSessionStart: noteCwd, onUserPromptSubmitted: noteCwd },
    tools: [
        {
            name: "copixel_get_text",
            description:
                "Return the exact original text of a tool result that copixel rendered as images. Use before quoting exact strings (edit old_str, ids, hashes).",
            parameters: {
                type: "object",
                properties: {
                    id: { type: "string", description: 'The copixel id from the tool result note, e.g. "px3".' },
                    start_line: { type: "integer", description: "1-based first line to return (optional)." },
                    end_line: { type: "integer", description: "1-based last line to return, inclusive (optional)." },
                },
                required: ["id"],
            },
            skipPermission: true,
            handler: async ({ id, start_line, end_line }, invocation) => {
                const entry = store.get(id);
                if (!entry) return `Unknown or expired copixel id "${id}". Re-run the original tool with a narrower range.`;
                let out = entry.text;
                if (start_line || end_line) {
                    const lines = entry.text.split("\n");
                    const s = Math.max(1, start_line ?? 1);
                    const e = Math.min(lines.length, end_line ?? lines.length);
                    out = lines.slice(s - 1, e).join("\n");
                }
                // Re-reading text gives back part of the saving; the dashboard nets it out.
                appendEvent({
                    type: "get_text", id, session: invocation?.sessionId ?? "", model: await currentModel(),
                    tool: entry.toolName, chars: out.length, tokens: Math.ceil(out.length / CHARS_PER_TEXT_TOKEN),
                });
                return out;
            },
        },
        {
            name: "copixel_stats",
            description: "Show copixel statistics for this session (results imaged, estimated tokens saved).",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () =>
                JSON.stringify(
                    {
                        enabled: !disabled,
                        minChars,
                        currentModel: await currentModel(),
                        ...stats,
                        estimatedTokensSaved: stats.textTokensEst - stats.imageTokensEst,
                        eventLog: logPath(),
                        note: "Estimates only (text ≈ chars/4). Check real usage with /usage. Full history: `npm run dashboard` in the copixel repo.",
                    },
                    null,
                    2,
                ),
        },
        {
            name: "copixel_load_context",
            description:
                "Load the shared context summary for this repository, saved by earlier Copilot sessions. Use when the user asks to load/use/recall " +
                "the saved or previous session context, and ALWAYS before copixel_save_context so the update merges with the existing text.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "Directory inside the repo (optional; defaults to the session's working directory)." },
                    version: { type: "integer", description: "Load an older version instead of the current one (optional)." },
                },
            },
            skipPermission: true,
            handler: async ({ path: dir, version }, invocation) => {
                try {
                    const c = loadContext({ cwd: dir || lastCwd || process.cwd(), version });
                    appendEvent({ type: "context_load", session: invocation?.sessionId ?? "", repo: c.repo, version: c.version, chars: c.text.length });
                    if (!c.exists) {
                        return `No saved context for ${c.repo} yet. To create one, call copixel_save_context with base_version=0.`;
                    }
                    const older = c.meta.history.map((h) => `v${h.version}`).join(", ") || "none";
                    return [
                        `[copixel context for ${c.repo} | version ${c.version}${c.version !== c.current ? ` (current is ${c.current})` : ""} | ` +
                            `updated ${c.meta.updatedAt} | ${c.meta.sessions.length} session(s) contributed | older versions: ${older}]`,
                        `[To update: merge new information into this text, then call copixel_save_context with base_version=${c.current}.]`,
                        "",
                        c.text,
                    ].join("\n");
                } catch (err) {
                    return `copixel_load_context failed: ${err?.message ?? err}`;
                }
            },
        },
        {
            name: "copixel_save_context",
            description:
                "Save the shared context summary for this repository so other sessions can load it. Use when the user asks to summarise/save " +
                "the session context. It UPDATES the existing summary: first call copixel_load_context, merge this session's new facts into the " +
                "loaded text (keep still-valid content, update changed facts, drop obsolete items), then pass the full merged summary here. " +
                "The previous version is kept in history. Write concise Markdown: goal, current state, key decisions, important files, open next steps.",
            parameters: {
                type: "object",
                properties: {
                    summary: { type: "string", description: `Full merged Markdown summary (max ${CONTEXT_MAX_CHARS} chars). Replaces the current text.` },
                    base_version: { type: "integer", description: "Version returned by copixel_load_context (0 if there was no saved context)." },
                    path: { type: "string", description: "Directory inside the repo (optional; defaults to the session's working directory)." },
                },
                required: ["summary", "base_version"],
            },
            handler: async ({ summary, base_version, path: dir }, invocation) => {
                try {
                    const sessionId = invocation?.sessionId ?? "";
                    const r = saveContext({ cwd: dir || lastCwd || process.cwd(), summary, baseVersion: base_version, sessionId });
                    appendEvent({ type: "context_save", session: sessionId, repo: r.repo, version: r.version, chars: r.chars });
                    return `Saved context v${r.version} for ${r.repo} (${r.chars} chars) at ${r.path}. ${r.historyKept} older version(s) kept. ` +
                        "Other sessions in this repo can load it with copixel_load_context.";
                } catch (err) {
                    return `copixel_save_context failed: ${err?.message ?? err}`;
                }
            },
        },
    ],
});
