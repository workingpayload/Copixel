#!/usr/bin/env node
// A/B: run the same prompt with copixel disabled vs enabled and compare Copilot-reported usage.
// NOTE: this makes real Copilot requests and spends AI credits.
// Usage: node measure.mjs [file-to-read] [model]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = path.resolve(process.argv[2] ?? new URL("./node_modules/pxpipe-proxy/dist/core/history.js", import.meta.url).pathname);
const model = process.argv[3] ?? "claude-opus-5.5";
const prompt =
    `Use the view tool exactly once to read ${file} with view_range [1, 300]. ` +
    `Then answer in under 60 words: list the names of the first 5 exported functions or constants. Do not use any other tools.`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pxmeasure-"));

function run(label, disable) {
    const usageFile = path.join(tmp, `${disable ? "off" : "on"}-usage.json`);
    const r = spawnSync(
        "copilot",
        ["-p", prompt, "--model", model, "--allow-all-tools", "--experimental", "--output-format", "json",
            "--no-color", "--usage-output-file", usageFile],
        { env: { ...process.env, COPIXEL_DISABLE: disable ? "1" : "" }, encoding: "utf8", maxBuffer: 1 << 28 },
    );
    fs.writeFileSync(path.join(tmp, `${disable ? "off" : "on"}.jsonl`), r.stdout ?? "");
    let aiu = 0, answer = "", imaged = false;
    for (const line of (r.stdout ?? "").split("\n")) {
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        const d = ev.data ?? {};
        if (ev.type === "session.usage_checkpoint") aiu = Number(d.totalNanoAiu ?? 0) / 1e9;
        if (ev.type === "tool.execution_complete" && line.includes("[copixel:")) imaged = true;
        if (ev.type === "assistant.message" && typeof d.content === "string" && d.content) answer = d.content;
    }
    let usage = {};
    try { usage = JSON.parse(fs.readFileSync(usageFile, "utf8")); } catch {}
    if (r.status !== 0) process.stderr.write(`[${label}] exit ${r.status}: ${r.stderr?.slice(-500)}\n`);
    const u = Object.values(usage.modelMetrics ?? {})[0]?.usage ?? {};
    return { label, imaged, inputTokens: u.inputTokens ?? 0, cacheWriteTokens: u.cacheWriteTokens ?? 0, aiCredits: aiu, usage, answer: answer.slice(0, 160) };
}

const off = run("text (copixel off)", true);
const on = run("images (copixel on)", false);
console.table([off, on].map(({ label, imaged, inputTokens, cacheWriteTokens, aiCredits }) => ({ label, imaged, inputTokens, cacheWriteTokens, aiCredits })));
console.log("\nAnswers:\n-", off.answer, "\n-", on.answer);
if (off.inputTokens && on.inputTokens) {
    console.log(`\nInput tokens: ${off.inputTokens} -> ${on.inputTokens} (${off.inputTokens - on.inputTokens} fewer)`);
}
if (off.aiCredits && on.aiCredits) {
    console.log("Note: AI credits are skewed by prompt caching (the 2nd run reuses the 1st run's cache); compare input tokens.");
    console.log(`\nAI credits: ${off.aiCredits.toFixed(4)} -> ${on.aiCredits.toFixed(4)} (${((1 - on.aiCredits / off.aiCredits) * 100).toFixed(1)}% saved)`);
}
console.log("Raw output:", tmp);
