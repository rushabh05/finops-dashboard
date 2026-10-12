import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseSse, mockSource, mockExplanationText, buildExplainContext, buildPrompt, anthropicSource } from '../src/explain.js';
import { getAlert } from '../src/alerts.js';
import { api, makeApp, SseClient, insertAlert, mkRequest, randomCid, sleep, waitUntil } from './helpers.js';
import { HOUR } from '../src/util.js';

async function collect(it) { let s = ''; for await (const x of it) s += x; return s; }
async function* bytes(str, size = 7) { const b = Buffer.from(str); for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size); }

test('SSE parser: events split across arbitrary chunk boundaries, comments, multi-line data, CRLF', async () => {
  const text = ': ping\n\nevent: a\ndata: {"x":1}\n\nevent: b\r\ndata: line1\r\ndata: line2\r\n\r\ndata: plain\n\n';
  const out = [];
  for await (const ev of parseSse(bytes(text, 3))) out.push(ev);
  assert.deepEqual(out, [{ event: 'a', data: { x: 1 } }, { event: 'b', data: 'line1\nline2' }, { event: 'message', data: 'plain' }]);
  const multibyte = [];
  for await (const ev of parseSse(bytes('event: t\ndata: {"t":"héllo ✓ 日本"}\n\n', 1))) multibyte.push(ev);
  assert.equal(multibyte[0].data.t, 'héllo ✓ 日本');
});

test('mock explainer is deterministic and only uses aggregated context', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const id = insertAlert(app, { kind: 'retry_storm', tenant: 'acme', endpoint: '/v1/classify', observed: 300, baseline: 100 });
  const alert = getAlert(app.db, id);
  const ctx = buildExplainContext(app.db, alert);
  const a = await collect(mockSource(ctx, { tokensPerSec: 5000, startupMs: 0 }));
  const b = await collect(mockSource(buildExplainContext(app.db, alert), { tokensPerSec: 5000, startupMs: 0 }));
  assert.equal(a, b);
  assert.equal(a, mockExplanationText(ctx));
  assert.match(a, /retry/i);
  assert.match(a, /What to check:/);
  // abortable
  const ac = new AbortController();
  const it = mockSource(ctx, { tokensPerSec: 20, startupMs: 0, signal: ac.signal });
  await it.next();
  ac.abort();
  await assert.rejects(async () => { for await (const _ of it) { /* drain */ } }, /abort/);
});

test('mock explainer stress option repeats the text (used by the backpressure lab) and is capped by the API', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const id = insertAlert(app);
  const ctx = buildExplainContext(app.db, getAlert(app.db, id));
  const once = mockExplanationText(ctx);
  const rep = await collect(mockSource(ctx, { tokensPerSec: 5000, startupMs: 0, repeat: 3 }));
  assert.equal(rep.split('[pass ').length - 1, 3);
  assert.ok(rep.length > 3 * once.length);
  assert.equal((await api(app, 'POST', '/api/generate', { body: { cid: 'abcdefgh12', alert_id: id, repeat: 101 } })).status, 400);
  assert.equal((await api(app, 'POST', '/api/generate', { body: { cid: 'abcdefgh12', alert_id: id, repeat: 0 } })).status, 400);
});

test('privacy: the model prompt contains aggregated numbers and entity names only - never request ids or raw rows', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const ts = Math.floor(Date.now() / HOUR) * HOUR + 100;
  await api(app, 'POST', '/api/ingest', { body: { requests: [
    mkRequest({ ts, tenant: 'acme', endpoint: '/v1/chat', id: 'SECRET-REQUEST-ID-12345', calls: [{ model: 'claude-sonnet-5-5', input_tokens: 777_001, output_tokens: 3, cached_tokens: 0 }] }),
    mkRequest({ ts: ts + 1, tenant: 'acme', endpoint: '/v1/chat', id: 'SECRET-REQUEST-ID-67890', calls: [{ model: 'claude-sonnet-5-5', input_tokens: 555_003, output_tokens: 5, cached_tokens: 0 }] }),
  ] } });
  const id = insertAlert(app, { ts, tenant: 'acme', endpoint: '/v1/chat' });
  const ctx = buildExplainContext(app.db, getAlert(app.db, id));
  const prompt = buildPrompt(ctx);
  const all = prompt.system + prompt.user;
  assert.ok(!all.includes('SECRET-REQUEST-ID'));
  assert.ok(!all.includes('777001') && !all.includes('555003'), 'no per-request token counts (only averages over many calls)');
  assert.ok(all.includes('666002'), 'the aggregate is there');
  assert.deepEqual(Object.keys(ctx).sort(), ['alert', 'breakdown_by', 'breakdown_in_alert_hour', 'failed_request_share', 'failed_request_share_prior_day', 'last_12_hours', 'metrics', 'model_mix_in_alert_hour', 'same_hour_previous_3_days_avg', 'top_contributor'].sort());
  assert.match(prompt.user, /acme/);
  assert.match(prompt.user, /Why did this spike, and what should I check\?/);
  assert.ok(prompt.user.length < 6000, `prompt stays small (${prompt.user.length} chars)`);
});

