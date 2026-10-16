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
const MS_KEYS = ['rxAgoMs', 'rxMsgAgoMs', 'rxSeqAgoMs', 'nakAgoMs', 'srvNakAgoMs', 'txAgoMs', 'txSeqAgoMs', 'tickAgoMs', 'snapAgeMs'] as const;
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
export function boundNetDiagnostics(d: unknown): Record<string, number | string | null> | null {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const src = d as Record<string, unknown>;
  const out: Record<string, number | string | null> = {};
  const clamp = (v: unknown, max: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : null;
  for (const k of MS_KEYS) if (k in src) out[k] = clamp(src[k], NET_DIAG_MAX_MS);
  for (const k of COUNT_KEYS) if (k in src) out[k] = clamp(src[k], NET_DIAG_MAX_COUNT);
  for (const k of HEX_KEYS) if (k in src) out[k] = typeof src[k] === 'string' && HEX_RE.test(src[k] as string) ? src[k] as string : null;
  return out;
}

/** The end causes whose telemetry carries the diagnostics: the session went silent (ours or the server's) or its socket closed under it. */
export const NET_DIAG_END_CAUSES: readonly string[] = ['link_dead', 'server_silent', 'client_suspended', 'socket_closed'];
