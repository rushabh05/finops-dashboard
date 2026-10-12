// Import a public LLM traffic trace (BurstGPT or an Azure LLM inference trace) into a dashboard database.
//
//   npm run import:trace -- data/datasets/burstgpt-v2.0/BurstGPT_1.csv
//   npm run import:trace -- data/datasets/azure-llm-2023/AzureLLMInferenceTrace_conv.csv --model claude-sonnet-5-5
//   DB_PATH=data/burstgpt.db npm start
//
// Real: request timing, token counts, API surface, failures. Assumed (and labelled in the UI): the tenant split
// (synthetic, skewed), prices (a price table), infrastructure cost (0). Timestamps are shifted by whole days to end near today.
import { parseArgs } from 'node:util';
import { resolve, basename } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scanBounds, traceRequests, makeTimeMap, makeTenantPicker, guessService, DEFAULT_MODEL_MAP } from '../src/import/traces.js';
import { createImportDb, BatchWriter, backfillDetection, finishImport, describeDb, fmtInt, fmtUsd, DAY } from '../src/import/common.js';
import { parsePriceArg } from '../src/import/prices.js';
import { verifyRollups } from '../src/ingest.js';
import { listAlerts } from '../src/alerts.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    format: { type: 'string', default: 'auto' },
    service: { type: 'string' },
    db: { type: 'string' },
    replace: { type: 'boolean', default: false },
    tenants: { type: 'string', default: '8' },
    skew: { type: 'string', default: '1' },
    seed: { type: 'string', default: '42' },
    sample: { type: 'string', default: '1' },
    days: { type: 'string' },
    end: { type: 'string', default: 'now' },
    'start-date': { type: 'string' },
    model: { type: 'string', default: 'claude-sonnet-5-5' },
    'model-map': { type: 'string' },
    price: { type: 'string', multiple: true, default: [] },
    'detect-days': { type: 'string', default: '7' },
    'no-verify': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
const usage = `usage: npm run import:trace -- <trace.csv> [--format auto|burstgpt|azure] [--service code|conv] [--db FILE] [--replace]
         [--tenants N] [--skew S] [--seed N] [--sample P] [--days N] [--end now|keep|ISO] [--start-date YYYY-MM-DD]
         [--model NAME] [--model-map ChatGPT=claude-haiku-5-5,GPT-4=claude-sonnet-5-5] [--price MODEL=in,out]
         [--detect-days N] [--no-verify]`;
if (a.help || positionals.length !== 1) { console.log(usage); process.exit(a.help ? 0 : 1); }

const file = resolve(positionals[0]);
if (!existsSync(file)) { console.error(`no such file: ${file}`); process.exit(1); }
const fail = (m) => { console.error(m); process.exit(1); };
const num = (name, v, { min = -Infinity, max = Infinity, int = false } = {}) => { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) fail(`bad --${name} "${v}"`); return n; };
const tenants = num('tenants', a.tenants, { min: 1, max: 64, int: true });
const skew = num('skew', a.skew, { min: 0, max: 5 });
const seed = num('seed', a.seed, { int: true });
const sample = num('sample', a.sample, { min: 0.0001, max: 1 });
const detectDays = num('detect-days', a['detect-days'], { min: 0 });
let overrides, modelMap = { ...DEFAULT_MODEL_MAP };
try {
  overrides = a.price.map(parsePriceArg);
  if (a['model-map']) for (const pair of a['model-map'].split(',')) { const [k, v] = pair.split('='); if (!k || !v) throw new Error(`bad --model-map entry "${pair}"`); modelMap[k.trim().toLowerCase()] = v.trim(); }
} catch (e) { fail(e.message); }

const out = (s = '') => console.log(s);
const t0 = Date.now();
out(`Trace import  ${file}  (${(statSync(file).size / 1e6).toFixed(1)} MB)`);
const bounds = await scanBounds(file, a.format);
const format = bounds.format;
const service = format === 'azure' ? (a.service ?? guessService(basename(file))) : 'burstgpt';
if (!bounds.count) fail('no usable rows in this file');
let timeMap;
try { timeMap = makeTimeMap({ bounds, end: a.end, startDate: a['start-date'] }); } catch (e) { fail(e.message); }
const day = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const spanDays = (bounds.max - bounds.min) / DAY;
out(`  format ${format}${format === 'azure' ? ` (${service})` : ''}: ${fmtInt(bounds.count)} rows spanning ${spanDays.toFixed(2)} days`);
out(`  shifted to ${day(timeMap(bounds.min))} .. ${day(timeMap(bounds.max))} UTC (whole-day shift: hour-of-day and weekday phase are kept)`);
const keepFromTs = a.days ? timeMap(bounds.max) - num('days', a.days, { min: 0.01 }) * DAY : -Infinity;

