import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitUntil } from './helpers.js';

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
  const child = spawn(process.execPath, [BIN, 'start', '--port', '0', '--host', '127.0.0.1', ...args], { cwd: ROOT, env: { ...process.env, ...CLEAN, ...QUIET, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); // own process group, so a leftover server can be swept
  const run = { child, out: '', err: '' };
  child.stdout.on('data', (d) => { run.out += d; });
  child.stderr.on('data', (d) => { run.err += d; });
  run.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  run.url = () => waitUntil(() => /dashboard on (http:\/\/\S+)/.exec(run.out)?.[1], { timeout: 20_000, interval: 50, what: `the server to announce its URL (stdout: ${run.out.trim()} stderr: ${run.err.trim()})` });
  const sweep = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ } };
  run.stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); // to the CLI only, like `kill <pid>`: it must pass it on
    const r = await Promise.race([run.exited, new Promise((r2) => setTimeout(() => r2(null), 8000))]);
    sweep(); // a CLI that failed to forward the signal leaves its server running with our pipes open: the test would hang instead of failing
    if (!r) await run.exited;
    return r;
  };
  return run;
}

const withDir = async (fn) => { const dir = mkdtempSync(join(tmpdir(), 'finops-bin-')); try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

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
      assert.equal(r?.code, 0, `exit: ${JSON.stringify(r)} stderr: ${run.err}`);
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
      assert.equal((await run.stop())?.code, 0);
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
      assert.equal((await run.stop())?.code, 0);
    }
  });
});
