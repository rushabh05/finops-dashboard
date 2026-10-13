// Import FastRouter's PAST requests into a dashboard database, so they can be browsed like everything else.
//
//   FASTROUTER_API_KEY=... finops import fastrouter --ids chat-ids.txt            # look each id up with FastRouter's /generation API
//   finops import fastrouter --file activity-log.csv [--map cost="Cost (USD)"]     # an Activity Log export, if you can get one (CSV / JSON / JSON lines)
//   finops import fastrouter --file export.csv --check                              # show how the columns were matched and 3 converted rows; write nothing
//
// FastRouter documents no endpoint that LISTS past requests, so a key alone cannot pull history: --ids needs the ids (each response's usage.chat_id,
// from your own logs), --file needs an export. The key is read from the environment only and goes nowhere but the Authorization header of requests to
// --base-url (https://api.fastrouter.ai). Prompts and completions are never read into the database: only token counts, cost, model, time and a hashed key.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { FastRouterError, GenerationClient, columnsOf, detectMapping, parseExport, parseIds, requestFromGeneration, requestFromRow, REQUIRED } from '../src/import/fastrouter.js';
import { createImportDb, BatchWriter, finishImport, describeDb, fmtInt, fmtUsd, usagePrefix, viewHint } from '../src/import/common.js';
import { verifyRollups } from '../src/ingest.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = process.env.DATA_DIR || resolve(ROOT, 'data');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
let a;
try {
  ({ values: a } = parseArgs({ options: {
    ids: { type: 'string' }, file: { type: 'string' }, map: { type: 'string', multiple: true, default: [] }, 'cost-scale': { type: 'string', default: '1' },
    'tenant-by': { type: 'string', default: 'key' }, 'tenant-raw': { type: 'boolean', default: false }, 'key-map': { type: 'string' },
    concurrency: { type: 'string', default: '4' }, 'retry-ms': { type: 'string', default: '1000' }, 'base-url': { type: 'string', default: 'https://api.fastrouter.ai' },
    db: { type: 'string', default: resolve(DATA_DIR, 'fastrouter.db') }, replace: { type: 'boolean', default: false }, append: { type: 'boolean', default: false },
    check: { type: 'boolean', default: false }, 'no-verify': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  } }));
} catch (e) { console.error(`${e.message}\n`); a = { help: true, bad: true }; }
const prefix = usagePrefix('fastrouter');
const usage = `usage: FASTROUTER_API_KEY=... ${prefix} --ids FILE|-   [--append] [--concurrency 4] [--retry-ms 1000] [--tenant-by key|provider|none]
       ${prefix} --file EXPORT.csv|.json|.jsonl   [--map FIELD=COLUMN ...] [--cost-scale 1] [--tenant-raw] [--check]
                          common: [--db FILE] [--replace | --append] [--key-map FILE] [--no-verify]

  --ids FILE   one FastRouter request id per line, or comma-separated (the usage.chat_id of a response; "-" reads standard input). Each is looked up with POST /api/v1/generation,
               which needs FASTROUTER_API_KEY in the environment. FastRouter has no call that lists past requests: the ids have to come from you.
  --file F     an Activity Log export. Columns are matched by name; fields: ${Object.keys({ id: 1, ts: 1, model: 1, input: 1, output: 1, cached: 1, cost: 1, tenant: 1, endpoint: 1, status: 1, latency: 1 }).join(', ')}
               (required: ${REQUIRED.join(', ')}). --map cost="Cost (USD)" names one by hand; --cost-scale 0.01 if the cost is in cents. The tenant column is
               hashed unless you pass --tenant-raw (for a column of key NAMES). --check prints the matching and three converted rows and writes nothing.
  --append     add to the database an earlier run made (ids already in it are not looked up again), instead of refusing to touch it.`;
if (a.help || (!a.ids && !a.file) || (a.ids && a.file)) { if (!a.help) console.error(a.ids && a.file ? 'give --ids or --file, not both\n' : 'give --ids FILE or --file EXPORT\n'); console.log(usage); process.exit(a.help && !a.bad ? 0 : 2); }
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };
if (!['key', 'provider', 'none'].includes(a['tenant-by'])) fail('--tenant-by must be key, provider or none');
const concurrency = Number(a.concurrency);
if (!(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16)) fail('--concurrency must be 1..16');
const retryMs = Number(a['retry-ms']);
if (!(Number.isInteger(retryMs) && retryMs >= 0 && retryMs <= 60_000)) fail('--retry-ms must be 0..60000 (the first wait before a retry; it doubles each time)');
const costScale = Number(a['cost-scale']);
if (!(Number.isFinite(costScale) && costScale > 0)) fail('--cost-scale must be a positive number (0.01 for a cost in cents)');
let keyMap = {};
if (a['key-map']) {
  try { keyMap = JSON.parse(readFileSync(a['key-map'], 'utf8')); } catch (e) { fail(`cannot read --key-map ${a['key-map']}: ${e.message}`); }
  if (!keyMap || typeof keyMap !== 'object' || Array.isArray(keyMap)) fail('--key-map must hold a JSON object: {"fr-key-ab12cd34ef": "team-name"}');
  for (const [k, v] of Object.entries(keyMap)) if (typeof v !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(v)) fail(`--key-map: the tenant name for ${k} must be letters, digits, . _ -`);
}
const explicit = {};
for (const m of a.map) {
  const i = m.indexOf('=');
  if (i < 1 || !['id', 'ts', 'model', 'input', 'output', 'cached', 'cost', 'tenant', 'endpoint', 'status', 'latency'].includes(m.slice(0, i))) fail(`bad --map "${m}": expected FIELD=COLUMN with FIELD one of id, ts, model, input, output, cached, cost, tenant, endpoint, status, latency`);
  explicit[m.slice(0, i)] = m.slice(i + 1);
}

