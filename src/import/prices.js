import { seedPrices } from '../pricing.js';

/*
 * Price lists for IMPORTED data. USD per million tokens, converted to the table's micro-USD per Mtok.
 *
 * Claude: input / output / cache-read come from the model catalog bundled with Claude Code's claude-api skill
 * (Fable 5.1 $10/$50 with $0.25 reads; Opus 5.5 $4/$20 with $0.20 reads; Opus 5 and Opus 4.8 $5/$25; Sonnet 5 and
 * 5.5 $2/$10 with $0.20 reads; Haiku 5.5 $0.10/$0.50). Cache writes are 1.25x (5-minute TTL) and 2x (1-hour TTL) the
 * input price. Models not listed in that catalog (Haiku 4.5, Sonnet 4.6, Opus 4.6/4.7) use their well-known list prices.
 * Haiku 5.5 is billed at $0.50/$2.50 for prompts above 100K tokens: only the base tier is modelled here.
 * The importer cross-checks these numbers against the cost Claude Code itself records (see claude-code.js).
 *
 * GPT: the 2023 list prices that were current when BurstGPT's trace was recorded (an ASSUMPTION - the trace holds
 * tokens, not prices). Override any row with --price MODEL=in,out[,read[,write5m[,write1h]]].
 */
const usd = (x) => Math.round(x * 1_000_000);

function claude(model, input, output, read, note) {
  return { model, input_per_mtok: usd(input), output_per_mtok: usd(output), cached_per_mtok: usd(read), cache_write_per_mtok: usd(input * 1.25), cache_write_1h_per_mtok: usd(input * 2), effective_from: 0, note };
}

export const CLAUDE_PRICES = [
  claude('claude-fable-5-1', 10, 50, 0.25, 'catalog'),
  claude('claude-fable-5', 10, 50, 1, 'catalog'),
  claude('claude-opus-5-5', 4, 20, 0.2, 'catalog'),
  claude('claude-opus-5', 5, 25, 0.5, 'catalog; read = 0.1x input'),
  claude('claude-opus-4-8', 5, 25, 0.5, 'catalog (priced like Opus 5); read = 0.1x input'),
  claude('claude-opus-4-7', 5, 25, 0.5, 'list price'),
  claude('claude-opus-4-6', 5, 25, 0.5, 'list price'),
  claude('claude-sonnet-5-5', 2, 10, 0.2, 'catalog'),
  claude('claude-sonnet-5', 2, 10, 0.2, 'catalog (same price as Sonnet 5.5)'),
  claude('claude-sonnet-4-6', 3, 15, 0.3, 'list price'),
  claude('claude-haiku-5-5', 0.1, 0.5, 0.01, 'catalog, base tier (<=100K-token prompts)'),
  claude('claude-haiku-4-5', 1, 5, 0.1, 'list price'),
  claude('claude-haiku-4-5-20251001', 1, 5, 0.1, 'list price'),
];

const gpt = (model, input, output, note) => ({ model, input_per_mtok: usd(input), output_per_mtok: usd(output), cached_per_mtok: usd(input), cache_write_per_mtok: 0, cache_write_1h_per_mtok: 0, effective_from: 0, note });

export const GPT_PRICES = [
  gpt('gpt-3.5-turbo', 1.5, 2, 'assumed: mid-2023 list price (4K context)'),
  gpt('gpt-4', 30, 60, 'assumed: mid-2023 list price (8K context)'),
];

export const ALL_PRICES = [...CLAUDE_PRICES, ...GPT_PRICES];

const PRICED_MODELS = new Set(ALL_PRICES.map((p) => p.model));
/** APIs name the model with a date suffix (claude-haiku-4-5-20251001); use that name when it is priced, else the alias without the date. */
export function normalizeModel(m) {
  if (PRICED_MODELS.has(m)) return m;
  const stripped = m.replace(/-\d{8}$/, '');
  return PRICED_MODELS.has(stripped) ? stripped : m;
}

/** Parse "model=in,out[,read[,write5m[,write1h]]]" (USD per Mtok). Missing read defaults to the input price, writes to 0 (unset). */
export function parsePriceArg(arg) {
  const m = /^([A-Za-z0-9._:-]{1,64})=([0-9.,]+)$/.exec(arg || '');
  if (!m) throw new Error(`bad --price "${arg}": expected MODEL=in,out[,read[,write5m[,write1h]]] in USD per million tokens`);
  const n = m[2].split(',').map(Number);
  if (n.length < 2 || n.length > 5 || n.some((v) => !Number.isFinite(v) || v < 0)) throw new Error(`bad --price "${arg}": 2 to 5 non-negative numbers expected`);
  const [input, output, read = input, w5 = 0, w1 = 0] = n;
  return { model: m[1], input_per_mtok: usd(input), output_per_mtok: usd(output), cached_per_mtok: usd(read), cache_write_per_mtok: usd(w5), cache_write_1h_per_mtok: usd(w1), effective_from: 0, note: '--price' };
}

/** Write the real price list (plus overrides) into model_prices, replacing rows with the same (model, effective_from). */
export function installPrices(db, overrides = []) {
  const rows = new Map();
  for (const p of [...ALL_PRICES, ...overrides]) rows.set(`${p.model}@${p.effective_from}`, p);
  seedPrices(db, [...rows.values()], { replace: true });
  return rows.size;
}
