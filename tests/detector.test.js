import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { PriceBook, seedPrices } from '../src/pricing.js';
import { Ingestor } from '../src/ingest.js';
import { seedHistory } from '../src/sim.js';
import { Detector, robustStats, DETECTOR_DEFAULTS } from '../src/detector.js';
import { setAlertStatus, AlertStateError, listAlerts, severityOf } from '../src/alerts.js';
import { median, mad, HOUR, DAY } from '../src/util.js';
import { mkRequest } from './helpers.js';

const T = Date.UTC(2026, 9, 12, 0, 0, 0); // history ends here (an hour boundary)
const INJ = [
  { kind: 'tenant_cost_spike', tenant: 'globex', startTs: T - 60 * HOUR, endTs: T - 57 * HOUR },
  { kind: 'token_bloat', endpoint: '/v1/chat', startTs: T - 40 * HOUR, endTs: T - 37 * HOUR },
  { kind: 'retry_storm', tenant: 'acme', endpoint: '/v1/classify', startTs: T - 20 * HOUR, endTs: T - 17 * HOUR },
];
let db, ing, det;

before(() => {
  db = openDb();
  seedPrices(db);
  ing = new Ingestor(db, new PriceBook(db));
  seedHistory(ing, { seed: 42, days: 14, endTs: T, injections: INJ }); // 14 days, anomalies in the last 3
  det = new Detector(db);
});

const label = (c) => `${c.kind}@${c.tenant_id ?? '*'}/${c.endpoint ?? '*'}`;
const inWindow = (hour) => INJ.find((i) => hour >= i.startTs && hour < i.endTs);

test('robust stats: median/MAD ignore outliers in the baseline', () => {
  const samples = [100, 102, 98, 101, 500, 99, 100]; // one wild day
  assert.equal(median(samples), 100);
  assert.equal(mad(samples), 1);
  const s = robustStats(samples, { relSigmaFloor: 0.12, madScale: 1.4826, cv: 1, baseRequests: 100 });
  assert.equal(s.base, 100);
  assert.ok(s.sigma >= 12 && s.sigma < 20, `sigma=${s.sigma}`); // floored at 12% of baseline / statistical noise, not blown up by the outlier
  // a tight baseline does not produce a hair-trigger: the floors keep sigma from collapsing to ~0
  assert.ok(robustStats([50, 50, 50, 50, 50, 50, 50], { relSigmaFloor: 0.12, madScale: 1.4826, cv: 1, baseRequests: 50 }).sigma >= 6);
});

test('stays quiet on normal seasonality: no alert in any hour outside an injected anomaly', () => {
  let evaluated = 0;
  const falsePositives = [];
  for (let asOf = T - 7 * DAY + HOUR; asOf <= T; asOf += HOUR) {
    const { hour, candidates } = det.evaluate(asOf);
    evaluated++;
    if (inWindow(hour)) continue;
    for (const c of candidates) falsePositives.push(`${new Date(hour).toISOString()} ${label(c)} z=${c.score.toFixed(1)}`);
  }
  assert.ok(evaluated >= 160);
  assert.deepEqual(falsePositives, [], 'every normal hour of a week, across all tenants, endpoints and pairs');
});

test('flags the injected tenant cost spike (as a cost spike on that tenant)', () => {
  const hits = [];
  for (let h = T - 60 * HOUR; h < T - 57 * HOUR; h += HOUR) hits.push(...det.evaluate(h + HOUR).candidates.filter((c) => c.kind === 'cost_spike' && c.tenant_id === 'globex' && c.endpoint === null));
  assert.equal(hits.length, 3, 'flagged in each hour of the anomaly');
  const c = hits[0];
  assert.ok(c.observed / c.baseline > 3, `observed ${c.observed} vs baseline ${c.baseline}`);
  assert.ok(c.score >= 4);
  assert.match(c.explanation, /Tenant globex spent \$\d/);
  assert.match(c.explanation, /robust z/);
});

test('flags the endpoint whose tokens per request triple (prompt bloat, traffic flat)', () => {
  const hits = [];
  for (let h = T - 40 * HOUR; h < T - 37 * HOUR; h += HOUR) hits.push(...det.evaluate(h + HOUR).candidates.filter((c) => c.kind === 'tokens_per_request' && c.endpoint === '/v1/chat' && c.tenant_id === null));
  assert.equal(hits.length, 3);
  for (const c of hits) assert.ok(c.observed / c.baseline > 2.5 && c.observed / c.baseline < 3.6, `tokens/request ratio ${c.observed / c.baseline}`);
  assert.match(hits[0].explanation, /prompt bloat/);
  assert.match(hits[0].explanation, /traffic is [01]\.\d×/);
});

