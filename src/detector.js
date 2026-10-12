import { DAY, HOUR, hourOf, median, mad } from './util.js';
import { hourLabel } from './alerts.js';
import { transaction } from './db.js';

/*
 * Explainable anomaly detection - no ML.
 *
 * For an entity (a tenant, an endpoint, or a tenant x endpoint pair) and the latest hour H:
 *   baseline samples = the same metric at H - 1d, H - 2d, ... H - Nd   (same hour-of-day, previous N days)
 *   baseline         = median(samples)
 *   sigma            = max( 1.4826 * MAD(samples),                 robust spread
 *                           relFloor * baseline,                   never trust a spread tighter than this
 *                           cv / sqrt(baseline requests) * baseline )  statistical noise expected at this volume
 *   z                = (observed - baseline) / sigma               robust z-score
 * An alert needs z >= zThreshold AND observed/baseline >= a per-metric minimum ratio, plus a minimum-volume
 * guard (requests) and a minimum absolute-cost floor. Only increases alert.
 *
 * Metrics: cost, requests, tokens per request, cost per request. Tokens/request and cost/request catch prompt bloat
 * when traffic is flat. The alert kind is chosen by decomposing cost = requests x cost-per-request.
 */
export const DETECTOR_DEFAULTS = {
  baselineDays: 7,
  minBaselineDays: 4, // fewer usable baseline days than this -> stay silent
  zThreshold: 4,
  overdispersion: 1.2, // request counts are judged in variance-stabilised (square-root) space, inflated by this
  madScale: 1.4826,
  relSigmaFloor: 0.12,
  cv: { requests: 1.0, cost: 3.0, tpr: 2.0, cpr: 3.0 }, // assumed per-request coefficient of variation (cost is heavy-tailed: opus calls vs classifiers)
  explainShare: 0.6, // a flagged entity explains another's increase when it accounts for this share of it
  minRequests: 30, // (projected) requests in the hour for tenant / endpoint / pair to be judged at all
  minObservedRequests: 10, // ...and actually observed so far (guards projection of a barely-started hour)
  minCostMicro: 250_000, // $0.25 / hour absolute floor for the cost-based kinds
  minRatio: { cost: 1.5, volume: 2, tokens: 1.4, cpr: 1.4 },
  flatTrafficRatio: 1.3, // requests below this ratio count as "flat traffic"
  minElapsed: 0.25, // a partial hour is judged (projected to a full hour) once this much of it has elapsed
  cooldownMs: 3 * HOUR,
  errorShare: 0.3, // volume spike where this share of requests failed (429 / 5xx) = retry storm
};

const fmtUsd = (micro) => {
  const v = micro / 1e6;
  return v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
};
const fmtN = (v) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(v >= 10 ? 0 : 1));
const fmtRatio = (r) => (r >= 100 ? '>100' : r.toFixed(1)) + '×';

export function robustStats(samples, { relSigmaFloor, madScale, cv, baseRequests }) {
  const base = median(samples);
  const m = mad(samples, base);
  const noise = baseRequests > 0 ? (cv / Math.sqrt(baseRequests)) * Math.abs(base) : 0;
  const sigma = Math.max(madScale * m, relSigmaFloor * Math.abs(base), noise);
  return { base, mad: m, sigma };
}

function metricResult(obs, samples, P, cv, baseRequests) {
  const { base, mad: m, sigma } = robustStats(samples, { relSigmaFloor: P.relSigmaFloor, madScale: P.madScale, cv, baseRequests });
  const z = sigma > 0 ? (obs - base) / sigma : obs > base ? Infinity : 0;
  const ratio = base > 0 ? obs / base : obs > 0 ? Infinity : 1;
  return { obs, base, mad: m, sigma, z, ratio, n: samples.length };
}

