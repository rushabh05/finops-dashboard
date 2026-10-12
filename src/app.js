import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { loadConfig } from './config.js';
import { openDb, transaction, ChangeLog, getMeta, setMeta } from './db.js';
import { PriceBook, seedPrices } from './pricing.js';
import { Ingestor, ValidationError, verifyRollups, RE_TENANT, RE_ENDPOINT } from './ingest.js';
import { Detector } from './detector.js';
import { ANOMALY_KINDS, Simulator, seedHistory } from './sim.js';
import { ChangeFeed } from './feed.js';
import { Hub } from './hub.js';
import { getAlert, listAlerts, setAlertStatus, AlertStateError, ALERT_STATUSES } from './alerts.js';
import { buildExplainContext, buildPrompt, mockSource, anthropicSource } from './explain.js';
import { HOUR } from './util.js';
import * as Q from './queries.js';
import { HttpError, OriginPolicy, Auth, authGate, listenGuard, P, FILTER_PARAMS, parseParams, readJson, pick, vInt, vEnum, vBool, vRegex, securityHeaders, RE_CID } from './security.js';
import { checkUpgrade, handshakeResponse, FrameParser, encodeFrame, encodeClose, OP, ProtocolError } from './ws.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

/**
 * One dashboard over one database, WITHOUT an HTTP server: `handle(req, res)` and `handleUpgrade(req, socket, head)` serve it.
 * createApp() wraps it in a server of its own; the multi-database front door (src/multi.js) hosts several, one per URL prefix.
 * ctx: { getPort?, sources? } - the port the server really listens on (for the Origin/Host policy) and the list for the source switcher.
 */