test('flags the retry storm: a volume spike dominated by 429/5xx is labelled retry_storm and names the hot pair', () => {
  const hits = [];
  for (let h = T - 20 * HOUR; h < T - 17 * HOUR; h += HOUR) hits.push(...det.evaluate(h + HOUR).candidates.filter((c) => c.kind === 'retry_storm'));
  assert.ok(hits.length >= 3);
  assert.ok(hits.some((c) => c.endpoint === '/v1/classify'));
  const c = hits.find((x) => x.endpoint === '/v1/classify');
  assert.ok(c.detail.error_share >= 0.3, `error share ${c.detail.error_share}`);
  assert.match(c.explanation, /retry storm/);
  assert.match(c.explanation, /acme/);
});

test('a partial hour is judged by projecting it to a full hour once enough of it has elapsed', () => {
  const stormHour = T - 19 * HOUR;
  const late = det.evaluate(stormHour + 40 * 60_000); // 2/3 into the hour
  assert.equal(late.hour, stormHour);
  assert.ok(Math.abs(late.fraction - 2 / 3) < 1e-9);
  assert.ok(late.candidates.some((c) => c.kind === 'retry_storm'), 'projected storm is caught mid-hour');
  assert.match(late.candidates.find((c) => c.kind === 'retry_storm').explanation, /projected from 67% of the hour/);
  const early = det.evaluate(stormHour + 5 * 60_000); // 8% in: too early, judge the previous complete hour instead
  assert.equal(early.hour, stormHour - HOUR);
  assert.equal(early.fraction, 1);
});

test('severity is derived from the robust z-score and the observed/baseline ratio', () => {
  assert.equal(severityOf({ score: 4.2, observed: 1.6, baseline: 1 }), 'medium');
  assert.equal(severityOf({ score: 9, observed: 2, baseline: 1 }), 'high');
  assert.equal(severityOf({ score: 6, observed: 3.2, baseline: 1 }), 'high');
  assert.equal(severityOf({ score: 20, observed: 4, baseline: 1 }), 'critical');
  assert.equal(severityOf({ score: 5, observed: 6, baseline: 1 }), 'critical');
});

/* ---------------- controlled synthetic scenarios for the guards ---------------- */

/** days of flat history for one tenant/endpoint, then an "incident" hour. Deterministic: no noise at all. */
function scenario({ baseReq = 60, spikeReq = 60, model = 'claude-haiku-5-5', baseIn = 1000, baseOut = 100, spikeIn = baseIn, spikeOut = baseOut, days = 9, otherTenants = true }) {
  const d = openDb();
  seedPrices(d);
  const i = new Ingestor(d, new PriceBook(d));
  const H = T;
  const push = (ts0, n, tin, tout, tenant = 'solo') => {
    const reqs = [];
    for (let k = 0; k < n; k++) reqs.push(mkRequest({ ts: ts0 + Math.floor((k * HOUR) / n), tenant, endpoint: '/v1/x', calls: [{ model, input_tokens: tin, output_tokens: tout }], id: `${tenant}-${ts0}-${k}` }));
    for (let a = 0; a < reqs.length; a += 500) i.ingest({ requests: reqs.slice(a, a + 500) });
  };
  for (let day = days; day >= 1; day--) for (let h = 0; h < 24; h++) push(H - day * DAY + h * HOUR, baseReq, baseIn, baseOut);
  for (let h = 0; h < 24; h++) push(H + h * HOUR, h === 0 ? spikeReq : baseReq, h === 0 ? spikeIn : baseIn, h === 0 ? spikeOut : baseOut);
  return { db: d, det: new Detector(d), asOf: H + HOUR };
}

test('minimum-volume guard: a spike on a low-volume entity is not judged', () => {
  const quiet = scenario({ baseReq: 4, spikeReq: 24 }); // x6 traffic but only 24 requests
  assert.deepEqual(quiet.det.evaluate(quiet.asOf).candidates.map(label), []);
  const loud = scenario({ baseReq: 4, spikeReq: 90 });
  const kinds = loud.det.evaluate(loud.asOf).candidates.map((c) => c.kind);
  assert.ok(kinds.includes('volume_spike'), `expected a volume spike, got ${kinds}`);
});

