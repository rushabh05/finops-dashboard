import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { FastRouterError, GenerationClient, columnsOf, detectMapping, parseCsv, parseExport, parseIds, requestFromGeneration, requestFromRow, toMs } from '../src/import/fastrouter.js';
import { discoverSources } from '../src/multi.js';

/*
 * FastRouter's past requests -> dashboard. The API is a fake that follows what docs.fastrouter.ai documents for POST /api/v1/generation (a request
 * by generation_id; usage.cost in USD; a hashed key; timing; and the request/response PAYLOADS, which must never be kept). Nothing here has talked to the
 * real FastRouter. The export files are made up too: FastRouter does not document an export format, so the importer matches columns by name and says what it did.
 */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const KEY = 'sk-fr-SECRET-FASTROUTER-KEY-do-not-print';
const PROMPT = 'SECRET prompt: our unreleased pricing', ANSWER = 'SECRET answer text';
const HASH = 'ab12CD34ef56gh78ij90';
const T0 = Date.UTC(2026, 8, 1, 10, 0, 0);

/** A /generation answer in the documented shape. credits_used is a DECOY: it must not be read as the cost. */
const generation = (id, o = {}) => ({
  id, model: 'openai/gpt-4o', provider_name: 'openai', endpoint: '/api/v1/chat/completions', is_byok: false, api_key: HASH, credits_used: 777,
  usage: { cost: 0.00123, prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 }, input_token_size: 1000, output_token_size: 200,
  query_time: new Date(T0).toISOString(), created_at: Math.floor(T0 / 1000), timing: { started_at: new Date(T0).toISOString(), completed_at: new Date(T0 + 850).toISOString(), duration_ms: 850 },
  request: { messages: [{ role: 'user', content: PROMPT }] }, response: { choices: [{ message: { content: ANSWER } }] }, metadata: { note: PROMPT },
  ...o,
});

async function fakeFastRouter() {
  const received = [];
  const seen = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const send = (status, o, h = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    if (req.method !== 'POST' || req.url !== '/api/v1/generation') return send(404, { error: 'no such route' });
    if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: `invalid key ${req.headers.authorization}` });
    const id = body.generation_id;
    const n = (seen.set(id, (seen.get(id) ?? 0) + 1), seen.get(id));
    const k = Number(/(\d+)$/.exec(id)?.[1] ?? 0);
    if (id.startsWith('missing')) return send(404, { error: 'not found' });
    if (id.startsWith('bad')) return send(400, { error: 'invalid id' });
    if (id.startsWith('boom')) return send(500, { error: 'boom' });
    if (id.startsWith('slow') && n === 1) return send(429, { error: 'slow down' }, { 'retry-after': '0' });
    if (id.startsWith('nocost')) return send(200, generation(id, { usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    const g = generation(id, { usage: { cost: 0.001 * (k || 1), prompt_tokens: 1000 * (k || 1), completion_tokens: 100 * (k || 1), total_tokens: 1100 * (k || 1) }, timing: { started_at: new Date(T0 + k * 60_000).toISOString(), duration_ms: 500 + k }, is_byok: id.startsWith('byok') });
    return send(200, g);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { received, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}

const withDir = async (fn) => { const dir = mkdtempSync(join(tmpdir(), 'finops-fr-')); try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } };

function runImport(args, env = {}, { input } = {}) {
  return new Promise((resolve2) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'scripts', 'import-fastrouter.js'), ...args], { cwd: ROOT, env: { ...process.env, FASTROUTER_API_KEY: '', DATA_DIR: '', FINOPS_CLI: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve2({ code, out, err }));
    child.stdin.end(input ?? '');
  });
}

const dbRows = (path) => {
  const d = new DatabaseSync(path, { readOnly: true });
  try {
    return d.prepare('SELECT r.id, r.ts, r.tenant_id, r.endpoint, r.status, r.duration_ms, c.model, c.input_tokens, c.output_tokens, c.cached_tokens, c.cost_micro_usd, c.cost_source FROM requests r JOIN llm_calls c ON c.request_id = r.id ORDER BY r.ts, r.id').all().map((x) => ({ ...x }));
  } finally { d.close(); }
};
const everything = (dir) => readdirSync(dir).filter((f) => /\.db/.test(f)).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('\n');

