import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMultiApp } from '../src/multi.js';
import { createProxy, ensureLiveDb } from '../src/proxy.js';
import { deepseekIsPeak, keyLabel, listPriceMicro, parseProviderSpec } from '../src/providers.js';
import { parsePriceArg } from '../src/import/prices.js';
import { sleep, waitUntil } from './helpers.js';

/*
 * `finops proxy --provider ...`, end to end: an "app" -> the proxy -> fake OpenAI / DeepSeek / OpenRouter / gateway servers, with what is recorded landing
 * in a REAL dashboard (real ingest) whose database we read. Fakes follow the providers' documented response formats; none of this has run against the
 * real services.
 */
const KEY = 'sk-proj-SECRET-OPENAI-KEY-do-not-record';
const KEY2 = 'sk-or-v1-SECRET-OPENROUTER-KEY-do-not-record';
const PROMPT = 'SECRET prompt text: our unreleased pricing';

const chat = (model, usage) => JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: 'SECRET answer' }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) });
const chunk = (model, o) => `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', model, ...o })}\n\n`;
const stream = (model, usage, { done = true } = {}) => [
  ': OPENROUTER PROCESSING\n\n',
  chunk(model, { choices: [{ index: 0, delta: { role: 'assistant', content: 'café ☕ SECRET answer' } }], usage: null }),
  chunk(model, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null }),
  ...(usage ? [chunk(model, { choices: [], usage })] : []),
  ...(done ? ['data: [DONE]\n\n'] : []),
].join('');

/** A stand-in for one provider's API. The reply is chosen per request: x-model, x-usage (JSON), x-test (json | stream | stream-nousage | 500). */
async function fakeProvider() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    const model = req.headers['x-model'] || 'gpt-4o-2024-08-06';
    const usage = req.headers['x-usage'] ? JSON.parse(req.headers['x-usage']) : { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } };
    const mode = req.headers['x-test'] || 'json';
    if (req.url === '/v1/messages') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'SECRET answer' }], usage: { input_tokens: 1000, output_tokens: 300 } })); }
    if (mode === '500') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'boom' } })); }
    if (mode === 'stream-responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const ev = (type, o) => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
      const bytes = Buffer.from([ev('response.created', { response: { id: 'resp_1', model, usage: null } }), ev('response.output_text.delta', { delta: 'café ☕ SECRET answer' }), ev('response.completed', { response: { id: 'resp_1', model, usage } })].join(''));
      for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)); await sleep(0); }
      return res.end();
    }
    if (req.url.endsWith('/responses') && mode === 'json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'resp_1', object: 'response', model, output: [{ type: 'message', content: [{ type: 'output_text', text: 'SECRET answer' }] }], usage })); }
    if (mode === 'stream' || mode === 'stream-nousage') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const bytes = Buffer.from(stream(model, mode === 'stream' ? usage : null));
      for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)); await sleep(0); } // 7-byte slices split lines, JSON and multi-byte characters
      return res.end();
    }
    if (/\/(chat\/completions|responses)$/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(chat(model, usage)); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"data":[]}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { received, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}

