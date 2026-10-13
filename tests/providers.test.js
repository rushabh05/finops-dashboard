import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { PriceBook, seedPrices } from '../src/pricing.js';
import { Ingestor, ValidationError, verifyRollups } from '../src/ingest.js';
import { DEEPSEEK_PRICES, OPENAI_PRICES, OpenAiSseUsage, apiKeyOf, deepseekIsPeak, keyLabel, listPriceMicro, openaiUsage, parseProviderSpec } from '../src/providers.js';
import { parsePriceArg } from '../src/import/prices.js';
import { mkRequest } from './helpers.js';

/*
 * Providers beyond Anthropic: how usage and cost are read from the OpenAI wire format, what a list price costs, which key made a call, and the ingest
 * rule that lets a call SUPPLY its own cost (a gateway's figure, or the proxy's list price) instead of being priced from model_prices.
 */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const T = Date.UTC(2026, 5, 1, 10, 15);
const openai = parseProviderSpec('openai');
const deepseek = parseProviderSpec('deepseek');
const openrouter = parseProviderSpec('openrouter');

test('openaiUsage: the prompt is the WHOLE prompt (cached tokens included), reasoning tokens stay in the output, and every provider spelling of "cached" is read', () => {
  // OpenAI chat completions
  assert.deepEqual(openaiUsage({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 150 } }),
    { input: 1000, output: 200, cached: 400, cacheWrite: 0, reportedMicro: null });
  // OpenAI Responses API
  assert.deepEqual(openaiUsage({ input_tokens: 900, output_tokens: 100, input_tokens_details: { cached_tokens: 300 }, output_tokens_details: { reasoning_tokens: 60 } }),
    { input: 900, output: 100, cached: 300, cacheWrite: 0, reportedMicro: null });
  // DeepSeek: prompt_tokens = cache hit + cache miss
  assert.deepEqual(openaiUsage({ prompt_tokens: 16, completion_tokens: 10, prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 10 }), { input: 16, output: 10, cached: 6, cacheWrite: 0, reportedMicro: null });
  // a cached count larger than the prompt is clamped (the dashboard refuses cached > input)
  assert.equal(openaiUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 99 } }).cached, 10);
  // nothing usable
  for (const u of [null, undefined, 'x', 5, {}, { total_tokens: 3 }]) assert.equal(openaiUsage(u), null);
  // garbage numbers become 0, never NaN or negative
  assert.deepEqual(openaiUsage({ prompt_tokens: -5, completion_tokens: 'abc', prompt_tokens_details: { cached_tokens: NaN } }), { input: 0, output: 0, cached: 0, cacheWrite: 0, reportedMicro: null });
});

test('openaiUsage: a provider\'s own cost is used only where it is trusted, in micro-USD; a bring-your-own-key call adds the upstream charge', () => {
  const u = { prompt_tokens: 194, completion_tokens: 2, cost: 0.00123, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100 } };
  assert.equal(openaiUsage(u).reportedMicro, null, 'not trusted by default: an unknown provider\'s "cost" could mean anything');
  assert.equal(openaiUsage(u, { reportsCost: true }).reportedMicro, 1230);
  assert.equal(openaiUsage(u, { reportsCost: true }).cacheWrite, 100, 'cache writes are inside the prompt count');
  // BYOK: `cost` is OpenRouter's fee, `upstream_inference_cost` what the provider charged: both are spend
  assert.equal(openaiUsage({ ...u, cost: 0.00095, cost_details: { upstream_inference_cost: 0.019 } }, { reportsCost: true }).reportedMicro, 19950);
  // not a number / negative: no reported cost (the caller then falls back to a price list)
  for (const cost of ['0.5', -1, NaN, null, Infinity]) assert.equal(openaiUsage({ ...u, cost }, { reportsCost: true }).reportedMicro, null);
  assert.equal(openaiUsage({ ...u, cost: 0 }, { reportsCost: true }).reportedMicro, 0, 'a free call (a :free model) is a real, zero-cost call');
});

