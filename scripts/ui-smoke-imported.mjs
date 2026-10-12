// Optional UI check for an IMPORTED database in headless Chrome (dev-only, not part of `npm test`):
//   node --disable-warning=ExperimentalWarning scripts/ui-smoke-imported.mjs data/claude-code.db [shots-dir]
// Checks the data-source banner, that the simulator controls are gone, the request drill-down (cache-write column
// when present), and that the page logs no console errors / CSP violations. Writes screenshots.
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { createApp } from '../src/server.js';
import { launch, sleep } from './cdp.mjs';

const db = process.argv[2];
if (!db) { console.error('usage: ui-smoke-imported.mjs <imported.db> [shots-dir]'); process.exit(1); }
const shots = resolve(process.argv[3] || tmpdir());
mkdirSync(shots, { recursive: true });
let failures = 0;
const ok = (name, cond, extra = '') => { if (!cond) failures++; console.log(cond ? 'PASS' : 'FAIL', name, extra); };

const app = await createApp({ dbPath: resolve(db), port: 0, simAutoStart: true });
await app.listen();
const b = await launch({ width: 1440, height: 1000 });
const ev = (e) => b.eval(e);
try {
  await b.emulate({ dark: false, reducedMotion: false });
  await b.goto(app.url);
  await sleep(3500);
  await ev(`document.querySelector('#range button[data-range="30d"]').click()`);
  await sleep(2500);

  const banner = await ev(`(() => { const e = document.querySelector('#source-banner'); return e && !e.hidden ? e.innerText : null; })()`);
  ok('data-source banner is shown', !!banner && /Imported data/.test(banner), (banner || '').slice(0, 90));
  ok('simulator controls are hidden', (await ev(`[...document.querySelectorAll('.sim-only')].every((e) => e.offsetParent === null)`)) === true);
  ok('no simulator toggle visible', (await ev(`document.querySelector('#simtoggle')?.offsetParent === null`)) === true);
  const tiles = await ev(`[...document.querySelectorAll('.tile')].map((t) => t.querySelector('.label')?.textContent + '=' + t.querySelector('.value')?.textContent)`);
  ok('tiles render with real numbers', tiles.length >= 6 && tiles.every((t) => !/=undefined/.test(t)), tiles.join(' | '));
  ok('tenant table has rows', (await ev(`document.querySelectorAll('#tenantcard tbody tr').length`)) >= 2);
  ok('footer says the newest record defines now', /newest imported record/.test(await ev(`document.querySelector('#foot').textContent`)));
  await b.shot(`${shots}/imported-light.png`);

  // drill into the most expensive request
  const clicked = await ev(`(() => { const r = document.querySelector('#drillcard tbody tr button, #drillcard tbody tr td button, #drillcard tbody tr'); if (!r) return false; r.click(); return true; })()`);
  await sleep(1500);
  const detail = await ev(`(() => { const d = document.querySelector('#reqdetail'); return d && !d.hidden ? { cols: [...d.querySelectorAll('thead th')].map((t) => t.textContent), rows: d.querySelectorAll('tbody tr').length, hint: d.querySelector('.hint')?.textContent } : null; })()`);
  ok('request detail opens', clicked && !!detail, JSON.stringify(detail?.cols));
  if (detail) {
    ok('cache-write column appears exactly when the formula hint mentions cache writes', detail.cols.includes('Cache writes') === /cache writes/.test(detail.hint || ''), `column ${detail.cols.includes('Cache writes') ? 'shown' : 'absent'}`);
    await b.shot(`${shots}/imported-detail.png`);
  }

  await b.emulate({ dark: true, reducedMotion: false });
  await sleep(600);
  await b.shot(`${shots}/imported-dark.png`);
  await b.resize(390, 900);
  await sleep(800);
  ok('no horizontal scroll at 390px', (await ev(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`)) === true);
  await b.shot(`${shots}/imported-mobile.png`);

  const bad = b.logs.filter((l) => /console\.(error|warning)|exception|log\.(error|warning)|Content Security Policy/i.test(l));
  ok('no console errors / CSP violations', bad.length === 0, bad.slice(0, 3).join(' | '));
} finally {
  b.close();
  await app.close();
}
console.log(failures ? `${failures} FAILED` : 'all checks passed', `- screenshots in ${shots}`);
process.exit(failures ? 1 : 0);
