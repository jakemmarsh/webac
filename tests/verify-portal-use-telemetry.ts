/**
 * TELEMETRY.portal-use-failed — a portal tried (a Use, or the body walking into it) that did nothing
 * within PORTAL_REPLY_MS reports one portal_use_failed with the portal's flags, PhysicsState, use radius,
 * where it stood from the player, what the client did and what came back; a teleport reports a light
 * portal_used with its timing. Both go to POST /client-preworld and the bridge logs them as client_world
 * through its whitelist (services/ws-tcp-bridge/src/clientWorld.ts sanitizeClientPortal).
 */
import { describe, it, expect } from 'vitest';
import {
  PortalUseReporter, PORTAL_REPLY_MS, PORTAL_MAX_WAIT_MS, PORTAL_RATE_MS, chatTemplate, isPortalObject, overlapsPortal,
  type PortalEvent, type PortalSnapshot, type PortalUseFailedEvent,
} from '../packages/renderer/src/telemetry/PortalUseReporter';
import { sanitizeClientPortal, sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server';

/** The Scrivener's Annex exit as a fake: Portal desc flag, ItemType Portal, Ethereal | ReportCollisions | Static. */
const PORTAL_GUID = 0x7013500a;
const portalObj = { itemType: 0x10000, objectDescFlags: 0x40000 };
const snap = (over: Partial<PortalSnapshot> = {}): PortalSnapshot => ({
  wcid: 90001, itemType: 0x10000, descFlags: 0x40014, physicsState: 0x4 | 0x8 | 0x1,
  useRadius: 3, reach: 1.234, rel: { dx: 2.04, dy: -1.96, dz: 0.31 },
  playerCell: 0x01350126, portalCell: 0x01350127, ...over,
});

function rig(snapshot: (g: number) => PortalSnapshot | null = () => snap()) {
  const clock = { t: 1000 };
  const events: PortalEvent[] = [];
  const r = new PortalUseReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'feedc0de12345678',
    era: () => 'eor', server: () => 'levistras', now: () => clock.t, snapshot,
    send: (_url, body) => { events.push(JSON.parse(body) as PortalEvent); },
  });
  /** Advance in 100 ms ticks, as main.ts does. */
  const run = (ms: number, moving = false): void => { for (let i = 0; i < ms / 100; i++) { clock.t += 100; r.tick(moving); } };
  return { r, clock, events, run };
}

describe('PortalUseReporter: a used portal that does nothing', () => {
  it('reports portal_use_failed with the portal, the player, what was sent and what came back', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    expect(g.r.watching).toBe(PORTAL_GUID);
    g.r.useDone(0);
    g.r.weenieError(0x0484);
    g.r.serverChat('Portal destination for portal ID 90001 not yet implemented!', 5);
    g.r.serverChat('Bob tells you, hi', 3); // counted, never kept
    g.run(PORTAL_REPLY_MS - 200);
    expect(g.events).toEqual([]);
    g.run(400);
    expect(g.events).toHaveLength(1);
    const e = g.events[0] as PortalUseFailedEvent & { eid: string };
    expect(e).toMatchObject({
      outcome: 'portal_use_failed', era: 'eor', server: 'levistras', trace: 'feedc0de12345678', build: 'b1',
      trigger: 'use', wcid: 90001, itemType: 0x10000, descFlags: 0x40014, physicsState: 0xd,
      ethereal: true, reportCollisions: true, useRadius: 3, reach: 1.23,
      dx: 2, dy: -2, dz: 0.3, dist: 2.8, endDist: 2.8,
      playerCell: '01350126', portalCell: '01350127',
      useSent: true, held: null, attempts: 1, overlapped: false, serverWalk: false,
      useDone: 0, weenieErrors: [0x0484], chatLines: 2, chatType: 5,
      chatTemplate: 'Portal destination for portal ID # not yet implemented!',
    });
    expect(e.waitedMs).toBeGreaterThanOrEqual(PORTAL_REPLY_MS);
    expect(JSON.stringify(e)).not.toMatch(/Bob/);
    expect(g.r.watching).toBeNull();
  });

  it('a Use the client kept reports useSent false and why', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, false, 'busy');
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', useSent: false, held: 'busy', useDone: null, weenieErrors: [] });
  });

  it('a use followed by a teleport reports portal_used and no failure', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(700);
    g.r.serverMovement();
    g.run(500, true);
    g.r.teleported();
    g.run(PORTAL_REPLY_MS * 2);
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_used', trigger: 'use', wcid: 90001, ms: 1200, useSent: true, serverWalk: true, attempts: 1 });
  });

  it('ignores what is not a portal', () => {
    const g = rig();
    g.r.useAttempt(0x70000001, { itemType: 0x10, objectDescFlags: 0x1000 }, true); // a door
    g.run(PORTAL_REPLY_MS * 2);
    expect(g.events).toEqual([]);
    expect(isPortalObject({ itemType: 0, objectDescFlags: 0x40000 })).toBe(true);
    expect(isPortalObject({ itemType: 0x10000, objectDescFlags: 0 })).toBe(true);
    expect(isPortalObject(null)).toBe(false);
  });

  it("the server's walk to the portal extends the wait, up to the cap", () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.r.serverMovement();
    g.run(PORTAL_REPLY_MS * 3, true);
    expect(g.events).toEqual([]);
    g.run(PORTAL_MAX_WAIT_MS, true);
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', serverWalk: true });
    expect((g.events[0] as PortalUseFailedEvent).waitedMs).toBeLessThanOrEqual(PORTAL_MAX_WAIT_MS + 100);
  });

  it('a second use of the same portal is another attempt in the same watch', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(3000);
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(3000);
    expect(g.events).toEqual([]);
    g.run(2100);
    expect(g.events).toHaveLength(1);
    expect(g.events[0]).toMatchObject({ attempts: 2 });
  });

  it('reports a portal at most once a minute', () => {
    const g = rig();
    for (let i = 0; i < 3; i++) { g.r.useAttempt(PORTAL_GUID, portalObj, true); g.run(PORTAL_REPLY_MS + 100); }
    expect(g.events).toHaveLength(1);
    g.run(PORTAL_RATE_MS);
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events).toHaveLength(2);
  });

  it('drops a watch whose portal is gone (nothing to report)', () => {
    const g = rig(() => null);
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(PORTAL_REPLY_MS * 2);
    expect(g.events).toEqual([]);
  });
});

