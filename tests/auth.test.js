import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeApp, api, mkRequest, SseClient, WsClient, randomCid } from './helpers.js';
import { Auth, listenGuard, parseCookies, safeEqual, isLoopbackHost, AUTH_COOKIE, MIN_TOKEN_LENGTH } from '../src/security.js';
import { createApp } from '../src/server.js';
import { HOUR } from '../src/util.js';

const TOKEN = 'correct-horse-battery-staple-42';
let app;
before(async () => { app = await makeApp({ authToken: TOKEN, seedDays: 2, volumeScale: 0.2 }); });
after(() => app.close());

/** Raw request without redirect-following, so Set-Cookie / Location can be inspected. */
const raw = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: app.port, path, method, headers }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { text += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});
const bearer = { Authorization: `Bearer ${TOKEN}` };

test('without credentials: everything is refused with 401 and a WWW-Authenticate challenge, except /healthz', async () => {
  for (const [method, path, body] of [['GET', '/api/summary'], ['GET', '/'], ['GET', '/app.js'], ['GET', '/api/stats'], ['GET', '/api/export.csv?view=tenant'], ['POST', '/api/ingest', { requests: [] }], ['POST', '/api/sim', { rate: 5 }]]) {
    const r = await api(app, method, path, { body });
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.match(r.headers.get('www-authenticate'), /^Bearer/);
    assert.match(r.json.error, /authentication required/);
  }
  assert.equal((await api(app, 'GET', '/healthz')).status, 200, 'liveness stays open');
  const sse = await new SseClient(app, { cid: randomCid() }).ready;
  assert.equal(sse.status, 401);
  sse.req.destroy();
  const ws = await WsClient.connect(app, { cid: randomCid() });
  assert.equal(ws.status, 401, 'WebSocket upgrade refused');
  ws.close();
});

