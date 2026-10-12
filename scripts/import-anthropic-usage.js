// Import your ORGANIZATION's token usage from Anthropic's Usage & Cost Admin API into a dashboard database, and check it against the bill.
//
//   ANTHROPIC_ADMIN_KEY=sk-ant-admin01-... finops import anthropic-usage [--days 30] [--bucket 1h|1d] [--tenant-by workspace|api-key|account|service-account]
//                                           [--db FILE] [--replace] [--since YYYY-MM-DD] [--base-url URL] [--price MODEL=in,out,...] [--no-cost-check] [--no-verify]
//
// Needs an organization ADMIN API key (the endpoints do not exist for individual accounts; workspace API keys do not work). The key is read from the
// environment only and goes nowhere but the `x-api-key` header of requests to --base-url (https://api.anthropic.com).
//
// This is aggregated data: one row per hour and (workspace, model, service tier, context window), NOT one row per API call. Request counts, latency and
// per-request metrics mean nothing on it, so detection is skipped; spend by workspace and model is exactly right (tokens x price), and the cost report
// (what Anthropic actually billed) is used to check the prices. Batch, priority, flex and long-context usage is priced at standard rates and flagged.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { AdminClient, AdminApiError, BUCKETS, TENANT_DIMENSIONS, buildRequests, costParams, crossCheck, usageParams } from '../src/import/anthropic-usage.js';
import { createImportDb, BatchWriter, finishImport, describeDb, fmtInt, fmtUsd, DAY, HOUR, usagePrefix, viewHint } from '../src/import/common.js';
import { parsePriceArg } from '../src/import/prices.js';
import { verifyRollups } from '../src/ingest.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = process.env.DATA_DIR || resolve(ROOT, 'data'); // same default as the server, so `finops start` finds what was imported
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
let a;
try {
  ({ values: a } = parseArgs({ options: {
    days: { type: 'string', default: '30' }, since: { type: 'string' }, bucket: { type: 'string', default: '1h' }, 'tenant-by': { type: 'string', default: 'workspace' },
    db: { type: 'string', default: resolve(DATA_DIR, 'anthropic-usage.db') }, replace: { type: 'boolean', default: false },
    'base-url': { type: 'string', default: 'https://api.anthropic.com' }, price: { type: 'string', multiple: true, default: [] },
    'no-cost-check': { type: 'boolean', default: false }, 'no-verify': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  } }));
} catch (e) { console.error(`${e.message}\n`); a = { help: true, bad: true }; }
const usage = `usage: ${usagePrefix('anthropic-usage')} [--days 30 | --since YYYY-MM-DD] [--bucket 1h|1d] [--tenant-by workspace|api-key|account|service-account]
                                    [--db FILE] [--replace] [--price MODEL=in,out[,read[,write5m[,write1h]]]] [--no-cost-check] [--no-verify]
  needs ANTHROPIC_ADMIN_KEY in the environment: an organization Admin API key (sk-ant-admin01-...). Individual accounts do not have one.`;
if (a.help) { console.log(usage); process.exit(a.bad ? 2 : 0); }
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };

if (!BUCKETS[a.bucket]) fail(`--bucket must be 1h or 1d\n${usage}`);
if (!TENANT_DIMENSIONS[a['tenant-by']]) fail(`--tenant-by must be one of ${Object.keys(TENANT_DIMENSIONS).join(', ')}`);
const adminKey = process.env.ANTHROPIC_ADMIN_KEY || '';
if (!adminKey) fail(`ANTHROPIC_ADMIN_KEY is not set. It must be an organization Admin API key (sk-ant-admin01-...); individual accounts have none.\n${usage}`);
let overrides;
try { overrides = a.price.map(parsePriceArg); } catch (e) { fail(e.message); }

const now = Date.now();
const today = Math.floor(now / DAY) * DAY;
let fromMs;
if (a.since) { fromMs = Date.parse(`${a.since}T00:00:00Z`); if (!Number.isFinite(fromMs)) fail(`bad --since "${a.since}" (expected YYYY-MM-DD)`); }
else { const n = Number(a.days); if (!(n >= 1 && n <= 366)) fail(`bad --days "${a.days}" (1..366)`); fromMs = today - n * DAY; }
fromMs = Math.floor(fromMs / DAY) * DAY; // whole UTC days, so the bill (daily) lines up
const toMs = Math.floor(now / BUCKETS[a.bucket].ms) * BUCKETS[a.bucket].ms;
if (fromMs >= toMs) fail('--since is in the future');

const out = (s = '') => console.log(s);
const t0 = Date.now();
let client;
try { client = new AdminClient({ baseUrl: a['base-url'], adminKey, userAgent: `finops-dashboard/${pkg.version} (${pkg.homepage})` }); } catch (e) { fail(e.message); }
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

out(`Anthropic usage import  (${new URL(a['base-url']).host}, ${day(fromMs)} .. ${day(toMs)}, ${a.bucket} buckets, tenant = ${a['tenant-by']})`);
const buckets = [];
try {
  for await (const b of client.pages('/v1/organizations/usage_report/messages', usageParams({ fromMs, toMs, bucket: a.bucket, tenantBy: a['tenant-by'] }), { onPage: (n, count) => { if (n === 1 || n % 5 === 0) process.stderr.write(`  page ${n}: ${count} buckets\n`); } })) buckets.push(b);
} catch (e) { fail(e instanceof AdminApiError ? `  ${e.message}` : e.message, 1); }
out(`  read ${fmtInt(buckets.length)} time buckets in ${client.requests} request${client.requests === 1 ? '' : 's'}`);
if (!buckets.length) fail('  the report is empty for this period: nothing to import', 1);

