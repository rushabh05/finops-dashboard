import { createHash } from 'node:crypto';
import { computeCostMicro } from './pricing.js';

/*
 * The providers `finops proxy` can forward to besides Anthropic, and how a call's usage and cost are read from what they answer.
 *
 * Every provider here speaks the OpenAI wire format (`POST .../chat/completions`, or `/responses`): a `usage` block with prompt/completion
 * (or input/output) token counts and, per provider, cached-prompt tokens. Where the COST of a call comes from is the one thing that differs:
 *
 *   OpenRouter  the response carries the charge itself (`usage.cost`, in credits, which are US dollars). That figure is used as it is: it is
 *               exact, covers any of hundreds of models and already reflects the provider that served the call. Nothing is looked up.
 *   OpenAI,     the response has tokens only, so the cost is tokens x the list price below, computed here and sent to the dashboard as the
 *   DeepSeek    call's supplied cost (see ingest.js). A model with no price is not guessed: it is named in the proxy's log and counted.
 *   any other   `--provider NAME=URL`: tokens x a price you give with `--price`, or the gateway's own `usage.cost` if you say you trust it.
 *
 * The built-in prices were read from the providers' own pricing pages on 2026-10-13 (below). They are STANDARD-tier list prices: a flex, batch
 * or priority ("fast") call, a prompt above a model's long-context threshold, regional data-residency uplifts and per-tool fees are billed
 * differently and are not modelled. Check them against an invoice, and override any with --price MODEL=in,out,cached.
 */

const usd = (x) => Math.round(x * 1_000_000);
const row = (model, input, cached, output) => ({ model, input_per_mtok: usd(input), cached_per_mtok: usd(cached), output_per_mtok: usd(output) });

/** https://developers.openai.com/api/docs/pricing, Standard tier, USD per Mtok: input, cached input, output. Only rows that two separate reads of the page agreed on. */
export const OPENAI_PRICES = [
  row('gpt-6-sol', 2, 0.2, 10), row('gpt-6.1-sol', 2, 0.1, 10), row('gpt-6-luna', 0.1, 0.01, 0.5),
  row('gpt-5.5', 5, 0.5, 30), row('gpt-5.4', 2.5, 0.25, 15), row('gpt-5.4-mini', 0.75, 0.075, 4.5),
  row('gpt-5.1', 1.25, 0.125, 10), row('gpt-5', 1.25, 0.125, 10), row('gpt-5-mini', 0.25, 0.025, 2), row('gpt-5-nano', 0.05, 0.005, 0.4),
  row('gpt-4.1', 2, 0.5, 8), row('gpt-4.1-mini', 0.4, 0.1, 1.6),
  row('gpt-4o', 2.5, 1.25, 10), row('gpt-4o-mini', 0.15, 0.075, 0.6),
  row('o3', 2, 0.5, 8), row('o4-mini', 1.1, 0.275, 4.4),
];

/**
 * https://api-docs.deepseek.com/quick_start/pricing. The OFF-PEAK rates (input = cache miss, cached = cache hit); peak hours cost twice as much (deepseekIsPeak).
 * The retired names deepseek-v4-flash and deepseek-v4-flash-vision-exp are served by, and billed as, deepseek-flash.
 */
export const DEEPSEEK_PRICES = [row('deepseek-flash', 0.15, 0.003, 0.6), row('deepseek-v4-pro', 0.66, 0.022, 1.98)];
const DEEPSEEK_ALIASES = { 'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4-flash-vision-exp': 'deepseek-flash' };

/**
 * DeepSeek's peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday, EXCEPT Chinese public holidays, which this does not know: a call on one
 * is billed at the off-peak rate by DeepSeek and at the peak rate here (an overestimate of at most 2x on those days).
 */
export function deepseekIsPeak(ts) {
  const d = new Date(ts);
  const dow = d.getUTCDay(), h = d.getUTCHours();
  return dow !== 0 && dow !== 6 && ((h >= 1 && h < 4) || (h >= 6 && h < 10));
}

