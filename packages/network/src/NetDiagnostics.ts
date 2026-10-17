/**
 * OBS.dm-stall-diagnostics — a compact snapshot of a session connection's
 * sequencing state, for the session that went silent.
 *
 * Dark Majesty players (GDLE servers) had in-world sessions go quiet a few
 * minutes in: the page's 40 s DISCONNECT_TIME check fired (endCause
 * link_dead) with the bridge socket still open, and nothing said whether the
 * server stopped sending, we stopped sending, or a sequence gap stalled
 * delivery. Both connections (ClientConnection for end of retail and the
 * classic servers, Connection1999 for AC1999) answer getDiagnostics() with
 * this shape; the network worker ships it with every snapshot, and the page
 * attaches it to the telemetry of a session that ended link_dead /
 * server_silent / client_suspended / socket_closed and logs it to the console on link_dead.
 *
 * Every field is a bounded integer or a hex code (no packet contents):
 * times are "ms ago" at the moment it was sampled (null = never), counters
 * are this session's totals.
 */
export interface NetDiagnostics {
  /** Since the last server packet of any kind (null: none this session). */
  rxAgoMs: number | null;
  /** Since the last game message from the server was dispatched (vs acks / time syncs only). */
  rxMsgAgoMs: number | null;
  /** Since the last in-order sequenced server packet was processed. */
  rxSeqAgoMs: number | null;
  /** The last server packet's header flags, hex ("0x00004000" = an ACK alone). */
  rxFlags: string | null;
  /** The last dispatched game message's opcode, hex; rxEvent: its game event type when the opcode is 0xF7B0. */
  rxOpcode: string | null;
  rxEvent: string | null;
  /** The server sequence delivered in order (what we ACK). */
  rxAck: number;
  /** The highest server sequence seen or announced (an ACK-only packet's stamp). */
  rxHigh: number;
  /** Server packets held out of order behind a gap, and the sequences still missing (NAK list, capped). */
  rxHeld: number;
  rxMissing: number;
  /** Messages the fragment gate holds plus partial multi-fragment messages. */
  fragHeld: number;
  /** Since we last asked the server to resend (RequestRetransmit), and how many such requests this session. */
  nakAgoMs: number | null;
  naks: number;
  /** Our last client→server sequence, our sequenced packets the server has not ACKed (retransmit cache), and its last ACK of ours. */
  txSeq: number;
  txUnacked: number;
  txAckedBySrv: number;
  /** Since the server last asked us to resend, and the sequences it asked for in total. */
  srvNakAgoMs: number | null;
  srvNaks: number;
  /** Packets we resent, and server-requested sequences we could not resend (RejectRetransmit sent). */
  resent: number;
  unsatisfied: number;
  /** Server sequences the server said it could not resend (RejectRetransmit / deny received). */
  srvRejects: number;
  /** Since our last packet of any kind, and our last sequenced packet (GDLE counts only those as alive). */
  txAgoMs: number | null;
  txSeqAgoMs: number | null;
  /** WebSocket bytes queued and not yet sent (a backed-up socket). */
  wsBuffered: number;
  /** Since the connection's service tick last ran, and its longest gap this session (a stalled worker clock). */
  tickAgoMs: number | null;
  tickGapMaxMs: number;
  /** Packets received / sent and bytes received this session. */
  rxPkts: number;
  txPkts: number;
  rxBytes: number;
  /** Page side only: how old the worker's snapshot was when the page read it (null in-thread). */
  snapAgeMs?: number | null;
  /**
   * OBS.dm-stall-tx-ring — since the server's last ACK of our packets
   * arrived, and since that ACK last moved forward. A server still ACKing an
   * old value (srvAckAgoMs small, srvAckAdvAgoMs large) is alive but not
   * taking our packets; one silent on both stopped altogether.
   */
  srvAckAgoMs?: number | null;
  srvAckAdvAgoMs?: number | null;
  /** Our last NET_DIAG_TX_RING sequenced packets, oldest first (TxRing). */
  txRecent?: NetTxRecord[];
}

/** One sequenced client packet in the diagnostics ring. */
export interface NetTxRecord {
  seq: number;
  /** Header flags, hex. */
  flags: string;
  /**
   * What it carried: the opcode of each message starting in it
   * ("f7b1:0008" = a GameAction and its action type), "cont" for a later
   * piece of a split message, or the optional headers ("ts+echo").
   */
  what: string;
  /** How long ago it went out. */
  agoMs: number;
}

/** How many sequenced packets the ring keeps (small: it rides on telemetry). */
export const NET_DIAG_TX_RING = 8;
/** A record's `what`: lowercase hex opcodes, names and separators, bounded. */
export const NET_DIAG_WHAT_RE = /^[a-z0-9:+.-]{1,48}$/;

/**
 * The label for one message (its first bytes): "f7b1:<action>" for a
 * GameAction (opcode, sequence, action type), else the opcode, as hex.
 */
export function messageLabel(bytes: Uint8Array): string {
  if (bytes.length < 4) return 'short';
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const op = v.getUint32(0, true);
  const hex = (n: number, w: number) => (n >>> 0).toString(16).padStart(w, '0');
  if (op === 0xf7b1 && bytes.length >= 12) return `f7b1:${hex(v.getUint32(8, true), 4)}`;
  return hex(op, 4);
}

/** Labels joined with "+", cut to fit NET_DIAG_WHAT_RE's length. */
export function joinLabels(labels: readonly string[]): string {
  const s = labels.join('+') || 'empty';
  return s.length <= 48 ? s : `${s.slice(0, 46)}+.`;
}

