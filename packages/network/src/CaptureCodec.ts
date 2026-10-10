/**
 * CaptureCodec — a trivial length-prefixed container for recording the raw
 * inbound (server→client) packet frames of a real ACE session so they can be
 * replayed deterministically through ClientConnection → ServerMessageHandler
 * in tests.
 *
 * ASSESS (2026-06-10 fresh-eyes audit, testing recommendation #2): the wire
 * layer had only hand-built single-message tests, so whole-handler regressions
 * (e.g. the FAITHFUL.331–337 alignment bugs) slipped through. A corpus of real
 * ACE bytes replayed through the real handler gives behavioral coverage of
 * every parser path at once — a parser break throws or changes the parsed
 * event sequence, which the replay snapshot catches.
 *
 * Format (little-endian): a sequence of frames, each:
 *   [u32 byteLength][byteLength bytes of the raw packet]
 * Each frame is exactly one datagram as the WebSocket client received it
 * (= exactly what ClientConnection.handlePacket consumes). The bridge writes
 * these in arrival order when BRIDGE_CAPTURE=<file> is set.
 */

/** Encode one packet frame: u32 length prefix + bytes. */
export function encodeCaptureFrame(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + frame.length);
  new DataView(out.buffer).setUint32(0, frame.length, true);
  out.set(frame, 4);
  return out;
}

/**
 * Decode a capture buffer back into its ordered frames. Tolerates a truncated
 * trailing frame (a capture killed mid-write) by stopping cleanly.
 */
export function decodeCaptureFrames(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset + 4 <= data.length) {
    const len = view.getUint32(offset, true);
    offset += 4;
    if (len === 0 || offset + len > data.length) break; // truncated/garbage tail
    frames.push(data.subarray(offset, offset + len));
    offset += len;
  }
  return frames;
}
