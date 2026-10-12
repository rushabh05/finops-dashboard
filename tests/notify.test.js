import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Notifier, buildPayload, describeAlert, parseWebhookUrl } from '../src/notify.js';
import { createApp } from '../src/server.js';
import { api, makeApp, sleep, waitUntil } from './helpers.js';

/*
 * Alert notifications. The webhook is a local HTTP server; every behaviour that matters is checked against what it actually receives:
 * the URL rules, the three payload formats, one retry, no redirects, a bounded queue, and - the one that protects people - alerts from
 * simulated data never reach a real channel.
 */
const SECRET = 'T0PS3CR3T-webhook-token';

async function webhookServer(handler) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    received.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (handler) handler(req, res, received.length); else { res.writeHead(200); res.end('ok'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    received,
    url: `http://127.0.0.1:${server.address().port}/hook/${SECRET}`,
    json: () => received.map((r) => JSON.parse(r.body)),
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}

const alert = (o = {}) => ({ id: 7, kind: 'cost_spike', tenant_id: 'globex', endpoint: null, observed: 6_540_000, baseline: 1_420_000, score: 17.3, hour: 1791820800000, explanation: 'Tenant globex spent $6.54 in the hour vs a typical $1.42.', ...o });
const fast = { retryDelayMs: 10, timeoutMs: 1500 };

test('parseWebhookUrl: https only (plain http just for this machine), the format follows the host, errors never contain the URL', () => {
  assert.equal(parseWebhookUrl(`https://hooks.slack.com/services/T/B/${SECRET}`).format, 'slack');
  assert.equal(parseWebhookUrl(`https://discord.com/api/webhooks/1/${SECRET}`).format, 'discord');
  assert.equal(parseWebhookUrl(`https://discordapp.com/api/webhooks/1/${SECRET}`).format, 'discord');
  assert.equal(parseWebhookUrl(`https://discord.com/other/${SECRET}`).format, 'json', 'a discord host without the webhook path is not assumed to be one');
  assert.equal(parseWebhookUrl(`https://example.org/hook/${SECRET}`).format, 'json');
  assert.equal(parseWebhookUrl(`https://hooks.slack.com/x/${SECRET}`, 'json').format, 'json', 'an explicit format wins');
  assert.equal(parseWebhookUrl(`http://127.0.0.1:9/hook/${SECRET}`).host, '127.0.0.1');
  assert.equal(parseWebhookUrl(`http://localhost:9/${SECRET}`).format, 'json');

  for (const bad of [`http://example.org/hook/${SECRET}`, `ftp://example.org/${SECRET}`, `not a url ${SECRET}`, `javascript:alert('${SECRET}')`]) {
    assert.throws(() => parseWebhookUrl(bad), (e) => /ALERT_WEBHOOK_URL/.test(e.message) && !e.message.includes(SECRET), bad);
  }
  assert.throws(() => parseWebhookUrl('https://example.org/x', 'xml'), /ALERT_WEBHOOK_FORMAT/);
});

test('payloads: Slack and Discord get their own shape, anything else gets structured JSON; the text reads like the dashboard', () => {
  const a = alert();
  const slack = buildPayload('slack', a, 'claude-code');
  assert.deepEqual(Object.keys(slack), ['text']);
  assert.match(slack.text, /\*CRITICAL: Cost spike, tenant globex · all endpoints\*/);
  assert.match(slack.text, /\$6\.54 vs typical \$1\.42 \(4\.6x\)/);
  assert.match(slack.text, /Tenant globex spent/);
  assert.match(slack.text, /source: claude-code/);

  const discord = buildPayload('discord', a, 'claude-code');
  assert.deepEqual(Object.keys(discord), ['content']);
  assert.match(discord.content, /\*\*CRITICAL: Cost spike/);
  assert.ok(buildPayload('discord', alert({ explanation: 'x'.repeat(5000) }), 's').content.length <= 2000, 'discord rejects messages over 2000 characters');

  const json = buildPayload('json', a, 'claude-code');
  assert.equal(json.event, 'finops.alert');
  assert.deepEqual(json.alert, { id: 7, kind: 'cost_spike', severity: 'critical', tenant: 'globex', endpoint: null, observed: 6_540_000, baseline: 1_420_000, score: 17.3, hour: 1791820800000, explanation: a.explanation });
  assert.match(json.text, /CRITICAL: Cost spike/);

  // each kind states its numbers in its own unit
  assert.match(describeAlert(alert({ kind: 'tokens_per_request', observed: 4200, baseline: 1000, score: 9, tenant_id: null, endpoint: '/v1/chat' }), 's').figures, /4,200 vs typical 1,000 tokens per request \(4\.2x\)/);
  assert.match(describeAlert(alert({ kind: 'retry_storm', observed: 310, baseline: 114, score: 11.5, tenant_id: null, endpoint: '/v1/classify' }), 's').figures, /310 vs typical 114 requests/);
  assert.equal(describeAlert(alert({ kind: 'volume_spike', baseline: 0, observed: 50 }), 's').figures, '50 vs typical 0 requests (new)');
  assert.match(describeAlert(alert({ tenant_id: null, endpoint: null }), 's').title, /all tenants · all endpoints/);
});

test('delivery: POSTs JSON in order, one message at a time; notify() returns before anything is sent', async () => {
  const hook = await webhookServer();
  try {
    const n = new Notifier({ url: hook.url, format: 'json', source: 'live', ...fast });
    n.notify([alert({ id: 1 }), alert({ id: 2 }), alert({ id: 3 })]);
    assert.equal(hook.received.length, 0, 'notify() only queues');
    await n.idle();
    assert.deepEqual(hook.json().map((m) => m.alert.id), [1, 2, 3]);
    assert.equal(hook.received[0].method, 'POST');
    assert.equal(hook.received[0].headers['content-type'], 'application/json');
    assert.equal(hook.received[0].url, `/hook/${SECRET}`);
    assert.deepEqual(n.stats, { sent: 3, failed: 0, dropped: 0 });
  } finally { await hook.close(); }
});

test('delivery: one retry after a 5xx; no retry for a 4xx; failures are logged by host (never the secret URL) and counted, not thrown', async () => {
  const logs = [];
  let calls = 0;
  const flaky = await webhookServer((req, res) => { calls++; res.writeHead(calls === 1 ? 503 : 200); res.end(); });
  const refusing = await webhookServer((req, res) => { res.writeHead(403); res.end('invalid_token'); });
  try {
    const a = new Notifier({ url: flaky.url, format: 'json', log: (m) => logs.push(m), ...fast });
    a.notify([alert()]);
    await a.idle();
    assert.equal(flaky.received.length, 2, 'retried once');
    assert.deepEqual(a.stats, { sent: 1, failed: 0, dropped: 0 });

    const b = new Notifier({ url: refusing.url, format: 'json', log: (m) => logs.push(m), ...fast });
    b.notify([alert()]);
    await b.idle();
    assert.equal(refusing.received.length, 1, 'a 403 will not get better: no retry');
    assert.deepEqual(b.stats, { sent: 0, failed: 1, dropped: 0 });
    assert.equal(logs.length, 1);
    assert.match(logs[0], /127\.0\.0\.1.*HTTP 403/);
    assert.ok(!logs.join('\n').includes(SECRET), 'the webhook URL is a secret');
  } finally { await flaky.close(); await refusing.close(); }
});

test('delivery: a redirect is not followed (the alert must not go somewhere nobody configured)', async () => {
  const elsewhere = await webhookServer();
  const redirecting = await webhookServer((req, res) => { res.writeHead(302, { Location: `${elsewhere.url}` }); res.end(); });
  try {
    const n = new Notifier({ url: redirecting.url, format: 'json', log: () => {}, ...fast });
    n.notify([alert()]);
    await n.idle();
    assert.equal(redirecting.received.length, 1);
    assert.equal(elsewhere.received.length, 0);
    assert.deepEqual(n.stats, { sent: 0, failed: 1, dropped: 0 });
    assert.match((await n.deliver({ text: 'x' })).error, /redirects are not followed/);
  } finally { await redirecting.close(); await elsewhere.close(); }
});

test('delivery: a server that never answers times out; a closed port fails fast; neither throws or leaks the URL', async () => {
  const silent = await webhookServer(() => { /* never respond */ });
  const closedPort = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  try {
    const slow = new Notifier({ url: silent.url, format: 'json', retryDelayMs: 5, timeoutMs: 150 });
    const t0 = Date.now();
    const r1 = await slow.deliver({ text: 'x' });
    assert.equal(r1.ok, false);
    assert.match(r1.error, /no answer within 150 ms/);
    assert.ok(Date.now() - t0 < 2000);

    const dead = new Notifier({ url: `http://127.0.0.1:${closedPort}/hook/${SECRET}`, format: 'json', ...fast });
    const r2 = await dead.deliver({ text: 'x' });
    assert.equal(r2.ok, false);
    assert.ok(r2.error && !r2.error.includes(SECRET), r2.error);
  } finally { await silent.close(); }
});

test('a flood cannot grow the queue without bound: the oldest are dropped and ONE summary message says how many', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const hook = await webhookServer(async (req, res) => { if (hook.received.length === 1) await gate; res.writeHead(200); res.end(); });
  try {
    const n = new Notifier({ url: hook.url, format: 'json', maxQueue: 3, ...fast });
    n.notify([alert({ id: 1 })]);                 // in flight, held open by the gate
    await waitUntil(() => hook.received.length === 1, { what: 'the first message to arrive' });
    n.notify(Array.from({ length: 8 }, (_, i) => alert({ id: 100 + i })));  // 8 arrive while it is busy: only the newest 3 fit
    release();
    await n.idle();
    const msgs = hook.json();
    assert.deepEqual(msgs.filter((m) => m.alert).map((m) => m.alert.id), [1, 105, 106, 107]);
    const notice = msgs.find((m) => m.event === 'finops.notice');
    assert.match(notice.text, /5 more alerts were not sent/);
    assert.equal(msgs.filter((m) => m.event === 'finops.notice').length, 1);
    assert.equal(n.stats.dropped, 5);
  } finally { await hook.close(); }
});

