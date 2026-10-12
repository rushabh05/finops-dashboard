import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptKey, encodeFrame, FrameParser, OP, ProtocolError, encodeClose } from '../src/ws.js';

test('handshake accept key matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('frames round-trip across the three length encodings, masked and unmasked', () => {
  for (const len of [0, 5, 125, 126, 200, 65535, 65536, 70000]) {
    const text = 'x'.repeat(len);
    for (const mask of [false, true]) {
      const p = new FrameParser({ expectMasked: mask, maxPayload: 1 << 20 });
      const out = p.push(encodeFrame(OP.TEXT, text, { mask }));
      assert.equal(out.length, 1);
      assert.equal(out[0].type, 'text');
      assert.equal(out[0].data, text);
    }
  }
});

test('parser copes with frames split at arbitrary byte boundaries and several frames in one chunk', () => {
  const frames = Buffer.concat([encodeFrame(OP.TEXT, 'hello', { mask: true }), encodeFrame(OP.TEXT, 'wörld ✓', { mask: true }), encodeFrame(OP.PING, 'p', { mask: true })]);
  const p = new FrameParser();
  const got = [];
  for (let i = 0; i < frames.length; i++) got.push(...p.push(frames.subarray(i, i + 1)));
  assert.deepEqual(got.map((m) => m.type), ['text', 'text', 'ping']);
  assert.equal(got[1].data, 'wörld ✓');
});

test('fragmented messages are reassembled, control frames may interleave', () => {
  const p = new FrameParser();
  const out = p.push(Buffer.concat([
    encodeFrame(OP.TEXT, 'he', { mask: true, fin: false }),
    encodeFrame(OP.PING, 'x', { mask: true }),
    encodeFrame(OP.CONT, 'llo', { mask: true, fin: true }),
  ]));
  assert.deepEqual(out.map((m) => m.type), ['ping', 'text']);
  assert.equal(out[1].data, 'hello');
});

test('protocol violations are rejected: unmasked client frame, oversize, bad control frame, stray continuation', () => {
  assert.throws(() => new FrameParser({ expectMasked: true }).push(encodeFrame(OP.TEXT, 'x')), ProtocolError);
  assert.throws(() => new FrameParser({ maxPayload: 10 }).push(encodeFrame(OP.TEXT, 'x'.repeat(11), { mask: true })), (e) => e.code === 1009);
  assert.throws(() => new FrameParser().push(encodeFrame(OP.PING, 'x'.repeat(126), { mask: true })), ProtocolError);
  assert.throws(() => new FrameParser().push(encodeFrame(OP.CONT, 'x', { mask: true })), ProtocolError);
});

test('close frame carries code and reason', () => {
  const [m] = new FrameParser({ expectMasked: false }).push(encodeClose(1001, 'bye'));
  assert.deepEqual(m, { type: 'close', code: 1001, reason: 'bye' });
});
