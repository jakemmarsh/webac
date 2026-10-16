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
] as const;
/** Counters and sequence numbers: 0..2^32-1. */
export const NET_DIAG_COUNT_FIELDS = [
  'rxAck', 'rxHigh', 'rxHeld', 'rxMissing', 'fragHeld', 'naks', 'txSeq', 'txUnacked', 'txAckedBySrv',
  'srvNaks', 'resent', 'unsatisfied', 'srvRejects', 'wsBuffered', 'tickGapMaxMs', 'rxPkts', 'txPkts', 'rxBytes',
] as const;
/** Header flags / opcodes as "0x" + up to 8 hex digits. */
export const NET_DIAG_HEX_FIELDS = ['rxFlags', 'rxOpcode', 'rxEvent'] as const;

export type NetDiag = Partial<Record<
  typeof NET_DIAG_MS_FIELDS[number] | typeof NET_DIAG_COUNT_FIELDS[number] | typeof NET_DIAG_HEX_FIELDS[number],
  number | string | null
>>;

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
  return any ? out : null;
}

/** `{ net }` when the event carries valid diagnostics, else nothing (older pages send none). */
export function netDiagField(v: unknown): { net?: NetDiag } {
  const net = sanitizeNetDiag(v);
  return net ? { net } : {};
}
