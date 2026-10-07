// Shared copixel event log: the extension appends, the dashboard reads.
// One JSON object per line. Only sizes, counts, model/tool names and ids are
// logged, never tool output text. Page images are written only when
// COPIXEL_SAVE_IMAGES=1, because they contain the rendered tool output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EVENT_VERSION = 1;
export const IMAGE_KEEP = 200;

export function copixelHome(env = process.env) {
    return env.COPIXEL_HOME || path.join(os.homedir(), ".copixel");
}

export function logPath(env = process.env) {
    return env.COPIXEL_LOG || path.join(copixelHome(env), "events.jsonl");
}

export function imagesDir(env = process.env) {
    return path.join(copixelHome(env), "images");
}

export function saveImagesEnabled(env = process.env) {
    return /^(1|true|yes)$/i.test(env.COPIXEL_SAVE_IMAGES ?? "");
}

function ensurePrivateDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Append one event. Never throws: logging must not break a tool call. */
export function appendEvent(event, env = process.env) {
    try {
        const file = logPath(env);
        ensurePrivateDir(path.dirname(file));
        const line = JSON.stringify({ v: EVENT_VERSION, ts: new Date().toISOString(), ...event }) + "\n";
        fs.appendFileSync(file, line, { mode: 0o600 });
        return true;
    } catch {
        return false;
    }
}

/** Save a PNG page and keep only the newest IMAGE_KEEP files. Returns the file name or null. */
export function saveImage(name, png, env = process.env) {
    if (!/^[\w-]+\.png$/.test(name)) return null;
    try {
        const dir = imagesDir(env);
        ensurePrivateDir(dir);
        fs.writeFileSync(path.join(dir, name), png, { mode: 0o600 });
        const files = fs
            .readdirSync(dir)
            .filter((f) => f.endsWith(".png"))
            .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
        for (const { f } of files.slice(IMAGE_KEEP)) fs.rmSync(path.join(dir, f), { force: true });
        return name;
    } catch {
        return null;
    }
}

/** Parse JSONL text into events, skipping malformed lines. */
export function parseEvents(text) {
    const out = [];
    for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
            const e = JSON.parse(line);
            if (e && typeof e === "object" && typeof e.type === "string") out.push(e);
        } catch {
            // skip partial or corrupt line
        }
    }
    return out;
}

export function readEvents(env = process.env) {
    try {
        return parseEvents(fs.readFileSync(logPath(env), "utf8"));
    } catch {
        return [];
    }
}
