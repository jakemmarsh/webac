/**
 * stream-gate — portal-space gate spans from the console lines that
 * tools/probe-dat-streaming.ts records (`<epoch ms> <console text>`).
 *
 * The gate is "holding for cell 0x…" → "released" (packages/renderer/src/main.ts,
 * the PortalSpaceGate hooks). That span is the number the streaming handoff
 * compares (docs/handoff-streaming-2026-10-05.md: real GPU cold / holtburg / warm
 * 1.21 / 0.93 / 0.54 s on main).
 */

export interface GateSpan {
  /** Destination cell id as logged (8 hex digits, lower case). */
  cell: string;
  /** Epoch ms of the "holding" line. */
  heldAt: number;
  /** Epoch ms of the "released" line, or null if the gate never released in these lines. */
  releasedAt: number | null;
  /** releasedAt - heldAt, or null. */
  ms: number | null;
  /** The gate's own resident/gave-up line between hold and release, if any. */
  outcome: 'resident' | 'gave up' | null;
}

const HOLD_RE = /portal-space gate: holding for cell 0x([0-9a-fA-F]{8})/;
const RELEASE_RE = /portal-space gate: released/;
const OUTCOME_RE = /portal-space gate: (resident|gave up)\b/;

/** Every gate span in `lines`, in order. A hold without a release closes at the next hold with ms null. */
export function gateSpans(lines: readonly string[]): GateSpan[] {
  const spans: GateSpan[] = [];
  let open: GateSpan | null = null;
  for (const line of lines) {
    const sp = line.indexOf(' ');
    const at = Number(line.slice(0, sp));
    if (!Number.isFinite(at)) continue;
    const text = line.slice(sp + 1);
    const hold = HOLD_RE.exec(text);
    if (hold) {
      if (open) spans.push(open);
      open = { cell: hold[1].toLowerCase(), heldAt: at, releasedAt: null, ms: null, outcome: null };
      continue;
    }
    if (!open) continue;
    const outcome = OUTCOME_RE.exec(text);
    if (outcome) { open.outcome = outcome[1] as GateSpan['outcome']; continue; }
    if (RELEASE_RE.test(text)) {
      open.releasedAt = at;
      open.ms = at - open.heldAt;
      spans.push(open);
      open = null;
    }
  }
  if (open) spans.push(open);
  return spans;
}

/** The first gate span held at or after `sinceMs` (a login, or one teleport). */
export function firstGateSince(lines: readonly string[], sinceMs: number): GateSpan | null {
  return gateSpans(lines).find((s) => s.heldAt >= sinceMs) ?? null;
}

/** One-line summary: `gate: cold 1.21 s · holtburg 0.93 s · warm 0.54 s` (— for a missing or unreleased gate). */
export function gateHeadline(gates: ReadonlyArray<readonly [string, GateSpan | null]>): string {
  return `gate: ${gates.map(([label, g]) => `${label} ${g?.ms != null ? (g.ms / 1000).toFixed(2) + ' s' : '—'}`).join(' · ')}`;
}