/* ------------------------------------------------------------------ ids and one record */

test('parseIds: one per line or comma-separated, comments, a JSON array; unusable and repeated ids are counted, never guessed at', () => {
  assert.deepEqual(parseIds('a1\nb2\n\n# a comment\nc3 # trailing\nd4, e5,f6\n'), { ids: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'], invalid: [], invalidCount: 0, duplicates: 0 });
  assert.deepEqual(parseIds('["x1","y2",3]').ids, ['x1', 'y2', '3']);
  const r = parseIds('ok1\nok1\nspaces?\nhttps://x.example/y\n' + 'z'.repeat(91) + '\nfine:2.x-y_z');
  assert.deepEqual([r.ids, r.invalidCount, r.duplicates], [['ok1', 'fine:2.x-y_z'], 3, 1]);
  assert.deepEqual(parseIds('').ids, []);
  const sentence = parseIds('this is a sentence\nid9');
  assert.deepEqual([sentence.ids, sentence.invalidCount], [['id9'], 1], 'a line with spaces is one unusable id, not three usable ones');
  const broken = parseIds('[not json\nid9');
  assert.deepEqual([broken.ids, broken.invalidCount], [['id9'], 1], 'a broken JSON array is read as lines, not crashed on');
});

test('requestFromGeneration: reads usage.cost (USD) - not the credits decoy - tokens, time, model, a hashed key and the endpoint; the payloads never reach the request', () => {
  const { request, byok } = requestFromGeneration('chat-1', generation('chat-1'));
  assert.equal(byok, false);
  assert.deepEqual(request, {
    id: 'fr:chat-1', ts: T0, tenant_id: 'fr-key-ab12CD34ef', endpoint: '/fastrouter/api/v1/chat/completions', method: 'POST', status: 200, duration_ms: 850, infra_cost_micro_usd: 0,
    llm_calls: [{ model: 'openai/gpt-4o', input_tokens: 1000, output_tokens: 200, cached_tokens: 0, latency_ms: 850, cost_micro_usd: 1230 }],
  });
  const json = JSON.stringify(request);
  for (const secret of [PROMPT, ANSWER, 'SECRET']) assert.ok(!json.includes(secret));
  // the time: timing.started_at, else query_time, else created_at (seconds); nothing plausible = skipped, never "now"
  const g = (o) => generation('t', { timing: undefined, query_time: undefined, created_at: undefined, ...o });
  assert.equal(requestFromGeneration('t', g({ query_time: new Date(T0 + 5000).toISOString() })).request.ts, T0 + 5000);
  assert.equal(requestFromGeneration('t', g({ created_at: Math.floor(T0 / 1000) + 7 })).request.ts, T0 + 7000);
  assert.equal(requestFromGeneration('t', g({})).skip, 'no_time');
  assert.equal(requestFromGeneration('t', g({ created_at: 5 })).skip, 'no_time', '5 seconds after 1970 is not a plausible request time');
  // a cost that is missing or not a number is a skip: credits_used is never used instead
  assert.equal(requestFromGeneration('t', generation('t', { usage: { prompt_tokens: 1 } })).skip, 'no_cost');
  assert.equal(requestFromGeneration('t', generation('t', { usage: { cost: 'abc' } })).skip, 'no_cost');
  assert.equal(requestFromGeneration('t', generation('t', { usage: { cost: -1 } })).skip, 'no_cost');
  assert.equal(requestFromGeneration('t', null).skip, 'unreadable');
  assert.equal(requestFromGeneration('t', generation('t', { usage: { cost: 0, prompt_tokens: 3, completion_tokens: 4 } })).request.llm_calls[0].cost_micro_usd, 0, 'a free request is a request');
  // tokens fall back to the *_token_size fields; a model name that is not a legal name is cleaned, not rejected
  const f = requestFromGeneration('t', generation('t', { usage: { cost: 0.5 }, input_token_size: 11, output_token_size: 22, model: 'we ird/mo del?' })).request.llm_calls[0];
  assert.deepEqual([f.input_tokens, f.output_tokens, f.model], [11, 22, 'we_ird/mo_del_']);
  // tenants
  assert.equal(requestFromGeneration('t', generation('t'), { tenantBy: 'provider' }).request.tenant_id, 'openai');
  assert.equal(requestFromGeneration('t', generation('t'), { tenantBy: 'none' }).request.tenant_id, 'fastrouter');
  assert.equal(requestFromGeneration('t', generation('t'), { keyMap: { 'fr-key-ab12CD34ef': 'search-team' } }).request.tenant_id, 'search-team');
  assert.equal(requestFromGeneration('t', generation('t', { is_byok: true })).byok, true);
});

test('toMs: epoch seconds, epoch milliseconds, ISO and numeric strings; anything implausible is null', () => {
  for (const v of [T0, T0 / 1000, String(T0), String(T0 / 1000), new Date(T0).toISOString(), new Date(T0).toUTCString()]) assert.equal(toMs(v), T0, String(v));
  for (const v of [null, undefined, '', 'yesterday', NaN, 0, 12345, -1, Date.UTC(2101, 0, 1), {}, []]) assert.equal(toMs(v), null, String(v));
});

/* ------------------------------------------------------------------ the API client */

test('GenerationClient: POSTs the id with the key in a header only; 404 / 400 are answers, 429 and 5xx are retried, a refused key stops everything without echoing it', async () => {
  const calls = [];
  const reply = (queue) => async (url, init) => { calls.push({ url: String(url), init }); const r = queue.shift(); return typeof r === 'function' ? r() : r; };
  const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const mk = (queue) => new GenerationClient({ apiKey: KEY, fetchImpl: reply(queue), retryMs: 1 });

  let c = mk([json(200, generation('x'))]);
  assert.equal((await c.lookup('x')).status, 'ok');
  assert.equal(calls[0].url, 'https://api.fastrouter.ai/api/v1/generation');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { generation_id: 'x' });
  assert.ok(!calls[0].url.includes(KEY), 'never in the URL');
  assert.equal(calls[0].init.redirect, 'manual');

  assert.deepEqual(await mk([json(404, {})]).lookup('x'), { status: 'not_found' });
  assert.deepEqual(await mk([json(400, {})]).lookup('x'), { status: 'bad_id' });
  c = mk([json(429, {}, { 'retry-after': '0' }), json(503, {}), json(200, generation('x'))]);
  assert.equal((await c.lookup('x')).status, 'ok');
  assert.equal(c.requests, 3, 'two retries, then the answer');
  const exhausted = await mk([json(500, {}), json(500, {}), json(500, {}), json(500, {})]).lookup('x');
  assert.deepEqual([exhausted.status, exhausted.error], ['failed', 'FastRouter answered HTTP 500']);
  assert.equal((await mk([json(302, {}, { location: 'https://evil.example/' })]).lookup('x')).status, 'failed', 'a redirect is never followed: the key would travel with it');
  const net = await new GenerationClient({ apiKey: KEY, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, retryMs: 1 }).lookup('x');
  assert.match(net.error, /could not reach https:\/\/api\.fastrouter\.ai \(ECONNREFUSED\)/);

  for (const status of [401, 403]) {
    await assert.rejects(() => mk([json(status, { error: `bad key ${KEY}` })]).lookup('x'), (e) => e instanceof FastRouterError && e.status === status && /refused the key/.test(e.message) && !e.message.includes(KEY));
  }
  assert.throws(() => new GenerationClient({ baseUrl: 'http://api.fastrouter.example', apiKey: KEY }), /must be https/);
  assert.throws(() => new GenerationClient({ baseUrl: 'https://u:p@api.fastrouter.example', apiKey: KEY }), /credentials/);
  assert.throws(() => new GenerationClient({ apiKey: '' }), /API key is required/);
  assert.doesNotThrow(() => new GenerationClient({ baseUrl: 'http://127.0.0.1:9', apiKey: KEY }));
});

/* ------------------------------------------------------------------ the whole command, ids */

test('finops import fastrouter --ids: looks each id up, imports the requests with FastRouter\'s own cost, counts what it could not, keeps no prompt and no key, and a re-run asks for nothing twice', async (t) => {
  const api = await fakeFastRouter();
  t.after(() => api.close());
  await withDir(async (dir) => {
    const ids = join(dir, 'ids.txt');
    writeFileSync(ids, ['ok-1', 'ok-2', 'ok-3', 'byok-1', 'missing-1', 'nocost-1', 'ok-1', 'not-valid!'].join('\n'));
    const db = join(dir, 'fastrouter.db');
    const r = await runImport(['--ids', ids, '--base-url', api.url, '--db', db], { FASTROUTER_API_KEY: KEY, DATA_DIR: dir });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /6 usable, 1 not usable.*1 repeated; 0 already imported; looking up 6/);
    assert.match(r.out, /Imported 4 requests/);
    assert.match(r.out, /1 ids were not found/);
    assert.match(r.out, /1 skipped: no usable cost/);
    assert.match(r.out, /1 requests used your own provider key \(BYOK\)/);
    assert.match(r.out, /Rollups vs brute-force recomputation: consistent/);

    const rows = dbRows(db);
    // ordered by time, then id: byok-1 and ok-1 started in the same millisecond
    assert.deepEqual(rows.map((x) => [x.id, x.input_tokens, x.output_tokens, x.cost_micro_usd, x.cost_source, x.model, x.tenant_id, x.endpoint, x.status, x.duration_ms]), [
      ['fr:byok-1', 1000, 100, 1000, 'supplied', 'openai/gpt-4o', 'fr-key-ab12CD34ef', '/fastrouter/api/v1/chat/completions', 200, 501],
      ['fr:ok-1', 1000, 100, 1000, 'supplied', 'openai/gpt-4o', 'fr-key-ab12CD34ef', '/fastrouter/api/v1/chat/completions', 200, 501],
      ['fr:ok-2', 2000, 200, 2000, 'supplied', 'openai/gpt-4o', 'fr-key-ab12CD34ef', '/fastrouter/api/v1/chat/completions', 200, 502],
      ['fr:ok-3', 3000, 300, 3000, 'supplied', 'openai/gpt-4o', 'fr-key-ab12CD34ef', '/fastrouter/api/v1/chat/completions', 200, 503],
    ], 'FastRouter\'s usage.cost x 1e6, not the credits_used decoy (777)');
    assert.equal(api.received.length, 6, 'every usable id was asked for once');
    assert.ok(api.received.every((q) => q.auth === `Bearer ${KEY}` && q.url === '/api/v1/generation'));

    // nothing sensitive anywhere we wrote or printed
    for (const secret of [KEY, PROMPT, ANSWER, 'SECRET']) for (const hay of [r.out, r.err, everything(dir)]) assert.ok(!hay.includes(secret), `"${secret}" must not appear`);
    const label = discoverSources(dir).find((s) => s.id === 'fastrouter');
    assert.deepEqual([label?.label, label?.kind], ['FastRouter (past requests)', 'imported']);

    // an existing database is not touched unless you say so; --append resumes and asks for nothing twice
    const again = await runImport(['--ids', ids, '--base-url', api.url, '--db', db], { FASTROUTER_API_KEY: KEY, DATA_DIR: dir });
    assert.equal(again.code, 1);
    assert.match(again.err, /already exists - pass --replace to rebuild it, --append to add to it/);
    const before = api.received.length;
    writeFileSync(ids, ['ok-1', 'ok-2', 'ok-3', 'byok-1', 'ok-4'].join('\n'));
    const resumed = await runImport(['--ids', ids, '--base-url', api.url, '--db', db, '--append'], { FASTROUTER_API_KEY: KEY, DATA_DIR: dir });
    assert.equal(resumed.code, 0, resumed.out + resumed.err);
    assert.match(resumed.out, /4 already imported; looking up 1/);
    assert.equal(api.received.length - before, 1, 'only the new id was looked up');
    assert.equal(dbRows(db).length, 5);
    // another importer's database is never appended to
    const other = join(dir, 'claude-code.db');
    const o = new DatabaseSync(other); o.exec('CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES(\'source\', \'import:claude-code\')'); o.close();
    const refused = await runImport(['--ids', ids, '--base-url', api.url, '--db', other, '--append'], { FASTROUTER_API_KEY: KEY, DATA_DIR: dir });
    assert.equal(refused.code, 1);
    assert.match(refused.err, /was not created by this importer/);
  });
});

