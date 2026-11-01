/**
 * TELEMETRY.objsend-diagnostics — a player typing ACE's @objsend (or /objsend) reports what the client's
 * object table held (objsend) and, OBJSEND_AFTER_MS later, again with the CreateObjects the resend brought
 * (objsend_after). The line goes through the real retail command system (CommandSystem.doCommand's Talk
 * fall-through → serverCommandSent), the snapshot through summarizeObjects, and the bridge keeps only its
 * whitelisted fields (services/ws-tcp-bridge/src/clientWorld.ts sanitizeClientObjsend).
 */
import { describe, it, expect } from 'vitest';
import { GameActionType } from '@ac/network';
import { RetailCommandSystem, type RetailCommandContext } from '../packages/renderer/src/chat/commands/index';
import {
  ObjsendReporter, OBJSEND_AFTER_MS, MAX_OBJSEND_EVENTS, countReleasedInView, isObjsendCommand, summarizeObjects,
  type ObjsendEvent, type ObjsendObject, type ObjsendSnapshot,
} from '../packages/renderer/src/telemetry/ObjsendReporter';
import { sanitizeClientObjsend, sanitizeClientPortal, sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server';

const PLAYER = 0x50000001;
const scene = {};
/** A world object 10 m east of the player, drawn. */
function obj(over: Partial<ObjsendObject> = {}): ObjsendObject {
  return {
    guid: 0x80000001, weenieClassId: 1000, itemType: 0x10, setupId: 0x02000001, physicsState: 0x408,
    worldX: 10, worldZ: 0, objCellId: 0xa9b40021, mesh: { visible: true, parent: scene }, ...over,
  };
}

/** A fake object table: one of each case near the player, plus far / carried / wielded ones. */
function table(): ObjsendObject[] {
  return [
    obj({ guid: PLAYER, weenieClassId: 1, mesh: null }), // the player: never counted
    obj({ guid: 1 }), // drawn
    obj({ guid: 2, weenieClassId: 7, itemType: 0x10, lostCell: true, mesh: { visible: false, parent: scene } }),
    obj({ guid: 3, weenieClassId: 7, itemType: 0x10, mesh: null }), // Setup, no mesh
    obj({ guid: 4, weenieClassId: 9, itemType: 0x80, mesh: { visible: true, parent: null } }), // detached
    obj({ guid: 5, weenieClassId: 9, itemType: 0x80, mesh: { visible: false, parent: scene } }), // invisible for no reason
    obj({ guid: 6, weenieClassId: 12, mesh: null, setupId: 0 }), // nothing to draw
    obj({ guid: 7, physicsState: 0x4000, mesh: { visible: false, parent: scene } }), // server-hidden
    obj({ guid: 8, physicsState: 0x20, mesh: null }), // NoDraw
    obj({ guid: 9, _culledByCell: true, mesh: { visible: false, parent: scene } }), // its env cell not drawn
    obj({ guid: 10, worldX: 61, mesh: null }), // out of view
    obj({ guid: 11, objCellId: 0, mesh: null }), // carried / contained
    obj({ guid: 12, wielderId: 0x80000099, mesh: null }), // wielded
    obj({ guid: 13, outOfWorld: true, mesh: null }), // picked up
  ];
}

function snapshotOf(objects: ObjsendObject[]): ObjsendSnapshot {
  return {
    ...summarizeObjects(objects, { x: 0, z: 0, guid: PLAYER }),
    ...countReleasedInView([{ position: { landblock: 0xa9b40021, x: 20, y: 30 } }, { position: { landblock: 0xaab40021, x: 20, y: 30 } }],
      { cellId: 0xa9b40021, x: 10, y: 30 }),
    msSinceTeleport: 1234, playerCell: 'a9b40021', pendingLoads: 3, unresolvedMisses: 1, portalSpace: false,
  };
}

/** The real retail command system on a minimal context: its Talk sends recorded, server commands to the reporter. */
function rig(opts: { era?: 'eor' | 'dark-majesty' | 'ac1999'; objects?: () => ObjsendObject[]; inWorld?: () => boolean } = {}) {
  const events: ObjsendEvent[] = [];
  const talks: string[] = [];
  const timers: Array<() => void> = [];
  const objects = opts.objects ?? table;
  const reporter = new ObjsendReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: 'feedc0de12345678',
    era: () => opts.era ?? 'eor', server: () => 'Coldeve',
    enabled: () => (opts.era ?? 'eor') !== 'ac1999',
    snapshot: () => ((opts.inWorld?.() ?? true) ? snapshotOf(objects()) : null),
    heldGuids: () => objects().map((o) => o.guid),
    send: (_url, body) => { events.push(JSON.parse(body) as ObjsendEvent); },
    schedule: (fn, ms) => { expect(ms).toBe(OBJSEND_AFTER_MS); timers.push(fn); },
  });
  const ctx = {
    print: () => {},
    send: (type: GameActionType, write?: (w: { writeString16(s: string): void }) => void) => {
      if (type === GameActionType.Talk) write?.({ writeString16: (s) => { talks.push(s); } });
      return true;
    },
    talkFocus: () => 1,
    lastSpeakableTarget: () => 0,
    chatPose: () => null,
    nowSeconds: () => 0,
    serverCommandSent: (line: string) => { reporter.commandSent(line); },
  } as unknown as RetailCommandContext;
  const commands = new RetailCommandSystem(ctx, opts.era === 'ac1999' ? 'ac1999' : 'eor');
  const fire = (): void => { for (const t of timers.splice(0)) t(); };
  return { reporter, commands, events, talks, fire };
}

