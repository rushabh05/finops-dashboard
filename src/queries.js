import { HOUR, DAY } from './util.js';
import { csvCell, HttpError } from './security.js';
import { countActive, listAlerts } from './alerts.js';

export const RANGES = { '24h': { hours: 24, bucketHours: 1 }, '7d': { hours: 168, bucketHours: 6 }, '30d': { hours: 720, bucketHours: 24 } };
const DIM_COL = { tenant: 'tenant_id', endpoint: 'endpoint', model: 'model' };

/** The data's clock: the newest rollup hour (not the wall clock), so simulated and replayed data behave the same. */
export function latestHour(db) {
  return db.prepare('SELECT MAX(hour) AS h FROM rollups_hourly').get().h;
}

export function windowOf(db, range = '24h') {
  const r = RANGES[range];
  const latest = latestHour(db);
  if (latest == null) return { empty: true, range, ...r, from: 0, to: 0, latest: 0, buckets: r.hours / r.bucketHours, bucketMs: r.bucketHours * HOUR };
  const from = latest - (r.hours - 1) * HOUR;
  return { empty: false, range, ...r, from, to: latest, latest, buckets: r.hours / r.bucketHours, bucketMs: r.bucketHours * HOUR };
}

/** Build " AND col = ?" for the active filters, optionally ignoring one dimension (cross-filtering). */
export function filterSql(f, ignore = null) {
  let sql = '';
  const params = [];
  for (const dim of ['tenant', 'endpoint', 'model']) {
    if (dim === ignore || f[dim] === undefined || f[dim] === null) continue;
    sql += ` AND ${DIM_COL[dim]} = ?`;
    params.push(f[dim]);
  }
  return { sql, params };
}

const totalsSql = `SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(llm_calls),0) AS llm_calls,
  COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out,
  COALESCE(SUM(cost_micro_usd),0) AS cost_micro_usd,
  COALESCE(SUM(CASE WHEN model <> '' THEN cost_micro_usd ELSE 0 END),0) AS llm_cost_micro_usd
  FROM rollups_hourly WHERE hour BETWEEN ? AND ?`;

function shapeTotals(t, filtered) {
  const infra = t.cost_micro_usd - t.llm_cost_micro_usd;
  // requests live on the infra rows, so under a model filter they are not attributable: report null, not a wrong 0
  const reqOk = t.requests > 0 && !filtered.model;
  return {
    requests: filtered.model ? null : t.requests, llm_calls: t.llm_calls, tokens_in: t.tokens_in, tokens_out: t.tokens_out,
    cost_micro_usd: t.cost_micro_usd, llm_cost_micro_usd: t.llm_cost_micro_usd, infra_cost_micro_usd: infra,
    cost_per_request_micro_usd: reqOk ? t.cost_micro_usd / t.requests : null,
    cost_per_1k_requests_micro_usd: reqOk ? (t.cost_micro_usd / t.requests) * 1000 : null,
    llm_share: t.cost_micro_usd > 0 ? t.llm_cost_micro_usd / t.cost_micro_usd : null,
  };
}