export class Detector {
  constructor(db, params = {}) {
    this.db = db;
    this.P = { ...DETECTOR_DEFAULTS, ...params, cv: { ...DETECTOR_DEFAULTS.cv, ...(params.cv || {}) }, minRatio: { ...DETECTOR_DEFAULTS.minRatio, ...(params.minRatio || {}) } };
    const hours = this.P.baselineDays + 1;
    const ph = new Array(hours).fill('?').join(',');
    const sel = (cols, group) => `SELECT hour, ${cols} SUM(requests) AS r, SUM(cost_micro_usd) AS c, SUM(tokens_in + tokens_out) AS k FROM rollups_hourly WHERE hour IN (${ph}) GROUP BY ${group}`;
    this.stTenant = db.prepare(sel('tenant_id AS t,', 'hour, tenant_id'));
    this.stEndpoint = db.prepare(sel('endpoint AS e,', 'hour, endpoint'));
    this.stPair = db.prepare(sel('tenant_id AS t, endpoint AS e,', 'hour, tenant_id, endpoint'));
    this.stMinHour = db.prepare('SELECT MIN(hour) AS h FROM rollups_hourly');
    this.stMaxTs = db.prepare('SELECT MAX(ts) AS ts FROM requests');
    const err = (extra) => `SELECT COUNT(*) AS n, SUM(status = 429 OR status >= 500) AS bad FROM requests WHERE ts >= ? AND ts < ? ${extra}`;
    this.stErrAll = db.prepare(err(''));
    this.stErrTenant = db.prepare(err('AND tenant_id = ?'));
    this.stErrEndpoint = db.prepare(err('AND endpoint = ?'));
    this.stErrPair = db.prepare(err('AND tenant_id = ? AND endpoint = ?'));
    this.stDedupe = db.prepare('SELECT 1 AS x FROM alerts WHERE kind = ? AND tenant_id IS ? AND endpoint IS ? AND ts > ? LIMIT 1');
    this.stInsert = db.prepare(
      'INSERT INTO alerts(ts, kind, tenant_id, endpoint, observed, baseline, score, explanation, status, hour, detail) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    );
  }

  /** Newest data timestamp (the detector's "now" - the data's clock, not the wall clock). */
  dataNow() {
    return this.stMaxTs.get().ts ?? null;
  }

  /** Which hour to judge and how much of it has elapsed. */
  static pickHour(asOf, minElapsed) {
    const cur = hourOf(asOf);
    const frac = (asOf - cur) / HOUR;
    return frac >= minElapsed ? { hour: cur, fraction: frac } : { hour: cur - HOUR, fraction: 1 };
  }

  _load(stmt, hours) {
    const m = new Map();
    for (const r of stmt.all(...hours)) {
      const key = r.t !== undefined && r.e !== undefined ? `${r.t}\u0000${r.e}` : r.t !== undefined ? r.t : r.e;
      let s = m.get(key);
      if (!s) { s = new Map(); m.set(key, s); }
      s.set(r.hour, { r: r.r, c: r.c, k: r.k });
    }
    return m;
  }

  _errors(grain, t, e, hour) {
    const lo = hour, hi = hour + HOUR;
    const row = grain === 'tenant' ? this.stErrTenant.get(lo, hi, t) : grain === 'endpoint' ? this.stErrEndpoint.get(lo, hi, e) : grain === 'pair' ? this.stErrPair.get(lo, hi, t, e) : this.stErrAll.get(lo, hi);
    return row.n ? (row.bad ?? 0) / row.n : 0;
  }

  /** Analyse one entity's series. Returns metrics + flags. */
  _analyze(series, H, f, baseHours) {
    const P = this.P;
    const zero = { r: 0, c: 0, k: 0 };
    const cur = series.get(H) || zero;
    const samples = baseHours.map((h) => series.get(h) || zero);
    const nonEmpty = samples.filter((s) => s.r > 0);
    const baseR = median(samples.map((s) => s.r));
    const effN = baseR * f; // a partial hour carries proportionally less evidence, so noise is judged on the requests it holds
    const obsR = cur.r / f, obsC = cur.c / f;
    const reqM = metricResult(obsR, samples.map((s) => s.r), P, P.cv.requests, effN);
    // Poisson counts are skewed, so a linear z over-fires on small baselines: also require the square-root-space z
    // (sqrt of a Poisson count has sd ~0.5; a partial hour carries sqrt(f) as much evidence) and keep the smaller.
    reqM.z = Math.min(reqM.z, (2 * Math.sqrt(f) * (Math.sqrt(obsR) - Math.sqrt(Math.max(reqM.base, 0)))) / P.overdispersion);
    const m = {
      requests: reqM,
      cost: metricResult(obsC, samples.map((s) => s.c), P, P.cv.cost, effN),
      tpr: nonEmpty.length >= P.minBaselineDays && cur.r > 0
        ? metricResult(cur.k / cur.r, nonEmpty.map((s) => s.k / s.r), P, P.cv.tpr, effN) : null,
      cpr: nonEmpty.length >= P.minBaselineDays && cur.r > 0
        ? metricResult(cur.c / cur.r, nonEmpty.map((s) => s.c / s.r), P, P.cv.cpr, effN) : null,
    };
    const volGuard = obsR >= P.minRequests && cur.r >= P.minObservedRequests;
    const costOk = obsC >= P.minCostMicro;
    const hit = (x, ratio) => x && Number.isFinite(x.z) ? x.z >= P.zThreshold && x.ratio >= ratio : x && x.z === Infinity && x.ratio >= ratio;
    const flags = {
      cost: volGuard && costOk && hit(m.cost, P.minRatio.cost),
      volume: volGuard && hit(m.requests, P.minRatio.volume),
      tpr: volGuard && costOk && !!m.tpr && hit(m.tpr, P.minRatio.tokens),
      cpr: volGuard && costOk && !!m.cpr && hit(m.cpr, P.minRatio.cpr),
    };
    return { m, flags, raw: cur, baseRequests: baseR };
  }

  /** cost = requests x cost-per-request: pick the kind that explains the move. */
  static diagnose(m, flags, P) {
    const vr = m.requests.ratio;
    const cr = m.cpr ? m.cpr.ratio : 1;
    if (flags.cost) {
      if (flags.cpr && vr < P.flatTrafficRatio) return flags.tpr || (m.tpr && m.tpr.ratio >= P.minRatio.tokens) ? 'tokens_per_request' : 'cost_per_request';
      if (flags.volume && cr < P.flatTrafficRatio) return 'volume_spike';
      return 'cost_spike';
    }
    if (flags.volume) return 'volume_spike';
    if (flags.tpr) return 'tokens_per_request';
    if (flags.cpr) return 'cost_per_request';
    return null;
  }

  /**
   * Evaluate without writing. Returns { hour, fraction, candidates[] } where candidates are alert-shaped objects.
   */
  evaluate(asOf = this.dataNow()) {
    const P = this.P;
    if (asOf == null) return { hour: null, fraction: 1, candidates: [], skipped: 'no data' };
    const { hour: H, fraction: f } = Detector.pickHour(asOf, P.minElapsed);
    const minHour = this.stMinHour.get().h;
    const baseHours = [];
    for (let d = 1; d <= P.baselineDays; d++) {
      const h = H - d * DAY;
      if (minHour != null && h >= minHour) baseHours.push(h);
    }
    if (baseHours.length < P.minBaselineDays) return { hour: H, fraction: f, candidates: [], skipped: 'not enough history' };
    const hours = [H, ...baseHours];
    while (hours.length < P.baselineDays + 1) hours.push(-1 - hours.length); // pad (matches no row)

    const tenants = this._load(this.stTenant, hours);
    const endpoints = this._load(this.stEndpoint, hours);
    const pairs = this._load(this.stPair, hours);

    const out = [];
    const kept = { tenant: new Set(), endpoint: new Set() };
    const mk = (grain, t, e, key, series) => {
      const a = this._analyze(series, H, f, baseHours);
      const kind = Detector.diagnose(a.m, a.flags, P);
      return { grain, t, e, key, a, kind, series };
    };
    const excess = (series, kind) => {
      const field = kind === 'volume_spike' ? 'r' : 'c';
      const obs = (series.get(H)?.[field] ?? 0) / f;
      return obs - median(baseHours.map((h) => series.get(h)?.[field] ?? 0));
    };

    const cands = [];
    for (const [t, s] of tenants) cands.push(mk('tenant', t, null, t, s));
    for (const [e, s] of endpoints) cands.push(mk('endpoint', null, e, e, s));
    const flagged = cands.filter((g) => g.kind);
    for (const g of flagged) g.ex = excess(g.series, g.kind);

    // Explain-away: a tenant alert is redundant when one flagged endpoint accounts for most of its increase (and
    // vice versa). When two entities explain each other (a single hot pair) both are kept.
    const explainer = (x) => {
      if (!(x.ex > 0)) return null;
      let best = null;
      for (const y of flagged) {
        if (y.grain === x.grain) continue;
        const ps = pairs.get(x.grain === 'tenant' ? `${x.t}\u0000${y.e}` : `${y.t}\u0000${x.e}`);
        if (!ps) continue;
        const pex = excess(ps, x.kind);
        if (pex >= P.explainShare * x.ex && (!best || pex > best.pex)) best = { y, pex };
      }
      return best;
    };
    const absorbed = new Map();
    for (const x of flagged) {
      const by = explainer(x);
      if (by) {
        const back = explainer(by.y);
        if (!(back && back.y === x)) { // not mutual -> x is redundant
          x.dropped = true;
          if (!absorbed.has(by.y)) absorbed.set(by.y, []);
          absorbed.get(by.y).push(x.grain === 'tenant' ? `tenant ${x.t}` : `endpoint ${x.e}`);
        }
      }
    }
    for (const g of flagged) if (!g.dropped) kept[g.grain].add(g.key);
    for (const g of flagged) {
      if (g.dropped) continue;
      out.push(this._candidate(g, H, f, baseHours, pairs, absorbed.get(g) || []));
    }
    // pair-level volume check, skipped where a coarser alert already covers the pair's tenant or endpoint
    for (const [key, s] of pairs) {
      const [t, e] = key.split('\u0000');
      if (kept.tenant.has(t) || kept.endpoint.has(e)) continue;
      const a = this._analyze(s, H, f, baseHours);
      if (!a.flags.volume) continue;
      out.push(this._candidate({ grain: 'pair', t, e, key, a, kind: 'volume_spike' }, H, f, baseHours, pairs, []));
    }
    return { hour: H, fraction: f, candidates: out };
  }

  _candidate(g, H, f, baseHours, pairs, absorbed = []) {
    const P = this.P;
    const { a } = g;
    let kind = g.kind;
    const subject = g.grain === 'tenant' ? `Tenant ${g.t}` : g.grain === 'endpoint' ? `Endpoint ${g.e}` : `Tenant ${g.t} on ${g.e}`;
    const partial = f < 0.999 ? ` (projected from ${Math.round(f * 100)}% of the hour)` : '';
    const when = `the hour starting ${hourLabel(H)}${partial}`;
    const typical = 'for that hour of day';
    const m = a.m;
    let detail = { grain: g.grain, hour: H, fraction: f, baseline_days: baseHours.length, metrics: {} };
    for (const [k, v] of Object.entries(m)) if (v) detail.metrics[k] = { observed: v.obs, baseline: v.base, mad: v.mad, sigma: v.sigma, z: v.z, ratio: v.ratio };

    let primary, text;
    const fx = `requests ${fmtRatio(m.requests.ratio)} and cost per request ${m.cpr ? fmtRatio(m.cpr.ratio) : 'n/a'} vs normal`;

    if (kind === 'volume_spike') {
      const share = this._errors(g.grain, g.t, g.e, H);
      const prior = this._errors(g.grain, g.t, g.e, H - DAY);
      detail.error_share = share; detail.error_share_prior_day = prior;
      let where = '';
      if (g.grain !== 'pair') {
        const top = this._topContributor(g, H, f, baseHours, pairs);
        if (top) { detail.top_contributor = top; where = ` Most of the extra traffic is ${g.grain === 'tenant' ? top.endpoint : `tenant ${top.tenant}`}.`; }
      }
      primary = m.requests;
      if (share >= P.errorShare) {
        kind = 'retry_storm';
        text = `${subject} sent ${fmtN(primary.obs)} requests in ${when} vs a typical ${fmtN(primary.base)} ${typical} (${fmtRatio(primary.ratio)}, robust z ${primary.z.toFixed(1)}); ${Math.round(share * 100)}% of them failed (429/5xx) - this looks like a retry storm, so check client retry/backoff and the failing upstream.${where}`;
      } else {
        text = `${subject} sent ${fmtN(primary.obs)} requests in ${when} vs a typical ${fmtN(primary.base)} ${typical} (${fmtRatio(primary.ratio)}, robust z ${primary.z.toFixed(1)}), and only ${Math.round(share * 100)}% failed - check for a new client, a batch job or a loop.${where}`;
      }
    } else if (kind === 'tokens_per_request') {
      primary = m.tpr;
      text = `${subject} used ${fmtN(primary.obs)} tokens per request in ${when} vs a typical ${fmtN(primary.base)} ${typical} (${fmtRatio(primary.ratio)}, robust z ${primary.z.toFixed(1)}) while traffic is ${fmtRatio(m.requests.ratio)} of normal - check for prompt bloat: a longer system prompt, more retrieved context or growing conversation history.`;
    } else if (kind === 'cost_per_request') {
      primary = m.cpr;
      text = `${subject} cost ${fmtUsd(primary.obs)} per request in ${when} vs a typical ${fmtUsd(primary.base)} ${typical} (${fmtRatio(primary.ratio)}, robust z ${primary.z.toFixed(1)}) with traffic at ${fmtRatio(m.requests.ratio)} of normal - check for a model change, lost prompt caching or longer outputs.`;
    } else {
      primary = m.cost;
      text = `${subject} spent ${fmtUsd(primary.obs)} in ${when} vs a typical ${fmtUsd(primary.base)} ${typical} (${fmtRatio(primary.ratio)}, robust z ${primary.z.toFixed(1)}); ${fx} - check for a runaway job or a prompt or model change.`;
    }
    if (absorbed.length) {
      detail.also_explains = absorbed;
      text += ` This also accounts for the rise on ${absorbed.slice(0, 3).join(', ')}${absorbed.length > 3 ? ` and ${absorbed.length - 3} more` : ''}.`;
    }
    detail.primary = kindMetric(kind);
    return {
      kind, tenant_id: g.t ?? null, endpoint: g.e ?? null,
      observed: primary.obs, baseline: primary.base, score: Number.isFinite(primary.z) ? primary.z : 99,
      explanation: text, hour: H, detail,
    };
  }

  _topContributor(g, H, f, baseHours, pairs) {
    let best = null;
    for (const [key, s] of pairs) {
      const [t, e] = key.split('\u0000');
      if (g.grain === 'tenant' ? t !== g.t : e !== g.e) continue;
      const obs = (s.get(H)?.r ?? 0) / f;
      const base = median(baseHours.map((h) => s.get(h)?.r ?? 0));
      const excess = obs - base;
      if (!best || excess > best.excess) best = { tenant: t, endpoint: e, observed: obs, baseline: base, excess };
    }
    return best && best.excess > 0 ? best : null;
  }

  /** Evaluate and persist alerts, skipping any kind/tenant/endpoint already alerted inside the cooldown window. */
  run(asOf = this.dataNow()) {
    const { hour, fraction, candidates, skipped } = this.evaluate(asOf);
    const inserted = [];
    let suppressed = 0;
    if (candidates.length) {
      transaction(this.db, () => {
        for (const c of candidates) {
          if (this.stDedupe.get(c.kind, c.tenant_id, c.endpoint, asOf - this.P.cooldownMs)) { suppressed++; continue; }
          const res = this.stInsert.run(asOf, c.kind, c.tenant_id, c.endpoint, c.observed, c.baseline, c.score, c.explanation, 'open', c.hour, JSON.stringify(c.detail));
          inserted.push({ id: Number(res.lastInsertRowid), ...c, ts: asOf });
        }
      });
    }
    return { hour, fraction, evaluated: candidates.length, inserted, suppressed, skipped };
  }
}

function kindMetric(kind) {
  return kind === 'cost_spike' ? 'cost' : kind === 'tokens_per_request' ? 'tpr' : kind === 'cost_per_request' ? 'cpr' : 'requests';
}
