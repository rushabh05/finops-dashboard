import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStoppedCleanly, waitUntil } from './helpers.js';

/*
 * These run the REAL entry point (`node src/server.js`, what `npm start` runs) as a child process. Every other test imports createApp /
 * createMultiApp directly, so none of them noticed when the entry point deadlocked on a circular import ("unsettled top-level await")
 * and `npm start` exited silently.
 */
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function start(env) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    cwd: ROOT, env: { ...process.env, DB_PATH: '', AUTH_TOKEN: '', ANTHROPIC_API_KEY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = { child, out: '', err: '' };
  child.stdout.on('data', (d) => { run.out += d; });
  child.stderr.on('data', (d) => { run.err += d; });
  run.exited = new Promise((resolveExit) => child.on('exit', (code, signal) => resolveExit({ code, signal })));
  run.url = () => waitUntil(() => /dashboard on (http:\/\/\S+)/.exec(run.out)?.[1], { timeout: 20_000, interval: 50, what: `the server to announce its URL (stdout: ${run.out.trim()} stderr: ${run.err.trim()})` });
  // The server announces itself with several console.log calls; stdout is a pipe, so a line can arrive a moment after the one before it.
  // Assert on a line only after waiting for it, never right after run.url().
  run.line = (re) => waitUntil(() => re.exec(run.out)?.[0], { timeout: 20_000, interval: 50, what: `${re} in the server output (stdout: ${run.out.trim()} stderr: ${run.err.trim()})` });
  run.stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const r = await Promise.race([run.exited, new Promise((r2) => setTimeout(() => r2(null), 5000))]);
    if (!r) { child.kill('SIGKILL'); await run.exited; }
    return r;
  };
  return run;
}
const withDir = async (fn) => { const dir = mkdtempSync(join(tmpdir(), 'finops-cli-')); try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };
const QUIET = { PORT: '0', HOST: '127.0.0.1', SEED_DAYS: '1', SEED_VOLUME: '0.1', SIM_AUTOSTART: '0' };

test('npm start (no DB_PATH): multi-database mode comes up, serves the switcher list and the page, and stops cleanly on SIGTERM', async () => {
  await withDir(async (dir) => {
    const run = start({ ...QUIET, DATA_DIR: dir });
    try {
      const url = await run.url();
      await run.line(/data sources in .*finops \(sample\)/);
      assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { ok: true, mode: 'multi' });
      const sources = await (await fetch(`${url}/api/sources`)).json();
      assert.deepEqual(sources.sources.map((s) => s.id), ['finops']);
      const page = await fetch(`${url}/`); // follows the redirect to /d/finops/
      assert.equal(page.status, 200);
      assert.match(page.url, /\/d\/finops\/$/);
      assert.match(await page.text(), /id="source"/);
      assert.equal((await fetch(`${url}/d/finops/api/stats`)).status, 200);
    } finally {
      const r = await run.stop();
      assertStoppedCleanly(assert, r, `stderr: ${run.err}`);
    }
  });
});

test('DB_PATH set: exactly that database at the root, no switcher (the original single-database mode)', async () => {
  await withDir(async (dir) => {
    const run = start({ ...QUIET, DB_PATH: join(dir, 'one.db') });
    try {
      const url = await run.url();
      assert.doesNotMatch(run.out, /data sources in/);
      const h = await (await fetch(`${url}/healthz`)).json();
      assert.equal(h.ok, true);
      assert.equal(h.mode, undefined);
      assert.deepEqual(await (await fetch(`${url}/api/sources`)).json(), { current: null, sources: [] });
      assert.match(await (await fetch(`${url}/`)).text(), /<title>FinOps Dashboard<\/title>/);
      assert.equal((await fetch(`${url}/api/stats`)).status, 200);
    } finally {
      assertStoppedCleanly(assert, await run.stop());
    }
  });
});

test('AUTH_TOKEN through the entry point: announced, enforced on every source', async () => {
  await withDir(async (dir) => {
    const run = start({ ...QUIET, DATA_DIR: dir, AUTH_TOKEN: 'cli-token-0123456789abcdef' });
    try {
      const url = await run.url();
      await run.line(/AUTH_TOKEN is set/);
      assert.equal((await fetch(`${url}/d/finops/api/summary`)).status, 401);
      assert.equal((await fetch(`${url}/d/finops/api/summary`, { headers: { Authorization: 'Bearer cli-token-0123456789abcdef' } })).status, 200);
    } finally {
      assertStoppedCleanly(assert, await run.stop());
    }
  });
});

test('refusals exit with status 1 and say why: non-loopback without a token, a busy port, a too-short token', async () => {
  await withDir(async (dir) => {
    const exposed = start({ ...QUIET, DATA_DIR: dir, HOST: '0.0.0.0' });
    const r1 = await exposed.exited;
    assert.equal(r1.code, 1);
    assert.match(exposed.err, /refusing to listen on 0\.0\.0\.0 without AUTH_TOKEN/);

    const short = start({ ...QUIET, DATA_DIR: dir, AUTH_TOKEN: 'short' });
    assert.equal((await short.exited).code !== 0, true);
    assert.match(short.err, /at least 16/);

    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    try {
      const busy = start({ ...QUIET, DATA_DIR: dir, PORT: String(blocker.address().port) });
      const r3 = await busy.exited;
      assert.equal(r3.code, 1);
      assert.match(busy.err, /already in use/);
    } finally { blocker.close(); }
  });
});

test('importing src/server.js starts nothing (the tests and scripts rely on that)', async () => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', "import('./src/server.js').then((m) => { console.log(Object.keys(m).sort().join(',')); })"], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0, 'the process ends by itself: nothing is listening');
  assert.equal(out.trim(), 'createApp,createMultiApp,createWorkspace');
});
