import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStoppedCleanly, waitUntil } from './helpers.js';

/*
 * The `finops` command (bin/finops.js) is a front door over the same entry points `npm start` and `npm run import:*` use. These tests run it
 * for real, as a child process, in throwaway directories: what it prints, where it puts data, that SIGTERM reaches the server it started,
 * and that an import made through it is served by `finops start`.
 */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BIN = join(ROOT, 'bin', 'finops.js');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const CLEAN = { DB_PATH: '', DATA_DIR: '', AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', FINOPS_CLI: '' };
const QUIET = { SEED_DAYS: '1', SEED_VOLUME: '0.1', SIM_AUTOSTART: '0' };

const finops = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...CLEAN, ...env } });

function serve(args, env = {}) {
  const child = spawn(process.execPath, [BIN, 'start', '--port', '0', '--host', '127.0.0.1', ...args], { cwd: ROOT, env: { ...process.env, ...CLEAN, ...QUIET, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true }); // own process group, so a leftover server can be swept
  const run = { child, out: '', err: '' };
  child.stdout.on('data', (d) => { run.out += d; });
  child.stderr.on('data', (d) => { run.err += d; });
  run.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  run.url = () => waitUntil(() => /dashboard on (http:\/\/\S+)/.exec(run.out)?.[1], { timeout: 20_000, interval: 50, what: `the server to announce its URL (stdout: ${run.out.trim()} stderr: ${run.err.trim()})` });
  const sweep = () => killTree(child);
  run.stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); // to the CLI only, like `kill <pid>`: it must pass it on
    const r = await Promise.race([run.exited, new Promise((r2) => setTimeout(() => r2(null), 8000))]);
    sweep(); // a CLI that failed to forward the signal leaves its server running with our pipes open: the test would hang instead of failing
    if (!r) await run.exited;
    return r;
  };
  return run;
}

// An open file cannot be deleted on Windows, and a killed process releases its files a moment late: retry the cleanup.
const withDir = async (fn) => { const dir = mkdtempSync(join(tmpdir(), 'finops-bin-')); try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };

/**
 * Stop a CLI process AND the server it started. POSIX: the CLI forwards SIGTERM, and the whole process group is swept as a safety net. Windows has no
 * signals: kill() ends the CLI at once without running its handlers, so its server child would be left running with the database open; kill the tree.
 */
function killTree(child) {
  if (process.platform === 'win32') { try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } }
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ } }
}

/** A miniature ~/.claude/projects: one project, one session, one prompt answered by one API response. Message text is a canary. */
function makeTranscripts(dir) {
  const ts = (ms) => new Date(Date.now() - 3_600_000 + ms).toISOString();
  const base = (o) => ({ isSidechain: false, userType: 'external', entrypoint: 'claude-vscode', cwd: '/Users/me/work/alpha', sessionId: 'sess-1', version: '9.9.9', ...o });
  const usage = { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } };
  const lines = [
    base({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: ts(0), message: { role: 'user', content: 'SECRET prompt' } }),
    base({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: ts(2000), requestId: 'req_1', message: { id: 'msg_1', model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: 'SECRET answer' }], usage } }),
  ];
  const root = join(dir, 'projects');
  mkdirSync(join(root, '-Users-me-work-alpha'), { recursive: true });
  writeFileSync(join(root, '-Users-me-work-alpha', 'sess-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return root;
}

test('finops: --version, help, and the ways to get a command wrong all say so and exit with the right status', () => {
  const v = finops(['--version']);
  assert.equal(v.status, 0);
  assert.equal(v.stdout.trim(), pkg.version);

  const help = finops(['help']);
  assert.equal(help.status, 0);
  for (const word of ['finops start', 'finops import claude-code', 'finops import trace', 'finops check-llm', '--data-dir']) assert.match(help.stdout, new RegExp(word));

  const bare = finops([]);
  assert.equal(bare.status, 2, 'no command is a usage error, not a success');
  assert.match(bare.stdout, /usage:/);

  const unknown = finops(['frobnicate']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command "frobnicate"/);

  assert.match(finops(['start', '--port', 'abc']).stderr, /--port must be a number/);
  assert.match(finops(['start', '--bogus']).stderr, /Unknown option '--bogus'/);
  assert.match(finops(['import', 'nothing']).stderr, /unknown importer "nothing"/);
  assert.match(finops(['import', 'trace', '--help']).stdout, /usage: finops import trace/, 'the importer names the command that was used');
});

test('finops start --data-dir: creates the directory private, serves it as multi-database mode, and SIGTERM reaches the server (exit 0)', async () => {
  await withDir(async (dir) => {
    const data = join(dir, 'fresh', 'data'); // does not exist yet
    const run = serve(['--data-dir', data]);
    try {
      const url = await run.url();
      assert.equal(existsSync(data), true);
      if (process.platform !== 'win32') assert.equal(statSync(data).mode & 0o777, 0o700, 'usage data: owner only');
      assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { ok: true, mode: 'multi' });
      await waitUntil(() => run.out.includes(`data sources in ${data}`), { what: `the server to name the data directory (stdout: ${run.out.trim()})` });
    } finally {
      const r = await run.stop();
      assertStoppedCleanly(assert, r, `stderr: ${run.err}`);
    }
  });
});

