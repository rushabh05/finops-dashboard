import http from 'node:http';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from './config.js';
import { createWorkspace } from './app.js';
import { parseWebhookUrl } from './notify.js';
import { HttpError, OriginPolicy, Auth, authGate, listenGuard } from './security.js';

/*
 * Multi-database mode: ONE server, one dashboard per database, a "Data source" switcher in the page.
 *
 *   /                      redirects to the default source (the sample data unless DEFAULT_SOURCE says otherwise)
 *   /d/<id>/               that database's dashboard; /d/<id>/api/..., /d/<id>/stream, /d/<id>/ws are its API and live streams
 *   /api/sources           the list the switcher shows
 *   /healthz               liveness
 *
 * Every *.db file in the data directory that holds a dashboard schema is a source (rescanned every few seconds, so a freshly
 * imported database appears without a restart). A workspace (src/server.js createWorkspace) is opened on first use and is entirely
 * independent: its own change feed, channels, detector and, for the sample database only, simulator. Imported databases are tagged
 * and never get a simulator; the sample's simulator pauses while nobody is watching it, so an unattended server does not grow it forever.
 * The front door does the authentication and the Host check once; workspaces are created without a token of their own.
 */

export const SAMPLE_ID = 'finops';
const RE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const KNOWN_LABELS = {
  'import:claude-code': 'Claude Code usage',
  'import:trace:burstgpt': 'BurstGPT public trace',
  'import:trace:azure-conv': 'Azure LLM trace: conversation',
  'import:trace:azure-code': 'Azure LLM trace: code',
};

