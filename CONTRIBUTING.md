# Contributing

Thanks for looking at this. It is a small, dependency-free project and the aim is to keep it that way: easy to read end to end,
and every claim in the README backed by a test or an honest "not verified".

## Setup

```
git clone https://github.com/rushabh05/finops-dashboard.git && cd finops-dashboard
node --version        # >= 22.13 (node:sqlite without a flag)
npm test              # 143 tests, ~11 s, no install step
npm start             # http://127.0.0.1:8787
```

There is nothing to `npm install`: **no runtime or dev dependencies, and please do not add any.** The standard library covers HTTP, SQLite,
crypto and the test runner; the WebSocket protocol is hand-written in `src/ws.js`.

## Before you open a pull request

1. **`npm test` passes**, and new behaviour has a test. Tests run serially (`--test-concurrency=1`) because several bind sockets and time things.
2. If you touched the streaming layer, **run the suite on more than one Node version and on Linux**. Two real bugs were found only there (see
   "What is verified" in the README). Docker is enough: `docker run --rm -v "$PWD":/app:ro -w /app node:22.13.0-bookworm-slim node --test --test-concurrency=1 "tests/*.test.js"`.
3. If you touched the page, run the browser checks (they need Chrome; set `CHROME_PATH` if it is not in a standard place):
   `node --disable-warning=ExperimentalWarning scripts/ui-smoke.mjs`, `scripts/ui-smoke-imported.mjs <db>` and `scripts/ui-smoke-switcher.mjs`.
   Every URL the page uses must stay **relative** (a test enforces it: the page is also served under `/d/<source>/`).
4. Match the surrounding code: its naming, its comment density, its idioms. Money is **integer micro-dollars**, never floats; SQL is **parameterized**; text from
   data goes to the DOM through `textContent` / `h()`, never `innerHTML`.
5. Update the README where behaviour changes, including the "verified / not verified" lists. Say what you did **not** test.

## Privacy rules (please read)

* **Never commit anything from `data/`.** It is git-ignored; it can hold your own Claude Code usage (project names) and downloaded datasets.
* Screenshots and fixtures may only use the **simulated** sample or **public** datasets. `scripts/screenshots.mjs` is built that way: keep it so.
* The Claude Code importer must keep reading usage metadata only, never message text; `tests/import-claude-code.test.js` has a canary that fails if text leaks.

## Good places to help

* Run `npm run check:llm` with a real API key and report the result (the live Anthropic source has not been exercised; see the README).
* Try other platforms: Windows (the Claude Code importer assumes POSIX paths), Safari and Firefox. CI already covers Linux x86_64 and macOS arm64 on Node 22.13.0, 22.x and 24.x.
* Tell us how the detector behaves on your traffic (`npm run eval:real -- <db>` summarises it): its thresholds were tuned on a simulator, then only observed, not tuned, on BurstGPT.
* Importers for other sources (a gateway's request log, another provider's usage export) following `src/import/`.

## Reporting bugs and security issues

Bugs: open an issue with the Node version, OS, what you ran and what you expected. Security problems: **do not** open a public issue, see [SECURITY.md](SECURITY.md).