const byModel = (list) => new Map(list.map((p) => [p.model, p]));

export const BUILTIN_PROVIDERS = {
  anthropic: { upstream: 'https://api.anthropic.com', format: 'anthropic' },
  openai: { upstream: 'https://api.openai.com', format: 'openai', prices: byModel(OPENAI_PRICES) },
  deepseek: { upstream: 'https://api.deepseek.com', format: 'openai', prices: byModel(DEEPSEEK_PRICES), aliases: DEEPSEEK_ALIASES, peak: deepseekIsPeak },
  openrouter: { upstream: 'https://openrouter.ai', format: 'openai', reportsCost: true },
};

export const RE_PROVIDER = /^[a-z][a-z0-9-]{0,29}$/;
const RESERVED = new Set(['v1', 'v1beta', 'api', '__finops']); // first path segments that are not provider names

/**
 * "openai" (built in) or "name=https://host" (any OpenAI-compatible endpoint; its cost comes from --price, or from the response if `name` is in `reportedCost`).
 * Returns { name, upstream, format, prices, aliases, peak, reportsCost }.
 */
export function parseProviderSpec(spec, { reportedCost = [] } = {}) {
  const m = /^([^=]+)(?:=(.+))?$/.exec(String(spec));
  if (!m) throw new Error(`bad --provider "${spec}": expected a name like openai, or NAME=https://host`);
  const name = m[1];
  if (!RE_PROVIDER.test(name) || RESERVED.has(name)) throw new Error(`bad provider name "${name}": lowercase letters, digits and dashes, starting with a letter`);
  const builtin = BUILTIN_PROVIDERS[name];
  if (!m[2] && !builtin) throw new Error(`unknown provider "${name}": the built-in ones are ${Object.keys(BUILTIN_PROVIDERS).join(', ')}; for another OpenAI-compatible endpoint give its URL: --provider ${name}=https://host`);
  const p = { name, upstream: m[2] || builtin.upstream, format: builtin?.format ?? 'openai', prices: builtin?.prices ?? null, aliases: builtin?.aliases ?? {}, peak: builtin?.peak ?? null, reportsCost: !!builtin?.reportsCost };
  if (reportedCost.includes(name)) p.reportsCost = true;
  return p;
}

/* ------------------------------------------------------------------ reading usage (OpenAI wire format) */

const int = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0);
const num = (n) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null);

/**
 * `usage` of a chat completion or a Responses API answer -> { input, output, cached, cacheWrite, reportedMicro }, or null when there is no usage.
 * input is the WHOLE prompt (cached tokens included, as the dashboard keeps it); output includes reasoning tokens (they are billed as output).
 * reportedMicro is the call's own charge in micro-USD when the provider reports one AND is trusted to (OpenRouter: `cost` is what the account is
 * charged; for a bring-your-own-key call that is OpenRouter's fee, and `cost_details.upstream_inference_cost` is what the provider charged on top).
 */
export function openaiUsage(u, { reportsCost = false } = {}) {
  if (!u || typeof u !== 'object') return null;
  const input = int(u.prompt_tokens ?? u.input_tokens), output = int(u.completion_tokens ?? u.output_tokens);
  if (u.prompt_tokens === undefined && u.input_tokens === undefined && u.completion_tokens === undefined && u.output_tokens === undefined) return null;
  const details = u.prompt_tokens_details ?? u.input_tokens_details ?? {};
  const cached = Math.min(input, int(details.cached_tokens ?? u.prompt_cache_hit_tokens));
  const cacheWrite = Math.min(input - cached, int(details.cache_write_tokens));
  let reportedMicro = null;
  if (reportsCost) {
    const cost = num(u.cost);
    if (cost !== null) reportedMicro = usd(cost) + usd(num(u.cost_details?.upstream_inference_cost) ?? 0);
  }
  return { input, output, cached, cacheWrite, reportedMicro };
}