test('sendTest: a labelled message in the right shape for the format', async () => {
  const hook = await webhookServer();
  try {
    assert.equal((await new Notifier({ url: hook.url, format: 'slack', source: 'check', ...fast }).sendTest()).ok, true);
    assert.equal((await new Notifier({ url: hook.url, format: 'discord', source: 'check', ...fast }).sendTest()).ok, true);
    assert.equal((await new Notifier({ url: hook.url, format: 'json', source: 'check', ...fast }).sendTest()).ok, true);
    const [s, d, j] = hook.json();
    assert.match(s.text, /Test message from the FinOps dashboard/);
    assert.match(d.content, /Test message from the FinOps dashboard/);
    assert.equal(j.event, 'finops.test');
  } finally { await hook.close(); }
});

test('wiring: a live (not simulated) database posts each NEW alert from the detector, and /api/stats says so without exposing the URL', async (t) => {
  const hook = await webhookServer();
  t.after(() => hook.close());
  const app = await makeApp({ alertWebhookUrl: hook.url, alertWebhookFormat: 'json' });
  t.after(() => app.close());
  const fake = { id: 41, ts: Date.now(), kind: 'retry_storm', tenant_id: null, endpoint: '/v1/classify', observed: 310, baseline: 114, score: 11.5, hour: 0, explanation: 'Endpoint /v1/classify sent 310 requests vs a typical 114.' };
  app.detector.run = () => ({ hour: 0, evaluated: 1, inserted: [fake], suppressed: 0 });
  app.runDetector();
  await waitUntil(() => hook.received.length === 1, { what: 'the alert to reach the webhook' });
  const m = hook.json()[0];
  assert.equal(m.alert.kind, 'retry_storm');
  assert.equal(m.alert.endpoint, '/v1/classify');
  assert.equal(m.source, ':memory:');

  app.detector.run = () => ({ hour: 0, evaluated: 1, inserted: [], suppressed: 1 }); // a cooldown-suppressed repeat inserts nothing
  app.runDetector();
  await sleep(100);
  assert.equal(hook.received.length, 1, 'only new alerts are posted');

  const stats = (await api(app, 'GET', '/api/stats')).json.webhook;
  assert.equal(stats.enabled, true);
  assert.equal(stats.host, '127.0.0.1');
  assert.equal(stats.sent, 1);
  assert.ok(!JSON.stringify(stats).includes(SECRET), 'the secret path is never exposed');
});

