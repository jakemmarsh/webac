/**
 * ASSESS: network hardening — OrderedPacketBuffer unit tests.
 *
 * Mirrors ACE's server-side reordering stage
 * (reference/ACE/Source/ACE.Server/Network/NetworkSession.cs ~336-397 +
 * CheckOutOfOrderPackets ~558-565): duplicates discarded, out-of-order packets
 * buffered and replayed strictly in order, with ACE's exact gating for seq-0
 * and ACK-only packets.
 */
import { describe, it, expect } from 'vitest';
import { OrderedPacketBuffer, MAX_OUT_OF_ORDER_BUFFER, MAX_SEQUENCE_WINDOW, PacketHeaderFlags } from '@ac/network';

const BLOB = PacketHeaderFlags.BlobFragments | PacketHeaderFlags.EncryptedChecksum;
const ACK = PacketHeaderFlags.AckSequence;

describe('OrderedPacketBuffer — in-order delivery', () => {
  it('starts expecting seq 2 (ACE NetworkSession.cs:57 — lastReceivedPacketSequence starts at 1)', () => {
    const buf = new OrderedPacketBuffer<string>();
    expect(buf.lastSequence).toBe(1);
    const r = buf.submit(2, BLOB, 'p2');
    expect(r.verdict).toBe('process');
    expect(r.ready).toEqual(['p2']);
  });

  it('processes consecutive sequences immediately', () => {
    const buf = new OrderedPacketBuffer<string>();
    expect(buf.submit(2, BLOB, 'p2').ready).toEqual(['p2']);
    expect(buf.submit(3, BLOB, 'p3').ready).toEqual(['p3']);
    expect(buf.submit(4, BLOB, 'p4').ready).toEqual(['p4']);
    expect(buf.lastSequence).toBe(4);
  });
});

describe('OrderedPacketBuffer — duplicates', () => {
  it('discards an immediate duplicate', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    const dup = buf.submit(2, BLOB, 'p2-again');
    expect(dup.verdict).toBe('duplicate');
    expect(dup.ready).toEqual([]);
  });

  it('discards a very old duplicate', () => {
    const buf = new OrderedPacketBuffer<string>();
    for (let s = 2; s <= 10; s++) buf.submit(s, BLOB, `p${s}`);
    expect(buf.submit(3, BLOB, 'p3-old').verdict).toBe('duplicate');
    expect(buf.lastSequence).toBe(10);
  });

  it('never deduplicates seq 0 (connect-phase packets)', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    expect(buf.submit(0, 0, 'c1').verdict).toBe('process');
    expect(buf.submit(0, 0, 'c2').verdict).toBe('process');
    // seq 0 never advances the sequence
    expect(buf.lastSequence).toBe(2);
  });

  it('allows an ACK-only packet repeating the current sequence (ACE FlushPackets reuses CurrentValue for ACKs)', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    const ack = buf.submit(2, ACK, 'ack2');
    expect(ack.verdict).toBe('process');
    expect(ack.ready).toEqual(['ack2']);
    expect(buf.lastSequence).toBe(2);
  });

  it('still discards a repeated-current-seq packet that is NOT ACK-only (exact flag equality, mirroring ACE)', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    expect(buf.submit(2, ACK | PacketHeaderFlags.TimeSync, 'x').verdict).toBe('duplicate');
  });

  it('ACK-only packets do not advance the expected sequence (ACE HandleOrderedPacket ~471-473)', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    expect(buf.submit(3, ACK, 'ack3').verdict).toBe('process');
    expect(buf.lastSequence).toBe(2);
    // The real data packet with seq 3 is still accepted afterwards
    expect(buf.submit(3, BLOB, 'p3').verdict).toBe('process');
    expect(buf.lastSequence).toBe(3);
  });
});

