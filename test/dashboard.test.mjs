import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { appendEvent, parseEvents, readEvents, saveImage } from "../eventlog.mjs";
import { buildReport, loadReport, NANO, ratesFromTokenDetails } from "../dashboard/data.mjs";
import { createServer, isAllowedHost } from "../dashboard/server.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copixel-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const envFor = (name) => ({ COPIXEL_HOME: path.join(tmp, name), COPILOT_HOME: path.join(tmp, name, "copilot") });

// claude-opus-5.5-like rates, nano-AIU per 1M tokens
const details = JSON.stringify([
    { batchSize: 1e6, costPerBatch: 4e11, tokenCount: 10, tokenType: "input", model: "m" },
    { batchSize: 1e6, costPerBatch: 2e10, tokenCount: 10, tokenType: "cache_read", model: "m" },
    { batchSize: 1e6, costPerBatch: 5e11, tokenCount: 10, tokenType: "cache_write", model: "m" },
    { batchSize: 1e6, costPerBatch: 2e12, tokenCount: 10, tokenType: "output", model: "m" },
]);

test("ratesFromTokenDetails parses per-token nano-AIU rates", () => {
    const r = ratesFromTokenDetails(details);
    assert.equal(r.input, 4e5);
    assert.equal(r.cache_read, 2e4);
    assert.equal(r.cache_write, 5e5);
    assert.equal(r.output, 2e6);
    assert.equal(ratesFromTokenDetails("not json"), null);
    assert.equal(ratesFromTokenDetails("[]"), null);
});

test("appendEvent/readEvents round-trip and skip corrupt lines", () => {
    const env = envFor("log");
    assert.equal(appendEvent({ type: "imaged", savedTokens: 5 }, env), true);
    fs.appendFileSync(path.join(env.COPIXEL_HOME, "events.jsonl"), "{broken\n\n");
    appendEvent({ type: "skipped" }, env);
    const ev = readEvents(env);
    assert.deepEqual(ev.map((e) => e.type), ["imaged", "skipped"]);
    assert.equal(ev[0].v, 1);
    assert.ok(ev[0].ts);
    assert.equal(fs.statSync(path.join(env.COPIXEL_HOME, "events.jsonl")).mode & 0o777, 0o600);
    assert.deepEqual(parseEvents('{"type":"x"}\n{"no":"type"}\n'), [{ type: "x" }]);
});

test("saveImage rejects unsafe names", () => {
    const env = envFor("img");
    assert.equal(saveImage("../evil.png", Buffer.from("x"), env), null);
    assert.equal(saveImage("a/b.png", Buffer.from("x"), env), null);
    assert.equal(saveImage("ok-1.png", Buffer.from("x"), env), "ok-1.png");
});

function fakeUsage() {
    const rates = { m: ratesFromTokenDetails(details) };
    const sessions = new Map([
        ["s1", { id: "s1", summary: "Session one", repository: "o/r", usage: { calls: 3, nano_aiu: 2 * NANO, models: "m", last_at: "2025-01-01T00:10:00.000Z" } }],
        ["s2", { id: "s2", summary: "No copixel", usage: { calls: 1, nano_aiu: 1 * NANO, models: "m", last_at: "2025-01-02T00:00:00.000Z" } }],
    ]);
    const calls = new Map([["s1", [
        { model: "m", t: "2025-01-01T00:00:00.000Z" },
        { model: "m", t: "2025-01-01T00:02:00.000Z" },
        { model: "m", t: "2025-01-01T00:03:00.000Z" },
        { model: "other", t: "2025-01-01T00:04:00.000Z" },
    ]]]);
    return { available: true, sessions, calls, rates };
}

test("buildReport prices first send + cache re-reads and subtracts get_text", () => {
    const events = [
        { type: "imaged", ts: "2025-01-01T00:01:00.000Z", session: "s1", model: "m", tool: "bash", textTokens: 1200, imageTokens: 150, overheadTokens: 50, savedTokens: 1000, chars: 4800, pages: 1 },
        { type: "get_text", ts: "2025-01-01T00:02:30.000Z", session: "s1", model: "m", tokens: 100 },
        { type: "skipped", ts: "2025-01-01T00:01:30.000Z", session: "s1", model: "m" },
        { type: "unknown", ts: "2025-01-01T00:01:30.000Z", session: "s9" },
    ];
    const r = buildReport({ events, usage: fakeUsage(), usdPerCredit: 0.01, now: new Date("2025-01-02T12:00:00Z") });
    // 1000 tok: write 5e5 nano/tok -> 0.5 AIU -> $0.005; 2 later "m" calls x 2e4 nano/tok -> 0.04 AIU -> $0.0004
    const usd = (aiu) => aiu * 0.01;
    assert.ok(Math.abs(r.totals.usdFirst - (usd(0.5) - usd(0.05))) < 1e-12);
    // get_text: 100 tok, 1 later call -> reread 0.002 AIU
    assert.ok(Math.abs(r.totals.usdReread - (usd(0.04) - usd(0.002))) < 1e-12);
    assert.ok(Math.abs(r.totals.usdNet - r.totals.usdFirst - r.totals.usdReread) < 1e-15);
    assert.equal(r.totals.imaged, 1);
    assert.equal(r.totals.skipped, 1);
    assert.equal(r.totals.netSavedTokens, 900);
    assert.equal(r.totals.imageTokens, 200);
    assert.equal(r.totals.sessionsAll, 2);
    assert.equal(r.totals.sessionsTracked, 1);
    assert.ok(Math.abs(r.totals.allSpendUsd - 0.03) < 1e-12);
    assert.ok(Math.abs(r.totals.trackedSpendUsd - 0.02) < 1e-12);
    const s1 = r.sessions.find((s) => s.id === "s1");
    assert.equal(s1.name, "Session one");
    assert.equal(s1.copixel.savedTokens, 900);
    assert.equal(r.sessions.find((s) => s.id === "s2").copixel, null);
    assert.equal(r.daily.length, 30);
    assert.equal(r.byTool[0].key, "bash");
    assert.equal(r.pricing[0].model, "m");
    assert.ok(Math.abs(r.pricing[0].inputUsdPerM - 4) < 1e-9);
    assert.equal(r.recent.length, 3);
});

