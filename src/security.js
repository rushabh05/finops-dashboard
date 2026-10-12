import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { RE_TENANT, RE_ENDPOINT, RE_MODEL } from './ingest.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const RE_CID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Query-string allowlist. spec: { name: { type: 'enum', values } | { type: 'int', min, max } | { type: 'regex', re } }.
 * Unknown parameters, repeated parameters and out-of-spec values are rejected with 400 - nothing reaches SQL unchecked.
 * (Values still travel as bound parameters; this is defence in depth and input hygiene.)
 */
export function parseParams(searchParams, spec) {
  const out = {};
  const seen = new Set();
  for (const [k, v] of searchParams) {
    if (!Object.hasOwn(spec, k)) throw new HttpError(400, `unknown query parameter "${k}"`);
    if (seen.has(k)) throw new HttpError(400, `repeated query parameter "${k}"`);
    seen.add(k);
    const s = spec[k];
    if (s.type === 'enum') {
      if (!s.values.includes(v)) throw new HttpError(400, `"${k}" must be one of: ${s.values.join(', ')}`);
      out[k] = v;
    } else if (s.type === 'int') {
      if (!/^\d{1,9}$/.test(v)) throw new HttpError(400, `"${k}" must be an integer`);
      const n = Number(v);
      if (n < s.min || n > s.max) throw new HttpError(400, `"${k}" must be between ${s.min} and ${s.max}`);
      out[k] = n;
    } else if (s.type === 'regex') {
      if (!s.re.test(v)) throw new HttpError(400, `"${k}" has an invalid format`);
      out[k] = v;
    }
  }
  return out;
}

export const P = {
  range: { type: 'enum', values: ['24h', '7d', '30d'] },
  tenant: { type: 'regex', re: RE_TENANT },
  endpoint: { type: 'regex', re: RE_ENDPOINT },
  model: { type: 'regex', re: RE_MODEL },
  cid: { type: 'regex', re: RE_CID },
  limit: (max) => ({ type: 'int', min: 1, max }),
};

export const FILTER_PARAMS = { range: P.range, tenant: P.tenant, endpoint: P.endpoint, model: P.model };

/** Read and parse a JSON POST body: requires application/json, caps the size while streaming. */
export function readJson(req, maxBytes) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!/^application\/json\s*(;|$)/.test(ct)) throw new HttpError(415, 'Content-Type must be application/json');
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > maxBytes) throw new HttpError(413, `body exceeds ${maxBytes} bytes`);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > maxBytes) {
        failed = true;
        reject(new HttpError(413, `body exceeds ${maxBytes} bytes`));
        req.resume(); // drain and discard so the response can still be written
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new HttpError(400, 'body is not valid JSON')); }
    });
    req.on('error', (e) => { if (!failed) reject(e); });
  });
}

/** Strict body validation helper: only listed keys, each checked by its predicate. */
export function pick(body, spec) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  const out = {};
  for (const k of Object.keys(body)) if (!Object.hasOwn(spec, k)) throw new HttpError(400, `unknown field "${k}"`);
  for (const [k, check] of Object.entries(spec)) {
    if (body[k] === undefined) continue;
    const v = check(body[k]);
    if (v === undefined) throw new HttpError(400, `invalid value for "${k}"`);
    out[k] = v;
  }
  return out;
}
export const vInt = (min, max) => (v) => (Number.isSafeInteger(v) && v >= min && v <= max ? v : undefined);
export const vEnum = (...values) => (v) => (values.includes(v) ? v : undefined);
export const vBool = (v) => (typeof v === 'boolean' ? v : undefined);
export const vRegex = (re) => (v) => (typeof v === 'string' && re.test(v) ? v : undefined);

