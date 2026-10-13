# Changelog

## 1.2.0 - 2026-10-13

* **`finops proxy` records OpenAI, DeepSeek, OpenRouter and any OpenAI-compatible gateway, and can tell API keys apart.** `--provider openai|deepseek|openrouter|NAME=URL` (repeatable) adds a route under its own prefix
  (`/openai/v1`, `/deepseek`, `/openrouter/api/v1`, `/NAME`) with its own fixed upstream; Anthropic stays at the root, unchanged. Chat-completion and Responses calls are recorded, streamed or not (`src/providers.js`).
  **Cost**: OpenRouter's own per-call `usage.cost` (a bring-your-own-key call adds `upstream_inference_cost`: an assumption, flagged); OpenAI and DeepSeek at list prices (read from their pricing pages on 2026-10-13; DeepSeek's peak hours
  cost double and are applied, Chinese holidays are not known); any other gateway through `--price`, or its own cost if you pass `--reported-cost NAME`. A model with no price is never guessed: the request is recorded without cost, named once in the log
  and counted. `--tenant-by-key [--key-map FILE]` makes each API key a tenant, named by a one-way label (`key-` + 40 bits of SHA-256); `finops key-label` prints a key's label from stdin. Keys are hashed in memory, never stored or logged (a test greps
  the database files, the log and the health endpoint). **Tested against fakes that follow the providers' documented formats, not the real services.**
* **A call can supply its own cost** (`cost_micro_usd` on an `llm_calls` item of `POST /api/ingest`): no `model_prices` row needed, stored as it came, marked `cost_source = 'supplied'` (new column, added to older databases with a default).
  Bounded to $1000 per call. Model names may now contain `/` (`openai/gpt-4o`). The request drill-down says where a supplied cost came from.
* **`finops import fastrouter`: FastRouter's past requests** (`scripts/import-fastrouter.js`, `src/import/fastrouter.js`). FastRouter documents no call that lists past usage, so history comes from what you have: `--ids FILE` looks each request id up with `POST /api/v1/generation` (needs `FASTROUTER_API_KEY`;
  retries, resumable with `--append`, stops at once on a refused key), `--file EXPORT` reads an Activity Log export (CSV / JSON / JSON lines) with columns matched by name, `--map` and `--check`. Cost is FastRouter's own `usage.cost` (USD; `credits_used` and any credits column are never used, their unit is undocumented);
  keys are hashed labels; prompts and completions (which the generation API returns) are never kept; alerts are not computed. `createImportDb` gains `append`. **Tested against a fake that follows the docs and made-up exports, not the real FastRouter.**
* 25 new tests (`tests/providers.test.js`, `tests/proxy-providers.test.js`, two real-process CLI tests): 214 in all, plus 13 for the FastRouter importer (`tests/import-fastrouter.test.js`): 227. Checked by mutation: 20 deliberate breakages of the proxy code (and 22 of the FastRouter importer, one of which survived and got an assertion), every one now caught by a test. Two survived the first round and exposed real gaps (no test sent a Responses API call; none checked that a supplied cost on a model the table *does* price is not shown as table-priced), and got tests; a third survivor was my mutation doing nothing, rewritten and caught. The run also exposed a flaky test of mine (it failed 12 times in 40 runs: rows read back by timestamp tied within one millisecond), now 0 in 40.

## 1.1.0 - 2026-10-13

* **CI runs on Windows too** (`windows-latest`, Node 22.13.0 / 22.x / 24.x): the whole suite passes. The graceful-stop assertions are platform-aware (Windows has no SIGTERM). Found and fixed on the way: proxy tests leaked database handles (`EBUSY` on cleanup), a real-process test asserted on a stdout line the moment the line before it arrived, and the importer tests read process output on `exit` instead of `close`.
* **`finops import anthropic-usage`**: your organization's token usage from Anthropic's Usage & Cost Admin API (needs an Admin API key; individual accounts have none), by workspace (or API key / account / service account) and model, priced at list prices,
  with a check against what Anthropic billed (cost report, cents) per model and tier. Aggregated data: one row per hour and group, not per API call, and labelled as such (no detection is run). A model and its dated alias are merged into one group
  (two rows with one id would have let ingest drop one silently: found by the unit test). **Tested against a fake Admin API that follows the documentation, not the real one.**
* **Docker image** (`Dockerfile`, `.dockerignore`, `scripts/docker-smoke.sh`, a `docker` CI job). `finops` is the entry point; runs as the unprivileged `node` user; data in `/data`; a `HEALTHCHECK`. `AUTH_TOKEN` is required (the server refuses
  `0.0.0.0` without it, and the image sets no insecure default); `.dockerignore` keeps `data/` (gigabytes of local databases) out of the build context. The smoke script is run by CI and checks 11 things, including the Host-header refusal.