export function summary(db, f) {
  const w = windowOf(db, f.range);
  const { sql, params } = filterSql(f);
  if (w.empty) return { window: w, totals: shapeTotals({ requests: 0, llm_calls: 0, tokens_in: 0, tokens_out: 0, cost_micro_usd: 0, llm_cost_micro_usd: 0 }, f), previous: null, projection: null, alerts: countActive(db, f) };
  const st = (from, to) => shapeTotals(db.prepare(totalsSql + sql).get(from, to, ...params), f);
  const totals = st(w.from, w.to);
  const previous = st(w.from - w.hours * HOUR, w.from - HOUR);

  // month-end projection: month-to-date + trailing-7-day hourly run rate x the hours left in the month
  const d = new Date(w.latest);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const monthEnd = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const mtd = db.prepare('SELECT COALESCE(SUM(cost_micro_usd),0) AS c FROM rollups_hourly WHERE hour BETWEEN ? AND ?' + sql).get(monthStart, w.latest, ...params).c;
  const minHour = db.prepare('SELECT MIN(hour) AS h FROM rollups_hourly').get().h;
  const rateFrom = Math.max(minHour, w.latest - 167 * HOUR);
  const rateHours = (w.latest - rateFrom) / HOUR + 1;
  const rateCost = db.prepare('SELECT COALESCE(SUM(cost_micro_usd),0) AS c FROM rollups_hourly WHERE hour BETWEEN ? AND ?' + sql).get(rateFrom, w.latest, ...params).c;
  const rate = rateCost / rateHours;
  const remaining = Math.max(0, (monthEnd - (w.latest + HOUR)) / HOUR);
  const projection = {
    month: new Date(monthStart).toISOString().slice(0, 7), month_to_date_micro_usd: mtd, run_rate_micro_usd_per_hour: rate,
    remaining_hours: remaining, projected_micro_usd: mtd + rate * remaining,
  };
  return { window: w, totals, previous, projection, alerts: countActive(db, f) };
}

/** Table for one dimension. It ignores its own filter so the selected row stays visible among its siblings. */
export function byDimension(db, f, dim) {
  const w = windowOf(db, f.range);
  const col = DIM_COL[dim];
  if (w.empty) return { window: w, dimension: dim, rows: [], total_cost_micro_usd: 0 };
  const { sql, params } = filterSql(f, dim);
  const rows = db.prepare(`SELECT ${col} AS key, SUM(cost_micro_usd) AS cost_micro_usd,
      SUM(CASE WHEN model <> '' THEN cost_micro_usd ELSE 0 END) AS llm_cost_micro_usd,
      SUM(requests) AS requests, SUM(llm_calls) AS llm_calls, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
      FROM rollups_hourly WHERE hour BETWEEN ? AND ?${sql} GROUP BY ${col} ORDER BY cost_micro_usd DESC`).all(w.from, w.to, ...params);
  const total = rows.reduce((n, r) => n + r.cost_micro_usd, 0);
  const sparks = new Map();
  const sp = db.prepare(`SELECT ${col} AS key, CAST((hour - ?) / ? AS INTEGER) AS b, SUM(cost_micro_usd) AS c
      FROM rollups_hourly WHERE hour BETWEEN ? AND ?${sql} GROUP BY ${col}, b`).all(w.from, w.bucketMs, w.from, w.to, ...params);
  for (const r of sp) {
    if (!sparks.has(r.key)) sparks.set(r.key, new Array(w.buckets).fill(0));
    if (r.b >= 0 && r.b < w.buckets) sparks.get(r.key)[r.b] = r.c;
  }
  const modelFiltered = dim !== 'model' && f.model;
  return {
    window: w, dimension: dim, total_cost_micro_usd: total,
    rows: rows.map((r) => ({
      key: r.key, cost_micro_usd: r.cost_micro_usd, llm_cost_micro_usd: r.llm_cost_micro_usd, share: total ? r.cost_micro_usd / total : 0,
      requests: modelFiltered ? null : dim === 'model' ? (r.key === '' ? r.requests : null) : r.requests,
      llm_calls: r.llm_calls, tokens_in: r.tokens_in, tokens_out: r.tokens_out,
      cost_per_request_micro_usd: dim !== 'model' && !modelFiltered && r.requests > 0 ? r.cost_micro_usd / r.requests : null,
      cost_per_call_micro_usd: r.llm_calls > 0 ? r.llm_cost_micro_usd / r.llm_calls : null,
      spark: sparks.get(r.key) || new Array(w.buckets).fill(0),
    })),
  };
}

