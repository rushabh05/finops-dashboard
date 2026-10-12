// Optional UI check of the "Data source" switcher in headless Chrome (dev-only, not part of `npm test`):
//   node --disable-warning=ExperimentalWarning scripts/ui-smoke-switcher.mjs [shots-dir]
// Starts a multi-database server over a throw-away data directory (a simulated sample plus two small imported databases),
// then switches between the sources the way a person would, over SSE and over WebSocket, and checks the page each time.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createMultiApp } from '../src/multi.js';
import { createImportDb, BatchWriter } from '../src/import/common.js';
import { launch, sleep } from './cdp.mjs';

const shots = resolve(process.argv[2] || tmpdir());
mkdirSync(shots, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'finops-switcher-'));
const HOUR = 3600_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR - 30 * HOUR;
for (const [file, source, note, tenants] of [
  ['claude-code.db', 'import:claude-code', 'Imported Claude Code usage. Cost is the API-equivalent list price.', ['alpha-app', 'beta-cli']],
  ['burstgpt.db', 'import:trace:burstgpt', 'Public trace: BurstGPT. Tenants are SYNTHETIC.', ['tenant-01', 'tenant-02', 'tenant-03']],
]) {
  const x = createImportDb({ path: join(dir, file), source, note });
  const w = new BatchWriter(x.ingestor);
  for (let i = 0; i < 600; i++) w.add({ id: `${file}-${i}`, ts: T0 + i * 3 * 60_000, tenant_id: tenants[i % tenants.length], endpoint: i % 3 ? '/api' : '/conversation', method: 'POST', status: 200, duration_ms: 50, infra_cost_micro_usd: 0, llm_calls: [{ model: 'claude-sonnet-5-5', input_tokens: 800 + (i % 7) * 100, output_tokens: 120, cached_tokens: 0, latency_ms: 300 }] });
  w.flush();
  x.db.close();
}

let failures = 0;
const ok = (name, cond, extra = '') => { if (!cond) failures++; console.log(cond ? 'PASS' : 'FAIL', name, extra); };
const app = await createMultiApp({ dataDir: dir, port: 0, seedDays: 4, volumeScale: 0.3, simAutoStart: true, simRate: 60, detectEveryMs: 400 });
await app.listen();
const b = await launch({ width: 1440, height: 1000 });
const ev = (e) => b.eval(e);
const pick = async (id) => { await ev(`(() => { const s = document.querySelector('#source'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change')); })()`); await sleep(3500); };
const state = () => ev(`({ path: location.pathname, token: location.search, title: document.title, selected: document.querySelector('#source').value, visible: !!document.querySelector('#source').offsetParent, options: [...document.querySelectorAll('#source option')].map((o) => o.value + '=' + o.textContent), banner: (() => { const e = document.querySelector('#source-banner'); return e && !e.hidden ? e.innerText.slice(0, 60) : null; })(), tenants: [...document.querySelectorAll('#tenantcard tbody tr td:first-child')].map((t) => t.innerText.trim()).sort(), conn: document.querySelector('#conn').dataset.state })`);
try {
  await b.emulate({ dark: false, reducedMotion: false });
  await b.goto(app.url + '/');
  await sleep(4000);
  let st = await state();
  ok('/ lands on the sample data', st.path === '/d/finops/', st.path);
  ok('the Data source dropdown is shown with all three sources', st.visible && st.options.length === 3, st.options.join(' | '));
  ok('sample selected, no import banner, title names it', st.selected === 'finops' && st.banner === null && /Sample data/.test(st.title), st.title);
  ok('sample data is live over SSE', st.conn === 'live' && st.tenants.length >= 5, `${st.tenants.length} tenants`);
  await b.shot(`${shots}/switcher-sample.png`, { fullPage: false });

  await pick('claude-code');
  st = await state();
  ok('picking "Claude Code usage" opens /d/claude-code/', st.path === '/d/claude-code/' && st.selected === 'claude-code', st.path);
  ok('its own banner and tenants, not the sample', /Imported data/.test(st.banner || '') && st.tenants.join() === 'alpha-app,beta-cli', `${st.banner} | ${st.tenants}`);
  ok('live over SSE under the prefix', st.conn === 'live');
  ok('the simulator controls are gone on an imported source', (await ev(`[...document.querySelectorAll('.sim-only')].every((e) => e.offsetParent === null)`)) === true);

  await ev(`(() => { const s = document.querySelector('#transport'); s.value = 'ws'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(2500);
  ok('live over WebSocket under the prefix', (await state()).conn === 'live' && /WebSocket/.test(await ev(`document.querySelector('#conntext').textContent`)));

  await pick('burstgpt');
  st = await state();
  ok('switching again lands on /d/burstgpt/ with its tenants', st.path === '/d/burstgpt/' && st.tenants.join() === 'tenant-01,tenant-02,tenant-03', `${st.path} ${st.tenants}`);
  ok('the transport choice and theme persist across sources (same origin)', (await ev(`document.querySelector('#transport').value`)) === 'ws');
  await b.shot(`${shots}/switcher-burstgpt.png`, { fullPage: false });

  await pick('finops');
  st = await state();
  ok('and back to the sample', st.path === '/d/finops/' && st.banner === null && st.tenants.length >= 5, st.path);
  await ev('history.back()');
  await sleep(3500);
  st = await state();
  ok('the browser Back button returns to the previous source', st.path === '/d/burstgpt/' && st.selected === 'burstgpt', `${st.path} selected=${st.selected}`);
  ok('and the restored page is live again (its socket was closed cleanly and reopened)', st.conn === 'live' && st.tenants.length === 3, `${st.conn} ${st.tenants}`);
  await ev('history.forward()');
  await sleep(3500);
  st = await state();
  ok('Forward works too and is live', st.path === '/d/finops/' && st.conn === 'live', `${st.path} ${st.conn}`);

  await b.resize(390, 900);
  await sleep(800);
  ok('no horizontal scroll at 390 px with the switcher in the header', (await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`)) === true);
  await b.shot(`${shots}/switcher-mobile.png`, { fullPage: false });

  const bad = b.logs.filter((l) => /exception|log\.error|Content Security Policy|console\.error/i.test(l));
  ok('no console errors or CSP violations across all of it', bad.length === 0, bad.slice(0, 3).join(' | '));
} finally {
  b.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} FAILED` : 'all checks passed', `- screenshots in ${shots}`);
process.exit(failures ? 1 : 0);
