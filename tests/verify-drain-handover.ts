/**
 * The page's planned handover on a bridge deploy (packages/renderer/src/session/DrainHandover.ts):
 * it hands the session over only at a safe moment, retries an attempt that left the session in
 * place, never hands over in danger, and reports each move ('handover' preworld outcome) with
 * its time, why ('safe' / 'hard_cut') and how ('adopt' / 'relogin').
 *
 * Also the reporter's side (telemetry/PreworldReporter.ts handover) and that the bridge keeps
 * exactly what the page sends (clientPreworld.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  DrainHandover, handoverBlocker, HANDOVER_COMBAT_QUIET_MS, HANDOVER_POLL_MS, HANDOVER_RETRY_MS, HANDOVER_SAFE_HOLD_MS,
  type HandoverSafety,
} from '../packages/renderer/src/session/DrainHandover';
import { PreworldReporter } from '../packages/renderer/src/telemetry/PreworldReporter';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld';

const calm = (): HandoverSafety => ({
  inWorld: true, entering: false, combatStance: false, dead: false, portalSpace: false,
  trade: false, vendor: false, dialog: null, lastCombatAt: null, hostilesSeeking: 0,
});

function harness(initial: Partial<HandoverSafety> = {}) {
  let t = 1_000_000;
  let safety: HandoverSafety = { ...calm(), ...initial };
  let ticker: (() => void) | null = null;
  const handovers: number[] = [];
  const reports: Array<{ reason: string; path: string; ms: number; token?: string | null }> = [];
  const d = new DrainHandover({
    now: () => t,
    safety: () => safety,
    handover: () => { handovers.push(t); },
    report: (r) => reports.push(r),
    setInterval: (fn) => { ticker = fn; return 1; },
    clearInterval: () => { ticker = null; },
  });
  /** Let `ms` pass, the page looking every HANDOVER_POLL_MS. */
  const run = (ms: number) => { for (let left = ms; left > 0; left -= HANDOVER_POLL_MS) { t += HANDOVER_POLL_MS; ticker?.(); } };
  return {
    d, handovers, reports, run,
    set: (p: Partial<HandoverSafety>) => { safety = { ...safety, ...p }; },
    get now() { return t; },
    get polling() { return ticker !== null; },
  };
}

describe('when is it safe to hand a session over', () => {
  const now = 10_000_000;
  it('calm in the world, or at character select: safe', () => {
    expect(handoverBlocker(calm(), now)).toBeNull();
    expect(handoverBlocker({ ...calm(), inWorld: false, combatStance: true }, now)).toBeNull();
    // A login's portal tunnel is not character select.
    expect(handoverBlocker({ ...calm(), inWorld: false, portalSpace: true }, now)).toBe('portal_space');
  });
  it('anything that could turn a stall into a death, or an exchange the handover could interrupt: not safe', () => {
    expect(handoverBlocker({ ...calm(), entering: true }, now)).toBe('entering');
    expect(handoverBlocker({ ...calm(), dead: true }, now)).toBe('dead');
    expect(handoverBlocker({ ...calm(), portalSpace: true }, now)).toBe('portal_space');
    expect(handoverBlocker({ ...calm(), combatStance: true }, now)).toBe('combat_stance');
    expect(handoverBlocker({ ...calm(), lastCombatAt: now - HANDOVER_COMBAT_QUIET_MS + 1 }, now)).toBe('recent_combat');
    expect(handoverBlocker({ ...calm(), lastCombatAt: now - HANDOVER_COMBAT_QUIET_MS }, now)).toBeNull();
    expect(handoverBlocker({ ...calm(), hostilesSeeking: 1 }, now)).toBe('hostile');
    expect(handoverBlocker({ ...calm(), trade: true }, now)).toBe('trade');
    expect(handoverBlocker({ ...calm(), vendor: true }, now)).toBe('vendor');
    expect(handoverBlocker({ ...calm(), dialog: 'confirm' }, now)).toBe('dialog');
  });
});

