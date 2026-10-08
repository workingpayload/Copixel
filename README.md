# Copixel (Copilot CLI extension)

Uses [pxpipe](https://github.com/teamchong/pxpipe) to render large **tool results** as dense PNG pages, so
the model reads a few image pages instead of thousands of text tokens. It runs inside Copilot CLI, so every
request still goes through Copilot under your normal Copilot billing. No BYOK or proxy is involved.

## How it works
- The `onPostToolUse` hook checks each successful tool result of at least `COPIXEL_MIN_CHARS` (default 6000) characters. If the
  current model is on pxpipe's allowlist (default: claude-opus-5.x, claude-fable-5, gemini) and the
  estimated image cost is clearly below the text cost, the hook replaces the text with PNG pages (`binaryResultsForLlm`), a short note, and
  pxpipe's factsheet of exact identifiers.
- The original text is kept in memory (last 50 results). The `copixel_get_text` tool returns it verbatim, optionally by
  line range, so the model can quote exact strings, such as `old_str` for edits.
- `copixel_stats` reports how many results were imaged and an estimate of tokens saved.

## Install
Install from npm:

```sh
npx copixel install          # sets up ~/.copilot/extensions/copixel
copilot --experimental
```

Other commands:
- `npx copixel@latest install` updates an existing install.
- `npx copixel dashboard` opens the savings dashboard.
- `npx copixel status` shows where things are installed.
- `npx copixel uninstall` removes the extension. Your data in `~/.copixel` is kept.

Ask Copilot "show copixel stats" to confirm the extension loaded.

The installer copies the extension files into `~/.copilot/extensions/copixel`, or `$COPILOT_HOME/extensions/copixel` if that variable is set, and runs `npm install` there. It refuses to overwrite a git checkout or another extension unless you pass `--force`.

**From source:** Copilot CLI loads any folder in `~/.copilot/extensions/` that contains an `extension.mjs`, so you can also clone the repo there:

```sh
git clone https://github.com/workingpayload/Copixel.git ~/.copilot/extensions/copixel
cd ~/.copilot/extensions/copixel && npm install --omit=dev    # update: git pull && npm install --omit=dev
```

Requirements: Node 20.19 or newer. The dashboard's spend data needs Node 22.5 or newer.

## Enabling
Extensions are experimental. Start Copilot with `copilot --experimental`, or pass `--experimental` together with `-p`.

## Measured (claude-opus-5.5, one `view` of 300 lines / ~15 KB)
The model received the images and answered correctly. Input tokens fell from 53,633 to 49,966
(~3.7k fewer, about 75% of that tool result). Billing stays on Copilot's normal AI credits.

## Config (env vars)
| Var | Effect |
|---|---|
| `COPIXEL_DISABLE=1` | turn it off |
| `COPIXEL_MIN_CHARS=6000` | minimum result size to image |
| `COPIXEL_MODELS=claude-opus,gpt-5` | override the model allowlist (prefix match) |
| `COPIXEL_SKIP_TOOLS=a,b` | extra tools to never image (edit/create/sql/task/... are always skipped) |
| `COPIXEL_HOME=~/.copixel` | where the event log (and saved images) live |
| `COPIXEL_LOG=<path>` | override the event log file (default `$COPIXEL_HOME/events.jsonl`) |
| `COPIXEL_SAVE_IMAGES=1` | also keep the newest 200 rendered pages so the dashboard can preview them (they contain tool output) |

## Shared session context
copixel keeps one living summary per repository, so separate Copilot sessions can reuse the same context.

- **Summarise / save:** ask "summarise the session using copixel". Copilot then:
  1. calls `copixel_load_context`
  2. merges the new facts into the existing summary
  3. saves it with `copixel_save_context`

  This updates the existing context rather than creating a new one.
- **Use it in another session:** ask "load the copixel context". Contexts are never injected automatically.
- **Safe updates:** a save must pass the `base_version` it loaded. A blind overwrite, or a save based on a version another session has since updated, is rejected.
- **History:** the previous 20 versions are kept. Use `copixel_load_context` with `version: N` to read or restore one.
- **Scope:** the context belongs to the git root, so any subfolder shares it. Outside git, it belongs to the folder.
- **Storage:** files live in `~/.copixel/contexts/<repo>-<hash>/` (`context.md`, `meta.json`, `history/`), with private permissions.
- Context tools are never turned into images, so the summary always stays exact text.

## Dashboard
```sh
npm run dashboard        # http://127.0.0.1:47822/
```
A local web UI, styled after the pxpipe dashboard. It refreshes every 5 seconds and shows:
- dollars saved, net tokens saved, results imaged, compression, and total Copilot spend
- a chart of daily savings for the last 30 days
- every Copilot session (name, repo, last active, models, calls, spend), with copixel's savings per session. You can filter the list and expand a row for details.
- savings by model and by tool, recent activity (imaged, skipped, get_text, errors), and pricing per model

Data sources:
- **copixel's event log** (`~/.copixel/events.jsonl`). The extension writes this. It contains only sizes, counts, ids and model/tool names, never the tool output itself.
- **Copilot's local session store** (`~/.copilot/session-store.db`), opened read-only. It provides real usage, AI-credit spend and per-model token rates.

Requirements:
- Node 22.5+ for `node:sqlite`. Without it the dashboard still runs, but shows only copixel data and uses fallback prices.
- The installed extension must include `eventlog.mjs` so that events get logged.

**How $ saved is estimated:**
- An imaged result counts its saved tokens once, at the model's cache-write rate (or the input rate if there is none).
- It also counts them again, at the cache-read rate, for every later model call with the same model in that session.
- Text pulled back with `copixel_get_text` is priced the same way and subtracted.
- Compaction is ignored, so the re-read part is an upper bound.

| Var | Effect |
|---|---|
| `COPIXEL_DASHBOARD_PORT=47822` | port (binds `127.0.0.1` only; non-loopback `Host` headers are rejected) |
| `COPIXEL_USD_PER_CREDIT=0.01` | USD per Copilot AI credit |
| `COPILOT_HOME` / `COPIXEL_SESSION_DB` | override where the session store is read from |

Run the tests with `npm test`.

## Limits
- Only tool results can be compressed. Copilot's system prompt, tool docs, and history are not reachable from an extension.
- Reading text from images is lossy for exact strings such as hashes and long identifiers. The note and factsheet mitigate this, and
  `copixel_get_text` returns the exact text.
- Savings depend on how Copilot counts image tokens. Run `node measure.mjs` to A/B it with real usage.
  This spends AI credits.
=======