test('OpenAiSseUsage: chat chunks, Responses events and OpenRouter comments, split at every byte boundary; the last usage wins; errors and [DONE] are noticed', () => {
  const lines = [
    ': OPENROUTER PROCESSING\n\n',
    `data: ${JSON.stringify({ id: 'c1', model: 'gpt-4o-2024-08-06', choices: [{ delta: { content: 'café ☕ SECRET' } }], usage: null })}\n\n`,
    `data: ${JSON.stringify({ id: 'c1', model: 'gpt-4o-2024-08-06', choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.5 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  const bytes = Buffer.from(lines);
  for (const step of [1, 2, 3, 7, 1000]) {
    const p = new OpenAiSseUsage();
    const dec = new StringDecoder('utf8');
    for (let i = 0; i < bytes.length; i += step) p.push(dec.write(bytes.subarray(i, i + step)));
    assert.deepEqual([p.model, p.usage, p.complete, p.sawUsage, p.errorType], ['gpt-4o-2024-08-06', { prompt_tokens: 12, completion_tokens: 3, cost: 0.5 }, true, true, null], `step ${step}`);
  }
  const r = new OpenAiSseUsage();
  r.push(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { model: 'gpt-5', usage: null } })}\n\n`);
  assert.equal(r.sawUsage, false);
  r.push(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { model: 'gpt-5', usage: { input_tokens: 5, output_tokens: 7 } } })}\n\n`);
  assert.deepEqual([r.model, r.usage, r.complete], ['gpt-5', { input_tokens: 5, output_tokens: 7 }, true]);
  const e = new OpenAiSseUsage();
  e.push(`data: ${JSON.stringify({ error: { message: 'boom', code: 'server_error' }, choices: [{ finish_reason: 'error' }] })}\n\n`);
  assert.deepEqual([e.errorType, e.complete, e.sawUsage], ['server_error', false, false]);
  const w = new OpenAiSseUsage();
  w.push('data: {"usage": {"prompt_tokens": 1}'); // a half-written event is not an event
  assert.equal(w.sawUsage, false);
  w.push('\n');
  assert.equal(w.sawUsage, false, 'a line that is not valid JSON is ignored, not thrown');
});

test('list prices: exact integer arithmetic, dated snapshots resolve to the priced model, an unknown model is null (never guessed), --price wins', () => {
  // gpt-4o: $2.50 in / $1.25 cached / $10 out. 600 uncached + 400 cached + 200 out = 1500 + 500 + 2000 micro-USD
  const call = { input: 1000, cached: 400, output: 200 };
  assert.equal(listPriceMicro(openai, 'gpt-4o', call, T), 4000);
  assert.equal(listPriceMicro(openai, 'gpt-4o-2024-08-06', call, T), 4000, 'a dated snapshot is billed as its model');
  assert.equal(listPriceMicro(openai, 'gpt-4o-mini', call, T), 600 * 0.15 + 400 * 0.075 + 200 * 0.6, 'longest name first: -mini is not gpt-4o');
  assert.equal(listPriceMicro(openai, 'gpt-99-future', call, T), null);
  assert.equal(listPriceMicro(deepseek, 'gpt-4o', call, T), null, 'a provider uses only its own list');
  const over = new Map([parsePriceArg('gpt-99-future=1,2,0.5')].map((p) => [p.model, p]));
  assert.equal(listPriceMicro(openai, 'gpt-99-future', call, T, over), 600 * 1 + 400 * 0.5 + 200 * 2);
  assert.equal(listPriceMicro(parseProviderSpec('gw=https://gw.example'), 'gpt-99-future', call, T, over), 600 * 1 + 400 * 0.5 + 200 * 2, '--price works for any provider, including a custom one');
  assert.equal(listPriceMicro(parseProviderSpec('gw=https://gw.example'), 'gpt-4o', call, T), null, 'a gateway that has no price list of its own is not priced from OpenAI\'s');
  // the shipped tables are sane: every row has non-negative integer prices and a cache read never costs more than input
  for (const p of [...OPENAI_PRICES, ...DEEPSEEK_PRICES]) {
    for (const k of ['input_per_mtok', 'cached_per_mtok', 'output_per_mtok']) assert.ok(Number.isInteger(p[k]) && p[k] >= 0, `${p.model}.${k}`);
    assert.ok(p.cached_per_mtok <= p.input_per_mtok, `${p.model}: cached <= input`);
  }
});

test('DeepSeek: peak hours (01-04 and 06-10 UTC on weekdays) cost twice the off-peak rate; the retired flash names bill as deepseek-flash', () => {
  const mon = (h) => Date.UTC(2026, 9, 12, h, 30); // Monday 12 Oct 2026
  const sat = Date.UTC(2026, 9, 17, 2, 30), sun = Date.UTC(2026, 9, 18, 7, 30);
  assert.equal(new Date(mon(2)).getUTCDay(), 1);
  for (const [ts, peak] of [[mon(0), false], [mon(1), true], [mon(3), true], [mon(4), false], [mon(5), false], [mon(6), true], [mon(9), true], [mon(10), false], [mon(20), false], [sat, false], [sun, false]]) {
    assert.equal(deepseekIsPeak(ts), peak, new Date(ts).toISOString());
  }
  // deepseek-flash: $0.15 miss / $0.003 hit / $0.60 out per Mtok off-peak
  const call = { input: 1000, cached: 0, output: 1000 };
  assert.equal(listPriceMicro(deepseek, 'deepseek-flash', call, mon(12)), 750);
  assert.equal(listPriceMicro(deepseek, 'deepseek-flash', call, mon(2)), 1500);
  assert.equal(listPriceMicro(deepseek, 'deepseek-flash', { input: 1000, cached: 1000, output: 0 }, mon(12)), 3, '1000 cache-hit tokens at $0.003/Mtok = 3 micro-USD');
  assert.equal(listPriceMicro(deepseek, 'deepseek-v4-flash', call, mon(12)), 750);
  assert.equal(listPriceMicro(deepseek, 'deepseek-v4-flash-vision-exp', call, mon(2)), 1500);
  assert.equal(listPriceMicro(deepseek, 'deepseek-v4-pro', call, mon(12)), 660 + 1980);
  // an explicit --price is used as given: it is NOT doubled at peak
  const over = new Map([parsePriceArg('deepseek-flash=1,1,1')].map((p) => [p.model, p]));
  assert.equal(listPriceMicro(deepseek, 'deepseek-flash', call, mon(2), over), 2000);
  assert.equal(listPriceMicro(openai, 'gpt-4o', call, mon(2)), listPriceMicro(openai, 'gpt-4o', call, mon(12)), 'only DeepSeek has a peak');
});

test('key labels: a stable one-way label per key; the key is read from the header each provider uses, and never from anything else', () => {
  const a = keyLabel('sk-proj-AAAA'), b = keyLabel('sk-proj-BBBB');
  assert.match(a, /^key-[0-9a-f]{10}$/);
  assert.equal(a, keyLabel('sk-proj-AAAA'), 'stable');
  assert.notEqual(a, b);
  assert.ok(!a.includes('AAAA') && !a.toLowerCase().includes('sk-proj'), 'the label does not contain the key');
  assert.equal(apiKeyOf({ authorization: 'Bearer sk-proj-AAAA' }), 'sk-proj-AAAA');
  assert.equal(apiKeyOf({ authorization: 'bearer  sk-x' }), 'sk-x');
  assert.equal(apiKeyOf({ 'x-api-key': 'sk-ant-1' }), 'sk-ant-1');
  assert.equal(apiKeyOf({ 'api-key': 'azure-1' }), 'azure-1');
  assert.equal(apiKeyOf({ authorization: 'Basic dXNlcjpwYXNz' }), '', 'Basic credentials are not an API key');
  assert.equal(apiKeyOf({}), '');
  // the CLI helper reads the key from stdin (never argv, which lands in shell history) and prints the same label
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'finops.js'), 'key-label'], { input: 'sk-proj-AAAA\n', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), a);
  assert.equal(spawnSync(process.execPath, [join(ROOT, 'bin', 'finops.js'), 'key-label'], { input: '', encoding: 'utf8' }).status, 2);
});

test('provider specs: built-in names, NAME=URL for any OpenAI-compatible endpoint, and every way to get one wrong', () => {
  assert.deepEqual([openai.upstream, openai.format, openai.reportsCost], ['https://api.openai.com', 'openai', false]);
  assert.deepEqual([openrouter.upstream, openrouter.reportsCost, openrouter.prices], ['https://openrouter.ai', true, null]);
  const gw = parseProviderSpec('fastrouter=https://gw.example.com', { reportedCost: ['fastrouter'] });
  assert.deepEqual([gw.name, gw.upstream, gw.format, gw.reportsCost, gw.prices], ['fastrouter', 'https://gw.example.com', 'openai', true, null]);
  assert.equal(parseProviderSpec('fastrouter=https://gw.example.com').reportsCost, false);
  assert.equal(parseProviderSpec('openai=https://my-openai-proxy.example').upstream, 'https://my-openai-proxy.example', 'a built-in name can be pointed elsewhere');
  assert.throws(() => parseProviderSpec('fastrouter'), /unknown provider "fastrouter".*--provider fastrouter=https/s);
  for (const bad of ['', 'UPPER=https://x.example', '1abc=https://x.example', 'a b=https://x.example', 'v1=https://x.example', '__finops=https://x.example', `${'a'.repeat(31)}=https://x.example`]) assert.throws(() => parseProviderSpec(bad), /bad provider name|unknown provider|bad --provider/, bad);
});

