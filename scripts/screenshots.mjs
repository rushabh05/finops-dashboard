// Regenerates the README screenshots in docs/images/ (dev-only; needs Chrome and, for the BurstGPT shot, data/burstgpt.db).
//   node --disable-warning=ExperimentalWarning scripts/screenshots.mjs
// Only the SIMULATED sample and the PUBLIC BurstGPT trace are ever shown: never point this at a database holding your own
// usage (project names would end up in the pictures).
import { mkdtempSync, copyFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMultiApp } from '../src/multi.js';
import { launch, sleep } from './cdp.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = resolve(ROOT, 'docs/images');
mkdirSync(OUT, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), 'finops-shots-'));
const bg = resolve(ROOT, 'data/burstgpt.db');
const haveBg = existsSync(bg);
if (haveBg) copyFileSync(bg, join(dir, 'burstgpt.db'));
else console.log('data/burstgpt.db not found: skipping the BurstGPT screenshot (npm run import:trace -- <BurstGPT_1.csv> creates it)');

const app = await createMultiApp({ dataDir: dir, port: 0, seedDays: 14, simAutoStart: true, simRate: 300, detectEveryMs: 300 });
await app.listen();
const b = await launch({ width: 1440, height: 1240 });
const ev = (e) => b.eval(e);
try {
  await b.emulate({ dark: false, reducedMotion: true });
  await b.goto(`${app.url}/d/finops/`);
  for (let i = 0; i < 80 && !(await ev(`document.querySelectorAll('#alertscard .alert').length`)); i++) await sleep(500); // wait for the simulator's first planted anomaly
  await sleep(1500);
  await b.shot(join(OUT, 'dashboard-sample.png'), { fullPage: false });
  console.log('dashboard-sample.png');

  await ev(`(() => { const btn = [...document.querySelectorAll('#alertscard button')].find((x) => /Explain with LLM/.test(x.textContent)); btn?.click(); return !!btn; })()`);
  await sleep(4500);
  await b.shot(join(OUT, 'explain-stream.png'), { fullPage: false });
  console.log('explain-stream.png');

  if (haveBg) {
    await b.emulate({ dark: true, reducedMotion: true });
    await ev(`(() => { const s = document.querySelector('#source'); s.value = 'burstgpt'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(3500);
    await ev(`document.querySelector('#range button[data-range="30d"]').click()`);
    await sleep(3500);
    await b.shot(join(OUT, 'dashboard-burstgpt-dark.png'), { fullPage: false });
    console.log('dashboard-burstgpt-dark.png');
  }
} finally {
  b.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}
