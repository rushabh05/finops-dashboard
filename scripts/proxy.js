// Record every LLM call your app makes, live, in the dashboard: point the app's base URL at this proxy.
//
//   finops start                                     # the dashboard (in another terminal)
//   finops proxy [--port 8788] [--tenant myapp] [--source live] [--upstream https://api.anthropic.com] [--verbose]
//                [--provider openai --provider deepseek --provider openrouter | --provider NAME=https://host]
//                [--price MODEL=in,out[,cached]] [--reported-cost NAME] [--tenant-by-key [--key-map FILE]]
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8788 python app.py       # anything using an Anthropic SDK honours this variable
//   OPENAI_BASE_URL=http://127.0.0.1:8788/openai/v1 python app.py  # with --provider openai
//
// Per call it sends the dashboard only: tenant, endpoint, time, status, duration, model and the token counts (and cost) of the response's own `usage` block.
// Prompts, completions, headers and API keys are never stored or logged. Label calls per tenant / feature with the request headers
// `x-finops-tenant: acme` and `x-finops-endpoint: /summarize` (the proxy strips them before forwarding), or per API key with --tenant-by-key.
// If the dashboard has AUTH_TOKEN, set the same AUTH_TOKEN in the proxy's environment (never on the command line). See src/proxy.js and src/providers.js.
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createProxy, ensureLiveDb } from '../src/proxy.js';
import { parsePriceArg } from '../src/import/prices.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = !!process.env.FINOPS_CLI;
const startCmd = cli ? 'finops start' : 'npm start';
let a;
try {
  ({ values: a } = parseArgs({ options: {
    port: { type: 'string', default: '8788' }, host: { type: 'string', default: '127.0.0.1' }, upstream: { type: 'string', default: 'https://api.anthropic.com' },
    dashboard: { type: 'string', default: 'http://127.0.0.1:8787' }, source: { type: 'string', default: 'live' }, tenant: { type: 'string', default: 'default' },
    provider: { type: 'string', multiple: true, default: [] }, 'reported-cost': { type: 'string', multiple: true, default: [] }, price: { type: 'string', multiple: true, default: [] },
    'tenant-by-key': { type: 'boolean', default: false }, 'key-map': { type: 'string' },
    verbose: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  } }));
} catch (e) { console.error(`${e.message}\n`); a = { help: true, bad: true }; }
if (a.help) {
  console.log(`usage: ${cli ? 'finops proxy' : 'npm run proxy --'} [--port 8788] [--tenant NAME] [--source live] [--dashboard http://127.0.0.1:8787] [--upstream https://api.anthropic.com] [--verbose]
                  [--provider NAME ...] [--price MODEL=in,out[,cached] ...] [--reported-cost NAME ...] [--tenant-by-key] [--key-map FILE]

  Anthropic (always on):  ANTHROPIC_BASE_URL=http://127.0.0.1:8788
  More providers:         --provider openai | deepseek | openrouter, or  --provider NAME=https://host  for any OpenAI-compatible endpoint
                          each one is served under its own prefix: /openai/v1, /deepseek, /openrouter/api/v1, /NAME (the base URLs are printed at start-up)
  Prices:                 OpenAI and DeepSeek calls are priced at list prices; OpenRouter reports each call's own cost. --price MODEL=in,out,cached
                          (USD per million tokens) adds or overrides a model; --reported-cost NAME trusts that provider's usage.cost
  Which key:              --tenant-by-key records each API key as a tenant named by a one-way label (key-3fa91c07d2); --key-map FILE
                          (JSON {"key-3fa91c07d2": "search-team"}) names them. Get a key's label with:  printf %s "$KEY" | ${cli ? 'finops' : 'node scripts/key-label.js #'} key-label
  Label calls:            request headers  x-finops-tenant: acme   x-finops-endpoint: /summarize  (they win over the key)
  Dashboard with AUTH_TOKEN: set the same AUTH_TOKEN in this process's environment.`);
  process.exit(a.bad ? 2 : 0);
}
if (!/^\d{1,5}$/.test(a.port)) { console.error('--port must be a number'); process.exit(2); }

const fail2 = (msg) => { console.error(`[finops-proxy] ${msg}`); process.exit(2); };
let prices, keyMap;
try { prices = a.price.map(parsePriceArg); } catch (e) { fail2(e.message); }
if (a['key-map']) {
  try { keyMap = JSON.parse(readFileSync(a['key-map'], 'utf8')); } catch (e) { fail2(`cannot read --key-map ${a['key-map']}: ${e.message}`); }
  if (!keyMap || typeof keyMap !== 'object' || Array.isArray(keyMap)) fail2('--key-map must hold a JSON object: {"key-3fa91c07d2": "team-name"}');
}

const dataDir = resolve(process.env.DATA_DIR || (cli ? join(homedir(), '.finops-dashboard') : join(ROOT, 'data')));
let proxy;
try {
  proxy = createProxy({ upstream: a.upstream, dashboard: a.dashboard, source: a.source, tenant: a.tenant, host: a.host, port: Number(a.port), authToken: process.env.AUTH_TOKEN || '', verbose: a.verbose,
    providers: a.provider, reportedCost: a['reported-cost'], prices, keyTenants: a['tenant-by-key'] || !!keyMap, keyMap: keyMap ?? {}, log: (m) => console.error(`[finops-proxy] ${m}`) });
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
const BASE = { openai: (u) => `export OPENAI_BASE_URL=${u}/openai/v1`, deepseek: (u) => `base_url=${u}/deepseek`, openrouter: (u) => `base_url=${u}/openrouter/api/v1` };
for (const n of proxy.providers) console.log(`[finops-proxy] ${n.padEnd(10)} ${(BASE[n] ?? ((u) => `base_url=${u}/${n}  followed by whatever comes after the host in its real base URL (e.g. /api/v1)`))(proxy.url)}`);
if (a['tenant-by-key'] || keyMap) console.log('[finops-proxy] tenants: one per API key (a one-way label; the key itself is never stored or logged)');
console.log(`[finops-proxy] watch it live:          ${startCmd}   then open ${a.dashboard}/d/${a.source}/   (data dir ${dataDir})`);
const stop = async () => { await proxy.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