const out = (s = '') => console.log(s);
const t0 = Date.now();
const note = (kind) => `Imported from FastRouter (${kind}): one row per request, with FastRouter's own cost in USD (not recomputed from a price list), token counts, model, time and a hashed key label. Cached-token counts are ${kind === 'generation API' ? 'not in that API and are 0 here' : 'taken from the export when it has them'}. Prompts and completions are not kept. This is only the requests you supplied, not necessarily everything the account made, so alerts are not computed.`;

let writer, imp, created = false;
const open = (kind) => {
  created = !existsSync(a.db);
  try {
    imp = createImportDb({ path: a.db, replace: a.replace, append: a.append, source: 'import:fastrouter', note: note(kind), maxCallsPerRequest: 5 });
  } catch (e) { fail(e.message, 1); }
  writer = new BatchWriter(imp.ingestor);
};
const skipLine = (skips) => { for (const [k, n] of Object.entries(skips)) if (n) out(`  ! ${fmtInt(n)} skipped: ${({ no_cost: 'no usable cost (usage.cost / the cost column)', no_time: 'no usable timestamp', unreadable: 'not a record' })[k] ?? k}`); };
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function report(extra) {
  if (created && writer.accepted === 0) { // do not leave an empty source in the dashboard's menu
    imp.db.close();
    for (const f of [a.db, `${a.db}-wal`, `${a.db}-shm`]) rmSync(f, { force: true });
    out();
    out('Nothing was imported, so no database was kept.');
    extra?.();
    process.exitCode = 1;
    return;
  }
  finishImport(imp);
  const d = describeDb(imp.db);
  out();
  out(`Imported ${fmtInt(writer.accepted)} requests${writer.duplicates ? ` (${fmtInt(writer.duplicates)} were already there)` : ''}   ${d.from ? `${day(d.from)} .. ${day(d.to)}` : ''}   -> ${a.db}`);
  out(`  cost (FastRouter's own figure)  ${fmtUsd(d.llm_cost_micro)}   tokens in ${fmtInt(d.tokens_in)} / out ${fmtInt(d.tokens_out)}   (database total: ${fmtInt(d.requests)} requests)`);
  const list = (rows) => rows.map((r) => `    ${String(r.key).padEnd(46)} ${fmtUsd(r.cost).padStart(9)}  ${fmtInt(r.requests)} requests`).join('\n');
  out('  tenants\n' + list(d.tenants));
  out('  models\n' + list(d.models));
  if (writer.rejected) out(`  ! ${writer.rejected} requests were rejected by validation, e.g. ${writer.rejectSamples.join(' | ')}`);
  extra?.();
  let exit = 0;
  if (!a['no-verify']) {
    const diffs = verifyRollups(imp.db);
    out(`Rollups vs brute-force recomputation: ${diffs.length === 0 ? 'consistent' : `MISMATCH (${diffs.length} differences)`}`);
    if (diffs.length) exit = 2;
  }
  imp.db.close();
  out();
  out(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s.  View it:  ${viewHint(a.db, DATA_DIR)}`);
  process.exitCode = exit;
}

if (a.file) {
  let rows;
  try {
    if (statSync(a.file).size > 256 * 1024 * 1024) fail('the export is larger than 256 MB: split it');
    rows = parseExport(readFileSync(a.file, 'utf8'), a.file);
  } catch (e) { fail(`cannot read ${a.file}: ${e.message}`); }
  const columns = columnsOf(rows);
  let m;
  try { m = detectMapping(columns, explicit); } catch (e) { fail(e.message); }
  out(`FastRouter export: ${fmtInt(rows.length)} rows, ${columns.length} columns`);
  out('  columns used: ' + Object.entries(m.map).map(([f, c]) => `${f}=${c}`).join('  '));
  for (const x of m.ambiguous) out(`  ! more than one column could be ${x}; override with --map`);
  if (m.missing.length) {
    fail(`  ! cannot tell which column is: ${m.missing.join(', ')}. Name them with --map FIELD=COLUMN (the cost column must be in USD, or use --cost-scale).\n  columns in the file: ${columns.slice(0, 60).join(', ')}${columns.length > 60 ? ', ...' : ''}\n  (a "credits" column is never picked automatically: its unit is not documented. If it is dollars, say so: --map cost=<column>)`);
  }
  const conv = { costScale, tenantRaw: a['tenant-raw'], keyMap, seen: new Map() };
  const skips = { no_cost: 0, no_time: 0 };
  const requests = [];
  for (const r of rows) { const x = requestFromRow(r, m.map, conv); if (x.request) requests.push(x.request); else skips[x.skip]++; }
  if (a.check) {
    out(`  ${fmtInt(requests.length)} of ${fmtInt(rows.length)} rows convert. The first three:`);
    for (const r of requests.slice(0, 3)) { const c = r.llm_calls[0]; out(`    ${new Date(r.ts).toISOString()}  ${c.model}  in ${fmtInt(c.input_tokens)} / out ${fmtInt(c.output_tokens)}  ${fmtUsd(c.cost_micro_usd)}  tenant ${r.tenant_id}  ${r.endpoint}`); }
    skipLine(skips);
    out('Nothing was written (--check).');
    process.exit(0);
  }
  if (!requests.length) fail(`  nothing to import: no row has both a usable time and a cost${skips.no_cost ? ` (${skips.no_cost} without a cost: is --map cost pointing at the right column?)` : ''}`, 1);
  if (a['tenant-raw']) out('  ! --tenant-raw: the values of the tenant column are used as tenant names as they are');
  open('activity log export');
  for (const r of requests) writer.add(r);
  writer.flush();
  report(() => skipLine(skips));
} else {
  const key = process.env.FASTROUTER_API_KEY || '';
  if (!key) fail(`FASTROUTER_API_KEY is not set (the FastRouter API key your app uses).\n${usage}`);
  let text;
  try { text = a.ids === '-' ? readFileSync(0, 'utf8') : readFileSync(a.ids, 'utf8'); } catch (e) { fail(`cannot read ${a.ids}: ${e.message}`); }
  const parsed = parseIds(text);
  if (!parsed.ids.length) fail(`no usable ids in ${a.ids === '-' ? 'standard input' : a.ids} (an id is letters, digits and . _ : - up to 90 characters)${parsed.invalidCount ? `; e.g. not usable: ${parsed.invalid.join(', ')}` : ''}`, 1);
  let client;
  try { client = new GenerationClient({ baseUrl: a['base-url'], apiKey: key, retryMs, userAgent: `finops-dashboard/${pkg.version} (${pkg.homepage})` }); } catch (e) { fail(e.message); }
  open('generation API');
  const have = new Set(imp.db.prepare("SELECT id FROM requests WHERE id LIKE 'fr:%'").all().map((r) => r.id));
  const todo = parsed.ids.filter((id) => !have.has(`fr:${id}`));
  out(`FastRouter ids: ${fmtInt(parsed.ids.length)} usable${parsed.invalidCount ? `, ${parsed.invalidCount} not usable (e.g. ${parsed.invalid.join(', ')})` : ''}${parsed.duplicates ? `, ${parsed.duplicates} repeated` : ''}; ${fmtInt(parsed.ids.length - todo.length)} already imported; looking up ${fmtInt(todo.length)} at ${new URL(a['base-url']).host} (${concurrency} at a time)`);
  const tally = { not_found: 0, bad_id: 0, failed: 0, byok: 0, no_cost: 0, no_time: 0, unreadable: 0 };
  const failures = [];
  let done = 0, next = 0, fatal = null;
  const worker = async () => {
    while (!fatal) {
      const i = next++;
      if (i >= todo.length) return;
      const id = todo[i];
      let r;
      try { r = await client.lookup(id); } catch (e) { if (e instanceof FastRouterError) { fatal = e; return; } throw e; }
      if (r.status !== 'ok') { tally[r.status]++; if (r.status === 'failed' && failures.length < 3) failures.push(`${id}: ${r.error}`); }
      else {
        const x = requestFromGeneration(id, r.body, { tenantBy: a['tenant-by'], keyMap });
        if (x.skip) tally[x.skip]++; else { if (x.byok) tally.byok++; writer.add(x.request); }
      }
      if (++done % 50 === 0 || done === todo.length) process.stderr.write(`  ${done} / ${todo.length} looked up\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, todo.length)) }, worker));
  writer.flush();
  report(() => {
    if (tally.not_found) out(`  ! ${fmtInt(tally.not_found)} ids were not found (unknown, or expired on FastRouter's side)`);
    if (tally.bad_id) out(`  ! ${fmtInt(tally.bad_id)} ids were refused by FastRouter as malformed`);
    if (tally.failed) out(`  ! ${fmtInt(tally.failed)} lookups failed after retries, e.g. ${failures.join(' | ')}. Run it again with --append: finished ids are not asked for twice.`);
    skipLine({ no_cost: tally.no_cost, no_time: tally.no_time, unreadable: tally.unreadable });
    if (tally.byok) out(`  ! ${fmtInt(tally.byok)} requests used your own provider key (BYOK): the cost shown is FastRouter's figure for them, which may not include what the provider charged you directly`);
  });
  if (fatal) { console.error(`\n${fatal.message}\nWhat was looked up before that is imported; fix the key and run again with --append.`); process.exitCode = 1; }
}