describe('the objsend command word', () => {
  it('matches /objsend and @objsend in any case, with arguments or a trailing comma', () => {
    for (const l of ['/objsend', '@objsend', '  /OBJSEND ', '@ObjSend creatures', '@objsend,']) expect(isObjsendCommand(l)).toBe(true);
    for (const l of ['objsend', '/objsends', '/obj send', 'say /objsend', '', '@', '/who']) expect(isObjsendCommand(l)).toBe(false);
  });
});

describe('summarizeObjects', () => {
  it('classifies each in-view object once and ranks the unrendered wcids / ItemTypes', () => {
    const c = summarizeObjects(table(), { x: 0, z: 0, guid: PLAYER });
    expect(c).toEqual({
      serverObjects: 14, placed: 10, inView: 9,
      unrendered: 4, lostCell: 1, noMesh: 1, detached: 1, invisible: 1,
      hiddenByState: 2, culledByCell: 1,
      topWcids: [7, 9], topItemTypes: [0x10, 0x80],
    });
  });

  it('keeps five of each, most common first', () => {
    const many = [1, 2, 2, 3, 3, 3, 4, 5, 6, 7].map((w, i) => obj({ guid: 100 + i, weenieClassId: w, itemType: w, mesh: null }));
    const c = summarizeObjects(many, { x: 0, z: 0, guid: PLAYER });
    expect(c.unrendered).toBe(10);
    expect(c.topWcids).toEqual([3, 2, 1, 4, 5]);
    expect(c.topItemTypes).toEqual([3, 2, 1, 4, 5]);
  });

  it('counts released records near the player in the server frame', () => {
    expect(countReleasedInView([
      { position: { landblock: 0xa9b40021, x: 20, y: 30 } }, // 10 m
      { position: { landblock: 0xaab40021, x: 20, y: 30 } }, // the next landblock east: 202 m
      { position: null },
    ], { cellId: 0xa9b40021, x: 10, y: 30 })).toEqual({ released: 3, releasedInView: 1 });
    expect(countReleasedInView([{ position: { landblock: 0xa9b40021, x: 20, y: 30 } }], null)).toEqual({ released: 1, releasedInView: 0 });
  });
});

describe('ObjsendReporter through the retail command system', () => {
  it('/objsend goes to the server as @objsend and reports objsend, then objsend_after with the creates between', () => {
    let objects = table();
    const g = rig({ objects: () => objects });
    g.commands.onChatCommand('/objsend', 1);
    expect(g.talks).toEqual(['@objsend']);
    expect(g.events).toHaveLength(1);
    const e = g.events[0] as ObjsendEvent & { eid: string };
    expect(e).toMatchObject({
      outcome: 'objsend', era: 'eor', server: 'Coldeve', trace: 'feedc0de12345678', build: 'b1', seq: 1,
      msSinceTeleport: 1234, playerCell: 'a9b40021', serverObjects: 14, placed: 10, inView: 9,
      unrendered: 4, lostCell: 1, noMesh: 1, detached: 1, invisible: 1, hiddenByState: 2, culledByCell: 1,
      topWcids: [7, 9], topItemTypes: [0x10, 0x80], released: 2, releasedInView: 1,
      pendingLoads: 3, unresolvedMisses: 1, portalSpace: false,
    });
    expect(e.eid).toEqual(expect.any(String));
    expect(e).not.toHaveProperty('createsNew');
    // ACE HandleObjSend: RemoveTrackedObject (DeleteObject) then TrackObject (CreateObject) for each known
    // object, so at create time the guid is no longer held: each counts against the guids held at the command.
    const held = table().map((o) => o.guid);
    for (const guid of held) {
      objects = objects.filter((o) => o.guid !== guid);
      g.reporter.objectDeleted();
      objects = [...objects, table().find((o) => o.guid === guid)!];
      g.reporter.objectCreated(guid);
    }
    // …and one the client never held (it had lost it).
    g.reporter.objectCreated(0x80000777);
    objects = table().map((o) => (o.lostCell || (o.setupId && !o.mesh) ? { ...o, lostCell: false, mesh: { visible: true, parent: scene } } : o));
    g.fire();
    expect(g.events).toHaveLength(2);
    expect(g.events[1]).toMatchObject({
      outcome: 'objsend_after', seq: 1, unrendered: 2, lostCell: 0, noMesh: 0,
      createsKnown: held.length, createsNew: 1, deletes: held.length,
    });
    // After the window, creates and deletes count for nothing.
    g.reporter.objectCreated(0x80000778);
    g.reporter.objectDeleted();
    g.commands.onChatCommand('@OBJSEND creatures', 8);
    g.fire();
    expect(g.events.map((x) => [x.outcome, x.seq, x.createsNew])).toEqual([
      ['objsend', 1, undefined], ['objsend_after', 1, 1], ['objsend', 2, undefined], ['objsend_after', 2, 0],
    ]);
    expect(g.events[3]).toMatchObject({ createsKnown: 0, deletes: 0 });
  });

  it('other chat and other server commands report nothing', () => {
    const g = rig();
    g.commands.onChatCommand('hello there', 1);
    g.commands.onChatCommand('type /objsend if they vanish', 1);
    g.commands.onChatCommand('@acehelp', 1);
    g.commands.onChatCommand('/objsends', 1);
    g.fire();
    expect(g.talks).toEqual(['hello there', 'type /objsend if they vanish', '@acehelp', '@objsends']);
    expect(g.events).toEqual([]);
  });

  it('a Dark Majesty (ACE-based classic) session reports as end of retail does', () => {
    const g = rig({ era: 'dark-majesty' });
    g.commands.onChatCommand('@objsend', 1);
    expect(g.talks).toEqual(['@objsend']);
    expect(g.events.map((e) => [e.outcome, e.era])).toEqual([['objsend', 'dark-majesty']]);
  });

  it('the AC1999 protocol reports nothing (its server has no objsend), and the line still goes out', () => {
    const g = rig({ era: 'ac1999' });
    g.commands.onChatCommand('/objsend', 1);
    g.fire();
    expect(g.talks).toEqual(['@objsend']);
    expect(g.events).toEqual([]);
  });

  it('outside the world nothing is reported, and a page reports at most MAX_OBJSEND_EVENTS commands', () => {
    let inWorld = false;
    const g = rig({ inWorld: () => inWorld });
    g.commands.onChatCommand('/objsend', 1);
    g.fire();
    expect(g.events).toEqual([]);
    inWorld = true;
    for (let i = 0; i < MAX_OBJSEND_EVENTS + 3; i++) { g.commands.onChatCommand('/objsend', 1); g.fire(); }
    expect(g.events.filter((e) => e.outcome === 'objsend')).toHaveLength(MAX_OBJSEND_EVENTS);
  });
});

