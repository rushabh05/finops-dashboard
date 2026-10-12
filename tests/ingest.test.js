import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { PriceBook, seedPrices } from '../src/pricing.js';
import { Ingestor, ValidationError, verifyRollups, recomputeRollups } from '../src/ingest.js';
import { TrafficGenerator, Rng } from '../src/sim.js';
import { HOUR } from '../src/util.js';
import { mkRequest } from './helpers.js';

function setup(opts) {
  const db = openDb();
  seedPrices(db);
  return { db, ing: new Ingestor(db, new PriceBook(db), opts) };
}
const T = Date.UTC(2026, 5, 1, 10, 15);

test('ingest computes LLM cost from model_prices and writes raw rows + rollups in one go', () => {
  const { db, ing } = setup();
  const r = ing.ingest({ requests: [mkRequest({ ts: T, calls: [{ model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 200, cached_tokens: 800 }], infra: 700 })] });
  assert.deepEqual({ accepted: r.accepted, duplicates: r.duplicates, llm_calls: r.llm_calls, cost: r.cost_micro_usd }, { accepted: 1, duplicates: 0, llm_calls: 1, cost: 3840 + 700 });
  assert.equal(db.prepare('SELECT cost_micro_usd FROM llm_calls').get().cost_micro_usd, 3840);
  const rollups = db.prepare('SELECT model, requests, llm_calls, tokens_in, tokens_out, cost_micro_usd FROM rollups_hourly ORDER BY model').all().map((x) => ({ ...x }));
  assert.deepEqual(rollups, [
    { model: '', requests: 1, llm_calls: 0, tokens_in: 0, tokens_out: 0, cost_micro_usd: 700 },
    { model: 'claude-sonnet-5-5', requests: 0, llm_calls: 1, tokens_in: 1000, tokens_out: 200, cost_micro_usd: 3840 },
  ]);
  assert.deepEqual(verifyRollups(db), []);
});

test('rollups equal a brute-force recomputation after many randomised, overlapping batches', () => {
  const { db, ing } = setup({ maxBatch: 400 });
  const gen = new TrafficGenerator({ seed: 5, volumeScale: 1 });
  const rng = new Rng(11);
  for (let h = 0; h < 30; h++) {
    const batch = gen.generate(T + h * HOUR - 6 * HOUR, T + h * HOUR - 5 * HOUR);
    // split into random chunks, and re-send some of them (duplicates must not double count)
    let i = 0;
    while (i < batch.length) {
      const n = 1 + rng.int(300);
      const chunk = batch.slice(i, i + n);
      ing.ingest({ requests: chunk });
      if (rng.next() < 0.2) assert.equal(ing.ingest({ requests: chunk }).accepted, 0);
      i += n;
    }
  }
  const have = db.prepare('SELECT COUNT(*) AS n FROM rollups_hourly').get().n;
  assert.ok(have > 200, `expected a meaningful number of rollup rows, got ${have}`);
  assert.deepEqual(verifyRollups(db), [], 'stored rollups must equal brute-force recomputation');
  // and the totals agree with the raw tables directly
  const raw = db.prepare('SELECT (SELECT SUM(infra_cost_micro_usd) FROM requests) + (SELECT SUM(cost_micro_usd) FROM llm_calls) AS c').get().c;
  assert.equal(db.prepare('SELECT SUM(cost_micro_usd) AS c FROM rollups_hourly').get().c, raw);
  assert.equal(recomputeRollups(db).size, have);
});

test('a call whose ts is in a different hour than its request lands in its own hour', () => {
  const { db, ing } = setup();
  const req = mkRequest({ ts: T, calls: [{ model: 'claude-haiku-5-5', input_tokens: 100, output_tokens: 10, ts: T + HOUR }] });
  ing.ingest({ requests: [req] });
  const hours = db.prepare("SELECT hour, model FROM rollups_hourly ORDER BY hour").all().map((r) => [r.hour, r.model]);
  assert.deepEqual(hours, [[Math.floor(T / HOUR) * HOUR, ''], [Math.floor(T / HOUR) * HOUR + HOUR, 'claude-haiku-5-5']]);
  assert.deepEqual(verifyRollups(db), []);
});

