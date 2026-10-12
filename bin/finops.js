#!/usr/bin/env node
// The `finops` command: one front door for the dashboard server and the importers.
//
//   finops start [--port N] [--host H] [--data-dir DIR] [--db FILE] [--open]
//   finops import claude-code [importer options]     your own Claude Code usage  -> <data dir>/claude-code.db
//   finops import trace <trace.csv> [importer options]   a public trace (BurstGPT, Azure LLM inference)
//   finops proxy [--port N] [--tenant NAME] ...        record your app's Anthropic API calls live (point ANTHROPIC_BASE_URL at it)
//   finops check-llm                                  live check of ANTHROPIC_API_KEY against the real API
//   finops check-webhook                              send a test message to ALERT_WEBHOOK_URL
//
// It adds nothing to the application: every command runs the same entry point `npm start` / `npm run import:*` runs, as a child process
// (they need `--disable-warning=ExperimentalWarning`, which a shebang cannot carry). What it does add is a data directory that survives
// the package directory: run through npx, the package lives in a cache that is thrown away, and the importers' default `<package>/data`
// would lose your database. Default: ~/.finops-dashboard (override: --data-dir, or DATA_DIR).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const MIN_NODE = [22, 13];

const HELP = `finops ${pkg.version} - real-time FinOps dashboard for LLM + infrastructure cost

usage:
  finops start [--port N] [--host H] [--data-dir DIR] [--db FILE] [--open]
        serve the dashboard. Without --db: every database in the data directory, with a source switcher in the page.
        With --db: exactly that database at the root.      --open opens your browser once the server is up.
  finops import claude-code [--days N | --since YYYY-MM-DD] [--replace] [--db FILE] [--root DIR] ...
        import your own Claude Code usage (usage metadata only, never message text); then 'finops start'.
  finops import trace <trace.csv> [--format auto|burstgpt|azure] [--db FILE] [--replace] ...
        import a public LLM traffic trace.
  finops proxy [--port 8788] [--tenant NAME] [--source live] [--upstream URL] [--verbose]
        a local proxy that records the cost of every Anthropic Messages API call your app makes, live, in the dashboard:
        run it, then start your app with ANTHROPIC_BASE_URL=http://127.0.0.1:8788. Token counts only, never prompts or keys.
  finops check-llm
        send one tiny request with ANTHROPIC_API_KEY to confirm explanations can use the real API.
  finops check-webhook
        send one test message to ALERT_WEBHOOK_URL (Slack, Discord or JSON) to confirm alert notifications are set up.
  finops --version | --help

options for every command:
  --data-dir DIR   where databases live (default: $DATA_DIR, else ~/.finops-dashboard)

environment (see the README): PORT, HOST, DATA_DIR, DB_PATH, AUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, ...
 'finops <command> --help' shows the options of the underlying importer.
`;

function fail(msg) { console.error(`finops: ${msg}`); process.exit(2); }

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) fail(`Node ${MIN_NODE.join('.')} or newer is required (this is ${process.versions.node}); it provides node:sqlite.`);

/** Pull `--data-dir X` / `--data-dir=X` out of an argument list (the importers do not know it). */
function takeOption(args, name) {
  const rest = [];
  let value;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) { if (i + 1 >= args.length) fail(`--${name} needs a value`); value = args[++i]; }
    else if (args[i].startsWith(`--${name}=`)) value = args[i].slice(name.length + 3);
    else rest.push(args[i]);
  }
  return { value, rest };
}

function dataDirFrom(flag) {
  const dir = resolve(flag || process.env.DATA_DIR || join(homedir(), '.finops-dashboard'));
  mkdirSync(dir, { recursive: true, mode: 0o700 }); // it holds your usage data: owner only
  return dir;
}

