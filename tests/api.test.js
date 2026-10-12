import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { api, makeApp, mkRequest, insertAlert, WsClient, SseClient, randomCid } from './helpers.js';
import { HOUR } from '../src/util.js';

let app;
before(async () => { app = await makeApp({ seedDays: 3, volumeScale: 0.5 }); });
after(() => app.close());

const raw = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: app.port, path, method, headers }, (res) => {
    let t = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { t += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

/* ------------------------------------------------------------------ ingest over HTTP */

test('POST /api/ingest: accepts a valid batch, computes cost, and is idempotent', async () => {
  const ts = Math.floor(Date.now() / HOUR) * HOUR + 5;
  const req = mkRequest({ ts, tenant: 'ingest-test', calls: [{ model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 200, cached_tokens: 800 }], infra: 700, id: 'ingest-http-1' });
  const r = await api(app, 'POST', '/api/ingest', { body: { requests: [req] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { accepted: 1, duplicates: 0, llm_calls: 1, cost_micro_usd: 3840 + 700, rollup_rows: 2 });
  assert.equal((await api(app, 'POST', '/api/ingest', { body: { requests: [req] } })).json.duplicates, 1);
  const d = await api(app, 'GET', '/api/requests/ingest-http-1');
  assert.equal(d.status, 200);
  assert.equal(d.json.llm_calls.length, 1);
  assert.equal(d.json.llm_calls[0].cost_micro_usd, 3840);
  assert.equal(d.json.llm_calls[0].cached_tokens, 800);
  assert.equal(d.json.llm_calls[0].price.cached_per_mtok, 300000);
  assert.equal(d.json.total_cost_micro_usd, 4540);
});

test('request ids containing : and # (allowed by ingest) can be fetched percent-encoded; cache writes are returned', async () => {
  const ts = Math.floor(Date.now() / HOUR) * HOUR + 7;
  const id = 'turn:abc123#1';
  app.db.prepare("INSERT OR REPLACE INTO model_prices(model, input_per_mtok, output_per_mtok, cached_per_mtok, effective_from, cache_write_per_mtok, cache_write_1h_per_mtok) VALUES('cw-test', 2000000, 10000000, 200000, 0, 2500000, 4000000)").run();
  app.priceBook.reload();
  const req = mkRequest({ ts, tenant: 'colon-test', id, calls: [{ model: 'cw-test', input_tokens: 10_000, output_tokens: 100, cached_tokens: 6000, cache_write_tokens: 1000, cache_write_1h_tokens: 500 }] });
  assert.equal((await api(app, 'POST', '/api/ingest', { body: { requests: [req] } })).status, 200);
  const d = await api(app, 'GET', '/api/requests/' + encodeURIComponent(id));
  assert.equal(d.status, 200, d.text);
  assert.equal(d.json.id, id);
  const c = d.json.llm_calls[0];
  assert.deepEqual([c.cache_write_tokens, c.cache_write_1h_tokens, c.cost_micro_usd, c.price.cache_write_per_mtok, c.price.cache_write_1h_per_mtok], [1000, 500, 11_700, 2_500_000, 4_000_000]);
  assert.equal((await api(app, 'GET', '/api/requests/%E0%A4%A')).status, 400, 'malformed percent-encoding');
  assert.equal((await api(app, 'GET', '/api/requests/' + encodeURIComponent('a b'))).status, 404, 'decoded id outside the allowlist');
});

test('POST /api/ingest: validation errors come back as 400 with a list; the batch cap is 413', async () => {
  const bad = mkRequest({ ts: Date.now() });
  bad.llm_calls[0].model = 'gpt-nope';
  bad.status = 7;
  const r = await api(app, 'POST', '/api/ingest', { body: { requests: [bad] } });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.length >= 2);
  assert.match(r.json.errors.join('\n'), /model/);
  const many = await api(app, 'POST', '/api/ingest', { body: { requests: Array.from({ length: app.cfg.limits.maxBatch + 1 }, (_, i) => mkRequest({ ts: Date.now(), id: `cap-${i}` })) } });
  assert.equal(many.status, 413);
  assert.equal((await api(app, 'POST', '/api/ingest', { body: 'not json', raw: true })).status, 400);
});

/* ------------------------------------------------------------------ security */

test('POST requires a JSON content type and caps body size', async () => {
  const ok = JSON.stringify({ requests: [mkRequest({ ts: Date.now(), id: 'ct-1' })] });
  assert.equal((await api(app, 'POST', '/api/ingest', { body: ok, raw: true, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await api(app, 'POST', '/api/ingest', { body: ok, raw: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await raw('/api/ingest', { method: 'POST', body: ok })).status, 415, 'no content-type at all');
  // declared too large
  const huge = JSON.stringify({ requests: [], pad: 'x'.repeat(app.cfg.limits.ingestBodyBytes + 10) });
  assert.equal((await api(app, 'POST', '/api/ingest', { body: huge, raw: true })).status, 413);
  // small endpoints have a much smaller cap
  assert.equal((await api(app, 'POST', '/api/sim', { body: JSON.stringify({ pad: 'x'.repeat(20_000) }), raw: true })).status, 413);
  // chunked body with no Content-Length is still capped while streaming
  const chunked = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: app.port, path: '/api/sim', method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.write('{"pad":"'); req.write('x'.repeat(20_000)); req.end('"}');
  });
  assert.equal(chunked, 413);
});

test('POST checks Origin: foreign origins are rejected, same-origin and non-browser clients are fine', async () => {
  const body = { requests: [mkRequest({ ts: Date.now(), id: 'origin-1' })] };
  assert.equal((await api(app, 'POST', '/api/ingest', { body, headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await api(app, 'POST', '/api/ingest', { body, headers: { Origin: 'null' } })).status, 403);
  assert.equal((await api(app, 'POST', '/api/ingest', { body, headers: { Origin: `http://127.0.0.1:${app.port}.evil.example` } })).status, 403);
  for (const route of ['/api/sim', '/api/throttle', '/api/cancel', '/api/generate']) {
    assert.equal((await api(app, 'POST', route, { body: {}, headers: { Origin: 'http://evil.example' } })).status, 403, route);
  }
  assert.equal((await api(app, 'POST', '/api/alerts/1/ack', { body: {}, headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await api(app, 'POST', '/api/ingest', { body, headers: { Origin: `http://127.0.0.1:${app.port}` } })).status, 200);
  assert.equal((await api(app, 'POST', '/api/ingest', { body: { requests: [mkRequest({ ts: Date.now(), id: 'origin-2' })] }, headers: { Origin: `http://localhost:${app.port}` } })).status, 200);
  // nothing from the rejected attempts was written
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE id = 'origin-1'").get().n, 1, 'only the accepted attempt landed');
});

test('STRICT_ORIGIN=1 also rejects POSTs that carry no Origin at all', async () => {
  const strict = await makeApp({ strictOrigin: true, seedDays: 0 });
  try {
    const body = { requests: [mkRequest({ ts: Date.now() })] };
    const r = await fetch(strict.url + '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 403);
    const ok = await fetch(strict.url + '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: strict.url }, body: JSON.stringify(body) });
    assert.equal(ok.status, 200);
  } finally { await strict.close(); }
});

test('WebSocket upgrade checks Origin (and the Host header)', async () => {
  const cid = randomCid();
  const bad = await WsClient.connect(app, { cid, origin: 'http://evil.example' });
  assert.equal(bad.status, 403);
  const ok = await WsClient.connect(app, { cid: randomCid() });
  assert.equal(ok.status, 101);
  assert.equal(ok.acceptOk, true);
  ok.close();
  const noOrigin = await WsClient.connect(app, { cid: randomCid(), origin: null }); // non-browser client
  assert.equal(noOrigin.status, 101);
  noOrigin.close();
  const badHost = await WsClient.connect(app, { cid: randomCid(), headers: { Host: 'evil.example' } });
  assert.notEqual(badHost.status, 101);
  assert.equal((await WsClient.connect(app, { cid: 'short' })).status, 400, 'client ids are validated');
  assert.equal(app.hub.get(cid), undefined, 'a rejected upgrade never opens a channel');
});

test('Host header must be one we serve (DNS-rebinding guard)', async () => {
  assert.equal((await raw('/healthz', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await raw('/healthz', { headers: { Host: `localhost:${app.port}` } })).status, 200);
});

test('client ids and every query parameter are validated against an allowlist', async () => {
  for (const cid of ['', 'short', 'has space!!', 'x'.repeat(65), "'; DROP TABLE alerts;--", '../../etc/passwd']) {
    const c = await new SseClient(app, { cid: encodeURIComponent(cid) }).ready;
    assert.equal(c.status, 400, `cid ${JSON.stringify(cid)}`);
    c.close();
  }
  assert.equal((await api(app, 'POST', '/api/cancel', { body: { cid: 'bad cid' } })).status, 400);
  assert.equal((await api(app, 'POST', '/api/throttle', { body: { cid: 'bad cid', bytes_per_sec: 1 } })).status, 400);
  assert.equal((await api(app, 'POST', '/api/generate', { body: { cid: 'abcdefgh12', alert_id: 1, extra: 1 } })).status, 400, 'unknown body fields');
  const bads = [
    '/api/summary?range=1y', '/api/summary?range=24h&range=7d', '/api/summary?bogus=1', "/api/by-tenant?tenant=' OR 1=1 --",
    '/api/by-endpoint?endpoint=no-slash', '/api/by-model?model=a%20b', '/api/timeseries?group=password', '/api/timeseries?top=99',
    '/api/requests?limit=100000', '/api/requests?sort=name;drop', '/api/alerts?status=everything', '/api/alerts?limit=-1', '/api/export.csv', '/api/export.csv?view=users',
    '/api/stats?cid=bad', '/api/summary?tenant=' + 'a'.repeat(200),
  ];
  for (const b of bads) assert.equal((await api(app, 'GET', b)).status, 400, b);
  assert.equal((await api(app, 'GET', '/api/requests/' + encodeURIComponent("x' OR '1'='1"))).status, 404);
});

test('responses carry a CSP and hardening headers; static files are allowlisted (no traversal)', async () => {
  const r = await api(app, 'GET', '/healthz');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const page = await api(app, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self' ws:\/\/127\.0\.0\.1:\d+/);
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/src/server.js', '/..%2fpackage.json', '/data/finops.db']) {
    assert.equal((await raw(p)).status, 404, p);
  }
});

test('binds to loopback by default', () => {
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.equal(app.cfg.host, '127.0.0.1');
});

test('unsupported methods and unknown routes', async () => {
  assert.equal((await raw('/api/summary', { method: 'DELETE' })).status, 405);
  assert.equal((await raw('/api/nope')).status, 404);
  assert.equal((await api(app, 'POST', '/api/nope', { body: {} })).status, 404);
});

/* ------------------------------------------------------------------ read API */

test('/healthz and /api/stats', async () => {
  assert.equal((await api(app, 'GET', '/healthz')).json.ok, true);
  const s = (await api(app, 'GET', '/api/stats?verify=1')).json;
  assert.equal(s.rollups_consistent, true, 'stored rollups equal a brute-force recomputation');
  assert.ok(s.db.requests > 1000 && s.db.rollups > 100);
  assert.equal(typeof s.sim.rate, 'number');
  assert.equal(s.llm.default_source, 'mock');
  assert.equal(s.llm.anthropic_enabled, false);
});

test('summary, tables and timeseries agree with each other and with the filters', async () => {
  const sum = (await api(app, 'GET', '/api/summary?range=7d')).json;
  const t = sum.totals;
  assert.equal(t.cost_micro_usd, t.llm_cost_micro_usd + t.infra_cost_micro_usd);
  assert.ok(Math.abs(t.llm_share - t.llm_cost_micro_usd / t.cost_micro_usd) < 1e-12);
  assert.ok(Math.abs(t.cost_per_1k_requests_micro_usd - (t.cost_micro_usd / t.requests) * 1000) < 1e-6);
  assert.ok(sum.projection.projected_micro_usd >= sum.projection.month_to_date_micro_usd);
  assert.ok(sum.window.latest > 0);

  for (const dim of ['tenant', 'endpoint', 'model']) {
    const d = (await api(app, 'GET', `/api/by-${dim}?range=7d`)).json;
    assert.equal(d.rows.reduce((n, r) => n + r.cost_micro_usd, 0), t.cost_micro_usd, `${dim} rows add up to the total`);
    assert.ok(Math.abs(d.rows.reduce((n, r) => n + r.share, 0) - 1) < 1e-9);
    assert.equal(d.rows[0].spark.length, sum.window.buckets);
    assert.equal(d.rows[0].spark.reduce((a, b) => a + b, 0), d.rows[0].cost_micro_usd, 'sparkline sums to the row');
    assert.deepEqual(d.rows.map((r) => r.cost_micro_usd), [...d.rows.map((r) => r.cost_micro_usd)].sort((a, b) => b - a), 'sorted by cost');
  }
  const bt = (await api(app, 'GET', '/api/by-tenant?range=7d')).json;
  assert.ok(bt.rows.length >= 8, 'the 8 simulated tenants (plus any added by earlier tests)');
  const acme = bt.rows.find((r) => r.key === 'acme');
  assert.ok(acme.cost_per_request_micro_usd > 0 && acme.requests > 0);

  // clicking a row filters everything...
  const f = (await api(app, 'GET', '/api/summary?range=7d&tenant=acme')).json;
  assert.equal(f.totals.cost_micro_usd, acme.cost_micro_usd);
  // ...but the table for that dimension keeps showing its siblings (cross-filtering)
  assert.equal((await api(app, 'GET', '/api/by-tenant?range=7d&tenant=acme')).json.rows.length, bt.rows.length);
  const ep = (await api(app, 'GET', '/api/by-endpoint?range=7d&tenant=acme')).json;
  assert.equal(ep.rows.reduce((n, r) => n + r.cost_micro_usd, 0), acme.cost_micro_usd, 'other tables respect the tenant filter');
  // a model filter makes per-request numbers unattributable: null rather than a wrong number
  const m = (await api(app, 'GET', '/api/summary?range=7d&model=claude-opus-5-5')).json;
  assert.equal(m.totals.requests, null);
  assert.equal(m.totals.cost_per_request_micro_usd, null);
  assert.equal(m.totals.llm_share, 1);

  const ts = (await api(app, 'GET', '/api/timeseries?range=7d&group=tenant')).json;
  assert.equal(ts.series.length, 8, 'top 7 tenants + Other');
  assert.equal(ts.series.at(-1).key, 'Other');
  assert.equal(ts.series.at(-1).other, true);
  assert.equal(ts.series.reduce((n, s) => n + s.total, 0), t.cost_micro_usd, 'stack adds up to total spend');
  assert.equal(ts.buckets.length, sum.window.buckets);
  assert.ok(ts.series.slice(0, -1).every((s, i, a) => !i || a[i - 1].total >= s.total), 'top series are ranked by cost');
  const day = (await api(app, 'GET', '/api/timeseries?range=24h&group=model&top=2')).json;
  assert.equal(day.buckets.length, 24);
  assert.ok(day.series.length <= 3);
  const total = (await api(app, 'GET', '/api/timeseries?range=30d&group=total')).json;
  assert.equal(total.buckets.length, 30);
  assert.equal(total.series.length, 1);
});

test('drill-down: request list (by cost or recency) and request detail with LLM calls', async () => {
  const top = (await api(app, 'GET', '/api/requests?range=7d&sort=cost&limit=5')).json;
  assert.equal(top.rows.length, 5);
  assert.ok(top.rows.every((r, i, a) => !i || a[i - 1].llm_cost_micro_usd >= r.llm_cost_micro_usd));
  const detail = (await api(app, 'GET', `/api/requests/${encodeURIComponent(top.rows[0].id)}`)).json;
  assert.equal(detail.id, top.rows[0].id);
  assert.equal(detail.llm_cost_micro_usd, detail.llm_calls.reduce((n, c) => n + c.cost_micro_usd, 0));
  assert.equal(detail.total_cost_micro_usd, detail.llm_cost_micro_usd + detail.infra_cost_micro_usd);
  for (const c of detail.llm_calls) assert.ok(c.input_tokens >= c.cached_tokens && c.latency_ms >= 0 && c.model);
  const recent = (await api(app, 'GET', '/api/requests?sort=recent&tenant=acme&limit=10')).json;
  assert.equal(recent.rows.length, 10);
  assert.ok(recent.rows.every((r) => r.tenant_id === 'acme'));
  assert.ok(recent.rows.every((r, i, a) => !i || a[i - 1].ts >= r.ts));
  const byModel = (await api(app, 'GET', '/api/requests?sort=cost&model=claude-haiku-5-5&limit=3')).json;
  for (const r of byModel.rows) assert.ok((await api(app, 'GET', `/api/requests/${r.id}`)).json.llm_calls.some((c) => c.model === 'claude-haiku-5-5'));
  assert.equal((await api(app, 'GET', '/api/requests/does-not-exist')).status, 404);
});

test('alerts: list, acknowledge, resolve and their state rules', async () => {
  const id = insertAlert(app, { tenant: 'acme' });
  const other = insertAlert(app, { tenant: 'globex', kind: 'volume_spike' });
  const list = (await api(app, 'GET', '/api/alerts?status=active')).json.alerts;
  assert.ok(list.some((a) => a.id === id && a.status === 'open' && a.severity));
  assert.ok((await api(app, 'GET', '/api/alerts?tenant=globex')).json.alerts.every((a) => a.tenant_id === 'globex' || a.tenant_id === null));
  const ack = await api(app, 'POST', `/api/alerts/${id}/ack`, { body: {} });
  assert.equal(ack.status, 200);
  assert.equal(ack.json.status, 'ack');
  assert.equal((await api(app, 'GET', '/api/summary')).json.alerts.acked >= 1, true);
  assert.equal((await api(app, 'POST', `/api/alerts/${id}/resolve`, { body: {} })).json.status, 'resolved');
  assert.equal((await api(app, 'POST', `/api/alerts/${id}/ack`, { body: {} })).status, 409, 'resolved alerts cannot be re-acknowledged');
  assert.equal((await api(app, 'POST', '/api/alerts/99999999/ack', { body: {} })).status, 404);
  assert.equal((await api(app, 'POST', `/api/alerts/${other}/resolve`, { body: {} })).json.status, 'resolved', 'resolve straight from open');
  assert.ok(!(await api(app, 'GET', '/api/alerts?status=active')).json.alerts.some((a) => a.id === id || a.id === other));
  assert.equal((await api(app, 'POST', `/api/alerts/${id}/ack`, { body: {}, headers: { 'Content-Type': 'text/plain' } })).status, 415);
});

test('CSV export follows the current view and neutralises spreadsheet formulas', async () => {
  const ts = Math.floor(Date.now() / HOUR) * HOUR + 7;
  await api(app, 'POST', '/api/ingest', { body: { requests: [mkRequest({ ts, tenant: '-evil', id: 'csv-1' })] } });
  const r = await api(app, 'GET', '/api/export.csv?view=tenant&range=24h');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="finops-tenant_range-24h\.csv"/);
  const lines = r.text.trim().split('\r\n');
  assert.equal(lines[0], 'tenant,cost_usd,llm_cost_usd,share,requests,llm_calls,tokens_in,tokens_out,cost_per_request_usd,cost_per_call_usd');
  assert.ok(lines.some((l) => l.startsWith("'-evil,")), 'a value starting with - is prefixed with a quote');
  assert.ok(lines.length >= 9);
  const sum = (await api(app, 'GET', '/api/summary?range=24h')).json.totals.cost_micro_usd;
  const cost = lines.slice(1).reduce((n, l) => n + Number(l.split(',')[1]), 0);
  assert.ok(Math.abs(cost - sum / 1e6) < 1e-3, 'CSV total equals the dashboard total');
  const filtered = await api(app, 'GET', '/api/export.csv?view=endpoint&range=7d&tenant=acme');
  assert.match(filtered.headers.get('content-disposition'), /tenant-acme/);
  assert.ok((await api(app, 'GET', '/api/export.csv?view=alerts')).text.startsWith('id,ts_utc,kind'));
  assert.ok((await api(app, 'GET', '/api/export.csv?view=requests&range=24h')).text.startsWith('id,ts_utc,tenant'));
  assert.ok((await api(app, 'GET', '/api/export.csv?view=timeseries&group=model')).text.startsWith('bucket_start_utc,model,cost_usd'));
});

test('/api/sim and /api/throttle validate their input', async () => {
  assert.equal((await api(app, 'POST', '/api/sim', { body: { rate: 100 } })).json.rate, 100);
  assert.equal((await api(app, 'POST', '/api/sim', { body: { rate: 10_000_000 } })).status, 400);
  assert.equal((await api(app, 'POST', '/api/sim', { body: { inject: 'meteor' } })).status, 400);
  assert.equal((await api(app, 'POST', '/api/sim', { body: { rate: 'fast' } })).status, 400);
  assert.equal((await api(app, 'POST', '/api/throttle', { body: { bytes_per_sec: -5 } })).status, 400);
  assert.equal((await api(app, 'POST', '/api/throttle', { body: {} })).status, 400);
  assert.equal((await api(app, 'POST', '/api/throttle', { body: { bytes_per_sec: 1000 } })).json.scope, 'all');
  await api(app, 'POST', '/api/throttle', { body: { bytes_per_sec: 0 } });
  assert.equal((await api(app, 'POST', '/api/throttle', { body: { cid: 'abcdefgh12', bytes_per_sec: 5 } })).status, 404);
});
