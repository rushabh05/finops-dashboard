import { h, clear, $, $$ } from './dom.js';
import * as F from './format.js';
import { stackedChart, seriesTable, legend, sparkline, queueChart } from './charts.js';
import { LiveStream, newClientId } from './stream.js';

const HOUR = 3600000;
const LINK_STEPS = [0, 1024, 4096, 16384, 65536, 262144, 1048576]; // bytes/s, 0 = unlimited
const MODEL_STEPS = [5, 10, 20, 40, 80, 160, 320, 640, 1280, 2500, 5000]; // tokens/s (mock model)
const RATE_STEPS = [0, 5, 10, 20, 40, 80, 160, 320, 640, 1280, 2500, 5000]; // simulated requests/s written
const REPEAT_STEPS = [1, 10, 40, 100]; // mock explanation length multiplier (stress)
const store = (() => { try { return window.localStorage; } catch { return null; } })();
const saved = (k, d) => { try { return store?.getItem(k) ?? d; } catch { return d; } };
const save = (k, v) => { try { store?.setItem(k, v); } catch { /* storage unavailable */ } };

const state = {
  range: saved('finops.range', '24h'),
  filters: { tenant: null, endpoint: null, model: null },
  stackBy: 'tenant', view: 'chart', alertFilter: 'active', drillSort: 'cost',
  patterns: saved('finops.patterns', '0') === '1', theme: saved('finops.theme', 'auto'),
  transport: saved('finops.transport', 'sse'),
  cid: newClientId(), stream: null, conn: 'connecting',
  rollups: new Map(), alerts: new Map(), windowHours: 6, snapshots: 0, lastRows: [], rowEvents: [],
  data: {}, selectedRequest: null, refreshSeq: 0, lastRefresh: 0, refreshTimer: null, loading: false,
  gen: null, lab: { link: 0, model: 3, rate: 4, repeat: 0 }, stats: null, queue: [],
  colors: { tenant: new Map(), endpoint: new Map(), model: new Map() },
  clock: 0,
};
if (!['24h', '7d', '30d'].includes(state.range)) state.range = '24h';
if (!['sse', 'ws'].includes(state.transport)) state.transport = 'sse';

/* ------------------------------------------------------------------ http */

function qs(extra = {}) {
  const p = new URLSearchParams();
  p.set('range', state.range);
  for (const [k, v] of Object.entries(state.filters)) if (v) p.set(k, v);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) p.set(k, v);
  return p.toString();
}
async function getJson(path) {
  const r = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${(await r.json().catch(() => ({}))).error || ''}`.trim());
  return r.json();
}
async function postJson(path, body = {}) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${path}: ${r.status}`);
  return j;
}
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

/* ------------------------------------------------------------------ colours: an entity keeps its colour, whatever else is on screen */

function colorFor(dim, keys) {
  const map = state.colors[dim];
  const live = new Set(keys);
  const taken = new Set();
  for (const k of keys) if (map.has(k)) taken.add(map.get(k));
  for (const k of keys) {
    if (map.has(k) && [...keys].filter((o) => o !== k && map.get(o) === map.get(k)).length === 0) continue;
    let slot = 1;
    while (taken.has(slot) && slot < 8) slot++;
    map.set(k, slot);
    taken.add(slot);
  }
  for (const k of [...map.keys()]) if (!live.has(k) && map.get(k) > 7) map.delete(k);
  return (key, other) => (other ? 'other' : `s${map.get(key) || 1}`);
}

/* ------------------------------------------------------------------ refresh */

function scheduleRefresh(urgent = false) {
  if (state.refreshTimer) return;
  const wait = urgent ? 0 : Math.max(0, state.lastRefresh + 1200 - Date.now());
  state.refreshTimer = setTimeout(() => { state.refreshTimer = null; refreshAll(); }, wait);
}

async function refreshAll() {
  if (document.hidden) return;
  const seq = ++state.refreshSeq;
  state.loading = true;
  state.lastRefresh = Date.now();
  $$('.card').forEach((c) => c.classList.add('refetching'));
  try {
    const [summary, tenant, endpoint, model, series, requests] = await Promise.all([
      getJson(`api/summary?${qs()}`),
      getJson(`api/by-tenant?${qs()}`),
      getJson(`api/by-endpoint?${qs()}`),
      getJson(`api/by-model?${qs()}`),
      getJson(`api/timeseries?${qs({ group: state.stackBy })}`),
      getJson(`api/requests?${qs({ sort: state.drillSort, limit: 25 })}`),
    ]);
    if (seq !== state.refreshSeq) return; // a newer refresh superseded this one
    state.data = { summary, tenant, endpoint, model, series, requests };
    state.clock = summary.window.latest + HOUR;
    renderAll();
  } catch (e) {
    toast(`Could not refresh: ${e.message}`);
  } finally {
    if (seq === state.refreshSeq) { state.loading = false; $$('.card').forEach((c) => c.classList.remove('refetching')); }
  }
}

/* ------------------------------------------------------------------ live rows / alerts (from the stream) */

