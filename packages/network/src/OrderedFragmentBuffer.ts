/**
 * OrderedFragmentBuffer — sequence-ordered delivery of reassembled fragment
 * messages, independent of the outer packet-sequence ordering already
 * enforced by OrderedPacketBuffer.
 *
 * ACE enforces two nested monotonic ordering streams before dispatching a
 * message to game logic: outer packet-sequence (OrderedPacketBuffer) and this
 * inner per-message fragment-sequence. Packet-sequence order alone doesn't
 * guarantee fragment-sequence order: ACE's SendBundle packs a bundle's queued
 * messages across packets by best-effort size (NetworkSession.cs:897-929,
 * non-UIQueue path), so a later/smaller message can land in an earlier packet
 * than a still-incomplete larger message from the same bundle.
 *
 * Ported from reference/ACE/Source/ACE.Server/Network/NetworkSession.cs:
 *   - lastReceivedFragmentSequence / outOfOrderFragments fields (~43,58)
 *   - ProcessFragment's ordering gate                           (~547-563)
 *   - HandleFragment (dispatch + advance)                       (~566-574)
 *   - CheckOutOfOrderFragments replay                            (~592-600)
 *
 * INITIAL_SEQUENCE: ACE's SendBundle stamps the first-ever fragment sent on a
 * session with sequence 0 (ConnectionData.FragmentSequence++, a uint
 * defaulting to 0, read then post-incremented) — confirmed against a real
 * captured ACE session (tests/fixtures/ac-session-001.bin: the first
 * BlobFragments fragment is fragSeq=0). So the expected-next value starts one
 * below that.
 */

const INITIAL_SEQUENCE = -1;

/**
 * NET.giveup-evict-no-fragment-unstick — backstop bound on messages held
 * behind a fragment gap. ACE's outOfOrderFragments is unbounded; a gap that
 * can never fill (its message rode a permanently lost packet) would grow this
 * forever. Past the cap the gate skips forward to the lowest held message
 * rather than dropping newer ones (ClientConnection normally unsticks the
 * gate long before — see its fragment-stall check).
 */
export const MAX_BUFFERED_FRAGMENT_MESSAGES = 4096;

/** 'stale' — the sequence is at or behind the gate (already delivered or
 *  skipped as lost); the message is dropped, never stored. */
export type OrderedFragmentVerdict = 'process' | 'buffered' | 'stale';

export interface OrderedFragmentResult<T> {
  verdict: OrderedFragmentVerdict;
  /** Messages now dispatchable, strictly in fragment-sequence order (the
   *  submitted message first if it was in order, then any buffered messages
   *  it unblocked). Empty unless verdict is 'process'. */
  ready: T[];
}

export class OrderedFragmentBuffer<T> {
  private lastReceivedSequence = INITIAL_SEQUENCE;
  private outOfOrder: Map<number, T> = new Map();
  /** Sequences declared lost (skip) that the gate has not reached yet. */
  private skipped: Set<number> = new Set();
  /** adoptFirstSequence ran this session. */
  private baselineAdopted = false;

  get lastSequence(): number {
    return this.lastReceivedSequence;
  }

  get bufferedCount(): number {
    return this.outOfOrder.size;
  }

  /** The lowest fragment sequence currently stuck waiting on a predecessor
   *  that hasn't arrived, or null if nothing is buffered. */
  get lowestBufferedSequence(): number | null {
    if (this.outOfOrder.size === 0) return null;
    return Math.min(...this.outOfOrder.keys());
  }

  reset(): void {
    this.baselineAdopted = false;
    this.lastReceivedSequence = INITIAL_SEQUENCE;
    this.outOfOrder.clear();
    this.skipped.clear();
  }