/**
 * OBS.dm-stall-tx-ring — the last few sequenced packets we sent and the
 * server's ACKs of them, for the session that went silent: which packet the
 * server stopped acknowledging, what it carried, and whether the server was
 * still ACKing (an old value) when it stopped taking ours.
 */
export class TxRing {
  private readonly ring: Array<{ seq: number; flags: number; what: string; at: number }> = [];
  private ackAt = 0;
  private ackAdvAt = 0;
  private ackValue = 0;

  /** A packet with a fresh client sequence went out. */
  sent(seq: number, flags: number, what: string, now: number): void {
    this.ring.push({ seq, flags, what, at: now });
    if (this.ring.length > NET_DIAG_TX_RING) this.ring.shift();
  }

  /** The server acknowledged our packets through `seq`. */
  serverAck(seq: number, now: number): void {
    this.ackAt = now;
    if (seq > this.ackValue) { this.ackValue = seq; this.ackAdvAt = now; }
  }

  reset(): void {
    this.ring.length = 0;
    this.ackAt = this.ackAdvAt = this.ackValue = 0;
  }

  /** The ring's NetDiagnostics fields at `now`. */
  snapshot(now: number): Pick<NetDiagnostics, 'srvAckAgoMs' | 'srvAckAdvAgoMs' | 'txRecent'> {
    return {
      srvAckAgoMs: msAgo(now, this.ackAt),
      srvAckAdvAgoMs: msAgo(now, this.ackAdvAt),
      txRecent: this.ring.map((r) => ({
        seq: r.seq, flags: hex32(r.flags) ?? '0x00000000', what: r.what, agoMs: Math.max(0, Math.round(now - r.at)),
      })),
    };
  }
}

/** The longest "ms ago" / gap kept (7 days); anything beyond reads as this. */
export const NET_DIAG_MAX_MS = 7 * 24 * 3600_000;
/** The largest counter or sequence kept. */
export const NET_DIAG_MAX_COUNT = 0xffffffff;

/** `v` as "0x" + 8 hex digits (a u32), or null. */
export function hex32(v: number | null | undefined): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
}

/** ms from `at` to `now`, or null when `at` is 0 / unset. */
export function msAgo(now: number, at: number): number | null {
  return at > 0 ? Math.max(0, Math.round(now - at)) : null;
}

const HEX_RE = /^0x[0-9a-f]{1,8}$/;
const MS_KEYS = [
  'rxAgoMs', 'rxMsgAgoMs', 'rxSeqAgoMs', 'nakAgoMs', 'srvNakAgoMs', 'txAgoMs', 'txSeqAgoMs', 'tickAgoMs', 'snapAgeMs',
  'srvAckAgoMs', 'srvAckAdvAgoMs',
] as const;
const COUNT_KEYS = [
  'rxAck', 'rxHigh', 'rxHeld', 'rxMissing', 'fragHeld', 'naks', 'txSeq', 'txUnacked', 'txAckedBySrv',
  'srvNaks', 'resent', 'unsatisfied', 'srvRejects', 'wsBuffered', 'tickGapMaxMs', 'rxPkts', 'txPkts', 'rxBytes',
] as const;
const HEX_KEYS = ['rxFlags', 'rxOpcode', 'rxEvent'] as const;

/**
 * A copy of `d` with only the known fields, each clamped to its bounds
 * (ms 0..NET_DIAG_MAX_MS, counters 0..NET_DIAG_MAX_COUNT, hex /^0x[0-9a-f]{1,8}$/);
 * null when `d` is not an object. What telemetry sends.
 */
export function boundNetDiagnostics(d: unknown): Record<string, number | string | null | BoundTxRecord[]> | null {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const src = d as Record<string, unknown>;
  const out: Record<string, number | string | null | BoundTxRecord[]> = {};
  const clamp = (v: unknown, max: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : null;
  for (const k of MS_KEYS) if (k in src) out[k] = clamp(src[k], NET_DIAG_MAX_MS);
  for (const k of COUNT_KEYS) if (k in src) out[k] = clamp(src[k], NET_DIAG_MAX_COUNT);
  for (const k of HEX_KEYS) if (k in src) out[k] = typeof src[k] === 'string' && HEX_RE.test(src[k] as string) ? src[k] as string : null;
  if (Array.isArray(src.txRecent)) {
    const recs: BoundTxRecord[] = [];
    for (const r of src.txRecent.slice(-NET_DIAG_TX_RING)) {
      if (!r || typeof r !== 'object') continue;
      const x = r as Record<string, unknown>;
      const uint = (v: unknown, max: number): number | null =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
      const seq = uint(x.seq, NET_DIAG_MAX_COUNT);
      const agoMs = uint(x.agoMs, NET_DIAG_MAX_MS);
      const flags = typeof x.flags === 'string' && HEX_RE.test(x.flags) ? x.flags : null;
      const what = typeof x.what === 'string' && NET_DIAG_WHAT_RE.test(x.what) ? x.what : null;
      if (seq === null || agoMs === null || flags === null || what === null) continue;
      recs.push({ seq, flags, what, agoMs });
    }
    out.txRecent = recs;
  }
  return out;
}

/** A txRecent record as telemetry carries it. */
export type BoundTxRecord = { seq: number; flags: string; what: string; agoMs: number };

/** The end causes whose telemetry carries the diagnostics: the session went silent (ours or the server's) or its socket closed under it. */
export const NET_DIAG_END_CAUSES: readonly string[] = ['link_dead', 'server_silent', 'client_suspended', 'socket_closed'];