function applySnapshot(d) {
  state.rollups.clear();
  state.alerts.clear();
  const { cols, rows } = d.rollups;
  for (const r of rows) { const o = {}; cols.forEach((c, i) => { o[c] = r[i]; }); state.rollups.set(o.id, o); }
  for (const a of d.alerts) state.alerts.set(a.id, a);
  state.windowHours = Math.max(1, Math.round((d.window.to - d.window.from) / HOUR));
  state.snapshots++;
}
function applyRows(rows) {
  for (const r of rows) {
    if (r.k.startsWith('r:')) state.rollups.set(r.v.id, r.v);
    else state.alerts.set(r.v.id, r.v);
  }
  let max = 0;
  for (const r of state.rollups.values()) if (r.hour > max) max = r.hour;
  const keep = max - (state.windowHours - 1) * HOUR; // like the server's window: older hours slide out
  for (const [id, r] of state.rollups) if (r.hour < keep) state.rollups.delete(id);
}
const passes = (r) => (!state.filters.tenant || r.tenant_id === state.filters.tenant) && (!state.filters.endpoint || r.endpoint === state.filters.endpoint) && (!state.filters.model || r.model === state.filters.model);
function liveHour() {
  let max = 0;
  for (const r of state.rollups.values()) if (r.hour > max) max = r.hour;
  let cost = 0;
  for (const r of state.rollups.values()) if (r.hour === max && passes(r)) cost += r.cost_micro_usd;
  return { hour: max, cost };
}

let tokenBuf = '';
let tokenRaf = 0;
function onStreamEvent({ event, data }) {
  if (event === 'snapshot') { applySnapshot(data); renderAlerts(); renderHeader(); scheduleRefresh(true); }
  else if (event === 'rows') {
    applyRows(data.rows);
    state.rowEvents.push([Date.now(), data.rows.length]);
    if (data.rows.some((r) => r.k.startsWith('a:'))) renderAlerts();
    renderHeader();
    scheduleRefresh();
  } else if (event === 'gen_start') onGenStart(data);
  else if (event === 'token') onToken(data);
  else if (event === 'gen_end') onGenEnd(data);
  else if (event === 'hello') { state.helloAt = Date.now(); }
}

function setConn(s) {
  state.conn = s;
  const el = $('#conn');
  el.dataset.state = s;
  const t = { live: `Live · ${state.transport === 'ws' ? 'WebSocket' : 'SSE'}`, connecting: 'Connecting…', reconnecting: 'Reconnecting…', error: 'Offline' }[s] || s;
  $('#conntext').textContent = t;
  renderAlerts(); // Explain buttons depend on a live stream
}
function connect() {
  state.stream?.close();
  const prev = state.stream;
  state.stream = new LiveStream({ cid: state.cid, kind: state.transport, onEvent: onStreamEvent, onStatus: setConn });
  if (prev && state.transport === 'ws') state.stream.lastId = prev.lastId;
  state.stream.connect();
  if (state.lab.link) postThrottle();
}

/* ------------------------------------------------------------------ header, filters, tiles */

function renderHeader() {
  const w = state.data.summary?.window;
  const live = liveHour();
  const now = Date.now();
  state.rowEvents = state.rowEvents.filter(([t]) => now - t < 5000);
  const rate = state.rowEvents.reduce((n, [, c]) => n + c, 0) / 5;
  const bits = [];
  const imported = !!state.stats?.source;
  if (w && !w.empty) bits.push(`Data through ${F.utcStamp(w.latest + HOUR).slice(0, 16)} UTC (${imported ? 'newest record' : 'simulated clock'})`);
  if (live.hour) bits.push(`${imported ? 'newest hour' : 'this hour so far'} ${F.usd(live.cost)}`);
  bits.push(`${rate.toFixed(rate < 10 ? 1 : 0)} row updates/s`);
  const line = bits.join(' · ');
  $('#datatime').textContent = line;
  $('#datatime').title = line; // the full text when the header truncates it
}

function setFilter(dim, value) {
  state.filters[dim] = state.filters[dim] === value ? null : value;
  state.selectedRequest = null;
  renderFilters();
  renderAlerts();
  scheduleRefresh(true);
}

function renderFilters() {
  const box = clear($('#filters'));
  const active = Object.entries(state.filters).filter(([, v]) => v);
  if (!active.length) { box.append(h('span', { class: 'label', text: 'No filters. Select a tenant, endpoint or model in the tables below to filter everything on this page.' })); return; }
  box.append(h('span', { class: 'label', text: 'Filtered by' }));
  for (const [k, v] of active) {
    box.append(h('span', { class: 'chip' }, h('span', { text: `${k}: ` }), h('b', { text: v }),
      h('button', { type: 'button', 'aria-label': `Remove ${k} filter ${v}`, onclick: () => setFilter(k, v) }, '✕')));
  }
  box.append(h('button', { type: 'button', class: 'btn small', onclick: () => { state.filters = { tenant: null, endpoint: null, model: null }; renderFilters(); renderAlerts(); scheduleRefresh(true); } }, 'Clear all'));
}

function delta(cur, prev, label) {
  const d = F.signedPct(cur, prev);
  if (d === null) return h('div', { class: 'delta', text: '' });
  const arrow = Math.abs(d) < 0.0005 ? '■' : d > 0 ? '▲' : '▼';
  return h('div', { class: 'delta' }, h('span', { 'aria-hidden': 'true', text: arrow + ' ' }), `${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}% vs previous ${label}`);
}