/** Run a script of this package with the flags it needs, wired to this terminal; resolves with the exit code. */
function run(script, args, { env = {}, onStdout } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, script), ...args], {
      stdio: ['inherit', onStdout ? 'pipe' : 'inherit', 'inherit'], env: { ...process.env, FINOPS_CLI: '1', ...env },
    });
    if (onStdout) child.stdout.on('data', (d) => { process.stdout.write(d); onStdout(String(d)); });
    // Ctrl-C reaches the child by itself (same process group): forwarding it too would stop the server twice. SIGTERM/SIGHUP only
    // ever reach this process, so those are passed on; on SIGINT this process just waits for the child to finish.
    const forward = (sig) => () => { if (child.exitCode === null && child.signalCode === null) child.kill(sig); };
    const handlers = [['SIGINT', () => {}], ['SIGTERM', forward('SIGTERM')], ['SIGHUP', forward('SIGHUP')]];
    for (const [s, h] of handlers) process.on(s, h);
    child.on('exit', (code, signal) => { for (const [s, h] of handlers) process.off(s, h); done(code ?? (signal ? 128 + { SIGINT: 2, SIGHUP: 1, SIGTERM: 15 }[signal] || 1 : 1)); });
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const c = spawn(cmd, args, { stdio: 'ignore', detached: true });
    c.on('error', () => console.error(`finops: could not open a browser; open ${url} yourself`));
    c.unref();
  } catch { /* no opener on this machine: the URL is printed above */ }
}

async function start(argv) {
  let v;
  try {
    ({ values: v } = parseArgs({ args: argv, options: {
      port: { type: 'string' }, host: { type: 'string' }, 'data-dir': { type: 'string' }, db: { type: 'string' },
      open: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
    } }));
  } catch (e) { fail(`${e.message}\n\n${HELP}`); }
  if (v.help) { console.log(HELP); return 0; }
  if (v.port !== undefined && !/^\d{1,5}$/.test(v.port)) fail(`--port must be a number, got "${v.port}"`);
  const env = { DATA_DIR: dataDirFrom(v['data-dir']) };
  if (v.port !== undefined) env.PORT = v.port;
  if (v.host !== undefined) env.HOST = v.host;
  if (v.db !== undefined) env.DB_PATH = resolve(v.db);
  let opened = false;
  return run('src/server.js', [], { env, onStdout: v.open ? (text) => {
    const m = !opened && /dashboard on (http:\/\/\S+)/.exec(text);
    if (m) { opened = true; openBrowser(m[1]); }
  } : undefined });
}

async function importCmd(argv) {
  const [kind, ...rest0] = argv;
  const scripts = { 'claude-code': 'scripts/import-claude-code.js', trace: 'scripts/import-trace.js' };
  if (!kind || kind === '--help' || kind === '-h') { console.log(HELP); return kind ? 0 : 2; }
  if (!scripts[kind]) fail(`unknown importer "${kind}" (expected: claude-code, trace)\n\n${HELP}`);
  const { value: dataDirFlag, rest } = takeOption(rest0, 'data-dir');
  if (rest.includes('--help') || rest.includes('-h')) return run(scripts[kind], rest);
  // The importers write to $DATA_DIR (default <package>/data) unless --db says otherwise: point that at the user's data directory.
  return run(scripts[kind], rest, { env: { DATA_DIR: dataDirFrom(dataDirFlag) } });
}

const [cmd, ...rest] = process.argv.slice(2);
let code;
switch (cmd) {
  case undefined: case 'help': case '--help': case '-h': console.log(HELP); code = cmd === undefined ? 2 : 0; break;
  case '--version': case '-v': case 'version': console.log(pkg.version); code = 0; break;
  case 'start': code = await start(rest); break;
  case 'import': code = await importCmd(rest); break;
  case 'proxy': { const { value, rest: args } = takeOption(rest, 'data-dir'); code = await run('scripts/proxy.js', args, { env: { DATA_DIR: dataDirFrom(value) } }); break; }
  case 'check-llm': code = await run('scripts/check-anthropic.js', rest); break;
  case 'check-webhook': code = await run('scripts/check-webhook.js', rest); break;
  default: fail(`unknown command "${cmd}"\n\n${HELP}`);
}
process.exit(code);