test('Authorization: Bearer works for API clients; a wrong or malformed token does not', async () => {
  assert.equal((await api(app, 'GET', '/api/summary?range=24h', { headers: bearer })).status, 200);
  for (const h of ['Bearer wrong-token-wrong-token', `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, 'Bearer ', TOKEN, `Basic ${TOKEN}`]) {
    assert.equal((await api(app, 'GET', '/api/summary', { headers: { Authorization: h } })).status, 401, h);
  }
  const ts = Math.floor(Date.now() / HOUR) * HOUR + 11;
  const ok = await api(app, 'POST', '/api/ingest', { headers: bearer, body: { requests: [mkRequest({ ts, id: 'auth-ing-1' })] } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.accepted, 1);
});

test('browser flow: /?token= sets an HttpOnly SameSite=Strict cookie, redirects without the secret, and the cookie then works everywhere', async () => {
  const r = await raw(`/?token=${TOKEN}`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/', 'the token is removed from the address bar');
  const cookie = r.headers['set-cookie'][0];
  assert.match(cookie, new RegExp(`^${AUTH_COOKIE}=[0-9a-f]{64};`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.doesNotMatch(cookie, /Secure/, 'only with COOKIE_SECURE=1');
  assert.ok(!cookie.includes(TOKEN), 'the cookie holds a derived value, never the token itself');
  const jar = { Cookie: cookie.split(';')[0] };

  assert.equal((await raw('/api/summary?range=24h', { headers: jar })).status, 200);
  const page = await raw('/', { headers: jar });
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>FinOps Dashboard<\/title>/);
  const sse = await new SseClient(app, { cid: randomCid(), headers: jar }).ready;
  assert.equal(sse.status, 200);
  await sse.waitForEvent('snapshot');
  sse.close();
  const ws = await WsClient.connect(app, { cid: randomCid(), headers: jar });
  assert.equal(ws.status, 101);
  assert.ok(ws.acceptOk);
  ws.close();

  // other query parameters survive the redirect
  const r2 = await raw(`/api/summary?range=7d&token=${TOKEN}`);
  assert.equal(r2.status, 303);
  assert.equal(r2.headers.location, '/api/summary?range=7d');
});

test('a wrong ?token= is refused without a cookie; a cookie carrying the raw token is not accepted', async () => {
  const bad = await raw('/?token=nope-nope-nope-nope-nope');
  assert.equal(bad.status, 401);
  assert.equal(bad.headers['set-cookie'], undefined);
  assert.equal((await raw('/api/summary', { headers: { Cookie: `${AUTH_COOKIE}=${TOKEN}` } })).status, 401);
  assert.equal((await raw('/api/summary', { headers: { Cookie: `${AUTH_COOKIE}=` } })).status, 401);
  assert.equal((await raw('/api/summary', { headers: { Cookie: 'other=1' } })).status, 401);
});

test('Bearer also authenticates the WebSocket upgrade; Origin and Host checks still apply to authenticated clients', async () => {
  const ws = await WsClient.connect(app, { cid: randomCid(), headers: bearer });
  assert.equal(ws.status, 101);
  ws.close();
  const evil = await WsClient.connect(app, { cid: randomCid(), headers: bearer, origin: 'http://evil.example' });
  assert.equal(evil.status, 403);
  evil.close();
  const post = await api(app, 'POST', '/api/ingest', { headers: { ...bearer, Origin: 'http://evil.example' }, body: { requests: [] } });
  assert.equal(post.status, 403);
  const host = await raw('/api/summary', { headers: { ...bearer, Host: 'evil.example' } });
  assert.equal(host.status, 403);
});

test('COOKIE_SECURE adds the Secure flag', async () => {
  const secure = await makeApp({ authToken: TOKEN, cookieSecure: true, seedDays: 0 });
  try {
    const r = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: secure.port, path: `/?token=${TOKEN}` }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject));
    assert.match(r.headers['set-cookie'][0], /; Secure/);
  } finally { await secure.close(); }
});

test('token rules: at least 16 characters, validated before anything is opened; constant-time compare; cookie parsing', () => {
  assert.throws(() => new Auth('short'), new RegExp(`at least ${MIN_TOKEN_LENGTH}`));
  assert.equal(new Auth('').enabled, false);
  assert.equal(new Auth('').ok({ headers: {} }), true, 'no token configured: open (and loopback-only)');
  assert.equal(new Auth(TOKEN).enabled, true);
  assert.equal(new Auth(TOKEN).cookieValue, new Auth(TOKEN).cookieValue, 'stable across restarts: sessions survive');
  assert.notEqual(new Auth(TOKEN).cookieValue, new Auth(TOKEN + 'x').cookieValue);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false, 'different lengths are fine');
  assert.deepEqual(parseCookies('a=1; finops_auth=xyz; b=2=3'), { a: '1', finops_auth: 'xyz', b: '2=3' });
  assert.deepEqual(parseCookies(undefined), {});
  return assert.rejects(createApp({ dbPath: ':memory:', authToken: 'too-short', port: 0, seedDays: 0 }), /at least 16/);
});

test('listen guard: a non-loopback address needs AUTH_TOKEN (or an explicit override)', async () => {
  assert.ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('::1') && isLoopbackHost('localhost') && !isLoopbackHost('0.0.0.0') && !isLoopbackHost('192.168.1.5'));
  assert.match(listenGuard({ host: '0.0.0.0', authToken: '', allowInsecure: false }), /refusing to listen on 0\.0\.0\.0 without AUTH_TOKEN/);
  assert.equal(listenGuard({ host: '0.0.0.0', authToken: TOKEN, allowInsecure: false }), null);
  assert.equal(listenGuard({ host: '0.0.0.0', authToken: '', allowInsecure: true }), null);
  assert.equal(listenGuard({ host: '127.0.0.1', authToken: '', allowInsecure: false }), null);
  // and the server really does refuse (it never binds)
  const exposed = await createApp({ dbPath: ':memory:', host: '0.0.0.0', port: 0, seedDays: 0, simAutoStart: false });
  try {
    await assert.rejects(exposed.listen(), /refusing to listen on 0\.0\.0\.0/);
    assert.equal(exposed.server.listening, false);
  } finally { await exposed.close(); }
});