/** Stacked series grouped by a dimension: top N by total cost over the window, everything else folded into "Other". */
export function timeseries(db, f, group, top = 7) {
  const w = windowOf(db, f.range);
  const bucketTs = Array.from({ length: w.buckets }, (_, i) => w.from + i * w.bucketMs);
  if (w.empty) return { window: w, group, buckets: bucketTs, series: [] };
  const { sql, params } = filterSql(f);
  const col = group === 'total' ? "'total'" : DIM_COL[group];
  const rows = db.prepare(`SELECT ${col} AS key, CAST((hour - ?) / ? AS INTEGER) AS b, SUM(cost_micro_usd) AS c
      FROM rollups_hourly WHERE hour BETWEEN ? AND ?${sql} GROUP BY 1, b`).all(w.from, w.bucketMs, w.from, w.to, ...params);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.key)) map.set(r.key, { key: r.key, total: 0, points: new Array(w.buckets).fill(0) });
    const s = map.get(r.key);
    if (r.b >= 0 && r.b < w.buckets) { s.points[r.b] += r.c; s.total += r.c; }
  }
  const ranked = [...map.values()].sort((a, b) => b.total - a.total);
  const keep = ranked.slice(0, top);
  const rest = ranked.slice(top);
  const series = keep.map((s) => ({ ...s, other: false }));
  if (rest.length) {
    const other = { key: 'Other', total: 0, points: new Array(w.buckets).fill(0), other: true, members: rest.length };
    for (const s of rest) { other.total += s.total; s.points.forEach((v, i) => { other.points[i] += v; }); }
    series.push(other);
  }
  return { window: w, group, top, buckets: bucketTs, series };
}

export function requestList(db, f, { sort = 'recent', limit = 25 } = {}) {
  const w = windowOf(db, f.range);
  if (w.empty) return { window: w, rows: [] };
  const lo = w.from, hi = w.to + HOUR - 1;
  const where = [];
  const params = [];
  if (f.tenant) { where.push('tenant_id = ?'); params.push(f.tenant); }
  if (f.endpoint) { where.push('endpoint = ?'); params.push(f.endpoint); }
  let rows;
  if (sort === 'cost') {
    const callWhere = [...where]; const callParams = [...params];
    if (f.model) { callWhere.push('model = ?'); callParams.push(f.model); }
    rows = db.prepare(`SELECT r.id, r.ts, r.tenant_id, r.endpoint, r.method, r.status, r.duration_ms, r.infra_cost_micro_usd, x.llm_cost AS llm_cost_micro_usd, x.calls AS llm_calls
      FROM (SELECT request_id, SUM(cost_micro_usd) AS llm_cost, COUNT(*) AS calls FROM llm_calls WHERE ts BETWEEN ? AND ?${callWhere.map((c) => ' AND ' + c).join('')}
            GROUP BY request_id ORDER BY llm_cost DESC LIMIT ?) x JOIN requests r ON r.id = x.request_id ORDER BY x.llm_cost DESC`).all(lo, hi, ...callParams, limit);
  } else {
    const rw = [...where];
    const rp = [...params];
    if (f.model) { rw.push('EXISTS (SELECT 1 FROM llm_calls c WHERE c.request_id = requests.id AND c.model = ?)'); rp.push(f.model); }
    rows = db.prepare(`SELECT id, ts, tenant_id, endpoint, method, status, duration_ms, infra_cost_micro_usd,
        (SELECT COALESCE(SUM(cost_micro_usd),0) FROM llm_calls WHERE request_id = requests.id) AS llm_cost_micro_usd,
        (SELECT COUNT(*) FROM llm_calls WHERE request_id = requests.id) AS llm_calls
        FROM requests WHERE ts BETWEEN ? AND ?${rw.map((c) => ' AND ' + c).join('')} ORDER BY ts DESC LIMIT ?`).all(lo, hi, ...rp, limit);
  }
  return { window: w, sort, rows: rows.map((r) => ({ ...r, total_cost_micro_usd: r.infra_cost_micro_usd + r.llm_cost_micro_usd })) };
}

