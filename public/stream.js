/*
 * Live stream client. SSE (EventSource) or WebSocket behind one interface; both deliver the same events:
 *   hello, snapshot, rows, token, gen_start, gen_end
 * SSE resumes with Last-Event-ID automatically. For WebSocket we track the newest row/snapshot id ourselves and
 * reconnect with ?lastEventId=. Either way the server replays only what was missed (or sends a fresh snapshot).
 */
const EVENTS = ['hello', 'snapshot', 'rows', 'token', 'gen_start', 'gen_end'];

export function newClientId() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return 'c' + [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class LiveStream {
  constructor({ cid, kind = 'sse', onEvent, onStatus }) {
    this.cid = cid;
    this.kind = kind;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.lastId = null;
    this.es = null;
    this.ws = null;
    this.retry = 0;
    this.timer = null;
    this.closed = false;
  }

  connect() {
    this.closed = false;
    this.onStatus(this.retry ? 'reconnecting' : 'connecting');
    if (this.kind === 'ws') this._connectWs(); else this._connectSse();
  }

  _connectSse() {
    const es = new EventSource(`stream?cid=${encodeURIComponent(this.cid)}`) /* relative: the page may live under /d/<source>/ */;
    this.es = es;
    es.onopen = () => { this.retry = 0; this.onStatus('live'); };
    es.onerror = () => { this.onStatus(es.readyState === EventSource.CLOSED ? 'error' : 'reconnecting'); if (es.readyState === EventSource.CLOSED && !this.closed) this._later(); };
    for (const name of EVENTS) {
      es.addEventListener(name, (e) => {
        let data;
        try { data = JSON.parse(e.data); } catch { return; }
        if (e.lastEventId) this.lastId = Number(e.lastEventId);
        this.onEvent({ event: name, data, id: e.lastEventId ? Number(e.lastEventId) : undefined });
      });
    }
  }

  _connectWs() {
    const q = `cid=${encodeURIComponent(this.cid)}${this.lastId !== null ? `&lastEventId=${this.lastId}` : ''}`;
    const url = new URL(`ws?${q}`, location.href); // relative to the page, which may live under /d/<source>/
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.onStatus('live'); };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (!msg || !EVENTS.includes(msg.event)) return;
      if (msg.id !== undefined) this.lastId = msg.id;
      this.onEvent({ event: msg.event, data: msg.data, id: msg.id });
    };
    ws.onclose = () => { if (!this.closed) { this.onStatus('reconnecting'); this._later(); } };
    ws.onerror = () => { /* onclose follows */ };
  }

  _later() {
    clearTimeout(this.timer);
    const wait = Math.min(8000, 400 * 2 ** this.retry++);
    this.timer = setTimeout(() => { if (!this.closed) this.connect(); }, wait);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.es?.close();
    this.ws?.close();
    this.es = null;
    this.ws = null;
  }
}
