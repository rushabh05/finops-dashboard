import test from 'node:test';
import assert from 'node:assert/strict';
import { Channel, sseCodec } from '../src/channel.js';
import { ChangeFeed } from '../src/feed.js';
import { ChangeLog, openDb } from '../src/db.js';
import { PriceBook, seedPrices } from '../src/pricing.js';
import { Ingestor } from '../src/ingest.js';
import { Rng } from '../src/sim.js';
import { HOUR } from '../src/util.js';
import { FakeTransport, Mirror, mkRequest, sleep, waitUntil, insertAlert } from './helpers.js';

const entry = (n, seq, v = {}) => ({ key: `r:${n}`, seq, table: 'rollups_hourly', row_id: n, op: 'update', row: { id: n, ...v } });

function mk(opts = {}, { drainMark = 1000 } = {}) {
  const t = new FakeTransport({ drainMark });
  let snaps = 0;
  const ch = new Channel({
    id: 'c1', codec: sseCodec, transport: t, opts,
    snapshot: () => { snaps++; return { id: ch.head + 100, data: { snap: snaps, window: { from: 0 }, rollups: { cols: [], rows: [] }, alerts: [] } }; },
  });
  return { ch, t, snaps: () => snaps };
}
async function* chunks(texts, { delay = 0, onYield } = {}) {
  for (const x of texts) { onYield?.(x); yield x; if (delay) await sleep(delay); }
}

/* ------------------------------------------------------------------ row lane */

test('conflation: the latest value per entity wins, and nothing else is lost', () => {
  const { ch, t } = mk();
  ch.pushRows([entry(1, 1, { v: 'a' })], 1);
  ch.pushRows([entry(2, 2, { v: 'b' })], 2);
  ch.pushRows([entry(1, 3, { v: 'c' })], 3); // replaces the pending value of r:1
  ch.pump();
  const frames = t.of('rows');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].data.rows.map((r) => [r.k, r.v.v]), [['r:2', 'b'], ['r:1', 'c']], 'ordered by newest seq, r:1 carries the latest value');
  assert.equal(ch.stats.rows_conflated, 1);
  assert.equal(frames[0].id, 3);
});

test('frame id = newest seq fully delivered: partial frames stop at their last row, the final frame claims the head', () => {
  const { ch, t } = mk({ maxRowsPerFrame: 2 });
  ch.pushRows([1, 2, 3, 4, 5].map((n) => entry(n, n)), 7); // head 7 is newer than the newest entry (7 was an irrelevant change)
  ch.pump();
  assert.deepEqual(t.of('rows').map((f) => f.id), [2, 4, 7]);
  assert.deepEqual(t.of('rows').map((f) => f.data.rows.length), [2, 2, 1]);
  assert.equal(ch.sentId, 7);
});

test('a conflated entity moves to the back of the queue, so ids never overstate what was delivered', () => {
  const { ch, t } = mk({ maxRowsPerFrame: 1 });
  ch.pushRows([entry(1, 1), entry(2, 2)], 2);
  ch.pushRows([entry(1, 3)], 3); // r:1 was pending at seq 1; now it is newest (seq 3)
  ch.pump();
  assert.deepEqual(t.of('rows').map((f) => [f.data.rows[0].k, f.id]), [['r:2', 2], ['r:1', 3]]);
});

test('overflow: past maxPending the pending set is dropped and replaced by one snapshot', () => {
  const { ch, t, snaps } = mk({ maxPending: 3 });
  ch.pushRows([1, 2, 3].map((n) => entry(n, n)), 3);
  assert.equal(ch.needSnapshot, false);
  ch.pushRows([entry(4, 4)], 4);
  assert.equal(ch.needSnapshot, true);
  assert.equal(ch.pending.size, 0);
  assert.equal(ch.stats.resyncs, 1);
  ch.pushRows([entry(5, 5), entry(6, 6)], 6); // ignored while a snapshot is owed: the snapshot will reflect them
  assert.equal(ch.pending.size, 0);
  ch.pump();
  assert.equal(snaps(), 1);
  assert.deepEqual(t.frames.map((f) => f.event), ['snapshot']);
  const snapId = t.frames[0].id;
  assert.equal(snapId, ch.head + 100);
  // changes the snapshot already covers are not re-sent; newer ones are
  ch.pushRows([entry(7, snapId - 1), entry(8, snapId + 1)], snapId + 1);
  ch.pump();
  assert.deepEqual(t.of('rows').map((f) => [f.data.rows.map((r) => r.k), f.id]), [[['r:8'], snapId + 1]]);
});