export function requestDetail(db, priceBook, id) {
  const r = db.prepare('SELECT id, ts, tenant_id, endpoint, method, status, duration_ms, infra_cost_micro_usd FROM requests WHERE id = ?').get(id);
  if (!r) return null;
  const calls = db.prepare(`SELECT id, ts, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, cache_write_1h_tokens, latency_ms, cost_micro_usd, cost_source FROM llm_calls WHERE request_id = ? ORDER BY ts, id`).all(id).map((c) => {
    const p = c.cost_source === 'supplied' ? null : priceBook.priceAt(c.model, c.ts); // a supplied cost was not computed from the table: no price to show
    return { ...c, price: p ? { input_per_mtok: p.input_per_mtok, output_per_mtok: p.output_per_mtok, cached_per_mtok: p.cached_per_mtok, cache_write_per_mtok: p.cache_write_per_mtok, cache_write_1h_per_mtok: p.cache_write_1h_per_mtok } : null };
  });
  const llm = calls.reduce((n, c) => n + c.cost_micro_usd, 0);
  return { ...r, llm_calls: calls, llm_cost_micro_usd: llm, total_cost_micro_usd: llm + r.infra_cost_micro_usd };
}

/* ------------------------------------------------------------------ CSV export of the current view */

const usd = (micro) => (micro == null ? '' : (micro / 1e6).toFixed(6));

export function exportCsv(db, f, view, { limit = 1000 } = {}) {
  const lines = [];
  const row = (cells) => lines.push(cells.map(csvCell).join(','));
  let name = view;
  if (view === 'tenant' || view === 'endpoint' || view === 'model') {
    const d = byDimension(db, f, view);
    row([view, 'cost_usd', 'llm_cost_usd', 'share', 'requests', 'llm_calls', 'tokens_in', 'tokens_out', 'cost_per_request_usd', 'cost_per_call_usd']);
    for (const r of d.rows) row([r.key === '' ? '(infra)' : r.key, usd(r.cost_micro_usd), usd(r.llm_cost_micro_usd), r.share.toFixed(6), r.requests, r.llm_calls, r.tokens_in, r.tokens_out, usd(r.cost_per_request_micro_usd), usd(r.cost_per_call_micro_usd)]);
  } else if (view === 'timeseries') {
    const group = f.group || 'tenant';
    const t = timeseries(db, f, group);
    row(['bucket_start_utc', group, 'cost_usd']);
    for (const s of t.series) t.buckets.forEach((ts, i) => row([new Date(ts).toISOString(), s.key === '' ? '(infra)' : s.key, usd(s.points[i])]));
    name = `timeseries-${group}`;
  } else if (view === 'alerts') {
    row(['id', 'ts_utc', 'kind', 'severity', 'tenant', 'endpoint', 'observed', 'baseline', 'score', 'status', 'explanation']);
    for (const a of listAlerts(db, { status: 'all', tenant: f.tenant, endpoint: f.endpoint, limit })) row([a.id, new Date(a.ts).toISOString(), a.kind, a.severity, a.tenant_id, a.endpoint, a.observed, a.baseline, a.score, a.status, a.explanation]);
  } else if (view === 'requests') {
    const l = requestList(db, f, { sort: 'cost', limit });
    row(['id', 'ts_utc', 'tenant', 'endpoint', 'method', 'status', 'duration_ms', 'llm_calls', 'infra_cost_usd', 'llm_cost_usd', 'total_cost_usd']);
    for (const r of l.rows) row([r.id, new Date(r.ts).toISOString(), r.tenant_id, r.endpoint, r.method, r.status, r.duration_ms, r.llm_calls, usd(r.infra_cost_micro_usd), usd(r.llm_cost_micro_usd), usd(r.total_cost_micro_usd)]);
  } else throw new HttpError(400, 'unknown view');
  const tag = ['range', 'tenant', 'endpoint', 'model'].filter((k) => f[k]).map((k) => `${k}-${String(f[k]).replace(/[^A-Za-z0-9._-]/g, '_')}`).join('_');
  return { filename: `finops-${name}${tag ? '_' + tag : ''}.csv`, csv: lines.join('\r\n') + '\r\n' };
}

export { DAY };
