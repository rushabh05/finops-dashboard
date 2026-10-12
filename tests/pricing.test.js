import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCostMicro, divRound, PriceBook, seedPrices, DEFAULT_PRICES } from '../src/pricing.js';
import { openDb } from '../src/db.js';
import { Rng } from '../src/sim.js';

const SONNET = { input_per_mtok: 3_000_000, output_per_mtok: 15_000_000, cached_per_mtok: 300_000 };

test('cost: plain input + output', () => {
  // 1,000 in @ $3/Mtok = $0.003 ; 200 out @ $15/Mtok = $0.003  -> $0.006 = 6000 micro-USD
  assert.equal(computeCostMicro({ input_tokens: 1000, output_tokens: 200, cached_tokens: 0 }, SONNET), 6000);
});

test('cost: cached tokens are billed at the cached price, the rest of the input at the input price', () => {
  // 1000 in of which 800 cached: 200 * 3 + 800 * 0.30 = 600 + 240 = 840 ; plus 200 out * 15 = 3000 -> 3840
  assert.equal(computeCostMicro({ input_tokens: 1000, output_tokens: 200, cached_tokens: 800 }, SONNET), 3840);
  // all cached: 1000 * 0.30 = 300
  assert.equal(computeCostMicro({ input_tokens: 1000, output_tokens: 0, cached_tokens: 1000 }, SONNET), 300);
  // caching is cheaper than not caching
  assert.ok(computeCostMicro({ input_tokens: 5000, output_tokens: 10, cached_tokens: 4000 }, SONNET) < computeCostMicro({ input_tokens: 5000, output_tokens: 10, cached_tokens: 0 }, SONNET));
});

test('cost: cached_tokens may not exceed input_tokens', () => {
  assert.throws(() => computeCostMicro({ input_tokens: 10, output_tokens: 1, cached_tokens: 11 }, SONNET), RangeError);
});

test('cost: rounds half up to whole micro-dollars', () => {
  // 1 token at $0.5/Mtok-in = 0.5 micro-USD -> rounds up to 1 ; at 0.4 -> 0
  assert.equal(computeCostMicro({ input_tokens: 1, output_tokens: 0, cached_tokens: 0 }, { input_per_mtok: 500_000, output_per_mtok: 0, cached_per_mtok: 0 }), 1);
  assert.equal(computeCostMicro({ input_tokens: 1, output_tokens: 0, cached_tokens: 0 }, { input_per_mtok: 400_000, output_per_mtok: 0, cached_per_mtok: 0 }), 0);
  assert.equal(divRound(2_500_000, 1_000_000), 3);
  assert.equal(divRound(2_499_999, 1_000_000), 2);
});

test('cost matches an exact BigInt reference on random inputs (including large token counts)', () => {
  const rng = new Rng(7);
  for (let i = 0; i < 5000; i++) {
    const input = rng.int(10_000_000);
    const cached = rng.int(input + 1);
    const output = rng.int(10_000_000);
    const price = { input_per_mtok: rng.int(30_000_000), output_per_mtok: rng.int(120_000_000), cached_per_mtok: rng.int(5_000_000) };
    const sum = BigInt(input - cached) * BigInt(price.input_per_mtok) + BigInt(cached) * BigInt(price.cached_per_mtok) + BigInt(output) * BigInt(price.output_per_mtok);
    const want = Number((sum + 500_000n) / 1_000_000n);
    assert.equal(computeCostMicro({ input_tokens: input, output_tokens: output, cached_tokens: cached }, price), want);
  }
});

test('price book: cost always comes from model_prices, honouring effective_from', () => {
  const db = openDb();
  seedPrices(db, DEFAULT_PRICES);
  const T0 = Date.UTC(2026, 0, 1);
  db.prepare('INSERT INTO model_prices(model, input_per_mtok, output_per_mtok, cached_per_mtok, effective_from) VALUES(?,?,?,?,?)').run('claude-sonnet-5-5', 1_500_000, 7_500_000, 150_000, T0);
  const book = new PriceBook(db);
  const call = { model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 200, cached_tokens: 0 };
  assert.equal(book.cost(call, T0 - 1), 6000, 'before the new price takes effect');
  assert.equal(book.cost(call, T0), 3000, 'from effective_from onward');
  assert.equal(book.priceAt('nope', T0), null);
  // editing the table (and reloading) changes the computed cost: nothing is hard-coded
  db.prepare("UPDATE model_prices SET input_per_mtok = 6000000 WHERE model = 'claude-sonnet-5-5' AND effective_from = 0").run();
  book.reload();
  assert.equal(book.cost(call, T0 - 1), 9000);
  assert.throws(() => book.cost({ ...call, model: 'nope' }, T0), /no price/);
});

