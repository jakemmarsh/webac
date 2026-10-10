/**
 * BUG.object-blobs-dropped-before-create — the SmartBox object handlers
 * (HandleDeleteObject @ 00451ea0, HandleSetState @ 004533e0,
 * HandleParentEvent @ 004535d0, …) queue a message for an object the client
 * does not have yet, or an older instance of, through
 * CObjectMaint::QueueBlobForObject @ 005092d0, and
 * SmartBox::ProcessObjectNetBlobs @ 00454b20 replays it at the create.
 * Pre-fix ours returned early, so e.g. a DeleteObject racing its
 * CreateObject was lost and the object stayed in the world.
 *
 * A message for an OLDER instance than the object is dropped
 * (NETBLOB_OLD_INSTANCE); applying a stale DeleteObject removed the AC1999
 * tutorial dungeon's re-minted statics (BUG.ac1999-world-objects-missing-after-login).
 */
import { describe, it, expect } from 'vitest';
import { gateObjectHandlers, createObjectBlobGate, OBJECT_BLOB_HANDLERS } from '../packages/renderer/src/world/ObjectBlobGate.js';
import { PendingPlayScripts, NONVISIBLE_OBJECT_DESTRUCTION_TIME_MS } from '../packages/renderer/src/effects/PlayScriptResolve.js';
import { isSequenceNewer } from '../packages/renderer/src/world/ServerObjectManager.js';
import type { ServerMessageHandlers } from '../packages/renderer/src/network/ServerMessageHandler.js';

/** A gate over a toy object table, wired the way main.ts wires it. */
function harness() {
  const objects = new Map<number, { instance: number }>();
  const q = new PendingPlayScripts();
  let now = 0;
  const gate = createObjectBlobGate({
    queue: q,
    worldInstance: (guid) => objects.get(guid)?.instance ?? null,
    knownWithoutWorldRecord: (guid) => guid === 0x5000000a, // ourselves
    isNewer: isSequenceNewer,
    now: () => now,
  });
  const create = (guid: number, instance: number) => { objects.set(guid, { instance }); q.replayFor(guid, now); };
  return { objects, q, gate, create, tick: (ms: number) => { now += ms; } };
}

