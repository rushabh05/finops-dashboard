import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMultiApp, discoverSources, SAMPLE_ID } from '../src/multi.js';
import { createImportDb, BatchWriter } from '../src/import/common.js';
import { SseClient, WsClient, mkRequest, randomCid, sleep, waitUntil } from './helpers.js';
import { HOUR } from '../src/util.js';

/** A data directory with two imported databases and some files that must be ignored. */
function makeDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'finops-multi-'));
  const make = (file, source, note, tenant, n) => {
    const x = createImportDb({ path: join(dir, file), source, note });
    const w = new BatchWriter(x.ingestor);
    const t0 = Math.floor(Date.now() / HOUR) * HOUR - 5 * HOUR;
    for (let i = 0; i < n; i++) w.add(mkRequest({ ts: t0 + i * 60_000, id: `${file}-${i}`, tenant, endpoint: '/main/cli' }));
    w.flush();
    x.db.close();
  };
  make('claude-code.db', 'import:claude-code', 'Claude Code note', 'proj-a', 12);
  make('burstgpt.db', 'import:trace:burstgpt', 'BurstGPT note', 'tenant-01', 7);
  writeFileSync(join(dir, 'notes.txt'), 'not a database');
  writeFileSync(join(dir, 'broken.db'), 'garbage, not sqlite');
  writeFileSync(join(dir, 'Bad Name.db'), '');
  const other = new DatabaseSync(join(dir, 'other.db'));
  other.exec('CREATE TABLE unrelated(x)');
  other.close();
  return dir;
}

const BASE = { port: 0, seedDays: 2, volumeScale: 0.2, simAutoStart: true, simIdleMs: 400, simIdleCheckMs: 50, sourcesTtlMs: 0, detectEveryMs: 100000 };
let dir, app;
before(async () => {
  dir = makeDataDir();
  app = await createMultiApp({ ...BASE, dataDir: dir });
  await app.listen();
});
after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const raw = (a, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: a.port, path, method, headers }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { text += d; });
    res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
  });
  req.on('error', reject);
  if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
  req.end();
});
const J = { 'Content-Type': 'application/json' };
const get = (path, opts) => raw(app, path, opts);

test('discovery: dashboard databases only, sample first (even before its file exists), imports labelled from their tag', () => {
  const list = discoverSources(dir);
  assert.deepEqual(list.map((s) => [s.id, s.kind]), [[SAMPLE_ID, 'sample'], ['burstgpt', 'imported'], ['claude-code', 'imported']]);
  assert.deepEqual(list.map((s) => s.label), ['Sample data (simulated)', 'BurstGPT public trace', 'Claude Code usage']);
  assert.equal(list[2].note, 'Claude Code note');
  assert.deepEqual(discoverSources(join(dir, 'does-not-exist')).map((s) => s.id), [SAMPLE_ID], 'no data directory yet: just the sample');
});

test('/api/sources, /healthz, and the redirects (/ -> default source, /d/<id> -> /d/<id>/)', async () => {
  const s = await get('/api/sources');
  assert.equal(s.status, 200);
  assert.equal(s.json.current, null);
  assert.deepEqual(s.json.sources.map((x) => x.path), ['/d/finops/', '/d/burstgpt/', '/d/claude-code/']);
  assert.ok(!JSON.stringify(s.json).includes(dir), 'file paths are not exposed');
  assert.deepEqual((await get('/healthz')).json, { ok: true, mode: 'multi' });
  const root = await get('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, '/d/finops/');
  const bare = await get('/d/claude-code?x=1');
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.location, '/d/claude-code/?x=1');
  assert.equal((await get('/nope')).status, 404);
  assert.equal((await raw(app, '/api/sources', { method: 'POST', headers: J, body: '{}' })).status, 404);
});

test('workspaces open lazily, on first use', async () => {
  assert.deepEqual(app.openIds(), [], 'nothing has been opened yet');
  assert.equal((await get('/d/claude-code/api/summary?range=24h')).status, 200);
  assert.deepEqual(app.openIds(), ['claude-code']);
});

test('each source is its own dashboard: data, tags, switcher list and simulator rules', async () => {
  const cc = (await get('/d/claude-code/api/by-tenant?range=24h')).json.rows.map((r) => r.key);
  const bg = (await get('/d/burstgpt/api/by-tenant?range=24h')).json.rows.map((r) => r.key);
  const sample = (await get('/d/finops/api/by-tenant?range=24h')).json.rows.map((r) => r.key);
  assert.deepEqual(cc, ['proj-a']);
  assert.deepEqual(bg, ['tenant-01']);
  assert.ok(sample.length >= 5 && !sample.includes('proj-a'), `the sample has its own simulated tenants: ${sample}`);

  const st = (await get('/d/claude-code/api/stats')).json;
  assert.deepEqual([st.source.id, st.source.note, st.sim.disabled], ['import:claude-code', 'Claude Code note', true]);
  assert.equal((await get('/d/finops/api/stats')).json.source, null);

  const src = (await get('/d/burstgpt/api/sources')).json;
  assert.equal(src.current, 'burstgpt');
  assert.equal(src.sources.length, 3);

  // an imported database never receives simulated rows; the sample does
  const r = await raw(app, '/d/claude-code/api/sim', { method: 'POST', headers: J, body: { running: true } });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /simulator is disabled/);
  assert.equal((await raw(app, '/d/finops/api/sim', { method: 'POST', headers: J, body: { rate: 25 } })).status, 200);
  assert.equal((await get('/d/claude-code/api/stats')).json.db.requests, 12);
});

