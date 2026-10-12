import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';
import { launch, sleep } from './cdp.mjs';

// Optional UI smoke test in a real (headless) Chrome: node --disable-warning=ExperimentalWarning scripts/ui-smoke.mjs
// Loads the dashboard against a live simulated backend, clicks through the main flows, fails on console errors / CSP
// violations, and writes screenshots to the OS temp dir. Not part of `npm test` (needs a browser).
const SP = tmpdir();
let failures = 0;
const app = await createApp({ dbPath: ':memory:', port: 0, seedDays: 9, simAutoStart: true, simRate: 200, detectEveryMs: 300 });
await app.listen();
const b = await launch();
const ok = (name, cond, extra = '') => { if (!cond) failures++; console.log(cond ? 'PASS' : 'FAIL', name, extra); };
const ev = (e) => b.eval(e);
try {
  await b.emulate({ dark: false, reducedMotion: false });
  await b.goto(app.url);
  await sleep(4000);

  // 1. click a tenant row -> filter chip, summary changes
  const before = await ev(`document.querySelector('.tile .value').textContent`);
  await ev(`document.querySelector('#tenantcard tbody tr td button').click()`);
  await sleep(1800);
  const chip = await ev(`document.querySelector('#filters .chip')?.innerText`);
  const after = await ev(`document.querySelector('.tile .value').textContent`);
  ok('tenant click adds filter chip', /tenant/.test(chip || ''), chip);
  ok('tenant filter changes total spend', before !== after, `${before} -> ${after}`);
  ok('tenant table still lists all tenants', (await ev(`document.querySelectorAll('#tenantcard tbody tr').length`)) >= 8);
  ok('selected row marked', (await ev(`document.querySelectorAll('#tenantcard tr.selected').length`)) === 1);
  const eprows = await ev(`document.querySelector('#endpointcard tbody tr td').innerText`);
  // 2. filter by model -> per-request tiles show dash
  await ev(`document.querySelector('#modelcard tbody tr td button').click()`);
  await sleep(1800);
  ok('model filter => per-request tile is "—"', (await ev(`document.querySelectorAll('.tile .value')[1].textContent`)) === '—');
  await ev(`[...document.querySelectorAll('#filters button')].find(b => b.textContent === 'Clear all').click()`);
  await sleep(1800);
  ok('clear all removes chips', (await ev(`document.querySelectorAll('#filters .chip').length`)) === 0);

  // 3. range 7d / 30d
  await ev(`document.querySelector('[data-range="7d"]').click()`); await sleep(1500);
  const cols7 = await ev(`document.querySelectorAll('#chartbody .col-hit').length`);
  await ev(`document.querySelector('[data-range="30d"]').click()`); await sleep(1500);
  const cols30 = await ev(`document.querySelectorAll('#chartbody .col-hit').length`);
  ok('7d => 28 buckets, 30d => 30 buckets', cols7 === 28 && cols30 === 30, `${cols7}/${cols30}`);
  await b.shot(join(SP, 'finops-ui-30d.png'), { fullPage: false });
  await ev(`document.querySelector('[data-range="24h"]').click()`); await sleep(1500);

  // 4. table view + stack by endpoint
  await ev(`document.querySelector('[data-view="table"]').click()`); await sleep(300);
  ok('table view renders a table', (await ev(`document.querySelectorAll('#chartbody table tbody tr').length`)) === 24);
  await ev(`document.querySelector('[data-view="chart"]').click()`);
  await ev(`(() => { const s = document.querySelector('#stackby'); s.value = 'endpoint'; s.dispatchEvent(new Event('change')); })()`); await sleep(1800);
  ok('stack by endpoint legend', (await ev(`document.querySelectorAll('.legend li').length`)) === 8, await ev(`[...document.querySelectorAll('.legend li')].map(l=>l.innerText.split('\\n')[0]).join(',')`));
  await ev(`(() => { const s = document.querySelector('#stackby'); s.value = 'tenant'; s.dispatchEvent(new Event('change')); })()`); await sleep(1500);

  // 5. tooltip via keyboard focus
  await ev(`document.querySelector('.chartbox svg').focus()`); await sleep(200);
  await b.press('ArrowLeft'); await b.press('ArrowLeft');
  const tipTxt = await ev(`document.querySelector('.chartbox .tip').hidden ? 'hidden' : document.querySelector('.chartbox .tip').innerText`);
  ok('tooltip shows on focus with per-series values', tipTxt !== 'hidden' && /Total/.test(tipTxt), tipTxt.replace(/\n/g, ' | '));
  await b.shot(join(SP, 'finops-ui-tip.png'), { fullPage: false });

  // 6. explain flow
  await ev(`(() => { const a = document.querySelectorAll('#alertlist .alert'); return a.length })()`).then((n) => console.log('alerts', n));
  await ev(`[...document.querySelectorAll('#alertlist button')].find(b => b.textContent === 'Explain with LLM').click()`);
  await sleep(700);
  const mid = await ev(`document.querySelector('#explain').innerText.length`);
  await sleep(4000);
  const full = await ev(`document.querySelector('#explain').innerText`);
  const meta = await ev(`document.querySelector('#explain-meta').innerText.replace(/\\n/g,' · ')`);
  ok('explanation streamed', full.length > 300 && /What to check/.test(full), `mid=${mid} full=${full.length}`);
  ok('meta shows TTFT + done', /Done/.test(meta) && /first token after/.test(meta), meta);
  ok('TTFT tile filled', (await ev(`document.querySelectorAll('.tile .value')[6].textContent`)) !== '—');
  ok('cancel hidden when finished', (await ev(`document.querySelector('#cancelgen').hidden`)) === true);
  await b.shot(join(SP, 'finops-ui-explain.png'), { fullPage: false });

  // 7. ack + resolve
  await ev(`[...document.querySelectorAll('#alertlist button')].find(b => b.textContent === 'Acknowledge').click()`); await sleep(600);
  ok('ack reflected', (await ev(`document.querySelectorAll('#alertlist .status')[0].textContent`)) === 'ack' || (await ev(`document.querySelector('.tiles').innerText`)).includes('acknowledged'));

  // 8. drill-down
  await ev(`document.querySelector('#reqlist tbody tr').click()`); await sleep(800);
  ok('request detail lists LLM calls', (await ev(`document.querySelectorAll('#reqdetail tbody tr').length`)) >= 1, await ev(`document.querySelector('#reqdetail').innerText.slice(0,160).replace(/\\n/g,' ')`));

  // 9. patterns + theme
  await ev(`document.querySelector('#patterns').click()`); await sleep(300);
  ok('patterns mode uses pattern fills', (await ev(`document.querySelectorAll('#chartbody svg path[fill^="url(#pat-"], #chartbody svg rect[fill^="url(#pat-"]').length`)) > 20);
  await b.shot(join(SP, 'finops-ui-patterns.png'), { fullPage: false });
  await ev(`document.querySelector('#patterns').click()`);
  await ev(`document.querySelector('#theme').click()`); await sleep(200);
  ok('theme toggle sets data-theme', (await ev(`document.documentElement.getAttribute('data-theme')`)) === 'light');

  // 10. websocket transport
  await ev(`(() => { const t = document.querySelector('#transport'); t.value = 'ws'; t.dispatchEvent(new Event('change')); })()`); await sleep(2500);
  ok('ws transport live', (await ev(`document.querySelector('#conntext').textContent`)).includes('WebSocket'), await ev(`document.querySelector('#conntext').textContent`));
  ok('rows still flow over ws', (await ev(`parseFloat(document.querySelector('#datatime').textContent.match(/([\\d.]+) row updates/)[1])`)) > 0);

  // 11. backpressure lab: throttle link to 4 KB/s, flood, explain at high model speed
  await ev(`(() => { const set = (id, v) => { const s = document.querySelector(id); s.value = v; s.dispatchEvent(new Event('input')); }; set('#lab-link', '3'); set('#lab-model', '9'); set('#lab-rate', '9'); set('#lab-repeat', '2'); })()`);
  await sleep(1500);
  await ev(`document.querySelector('#labactions button').click()`);
  await sleep(14000);
  const counters = await ev(`[...document.querySelectorAll('#counters .counter')].map(c => c.querySelector('.l').textContent + '=' + c.querySelector('.n').textContent).join(' | ')`);
  console.log('COUNTERS', counters);
  const ch = [...app.hub.channels.values()][0]; const st = { channel: ch && ch.snapshotStats() };
  console.log('server stats', JSON.stringify(st.channel && { coalesced: st.channel.chunks_coalesced, pauses: st.channel.model_pauses, conflated: st.channel.rows_conflated, resyncs: st.channel.resyncs, throttle: st.channel.throttle_bps }));
  await b.shot(join(SP, 'finops-ui-lab.png'), { fullPage: false });
  ok('no console errors or CSP violations', b.logs.filter((l) => /error|exception|Refused/i.test(l)).length === 0, JSON.stringify(b.logs));
  console.log(`screenshots in ${SP}: finops-ui-*.png`);
} finally { b.close(); await app.close(); process.exit(failures ? 1 : 0); }