function renderTiles() {
  const sm = state.data.summary;
  if (!sm) return;
  const t = sm.totals, p = sm.previous;
  const label = state.range === '24h' ? '24h' : state.range === '7d' ? '7d' : '30d';
  const modelFiltered = !!state.filters.model;
  const act = liveAlertCounts();
  const tiles = [
    { l: 'Total spend', v: F.usd(t.cost_micro_usd), d: delta(t.cost_micro_usd, p?.cost_micro_usd, label), n: `LLM ${F.usd(t.llm_cost_micro_usd)} · infra ${F.usd(t.infra_cost_micro_usd)}`, hero: true },
    { l: 'Spend per 1K requests', v: modelFiltered ? '—' : F.usd(t.cost_per_1k_requests_micro_usd), d: modelFiltered ? h('div', { class: 'delta' }) : delta(t.cost_per_1k_requests_micro_usd, p?.cost_per_1k_requests_micro_usd, label), n: modelFiltered ? 'Not attributable per model' : `${F.compact(t.requests)} requests` },
    { l: 'LLM share of cost', v: F.pct(t.llm_share), d: delta(t.llm_share, p?.llm_share, label), n: `${F.compact(t.llm_calls)} LLM calls` },
    { l: 'Cost per request', v: modelFiltered ? '—' : F.usd(t.cost_per_request_micro_usd, { precise: true }), d: modelFiltered ? h('div', { class: 'delta' }) : delta(t.cost_per_request_micro_usd, p?.cost_per_request_micro_usd, label), n: `${F.compact(t.tokens_in + t.tokens_out)} tokens` },
    { l: 'Active alerts', v: String(act.active), d: h('div', { class: 'delta', text: `${act.open} open · ${act.acked} acknowledged` }), n: 'not resolved' },
    { l: `Projected ${sm.projection?.month ?? ''} month-end`, v: sm.projection ? F.usd(sm.projection.projected_micro_usd) : '—', d: h('div', { class: 'delta', text: sm.projection ? `${F.usd(sm.projection.month_to_date_micro_usd)} so far` : '' }), n: sm.projection ? `run rate ${F.usd(sm.projection.run_rate_micro_usd_per_hour)}/h × ${Math.round(sm.projection.remaining_hours)}h left` : '' },
    { l: 'Time to first token', v: state.gen?.ttftClient != null ? F.ms(state.gen.ttftClient) : '—', d: h('div', { class: 'delta', text: state.gen?.ttftServer != null ? `server-side ${F.ms(state.gen.ttftServer)}` : '' }), n: state.gen ? (state.gen.source === 'anthropic' ? 'Anthropic stream' : 'mock model (simulated start-up delay)') : 'for the explanation stream' },
  ];
  const box = clear($('#tiles'));
  for (const t2 of tiles) box.append(h('div', { class: 'tile' + (t2.hero ? ' hero' : '') }, h('div', { class: 'label', text: t2.l }), h('div', { class: 'value num', text: t2.v }), t2.d, h('div', { class: 'note', text: t2.n })));
}

function liveAlertCounts() {
  let active = 0, open = 0;
  for (const a of visibleAlerts('active')) { active++; if (a.status === 'open') open++; }
  return { active, open, acked: active - open };
}

/* ------------------------------------------------------------------ chart */

function renderChart() {
  const d = state.data.series;
  // live refreshes rebuild the SVG: carry over the hovered/focused column so a tooltip never vanishes under the pointer
  const prev = state.chartCtl;
  const hadFocus = !!prev && document.activeElement === prev.svg;
  const prevActive = prev ? prev.active : -1;
  state.chartCtl = null;
  const body = clear($('#chartbody'));
  if (!d) return;
  if (d.window.empty) { body.append(h('div', { class: 'empty', text: 'No data yet.' })); return; }
  const colorOf = colorFor(state.stackBy, d.series.filter((s) => !s.other).map((s) => s.key));
  const unit = { tenant: 'tenant', endpoint: 'endpoint', model: 'model' }[state.stackBy];
  $('#chart-hint').textContent = `${state.range === '24h' ? 'hourly' : state.range === '7d' ? '6-hour' : 'daily'} spend, top 7 ${unit}s + Other · UTC`;
  if (state.view === 'table') { seriesTable(body, { buckets: d.buckets, series: d.series, bucketMs: d.window.bucketMs, range: state.range }); return; }
  body.append(legend(d.series, colorOf, { patterns: state.patterns, onPick: (k) => { if (k !== '') setFilter(state.stackBy, k); } }));
  const host = h('div', { class: 'chartbox' });
  body.append(host);
  const ctl = stackedChart(host, { buckets: d.buckets, series: d.series, colorOf, bucketMs: d.window.bucketMs, range: state.range, patterns: state.patterns, liveLast: true, unit: `Spend by ${unit}` });
  state.chartCtl = ctl;
  if (hadFocus) ctl.svg.focus({ preventScroll: true });
  if (prevActive >= 0 && prevActive < d.buckets.length) ctl.show(prevActive);
}

/* ------------------------------------------------------------------ dimension tables */

