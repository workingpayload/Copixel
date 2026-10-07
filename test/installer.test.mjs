import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { install, MARKER, RUNTIME_FILES, readInstalled, uninstall } from "../installer.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "copixel-inst-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const quiet = () => {};

test("install copies runtime files, writes package.json and marker; reinstall updates", () => {
    const dir = path.join(tmp, "ext", "copixel");
    const r = install({ dir, skipDeps: true, log: quiet });
    for (const f of RUNTIME_FILES) assert.ok(fs.existsSync(path.join(dir, f)), f);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.ok(pkg.dependencies["pxpipe-proxy"]);
    assert.equal(pkg.private, true);
    assert.equal(readInstalled(dir).version, r.version);
    fs.writeFileSync(path.join(dir, "extension.mjs"), "stale copixel");
    install({ dir, skipDeps: true, log: quiet });
    assert.notEqual(fs.readFileSync(path.join(dir, "extension.mjs"), "utf8"), "stale copixel");
});

test("install refuses git checkouts and foreign folders unless forced", () => {
    const gitDir = path.join(tmp, "git");
    fs.mkdirSync(path.join(gitDir, ".git"), { recursive: true });
    assert.throws(() => install({ dir: gitDir, skipDeps: true, log: quiet }), /git checkout/);
    const foreign = path.join(tmp, "foreign");
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(foreign, "extension.mjs"), "someone else's extension");
    assert.throws(() => install({ dir: foreign, skipDeps: true, log: quiet }), /does not look like copixel/);
    assert.throws(() => uninstall({ dir: foreign }), /does not look like/);
    install({ dir: foreign, force: true, skipDeps: true, log: quiet });
    assert.ok(fs.existsSync(path.join(foreign, MARKER)));
});

test("uninstall removes only our install", () => {
    const dir = path.join(tmp, "rm");
    install({ dir, skipDeps: true, log: quiet });
    assert.deepEqual(uninstall({ dir }), { dir, removed: true });
    assert.equal(fs.existsSync(dir), false);
    assert.deepEqual(uninstall({ dir }), { dir, removed: false });
});

test("cli prints version and help", () => {
    const bin = fileURLToPath(new URL("../bin/copixel.mjs", import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(execFileSync(process.execPath, [bin, "--version"], { encoding: "utf8" }).trim(), pkg.version);
    assert.match(execFileSync(process.execPath, [bin, "help"], { encoding: "utf8" }), /copixel install/);
});
