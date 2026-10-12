import { transaction } from './db.js';
import { hourOf, isInt } from './util.js';

export class ValidationError extends Error {
  constructor(errors) {
    super(`invalid batch: ${errors[0]}`);
    this.name = 'ValidationError';
    this.errors = errors;
    this.status = 400;
  }
}

const RE_ID = /^[A-Za-z0-9._:#-]{1,100}$/;
export const RE_TENANT = /^[A-Za-z0-9._-]{1,64}$/;
export const RE_ENDPOINT = /^\/[A-Za-z0-9._~/:{}-]{0,119}$/;
export const RE_MODEL = /^[A-Za-z0-9._:-]{1,64}$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const TS_MIN = Date.UTC(2020, 0, 1);
const TS_MAX = Date.UTC(2100, 0, 1);
const MAX_TOKENS = 10_000_000;
const MAX_ERRORS = 20;

const REQ_KEYS = new Set(['id', 'ts', 'tenant_id', 'endpoint', 'method', 'status', 'duration_ms', 'infra_cost_micro_usd', 'llm_calls']);
const CALL_KEYS = new Set(['id', 'ts', 'model', 'input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'cache_write_1h_tokens', 'latency_ms']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate and normalise a batch body ({ requests: [...] }) and compute LLM cost from model_prices.
 * All-or-nothing: any problem rejects the whole batch (so a retry can never half-apply).
 * Returns normalised requests, each with `llm_calls[]` carrying cost_micro_usd.
 */
export function validateBatch(body, { priceBook, maxBatch = 1000, maxCallsPerRequest = 20 }) {
  const errors = [];
  const err = (msg) => { if (errors.length < MAX_ERRORS) errors.push(msg); };

  if (!isPlainObject(body)) throw new ValidationError(['body must be a JSON object { "requests": [...] }']);
  for (const k of Object.keys(body)) if (k !== 'requests') err(`unknown top-level field "${k}"`);
  if (!Array.isArray(body.requests)) throw new ValidationError(['"requests" must be an array']);
  if (body.requests.length === 0) throw new ValidationError(['"requests" must not be empty']);
  if (body.requests.length > maxBatch) {
    const e = new ValidationError([`batch too large: ${body.requests.length} > ${maxBatch} requests`]);
    e.status = 413;
    throw e;
  }

  const out = [];
  body.requests.forEach((r, i) => {
    const at = `requests[${i}]`;
    if (!isPlainObject(r)) return err(`${at}: must be an object`);
    for (const k of Object.keys(r)) if (!REQ_KEYS.has(k)) err(`${at}: unknown field "${k}"`);
    if (typeof r.id !== 'string' || !RE_ID.test(r.id)) err(`${at}.id: must match ${RE_ID}`);
    if (!isInt(r.ts, TS_MIN, TS_MAX)) err(`${at}.ts: must be integer epoch milliseconds`);
    if (typeof r.tenant_id !== 'string' || !RE_TENANT.test(r.tenant_id)) err(`${at}.tenant_id: must match ${RE_TENANT}`);
    if (typeof r.endpoint !== 'string' || !RE_ENDPOINT.test(r.endpoint)) err(`${at}.endpoint: must be a path like /v1/chat`);
    if (!METHODS.has(r.method)) err(`${at}.method: must be one of ${[...METHODS].join(',')}`);
    if (!isInt(r.status, 100, 599)) err(`${at}.status: must be an integer 100..599`);
    if (!isInt(r.duration_ms, 0, 3_600_000)) err(`${at}.duration_ms: must be an integer 0..3600000`);
    const infra = r.infra_cost_micro_usd === undefined ? 0 : r.infra_cost_micro_usd;
    if (!isInt(infra, 0, 1_000_000_000)) err(`${at}.infra_cost_micro_usd: must be a non-negative integer (micro-USD)`);

    const calls = r.llm_calls === undefined ? [] : r.llm_calls;
    if (!Array.isArray(calls)) return err(`${at}.llm_calls: must be an array`);
    if (calls.length > maxCallsPerRequest) return err(`${at}.llm_calls: at most ${maxCallsPerRequest} calls per request`);

    const normCalls = [];
    calls.forEach((c, j) => {
      const cat = `${at}.llm_calls[${j}]`;
      const mark = errors.length;
      if (!isPlainObject(c)) return err(`${cat}: must be an object`);
      for (const k of Object.keys(c)) if (!CALL_KEYS.has(k)) err(`${cat}: unknown field "${k}"`);
      const ts = c.ts === undefined ? r.ts : c.ts;
      if (!isInt(ts, TS_MIN, TS_MAX)) err(`${cat}.ts: must be integer epoch milliseconds`);
      if (typeof c.model !== 'string' || !RE_MODEL.test(c.model)) return err(`${cat}.model: invalid model name`);
      if (!isInt(c.input_tokens, 0, MAX_TOKENS)) err(`${cat}.input_tokens: must be an integer 0..${MAX_TOKENS}`);
      if (!isInt(c.output_tokens, 0, MAX_TOKENS)) err(`${cat}.output_tokens: must be an integer 0..${MAX_TOKENS}`);
      const cached = c.cached_tokens === undefined ? 0 : c.cached_tokens;
      const cw = c.cache_write_tokens === undefined ? 0 : c.cache_write_tokens;
      const cw1h = c.cache_write_1h_tokens === undefined ? 0 : c.cache_write_1h_tokens;
      if (!isInt(cached, 0, MAX_TOKENS)) err(`${cat}.cached_tokens: must be an integer 0..${MAX_TOKENS}`);
      if (!isInt(cw, 0, MAX_TOKENS)) err(`${cat}.cache_write_tokens: must be an integer 0..${MAX_TOKENS}`);
      if (!isInt(cw1h, 0, MAX_TOKENS)) err(`${cat}.cache_write_1h_tokens: must be an integer 0..${MAX_TOKENS}`);
      if (isInt(c.input_tokens, 0, MAX_TOKENS) && isInt(cached, 0, MAX_TOKENS) && isInt(cw, 0, MAX_TOKENS) && isInt(cw1h, 0, MAX_TOKENS) && cached + cw + cw1h > c.input_tokens) {
        err(`${cat}: cached_tokens + cache_write_tokens + cache_write_1h_tokens cannot exceed input_tokens (input_tokens is the whole prompt)`);
      }
      if (!isInt(c.latency_ms, 0, 3_600_000)) err(`${cat}.latency_ms: must be an integer 0..3600000`);
      const id = c.id === undefined ? `${r.id}#${j}` : c.id;
      if (typeof id !== 'string' || !RE_ID.test(id)) err(`${cat}.id: must match ${RE_ID}`);
      if (errors.length > mark) return; // this call is already invalid; report the rest of the batch too
      const price = priceBook.priceAt(c.model, ts);
      if (!price) return err(`${cat}.model: no price in model_prices for "${c.model}" at ts=${ts}`);
      // a missing write rate must not silently bill the tokens at 0: refuse instead
      if (cw > 0 && !price.cache_write_per_mtok) return err(`${cat}.cache_write_tokens: model_prices has no cache write price for "${c.model}"`);
      if (cw1h > 0 && !price.cache_write_1h_per_mtok) return err(`${cat}.cache_write_1h_tokens: model_prices has no 1-hour cache write price for "${c.model}"`);
      const call = { model: c.model, input_tokens: c.input_tokens, output_tokens: c.output_tokens, cached_tokens: cached, cache_write_tokens: cw, cache_write_1h_tokens: cw1h };
      normCalls.push({
        id, ts, model: c.model, input_tokens: c.input_tokens, output_tokens: c.output_tokens,
        cached_tokens: cached, cache_write_tokens: cw, cache_write_1h_tokens: cw1h, latency_ms: c.latency_ms,
        cost_micro_usd: priceBook.cost(call, ts),
      });
    });
    out.push({
      id: r.id, ts: r.ts, tenant_id: r.tenant_id, endpoint: r.endpoint, method: r.method, status: r.status,
      duration_ms: r.duration_ms, infra_cost_micro_usd: infra, llm_calls: normCalls,
    });
  });
  if (errors.length) throw new ValidationError(errors);
  return out;
}

/** Hourly rollup accumulator: Map key -> delta row. */
function addRollup(acc, hour, tenant, endpoint, model) {
  const key = `${hour}\u0000${tenant}\u0000${endpoint}\u0000${model}`;
  let row = acc.get(key);
  if (!row) {
    row = { hour, tenant_id: tenant, endpoint, model, requests: 0, llm_calls: 0, tokens_in: 0, tokens_out: 0, cost_micro_usd: 0 };
    acc.set(key, row);
  }
  return row;
}

export class Ingestor {
  constructor(db, priceBook, { maxBatch = 1000, maxCallsPerRequest = 20 } = {}) {
    this.db = db;
    this.priceBook = priceBook;
    this.maxBatch = maxBatch;
    this.maxCallsPerRequest = maxCallsPerRequest;
    this.stReq = db.prepare(
      'INSERT OR IGNORE INTO requests(id, ts, tenant_id, endpoint, method, status, duration_ms, infra_cost_micro_usd) VALUES(?,?,?,?,?,?,?,?)',
    );
    this.stCall = db.prepare(
      'INSERT INTO llm_calls(id, request_id, ts, tenant_id, endpoint, model, input_tokens, output_tokens, cached_tokens, latency_ms, cost_micro_usd, cache_write_tokens, cache_write_1h_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    this.stRollup = db.prepare(
      `INSERT INTO rollups_hourly(hour, tenant_id, endpoint, model, requests, llm_calls, tokens_in, tokens_out, cost_micro_usd)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(hour, tenant_id, endpoint, model) DO UPDATE SET
         requests = requests + excluded.requests,
         llm_calls = llm_calls + excluded.llm_calls,
         tokens_in = tokens_in + excluded.tokens_in,
         tokens_out = tokens_out + excluded.tokens_out,
         cost_micro_usd = cost_micro_usd + excluded.cost_micro_usd`,
    );
  }

  validate(body) {
    return validateBatch(body, { priceBook: this.priceBook, maxBatch: this.maxBatch, maxCallsPerRequest: this.maxCallsPerRequest });
  }

  /** Validate + write. Throws ValidationError (nothing written) or returns a summary. */
  ingest(body) {
    return this.write(this.validate(body));
  }

  /**
   * Write already-validated requests: raw rows + hourly rollups in ONE transaction.
   * Idempotent per request id: a request id that already exists is skipped entirely
   * (its calls and rollup contribution are not applied twice).
   */
  write(requests) {
    return transaction(this.db, () => {
      const acc = new Map();
      let accepted = 0, duplicates = 0, calls = 0, cost = 0;
      for (const r of requests) {
        const res = this.stReq.run(r.id, r.ts, r.tenant_id, r.endpoint, r.method, r.status, r.duration_ms, r.infra_cost_micro_usd);
        if (res.changes === 0) { duplicates++; continue; }
        accepted++;
        const infra = addRollup(acc, hourOf(r.ts), r.tenant_id, r.endpoint, '');
        infra.requests += 1;
        infra.cost_micro_usd += r.infra_cost_micro_usd;
        cost += r.infra_cost_micro_usd;
        for (const c of r.llm_calls) {
          this.stCall.run(c.id, r.id, c.ts, r.tenant_id, r.endpoint, c.model, c.input_tokens, c.output_tokens, c.cached_tokens, c.latency_ms, c.cost_micro_usd, c.cache_write_tokens, c.cache_write_1h_tokens);
          const row = addRollup(acc, hourOf(c.ts), r.tenant_id, r.endpoint, c.model);
          row.llm_calls += 1;
          row.tokens_in += c.input_tokens;
          row.tokens_out += c.output_tokens;
          row.cost_micro_usd += c.cost_micro_usd;
          calls++;
          cost += c.cost_micro_usd;
        }
      }
      for (const d of acc.values()) {
        this.stRollup.run(d.hour, d.tenant_id, d.endpoint, d.model, d.requests, d.llm_calls, d.tokens_in, d.tokens_out, d.cost_micro_usd);
      }
      return { accepted, duplicates, llm_calls: calls, cost_micro_usd: cost, rollup_rows: acc.size };
    });
  }
}

/**
 * Brute-force recomputation of the rollups from the raw tables (used by tests and /api/stats?verify=1).
 * Returns Map key -> row using the same key format as the accumulator.
 */
export function recomputeRollups(db) {
  const acc = new Map();
  for (const r of pagedRows(db, 'requests', 'ts, tenant_id, endpoint, infra_cost_micro_usd')) {
    const row = addRollup(acc, hourOf(r.ts), r.tenant_id, r.endpoint, '');
    row.requests += 1;
    row.cost_micro_usd += r.infra_cost_micro_usd;
  }
  for (const c of pagedRows(db, 'llm_calls', 'ts, tenant_id, endpoint, model, input_tokens, output_tokens, cost_micro_usd')) {
    const row = addRollup(acc, hourOf(c.ts), c.tenant_id, c.endpoint, c.model);
    row.llm_calls += 1;
    row.tokens_in += c.input_tokens;
    row.tokens_out += c.output_tokens;
    row.cost_micro_usd += c.cost_micro_usd;
  }
  return acc;
}

/**
 * Rows of a table in rowid order, a page at a time: a verification pass over millions of rows must not hold them all in memory.
 * (Paged .all() rather than StatementSync#iterate(): on Node 22.13 a temporary statement can be garbage-collected while an
 * iterator is still reading it - "statement has been finalized" - which only newer versions fixed.)
 */
function* pagedRows(db, table, columns, pageSize = 20_000) {
  const st = db.prepare(`SELECT rowid AS _rid, ${columns} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${pageSize}`);
  let after = 0;
  for (;;) {
    const rows = st.all(after);
    if (!rows.length) return;
    yield* rows;
    after = rows[rows.length - 1]._rid;
  }
}

/** Compare stored rollups with a brute-force recomputation; returns a list of differences (empty = consistent). */
export function verifyRollups(db) {
  const want = recomputeRollups(db);
  const have = new Map();
  for (const r of db.prepare('SELECT hour, tenant_id, endpoint, model, requests, llm_calls, tokens_in, tokens_out, cost_micro_usd FROM rollups_hourly').all()) {
    have.set(`${r.hour}\u0000${r.tenant_id}\u0000${r.endpoint}\u0000${r.model}`, { ...r });
  }
  const diffs = [];
  for (const [k, w] of want) {
    const h = have.get(k);
    if (!h) { diffs.push({ key: k, missing: true, want: w }); continue; }
    for (const f of ['requests', 'llm_calls', 'tokens_in', 'tokens_out', 'cost_micro_usd']) {
      if (h[f] !== w[f]) diffs.push({ key: k, field: f, have: h[f], want: w[f] });
    }
  }
  for (const [k, h] of have) if (!want.has(k)) diffs.push({ key: k, extra: true, have: h });
  return diffs;
}