let imp;
try {
  imp = createImportDb({
    path: a.db, replace: a.replace, priceOverrides: overrides, maxCallsPerRequest: 20,
    source: 'import:anthropic-usage',
    note: `Imported from Anthropic's Usage & Cost Admin API: token usage by ${a['tenant-by']}, priced at list prices. Each row is one ${a.bucket === '1h' ? 'hour' : 'day'} of one (${a['tenant-by']}, model, service tier, context window) group, NOT one API call: request counts, latency and per-request metrics are not meaningful, so no anomaly detection is run. Batch, priority and long-context usage is priced at standard rates; web search and code execution fees are not included.`,
  });
} catch (e) { fail(e.message, 1); }

const built = buildRequests(buckets, { tenantBy: a['tenant-by'], priceBook: imp.priceBook });
const w = new BatchWriter(imp.ingestor);
for (const r of built.requests) w.add(r);
w.flush();
finishImport(imp);
const d = describeDb(imp.db);
out();
out(`Imported ${fmtInt(w.accepted)} usage rows   ${day(d.from)} .. ${day(d.to)}   -> ${a.db}`);
out(`  list-price cost  ${fmtUsd(d.llm_cost_micro)}   tokens in ${fmtInt(d.tokens_in)} / out ${fmtInt(d.tokens_out)}   (${fmtInt(built.emptyBuckets)} empty ${a.bucket} buckets skipped)`);
const list = (rows, fmt) => rows.map((r) => `    ${fmt(r)}`).join('\n');
out(`  top ${a['tenant-by']}s\n` + list(d.tenants, (r) => `${r.key.padEnd(46)} ${fmtUsd(r.cost).padStart(9)}`));
out('  models\n' + list(d.models, (r) => `${r.key.padEnd(46)} ${fmtUsd(r.cost).padStart(9)}`));
if (w.rejected) out(`  ! ${w.rejected} rows were rejected by validation, e.g. ${w.rejectSamples.join(' | ')}`);
for (const [m, n] of built.unpriced) out(`  ! ${fmtInt(n)} tokens of "${m}" were skipped: no price known (add one with --price ${m}=in,out,read,write5m,write1h)`);
for (const [k, n] of built.nonStandard) out(`  ! ${fmtInt(n)} tokens in tier / context "${k}" are priced at standard rates (the bill may differ: see the check below)`);
if (built.webSearches) out(`  ! ${fmtInt(built.webSearches)} server-side web searches: those per-search fees are not included`);

let exit = 0;
out();
if (a['no-cost-check']) out('Cost check skipped (--no-cost-check).');
else {
  try {
    const cutoff = Math.min(today, toMs); // complete days only: today's bill is still being written
    if (cutoff <= fromMs) out('Cost check: the period has no complete day yet.');
    else {
      const cost = [];
      for await (const b of client.pages('/v1/organizations/cost_report', costParams({ fromMs, toMs: cutoff }))) cost.push(b);
      const rows = crossCheck(imp.db, cost, { fromMs, toMs: cutoff });
      out(`Check against what Anthropic billed (cost report, token costs, ${day(fromMs)} .. ${day(cutoff - 1)}, complete days):`);
      const std = rows.filter((r) => r.tier === 'standard' && r.billedUsd !== null);
      const sum = (xs, k) => xs.reduce((s, r) => s + r[k], 0);
      if (std.length) {
        const ratio = sum(std, 'computedUsd') / sum(std, 'billedUsd');
        out(`  standard tier: computed $${sum(std, 'computedUsd').toFixed(2)} vs billed $${sum(std, 'billedUsd').toFixed(2)}  (ratio ${ratio.toFixed(4)})`);
        if (Math.abs(ratio - 1) > 0.02) out('  ! more than 2% apart: a price in src/import/prices.js is out of date, or the long-context / fast / data-residency premiums apply. Compare the models below.');
      } else out('  no standard-tier usage to compare.');
      for (const r of rows.slice(0, 12)) {
        out(`    ${(r.model + (r.tier === 'standard' ? '' : ` [${r.tier}]`)).padEnd(46)} computed ${fmtUsd(r.computedUsd * 1e6).padStart(9)}   billed ${r.billedUsd === null ? '      n/a' : fmtUsd(r.billedUsd * 1e6).padStart(9)}   ${r.ratio === null ? '' : `x${r.ratio.toFixed(3)}`}`);
      }
      out('  (billed excludes Priority Tier, which the cost report does not cover; non-standard tiers are expected to differ because they are priced at standard rates here.)');
    }
  } catch (e) { out(`Cost check failed: ${e.message}. The import itself is complete.`); }
}

if (!a['no-verify']) {
  const diffs = verifyRollups(imp.db);
  out(`Rollups vs brute-force recomputation: ${diffs.length === 0 ? 'consistent' : `MISMATCH (${diffs.length} differences)`}`);
  if (diffs.length) exit = 2;
}
finishImport(imp);
imp.db.close();
out();
out(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s.  View it:  ${viewHint(a.db, DATA_DIR)}`);
process.exitCode = exit;