describe('gateObjectHandlers', () => {
  it('wraps exactly the single-object handlers plus ParentEvent; others pass through untouched', () => {
    const chat = () => {};
    const h: ServerMessageHandlers = { onHearSpeech: chat };
    for (const k of OBJECT_BLOB_HANDLERS) (h as Record<string, unknown>)[k] = () => {};
    const out = gateObjectHandlers(h, { defer: () => false, deferUntilKnown: () => false });
    expect(out.onHearSpeech).toBe(chat);
    for (const k of OBJECT_BLOB_HANDLERS) expect(out[k]).not.toBe(h[k]);
  });

  it('a DeleteObject that beats its CreateObject is applied right after the create', () => {
    const { gate, create } = harness();
    const seen: string[] = [];
    const out = gateObjectHandlers({ onObjectDelete: (d) => seen.push(`delete ${d.guid}`) }, gate);
    out.onObjectDelete!({ guid: 0x80001, instanceSequence: 1 });
    expect(seen).toEqual([]);
    create(0x80001, 1);
    expect(seen).toEqual(['delete 524289']);
  });

  it('replays one object\'s messages in arrival order, and a later message waits behind them', () => {
    const { gate, create } = harness();
    const seen: string[] = [];
    const out = gateObjectHandlers({
      onSetState: (d) => seen.push(`state ${d.physicsState}`),
      onVectorUpdate: () => seen.push('vector'),
    }, gate);
    out.onSetState!({ guid: 7, physicsState: 1, instanceSequence: 1, stateSequence: 1 });
    out.onVectorUpdate!({ guid: 7, velocity: { x: 0, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 }, instanceSequence: 1, vectorSequence: 1 });
    out.onSetState!({ guid: 7, physicsState: 2, instanceSequence: 1, stateSequence: 2 });
    create(7, 1);
    expect(seen).toEqual(['state 1', 'vector', 'state 2']);
    out.onSetState!({ guid: 7, physicsState: 3, instanceSequence: 1, stateSequence: 3 });
    expect(seen.at(-1)).toBe('state 3'); // known now: applied at once
  });

  it('a message for a NEWER instance waits for that instance\'s CreateObject', () => {
    const { gate, create } = harness();
    create(9, 4);
    const seen: number[] = [];
    const out = gateObjectHandlers({ onObjectDelete: (d) => seen.push(d.instanceSequence) }, gate);
    out.onObjectDelete!({ guid: 9, instanceSequence: 5 });
    expect(seen).toEqual([]); // the old instance stays
    create(9, 5);
    expect(seen).toEqual([5]);
  });

  // BUG.ac1999-world-objects-missing-after-login — NETBLOB_OLD_INSTANCE. The
  // AC1999 server re-mints a respawned landblock's static guids at a newer
  // instance; the previous instance's DeleteObject, queued before the new
  // CreateObject, removed every door, sign and NPC of the tutorial dungeon
  // at once after a login (2026-10-08 local, 2026-10-09 playwebac.com).
  it('a queued DeleteObject for an OLDER instance is dropped at the newer create (the 1999 static re-mint)', () => {
    const { gate, create } = harness();
    const seen: number[] = [];
    const out = gateObjectHandlers({ onObjectDelete: (d) => seen.push(d.guid) }, gate);
    out.onObjectDelete!({ guid: 0x7017e004, instanceSequence: 3 }); // the despawned instance's delete
    create(0x7017e004, 4); // the respawn's CreateObject
    expect(seen).toEqual([]);
    out.onObjectDelete!({ guid: 0x7017e004, instanceSequence: 3 }); // a late copy: still the old instance
    expect(seen).toEqual([]);
    out.onObjectDelete!({ guid: 0x7017e004, instanceSequence: 4 }); // this instance's own delete
    expect(seen).toEqual([0x7017e004]);
  });

  it('a drop is reported (stamp, current instance) for the owner\'s log', () => {
    const drops: number[][] = [];
    const gate = createObjectBlobGate({
      queue: new PendingPlayScripts(), worldInstance: () => 9, knownWithoutWorldRecord: () => false,
      isNewer: isSequenceNewer, now: () => 0, dropped: (g, s, c) => drops.push([g, s, c]),
    });
    expect(gate.defer(0x7017e010, 8, () => {})).toBe(true);
    expect(gate.defer(0x7017e010, 9, () => {})).toBe(false);
    expect(drops).toEqual([[0x7017e010, 8, 9]]);
  });

  it('every gated handler drops an older instance\'s message (SetState, VectorUpdate, Pickup, position)', () => {
    const { gate, create } = harness();
    create(0x7017e008, 7);
    const seen: string[] = [];
    const out = gateObjectHandlers({
      onSetState: () => seen.push('state'),
      onVectorUpdate: () => seen.push('vector'),
      onPickupEvent: () => seen.push('pickup'),
    }, gate);
    out.onSetState!({ guid: 0x7017e008, physicsState: 4, instanceSequence: 6, stateSequence: 1 });
    out.onVectorUpdate!({ guid: 0x7017e008, velocity: { x: 0, y: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 }, instanceSequence: 6, vectorSequence: 1 });
    out.onPickupEvent!({ guid: 0x7017e008, instanceSequence: 6, positionSequence: 1 } as never);
    expect(seen).toEqual([]);
    out.onSetState!({ guid: 0x7017e008, physicsState: 4, instanceSequence: 7, stateSequence: 2 });
    expect(seen).toEqual(['state']);
  });

  it('sequence wrap: 0xFFFF is older than 1, so its delete is dropped; a stamp-less message still applies', () => {
    const { gate, create } = harness();
    create(0x7017e00c, 1);
    const seen: Array<number | undefined> = [];
    const out = gateObjectHandlers({ onObjectDelete: (d) => seen.push(d.instanceSequence) }, gate);
    out.onObjectDelete!({ guid: 0x7017e00c, instanceSequence: 0xFFFF });
    expect(seen).toEqual([]);
    out.onObjectDelete!({ guid: 0x7017e00c, instanceSequence: undefined as unknown as number });
    expect(seen).toEqual([undefined]);
  });

  it('ParentEvent checks the holder (its stamp is the holder\'s instance) then queues on the missing item', () => {
    const { gate, create } = harness();
    const seen: string[] = [];
    const out = gateObjectHandlers({ onParentEvent: (d) => seen.push(`${d.creatureGuid}<-${d.wieldedGuid}`) }, gate);
    create(0x50, 2); // the holder is known, the item is not yet
    out.onParentEvent!({ creatureGuid: 0x50, wieldedGuid: 0x81, parentLocation: 1, placement: 1, instanceSequence: 2, positionSequence: 1 });
    expect(seen).toEqual([]);
    create(0x81, 1);
    expect(seen).toEqual(['80<-129']);
    // an unknown holder queues on the holder
    create(0x82, 1);
    out.onParentEvent!({ creatureGuid: 0x51, wieldedGuid: 0x82, parentLocation: 1, placement: 1, instanceSequence: 1, positionSequence: 1 });
    expect(seen.length).toBe(1);
    create(0x51, 1);
    expect(seen.at(-1)).toBe('81<-130');
  });

  it('a CreateObject whose parent is unknown waits on the parent (deferUntilKnown)', () => {
    const { gate, create } = harness();
    const seen: string[] = [];
    const createItem = () => { if (gate.deferUntilKnown(0x50, createItem)) return; seen.push('item created'); };
    createItem();
    expect(seen).toEqual([]);
    create(0x50, 1);
    expect(seen).toEqual(['item created']);
    expect(gate.deferUntilKnown(0x5000000a, () => {})).toBe(false); // ourselves
  });

  it('our own character and pack items are never queued', () => {
    const { gate } = harness();
    const seen: number[] = [];
    const out = gateObjectHandlers({ onSetState: (d) => seen.push(d.guid) }, gate);
    out.onSetState!({ guid: 0x5000000a, physicsState: 0, instanceSequence: 1, stateSequence: 1 });
    expect(seen).toEqual([0x5000000a]);
  });

  it('a queue whose object never arrives is dropped after NONVISIBLE_OBJECT_DESTRUCTION_TIME', () => {
    const { gate, q, tick, create } = harness();
    const seen: number[] = [];
    const out = gateObjectHandlers({ onObjectDelete: (d) => seen.push(d.guid) }, gate);
    out.onObjectDelete!({ guid: 3, instanceSequence: 1 });
    tick(NONVISIBLE_OBJECT_DESTRUCTION_TIME_MS + 1);
    q.pump(NONVISIBLE_OBJECT_DESTRUCTION_TIME_MS + 1, () => false);
    expect(q.size).toBe(0);
    create(3, 1);
    expect(seen).toEqual([]);
  });
});
