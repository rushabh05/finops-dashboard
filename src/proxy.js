import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { openDb, getMeta } from './db.js';
import { RE_TENANT, RE_ENDPOINT } from './ingest.js';
import { installPrices, normalizeModel } from './import/prices.js';
import { usageFields } from './import/claude-code.js';
import { isLoopbackHost } from './security.js';

/*
 * `finops proxy`: record the cost of every Anthropic Messages API call your app makes, live, with no code change beyond a base URL.
 *
 *   your app  --ANTHROPIC_BASE_URL=http://127.0.0.1:8788-->  proxy  ------>  api.anthropic.com
 *                                                              |
 *                                                              +-- usage numbers only -->  the dashboard's POST /api/ingest
 *
 * What it is and is not:
 *  - It forwards to ONE configured upstream and nothing else (a request path can never change the host). It listens on this machine only.
 *  - It never stores or logs headers, request bodies, prompts, completions or API keys. What leaves it is: tenant, endpoint, time, status,
 *    duration and, per call, the model and the token counts from the response's own `usage` block.
 *  - The dashboard stays the single writer: the proxy POSTs to its ordinary ingest endpoint, so validation, pricing, the live stream and
 *    the detector all behave exactly as for any other source.
 *  - Anthropic Messages API only (`POST /v1/messages`, streaming or not); every other path is forwarded without being recorded. OpenAI-style
 *    APIs are not recorded: this project has no verified price list for them, and a cost number from a guessed price is worse than none.
 */

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const RE_ID = /^[A-Za-z0-9._:#-]{1,100}$/;
const RE_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const MAX_PARSE_BYTES = 8 * 1024 * 1024; // a non-streamed response bigger than this is forwarded but not read for usage
const SAMPLE_SOURCE = 'finops';

/** An http(s) base URL: https unless it is this machine (the dashboard URL carries a token; the upstream carries API keys). */
export function parseBase(raw, name) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`${name} is not a valid URL`); }
  const loopback = isLoopbackHost(u.hostname) || u.hostname === '[::1]';
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) throw new Error(`${name} must be https (plain http is only accepted for localhost)`);
  if (u.username || u.password) throw new Error(`${name} must not contain credentials`);
  return u;
}

const defined = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== null && v !== undefined));

/** Read `usage` out of a streamed (server-sent events) Messages response, incrementally. Later values win: output_tokens in message_delta is the final count. */
export class SseUsage {
  constructor() { this.buf = ''; this.event = ''; this.usage = {}; this.model = null; this.complete = false; this.errorType = null; this.sawUsage = false; }
  push(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.#line(line);
    }
    if (this.buf.length > 1_000_000) this.buf = ''; // one line this long is not an event we understand
  }
  #line(l) {
    if (l === '') { this.event = ''; return; }
    if (l.startsWith('event:')) { this.event = l.slice(6).trim(); return; }
    if (!l.startsWith('data:')) return;
    const d = l.slice(5).trim();
    if (d[0] !== '{') return;
    let j;
    try { j = JSON.parse(d); } catch { return; }
    const type = j.type || this.event;
    if (type === 'message_start' && j.message) { this.model = j.message.model ?? this.model; Object.assign(this.usage, defined(j.message.usage)); this.sawUsage ||= !!j.message.usage; }
    else if (type === 'message_delta' && j.usage) { Object.assign(this.usage, defined(j.usage)); this.sawUsage = true; }
    else if (type === 'message_stop') this.complete = true;
    else if (type === 'error') this.errorType = j.error?.type || 'error';
  }
}

/** A recorded request in the dashboard's ingest format, or null when there is nothing to record. */
export function buildRecord({ id, ts, tenant, endpoint, method, status, durationMs, model, usage }) {
  const call = [];
  if (model && usage && Object.keys(usage).length) {
    const u = usageFields(usage);
    call.push({
      model: normalizeModel(model), input_tokens: u.input + u.read + u.w5 + u.w1, output_tokens: u.output, cached_tokens: u.read,
      cache_write_tokens: u.w5, cache_write_1h_tokens: u.w1, latency_ms: durationMs,
    });
  }
  return { id, ts, tenant_id: tenant, endpoint, method, status, duration_ms: durationMs, infra_cost_micro_usd: 0, llm_calls: call };
}