test('--ids: a refused key stops at once, says so without printing the key, and keeps no empty database; a flaky id is retried; one that keeps failing is reported with the way to resume', async (t) => {
  const api = await fakeFastRouter();
  t.after(() => api.close());
  await withDir(async (dir) => {
    const ids = join(dir, 'ids.txt');
    writeFileSync(ids, 'ok-1\nok-2\nok-3\n');
    const wrong = await runImport(['--ids', ids, '--base-url', api.url, '--db', join(dir, 'x.db')], { FASTROUTER_API_KEY: 'sk-fr-WRONG-KEY', DATA_DIR: dir });
    assert.equal(wrong.code, 1);
    assert.match(wrong.err, /FastRouter refused the key \(HTTP 401\)/);
    assert.ok(!(wrong.out + wrong.err).includes('sk-fr-WRONG-KEY'), 'the key is not echoed, even though the server echoed it back in its error body');
    assert.ok(!existsSync(join(dir, 'x.db')), 'no empty database is left in the menu');
    assert.match(wrong.out, /Nothing was imported, so no database was kept/);

    writeFileSync(ids, 'ok-1\nslow-2\nboom-3\n');
    const mixed = await runImport(['--ids', ids, '--base-url', api.url, '--db', join(dir, 'y.db'), '--concurrency', '1', '--retry-ms', '1'], { FASTROUTER_API_KEY: KEY, DATA_DIR: dir });
    assert.equal(mixed.code, 0, mixed.out + mixed.err);
    assert.match(mixed.out, /Imported 2 requests/);
    assert.match(mixed.out, /1 lookups failed after retries, e\.g\. boom-3: FastRouter answered HTTP 500\. Run it again with --append/);
    assert.equal(dbRows(join(dir, 'y.db')).length, 2);

    const noKey = await runImport(['--ids', ids, '--base-url', api.url], { DATA_DIR: dir });
    assert.equal(noKey.code, 2);
    assert.match(noKey.err, /FASTROUTER_API_KEY is not set/);
    assert.equal((await runImport(['--ids', ids, '--base-url', 'http://api.fastrouter.example'], { FASTROUTER_API_KEY: KEY, DATA_DIR: dir })).code, 2);
    assert.equal((await runImport(['--ids', '-', '--base-url', api.url, '--db', join(dir, 'z.db')], { FASTROUTER_API_KEY: KEY, DATA_DIR: dir }, { input: 'ok-1\n' })).code, 0, 'ids from standard input');
    assert.equal((await runImport([], {})).code, 2);
    assert.equal((await runImport(['--ids', ids, '--file', ids], {})).code, 2);
  });
});

