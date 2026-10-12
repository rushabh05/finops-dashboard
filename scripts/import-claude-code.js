// Import your own Claude Code usage (~/.claude/projects/**/*.jsonl) into a dashboard database.
//
//   npm run import:claude-code -- [--db data/claude-code.db] [--replace] [--days 30] [--since 2026-09-01]
//                                 [--root ~/.claude/projects] [--detect-days 7] [--price model=in,out,read,w5,w1] [--no-verify]
//   DB_PATH=data/claude-code.db npm start        # then open http://127.0.0.1:8787
//
// Only usage metadata is read (model, token counts, timestamps, project folder, agent type): never message text.
// Costs are API-EQUIVALENT list prices - on a flat-rate plan this is what the tokens would have cost, not your bill.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanTranscripts, buildRequests, findTranscripts, DEFAULT_ROOT } from '../src/import/claude-code.js';
import { createImportDb, BatchWriter, backfillDetection, finishImport, describeDb, fmtInt, fmtUsd, DAY, usagePrefix, viewHint } from '../src/import/common.js';
import { parsePriceArg } from '../src/import/prices.js';
import { verifyRollups } from '../src/ingest.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = process.env.DATA_DIR || resolve(ROOT, 'data'); // same default as the server, so `finops start` finds what was imported
const { values: a } = parseArgs({
  options: {
    root: { type: 'string', default: DEFAULT_ROOT },
    db: { type: 'string', default: resolve(DATA_DIR, 'claude-code.db') },
    replace: { type: 'boolean', default: false },
    days: { type: 'string' },
    since: { type: 'string' },
    'detect-days': { type: 'string', default: '7' },
    price: { type: 'string', multiple: true, default: [] },
    'no-verify': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (a.help) {
  console.log(`usage: ${usagePrefix('claude-code')} [--db FILE] [--replace] [--days N | --since YYYY-MM-DD] [--root DIR]
                                       [--detect-days N] [--price MODEL=in,out[,read[,write5m[,write1h]]]] [--no-verify]`);
  process.exit(0);
}

const out = (s = '') => console.log(s);
const t0 = Date.now();
const files = findTranscripts(a.root);
if (!files.length) { console.error(`no .jsonl transcripts found under ${a.root}`); process.exit(1); }

out(`Claude Code import  (${a.root})`);
const scan = await scanTranscripts({ root: a.root, files });
const s = scan.stats;
out(`  read ${fmtInt(s.files)} files, ${fmtInt(s.lines)} lines${s.badLines ? ` (${s.badLines} unreadable)` : ''}`);
out(`  ${fmtInt(s.assistantLines)} assistant lines -> ${fmtInt(scan.messages.size)} API responses`);
out(`    (${fmtInt(s.duplicateLines)} repeated streaming lines and ${fmtInt(s.crossFileDuplicates)} lines copied into forked/resumed sessions were counted once; ${fmtInt(s.syntheticErrors)} client-side API errors carry no tokens)`);

let sinceTs = 0;
const newest = Math.max(...[...scan.messages.values()].map((m) => m.ts));
if (a.since) {
  sinceTs = Date.parse(`${a.since}T00:00:00Z`);
  if (!Number.isFinite(sinceTs)) { console.error(`bad --since "${a.since}" (expected YYYY-MM-DD)`); process.exit(1); }
} else if (a.days) {
  const n = Number(a.days);
  if (!(n > 0)) { console.error(`bad --days "${a.days}"`); process.exit(1); }
  sinceTs = newest - n * DAY;
}

let overrides;
try { overrides = a.price.map(parsePriceArg); } catch (e) { console.error(e.message); process.exit(1); }

let imp;
try {
  imp = createImportDb({
    path: a.db, replace: a.replace, priceOverrides: overrides, maxCallsPerRequest: 20_000,
    source: 'import:claude-code',
    note: 'Imported Claude Code usage. Cost is the API-equivalent list price of the tokens (a flat-rate plan is not billed per token). Tenants are project folders; requests are prompts and sub-agent runs.',
  });
} catch (e) { console.error(e.message); process.exit(1); }

const built = buildRequests(scan, { priceBook: imp.priceBook, sinceTs });
const w = new BatchWriter(imp.ingestor);
for (const r of built.requests) w.add(r);
w.flush();
finishImport(imp);

const d = describeDb(imp.db);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
out();
out(`Imported ${fmtInt(w.accepted)} requests / ${fmtInt(w.llmCalls)} LLM calls  ${day(d.from)} .. ${day(d.to)}   -> ${a.db}`);
if (built.skippedBefore) out(`  (${fmtInt(built.skippedBefore)} responses older than the --days/--since window were left out)`);
out(`  API-equivalent cost  ${fmtUsd(d.llm_cost_micro)}   tokens in ${fmtInt(d.tokens_in)} / out ${fmtInt(d.tokens_out)}`);
const callsPer = imp.db.prepare('SELECT request_id, COUNT(*) AS n FROM llm_calls GROUP BY request_id').all().map((r) => r.n).sort((x, y) => x - y);
if (callsPer.length) out(`  LLM calls per request: median ${callsPer[callsPer.length >> 1]}, p95 ${callsPer[Math.floor(callsPer.length * 0.95)]}, max ${callsPer[callsPer.length - 1]}`);
const list = (rows, fmt) => rows.map((r) => `    ${fmt(r)}`).join('\n');
out('  top tenants (project folders)\n' + list(d.tenants, (r) => `${r.key.padEnd(46)} ${fmtUsd(r.cost).padStart(9)}  ${fmtInt(r.requests)} requests`));
out('  endpoints\n' + list(d.endpoints, (r) => `${r.key.padEnd(46)} ${fmtUsd(r.cost).padStart(9)}  ${fmtInt(r.requests)} requests`));
out('  models\n' + list(d.models, (r) => `${r.key.padEnd(46)} ${fmtUsd(r.cost).padStart(9)}`));
if (w.rejected) out(`  ! ${w.rejected} requests were rejected by validation, e.g. ${w.rejectSamples.join(' | ')}`);
for (const [m, n] of built.unpriced) out(`  ! ${fmtInt(n)} responses from "${m}" were skipped: no price known (add one with --price ${m}=in,out,read,write5m,write1h)`);
if (s.fastMode) out(`  ! ${fmtInt(s.fastMode)} responses used fast mode and are priced at standard rates (fast mode costs more)`);
if (s.webSearch) out(`  ! ${fmtInt(s.webSearch)} responses used server-side web search/fetch; those per-request fees are not included`);

const c = built.crossCheck;
out();
if (c.tokenExact) {
  const models = Object.entries(c.byModel).map(([m, v]) => `${m.replace(/^claude-/, '')} (${v.pairs})`).join(', ');
  out('Price check against the cost Claude Code recorded itself (its cost-state entries):');
  out(`  ${c.tokenExact} of ${c.compared} session x model pairs have token totals identical to Claude Code's: for those this import computes`);
  out(`  $${c.computedUsd.toFixed(4)} vs Claude Code's $${c.reportedUsd.toFixed(4)} (ratio ${c.ratio.toFixed(6)}, worst pair off by ${(c.maxRelError * 100).toFixed(4)}%)  models: ${models}`);
  out(`  The other ${c.compared - c.tokenExact} pairs are not comparable: Claude Code's counter covers only part of those sessions (resumes, forks, sub-agent usage).`);
} else out('Price check: no Claude Code cost records (cost-state) matched the imported sessions, so prices could not be cross-checked.');

if (!a['no-verify']) {
  const diffs = verifyRollups(imp.db);
  out(`Rollups vs brute-force recomputation: ${diffs.length === 0 ? 'consistent' : `MISMATCH (${diffs.length} differences)`}`);
  if (diffs.length) process.exitCode = 2;
}

const detectDays = Number(a['detect-days']);
if (detectDays > 0) {
  const b = backfillDetection(imp.db, { days: detectDays });
  const kinds = Object.entries(b.byKind).map(([k, n]) => `${n} ${k}`).join(', ');
  out(`Detector backfill over the last ${detectDays} days: ${b.inserted} alerts${kinds ? ` (${kinds})` : ''}${b.skipped ? ` [${b.skipped}]` : ''}`);
  out('  note: the detector expects steady, seasonal multi-tenant traffic; bursty personal usage has no daily rhythm, so treat these alerts as "unusually busy hour", not as incidents.');
}
finishImport(imp);
imp.db.close();
out();
out(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s.  View it:  ${viewHint(a.db, DATA_DIR)}`);
