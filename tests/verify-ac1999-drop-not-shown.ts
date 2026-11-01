/**
 * BUG.ac1999-drop-not-shown — an item dropped on the AC1999 server left the pack but never showed
 * on the ground until a relog.
 *
 * The AC1999 server's FinishMoveItemTo3D (Server/Source/Monster.cpp) sends the dropper 0x19A
 * InventoryPutObjectIn3D, marks the dropper already aware of the item (SetMadeAwareOf: no 0xF745
 * resend), then Movement_Teleport → Movement_UpdatePos → 0xF748. Retail puts a known object with no
 * cell in the world from that position alone: SmartBox::HandleReceivedPosition (EoL @ 00453fd0,
 * 1999 @ 0x0040fb7d) → CPhysicsObj::MoveOrTeleport (EoL @ 00516330: cell == 0 → SetPosition; 1999
 * @ 0x004337b0: no cell → teleport_hook + SetPositionSimple).
 *
 * Driven end to end with real bytes: the Apple's 0xF745 from the committed 1999 session capture, a
 * 0x19A and an 0xF748 built per the server's writers (ObjectMsgs.cpp InventoryDrop, PhatSDK
 * PositionPack::Pack), through the real Adapter1999 codecs and ServerMessageHandler, into the real
 * NonWorldObjectRecords + ServerObjectManager.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { decodeCapture } from '../tools/ac1999/decode-capture.js';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import { registerInventory1999 } from '../packages/network/src/era1999/codecs/Inventory1999.js';
import { registerMovement1999 } from '../packages/network/src/era1999/codecs/Movement1999.js';
import type { Player1999State } from '../packages/network/src/era1999/codecs/Player1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { BinaryReader, deserializeMessage, parseCreateObjectFromReader, PhysicsTimestamp, type CreateObjectData } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { NonWorldObjectRecords, placeKnownObjectByPosition } from '../packages/renderer/src/world/NonWorldObjectRecords.js';

const PLAYER = 0x50000003;
const APPLE = 0x9000005a;
const CELL = 0x937f002c;

const captured = decodeCapture(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
  .filter((m) => m.dir === 's2c' && m.opcode === 0xf745);

function adapter() {
  const c = emptyCodecs();
  registerObjects1999(c);
  const player = { guid: PLAYER, eventSequence: 100 } as Player1999State;
  registerInventory1999(c, { player: () => player });
  registerMovement1999(c, { playerGuid: () => PLAYER });
  return new Adapter1999(c, { account: 'acjs', log: () => {} });
}

/** The captured 1999 0xF745 for `guid`, translated and parsed by the real EoL parser. */
function capturedCreate(a: Adapter1999, guid: number): CreateObjectData {
  for (const m of captured) {
    const msg = deserializeMessage(a.inbound(m.data, m.group)[0]);
    if (msg.type !== 'direct') continue;
    const o = parseCreateObjectFromReader(new BinaryReader(msg.payload));
    if (o.guid === guid) return o;
  }
  throw new Error(`0x${guid.toString(16)} not in the capture`);
}

/** 0x19A as the server's SendNetMessage(InventoryDrop(item), PRIVATE_MSG, TRUE) wraps it. */
const putIn3D1999 = (item: number) => new Writer1999().u32(0xf7b0).u32(PLAYER).u32(7).u32(0x19a).u32(item).toBytes();

/** 0xF748 per PositionPack::Pack: contact + placement 0x65, x/y of the quaternion omitted. */
function updatePosition1999(guid: number, o: { instance: number; position: number; teleport: number }): Uint8Array {
  return new Writer1999().u32(0xf748).u32(guid)
    .u32(0x02 | 0x04 | 0x10 | 0x20).u32(CELL).f32(130.5).f32(42.25).f32(28.0)
    .f32(0.7071).f32(0.7071) // w, z
    .u32(0x65)
    .u16(o.instance).u16(o.position).u16(o.teleport).u16(0)
    .toBytes();
}

