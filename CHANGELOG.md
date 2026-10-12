# Changelog

## 1.0.0 - 2026-10-12

First public release.

* Real-time FinOps dashboard: spend per tenant, endpoint and LLM call; tiles, stacked live chart, tables with sparklines, request drill-down, alerts, light/dark.
* Integer micro-dollar cost model computed from `model_prices`, including cache reads and 5-minute / 1-hour cache writes.
* Hand-written WebSocket and SSE streaming layer with conflation, drop-and-snapshot, `Last-Event-ID` resume, a lossless token lane and real backpressure.
* Explainable anomaly detector (median/MAD robust z-scores) with cooldown, ack and resolve; optional LLM-written explanations (mock or Anthropic).
* Importers for your own Claude Code usage and for public traces (BurstGPT, Azure LLM inference), with a price check against Claude Code's own cost records.
* **Data source switcher**: one server, one dashboard per database under `/d/<id>/`.
* Optional shared-secret authentication (`AUTH_TOKEN`); the server refuses a non-loopback address without it.
* Verified on Linux and macOS, Node 22.13.0 / 22.x / 24.x; zero npm dependencies.
