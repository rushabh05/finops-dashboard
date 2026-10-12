import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMultiApp } from '../src/multi.js';
import { createApp } from '../src/server.js';
import { buildRecord, createProxy, ensureLiveDb, normalizeModel, SseUsage } from '../src/proxy.js';
import { openDb, setMeta } from '../src/db.js';
import { usageFields } from '../src/import/claude-code.js';
import { sleep, waitUntil } from './helpers.js';

/*
 * `finops proxy`, end to end: your app -> proxy -> a fake Anthropic API, with the usage numbers landing in a REAL dashboard (real ingest,
 * real prices) whose database we then read. Also: streaming split at awkward byte boundaries, compression, errors, aborts, and the rules that
 * protect people (a request path cannot change the host, no key or prompt is ever recorded or logged, the sample database is off limits).
 */
const KEY = 'sk-ant-api03-SECRET-KEY-do-not-record';
const PROMPT = 'SECRET prompt text: our unreleased pricing';
const USAGE = { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 }, output_tokens: 300 };
// claude-sonnet-5-5: $2 in / $10 out / $0.20 cache read / $2.50 cache write (5 min) per Mtok
// -> (1000*2 + 500*0.2 + 200*2.5 + 300*10) / 1e6 USD = $0.0056 = 5600 micro-USD, on 1700 prompt tokens (uncached + cached + cache writes)
const EXPECT = { tokens_in: 1700, tokens_out: 300, cost: 5600 };

const messageJson = (model = 'claude-sonnet-5-5', usage = USAGE) => JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'SECRET answer' }], stop_reason: 'end_turn', usage });
const sse = (model, usage, { outputInStart = 1, tail = true } = {}) => [
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { ...usage, output_tokens: outputInStart } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'café ☕ SECRET answer' } })}\n\n`,
  ...(tail ? [
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ] : []),
].join('');

/** A stand-in for api.anthropic.com. What it does is chosen per request by the `x-test` header. */
async function fakeUpstream() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    const mode = req.headers['x-test'] || 'json';
    const model = req.headers['x-model'] || 'claude-sonnet-5-5';
    if (mode === 'json') { res.writeHead(200, { 'Content-Type': 'application/json', 'request-id': 'req_abc' }); return res.end(messageJson(model)); }
    if (mode === 'gzip') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync(messageJson(model))); }
    if (mode === '429') { res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '1' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })); }
    if (mode === 'stream' || mode === 'stream-slow-tail') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const bytes = Buffer.from(sse(model, USAGE));
      for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)); await sleep(0); } // 7-byte chunks split lines, JSON and the multi-byte characters
      return res.end();
    }
    if (mode === 'stream-error') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse(model, USAGE, { tail: false }));
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`);
      return res.end();
    }
    if (mode === 'stream-hang') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(sse(model, USAGE, { tail: false }));
      res.on('close', () => { server.hangClosed = true; });
      return; // never finishes: the client will give up
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"data":[]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, received, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}

