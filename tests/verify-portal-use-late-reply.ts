/**
 * OBS.portal-use-late-reply — after a `portal_use_failed` verdict the reporter keeps listening
 * LATE_REPLY_WINDOW_MS and sends one `portal_late_reply`: the first UseDone, server movement of the
 * player, teleport or WeenieError that came after the verdict, else `none` (or `new_try` / `left_world`
 * when the window ended first).
 *
 * Production 2026-11-24 (Coldeve, ACE, end of retail, trace 43bdfafbf10157a2): a Gateway (wcid 1955)
 * use from 3.7 m got no movement, no UseDone, no refusal and no teleport in 5 s. Stock ACE answers every
 * processed Use at once (Player_Use.cs HandleActionUseItem → Player_Move.cs CreateMoveToChain: a
 * MoveToPosition for a portal, a TurnToObject in range) and sends the walk's UseDone only on arrival or
 * at the 15 s chain timeout, so the event could not tell "answered late" from "never answered".
 *
 * Drives the real PortalUseReporter and the bridge's real whitelist (clientWorld.ts sanitizeClientPortal).
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  PortalUseReporter, PORTAL_REPLY_MS, LATE_REPLY_WINDOW_MS, LATE_REPLY_TYPES,
  type PortalEvent, type PortalSnapshot,
} from '../packages/renderer/src/telemetry/PortalUseReporter';
import { sanitizeClientPortal, isPortalOutcome, PORTAL_LATE_REPLY_TYPES } from '../services/ws-tcp-bridge/src/clientWorld';
import { formatLogLine } from '../services/ws-tcp-bridge/src/log.js';

const GATEWAY = 0x7a1b2c3d;
const gatewayObj = { itemType: 0x10000, objectDescFlags: 0x40014 };
/** The production portal: Gateway 1955, Ethereal | LightingOn (2052), no ReportCollisions, UseRadius 0.75. */
const snap = (): PortalSnapshot => ({
  wcid: 1955, itemType: 0x10000, descFlags: 262164, physicsState: 2052,
  useRadius: 0.75, reach: 1.92, rel: { dx: -2.1, dy: 3.1, dz: -0.1 },
  playerCell: 0x016c01c3, portalCell: 0x016c01bd,
});

function rig() {
  const clock = { t: 1000 };
  const events: PortalEvent[] = [];
  const r = new PortalUseReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'feedc0de12345678',
    era: () => 'eor', server: () => 'coldeve', now: () => clock.t, snapshot: () => snap(),
    send: (_url, body) => { events.push(JSON.parse(body) as PortalEvent); },
  });
  const run = (ms: number): void => { for (let i = 0; i < ms / 100; i++) { clock.t += 100; r.tick({ serverWalking: false, playerMoving: false }); } };
  /** A Use nothing answered: the production verdict. */
  const failedUse = (): void => {
    r.overlaps([]);
    r.useAttempt(GATEWAY, gatewayObj, true, null, false);
    run(PORTAL_REPLY_MS + 100);
    expect(events.map((e) => e.outcome)).toEqual(['portal_use_failed']);
  };
  const late = () => events.filter((e) => e.outcome === 'portal_late_reply');
  return { r, clock, events, run, failedUse, late };
}