/* ------------------------------------------------------------------ an export file */

test('parseCsv: quoted commas, doubled quotes, line breaks inside a field, CRLF and a BOM', () => {
  const rows = parseCsv('﻿a,b,c\r\n1,"x, y","he said ""hi"""\r\n2,"line1\nline2",\r\n\r\n3,,z');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'he said "hi"'], ['2', 'line1\nline2', ''], ['3', '', 'z']]);
});

test('parseExport: CSV, a JSON array, an object holding one, JSON lines; anything else is an error that says what is wrong', () => {
  assert.deepEqual(parseExport('a,b\n1,2\n'), [{ a: '1', b: '2' }]);
  assert.deepEqual(parseExport('[{"a":1},{"a":2}]'), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(parseExport('{"data":[{"a":1}],"next":null}'), [{ a: 1 }]);
  assert.deepEqual(parseExport('{"a":1}\n{"a":2}\n'), [{ a: 1 }, { a: 2 }]);
  assert.throws(() => parseExport(''), /empty/);
  assert.throws(() => parseExport('{"total": 3}'), /no list of requests/);
  assert.throws(() => parseExport('a,b\n'), /no data rows/);
  assert.throws(() => parseExport('{"a":1}\nnot json'), /line 2 is not JSON/);
});

test('detectMapping: columns are matched by name; nothing is guessed when it is not clear, and a credits column is never taken for dollars', () => {
  const cols = ['Request ID', 'Time', 'Model', 'Prompt Tokens', 'Completion Tokens', 'Cost (USD)', 'API Key', 'Latency (ms)', 'Prompt'];
  const m = detectMapping(cols);
  assert.deepEqual(m.map, { id: 'Request ID', ts: 'Time', model: 'Model', input: 'Prompt Tokens', output: 'Completion Tokens', cost: 'Cost (USD)', tenant: 'API Key', latency: 'Latency (ms)' });
  assert.deepEqual([m.missing, m.ambiguous], [[], []]);
  assert.deepEqual(detectMapping(['created_at', 'model', 'usage.prompt_tokens', 'usage.completion_tokens', 'usage.cost', 'timing.duration_ms']).map, { ts: 'created_at', model: 'model', input: 'usage.prompt_tokens', output: 'usage.completion_tokens', cost: 'usage.cost', latency: 'timing.duration_ms' });
  const credits = detectMapping(['Time', 'Model', 'Prompt Tokens', 'Completion Tokens', 'Credits Used']);
  assert.deepEqual(credits.missing, ['cost'], 'credits_used is a decoy until the user says what unit it is in');
  assert.deepEqual(detectMapping(['Time', 'Model', 'Prompt Tokens', 'Completion Tokens', 'Credits Used'], { cost: 'Credits Used' }).missing, []);
  assert.deepEqual(detectMapping(['Time', 'Model', 'Prompt Tokens', 'Completion Tokens', 'Cost', 'Cost USD']).ambiguous, ['cost: Cost / Cost USD (using Cost)']);
  assert.throws(() => detectMapping(['a'], { cost: 'nope' }), /--map cost=nope: no such column/);
  assert.deepEqual(columnsOf([{ usage: { cost: 1, deep: { x: 1 } }, model: 'm' }]).sort(), ['model', 'usage.cost', 'usage.deep.x']);
});

test('requestFromRow: cost scale, hashed tenants by default, ids from the row when there is no id column, rows with no usable cost or time are skipped', () => {
  const row = { 'Request ID': 'r-1', Time: new Date(T0).toISOString(), Model: 'openai/gpt-4o', 'Prompt Tokens': '1,234', 'Completion Tokens': '56', 'Cost (USD)': '$0.0123', 'API Key': 'sk-fr-REAL-KEY-VALUE', 'Latency (ms)': '420', Prompt: PROMPT };
  const map = detectMapping(Object.keys(row)).map;
  const { request } = requestFromRow(row, map);
  assert.deepEqual([request.id, request.ts, request.duration_ms, request.llm_calls[0].input_tokens, request.llm_calls[0].output_tokens, request.llm_calls[0].cost_micro_usd], ['fr:r-1', T0, 420, 1234, 56, 12300]);
  assert.match(request.tenant_id, /^fr-key-[0-9a-f]{10}$/);
  assert.ok(!JSON.stringify(request).includes('REAL-KEY') && !JSON.stringify(request).includes('SECRET'), 'neither the key value nor the prompt column is kept');
  assert.equal(requestFromRow(row, map, { tenantRaw: true }).request.tenant_id, 'sk-fr-REAL-KEY-VALUE', 'raw names only when asked for (for a column of key NAMES)');
  assert.equal(requestFromRow(row, map, { costScale: 0.01 }).request.llm_calls[0].cost_micro_usd, 123);
  assert.equal(requestFromRow({ ...row, 'Cost (USD)': '' }, map).skip, 'no_cost');
  assert.equal(requestFromRow({ ...row, Time: 'soon' }, map).skip, 'no_time');
  // no id column: a stable id from the content, and a counter so two identical rows are two requests
  const noId = { ...row }; delete noId['Request ID'];
  const m2 = detectMapping(Object.keys(noId)).map;
  const seen = new Map();
  const a = requestFromRow(noId, m2, { seen }).request.id, b = requestFromRow(noId, m2, { seen }).request.id;
  assert.notEqual(a, b);
  assert.equal(a, requestFromRow(noId, m2, { seen: new Map() }).request.id, 'stable across runs');
});

const CSV = [
  'Request ID,Time,Model,Prompt Tokens,Completion Tokens,Cost (USD),API Key,Endpoint,Status,Latency (ms),Prompt',
  `r-1,${new Date(T0).toISOString()},openai/gpt-4o,1000,100,0.002,prod-backend,/api/v1/chat/completions,200,300,"${PROMPT}, with ""quotes"" and\na new line"`,
  `r-2,${new Date(T0 + 60_000).toISOString()},anthropic/claude-sonnet-4.5,2000,200,0.004,prod-backend,/api/v1/chat/completions,429,50,"${ANSWER}"`,
  `r-3,${new Date(T0 + 120_000).toISOString()},openai/gpt-4o-mini,500,50,0.0005,batch-job,/api/v1/chat/completions,200,120,x`,
  `r-4,${new Date(T0 + 180_000).toISOString()},openai/gpt-4o,1,1,,batch-job,/api/v1/chat/completions,200,1,no cost on this row`,
  'r-5,not a time,openai/gpt-4o,1,1,0.1,batch-job,/api/v1/chat/completions,200,1,bad time',
].join('\n');

test('finops import fastrouter --file: an Activity Log export is matched by column name, the mapping is printed, tenants are hashed, payload columns are dropped, bad rows are counted', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'activity.csv');
    writeFileSync(file, CSV);
    const db = join(dir, 'fastrouter.db');

    const check = await runImport(['--file', file, '--db', db, '--check'], { DATA_DIR: dir });
    assert.equal(check.code, 0, check.out + check.err);
    assert.match(check.out, /5 rows, 11 columns/);
    assert.match(check.out, /columns used: id=Request ID  ts=Time  model=Model  input=Prompt Tokens  output=Completion Tokens  cost=Cost \(USD\)  tenant=API Key  endpoint=Endpoint  status=Status  latency=Latency \(ms\)/);
    assert.match(check.out, /3 of 5 rows convert/);
    assert.match(check.out, /Nothing was written/);
    assert.ok(!existsSync(db), '--check writes nothing');

    const r = await runImport(['--file', file, '--db', db], { DATA_DIR: dir });
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /Imported 3 requests/);
    assert.match(r.out, /1 skipped: no usable cost/);
    assert.match(r.out, /1 skipped: no usable timestamp/);
    const rows = dbRows(db);
    assert.deepEqual(rows.map((x) => [x.id, x.model, x.input_tokens, x.output_tokens, x.cost_micro_usd, x.status, x.duration_ms, x.endpoint]), [
      ['fr:r-1', 'openai/gpt-4o', 1000, 100, 2000, 200, 300, '/fastrouter/api/v1/chat/completions'],
      ['fr:r-2', 'anthropic/claude-sonnet-4.5', 2000, 200, 4000, 429, 50, '/fastrouter/api/v1/chat/completions'],
      ['fr:r-3', 'openai/gpt-4o-mini', 500, 50, 500, 200, 120, '/fastrouter/api/v1/chat/completions'],
    ]);
    assert.equal(new Set(rows.map((x) => x.tenant_id)).size, 2);
    assert.ok(rows.every((x) => /^fr-key-[0-9a-f]{10}$/.test(x.tenant_id)), 'hashed: an export may hold key values');
    for (const secret of [PROMPT, ANSWER, 'SECRET', 'prod-backend', 'batch-job']) for (const hay of [r.out, check.out, everything(dir)]) assert.ok(!hay.includes(secret), `"${secret}" must not appear`);

    // key NAMES can be used as they are, and a cost in cents is scaled
    const db2 = join(dir, 'raw.db');
    const raw = await runImport(['--file', file, '--db', db2, '--tenant-raw', '--cost-scale', '0.01'], { DATA_DIR: dir });
    assert.equal(raw.code, 0, raw.out + raw.err);
    assert.deepEqual(dbRows(db2).map((x) => [x.tenant_id, x.cost_micro_usd]), [['prod-backend', 20], ['prod-backend', 40], ['batch-job', 5]]);
    assert.match(raw.out, /--tenant-raw/);

    // identical re-import adds nothing (--append: ids are stable)
    const again = await runImport(['--file', file, '--db', db, '--append'], { DATA_DIR: dir });
    assert.equal(again.code, 0, again.out + again.err);
    assert.match(again.out, /Imported 0 requests \(3 were already there\)/);
    assert.equal(dbRows(db).length, 3);
  });
});

