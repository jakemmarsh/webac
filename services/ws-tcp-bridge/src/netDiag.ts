/**
 * OBS.dm-stall-diagnostics — the connection diagnostics a page attaches to a
 * session that went silent or lost its socket (renderer WorldReporter /
 * PreworldReporter `net`, built from @ac/network NetDiagnostics.ts).
 *
 * Privacy: sequence numbers, counters, "ms ago" times and hex header codes
 * only. Every field is checked against its bound here; unknown fields and
 * anything out of bounds are dropped, so nothing else can reach the log.
 */

/** "ms ago" fields: 0..7 days, or null (never). */
export const NET_DIAG_MS_FIELDS = [
  'rxAgoMs', 'rxMsgAgoMs', 'rxSeqAgoMs', 'nakAgoMs', 'srvNakAgoMs', 'txAgoMs', 'txSeqAgoMs', 'tickAgoMs', 'snapAgeMs',
  'srvAckAgoMs', 'srvAckAdvAgoMs',
] as const;
/** Counters and sequence numbers: 0..2^32-1. */
export const NET_DIAG_COUNT_FIELDS = [
  'rxAck', 'rxHigh', 'rxHeld', 'rxMissing', 'fragHeld', 'naks', 'txSeq', 'txUnacked', 'txAckedBySrv',
  'srvNaks', 'resent', 'unsatisfied', 'srvRejects', 'wsBuffered', 'tickGapMaxMs', 'rxPkts', 'txPkts', 'rxBytes',
] as const;
/** Header flags / opcodes as "0x" + up to 8 hex digits. */
export const NET_DIAG_HEX_FIELDS = ['rxFlags', 'rxOpcode', 'rxEvent'] as const;

/**
 * OBS.dm-stall-tx-ring — our last sequenced packets (at most NET_DIAG_TX_RING):
 * sequence, header flags (hex), what they carried (hex opcodes / fixed names) and age.
 */
export const NET_DIAG_TX_RING = 8;
const WHAT = /^[a-z0-9:+.-]{1,48}$/;
export type NetTxRecord = { seq: number; flags: string; what: string; agoMs: number };

export type NetDiag = Partial<Record<
  typeof NET_DIAG_MS_FIELDS[number] | typeof NET_DIAG_COUNT_FIELDS[number] | typeof NET_DIAG_HEX_FIELDS[number],
  number | string | null
>> & { txRecent?: NetTxRecord[] };

const MAX_MS = 7 * 24 * 3600_000;
const MAX_COUNT = 0xffffffff;
const HEX = /^0x[0-9a-f]{1,8}$/;

function uint(v: unknown, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

/** The validated diagnostics, or null when `v` is not an object or carries no known field. */
export function sanitizeNetDiag(v: unknown): NetDiag | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  const out: NetDiag = {};
  let any = false;
  for (const k of NET_DIAG_MS_FIELDS) if (k in b) { out[k] = uint(b[k], MAX_MS); any = true; }
  for (const k of NET_DIAG_COUNT_FIELDS) if (k in b) { out[k] = uint(b[k], MAX_COUNT); any = true; }
  for (const k of NET_DIAG_HEX_FIELDS) if (k in b) { out[k] = typeof b[k] === 'string' && HEX.test(b[k] as string) ? b[k] as string : null; any = true; }
  if (Array.isArray(b.txRecent)) {
    any = true;
    const recs: NetTxRecord[] = [];
    for (const r of b.txRecent.slice(-NET_DIAG_TX_RING)) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const x = r as Record<string, unknown>;
      const seq = uint(x.seq, MAX_COUNT);
      const agoMs = uint(x.agoMs, MAX_MS);
      if (seq === null || agoMs === null) continue;
      if (typeof x.flags !== 'string' || !HEX.test(x.flags) || typeof x.what !== 'string' || !WHAT.test(x.what)) continue;
      recs.push({ seq, flags: x.flags, what: x.what, agoMs });
    }
    out.txRecent = recs;
  }
  return any ? out : null;
}

/** `{ net }` when the event carries valid diagnostics, else nothing (older pages send none). */
export function netDiagField(v: unknown): { net?: NetDiag } {
  const net = sanitizeNetDiag(v);
  return net ? { net } : {};
}