/* ------------------------------------------------------------------ ingest: a call may supply its own cost */

function setup() {
  const db = openDb();
  seedPrices(db);
  return { db, ing: new Ingestor(db, new PriceBook(db)) };
}

test('ingest: a call that SUPPLIES cost_micro_usd needs no price row, is stored as it came, is marked "supplied", and the rollups still verify', () => {
  const { db, ing } = setup();
  const r = ing.ingest({ requests: [
    mkRequest({ id: 'a', ts: T, calls: [{ model: 'openai/gpt-4o', input_tokens: 1000, output_tokens: 200, cached_tokens: 400, cost_micro_usd: 4321 }] }),
    // a priced call and a supplied one in the same request, and the supplied one for a model that IS priced: supplied wins, nothing is recomputed
    mkRequest({ id: 'b', ts: T, calls: [{ model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 200 }, { model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 200, cost_micro_usd: 7 }] }),
  ] });
  assert.equal(r.accepted, 2);
  const rows = db.prepare('SELECT request_id, model, cost_micro_usd, cost_source FROM llm_calls ORDER BY request_id, id').all().map((x) => ({ ...x }));
  // claude-sonnet-5-5 in the test price table: $3 in / $15 out per Mtok -> 1000 * 3 + 200 * 15 = 6000 micro-USD
  assert.deepEqual(rows, [
    { request_id: 'a', model: 'openai/gpt-4o', cost_micro_usd: 4321, cost_source: 'supplied' },
    { request_id: 'b', model: 'claude-sonnet-5-5', cost_micro_usd: 6000, cost_source: 'price_list' },
    { request_id: 'b', model: 'claude-sonnet-5-5', cost_micro_usd: 7, cost_source: 'supplied' },
  ]);
  assert.deepEqual(verifyRollups(db), []);
  assert.equal(db.prepare("SELECT SUM(cost_micro_usd) AS c FROM rollups_hourly WHERE model = 'openai/gpt-4o'").get().c, 4321);
});