* **`finops proxy`: live cost tracking.** A local proxy (`src/proxy.js`) for the Anthropic Messages API: point `ANTHROPIC_BASE_URL` at it and every call's tenant, endpoint, status, duration, model and token counts
  (never prompts, answers, headers or keys) is recorded into a `live` database of the dashboard through its ordinary ingest endpoint. Streaming and compressed responses, failures (429/5xx/529) and client aborts (499) are
  recorded; the usage mapping is the Claude Code importer's own function; unpriced models are named and counted without losing their batch. Safety: fixed upstream (a request path cannot pick another host), loopback only,
  refuses the simulated sample database, https for anything remote. 15 new tests plus two real-process tests, checked by mutation. **Tested against a fake Anthropic API, not the real one.**
* **Alert notifications.** `ALERT_WEBHOOK_URL` posts every new alert to Slack, Discord or any JSON endpoint (`src/notify.js`); `finops check-webhook` sends a test message. Simulated alerts never notify
  (decided at run time: configured to simulate, or the simulator has written to the database) unless `ALERT_WEBHOOK_SIMULATED=1`. The URL is treated as a secret (never logged, never in `/api/stats`, https required except for
  localhost, redirects not followed), delivery is asynchronous with a timeout, one retry and a bounded queue. `/api/stats` gains a `webhook` block. 12 new tests (`tests/notify.test.js`), checked by mutation.
* **The `finops` command** (`bin/finops.js`): `finops start [--open]`, `finops import claude-code`, `finops import trace`, `finops check-llm`. Runs from a clone, installed
  (`npm install -g github:rushabh05/finops-dashboard`) or with no install (`npx github:rushabh05/finops-dashboard start --open`). It keeps databases in `--data-dir`, else `$DATA_DIR`, else
  `~/.finops-dashboard` (mode 700) so imports survive an npx cache; `npm start` is unchanged. The importers now honour `DATA_DIR` too, and print hints that match how they were launched.
  `package.json` gains `bin` and `files` (a 136 KB package: no media, databases or tests). New: `tests/finops-bin.test.js` (4 tests).
* **Film: removed the oval.** The product film had a full-frame elliptical vignette, a blue halo behind the logo and an orange disc behind the cost spike; all three read as a big
  oval/circle on the background. The ground is now flat; the spike is picked out by a tight outline that hugs the tallest bar. Re-encoded (25 MB, was 37 MB).
* Two flaky tests, found by CI on the film commit. `cli.test.js` asserted a stdout line the moment the line before it arrived (the CI log shows the output holding only the first line); it now waits for the line.
  The live-simulator e2e test timed out once on Linux / Node 22.13.0. It did not reproduce in 12 isolated and 6 full-suite runs in a Node 22.13.0 container, nor at half a CPU; but under **extreme CPU starvation**
  (a tenth of a CPU plus four busy loops) the old version failed with the same message in at least 2 runs (the run's summary was lost, so the total is unknown) while the new one passed 3 of 3. That is supportive, not
  conclusive: at that setting everything is ~10x slower, so any wall-clock timeout can trip. What was measured about the old test: its 3-hour anomaly window lasts only ~1.6 s of real time at 1500 req/s, and it only
  accepted the alert in a `rows` frame. The new one uses a 12-hour window at 300 req/s (about 30 s), waits for the alert in the database, then for the client to receive it in a `rows` or a `snapshot` frame, and a failure
  prints the simulator state, the alerts table and the stream's event counts.

## 1.0.1 - 2026-10-12

* **Fixed `npm start`.** The entry point (`src/server.js`) awaited the multi-database module, which imported the entry point back: a circular import with a pending top-level
  await, so the process exited silently ("unsettled top-level await"). The application code now lives in `src/app.js` and `src/multi.js`; `src/server.js` only starts one of them.
  Added `tests/cli.test.js`, which runs the real entry point (the other tests import the functions directly, which is why none of them noticed).
* Fixed a flaky channel test that paced its source with a timer (found by the first CI run).


## 1.0.0 - 2026-10-12 (first public commit)

First public release.

* Real-time FinOps dashboard: spend per tenant, endpoint and LLM call; tiles, stacked live chart, tables with sparklines, request drill-down, alerts, light/dark.
* Integer micro-dollar cost model computed from `model_prices`, including cache reads and 5-minute / 1-hour cache writes.
* Hand-written WebSocket and SSE streaming layer with conflation, drop-and-snapshot, `Last-Event-ID` resume, a lossless token lane and real backpressure.
* Explainable anomaly detector (median/MAD robust z-scores) with cooldown, ack and resolve; optional LLM-written explanations (mock or Anthropic).
* Importers for your own Claude Code usage and for public traces (BurstGPT, Azure LLM inference), with a price check against Claude Code's own cost records.
* **Data source switcher**: one server, one dashboard per database under `/d/<id>/`.
* Optional shared-secret authentication (`AUTH_TOKEN`); the server refuses a non-loopback address without it.
* Verified on Linux and macOS, Node 22.13.0 / 22.x / 24.x; zero npm dependencies.
