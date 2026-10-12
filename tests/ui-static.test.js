import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp, api } from './helpers.js';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const files = readdirSync(PUBLIC);
const read = (f) => readFileSync(join(PUBLIC, f), 'utf8');

test('UI is CSP-clean: no inline scripts, inline styles, or inline event handlers in the HTML', () => {
  const html = read('index.html');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script>');
  assert.ok(!/<style[\s>]/i.test(html), 'inline <style>');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style= attribute');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler attribute');
  assert.match(html, /<script type="module" src="app\.js">/);
});

test('every URL the page uses is relative, so the same page works at / and under /d/<source>/ (the data source switcher)', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
  assert.ok(!/(?:src|href)="\/(?!\/)/.test(html), 'index.html must not use root-absolute src/href');
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const src = read(f);
    assert.ok(!/['"`]\/(?:api|stream|ws)\b/.test(src), `${f}: a root-absolute /api, /stream or /ws URL would bypass the /d/<source>/ prefix`);
    assert.ok(!/from\s+['"]\/[^/]/.test(src), `${f}: root-absolute module import`);
  }
  assert.match(read('stream.js'), /new URL\(`ws\?/, 'the WebSocket URL is built relative to the page');
});

test('UI never turns strings into markup: tenant-supplied text only goes through textContent / text nodes', () => {
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const src = read(f);
    for (const bad of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new Function\(/, /\.setAttribute\(\s*['"]style['"]/, /\.setAttribute\(\s*['"]on/]) {
      assert.ok(!bad.test(src), `${f} contains ${bad}`);
    }
  }
  // the helper that builds every element routes `text` to textContent and children to text nodes
  const dom = read('dom.js');
  assert.match(dom, /k === 'text'\) el\.textContent = v/);
  assert.match(dom, /document\.createTextNode\(String\(c\)\)/);
});

test('light and dark palettes: colour tokens are defined for both modes plus the manual toggle', () => {
  const css = read('style.css');
  assert.match(css, /prefers-color-scheme: dark/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /prefers-reduced-motion: no-preference/, 'animations only when motion is allowed');
  assert.match(css, /forced-colors: active/);
  for (const hex of ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6']) assert.ok(css.includes(hex), `categorical colour ${hex}`);
});

test('every file in public/ is served with the right content type', async (t) => {
  const app = await makeApp({ seedDays: 0 });
  t.after(() => app.close());
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  for (const f of files) {
    const ext = f.slice(f.lastIndexOf('.'));
    const r = await api(app, 'GET', f === 'index.html' ? '/' : `/${f}`);
    assert.equal(r.status, 200, f);
    assert.match(r.headers.get('content-type'), new RegExp(types[ext]), f);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
});