/** Origin / Host policy. Loopback origins for the actual port are always allowed; extras come from config. */
export class OriginPolicy {
  constructor(config, getPort) {
    this.config = config;
    this.getPort = getPort;
  }
  _hosts() {
    const p = this.getPort();
    const base = [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`];
    if (this.config.host && !['0.0.0.0', '::'].includes(this.config.host)) base.push(`${this.config.host.includes(':') ? `[${this.config.host}]` : this.config.host}:${p}`);
    return new Set([...base, ...this.config.allowedHosts]);
  }
  allowedOrigins() {
    return new Set([...[...this._hosts()].map((h) => `http://${h}`), ...this.config.allowedOrigins]);
  }
  /** DNS-rebinding guard: the Host header must be one we serve. */
  hostOk(req) {
    const h = req.headers.host;
    return typeof h === 'string' && this._hosts().has(h.toLowerCase());
  }
  /** Browsers always send Origin on POST and WebSocket upgrades. Non-browser clients send none (allowed unless STRICT_ORIGIN=1). */
  originOk(req) {
    const o = req.headers.origin;
    if (o === undefined) return !this.config.strictOrigin;
    return this.allowedOrigins().has(o);
  }
}

export function securityHeaders(host) {
  const h = host && /^[A-Za-z0-9.\-:[\]]+$/.test(host) ? host : '127.0.0.1';
  return {
    'Content-Security-Policy': [
      "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", `connect-src 'self' ws://${h}`,
      "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

/** CSV cell: quote when needed and neutralise spreadsheet formula injection from tenant-supplied strings. */
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}


/* ------------------------------------------------------------------ optional shared-token authentication */

export const AUTH_COOKIE = 'finops_auth';
export const MIN_TOKEN_LENGTH = 16;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
export const isLoopbackHost = (host) => LOOPBACK_HOSTS.has(host);

const digest = (v) => createHash('sha256').update(String(v)).digest();
/** Constant-time string comparison (both sides are hashed first, so lengths do not leak and timingSafeEqual always gets equal lengths). */
export const safeEqual = (a, b) => timingSafeEqual(digest(a), digest(b));

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Optional shared-secret authentication (AUTH_TOKEN). With no token the server behaves as before (it then binds to loopback only).
 * A request is authenticated by `Authorization: Bearer <token>` (API clients) or by the session cookie that visiting
 * `/?token=<token>` sets (browsers: EventSource and WebSocket send it too). The cookie holds an HMAC derived from the token, not the
 * token itself, and is HttpOnly + SameSite=Strict, which together with the Origin check on POST covers CSRF.
 */
export class Auth {
  constructor(token = '') {
    this.token = token;
    if (token && token.length < MIN_TOKEN_LENGTH) throw new Error(`AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
    this.enabled = !!token;
    this.cookieValue = this.enabled ? createHmac('sha256', token).update('finops-session-v1').digest('hex') : '';
  }
  tokenOk(candidate) {
    return this.enabled && typeof candidate === 'string' && safeEqual(candidate, this.token);
  }
  ok(req) {
    if (!this.enabled) return true;
    const h = req.headers.authorization;
    if (typeof h === 'string' && /^Bearer /i.test(h) && this.tokenOk(h.slice(7).trim())) return true;
    const c = parseCookies(req.headers.cookie)[AUTH_COOKIE];
    return typeof c === 'string' && safeEqual(c, this.cookieValue);
  }
  cookieHeader({ secure = false } = {}) {
    return `${AUTH_COOKIE}=${this.cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`;
  }
}

/** Refuse to serve a non-loopback address without a token (unless explicitly overridden). Returns a message, or null when fine. */
export function listenGuard({ host, authToken, allowInsecure }) {
  if (isLoopbackHost(host) || authToken || allowInsecure) return null;
  return `refusing to listen on ${host} without AUTH_TOKEN: the dashboard would be open to the network. Set AUTH_TOKEN (>= ${MIN_TOKEN_LENGTH} characters), or ALLOW_INSECURE=1 if something in front of it already authenticates.`;
}

/**
 * The authentication step shared by the single-database server and the multi-database front door.
 * Returns true when it has already answered (the one-time `?token=` redirect that sets the session cookie); throws an
 * HttpError(401) when the request is not authenticated; returns false when the request may proceed.
 */
export function authGate(auth, { cookieSecure = false } = {}, req, res, url) {
  if (!auth.enabled || url.pathname === '/healthz') return false;
  const deny = () => {
    res.setHeader('WWW-Authenticate', 'Bearer realm="finops"');
    return new HttpError(401, 'authentication required: open /?token=<AUTH_TOKEN> once in the browser, or send "Authorization: Bearer <AUTH_TOKEN>"');
  };
  if ((req.method === 'GET' || req.method === 'HEAD') && url.searchParams.has('token')) {
    if (!auth.tokenOk(url.searchParams.get('token'))) throw deny();
    url.searchParams.delete('token'); // never keep the secret in the address bar
    res.writeHead(303, { Location: url.pathname + url.search, 'Set-Cookie': auth.cookieHeader({ secure: cookieSecure }), 'Cache-Control': 'no-store', 'Content-Length': '0' });
    res.end();
    return true;
  }
  if (!auth.ok(req)) throw deny();
  return false;
}