describe('PortalUseReporter: walking into a portal', () => {
  it('a newly overlapped portal with no teleport reports trigger walk_in', () => {
    const g = rig();
    g.r.overlaps([]); // the baseline
    g.r.overlaps([PORTAL_GUID]);
    g.run(PORTAL_REPLY_MS + 100);
    expect(g.events[0]).toMatchObject({ outcome: 'portal_use_failed', trigger: 'walk_in', useSent: false, held: null, overlapped: true, attempts: 0 });
  });

  it('standing on a portal at arrival (the check after a teleport or world entry) is no try', () => {
    const g = rig();
    g.r.reset();
    g.r.overlaps([PORTAL_GUID]);
    g.run(PORTAL_REPLY_MS * 2);
    g.r.teleported();
    g.r.overlaps([PORTAL_GUID]);
    g.run(PORTAL_REPLY_MS * 2);
    expect(g.events).toEqual([]);
  });

  it('walking into the portal being used marks the use overlapped; the teleport reports portal_used', () => {
    const g = rig();
    g.r.overlaps([]);
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.run(300);
    g.r.overlaps([PORTAL_GUID]);
    g.r.teleported();
    expect(g.events).toEqual([expect.objectContaining({ outcome: 'portal_used', trigger: 'use', ms: 300 })]);
  });

  it('overlapsPortal: the body within the reach, the portal base near the feet', () => {
    expect(overlapsPortal(1.0, 0, 1.2, 0)).toBe(true);
    expect(overlapsPortal(1.3, 0, 1.2, 0)).toBe(false);
    expect(overlapsPortal(1.3, 0, 1.2, 0.5)).toBe(true);
    expect(overlapsPortal(0.5, 5, 1.2, 0)).toBe(false); // a floor above
    expect(overlapsPortal(Number.NaN, 0, 1.2, 0)).toBe(false);
  });
});

describe('chatTemplate', () => {
  it('keeps only portal lines, numbers as #', () => {
    expect(chatTemplate('You have been teleported too recently!')).toBe('You have been teleported too recently!');
    expect(chatTemplate('Portal 0x7013500A at 12.5 m')).toBe('Portal # at # m');
    expect(chatTemplate('Welcome to Asheron\'s Call')).toBeNull();
  });
});

describe('the bridge keeps the portal fields', () => {
  it('sanitizeClientPortal keeps every field the page sends and drops junk', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.r.useDone(0);
    g.r.weenieError(0x0484);
    g.r.serverChat('Portal destination for portal ID 90001 not yet implemented!', 5);
    g.run(PORTAL_REPLY_MS + 100);
    const sent = g.events[0];
    expect(sanitizeClientPortal(sent)).toEqual(sent);
    // The world sanitizer does not take them (their own route branch does).
    expect(sanitizeClientWorld(sent)).toBeNull();
    const junk = sanitizeClientPortal({
      ...sent, name: 'Portal to Zaikhal', chatTemplate: 'Bob has 3 pyreals', playerCell: '0x0135', weenieErrors: [1, 'x', -1, 2, 3, 4, 5],
      trigger: 'telepathy', dx: Infinity, physicsState: 2 ** 33,
    }) as unknown as Record<string, unknown>;
    expect(junk).not.toHaveProperty('name');
    expect(junk).toMatchObject({ chatTemplate: null, playerCell: null, weenieErrors: [1, 2], trigger: null, dx: null, physicsState: null });
  });

  it('sanitizeClientPortal keeps portal_used', () => {
    const g = rig();
    g.r.useAttempt(PORTAL_GUID, portalObj, true);
    g.clock.t += 850;
    g.r.teleported();
    expect(sanitizeClientPortal(g.events[0])).toEqual(g.events[0]);
    expect(sanitizeClientPortal({ outcome: 'first_minute' })).toBeNull();
  });

  it('POST /client-preworld logs a portal event as one client_world line', async () => {
    const c: BridgeConfig = resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
    c.wsPort = 0;
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const bridge = createBridgeServer(c, { log: (level, event, fields) => { logs.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const g = rig();
      g.r.useAttempt(PORTAL_GUID, portalObj, true);
      g.run(PORTAL_REPLY_MS + 100);
      const res = await fetch(`http://127.0.0.1:${port}/client-preworld`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(g.events[0]) });
      expect(res.status).toBe(204);
      const line = logs.find((l) => l[1] === 'client_world')!;
      const { ip, ...fields } = line[2];
      expect(ip).toEqual(expect.any(String));
      expect(fields).toEqual(Object.fromEntries(Object.entries(g.events[0]).filter(([, v]) => v !== null)));
      expect(bridge.metrics.clientPreworld.get('portal_use_failed')).toBe(1);
    } finally {
      await bridge.shutdown();
    }
  });
});
