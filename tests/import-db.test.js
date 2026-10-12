import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImportDb, BatchWriter, backfillDetection, finishImport, describeDb } from '../src/import/common.js';
import { CLAUDE_PRICES, GPT_PRICES, parsePriceArg, installPrices } from '../src/import/prices.js';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';
import { PriceBook, seedPrices } from '../src/pricing.js';
import { Ingestor } from '../src/ingest.js';
import { mkRequest, api } from './helpers.js';
import { HOUR, DAY } from '../src/util.js';

const withDir = async (fn) => { const dir = mkdtempSync(join(tmpdir(), 'finops-impdb-')); try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const T = Date.UTC(2026, 5, 1, 0, 0);

test('createImportDb: refuses an existing file unless replaced, and never overwrites data it did not create', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'x.db');
    const a = createImportDb({ path, source: 'import:test', note: 'n' });
    a.ingestor.ingest({ requests: [mkRequest({ ts: T })] });
    a.db.close();
    assert.throws(() => createImportDb({ path, source: 'import:test', note: 'n' }), /already exists/);
    // replacing our own (importer-tagged) database is fine and starts clean
    const b = createImportDb({ path, replace: true, source: 'import:test', note: 'n' });
    assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
    b.db.close();

    // a database with data that is NOT tagged as imported (the simulator's file, live ingest) is never replaced
    const other = join(dir, 'sim.db');
    const o = openDb(other);
    seedPrices(o);
    new Ingestor(o, new PriceBook(o)).ingest({ requests: [mkRequest({ ts: T })] });
    o.close();
    assert.throws(() => createImportDb({ path: other, replace: true, source: 'import:test', note: 'n' }), /not created by an importer/);
    assert.ok(existsSync(other), 'left untouched');
    // an empty database is safe to replace
    const empty = join(dir, 'empty.db');
    openDb(empty).close();
    createImportDb({ path: empty, replace: true, source: 'import:test', note: 'n' }).db.close();
    // garbage that is not a database at all is not touched either
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'not a database');
    assert.throws(() => createImportDb({ path: junk, replace: true, source: 'import:test', note: 'n' }), /not created by an importer/);
  });
});

test('price list: every Claude row has read + both write rates; overrides replace; bad --price is rejected', () => {
  for (const p of CLAUDE_PRICES) {
    assert.ok(p.cache_write_per_mtok > 0 && p.cache_write_1h_per_mtok > p.cache_write_per_mtok && p.cached_per_mtok < p.input_per_mtok, p.model);
    assert.equal(p.cache_write_per_mtok, Math.round(p.input_per_mtok * 1.25), `${p.model}: 5-minute writes cost 1.25x input`);
    assert.equal(p.cache_write_1h_per_mtok, p.input_per_mtok * 2, `${p.model}: 1-hour writes cost 2x input`);
  }
  const sonnet = CLAUDE_PRICES.find((p) => p.model === 'claude-sonnet-5-5');
  assert.deepEqual([sonnet.input_per_mtok, sonnet.output_per_mtok, sonnet.cached_per_mtok], [2_000_000, 10_000_000, 200_000]);
  assert.ok(GPT_PRICES.every((p) => p.cache_write_per_mtok === 0));
  assert.deepEqual(parsePriceArg('my-model=1.5,6,0.15,1.9,3'), { model: 'my-model', input_per_mtok: 1_500_000, output_per_mtok: 6_000_000, cached_per_mtok: 150_000, cache_write_per_mtok: 1_900_000, cache_write_1h_per_mtok: 3_000_000, effective_from: 0, note: '--price' });
  assert.equal(parsePriceArg('m=2,8').cached_per_mtok, 2_000_000, 'read defaults to the input price');
  for (const bad of ['nope', 'm=1', 'm=a,b', 'm=1,2,3,4,5,6', '=1,2']) assert.throws(() => parsePriceArg(bad), /bad --price/, bad);
  const db = openDb();
  installPrices(db, [parsePriceArg('claude-sonnet-5-5=9,9')]);
  assert.equal(new PriceBook(db).priceAt('claude-sonnet-5-5', 5).input_per_mtok, 9_000_000, 'an override wins over the built-in row');
});

