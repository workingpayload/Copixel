import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CONTEXT_HISTORY_KEEP, contextDir, loadContext, repoRoot, saveContext } from "../context.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copixel-ctx-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function setup(name) {
    const env = { COPIXEL_HOME: path.join(tmp, name, "home") };
    const repo = path.join(tmp, name, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    return { env, repo };
}

test("repoRoot finds the git root from a subfolder, else uses the folder", () => {
    const { repo } = setup("root");
    assert.equal(repoRoot(path.join(repo, "src", "deep")), repo);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "copixel-plain-"));
    try {
        assert.equal(repoRoot(plain), plain);
    } finally {
        fs.rmSync(plain, { recursive: true, force: true });
    }
});

test("save creates v1, then updates in place and shares across subfolders", () => {
    const { env, repo } = setup("update");
    assert.equal(loadContext({ cwd: repo, env }).exists, false);
    const a = saveContext({ cwd: repo, summary: "first", baseVersion: 0, sessionId: "s1", env });
    assert.equal(a.version, 1);
    const b = saveContext({ cwd: path.join(repo, "src"), summary: "first + second", baseVersion: 1, sessionId: "s2", env });
    assert.equal(b.version, 2);
    assert.equal(b.path, a.path);
    const cur = loadContext({ cwd: path.join(repo, "src", "deep"), env });
    assert.equal(cur.text.trim(), "first + second");
    assert.deepEqual(cur.meta.sessions, ["s1", "s2"]);
    assert.equal(loadContext({ cwd: repo, version: 1, env }).text.trim(), "first");
    assert.equal(fs.statSync(path.join(contextDir(repo, env), "context.md")).mode & 0o777, 0o600);
});

test("save rejects stale or missing base_version and empty/oversized summaries", () => {
    const { env, repo } = setup("conflict");
    saveContext({ cwd: repo, summary: "v1", baseVersion: 0, env });
    assert.throws(() => saveContext({ cwd: repo, summary: "blind", baseVersion: 0, env }), /version 1/);
    assert.throws(() => saveContext({ cwd: repo, summary: "blind", env }), /missing/);
    assert.throws(() => saveContext({ cwd: repo, summary: "  ", baseVersion: 1, env }), /empty/);
    assert.throws(() => saveContext({ cwd: repo, summary: "x".repeat(70_000), baseVersion: 1, env }), /max/);
    assert.equal(loadContext({ cwd: repo, env }).text.trim(), "v1");
    assert.throws(() => loadContext({ cwd: repo, version: 99, env }), /not found/);
});

test("history keeps only the newest versions", () => {
    const { env, repo } = setup("history");
    const n = CONTEXT_HISTORY_KEEP + 5;
    for (let i = 0; i < n; i++) saveContext({ cwd: repo, summary: `v${i + 1}`, baseVersion: i, env });
    const c = loadContext({ cwd: repo, env });
    assert.equal(c.version, n);
    assert.equal(c.meta.history.length, CONTEXT_HISTORY_KEEP);
    assert.equal(fs.readdirSync(path.join(contextDir(repo, env), "history")).length, CONTEXT_HISTORY_KEEP);
    assert.equal(c.meta.history[0].version, n - CONTEXT_HISTORY_KEEP);
});

test("different repos get separate contexts", () => {
    const one = setup("sepA");
    const two = setup("sepB");
    const env = one.env;
    saveContext({ cwd: one.repo, summary: "A", baseVersion: 0, env });
    assert.equal(loadContext({ cwd: two.repo, env }).exists, false);
});