test('ingest: a supplied cost must be an integer between 0 and $1000; without one the model still needs a price', () => {
  const { ing } = setup();
  const bad = (cost) => { const call = { model: 'x/y', input_tokens: 1, output_tokens: 1 }; if (cost !== undefined) call.cost_micro_usd = cost; return () => ing.ingest({ requests: [mkRequest({ ts: T, calls: [call] })] }); };
  for (const c of [-1, 1.5, '12', null, NaN, 1_000_000_001, {}, []]) assert.throws(bad(c), (e) => e instanceof ValidationError && /cost_micro_usd/.test(e.message), String(c));
  assert.throws(bad(undefined), (e) => e instanceof ValidationError && /no price in model_prices/.test(e.message), 'no supplied cost and no price: refused, as before');
  assert.equal(bad(0)().accepted, 1, 'a free call is a call');
  assert.equal(bad(1_000_000_000)().accepted, 1);
});

test('ingest: model names may carry a provider prefix (openai/gpt-4o, anthropic/claude-sonnet-4.5:beta) but nothing that is not a name', () => {
  const { ing } = setup();
  const model = (m) => () => ing.ingest({ requests: [mkRequest({ ts: T, calls: [{ model: m, input_tokens: 1, output_tokens: 1, cost_micro_usd: 1 }] })] });
  for (const m of ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5:beta', 'meta-llama/llama-3.3-70b-instruct:free']) assert.equal(model(m)().accepted, 1, m);
  for (const m of ['a b', 'a\\b', 'a?b', 'a<b>', 'é', '', 'x'.repeat(65), 'a%2Fb']) assert.throws(model(m), /invalid model name/, JSON.stringify(m));
});

test('an older database gains the cost_source column when it is opened, and its existing calls are "price_list"', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'finops-mig-'));
  try {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE requests(id TEXT PRIMARY KEY, ts INTEGER NOT NULL, tenant_id TEXT NOT NULL, endpoint TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL, duration_ms INTEGER NOT NULL, infra_cost_micro_usd INTEGER NOT NULL);
      CREATE TABLE llm_calls(id TEXT PRIMARY KEY, request_id TEXT NOT NULL, ts INTEGER NOT NULL, tenant_id TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, latency_ms INTEGER NOT NULL, cost_micro_usd INTEGER NOT NULL);
      INSERT INTO requests VALUES('r', 1700000000000, 't', '/e', 'POST', 200, 5, 0);
      INSERT INTO llm_calls VALUES('c', 'r', 1700000000000, 't', '/e', 'm', 1, 1, 0, 1, 9);`);
    old.close();
    const db = openDb(path);
    try { assert.deepEqual({ ...db.prepare('SELECT cost_micro_usd, cost_source FROM llm_calls').get() }, { cost_micro_usd: 9, cost_source: 'price_list' }); } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