test('minimum absolute-cost floor: a x4 tokens/request jump on a few-cent endpoint is ignored, on a real-money one it alerts', () => {
  const cheap = scenario({ model: 'claude-haiku-5-5', baseIn: 200, baseOut: 20, spikeIn: 800, spikeOut: 80 }); // ~ $0.03 / hour even after the jump
  assert.ok(cheap.db.prepare('SELECT SUM(cost_micro_usd) AS c FROM rollups_hourly WHERE hour = ?').get(T).c < DETECTOR_DEFAULTS.minCostMicro);
  assert.deepEqual(cheap.det.evaluate(cheap.asOf).candidates.map(label), []);
  const real = scenario({ model: 'claude-sonnet-5-5', baseIn: 1000, baseOut: 100, spikeIn: 4000, spikeOut: 400 });
  const found = real.det.evaluate(real.asOf).candidates.map((c) => c.kind);
  assert.ok(found.includes('tokens_per_request'), `got ${found}`);
});

test('traffic growth alone does not trip the per-request detectors (and flat noise-free history is quiet)', () => {
  const s = scenario({ baseReq: 60, spikeReq: 60 });
  assert.deepEqual(s.det.evaluate(s.asOf).candidates, []);
  const grow = scenario({ baseReq: 60, spikeReq: 160 });
  const kinds = grow.det.evaluate(grow.asOf).candidates.map((c) => c.kind);
  assert.ok(kinds.includes('volume_spike'));
  assert.ok(!kinds.includes('tokens_per_request') && !kinds.includes('cost_per_request'));
});

test('not enough history: stays silent until at least minBaselineDays of the same hour exist', () => {
  const s = scenario({ baseReq: 60, spikeReq: 300, days: 2 });
  const r = s.det.evaluate(s.asOf);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.skipped, 'not enough history');
});

test('cost-per-request jump with flat traffic (model mix / caching change) is reported as cost_per_request or tokens_per_request', () => {
  // output tokens x5 only: tokens/request rises mildly but cost/request rises a lot
  const s = scenario({ model: 'claude-sonnet-5-5', baseIn: 1000, baseOut: 100, spikeIn: 1000, spikeOut: 700 });
  const found = s.det.evaluate(s.asOf).candidates;
  assert.ok(found.some((c) => c.kind === 'cost_per_request' || c.kind === 'tokens_per_request'), `got ${found.map(label)}`);
});

/* ---------------- persistence: cooldown, ack, resolve (writes to the shared DB, so keep these last) ---------------- */

test('alerts store observed, baseline, score and a plain-English explanation; the cooldown de-duplicates', () => {
  const d = new Detector(db, { cooldownMs: 90 * 60_000 });
  const t1 = T - 40 * HOUR + HOUR; // end of the first token-bloat hour
  const a = d.run(t1);
  const bloat = a.inserted.find((x) => x.kind === 'tokens_per_request' && x.endpoint === '/v1/chat');
  assert.ok(bloat, 'inserted a prompt-bloat alert');
  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(bloat.id);
  assert.equal(row.status, 'open');
  assert.ok(row.observed > row.baseline && row.baseline > 0 && row.score >= 4);
  assert.ok(row.explanation.length > 40 && row.explanation.length < 600);
  assert.equal(row.ts, t1);

  // same anomaly an hour later: inside the cooldown -> suppressed, nothing new for that key
  const b = d.run(t1 + HOUR);
  assert.ok(!b.inserted.some((x) => x.kind === 'tokens_per_request' && x.endpoint === '/v1/chat'));
  assert.ok(b.suppressed >= 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'tokens_per_request' AND endpoint = '/v1/chat'").get().n, 1);

  // two hours later: the cooldown (90 min) has expired and the anomaly is still going -> a fresh alert
  const c = d.run(t1 + 2 * HOUR);
  assert.ok(c.inserted.some((x) => x.kind === 'tokens_per_request' && x.endpoint === '/v1/chat'), 'alerts again once the cooldown has passed');
});

test('acknowledge and resolve', () => {
  const [first] = listAlerts(db, { status: 'open', limit: 1 });
  assert.ok(first);
  assert.equal(setAlertStatus(db, first.id, 'ack').status, 'ack');
  assert.equal(setAlertStatus(db, first.id, 'ack').status, 'ack', 'idempotent');
  assert.equal(setAlertStatus(db, first.id, 'resolved').status, 'resolved');
  assert.throws(() => setAlertStatus(db, first.id, 'ack'), AlertStateError);
  assert.equal(setAlertStatus(db, first.id, 'resolved').status, 'resolved', 'resolving twice is idempotent');
  assert.equal(setAlertStatus(db, 999999, 'ack'), null);
  const [second] = listAlerts(db, { status: 'open', limit: 1 });
  assert.equal(setAlertStatus(db, second.id, 'resolved').status, 'resolved', 'resolve straight from open');
  assert.ok(!listAlerts(db, { status: 'active' }).some((a) => a.id === first.id || a.id === second.id));
});
