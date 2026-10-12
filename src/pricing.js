import { transaction } from './db.js';

/*
 * Cost formula (all integer arithmetic until the final rounding):
 *
 *   uncached_in = input_tokens - cached_tokens - cache_write_tokens - cache_write_1h_tokens
 *   micro_usd   = round_half_up( (uncached_in * input_per_mtok
 *                               + cached_tokens * cached_per_mtok
 *                               + cache_write_tokens * cache_write_per_mtok
 *                               + cache_write_1h_tokens * cache_write_1h_per_mtok
 *                               + output_tokens * output_per_mtok) / 1_000_000 )
 *
 * Prices are micro-USD per million tokens, so tokens * price / 1e6 yields micro-USD.
 * `input_tokens` is the WHOLE prompt: it includes the cached (read) tokens and the tokens written to the cache
 * (5-minute and 1-hour TTL), which are billed at their own rates. The cache-write fields are optional (default 0).
 */
export function divRound(n, d) {
  let q = Math.floor(n / d);
  let r = n - q * d;
  if (r < 0) { q -= 1; r += d; }
  else if (r >= d) { q += 1; r -= d; }
  return r * 2 >= d ? q + 1 : q;
}

export function computeCostMicro({ input_tokens, output_tokens, cached_tokens = 0, cache_write_tokens = 0, cache_write_1h_tokens = 0 }, price) {
  const special = cached_tokens + cache_write_tokens + cache_write_1h_tokens;
  if (special > input_tokens) throw new RangeError('cached_tokens + cache_write_tokens + cache_write_1h_tokens cannot exceed input_tokens');
  const sum =
    (input_tokens - special) * price.input_per_mtok +
    cached_tokens * price.cached_per_mtok +
    cache_write_tokens * (price.cache_write_per_mtok ?? 0) +
    cache_write_1h_tokens * (price.cache_write_1h_per_mtok ?? 0) +
    output_tokens * price.output_per_mtok;
  return divRound(sum, 1_000_000);
}

/**
 * Illustrative list prices (micro-USD / Mtok) for the simulator. Seeded into model_prices; the cost path only ever
 * reads the table. Real, dated prices for imported data live in src/import/prices.js.
 */
export const DEFAULT_PRICES = [
  { model: 'claude-haiku-5-5', input_per_mtok: 1_000_000, output_per_mtok: 5_000_000, cached_per_mtok: 100_000, effective_from: 0 },
  { model: 'claude-sonnet-5-5', input_per_mtok: 3_000_000, output_per_mtok: 15_000_000, cached_per_mtok: 300_000, effective_from: 0 },
  { model: 'claude-opus-5-5', input_per_mtok: 5_000_000, output_per_mtok: 25_000_000, cached_per_mtok: 500_000, effective_from: 0 },
];

/** Insert price rows. `replace: true` overwrites a row with the same (model, effective_from); the default keeps existing rows. */
export function seedPrices(db, prices = DEFAULT_PRICES, { replace = false } = {}) {
  const st = db.prepare(
    `INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO model_prices(model, input_per_mtok, output_per_mtok, cached_per_mtok, effective_from, cache_write_per_mtok, cache_write_1h_per_mtok) VALUES(?,?,?,?,?,?,?)`,
  );
  transaction(db, () => {
    for (const p of prices) st.run(p.model, p.input_per_mtok, p.output_per_mtok, p.cached_per_mtok, p.effective_from, p.cache_write_per_mtok ?? 0, p.cache_write_1h_per_mtok ?? 0);
  });
}

/** In-memory view of model_prices. Call reload() after changing the table. */
export class PriceBook {
  constructor(db) {
    this.db = db;
    this.reload();
  }
  reload() {
    this.byModel = new Map();
    const rows = this.db
      .prepare('SELECT model, input_per_mtok, output_per_mtok, cached_per_mtok, cache_write_per_mtok, cache_write_1h_per_mtok, effective_from FROM model_prices ORDER BY model, effective_from')
      .all();
    for (const r of rows) {
      if (!this.byModel.has(r.model)) this.byModel.set(r.model, []);
      this.byModel.get(r.model).push(r);
    }
  }
  models() {
    return [...this.byModel.keys()];
  }
  /** The price row effective at `ts` (latest effective_from <= ts), or null. */
  priceAt(model, ts) {
    const list = this.byModel.get(model);
    if (!list) return null;
    let found = null;
    for (const p of list) {
      if (p.effective_from <= ts) found = p;
      else break;
    }
    return found;
  }
  cost(call, ts) {
    const price = this.priceAt(call.model, ts);
    if (!price) throw new Error(`no price for model ${call.model} at ${ts}`);
    return computeCostMicro(call, price);
  }
}
