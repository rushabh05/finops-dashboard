import { s, h, clear } from './dom.js';
import { usd, usdCompact, utcHour, utcDate, utcDow } from './format.js';

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

/** x-axis label for bucket i, or null. Labels are sparse on purpose. */
function axisLabel(range, ts, i, bucketMs) {
  if (range === '24h') return i % 4 === 0 ? utcHour(ts) : null;
  if (range === '7d') return i === 0 || utcDate(ts) !== utcDate(ts - bucketMs) ? `${utcDow(ts)} ${utcDate(ts).slice(8)}` : null;
  return i % 5 === 0 ? utcDate(ts).slice(5) : null;
}

export function bucketLabel(range, ts, bucketMs) {
  if (bucketMs <= 3600000) return `${utcDate(ts)} ${utcHour(ts)} UTC`;
  const end = ts + bucketMs;
  return `${utcDate(ts)} ${utcHour(ts)} → ${utcDate(end) === utcDate(ts) ? '' : utcDate(end) + ' '}${utcHour(end)} UTC`;
}

const PAT_ANGLES = [45, 135, 45, 135, 45, 135, 45];
function patternDefs() {
  const defs = s('defs');
  PAT_ANGLES.forEach((angle, i) => {
    const gap = 5 + (i % 3);
    defs.append(s('pattern', { id: `pat-s${i + 1}`, width: gap, height: gap, patternUnits: 'userSpaceOnUse', patternTransform: `rotate(${angle})` },
      s('rect', { width: gap, height: gap, class: `fill-s${i + 1}` }),
      s('line', { x1: 0, y1: 0, x2: 0, y2: gap, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0.55 })));
  });
  defs.append(s('pattern', { id: 'pat-other', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    s('rect', { width: 6, height: 6, class: 'fill-other' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--surface)', 'stroke-width': 3, opacity: 0.55 })));
  return defs;
}
const fillAttrs = (cls, patterns) => (patterns ? { fill: `url(#pat-${cls})` } : { class: `fill-${cls}` });

export function legend(series, colorOf, { onPick, patterns } = {}) {
  const ul = h('ul', { class: 'legend', 'aria-label': 'Series' });
  for (const sr of series) {
    const cls = colorOf(sr.key, sr.other);
    const label = sr.key === '' ? 'infra (non-LLM)' : sr.other ? `Other (${sr.members})` : sr.key;
    const sw = s('svg', { width: 12, height: 12, 'aria-hidden': 'true' }, s('rect', { width: 12, height: 12, rx: 2, ...fillAttrs(cls, patterns) }));
    const inner = [sw, h('span', { text: label }), h('span', { class: 'muted num', text: usd(sr.total) })];
    ul.append(h('li', null, onPick && !sr.other ? h('button', { type: 'button', title: `Filter to ${label}`, onclick: () => onPick(sr.key) }, inner) : h('span', null, inner)));
  }
  return ul;
}

/**
 * Stacked columns (one column per time bucket, segments per series).
 * Marks: <=24px columns, 4px rounded data end, 2px surface gap between segments, hairline grid, sparse direct labels.
 */
export function stackedChart(host, { buckets, series, colorOf, bucketMs, range, patterns, liveLast, unit = 'Spend' }) {
  clear(host);
  const W = Math.max(320, Math.round(host.clientWidth || 640));
  const H = 340;
  const wide = W >= 560;
  const m = { l: 50, r: wide ? 104 : 12, t: 20, b: 26 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const n = buckets.length;
  const totals = buckets.map((_, i) => series.reduce((a, sr) => a + sr.points[i], 0));
  const maxV = Math.max(1, ...totals);
  const step = niceStep(maxV / 4);
  const top = Math.max(step, Math.ceil(maxV / step) * step);
  const y = (v) => m.t + ph - (v / top) * ph;
  const slot = pw / n;
  const bw = Math.min(24, Math.max(3, slot * 0.78));
  const x = (i) => m.l + slot * i + (slot - bw) / 2;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', tabindex: '0', 'aria-label': `${unit} per ${range === '24h' ? 'hour' : range === '7d' ? '6 hours' : 'day'}, stacked. Total ${usd(totals.reduce((a, b) => a + b, 0))}. Use arrow keys to read each column, or switch to the table view.` });
  if (patterns) svg.append(patternDefs());

  const grid = s('g', { class: 'axis' });
  for (let v = 0; v <= top + 1e-9; v += step) {
    grid.append(s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v === 0 ? 'baseline' : 'gridline' }));
    grid.append(s('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', text: usdCompact(v) }));
  }
  buckets.forEach((ts, i) => {
    const lab = axisLabel(range, ts, i, bucketMs);
    if (lab) grid.append(s('text', { x: x(i) + bw / 2, y: H - 8, 'text-anchor': 'middle', text: lab }));
  });
  svg.append(grid);

  // columns
  const cols = s('g');
  for (let i = 0; i < n; i++) {
    let acc = 0;
    const nonEmpty = series.filter((sr) => sr.points[i] > 0);
    nonEmpty.forEach((sr, k) => {
      const v = sr.points[i];
      const y1 = y(acc + v), y0 = y(acc);
      const hgt = Math.max(0.5, y0 - y1);
      const cls = colorOf(sr.key, sr.other);
      const attrs = fillAttrs(cls, patterns);
      if (k === nonEmpty.length - 1 && hgt > 1) { // 4px rounded data end, square at the baseline side
        const r = Math.min(4, hgt / 2, bw / 2);
        cols.append(s('path', { d: `M${x(i)},${y1 + hgt} V${y1 + r} Q${x(i)},${y1} ${x(i) + r},${y1} H${x(i) + bw - r} Q${x(i) + bw},${y1} ${x(i) + bw},${y1 + r} V${y1 + hgt} Z`, class: 'seg-gap', ...attrs }));
      } else {
        cols.append(s('rect', { x: x(i), y: y1, width: bw, height: hgt, class: 'seg-gap', ...attrs }));
      }
      acc += v;
    });
  }
  svg.append(cols);

  // direct labels on the newest column, only where they fit and do not collide
  if (wide) {
    const i = n - 1;
    let acc = 0;
    const segs = [];
    for (const sr of series) {
      const v = sr.points[i];
      if (v > 0) segs.push({ sr, mid: y(acc + v / 2), hgt: y(acc) - y(acc + v) });
      acc += v;
    }
    let lastY = Infinity;
    const lab = s('g');
    for (const sg of [...segs].reverse()) {
      if (sg.hgt < 12 || lastY - sg.mid < 13) continue;
      lastY = sg.mid;
      const name = sg.sr.key === '' ? 'infra' : sg.sr.other ? 'Other' : sg.sr.key;
      lab.append(s('rect', { x: x(i) + bw + 6, y: sg.mid - 1.5, width: 9, height: 3, rx: 1.5, class: `fill-${colorOf(sg.sr.key, sg.sr.other)}` }));
      lab.append(s('text', { x: x(i) + bw + 19, y: sg.mid + 4, class: 'direct-label', text: name.length > 15 ? name.slice(0, 14) + '…' : name }));
    }
    svg.append(lab);
  }
  if (liveLast && n) svg.append(s('text', { x: x(n - 1) + bw / 2, y: y(totals[n - 1]) - 6, 'text-anchor': 'middle', class: 'live-mark', text: 'live' }));

  // hover / focus layer: one tooltip listing every series at that bucket
  const tip = h('div', { class: 'tip', hidden: true });
  const hits = s('g');
  let active = -1;
  const crosshair = s('line', { class: 'crosshair', y1: m.t, y2: m.t + ph, visibility: 'hidden' });
  const hitRects = [];
  const show = (i) => {
    active = i;
    hitRects.forEach((r, k) => r.classList.toggle('active', k === i));
    clear(tip);
    tip.append(h('div', { class: 't', text: bucketLabel(range, buckets[i], bucketMs) }));
    const rows = series.filter((sr) => sr.points[i] > 0).reverse();
    for (const sr of rows) {
      const nm = sr.key === '' ? 'infra (non-LLM)' : sr.other ? `Other (${sr.members})` : sr.key;
      tip.append(h('div', { class: 'row' }, h('span', { class: `k bg-${colorOf(sr.key, sr.other)}` }), h('span', { class: 'n', text: nm }), h('span', { class: 'v', text: usd(sr.points[i]) })));
    }
    if (!rows.length) tip.append(h('div', { class: 'row muted', text: 'No spend' }));
    tip.append(h('div', { class: 'row total' }, h('span', { class: 'n', text: 'Total' }), h('span', { class: 'v', text: usd(totals[i]) })));
    tip.hidden = false;
    const cx = x(i) + bw / 2;
    const scale = (host.clientWidth || W) / W;
    const tw = tip.offsetWidth || 200;
    const left = cx * scale + 12 + tw > (host.clientWidth || W) ? cx * scale - 12 - tw : cx * scale + 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${m.t * scale}px`;
    crosshair.setAttribute('x1', cx); crosshair.setAttribute('x2', cx); crosshair.setAttribute('visibility', 'visible');
  };
  const hide = () => { active = -1; tip.hidden = true; crosshair.setAttribute('visibility', 'hidden'); hitRects.forEach((r) => r.classList.remove('active')); };
  for (let i = 0; i < n; i++) {
    const r = s('rect', { x: m.l + slot * i, y: m.t, width: slot, height: ph, class: 'col-hit' });
    r.addEventListener('pointerenter', () => show(i));
    r.addEventListener('pointermove', () => { if (active !== i) show(i); });
    hitRects.push(r);
    hits.append(r);
  }
  svg.append(crosshair, hits);
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('focus', () => { if (active < 0) show(n - 1); });
  svg.addEventListener('keydown', (e) => {
    const k = e.key;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(k)) return;
    e.preventDefault();
    if (k === 'Escape') return hide();
    const cur = active < 0 ? n - 1 : active;
    show(k === 'ArrowLeft' ? Math.max(0, cur - 1) : k === 'ArrowRight' ? Math.min(n - 1, cur + 1) : k === 'Home' ? 0 : n - 1);
  });
  host.append(svg, tip);
  return { show, hide, svg, get active() { return active; } };
}

/** The same data as an accessible table. */
export function seriesTable(host, { buckets, series, bucketMs, range }) {
  clear(host);
  const head = h('tr', null, h('th', { scope: 'col', text: 'Time (UTC)' }), ...series.map((sr) => h('th', { scope: 'col', text: sr.key === '' ? 'infra' : sr.other ? 'Other' : sr.key })), h('th', { scope: 'col', text: 'Total' }));
  const body = h('tbody');
  for (let i = buckets.length - 1; i >= 0; i--) {
    const tot = series.reduce((a, sr) => a + sr.points[i], 0);
    body.append(h('tr', null, h('th', { scope: 'row', text: bucketLabel(range, buckets[i], bucketMs) }), ...series.map((sr) => h('td', { class: 'num', text: usd(sr.points[i]) })), h('td', { class: 'num', text: usd(tot) })));
  }
  host.append(h('div', { class: 'tablewrap scroll' }, h('table', null, h('caption', { class: 'sr-only', text: 'Spend per time bucket' }), h('thead', null, head), body)));
}

/** 24-point-ish trend line. Ends in an 8px dot with a 2px surface ring. */
export function sparkline(values, { w = 84, h: hgt = 24 } = {}) {
  const n = values.length;
  const max = Math.max(1, ...values);
  const pad = 6;
  const pts = values.map((v, i) => [pad + (n > 1 ? (i / (n - 1)) * (w - 2 * pad) : 0), hgt - pad - (v / max) * (hgt - 2 * pad)]);
  const last = pts[pts.length - 1] || [pad, hgt - pad];
  return s('svg', { class: 'spark', width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, 'aria-hidden': 'true' },
    s('polyline', { points: pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ') }),
    s('circle', { cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: 4 }));
}

/** Rolling queue-depth chart for the backpressure lab. */
export function queueChart(host, values, { w = 640, h: hgt = 70, fmt = String } = {}) {
  clear(host);
  const n = values.length;
  const max = Math.max(1, ...values);
  const x = (i) => (n > 1 ? (i / (n - 1)) * (w - 2) + 1 : 1);
  const y = (v) => hgt - 4 - (v / max) * (hgt - 14);
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  host.append(s('svg', { viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Queue depth over the last ${n} samples, peak ${fmt(max)}` },
    s('line', { x1: 0, x2: w, y1: hgt - 4, y2: hgt - 4, class: 'baseline' }),
    n > 1 ? s('polygon', { points: `${x(0)},${hgt - 4} ${line} ${x(n - 1)},${hgt - 4}`, class: 'qarea' }) : null,
    n > 1 ? s('polyline', { points: line, class: 'qline' }) : null));
}
