# Changelog

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