describe('OrderedPacketBuffer — out-of-order buffering + replay', () => {
  it('buffers a gap then replays in order when the gap fills', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    expect(buf.submit(4, BLOB, 'p4').verdict).toBe('buffered');
    expect(buf.submit(5, BLOB, 'p5').verdict).toBe('buffered');
    expect(buf.bufferedCount).toBe(2);
    const fill = buf.submit(3, BLOB, 'p3');
    expect(fill.verdict).toBe('process');
    expect(fill.ready).toEqual(['p3', 'p4', 'p5']);
    expect(buf.bufferedCount).toBe(0);
    expect(buf.lastSequence).toBe(5);
  });

  it('handles a fully reversed out-of-order burst', () => {
    const buf = new OrderedPacketBuffer<string>();
    for (let s = 6; s >= 3; s--) {
      expect(buf.submit(s, BLOB, `p${s}`).verdict).toBe('buffered');
    }
    const r = buf.submit(2, BLOB, 'p2');
    expect(r.ready).toEqual(['p2', 'p3', 'p4', 'p5', 'p6']);
  });

  it('ignores re-delivery of an already-buffered sequence (ACE outOfOrderPackets.ContainsKey gate)', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(4, BLOB, 'p4-first');
    buf.submit(4, BLOB, 'p4-second');
    expect(buf.bufferedCount).toBe(1);
    const r = buf.submit(2, BLOB, 'p2');
    expect(r.ready).toEqual(['p2']); // 3 still missing
    const fill = buf.submit(3, BLOB, 'p3');
    expect(fill.ready).toEqual(['p3', 'p4-first']);
  });

  it('bounds the out-of-order buffer: at most MAX_OUT_OF_ORDER_BUFFER, and nothing past the reorder window (ACE CryptoSystem MaximumEffortLevel = 256)', () => {
    const buf = new OrderedPacketBuffer<string>();
    expect(MAX_OUT_OF_ORDER_BUFFER).toBe(256);
    expect(MAX_SEQUENCE_WINDOW).toBe(256);
    for (let s = 10; s < 10 + 400; s++) buf.submit(s, BLOB, `p${s}`);
    // NET.ooo-overflow-acked-but-dropped — ACE DoRequestForRetransmission
    // treats a sequence > MaximumEffortLevel past the expected one as
    // abnormal; lastSequence is 1, so only 10..257 are kept.
    expect(buf.bufferedCount).toBeLessThanOrEqual(MAX_OUT_OF_ORDER_BUFFER);
    expect(buf.bufferedCount).toBe(257 - 10 + 1);
  });

  it("reports 'dropped' (not 'buffered') for a packet it did not keep, and keeps NAKing it", () => {
    const buf = new OrderedPacketBuffer<string>();
    const far = 1 + MAX_SEQUENCE_WINDOW + 1;
    expect(buf.submit(far, BLOB, 'far').verdict).toBe('dropped');
    expect(buf.has(far)).toBe(false);
    expect(buf.highestBufferedSequence).toBeNull();
    // Once the window reaches it, the same sequence is accepted normally.
    for (let s = 2; s < far; s++) buf.submit(s, BLOB, `p${s}`);
    expect(buf.submit(far, BLOB, 'far').verdict).toBe('process');
  });
});

describe('OrderedPacketBuffer — acceptGap (lost sequences)', () => {
  it('skips a lost sequence and releases buffered packets behind it', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    buf.submit(4, BLOB, 'p4');
    buf.submit(5, BLOB, 'p5');
    const ready = buf.acceptGap(3);
    expect(ready).toEqual(['p4', 'p5']);
    expect(buf.lastSequence).toBe(5);
  });

  it('delivers buffered packets inside the accepted range instead of discarding them', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    buf.submit(4, BLOB, 'p4'); // 3 lost, 4 received out of order
    const ready = buf.acceptGap(4);
    expect(ready).toEqual(['p4']);
    expect(buf.lastSequence).toBe(4);
  });

  it('is a no-op for already-passed sequences', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    expect(buf.acceptGap(2)).toEqual([]);
    expect(buf.lastSequence).toBe(2);
  });

  it('reset() restores initial state', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    buf.submit(9, BLOB, 'p9');
    buf.reset();
    expect(buf.lastSequence).toBe(1);
    expect(buf.bufferedCount).toBe(0);
  });
});

describe('OrderedPacketBuffer — receive-sequence authority (NET.ack-only-seq-marks-lost-received)', () => {
  it('missingSequences lists every sequence up to the bound that was not kept', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    buf.submit(4, BLOB, 'p4');
    buf.submit(7, BLOB, 'p7');
    expect(buf.highestBufferedSequence).toBe(7);
    expect(buf.missingSequences(7)).toEqual([3, 5, 6]);
    // an announced-but-unseen tail (the ACK-only CurrentValue case) counts too
    expect(buf.missingSequences(9)).toEqual([3, 5, 6, 8, 9]);
    expect(buf.missingSequences(9, 2)).toEqual([3, 5]);
    expect(buf.has(2)).toBe(true);
    expect(buf.has(4)).toBe(true);
    expect(buf.has(3)).toBe(false);
  });

  it('the gap scan never walks past the reorder window, whatever the bound (garbage sequence)', () => {
    const buf = new OrderedPacketBuffer<string>();
    const missing = buf.missingSequences(0xFFFFFFFF);
    expect(missing.length).toBe(MAX_SEQUENCE_WINDOW);
    expect(missing[missing.length - 1]).toBe(1 + MAX_SEQUENCE_WINDOW);
  });

  it('markLost skips exactly one sequence — never an earlier one still in flight', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    buf.submit(5, BLOB, 'p5');
    // 3 and 4 missing; the server rejects only 4
    expect(buf.markLost(4)).toEqual([]);
    expect(buf.lastSequence).toBe(2);
    expect(buf.missingSequences(5)).toEqual([3]);
    // 3's retransmit arrives: 3, then (4 lost) 5 are released
    const r = buf.submit(3, BLOB, 'p3');
    expect(r.ready).toEqual(['p3', 'p5']);
    expect(buf.lastSequence).toBe(5);
  });

  it('markLost of the next-expected sequence releases what was buffered behind it', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    buf.submit(4, BLOB, 'p4');
    buf.submit(5, BLOB, 'p5');
    expect(buf.markLost(3)).toEqual(['p4', 'p5']);
    expect(buf.lastSequence).toBe(5);
    expect(buf.missingSequences(5)).toEqual([]);
  });

  it('acceptGap on a huge sequence advances without walking every number', () => {
    const buf = new OrderedPacketBuffer<string>();
    buf.submit(2, BLOB, 'p2');
    buf.submit(4, BLOB, 'p4');
    expect(buf.acceptGap(0xFFFFFFF0)).toEqual(['p4']);
    expect(buf.lastSequence).toBe(0xFFFFFFF0);
  });
});
