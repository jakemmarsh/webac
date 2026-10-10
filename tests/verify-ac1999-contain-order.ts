/**
 * The 1999 server's spawn-into-a-pack order (Container.cpp SpawnInContainer: the 0x22
 * InventoryMove BEFORE MakeAware's 0xF745, and a create built for a free object: world
 * POSITION, no container) put into end-of-retail order by
 * packages/network/src/era1999/codecs/ContainOrder1999.ts. Live 2026-10-07: a Metal Cap bought
 * from Sedor Wystan took the pyreals but never reached the pack. The bytes are built as the
 * AC1999 server writes them and fed through the REAL adapter, parser, handler and router.
 */
import { describe, expect, it } from 'vitest';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { codecs1999 } from '../packages/network/src/era1999/codecs/index.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import { registerInventory1999 } from '../packages/network/src/era1999/codecs/Inventory1999.js';
import { placeCreateInContainer, registerContainOrder1999 } from '../packages/network/src/era1999/codecs/ContainOrder1999.js';
import type { Player1999State } from '../packages/network/src/era1999/codecs/Player1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import {
  BinaryReader, deserializeMessage, parseCreateObjectFromReader, type CreateObjectData,
} from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { routeObjectSubject } from '../packages/renderer/src/network/objectSubjectRouting.js';

const PLAYER = 0x50000003;
const CAP = 0x90000343;
const CORPSE = 0x90000100;

/** A 0xF7B0-wrapped 0x22 InventoryMove, as SpawnInContainer sends it (PRIVATE_MSG, event = TRUE). */
const put22 = (item: number, container: number, seq = 42) =>
  new Writer1999().u32(0xf7b0).u32(PLAYER).u32(seq).u32(0x22).u32(item).u32(container).u32(0).u32(0).toBytes();
const flatPut22 = (item: number, container: number) =>
  new Writer1999().u32(0x22).u32(item).u32(container).u32(0).u32(0).toBytes();

/**
 * A 1999 0xF745 as BuildPhysicsDesc1999 / OldPublicWeenieDesc::Pack lay it out for an item that is
 * not contained yet: POSITION from its unset frame, no 0x4000 container. Every PublicWeenieDesc
 * field that precedes CONTAINER in the end-of-retail order is present (the insert point), and one
 * that follows it (valid locations).
 */
function create1999(guid: number, opts: { container?: number; position?: boolean } = {}): Uint8Array {
  const pos = opts.position ?? true;
  const w = new Writer1999().u32(0xf745).u32(guid);
  w.u8(0x11).u8(1).u8(0).u8(1).u16(0x007e).u16(0x8123).u8(0).u8(0).u8(2).u16(0x9001).align4();
  const pd = 0x1 | 0x2 | 0x20000 | (pos ? 0x8000 : 0);
  w.u32(pd).u32(0x14).u32(0x65);
  if (pos) w.u32(0).f32(0).f32(0).f32(0).f32(1).f32(0).f32(0).f32(0);
  w.u32(0x09000001).u32(0x020000c4);
  for (let i = 0; i < 9; i++) w.u16(i + 1);
  w.align4();
  const header = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x1000 | 0x2000 | 0x10000
    | (opts.container !== undefined ? 0x4000 : 0);
  w.u32(header).acString('Metal Cap').u16(0x0102).u16(0x1aa5).u32(0x2).u32(0x10);
  // 1999 order (Objects1999 file comment): plural, itemsCap, containersCap, value, useability, useRadius,
  // effects, ammo, combatUse, structure, maxStructure, stack, maxStack, [container], validLocations.
  w.acString('Metal Caps').u8(0).u8(0).u32(92).u32(1).f32(0.5).u32(0).u8(0).u8(0).u16(5).u16(10).u16(1).u16(1);
  if (opts.container !== undefined) w.u32(opts.container);
  w.u32(0x1);
  return w.align4().toBytes();
}

const opOf = (m: Uint8Array) => new DataView(m.buffer, m.byteOffset).getUint32(0, true);
const eventTypeOf = (m: Uint8Array) => new DataView(m.buffer, m.byteOffset).getUint32(12, true);

function parseCreate(m: Uint8Array): CreateObjectData {
  const msg = deserializeMessage(m);
  if (msg.type !== 'direct') throw new Error('not a direct message');
  const r = new BinaryReader(msg.payload);
  const obj = parseCreateObjectFromReader(r);
  expect(r.position).toBe(msg.payload.length);
  return obj;
}

function rig(opts: { now?: () => number; holdMs?: number; maxHeld?: number } = {}) {
  const logs: string[] = [];
  const c = emptyCodecs();
  registerObjects1999(c, { movement: (b) => b });
  const player = { guid: PLAYER, eventSequence: 100 } as Player1999State;
  registerInventory1999(c, { player: () => player });
  const stage = registerContainOrder1999(c, opts);
  return { a: new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) }), stage, logs };
}