function renderDim(cardId, titleId, dim, title) {
  const d = state.data[dim];
  const card = clear($(`#${cardId}`));
  if (!d) return;
  const isModel = dim === 'model';
  const chartColor = state.stackBy === dim && state.data.series ? colorFor(dim, state.data.series.series.filter((s) => !s.other).map((s) => s.key)) : null;
  const inChart = new Set(state.data.series?.series.filter((s) => !s.other).map((s) => s.key) || []);
  card.append(h('header', null, h('h2', { id: titleId, text: title }), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn small', 'data-export': dim, onclick: () => exportCsv(dim) }, 'Export CSV')));
  const head = h('tr', null, h('th', { scope: 'col', text: dim }), h('th', { scope: 'col', text: 'Cost' }), h('th', { scope: 'col', text: 'Share' }),
    h('th', { scope: 'col', text: isModel ? 'Calls' : 'Requests' }), h('th', { scope: 'col', text: isModel ? 'Cost / call' : 'Cost / req' }), h('th', { scope: 'col', text: 'Trend' }));
  const body = h('tbody');
  const maxShare = Math.max(0.0001, ...d.rows.map((r) => r.share));
  for (const r of d.rows) {
    const selected = state.filters[dim] === r.key;
    const label = r.key === '' ? 'infra (non-LLM)' : r.key;
    const sw = chartColor && inChart.has(r.key) ? h('span', { class: `sw bg-${chartColor(r.key)}`, 'aria-hidden': 'true' }) : h('span', { class: 'sw', 'aria-hidden': 'true' });
    const btn = h('button', { type: 'button', class: 'namebtn', 'aria-pressed': String(selected), disabled: r.key === '' || undefined, title: r.key === '' ? 'Infra rows are not an LLM model' : selected ? `Remove filter ${label}` : `Filter everything to ${label}`, onclick: () => setFilter(dim, r.key) }, sw, h('span', { class: 'name', text: label }));
    const reqs = isModel ? r.llm_calls : r.requests;
    const per = isModel ? r.cost_per_call_micro_usd : r.cost_per_request_micro_usd;
    body.append(h('tr', { class: selected ? 'selected' : null }, h('td', null, btn), h('td', { class: 'num', text: F.usd(r.cost_micro_usd) }),
      h('td', { class: 'num' }, h('span', { class: 'sharebar', 'aria-hidden': 'true' }, h('i', { class: `w-${Math.min(100, Math.round((r.share / maxShare) * 20) * 5)}` })), F.pct(r.share)),
      h('td', { class: 'num', text: reqs === null ? '—' : F.compact(reqs) }), h('td', { class: 'num', text: F.usd(per, { precise: true }) }), h('td', null, sparkline(r.spark))));
  }
  card.append(h('div', { class: 'tablewrap scroll' }, h('table', null, h('thead', null, head), body)));
  if (!d.rows.length) card.append(h('div', { class: 'empty', text: 'No data for this selection.' }));
}

/* ------------------------------------------------------------------ alerts + explanation */

function visibleAlerts(mode = state.alertFilter) {
  const out = [];
  for (const a of state.alerts.values()) {
    if (mode === 'active' && a.status === 'resolved') continue;
    if (state.filters.tenant && a.tenant_id && a.tenant_id !== state.filters.tenant) continue;
    if (state.filters.endpoint && a.endpoint && a.endpoint !== state.filters.endpoint) continue;
    out.push(a);
  }
  return out.sort((a, b) => b.ts - a.ts || b.id - a.id);
}

function alertNumbers(a) {
  const f = a.kind === 'volume_spike' || a.kind === 'retry_storm' ? (v) => `${F.int(v)} requests` : a.kind === 'tokens_per_request' ? (v) => `${F.int(v)} tokens/request` : (v) => F.usd(v, { precise: a.kind === 'cost_per_request' });
  return `${f(a.observed)} vs typical ${f(a.baseline)} · ${a.baseline > 0 ? (a.observed / a.baseline).toFixed(1) : '∞'}× · robust z ${a.score.toFixed(1)}`;
}

function renderAlerts() {
  const list = clear($('#alertlist'));
  const items = visibleAlerts();
  $('#alerts-hint').textContent = `${items.length} shown`;
  if (!items.length) list.append(h('div', { class: 'empty', text: state.alertFilter === 'active' ? (state.stats?.source ? 'No active alerts in the imported period.' : 'No active alerts. The detector runs as data arrives; the simulator injects anomalies over time.') : 'No alerts.' }));
  const live = state.conn === 'live';
  for (const a of items.slice(0, 40)) {
    const who = [a.tenant_id ? `tenant ${a.tenant_id}` : 'all tenants', a.endpoint ? a.endpoint : 'all endpoints'].join(' · ');
    const busy = state.gen && state.gen.alertId === a.id && state.gen.state === 'streaming';
    list.append(h('article', { class: 'alert', role: 'listitem', 'data-status': a.status },
      h('div', { class: 'head' },
        h('span', { class: 'sev', 'data-sev': a.severity }, h('span', { 'aria-hidden': 'true', text: F.SEV_ICON[a.severity] }), F.SEV_LABEL[a.severity]),
        h('span', { class: 'kind', text: F.KIND_LABEL[a.kind] || a.kind }),
        h('span', { class: 'status', text: a.status }),
        h('span', { class: 'when', text: F.ago(a.ts, state.clock || a.ts), title: F.utcStamp(a.ts) })),
      h('div', { class: 'who', text: who }),
      h('div', { class: 'why', text: a.explanation }),
      h('div', { class: 'nums num', text: alertNumbers(a) }),
      h('div', { class: 'actions' },
        a.status === 'open' ? h('button', { type: 'button', class: 'btn small', onclick: () => alertAction(a, 'ack') }, 'Acknowledge') : null,
        a.status !== 'resolved' ? h('button', { type: 'button', class: 'btn small', onclick: () => alertAction(a, 'resolve') }, 'Resolve') : null,
        h('button', { type: 'button', class: 'btn small primary', disabled: !live || busy || undefined, onclick: () => explain(a) }, busy ? 'Explaining…' : 'Explain with LLM'))));
  }
  renderTiles();
}

async function alertAction(a, action) {
  try {
    const out = await postJson(`api/alerts/${a.id}/${action}`);
    state.alerts.set(out.id, { ...state.alerts.get(out.id), ...out, detail: undefined });
    renderAlerts();
  } catch (e) { toast(e.message); }
}

function setExplainMeta() {
  const g = state.gen;
  const meta = clear($('#explain-meta'));
  if (!g) return;
  const bits = [];
  bits.push(g.state === 'waiting' ? 'Waiting for the first token…' : g.state === 'streaming' ? 'Streaming…' : g.state === 'done' ? 'Done' : g.state === 'cancelled' ? 'Cancelled' : 'Error');
  if (g.source) bits.push(`source: ${g.source === 'anthropic' ? `Anthropic (${g.model})` : 'deterministic mock'}`);
  if (g.ttftClient != null) bits.push(`first token after ${F.ms(g.ttftClient)}${g.ttftServer != null ? ` (server ${F.ms(g.ttftServer)})` : ''}`);
  bits.push(`${g.text.length} chars`);
  if (g.pauses) bits.push(`model paused ${g.pauses}×`);
  if (g.offsetError) bits.push('⚠ out-of-order chunk detected');
  for (const b of bits) meta.append(h('span', { text: b }));
  $('#cancelgen').hidden = !(g.state === 'waiting' || g.state === 'streaming');
}

function paintExplain() {
  tokenRaf = 0;
  const g = state.gen;
  if (!g) return;
  const box = $('#explain');
  box.textContent = g.text;
  if (g.state === 'streaming' || g.state === 'waiting') box.append(h('span', { class: 'caret', 'aria-hidden': 'true' }));
  if (g.error) box.append(h('div', { class: 'muted', text: `\n[${g.error}]` }));
  box.scrollTop = box.scrollHeight;
  setExplainMeta();
}
function schedulePaint() { if (!tokenRaf) tokenRaf = requestAnimationFrame(paintExplain); }

async function explain(a) {
  if (state.conn !== 'live') return toast('The live stream is not connected yet.');
  const g = { alertId: a.id, state: 'waiting', text: '', t0: performance.now(), id: null, ttftClient: null, ttftServer: null, source: null, model: null, pauses: 0 };
  state.gen = g;
  $('#explain-for').textContent = `${F.KIND_LABEL[a.kind] || a.kind} · ${a.tenant_id || 'all tenants'} · ${a.endpoint || 'all endpoints'}`;
  paintExplain();
  renderAlerts();
  try {
    await postJson('api/generate', { cid: state.cid, alert_id: a.id, source: 'auto', tokens_per_sec: MODEL_STEPS[state.lab.model], repeat: REPEAT_STEPS[state.lab.repeat] });
  } catch (e) {
    g.state = 'error'; g.error = e.message; paintExplain(); renderAlerts(); renderTiles();
  }
}
function onGenStart(d) {
  const g = state.gen;
  if (!g || g.id || d.alert_id !== g.alertId) return;
  g.id = d.gen; g.source = d.source; g.model = d.model;
  schedulePaint();
}
function onToken(d) {
  const g = state.gen;
  if (!g || d.gen !== g.id) return;
  if (g.ttftClient === null) {
    g.ttftClient = performance.now() - g.t0;
    g.ttftServer = d.ttft_ms ?? null;
    g.state = 'streaming';
    renderTiles();
  }
  if (d.o !== g.text.length) g.offsetError = true; // never expected: the token lane is ordered and lossless
  g.text += d.t;
  schedulePaint();
}
function onGenEnd(d) {
  const g = state.gen;
  if (!g || d.gen !== g.id) return;
  g.state = d.reason === 'done' ? 'done' : d.reason === 'cancelled' || d.reason === 'replaced' ? 'cancelled' : 'error';
  g.pauses = d.pauses || 0;
  if (d.reason === 'error') g.error = d.error || 'generation failed';
  if (g.ttftClient === null) g.ttftClient = null;
  paintExplain();
  renderAlerts();
  renderTiles();
}

/* ------------------------------------------------------------------ drill-down */

function renderDrill() {
  const d = state.data.requests;
  const box = clear($('#reqlist'));
  if (!d) return;
  const head = h('tr', null, ...['Time (UTC)', 'Tenant', 'Endpoint', 'Status', 'LLM calls', 'LLM cost', 'Infra', 'Total'].map((t, i) => h('th', { scope: 'col', text: t, class: i < 3 ? 'left' : null })));
  const body = h('tbody');
  for (const r of d.rows) {
    const sel = state.selectedRequest === r.id;
    const bad = r.status === 429 || r.status >= 500;
    const tr = h('tr', { class: 'pick' + (sel ? ' selected' : ''), tabindex: '0', 'aria-selected': String(sel) },
      h('td', { class: 'num', text: F.utcStamp(r.ts).slice(5, 19) }), h('td', { text: r.tenant_id }), h('td', { class: 'mono', text: r.endpoint }),
      h('td', { class: 'statuscell' }, h('span', { class: 'pill' + (bad ? ' bad' : ''), text: `${bad ? '✕ ' : ''}${r.status}` })),
      h('td', { class: 'num', text: String(r.llm_calls) }), h('td', { class: 'num', text: F.usd(r.llm_cost_micro_usd, { precise: true }) }),
      h('td', { class: 'num', text: F.usd(r.infra_cost_micro_usd, { precise: true }) }), h('td', { class: 'num', text: F.usd(r.total_cost_micro_usd, { precise: true }) }));
    const open = () => openRequest(r.id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    body.append(tr);
  }
  box.append(h('table', null, h('caption', { class: 'sr-only', text: 'Requests for the current filters' }), h('thead', null, head), body));
  if (!d.rows.length) box.append(h('div', { class: 'empty', text: 'No requests match.' }));
  renderDetail();
}

async function openRequest(id) {
  state.selectedRequest = id;
  try { state.detail = await getJson(`api/requests/${encodeURIComponent(id)}`); } catch (e) { toast(e.message); state.detail = null; }
  renderDrill();
}

function renderDetail() {
  const box = clear($('#reqdetail'));
  const d = state.detail;
  if (!state.selectedRequest || !d || d.id !== state.selectedRequest) { box.hidden = true; return; }
  box.hidden = false;
  box.append(h('div', { class: 'kv' },
    h('span', null, 'Request ', h('b', { class: 'mono', text: d.id })), h('span', null, 'tenant ', h('b', { text: d.tenant_id })), h('span', null, h('b', { class: 'mono', text: `${d.method} ${d.endpoint}` })),
    h('span', null, 'status ', h('b', { text: String(d.status) })), h('span', null, 'duration ', h('b', { text: F.ms(d.duration_ms) })), h('span', null, F.utcStamp(d.ts))));
  // the cache-write column only appears when some call wrote to the prompt cache (it is billed at its own rate)
  const hasWrites = d.llm_calls.some((c) => c.cache_write_tokens || c.cache_write_1h_tokens);
  const cols = ['#', 'Model', 'Input tokens', 'Cached tokens', ...(hasWrites ? ['Cache writes'] : []), 'Output tokens', 'Latency', 'Cost'];
  const head = h('tr', null, ...cols.map((t, i) => h('th', { scope: 'col', text: t, class: i < 2 ? 'left' : null })));
  const body = h('tbody');
  d.llm_calls.forEach((c, i) => body.append(h('tr', null, h('td', { text: String(i + 1) }), h('td', { class: 'mono', text: c.model }), h('td', { class: 'num', text: F.int(c.input_tokens) }),
    h('td', { class: 'num', text: `${F.int(c.cached_tokens)} (${c.input_tokens ? Math.round((c.cached_tokens / c.input_tokens) * 100) : 0}%)` }),
    ...(hasWrites ? [h('td', { class: 'num', text: F.int(c.cache_write_tokens + c.cache_write_1h_tokens) })] : []),
    h('td', { class: 'num', text: F.int(c.output_tokens) }), h('td', { class: 'num', text: F.ms(c.latency_ms) }), h('td', { class: 'num', text: F.usd(c.cost_micro_usd, { precise: true }) }))));
  if (!d.llm_calls.length) body.append(h('tr', null, h('td', { colspan: String(cols.length), class: 'muted', text: 'This request made no LLM calls (infrastructure cost only).' })));
  box.append(h('div', { class: 'tablewrap calls', tabindex: '0', role: 'region', 'aria-label': `LLM calls of this request (${d.llm_calls.length})` }, h('table', null, h('thead', null, head), body)));
  box.append(h('div', { class: 'kv' }, h('span', null, 'LLM ', h('b', { text: F.usd(d.llm_cost_micro_usd, { precise: true }) })), h('span', null, '+ infra ', h('b', { text: F.usd(d.infra_cost_micro_usd, { precise: true }) })), h('span', null, '= total ', h('b', { text: F.usd(d.total_cost_micro_usd, { precise: true }) }))));
  box.append(h('div', { class: 'hint', text: hasWrites ? 'Cost = (input − cached − cache writes) × input price + cached × cache-read price + cache writes × cache-write price (5 min / 1 h) + output × output price, from model_prices at the call time.' : 'Cost = (input − cached) × input price + cached × cached price + output × output price, from model_prices at the call time.' }));
}

/* ------------------------------------------------------------------ backpressure lab */

const linkLabel = (b) => (b === 0 ? 'Unlimited' : b >= 1048576 ? `${b / 1048576} MB/s` : `${b / 1024} KB/s`);
let throttleTimer, rateTimer;
function postThrottle() { return postJson('api/throttle', { cid: state.cid, bytes_per_sec: LINK_STEPS[state.lab.link] }).catch((e) => toast(e.message)); }

function renderLab() {
  const ctl = clear($('#labctl'));
  const mk = (id, label, steps, key, fmt, onchange) => {
    const out = h('span', { class: 'num', id: `${id}-v`, text: fmt(steps[state.lab[key]]) });
    const input = h('input', { type: 'range', id, min: '0', max: String(steps.length - 1), step: '1', value: String(state.lab[key]), 'aria-describedby': `${id}-v` });
    input.addEventListener('input', () => { state.lab[key] = Number(input.value); out.textContent = fmt(steps[state.lab[key]]); onchange(); });
    return h('div', { class: 'ctl' }, h('label', { for: id }, h('span', { text: label }), out), input);
  };
  ctl.append(
    mk('lab-link', 'Link speed (bytes/s to this browser)', LINK_STEPS, 'link', linkLabel, () => { clearTimeout(throttleTimer); throttleTimer = setTimeout(postThrottle, 150); }),
    mk('lab-model', 'Model speed (tokens/s, mock model)', MODEL_STEPS, 'model', (v) => `${v} tok/s`, () => {}),
    mk('lab-rate', 'Write rate (simulated requests/s)', RATE_STEPS, 'rate', (v) => `${v} req/s`, () => { clearTimeout(rateTimer); rateTimer = setTimeout(() => postJson('api/sim', { rate: RATE_STEPS[state.lab.rate] }).catch((e) => toast(e.message)), 150); }),
    mk('lab-repeat', 'Explanation length (mock model, stress)', REPEAT_STEPS, 'repeat', (v) => `${v}×`, () => {}));
  $('#lab-rate').closest('.ctl').classList.add('sim-only');
  const act = clear($('#labactions'));
  const inject = (kind, text) => h('button', { type: 'button', class: 'btn small sim-only', onclick: () => postJson('api/sim', { inject: kind, hours: 2 }).then(() => toast(`Injected: ${text}`)).catch((e) => toast(e.message)) }, `Inject ${text}`);
  act.append(
    h('button', { type: 'button', class: 'btn small primary', onclick: () => { const a = visibleAlerts('active')[0] || visibleAlerts('all')[0]; if (a) explain(a); else toast('No alert to explain yet.'); } }, 'Explain latest alert'),
    inject('tenant_cost_spike', 'tenant cost spike'), inject('token_bloat', 'prompt bloat'), inject('retry_storm', 'retry storm'),
    h('button', { type: 'button', class: 'btn small sim-only', id: 'simtoggle', onclick: () => postJson('api/sim', { running: !(state.stats?.sim.running) }).catch((e) => toast(e.message)) }, 'Pause simulator'),
    h('span', { class: 'hint', id: 'simstate' }));
}

function renderCounters() {
  const st = state.stats;
  const c = st?.channel;
  const box = clear($('#counters'));
  const item = (n, l, d) => h('div', { class: 'counter' }, h('div', { class: 'n num', text: n }), h('div', { class: 'l', text: l }), h('div', { class: 'd', text: d }));
  box.append(
    item(c ? F.int(c.chunks_coalesced) : '—', 'Chunks coalesced', c ? `${F.int(c.chunks_in)} in → ${F.int(c.token_frames)} frames` : ''),
    item(c ? F.int(c.model_pauses) : '—', 'Model pauses', 'source paused at the high-water mark'),
    item(c ? F.int(c.rows_conflated) : '—', 'Rows conflated', c ? `${F.int(c.rows_in)} updates in → ${F.int(c.rows_sent)} sent` : ''),
    item(c ? F.int(c.resyncs) : '—', 'Resyncs', c ? `${F.int(c.snapshots)} snapshots sent` : 'pending set dropped → snapshot'),
    item(c ? F.bytes(c.token_queue_bytes) : '—', 'Token queue', c ? `${F.int(c.pending_rows)} rows pending` : ''),
    item(c ? F.bytes(c.transport_buffered) : '—', 'Socket buffer', c ? `peak ${F.bytes(c.max_buffered)} · blocked ${F.int(c.blocked_events)}×` : ''));
  const q = state.queue;
  queueChart($('#queue'), q, { fmt: F.bytes });
  const cap = $('#queue');
  if (!cap.querySelector('.hint')) cap.append(h('div', { class: 'hint', text: 'Queued bytes over the last minute (token queue + socket buffer). Peak ' }));
  const hint = cap.querySelector('.hint');
  hint.textContent = `Queued bytes (token queue + socket buffer), last ${Math.round(q.length / 2)}s · peak ${F.bytes(Math.max(0, ...q))}`;
  renderSource();
  if (st && st.sim.disabled) {
    $('#simstate').textContent = 'Imported data: the simulator is disabled, so the lab only exercises the explanation stream and the link throttle.';
  } else if (st) {
    $('#simstate').textContent = `Simulated clock ${F.utcStamp(st.sim.sim_now).slice(0, 16)} UTC · ${st.sim.written.toLocaleString('en-US')} requests written` + (st.sim.anomalies.some((a) => a.active) ? ` · active: ${st.sim.anomalies.filter((a) => a.active).map((a) => a.kind.replace(/_/g, ' ')).join(', ')}` : '');
    const tg = $('#simtoggle');
    if (tg) tg.textContent = st.sim.running ? 'Pause simulator' : 'Resume simulator';
  }
}

async function pollStats() {
  if (document.hidden) return;
  try {
    state.stats = await getJson(`api/stats?cid=${encodeURIComponent(state.cid)}`);
    const c = state.stats.channel;
    if (c) { state.queue.push(c.token_queue_bytes + c.transport_buffered); if (state.queue.length > 120) state.queue.shift(); }
    renderCounters();
  } catch { /* server restarting */ }
}

/* ------------------------------------------------------------------ chrome */

function exportCsv(view) {
  const a = h('a', { href: `api/export.csv?${qs({ view, group: view === 'timeseries' ? state.stackBy : undefined })}`, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', state.theme);
  $('#theme').textContent = `Theme: ${state.theme}`;
}

function renderAll() {
  renderHeader();
  renderFilters();
  renderTiles();
  renderChart();
  renderDim('tenantcard', 't-title', 'tenant', 'By tenant');
  renderDim('endpointcard', 'e-title', 'endpoint', 'By endpoint');
  renderDim('modelcard', 'm-title', 'model', 'By model');
  renderAlerts();
  renderDrill();
  renderFoot();
}

function renderFoot() {
  const clock = state.stats?.source ? 'the newest imported record defines "now"' : 'the data clock is simulated and may run ahead of your wall clock';
  $('#foot').textContent = `All money is stored as integer micro-dollars and computed from the model_prices table. Times are UTC; ${clock}. Client id ${state.cid.slice(0, 7)}…`;
}

/** Imported databases: say where the data came from, and take the simulator controls away (the simulator is disabled on them). */
let shownSource;
function renderSource() {
  const src = state.stats?.source ?? null;
  const id = src ? src.id : null;
  if (id !== shownSource) {
    shownSource = id;
    const box = $('#source-banner');
    box.hidden = !src;
    box.textContent = '';
    if (src) box.append(h('b', { text: 'Imported data. ' }), document.createTextNode(src.note));
    renderFoot();
    renderAlerts();
  }
  $$('.sim-only').forEach((el) => { el.hidden = !!src; });
}

function wire() {
  $$('#range button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.range === state.range));
    b.addEventListener('click', () => { state.range = b.dataset.range; save('finops.range', state.range); $$('#range button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); scheduleRefresh(true); });
  });
  $('#stackby').addEventListener('change', (e) => { state.stackBy = e.target.value; scheduleRefresh(true); });
  $$('#viewtoggle button').forEach((b) => b.addEventListener('click', () => { state.view = b.dataset.view; $$('#viewtoggle button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); renderChart(); }));
  $$('#alertfilter button').forEach((b) => b.addEventListener('click', () => { state.alertFilter = b.dataset.af; $$('#alertfilter button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); renderAlerts(); }));
  $$('#drillsort button').forEach((b) => b.addEventListener('click', () => { state.drillSort = b.dataset.sort; $$('#drillsort button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); scheduleRefresh(true); }));
  $$('[data-export]').forEach((b) => { if (!b.onclick) b.addEventListener('click', () => exportCsv(b.dataset.export)); });
  $('#cancelgen').addEventListener('click', () => postJson('api/cancel', { cid: state.cid }).catch((e) => toast(e.message)));
  $('#theme').addEventListener('click', () => { state.theme = { auto: 'light', light: 'dark', dark: 'auto' }[state.theme]; save('finops.theme', state.theme); applyTheme(); });
  const pat = $('#patterns');
  pat.setAttribute('aria-pressed', String(state.patterns));
  pat.addEventListener('click', () => { state.patterns = !state.patterns; save('finops.patterns', state.patterns ? '1' : '0'); pat.setAttribute('aria-pressed', String(state.patterns)); renderChart(); });
  const tr = $('#transport');
  tr.value = state.transport;
  tr.addEventListener('change', () => { state.transport = tr.value; save('finops.transport', state.transport); connect(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { scheduleRefresh(true); pollStats(); } });
  // Back/Forward (the data source switcher makes it a normal gesture): the browser may park this page in its back/forward cache, which kills open
  // sockets. Close the stream cleanly on the way out and reconnect when the page is restored; the server replays the gap or sends a fresh snapshot.
  window.addEventListener('pagehide', () => state.stream?.close());
  window.addEventListener('pageshow', (e) => {
    if (currentSourceId) $('#source').value = currentSourceId; // a restored page keeps the value the user last picked (the source they were leaving for)
    if (e.persisted) { connect(); scheduleRefresh(true); pollStats(); }
  });
  let rz;
  new ResizeObserver(() => { clearTimeout(rz); rz = setTimeout(() => { if (state.view === 'chart') renderChart(); }, 120); }).observe($('#chartcard'));
  window.matchMedia?.('(forced-colors: active)').addEventListener?.('change', renderChart);
}

/** Multi-database server: fill the "Data source" dropdown. Picking one opens that database's dashboard (/d/<id>/). A single-database server has no switcher. */
let currentSourceId = null;
async function loadSources() {
  try {
    const s = await getJson('api/sources');
    if (!s.current || s.sources.length < 2) return;
    const sel = $('#source');
    clear(sel);
    for (const x of s.sources) sel.append(h('option', { value: x.id, title: x.note || '', text: x.label }));
    currentSourceId = s.current;
    sel.value = s.current;
    sel.hidden = false;
    const cur = s.sources.find((x) => x.id === s.current);
    if (cur) document.title = `FinOps · ${cur.label}`;
    sel.addEventListener('change', () => location.assign(new URL(`../${encodeURIComponent(sel.value)}/`, location.href)));
  } catch { /* a server without /api/sources */ }
}

applyTheme();
wire();
loadSources();
renderLab();
renderCounters();
connect();
refreshAll();
setInterval(pollStats, 500);
setInterval(renderHeader, 1000);
