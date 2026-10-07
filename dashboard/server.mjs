#!/usr/bin/env node
// copixel dashboard: local-only web UI for copixel savings across all Copilot sessions.
//   npm run dashboard            -> http://127.0.0.1:47822/
// Env: COPIXEL_DASHBOARD_PORT, COPIXEL_DASHBOARD_HOST (default 127.0.0.1),
//      COPIXEL_LOG / COPIXEL_HOME, COPIXEL_USD_PER_CREDIT, COPILOT_HOME, COPIXEL_SESSION_DB.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { imagesDir } from "../eventlog.mjs";
import { loadReport } from "./data.mjs";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const STATIC = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Reject requests whose Host isn't loopback (blocks DNS-rebinding reads). */
export function isAllowedHost(hostHeader, port) {
    if (!hostHeader) return false;
    const m = String(hostHeader).toLowerCase().match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    if (!m) return false;
    if (!LOCAL_HOSTS.has(m[1])) return false;
    return m[2] === undefined || Number(m[2]) === Number(port);
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
    res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
    });
    res.end(body);
}

export function createServer({ env = process.env, port } = {}) {
    return http.createServer(async (req, res) => {
        try {
            const actualPort = port ?? req.socket.localPort;
            if (!isAllowedHost(req.headers.host, actualPort)) return send(res, 403, "forbidden host\n");
            if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed\n");
            const url = new URL(req.url, "http://localhost");
            const p = url.pathname;
            if (STATIC[p]) {
                const [file, type] = STATIC[p];
                return send(res, 200, fs.readFileSync(path.join(PUBLIC, file)), type);
            }
            if (p === "/api/report.json") {
                const report = await loadReport({ env });
                return send(res, 200, JSON.stringify(report), "application/json; charset=utf-8");
            }
            const img = p.match(/^\/api\/image\/([\w-]+\.png)$/);
            if (img) {
                const file = path.join(imagesDir(env), img[1]);
                if (!fs.existsSync(file)) return send(res, 404, "not found\n");
                return send(res, 200, fs.readFileSync(file), "image/png");
            }
            if (p === "/healthz") return send(res, 200, "ok\n");
            return send(res, 404, "not found\n");
        } catch (err) {
            return send(res, 500, `error: ${err?.message ?? err}\n`);
        }
    });
}

export function startServer({ env = process.env } = {}) {
    const port = Number(env.COPIXEL_DASHBOARD_PORT) || 47822;
    const host = env.COPIXEL_DASHBOARD_HOST || "127.0.0.1";
    const server = createServer({ env, port });
    server.on("error", (err) => {
        console.error(`copixel dashboard: ${err.message}`);
        process.exit(1);
    });
    server.listen(port, host, () => {
        console.log(`copixel dashboard: http://${host === "::1" ? "[::1]" : host}:${port}/`);
    });
    return server;
}

const isMain = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url);
if (isMain) startServer();