test('writes only happen while buffered bytes are under the limit; the channel resumes on drain', () => {
  const limit = 600;
  const { ch, t } = mk({ bufferLimit: limit, maxRowsPerFrame: 1, maxPending: 10_000 }, { drainMark: 200 });
  const writeBuffered = [];
  const orig = t.write.bind(t);
  t.write = (b) => { writeBuffered.push(t.buffered); orig(b); };
  ch.pushRows(Array.from({ length: 100 }, (_, i) => entry(i, i + 1, { pad: 'x'.repeat(40) })), 100);
  ch.pump();
  assert.ok(t.frames.length < 100, 'did not dump everything into the transport');
  assert.ok(Math.max(...writeBuffered) < limit, 'never wrote while at/over the limit');
  assert.equal(ch.blocked, true);
  let guard = 0;
  while (t.frames.length < 100 && guard++ < 1000) t.flush(300); // the network catches up -> 'drain' -> pump
  assert.equal(t.frames.length, 100);
  assert.ok(Math.max(...writeBuffered) < limit);
  assert.ok(t.maxBuffered < limit + 200, `max buffered ${t.maxBuffered}`);
});

/* ------------------------------------------------------------------ token lane */

test('tokens: ordered and lossless; adjacent chunks merge while the client is slow', async () => {
  const { ch, t } = mk({ bufferLimit: 500, highWater: 1_000_000, maxTokenFrame: 100_000 }, { drainMark: 100 });
  t.buffered = 500; // client is stalled: transport full
  const words = Array.from({ length: 60 }, (_, i) => `w${i} `);
  const g = ch.startGeneration({ id: 'g1', source: chunks(words) });
  await g.done;
  ch.pump(); // still blocked
  assert.equal(t.frames.length, 0, 'nothing written while the transport is full');
  t.flush(500); // client catches up
  const toks = t.of('token');
  assert.ok(toks.length < 5, `60 chunks should have merged into a few frames, got ${toks.length}`);
  assert.equal(ch.stats.chunks_coalesced, 60 - toks.length);
  assert.equal(toks.map((f) => f.data.t).join(''), words.join(''), 'lossless and in order');
  let off = 0;
  for (const f of toks) { assert.equal(f.data.o, off, 'offsets are contiguous'); off += f.data.t.length; }
  assert.deepEqual(t.frames.map((f) => f.event).filter((e) => e !== 'token'), ['gen_start', 'gen_end']);
  assert.equal(t.frames.at(-1).event, 'gen_end');
  assert.equal(t.frames.at(-1).data.total, words.join('').length);
  assert.equal(t.frames.at(-1).data.reason, 'done');
});

test('a fast client sees every chunk as its own frame (no needless merging)', async () => {
  const { ch, t } = mk();
  // A "fast client" is one that has flushed a chunk before the next arrives. Pace the source on the flush itself instead of on a
  // timer: with a 5 ms timer, an event-loop stall (a busy shared CI runner) lets the next chunk arrive before the flush runs, and
  // merging those two is exactly what the channel is meant to do, so the test was asserting a timing accident.
  async function* paced() {
    const texts = ['a ', 'b ', 'c '];
    for (let i = 0; i < texts.length; i++) {
      yield texts[i];
      await waitUntil(() => t.of('token').length > i, { what: `chunk ${i + 1} to be flushed` });
    }
  }
  const g = ch.startGeneration({ id: 'g1', source: paced() });
  await g.done;
  ch.pump();
  assert.equal(t.of('token').length, 3);
  assert.equal(ch.stats.chunks_coalesced, 0);
});

