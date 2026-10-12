import { createHash } from 'node:crypto';
import { DAY, HOUR } from './common.js';
import { normalizeModel } from './prices.js';

/*
 * Anthropic's Usage & Cost Admin API -> dashboard requests.
 *
 *   GET /v1/organizations/usage_report/messages   token counts per time bucket, grouped (model, tier, context window, workspace / API key / ...)
 *   GET /v1/organizations/cost_report             what Anthropic billed, per day (amount in CENTS as a decimal string)
 *
 * (https://platform.claude.com/docs/en/manage-claude/usage-cost-api; needs an organization Admin API key: the endpoints do not exist for
 * individual accounts, and workspace API keys do not work.)
 *
 * What this data is NOT: a request log. The usage report has token counts per hour and group, no request counts and no latency. Each row we
 * write is therefore "one hour x one group", not one API call: tiles, cost per request, tokens per request and the volume/retry detectors are
 * meaningless on it (the import says so in its banner and skips detection). What it IS: the organization's real token usage by workspace and
 * model, which is exactly what spend attribution needs, and it can be checked against the bill (crossCheck).
 */

const VERSION = '2023-06-01';
export const BUCKETS = { '1h': { ms: HOUR, limit: 168 }, '1d': { ms: DAY, limit: 31 } };
export const TENANT_DIMENSIONS = { workspace: 'workspace_id', 'api-key': 'api_key_id', account: 'account_id', 'service-account': 'service_account_id' };
const NONE = { workspace: 'default-workspace', 'api-key': 'console-or-unknown-key', account: 'no-account', 'service-account': 'no-service-account' };

export class AdminApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tiny client: Admin key in a header (never in a URL, never logged), retries for 429/5xx, errors that say what to do. */
export class AdminClient {
  constructor({ baseUrl = 'https://api.anthropic.com', adminKey, fetchImpl = globalThis.fetch, userAgent = 'finops-dashboard', retryMs = 1000, pauseMs = 200 }) {
    const u = new URL(baseUrl);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) throw new Error('--base-url must be https (plain http is only accepted for localhost): the Admin key is sent to it');
    if (u.username || u.password) throw new Error('--base-url must not contain credentials');
    if (!adminKey) throw new Error('an Admin API key is required (ANTHROPIC_ADMIN_KEY)');
    this.origin = u.origin; this.key = adminKey; this.fetch = fetchImpl; this.ua = userAgent; this.retryMs = retryMs; this.pauseMs = pauseMs;
    this.requests = 0;
  }

  async get(path, params) {
    const url = new URL(path, this.origin);
    for (const [k, v] of params) url.searchParams.append(k, v);
    let last;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(last?.retryAfterMs ?? this.retryMs * 2 ** (attempt - 1));
      let res;
      try {
        this.requests++;
        res = await this.fetch(url, { headers: { 'x-api-key': this.key, 'anthropic-version': VERSION, 'User-Agent': this.ua }, signal: AbortSignal.timeout(30_000), redirect: 'manual' });
      } catch (e) { last = { error: new AdminApiError(`could not reach ${this.origin} (${e?.cause?.code || e?.name || 'network error'})`) }; continue; }
      if (res.status === 200) return res.json();
      const body = await res.json().catch(() => ({}));
      const detail = body?.error?.message ? `: ${String(body.error.message).slice(0, 200)}` : '';
      if (res.status === 401 || res.status === 403) throw new AdminApiError(`the Admin API refused the key (HTTP ${res.status})${detail}. These endpoints need an organization Admin API key (sk-ant-admin01-...) or another Admin credential; workspace API keys and individual accounts do not work.`, res.status);
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after'));
        last = { error: new AdminApiError(`the Admin API answered HTTP ${res.status}${detail}`, res.status), retryAfterMs: wait > 0 ? Math.min(30_000, wait * 1000) : undefined };
        continue;
      }
      throw new AdminApiError(`the Admin API answered HTTP ${res.status}${detail}`, res.status);
    }
    throw last.error;
  }

  /** Follow has_more / next_page; yields buckets, oldest first. */
  async *pages(path, baseParams, { onPage } = {}) {
    let page = null, n = 0;
    do {
      const params = page ? [...baseParams, ['page', page]] : baseParams;
      const j = await this.get(path, params);
      n++;
      onPage?.(n, j.data?.length ?? 0);
      for (const b of j.data ?? []) yield b;
      page = j.has_more ? j.next_page : null;
      if (page) await sleep(this.pauseMs);
    } while (page);
  }
}

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** The query for the usage report. Group by model + tier + context window + the tenant dimension (what pricing and attribution depend on). */
export function usageParams({ fromMs, toMs, bucket, tenantBy }) {
  const p = [['starting_at', iso(fromMs)], ['ending_at', iso(toMs)], ['bucket_width', bucket], ['limit', String(BUCKETS[bucket].limit)]];
  for (const g of ['model', 'service_tier', 'context_window', TENANT_DIMENSIONS[tenantBy]]) p.push(['group_by[]', g]);
  return p;
}

