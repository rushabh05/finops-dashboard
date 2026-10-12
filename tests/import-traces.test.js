import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitCsv, detectFormat, parseTimestamp, readTrace, scanBounds, unit, makeTenantPicker, makeTimeMap, traceRequests, guessService, DEFAULT_MODEL_MAP } from '../src/import/traces.js';
import { createImportDb, BatchWriter } from '../src/import/common.js';
import { verifyRollups } from '../src/ingest.js';
import { DAY, HOUR } from '../src/util.js';

let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'finops-trace-')); });
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };

const BURST = `Timestamp,Model,Request tokens,Response tokens,Total tokens,Log Type
5,ChatGPT,1000,100,1100,Conversation log
3605,GPT-4,2000,200,2200,API log
3700,GPT-4,500,0,500,API log
7300,ChatGPT,300,30,330,Conversation log
bad,row,x,y,z,w
90000,ChatGPT,100,10,110,API log
`;

test('csv + timestamp parsing', () => {
  assert.deepEqual(splitCsv('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsv('a,"b,c",d,"e ""q"""'), ['a', 'b,c', 'd', 'e "q"']);
  assert.equal(parseTimestamp('2023-11-16 18:15:46.6805900'), Date.UTC(2023, 10, 16, 18, 15, 46, 680), 'no zone = UTC, 7-digit fraction');
  assert.equal(parseTimestamp('2024-05-10 00:00:00.009930+00:00'), Date.UTC(2024, 4, 10, 0, 0, 0, 9));
  assert.equal(parseTimestamp('2024-05-10 02:00:00+02:00'), Date.UTC(2024, 4, 10, 0, 0, 0), 'an offset is applied');
  assert.ok(Number.isNaN(parseTimestamp('yesterday')));
  assert.equal(detectFormat('Timestamp,Model,Request tokens,Response tokens,Total tokens,Log Type'), 'burstgpt');
  assert.equal(detectFormat('Timestamp,Session ID,Elapsed time,Model,Request tokens,Response tokens,Total tokens,Log Type'), 'burstgpt');
  assert.equal(detectFormat('TIMESTAMP,ContextTokens,GeneratedTokens'), 'azure');
  assert.throws(() => detectFormat('a,b,c'), /cannot recognise/);
  assert.equal(guessService('AzureLLMInferenceTrace_conv_1week.csv'), 'conv');
  assert.equal(guessService('AzureLLMInferenceTrace_code.csv'), 'code');
});

test('BurstGPT rows: surface, model, failures; malformed rows are skipped', async () => {
  const p = file('burst.csv', BURST);
  const bounds = await scanBounds(p);
  assert.deepEqual([bounds.count, bounds.min, bounds.max, bounds.relative, bounds.format], [5, 5000, 90_000_000, true, 'burstgpt']);
  const timeMap = makeTimeMap({ bounds, end: '2026-06-10T12:00:00Z' });
  const stats = { rows: 0, kept: 0, failed: 0, sampledOut: 0, outOfWindow: 0 };
  const reqs = [];
  for await (const r of traceRequests(p, { format: 'burstgpt', timeMap, stats })) reqs.push(r);
  assert.equal(reqs.length, 5);
  assert.deepEqual([stats.kept, stats.failed], [5, 1]);
  assert.deepEqual(reqs.map((r) => r.endpoint), ['/conversation', '/api', '/api', '/conversation', '/api']);
  assert.deepEqual(reqs.map((r) => r.llm_calls[0]?.model), ['gpt-3.5-turbo', 'gpt-4', undefined, 'gpt-3.5-turbo', 'gpt-3.5-turbo']);
  assert.deepEqual([reqs[2].status, reqs[2].llm_calls.length], [500, 0], 'a response of 0 tokens is a failed request: status 500, no call, no cost');
  assert.deepEqual([reqs[0].status, reqs[0].llm_calls[0].input_tokens, reqs[0].llm_calls[0].output_tokens], [200, 1000, 100]);
  assert.equal(new Set(reqs.map((r) => r.id)).size, 5);
  for (const r of reqs) assert.match(r.tenant_id, /^tenant-0[1-8]$/);
  // spacing between requests is preserved exactly
  assert.equal(reqs[1].ts - reqs[0].ts, 3600 * 1000);
});

test('newer BurstGPT layout: a conversation stays on one tenant and Elapsed time becomes the latency', async () => {
  const p = file('burst-new.csv', `Timestamp,Session ID,Elapsed time,Model,Request tokens,Response tokens,Total tokens,Log Type
10,s-100,1.5,ChatGPT,100,10,110,Conversation log
20,s-100,2.25,ChatGPT,120,30,150,Conversation log
30,s-200,0.8,GPT-4,300,40,340,Conversation log
40,,12.0,GPT-4,50,5,55,API log
`);
  const bounds = await scanBounds(p);
  const reqs = [];
  for await (const r of traceRequests(p, { format: 'burstgpt', timeMap: makeTimeMap({ bounds, end: '2026-06-10T12:00:00Z' }), tenants: 8 })) reqs.push(r);
  assert.equal(reqs.length, 4);
  assert.equal(reqs[0].tenant_id, reqs[1].tenant_id, 'same Session ID, same tenant');
  assert.deepEqual(reqs.map((r) => r.duration_ms), [1500, 2250, 800, 12_000]);
  assert.deepEqual(reqs.map((r) => r.llm_calls[0].latency_ms), [1500, 2250, 800, 12_000]);
  assert.deepEqual(reqs.map((r) => r.endpoint), ['/conversation', '/conversation', '/conversation', '/api']);
});

test('--model-map retargets models (what-if on another price list)', async () => {
  const p = file('burst2.csv', BURST);
  const bounds = await scanBounds(p);
  const timeMap = makeTimeMap({ bounds, end: '2026-06-10T12:00:00Z' });
  const reqs = [];
  for await (const r of traceRequests(p, { format: 'burstgpt', timeMap, modelMap: { ...DEFAULT_MODEL_MAP, chatgpt: 'claude-haiku-5-5', 'gpt-4': 'claude-sonnet-5-5' } })) reqs.push(r);
  assert.deepEqual(reqs.filter((r) => r.llm_calls.length).map((r) => r.llm_calls[0].model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-haiku-5-5']);
});

test('time shift: whole days only (hour-of-day and weekday survive), the trace ends at or before the reference', async () => {
  const bounds = { relative: true, min: 5000, max: 90_000_000, count: 5 };
  const now = Date.UTC(2026, 9, 12, 10, 17, 0);
  const tm = makeTimeMap({ bounds, end: 'now', now });
  const last = tm(bounds.max);
  assert.ok(last <= now && now - last < DAY, 'ends within the last day');
  assert.equal((tm(bounds.max) - bounds.max) % DAY, 0, 'a whole number of days');
  assert.equal(tm(5000) - tm(0), 5000);
  // absolute traces (Azure) shift by a whole number of days too
  const az = { relative: false, min: Date.UTC(2023, 10, 16, 18, 15), max: Date.UTC(2023, 10, 16, 19, 14), count: 2 };
  const t2 = makeTimeMap({ bounds: az, end: 'now', now });
  assert.equal((t2(az.max) - az.max) % DAY, 0);
  assert.ok(t2(az.max) <= now && now - t2(az.max) < DAY);
  assert.equal(makeTimeMap({ bounds: az, end: 'keep' })(az.max), az.max);
  assert.throws(() => makeTimeMap({ bounds, end: 'keep' }), /--start-date/);
  assert.equal(makeTimeMap({ bounds, end: 'keep', startDate: '2023-01-02' })(0), Date.UTC(2023, 0, 2));
  assert.throws(() => makeTimeMap({ bounds, end: 'tomorrowish' }), /bad --end/);
});

test('Azure rows (2023 and 2024 layouts): one endpoint per service, the chosen model, no failures', async () => {
  const p23 = file('az23.csv', 'TIMESTAMP,ContextTokens,GeneratedTokens\n2023-11-16 18:15:46.6805900,374,44\n2023-11-16 18:15:50.9951690,396,0\n');
  const p24 = file('az24.csv', 'TIMESTAMP,ContextTokens,GeneratedTokens\n2024-05-10 00:00:00.009930+00:00,2162,5\n2024-05-10 00:00:00.017335+00:00,2399,6\n');
  for (const [p, svc, n] of [[p23, 'conv', 2], [p24, 'code', 2]]) {
    const bounds = await scanBounds(p);
    assert.equal(bounds.format, 'azure');
    const timeMap = makeTimeMap({ bounds, end: 'keep' });
    const reqs = [];
    for await (const r of traceRequests(p, { format: 'azure', service: svc, model: 'claude-sonnet-5-5', timeMap })) reqs.push(r);
    assert.equal(reqs.length, n);
    assert.ok(reqs.every((r) => r.endpoint === (svc === 'code' ? '/code' : '/conversation') && r.status === 200 && r.llm_calls[0].model === 'claude-sonnet-5-5'));
    assert.ok(reqs[0].id.startsWith(`az-${svc}-`));
  }
});

test('tenant split is deterministic, seeded, and follows the requested skew', () => {
  const a = makeTenantPicker({ count: 8, skew: 1, seed: 7 });
  const b = makeTenantPicker({ count: 8, skew: 1, seed: 7 });
  const counts = Object.fromEntries(a.names.map((n) => [n, 0]));
  for (let i = 0; i < 40_000; i++) { assert.equal(a.pick(i), b.pick(i)); counts[a.pick(i)]++; }
  a.shares.forEach((s, i) => assert.ok(Math.abs(counts[a.names[i]] / 40_000 - s) < 0.01, `${a.names[i]} ${(counts[a.names[i]] / 40_000).toFixed(3)} vs ${s.toFixed(3)}`));
  assert.ok(Math.abs(a.shares.reduce((x, y) => x + y, 0) - 1) < 1e-9);
  const flat = makeTenantPicker({ count: 4, skew: 0 });
  assert.deepEqual(flat.shares, [0.25, 0.25, 0.25, 0.25]);
  assert.equal(a.pick('session-abc'), a.pick('session-abc'), 'a conversation id always lands on the same tenant');
  const other = makeTenantPicker({ count: 8, skew: 1, seed: 8 });
  assert.ok(Array.from({ length: 200 }, (_, i) => i).some((i) => other.pick(i) !== a.pick(i)), 'a different seed gives a different assignment');
  const u = Array.from({ length: 10_000 }, (_, i) => unit(i, 99));
  assert.ok(u.every((x) => x >= 0 && x < 1));
  assert.ok(Math.abs(u.reduce((x, y) => x + y, 0) / u.length - 0.5) < 0.02);
});

test('--sample thins deterministically; --days keeps only the newest part', async () => {
  const rows = ['Timestamp,Model,Request tokens,Response tokens,Total tokens,Log Type'];
  for (let i = 0; i < 4000; i++) rows.push(`${i * 60},ChatGPT,100,10,110,API log`); // one request a minute, ~2.8 days
  const p = file('burst3.csv', rows.join('\n') + '\n');
  const bounds = await scanBounds(p);
  const timeMap = makeTimeMap({ bounds, end: '2026-06-10T12:00:00Z' });
  const run = async (extra) => { const out = []; for await (const r of traceRequests(p, { format: 'burstgpt', timeMap, ...extra })) out.push(r); return out; };
  const s1 = await run({ sample: 0.25 });
  const s2 = await run({ sample: 0.25 });
  assert.deepEqual(s1.map((r) => r.id), s2.map((r) => r.id), 'same seed, same rows');
  assert.ok(Math.abs(s1.length / 4000 - 0.25) < 0.03, `kept ${s1.length}`);
  assert.notDeepEqual((await run({ sample: 0.25, seed: 5 })).map((r) => r.id), s1.map((r) => r.id));
  const recent = await run({ keepFromTs: timeMap(bounds.max) - DAY });
  assert.ok(recent.length > 1400 && recent.length <= 1441, `kept ${recent.length}`);
});

test('end to end: a trace imports through the real ingest path with consistent rollups and the stated costs', async () => {
  const p = file('burst4.csv', BURST);
  const bounds = await scanBounds(p);
  const timeMap = makeTimeMap({ bounds, end: '2026-06-10T12:00:00Z' });
  const x = createImportDb({ path: ':memory:', source: 'import:trace:burstgpt', note: 'test' });
  const w = new BatchWriter(x.ingestor);
  for await (const r of traceRequests(p, { format: 'burstgpt', timeMap, tenants: 3 })) w.add(r);
  w.flush();
  assert.equal(w.rejected, 0, w.rejectSamples.join('; '));
  assert.equal(w.accepted, 5);
  assert.deepEqual(verifyRollups(x.db), []);
  const cost = (n) => x.db.prepare('SELECT cost_micro_usd AS c FROM llm_calls ORDER BY ts LIMIT 1 OFFSET ?').get(n).c;
  assert.equal(cost(0), 1700, 'gpt-3.5-turbo @ $1.50 in / $2.00 out per Mtok: 1000 x 1.5 + 100 x 2 micro-USD');
  assert.equal(cost(1), 72_000, 'gpt-4 @ $30 in / $60 out per Mtok: 2000 x 30 + 200 x 60 micro-USD');
  assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 500").get().n, 1);
  assert.ok(x.db.prepare('SELECT COUNT(DISTINCT tenant_id) AS n FROM requests').get().n <= 3, 'at most the 3 requested synthetic tenants');
  x.db.close();
});
