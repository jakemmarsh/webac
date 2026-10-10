/**
 * ASSESS: unit tests for the packet-capture container codec used by the
 * session-replay corpus (bridge BRIDGE_CAPTURE writer ↔ replay test reader).
 */
import { describe, it, expect } from 'vitest';
import { encodeCaptureFrame, decodeCaptureFrames } from '@ac/network';

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('CaptureCodec', () => {
  it('round-trips a single frame', () => {
    const frame = new Uint8Array([1, 2, 3, 4, 5]);
    const decoded = decodeCaptureFrames(encodeCaptureFrame(frame));
    expect(decoded).toHaveLength(1);
    expect(Array.from(decoded[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it('round-trips many frames in order', () => {
    const frames = [
      new Uint8Array([10]),
      new Uint8Array([20, 21]),
      new Uint8Array([30, 31, 32]),
    ];
    const buf = concat(...frames.map(encodeCaptureFrame));
    const decoded = decodeCaptureFrames(buf);
    expect(decoded.map((f) => Array.from(f))).toEqual([[10], [20, 21], [30, 31, 32]]);
  });

  it('prefixes each frame with its little-endian u32 length', () => {
    const enc = encodeCaptureFrame(new Uint8Array(258).fill(9));
    expect(new DataView(enc.buffer).getUint32(0, true)).toBe(258);
    expect(enc.length).toBe(4 + 258);
  });

  it('stops cleanly at a truncated trailing frame (capture killed mid-write)', () => {
    const good = encodeCaptureFrame(new Uint8Array([1, 2, 3]));
    // A length prefix claiming 100 bytes but only 2 present.
    const truncatedPrefix = new Uint8Array(6);
    new DataView(truncatedPrefix.buffer).setUint32(0, 100, true);
    truncatedPrefix[4] = 0xff; truncatedPrefix[5] = 0xee;
    const decoded = decodeCaptureFrames(concat(good, truncatedPrefix));
    expect(decoded.map((f) => Array.from(f))).toEqual([[1, 2, 3]]);
  });

  it('returns no frames for empty / sub-header input', () => {
    expect(decodeCaptureFrames(new Uint8Array(0))).toEqual([]);
    expect(decodeCaptureFrames(new Uint8Array([1, 2, 3]))).toEqual([]); // < 4 bytes
  });

  it('treats a zero-length frame as the terminator', () => {
    const good = encodeCaptureFrame(new Uint8Array([7, 7]));
    const zero = new Uint8Array(4); // length 0
    const decoded = decodeCaptureFrames(concat(good, zero, good));
    expect(decoded.map((f) => Array.from(f))).toEqual([[7, 7]]);
  });
});
