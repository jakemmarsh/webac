/**
 * OrderedPacketBuffer — sequence-ordered, deduplicated packet delivery.
 *
 * ASSESS: mirror of ACE's server-side reordering stage so the browser client
 * survives real-network reordering/duplication instead of processing packets
 * in arrival order. Ported from
 * reference/ACE/Source/ACE.Server/Network/NetworkSession.cs:
 *   - duplicate discard gate           (~lines 336-346)
 *   - out-of-order buffering           (~lines 348-363)
 *   - CheckOutOfOrderPackets replay    (~lines 558-565)
 *   - sequence advance gating          (~lines 471-473 in HandleOrderedPacket)
 *
 * ACE's exact gating rules (all mirrored here):
 *   - seq 0 packets are NEVER deduplicated or buffered (several seq-0 packets
 *     occur during connect; CICMDCommand can arrive seq 0 at any point).
 *   - a packet whose flags are EXACTLY AckSequence may repeat the current
 *     sequence (ACE FlushPackets reuses the current sequence for ACK-only
 *     packets — NetworkSession.cs ~721-723).
 *   - processing a packet advances the expected sequence only when seq != 0
 *     and flags !== AckSequence (exact equality, not hasFlag).
 *
 * NET.ack-only-seq-marks-lost-received — this buffer is the client's ONE
 * receive-sequence authority: a packet counts as received only once it is
 * kept here (processed, or buffered out of order). ClientConnection derives
 * both its ACK value (lastSequence) and its NAK list (missingSequences) from
 * it, so a packet this buffer drops (window/capacity overflow —
 * NET.ooo-overflow-acked-but-dropped) is by construction never ACKed and
 * will be NAKed again.
 */

import { PacketHeaderFlags } from './PacketHeaderFlags.js';

/** 'dropped' — out of the reorder window or the buffer is full; the packet
 *  was NOT kept, so it is still missing and will be re-requested. */
export type OrderedPacketVerdict = 'process' | 'duplicate' | 'buffered' | 'dropped';

export interface OrderedPacketResult<T> {
  verdict: OrderedPacketVerdict;
  /** Packets now processable, strictly in sequence order (submitted packet
   *  first, then any buffered packets unblocked by it). Empty unless verdict
   *  is 'process'. */
  ready: T[];
}

/** ACE NetworkSession.cs:57 — lastReceivedPacketSequence starts at 1; the
 *  peer's first real packet is seq 2 (seq 1 is never sent). */
const INITIAL_SEQUENCE = 1;

/** ACE CryptoSystem.cs:8 MaximumEffortLevel = 256 — ACE terminates the session
 *  when a gap exceeds this (AbnormalSequenceReceived). We can't terminate the
 *  server, so we use it as a sanity cap on the out-of-order buffer. */
export const MAX_OUT_OF_ORDER_BUFFER = 256;

/** ACE NetworkSession DoRequestForRetransmission: a received sequence more
 *  than CryptoSystem.MaximumEffortLevel (256) past the expected one is
 *  abnormal (AbnormalSequenceReceived). Packets beyond this window are not
 *  kept, and gap scans never look past it — a garbage sequence can't make a
 *  scan walk billions of numbers. */
export const MAX_SEQUENCE_WINDOW = 256;

interface BufferedPacket<T> {
  flags: number;
  packet: T;
}

export class OrderedPacketBuffer<T> {
  private lastReceivedSequence = INITIAL_SEQUENCE;
  private outOfOrder: Map<number, BufferedPacket<T>> = new Map();
  /** Sequences declared permanently lost (markLost) that the in-order
   *  cursor has not reached yet. */
  private lost: Set<number> = new Set();

  get lastSequence(): number {
    return this.lastReceivedSequence;
  }

  get bufferedCount(): number {
    return this.outOfOrder.size;
  }

  /** Highest sequence currently held out of order, or null if none. */
  get highestBufferedSequence(): number | null {
    let max: number | null = null;
    for (const k of this.outOfOrder.keys()) if (max === null || k > max) max = k;
    return max;
  }

  /** True if this sequence has been kept (already processed, or buffered). */
  has(seq: number): boolean {
    return seq <= this.lastReceivedSequence || this.outOfOrder.has(seq);
  }

  /**
   * Sequences after lastSequence, up to and including `upTo`, that were not
   * kept and not declared lost — the NAK list. The scan never looks past
   * lastSequence + MAX_SEQUENCE_WINDOW and stops after `limit` entries.
   */
  missingSequences(upTo: number, limit: number = Number.POSITIVE_INFINITY): number[] {
    const out: number[] = [];
    const top = Math.min(upTo, this.lastReceivedSequence + MAX_SEQUENCE_WINDOW);
    for (let s = this.lastReceivedSequence + 1; s <= top && out.length < limit; s++) {
      if (!this.outOfOrder.has(s) && !this.lost.has(s)) out.push(s);
    }
    return out;
  }

