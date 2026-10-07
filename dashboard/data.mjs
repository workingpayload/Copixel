// Data layer for the copixel dashboard.
//
// Joins two sources:
//   1. copixel's own event log (~/.copixel/events.jsonl): which tool results were
//      imaged and the estimated text vs image tokens for each.
//   2. Copilot CLI's local session store (~/.copilot/session-store.db), read-only:
//      real per-call usage, AI-credit spend, and per-model token rates.
//
// Dollar savings model (an estimate, shown as such in the UI):
//   An imaged tool result enters the context once (billed at the model's
//   cache-write rate, or the input rate if the model has none) and is then re-read
//   from the prompt cache on every later model call in that session (cache-read
//   rate). Saved $ = savedTokens x (writeRate + laterCalls x readRate).
//   copixel_get_text re-reads add text back, so they are priced the same way and
//   subtracted. Context compaction can drop old results earlier; that is ignored,
//   which makes the re-read part an upper bound.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const NANO = 1e9;
export const DEFAULT_USD_PER_CREDIT = 0.01;
// Used only for models with no rates in the session store.
export const FALLBACK_USD_PER_MTOK = 3;

export function copilotHome(env = process.env) {
    return env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

/** token_details_json -> nano-AIU per token, by token type. */
export function ratesFromTokenDetails(json) {
    let arr;
    try {
        arr = typeof json === "string" ? JSON.parse(json) : json;
    } catch {
        return null;
    }
    if (!Array.isArray(arr)) return null;
    const r = {};
    for (const d of arr) {
        if (!d || !d.batchSize || typeof d.costPerBatch !== "number" || !d.tokenType) continue;
        r[d.tokenType] = d.costPerBatch / d.batchSize;
    }
    return Object.keys(r).length ? r : null;
}

function fallbackRates(usdPerCredit) {
    const input = (FALLBACK_USD_PER_MTOK / usdPerCredit / 1e6) * NANO;
    return { input, cache_read: input * 0.1, cache_write: input * 1.25, output: input * 5, fallback: true };
}

/** Read-only load from Copilot's session store. Returns empty data if unavailable. */
export async function loadUsage({ dbPath, sessionIds = [], env = process.env } = {}) {
    const empty = { available: false, error: null, sessions: new Map(), calls: new Map(), rates: {} };
    const file = dbPath ?? path.join(copilotHome(env), "session-store.db");
    if (!fs.existsSync(file)) return { ...empty, error: `not found: ${file}` };
    let db;
    try {
        const { DatabaseSync } = await import("node:sqlite");
        db = new DatabaseSync(file, { readOnly: true });
        const sessions = new Map();
        for (const s of db.prepare("SELECT id, cwd, repository, branch, summary, created_at, updated_at FROM sessions").all()) {
            sessions.set(s.id, { ...s, usage: null });
        }
        const agg = db.prepare(`
            SELECT session_id, COUNT(*) calls, SUM(input_tokens) input, SUM(output_tokens) output,
                   SUM(cache_read_tokens) cache_read, SUM(cache_write_tokens) cache_write,
                   SUM(total_nano_aiu) nano_aiu, GROUP_CONCAT(DISTINCT model) models,
                   MIN(created_at) first_at, MAX(created_at) last_at
            FROM assistant_usage_events GROUP BY session_id`).all();
        for (const a of agg) {
            const s = sessions.get(a.session_id) ?? { id: a.session_id };
            s.usage = a;
            sessions.set(a.session_id, s);
        }
        const rates = {};
        const rateRows = db.prepare(`
            SELECT model, token_details_json FROM assistant_usage_events
            WHERE token_details_json IS NOT NULL ORDER BY created_at DESC LIMIT 2000`).all();
        for (const row of rateRows) {
            if (rates[row.model]) continue;
            const r = ratesFromTokenDetails(row.token_details_json);
            if (r) rates[row.model] = r;
        }
        const calls = new Map();
        const ids = [...new Set(sessionIds.filter(Boolean))];
        if (ids.length) {
            const stmt = db.prepare(
                `SELECT session_id, model, created_at FROM assistant_usage_events
                 WHERE session_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at`,
            );
            for (const c of stmt.all(...ids)) {
                if (!calls.has(c.session_id)) calls.set(c.session_id, []);
                calls.get(c.session_id).push({ model: c.model, t: c.created_at });
            }
        }
        return { available: true, error: null, sessions, calls, rates };
    } catch (err) {
        return { ...empty, error: String(err?.message ?? err) };
    } finally {
        try {
            db?.close();
        } catch {
            // ignore
        }
    }
}

/** Session display name from ~/.copilot/session-state/<id>/workspace.yaml, if present. */
export function workspaceName(id, env = process.env) {
    if (!/^[\w-]+$/.test(id)) return null;
    try {
        const y = fs.readFileSync(path.join(copilotHome(env), "session-state", id, "workspace.yaml"), "utf8");
        const m = y.match(/^name:\s*(.+)$/m);
        if (!m) return null;
        return m[1].trim().replace(/^['"]|['"]$/g, "");
    } catch {
        return null;
    }
}

const localDay = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleDateString("sv-SE");
};

function bump(map, key, init) {
    if (!map.has(key)) map.set(key, init());
    return map.get(key);
}

/**
 * Pure aggregation. `usage` has the shape returned by loadUsage.
 * `names` optionally maps session id -> display name (workspace.yaml fallback).
 */
export function buildReport({ events, usage, usdPerCredit = DEFAULT_USD_PER_CREDIT, names = new Map(), now = new Date() }) {
    const toUsd = (nanoAiu) => (nanoAiu / NANO) * usdPerCredit;
    const priced = new Set();
    const unpriced = new Set();
    const ratesFor = (model) => {
        const r = usage.rates[model];
        if (r) {
            priced.add(model);
            return r;
        }
        if (model) unpriced.add(model);
        return fallbackRates(usdPerCredit);
    };
    const laterCalls = (session, model, ts) => {
        const list = usage.calls.get(session);
        if (!list) return 0;
        let n = 0;
        for (const c of list) if (c.t > ts && (!model || c.model === model)) n++;
        return n;
    };
    // Value of keeping `tokens` out of (or adding them to) the context at `ts`.
    const valueOf = (e, tokens) => {
        const r = ratesFor(e.model);
        const write = r.cache_write || r.input || 0;
        const later = laterCalls(e.session, e.model, e.ts);
        return { first: toUsd(tokens * write), reread: toUsd(tokens * (r.cache_read || 0) * later), later };
    };

    const totals = {
        imaged: 0, skipped: 0, errors: 0, getTextCalls: 0,
        textTokens: 0, imageTokens: 0, grossSavedTokens: 0, getTextTokens: 0, netSavedTokens: 0,
        usdFirst: 0, usdReread: 0, usdNet: 0, chars: 0, pages: 0,
    };
    const daily = new Map();
    const byModel = new Map();
    const byTool = new Map();
    const perSession = new Map();
    const blankSession = () => ({ imaged: 0, skipped: 0, errors: 0, getTextCalls: 0, savedTokens: 0, textTokens: 0, usdNet: 0, usdFirst: 0, firstTs: null, lastTs: null, cwd: "", models: new Set() });
    const blankGroup = () => ({ imaged: 0, savedTokens: 0, textTokens: 0, usdNet: 0 });
    const recent = [];

    for (const e of events) {
        if (!e || !e.ts) continue;
        if (!["imaged", "get_text", "skipped", "error"].includes(e.type)) continue;
        const s = bump(perSession, e.session || "unknown", blankSession);
        if (!s.firstTs || e.ts < s.firstTs) s.firstTs = e.ts;
        if (!s.lastTs || e.ts > s.lastTs) s.lastTs = e.ts;
        if (e.cwd) s.cwd = e.cwd;
        if (e.model) s.models.add(e.model);
        let usd = 0;
        let tokens = 0;
        if (e.type === "imaged") {
            const imageTok = (e.imageTokens || 0) + (e.overheadTokens || 0);
            tokens = Number.isFinite(e.savedTokens) ? e.savedTokens : (e.textTokens || 0) - imageTok;
            const v = valueOf(e, tokens);
            usd = v.first + v.reread;
            totals.imaged++;
            totals.textTokens += e.textTokens || 0;
            totals.imageTokens += imageTok;
            totals.grossSavedTokens += tokens;
            totals.usdFirst += v.first;
            totals.usdReread += v.reread;
            totals.chars += e.chars || 0;
            totals.pages += e.pages || 0;
            s.imaged++;
            s.savedTokens += tokens;
            s.textTokens += e.textTokens || 0;
            s.usdFirst += v.first;
            for (const g of [bump(byModel, e.model || "unknown", blankGroup), bump(byTool, e.tool || "unknown", blankGroup)]) {
                g.imaged++;
                g.savedTokens += tokens;
                g.textTokens += e.textTokens || 0;
                g.usdNet += usd;
            }
        } else if (e.type === "get_text") {
            tokens = -(e.tokens || 0);
            const v = valueOf(e, e.tokens || 0);
            usd = -(v.first + v.reread);
            totals.getTextCalls++;
            totals.getTextTokens += e.tokens || 0;
            totals.usdFirst -= v.first;
            totals.usdReread -= v.reread;
            s.getTextCalls++;
            s.savedTokens += tokens;
            s.usdFirst -= v.first;
            const g = bump(byModel, e.model || "unknown", blankGroup);
            g.savedTokens += tokens;
            g.usdNet += usd;
        } else if (e.type === "skipped") {
            totals.skipped++;
            s.skipped++;
        } else {
            totals.errors++;
            s.errors++;
        }
        s.usdNet += usd;
        if (tokens || usd) {
            const d = bump(daily, localDay(e.ts), () => ({ savedTokens: 0, usd: 0, imaged: 0 }));
            d.savedTokens += tokens;
            d.usd += usd;
            if (e.type === "imaged") d.imaged++;
        }
        recent.push({
            ts: e.ts, type: e.type, session: e.session || "", model: e.model || "", tool: e.tool || "",
            chars: e.chars || 0, pages: e.pages || 0, textTokens: e.textTokens || 0,
            imageTokens: (e.imageTokens || 0) + (e.overheadTokens || 0), savedTokens: tokens, usd,
            reason: e.reason || e.message || "", image: e.image || null, id: e.id || null,
        });
    }
    totals.netSavedTokens = totals.grossSavedTokens - totals.getTextTokens;
    totals.usdNet = totals.usdFirst + totals.usdReread;

    // Sessions: every Copilot session in the store, plus any only seen in the log.
    const ids = new Set([...usage.sessions.keys(), ...perSession.keys()]);
    const sessions = [];
    let trackedSpendUsd = 0;
    let allSpendUsd = 0;
    for (const id of ids) {
        const meta = usage.sessions.get(id) ?? {};
        const c = perSession.get(id);
        const u = meta.usage;
        const spendUsd = u ? toUsd(u.nano_aiu || 0) : 0;
        allSpendUsd += spendUsd;
        if (c) trackedSpendUsd += spendUsd;
        const lastActive = [c?.lastTs, u?.last_at, meta.updated_at].filter(Boolean).sort().pop() ?? null;
        sessions.push({
            id,
            name: meta.summary || names.get(id) || null,
            repository: meta.repository || null,
            branch: meta.branch || null,
            cwd: meta.cwd || c?.cwd || null,
            createdAt: meta.created_at || c?.firstTs || null,
            lastActive,
            models: [...new Set([...(u?.models ? u.models.split(",") : []), ...(c ? c.models : [])])],
            copixel: c
                ? { imaged: c.imaged, skipped: c.skipped, errors: c.errors, getTextCalls: c.getTextCalls, savedTokens: c.savedTokens, textTokens: c.textTokens, usdFirst: c.usdFirst, usdNet: c.usdNet }
                : null,
            usage: u
                ? { calls: u.calls, inputTokens: u.input || 0, outputTokens: u.output || 0, cacheReadTokens: u.cache_read || 0, cacheWriteTokens: u.cache_write || 0, credits: (u.nano_aiu || 0) / NANO, spendUsd }
                : null,
        });
    }
    sessions.sort((a, b) => String(b.lastActive ?? "").localeCompare(String(a.lastActive ?? "")));

    const days = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const key = d.toLocaleDateString("sv-SE");
        days.push({ date: key, ...(daily.get(key) ?? { savedTokens: 0, usd: 0, imaged: 0 }) });
    }

    const toUsdPerM = (nanoPerTok) => (nanoPerTok / NANO) * 1e6 * usdPerCredit;
    const pricing = Object.entries(usage.rates)
        .map(([model, r]) => ({
            model,
            inputUsdPerM: toUsdPerM(r.input || 0),
            cacheWriteUsdPerM: toUsdPerM(r.cache_write || 0),
            cacheReadUsdPerM: toUsdPerM(r.cache_read || 0),
            outputUsdPerM: toUsdPerM(r.output || 0),
            usedByCopixel: priced.has(model),
        }))
        .sort((a, b) => Number(b.usedByCopixel) - Number(a.usedByCopixel) || a.model.localeCompare(b.model));

    const tracked = sessions.filter((s) => s.copixel);
    const sortGroups = (m) => [...m].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.savedTokens - a.savedTokens);
    return {
        generatedAt: now.toISOString(),
        usdPerCredit,
        totals: {
            ...totals,
            sessionsTracked: tracked.length,
            sessionsAll: sessions.length,
            compressionPct: totals.textTokens ? (totals.netSavedTokens / totals.textTokens) * 100 : 0,
            trackedSpendUsd,
            allSpendUsd,
            // Share of what tracked sessions would have cost without copixel.
            pctOfWouldBeSpend: trackedSpendUsd + totals.usdNet > 0 ? (totals.usdNet / (trackedSpendUsd + totals.usdNet)) * 100 : 0,
        },
        daily: days,
        byModel: sortGroups(byModel),
        byTool: sortGroups(byTool),
        sessions,
        recent: recent.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 100),
        pricing,
        unpricedModels: [...unpriced],
        fallbackUsdPerMTok: FALLBACK_USD_PER_MTOK,
    };
}

/** Load everything from disk and build the report. */
export async function loadReport({ env = process.env, readEvents, now } = {}) {
    const { readEvents: defaultRead } = await import("../eventlog.mjs");
    const events = await (readEvents ?? defaultRead)(env);
    const usdPerCredit = Number(env.COPIXEL_USD_PER_CREDIT) > 0 ? Number(env.COPIXEL_USD_PER_CREDIT) : DEFAULT_USD_PER_CREDIT;
    const sessionIds = [...new Set(events.map((e) => e.session).filter(Boolean))];
    const usage = await loadUsage({ sessionIds, env, dbPath: env.COPIXEL_SESSION_DB || undefined });
    const names = new Map();
    for (const id of new Set([...usage.sessions.keys(), ...sessionIds])) {
        if (usage.sessions.get(id)?.summary) continue;
        const n = workspaceName(id, env);
        if (n) names.set(id, n);
    }
    const report = buildReport({ events, usage, usdPerCredit, names, now });
    report.sources = { usageAvailable: usage.available, usageError: usage.error, events: events.length };
    return report;
}