export async function createWorkspace(overrides = {}, env = process.env, ctx = {}) {
  const cfg = loadConfig(env, overrides);
  const auth = new Auth(cfg.authToken); // validated before anything is opened: a too-short token throws here
  const startedAt = Date.now();
  const log = cfg.log ?? (() => {});

  const db = openDb(cfg.dbPath);
  seedPrices(db);
  const priceBook = new PriceBook(db);
  const ingestor = new Ingestor(db, priceBook, { maxBatch: cfg.limits.maxBatch, maxCallsPerRequest: cfg.limits.maxCallsPerRequest });
  const changeLog = new ChangeLog(db);

  // a database filled by one of the importers (scripts/import-*.js) is tagged: it holds real data, so the simulator never touches it
  const dataSource = getMeta(db, 'source');
  const dataSourceNote = getMeta(db, 'source_note', '');

  // first run: seed history through the real ingest path, then forget the change log it produced
  const empty = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n === 0;
  let simStart = Math.floor(Date.now() / HOUR) * HOUR;
  if (empty && cfg.seedDays > 0 && !dataSource) {
    const t0 = Date.now();
    log(`seeding ${cfg.seedDays} days of history...`);
    const r = seedHistory(ingestor, { seed: cfg.seed, days: cfg.seedDays, endTs: simStart, volumeScale: cfg.volumeScale });
    changeLog.reset();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    log(`seeded ${r.requests} requests / ${r.llm_calls} LLM calls in ${Date.now() - t0} ms`);
  } else if (!empty) {
    simStart = db.prepare('SELECT MAX(ts) AS t FROM requests').get().t + 1;
  }

  const feed = new ChangeFeed(db, { windowHours: cfg.liveWindowHours });
  const hub = new Hub({ feed, cfg });
  const detector = new Detector(db, cfg.detector);
  const sim = new Simulator({ ingestor, seed: cfg.seed, volumeScale: cfg.volumeScale, rate: cfg.simRate, startTs: simStart, autoAnomalies: cfg.simAnomalies, maxBatch: cfg.limits.maxBatch });

  let port = cfg.port;
  const policy = new OriginPolicy(cfg, ctx.getPort ?? (() => port));
  const files = new Map();
  try {
    for (const f of readdirSync(cfg.publicDir)) if (MIME[extname(f)]) files.set(`/${f}`, { type: MIME[extname(f)], body: readFileSync(join(cfg.publicDir, f)) });
  } catch { /* no public dir: API only */ }

  /* ---- detection scheduling: after writes, at most once per detectEveryMs ---- */
  let detectTimer = null, lastDetect = 0;
  const lastRun = { at: null, hour: null, evaluated: 0, inserted: 0, suppressed: 0, ms: null, skipped: null };
  function runDetector() {
    const t0 = Date.now();
    const r = detector.run();
    Object.assign(lastRun, { at: Date.now(), hour: r.hour, evaluated: r.evaluated, inserted: r.inserted.length, suppressed: r.suppressed, ms: Date.now() - t0, skipped: r.skipped ?? null });
    if (r.inserted.length) feed.notify();
    return r;
  }
  function scheduleDetect() {
    if (detectTimer) return;
    const wait = Math.max(0, lastDetect + cfg.detectEveryMs - Date.now());
    detectTimer = setTimeout(() => {
      detectTimer = null;
      lastDetect = Date.now();
      try { runDetector(); } catch (e) { console.error('detector failed', e); }
    }, wait);
    detectTimer.unref?.();
  }
  function afterWrite() { feed.notify(); scheduleDetect(); }
  sim.on('write', afterWrite);
  sim.on('error', (e) => console.error('simulator write failed:', e.message));

  const pruneTimer = setInterval(() => { try { changeLog.prune(cfg.changeLogKeep); } catch (e) { console.error('prune failed', e); } }, 30_000);
  pruneTimer.unref?.();

  /* ---- the simulator: started by the owner; optionally paused while nobody is watching (so an unattended sample database does not grow forever) ---- */
  let userPaused = false, idleTimer = null, lastViewerAt = Date.now();
  const simWanted = () => cfg.simAutoStart && !dataSource;
  function idleTick() {
    if (hub.size > 0) { lastViewerAt = Date.now(); if (!sim.running && !userPaused) sim.start(); }
    else if (sim.running && Date.now() - lastViewerAt > cfg.simIdleMs) sim.stop();
  }
  function startSim() {
    if (!simWanted()) return;
    if (!userPaused) sim.start();
    if (cfg.simPauseWhenIdle && !idleTimer) { lastViewerAt = Date.now(); idleTimer = setInterval(idleTick, cfg.simIdleCheckMs); idleTimer.unref?.(); }
  }

  /* ---- helpers ---- */
  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': buf.length, ...headers });
    res.end(buf);
  };
  const filtersOf = (q) => ({ range: q.range || '24h', tenant: q.tenant, endpoint: q.endpoint, model: q.model });
  const requireOrigin = (req) => { if (!policy.originOk(req)) throw new HttpError(403, 'origin not allowed'); };

  /* ---- routes ---- */
  const getRoutes = {
    '/healthz': (req, res) => {
      db.prepare('SELECT 1').get();
      send(res, 200, { ok: true, uptime_s: Math.round((Date.now() - startedAt) / 1000) });
    },
    '/api/summary': (req, res, url) => send(res, 200, Q.summary(db, filtersOf(parseParams(url.searchParams, FILTER_PARAMS)))),
    '/api/by-tenant': (req, res, url) => send(res, 200, Q.byDimension(db, filtersOf(parseParams(url.searchParams, FILTER_PARAMS)), 'tenant')),
    '/api/by-endpoint': (req, res, url) => send(res, 200, Q.byDimension(db, filtersOf(parseParams(url.searchParams, FILTER_PARAMS)), 'endpoint')),
    '/api/by-model': (req, res, url) => send(res, 200, Q.byDimension(db, filtersOf(parseParams(url.searchParams, FILTER_PARAMS)), 'model')),
    '/api/timeseries': (req, res, url) => {
      const q = parseParams(url.searchParams, { ...FILTER_PARAMS, group: { type: 'enum', values: ['tenant', 'endpoint', 'model', 'total'] }, top: { type: 'int', min: 1, max: 10 } });
      send(res, 200, Q.timeseries(db, filtersOf(q), q.group || 'tenant', q.top || 7));
    },
    '/api/requests': (req, res, url) => {
      const q = parseParams(url.searchParams, { ...FILTER_PARAMS, sort: { type: 'enum', values: ['recent', 'cost'] }, limit: P.limit(100) });
      send(res, 200, Q.requestList(db, filtersOf(q), { sort: q.sort || 'cost', limit: q.limit || 25 }));
    },
    '/api/alerts': (req, res, url) => {
      const q = parseParams(url.searchParams, { status: { type: 'enum', values: ['active', 'all', ...ALERT_STATUSES] }, tenant: P.tenant, endpoint: P.endpoint, limit: P.limit(500) });
      send(res, 200, { alerts: listAlerts(db, { status: q.status || 'all', tenant: q.tenant, endpoint: q.endpoint, limit: q.limit || 100 }) });
    },
    '/api/export.csv': (req, res, url) => {
      const q = parseParams(url.searchParams, { ...FILTER_PARAMS, view: { type: 'enum', values: ['tenant', 'endpoint', 'model', 'timeseries', 'alerts', 'requests'] }, group: { type: 'enum', values: ['tenant', 'endpoint', 'model', 'total'] } });
      if (!q.view) throw new HttpError(400, '"view" is required');
      const { filename, csv } = Q.exportCsv(db, { ...filtersOf(q), group: q.group }, q.view);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
      res.end(csv);
    },
    '/api/stats': (req, res, url) => {
      const q = parseParams(url.searchParams, { cid: P.cid, verify: { type: 'enum', values: ['1'] } });
      const counts = db.prepare('SELECT (SELECT COUNT(*) FROM requests) AS requests, (SELECT COUNT(*) FROM llm_calls) AS llm_calls, (SELECT COUNT(*) FROM rollups_hourly) AS rollups, (SELECT COUNT(*) FROM alerts) AS alerts').get();
      const out = {
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        sim: { ...sim.status(), disabled: !!dataSource },
        source: dataSource ? { id: dataSource, note: dataSourceNote } : null,
        db: { ...counts, change_log: { head: changeLog.head(), retained: changeLog.count(), pruned_to: changeLog.prunedTo() } },
        feed: { head: feed.head, ...feed.stats, window_hours: feed.windowHours },
        detector: lastRun,
        ...hub.stats(q.cid),
        llm: { anthropic_enabled: !!cfg.anthropicKey, model: cfg.anthropicKey ? cfg.anthropicModel : null, default_source: cfg.anthropicKey ? 'anthropic' : 'mock' },
      };
      if (q.verify) { const diffs = verifyRollups(db); out.rollups_consistent = diffs.length === 0; out.rollup_diffs = diffs.slice(0, 5); }
      send(res, 200, out);
    },
    '/stream': (req, res, url) => handleStream(req, res, url),
    // the list behind the page's "Data source" switcher ({ current: null, sources: [] } when this server hosts a single database)
    '/api/sources': (req, res) => send(res, 200, ctx.sources ? ctx.sources() : { current: null, sources: [] }),
  };

  const postRoutes = {
    '/api/ingest': async (req, res) => {
      const body = await readJson(req, cfg.limits.ingestBodyBytes);
      const r = ingestor.ingest(body);
      afterWrite();
      send(res, 200, r);
    },
    '/api/generate': async (req, res) => {
      const body = pick(await readJson(req, cfg.limits.jsonBodyBytes), {
        cid: vRegex(RE_CID), alert_id: vInt(1, 2 ** 31), source: vEnum('auto', 'mock', 'anthropic'), tokens_per_sec: vInt(1, 5000), repeat: vInt(1, 100),
      });
      if (!body.cid || !body.alert_id) throw new HttpError(400, '"cid" and "alert_id" are required');
      const ch = hub.get(body.cid);
      if (!ch) throw new HttpError(409, 'no open stream for this client id - connect to /stream (or /ws) first');
      const alert = getAlert(db, body.alert_id);
      if (!alert) throw new HttpError(404, 'alert not found');
      if (!(ch.gen && !ch.gen.ended) && hub.activeGenerations() >= cfg.limits.maxGenerations) throw new HttpError(429, 'too many generations running; try again shortly');
      let source = body.source || 'auto';
      if (source === 'auto') source = cfg.anthropicKey ? 'anthropic' : 'mock';
      if (source === 'anthropic' && !cfg.anthropicKey) throw new HttpError(400, 'ANTHROPIC_API_KEY is not configured on the server');
      const ctx = buildExplainContext(db, alert);
      const ac = new AbortController();
      let iterable, model = null;
      if (source === 'anthropic') {
        const prompt = buildPrompt(ctx);
        model = cfg.anthropicModel;
        iterable = anthropicSource({ apiKey: cfg.anthropicKey, model, baseUrl: cfg.anthropicBaseUrl, effort: cfg.anthropicEffort, maxTokens: cfg.anthropicMaxTokens, system: prompt.system, user: prompt.user, signal: ac.signal });
      } else {
        model = 'mock-explainer';
        iterable = mockSource(ctx, { tokensPerSec: body.tokens_per_sec || 40, signal: ac.signal, repeat: body.repeat || 1 });
      }
      const id = hub.nextGenId();
      ch.startGeneration({ id, source: iterable, abort: () => ac.abort(), meta: { alert_id: alert.id, source, model, tokens_per_sec: source === 'mock' ? body.tokens_per_sec || 40 : null } });
      send(res, 202, { gen: id, source, model });
    },
    '/api/cancel': async (req, res) => {
      const body = pick(await readJson(req, cfg.limits.jsonBodyBytes), { cid: vRegex(RE_CID) });
      if (!body.cid) throw new HttpError(400, '"cid" is required');
      const ch = hub.get(body.cid);
      send(res, 200, { cancelled: ch ? ch.cancelGeneration('cancelled') : false });
    },
    '/api/throttle': async (req, res) => {
      const body = pick(await readJson(req, cfg.limits.jsonBodyBytes), { cid: vRegex(RE_CID), bytes_per_sec: vInt(0, 100_000_000) });
      if (body.bytes_per_sec === undefined) throw new HttpError(400, '"bytes_per_sec" is required (0 = unlimited)');
      if (!hub.setThrottle(body.cid, body.bytes_per_sec)) throw new HttpError(404, 'no open stream for this client id');
      send(res, 200, { ok: true, bytes_per_sec: body.bytes_per_sec, scope: body.cid ? 'channel' : 'all' });
    },
    '/api/sim': async (req, res) => {
      if (dataSource) throw new HttpError(409, `the simulator is disabled: this database holds imported data (${dataSource})`);
      const body = pick(await readJson(req, cfg.limits.jsonBodyBytes), {
        rate: vInt(0, cfg.limits.maxSimRate), running: vBool, inject: vEnum(...ANOMALY_KINDS), hours: vInt(1, 24), tenant: vRegex(RE_TENANT), endpoint: vRegex(RE_ENDPOINT),
      });
      if (body.rate !== undefined) sim.setRate(body.rate);
      if (body.running === true) { userPaused = false; sim.start(); } else if (body.running === false) { userPaused = true; sim.stop(); }
      if (body.inject) sim.inject(body.inject, { hours: body.hours ?? 2, tenant: body.tenant, endpoint: body.endpoint });
      send(res, 200, sim.status());
    },
  };

  function handleStream(req, res, url) {
    const q = parseParams(url.searchParams, { cid: P.cid, lastEventId: { type: 'int', min: 0, max: 1e12 } });
    if (!q.cid) throw new HttpError(400, '"cid" is required');
    let lastId = q.lastEventId ?? null;
    const hdr = req.headers['last-event-id'];
    if (hdr !== undefined) {
      if (!/^\d{1,12}$/.test(hdr)) throw new HttpError(400, 'invalid Last-Event-ID');
      lastId = Number(hdr);
    }
    if (hub.size >= cfg.limits.maxChannels && !hub.get(q.cid)) throw new HttpError(503, 'too many open streams');
    res.writeHead(200, {
      ...securityHeaders(req.headers.host),
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 30_000); // notice peers that vanished without a FIN
    req.socket.setTimeout(0);
    res.write('retry: 1500\n\n');
    hub.open({ cid: q.cid, kind: 'sse', stream: res, lastId });
    if (idleTimer) idleTick();
  }

  const alertAction = /^\/api\/alerts\/(\d{1,10})\/(ack|resolve)$/;
  // the id arrives percent-encoded (ids may contain ':' and '#'): decode first, then apply the same allowlist the ingest uses
  const requestById = /^\/api\/requests\/([^/]{1,400})$/;
  const RE_REQUEST_ID = /^[A-Za-z0-9._:#-]{1,100}$/;

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const base = securityHeaders(req.headers.host);
    for (const [k, v] of Object.entries(base)) res.setHeader(k, v);
    if (!policy.hostOk(req)) throw new HttpError(403, 'host not allowed');
    if (authGate(auth, cfg, req, res, url)) return;

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (getRoutes[pathname]) return getRoutes[pathname](req, res, url);
      const m = requestById.exec(pathname);
      if (m) {
        parseParams(url.searchParams, {});
        let id;
        try { id = decodeURIComponent(m[1]); } catch { throw new HttpError(400, 'bad request id'); }
        if (!RE_REQUEST_ID.test(id)) throw new HttpError(404, 'request not found');
        const d = Q.requestDetail(db, priceBook, id);
        if (!d) throw new HttpError(404, 'request not found');
        return send(res, 200, d);
      }
      const file = files.get(pathname === '/' ? '/index.html' : pathname);
      if (file) {
        res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-cache', 'Content-Length': file.body.length });
        return res.end(req.method === 'HEAD' ? undefined : file.body);
      }
      throw new HttpError(404, 'not found');
    }
    if (req.method === 'POST') {
      requireOrigin(req);
      if (postRoutes[pathname]) return postRoutes[pathname](req, res, url);
      const m = alertAction.exec(pathname);
      if (m) {
        await readJson(req, cfg.limits.jsonBodyBytes); // enforces JSON content type + body cap, body itself unused
        const out = setAlertStatus(db, Number(m[1]), m[2] === 'ack' ? 'ack' : 'resolved');
        if (!out) throw new HttpError(404, 'alert not found');
        feed.notify();
        return send(res, 200, out);
      }
      throw new HttpError(404, 'not found');
    }
    throw new HttpError(405, 'method not allowed');
  }

  async function handle(req, res) {
    try {
      await route(req, res);
    } catch (e) {
      if (res.headersSent) { try { res.destroy(); } catch { /* ignore */ } return; }
      if (e instanceof ValidationError) return send(res, e.status, { error: e.message, errors: e.errors });
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      if (e instanceof AlertStateError) return send(res, 409, { error: e.message });
      console.error('request failed:', e);
      send(res, 500, { error: 'internal error' });
    }
  }

  function handleUpgrade(req, socket, head) {
    socket.on('error', () => { /* resets from clients that vanish mid-handshake must never crash the process */ });
    const reject = (status, msg) => {
      try { socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignore */ }
      socket.destroy();
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') return reject(404, 'Not Found');
      if (!policy.hostOk(req) || !policy.originOk(req)) return reject(403, 'Forbidden');
      if (!auth.ok(req)) return reject(401, 'Unauthorized');
      const { key } = checkUpgrade(req);
      const q = parseParams(url.searchParams, { cid: P.cid, lastEventId: { type: 'int', min: 0, max: 1e12 } });
      if (!q.cid) return reject(400, 'Bad Request');
      if (hub.size >= cfg.limits.maxChannels && !hub.get(q.cid)) return reject(503, 'Service Unavailable');
      socket.write(handshakeResponse(key));
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      socket.setTimeout(0);
      const ch = hub.open({ cid: q.cid, kind: 'ws', stream: socket, lastId: q.lastEventId ?? null });
      if (idleTimer) idleTick();
      const parser = new FrameParser({ maxPayload: 64 * 1024, expectMasked: true });
      const onData = (chunk) => {
        try {
          for (const m of parser.push(chunk)) {
            if (m.type === 'ping') socket.write(encodeFrame(OP.PONG, m.data));
            else if (m.type === 'close') { socket.write(encodeClose(1000)); ch.close('client closed', { notify: false }); return; } // echo the close once, not twice
            // text/binary from the client carry no commands: everything goes through the REST endpoints
          }
        } catch (e) {
          try { socket.write(encodeClose(e instanceof ProtocolError ? e.code : 1002, 'protocol error')); } catch { /* ignore */ }
          ch.close('protocol error', { notify: false });
          socket.destroy();
        }
      };
      if (head && head.length) onData(head);
      socket.on('data', onData);
    } catch (e) {
      reject(e instanceof HttpError || e instanceof ProtocolError ? 400 : 500, e instanceof HttpError || e instanceof ProtocolError ? 'Bad Request' : 'Internal Server Error');
    }
  }

  let closed = false;
  return {
    cfg, db, hub, feed, sim, detector, ingestor, priceBook, changeLog, policy, dataSource,
    runDetector, afterWrite, handle, handleUpgrade, startSim,
    setPort(p) { port = p; },
    /** Stop everything this workspace started and close its database (not the HTTP server: the owner closes that). */
    close() {
      if (closed) return;
      closed = true;
      sim.stop();
      clearTimeout(detectTimer);
      clearInterval(pruneTimer);
      clearInterval(idleTimer);
      feed.stop();
      hub.close();
      try { db.close(); } catch { /* ignore */ }
    },
  };
}

/** A complete single-database server: one workspace behind an HTTP server of its own. */
export async function createApp(overrides = {}, env = process.env) {
  const ws = await createWorkspace(overrides, env);
  const { cfg } = ws;
  const server = http.createServer({ highWaterMark: 16 * 1024 }, ws.handle);
  server.on('upgrade', ws.handleUpgrade);
  let port = cfg.port;
  let closed = false;
  const app = {
    ...ws, server,
    get port() { return port; },
    get url() { return `http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${port}`; },
    listen() {
      const problem = listenGuard(cfg);
      if (problem) return Promise.reject(new Error(problem));
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.port, cfg.host, () => {
          port = server.address().port;
          ws.setPort(port);
          ws.startSim();
          resolve(app);
        });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      ws.close();
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    },
  };
  return app;
}
