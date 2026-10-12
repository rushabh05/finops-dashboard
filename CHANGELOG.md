# Changelog

## Unreleased

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
* Two flaky tests, found by CI on the previous commit. `cli.test.js` asserted a stdout line the moment the line before it arrived (the CI log shows the output holding only the first
  line); it now waits for the line. The live-simulator e2e test timed out once on Linux / Node 22.13.0 and **could not be reproduced** (0 failures in 12 isolated and 6 full-suite runs
  in a Node 22.13.0 container, nor under heavy CPU starvation). What was measured: its 3-hour anomaly window lasts only ~1.6 s of real time at 1500 req/s, and it only accepted the alert
  in a `rows` frame. It now uses a 12-hour window at 300 req/s (about 30 s), waits for the alert in the database, then for the client to receive it in a `rows` or a `snapshot` frame, and
  a failure prints the simulator state, the alerts table and the stream's event counts. Treat that fix as a likely cause, not a proven one.

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