  reset(): void {
    this.lastReceivedSequence = INITIAL_SEQUENCE;
    this.outOfOrder.clear();
    this.lost.clear();
  }

  /**
   * Submit a received packet. Returns the verdict plus the in-order list of
   * packets the caller should process now.
   */
  submit(seq: number, flags: number, packet: T): OrderedPacketResult<T> {
    // Duplicate gate — ACE NetworkSession.cs ~336-346
    if (
      seq <= this.lastReceivedSequence && seq !== 0 &&
      !(flags === PacketHeaderFlags.AckSequence && seq === this.lastReceivedSequence)
    ) {
      return { verdict: 'duplicate', ready: [] };
    }

    // Out-of-order gate — ACE NetworkSession.cs ~348-363
    if (seq > this.lastReceivedSequence + 1) {
      if (this.outOfOrder.has(seq)) return { verdict: 'buffered', ready: [] };
      if (
        seq - this.lastReceivedSequence > MAX_SEQUENCE_WINDOW ||
        this.outOfOrder.size >= MAX_OUT_OF_ORDER_BUFFER
      ) {
        // Not kept → not received: it stays in missingSequences and is NAKed.
        return { verdict: 'dropped', ready: [] };
      }
      this.outOfOrder.set(seq, { flags, packet });
      this.lost.delete(seq); // a "lost" packet that turned up after all
      return { verdict: 'buffered', ready: [] };
    }

    // In-order — process, then replay any buffered packets now unblocked
    const ready: T[] = [packet];
    this.advance(seq, flags);
    this.drainInto(ready);
    return { verdict: 'process', ready };
  }

  /**
   * Accept a permanently-lost sequence (server sent RejectRetransmit) so
   * ordered delivery can move past the gap. Returns any
   * buffered packets that become processable, in order.
   */
  acceptGap(seq: number): T[] {
    const ready: T[] = [];
    if (seq <= this.lastReceivedSequence) return ready;
    // The "lost" range may contain packets we actually have — deliver them
    // rather than discarding them. Walk only the held keys, never every
    // number in the range (a garbage sequence can make it arbitrarily wide).
    const held = [...this.outOfOrder.keys()].filter(k => k <= seq).sort((a, b) => a - b);
    for (const k of held) {
      ready.push(this.outOfOrder.get(k)!.packet);
      this.outOfOrder.delete(k);
    }
    // We're skipping this range either way (it was declared lost), so
    // advance unconditionally — the ACK-only gate doesn't apply here.
    this.lastReceivedSequence = seq;
    for (const s of this.lost) if (s <= seq) this.lost.delete(s);
    this.drainInto(ready);
    return ready;
  }

  /**
   * Declare exactly one sequence permanently lost (server RejectRetransmit —
   * retail SharedNet::HandleEmptyAck @ 005448f0 drops it from the NAK set).
   * Unlike acceptGap, earlier sequences
   * still in flight are NOT skipped. Returns any buffered packets the skip
   * releases, in order.
   */
  markLost(seq: number): T[] {
    const ready: T[] = [];
    if (seq <= this.lastReceivedSequence || this.outOfOrder.has(seq)) return ready;
    if (seq - this.lastReceivedSequence > MAX_SEQUENCE_WINDOW) return ready;
    this.lost.add(seq);
    this.drainInto(ready);
    return ready;
  }

  /** ACE NetworkSession.cs ~471-473 — only non-zero, non-ACK-only packets
   *  advance lastReceivedPacketSequence. */
  private advance(seq: number, flags: number): void {
    if (seq !== 0 && flags !== PacketHeaderFlags.AckSequence) {
      this.lastReceivedSequence = seq;
      this.lost.delete(seq);
    }
  }

  /** ACE CheckOutOfOrderPackets (NetworkSession.cs ~558-565). */
  private drainInto(ready: T[]): void {
    let next = this.lastReceivedSequence + 1;
    for (;;) {
      const buffered = this.outOfOrder.get(next);
      if (buffered) {
        this.outOfOrder.delete(next);
        ready.push(buffered.packet);
        this.advance(next, buffered.flags);
        // An ACK-only packet doesn't advance the sequence; the map entry is
        // already removed, so the loop terminates (same as ACE's TryRemove loop).
        if (this.lastReceivedSequence !== next) break;
      } else if (this.lost.delete(next)) {
        this.lastReceivedSequence = next;
      } else {
        break;
      }
      next = this.lastReceivedSequence + 1;
    }
  }
}
