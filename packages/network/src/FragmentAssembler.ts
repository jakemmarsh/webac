/**
 * FragmentAssembler — accumulates multi-fragment messages until complete.
 *
 * ASSESS: extracted from ClientConnection.handleFragment so the dedup/eviction
 * behavior is unit-testable. Mirrors ACE's MessageBuffer semantics
 * (reference/ACE/Source/ACE.Server/Network/MessageBuffer.cs:22-30 —
 * AddFragment ignores a fragment whose Index is already buffered, instead of
 * double-counting it toward completion). Pre-fix, a duplicated fragment made
 * fragments.length hit header.count early, reassembly returned null, and the
 * whole message was unrecoverably dropped.
 *
 * Stale-entry eviction has no ACE equivalent (ACE clears partialFragments only
 * on session release) — it's a leak guard for fragments lost permanently on a
 * real network.
 */

import { Fragment, reassembleFragments } from './PacketFragment.js';

interface PendingMessage {
  fragments: Fragment[];
  /** Timestamp (ms) when the first fragment arrived. */
  firstSeenAt: number;
}

export class FragmentAssembler {
  private pending: Map<number, PendingMessage> = new Map();

  get pendingCount(): number {
    return this.pending.size;
  }

  reset(): void {
    this.pending.clear();
  }

  /**
   * Add a fragment of a multi-fragment message (header.count > 1).
   * Returns the reassembled message payload once all fragments have arrived,
   * or null while the message is still incomplete.
   */
  add(fragment: Fragment, now: number = Date.now()): Uint8Array | null {
    // BUG.8 — key partials by fragment SEQUENCE, not id. ACE stamps every
    // server fragment with the constant Id 0x80000000 (MessageFragment.cs:94);
    // the per-message discriminator is Header.Sequence
    // (ConnectionData.FragmentSequence++, NetworkSession.cs:821), and ACE's
    // own receive side buckets partials by it (NetworkSession.cs:495).
    // Pre-fix, ALL in-flight multi-fragment messages shared the 0x80000000
    // bucket: a second message's index-0 was "dedup"-dropped against the
    // first message's, counts cross-checked against the wrong message, and
    // the mixed bucket could either complete with corrupted spliced payloads
    // or sit incomplete forever (the live "[AC:FRAG] Evicting stale partial
    // message id=2147483648" observed 2026-07-04).
    const key = fragment.header.sequence;
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { fragments: [], firstSeenAt: now };
      this.pending.set(key, entry);
    }

    // ACE MessageBuffer.cs:27 — ignore duplicate indices
    if (entry.fragments.some(f => f.header.index === fragment.header.index)) {
      return null;
    }
    entry.fragments.push(fragment);

    if (entry.fragments.length !== fragment.header.count) return null;

    this.pending.delete(key);
    return reassembleFragments(entry.fragments);
  }

  /**
   * NET.giveup-evict-no-fragment-unstick — drop partial messages at or below
   * a fragment sequence the ordering gate has already moved past: they can
   * never be delivered in order, so holding their chunks only leaks.
   * Returns the discarded sequences.
   */
  discardThrough(seq: number): number[] {
    const discarded: number[] = [];
    for (const key of this.pending.keys()) {
      if (key <= seq) {
        discarded.push(key);
        this.pending.delete(key);
      }
    }
    return discarded;
  }

  /**
   * Drop pending messages whose first fragment is older than maxAgeMs.
   * Returns the evicted fragment sequences — the caller must also tell its
   * fragment-ordering gate (OrderedFragmentBuffer.skip) that they will never
   * complete, or every later message stays held behind them.
   */
  evictStale(maxAgeMs: number, now: number = Date.now()): number[] {
    const evicted: number[] = [];
    for (const [id, entry] of this.pending) {
      if (now - entry.firstSeenAt > maxAgeMs) {
        evicted.push(id);
        this.pending.delete(id);
      }
    }
    return evicted;
  }
}
