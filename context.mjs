// Shared, per-repository session context for copixel.
// One living summary per repo (git root, or the folder if not in git). Saving
// replaces the current summary with a merged version and keeps older versions.
//
// Layout: $COPIXEL_HOME/contexts/<name>-<hash>/
//   context.md   current summary
//   meta.json    { repo, version, updatedAt, updatedBySession, sessions[], history[] }
//   history/v<N>.md  previous versions (newest CONTEXT_HISTORY_KEEP kept)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { copixelHome } from "./eventlog.mjs";

export const CONTEXT_HISTORY_KEEP = 20;
export const CONTEXT_MAX_CHARS = 60_000;

/** Nearest ancestor containing .git, else the directory itself. */
export function repoRoot(dir) {
    const start = path.resolve(dir || process.cwd());
    for (let d = start; ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, ".git"))) return d;
        if (path.dirname(d) === d) return start;
    }
}

export function contextDir(repo, env = process.env) {
    const name = (path.basename(repo) || "root").replace(/[^\w.-]/g, "_").slice(0, 40);
    const hash = crypto.createHash("sha256").update(repo).digest("hex").slice(0, 10);
    return path.join(copixelHome(env), "contexts", `${name}-${hash}`);
}

function readMeta(dir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    } catch {
        return null;
    }
}

function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
}

/** Current (or a historical) context for the repo containing `cwd`. */
export function loadContext({ cwd, version, env = process.env } = {}) {
    const repo = repoRoot(cwd);
    const dir = contextDir(repo, env);
    const meta = readMeta(dir);
    if (!meta) return { repo, exists: false, version: 0, text: "", meta: null };
    let text;
    if (version && version !== meta.version) {
        if (!/^\d+$/.test(String(version))) throw new Error("version must be a positive integer");
        const file = path.join(dir, "history", `v${Number(version)}.md`);
        if (!fs.existsSync(file)) throw new Error(`version ${version} not found; available: ${meta.history.map((h) => h.version).join(", ") || "none"}`);
        text = fs.readFileSync(file, "utf8");
    } else {
        text = fs.readFileSync(path.join(dir, "context.md"), "utf8");
    }
    return { repo, exists: true, version: Number(version) || meta.version, current: meta.version, text, meta };
}

/**
 * Save the merged summary as the new current version.
 * `baseVersion` must equal the current version (0 if none) so an update is always
 * a merge of what was loaded, never a blind overwrite of someone else's update.
 */
export function saveContext({ cwd, summary, baseVersion, sessionId = "", env = process.env }) {
    const text = String(summary ?? "").trim();
    if (!text) throw new Error("summary is empty");
    if (text.length > CONTEXT_MAX_CHARS) throw new Error(`summary is ${text.length} chars; max ${CONTEXT_MAX_CHARS}. Condense it.`);
    const repo = repoRoot(cwd);
    const dir = contextDir(repo, env);
    fs.mkdirSync(path.join(dir, "history"), { recursive: true, mode: 0o700 });
    const meta = readMeta(dir) ?? { repo, version: 0, sessions: [], history: [] };
    if (Number(baseVersion ?? -1) !== meta.version) {
        throw new Error(
            `context is at version ${meta.version} but base_version was ${baseVersion ?? "missing"}. ` +
                "Call copixel_load_context, merge your new summary into the current text, then save with base_version set to the loaded version.",
        );
    }
    if (meta.version > 0) {
        const prev = path.join(dir, "context.md");
        fs.copyFileSync(prev, path.join(dir, "history", `v${meta.version}.md`));
        meta.history.push({ version: meta.version, updatedAt: meta.updatedAt, chars: fs.statSync(prev).size });
        for (const old of meta.history.splice(0, Math.max(0, meta.history.length - CONTEXT_HISTORY_KEEP))) {
            fs.rmSync(path.join(dir, "history", `v${old.version}.md`), { force: true });
        }
    }
    meta.repo = repo;
    meta.version += 1;
    meta.updatedAt = new Date().toISOString();
    meta.updatedBySession = sessionId;
    if (sessionId && !meta.sessions.includes(sessionId)) meta.sessions.push(sessionId);
    writeAtomic(path.join(dir, "context.md"), text + "\n");
    writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    return { repo, version: meta.version, path: path.join(dir, "context.md"), chars: text.length, historyKept: meta.history.length };
}