describe('OBS.portal-use-late-reply: what the server said after a portal_use_failed', () => {
  it('a late MoveToPosition: server_move with its MovementType, ms from the try, sent at once', () => {
    const g = rig();
    g.failedUse();
    g.run(2_000);
    expect(g.late()).toEqual([]);
    g.r.serverMovement(7, { started: true, at: { x: 0, y: 0, z: 0 }, target: { x: 1, y: 1, z: 0 } });
    expect(g.late()).toHaveLength(1);
    expect(g.late()[0]).toMatchObject({
      outcome: 'portal_late_reply', trigger: 'use', wcid: 1955, era: 'eor', server: 'coldeve', trace: 'feedc0de12345678',
      lateReplyType: 'server_move', lateCode: 7, lateActions: 0, waitedMs: 5000, lateReplyMs: 7100,
    });
    // One per failure: what comes after is not reported again.
    g.r.useDone(0);
    g.r.teleported();
    g.run(LATE_REPLY_WINDOW_MS * 2);
    expect(g.late()).toHaveLength(1);
  });

  it('the 15 s chain timeout UseDone and a WeenieError are reported with their codes', () => {
    const a = rig();
    a.failedUse();
    a.run(9_900);
    a.r.useDone(0);
    expect(a.late()[0]).toMatchObject({ lateReplyType: 'use_done', lateCode: 0, lateReplyMs: 15_000 });
    const b = rig();
    b.failedUse();
    b.r.weenieError(0x04a7);
    expect(b.late()[0]).toMatchObject({ lateReplyType: 'weenie_error', lateCode: 0x04a7 });
  });

  it('a late teleport is the answer (and no portal_used: the watch had ended)', () => {
    const g = rig();
    g.failedUse();
    g.run(1_000);
    g.r.teleported();
    expect(g.events.map((e) => e.outcome)).toEqual(['portal_use_failed', 'portal_late_reply']);
    expect(g.late()[0]).toMatchObject({ lateReplyType: 'teleport', lateCode: null, lateReplyMs: 6_100 });
  });

  it('nothing in the window: none, sent when the window closes and not before', () => {
    const g = rig();
    g.failedUse();
    g.run(LATE_REPLY_WINDOW_MS - 200);
    expect(g.late()).toEqual([]);
    g.run(300);
    expect(g.late()).toHaveLength(1);
    expect(g.late()[0]).toMatchObject({ lateReplyType: 'none', lateReplyMs: null, lateCode: null, lateActions: 0 });
    // The window is closed: a later UseDone answers nothing here.
    g.r.useDone(0);
    expect(g.late()).toHaveLength(1);
  });

  it('counts the actions the page sent after the verdict (a cast\'s UseDone is not the try\'s answer)', () => {
    const g = rig();
    g.failedUse();
    g.r.actionSent(0x4a); // CastTargetedSpell
    g.r.actionSent(0x4a);
    g.r.useDone(0x1d); // "You're too busy!"
    expect(g.late()[0]).toMatchObject({ lateReplyType: 'use_done', lateCode: 0x1d, lateActions: 2 });
  });

  it('a new try or leaving the world ends the window without an answer', () => {
    const a = rig();
    a.failedUse();
    a.run(1_000);
    a.r.useAttempt(0x7a000001, gatewayObj, true);
    expect(a.late()[0]).toMatchObject({ lateReplyType: 'new_try', lateReplyMs: null });
    // The new watch takes the replies that follow, as before.
    expect(a.r.watching).toBe(0x7a000001);
    const b = rig();
    b.failedUse();
    b.r.reset();
    expect(b.late()[0]).toMatchObject({ lateReplyType: 'left_world', lateReplyMs: null });
  });

  it('only a portal_use_failed listens: a refusal, a portal_used or no event at all leaves nothing to follow', () => {
    const refused = rig();
    refused.r.useAttempt(GATEWAY, gatewayObj, true);
    refused.r.weenieError(0x0474);
    refused.run(PORTAL_REPLY_MS + 100);
    expect(refused.events.map((e) => e.outcome)).toEqual(['portal_refused']);
    refused.r.useDone(0);
    refused.run(LATE_REPLY_WINDOW_MS + 100);
    expect(refused.late()).toEqual([]);
    const used = rig();
    used.r.useAttempt(GATEWAY, gatewayObj, true);
    used.r.serverMovement(7);
    used.r.teleported();
    used.r.useDone(0);
    used.run(LATE_REPLY_WINDOW_MS + 100);
    expect(used.events.map((e) => e.outcome)).toEqual(['portal_used']);
    const idle = rig();
    idle.r.useDone(0);
    idle.r.serverMovement(8);
    idle.run(LATE_REPLY_WINDOW_MS + 100);
    expect(idle.events).toEqual([]);
  });

  it('the bridge keeps every field of every late reply and drops junk', () => {
    expect(PORTAL_LATE_REPLY_TYPES).toEqual(LATE_REPLY_TYPES);
    expect(isPortalOutcome('portal_late_reply')).toBe(true);
    const g = rig();
    g.failedUse();
    g.r.serverMovement(7);
    const ev = g.late()[0];
    expect(sanitizeClientPortal(ev)).toEqual(ev);
    const n = rig();
    n.failedUse();
    n.run(LATE_REPLY_WINDOW_MS + 100);
    expect(sanitizeClientPortal(n.late()[0])).toEqual(n.late()[0]);
    expect(sanitizeClientPortal({ ...ev, lateReplyType: 'maybe', lateReplyMs: -5, lateCode: 'x', lateActions: 1e9, extra: 1 }))
      .toEqual({ ...ev, lateReplyType: null, lateReplyMs: null, lateCode: null, lateActions: null });
  });

  it("the monitor's launch filter leaves it to check.sh's portal section, as the failure it follows", () => {
    const g = rig();
    g.failedUse();
    g.run(LATE_REPLY_WINDOW_MS + 100);
    // tools/aws-logs.sh's rendering of the bridge's client_world line.
    const lines = g.events.map((e) => {
      const obj = JSON.parse(formatLogLine('info', 'client_world', { ip: '198.51.100.7', ...sanitizeClientPortal(e) }, new Date('2026-11-24T21:45:33Z'))) as Record<string, unknown>;
      const val = (v: unknown) => (typeof v === 'boolean' ? String(v) : v === null ? 'null' : JSON.stringify(v));
      return `2026-11-24T21:45:33 [INFO]  ${Object.entries(obj).filter(([k]) => k !== 'level').map(([k, v]) => `${k}=${val(v)}`).join(' ')}`;
    });
    expect(lines[1]).toMatch(/outcome="portal_late_reply".*lateReplyType="none"/);
    const out = execFileSync('bash', [path.join(__dirname, '..', 'tools', 'monitor', 'launch-filter.sh')], {
      input: `${lines.join('\n')}\n`, env: { ...process.env, MONITOR_OWN_IPS: '192\\.0\\.2\\.1' },
    }).toString();
    expect(out).not.toMatch(/portal_(use_failed|late_reply)/);
  });
});