describe('DrainHandover', () => {
  it('hands over once it has been safe for the hold time, and reports the move', () => {
    const h = harness();
    h.d.onDraining(true);
    expect(h.polling).toBe(true);
    h.run(HANDOVER_SAFE_HOLD_MS);
    expect(h.handovers).toHaveLength(0);
    h.run(HANDOVER_POLL_MS * 2);
    expect(h.handovers).toHaveLength(1);
    h.run(10_000);
    expect(h.handovers).toHaveLength(1); // one at a time
    h.d.onResult({ ok: true, ms: 240 });
    expect(h.reports).toEqual([{ reason: 'safe', path: 'adopt', ms: 240 }]);
    expect(h.polling).toBe(false);
  });

  it('waits out a fight: a lull shorter than the hold time does not count', () => {
    const h = harness({ combatStance: true });
    h.d.onDraining(true);
    h.run(60_000);
    expect(h.handovers).toHaveLength(0);
    // Out of combat stance, but a hit lands a second later: the quiet period starts over.
    h.set({ combatStance: false, lastCombatAt: h.now });
    h.run(HANDOVER_COMBAT_QUIET_MS - 1000);
    expect(h.handovers).toHaveLength(0);
    h.set({ lastCombatAt: h.now });
    h.run(HANDOVER_COMBAT_QUIET_MS);
    expect(h.handovers).toHaveLength(0);
    h.run(HANDOVER_SAFE_HOLD_MS + HANDOVER_POLL_MS * 2);
    expect(h.handovers).toHaveLength(1);
  });

  it('a monster chasing the character holds the handover until it stops', () => {
    const h = harness({ hostilesSeeking: 2 });
    h.d.onDraining(true);
    h.run(30_000);
    expect(h.handovers).toHaveLength(0);
    h.set({ hostilesSeeking: 0 });
    h.run(HANDOVER_SAFE_HOLD_MS + HANDOVER_POLL_MS * 2);
    expect(h.handovers).toHaveLength(1);
  });

  it('a bridge that cannot hand over: never tries, and the drain\'s hard cut is reported once the resume is back', () => {
    const h = harness();
    h.d.onDraining(false);
    expect(h.polling).toBe(false);
    h.run(10_000);
    expect(h.handovers).toHaveLength(0);
    h.d.onSessionDropped();
    h.run(9_000);
    h.d.onEnteredWorld();
    expect(h.reports).toEqual([{ reason: 'hard_cut', path: 'relogin', ms: 9_000 }]);
    // Only once.
    h.d.onEnteredWorld();
    expect(h.reports).toHaveLength(1);
  });

  it('an attempt that left the session in place is retried later; after the last retry it stays put', () => {
    const h = harness();
    h.d.onDraining(true);
    for (let i = 0; i <= HANDOVER_RETRY_MS.length; i++) {
      h.run(HANDOVER_RETRY_MS[Math.max(0, i - 1)] ?? 0);
      h.run(HANDOVER_SAFE_HOLD_MS + HANDOVER_POLL_MS * 2);
      expect(h.handovers).toHaveLength(i + 1);
      h.d.onResult({ ok: false, stage: 'adopt', reason: 'bad ticket', released: false, ms: 30 });
    }
    expect(h.reports.at(-1)).toMatchObject({ reason: 'safe', path: 'adopt', token: 'adopt_bad_ticket' });
    expect(h.polling).toBe(false);
    h.run(600_000);
    expect(h.handovers).toHaveLength(HANDOVER_RETRY_MS.length + 1);
  });

  it('an attempt that lost the session: the resume brings it back, reported from the handover\'s start', () => {
    const h = harness();
    h.d.onDraining(true);
    h.run(HANDOVER_SAFE_HOLD_MS + HANDOVER_POLL_MS * 2);
    const started = h.handovers[0];
    h.run(1000);
    h.d.onResult({ ok: false, stage: 'bind', reason: 'port_busy', released: true, ms: 1000 });
    h.d.onSessionDropped(); // the connection's 'disconnected' follows
    h.run(8_000);
    h.d.onEnteredWorld();
    expect(h.reports.at(-1)).toEqual({ reason: 'safe', path: 'relogin', ms: h.now - started });
  });

  it('a drop with no deploy under way reports nothing; a logout or the launcher forgets a pending report', () => {
    const h = harness();
    h.d.onSessionDropped();
    h.d.onEnteredWorld();
    expect(h.reports).toEqual([]);
    h.d.onDraining(false);
    h.d.onSessionDropped();
    h.d.reset();
    h.d.onEnteredWorld();
    expect(h.reports).toEqual([]);
  });
});

describe('the handover outcome on the wire', () => {
  it('the reporter sends exactly what the bridge keeps', () => {
    const posted: string[] = [];
    const r = new PreworldReporter({
      endpoint: 'https://bridge.test/client-preworld', build: 'b1', era: () => 'eor', server: () => 'coldeve',
      screen: () => 'world', send: (_url, body) => { posted.push(body); return Promise.resolve(); }, trace: 'abcdefgh12',
    });
    r.handover({ reason: 'safe', path: 'adopt', ms: 312.4 });
    r.handover({ reason: 'safe', path: 'adopt', ms: 40, token: 'adopt_other_host' });
    r.handover({ reason: 'hard_cut', path: 'relogin', ms: 9100 });
    const bodies = posted.map((p) => JSON.parse(p));
    expect(bodies.map((b) => sanitizeClientPreworld(b))).toEqual([
      expect.objectContaining({ outcome: 'handover', era: 'eor', server: 'coldeve', handoverMs: 312, reason: 'safe', path: 'adopt', token: null }),
      expect.objectContaining({ outcome: 'handover', handoverMs: 40, token: 'adopt_other_host' }),
      expect.objectContaining({ outcome: 'handover', handoverMs: 9100, reason: 'hard_cut', path: 'relogin' }),
    ]);
  });
});