/* ------------------------------------------------------------------ Anthropic source against a local fake of the Messages API */

function fakeAnthropic({ mode = 'ok', words = ['The ', 'spike ', 'comes ', 'from ', 'longer ', 'prompts.'], delay = 5 } = {}) {
  const seen = [];
  let closedEarly = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      if (mode === '401') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.on('close', () => { if (!res.writableEnded) closedEarly = true; });
      const ev = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      if (mode === 'thinking-only' || mode === 'empty') { // a model that spent its whole budget thinking, or ended without text
        ev('message_start', { type: 'message_start', message: { id: 'msg_t', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1 } } });
        if (mode === 'thinking-only') {
          ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
          ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think about this at length...' } });
        }
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: mode === 'thinking-only' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 700 } });
        ev('message_stop', { type: 'message_stop' });
        return res.end();
      }
      ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1 } } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      res.write('event: ping\ndata: {"type": "ping"}\n\n');
      for (const [i, w] of words.entries()) {
        if (res.destroyed) return;
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } });
        if (mode === 'sse-error' && i === 2) { ev('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }); return res.end(); }
        if (mode === 'slow') await new Promise((r) => setTimeout(r, 200)); else await new Promise((r) => setTimeout(r, delay));
      }
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: words.length } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}`, get closedEarly() { return closedEarly; }, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) })));
}

test('Anthropic source: sends the Messages API request we expect and yields the text deltas (fake server)', async () => {
  const fake = await fakeAnthropic();
  try {
    const out = await collect(anthropicSource({ apiKey: 'sk-test', model: 'claude-sonnet-5-5', baseUrl: fake.url, system: 'SYS', user: 'USER' }));
    assert.equal(out, 'The spike comes from longer prompts.');
    const r = fake.seen[0];
    assert.equal(r.method, 'POST');
    assert.equal(r.url, '/v1/messages');
    assert.equal(r.headers['x-api-key'], 'sk-test');
    assert.equal(r.headers['anthropic-version'], '2023-06-01');
    assert.equal(r.headers['content-type'], 'application/json');
    assert.equal(r.body.model, 'claude-sonnet-5-5');
    assert.equal(r.body.stream, true);
    assert.equal(r.body.system, 'SYS');
    assert.deepEqual(r.body.messages, [{ role: 'user', content: 'USER' }]);
    assert.ok(r.body.max_tokens > 0);
    assert.ok(!('temperature' in r.body) && !('top_p' in r.body) && !('budget_tokens' in (r.body.thinking || {})), 'no sampling params / budget_tokens, which newer models reject');
  } finally { await fake.close(); }
});

test('Anthropic source: a response with no text is an error (thinking used the whole budget / empty), never a silent empty explanation', async () => {
  const think = await fakeAnthropic({ mode: 'thinking-only' });
  try {
    await assert.rejects(collect(anthropicSource({ apiKey: 'k', model: 'm', baseUrl: think.url, system: 's', user: 'u', maxTokens: 700 })), /whole token budget \(max_tokens=700\).*ANTHROPIC_MAX_TOKENS/);
  } finally { await think.close(); }
  const empty = await fakeAnthropic({ mode: 'empty' });
  try {
    await assert.rejects(collect(anthropicSource({ apiKey: 'k', model: 'm', baseUrl: empty.url, system: 's', user: 'u' })), /returned no text/);
  } finally { await empty.close(); }
});

test('Anthropic source: max_tokens defaults to a budget that leaves room for thinking, and is configurable', async (t) => {
  const fake = await fakeAnthropic();
  t.after(() => fake.close());
  await collect(anthropicSource({ apiKey: 'k', model: 'm', baseUrl: fake.url, system: 's', user: 'u' }));
  assert.equal(fake.seen[0].body.max_tokens, 1500);
  assert.deepEqual(fake.seen[0].body.output_config, { effort: 'low' });
  await collect(anthropicSource({ apiKey: 'k', model: 'm', baseUrl: fake.url, system: 's', user: 'u', maxTokens: 4000, effort: '' }));
  assert.equal(fake.seen[1].body.max_tokens, 4000);
  assert.ok(!('output_config' in fake.seen[1].body), 'ANTHROPIC_EFFORT= (empty) omits output_config');
  const app = await makeApp({ anthropicKey: 'sk-test', anthropicBaseUrl: fake.url, anthropicMaxTokens: 2222, anthropicEffort: 'medium' });
  t.after(() => app.close());
  const cid = randomCid();
  const c = await new SseClient(app, { cid }).ready;
  await c.waitForEvent('snapshot');
  const alertId = insertAlert(app, { kind: 'cost_spike' });
  assert.equal((await api(app, 'POST', '/api/generate', { body: { cid, alert_id: alertId } })).status, 202);
  await c.waitForEvent('gen_end');
  const sent = fake.seen[fake.seen.length - 1].body;
  assert.deepEqual([sent.max_tokens, sent.output_config], [2222, { effort: 'medium' }], 'the server passes ANTHROPIC_MAX_TOKENS and ANTHROPIC_EFFORT through');
  c.close();
});

test('Anthropic source: HTTP errors and in-stream errors surface as errors (without leaking the key)', async () => {
  const f401 = await fakeAnthropic({ mode: '401' });
  try {
    await assert.rejects(collect(anthropicSource({ apiKey: 'sk-secret-key', model: 'm', baseUrl: f401.url, system: 's', user: 'u' })), (e) => /401/.test(e.message) && !e.message.includes('sk-secret-key'));
  } finally { await f401.close(); }
  const fErr = await fakeAnthropic({ mode: 'sse-error' });
  try {
    let got = '';
    await assert.rejects(async () => { for await (const x of anthropicSource({ apiKey: 'k', model: 'm', baseUrl: fErr.url, system: 's', user: 'u' })) got += x; }, /overloaded_error/);
    assert.equal(got, 'The spike comes ');
  } finally { await fErr.close(); }
});

test('Anthropic source through the dashboard: ANTHROPIC_API_KEY switches /api/generate to the model, tokens stream to the client in order', async (t) => {
  const fake = await fakeAnthropic();
  const app = await makeApp({ anthropicKey: 'sk-test', anthropicBaseUrl: fake.url });
  t.after(async () => { await app.close(); await fake.close(); });
  assert.equal((await api(app, 'GET', '/api/stats')).json.llm.default_source, 'anthropic');
  assert.equal((await api(app, 'GET', '/api/stats')).json.llm.model, 'claude-sonnet-5-5', 'default model');
  const cid = randomCid();
  const alertId = insertAlert(app, { kind: 'tokens_per_request', tenant: null, endpoint: '/v1/chat' });
  const c = await new SseClient(app, { cid }).ready;
  await c.waitForEvent('snapshot');
  const g = await api(app, 'POST', '/api/generate', { body: { cid, alert_id: alertId } }); // source "auto" -> anthropic
  assert.equal(g.status, 202);
  assert.equal(g.json.source, 'anthropic');
  await c.waitForEvent('gen_end');
  assert.equal(c.of('token').map((e) => e.data.t).join(''), 'The spike comes from longer prompts.');
  assert.equal(c.of('gen_start')[0].data.model, 'claude-sonnet-5-5');
  assert.equal(c.of('gen_end')[0].data.reason, 'done');
  const body = fake.seen[0].body;
  const prompt = body.messages[0].content;
  assert.match(prompt, /"endpoint": "\/v1\/chat"/);
  assert.ok(!/request_id|"id":/.test(prompt), 'only aggregates are sent');
  c.close();
});

test('Anthropic source: an upstream failure ends the generation cleanly with an error the UI can show', async (t) => {
  const fake = await fakeAnthropic({ mode: '401' });
  const app = await makeApp({ anthropicKey: 'sk-bad', anthropicBaseUrl: fake.url });
  t.after(async () => { await app.close(); await fake.close(); });
  const cid = randomCid();
  const alertId = insertAlert(app);
  const c = await new SseClient(app, { cid }).ready;
  await c.waitForEvent('snapshot');
  await api(app, 'POST', '/api/generate', { body: { cid, alert_id: alertId } });
  const end = await c.waitForEvent('gen_end');
  assert.equal(end.data.reason, 'error');
  assert.match(end.data.error, /401/);
  assert.ok(!JSON.stringify(c.events).includes('sk-bad'));
  c.close();
});

test('cancelling an Anthropic generation aborts the upstream request', async (t) => {
  const fake = await fakeAnthropic({ mode: 'slow' });
  const app = await makeApp({ anthropicKey: 'sk-test', anthropicBaseUrl: fake.url });
  t.after(async () => { await app.close(); await fake.close(); });
  const cid = randomCid();
  const alertId = insertAlert(app);
  const c = await new SseClient(app, { cid }).ready;
  await c.waitForEvent('snapshot');
  await api(app, 'POST', '/api/generate', { body: { cid, alert_id: alertId } });
  await c.waitForEvent('token');
  await api(app, 'POST', '/api/cancel', { body: { cid } });
  assert.equal((await c.waitForEvent('gen_end')).data.reason, 'cancelled');
  await waitUntil(() => fake.closedEarly, { what: 'the upstream connection to be closed' });
  c.close();
});