/** Fake providers + a real multi-database dashboard + a proxy with those providers between an "app" and them. */
async function stack(t, { names = ['openai', 'deepseek', 'openrouter'], proxyOptions = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'finops-providers-'));
  // cleanup is registered FIRST and closes whatever exists by then: a proxy that refuses its options must fail the test, not leave servers open and hang the run
  const open = { fakes: [], dashboard: null, proxy: null };
  t.after(async () => { await open.proxy?.close(); await open.dashboard?.close(); await Promise.all(open.fakes.map((f) => f.close())); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const fakes = {};
  for (const n of ['anthropic', ...names]) { fakes[n] = await fakeProvider(); open.fakes.push(fakes[n]); }
  ensureLiveDb(join(dir, 'live.db'));
  const dashboard = await createMultiApp({ dataDir: dir, port: 0, seedDays: 1, volumeScale: 0.1, simAutoStart: false, sourcesTtlMs: 0, detectEveryMs: 100000 });
  open.dashboard = dashboard;
  await dashboard.listen();
  const logs = [];
  const providers = names.map((n) => `${n}=${fakes[n].url}`);
  const proxy = createProxy({ upstream: fakes.anthropic.url, dashboard: dashboard.url, source: 'live', tenant: 'default', port: 0, log: (m) => logs.push(m), verbose: true, flushMs: 20, providers, ...proxyOptions });
  open.proxy = proxy;
  await proxy.listen();
  const call = async (path, headers = {}, { body = JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: PROMPT }] }), method = 'POST' } = {}) => {
    const res = await fetch(`${proxy.url}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, ...headers }, body: method === 'GET' ? undefined : body });
    const bytes = Buffer.from(await res.arrayBuffer());
    await sleep(3); // the next call starts in a later millisecond: rows are read back ORDER BY ts, and two calls in one millisecond would be ordered by their random ids
    return { res, bytes };
  };
  const db = () => new DatabaseSync(join(dir, 'live.db'), { readOnly: true });
  const count = () => { const d = db(); try { return d.prepare('SELECT COUNT(*) AS n FROM requests').get().n; } finally { d.close(); } };
  const rows = async (n) => {
    await waitUntil(async () => { await proxy.recorder.idle(500); return count() >= n; }, { what: `${n} request(s) in the dashboard database (proxy stats ${JSON.stringify(proxy.stats)}, logs ${JSON.stringify(logs)})` });
    const d = db();
    try {
      return d.prepare('SELECT r.id, r.ts, r.tenant_id, r.endpoint, r.status, c.model, c.input_tokens, c.output_tokens, c.cached_tokens, c.cache_write_tokens, c.cost_micro_usd, c.cost_source FROM requests r LEFT JOIN llm_calls c ON c.request_id = r.id ORDER BY r.ts, r.id').all().map((x) => ({ ...x }));
    } finally { d.close(); }
  };
  return { dir, fakes, dashboard, proxy, logs, call, rows, db };
}

test('OpenAI, non-streamed: the app gets the answer untouched; the dashboard gets tokens and the list-price cost, marked as supplied; the path prefix is stripped upstream', async (t) => {
  const s = await stack(t);
  const { res, bytes } = await s.call('/openai/v1/chat/completions', { 'x-finops-tenant': 'acme', 'x-finops-endpoint': '/summarize' });
  assert.equal(res.status, 200);
  assert.equal(bytes.toString(), chat('gpt-4o-2024-08-06', { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } }));
  const up = s.fakes.openai.received[0];
  assert.equal(up.url, '/v1/chat/completions', 'the /openai prefix is ours, not the provider\'s');
  assert.equal(up.headers.authorization, `Bearer ${KEY}`, 'the key reaches the provider');
  assert.equal(up.headers.host, new URL(s.fakes.openai.url).host);
  assert.equal(up.headers['x-finops-tenant'], undefined);
  assert.equal(JSON.parse(up.body).messages[0].content, PROMPT, 'the body is forwarded as it came');
  assert.equal(s.fakes.deepseek.received.length + s.fakes.openrouter.received.length + s.fakes.anthropic.received.length, 0, 'only the chosen provider was called');
  // gpt-4o: 600 uncached x $2.50 + 400 cached x $1.25 + 200 out x $10 = 1500 + 500 + 2000
  assert.deepEqual(await s.rows(1), [{ ...(await s.rows(1))[0], tenant_id: 'acme', endpoint: '/summarize', status: 200, model: 'gpt-4o-2024-08-06', input_tokens: 1000, output_tokens: 200, cached_tokens: 400, cache_write_tokens: 0, cost_micro_usd: 4000, cost_source: 'supplied' }]);
});

test('without a label the endpoint carries the provider, so one dashboard tells OpenAI from DeepSeek from OpenRouter', async (t) => {
  const s = await stack(t);
  await s.call('/openai/v1/chat/completions');
  await s.call('/deepseek/chat/completions', { 'x-model': 'deepseek-flash', 'x-usage': JSON.stringify({ prompt_tokens: 100, completion_tokens: 10 }) });
  await s.call('/openrouter/api/v1/chat/completions', { 'x-model': 'openai/gpt-4o', 'x-usage': JSON.stringify({ prompt_tokens: 100, completion_tokens: 10, cost: 0.001 }) });
  const rows = await s.rows(3);
  assert.deepEqual(rows.map((r) => r.endpoint).sort(), ['/deepseek/chat/completions', '/openai/v1/chat/completions', '/openrouter/api/v1/chat/completions']);
  assert.deepEqual(s.fakes.openrouter.received.map((r) => r.url), ['/api/v1/chat/completions'], 'the OpenRouter base URL path (/api/v1) comes after the prefix and is forwarded');
  assert.deepEqual(s.fakes.deepseek.received.map((r) => r.url), ['/chat/completions']);
});

test('OpenAI, streamed: usage is read from the final chunk even when the stream is cut at every 7 bytes; without include_usage the call is recorded without cost, and says how to fix it', async (t) => {
  const s = await stack(t);
  const a = await s.call('/openai/v1/chat/completions', { 'x-test': 'stream' }, { body: JSON.stringify({ model: 'gpt-4o', stream: true, stream_options: { include_usage: true }, messages: [] }) });
  assert.equal(a.bytes.toString(), stream('gpt-4o-2024-08-06', { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } }), 'the stream reaches the app byte for byte');
  const b = await s.call('/openai/v1/chat/completions', { 'x-test': 'stream-nousage' });
  assert.equal(b.res.status, 200);
  const rows = await s.rows(2);
  assert.deepEqual(rows.map((r) => [r.cost_micro_usd, r.cost_source, r.input_tokens]), [[4000, 'supplied', 1000], [null, null, null]]);
  assert.equal(s.proxy.stats.unreadable_usage, 1);
  assert.ok(s.logs.some((l) => /no readable usage block/.test(l) && /include_usage/.test(l)), JSON.stringify(s.logs));
});

test('OpenAI Responses API, streamed or not: input_tokens / output_tokens and the cached count are read (from the response, or from the response.completed event)', async (t) => {
  const s = await stack(t);
  // gpt-5: $1.25 in / $0.125 cached / $10 out: 1000 uncached x 1.25 + 1000 cached x 0.125 + 500 out x 10 = 1250 + 125 + 5000
  const usage = JSON.stringify({ input_tokens: 2000, output_tokens: 500, input_tokens_details: { cached_tokens: 1000 }, output_tokens_details: { reasoning_tokens: 300 }, total_tokens: 2500 });
  await s.call('/openai/v1/responses', { 'x-model': 'gpt-5-2025-08-07', 'x-usage': usage });
  const streamed = await s.call('/openai/v1/responses', { 'x-test': 'stream-responses', 'x-model': 'gpt-5', 'x-usage': usage });
  assert.match(streamed.bytes.toString(), /event: response\.completed/, 'the event stream reaches the app');
  const rows = await s.rows(2);
  assert.deepEqual(rows.map((r) => [r.endpoint, r.model, r.input_tokens, r.cached_tokens, r.output_tokens, r.cost_micro_usd]), [
    ['/openai/v1/responses', 'gpt-5-2025-08-07', 2000, 1000, 500, 6375], ['/openai/v1/responses', 'gpt-5', 2000, 1000, 500, 6375],
  ]);
});

test('DeepSeek: cache-hit tokens are the cached tokens, and the price depends on the time of the call (peak hours cost double)', async (t) => {
  const s = await stack(t);
  await s.call('/deepseek/chat/completions', { 'x-model': 'deepseek-flash', 'x-usage': JSON.stringify({ prompt_tokens: 100_000, completion_tokens: 20_000, prompt_cache_hit_tokens: 60_000, prompt_cache_miss_tokens: 40_000 }) });
  const [r] = await s.rows(1);
  assert.deepEqual([r.input_tokens, r.cached_tokens, r.output_tokens, r.model], [100_000, 60_000, 20_000, 'deepseek-flash']);
  // off-peak: 40000 x $0.15 + 60000 x $0.003 + 20000 x $0.60 = 6000 + 180 + 12000 micro-USD; peak is double
  assert.equal(r.cost_micro_usd, deepseekIsPeak(r.ts) ? 36_360 : 18_180);
  assert.equal(r.cost_micro_usd, listPriceMicro(parseProviderSpec('deepseek'), 'deepseek-flash', { input: 100_000, cached: 60_000, output: 20_000 }, r.ts));
});

test('OpenRouter: the call\'s own cost is recorded for any model (slashes and :free included); a bring-your-own-key call adds the upstream charge; no cost and no price means "recorded without cost", loudly', async (t) => {
  const s = await stack(t);
  const or = (model, usage) => s.call('/openrouter/api/v1/chat/completions', { 'x-model': model, 'x-usage': JSON.stringify(usage), authorization: `Bearer ${KEY2}` });
  await or('anthropic/claude-sonnet-4.5', { prompt_tokens: 194, completion_tokens: 2, cost: 0.00123 });
  await or('meta-llama/llama-3.3-70b-instruct:free', { prompt_tokens: 50, completion_tokens: 5, cost: 0 });
  await or('openai/gpt-4o', { prompt_tokens: 100, completion_tokens: 10, cost: 0.00095, cost_details: { upstream_inference_cost: 0.019 } });
  await or('openai/gpt-4o', { prompt_tokens: 100, completion_tokens: 10 }); // a response without cost
  const rows = await s.rows(4);
  assert.deepEqual(rows.map((r) => [r.model, r.cost_micro_usd, r.cost_source]), [
    ['anthropic/claude-sonnet-4.5', 1230, 'supplied'], ['meta-llama/llama-3.3-70b-instruct:free', 0, 'supplied'], ['openai/gpt-4o', 19950, 'supplied'], [null, null, null],
  ]);
  assert.equal(s.proxy.stats.unpriced, 1);
  assert.ok(s.logs.some((l) => /no price for model "openai\/gpt-4o" \(openrouter\).*--price openai\/gpt-4o=/.test(l)), JSON.stringify(s.logs));
  // the dashboard reads it back like any other cost
  const sum = await (await fetch(`${s.dashboard.url}/d/live/api/summary`)).json();
  assert.equal(sum.totals.cost_micro_usd, 1230 + 0 + 19950);
  // and the request detail says where the number came from instead of showing a price that was never used
  const detail = await (await fetch(`${s.dashboard.url}/d/live/api/requests/${encodeURIComponent(rows[0].id)}`)).json();
  assert.deepEqual([detail.llm_calls[0].cost_source, detail.llm_calls[0].price], ['supplied', null]);
});

test('a model nobody has a price for is recorded without cost, named once in the log, and priced once you give --price', async (t) => {
  const s = await stack(t);
  const usage = JSON.stringify({ prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } });
  await s.call('/openai/v1/chat/completions', { 'x-model': 'gpt-99-future', 'x-usage': usage });
  await s.call('/openai/v1/chat/completions', { 'x-model': 'gpt-99-future', 'x-usage': usage });
  const rows = await s.rows(2);
  assert.deepEqual(rows.map((r) => [r.status, r.model, r.cost_micro_usd]), [[200, null, null], [200, null, null]], 'the requests are counted, with no invented cost');
  assert.equal(s.proxy.stats.unpriced, 2);
  assert.equal(s.logs.filter((l) => /no price for model "gpt-99-future"/.test(l)).length, 1, 'named once, not once per call');
  assert.match(s.logs.find((l) => /no price for model/.test(l)), /--price gpt-99-future=INPUT,OUTPUT,CACHED/);

  const s2 = await stack(t, { proxyOptions: { prices: [parsePriceArg('gpt-99-future=1,2,0.5')] } });
  await s2.call('/openai/v1/chat/completions', { 'x-model': 'gpt-99-future', 'x-usage': usage });
  assert.equal((await s2.rows(1))[0].cost_micro_usd, 600 * 1 + 400 * 0.5 + 200 * 2);
});

test('a custom OpenAI-compatible provider: priced by --price; its usage.cost is ignored unless you say you trust it with --reported-cost', async (t) => {
  const usage = JSON.stringify({ prompt_tokens: 1000, completion_tokens: 200, cost: 0.5 });
  const untrusted = await stack(t, { names: ['fastrouter'] });
  await untrusted.call('/fastrouter/api/v1/chat/completions', { 'x-model': 'some-model', 'x-usage': usage });
  assert.equal((await untrusted.rows(1))[0].cost_micro_usd, null, 'no price and no trust: not recorded with a cost that came from nowhere');
  assert.match(untrusted.logs.find((l) => /no price for model/.test(l)), /--reported-cost fastrouter/, 'the log says how to trust the gateway\'s own figure');

  const priced = await stack(t, { names: ['fastrouter'], proxyOptions: { prices: [parsePriceArg('some-model=2,10')] } });
  await priced.call('/fastrouter/api/v1/chat/completions', { 'x-model': 'some-model', 'x-usage': usage });
  assert.equal((await priced.rows(1))[0].cost_micro_usd, 1000 * 2 + 200 * 10, '--price, not the 0.5 the gateway claims');

  const trusted = await stack(t, { names: ['fastrouter'], proxyOptions: { reportedCost: ['fastrouter'] } });
  await trusted.call('/fastrouter/api/v1/chat/completions', { 'x-model': 'some-model', 'x-usage': usage });
  const [r] = await trusted.rows(1);
  assert.deepEqual([r.cost_micro_usd, r.cost_source], [500_000, 'supplied']);
  // the same gateway serving a model the dashboard DOES have a price for: the figure it reported stays, and the drill-down does not pretend the table was used
  await trusted.call('/fastrouter/api/v1/chat/completions', { 'x-model': 'claude-sonnet-5-5', 'x-usage': usage });
  const rows = await trusted.rows(2);
  assert.deepEqual([rows[1].model, rows[1].cost_micro_usd, rows[1].cost_source], ['claude-sonnet-5-5', 500_000, 'supplied'], 'not recomputed from the price table (that would be 1000 x $2 + 200 x $10)');
  const detail = await (await fetch(`${trusted.dashboard.url}/d/live/api/requests/${encodeURIComponent(rows[1].id)}`)).json();
  assert.deepEqual([detail.llm_calls[0].cost_source, detail.llm_calls[0].price, detail.llm_calls[0].cost_micro_usd], ['supplied', null, 500_000]);
});

test('failures count: a provider 500 is a request with that status and no cost; Anthropic at the root still works beside the providers, priced by the dashboard\'s table', async (t) => {
  const s = await stack(t);
  const bad = await s.call('/openai/v1/chat/completions', { 'x-test': '500' });
  assert.equal(bad.res.status, 500);
  const ant = await s.call('/v1/messages', { 'x-api-key': 'sk-ant-key', authorization: '' }, { body: JSON.stringify({ model: 'claude-sonnet-5-5', messages: [] }) });
  assert.equal(ant.res.status, 200);
  const rows = await s.rows(2);
  assert.deepEqual(rows.map((r) => [r.endpoint, r.status, r.model, r.cost_micro_usd, r.cost_source]), [['/openai/v1/chat/completions', 500, null, null, null], ['/v1/messages', 200, 'claude-sonnet-5-5', 5000, 'price_list']]);
  assert.equal(s.proxy.stats.upstream_errors, 1);
});

test('routing is by a fixed table, never by the request: unknown prefixes go to the default upstream, and nothing in a path can pick another host', async (t) => {
  const s = await stack(t);
  // not a provider: handled exactly as before (the Anthropic upstream) and, not being /v1/messages, never recorded
  await s.call('/nope/v1/chat/completions');
  assert.deepEqual(s.fakes.anthropic.received.map((r) => r.url), ['/nope/v1/chat/completions']);
  // a provider prefix followed by a path that tries to be a host: it is only ever a path on THAT provider's origin
  await s.call('/openai//evil.example/x');
  await s.call('/openai@evil.example/x');
  await s.call('/openai/..%2f..%2fx');
  await s.call('/openai');
  await s.call('/openai?a=1', {}, { method: 'GET' });
  assert.deepEqual(s.fakes.openai.received.map((r) => r.url), ['//evil.example/x', '/..%2f..%2fx', '/', '/?a=1']);
  assert.deepEqual(s.fakes.anthropic.received.map((r) => r.url), ['/nope/v1/chat/completions', '/openai@evil.example/x'], '"/openai@evil.example" is not the openai prefix: it is a path on the default upstream');
  for (const url of ['//evil.example/x', 'http://evil.example/']) {
    const r = await new Promise((resolve) => { const q = http.request({ host: '127.0.0.1', port: s.proxy.port, path: url, method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode); }); q.end(); });
    assert.equal(r, 400, url);
  }
  assert.equal(s.proxy.stats.unreadable_usage, 0);
  assert.equal(await s.rows(0).then((r) => r.length), 0, 'none of that was recorded');
  const health = await (await fetch(`${s.proxy.url}/__finops/health`)).json();
  assert.deepEqual(health.providers, ['openai', 'deepseek', 'openrouter']);
});

test('--tenant-by-key: each API key is its own tenant, named by a one-way label or by --key-map; an explicit x-finops-tenant still wins; off, everything is the default tenant', async (t) => {
  const label1 = keyLabel(KEY), label2 = keyLabel(KEY2);
  const s = await stack(t, { proxyOptions: { keyTenants: true, keyMap: { [label2]: 'search-team' } } });
  await s.call('/openai/v1/chat/completions');
  await s.call('/openai/v1/chat/completions');
  await s.call('/openrouter/api/v1/chat/completions', { authorization: `Bearer ${KEY2}`, 'x-usage': JSON.stringify({ prompt_tokens: 10, completion_tokens: 1, cost: 0.1 }), 'x-model': 'openai/gpt-4o' });
  await s.call('/openai/v1/chat/completions', { 'x-finops-tenant': 'explicit' });
  await s.call('/v1/messages', { authorization: '', 'x-api-key': 'sk-ant-third-key' }, { body: JSON.stringify({ model: 'claude-sonnet-5-5', messages: [] }) });
  const rows = await s.rows(5);
  assert.deepEqual(rows.map((r) => r.tenant_id).sort(), [label1, label1, 'explicit', 'search-team', keyLabel('sk-ant-third-key')].sort());
  assert.match(label1, /^key-[0-9a-f]{10}$/);
  assert.equal(s.logs.filter((l) => /new API key seen/.test(l)).length, 3, 'each key is announced once');
  assert.ok(s.logs.some((l) => l.includes(`"${label1}": "team-name"`)), 'the log says how to name an unnamed key');
  // the keys themselves are nowhere: not in the database files, the log, or the health endpoint
  const health = JSON.stringify(await (await fetch(`${s.proxy.url}/__finops/health`)).json());
  const all = [...s.logs, health];
  for (const f of readdirSync(s.dir)) if (/live\.db/.test(f)) all.push(readFileSync(join(s.dir, f)).toString('latin1'));
  for (const secret of [KEY, KEY2, 'sk-ant-third-key', PROMPT, 'SECRET answer']) for (const hay of all) assert.ok(!hay.includes(secret), `"${secret}" must not appear anywhere`);

  const off = await stack(t);
  await off.call('/openai/v1/chat/completions');
  assert.equal((await off.rows(1))[0].tenant_id, 'default');
});

test('guards: a provider needs a real, https (or localhost) upstream, no duplicates, a valid key map, and may not point back at the proxy', async () => {
  const base = { dashboard: 'http://127.0.0.1:1', port: 0 };
  assert.throws(() => createProxy({ ...base, providers: ['openai=http://api.openai.example'] }), /must be https/);
  assert.throws(() => createProxy({ ...base, providers: ['openai=https://user:pw@api.openai.example'] }), /credentials/);
  assert.throws(() => createProxy({ ...base, providers: ['openai', 'openai'] }), /given twice/);
  assert.throws(() => createProxy({ ...base, providers: ['nope'] }), /unknown provider "nope"/);
  assert.throws(() => createProxy({ ...base, providers: ['openai'], reportedCost: ['deepseek'] }), /no provider called "deepseek"/);
  assert.throws(() => createProxy({ ...base, keyMap: { 'not-a-label': 'x' } }), /not a key label/);
  assert.throws(() => createProxy({ ...base, keyMap: { [keyLabel('k')]: 'bad name!' } }), /must match/);
  // an upstream that is the proxy itself (OPENAI_BASE_URL exported in the proxy's own shell) would forward every call to itself forever
  const loop = createProxy({ ...base, port: 18798, providers: ['openai=http://127.0.0.1:18798'] });
  await assert.rejects(loop.listen(), /"openai" upstream is this proxy itself/);
});