/** Open read-only and report the importer tag, or null when the file is not a dashboard database. */
function probe(file) {
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    if (!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'requests'").get()) return null;
    let source = null, note = '';
    try {
      source = db.prepare("SELECT value FROM meta WHERE key = 'source'").get()?.value ?? null;
      note = db.prepare("SELECT value FROM meta WHERE key = 'source_note'").get()?.value ?? '';
    } catch { /* an old database without a meta table */ }
    return { source, note };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/** The dashboard databases in `dataDir`: [{ id, label, kind: 'sample' | 'imported' | 'live', note, file }], sample first. */
export function discoverSources(dataDir) {
  const out = new Map();
  let names = [];
  try { names = readdirSync(dataDir); } catch { /* no data directory yet: only the sample exists */ }
  for (const f of names) {
    if (!f.endsWith('.db')) continue;
    const id = f.slice(0, -3);
    if (!RE_ID.test(id)) continue;
    const info = probe(join(dataDir, f));
    if (!info) continue;
    if (id === SAMPLE_ID) out.set(id, { id, label: 'Sample data (simulated)', kind: 'sample', note: 'Simulated customers and traffic, with planted anomalies.', file: join(dataDir, f) });
    else if (info.source) out.set(id, { id, label: KNOWN_LABELS[info.source] ?? info.source.replace(/^import:/, ''), kind: 'imported', note: info.note, file: join(dataDir, f) });
    else out.set(id, { id, label: id, kind: 'live', note: 'Live-ingest database.', file: join(dataDir, f) });
  }
  if (!out.has(SAMPLE_ID)) out.set(SAMPLE_ID, { id: SAMPLE_ID, label: 'Sample data (simulated)', kind: 'sample', note: 'Simulated customers and traffic, with planted anomalies.', file: join(dataDir, `${SAMPLE_ID}.db`) });
  const rank = { sample: 0, imported: 1, live: 2 };
  return [...out.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label));
}

export async function createMultiApp(overrides = {}, env = process.env) {
  const cfg = loadConfig(env, overrides);
  const auth = new Auth(cfg.authToken); // validated before anything is opened
  if (cfg.alertWebhookUrl) parseWebhookUrl(cfg.alertWebhookUrl, cfg.alertWebhookFormat); // so is the webhook URL: fail at startup, not at the first alert
  let port = cfg.port;
  const policy = new OriginPolicy(cfg, () => port);

  let cache = { at: 0, list: [] };
  const sources = () => {
    if (Date.now() - cache.at > cfg.sourcesTtlMs || !cache.list.length) cache = { at: Date.now(), list: discoverSources(cfg.dataDir) };
    return cache.list;
  };
  const publicList = (current) => ({
    current,
    sources: sources().map((s) => ({ id: s.id, label: s.label, kind: s.kind, note: s.note, path: `/d/${s.id}/` })),
  });
  const defaultId = () => (cfg.defaultSource && sources().some((s) => s.id === cfg.defaultSource) ? cfg.defaultSource : SAMPLE_ID);

  const workspaces = new Map(); // id -> Promise<workspace>
  function workspace(id) {
    let p = workspaces.get(id);
    if (!p) {
      const src = sources().find((s) => s.id === id);
      if (!src) throw new HttpError(404, 'unknown data source');
      const o = { ...overrides, dbPath: src.file, authToken: '', cookieSecure: false };
      if (src.kind === 'sample') o.simPauseWhenIdle = env.SIM_PAUSE_WHEN_IDLE !== '0';
      else { o.seedDays = 0; o.simAutoStart = false; } // only the sample database ever receives simulated rows
      p = createWorkspace(o, env, { getPort: () => port, sources: () => publicList(id) }).then((ws) => { ws.setPort(port); ws.startSim(); return ws; });
      workspaces.set(id, p);
      p.catch(() => workspaces.delete(id));
    }
    return p;
  }

  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': buf.length, ...headers });
    res.end(buf);
  };
  const redirect = (res, status, location) => { res.writeHead(status, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': '0' }); res.end(); };
  const PREFIX = /^\/d\/([^/]+)(\/.*)?$/;

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!policy.hostOk(req)) throw new HttpError(403, 'host not allowed');
      if (authGate(auth, cfg, req, res, url)) return;
      if (url.pathname === '/healthz') return send(res, 200, { ok: true, mode: 'multi' });
      if (url.pathname === '/api/sources' && (req.method === 'GET' || req.method === 'HEAD')) return send(res, 200, publicList(null));
      if (url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) return redirect(res, 302, `/d/${defaultId()}/`);
      const m = PREFIX.exec(url.pathname);
      if (!m) throw new HttpError(404, 'not found');
      if (!RE_ID.test(m[1]) || !sources().some((s) => s.id === m[1])) throw new HttpError(404, 'unknown data source');
      if (!m[2]) return redirect(res, 301, `/d/${m[1]}/${url.search}`); // relative URLs in the page need the trailing slash
      const ws = await workspace(m[1]);
      req.url = m[2] + url.search; // the workspace serves it as if it were the root
      return ws.handle(req, res);
    } catch (e) {
      if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      console.error('request failed:', e);
      send(res, 500, { error: 'internal error' });
    }
  }

  async function handleUpgrade(req, socket, head) {
    socket.on('error', () => { /* resets from clients that vanish mid-handshake must never crash the process */ });
    const reject = (status, msg) => {
      try { socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignore */ }
      socket.destroy();
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const m = PREFIX.exec(url.pathname);
      if (!m || m[2] !== '/ws' || !RE_ID.test(m[1]) || !sources().some((s) => s.id === m[1])) return reject(404, 'Not Found');
      if (!policy.hostOk(req) || !policy.originOk(req)) return reject(403, 'Forbidden');
      if (!auth.ok(req)) return reject(401, 'Unauthorized');
      const ws = await workspace(m[1]);
      req.url = '/ws' + url.search;
      ws.handleUpgrade(req, socket, head);
    } catch {
      reject(500, 'Internal Server Error');
    }
  }

  const server = http.createServer({ highWaterMark: 16 * 1024 }, handle);
  server.on('upgrade', handleUpgrade);
  let closed = false;
  const app = {
    cfg, server, policy, defaultId,
    sources: () => publicList(null).sources,
    workspace,
    openIds: () => [...workspaces.keys()],
    get port() { return port; },
    get url() { return `http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${port}`; },
    listen() {
      const problem = listenGuard(cfg);
      if (problem) return Promise.reject(new Error(problem));
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => { port = server.address().port; resolve(app); });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const p of workspaces.values()) { try { const w = await p; await w.flush(); w.close(); } catch { /* it never opened */ } }
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    },
  };
  return app;
}