test('duplicate request ids are idempotent', () => {
  const { db, ing } = setup();
  const req = mkRequest({ ts: T, id: 'dup-1' });
  assert.equal(ing.ingest({ requests: [req] }).accepted, 1);
  const again = ing.ingest({ requests: [req] });
  assert.deepEqual([again.accepted, again.duplicates], [0, 1]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM llm_calls').get().n, 1);
  assert.deepEqual(verifyRollups(db), []);
});

const bad = (mutate) => { const r = mkRequest({ ts: T }); mutate(r); return { requests: [r] }; };

test('validation rejects bad input and writes nothing (all-or-nothing)', () => {
  const { db, ing } = setup();
  const cases = {
    'unknown model': bad((r) => { r.llm_calls[0].model = 'gpt-nope'; }),
    'cached > input': bad((r) => { r.llm_calls[0].cached_tokens = 5000; }),
    'negative tokens': bad((r) => { r.llm_calls[0].output_tokens = -1; }),
    'float tokens': bad((r) => { r.llm_calls[0].input_tokens = 1.5; }),
    'string tokens': bad((r) => { r.llm_calls[0].input_tokens = '10'; }),
    'bad status': bad((r) => { r.status = 99; }),
    'bad method': bad((r) => { r.method = 'BREW'; }),
    'bad tenant': bad((r) => { r.tenant_id = 'x; DROP TABLE requests'; }),
    'bad endpoint': bad((r) => { r.endpoint = 'no-slash'; }),
    'bad ts': bad((r) => { r.ts = 'yesterday'; }),
    'bad id': bad((r) => { r.id = 'has space'; }),
    'unknown field': bad((r) => { r.prompt = 'secret'; }),
    'unknown call field': bad((r) => { r.llm_calls[0].prompt = 'secret'; }),
    'negative infra': bad((r) => { r.infra_cost_micro_usd = -5; }),
    'llm_calls not array': bad((r) => { r.llm_calls = {}; }),
    'too many calls': bad((r) => { r.llm_calls = Array.from({ length: 21 }, () => ({ model: 'claude-haiku-5-5', input_tokens: 1, output_tokens: 1, latency_ms: 1 })); }),
  };
  for (const [name, body] of Object.entries(cases)) assert.throws(() => ing.ingest(body), ValidationError, name);
  // top-level shape
  for (const body of [null, [], 'x', {}, { requests: 'x' }, { requests: [] }, { requests: [mkRequest({ ts: T })], extra: 1 }]) assert.throws(() => ing.ingest(body), ValidationError);
  // a valid request next to an invalid one: nothing is written
  assert.throws(() => ing.ingest({ requests: [mkRequest({ ts: T }), bad((r) => { r.status = 1; }).requests[0]] }), ValidationError);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rollups_hourly').get().n, 0);
});

test('batch size is capped (413)', () => {
  const { ing } = setup({ maxBatch: 5 });
  const mk = (n) => ({ requests: Array.from({ length: n }, (_, i) => mkRequest({ ts: T + i })) });
  assert.equal(ing.ingest(mk(5)).accepted, 5);
  assert.throws(() => ing.ingest(mk(6)), (e) => e instanceof ValidationError && e.status === 413);
});

test('a failure part-way through the write rolls the whole batch back', () => {
  const { db, ing } = setup();
  // pre-existing llm call id collides with the second request's call -> the INSERT throws mid-transaction
  ing.ingest({ requests: [{ ...mkRequest({ ts: T, id: 'a' }), llm_calls: [{ id: 'shared-call', model: 'claude-haiku-5-5', input_tokens: 1, output_tokens: 1, latency_ms: 1 }] }] });
  const before = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
  const batch = { requests: [mkRequest({ ts: T, id: 'b' }), { ...mkRequest({ ts: T, id: 'c' }), llm_calls: [{ id: 'shared-call', model: 'claude-haiku-5-5', input_tokens: 1, output_tokens: 1, latency_ms: 1 }] }] };
  assert.throws(() => ing.ingest(batch));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, before);
  assert.deepEqual(verifyRollups(db), []);
});

test('triggers log rollup and alert changes with an autoincrement seq', () => {
  const { db, ing } = setup();
  ing.ingest({ requests: [mkRequest({ ts: T })] });
  ing.ingest({ requests: [mkRequest({ ts: T })] }); // same rollup rows -> updates
  const ch = db.prepare('SELECT seq, "table" AS t, op FROM changes ORDER BY seq').all().map((r) => ({ ...r }));
  assert.deepEqual(ch.map((c) => c.t), ['rollups_hourly', 'rollups_hourly', 'rollups_hourly', 'rollups_hourly']);
  assert.deepEqual(ch.map((c) => c.op), ['insert', 'insert', 'update', 'update']);
  db.prepare("INSERT INTO alerts(ts, kind, observed, baseline, score, explanation) VALUES(1,'cost_spike',1,1,1,'x')").run();
  db.prepare("UPDATE alerts SET status = 'ack' WHERE id = 1").run();
  const tail = db.prepare('SELECT "table" AS t, op FROM changes ORDER BY seq DESC LIMIT 2').all().map((r) => `${r.t}:${r.op}`).reverse();
  assert.deepEqual(tail, ['alerts:insert', 'alerts:update']);
  const maxSeq = db.prepare('SELECT MAX(seq) AS s FROM changes').get().s;
  db.exec('DELETE FROM changes');
  db.prepare("UPDATE alerts SET status = 'resolved' WHERE id = 1").run();
  assert.equal(db.prepare('SELECT MIN(seq) AS s FROM changes').get().s, maxSeq + 1, 'AUTOINCREMENT never reuses a seq');
});

