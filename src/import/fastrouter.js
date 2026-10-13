import { createHash } from 'node:crypto';

/*
 * FastRouter's PAST requests -> dashboard requests.
 *
 * FastRouter documents no way to LIST past usage (https://docs.fastrouter.ai/llms.txt): the dashboard's Activity Log is a web page, the Kafka
 * "Observability Destinations" only forward NEW requests, and the one API that reads the past is
 *
 *     POST https://api.fastrouter.ai/api/v1/generation   { "generation_id": "<id>" }     Authorization: Bearer <your FastRouter key>
 *
 * which returns ONE request by its id (model, provider, tokens, `usage.cost` in USD, a hashed key, timing, and the request/response PAYLOADS).
 * So there are two honest ways in, and this file serves both:
 *
 *   --ids      ids you already have (the `usage.chat_id` of your responses, from your own logs): each is looked up with the call above.
 *   --file     an Activity Log export (CSV / JSON / JSON lines), if your dashboard or FastRouter support can give you one: columns are
 *              matched by name (or by --map), and the import says which it used and refuses to guess when it cannot tell.
 *
 * Prompts and completions are NEVER kept: only the numeric fields below are read from a record, and the rest (the payloads included) is dropped
 * the moment it is parsed. The cost is FastRouter's own figure (a supplied cost, see ingest.js), so no price table is involved.
 */

const VERSION_PATH = '/api/v1/generation';
export const RE_GEN_ID = /^[A-Za-z0-9._:-]{1,90}$/; // 'fr:' + this must fit the 100 characters of a request id

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_TS = Date.UTC(2020, 0, 1), MAX_TS = Date.UTC(2100, 0, 1);
const int = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : 0);
const num = (n) => { const v = typeof n === 'string' && n.trim() !== '' ? Number(n.replace(/[$,\s]/g, '')) : n; return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null; };
const alnum = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '');

export class FastRouterError extends Error {
  constructor(message, status) { super(message); this.name = 'FastRouterError'; this.status = status; }
}

/* ------------------------------------------------------------------ ids */

