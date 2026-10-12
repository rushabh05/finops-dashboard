import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/server.js';
import { FrameParser, OP, acceptKey, encodeFrame, encodeClose } from '../src/ws.js';
import { HOUR } from '../src/util.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(fn, { timeout = 8000, interval = 10, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

/** A small, quiet app: in-memory DB, tiny history, simulator off, ephemeral port. */
export async function makeApp(overrides = {}) {
  const app = await createApp({
    dbPath: ':memory:', port: 0, seedDays: 2, volumeScale: 0.3, simAutoStart: false, simAnomalies: false, detectEveryMs: 100000,
    ...overrides,
  });
  await app.listen();
  return app;
}

export async function api(app, method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = raw ? body : JSON.stringify(body);
    if (!('content-type' in Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v])))) init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(app.url + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}

let reqSeq = 0;
/** Valid ingest request. `calls` = [{model, input_tokens, output_tokens, cached_tokens}] */
export function mkRequest({ ts, tenant = 'acme', endpoint = '/v1/chat', calls = [{ model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 200, cached_tokens: 0 }], status = 200, infra = 500, id } = {}) {
  return {
    id: id ?? `t${Date.now().toString(36)}-${(reqSeq++).toString(36)}`, ts, tenant_id: tenant, endpoint, method: 'POST', status, duration_ms: 120,
    infra_cost_micro_usd: infra, llm_calls: calls.map((c) => ({ latency_ms: 300, cached_tokens: 0, ...c })),
  };
}

export function insertAlert(app, o = {}) {
  const ts = o.ts ?? app.sim.simNow;
  const r = app.db.prepare('INSERT INTO alerts(ts, kind, tenant_id, endpoint, observed, baseline, score, explanation, status, hour, detail) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    ts, o.kind ?? 'cost_spike', o.tenant ?? 'acme', o.endpoint ?? null, o.observed ?? 4_000_000, o.baseline ?? 1_000_000, o.score ?? 9.5,
    o.explanation ?? 'Tenant acme spent $4.00 vs a typical $1.00', 'open', Math.floor(ts / HOUR) * HOUR, null,
  );
  return Number(r.lastInsertRowid);
}

/* ------------------------------------------------------------------ fake transport for channel unit tests */

export class FakeTransport extends EventEmitter {
  constructor({ drainMark = 1000 } = {}) {
    super();
    this.drainMark = drainMark;
    this._buffered = 0;
    this.frames = []; // {event, id, data, bytes}
    this.closed = false;
    this.maxBuffered = 0;
    this._above = false;
    this.rate = 0;
  }
  get buffered() { return this._buffered; }
  set buffered(v) { // tests may stall the "network" by setting this directly
    this._buffered = v;
    this.maxBuffered = Math.max(this.maxBuffered, v);
    if (v > this.drainMark) this._above = true;
  }
  write(buf) {
    if (this.closed) return;
    this.buffered = this._buffered + buf.length;
    this.frames.push({ ...parseSseFrame(buf.toString()), bytes: buf.length });
  }
  /** The "network" accepts n bytes: shrink the buffer, emit 'drain' when it falls back under the mark. */
  flush(n = Infinity) {
    this._buffered = Math.max(0, this._buffered - n);
    if (this._above && this._buffered <= this.drainMark) { this._above = false; this.emit('drain'); }
  }
  end() { this.closed = true; this.emit('close'); }
  destroy() { this.end(); }
  of(event) { return this.frames.filter((f) => f.event === event); }
}

export function parseSseFrame(text) {
  const out = { event: 'message', id: undefined, data: undefined };
  const data = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('id: ')) out.id = Number(line.slice(4));
    else if (line.startsWith('event: ')) out.event = line.slice(7);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  if (data.length) { try { out.data = JSON.parse(data.join('\n')); } catch { out.data = data.join('\n'); } }
  return out;
}

/* ------------------------------------------------------------------ real clients */

class ClientBase {
  constructor() {
    this.events = [];
    this.lastId = null;
    this.closed = false;
  }
  _push(ev) {
    this.events.push(ev);
    if (ev.id !== undefined) this.lastId = ev.id;
  }
  of(event) { return this.events.filter((e) => e.event === event); }
  waitFor(pred, opts = {}) { return waitUntil(() => this.events.find(pred) || (this.closed && opts.allowClosed ? null : null), { what: opts.what || 'event', ...opts }); }
  async waitForEvent(event, pred = () => true, opts = {}) {
    return waitUntil(() => this.events.find((e) => e.event === event && pred(e)), { what: `${event} event`, ...opts });
  }
}

export class SseClient extends ClientBase {
  constructor(app, { cid, lastEventId = null, headers = {}, query = '', basePath = '' } = {}) {
    super();
    this.cid = cid;
    this.buf = '';
    this.ready = new Promise((resolve, reject) => {
      this.req = http.request({
        host: '127.0.0.1', port: app.port, path: `${basePath}/stream?cid=${cid}${query}`,
        headers: { Accept: 'text/event-stream', ...(lastEventId !== null ? { 'Last-Event-ID': String(lastEventId) } : {}), ...headers },
      }, (res) => {
        this.res = res;
        this.status = res.statusCode;
        this.headers = res.headers;
        res.setEncoding('utf8');
        res.on('data', (d) => this._data(d));
        res.on('close', () => { this.closed = true; });
        resolve(this);
      });
      this.req.on('error', (e) => { this.closed = true; reject(e); });
      this.req.end();
    });
  }
  _data(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n\n')) !== -1) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      if (block.startsWith(':') || block.startsWith('retry:')) continue;
      this._push(parseSseFrame(block));
    }
  }
  pause() { this.res.pause(); }
  resume() { this.res.resume(); }
  close() { this.closed = true; this.req.destroy(); }
}