/** The main.ts wiring of the pieces under test (create / position / delete / stack size). */
function client() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (som as any).buildMesh = () => new THREE.Group();
  const records = new NonWorldObjectRecords();
  const deleted: number[] = [];
  som.onObjectDeleted = (o) => { deleted.push(o.guid); };
  /** handleObjectCreateOrUpdate's routing + tail: our own items are not world objects. */
  const create = (d: CreateObjectData): void => {
    if (d.containerId !== PLAYER && d.wielderId !== PLAYER) som.createObject(d);
    if (som.getObject(d.guid)) records.forget(d.guid); else records.remember(d);
  };
  const h = new ServerMessageHandler();
  const putIn3D: number[] = [];
  h.setHandlers({
    onObjectCreate: create,
    onInventoryPutIn3D: (d) => { putIn3D.push(d.itemGuid); },
    onUpdatePosition: (d) => {
      if (placeKnownObjectByPosition(records, { hasWorldObject: (g) => !!som.getObject(g), create }, d)) return;
      som.updatePosition(d);
    },
    onObjectDelete: (d) => { som.deleteObject(d.guid); records.forget(d.guid); },
    onSetStackSize: (d) => records.setStackSize(d.guid, d.stackSize, d.value),
  });
  const feed = (a: Adapter1999, bytes: Uint8Array, group = 3) => {
    for (const m of a.inbound(bytes, group)) h.handleMessage(deserializeMessage(m));
  };
  return { som, records, deleted, putIn3D, create, feed };
}

