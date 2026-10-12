import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DAY } from '../util.js';

/*
 * Public LLM traffic traces -> dashboard requests.
 *
 *   BurstGPT (HPMLL/BurstGPT, CC BY 4.0): Timestamp (seconds from day 0), Model (ChatGPT | GPT-4), Request tokens,
 *     Response tokens, Total tokens, Log Type (Conversation log | API log) [+ Session ID, Elapsed time in newer files].
 *     Real Azure OpenAI traffic; a Response tokens value of 0 marks a failed request.
 *   Azure LLM inference traces (Azure/AzurePublicDataset, CC BY 4.0): TIMESTAMP, ContextTokens, GeneratedTokens,
 *     one file per service (code / conversation), 2023 (one hour) and 2024 (one week).
 *
 * What is REAL: request timing (bursts, daily / weekly rhythm), token counts, which API surface, failures.
 * What is NOT in the data and is therefore a stated assumption: who the customer is (tenants are synthetic buckets
 * with a skewed share), prices (a price table, see prices.js), infrastructure cost (0), cached tokens (0).
 * Real timestamps are shifted by whole days so the trace ends near today (hour-of-day and weekday phase are kept).
 */

/** Split one CSV line (these datasets never quote, but a quoted field must not break the parse). */
export function splitCsv(line) {
  if (!line.includes('"')) return line.split(',');
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const norm = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function detectFormat(headerLine) {
  const cols = splitCsv(headerLine).map(norm);
  if (cols.includes('request tokens') && cols.includes('response tokens')) return 'burstgpt';
  if (cols.includes('contexttokens') && cols.includes('generatedtokens')) return 'azure';
  throw new Error(`cannot recognise this CSV (header: ${headerLine.slice(0, 120)}). Supported: BurstGPT and Azure LLM inference traces`);
}

/** "2023-11-16 18:15:46.6805900" and "2024-05-10 00:00:00.009930+00:00" -> epoch ms (no zone means UTC). */
export function parseTimestamp(str) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d+))?\s*(?:Z|([+-])(\d\d):?(\d\d))?$/.exec(str.trim());
  if (!m) return NaN;
  const ms = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + Math.floor(ms);
  if (m[8]) t -= (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) * 60_000;
  return t;
}

/**
 * Stream a trace as normalized records: { n, t, tIsRelative, input, output, kind, model?, session?, elapsedMs? }.
 * `t` is epoch ms for Azure, and ms from the first day's midnight for BurstGPT (whose timestamps are relative).
 */
export async function* readTrace(path, format) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let cols = null, n = 0, fmt = format;
  for await (const line of rl) {
    if (!line.trim()) continue;
    if (!cols) {
      fmt = !fmt || fmt === 'auto' ? detectFormat(line) : fmt;
      const h = splitCsv(line).map(norm);
      const at = (...names) => { for (const nm of names) { const i = h.indexOf(nm); if (i >= 0) return i; } return -1; };
      cols = fmt === 'burstgpt'
        ? { t: at('timestamp'), model: at('model'), input: at('request tokens'), output: at('response tokens'), kind: at('log type'), session: at('session id'), elapsed: at('elapsed time') }
        : { t: at('timestamp'), input: at('contexttokens'), output: at('generatedtokens') };
      for (const [k, i] of Object.entries(cols)) if (i < 0 && !['kind', 'model', 'session', 'elapsed'].includes(k)) throw new Error(`column for "${k}" not found in header: ${line.slice(0, 120)}`);
      continue;
    }
    const f = splitCsv(line);
    const input = Number(f[cols.input]), output = Number(f[cols.output]);
    if (!Number.isInteger(input) || !Number.isInteger(output) || input < 0 || output < 0) continue; // skip malformed rows
    let t;
    if (fmt === 'burstgpt') t = Number(f[cols.t]) * 1000;
    else t = parseTimestamp(f[cols.t] ?? '');
    if (!Number.isFinite(t)) continue;
    const rec = { n: n++, t, tIsRelative: fmt === 'burstgpt', input, output, kind: cols.kind >= 0 ? f[cols.kind] : undefined, model: cols.model >= 0 ? f[cols.model] : undefined };
    if (cols.session >= 0 && f[cols.session]) rec.session = f[cols.session];
    if (cols.elapsed >= 0 && f[cols.elapsed] !== undefined && f[cols.elapsed] !== '' && Number.isFinite(Number(f[cols.elapsed]))) rec.elapsedMs = Math.round(Number(f[cols.elapsed]) * 1000);
    yield rec;
  }
  return fmt;
}

/** First pass: how many rows, and the time span (needed to shift the trace in time). */
export async function scanBounds(path, format) {
  let count = 0, min = Infinity, max = -Infinity, fmt = format;
  let rel = false;
  const it = readTrace(path, format);
  for (;;) {
    const { value, done } = await it.next();
    if (done) { fmt = value ?? fmt; break; }
    count++; rel = value.tIsRelative;
    if (value.t < min) min = value.t;
    if (value.t > max) max = value.t;
  }
  return { count, min, max, relative: rel, format: fmt };
}