  /**
   * Start the gate at the session's first fragment sequence instead of
   * assuming 0. Called once with the lowest fragment sequence in the first
   * packet that carries fragments. GDLE pre-increments its counter
   * (PacketController.cpp: `dwFragSequence = ++m_out.fragment_counter`) and
   * its first fragment is 2, so the gate waited for 0 and 1, which never
   * come, and every login stalled FRAGMENT_STALL_MS before the character
   * list appeared. Retail has no fragment-order gate at all
   * (PacketController::AddReceivedBlobToQueue @ 00541490 queues each
   * completed blob by queue id), so starting later rejects nothing retail
   * would accept.
   *
   * Applies only when that lowest sequence is 2 or more. ACE numbers its
   * first fragment 0, and an empty first packet always takes the first chunk
   * of message 0, so ACE's first packet starts at 0 and this never fires.
   * A first packet starting at 1 still waits for 0: that is the
   * swapped-first-pair shape ACE's best-effort packing is modelled with.
   * Returns whether it applied.
   */
  adoptFirstSequence(seq: number): boolean {
    if (this.baselineAdopted) return false;
    this.baselineAdopted = true;
    if (this.lastReceivedSequence !== INITIAL_SEQUENCE || this.outOfOrder.size > 0 || this.skipped.size > 0) return false;
    if (!Number.isInteger(seq) || seq < 2) return false;
    this.lastReceivedSequence = seq - 1;
    return true;
  }

  /**
   * Submit a fully-reassembled message tagged with its fragment sequence
   * (ACE ProcessFragment's ordering gate, ~547-563).
   */
  submit(seq: number, message: T): OrderedFragmentResult<T> {
    // At or behind the gate: delivered already, or skipped as lost. Storing it
    // would leak — drainInto only ever looks forward.
    if (seq <= this.lastReceivedSequence) {
      return { verdict: 'stale', ready: [] };
    }
    if (seq !== this.lastReceivedSequence + 1) {
      this.outOfOrder.set(seq, message);
      if (this.outOfOrder.size > MAX_BUFFERED_FRAGMENT_MESSAGES) {
        const lowest = this.lowestBufferedSequence!;
        return { verdict: 'process', ready: this.acceptGap(lowest) };
      }
      return { verdict: 'buffered', ready: [] };
    }

    const ready: T[] = [message];
    this.lastReceivedSequence = seq;
    this.drainInto(ready);
    return { verdict: 'process', ready };
  }

  /**
   * Accept a permanently-lost fragment sequence and skip past it, releasing
   * any buffered messages behind it. No ACE-side equivalent exists for this
   * inner stream specifically (NetworkSession.cs never recovers a fragment
   * gap on its own) — this mirrors OrderedPacketBuffer.acceptGap, called when
   * the OUTER packet-sequence gap containing the missing fragment has itself
   * been declared unrecoverable (server RejectRetransmit — NetworkSession.cs
   * ~283-310). Without this, a packet permanently lost mid-bundle would leave
   * every fragment after it buffered forever.
   */
  acceptGap(seq: number): T[] {
    const ready: T[] = [];
    if (seq <= this.lastReceivedSequence) return ready;
    // Walk only the held keys (not every number in between) — the range can
    // be arbitrarily wide when a sequence on the wire is garbage.
    const held = [...this.outOfOrder.keys()].filter(k => k <= seq).sort((a, b) => a - b);
    for (const k of held) {
      ready.push(this.outOfOrder.get(k)!);
      this.outOfOrder.delete(k);
    }
    this.lastReceivedSequence = seq;
    this.drainInto(ready);
    return ready;
  }

  /**
   * Declare exactly one fragment sequence permanently lost — its partial
   * message was evicted (FragmentAssembler.evictStale) and can never
   * complete. Earlier sequences still pending are not skipped. Returns any
   * held messages the skip releases, in order.
   */
  skip(seq: number): T[] {
    const ready: T[] = [];
    if (seq <= this.lastReceivedSequence) return ready;
    this.outOfOrder.delete(seq);
    this.skipped.add(seq);
    this.drainInto(ready);
    return ready;
  }

  /** ACE CheckOutOfOrderFragments (NetworkSession.cs ~592-600). */
  private drainInto(ready: T[]): void {
    let next = this.lastReceivedSequence + 1;
    for (;;) {
      if (this.outOfOrder.has(next)) {
        const message = this.outOfOrder.get(next)!;
        this.outOfOrder.delete(next);
        ready.push(message);
      } else if (!this.skipped.delete(next)) {
        break;
      }
      this.lastReceivedSequence = next;
      next = this.lastReceivedSequence + 1;
    }
    // Forget skip marks the gate has passed (acceptGap can jump over them).
    for (const s of this.skipped) if (s <= this.lastReceivedSequence) this.skipped.delete(s);
  }
}
