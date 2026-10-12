// Record every Anthropic Messages API call your app makes, live, in the dashboard: point the app's base URL at this proxy.
//
//   finops start                                     # the dashboard (in another terminal)
//   finops proxy [--port 8788] [--tenant myapp] [--source live] [--upstream https://api.anthropic.com] [--verbose]
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8788 python app.py       # anything using an Anthropic SDK honours this variable
//
// Per call it sends the dashboard only: tenant, endpoint, time, status, duration, model and the token counts of the response's own `usage` block.
// Prompts, completions, headers and API keys are never stored or logged. Label calls per tenant / feature with the request headers
// `x-finops-tenant: acme` and `x-finops-endpoint: /summarize` (the proxy strips them before forwarding). If the dashboard has AUTH_TOKEN, set the
// same AUTH_TOKEN in the proxy's environment (never on the command line). Anthropic Messages API only: see src/proxy.js for why.
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProxy, ensureLiveDb } from '../src/proxy.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = !!process.env.FINOPS_CLI;
const startCmd = cli ? 'finops start' : 'npm start';
let a;
try {
  ({ values: a } = parseArgs({ options: {
    port: { type: 'string', default: '8788' }, host: { type: 'string', default: '127.0.0.1' }, upstream: { type: 'string', default: 'https://api.anthropic.com' },
    dashboard: { type: 'string', default: 'http://127.0.0.1:8787' }, source: { type: 'string', default: 'live' }, tenant: { type: 'string', default: 'default' },
    verbose: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  } }));
} catch (e) { console.error(`${e.message}\n`); a = { help: true, bad: true }; }
if (a.help) {
  console.log(`usage: ${cli ? 'finops proxy' : 'npm run proxy --'} [--port 8788] [--tenant NAME] [--source live] [--dashboard http://127.0.0.1:8787] [--upstream https://api.anthropic.com] [--verbose]

  Point your app at it:  ANTHROPIC_BASE_URL=http://127.0.0.1:8788
  Label calls:           request headers  x-finops-tenant: acme   x-finops-endpoint: /summarize
  Dashboard with AUTH_TOKEN: set the same AUTH_TOKEN in this process's environment.`);
  process.exit(a.bad ? 2 : 0);
}
if (!/^\d{1,5}$/.test(a.port)) { console.error('--port must be a number'); process.exit(2); }

const dataDir = resolve(process.env.DATA_DIR || (cli ? join(homedir(), '.finops-dashboard') : join(ROOT, 'data')));
let proxy;
try {
  proxy = createProxy({ upstream: a.upstream, dashboard: a.dashboard, source: a.source, tenant: a.tenant, host: a.host, port: Number(a.port), authToken: process.env.AUTH_TOKEN || '', verbose: a.verbose, log: (m) => console.error(`[finops-proxy] ${m}`) });
  if (new URL(a.dashboard).hostname === '127.0.0.1' || new URL(a.dashboard).hostname === 'localhost') {
    const created = ensureLiveDb(join(dataDir, `${a.source}.db`)); // the dashboard lists it within a few seconds; real Claude prices are installed
    if (created) console.log(`[finops-proxy] created ${join(dataDir, `${a.source}.db`)} with the real price list`);
  }
  await proxy.listen();
} catch (e) {
  console.error(e.code === 'EADDRINUSE' ? `[finops-proxy] port ${a.port} is already in use - pick another with --port` : `[finops-proxy] ${e.message}`);
  process.exit(e.code === 'EADDRINUSE' ? 1 : 2);
}
console.log(`[finops-proxy] listening on ${proxy.url}  ->  ${new URL(a.upstream).host}   recording into "${a.source}" at ${a.dashboard}`);
console.log(`[finops-proxy] point your app at it:   export ANTHROPIC_BASE_URL=${proxy.url}`);
console.log(`[finops-proxy] watch it live:          ${startCmd}   then open ${a.dashboard}/d/${a.source}/   (data dir ${dataDir})`);
const stop = async () => { await proxy.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
