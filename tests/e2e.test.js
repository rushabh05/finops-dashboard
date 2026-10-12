import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { buildExplainContext, mockExplanationText } from '../src/explain.js';
import { getAlert } from '../src/alerts.js';
import { HOUR } from '../src/util.js';
import { Rng } from '../src/sim.js';
import { encodeClose } from '../src/ws.js';
import { api, makeApp, SseClient, WsClient, Mirror, assertConverged, insertAlert, mkRequest, randomCid, sleep, waitUntil, dbTruth } from './helpers.js';

const nowHour = () => Math.floor(Date.now() / HOUR) * HOUR;
const tenants = ['acme', 'globex', 'initech', 'umbrella', 'hooli', 'stark', 'wayne', 'wonka'];
const endpoints = ['/v1/chat', '/v1/summarize', '/v1/classify', '/v1/tag', '/v1/extract', '/v1/moderate'];

/** Ingest `n` random requests in the current hour through the real HTTP endpoint. */
async function ingestBurst(app, rng, n = 20) {
  const ts = nowHour() + rng.int(HOUR - 1);
  const requests = Array.from({ length: n }, () => mkRequest({
    ts, tenant: tenants[rng.int(tenants.length)], endpoint: endpoints[rng.int(endpoints.length)],
    calls: [{ model: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'][rng.int(3)], input_tokens: 200 + rng.int(2000), output_tokens: 20 + rng.int(300), cached_tokens: 0 }],
  }));
  const r = await api(app, 'POST', '/api/ingest', { body: { requests } });
  assert.equal(r.status, 200, r.text);
}

/** The server has written everything up to the log head, and `client` (if given) has actually received it. */
const caughtUp = (app, cid, client) => () => {
  const ch = app.hub.get(cid);
  app.feed.poll();
  const server = ch && ch.sentId === app.changeLog.head() && ch.pending.size === 0 && !ch.needSnapshot && ch.transport.buffered === 0;
  return server && (!client || client.lastId === ch.sentId);
};

for (const kind of ['sse', 'ws']) {
  test(`${kind.toUpperCase()} end-to-end: LLM tokens arrive complete and in order while cost frames interleave; client converges to the DB`, async (t) => {
    const app = await makeApp({ liveWindowHours: 3 });
    t.after(() => app.close());
    const cid = randomCid();
    const alertId = insertAlert(app);
    const client = kind === 'sse' ? await new SseClient(app, { cid }).ready : await WsClient.connect(app, { cid });
    assert.ok(kind === 'sse' ? client.status === 200 : client.status === 101 && client.acceptOk);
    await client.waitForEvent('hello');
    assert.equal(client.of('hello')[0].data.transport, kind);
    await client.waitForEvent('snapshot');

    const expected = mockExplanationText(buildExplainContext(app.db, getAlert(app.db, alertId))); // the context is fixed at the moment of the request
    const gen = await api(app, 'POST', '/api/generate', { body: { cid, alert_id: alertId, source: 'mock', tokens_per_sec: 300 } });
    assert.equal(gen.status, 202, gen.text);
    assert.equal(gen.json.source, 'mock');
    const rng = new Rng(3);
    // cost updates keep flowing while the explanation streams
    for (let i = 0; i < 40 && !client.of('gen_end').length; i++) { await ingestBurst(app, rng, 15); await sleep(25); }
    await client.waitForEvent('gen_end', () => true, { timeout: 15000 });

    const toks = client.of('token').filter((e) => e.data.gen === gen.json.gen);
    assert.ok(toks.length > 5);
    assert.equal(toks.map((e) => e.data.t).join(''), expected, 'the full text, nothing lost, nothing reordered');
    let off = 0;
    for (const e of toks) { assert.equal(e.data.o, off); off += e.data.t.length; }
    const end = client.of('gen_end')[0].data;
    assert.deepEqual([end.reason, end.total, end.gen], ['done', expected.length, gen.json.gen]);
    assert.ok(Number.isFinite(toks[0].data.ttft_ms) && toks[0].data.ttft_ms >= 100, 'first token reports time-to-first-token');
    assert.equal(client.events.findIndex((e) => e.event === 'gen_start') < client.events.findIndex((e) => e.event === 'token'), true);

    const firstTok = client.events.findIndex((e) => e.event === 'token');
    const lastTok = client.events.findLastIndex((e) => e.event === 'token');
    const between = client.events.slice(firstTok, lastTok).filter((e) => e.event === 'rows');
    assert.ok(between.length >= 2, `cost frames interleaved with the token stream (saw ${between.length})`);

    await waitUntil(caughtUp(app, cid, client), { what: 'client to catch up' });
    const mirror = new Mirror().applyAll(client.events);
    assertConverged(assert, mirror, app);
    client.close();
  });
}

test('SSE Last-Event-ID resume: only what was missed is replayed, with ids that continue from the cursor', async (t) => {
  const app = await makeApp({ liveWindowHours: 3 });
  t.after(() => app.close());
  const rng = new Rng(9);
  const cid = randomCid();
  const c1 = await new SseClient(app, { cid }).ready;
  await c1.waitForEvent('snapshot');
  for (let i = 0; i < 5; i++) await ingestBurst(app, rng, 10);
  await waitUntil(caughtUp(app, cid, c1), { what: 'c1 caught up' });
  const cursor = c1.lastId;
  assert.equal(cursor, app.changeLog.head(), 'the id on the last frame is the newest seq fully delivered');
  c1.close();
  await waitUntil(() => !app.hub.get(cid), { what: 'server to notice the disconnect' });

  // changes while the client is away
  for (let i = 0; i < 4; i++) await ingestBurst(app, rng, 10);
  app.feed.poll();
  const missed = new Set(app.db.prepare('SELECT "table" AS t, row_id FROM changes WHERE seq > ?').all(cursor).map((r) => `${r.t === 'rollups_hourly' ? 'r' : 'a'}:${r.row_id}`));
  assert.ok(missed.size > 3);

  const c2 = await new SseClient(app, { cid, lastEventId: cursor }).ready; // browsers send this header automatically on reconnect
  const hello = await c2.waitForEvent('hello');
  assert.equal(hello.data.resumed, true);
  await waitUntil(caughtUp(app, cid, c2), { what: 'c2 caught up' });
  assert.equal(c2.of('snapshot').length, 0, 'resume replays the gap, it does not resend the world');
  const replayed = new Set(c2.of('rows').flatMap((e) => e.data.rows.map((r) => r.k)));
  for (const k of replayed) assert.ok(missed.has(k), `${k} was not part of the gap`);
  for (const k of missed) assert.ok(replayed.has(k), `${k} was missed and must be replayed`);
  assert.ok(c2.of('rows')[0].id > cursor);

  const mirror = new Mirror();
  // c1 only ever saw frames up to the cursor
  mirror.applyAll(c1.events).applyAll(c2.events);
  assertConverged(assert, mirror, app);
  c2.close();
});

test('SSE resume falls back to a snapshot when the log was pruned, or the id is from another life', async (t) => {
  const app = await makeApp({ liveWindowHours: 3 });
  t.after(() => app.close());
  const rng = new Rng(4);
  await ingestBurst(app, rng, 10);
  app.feed.poll();
  const old = app.changeLog.head();
  await ingestBurst(app, rng, 10);
  app.changeLog.prune(0); // everything so far is gone from the log

  const a = await new SseClient(app, { cid: randomCid(), lastEventId: old }).ready;
  assert.equal((await a.waitForEvent('hello')).data.resumed, false);
  await a.waitForEvent('snapshot');
  assertConverged(assert, new Mirror().applyAll(a.events), app);

  const b = await new SseClient(app, { cid: randomCid(), lastEventId: app.changeLog.head() + 1000 }).ready; // newer than anything we have
  assert.equal((await b.waitForEvent('hello')).data.resumed, false);
  await b.waitForEvent('snapshot');

  const bad = await new SseClient(app, { cid: randomCid(), headers: { 'Last-Event-ID': 'not-a-number' } }).ready;
  assert.equal(bad.status, 400);
  a.close(); b.close(); bad.close();
});

test('WebSocket resume via ?lastEventId=', async (t) => {
  const app = await makeApp({ liveWindowHours: 3 });
  t.after(() => app.close());
  const rng = new Rng(2);
  const cid = randomCid();
  const w1 = await WsClient.connect(app, { cid });
  await w1.waitForEvent('snapshot');
  await ingestBurst(app, rng, 12);
  await waitUntil(caughtUp(app, cid, w1), { what: 'ws caught up' });
  const cursor = w1.lastId;
  w1.close();
  await waitUntil(() => !app.hub.get(cid));
  await ingestBurst(app, rng, 12);
  const w2 = await WsClient.connect(app, { cid, lastEventId: cursor });
  assert.equal((await w2.waitForEvent('hello')).data.resumed, true);
  await waitUntil(caughtUp(app, cid, w2));
  assert.equal(w2.of('snapshot').length, 0);
  assertConverged(assert, new Mirror().applyAll(w1.events).applyAll(w2.events), app);
  w2.close();
});

test('slow link: queues stay bounded, the model is paused, and the client still converges to the true DB state', async (t) => {
  const maxPending = 40, highWater = 4096, bufferLimit = 16 * 1024;
  const app = await makeApp({ liveWindowHours: 2, channel: { maxPending, highWater, lowWater: 1024, bufferLimit, drainMark: 4096, maxRowsPerFrame: 25 } });
  t.after(() => app.close());
  const cid = randomCid();
  const client = await new SseClient(app, { cid }).ready;
  await client.waitForEvent('snapshot');
  const snapBytes = Buffer.byteLength(JSON.stringify(app.feed.snapshot().data));

  assert.equal((await api(app, 'POST', '/api/throttle', { body: { cid, bytes_per_sec: 120_000 } })).status, 200);
  const ch = app.hub.get(cid);
  // a long explanation (about 300 KB) from a source that is far faster than the link, plus a heavy write load
  const parts = Array.from({ length: 3000 }, (_, i) => `[${String(i).padStart(4, '0')}]${'x'.repeat(92)}`);
  let produced = 0;
  async function* fast() { for (const p of parts) { produced++; yield p; } }
  ch.startGeneration({ id: 'big', source: fast(), meta: { alert_id: 0, source: 'test' } });

  const rng = new Rng(21);
  const samples = [];
  let stop = false;
  const sampler = (async () => { while (!stop) { samples.push(ch.depth()); await sleep(15); } })();
  const t0 = Date.now();
  while (Date.now() - t0 < 1800) { await ingestBurst(app, rng, 60); await sleep(20); }
  stop = true;
  await sampler;

  const maxQ = Math.max(...samples.map((s) => s.token_queue_bytes));
  const maxRows = Math.max(...samples.map((s) => s.pending_rows));
  const maxBuf = Math.max(...samples.map((s) => s.transport_buffered));
  assert.ok(maxRows <= maxPending, `pending rows bounded: ${maxRows} <= ${maxPending}`);
  assert.ok(maxQ <= highWater + 200, `token queue bounded by the high-water mark: ${maxQ}`);
  assert.ok(maxBuf <= bufferLimit + snapBytes + 4096, `transport buffer bounded: ${maxBuf}`);
  assert.ok(ch.stats.model_pauses >= 1, 'the model source was paused by backpressure');
  assert.ok(ch.stats.rows_conflated > 0 || ch.stats.resyncs > 0, `rows were conflated (${ch.stats.rows_conflated}) or resynced (${ch.stats.resyncs})`);
  assert.ok(produced < parts.length, `source was throttled (${produced}/${parts.length} produced while the link was slow)`);

  // the link recovers
  assert.equal((await api(app, 'POST', '/api/throttle', { body: { cid, bytes_per_sec: 0 } })).status, 200);
  await client.waitForEvent('gen_end', (e) => e.data.gen === 'big', { timeout: 20000 });
  await waitUntil(caughtUp(app, cid, client), { timeout: 20000, what: 'rows to catch up' });
  const text = client.of('token').filter((e) => e.data.gen === 'big').map((e) => e.data.t).join('');
  assert.equal(text, parts.join(''), 'the token lane is lossless and ordered even through a slow link');
  assert.equal(client.of('gen_end').find((e) => e.data.gen === 'big').data.reason, 'done');
  assertConverged(assert, new Mirror().applyAll(client.events), app);
  client.close();
});

test('real socket: when the client stops reading, the server stops writing and pauses the model; resuming reads everything in order', async (t) => {
  const app = await makeApp({ liveWindowHours: 2 });
  t.after(() => app.close());
  const cid = randomCid();
  const sock = net.connect(app.port, '127.0.0.1');
  sock.pause(); // never read: the kernel buffers fill, TCP closes the window, the server's socket backs up
  sock.write(`GET /stream?cid=${cid} HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\nAccept: text/event-stream\r\n\r\n`);
  const ch = await waitUntil(() => app.hub.get(cid), { what: 'channel' });

  const N = 3000, CHUNK = 8192; // ~24 MB, far more than loopback buffers hold
  const part = (i) => `${String(i).padStart(5, '0')}:`.padEnd(CHUNK, String.fromCharCode(97 + (i % 26)));
  let produced = 0;
  async function* big() { for (let i = 0; i < N; i++) { produced++; yield part(i); } }
  ch.startGeneration({ id: 'huge', source: big(), meta: { source: 'test' } });

  await waitUntil(() => ch.stats.model_pauses >= 1, { timeout: 15000, what: 'the model to be paused' });
  // Production stops EVENTUALLY: with larger kernel socket buffers (Linux) the first pause drains into the kernel and the model
  // resumes a few more times before the socket truly backs up, so wait until it has been still and blocked for half a second.
  let last = -1, still = 0;
  await waitUntil(() => { if (produced === last && ch.blocked) still++; else { still = 0; last = produced; } return still >= 5; }, { timeout: 20000, interval: 100, what: 'the model to stop producing' });
  const a = produced;
  await sleep(300);
  assert.equal(produced, a, 'a paused model is not producing');
  assert.ok(produced < N, `the source was stopped long before the end (${produced}/${N})`);
  assert.ok(ch.tokenBytes <= ch.o.highWater + CHUNK, `queue bounded: ${ch.tokenBytes}`);
  assert.ok(ch.transport.buffered <= ch.o.bufferLimit + 2 * CHUNK, `server-side socket buffer bounded: ${ch.transport.buffered}`);
  assert.equal(ch.blocked, true);

  // now read: drain everything the server has, and keep going until the generation ends
  let raw = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => { raw += d; });
  sock.resume();
  await waitUntil(() => raw.includes('event: gen_end'), { timeout: 30000, what: 'gen_end after the client resumed reading' });
  await sleep(50);
  assert.equal(produced, N);
  const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  const texts = [];
  let end = null;
  for (const block of body.split('\n\n')) {
    const ev = /^event: (\w+)/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (ev === 'token') texts.push(JSON.parse(data));
    if (ev === 'gen_end') end = JSON.parse(data);
  }
  let off = 0;
  for (const x of texts) { assert.equal(x.o, off); off += x.t.length; }
  assert.equal(texts.map((x) => x.t).join(''), Array.from({ length: N }, (_, i) => part(i)).join(''));
  assert.equal(end.reason, 'done');
  assert.ok(end.pauses >= 1);
  sock.destroy();
});

test('client disconnect cancels the generation and frees the channel', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const cid = randomCid();
  const alertId = insertAlert(app);
  const c = await new SseClient(app, { cid }).ready;
  await c.waitForEvent('snapshot');
  assert.equal((await api(app, 'POST', '/api/generate', { body: { cid, alert_id: alertId, tokens_per_sec: 10 } })).status, 202);
  await c.waitForEvent('token');
  const ch = app.hub.get(cid);
  const g = ch.gen;
  c.close();
  await waitUntil(() => !app.hub.get(cid) && g.cancelled, { what: 'channel torn down and generation cancelled' });
  assert.equal(app.hub.stats().channels, 0);
});