describe('the bridge keeps the objsend fields', () => {
  function sentPair(): ObjsendEvent[] {
    const g = rig();
    g.commands.onChatCommand('/objsend', 1);
    g.reporter.objectDeleted();
    g.reporter.objectCreated(1);
    g.reporter.objectCreated(0x80000777);
    g.fire();
    return g.events;
  }

  it('sanitizeClientObjsend keeps every field the page sends and drops anything else', () => {
    const [before, after] = sentPair();
    expect(sanitizeClientObjsend(before)).toEqual(before);
    expect(after).toMatchObject({ createsKnown: 1, createsNew: 1, deletes: 1 });
    expect(sanitizeClientObjsend(after)).toEqual(after);
    // The world and portal sanitizers do not take them (their own route branch does).
    expect(sanitizeClientWorld(before)).toBeNull();
    expect(sanitizeClientPortal(before)).toBeNull();
    expect(sanitizeClientObjsend({ outcome: 'first_minute' })).toBeNull();
    const junk = sanitizeClientObjsend({
      ...before, name: 'Drudge Slinker', text: '/objsend', ip: '1.2.3.4', playerCell: '0xa9b4', inView: -1, unrendered: 1.5,
      topWcids: [1, 'x', -1, 2, 3, 4, 5, 6, 7], portalSpace: 'no', msSinceTeleport: 2 ** 40, createsNew: 4, deletes: 4,
    }) as unknown as Record<string, unknown>;
    for (const k of ['name', 'text', 'ip', 'createsNew', 'deletes']) expect(junk).not.toHaveProperty(k);
    expect(junk).toMatchObject({ playerCell: null, inView: null, unrendered: null, topWcids: [1, 2, 3], portalSpace: null, msSinceTeleport: null });
  });

  it('POST /client-preworld logs each as one client_world line', async () => {
    const c: BridgeConfig = resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
    c.wsPort = 0;
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const bridge = createBridgeServer(c, { log: (level, event, fields) => { logs.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const sent = sentPair();
      for (const ev of sent) {
        const res = await fetch(`http://127.0.0.1:${port}/client-preworld`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(ev) });
        expect(res.status).toBe(204);
      }
      const lines = logs.filter((l) => l[1] === 'client_world');
      expect(lines).toHaveLength(2);
      lines.forEach((line, i) => {
        const { ip, ...fields } = line[2];
        expect(ip).toEqual(expect.any(String));
        expect(fields).toEqual(Object.fromEntries(Object.entries(sent[i]).filter(([, v]) => v !== null)));
      });
      expect(bridge.metrics.clientPreworld.get('objsend')).toBe(1);
      expect(bridge.metrics.clientPreworld.get('objsend_after')).toBe(1);
    } finally {
      await bridge.shutdown();
    }
  });
});