/** Create the live database the proxy records into (schema + the real price list), unless it exists. Never touches imported or sample data. */
export function ensureLiveDb(path) {
  if (existsSync(path)) {
    const db = openDb(path);
    try {
      const src = getMeta(db, 'source');
      if (src) throw new Error(`${path} holds imported data (${src}); pick another --source`);
    } finally { db.close(); }
    return false;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = openDb(path);
  try { installPrices(db); } finally { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); }
  return true;
}

/** Batches records and POSTs them to the dashboard. Never blocks a proxied call; retries with backoff; isolates a record the dashboard refuses. */
class Recorder {
  constructor({ dashboard, source, authToken, fetchImpl, log, stats, flushMs, maxPending }) {
    Object.assign(this, { dashboard, source, authToken, fetchImpl, log, stats, flushMs, maxPending });
    this.pending = []; this.timer = null; this.running = null; this.path = null; this.failures = 0; this.lastWarn = 0; this.seen = new Set();
  }
  add(rec) {
    if (this.pending.length >= this.maxPending) { this.pending.shift(); this.stats.dropped++; }
    this.pending.push(rec);
    this.#schedule(this.pending.length >= 50 ? 0 : this.flushMs);
  }
  #schedule(ms) {
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => { this.timer = null; this.running = this.#run().finally(() => { this.running = null; if (this.pending.length) this.#schedule(Math.min(30_000, this.flushMs * 2 ** this.failures)); }); }, ms);
    this.timer.unref?.();
  }
  #warn(msg, key = msg) {
    const now = Date.now();
    if (this.seen.has(key) && now - this.lastWarn < 60_000) return;
    if (this.seen.size > 50) this.seen.clear();
    this.seen.add(key); this.lastWarn = now;
    this.log(msg);
  }
  async #ingestPath() {
    if (this.path) return this.path;
    const res = await this.fetchImpl(`${this.dashboard.origin}/healthz`, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    const j = await res.json().catch(() => ({}));
    return (this.path = j.mode === 'multi' ? `/d/${this.source}/api/ingest` : '/api/ingest');
  }
  async #post(requests) {
    const headers = { 'Content-Type': 'application/json', Origin: this.dashboard.origin };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    const res = await this.fetchImpl(`${this.dashboard.origin}${await this.#ingestPath()}`, { method: 'POST', headers, body: JSON.stringify({ requests }), signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }
  async #run() {
    while (this.pending.length) {
      const batch = this.pending.slice(0, 100);
      let r;
      try { r = await this.#post(batch); } catch (e) {
        this.failures++;
        this.#warn(`cannot reach the dashboard at ${this.dashboard.origin} (${e?.cause?.code || e?.name || 'error'}): recording is queued (${this.pending.length} waiting). Start it with: finops start`, 'unreachable');
        return;
      }
      if (r.status === 200) { this.pending.splice(0, batch.length); this.failures = 0; this.stats.recorded += batch.length; continue; }
      if (r.status === 400) { this.pending.splice(0, batch.length); await this.#isolate(batch, r); continue; }
      this.failures++;
      if (r.status === 404) this.path = null; // the dashboard may have restarted in the other mode
      this.#warn(r.status === 401 || r.status === 403 ? 'the dashboard refused the proxy (HTTP ' + r.status + '): set AUTH_TOKEN for the proxy to the same value as for the dashboard' : `the dashboard answered HTTP ${r.status}${r.status === 404 ? ` - is the "${this.source}" database there? start the proxy and the dashboard with the same data directory` : ''}; will retry`, `http-${r.status}`);
      return;
    }
  }
  /** One invalid record rejects its whole batch: send them one by one to find (and name) the culprits instead of losing all of them. */
  async #isolate(batch, first) {
    if (batch.length === 1) return this.#reject(first.body);
    for (const rec of batch) {
      try {
        const r = await this.#post([rec]);
        if (r.status === 200) this.stats.recorded++;
        else if (r.status === 400) this.#reject(r.body);
        else { this.pending.unshift(rec); return; }
      } catch { this.pending.unshift(rec); return; }
    }
  }
  #reject(body) {
    this.stats.rejected++;
    const why = String(body?.errors?.[0] ?? body?.error ?? 'invalid').replace(/^requests\[\d+\]\.?/, '');
    this.#warn(`the dashboard rejected a recorded call (${why}); it is not counted. For an unpriced model add its price (README, "Prices").`, why.replace(/^.*no price/, 'no price'));
  }
  async idle(timeoutMs = 3000) {
    const t0 = Date.now();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; if (!this.running) this.running = this.#run().finally(() => { this.running = null; }); }
    while ((this.running || this.pending.length) && Date.now() - t0 < timeoutMs) {
      if (!this.running && this.pending.length && this.failures) break; // the dashboard is down: do not spin
      await Promise.race([this.running ?? Promise.resolve(), new Promise((r) => setTimeout(r, 25))]);
    }
  }
}