test('above the high-water mark the model source is paused until the queue drains', async () => {
  const { ch, t } = mk({ bufferLimit: 400, highWater: 300, lowWater: 100, maxTokenFrame: 150 }, { drainMark: 100 });
  t.buffered = 400; // blocked
  let produced = 0;
  const total = 60;
  const source = chunks(Array.from({ length: total }, (_, i) => `${String(i).padStart(2, '0')}${'.'.repeat(48)}`), { onYield: () => { produced++; } }); // 50-byte chunks
  const g = ch.startGeneration({ id: 'g1', source });
  await waitUntil(() => ch.stats.model_pauses >= 1, { what: 'model pause' });
  const atPause = produced;
  assert.ok(atPause <= 8, `source was pulled ${atPause} times before pausing`);
  await sleep(60);
  assert.equal(produced, atPause, 'a paused source is not pulled from');
  assert.ok(ch.tokenBytes <= 300 + 50, `queue bounded: ${ch.tokenBytes}`);
  // the client drains: the source resumes, and everything arrives in order
  let guard = 0;
  while (!t.of('gen_end').length && guard++ < 5000) { t.flush(120); await sleep(1); }
  assert.equal(produced, total);
  assert.ok(ch.stats.model_pauses >= 2, `paused repeatedly: ${ch.stats.model_pauses}`);
  assert.ok(ch.stats.max_token_queue_bytes <= 300 + 50);
  const text = t.of('token').map((f) => f.data.t).join('');
  assert.equal(text, Array.from({ length: total }, (_, i) => `${String(i).padStart(2, '0')}${'.'.repeat(48)}`).join(''));
  await g.done;
});

test('bandwidth sharing: with both lanes backlogged, rows get about a third of the bytes and neither starves', async () => {
  const { ch, t } = mk({ bufferLimit: 3000, maxPending: 100_000, maxRowsPerFrame: 3, maxTokenFrame: 300, highWater: 10_000_000 }, { drainMark: 1000 });
  t.buffered = 3000; // start blocked so both lanes build a backlog
  ch.pushRows(Array.from({ length: 3000 }, (_, i) => entry(i, i + 1, { pad: 'r'.repeat(30) })), 3000);
  const g = ch.startGeneration({ id: 'g1', source: chunks(Array.from({ length: 4000 }, () => 'tttttttttt'.repeat(3))) });
  await waitUntil(() => ch.tokenBytes >= 100_000, { what: 'token backlog' });
  const rowBytes0 = ch.stats.bytes_rows, tokBytes0 = ch.stats.bytes_tokens;
  let steps = 0;
  while (steps++ < 60) { t.flush(2800); await sleep(0); } // contended window: both backlogs stay non-empty
  assert.ok(ch.pending.size > 0 && ch.tq.length > 0, 'still contended');
  const rows = ch.stats.bytes_rows - rowBytes0;
  const toks = ch.stats.bytes_tokens - tokBytes0;
  const share = rows / (rows + toks);
  assert.ok(rows > 0 && toks > 0, 'neither lane starves');
  assert.ok(share > 0.27 && share < 0.40, `rows' share of bytes was ${share.toFixed(3)}`);
  assert.ok(toks > rows, 'tokens keep priority');
  g.abort = undefined;
  ch.cancelGeneration();
});

test('cancel: queued chunks are dropped, the source is aborted, and the client still gets an ordered gen_end', async () => {
  const { ch, t } = mk({ bufferLimit: 400 }, { drainMark: 100 });
  let aborted = false, returned = false;
  async function* slow() { try { for (let i = 0; i < 1000; i++) { yield `t${i} `; await sleep(5); } } finally { returned = true; } }
  const g = ch.startGeneration({ id: 'g1', source: slow(), abort: () => { aborted = true; } });
  await waitUntil(() => t.of('token').length >= 2, { what: 'some tokens' });
  ch.cancelGeneration('cancelled');
  await g.done;
  ch.pump();
  assert.equal(aborted, true);
  assert.equal(returned, true);
  const end = t.of('gen_end');
  assert.equal(end.length, 1);
  assert.equal(end[0].data.reason, 'cancelled');
  assert.equal(t.frames.at(-1).event, 'gen_end');
});

test('a source error ends the generation with reason "error" after the tokens that did arrive', async () => {
  const { ch, t } = mk();
  async function* boom() { yield 'hello '; throw new Error('upstream exploded'); }
  const g = ch.startGeneration({ id: 'g1', source: boom() });
  await g.done;
  ch.pump();
  assert.equal(t.of('token').map((f) => f.data.t).join(''), 'hello ');
  assert.equal(t.of('gen_end')[0].data.reason, 'error');
  assert.match(t.of('gen_end')[0].data.error, /upstream exploded/);
});

