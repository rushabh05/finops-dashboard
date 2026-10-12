import { createHash, randomBytes } from 'node:crypto';

/* Hand-written RFC 6455: opening handshake + frame encode/decode (no `ws` package). */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64');

export class ProtocolError extends Error {
  constructor(message, code = 1002) {
    super(message);
    this.code = code;
  }
}

/** Validate an upgrade request. Returns { key } or throws ProtocolError. */
export function checkUpgrade(req) {
  const h = req.headers;
  if (String(h.upgrade || '').toLowerCase() !== 'websocket') throw new ProtocolError('not a websocket upgrade');
  if (!/\bupgrade\b/i.test(String(h.connection || ''))) throw new ProtocolError('missing Connection: Upgrade');
  if (h['sec-websocket-version'] !== '13') throw new ProtocolError('unsupported websocket version');
  const key = h['sec-websocket-key'];
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) throw new ProtocolError('bad Sec-WebSocket-Key');
  return { key };
}

export function handshakeResponse(key) {
  return ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n');
}

/** Encode one frame. Servers send unmasked frames; clients (tests) must mask. */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { mask = false, fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = body.length;
  const maskLen = mask ? 4 : 0;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2 + maskLen);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4 + maskLen);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10 + maskLen);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) return Buffer.concat([header, body]);
  header[1] |= 0x80;
  const key = randomBytes(4);
  key.copy(header, header.length - 4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = body[i] ^ key[i & 3];
  return Buffer.concat([header, masked]);
}

export function encodeClose(code = 1000, reason = '', opts = {}) {
  const r = Buffer.from(reason);
  const body = Buffer.alloc(2 + r.length);
  body.writeUInt16BE(code, 0);
  r.copy(body, 2);
  return encodeFrame(OP.CLOSE, body, opts);
}

/**
 * Incremental frame parser. push(chunk) returns complete messages:
 *   { type: 'text' | 'binary', data }, { type: 'ping' | 'pong', data }, { type: 'close', code, reason }
 * Handles fragmentation, masking, length encodings and enforces payload caps.
 */
export class FrameParser {
  constructor({ maxPayload = 1 << 20, expectMasked = true } = {}) {
    this.maxPayload = maxPayload;
    this.expectMasked = expectMasked;
    this.buf = Buffer.alloc(0);
    this.fragOp = null;
    this.frags = [];
    this.fragLen = 0;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0;
      if (b[0] & 0x70) throw new ProtocolError('reserved bits set');
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      if (this.expectMasked && !masked) throw new ProtocolError('client frames must be masked');
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new ProtocolError('frame too large', 1009);
        len = Number(big);
        off = 10;
      }
      if (len > this.maxPayload) throw new ProtocolError('frame too large', 1009);
      const isControl = opcode >= 0x8;
      if (isControl && (!fin || len > 125)) throw new ProtocolError('bad control frame');
      const total = off + (masked ? 4 : 0) + len;
      if (b.length < total) break;
      let payload;
      if (masked) {
        const key = b.subarray(off, off + 4);
        payload = Buffer.allocUnsafe(len);
        const src = b.subarray(off + 4, total);
        for (let i = 0; i < len; i++) payload[i] = src[i] ^ key[i & 3];
      } else payload = Buffer.from(b.subarray(off, total));
      this.buf = b.subarray(total);

      if (isControl) {
        if (opcode === OP.CLOSE) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          out.push({ type: 'close', code, reason: payload.subarray(2).toString() });
        } else if (opcode === OP.PING) out.push({ type: 'ping', data: payload });
        else if (opcode === OP.PONG) out.push({ type: 'pong', data: payload });
        else throw new ProtocolError('unknown control opcode');
        continue;
      }
      if (opcode === OP.CONT) {
        if (this.fragOp === null) throw new ProtocolError('unexpected continuation frame');
      } else {
        if (opcode !== OP.TEXT && opcode !== OP.BINARY) throw new ProtocolError('unknown opcode');
        if (this.fragOp !== null) throw new ProtocolError('new data frame inside a fragmented message');
        this.fragOp = opcode;
      }
      this.frags.push(payload);
      this.fragLen += len;
      if (this.fragLen > this.maxPayload) throw new ProtocolError('message too large', 1009);
      if (fin) {
        const data = Buffer.concat(this.frags);
        const type = this.fragOp === OP.TEXT ? 'text' : 'binary';
        this.frags = []; this.fragLen = 0; this.fragOp = null;
        if (type === 'text') {
          try { out.push({ type, data: new TextDecoder('utf-8', { fatal: true }).decode(data) }); } catch { throw new ProtocolError('invalid utf-8', 1007); }
        } else out.push({ type, data });
      }
    }
    return out;
  }
}