test('an imported database: the server shows the source, never seeds or simulates, and refuses /api/sim', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'imp.db');
    const x = createImportDb({ path, source: 'import:claude-code', note: 'Imported for the test. Costs are API-equivalent.' });
    const w = new BatchWriter(x.ingestor);
    for (let i = 0; i < 5; i++) w.add(mkRequest({ ts: T + i * HOUR, id: `imp-${i}`, tenant: 'proj-a', endpoint: '/main/cli' }));
    w.flush();
    finishImport(x);
    x.db.close();

    const app = await createApp({ dbPath: path, port: 0, seedDays: 3, simAutoStart: true, detectEveryMs: 100000 });
    await app.listen();
    try {
      const stats = (await api(app, 'GET', '/api/stats')).json;
      assert.deepEqual(stats.source, { id: 'import:claude-code', note: 'Imported for the test. Costs are API-equivalent.' });
      assert.equal(stats.sim.disabled, true);
      assert.equal(stats.sim.running, false, 'simAutoStart is ignored on imported data');
      assert.equal(stats.db.requests, 5, 'nothing was seeded or simulated');
      for (const body of [{ running: true }, { inject: 'retry_storm' }, { rate: 10 }]) {
        const r = await api(app, 'POST', '/api/sim', { body });
        assert.equal(r.status, 409, JSON.stringify(body));
        assert.match(r.json.error, /simulator is disabled/);
      }
      assert.equal((await api(app, 'GET', '/api/summary?range=24h')).json.totals.requests, 5);
    } finally { await app.close(); }

    // ...whereas a database without the tag behaves as before
    const plain = await createApp({ dbPath: ':memory:', port: 0, seedDays: 2, volumeScale: 0.2, simAutoStart: false, detectEveryMs: 100000 });
    await plain.listen();
    try {
      const s = (await api(plain, 'GET', '/api/stats')).json;
      assert.equal(s.source, null);
      assert.equal(s.sim.disabled, false);
      assert.ok(s.db.requests > 100);
      assert.equal((await api(plain, 'POST', '/api/sim', { body: { rate: 10 } })).status, 200);
    } finally { await plain.close(); }
  });
});

test('an EMPTY tagged database is not seeded with simulated history either', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'empty-imp.db');
    createImportDb({ path, source: 'import:trace:burstgpt', note: 'n' }).db.close();
    const app = await createApp({ dbPath: path, port: 0, seedDays: 3, volumeScale: 0.2, simAutoStart: true, detectEveryMs: 100000 });
    await app.listen();
    try {
      assert.equal((await api(app, 'GET', '/api/stats')).json.db.requests, 0);
    } finally { await app.close(); }
  });
});

test('detector backfill raises alerts in the data\'s own time, once per cooldown, and describeDb reports the headline numbers', () => {
  const x = createImportDb({ path: ':memory:', source: 'import:test', note: 'n' });
  const w = new BatchWriter(x.ingestor);
  const last = Date.UTC(2026, 5, 20, 12, 0);
  // 10 steady days of 40 requests/hour, then 3 hours at 300/hour
  let n = 0;
  for (let h = last - 10 * DAY; h < last; h += HOUR) {
    const k = h >= last - 3 * HOUR ? 300 : 40;
    for (let i = 0; i < k; i++) w.add(mkRequest({ ts: h + i * 1000, id: `bf-${n++}`, tenant: 'steady', endpoint: '/main/cli', infra: 20_000 }));
  }
  w.flush();
  const b = backfillDetection(x.db, { days: 2 });
  assert.ok(b.inserted >= 1 && b.inserted <= 6, `inserted ${b.inserted}`);
  assert.ok(Object.keys(b.byKind).length >= 1);
  const alert = x.db.prepare('SELECT ts, hour, tenant_id FROM alerts ORDER BY ts LIMIT 1').get();
  assert.ok(alert.ts > last - 3 * HOUR - HOUR && alert.ts <= last + HOUR, 'alert time is data time, not wall-clock time');
  const d = describeDb(x.db);
  assert.equal(d.requests, n);
  assert.equal(d.source, 'import:test');
  assert.equal(d.tenants[0].key, 'steady');
  assert.equal(backfillDetection(openDb(), { days: 3 }).inserted, 0, 'an empty database yields nothing');
  x.db.close();
});