test('closing the channel releases a paused source', async () => {
  const { ch, t } = mk({ bufferLimit: 100, highWater: 100, lowWater: 10 }, { drainMark: 10 });
  t.buffered = 100;
  let returned = false;
  async function* many() { try { for (;;) yield 'x'.repeat(50); } finally { returned = true; } }
  const g = ch.startGeneration({ id: 'g1', source: many() });
  await waitUntil(() => ch.stats.model_pauses >= 1);
  ch.close('test');
  await g.done;
  assert.equal(returned, true);
});

/* ------------------------------------------------------------------ resume ids & snapshot fallback (real DB + feed) */

function world() {
  const db = openDb();
  seedPrices(db);
  const ing = new Ingestor(db, new PriceBook(db));
  const feed = new ChangeFeed(db, { windowHours: 6 });
  return { db, ing, feed, log: new ChangeLog(db) };
}
const T = Date.UTC(2026, 5, 1, 12, 0);
const tenants = ['acme', 'globex', 'initech', 'umbrella'];
const endpoints = ['/v1/chat', '/v1/summarize', '/v1/classify'];

function randomIngest(ing, rng, n = 1 + rng.int(6)) {
  const reqs = [];
  for (let i = 0; i < n; i++) {
    reqs.push(mkRequest({ ts: T + rng.int(3 * HOUR), tenant: tenants[rng.int(4)], endpoint: endpoints[rng.int(3)], calls: [{ model: ['claude-haiku-5-5', 'claude-sonnet-5-5'][rng.int(2)], input_tokens: 100 + rng.int(900), output_tokens: 10 + rng.int(200) }] }));
  }
  ing.ingest({ requests: reqs });
}

test('feed.since: replays only what changed after the cursor, falls back to null when the log was pruned or the id is bogus', () => {
  const { db, ing, feed, log } = world();
  const rng = new Rng(1);
  for (let i = 0; i < 5; i++) randomIngest(ing, rng);
  feed.poll();
  const cursor = log.head();
  const before = feed.snapshot();
  assert.equal(before.id, cursor);
  assert.deepEqual(feed.since(cursor, 1000).entries, [], 'nothing missed');
  ing.ingest({ requests: [mkRequest({ ts: T, tenant: 'acme', endpoint: '/v1/chat' })] }); // touches 2 rollup rows
  const r = feed.since(cursor, 1000);
  assert.equal(r.entries.length, 2);
  assert.ok(r.entries.every((e) => e.seq > cursor));
  assert.equal(r.head, log.head());
  // pruned past the cursor / cursor in the future / not a number / too many entities -> snapshot fallback
  log.prune(0);
  assert.equal(feed.since(cursor, 1000), null, 'log pruned past the cursor');
  assert.equal(feed.since(log.head() + 5, 1000), null, 'cursor newer than the log');
  assert.equal(feed.since(-1, 1000), null);
  assert.equal(feed.since(NaN, 1000), null);
  ing.ingest({ requests: Array.from({ length: 6 }, (_, i) => mkRequest({ ts: T, tenant: tenants[i % 4], endpoint: endpoints[i % 3] })) });
  assert.equal(feed.since(log.prunedTo(), 1), null, 'more changed entities than maxEntities');
  void db;
});