/** Ids from a text file: one per line (or several separated by commas), `#` comments, or a JSON array. A line with spaces in it is one unusable id, never several. Returns { ids (unique, valid), invalid (samples), invalidCount, duplicates }. */
export function parseIds(text) {
  const raw = [];
  const t = String(text).trim();
  if (t.startsWith('[')) { try { const a = JSON.parse(t); if (Array.isArray(a)) for (const x of a) raw.push(String(x)); } catch { /* not JSON after all: read it as lines */ } }
  if (!raw.length) for (const line of t.split(/\r?\n/)) { const s = line.replace(/#.*$/, '').trim(); if (s) raw.push(...s.split(',').map((x) => x.trim()).filter(Boolean)); }
  const seen = new Set(), ids = [], invalid = [];
  let invalidCount = 0, duplicates = 0;
  for (const id of raw) {
    if (!RE_GEN_ID.test(id)) { invalidCount++; if (invalid.length < 3) invalid.push(id.slice(0, 40)); continue; }
    if (seen.has(id)) { duplicates++; continue; }
    seen.add(id); ids.push(id);
  }
  return { ids, invalid, invalidCount, duplicates };
}

/* ------------------------------------------------------------------ the generation API */

/** A small client: the key goes in a header to --base-url only (https, or this machine), never into a URL, a log or an error message. */
export class GenerationClient {
  constructor({ baseUrl = 'https://api.fastrouter.ai', apiKey, fetchImpl = globalThis.fetch, userAgent = 'finops-dashboard', retryMs = 1000 }) {
    const u = new URL(baseUrl);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) throw new Error('--base-url must be https (plain http is only accepted for localhost): the API key is sent to it');
    if (u.username || u.password) throw new Error('--base-url must not contain credentials');
    if (!apiKey) throw new Error('a FastRouter API key is required (FASTROUTER_API_KEY)');
    this.url = new URL(VERSION_PATH, u.origin); this.key = apiKey; this.fetch = fetchImpl; this.ua = userAgent; this.retryMs = retryMs;
    this.requests = 0;
  }

  /** { status: 'ok', body } | { status: 'not_found' | 'bad_id' | 'failed', error? }. Throws FastRouterError when the key is refused (nothing else would work either). */
  async lookup(id) {
    let last = 'could not be read';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(last.retryAfterMs ?? this.retryMs * 2 ** (attempt - 1));
      let res;
      try {
        this.requests++;
        res = await this.fetch(this.url, { method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': this.ua }, body: JSON.stringify({ generation_id: id }), signal: AbortSignal.timeout(30_000), redirect: 'manual' });
      } catch (e) { last = { error: `could not reach ${this.url.origin} (${e?.cause?.code || e?.name || 'network error'})` }; continue; }
      if (res.status === 200) {
        if (Number(res.headers.get('content-length')) > 20_000_000) return { status: 'failed', error: 'the record is larger than 20 MB' };
        try { return { status: 'ok', body: await res.json() }; } catch { return { status: 'failed', error: 'the answer was not JSON' }; }
      }
      await res.body?.cancel().catch(() => {}); // the body is never read on an error: it could echo what was sent
      if (res.status === 401 || res.status === 403) throw new FastRouterError(`FastRouter refused the key (HTTP ${res.status}): FASTROUTER_API_KEY must be a FastRouter API key (the one your app sends), not a provisioning key`, res.status);
      if (res.status === 404) return { status: 'not_found' };
      if (res.status === 400) return { status: 'bad_id' };
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after'));
        last = { error: `FastRouter answered HTTP ${res.status}`, retryAfterMs: wait > 0 ? Math.min(30_000, wait * 1000) : undefined };
        continue;
      }
      return { status: 'failed', error: `FastRouter answered HTTP ${res.status}` };
    }
    return { status: 'failed', error: last.error ?? 'failed' };
  }
}

/* ------------------------------------------------------------------ a record -> an ingest request */

/** Epoch ms from epoch seconds, epoch ms, or an ISO / RFC 2822 date string; null when it is not a plausible time. */
export function toMs(v) {
  let ms = null;
  if (typeof v === 'number' && Number.isFinite(v)) ms = v < 1e11 ? v * 1000 : v;
  else if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    ms = Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : Date.parse(v);
  }
  return ms !== null && Number.isFinite(ms) && ms >= MIN_TS && ms < MAX_TS ? Math.round(ms) : null;
}

const safeTenant = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'fastrouter';
const safeModel = (s) => String(s ?? '').replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 64) || 'unknown';
const safeEndpoint = (e) => `/fastrouter${(typeof e === 'string' && e.startsWith('/') ? e : '/api/v1/chat/completions').replace(/[^A-Za-z0-9._~/:{}-]/g, '_').slice(0, 100)}`;

/** FastRouter's own hash of the key (an id it returns "for auditing"), as a short tenant label. Not our key label: different hash, different prefix. */
const hashLabel = (hash) => `fr-key-${alnum(hash).slice(0, 10) || 'unknown'}`;

/**
 * One /generation answer -> { request, byok } or { skip: 'unreadable' | 'no_cost' | 'no_time' }.
 * Only these fields are read: usage.cost (USD), usage.prompt_tokens / completion_tokens (or input_token_size / output_token_size),
 * timing.started_at / query_time / created_at, timing.duration_ms, model, provider_name, endpoint, api_key (a hash), is_byok.
 * `request`, `response` and `metadata` (the payloads) are never touched.
 */
