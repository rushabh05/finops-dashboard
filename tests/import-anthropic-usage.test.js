import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AdminApiError, AdminClient, buildRequests, crossCheck, usageParams, costParams } from '../src/import/anthropic-usage.js';
import { ALL_PRICES } from '../src/import/prices.js';
import { PriceBook } from '../src/pricing.js';
import { discoverSources } from '../src/multi.js';
import { openDb } from '../src/db.js';
import { installPrices } from '../src/import/prices.js';

/*
 * Anthropic Usage & Cost Admin API -> dashboard. The API is a fake that follows the documented contract (parameters, headers, pagination with
 * has_more / next_page, cost amounts in CENTS as decimal strings) and generates deterministic hourly usage, so the importer's numbers can be
 * checked against sums computed here independently of the importer's code.
 */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KEY = 'sk-ant-admin01-SECRET-ADMIN-KEY-do-not-print';
const H = 3_600_000, D = 24 * H;
const WS_A = 'wrkspc_01AAAAAAAAAAAAAAAAAAAAAA', WS_B = 'wrkspc_01BBBBBBBBBBBBBBBBBBBBBB';
const PRICE = Object.fromEntries(ALL_PRICES.map((p) => [p.model, p]));

/** What was used in the hour starting at ts: deterministic, with the quirks of the real report (empty hours, a null workspace, a batch tier, an unpriced model, an all-zero row). */
function groupsAt(ts) {
  const h = Math.floor(ts / H);
  const g = [];
  if (h % 3 !== 0) g.push({ ws: WS_A, model: 'claude-sonnet-5-5', tier: 'standard', ctx: '0-200k', uncached: 1000 + (h % 7), read: 500, w5: 200, w1: 0, out: 300, search: h % 4 === 0 ? 2 : 0 });
  if (h % 5 === 0) g.push({ ws: null, model: 'claude-haiku-4-5-20251001', tier: 'batch', ctx: '0-200k', uncached: 2000, read: 0, w5: 0, w1: 0, out: 100, search: 0 });
  if (h % 11 === 0) g.push({ ws: WS_B, model: 'claude-mystery-9', tier: 'standard', ctx: '0-200k', uncached: 50, read: 0, w5: 0, w1: 0, out: 5, search: 0 });
  if (h % 13 === 0) g.push({ ws: WS_A, model: 'claude-opus-5-5', tier: 'standard', ctx: '0-200k', uncached: 0, read: 0, w5: 0, w1: 0, out: 0, search: 0 });
  return g;
}
const usd = (g) => { // list price of the group's tokens, in USD (prices are micro-USD per million tokens)
  const p = PRICE[g.model];
  return p ? (g.uncached * p.input_per_mtok + g.read * p.cached_per_mtok + g.w5 * p.cache_write_per_mtok + g.w1 * p.cache_write_1h_per_mtok + g.out * p.output_per_mtok) / 1e12 : 0;
};
const usageResult = (g) => ({
  account_id: null, api_key_id: null, cache_creation: { ephemeral_1h_input_tokens: g.w1, ephemeral_5m_input_tokens: g.w5 }, cache_read_input_tokens: g.read, context_window: g.ctx,
  inference_geo: null, model: g.model, output_tokens: g.out, server_tool_use: { web_search_requests: g.search }, service_account_id: null, service_tier: g.tier,
  uncached_input_tokens: g.uncached, workspace_id: g.ws,
});