describe('SpawnInContainer order (0x22 before the item exists) → end-of-retail order', () => {
  it('codecs1999 installs it: the held 0x22 follows the create, which now names the pack and has no position', () => {
    const a = new Adapter1999(codecs1999(), { account: 'acjs', log: () => {} });
    expect(a.inbound(put22(CAP, PLAYER), 4)).toEqual([]);
    const out = a.inbound(create1999(CAP), 3);
    expect(out.map(opOf)).toEqual([0xf745, 0xf7b0]);
    expect(eventTypeOf(out[1])).toBe(0x22);
    const obj = parseCreate(out[0]);
    expect(obj.guid).toBe(CAP);
    expect(obj.containerId).toBe(PLAYER);
    expect(obj.position).toBeNull();
    // Everything around the insert point survived.
    expect([obj.name, obj.pluralName, obj.value, obj.stackSize, obj.maxStackSize, obj.validLocations]).toEqual(['Metal Cap', 'Metal Caps', 92, 1, 1, 0x1]);
    expect([obj.setupId, obj.motionTableId, obj.placement]).toEqual([0x020000c4, 0x09000001, 0x65]);
    expect(obj.subPalettes).toEqual([{ paletteId: 0x04008123, offset: 0, length: 256 * 8 }]);
    expect(obj.timestamps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // The client files it as a carried item (before: 'world', and the 0x22 was for an unknown guid).
    expect(routeObjectSubject(obj, PLAYER, [])).toBe('own-inventory');
  });

  it('the real handler sees ObjectCreate, then InventoryPutObjInContainer, as ACE sends a vendor buy', () => {
    const { a } = rig();
    const seen: string[] = [];
    const h = new ServerMessageHandler();
    h.setHandlers({
      onObjectCreate: (d) => seen.push(`create ${d.guid.toString(16)} in ${d.containerId.toString(16)}`),
      onInventoryPut: (d) => seen.push(`put ${d.itemGuid.toString(16)} in ${d.containerGuid.toString(16)} slot ${d.slot}`),
    });
    for (const m of [...a.inbound(put22(CAP, PLAYER), 4), ...a.inbound(create1999(CAP), 3)]) h.handleMessage(deserializeMessage(m));
    expect(seen).toEqual(['create 90000343 in 50000003', 'put 90000343 in 50000003 slot 0']);
  });

  it('the flat 0x22 form waits the same way', () => {
    const { a } = rig();
    expect(a.inbound(flatPut22(CAP, PLAYER), 4)).toEqual([]);
    const out = a.inbound(create1999(CAP), 3);
    expect(out.map(opOf)).toEqual([0xf745, 0xf7b0]);
    expect(parseCreate(out[0]).containerId).toBe(PLAYER);
  });

  it('a viewer of a corpse gets the item placed in the corpse (the openedBy branch)', () => {
    const { a } = rig();
    a.inbound(put22(CAP, CORPSE), 4);
    expect(parseCreate(a.inbound(create1999(CAP), 3)[0]).containerId).toBe(CORPSE);
  });

  it('a 0x22 for an item already created passes at once, and the create is untouched', () => {
    const { a, stage } = rig();
    const create = a.inbound(create1999(CAP), 3);
    expect(parseCreate(create[0]).position).not.toBeNull();
    const out = a.inbound(put22(CAP, PLAYER), 4);
    expect(out).toHaveLength(1);
    expect(stage.pending).toBe(0);
  });

  it('a create that already names a container is passed through byte for byte', () => {
    const { a } = rig();
    const direct = rig().a.inbound(create1999(CAP, { container: PLAYER, position: false }), 3)[0];
    a.inbound(put22(CAP, PLAYER), 4);
    const out = a.inbound(create1999(CAP, { container: PLAYER, position: false }), 3);
    expect(Array.from(out[0])).toEqual(Array.from(direct));
    expect(out.map(opOf)).toEqual([0xf745, 0xf7b0]);
  });

  it('a held 0x22 whose create never comes goes out unchanged once it is too old', () => {
    let t = 1000;
    const { a, logs } = rig({ now: () => t, holdMs: 3000 });
    expect(a.inbound(put22(0x90000999, PLAYER), 4)).toEqual([]);
    t += 2999;
    expect(a.inbound(create1999(CAP), 3).map(opOf)).toEqual([0xf745]);
    t += 1;
    const out = a.inbound(create1999(CAP + 1), 3);
    expect(out.map(opOf)).toEqual([0xf7b0, 0xf745]);
    expect(eventTypeOf(out[0])).toBe(0x22);
    expect(new DataView(out[0].buffer, out[0].byteOffset).getUint32(16, true)).toBe(0x90000999);
    expect(logs.some((l) => /0x90000999 got no CreateObject/.test(l))).toBe(true);
  });

  it('at most maxHeld wait; past it the oldest goes out', () => {
    const { a, stage } = rig({ maxHeld: 2 });
    a.inbound(put22(0x90000901, PLAYER), 4);
    a.inbound(put22(0x90000902, PLAYER), 4);
    const out = a.inbound(put22(0x90000903, PLAYER), 4);
    expect(out).toHaveLength(1);
    expect(new DataView(out[0].buffer, out[0].byteOffset).getUint32(16, true)).toBe(0x90000901);
    expect(stage.pending).toBe(2);
  });

  it('a deleted object is unknown again: a later 0x22 for it waits for its next create', () => {
    const { a, stage } = rig();
    a.inbound(create1999(CAP), 3);
    a.inbound(new Writer1999().u32(0xf747).u32(CAP).u16(1).toBytes(), 3);
    expect(a.inbound(put22(CAP, PLAYER), 4)).toEqual([]);
    expect(stage.pending).toBe(1);
  });

  it('placeCreateInContainer refuses a create shorter than its own flags', () => {
    const full = rig().a.inbound(create1999(CAP), 3)[0];
    expect(() => placeCreateInContainer(full.subarray(0, full.length - 40), PLAYER)).toThrow(RangeError);
  });
});