export function requestFromGeneration(id, g, { tenantBy = 'key', keyMap = {} } = {}) {
  if (!g || typeof g !== 'object') return { skip: 'unreadable' };
  const u = g.usage && typeof g.usage === 'object' ? g.usage : {};
  const usd = num(u.cost);
  if (usd === null) return { skip: 'no_cost' };
  const ts = toMs(g.timing?.started_at) ?? toMs(g.query_time) ?? toMs(g.created_at);
  if (ts === null) return { skip: 'no_time' };
  let tenant = 'fastrouter';
  if (tenantBy === 'key' && g.api_key) { const l = hashLabel(g.api_key); tenant = keyMap[l] ?? l; }
  else if (tenantBy === 'provider' && g.provider_name) tenant = safeTenant(g.provider_name);
  const duration = Math.min(3_600_000, int(g.timing?.duration_ms));
  return {
    byok: g.is_byok === true,
    request: {
      id: `fr:${id}`, ts, tenant_id: tenant, endpoint: safeEndpoint(g.endpoint), method: 'POST', status: 200, duration_ms: duration, infra_cost_micro_usd: 0,
      llm_calls: [{ model: safeModel(g.model), input_tokens: int(u.prompt_tokens ?? g.input_token_size), output_tokens: int(u.completion_tokens ?? g.output_token_size), cached_tokens: 0, latency_ms: duration, cost_micro_usd: Math.round(usd * 1e6) }],
    },
  };
}

/* ------------------------------------------------------------------ an export file */

/** RFC 4180: quoted fields may hold commas, quotes ("") and line breaks (prompts do); a BOM and CRLF are fine. Rows of fields. */
export function parseCsv(text) {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"' && f === '') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); f = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/** A list of plain objects from CSV (first line = header), a JSON array, an object holding one (data / items / results / logs / requests / records), or JSON lines. */
export function parseExport(text, name = '') {
  const t = text.replace(/^﻿/, '').trim();
  if (!t) throw new Error('the file is empty');
  if (t[0] === '[' || t[0] === '{') {
    let j;
    try { j = JSON.parse(t); } catch {
      const rows = t.split(/\r?\n/).filter((l) => l.trim()).map((l, i) => { try { return JSON.parse(l); } catch { throw new Error(`line ${i + 1} is not JSON (the file is neither a JSON document nor JSON lines)`); } });
      return rows.filter((r) => r && typeof r === 'object');
    }
    if (Array.isArray(j)) return j.filter((r) => r && typeof r === 'object');
    for (const k of ['data', 'items', 'results', 'logs', 'requests', 'records', 'rows']) if (Array.isArray(j[k])) return j[k].filter((r) => r && typeof r === 'object');
    throw new Error('this JSON is an object with no list of requests in it (expected an array, or one of data / items / results / logs / requests / records)');
  }
  if (/\.jsonl?$/i.test(name)) throw new Error('the file does not hold JSON');
  const rows = parseCsv(t);
  if (rows.length < 2) throw new Error('the CSV has no data rows');
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/** Dotted keys of a nested record down to 3 levels ("usage.cost"), values left as they are. */
function flatten(o, prefix = '', depth = 0, out = {}) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) flatten(v, key, depth + 1, out); else out[key] = v;
  }
  return out;
}

export const FIELDS = {
  id: ['id', 'generationid', 'chatid', 'usagechatid', 'requestid', 'uuid'],
  ts: ['timingstartedat', 'startedat', 'querytime', 'createdat', 'timestamp', 'time', 'datetime', 'date', 'requesttime', 'createdtime'], // when the request STARTED comes first
  model: ['model', 'modelname', 'modelid'],
  input: ['prompttokens', 'usageprompttokens', 'inputtokens', 'inputtokensize', 'tokensin'],
  output: ['completiontokens', 'usagecompletiontokens', 'outputtokens', 'outputtokensize', 'tokensout'],
  cached: ['cachedtokens', 'cachedinputtokens', 'promptcachedtokens', 'cachereadtokens'],
  cost: ['usagecost', 'cost', 'costusd', 'totalcost', 'totalcostusd'], // never `credits_used`: its unit is not documented
  tenant: ['apikey', 'apikeyname', 'keyname', 'keyid', 'key', 'project', 'projectname'],
  endpoint: ['endpoint', 'path', 'route'],
  status: ['statuscode', 'status', 'httpstatus'],
  latency: ['timingdurationms', 'durationms', 'latencyms', 'responsetimems', 'latency'],
};
export const REQUIRED = ['ts', 'model', 'input', 'output', 'cost'];