test('wiring: simulated data never notifies - set up to simulate, or simulated later through /api/sim - unless ALERT_WEBHOOK_SIMULATED=1', async (t) => {
  const hook = await webhookServer();
  t.after(() => hook.close());
  const fake = { id: 1, ts: Date.now(), kind: 'cost_spike', tenant_id: 'acme', endpoint: null, observed: 5_000_000, baseline: 1_000_000, score: 12, hour: 0, explanation: 'fake' };
  const stub = (app) => { app.detector.run = () => ({ hour: 0, evaluated: 1, inserted: [fake], suppressed: 0 }); };

  const configured = await makeApp({ alertWebhookUrl: hook.url, alertWebhookFormat: 'json', simAutoStart: true });
  t.after(() => configured.close());
  stub(configured);
  configured.runDetector();

  const later = await makeApp({ alertWebhookUrl: hook.url, alertWebhookFormat: 'json' }); // not simulated at first...
  t.after(() => later.close());
  assert.equal((await api(later, 'POST', '/api/sim', { body: { rate: 200, running: true } })).status, 200);
  await waitUntil(() => later.sim.status().written > 0, { what: 'the simulator to write' });
  await api(later, 'POST', '/api/sim', { body: { running: false } });
  stub(later);
  later.runDetector(); // ...but the simulator has now written to this database

  await sleep(250);
  assert.equal(hook.received.length, 0, 'fake anomalies stay out of a real channel');
  assert.equal((await api(configured, 'GET', '/api/stats')).json.webhook.enabled, false);
  assert.match((await api(configured, 'GET', '/api/stats')).json.webhook.reason, /simulated/);

  const optIn = await makeApp({ alertWebhookUrl: hook.url, alertWebhookFormat: 'json', simAutoStart: true, alertWebhookSimulated: true });
  t.after(() => optIn.close());
  stub(optIn);
  optIn.runDetector();
  await waitUntil(() => hook.received.length === 1, { what: 'the opted-in simulated alert' });
});

