import { EventEmitter } from 'node:events';

/*
 * Transport interface used by Channel (a raw byte sink with backpressure signalling):
 *   write(buf)      never blocks; bytes are queued
 *   buffered        bytes accepted but not yet flushed to the OS
 *   'drain' event   emitted when `buffered` falls back to <= drainMark after having been above it
 *   'close' event, closed flag, end(), destroy()
 * Framing (SSE / WebSocket) is a separate codec, so a slow-link simulator can sit below the framing.
 */

/** Wraps a Node writable (http.ServerResponse or a raw net.Socket). Tracks buffered bytes through write callbacks. */
export class NodeTransport extends EventEmitter {
  constructor(stream, { drainMark = 16 * 1024 } = {}) {
    super();
    this.stream = stream;
    this.drainMark = drainMark;
    this._buffered = 0;
    this._above = false;
    this.closed = false;
    this.bytesWritten = 0;
    const onClose = () => this._closed();
    stream.on('close', onClose);
    stream.on('error', onClose);
  }

  get buffered() { return this._buffered; }

  write(buf) {
    if (this.closed) return;
    const n = buf.length;
    this._buffered += n;
    this.bytesWritten += n;
    if (this._buffered > this.drainMark) this._above = true;
    this.stream.write(buf, () => {
      this._buffered -= n;
      if (this._above && this._buffered <= this.drainMark && !this.closed) {
        this._above = false;
        this.emit('drain');
      }
    });
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  end() {
    if (this.closed) return;
    try { this.stream.end(); } catch { /* already gone */ }
  }

  destroy() {
    this.closed = true;
    try { this.stream.destroy(); } catch { /* already gone */ }
  }
}

/**
 * Simulated slow link: a token-bucket in front of any transport. rate 0 = pass-through.
 * `buffered` counts its own queue plus the inner transport, so the Channel sees the link as slow.
 */
export class LinkSim extends EventEmitter {
  constructor(inner, { bytesPerSec = 0, drainMark = 16 * 1024, tickMs = 20 } = {}) {
    super();
    this.inner = inner;
    this.rate = bytesPerSec;
    this.drainMark = drainMark;
    this.tickMs = tickMs;
    this.queue = [];
    this.queued = 0;
    this.allowance = 0;
    this.timer = null;
    this._above = false;
    this.closed = inner.closed;
    inner.on('close', () => { this.closed = true; this._stop(); this.emit('close'); });
    inner.on('drain', () => this._check());
  }

  get buffered() { return this.queued + this.inner.buffered; }

  write(buf) {
    if (this.closed) return;
    if (!this.rate && !this.queued) {
      this.inner.write(buf);
      this._mark();
      return;
    }
    this.queue.push(buf);
    this.queued += buf.length;
    this._mark();
    this._arm();
  }

  setRate(bytesPerSec) {
    this.rate = Math.max(0, bytesPerSec || 0);
    this.allowance = 0;
    if (!this.rate) this._flushAll();
    else this._arm();
  }

  _mark() { if (this.buffered > this.drainMark) this._above = true; }

  _check() {
    if (this._above && this.buffered <= this.drainMark && !this.closed) {
      this._above = false;
      this.emit('drain');
    }
  }

  _arm() {
    if (this.timer || !this.queued) return;
    this.timer = setInterval(() => this._tick(), this.tickMs);
    this.timer.unref?.();
  }

  _stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  _flushAll() {
    for (const b of this.queue) this.inner.write(b);
    this.queue = [];
    this.queued = 0;
    this._stop();
    this._check();
  }

  _tick() {
    if (!this.rate) return this._flushAll();
    this.allowance = Math.min(this.allowance + (this.rate * this.tickMs) / 1000, this.rate * 0.1 + 1);
    while (this.queue.length && this.allowance >= 1) {
      const head = this.queue[0];
      const n = Math.min(head.length, Math.floor(this.allowance));
      if (n >= head.length) this.queue.shift();
      else this.queue[0] = head.subarray(n);
      this.inner.write(n >= head.length ? head : head.subarray(0, n));
      this.queued -= n;
      this.allowance -= n;
    }
    if (!this.queue.length) this._stop();
    this._check();
  }

  end() { this._flushAll(); this.inner.end(); }
  destroy() { this._stop(); this.closed = true; this.inner.destroy(); }
}