test('the page and its assets are served under the prefix; unknown or malformed sources are 404', async () => {
  const page = await get('/d/claude-code/');
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>FinOps Dashboard<\/title>/);
  assert.match(page.text, /id="source"/);
  assert.equal((await get('/d/claude-code/app.js')).status, 200);
  assert.equal((await get('/d/claude-code/style.css')).status, 200);
  for (const bad of ['/d/nope/', '/d/nope/api/summary', '/d/Bad%20Name/', '/d/..%2f/x', '/d/claude-code%2fx/', '/d//', '/d/other/', '/d/broken/']) {
    assert.equal((await get(bad)).status, 404, bad);
  }
  // dot segments are resolved by the URL parser before routing: /d/%2e%2e/ is simply "/", which redirects to the default source;
  // nothing outside the sources is reachable, and a path that climbs out of a source cannot read another file
  assert.equal((await get('/d/%2e%2e/')).headers.location, '/d/finops/');
  assert.equal((await get('/d/claude-code/%2e%2e/%2e%2e/package.json')).status, 404);
  assert.equal((await get('/d/claude-code/../../src/server.js')).status, 404);
});

test('live streams work under the prefix: SSE and WebSocket, each on its own source', async () => {
  const sse = await new SseClient(app, { cid: randomCid(), basePath: '/d/burstgpt' }).ready;
  assert.equal(sse.status, 200);
  const snap = await sse.waitForEvent('snapshot');
  assert.ok(snap.data.rollups, 'a snapshot of that database');
  sse.close();
  const ws = await WsClient.connect(app, { cid: randomCid(), basePath: '/d/claude-code' });
  assert.equal(ws.status, 101);
  assert.ok(ws.acceptOk);
  await ws.waitForEvent('snapshot');
  ws.close();
  assert.equal((await WsClient.connect(app, { cid: randomCid(), basePath: '/d/nope' })).status, 404);
  assert.equal((await WsClient.connect(app, { cid: randomCid(), basePath: '/d/claude-code', origin: 'http://evil.example' })).status, 403);
  assert.equal((await WsClient.connect(app, { cid: randomCid() })).status, 404, '/ws at the root belongs to no source');
});