test('finops import claude-code, then finops start: the import lands in the data directory and is served as a source', async () => {
  await withDir(async (dir) => {
    const data = join(dir, 'data');
    const root = makeTranscripts(dir);
    const imp = finops(['import', 'claude-code', '--root', root, '--data-dir', data]);
    assert.equal(imp.status, 0, `${imp.stdout}\n${imp.stderr}`);
    assert.equal(existsSync(join(data, 'claude-code.db')), true, 'written to <data dir>/claude-code.db, not to the package directory');
    assert.match(imp.stdout, /View it:\s+finops start --data-dir /, 'the hint names the command that was used, not npm');
    assert.doesNotMatch(imp.stdout, /npm start/);

    const run = serve(['--data-dir', data]);
    try {
      const url = await run.url();
      const { sources } = await (await fetch(`${url}/api/sources`)).json();
      const cc = sources.find((s) => s.id === 'claude-code');
      assert.ok(cc, `claude-code is listed: ${JSON.stringify(sources)}`);
      assert.equal(cc.kind, 'imported');
      const { totals } = await (await fetch(`${url}/d/claude-code/api/summary`)).json();
      assert.deepEqual([totals.requests, totals.llm_calls, totals.tokens_in, totals.tokens_out], [1, 1, 100, 50], 'the one prompt + response in the fixture, nothing else');
      assert.ok(totals.cost_micro_usd > 0);
    } finally {
      assertStoppedCleanly(assert, await run.stop());
    }
  });
});

test('finops start --db FILE: exactly that database at the root, no source switcher', async () => {
  await withDir(async (dir) => {
    const root = makeTranscripts(dir);
    const db = join(dir, 'elsewhere', 'mine.db');
    mkdirSync(join(dir, 'elsewhere'));
    const imp = finops(['import', 'claude-code', '--root', root, '--db', db, '--data-dir', join(dir, 'data')]);
    assert.equal(imp.status, 0, `${imp.stdout}\n${imp.stderr}`);
    assert.match(imp.stdout, /finops start --db /, 'outside the data directory the hint uses --db');

    const run = serve(['--db', db, '--data-dir', join(dir, 'data')]);
    try {
      const url = await run.url();
      const h = await (await fetch(`${url}/healthz`)).json();
      assert.equal(h.ok, true);
      assert.equal(h.mode, undefined, 'single-database mode');
      assert.deepEqual(await (await fetch(`${url}/api/sources`)).json(), { current: null, sources: [] });
      assert.equal((await fetch(`${url}/api/stats`)).status, 200);
    } finally {
      assertStoppedCleanly(assert, await run.stop());
    }
  });
});

const freePort = () => new Promise((resolve) => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); });

function spawnCli(args, env = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, env: { ...process.env, ...CLEAN, ...QUIET, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
  const run = { child, out: '', err: '' };
  child.stdout.on('data', (d) => { run.out += d; });
  child.stderr.on('data', (d) => { run.err += d; });
  run.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  run.stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const r = await Promise.race([run.exited, new Promise((r2) => setTimeout(() => r2(null), 8000))]);
    killTree(child);
    if (!r) await run.exited;
    return r;
  };
  return run;
}