/** WebSocket client over a raw socket (so tests control reading and the Origin header). */
export class WsClient extends ClientBase {
  static async connect(app, { cid, lastEventId = null, origin, headers = {}, basePath = '' } = {}) {
    const c = new WsClient();
    c.cid = cid;
    c.parser = new FrameParser({ maxPayload: 8 << 20, expectMasked: false });
    c.socket = net.connect(app.port, '127.0.0.1');
    const key = randomBytes(16).toString('base64');
    const q = `cid=${cid}${lastEventId !== null ? `&lastEventId=${lastEventId}` : ''}`;
    const h = { Host: `127.0.0.1:${app.port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', ...headers };
    if (origin !== null) h.Origin = origin ?? `http://127.0.0.1:${app.port}`;
    const hs = [`GET ${basePath}/ws?${q} HTTP/1.1`, ...Object.entries(h).map(([k, v]) => `${k}: ${v}`)];
    c.socket.write(hs.join('\r\n') + '\r\n\r\n');
    let head = Buffer.alloc(0);
    const status = await new Promise((resolve) => {
      const onData = (d) => {
        head = Buffer.concat([head, d]);
        const i = head.indexOf('\r\n\r\n');
        if (i === -1) return;
        c.socket.off('data', onData);
        const text = head.subarray(0, i).toString();
        const rest = head.subarray(i + 4);
        const code = Number(/^HTTP\/1\.1 (\d+)/.exec(text)[1]);
        if (code === 101) {
          const accept = /sec-websocket-accept: (.+)/i.exec(text)?.[1]?.trim();
          c.acceptOk = accept === acceptKey(key);
          c.socket.on('data', (x) => c._data(x));
          if (rest.length) c._data(rest);
        }
        resolve(code);
      };
      c.socket.on('data', onData);
      c.socket.on('close', () => { c.closed = true; resolve(0); });
      c.socket.on('error', () => { c.closed = true; });
    });
    c.status = status;
    c.socket.on('close', () => { c.closed = true; });
    return c;
  }
  _data(d) {
    for (const m of this.parser.push(d)) {
      if (m.type === 'text') this._push(JSON.parse(m.data));
      else if (m.type === 'ping') this.socket.write(encodeFrame(OP.PONG, m.data, { mask: true }));
      else if (m.type === 'close') { this.closeFrame = m; this.closeFrames = (this.closeFrames || 0) + 1; }
    }
  }
  pause() { this.socket.pause(); }
  resume() { this.socket.resume(); }
  send(text) { this.socket.write(encodeFrame(OP.TEXT, text, { mask: true })); }
  close() { try { this.socket.write(encodeClose(1000, '', { mask: true })); } catch { /* ignore */ } this.socket.destroy(); this.closed = true; }
}

/** Mirror of what the browser keeps: snapshot replaces, row frames patch by entity key. */
export class Mirror {
  constructor() { this.rollups = new Map(); this.alerts = new Map(); this.snapshots = 0; }
  apply(ev) {
    if (ev.event === 'snapshot') {
      this.snapshots++;
      this.rollups.clear(); this.alerts.clear();
      const { cols, rows } = ev.data.rollups;
      for (const r of rows) { const o = {}; cols.forEach((c, i) => { o[c] = r[i]; }); this.rollups.set(o.id, o); }
      for (const a of ev.data.alerts) this.alerts.set(a.id, a);
      this.from = ev.data.window.from;
    } else if (ev.event === 'rows') {
      for (const r of ev.data.rows) {
        if (r.k.startsWith('r:')) this.rollups.set(r.v.id, r.v); else this.alerts.set(r.v.id, r.v);
      }
    }
  }
  applyAll(events) { for (const e of events) this.apply(e); return this; }
}

/** The truth the mirror must converge to. */
export function dbTruth(app) {
  const from = app.feed.windowFrom();
  const rollups = new Map(app.db.prepare('SELECT rowid AS id, hour, tenant_id, endpoint, model, requests, llm_calls, tokens_in, tokens_out, cost_micro_usd FROM rollups_hourly WHERE hour >= ?').all(from).map((r) => [r.id, { ...r }]));
  return { rollups, from };
}

export function assertConverged(assert, mirror, app) {
  const truth = dbTruth(app);
  // like the browser, drop rows that have slid out of the live window (the window moves as new hours arrive)
  const mine = new Map([...mirror.rollups].filter(([, r]) => r.hour >= truth.from));
  mirror = { rollups: mine, alerts: mirror.alerts };
  const keys = (m) => [...m.keys()].sort((a, b) => a - b);
  assert.deepEqual(keys(mirror.rollups), keys(truth.rollups), 'same set of rollup rows in the live window');
  for (const [id, row] of truth.rollups) assert.deepEqual(mirror.rollups.get(id), row, `rollup row ${id}`);
  const dbAlerts = app.db.prepare('SELECT id, status FROM alerts').all();
  for (const a of dbAlerts) assert.equal(mirror.alerts.get(a.id)?.status, a.status, `alert ${a.id} status`);
}

export const randomCid = () => 'c' + randomBytes(8).toString('hex');