/** Read `usage` out of a streamed OpenAI-format response (chat completion chunks or Responses events), incrementally. The last usage seen wins. */
export class OpenAiSseUsage {
  constructor() { this.buf = ''; this.usage = null; this.model = null; this.complete = false; this.errorType = null; this.sawUsage = false; }
  push(text) {
    this.buf += text;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.#line(line);
    }
    if (this.buf.length > 1_000_000) this.buf = ''; // one line this long is not an event we understand
  }
  #line(l) {
    if (!l.startsWith('data:')) return; // event names, comments (": OPENROUTER PROCESSING") and blank lines carry nothing we read
    const d = l.slice(5).trim();
    if (d === '[DONE]') { this.complete = true; return; }
    if (d[0] !== '{') return;
    let j;
    try { j = JSON.parse(d); } catch { return; }
    const model = j.model ?? j.response?.model;
    if (typeof model === 'string') this.model = model;
    const usage = j.usage ?? j.response?.usage;
    if (usage && typeof usage === 'object') { this.usage = usage; this.sawUsage = true; }
    if (j.type === 'response.completed' || j.type === 'response.incomplete') this.complete = true;
    if (j.error) this.errorType = String(j.error.type || j.error.code || 'error');
    else if (j.type === 'response.failed') this.errorType = 'failed';
  }
}

/* ------------------------------------------------------------------ cost of a call whose response carries tokens only */

/** The model's price row for this provider: --price overrides first, then the built-in list (exact name, alias, or without a date suffix). */
function resolvePrice(provider, model, overrides) {
  if (overrides.has(model)) return overrides.get(model);
  if (!provider.prices) return null;
  const tries = [model, provider.aliases[model], model.replace(/-\d{4}-\d{2}-\d{2}$/, ''), model.replace(/-\d{8}$/, '')];
  for (const t of tries) {
    if (t && overrides.has(t)) return overrides.get(t);
    if (t && provider.prices.has(t)) return provider.prices.get(t);
    const a = t && provider.aliases[t];
    if (a && provider.prices.has(a)) return provider.prices.get(a);
  }
  return null;
}

/**
 * Micro-USD for one call at list prices, or null when this provider/model has no price (the caller must not invent one).
 * `ts` picks DeepSeek's peak rate; --price overrides are used exactly as given.
 */
export function listPriceMicro(provider, model, { input, output, cached }, ts, overrides = new Map()) {
  const base = resolvePrice(provider, model, overrides);
  if (!base) return null;
  const peak = provider.peak && !overrides.has(model) && provider.peak(ts) ? 2 : 1;
  return computeCostMicro({ input_tokens: input, output_tokens: output, cached_tokens: cached }, {
    input_per_mtok: base.input_per_mtok * peak, cached_per_mtok: base.cached_per_mtok * peak, output_per_mtok: base.output_per_mtok * peak,
  });
}

/* ------------------------------------------------------------------ which key made the call */

/** The API key a request carries, from the header each provider uses. Only ever hashed by keyLabel: never stored, logged or forwarded anywhere but upstream. */
export function apiKeyOf(headers) {
  const auth = headers.authorization;
  if (typeof auth === 'string') { const m = /^Bearer\s+(\S+)/i.exec(auth); if (m) return m[1]; }
  for (const h of ['x-api-key', 'api-key']) if (typeof headers[h] === 'string' && headers[h]) return headers[h];
  return '';
}

/**
 * A short, stable, one-way label for an API key ("key-3fa91c07d2"): the first 40 bits of its SHA-256. It tells keys apart in the dashboard without
 * being the key (an API key has far more than 40 bits of entropy to hide behind, and the label cannot be reversed to it).
 */
export function keyLabel(key) {
  return `key-${createHash('sha256').update(`finops-key-label-v1:${key}`).digest('hex').slice(0, 10)}`;
}