test('finops proxy: refuses the simulated sample database, rejects unknown options, and --help names the command', async () => {
  await withDir(async (dir) => {
    const sample = finops(['proxy', '--source', 'finops', '--data-dir', join(dir, 'd')]);
    assert.equal(sample.status, 2);
    assert.match(sample.stderr, /simulated sample database/);
    assert.match(finops(['proxy', '--help']).stdout, /usage: finops proxy/);
    assert.match(finops(['proxy', '--bogus']).stderr, /Unknown option/);
    assert.match(finops(['help']).stdout, /finops proxy/);
  });
});

test('finops proxy + finops start, as real processes: a call made through the proxy shows up in the dashboard with the right tokens and cost', async () => {
  await withDir(async (dir) => {
    const data = join(dir, 'data');
    const reply = JSON.stringify({ id: 'msg_1', type: 'message', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'SECRET answer' }], usage: { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 }, output_tokens: 300 } });
    const seen = [];
    const upstream = http.createServer((req, res) => { seen.push(req.headers['x-api-key']); req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(reply); }); });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const dashPort = await freePort();
    // the proxy first: it creates <data>/live.db, so the dashboard finds it on its first look
    const proxy = spawnCli(['proxy', '--port', '0', '--data-dir', data, '--dashboard', `http://127.0.0.1:${dashPort}`, '--upstream', `http://127.0.0.1:${upstream.address().port}`, '--tenant', 'checkout']);
    const dash = serve(['--data-dir', data, '--port', String(dashPort)]);
    try {
      const proxyUrl = await waitUntil(() => /listening on (http:\/\/\S+)/.exec(proxy.out)?.[1], { timeout: 20_000, interval: 50, what: `the proxy to start (stdout: ${proxy.out} stderr: ${proxy.err})` });
      // the proxy prints these with separate writes: wait for each line instead of asserting the moment the first one arrives
      const sees = (re, what) => waitUntil(() => re.test(proxy.out), { timeout: 20_000, interval: 50, what: `${what} (stdout: ${proxy.out} stderr: ${proxy.err})` });
      await sees(/export ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:\d+/, 'the proxy to say how to point your app at it');
      await sees(/created .*live\.db with the real price list/, 'the proxy to say it created the live database');
      const url = await dash.url();

      const res = await fetch(`${proxyUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test-key' }, body: JSON.stringify({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'hi' }] }) });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).id, 'msg_1');
      assert.deepEqual(seen, ['sk-ant-test-key']);

      const totals = await waitUntil(async () => {
        const r = await fetch(`${url}/d/live/api/summary`);
        const j = r.status === 200 ? await r.json() : null;
        return j?.totals?.requests === 1 ? j.totals : null;
      }, { timeout: 20_000, interval: 200, what: `the call to show up in the dashboard (proxy stdout: ${proxy.out} stderr: ${proxy.err})` });
      assert.deepEqual([totals.tokens_in, totals.tokens_out, totals.cost_micro_usd], [1700, 300, 5600]);
      const sources = (await (await fetch(`${url}/api/sources`)).json()).sources;
      assert.equal(sources.find((x) => x.id === 'live')?.kind, 'live');
      const { rows } = await (await fetch(`${url}/d/live/api/requests?sort=recent`)).json();
      assert.deepEqual(rows.map((r) => [r.tenant_id, r.endpoint, r.status, r.llm_calls]), [['checkout', '/v1/messages', 200, 1]], 'labelled with the --tenant given to the proxy');
      assert.ok(!(proxy.out + proxy.err).includes('sk-ant-test-key'), 'the key is not in the proxy output');
    } finally {
      assertStoppedCleanly(assert, await proxy.stop(), `proxy stderr: ${proxy.err}`);
      assertStoppedCleanly(assert, await dash.stop());
      await new Promise((r) => { upstream.close(r); upstream.closeAllConnections?.(); });
    }
  });
});

test('finops proxy --provider / --price / --tenant-by-key, as real processes: the flags reach the proxy, the base URL is printed, and a call is recorded under its key\'s label', async () => {
  await withDir(async (dir) => {
    const data = join(dir, 'data');
    const KEY = 'sk-gw-SECRET-GATEWAY-KEY';
    const seen = [];
    const upstream = http.createServer((req, res) => { seen.push([req.url, req.headers.authorization]); req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ model: 'some-model', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200 } })); }); });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const dashPort = await freePort();
    const proxy = spawnCli(['proxy', '--port', '0', '--data-dir', data, '--dashboard', `http://127.0.0.1:${dashPort}`, '--provider', `gw=http://127.0.0.1:${upstream.address().port}`, '--price', 'some-model=2,10', '--tenant-by-key']);
    const dash = serve(['--data-dir', data, '--port', String(dashPort)]);
    try {
      const proxyUrl = await waitUntil(() => /listening on (http:\/\/\S+)/.exec(proxy.out)?.[1], { timeout: 20_000, interval: 50, what: `the proxy to start (stdout: ${proxy.out} stderr: ${proxy.err})` });
      const sees = (re, what) => waitUntil(() => re.test(proxy.out), { timeout: 20_000, interval: 50, what: `${what} (stdout: ${proxy.out} stderr: ${proxy.err})` });
      await sees(/gw\s+base_url=http:\/\/127\.0\.0\.1:\d+\/gw/, 'the proxy to print the base URL of the gw provider');
      await sees(/tenants: one per API key/, 'the proxy to say it tells keys apart');
      const url = await dash.url();

      const res = await fetch(`${proxyUrl}/gw/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: '{"model":"some-model","messages":[]}' });
      assert.equal(res.status, 200);
      assert.deepEqual(seen, [['/v1/chat/completions', `Bearer ${KEY}`]], 'the prefix is stripped and the key is forwarded');
      const totals = await waitUntil(async () => {
        const r = await fetch(`${url}/d/live/api/summary`);
        const j = r.status === 200 ? await r.json() : null;
        return j?.totals?.requests === 1 ? j.totals : null;
      }, { timeout: 20_000, interval: 200, what: `the call to show up in the dashboard (proxy stdout: ${proxy.out} stderr: ${proxy.err})` });
      assert.deepEqual([totals.tokens_in, totals.tokens_out, totals.cost_micro_usd], [1000, 200, 1000 * 2 + 200 * 10], '--price reached the proxy');
      const { rows } = await (await fetch(`${url}/d/live/api/requests?sort=recent`)).json();
      const expected = spawnSync(process.execPath, [BIN, 'key-label'], { input: KEY, encoding: 'utf8' }).stdout.trim();
      assert.deepEqual(rows.map((r) => [r.tenant_id, r.endpoint]), [[expected, '/gw/v1/chat/completions']]);
      assert.match(expected, /^key-[0-9a-f]{10}$/);
      assert.ok(!(proxy.out + proxy.err).includes(KEY), 'the key is not in the proxy output');
    } finally {
      assertStoppedCleanly(assert, await proxy.stop(), `proxy stderr: ${proxy.err}`);
      assertStoppedCleanly(assert, await dash.stop());
      await new Promise((r) => { upstream.close(r); upstream.closeAllConnections?.(); });
    }
  });
});

test('finops proxy: a wrong --provider, --price or --key-map is refused with exit 2 and a message that says what to do', async () => {
  await withDir(async (dir) => {
    const bad = (args) => finops(['proxy', '--data-dir', join(dir, 'd'), ...args]);
    const a = bad(['--provider', 'nope']);
    assert.equal(a.status, 2);
    assert.match(a.stderr, /unknown provider "nope".*--provider nope=https/s);
    assert.match(bad(['--provider', 'openai', '--reported-cost', 'deepseek']).stderr, /no provider called "deepseek"/);
    assert.match(bad(['--price', 'gpt-x']).stderr, /bad --price/);
    assert.match(bad(['--key-map', join(dir, 'missing.json')]).stderr, /cannot read --key-map/);
    writeFileSync(join(dir, 'map.json'), '{"not-a-label": "x"}');
    assert.match(bad(['--key-map', join(dir, 'map.json')]).stderr, /not a key label/);
    writeFileSync(join(dir, 'arr.json'), '[1]');
    assert.match(bad(['--key-map', join(dir, 'arr.json')]).stderr, /must hold a JSON object/);
    assert.match(finops(['help']).stdout, /key-label/);
  });
});