test('resume-id correctness (property test): after random disconnects with lost in-flight frames, resuming from the last RECEIVED id converges to the DB', () => {
  let incremental = 0, fallback = 0;
  for (let trial = 0; trial < 150; trial++) {
    const rng = new Rng(1000 + trial);
    const { db, ing, feed, log } = world();
    // channel A: small frames, random flushes
    const tA = new FakeTransport({ drainMark: 300 });
    const A = new Channel({ id: 'A', codec: sseCodec, transport: tA, snapshot: () => feed.snapshot(), opts: { maxRowsPerFrame: 1 + rng.int(4), maxPending: 5 + rng.int(40), bufferLimit: 400 + rng.int(800) } });
    feed.subscribe((entries, head) => A.pushRows(entries, head));
    randomIngest(ing, rng, 3);
    feed.poll();
    A.startFresh();
    A.pump();
    const steps = 3 + rng.int(12);
    for (let s = 0; s < steps; s++) {
      randomIngest(ing, rng);
      if (rng.next() < 0.3) insertAlert({ db, sim: { simNow: T }, }, { ts: T + s });
      if (rng.next() < 0.2 && log.head() > 0) db.prepare("UPDATE alerts SET status = 'ack' WHERE id = (SELECT MAX(id) FROM alerts)").run();
      feed.poll();
      A.pump();
      if (rng.next() < 0.6) { tA.flush(100 + rng.int(2000)); A.pump(); }
    }
    // disconnect: the last k written frames never reached the client (they were sitting in socket buffers)
    const lost = rng.int(4);
    const received = tA.frames.slice(0, Math.max(0, tA.frames.length - lost));
    const lastId = received.filter((f) => f.id !== undefined).at(-1)?.id ?? null;
    A.close('disconnect');
    // more changes happen while the client is away
    for (let s = 0; s < 1 + rng.int(4); s++) randomIngest(ing, rng);
    // reconnect
    const tB = new FakeTransport({ drainMark: 300 });
    const B = new Channel({ id: 'B', codec: sseCodec, transport: tB, snapshot: () => feed.snapshot(), opts: { maxRowsPerFrame: 1 + rng.int(5), maxPending: 5 + rng.int(60), bufferLimit: 100_000 } });
    if (rng.next() < 0.15) log.prune(rng.int(4)); // sometimes the log was pruned meanwhile
    const r = lastId === null ? null : feed.since(lastId, B.o.maxPending);
    if (r) B.resume(lastId, r.entries, r.head); else B.startFresh();
    feed.subscribe((entries, head) => B.pushRows(entries, head));
    B.pump();
    // more live changes after reconnecting
    randomIngest(ing, rng);
    feed.poll();
    B.pump();
    if (r) incremental++; else fallback++;
    const m2 = new Mirror().applyAll(received).applyAll(tB.frames);
    const from = feed.windowFrom();
    const truth = new Map(db.prepare('SELECT rowid AS id, hour, tenant_id, endpoint, model, requests, llm_calls, tokens_in, tokens_out, cost_micro_usd FROM rollups_hourly WHERE hour >= ?').all(from).map((x) => [x.id, { ...x }]));
    assert.equal(m2.rollups.size, truth.size, `trial ${trial}: row count (resumed=${!!r}, lastId=${lastId}, lost=${lost})`);
    for (const [id, row] of truth) assert.deepEqual(m2.rollups.get(id), row, `trial ${trial}: rollup ${id}`);
    for (const a of db.prepare('SELECT id, status FROM alerts').all()) assert.equal(m2.alerts.get(a.id)?.status, a.status, `trial ${trial}: alert ${a.id}`);
    // ids on every frame B sent are monotonic and never ahead of the log head
    const ids = tB.frames.filter((f) => f.id !== undefined).map((f) => f.id);
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i] >= ids[i - 1], `trial ${trial}: ids monotonic`);
    if (ids.length) assert.ok(ids.at(-1) <= log.head());
    if (r) assert.ok(!tB.of('snapshot').length, `trial ${trial}: incremental resume must not send a snapshot`);
  }
  assert.ok(incremental >= 40 && fallback >= 5, `both paths exercised (incremental=${incremental}, snapshot fallback=${fallback})`);
});

test('slow-consumer eviction: a transport that stays full past stallMs is closed, and a paused model is released', async () => {
  let clock = 1000;
  const t = new FakeTransport({ drainMark: 10 });
  const ch = new Channel({ id: 'c', codec: sseCodec, transport: t, snapshot: () => ({ id: 0, data: {} }), now: () => clock, opts: { bufferLimit: 100, highWater: 100, lowWater: 10 } });
  t.buffered = 100;
  let returned = false;
  async function* many() { try { for (;;) yield 'x'.repeat(50); } finally { returned = true; } }
  const g = ch.startGeneration({ id: 'g', source: many() });
  await waitUntil(() => ch.blocked && ch.stats.model_pauses >= 1);
  clock += 60_000; ch.checkStall(120_000);
  assert.equal(ch.closed, false, 'not yet');
  clock += 61_000; ch.checkStall(120_000);
  assert.equal(ch.closed, true);
  await g.done;
  assert.equal(returned, true);
  assert.equal(t.closed, true);
});