export function costParams({ fromMs, toMs }) {
  return [['starting_at', iso(fromMs)], ['ending_at', iso(toMs)], ['bucket_width', '1d'], ['limit', '31'], ['group_by[]', 'description'], ['group_by[]', 'workspace_id']];
}

const int = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0);
const safeTenant = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';

/**
 * Buckets -> ingest requests. One request per (bucket, group) with tokens; groups without any are skipped.
 * input_tokens is the whole prompt (uncached + cache read + cache writes), as everywhere in the dashboard.
 */
export function buildRequests(buckets, { tenantBy = 'workspace', priceBook, sinceTs = 0 }) {
  const dim = TENANT_DIMENSIONS[tenantBy];
  const groups = new Map(); // rows that normalise to the same group (a model and its dated alias) are ONE group: summed, never two rows with one id
  const unpriced = new Map();
  const nonStandard = new Map(); // "tier / context" -> total tokens priced at standard rates
  let webSearches = 0, emptyBuckets = 0, rows = 0;
  for (const b of buckets) {
    const ts = Date.parse(b.starting_at);
    if (!Number.isFinite(ts) || ts < sinceTs) continue;
    if (!b.results?.length) { emptyBuckets++; continue; }
    for (const r of b.results) {
      const read = int(r.cache_read_input_tokens), w5 = int(r.cache_creation?.ephemeral_5m_input_tokens), w1 = int(r.cache_creation?.ephemeral_1h_input_tokens);
      const input = int(r.uncached_input_tokens) + read + w5 + w1, output = int(r.output_tokens);
      webSearches += int(r.server_tool_use?.web_search_requests);
      if (input + output === 0) continue;
      rows++;
      const model = normalizeModel(String(r.model ?? 'unknown'));
      if (!priceBook.priceAt(model, ts)) { unpriced.set(model, (unpriced.get(model) ?? 0) + input + output); continue; }
      const tier = String(r.service_tier ?? 'standard'), ctx = String(r.context_window ?? '0-200k');
      if (tier !== 'standard' || ctx !== '0-200k') nonStandard.set(`${tier} / ${ctx}`, (nonStandard.get(`${tier} / ${ctx}`) ?? 0) + input + output);
      const tenant = r[dim] == null ? NONE[tenantBy] : safeTenant(r[dim]);
      const key = JSON.stringify([ts, tenant, model, tier, ctx]);
      const g = groups.get(key);
      if (g) { const c = g.llm_calls[0]; c.input_tokens += input; c.output_tokens += output; c.cached_tokens += read; c.cache_write_tokens += w5; c.cache_write_1h_tokens += w1; continue; }
      groups.set(key, {
        id: `u:${ts.toString(36)}:${createHash('sha1').update(key).digest('hex').slice(0, 20)}`, ts, tenant_id: tenant,
        endpoint: `/usage/${tier}/${ctx}`.replace(/[^A-Za-z0-9._~/:{}-]/g, '_'), method: 'POST', status: 200, duration_ms: 0, infra_cost_micro_usd: 0,
        llm_calls: [{ model, input_tokens: input, output_tokens: output, cached_tokens: read, cache_write_tokens: w5, cache_write_1h_tokens: w1, latency_ms: 0 }],
      });
    }
  }
  return { requests: [...groups.values()], unpriced, nonStandard, webSearches, emptyBuckets, rows };
}

/**
 * Compare what we computed (token counts x the price list) with what Anthropic billed (cost report, cost_type "tokens"), for COMPLETE days only,
 * per (model, service tier). amount is in cents. Returns rows { model, tier, computedUsd, billedUsd, ratio, days }.
 */
export function crossCheck(db, costBuckets, { fromMs, toMs }) {
  const billed = new Map();
  for (const b of costBuckets) {
    const d = b.starting_at.slice(0, 10);
    for (const r of b.results ?? []) {
      if (r.cost_type !== 'tokens' || !r.model) continue;
      const tier = r.service_tier ?? 'standard';
      const k = `${normalizeModel(r.model)}\u0000${tier}`; // the same names we stored
      const v = billed.get(k) ?? { usd: 0, days: new Set() };
      v.usd += Number(r.amount) / 100; v.days.add(d);
      billed.set(k, v);
    }
  }
  // ours, from the imported rows (endpoint /usage/<tier>/<ctx>), for the same complete days
  const ours = new Map();
  const rows = db.prepare(`SELECT c.model, r.endpoint, c.cost_micro_usd AS cost, c.ts FROM llm_calls c JOIN requests r ON r.id = c.request_id WHERE c.ts >= ? AND c.ts < ?`).all(fromMs, toMs);
  for (const r of rows) {
    const tier = r.endpoint.split('/')[2] ?? 'standard';
    const k = `${r.model}\u0000${tier}`;
    ours.set(k, (ours.get(k) ?? 0) + r.cost / 1e6);
  }
  const out = [];
  for (const [k, o] of ours) {
    const [model, tier] = k.split('\u0000');
    const b = billed.get(k);
    out.push({ model, tier, computedUsd: o, billedUsd: b?.usd ?? null, ratio: b && b.usd > 0 ? o / b.usd : null, days: b?.days.size ?? 0 });
  }
  return out.sort((a, b) => b.computedUsd - a.computedUsd);
}