const pretty = format === 'burstgpt' ? 'BurstGPT' : `Azure LLM inference trace (${service})`;
const priceBasis = format === 'burstgpt' ? 'prices are assumed mid-2023 list prices' : `every call is priced as ${a.model}`;
const dbPath = a.db ? resolve(a.db) : resolve(ROOT, 'data', format === 'burstgpt' ? 'burstgpt.db' : `azure-${service}.db`);
let imp;
try {
  imp = createImportDb({
    path: dbPath, replace: a.replace, priceOverrides: overrides, maxCallsPerRequest: 20,
    source: `import:trace:${format === 'burstgpt' ? 'burstgpt' : `azure-${service}`}`,
    note: `Public trace: ${pretty}. Request timing and token counts are real; tenants are SYNTHETIC buckets (the trace has no customer id), ${priceBasis}, infrastructure cost is 0, and timestamps are shifted by whole days to end near today.`,
  });
} catch (e) { fail(e.message); }

const stats = { rows: 0, kept: 0, failed: 0, sampledOut: 0, outOfWindow: 0 };
const w = new BatchWriter(imp.ingestor);
for await (const r of traceRequests(file, { format, service, model: a.model, modelMap, tenants, skew, seed, sample, keepFromTs, timeMap, stats })) w.add(r);
w.flush();
finishImport(imp);

const d = describeDb(imp.db);
out();
out(`Imported ${fmtInt(w.accepted)} requests / ${fmtInt(w.llmCalls)} LLM calls  ${day(d.from)} .. ${day(d.to)}   -> ${dbPath}`);
if (stats.sampledOut) out(`  --sample ${sample}: ${fmtInt(stats.sampledOut)} rows left out (volumes and cost are scaled down by the same factor)`);
if (stats.outOfWindow) out(`  ${fmtInt(stats.outOfWindow)} rows older than --days ${a.days} left out`);
if (stats.failed) out(`  ${fmtInt(stats.failed)} failed requests (0 response tokens): recorded as status 500 with no LLM call and no cost  (${((stats.failed / Math.max(1, stats.kept)) * 100).toFixed(2)}%)`);
out(`  API-style cost  ${fmtUsd(d.llm_cost_micro)}   tokens in ${fmtInt(d.tokens_in)} / out ${fmtInt(d.tokens_out)}`);
const hours = imp.db.prepare('SELECT SUM(requests) AS r FROM rollups_hourly GROUP BY hour').all().map((r) => r.r).sort((x, y) => x - y);
if (hours.length) out(`  requests per hour: min ${fmtInt(hours[0])}, median ${fmtInt(hours[hours.length >> 1])}, max ${fmtInt(hours[hours.length - 1])}  (${hours.length} hours)`);
const tp = makeTenantPicker({ count: tenants, skew, seed });
out(`  synthetic tenant shares: ${tp.names.slice(0, 4).map((n, i) => `${n} ${(tp.shares[i] * 100).toFixed(0)}%`).join(', ')}${tenants > 4 ? ', ...' : ''}   (skew ${skew})`);
const list = (rows, withRequests) => rows.map((r) => `    ${String(r.key).padEnd(22)} ${fmtUsd(r.cost).padStart(11)}${withRequests ? `  ${fmtInt(r.requests)} requests` : ''}`).join('\n');
out('  endpoints\n' + list(d.endpoints, true));
out('  models\n' + list(d.models.filter((m) => m.key !== '(infra)'), false));
if (w.rejected) out(`  ! ${fmtInt(w.rejected)} requests rejected by validation, e.g. ${w.rejectSamples.join(' | ')}`);

if (!a['no-verify']) {
  const t1 = Date.now();
  const diffs = verifyRollups(imp.db);
  out(`Rollups vs brute-force recomputation: ${diffs.length === 0 ? 'consistent' : `MISMATCH (${diffs.length} differences)`}  (${((Date.now() - t1) / 1000).toFixed(1)} s)`);
  if (diffs.length) process.exitCode = 2;
}

if (detectDays > 0) {
  const t1 = Date.now();
  const b = backfillDetection(imp.db, { days: detectDays });
  const kinds = Object.entries(b.byKind).map(([k, n]) => `${n} ${k}`).join(', ');
  out(`Detector over the last ${detectDays} days of the trace (${((Date.now() - t1) / 1000).toFixed(1)} s): ${b.inserted} alerts${kinds ? ` (${kinds})` : ''}${b.skipped ? ` [${b.skipped}]` : ''}`);
  for (const al of listAlerts(imp.db, { status: 'all', limit: 6 })) out(`    ${new Date(al.hour ?? al.ts).toISOString().slice(0, 13)}h  ${al.kind.padEnd(18)} z=${al.score.toFixed(1)}  ${al.explanation.slice(0, 150)}`);
}
finishImport(imp);
imp.db.close();
out();
out(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s.  View it:  DB_PATH=${dbPath} npm start`);
