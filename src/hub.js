import { Channel, sseCodec, wsCodec } from './channel.js';
import { NodeTransport, LinkSim } from './transport.js';

/** Registry of live channels (one per client id) + fan-out of feed entries + generation bookkeeping. */
export class Hub {
  constructor({ feed, cfg, now = Date.now }) {
    this.feed = feed;
    this.cfg = cfg;
    this.now = now;
    this.channels = new Map();
    this.defaultThrottle = 0;
    this.genSeq = 0;
    this.ttft = []; // recent server-measured time-to-first-token (ms)
    this.totals = { opened: 0, closed: 0, resumed: 0, snapshots_sent: 0 };
    this.unsub = feed.subscribe((entries, head) => {
      for (const ch of this.channels.values()) ch.pushRows(entries, head);
    });
    this.hb = setInterval(() => {
      for (const ch of [...this.channels.values()]) { ch.checkStall(cfg.channel.stallMs); ch.heartbeat(cfg.channel.heartbeatMs); }
    }, Math.max(250, Math.min(cfg.channel.heartbeatMs, 5000)));
    this.hb.unref?.();
  }

  get size() { return this.channels.size; }
  get(cid) { return this.channels.get(cid); }

  /** Open a channel for `stream` (an http.ServerResponse for SSE, a raw socket for WebSocket). */
  open({ cid, kind, stream, lastId = null }) {
    const old = this.channels.get(cid);
    if (old) old.close('replaced by a new connection');
    const cc = this.cfg.channel;
    const raw = new NodeTransport(stream, { drainMark: cc.drainMark });
    const link = new LinkSim(raw, { bytesPerSec: this.defaultThrottle, drainMark: cc.drainMark });
    const codec = kind === 'ws' ? wsCodec : sseCodec;
    const ch = new Channel({ id: cid, codec, transport: link, snapshot: () => this.feed.snapshot(), opts: cc, now: this.now });
    this.channels.set(cid, ch);
    this.totals.opened++;
    ch.on('close', () => {
      if (this.channels.get(cid) === ch) this.channels.delete(cid);
      this.totals.closed++;
    });
    ch.on('first-token', (g, ms) => {
      this.ttft.push(ms);
      if (this.ttft.length > 100) this.ttft.shift();
    });

    // resume incrementally if the client's cursor is still usable, otherwise start from a snapshot
    let resumed = false;
    if (lastId !== null) {
      const r = this.feed.since(lastId, cc.maxPending);
      if (r) { ch.resume(lastId, r.entries, r.head); resumed = true; this.totals.resumed++; }
    }
    link.write(codec.encode({ event: 'hello', data: { cid, transport: codec.name, resumed, last_id: lastId, server_time: this.now() } }));
    if (!resumed) ch.startFresh();
    return ch;
  }

  nextGenId() { return `g${++this.genSeq}`; }

  activeGenerations() {
    let n = 0;
    for (const ch of this.channels.values()) if (ch.gen && !ch.gen.ended) n++;
    return n;
  }

  setThrottle(cid, bytesPerSec) {
    if (cid) {
      const ch = this.channels.get(cid);
      if (!ch) return false;
      ch.setThrottle(bytesPerSec);
      return true;
    }
    this.defaultThrottle = bytesPerSec;
    for (const ch of this.channels.values()) ch.setThrottle(bytesPerSec);
    return true;
  }

  ttftSummary() {
    if (!this.ttft.length) return { count: 0, last_ms: null, p50_ms: null };
    const s = [...this.ttft].sort((a, b) => a - b);
    return { count: s.length, last_ms: this.ttft[this.ttft.length - 1], p50_ms: s[s.length >> 1] };
  }

  stats(cid) {
    const ch = cid ? this.channels.get(cid) : null;
    return {
      channels: this.channels.size, active_generations: this.activeGenerations(), default_throttle_bps: this.defaultThrottle,
      totals: this.totals, ttft: this.ttftSummary(), channel: ch ? ch.snapshotStats() : null,
    };
  }

  close() {
    clearInterval(this.hb);
    this.unsub();
    for (const ch of [...this.channels.values()]) ch.close('server shutting down');
  }
}