const SONNET_WRITES = { ...SONNET, cache_write_per_mtok: 3_750_000, cache_write_1h_per_mtok: 6_000_000 }; // 1.25x and 2x the input price

test('cost: cache writes are billed at their own 5-minute / 1-hour rates, and are part of input_tokens', () => {
  // 10,000 prompt tokens = 1,000 plain + 5,000 cache reads + 3,000 5m writes + 1,000 1h writes; 200 out
  //   1000*3 + 5000*0.30 + 3000*3.75 + 1000*6 + 200*15 = 3000 + 1500 + 11250 + 6000 + 3000 = 24750
  assert.equal(computeCostMicro({ input_tokens: 10_000, output_tokens: 200, cached_tokens: 5000, cache_write_tokens: 3000, cache_write_1h_tokens: 1000 }, SONNET_WRITES), 24_750);
  // a price row without write rates (every pre-existing row) bills them at 0 here, which is why ingest refuses that combination
  assert.equal(computeCostMicro({ input_tokens: 1000, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 1000 }, SONNET), 0);
  // omitting the write fields keeps the old formula
  assert.equal(computeCostMicro({ input_tokens: 1000, output_tokens: 200, cached_tokens: 800 }, SONNET_WRITES), 3840);
});

test('cost: cached + writes may not exceed input_tokens', () => {
  assert.throws(() => computeCostMicro({ input_tokens: 100, output_tokens: 1, cached_tokens: 60, cache_write_tokens: 30, cache_write_1h_tokens: 11 }, SONNET_WRITES), RangeError);
  assert.doesNotThrow(() => computeCostMicro({ input_tokens: 100, output_tokens: 1, cached_tokens: 60, cache_write_tokens: 30, cache_write_1h_tokens: 10 }, SONNET_WRITES));
});

test('cost with cache writes matches an exact BigInt reference on random inputs', () => {
  const rng = new Rng(11);
  for (let i = 0; i < 5000; i++) {
    const input = rng.int(10_000_000);
    const cached = rng.int(input + 1);
    const w5 = rng.int(input - cached + 1);
    const w1 = rng.int(input - cached - w5 + 1);
    const output = rng.int(10_000_000);
    const price = { input_per_mtok: rng.int(30_000_000), output_per_mtok: rng.int(120_000_000), cached_per_mtok: rng.int(5_000_000), cache_write_per_mtok: rng.int(40_000_000), cache_write_1h_per_mtok: rng.int(60_000_000) };
    const sum = BigInt(input - cached - w5 - w1) * BigInt(price.input_per_mtok) + BigInt(cached) * BigInt(price.cached_per_mtok)
      + BigInt(w5) * BigInt(price.cache_write_per_mtok) + BigInt(w1) * BigInt(price.cache_write_1h_per_mtok) + BigInt(output) * BigInt(price.output_per_mtok);
    const want = Number((sum + 500_000n) / 1_000_000n);
    assert.equal(computeCostMicro({ input_tokens: input, output_tokens: output, cached_tokens: cached, cache_write_tokens: w5, cache_write_1h_tokens: w1 }, price), want);
  }
});

test('price book carries the cache-write rates, and seedPrices can replace a row', () => {
  const db = openDb();
  seedPrices(db, DEFAULT_PRICES);
  seedPrices(db, [{ model: 'claude-sonnet-5-5', input_per_mtok: 2_000_000, output_per_mtok: 10_000_000, cached_per_mtok: 200_000, cache_write_per_mtok: 2_500_000, cache_write_1h_per_mtok: 4_000_000, effective_from: 0 }]);
  assert.equal(new PriceBook(db).priceAt('claude-sonnet-5-5', 5).input_per_mtok, 3_000_000, 'default: an existing row is kept');
  seedPrices(db, [{ model: 'claude-sonnet-5-5', input_per_mtok: 2_000_000, output_per_mtok: 10_000_000, cached_per_mtok: 200_000, cache_write_per_mtok: 2_500_000, cache_write_1h_per_mtok: 4_000_000, effective_from: 0 }], { replace: true });
  const book = new PriceBook(db);
  const p = book.priceAt('claude-sonnet-5-5', 5);
  assert.deepEqual([p.input_per_mtok, p.cache_write_per_mtok, p.cache_write_1h_per_mtok], [2_000_000, 2_500_000, 4_000_000]);
  assert.equal(book.cost({ model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 400, cache_write_1h_tokens: 100 }, 5), 500 * 2 + 400 * 2.5 + 100 * 4);
});
