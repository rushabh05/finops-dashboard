// What does the detector do on a real (imported) database? Reproduces the numbers quoted in the README.
//
//   npm run eval:real -- data/burstgpt.db [--days 54] [--examples 8]
//
// It works on a COPY of the database (VACUUM INTO a temp file, deleted afterwards), clears that copy's alerts, replays the detector
// hour by hour over the last --days of the data's own clock, and summarises the alerts: how many, of what kind and grain, how large
// (observed / baseline, robust z), how many have a near-zero baseline, and how bursty the underlying hourly volume is.
// There are no labels, so this says how OFTEN and how LOUDLY the detector fires, not whether it is right.
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { backfillDetection } from '../src/import/common.js';
import { DAY } from '../src/util.js';

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { days: { type: 'string' }, examples: { type: 'string', default: '8' }, help: { type: 'boolean', short: 'h' } } });
if (a.help || positionals.length !== 1) { console.log('usage: npm run eval:real -- <imported.db> [--days N] [--examples N]'); process.exit(a.help ? 0 : 1); }
const src = resolve(positionals[0]);
if (!existsSync(src)) { console.error(`no such file: ${src}`); process.exit(1); }

const dir = mkdtempSync(join(tmpdir(), 'finops-evalreal-'));
const copy = join(dir, 'copy.db');
try {
  const ro = new DatabaseSync(src, { readOnly: true });
  ro.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  ro.close();
  const db = openDb(copy);
  db.exec('DELETE FROM alerts');
  const span = db.prepare('SELECT MIN(hour) AS a, MAX(hour) AS b FROM rollups_hourly').get();
  const spanDays = (span.b - span.a) / DAY;
  const days = a.days ? Number(a.days) : Math.max(1, Math.floor(spanDays) - 7);
  console.log(`${src}\n  data spans ${spanDays.toFixed(1)} days; evaluating the last ${days} (the detector needs >= 4 earlier days of the same hour as its baseline)`);
  const t0 = Date.now();
  const b = backfillDetection(db, { days });
  console.log(`  replayed in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${b.inserted} alerts after the 3-hour cooldown, from ${b.evaluated} candidate evaluations\n`);

  const rows = db.prepare('SELECT ts, hour, kind, tenant_id, endpoint, observed, baseline, score, explanation, detail FROM alerts ORDER BY ts').all();
  if (!rows.length) { console.log('no alerts'); process.exit(0); }
  const tally = (f) => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const sorted = (xs) => [...xs].sort((x, y) => x - y);
  const q = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];
  const perDay = tally((r) => new Date(r.hour).toISOString().slice(0, 10));
  const dayCounts = sorted(Object.values(perDay));
  console.log(`alerts: ${rows.length} = ${(rows.length / days).toFixed(1)} a day;  alerts on ${Object.keys(perDay).length} of ${days} days;  per day min ${dayCounts[0]}, median ${q(dayCounts, 0.5)}, max ${dayCounts[dayCounts.length - 1]}`);
  console.log('by kind     ', JSON.stringify(tally((r) => r.kind)));
  console.log('by grain    ', JSON.stringify(tally((r) => JSON.parse(r.detail).grain)));
  console.log('by endpoint ', JSON.stringify(tally((r) => r.endpoint ?? '(all)')));
  const dow = tally((r) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(r.hour).getUTCDay()]);
  console.log('by weekday  ', ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `${d} ${dow[d] || 0}`).join('  '));
  const hod = new Array(24).fill(0);
  for (const r of rows) hod[new Date(r.hour).getUTCHours()]++;
  console.log('by hour UTC ', hod.join(' '));
  const ratio = sorted(rows.map((r) => (r.baseline > 0 ? r.observed / r.baseline : Infinity)));
  const x = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}x` : 'baseline 0');
  const under2 = rows.filter((r) => r.observed / Math.max(r.baseline, 1e-9) < 2).length;
  const nearZero = rows.filter((r) => r.baseline <= 0.05 * r.observed).length;
  console.log(`size        observed / same-hour baseline: median ${x(q(ratio, 0.5))}, p10 ${x(q(ratio, 0.1))}, p90 ${x(q(ratio, 0.9))}; ${under2} alerts (${((under2 / rows.length) * 100).toFixed(0)}%) are under 2x`);
  console.log(`            ${nearZero} alerts (${((nearZero / rows.length) * 100).toFixed(0)}%) have a near-zero baseline (<= 5% of observed): activity where there was none`);
  const byKindZ = {};
  for (const r of rows) (byKindZ[r.kind] ||= []).push(r.score);
  console.log('robust z    ', Object.entries(byKindZ).map(([k, v]) => `${k} median ${q(sorted(v), 0.5).toFixed(1)}`).join(', '), '(threshold 4)');

  console.log('\nhow bursty is the traffic the detector sees? (requests per hour, over the hours with any traffic)');
  const perEndpoint = {};
  for (const r of db.prepare("SELECT endpoint, SUM(requests) AS r FROM rollups_hourly WHERE model = '' GROUP BY endpoint, hour").all()) (perEndpoint[r.endpoint] ||= []).push(r.r);
  for (const [endpoint, counts] of Object.entries(perEndpoint)) {
    const v = sorted(counts);
    console.log(`  ${endpoint.padEnd(28)} ${String(v.length).padStart(5)} hours   median ${q(v, 0.5)}   p99 ${q(v, 0.99)}   max ${v[v.length - 1]}   (p99/median ${(q(v, 0.99) / Math.max(1, q(v, 0.5))).toFixed(0)}x)`);
  }
  const n = Number(a.examples);
  if (n > 0) {
    console.log(`\n${n} strongest alerts:`);
    for (const r of [...rows].sort((x, y) => y.score - x.score).slice(0, n)) console.log(`  ${new Date(r.hour).toISOString().slice(0, 13)}h  ${r.kind.padEnd(18)} z=${(r.score >= 99 ? '>=99' : r.score.toFixed(1)).padStart(5)}  ${r.explanation.slice(0, 140)}`);
  }
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