test('--file: when the columns are not clear it refuses and says which and how to name them (credits are never taken for dollars); --map fixes it; JSON, nested records and JSON lines work', async () => {
  await withDir(async (dir) => {
    const credits = join(dir, 'credits.csv');
    writeFileSync(credits, 'Time,Model,Prompt Tokens,Completion Tokens,Credits Used\n' + `${new Date(T0).toISOString()},m,10,5,0.5\n`);
    const r = await runImport(['--file', credits, '--db', join(dir, 'a.db')], { DATA_DIR: dir });
    assert.equal(r.code, 2);
    assert.match(r.err, /cannot tell which column is: cost/);
    assert.match(r.err, /columns in the file: Time, Model, Prompt Tokens, Completion Tokens, Credits Used/);
    assert.match(r.err, /"credits" column is never picked automatically/);
    assert.ok(!existsSync(join(dir, 'a.db')));
    const fixed = await runImport(['--file', credits, '--db', join(dir, 'a.db'), '--map', 'cost=Credits Used'], { DATA_DIR: dir });
    assert.equal(fixed.code, 0, fixed.out + fixed.err);
    assert.equal(dbRows(join(dir, 'a.db'))[0].cost_micro_usd, 500_000);
    assert.equal((await runImport(['--file', credits, '--db', join(dir, 'b.db'), '--map', 'cost=Nope'], { DATA_DIR: dir })).code, 2);
    assert.equal((await runImport(['--file', credits, '--map', 'bogus=Time'], { DATA_DIR: dir })).code, 2);

    const nested = join(dir, 'nested.json');
    writeFileSync(nested, JSON.stringify({ data: [1, 2].map((k) => generation(`g${k}`, { usage: { cost: 0.01 * k, prompt_tokens: 100 * k, completion_tokens: 10 * k }, timing: { started_at: new Date(T0 + k * 1000).toISOString(), duration_ms: 100 * k } })) }));
    const j = await runImport(['--file', nested, '--db', join(dir, 'n.db')], { DATA_DIR: dir });
    assert.equal(j.code, 0, j.out + j.err);
    assert.deepEqual(dbRows(join(dir, 'n.db')).map((x) => [x.id, x.cost_micro_usd, x.input_tokens, x.duration_ms, x.ts]), [['fr:g1', 10_000, 100, 100, T0 + 1000], ['fr:g2', 20_000, 200, 200, T0 + 2000]], 'usage.cost, not the credits_used decoy; the time is when the request STARTED (timing.started_at), not created_at; payload columns ignored');
    assert.ok(!everything(dir).includes('SECRET'));

    const lines = join(dir, 'x.jsonl');
    writeFileSync(lines, [3, 4].map((k) => JSON.stringify(generation(`l${k}`, { usage: { cost: 0.01, prompt_tokens: 1, completion_tokens: 1 } }))).join('\n'));
    assert.equal((await runImport(['--file', lines, '--db', join(dir, 'l.db')], { DATA_DIR: dir })).code, 0);
    assert.equal(dbRows(join(dir, 'l.db')).length, 2);

    const none = join(dir, 'none.csv');
    writeFileSync(none, 'Time,Model,Prompt Tokens,Completion Tokens,Cost\nsoon,m,1,1,\n');
    const empty = await runImport(['--file', none, '--db', join(dir, 'e.db')], { DATA_DIR: dir });
    assert.equal(empty.code, 1);
    assert.match(empty.err, /nothing to import/);
    assert.ok(!existsSync(join(dir, 'e.db')));
  });
});

test('the finops command knows the importer, and its help says what FastRouter does and does not give you', () => {
  return new Promise((resolve2, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'bin', 'finops.js'), 'import', 'fastrouter', '--help'], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      try {
        assert.equal(code, 0);
        assert.match(out, /finops import fastrouter --ids FILE/);
        assert.match(out, /FastRouter has no call that lists past requests/);
        resolve2();
      } catch (e) { reject(e); }
    });
  });
});
