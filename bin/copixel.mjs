#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { copixelHome } from "../eventlog.mjs";
import { extensionDir, install, packageInfo, readInstalled, uninstall } from "../installer.mjs";

const HELP = `copixel ${packageInfo().version} - token-saving Copilot CLI extension

Usage:
  copixel install [--dir <path>] [--force]   install/update the extension in ~/.copilot/extensions/copixel
  copixel uninstall [--dir <path>]           remove the extension (keeps ~/.copixel data)
  copixel dashboard                          start the savings dashboard (http://127.0.0.1:47822/)
  copixel status                             show install and data locations
  copixel --version

After installing, start Copilot with: copilot --experimental`;

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const opt = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
};
const dir = opt("--dir") ? path.resolve(opt("--dir")) : extensionDir();

try {
    switch (cmd) {
        case "install": {
            const before = readInstalled(dir)?.version;
            const r = install({ dir, force: flag("--force") });
            console.log(`copixel ${r.version} ${before ? `updated (was ${before})` : "installed"} in ${r.dir}`);
            console.log("Start Copilot with `copilot --experimental` (or reload extensions in a running session).");
            break;
        }
        case "uninstall": {
            const r = uninstall({ dir });
            console.log(r.removed ? `Removed ${r.dir}. Your data in ${copixelHome()} was kept.` : `Nothing installed at ${r.dir}.`);
            break;
        }
        case "dashboard": {
            const { startServer } = await import("../dashboard/server.mjs");
            startServer();
            break;
        }
        case "status": {
            const inst = readInstalled(dir);
            const home = copixelHome();
            const ctx = path.join(home, "contexts");
            console.log(`package version : ${packageInfo().version}`);
            console.log(`extension dir   : ${dir} ${fs.existsSync(path.join(dir, "extension.mjs")) ? `(installed${inst ? ` v${inst.version}` : ""})` : "(not installed)"}`);
            console.log(`data dir        : ${home}`);
            console.log(`shared contexts : ${fs.existsSync(ctx) ? fs.readdirSync(ctx).length : 0}`);
            break;
        }
        case "-v":
        case "--version":
            console.log(packageInfo().version);
            break;
        case undefined:
        case "-h":
        case "--help":
        case "help":
            console.log(HELP);
            break;
        default:
            console.error(`Unknown command "${cmd}".\n\n${HELP}`);
            process.exitCode = 1;
    }
} catch (err) {
    console.error(`copixel: ${err?.message ?? err}`);
    process.exitCode = 1;
}