async function fakeAdminApi({ failUsage = 0, failCost = 0, rateLimitFirst = false } = {}) {
  const calls = [];
  const servedHours = [];
  let limited = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push({ path: url.pathname, params: url.searchParams, headers: req.headers });
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    const bad = (m) => send(400, { type: 'error', error: { type: 'invalid_request_error', message: m } });
    if (req.headers['x-api-key'] !== KEY) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (req.headers['anthropic-version'] !== '2023-06-01') return bad('anthropic-version header required');
    const q = url.searchParams;
    const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
    if (!iso.test(q.get('starting_at') ?? '') || !iso.test(q.get('ending_at') ?? '')) return bad('starting_at / ending_at must be RFC 3339');
    const start = Date.parse(q.get('starting_at')), end = Date.parse(q.get('ending_at'));
    if (url.pathname === '/v1/organizations/usage_report/messages') {
      if (rateLimitFirst && !limited) { limited = true; return send(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '0' }); }
      if (failUsage) return send(failUsage, { type: 'error', error: { type: 'api_error', message: 'boom' } });
      const width = q.get('bucket_width') ?? '1d', step = width === '1h' ? H : D, max = width === '1h' ? 168 : 31;
      const limit = Number(q.get('limit') ?? (width === '1h' ? 24 : 7));
      if (!(limit >= 1 && limit <= max)) return bad(`limit must be 1..${max} for ${width}`);
      const groupBy = q.getAll('group_by[]');
      for (const need of ['model', 'service_tier', 'context_window']) if (!groupBy.includes(need)) return bad(`group_by[] must include ${need}`);
      const starts = [];
      for (let t = Math.floor(start / step) * step; t + step <= end; t += step) starts.push(t);
      const from = q.get('page') ? Number(q.get('page').replace('page_', '')) : 0;
      const slice = starts.slice(from, from + limit);
      const data = slice.map((t) => {
        const hours = step === H ? [t] : Array.from({ length: 24 }, (_, i) => t + i * H);
        const merged = new Map();
        for (const hh of hours) { if (step === H) servedHours.push(hh); for (const g of groupsAt(hh)) { const k = JSON.stringify([g.ws, g.model, g.tier, g.ctx]); const m = merged.get(k); if (m) for (const f of ['uncached', 'read', 'w5', 'w1', 'out', 'search']) m[f] += g[f]; else merged.set(k, { ...g }); } }
        return { starting_at: new Date(t).toISOString().replace('.000Z', 'Z'), ending_at: new Date(t + step).toISOString().replace('.000Z', 'Z'), results: [...merged.values()].map(usageResult) };
      });
      const more = from + limit < starts.length;
      return send(200, { data, has_more: more, next_page: more ? `page_${from + limit}` : null });
    }
    if (url.pathname === '/v1/organizations/cost_report') {
      if (failCost) return send(failCost, { type: 'error', error: { type: 'api_error', message: 'cost report down' } });
      if (q.get('bucket_width') !== '1d' || !(Number(q.get('limit')) >= 1 && Number(q.get('limit')) <= 31)) return bad('cost report: bucket_width 1d, limit 1..31');
      if (!q.getAll('group_by[]').includes('description')) return bad('group_by[] description expected');
      const days = [];
      for (let t = Math.floor(start / D) * D; t + D <= end; t += D) days.push(t);
      const data = days.map((t) => {
        const agg = new Map();
        for (let i = 0; i < 24; i++) for (const g of groupsAt(t + i * H)) {
          if (!PRICE[g.model]) continue;
          const k = `${g.ws}|${g.model}|${g.tier}`;
          const billed = usd(g) * (g.tier === 'batch' ? 0.5 : 1);
          agg.set(k, { g, usd: (agg.get(k)?.usd ?? 0) + billed });
        }
        const results = [...agg.values()].map(({ g, usd: u }) => ({ amount: (u * 100).toFixed(5), context_window: g.ctx, cost_type: 'tokens', currency: 'USD', description: `${g.model} Usage`, inference_geo: 'global', model: g.model, service_tier: g.tier, token_type: null, workspace_id: g.ws }));
        results.push({ amount: '12.5', context_window: null, cost_type: 'web_search', currency: 'USD', description: 'Web Search Usage', inference_geo: null, model: null, service_tier: null, token_type: null, workspace_id: null });
        return { starting_at: new Date(t).toISOString().replace('.000Z', 'Z'), ending_at: new Date(t + D).toISOString().replace('.000Z', 'Z'), results };
      });
      return send(200, { data, has_more: false, next_page: null });
    }
    return send(404, { type: 'error', error: { type: 'not_found_error', message: 'no such route' } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, servedHours, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}

function runImporter(args, { env = {} } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'import-anthropic-usage.js'), ...args], { cwd: ROOT, env: { ...process.env, ANTHROPIC_ADMIN_KEY: KEY, FINOPS_CLI: '', ...env } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('exit', (code) => resolveRun({ code, out, err }));
  });
}
const withDir = async (fn) => { const dir = mkdtempSync(join(tmpdir(), 'finops-usage-')); try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const priceBook = () => { const db = openDb(':memory:'); installPrices(db); return new PriceBook(db); };

test('the importer asks for what the documentation says: day-aligned RFC 3339 times, 1h buckets at the maximum limit, grouped by model, tier, context window and workspace; the key only in a header', async (t) => {
  const api = await fakeAdminApi();
  t.after(() => api.close());
  await withDir(async (dir) => {
    const r = await runImporter(['--base-url', api.url, '--db', join(dir, 'u.db'), '--days', '3'], { env: { DATA_DIR: dir } });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const usage = api.calls.filter((c) => c.path === '/v1/organizations/usage_report/messages');
    const cost = api.calls.filter((c) => c.path === '/v1/organizations/cost_report');
    assert.equal(usage.length, 1);
    assert.equal(cost.length, 1);
    const u = usage[0];
    assert.match(u.params.get('starting_at'), /T00:00:00Z$/, 'whole UTC days, so the (daily) bill lines up');
    assert.equal(u.params.get('bucket_width'), '1h');
    assert.equal(u.params.get('limit'), '168');
    assert.deepEqual(u.params.getAll('group_by[]'), ['model', 'service_tier', 'context_window', 'workspace_id']);
    assert.equal(u.headers['x-api-key'], KEY);
    assert.equal(u.headers['anthropic-version'], '2023-06-01');
    assert.match(u.headers['user-agent'], /^finops-dashboard\/\d+\.\d+\.\d+ \(https:\/\/github\.com\/rushabh05\/finops-dashboard#readme\)$/);
    assert.ok(!u.params.toString().includes('SECRET'), 'the key is never in a URL');
    const c = cost[0];
    assert.equal(c.params.get('bucket_width'), '1d');
    assert.deepEqual(c.params.getAll('group_by[]'), ['description', 'workspace_id']);
    assert.equal(c.params.get('ending_at'), new Date(Math.floor(Date.now() / D) * D).toISOString().replace('.000Z', 'Z'), 'complete days only: the bill for today is still being written');
  });
});

test('end to end: rows, tokens, tenants and cost equal sums computed independently from the fake data; skips and caveats are reported; the key is never printed or stored', async (t) => {
  const api = await fakeAdminApi();
  t.after(() => api.close());
  await withDir(async (dir) => {
    const db = join(dir, 'anthropic-usage.db');
    const r = await runImporter(['--base-url', api.url, '--db', db, '--days', '3'], { env: { DATA_DIR: dir } });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);

    // independent expectation over the hours the fake actually served
    let rows = 0, tin = 0, tout = 0, cost = 0, searches = 0, skippedTokens = 0, batchTokens = 0;
    const tenants = new Set(), endpoints = new Set();
    for (const t of api.servedHours) for (const g of groupsAt(t)) {
      searches += g.search;
      const input = g.uncached + g.read + g.w5 + g.w1;
      if (input + g.out === 0) continue;
      if (!PRICE[g.model]) { skippedTokens += input + g.out; continue; }
      rows++; tin += input; tout += g.out; cost += usd(g);
      tenants.add(g.ws ?? 'default-workspace'); endpoints.add(`/usage/${g.tier}/${g.ctx}`);
      if (g.tier === 'batch') batchTokens += input + g.out;
    }
    const d = new DatabaseSync(db, { readOnly: true });
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM requests').get().n, rows);
    const t = d.prepare('SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost_micro_usd) AS c FROM llm_calls').get();
    assert.deepEqual([t.i, t.o], [tin, tout]);
    assert.ok(Math.abs(t.c / 1e6 - cost) < rows * 1e-6, `cost ${t.c / 1e6} vs ${cost}`);
    assert.deepEqual(new Set(d.prepare('SELECT DISTINCT tenant_id FROM requests').all().map((x) => x.tenant_id)), tenants);
    assert.deepEqual(new Set(d.prepare('SELECT DISTINCT endpoint FROM requests').all().map((x) => x.endpoint)), endpoints);
    assert.equal(d.prepare("SELECT value FROM meta WHERE key = 'source'").get().value, 'import:anthropic-usage');
    assert.match(d.prepare("SELECT value FROM meta WHERE key = 'source_note'").get().value, /NOT one API call/);
    assert.equal(d.prepare('SELECT COUNT(*) AS n FROM alerts').get().n, 0, 'no detection on aggregated data');
    d.close();

    // what it says about itself
    assert.match(r.out, new RegExp(`${skippedTokens} tokens of "claude-mystery-9" were skipped: no price known`));
    assert.match(r.out, new RegExp(`${batchTokens.toLocaleString('en-US')} tokens in tier / context "batch / 0-200k" are priced at standard rates`));
    assert.match(r.out, new RegExp(`${searches} server-side web searches`));
    assert.match(r.out, /Rollups vs brute-force recomputation: consistent/);
    assert.match(r.out, /finops start|DB_PATH=.*npm start/);

    // the bill check: standard tier agrees exactly; batch is billed at half, which the check shows as x2.000
    const std = /standard tier: computed \$([\d.]+) vs billed \$([\d.]+)\s+\(ratio ([\d.]+)\)/.exec(r.out);
    assert.ok(std, r.out);
    assert.ok(Math.abs(Number(std[3]) - 1) < 0.001, `standard ratio ${std[3]}`);
    assert.doesNotMatch(r.out, /more than 2% apart/);
    assert.match(r.out, /claude-haiku-4-5-20251001 \[batch\]\s+computed\s+\$[\d.]+\s+billed\s+\$[\d.]+\s+x2\.00/);

    // secrets
    const everything = r.out + r.err + readdirSync(dir).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('');
    assert.ok(!everything.includes(KEY) && !everything.includes('sk-ant-admin'), 'the Admin key appears nowhere: not printed, not in the database');

    // the dashboard lists it under a readable name
    const src = discoverSources(dir).find((s) => s.id === 'anthropic-usage');
    assert.equal(src.label, 'Anthropic usage (Admin API)');
    assert.equal(src.kind, 'imported');
  });
});

test('a long period is fetched page by page (has_more / next_page), and a failing cost report does not fail the import', async (t) => {
  const api = await fakeAdminApi({ failCost: 400 });
  t.after(() => api.close()); // (5xx retries are covered by the AdminClient test; a 4xx fails at once)
  await withDir(async (dir) => {
    const r = await runImporter(['--base-url', api.url, '--db', join(dir, 'u.db'), '--days', '10'], { env: { DATA_DIR: dir } });
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const usage = api.calls.filter((c) => c.path === '/v1/organizations/usage_report/messages');
    assert.ok(usage.length >= 2, `10 days of hourly buckets are more than one page of 168 (${usage.length} pages)`);
    assert.equal(usage[0].params.get('page'), null);
    assert.match(usage[1].params.get('page'), /^page_168$/);
    assert.equal(new Set(api.servedHours).size, api.servedHours.length, 'no bucket was fetched twice');
    assert.match(r.out, /Cost check failed: the Admin API answered HTTP 400.*The import itself is complete\./);
    assert.match(r.out, /Rollups vs brute-force recomputation: consistent/);
  });
});

test('errors say what to do: a refused key, a missing key, bad options, a remote http URL; --no-cost-check skips the bill; --replace is needed to overwrite', async (t) => {
  const api = await fakeAdminApi();
  t.after(() => api.close());
  await withDir(async (dir) => {
    const db = join(dir, 'u.db');
    const refused = await runImporter(['--base-url', api.url, '--db', db], { env: { ANTHROPIC_ADMIN_KEY: 'sk-ant-wrong-key', DATA_DIR: dir } });
    assert.equal(refused.code, 1);
    assert.match(refused.err + refused.out, /refused the key \(HTTP 401\).*organization Admin API key.*workspace API keys and individual accounts do not work/);
    assert.ok(!(refused.err + refused.out).includes('sk-ant-wrong-key'), 'even a wrong key is not echoed');

    const none = await runImporter(['--base-url', api.url, '--db', db], { env: { ANTHROPIC_ADMIN_KEY: '', DATA_DIR: dir } });
    assert.equal(none.code, 2);
    assert.match(none.err, /ANTHROPIC_ADMIN_KEY is not set.*individual accounts have none/);

    assert.match((await runImporter(['--bucket', '5m'], { env: { DATA_DIR: dir } })).err, /--bucket must be 1h or 1d/);
    assert.match((await runImporter(['--tenant-by', 'pet'], { env: { DATA_DIR: dir } })).err, /--tenant-by must be one of/);
    assert.match((await runImporter(['--days', '0'], { env: { DATA_DIR: dir } })).err, /bad --days/);
    assert.match((await runImporter(['--since', 'last-week'], { env: { DATA_DIR: dir } })).err, /bad --since/);
    assert.match((await runImporter(['--base-url', 'http://api.example.org'], { env: { DATA_DIR: dir } })).err, /--base-url must be https/);
    assert.match((await runImporter(['--bogus'], { env: { DATA_DIR: dir } })).out, /usage: .*import:anthropic-usage/);

    const first = await runImporter(['--base-url', api.url, '--db', db, '--days', '2', '--no-cost-check'], { env: { DATA_DIR: dir } });
    assert.equal(first.code, 0, `${first.out}\n${first.err}`);
    assert.match(first.out, /Cost check skipped/);
    assert.equal(api.calls.filter((c) => c.path === '/v1/organizations/cost_report').length, 0);
    const again = await runImporter(['--base-url', api.url, '--db', db, '--days', '2', '--no-cost-check'], { env: { DATA_DIR: dir } });
    assert.notEqual(again.code, 0, 'it will not overwrite an existing database by accident');
    assert.match(again.err + again.out, /--replace/);
    const replaced = await runImporter(['--base-url', api.url, '--db', db, '--days', '2', '--no-cost-check', '--replace'], { env: { DATA_DIR: dir } });
    assert.equal(replaced.code, 0, `${replaced.out}\n${replaced.err}`);
  });
});

test('--tenant-by api-key / account / service-account group by that dimension; ids that are not valid tenant names are made valid', () => {
  const book = priceBook();
  const bucket = (r) => [{ starting_at: '2026-10-01T00:00:00Z', ending_at: '2026-10-01T01:00:00Z', results: [r] }];
  const base = { model: 'claude-sonnet-5-5', service_tier: 'standard', context_window: '0-200k', uncached_input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } };
  const key = buildRequests(bucket({ ...base, api_key_id: 'apikey_01Rj2N8SVvo6BePZj99NhmiT', workspace_id: 'ignored' }), { tenantBy: 'api-key', priceBook: book });
  assert.equal(key.requests[0].tenant_id, 'apikey_01Rj2N8SVvo6BePZj99NhmiT');
  assert.equal(buildRequests(bucket({ ...base, api_key_id: null }), { tenantBy: 'api-key', priceBook: book }).requests[0].tenant_id, 'console-or-unknown-key');
  assert.equal(buildRequests(bucket({ ...base, account_id: 'user with spaces & symbols!' }), { tenantBy: 'account', priceBook: book }).requests[0].tenant_id, 'user_with_spaces___symbols_');
  assert.equal(buildRequests(bucket({ ...base, service_account_id: 'svac_01Hk' }), { tenantBy: 'service-account', priceBook: book }).requests[0].tenant_id, 'svac_01Hk');
  const p = usageParams({ fromMs: Date.UTC(2026, 9, 1), toMs: Date.UTC(2026, 9, 3), bucket: '1d', tenantBy: 'api-key' });
  assert.deepEqual(p.filter(([k]) => k === 'group_by[]').map(([, v]) => v), ['model', 'service_tier', 'context_window', 'api_key_id']);
  assert.deepEqual(p.find(([k]) => k === 'limit'), ['limit', '31']);
  assert.deepEqual(costParams({ fromMs: 0, toMs: D }).find(([k]) => k === 'limit'), ['limit', '31']);
});

test('buildRequests: token mapping (input is the whole prompt), zero rows and empty buckets skipped, unique valid ids, unpriced and non-standard usage tallied', () => {
  const book = priceBook();
  const res = (o) => ({ model: 'claude-sonnet-5-5', service_tier: 'standard', context_window: '0-200k', workspace_id: WS_A, uncached_input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, server_tool_use: { web_search_requests: 0 }, ...o });
  const buckets = [
    { starting_at: '2026-10-01T00:00:00Z', ending_at: '2026-10-01T01:00:00Z', results: [] },
    { starting_at: '2026-10-01T01:00:00Z', ending_at: '2026-10-01T02:00:00Z', results: [
      res({ uncached_input_tokens: 1000, cache_read_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 100 }, output_tokens: 300, server_tool_use: { web_search_requests: 3 } }),
      res({}),                                                                            // all zero: skipped
      res({ model: 'claude-sonnet-5-5-20260101', uncached_input_tokens: 7, output_tokens: 1 }), // dated alias of a priced model
      res({ model: 'gpt-nonsense-1', uncached_input_tokens: 5, output_tokens: 5 }),         // no price
      res({ service_tier: 'priority', context_window: '200k-1M', uncached_input_tokens: 40, output_tokens: 2 }),
      res({ workspace_id: null, uncached_input_tokens: 1, output_tokens: 1 }),
    ] },
  ];
  const b = buildRequests(buckets, { tenantBy: 'workspace', priceBook: book });
  assert.equal(b.emptyBuckets, 1);
  assert.equal(b.webSearches, 3);
  assert.deepEqual([...b.unpriced], [['gpt-nonsense-1', 10]]);
  assert.deepEqual([...b.nonStandard], [['priority / 200k-1M', 42]]);
  const [first] = b.requests;
  // the row for the dated alias (7 in, 1 out) normalises to the same group as the first, so it is SUMMED into it: two rows with one id would let ingest drop one silently
  assert.deepEqual(first.llm_calls[0], { model: 'claude-sonnet-5-5', input_tokens: 1807, output_tokens: 301, cached_tokens: 500, cache_write_tokens: 200, cache_write_1h_tokens: 100, latency_ms: 0 });
  assert.equal(b.requests.length, 3, 'merged group + priority/long-context + null workspace');
  assert.equal(first.ts, Date.parse('2026-10-01T01:00:00Z'));
  assert.equal(first.endpoint, '/usage/standard/0-200k');
  assert.equal(b.requests.find((r) => r.llm_calls[0].input_tokens === 1).tenant_id, 'default-workspace');
  assert.equal(new Set(b.requests.map((r) => r.id)).size, b.requests.length);
  for (const r of b.requests) assert.match(r.id, /^[A-Za-z0-9._:#-]{1,100}$/);
  for (const r of b.requests) assert.match(r.endpoint, /^\/[A-Za-z0-9._~/:{}-]{0,119}$/);
  assert.equal(buildRequests(buckets, { tenantBy: 'workspace', priceBook: book, sinceTs: Date.parse('2026-10-01T02:00:00Z') }).requests.length, 0, 'sinceTs filters whole buckets');
});

test('crossCheck: per (model, tier), computed vs billed (cents -> USD); only token costs count; a model the bill does not list is shown as n/a', () => {
  const db = openDb(':memory:');
  installPrices(db);
  db.prepare("INSERT INTO requests(id, ts, tenant_id, endpoint, method, status, duration_ms, infra_cost_micro_usd) VALUES ('a', 100, 't', '/usage/standard/0-200k', 'POST', 200, 0, 0), ('b', 100, 't', '/usage/batch/0-200k', 'POST', 200, 0, 0), ('c', 100, 't', '/usage/standard/0-200k', 'POST', 200, 0, 0), ('d', 99999999999, 't', '/usage/standard/0-200k', 'POST', 200, 0, 0)").run();
  const ins = db.prepare('INSERT INTO llm_calls(id, request_id, ts, tenant_id, endpoint, model, input_tokens, output_tokens, cached_tokens, latency_ms, cost_micro_usd) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 0, 0, ?)');
  ins.run('a#0', 'a', 100, 't', '/usage/standard/0-200k', 'claude-sonnet-5-5', 2_000_000);          // $2.00
  ins.run('b#0', 'b', 100, 't', '/usage/batch/0-200k', 'claude-sonnet-5-5', 1_000_000);            // $1.00 at standard rates
  ins.run('c#0', 'c', 100, 't', '/usage/standard/0-200k', 'claude-opus-5-5', 500_000);            // not on the bill
  ins.run('d#0', 'd', 99999999999, 't', '/usage/standard/0-200k', 'claude-sonnet-5-5', 9_000_000); // outside the checked days
  const bill = [{ starting_at: '1970-01-01T00:00:00Z', ending_at: '1970-01-02T00:00:00Z', results: [
    { cost_type: 'tokens', model: 'claude-sonnet-5-5', service_tier: 'standard', amount: '200.0', currency: 'USD' },         // 200 cents = $2.00
    { cost_type: 'tokens', model: 'claude-sonnet-5-5', service_tier: 'batch', amount: '50', currency: 'USD' },              // $0.50: half of ours
    { cost_type: 'web_search', model: null, service_tier: null, amount: '999', currency: 'USD' },                           // ignored
    { cost_type: 'tokens', model: 'claude-sonnet-5-5-20260101', service_tier: 'standard', amount: '100', currency: 'USD' },   // dated name -> same model: +$1.00
  ] }];
  const rows = crossCheck(db, bill, { fromMs: 0, toMs: D });
  const find = (m, t) => rows.find((r) => r.model === m && r.tier === t);
  assert.deepEqual([find('claude-sonnet-5-5', 'standard').computedUsd, find('claude-sonnet-5-5', 'standard').billedUsd], [2, 3]);
  assert.equal(find('claude-sonnet-5-5', 'standard').ratio, 2 / 3);
  assert.equal(find('claude-sonnet-5-5', 'batch').ratio, 2, 'ours at standard rates is double the half-price batch bill');
  assert.deepEqual([find('claude-opus-5-5', 'standard').billedUsd, find('claude-opus-5-5', 'standard').ratio], [null, null]);
  assert.equal(rows.length, 3, 'the row outside the checked days is not counted');
  db.close();
});

test('AdminClient: honours Retry-After on 429 (with a finite wait when the header is absent), retries 5xx, gives up with a clear error, never follows a redirect, and refuses unsafe base URLs', async () => {
  assert.throws(() => new AdminClient({ baseUrl: 'http://api.example.org', adminKey: 'k' }), /must be https/);
  assert.throws(() => new AdminClient({ baseUrl: 'https://user:pw@api.example.org', adminKey: 'k' }), /credentials/);
  assert.throws(() => new AdminClient({ baseUrl: 'https://api.example.org', adminKey: '' }), /Admin API key is required/);

  let n = 0;
  const server = http.createServer((req, res) => {
    n++;
    if (req.url.startsWith('/limited')) { if (n === 1) { res.writeHead(429, { 'retry-after': '0' }); return res.end('{}'); } res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":1}'); }
    if (req.url.startsWith('/bare429')) { if (n === 1) { res.writeHead(429); return res.end('{}'); } res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":3}'); }
    if (req.url.startsWith('/flaky')) { if (n <= 2) { res.writeHead(503); return res.end('{}'); } res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":2}'); }
    if (req.url.startsWith('/down')) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"still down"}}'); }
    if (req.url.startsWith('/redir')) { res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' }); return res.end(); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const c = new AdminClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, adminKey: KEY, retryMs: 5, pauseMs: 0 });
    n = 0; assert.deepEqual(await c.get('/limited', []), { ok: 1 });
    assert.equal(n, 2);
    // no Retry-After header: it must wait the (finite) backoff, not NaN-sleep for nothing
    const slow = new AdminClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, adminKey: KEY, retryMs: 80, pauseMs: 0 });
    n = 0; const t0 = Date.now();
    assert.deepEqual(await slow.get('/bare429', []), { ok: 3 });
    assert.ok(Date.now() - t0 >= 70, `waited ${Date.now() - t0} ms`);
    n = 0; assert.deepEqual(await c.get('/flaky', []), { ok: 2 });
    assert.equal(n, 3);
    n = 0;
    await assert.rejects(c.get('/down', []), (e) => e instanceof AdminApiError && /HTTP 500: still down/.test(e.message) && !e.message.includes(KEY));
    assert.equal(n, 4, 'one try plus three retries, then it stops');
    await assert.rejects(c.get('/redir', []), /HTTP 302/);
    await assert.rejects(c.get('/nope', []), /HTTP 404/);
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); }
  const dead = new AdminClient({ baseUrl: 'http://127.0.0.1:1', adminKey: KEY, retryMs: 1, pauseMs: 0 });
  await assert.rejects(dead.get('/x', []), (e) => /could not reach http:\/\/127\.0\.0\.1:1/.test(e.message) && !e.message.includes(KEY));
});