test('cache-write tokens are priced from the table, stored, and validated', () => {
  const { db, ing } = setup();
  db.prepare("INSERT INTO model_prices(model, input_per_mtok, output_per_mtok, cached_per_mtok, effective_from, cache_write_per_mtok, cache_write_1h_per_mtok) VALUES('cw-model', 2000000, 10000000, 200000, 0, 2500000, 4000000)").run();
  ing.priceBook.reload();
  const call = { model: 'cw-model', input_tokens: 10_000, output_tokens: 100, cached_tokens: 6000, cache_write_tokens: 1000, cache_write_1h_tokens: 500 };
  const r = ing.ingest({ requests: [mkRequest({ ts: T, id: 'cw-1', calls: [call], infra: 0 })] });
  // 2500 plain*2 + 6000*0.2 + 1000*2.5 + 500*4 + 100*10 = 5000 + 1200 + 2500 + 2000 + 1000 = 11700
  assert.equal(r.cost_micro_usd, 11_700);
  const row = db.prepare('SELECT input_tokens, cached_tokens, cache_write_tokens, cache_write_1h_tokens, cost_micro_usd FROM llm_calls WHERE request_id = ?').get('cw-1');
  assert.deepEqual({ ...row }, { input_tokens: 10_000, cached_tokens: 6000, cache_write_tokens: 1000, cache_write_1h_tokens: 500, cost_micro_usd: 11_700 });
  assert.deepEqual(verifyRollups(db), []);
  const bads = {
    'writes + cached > input': { ...call, cache_write_tokens: 4000 },
    'negative write tokens': { ...call, cache_write_tokens: -1 },
    'float 1h write tokens': { ...call, cache_write_1h_tokens: 1.5 },
  };
  for (const [name, c] of Object.entries(bads)) assert.throws(() => ing.ingest({ requests: [mkRequest({ ts: T, calls: [c] })] }), ValidationError, name);
  // a model whose price row has no write rate must refuse writes rather than bill them at zero
  assert.throws(() => ing.ingest({ requests: [mkRequest({ ts: T, calls: [{ model: 'claude-haiku-5-5', input_tokens: 100, output_tokens: 1, cache_write_tokens: 50 }] })] }), /no cache write price/);
  assert.throws(() => ing.ingest({ requests: [mkRequest({ ts: T, calls: [{ model: 'claude-haiku-5-5', input_tokens: 100, output_tokens: 1, cache_write_1h_tokens: 50 }] })] }), /no 1-hour cache write price/);
});

test('openDb upgrades a database created before the cache-write columns existed', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'finops-migrate-'));
  try {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE requests(id TEXT PRIMARY KEY, ts INTEGER NOT NULL, tenant_id TEXT NOT NULL, endpoint TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL, duration_ms INTEGER NOT NULL, infra_cost_micro_usd INTEGER NOT NULL);
      CREATE TABLE llm_calls(id TEXT PRIMARY KEY, request_id TEXT NOT NULL, ts INTEGER NOT NULL, tenant_id TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL, latency_ms INTEGER NOT NULL, cost_micro_usd INTEGER NOT NULL);
      CREATE TABLE model_prices(model TEXT NOT NULL, input_per_mtok INTEGER NOT NULL, output_per_mtok INTEGER NOT NULL, cached_per_mtok INTEGER NOT NULL, effective_from INTEGER NOT NULL, PRIMARY KEY(model, effective_from));
      INSERT INTO model_prices VALUES('m', 1000000, 2000000, 100000, 0);
      INSERT INTO requests VALUES('r1', 1, 't', '/e', 'POST', 200, 5, 0);
      INSERT INTO llm_calls VALUES('c1', 'r1', 1, 't', '/e', 'm', 10, 5, 0, 3, 20);`);
    old.close();
    const db = openDb(path);
    const price = db.prepare('SELECT * FROM model_prices').get();
    assert.deepEqual([price.cache_write_per_mtok, price.cache_write_1h_per_mtok], [0, 0]);
    const call = db.prepare('SELECT * FROM llm_calls').get();
    assert.deepEqual([call.cost_micro_usd, call.cache_write_tokens, call.cache_write_1h_tokens], [20, 0, 0]);
    openDb(path).close(); // idempotent
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