describe('BUG.ac1999-drop-not-shown: a dropped item appears on the ground', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('the captured Apple is a pack item (contained by the player, no position)', () => {
    const apple = capturedCreate(adapter(), APPLE);
    expect(apple.containerId).toBe(PLAYER);
    expect(apple.position).toBeNull();
    expect(apple.timestamps?.[PhysicsTimestamp.Instance]).toBe(1);
  });

  it('0x19A then 0xF748 (the server\'s order) puts it in the world where the server placed it', () => {
    const a = adapter();
    const c = client();
    c.create(capturedCreate(a, APPLE));
    expect(c.som.getObject(APPLE)).toBeUndefined();
    c.feed(a, putIn3D1999(APPLE));
    expect(c.putIn3D).toEqual([APPLE]);
    c.feed(a, updatePosition1999(APPLE, { instance: 1, position: 2, teleport: 2 }));
    const o = c.som.getObject(APPLE)!;
    expect(o, 'the dropped Apple is a world object').toBeDefined();
    expect(o.name).toBe('Apple');
    expect(o.objCellId).toBe(CELL);
    expect(o.position).toMatchObject({ landblock: CELL, x: 130.5, y: 42.25, z: 28 });
    expect(o.placement).toBe(0x65);
    expect(o.wielderId).toBe(0);
    expect(o.instanceSequence).toBe(1);
    expect(c.records.has(APPLE)).toBe(false);
  });

  it('0xF748 before 0x19A places it too (retail\'s MoveOrTeleport does not wait on the pack)', () => {
    const a = adapter();
    const c = client();
    c.create(capturedCreate(a, APPLE));
    c.feed(a, updatePosition1999(APPLE, { instance: 1, position: 2, teleport: 2 }));
    expect(c.som.getObject(APPLE)).toBeDefined();
    c.feed(a, putIn3D1999(APPLE));
    expect(c.som.getObject(APPLE)).toBeDefined();
  });

  it('a later 0xF748 moves the placed object (no second create)', () => {
    const a = adapter();
    const c = client();
    c.create(capturedCreate(a, APPLE));
    c.feed(a, putIn3D1999(APPLE));
    c.feed(a, updatePosition1999(APPLE, { instance: 1, position: 2, teleport: 2 }));
    const first = c.som.getObject(APPLE);
    c.feed(a, updatePosition1999(APPLE, { instance: 1, position: 3, teleport: 2 }));
    expect(c.som.getObject(APPLE)).toBe(first);
    expect(c.deleted).toEqual([]);
  });

  it('a split-off stack shows the count it was dropped with (SetStackSize while carried)', () => {
    const a = adapter();
    const c = client();
    const pyreal = capturedCreate(a, 0x90000056);
    expect(pyreal.stackSize).toBe(100);
    c.create(pyreal);
    c.feed(a, new Writer1999().u32(0x197).u32(0x90000056).u32(40).u32(40).toBytes());
    c.feed(a, putIn3D1999(0x90000056));
    c.feed(a, updatePosition1999(0x90000056, { instance: 1, position: 2, teleport: 2 }));
    expect(c.som.getObject(0x90000056)?.stackSize).toBe(40);
  });

  it('a ground item picked up and dropped again reappears (the pickup keeps its record)', () => {
    const a = adapter();
    const c = client();
    const ground = { ...capturedCreate(a, APPLE), containerId: 0, position: { landblock: CELL, x: 1, y: 2, z: 3, rw: 1, rx: 0, ry: 0, rz: 0 } };
    c.create(ground);
    expect(c.som.getObject(APPLE)).toBeDefined();
    // handleInventoryPut's pick-up: the world record goes, the carried record stays.
    c.records.carryFromWorld(c.som.getObject(APPLE)!.createData!, PLAYER);
    c.som.deleteObject(APPLE, 'pickup');
    expect(c.som.getObject(APPLE)).toBeUndefined();
    c.feed(a, putIn3D1999(APPLE));
    c.feed(a, updatePosition1999(APPLE, { instance: 1, position: 4, teleport: 4 }));
    expect(c.som.getObject(APPLE)?.objCellId).toBe(CELL);
  });

  it('an 0xF748 for an object the client never knew still makes nothing (queued by the blob gate in main)', () => {
    const a = adapter();
    const c = client();
    c.feed(a, updatePosition1999(0x90000999, { instance: 1, position: 2, teleport: 2 }));
    expect(c.som.getObject(0x90000999)).toBeUndefined();
  });

  it('a deleted carried item is forgotten: a stray 0xF748 does not bring it back', () => {
    const a = adapter();
    const c = client();
    c.create(capturedCreate(a, APPLE));
    c.feed(a, new Writer1999().u32(0xf747).u32(APPLE).u16(1).u16(0).toBytes());
    c.feed(a, updatePosition1999(APPLE, { instance: 1, position: 2, teleport: 2 }));
    expect(c.som.getObject(APPLE)).toBeUndefined();
  });

  it('end of retail / Dark Majesty: the server\'s CreateObject after the placing position updates the same object in place', () => {
    const a = adapter();
    const c = client();
    const apple = capturedCreate(a, APPLE);
    c.create(apple);
    c.feed(a, updatePosition1999(APPLE, { instance: 1, position: 2, teleport: 2 }));
    const placed = c.som.getObject(APPLE);
    // ACE / GDLE: the object enters the dropper's ObjectMaint → a CreateObject with a position.
    c.create({ ...apple, containerId: 0, position: { landblock: CELL, x: 130.5, y: 42.25, z: 28, rw: 0.7071, rx: 0, ry: 0, rz: 0.7071 } });
    expect(c.som.getObject(APPLE)).toBe(placed);
    expect(c.deleted).toEqual([]);
  });

  it('end of retail / Dark Majesty: a CreateObject first leaves nothing for the position to place', () => {
    const a = adapter();
    const c = client();
    const apple = capturedCreate(a, APPLE);
    c.create(apple);
    c.create({ ...apple, containerId: 0, position: { landblock: CELL, x: 1, y: 2, z: 3, rw: 1, rx: 0, ry: 0, rz: 0 } });
    expect(c.records.has(APPLE)).toBe(false);
    const obj = c.som.getObject(APPLE);
    c.feed(a, updatePosition1999(APPLE, { instance: 1, position: 2, teleport: 2 }));
    expect(c.som.getObject(APPLE)).toBe(obj);
  });
});