test('Origin and Host checks still apply under the prefix', async () => {
  const bad = await raw(app, '/d/claude-code/api/ingest', { method: 'POST', headers: { ...J, Origin: 'http://evil.example' }, body: { requests: [] } });
  assert.equal(bad.status, 403);
  assert.equal((await get('/d/claude-code/api/summary', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await get('/api/sources', { headers: { Host: 'evil.example' } })).status, 403);
  // writes land in the right database
  const ts = Math.floor(Date.now() / HOUR) * HOUR + 3;
  const ok = await raw(app, '/d/burstgpt/api/ingest', { method: 'POST', headers: J, body: { requests: [mkRequest({ ts, id: 'multi-ing-1', tenant: 'ingested-here' })] } });
  assert.equal(ok.status, 200, ok.text);
  assert.ok((await get('/d/burstgpt/api/by-tenant?range=24h')).json.rows.some((r) => r.key === 'ingested-here'));
  assert.ok(!(await get('/d/claude-code/api/by-tenant?range=24h')).json.rows.some((r) => r.key === 'ingested-here'));
});

test('the sample simulator runs while someone is watching, pauses when nobody is, resumes on return, and respects a manual pause', async () => {
  const running = async () => (await get('/d/finops/api/stats')).json.sim.running;
  const c1 = await new SseClient(app, { cid: randomCid(), basePath: '/d/finops' }).ready;
  await c1.waitForEvent('snapshot');
  await waitUntil(running, { what: 'the simulator to run for a viewer', timeout: 5000, interval: 50 });
  c1.close();
  await waitUntil(async () => !(await running()), { what: 'the simulator to pause when nobody watches', timeout: 6000, interval: 100 });
  const frozen = (await get('/d/finops/api/stats')).json.sim.written;
  await sleep(300);
  assert.equal((await get('/d/finops/api/stats')).json.sim.written, frozen, 'nothing is written while it is paused');
  const c2 = await new SseClient(app, { cid: randomCid(), basePath: '/d/finops' }).ready;
  await c2.waitForEvent('snapshot');
  await waitUntil(running, { what: 'the simulator to resume for the returning viewer', timeout: 5000, interval: 50 });
  assert.equal((await raw(app, '/d/finops/api/sim', { method: 'POST', headers: J, body: { running: false } })).status, 200);
  await sleep(400);
  assert.equal(await running(), false, 'a manual pause is not undone just because a viewer is connected');
  assert.equal((await raw(app, '/d/finops/api/sim', { method: 'POST', headers: J, body: { running: true } })).status, 200);
  assert.equal(await running(), true);
  c2.close();
});

test('a database imported while the server runs shows up without a restart', async () => {
  assert.ok(!(await get('/api/sources')).json.sources.some((s) => s.id === 'azure-conv'));
  const x = createImportDb({ path: join(dir, 'azure-conv.db'), source: 'import:trace:azure-conv', note: 'Azure note' });
  x.ingestor.ingest({ requests: [mkRequest({ ts: Date.now() - 60_000, id: 'az-1', tenant: 'tenant-01' })] });
  x.db.close();
  const s = (await get('/api/sources')).json.sources;
  assert.deepEqual(s.map((x) => x.id), ['finops', 'azure-conv', 'burstgpt', 'claude-code'], 'sorted by label: Azure, BurstGPT, Claude');
  assert.equal(s[1].label, 'Azure LLM trace: conversation');
  assert.equal((await get('/d/azure-conv/api/summary?range=24h')).json.totals.requests, 1);
});

test('DEFAULT_SOURCE chooses what / opens; an unknown one falls back to the sample', async () => {
  const a = await createMultiApp({ ...BASE, dataDir: dir, defaultSource: 'claude-code', simAutoStart: false });
  const b = await createMultiApp({ ...BASE, dataDir: dir, defaultSource: 'nope', simAutoStart: false });
  await a.listen(); await b.listen();
  try {
    assert.equal((await raw(a, '/')).headers.location, '/d/claude-code/');
    assert.equal((await raw(b, '/')).headers.location, '/d/finops/');
  } finally { await a.close(); await b.close(); }
});

test('authentication is done once, at the front door: Bearer, the cookie flow keeps the prefix, WebSocket included', async () => {
  const TOKEN = 'multi-mode-token-0123456789';
  const secured = await createMultiApp({ ...BASE, dataDir: dir, authToken: TOKEN, simAutoStart: false });
  await secured.listen();
  try {
    const g = (path, o) => raw(secured, path, o);
    assert.equal((await g('/d/claude-code/api/summary')).status, 401);
    assert.equal((await g('/api/sources')).status, 401);
    assert.equal((await g('/healthz')).status, 200);
    assert.equal((await g('/d/claude-code/api/summary?range=24h', { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
    const login = await g(`/d/claude-code/?token=${TOKEN}`);
    assert.equal(login.status, 303);
    assert.equal(login.headers.location, '/d/claude-code/', 'the redirect keeps the source and drops the token');
    const jar = { Cookie: login.headers['set-cookie'][0].split(';')[0] };
    assert.equal((await g('/d/claude-code/', { headers: jar })).status, 200);
    assert.equal((await g('/', { headers: jar })).status, 302);
    assert.equal((await g('/?token=wrong-wrong-wrong-wrong')).status, 401);
    assert.equal((await WsClient.connect(secured, { cid: randomCid(), basePath: '/d/claude-code', headers: jar })).status, 101);
    assert.equal((await WsClient.connect(secured, { cid: randomCid(), basePath: '/d/claude-code' })).status, 401);
    const noCookieSse = await new SseClient(secured, { cid: randomCid(), basePath: '/d/claude-code' }).ready;
    assert.equal(noCookieSse.status, 401);
    noCookieSse.req.destroy();
  } finally { await secured.close(); }
  await assert.rejects(createMultiApp({ ...BASE, dataDir: dir, authToken: 'short' }), /at least 16/);
});

test('refuses to listen on a non-loopback address without a token, like the single-database server', async () => {
  const open = await createMultiApp({ ...BASE, dataDir: dir, host: '0.0.0.0', simAutoStart: false });
  try {
    await assert.rejects(open.listen(), /refusing to listen on 0\.0\.0\.0/);
    assert.equal(open.server.listening, false);
  } finally { await open.close(); }
});

test('closing the server closes every workspace it opened', async () => {
  const d2 = makeDataDir();
  const a = await createMultiApp({ ...BASE, dataDir: d2, simAutoStart: false });
  await a.listen();
  await raw(a, '/d/claude-code/api/summary');
  const ws = await a.workspace('claude-code');
  await a.close();
  assert.equal(a.server.listening, false);
  assert.throws(() => ws.db.prepare('SELECT 1').get(), /not open|closed/i, 'its database was closed');
  rmSync(d2, { recursive: true, force: true });
});