test("buildReport falls back for unknown models and empty data", () => {
    const empty = { available: false, sessions: new Map(), calls: new Map(), rates: {} };
    const r = buildReport({ events: [{ type: "imaged", ts: "2025-01-01T00:00:00Z", session: "x", model: "mystery", savedTokens: 1e6 }], usage: empty });
    assert.deepEqual(r.unpricedModels, ["mystery"]);
    assert.ok(r.totals.usdFirst > 0);
    assert.equal(r.sessions[0].id, "x");
    const z = buildReport({ events: [], usage: empty });
    assert.equal(z.totals.usdNet, 0);
    assert.equal(z.sessions.length, 0);
});

test("loadReport reads the real sqlite schema read-only", async (t) => {
    let DatabaseSync;
    try {
        ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
        return t.skip("node:sqlite unavailable");
    }
    const env = envFor("db");
    fs.mkdirSync(env.COPILOT_HOME, { recursive: true });
    const db = new DatabaseSync(path.join(env.COPILOT_HOME, "session-store.db"));
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
             CREATE TABLE assistant_usage_events (id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INT, output_tokens INT,
               cache_read_tokens INT, cache_write_tokens INT, total_nano_aiu INT, token_details_json TEXT, created_at TEXT);`);
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?,?)").run("s1", "/w", "o/r", "main", "", "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z");
    const ins = db.prepare("INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_nano_aiu, token_details_json, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    ins.run("s1", "m", 10, 10, 10, 10, 1e9, details, "2025-01-01T00:00:00Z");
    ins.run("s1", "m", 10, 10, 10, 10, 1e9, details, "2025-01-01T00:05:00Z");
    db.close();
    fs.mkdirSync(path.join(env.COPILOT_HOME, "session-state", "s1"), { recursive: true });
    fs.writeFileSync(path.join(env.COPILOT_HOME, "session-state", "s1", "workspace.yaml"), "id: s1\nname: From workspace\n");
    appendEvent({ type: "imaged", session: "s1", model: "m", savedTokens: 1000, textTokens: 1100 }, env);
    // backdate so the second call counts as a later re-read
    const file = path.join(env.COPIXEL_HOME, "events.jsonl");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/"ts":"[^"]+"/, '"ts":"2025-01-01T00:01:00.000Z"'));

    const r = await loadReport({ env });
    assert.equal(r.sources.usageAvailable, true);
    assert.equal(r.sessions[0].name, "From workspace");
    assert.equal(r.sessions[0].usage.calls, 2);
    assert.ok(Math.abs(r.totals.usdFirst - 0.005) < 1e-12);
    assert.ok(Math.abs(r.totals.usdReread - 0.0002) < 1e-12);
});

test("isAllowedHost only accepts loopback on the right port", () => {
    assert.equal(isAllowedHost("127.0.0.1:47822", 47822), true);
    assert.equal(isAllowedHost("localhost:47822", 47822), true);
    assert.equal(isAllowedHost("[::1]:47822", 47822), true);
    assert.equal(isAllowedHost("localhost", 47822), true);
    assert.equal(isAllowedHost("evil.com:47822", 47822), false);
    assert.equal(isAllowedHost("127.0.0.1:1", 47822), false);
    assert.equal(isAllowedHost(undefined, 47822), false);
});

test("server serves UI, report, images and blocks bad hosts/paths", async () => {
    const env = { ...envFor("srv"), COPIXEL_SESSION_DB: path.join(tmp, "missing.db") };
    appendEvent({ type: "imaged", session: "s", model: "m", savedTokens: 10 }, env);
    saveImage("p1.png", Buffer.from([0x89, 0x50]), env);
    const server = createServer({ env });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    try {
        const html = await fetch(base + "/");
        assert.equal(html.status, 200);
        assert.match(html.headers.get("content-security-policy"), /default-src 'self'/);
        assert.match(await html.text(), /copixel dashboard/);
        const rep = await (await fetch(base + "/api/report.json")).json();
        assert.equal(rep.totals.imaged, 1);
        assert.equal(rep.sources.usageAvailable, false);
        assert.equal((await fetch(base + "/app.js")).status, 200);
        assert.equal((await fetch(base + "/api/image/p1.png")).status, 200);
        assert.equal((await fetch(base + "/api/image/..%2Fevents.jsonl")).status, 404);
        assert.equal((await fetch(base + "/server.mjs")).status, 404);
        assert.equal((await fetch(base + "/", { method: "POST" })).status, 405);
        const bad = await new Promise((resolve) => {
            import("node:http").then(({ request }) => {
                request({ host: "127.0.0.1", port, path: "/api/report.json", headers: { Host: "evil.example" } }, (res) => resolve(res.statusCode)).end();
            });
        });
        assert.equal(bad, 403);
    } finally {
        server.close();
    }
});