export { normalizeModel }; // the tests (and callers) have always imported it from here

export function createProxy({
  upstream = 'https://api.anthropic.com', dashboard = 'http://127.0.0.1:8787', source = 'live', tenant = 'default',
  host = '127.0.0.1', port = 8788, authToken = '', log = () => {}, verbose = false, fetchImpl = globalThis.fetch,
  flushMs = 1000, maxPending = 1000,
} = {}) {
  const up = parseBase(upstream, 'upstream');
  const dash = parseBase(dashboard, 'dashboard');
  if (!RE_SOURCE.test(source)) throw new Error('source must be a database name like "live"');
  if (source === SAMPLE_SOURCE) throw new Error(`source "${SAMPLE_SOURCE}" is the simulated sample database: recording real calls into it would mix them with fake traffic`);
  if (!RE_TENANT.test(tenant)) throw new Error('tenant must match ' + RE_TENANT);
  if (!isLoopbackHost(host)) throw new Error('the proxy only listens on this machine (127.0.0.1): run one next to each service instead of exposing it');

  const stats = { proxied: 0, recorded: 0, rejected: 0, dropped: 0, upstream_errors: 0, unreadable_usage: 0, aborted: 0 };
  const recorder = new Recorder({ dashboard: dash, source, authToken, fetchImpl, log, stats, flushMs, maxPending });
  const transport = up.protocol === 'https:' ? https : http;
  const inflight = new Set();
  let warnedLabel = false, warnedUsage = false;

  function label(req) {
    const t = req.headers['x-finops-tenant'];
    const e = req.headers['x-finops-endpoint'];
    const okT = typeof t === 'string' && RE_TENANT.test(t);
    const okE = typeof e === 'string' && RE_ENDPOINT.test(e);
    if (((t !== undefined && !okT) || (e !== undefined && !okE)) && !warnedLabel) { warnedLabel = true; log('ignored an invalid x-finops-tenant / x-finops-endpoint header (tenant: letters, digits, . _ -; endpoint: a path like /summarize)'); }
    return { tenant: okT ? t : tenant, endpoint: okE ? e : null };
  }

  function bad(res, status, message) {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `finops proxy: ${message}` } }));
  }

  function handle(req, res) {
    if (req.url === '/__finops/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, upstream: up.host, dashboard: dash.origin, source, pending: recorder.pending.length, ...stats }));
    }
    // origin-form only: '//evil.example/x' and absolute-form 'http://evil.example/' must not be able to pick another host
    if (typeof req.url !== 'string' || !/^\/[^\s]*$/.test(req.url) || req.url.startsWith('//')) return bad(res, 400, 'bad request path');
    let target;
    try { target = new URL(up.origin + req.url); } catch { return bad(res, 400, 'bad request path'); }
    if (target.origin !== up.origin) return bad(res, 400, 'bad request path');

    const start = Date.now();
    const recordIt = req.method === 'POST' && target.pathname === '/v1/messages';
    const lab = label(req);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && k !== 'host' && !k.startsWith('x-finops-')) headers[k] = v;
    headers.host = up.host;
    headers['accept-encoding'] = 'identity'; // read usage from plain text (a compressed reply is still handled below)

    stats.proxied++;
    let done = false, partial = () => ({ usage: null, model: null });
    const finish = (status, usage, model) => {
      if (done) return;
      done = true;
      inflight.delete(handleCtx);
      if (status >= 500) stats.upstream_errors++;
      if (!recordIt) return;
      const ok2xx = status >= 200 && status < 300;
      if (ok2xx && !(usage && Object.keys(usage).length)) { stats.unreadable_usage++; if (!warnedUsage) { warnedUsage = true; log('a successful /v1/messages response had no readable usage block: the request is recorded without cost'); } }
      const duration = Math.max(0, Math.min(3_600_000, Date.now() - start));
      const rec = buildRecord({
        id: `px-${start.toString(36)}-${randomBytes(5).toString('hex')}`, ts: start, tenant: lab.tenant, endpoint: lab.endpoint ?? target.pathname,
        method: req.method, status, durationMs: duration, model: ok2xx || usage ? model : null, usage: ok2xx || usage ? usage : null,
      });
      if (verbose) log(`${req.method} ${target.pathname} ${status} ${duration} ms tenant=${lab.tenant}${rec.llm_calls[0] ? ` ${rec.llm_calls[0].model} in=${rec.llm_calls[0].input_tokens} out=${rec.llm_calls[0].output_tokens}` : ''}`);
      recorder.add(rec);
    };
    const handleCtx = { destroy: () => { upReq.destroy(); res.destroy(); } };
    inflight.add(handleCtx);

    const upReq = transport.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, path: target.pathname + target.search, method: req.method, headers }, (r) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP_BY_HOP.has(k)) outHeaders[k] = v;
      res.writeHead(r.statusCode, outHeaders);
      res.flushHeaders?.();

      const sse = /text\/event-stream/i.test(r.headers['content-type'] || '');
      const enc = String(r.headers['content-encoding'] || 'identity').toLowerCase();
      const decoder = enc === 'gzip' || enc === 'x-gzip' ? zlib.createGunzip() : enc === 'deflate' ? zlib.createInflate() : enc === 'br' ? zlib.createBrotliDecompress() : null;
      const readable = enc === 'identity' || decoder;
      const text = new StringDecoder('utf8');
      const parser = new SseUsage();
      if (sse && recordIt) partial = () => ({ usage: parser.sawUsage ? parser.usage : null, model: parser.model });
      const chunks = []; let size = 0;
      const feed = (chunk) => {
        if (!recordIt || !readable) return;
        if (sse) parser.push(text.write(chunk));
        else if (size <= MAX_PARSE_BYTES) { chunks.push(chunk); size += chunk.length; }
      };
      const conclude = () => {
        let usage = null, model = null, status = r.statusCode;
        if (sse) {
          usage = parser.sawUsage ? parser.usage : null; model = parser.model;
          if (!parser.complete && parser.errorType && status < 400) status = parser.errorType === 'overloaded_error' ? 529 : parser.errorType === 'rate_limit_error' ? 429 : 500;
        } else if (size && size <= MAX_PARSE_BYTES) {
          try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); usage = j.usage ?? null; model = j.model ?? null; } catch { /* not JSON: nothing to read */ }
        }
        finish(status, usage, model);
      };
      if (decoder) { decoder.on('data', feed); decoder.on('end', conclude); decoder.on('error', () => conclude()); r.on('data', (c) => decoder.write(c)); r.on('end', () => decoder.end()); }
      else { r.on('data', feed); r.on('end', conclude); }
      r.pipe(res);
      r.on('error', () => { res.destroy(); finish(502, null, null); });
    });
    upReq.setTimeout(300_000, () => upReq.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    upReq.on('error', (e) => {
      if (!res.headersSent) bad(res, 502, `could not reach the upstream (${e.code || e.message})`); else res.destroy();
      finish(502, null, null);
    });
    // The client went away before the reply finished: stop the upstream call. The prompt was certainly processed (its input tokens arrive in the
    // first event), so what the stream had already reported is recorded, as status 499. Output tokens are then a lower bound: the final count never came.
    res.on('close', () => {
      if (done || res.writableFinished) return;
      stats.aborted++;
      upReq.destroy();
      const p = partial();
      finish(499, p.usage, p.model);
    });
    req.on('error', () => upReq.destroy());
    req.pipe(upReq);
  }

  const server = http.createServer({ highWaterMark: 16 * 1024 }, handle);
  server.keepAliveTimeout = 5000;
  let boundPort = port;
  return {
    server, stats, recorder,
    get port() { return boundPort; },
    get url() { return `http://${host.includes(':') ? `[${host}]` : host}:${boundPort}`; },
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        boundPort = server.address().port;
        // ANTHROPIC_BASE_URL points at this proxy in the app's shell: an upstream that is the proxy itself would forward every call to itself forever
        if (isLoopbackHost(up.hostname.replace(/^\[|\]$/g, '')) && Number(up.port || (up.protocol === 'https:' ? 443 : 80)) === boundPort) {
          server.close(() => reject(new Error('the upstream is this proxy itself (a loop): is ANTHROPIC_BASE_URL exported in this shell? pass --upstream https://api.anthropic.com')));
          return;
        }
        resolve();
      });
    }),
    async close() {
      await new Promise((r) => {
        server.close(() => r());
        const t = setTimeout(() => { for (const c of inflight) c.destroy(); server.closeAllConnections?.(); }, 8000);
        t.unref?.();
        server.closeIdleConnections?.();
      });
      await recorder.idle(3000);
    },
  };
}
