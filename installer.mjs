// Installs copixel into Copilot CLI's user extensions directory.
// The extension folder is a plain copy of the runtime files plus its own
// node_modules, the same layout Copilot loads from a git clone.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_FILES = ["extension.mjs", "eventlog.mjs", "context.mjs"];
export const MARKER = ".copixel-install.json";

export function packageInfo() {
    return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
}

export function extensionDir(env = process.env) {
    return path.join(env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "extensions", "copixel");
}

/** True if `dir` is empty/missing or already holds a copixel install we may overwrite. */
function isOurs(dir) {
    if (!fs.existsSync(dir)) return true;
    if (fs.existsSync(path.join(dir, MARKER))) return true;
    const entries = fs.readdirSync(dir);
    if (!entries.length) return true;
    try {
        return fs.readFileSync(path.join(dir, "extension.mjs"), "utf8").includes("copixel");
    } catch {
        return false;
    }
}

export function readInstalled(dir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8"));
    } catch {
        return null;
    }
}

export function install({ dir = extensionDir(), force = false, skipDeps = false, log = console.log } = {}) {
    if (path.resolve(dir) === PKG_ROOT) throw new Error("target is the package itself");
    if (!force && fs.existsSync(path.join(dir, ".git"))) {
        throw new Error(`${dir} is a git checkout; update it with "git pull && npm install" or pass --force to overwrite.`);
    }
    if (!force && !isOurs(dir)) throw new Error(`${dir} exists and does not look like copixel; pass --force to overwrite.`);
    const pkg = packageInfo();
    fs.mkdirSync(dir, { recursive: true });
    for (const f of RUNTIME_FILES) fs.copyFileSync(path.join(PKG_ROOT, f), path.join(dir, f));
    const extPkg = { name: "copixel-extension", version: pkg.version, private: true, dependencies: pkg.dependencies };
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(extPkg, null, 2) + "\n");
    if (!skipDeps) {
        log(`Installing dependencies in ${dir} ...`);
        const win = process.platform === "win32";
        const r = spawnSync(win ? "npm.cmd" : "npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
            cwd: dir,
            stdio: "inherit",
            shell: win,
        });
        if (r.error || r.status !== 0) throw new Error(`npm install failed in ${dir} (${r.error?.message ?? `exit ${r.status}`})`);
    }
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ version: pkg.version, installedAt: new Date().toISOString() }, null, 2) + "\n");
    return { dir, version: pkg.version };
}

export function uninstall({ dir = extensionDir() } = {}) {
    if (!fs.existsSync(dir)) return { dir, removed: false };
    if (!isOurs(dir) || fs.existsSync(path.join(dir, ".git"))) throw new Error(`${dir} does not look like an npm-installed copixel; remove it manually.`);
    fs.rmSync(dir, { recursive: true, force: true });
    return { dir, removed: true };
}