/** upstream + a real multi-database dashboard + a proxy between an "app" and the upstream. */
async function stack(t, { proxyOptions = {}, dashboardOptions = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'finops-proxy-'));
  const upstream = await fakeUpstream();
  ensureLiveDb(join(dir, 'live.db'));
  const dashboard = await createMultiApp({ dataDir: dir, port: 0, seedDays: 1, volumeScale: 0.1, simAutoStart: false, sourcesTtlMs: 0, detectEveryMs: 100000, ...dashboardOptions });
  await dashboard.listen();
  const logs = [];
  const proxy = createProxy({ upstream: upstream.url, dashboard: dashboard.url, source: 'live', tenant: 'default', port: 0, log: (m) => logs.push(m), verbose: true, flushMs: 20, authToken: dashboardOptions.authToken, ...proxyOptions });
  await proxy.listen();
  t.after(async () => { await proxy.close(); await dashboard.close(); await upstream.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const call = async (headers = {}, { body = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 100, messages: [{ role: 'user', content: PROMPT }] }), path = '/v1/messages', method = 'POST' } = {}) => {
    const res = await fetch(`${proxy.url}${path}`, { method, headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01', ...headers }, body: method === 'GET' ? undefined : body });
    return { res, bytes: Buffer.from(await res.arrayBuffer()) };
  };
  const db = () => new DatabaseSync(join(dir, 'live.db'), { readOnly: true });
  // every handle is closed at once: an open file cannot be deleted on Windows (EBUSY), so a leaked handle would fail the cleanup there
  const count = () => { const d = db(); try { return d.prepare('SELECT COUNT(*) AS n FROM requests').get().n; } finally { d.close(); } };
  const rows = async (n) => {
    await waitUntil(async () => { await proxy.recorder.idle(500); return count() >= n; }, { what: `${n} request(s) in the dashboard database (proxy stats ${JSON.stringify(proxy.stats)}, logs ${JSON.stringify(logs)})` });
    const d = db();
    try {
      return d.prepare('SELECT r.id, r.tenant_id, r.endpoint, r.method, r.status, r.duration_ms, c.model, c.input_tokens, c.output_tokens, c.cached_tokens, c.cache_write_tokens, c.cache_write_1h_tokens, c.cost_micro_usd FROM requests r LEFT JOIN llm_calls c ON c.request_id = r.id ORDER BY r.ts, r.id').all();
    } finally { d.close(); }
  };
  return { dir, upstream, dashboard, proxy, logs, call, rows, db };
}

test('a non-streamed call: the app gets the upstream answer untouched; the dashboard gets tenant, endpoint, status, tokens and the exact cost - and nothing else', async (t) => {
  const s = await stack(t);
  const { res, bytes } = await s.call({ 'x-test': 'json', 'x-finops-tenant': 'acme', 'x-finops-endpoint': '/summarize' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('request-id'), 'req_abc', 'upstream response headers come through');
  assert.equal(bytes.toString(), messageJson());

  const up = s.upstream.received[0];
  assert.equal(up.headers['x-api-key'], KEY, 'the key is forwarded to the upstream');
  assert.equal(up.headers['anthropic-version'], '2023-06-01');
  assert.equal(up.headers.host, new URL(s.upstream.url).host, 'Host is the upstream\'s, not the proxy\'s');
  assert.equal(up.headers['accept-encoding'], 'identity');
  assert.equal(up.headers['x-finops-tenant'], undefined, 'our labels are stripped before forwarding');
  assert.equal(up.headers['x-finops-endpoint'], undefined);
  assert.equal(JSON.parse(up.body).messages[0].content, PROMPT, 'the body is forwarded as it came');

  const [r] = await s.rows(1);
  assert.deepEqual({ tenant: r.tenant_id, endpoint: r.endpoint, method: r.method, status: r.status, model: r.model }, { tenant: 'acme', endpoint: '/summarize', method: 'POST', status: 200, model: 'claude-sonnet-5-5' });
  assert.deepEqual({ in: r.input_tokens, out: r.output_tokens, cached: r.cached_tokens, w5: r.cache_write_tokens, w1h: r.cache_write_1h_tokens }, { in: 1700, out: 300, cached: 500, w5: 200, w1h: 0 });
  assert.equal(r.cost_micro_usd, EXPECT.cost);

  // and the dashboard itself serves it
  const sum = await (await fetch(`${s.dashboard.url}/d/live/api/summary`)).json();
  assert.deepEqual([sum.totals.requests, sum.totals.tokens_in, sum.totals.tokens_out, sum.totals.cost_micro_usd], [1, EXPECT.tokens_in, EXPECT.tokens_out, EXPECT.cost]);
});

test('a streamed call, split at 7-byte boundaries (mid-line, mid-JSON, mid-character): the app gets every byte; the FINAL output_tokens is recorded', async (t) => {
  const s = await stack(t);
  const { res, bytes } = await s.call({ 'x-test': 'stream' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(bytes.toString('utf8'), sse('claude-sonnet-5-5', USAGE), 'the stream passes through unchanged');
  const [r] = await s.rows(1);
  assert.equal(r.output_tokens, 300, 'message_delta\'s final count wins over message_start\'s initial 1');
  assert.equal(r.input_tokens, 1700);
  assert.equal(r.cost_micro_usd, EXPECT.cost);
  assert.equal(r.status, 200);
});

test('a compressed response is forwarded as is (the app decompresses it) AND read for usage', async (t) => {
  const s = await stack(t);
  // fetch() would decompress for us: use a raw client to see the bytes the proxy really sent
  const got = await new Promise((resolve, reject) => {
    const req = http.request(`${s.proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test': 'gzip', 'x-api-key': KEY, 'accept-encoding': 'gzip' } }, (r) => {
      const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => resolve({ headers: r.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(got.headers['content-encoding'], 'gzip', 'still compressed on the way to the app');
  assert.equal(zlib.gunzipSync(got.bytes).toString(), messageJson());
  const [r] = await s.rows(1);
  assert.equal(r.cost_micro_usd, EXPECT.cost);
});

test('failures are recorded too (they are what a retry-storm alert is made of): a 429 is a request with status 429 and no cost; a mid-stream overloaded error is 529', async (t) => {
  const s = await stack(t);
  const a = await s.call({ 'x-test': '429' });
  assert.equal(a.res.status, 429);
  assert.equal(a.res.headers.get('retry-after'), '1');
  assert.equal(JSON.parse(a.bytes).error.type, 'rate_limit_error');
  await s.call({ 'x-test': 'stream-error' });
  const rows = await s.rows(2);
  const r429 = rows.find((r) => r.status === 429);
  assert.equal(r429.model, null, 'no LLM call, so no cost');
  const r529 = rows.find((r) => r.status === 529);
  assert.ok(r529, `a 200 stream that ends in an error event is recorded as the error: ${JSON.stringify(rows.map((r) => r.status))}`);
  assert.equal(r529.input_tokens, 1700, 'the prompt was processed: its input tokens are billed');
  assert.equal(s.proxy.stats.upstream_errors, 1, 'only the 5xx counts as an upstream error, not the client-side 429');
});

test('a client that gives up mid-stream: the upstream call is stopped and the request is recorded as 499 with the usage seen so far', async (t) => {
  const s = await stack(t);
  const ac = new AbortController();
  const res = await fetch(`${s.proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test': 'stream-hang', 'x-api-key': KEY }, body: '{}', signal: ac.signal });
  const reader = res.body.getReader();
  await reader.read(); // the first event arrived
  ac.abort();
  await waitUntil(() => s.upstream.server.hangClosed, { what: 'the upstream connection to be closed' });
  const [r] = await s.rows(1);
  assert.equal(r.status, 499);
  assert.equal(r.input_tokens, 1700, 'input tokens were already reported by message_start');
  assert.equal(s.proxy.stats.aborted, 1);
});

test('model names: a dated alias is recorded under the priced name; an unpriced model is rejected by the dashboard WITHOUT losing its neighbours, and says why', async (t) => {
  assert.equal(normalizeModel('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(normalizeModel('claude-sonnet-5-5-20260101'), 'claude-sonnet-5-5');
  assert.equal(normalizeModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001', 'a dated name that is itself priced is kept');
  assert.equal(normalizeModel('gpt-4o'), 'gpt-4o');

  const s = await stack(t, { proxyOptions: { flushMs: 200 } }); // let the three calls travel in one batch
  await Promise.all([
    s.call({ 'x-test': 'json', 'x-model': 'claude-sonnet-5-5-20260101' }),
    s.call({ 'x-test': 'json', 'x-model': 'some-unpriced-model-9' }),
    s.call({ 'x-test': 'json', 'x-model': 'claude-sonnet-5-5' }),
  ]);
  await waitUntil(async () => { await s.proxy.recorder.idle(500); return s.proxy.stats.recorded + s.proxy.stats.rejected >= 3; }, { what: 'all three records to be settled' });
  const rows = await s.rows(2);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.model), ['claude-sonnet-5-5', 'claude-sonnet-5-5']);
  assert.equal(s.proxy.stats.rejected, 1);
  assert.ok(s.logs.some((l) => /no price in model_prices for "some-unpriced-model-9"/.test(l) || /no price/.test(l)), `the log names the cause: ${JSON.stringify(s.logs)}`);
});

test('labels: invalid x-finops headers fall back to the defaults (and are logged once); other paths are forwarded but never recorded', async (t) => {
  const s = await stack(t, { proxyOptions: { tenant: 'fallback' } });
  await s.call({ 'x-finops-tenant': 'bad tenant!', 'x-finops-endpoint': 'no-slash' });
  await s.call({ 'x-finops-tenant': 'still bad!' });
  const rows = await s.rows(2);
  assert.deepEqual(rows.map((r) => [r.tenant_id, r.endpoint]), [['fallback', '/v1/messages'], ['fallback', '/v1/messages']]);
  assert.equal(s.logs.filter((l) => /invalid x-finops/.test(l)).length, 1, 'warned once, not per call');

  const models = await s.call({}, { method: 'GET', path: '/v1/models' });
  assert.equal(models.res.status, 200);
  const count = await s.call({}, { path: '/v1/messages/count_tokens' });
  assert.equal(count.res.status, 200);
  assert.deepEqual(s.upstream.received.slice(-2).map((r) => `${r.method} ${r.url}`), ['GET /v1/models', 'POST /v1/messages/count_tokens']);
  await sleep(150);
  assert.equal((await s.rows(2)).length, 2, 'pass-through paths are not recorded');
});

test('a request path can never pick another host: protocol-relative and absolute-form request lines are refused before anything is forwarded', async (t) => {
  const s = await stack(t);
  const raw = (line) => new Promise((resolve, reject) => {
    const sock = net.connect(s.proxy.port, '127.0.0.1', () => sock.write(`${line}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let out = '';
    sock.on('data', (d) => { out += d; });
    sock.on('end', () => resolve(out));
    sock.on('error', reject);
  });
  for (const line of ['POST //evil.example.test/v1/messages HTTP/1.1', 'POST http://evil.example.test/v1/messages HTTP/1.1', 'GET https://evil.example.test:8443/ HTTP/1.1', 'GET @evil.example.test/ HTTP/1.1']) {
    const out = await raw(line);
    assert.match(out, /^HTTP\/1\.1 400/, line);
  }
  assert.equal(s.upstream.received.length, 0, 'nothing reached the upstream');
  // odd paths that stay on the configured host are just paths on that host (a backslash is a path character, '@' only means something before the first '/')
  for (const path of ['/v1/messages/../models', '/x\\@evil.example.test', '/@evil.example.test/y']) {
    const r = await s.call({}, { method: 'GET', path });
    assert.equal(r.res.status, 200, path);
    assert.equal(s.upstream.received.at(-1).headers.host, new URL(s.upstream.url).host, `${path} was sent to the configured upstream and nowhere else`);
  }
  assert.equal(s.upstream.received.length, 3);
});

test('secrets: neither the API key nor the prompt/answer text is ever stored or logged - not in the database files, not in the proxy\'s log, not in /__finops/health', async (t) => {
  const s = await stack(t);
  await s.call({ 'x-test': 'json' });
  await s.call({ 'x-test': 'stream' });
  await s.rows(2);
  const health = await (await fetch(`${s.proxy.url}/__finops/health`)).text();
  assert.equal(JSON.parse(health).recorded, 2);
  const everything = [health, ...s.logs, ...readdirSync(s.dir).filter((f) => /^live\.db/.test(f)).map((f) => readFileSync(join(s.dir, f)).toString('latin1'))].join('\n');
  for (const secret of [KEY, 'SECRET prompt', 'SECRET answer', 'unreleased pricing', 'sk-ant']) assert.ok(!everything.includes(secret), `"${secret}" must not appear anywhere`);
  assert.ok(s.logs.length > 0, 'verbose mode did log (so the check above looked at something)');
});

test('the dashboard being down is not the app\'s problem: calls still work, records queue, and arrive when it comes back', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'finops-proxy-down-'));
  const upstream = await fakeUpstream();
  ensureLiveDb(join(dir, 'live.db'));
  const first = await createMultiApp({ dataDir: dir, port: 0, seedDays: 1, volumeScale: 0.1, simAutoStart: false, sourcesTtlMs: 0, detectEveryMs: 100000 });
  await first.listen();
  const port = first.port;
  await first.close(); // now nothing listens there
  const logs = [];
  const proxy = createProxy({ upstream: upstream.url, dashboard: `http://127.0.0.1:${port}`, source: 'live', port: 0, flushMs: 20, log: (m) => logs.push(m) });
  await proxy.listen();
  let dashboard;
  t.after(async () => { await proxy.close(); await dashboard?.close(); await upstream.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  for (let i = 0; i < 3; i++) assert.equal((await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: '{}' })).status, 200);
  await waitUntil(() => logs.some((l) => /cannot reach the dashboard/.test(l)), { what: 'a warning that the dashboard is unreachable' });
  assert.equal(proxy.stats.recorded, 0);
  assert.equal(proxy.recorder.pending.length, 3);
  assert.ok(!logs.join('\n').includes(KEY));

  dashboard = await createMultiApp({ dataDir: dir, port, seedDays: 1, volumeScale: 0.1, simAutoStart: false, sourcesTtlMs: 0, detectEveryMs: 100000 });
  await dashboard.listen();
  await waitUntil(() => proxy.stats.recorded === 3, { timeout: 15000, what: `the queued records to arrive (stats ${JSON.stringify(proxy.stats)})` });
  assert.equal(proxy.recorder.pending.length, 0);
});

test('a dashboard with AUTH_TOKEN: the proxy needs the same token (sent as a Bearer header), and says so when it is missing', async (t) => {
  const token = 'a-long-enough-shared-secret-123';
  const noToken = await stack(t, { dashboardOptions: { authToken: token }, proxyOptions: { authToken: '' } });
  await noToken.call({ 'x-test': 'json' });
  await waitUntil(() => noToken.logs.some((l) => /refused the proxy \(HTTP 401\).*AUTH_TOKEN/.test(l)), { what: `the 401 explanation (${JSON.stringify(noToken.logs)})` });
  assert.equal(noToken.proxy.stats.recorded, 0);

  const withToken = await stack(t, { dashboardOptions: { authToken: token }, proxyOptions: { authToken: token } });
  await withToken.call({ 'x-test': 'json' });
  const rows = await withToken.rows(1);
  assert.equal(rows[0].cost_micro_usd, EXPECT.cost);
});

test('a dashboard in single-database mode (DB_PATH) is found too: the ingest path is picked from /healthz', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'finops-proxy-single-'));
  const upstream = await fakeUpstream();
  ensureLiveDb(join(dir, 'one.db'));
  const dashboard = await createApp({ dbPath: join(dir, 'one.db'), port: 0, seedDays: 0, simAutoStart: false, detectEveryMs: 100000 });
  await dashboard.listen();
  const proxy = createProxy({ upstream: upstream.url, dashboard: dashboard.url, source: 'ignored-in-single-mode', port: 0, flushMs: 20 });
  await proxy.listen();
  t.after(async () => { await proxy.close(); await dashboard.close(); await upstream.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  await fetch(`${proxy.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test': 'json' }, body: '{}' });
  await waitUntil(() => proxy.stats.recorded === 1, { what: `a recorded request (${JSON.stringify(proxy.stats)})` });
  const sum = await (await fetch(`${dashboard.url}/api/summary`)).json();
  assert.equal(sum.totals.cost_micro_usd, EXPECT.cost);
});

test('guards: not the sample database, only this machine, https for anything remote, no credentials in URLs, never its own upstream', async () => {
  const ok = { upstream: 'https://api.anthropic.com', dashboard: 'http://127.0.0.1:8787', source: 'live', port: 0 };
  assert.doesNotThrow(() => createProxy(ok));
  assert.throws(() => createProxy({ ...ok, source: 'finops' }), /simulated sample database/);
  assert.throws(() => createProxy({ ...ok, source: '../etc' }), /database name/);
  assert.throws(() => createProxy({ ...ok, host: '0.0.0.0' }), /only listens on this machine/);
  assert.throws(() => createProxy({ ...ok, upstream: 'http://api.example.org' }), /upstream must be https/);
  assert.throws(() => createProxy({ ...ok, dashboard: 'http://dashboard.example.org' }), /dashboard must be https/);
  assert.throws(() => createProxy({ ...ok, upstream: 'https://user:pw@api.anthropic.com' }), /credentials/);
  assert.throws(() => createProxy({ ...ok, tenant: 'bad tenant' }), /tenant must match/);
  assert.throws(() => createProxy({ ...ok, upstream: 'not a url' }), /upstream is not a valid URL/);

  const loop = createProxy({ ...ok, upstream: 'http://127.0.0.1:18799', port: 18799 });
  await assert.rejects(loop.listen(), /the upstream is this proxy itself/);
});

test('ensureLiveDb: creates the database with the real price list, is idempotent, and refuses imported data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'finops-live-'));
  try {
    const path = join(dir, 'nested', 'live.db');
    assert.equal(ensureLiveDb(path), true);
    assert.equal(ensureLiveDb(path), false, 'a second call leaves it alone');
    const db = new DatabaseSync(path, { readOnly: true });
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001']) assert.ok(db.prepare('SELECT 1 AS x FROM model_prices WHERE model = ?').get(m), `${m} is priced`);
    db.close();

    const imported = join(dir, 'imported.db');
    const x = openDb(imported);
    setMeta(x, 'source', 'import:claude-code');
    x.close();
    assert.throws(() => ensureLiveDb(imported), /holds imported data/);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('usage mapping is the importer\'s: one definition, so imported and proxied numbers cannot disagree', () => {
  const cases = [
    USAGE,
    { input_tokens: 10, output_tokens: 5 },
    { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
    { input_tokens: 10, cache_creation_input_tokens: 700, output_tokens: 5 }, // an older client: no breakdown, all 5-minute writes
    { input_tokens: 10, cache_creation_input_tokens: 700, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 600 }, output_tokens: 5 },
  ];
  for (const u of cases) {
    const f = usageFields(u);
    const rec = buildRecord({ id: 'x', ts: 1, tenant: 't', endpoint: '/v1/messages', method: 'POST', status: 200, durationMs: 5, model: 'claude-sonnet-5-5', usage: u });
    const c = rec.llm_calls[0];
    assert.deepEqual([c.input_tokens, c.output_tokens, c.cached_tokens, c.cache_write_tokens, c.cache_write_1h_tokens], [f.input + f.read + f.w5 + f.w1, f.output, f.read, f.w5, f.w1]);
    assert.ok(c.cached_tokens + c.cache_write_tokens + c.cache_write_1h_tokens <= c.input_tokens, 'the ingest rule: input_tokens is the whole prompt');
  }
  assert.equal(buildRecord({ id: 'x', ts: 1, tenant: 't', endpoint: '/e', method: 'POST', status: 500, durationMs: 1, model: null, usage: null }).llm_calls.length, 0);

  const p = new SseUsage();
  p.push('event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":3,"output_tokens":1}}}\n\r\nevent: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":42,"input_tokens":null}}\n\nnot sse at all\ndata: {broken\n');
  assert.deepEqual(p.usage, { input_tokens: 3, output_tokens: 42 }, 'later values win, nulls and garbage are ignored');
  assert.equal(p.model, 'm');
});