test('/api/cancel stops a running explanation; /api/generate needs a live stream and a real alert', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const cid = randomCid();
  const alertId = insertAlert(app);
  assert.equal((await api(app, 'POST', '/api/generate', { body: { cid, alert_id: alertId } })).status, 409, 'no stream open yet');
  const c = await new SseClient(app, { cid }).ready;
  await c.waitForEvent('snapshot');
  assert.equal((await api(app, 'POST', '/api/generate', { body: { cid, alert_id: 987654 } })).status, 404);
  assert.equal((await api(app, 'POST', '/api/generate', { body: { cid, alert_id: alertId, source: 'anthropic' } })).status, 400, 'no API key configured');
  assert.equal((await api(app, 'POST', '/api/generate', { body: { cid, alert_id: alertId, tokens_per_sec: 15 } })).status, 202);
  await c.waitForEvent('token');
  const r = await api(app, 'POST', '/api/cancel', { body: { cid } });
  assert.deepEqual(r.json, { cancelled: true });
  const end = await c.waitForEvent('gen_end');
  assert.equal(end.data.reason, 'cancelled');
  assert.equal((await api(app, 'POST', '/api/cancel', { body: { cid } })).json.cancelled, false);
  c.close();
});

test('the live simulator writes through the same path, raises alerts for the injected anomalies, and pushes them to clients', async (t) => {
  const app = await makeApp({ seedDays: 9, volumeScale: 1, detectEveryMs: 50, simAnomalies: false });
  t.after(() => app.close());
  const cid = randomCid();
  const c = await new SseClient(app, { cid }).ready;
  await c.waitForEvent('snapshot');
  assert.equal((await api(app, 'POST', '/api/sim', { body: { rate: 1500, running: true } })).status, 200);
  const r = await api(app, 'POST', '/api/sim', { body: { inject: 'token_bloat', hours: 3 } });
  assert.equal(r.json.anomalies.at(-1).kind, 'token_bloat');
  const isBloat = (x) => x.k.startsWith('a:') && x.v.kind === 'tokens_per_request' && x.v.endpoint === '/v1/chat';
  const alertEv = await c.waitForEvent('rows', (e) => e.data.rows.some(isBloat), { timeout: 40000, what: 'a prompt-bloat alert for /v1/chat pushed over the stream' });
  const a = alertEv.data.rows.find(isBloat).v;
  assert.equal(a.tenant_id, null);
  assert.equal(a.status, 'open');
  await api(app, 'POST', '/api/sim', { body: { running: false } });
  await waitUntil(caughtUp(app, cid, c), { what: 'caught up' });
  assertConverged(assert, new Mirror().applyAll(c.events), app);
  c.close();
});

test('WebSocket: when the client closes, the server answers with exactly ONE close frame (echoing the code) and ends the connection', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const ws = await WsClient.connect(app, { cid: randomCid() });
  assert.equal(ws.status, 101);
  await ws.waitForEvent('snapshot');
  ws.socket.write(encodeClose(1000, 'bye', { mask: true }));
  await waitUntil(() => ws.closed, { what: 'the server to end the connection' });
  assert.equal(ws.closeFrames, 1, 'a second close frame is a protocol violation (browsers log "Close received after close")');
  assert.equal(ws.closeFrame.code, 1000);
  await waitUntil(() => app.hub.size === 0, { what: 'the channel to be released' });
});