test('wiring: a bad ALERT_WEBHOOK_URL stops startup with a clear message that does not echo it', async () => {
  await assert.rejects(createApp({ dbPath: ':memory:', port: 0, seedDays: 0, simAutoStart: false, alertWebhookUrl: `http://example.org/hook/${SECRET}` }), (e) => /ALERT_WEBHOOK_URL must be https/.test(e.message) && !e.message.includes(SECRET));
});

test('end to end: the real detector, on the simulator\'s injected prompt bloat, posts a tokens_per_request alert (opted in)', async (t) => {
  const hook = await webhookServer();
  t.after(() => hook.close());
  const app = await makeApp({ seedDays: 9, volumeScale: 1, detectEveryMs: 50, simAnomalies: false, alertWebhookUrl: hook.url, alertWebhookFormat: 'json', alertWebhookSimulated: true });
  t.after(() => app.close());
  assert.equal((await api(app, 'POST', '/api/sim', { body: { rate: 300, running: true } })).status, 200);
  assert.equal((await api(app, 'POST', '/api/sim', { body: { inject: 'token_bloat', hours: 12 } })).status, 200);
  const diagnose = () => `sim: ${JSON.stringify(app.sim.status())}; alerts: ${JSON.stringify(app.db.prepare('SELECT id, kind, tenant_id, endpoint FROM alerts').all())}; received: ${hook.received.length}`;
  // the injected bloat can first trip a tenant-level alert (endpoint null); wait for the endpoint-level one, as the e2e suite does
  const bloat = await waitUntil(() => hook.json().find((m) => m.alert?.kind === 'tokens_per_request' && m.alert.endpoint === '/v1/chat'), { timeout: 40000, what: `a tokens_per_request alert for /v1/chat at the webhook (${diagnose()})` });
  assert.equal(bloat.alert.tenant, null);
  assert.ok(['medium', 'high', 'critical'].includes(bloat.alert.severity));
  assert.match(bloat.text, /Tokens per request jump/);
  await api(app, 'POST', '/api/sim', { body: { running: false } });
});