/** { field: column } by name, from `columns`; `explicit` (field -> column) wins. Returns { map, missing (required fields with no column), ambiguous }. */
export function detectMapping(columns, explicit = {}) {
  const norm = new Map();
  for (const c of columns) { const n = alnum(c).toLowerCase(); if (!norm.has(n)) norm.set(n, c); }
  const map = {}, ambiguous = [];
  for (const [field, candidates] of Object.entries(FIELDS)) {
    if (explicit[field]) {
      if (!columns.includes(explicit[field])) throw new Error(`--map ${field}=${explicit[field]}: no such column (columns: ${columns.slice(0, 40).join(', ')})`);
      map[field] = explicit[field]; continue;
    }
    const hits = candidates.filter((c) => norm.has(c));
    if (hits.length) { map[field] = norm.get(hits[0]); if (hits.length > 1) ambiguous.push(`${field}: ${hits.map((h) => norm.get(h)).join(' / ')} (using ${norm.get(hits[0])})`); }
  }
  return { map, missing: REQUIRED.filter((f) => !map[f]), ambiguous };
}

export function columnsOf(rows) {
  const cols = new Set();
  for (const r of rows.slice(0, 200)) for (const k of Object.keys(flatten(r))) cols.add(k);
  return [...cols];
}

/**
 * One exported row -> { request } or { skip }. The row is flattened first so a nested JSON record and a flat CSV row are read the same way.
 * `costScale` converts the cost column to USD (0.01 if it is in cents). The tenant column is HASHED by default (an export can hold key values):
 * pass tenantRaw to use its values as names, for a column that holds key NAMES.
 */
export function requestFromRow(row, map, { costScale = 1, tenantRaw = false, keyMap = {}, seen = new Map() } = {}) {
  const f = flatten(row);
  const get = (field) => (map[field] ? f[map[field]] : undefined);
  const usd = num(get('cost'));
  if (usd === null) return { skip: 'no_cost' };
  const ts = toMs(get('ts'));
  if (ts === null) return { skip: 'no_time' };
  const input = int(String(get('input') ?? '').replace(/,/g, '')), output = int(String(get('output') ?? '').replace(/,/g, ''));
  const model = safeModel(get('model'));
  let tenant = 'fastrouter';
  const rawTenant = get('tenant');
  if (rawTenant !== undefined && rawTenant !== null && String(rawTenant).trim() !== '') {
    if (tenantRaw) tenant = keyMap[safeTenant(rawTenant)] ?? safeTenant(rawTenant);
    else { const l = `fr-key-${createHash('sha256').update(`finops-fastrouter-export:${String(rawTenant).trim()}`).digest('hex').slice(0, 10)}`; tenant = keyMap[l] ?? l; }
  }
  const status = Number(get('status'));
  const duration = Math.min(3_600_000, int(get('latency')));
  const micro = Math.round(usd * costScale * 1e6);
  const rawId = get('id');
  let id = rawId !== undefined && rawId !== null && String(rawId).trim() !== '' ? `fr:${String(rawId).trim().replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 90)}` : null;
  if (!id) { // no id column: a stable id from what the row says, plus a counter for rows that are identical in every field
    const h = createHash('sha1').update(JSON.stringify([ts, model, input, output, micro, tenant, get('endpoint') ?? ''])).digest('hex').slice(0, 24);
    const n = (seen.get(h) ?? 0) + 1; seen.set(h, n);
    id = `fr:row-${h}-${n}`;
  }
  return {
    request: {
      id, ts, tenant_id: tenant, endpoint: safeEndpoint(get('endpoint')), method: 'POST', status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : 200,
      duration_ms: duration, infra_cost_micro_usd: 0,
      llm_calls: [{ model, input_tokens: input, output_tokens: output, cached_tokens: Math.min(input, int(String(get('cached') ?? '').replace(/,/g, ''))), latency_ms: duration, cost_micro_usd: micro }],
    },
  };
}
