import { EventEmitter } from 'node:events';
import { OP, encodeFrame, encodeClose } from './ws.js';

/* ------------------------------------------------------------------ codecs: SSE and WebSocket behind one interface */

/** Server-Sent Events. `id:` is only written for row frames (token frames must not move Last-Event-ID). */
export const sseCodec = {
  name: 'sse',
  encode({ event, id, data }) {
    return Buffer.from(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  },
  heartbeat: () => Buffer.from(': hb\n\n'),
};

/** WebSocket text frames carrying {event, id, data} JSON. */
export const wsCodec = {
  name: 'ws',
  encode({ event, id, data }) {
    return encodeFrame(OP.TEXT, JSON.stringify(id !== undefined ? { event, id, data } : { event, data }));
  },
  heartbeat: () => encodeFrame(OP.PING),
  closeFrame: () => encodeClose(1001, 'going away'),
};

const byteLen = (s) => Buffer.byteLength(s);

/**
 * One Channel per client. It owns two lanes and one write loop:
 *
 *  ROW LANE   rollup/alert changes keyed by entity; latest value wins (conflation). If more than `maxPending`
 *             entities are waiting, the set is dropped and the client gets a full snapshot instead. Every row/snapshot
 *             frame carries `id` = the newest change-log seq fully delivered, so SSE Last-Event-ID resume replays
 *             only what was missed.
 *  TOKEN LANE ordered and lossless. Adjacent chunks merge while the client is slow; above `highWater` queued bytes
 *             the model source is paused (not pulled from) until the queue drains below `lowWater`.
 *
 *  The write loop only writes while transport.buffered < bufferLimit and resumes on the transport's 'drain'.
 *  Tokens have priority, but while a token backlog exists rows are guaranteed about `rowShare` of the bytes.
 */
export class Channel extends EventEmitter {
  /**
   * @param {object} p
   * @param {string} p.id client id
   * @param {object} p.codec sseCodec | wsCodec
   * @param {object} p.transport see transport.js
   * @param {() => {id:number, data:object}} p.snapshot builds a full snapshot (id = change-log head it reflects)
   * @param {object} p.opts limits (see config.channel)
   */
  constructor({ id, codec, transport, snapshot, opts = {}, now = Date.now }) {
    super();
    this.id = id;
    this.codec = codec;
    this.transport = transport;
    this.snapshotFn = snapshot;
    this.now = now;
    this.o = {
      bufferLimit: 64 * 1024, maxPending: 600, maxRowsPerFrame: 100, highWater: 16 * 1024, lowWater: 4 * 1024,
      maxTokenFrame: 2048, rowShare: 1 / 3, ...opts,
    };
    this.closed = false;
    this.createdAt = now();

    // row lane
    this.pending = new Map(); // entity key -> entry; insertion order == ascending latest-seq order
    this.needSnapshot = false;
    this.head = 0; //        newest seq the feed told us about
    this.sentId = 0; //      newest seq fully delivered (the `id` on the last row/snapshot frame)
    this.covered = 0; //     entries with seq <= covered are already reflected on the client (snapshot / resume)

    // token lane
    this.tq = []; //         ordered items: {type:'start'|'chunk'|'end', g, ...}
    this.tokenBytes = 0;
    this.gen = null;
    this.drainWaiters = [];

    // write loop state
    this.scheduled = false;
    this.pumping = false;
    this.blocked = false;
    this.blockedSince = null;
    this.shareRow = 0;
    this.shareTok = 0;
    this.lastWrite = now();

    this.stats = {
      rows_in: 0, rows_conflated: 0, rows_sent: 0, row_frames: 0, snapshots: 0, resyncs: 0, resumes: 0,
      chunks_in: 0, chunks_coalesced: 0, token_frames: 0, model_pauses: 0, generations: 0,
      bytes_rows: 0, bytes_tokens: 0, bytes_other: 0, blocked_events: 0,
      max_pending: 0, max_token_queue_bytes: 0, max_buffered: 0, last_ttft_ms: null,
    };

    transport.on('drain', () => { this.blocked = false; this.blockedSince = null; this.pump(); });
    transport.on('close', () => this.close('transport closed'));
  }

  /* -------------------------------------------------------------- row lane */

  /** New client with nothing: send a snapshot first. */
  startFresh() {
    this.needSnapshot = true;
    this.schedule();
  }

  /**
   * Resume after `lastId`. `entries` are the changes since then (collapsed, ascending by seq) and `head` the log head
   * they reflect. `entries === null` means the log was pruned past lastId (or lastId is unusable): fall back to a snapshot.
   */
  resume(lastId, entries, head) {
    this.stats.resumes++;
    if (entries === null) return this.startFresh();
    this.sentId = lastId;
    this.head = head;
    this.covered = head;
    for (const e of entries) this._setPending(e);
    if (this.pending.size > this.o.maxPending) this._overflow();
    this.schedule();
  }

  /** Called by the feed with changes (ascending seq, already collapsed per entity within the poll) and the feed head. */
  pushRows(entries, head) {
    if (this.closed) return;
    if (head > this.head) this.head = head;
    if (this.needSnapshot) return; // the snapshot we will send reflects everything up to now
    for (const e of entries) {
      if (e.seq <= this.covered) continue;
      this.stats.rows_in++;
      this._setPending(e);
    }
    if (this.pending.size > this.stats.max_pending) this.stats.max_pending = this.pending.size;
    if (this.pending.size > this.o.maxPending) this._overflow();
    this.schedule();
  }

  _setPending(e) {
    if (this.pending.delete(e.key)) this.stats.rows_conflated++; // a newer value replaces the pending one
    this.pending.set(e.key, e);
  }

  _overflow() {
    this.pending.clear();
    this.needSnapshot = true;
    this.stats.resyncs++;
  }

  _nextRowFrame() {
    if (this.needSnapshot) {
      const snap = this.snapshotFn();
      this.needSnapshot = false;
      this.pending.clear();
      this.covered = Math.max(this.covered, snap.id);
      this.stats.snapshots++;
      return { kind: 'rows', evt: { event: 'snapshot', id: snap.id, data: snap.data }, advance: snap.id, count: 0 };
    }
    if (!this.pending.size) return null;
    const rows = [];
    let last = this.sentId;
    for (const [key, e] of this.pending) {
      if (rows.length >= this.o.maxRowsPerFrame) break;
      rows.push({ k: key, t: e.table, op: e.op, v: e.row });
      last = e.seq;
    }
    for (let i = 0; i < rows.length; i++) this.pending.delete(rows[i].k);
    // Everything pending is in this frame -> we can claim the whole head; otherwise only up to the last row included
    // (rows are ordered by their newest seq, so nothing still pending is older than `last`).
    const id = this.pending.size ? last : Math.max(this.head, last);
    return { kind: 'rows', evt: { event: 'rows', id, data: { rows } }, advance: id, count: rows.length };
  }

  /* -------------------------------------------------------------- token lane */

  /**
   * Start streaming a generation. `source` is an async iterable of strings; `abort` (optional) cancels the
   * upstream request. Any generation already running on this channel is cancelled first.
   */
  startGeneration({ id, source, meta = {}, abort }) {
    if (this.gen) this.cancelGeneration('replaced');
    const g = {
      id, source, meta, abort, offset: 0, sentOffset: 0, cancelled: false, reason: 'done', ended: false,
      startedAt: this.now(), firstTokenAt: null, pauses: 0, chunks: 0, done: null,
    };
    this.gen = g;
    this.stats.generations++;
    this.tq.push({ type: 'start', g });
    this.schedule();
    g.done = this._runSource(g);
    return g;
  }

  cancelGeneration(reason = 'cancelled') {
    const g = this.gen;
    if (!g || g.cancelled || g.ended) return false;
    g.cancelled = true;
    g.reason = reason;
    try { g.abort?.(); } catch { /* ignore */ }
    // drop unsent chunks of this generation; the end marker below still goes out in order
    this.tq = this.tq.filter((it) => !(it.type === 'chunk' && it.g === g));
    this.tokenBytes = this.tq.reduce((n, it) => n + (it.type === 'chunk' ? it.bytes : 0), 0);
    this._releaseWaiters();
    return true;
  }

  async _runSource(g) {
    let error;
    let it;
    try {
      it = g.source[Symbol.asyncIterator]();
      while (!g.cancelled && !this.closed) {
        const { value, done } = await it.next(); // the source only advances when we ask - pausing = not asking
        if (done || g.cancelled || this.closed) break;
        if (typeof value !== 'string' || value === '') continue;
        this._enqueueChunk(g, value);
        if (this.tokenBytes >= this.o.highWater && !g.cancelled && !this.closed) {
          this.stats.model_pauses++;
          g.pauses++;
          this.emit('model-pause', g);
          await this._waitDrain(g);
          this.emit('model-resume', g);
        }
      }
    } catch (e) {
      if (!g.cancelled) { g.reason = 'error'; error = e?.message || String(e); }
    } finally {
      try { await it?.return?.(); } catch { /* ignore */ }
    }
    g.ended = true;
    if (this.closed) return;
    this.tq.push({ type: 'end', g, reason: g.reason, error });
    this.schedule();
  }

  _enqueueChunk(g, text) {
    const bytes = byteLen(text);
    this.tq.push({ type: 'chunk', g, text, bytes });
    this.tokenBytes += bytes;
    this.stats.chunks_in++;
    if (this.tokenBytes > this.stats.max_token_queue_bytes) this.stats.max_token_queue_bytes = this.tokenBytes;
    this.schedule();
  }

  _waitDrain(g) {
    if (this.tokenBytes <= this.o.lowWater) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push({ g, resolve }));
  }

  _releaseWaiters() {
    if (!this.drainWaiters.length) return;
    const keep = [];
    for (const w of this.drainWaiters) {
      if (this.closed || w.g.cancelled || this.tokenBytes <= this.o.lowWater) w.resolve();
      else keep.push(w);
    }
    this.drainWaiters = keep;
  }

  _nextTokenFrame() {
    const item = this.tq.shift();
    const g = item.g;
    if (item.type === 'start') {
      return { kind: 'tokens', evt: { event: 'gen_start', data: { gen: g.id, ...g.meta } } };
    }
    if (item.type === 'end') {
      if (this.gen === g) this.gen = null;
      return { kind: 'tokens', evt: { event: 'gen_end', data: { gen: g.id, reason: item.reason, total: g.sentOffset, ttft_ms: g.firstTokenAt ? g.firstTokenAt - g.startedAt : null, pauses: g.pauses, ...(item.error ? { error: item.error } : {}) } } };
    }
    // chunk: merge the adjacent chunks of the same generation that are already queued (a slow client => bigger frames)
    let text = item.text;
    let bytes = item.bytes;
    let merged = 1;
    while (this.tq.length && this.tq[0].type === 'chunk' && this.tq[0].g === g && bytes + this.tq[0].bytes <= this.o.maxTokenFrame) {
      const nx = this.tq.shift();
      text += nx.text;
      bytes += nx.bytes;
      merged++;
    }
    this.stats.chunks_coalesced += merged - 1;
    this.tokenBytes -= bytes;
    const data = { gen: g.id, o: g.sentOffset, t: text };
    g.sentOffset += text.length;
    if (!g.firstTokenAt) {
      g.firstTokenAt = this.now();
      data.ttft_ms = g.firstTokenAt - g.startedAt;
      this.stats.last_ttft_ms = data.ttft_ms;
      this.emit('first-token', g, data.ttft_ms);
    }
    return { kind: 'tokens', evt: { event: 'token', data } };
  }

  /* -------------------------------------------------------------- write loop */

  schedule() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    setImmediate(() => { this.scheduled = false; this.pump(); });
  }

  _pick() {
    const tokens = this.tq.length > 0;
    const rows = this.needSnapshot || this.pending.size > 0;
    if (!tokens) { this.shareRow = 0; this.shareTok = 0; return rows ? 'rows' : null; }
    if (!rows) return 'tokens';
    // both have backlog: tokens first, but rows are owed `rowShare` of the bytes: rows/(rows+tokens) < share
    const s = this.o.rowShare;
    return this.shareRow * (1 - s) < s * this.shareTok ? 'rows' : 'tokens';
  }

  pump() {
    if (this.pumping || this.closed) return;
    this.pumping = true;
    try {
      while (!this.closed) {
        const buffered = this.transport.buffered;
        if (buffered > this.stats.max_buffered) this.stats.max_buffered = buffered;
        if (buffered >= this.o.bufferLimit) { // transport is full: stop; its 'drain' event restarts us
          if (!this.blocked) { this.blocked = true; this.blockedSince = this.now(); this.stats.blocked_events++; }
          break;
        }
        const lane = this._pick();
        if (!lane) break;
        const f = lane === 'rows' ? this._nextRowFrame() : this._nextTokenFrame();
        if (!f) continue;
        const buf = this.codec.encode(f.evt);
        this.transport.write(buf);
        this.lastWrite = this.now();
        if (f.kind === 'rows') {
          this.stats.bytes_rows += buf.length;
          this.shareRow += buf.length;
          this.stats.row_frames++;
          this.stats.rows_sent += f.count;
          if (f.advance > this.sentId) this.sentId = f.advance;
        } else {
          this.stats.bytes_tokens += buf.length;
          this.shareTok += buf.length;
          if (f.evt.event === 'token') this.stats.token_frames++;
        }
      }
    } finally {
      this.pumping = false;
    }
    this._releaseWaiters();
  }

  /** Slow-consumer eviction: a transport that has been full for `stallMs` without a single drain is dead weight. */
  checkStall(stallMs) {
    if (this.blocked && this.blockedSince !== null && this.now() - this.blockedSince > stallMs) this.close('stalled consumer');
  }

  heartbeat(maxIdleMs) {
    if (this.closed || this.transport.buffered > 0 || this.now() - this.lastWrite < maxIdleMs) return;
    const buf = this.codec.heartbeat();
    this.transport.write(buf);
    this.stats.bytes_other += buf.length;
    this.lastWrite = this.now();
  }

  setThrottle(bytesPerSec) {
    this.transport.setRate?.(bytesPerSec);
  }

  /** Queue depths for the backpressure lab / tests. */
  depth() {
    return { pending_rows: this.pending.size, token_queue_bytes: this.tokenBytes, transport_buffered: this.transport.buffered, need_snapshot: this.needSnapshot };
  }

  snapshotStats() {
    return {
      id: this.id, transport: this.codec.name, age_ms: this.now() - this.createdAt, sent_id: this.sentId, head: this.head,
      throttle_bps: this.transport.rate ?? 0, generating: !!this.gen, blocked: this.blocked, ...this.depth(), ...this.stats,
    };
  }

  /** `notify: false` when the peer has already been sent a close frame (a WebSocket must send exactly one). */
  close(reason = 'closed', { notify = true } = {}) {
    if (this.closed) return;
    if (this.gen) this.cancelGeneration(reason);
    this.closed = true;
    this._releaseWaiters();
    this.pending.clear();
    this.tq = [];
    this.tokenBytes = 0;
    try {
      if (notify && this.codec.closeFrame && !this.transport.closed) this.transport.write(this.codec.closeFrame());
      this.transport.end();
    } catch { /* ignore */ }
    this.emit('close', reason);
  }
}