/** Deterministic uniform [0,1) from an integer and a salt (so tenant, sampling, ... are independent and reproducible). */
export function unit(n, salt) {
  let x = (Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Tenant picker: N synthetic tenants whose traffic shares follow 1/k^skew (k = 1..N). */
export function makeTenantPicker({ count = 8, skew = 1, seed = 42 } = {}) {
  const names = Array.from({ length: count }, (_, i) => `tenant-${String(i + 1).padStart(2, '0')}`);
  const w = names.map((_, i) => 1 / (i + 1) ** skew);
  const total = w.reduce((a, b) => a + b, 0);
  const cum = [];
  w.reduce((acc, x, i) => (cum[i] = acc + x / total), 0);
  return { names, shares: w.map((x) => x / total), pick: (key) => { const u = unit(typeof key === 'string' ? hashString(key) : key, seed); const i = cum.findIndex((c) => u < c); return names[i < 0 ? count - 1 : i]; } };
}

const slug = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
export const DEFAULT_MODEL_MAP = { chatgpt: 'gpt-3.5-turbo', 'gpt-4': 'gpt-4' };

/**
 * Where does time 0 of the trace go? Returns a function t -> absolute epoch ms.
 *   end = 'now' | <ISO date-time> | 'keep'. Whole-day shifts only, so hour-of-day (and weekday) phase survive.
 */
export function makeTimeMap({ bounds, end = 'now', startDate, now = Date.now() }) {
  if (bounds.relative) {
    // BurstGPT: seconds from day-0 midnight. Pick the day-0 midnight so that the last record is at or before `end`.
    if (end === 'keep') {
      const s = Date.parse(`${startDate}T00:00:00Z`);
      if (!Number.isFinite(s)) throw new Error('--end keep needs --start-date YYYY-MM-DD for BurstGPT (its timestamps are relative)');
      return (t) => s + t;
    }
    const ref = end === 'now' ? now : Date.parse(end);
    if (!Number.isFinite(ref)) throw new Error(`bad --end "${end}" (now | keep | an ISO date-time)`);
    const base = Math.floor((ref - bounds.max) / DAY) * DAY;
    return (t) => base + t;
  }
  if (end === 'keep') return (t) => t;
  const ref = end === 'now' ? now : Date.parse(end);
  if (!Number.isFinite(ref)) throw new Error(`bad --end "${end}" (now | keep | an ISO date-time)`);
  const shift = Math.floor((ref - bounds.max) / DAY) * DAY;
  return (t) => t + shift;
}

/**
 * Turn a trace into requests. Generator: yields dashboard requests in file order.
 * opts: { format, service, model, modelMap, tenants, skew, seed, sample, keepFromTs (absolute, after time map), timeMap }
 */
export async function* traceRequests(path, opts) {
  const { format, service = 'trace', model = 'claude-sonnet-5-5', modelMap = DEFAULT_MODEL_MAP, tenants, sample = 1, keepFromTs = -Infinity, timeMap, seed = 42, stats } = opts;
  const prefix = format === 'burstgpt' ? 'bg' : `az-${slug(service)}`;
  const tp = makeTenantPicker({ count: tenants ?? 8, skew: opts.skew ?? 1, seed });
  const maxTs = 253_402_300_799_000;
  for await (const r of readTrace(path, format)) {
    if (stats) stats.rows++;
    const ts = Math.round(timeMap(r.t));
    if (ts < keepFromTs || ts < Date.UTC(2020, 0, 1) || ts > maxTs) { if (stats) stats.outOfWindow++; continue; }
    if (sample < 1 && unit(r.n, seed ^ 0x51ed) >= sample) { if (stats) stats.sampledOut++; continue; }
    const tenant = tp.pick(r.session ?? r.n);
    let endpoint, llmModel, failed = false;
    if (format === 'burstgpt') {
      const kind = norm(r.kind ?? '');
      endpoint = kind.startsWith('conversation') ? '/conversation' : kind.startsWith('api') ? '/api' : `/${slug(r.kind) || 'other'}`;
      const raw = (r.model ?? '').trim().toLowerCase();
      llmModel = modelMap[raw] ?? modelMap[norm(raw)] ?? (slug(raw) || 'unknown-model');
      failed = r.output === 0; // BurstGPT marks failed requests with 0 response tokens
    } else {
      endpoint = service === 'code' ? '/code' : service === 'conv' || service === 'conversation' ? '/conversation' : `/${slug(service) || 'trace'}`;
      llmModel = model;
    }
    const ms = r.elapsedMs === undefined ? 0 : Math.min(3_600_000, Math.max(0, r.elapsedMs));
    if (stats) { stats.kept++; if (failed) stats.failed++; }
    yield {
      id: `${prefix}-${r.n}`, ts, tenant_id: tenant, endpoint, method: 'POST', status: failed ? 500 : 200, duration_ms: ms, infra_cost_micro_usd: 0,
      llm_calls: failed ? [] : [{ model: llmModel, input_tokens: r.input, output_tokens: r.output, cached_tokens: 0, latency_ms: ms }],
    };
  }
}

/** "code" / "conv" from a file name such as AzureLLMInferenceTrace_conv_1week.csv. */
export function guessService(path) {
  const b = path.toLowerCase();
  return /code/.test(b) ? 'code' : /conv/.test(b) ? 'conv' : 'trace';
}
