/**
 * The 1999 object codecs (packages/network/src/era1999/codecs/Objects1999.ts): every
 * object-family message the real 1999 server sent in the committed session capture is
 * translated and parsed by our REAL end-of-retail parsers (parseCreateObjectFromReader,
 * ServerMessageHandler), plus built 1999 messages for the layouts the capture lacks.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decodeCapture, type Message1999 } from '../tools/ac1999/decode-capture.js';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerObjects1999, type Objects1999Options } from '../packages/network/src/era1999/codecs/Objects1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import {
  BinaryReader, deserializeMessage, parseCreateObjectFromReader, type CreateObjectData, type DirectMessage,
} from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import * as THREE from 'three';

const OBJECT_OPS = new Set([0xf745, 0xf746, 0xf747, 0xf625, 0xf74b, 0xf74e, 0xf749, 0xf74a, 0xf750, 0xf755, 0xf751]);

const capture: Message1999[] = decodeCapture(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
  .filter((m) => m.dir === 's2c' && OBJECT_OPS.has(m.opcode));

function adapter(opts?: Objects1999Options) {
  const logs: string[] = [];
  const c = emptyCodecs();
  registerObjects1999(c, opts);
  return { a: new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) }), logs };
}

function direct(bytes: Uint8Array): DirectMessage {
  const m = deserializeMessage(bytes);
  if (m.type !== 'direct') throw new Error('not a direct message');
  return m;
}

/** Parse an EoL 0xF745 with the real parser, asserting it consumes the payload exactly. */
function parseCreate(bytes: Uint8Array): CreateObjectData {
  const { payload } = direct(bytes);
  const r = new BinaryReader(payload);
  const obj = parseCreateObjectFromReader(r);
  expect(r.position).toBe(payload.length);
  return obj;
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);

/** Every handler the object messages reach, recording what arrived. */
function recordingHandler() {
  const got: Record<string, unknown[]> = {};
  const rec = (k: string) => (d: unknown) => { (got[k] ??= []).push(d); };
  const h = new ServerMessageHandler();
  h.setHandlers({
    onObjectCreate: rec('create'), onPlayerCreate: rec('playerCreate'), onObjectDelete: rec('delete'),
    onObjDescEvent: rec('objDesc'), onSetState: rec('setState'), onVectorUpdate: rec('vector'),
    onParentEvent: rec('parent'), onPickupEvent: rec('pickup'), onSound: rec('sound'),
    onPlayEffect: rec('effect'), onPlayerTeleport: () => rec('teleport')(true),
  });
  return { h, got };
}

describe('1999 object messages from the real session capture', () => {
  it('the capture has the object family', () => {
    const ops = new Set(capture.map((m) => m.opcode));
    for (const op of [0xf745, 0xf746, 0xf747, 0xf625, 0xf74b, 0xf74e]) expect(ops.has(op)).toBe(true);
    expect(capture.filter((m) => m.opcode === 0xf745).length).toBeGreaterThanOrEqual(70);
  });

  it('every one translates to exactly one EoL message with no notes', () => {
    const { a, logs } = adapter();
    for (const m of capture) {
      const out = a.inbound(m.data, m.group);
      expect(out, `0x${m.opcode.toString(16)} seq ${m.seq}`).toHaveLength(1);
      expect(direct(out[0]).opcode).toBe(m.opcode);
    }
    expect(logs).toEqual([]);
    expect([...a.unknownInbound.keys()]).toEqual([]);
  });

  it('every ObjectCreate parses exactly, with the 1999 bytes\' name, wcid and icon', () => {
    const { a } = adapter();
    const creates = capture.filter((m) => m.opcode === 0xf745);
    for (const m of creates) {
      const obj = parseCreate(a.inbound(m.data, m.group)[0]);
      // Independently locate the 1999 PublicWeenieDesc name (AcString incl. NUL) and the u16s after its pad.
      const nameBytes = Buffer.from(`${obj.name}\0`, 'latin1');
      const at = Buffer.from(m.data).indexOf(Buffer.concat([Buffer.from([nameBytes.length, 0]), nameBytes]));
      expect(at, obj.name).toBeGreaterThan(8);
      const after = (at + 2 + nameBytes.length + 3) & ~3;
      expect(obj.weenieClassId).toBe(u16(m.data, after));
      expect(obj.iconId).toBe((0x06000000 | u16(m.data, after + 2)) >>> 0);
      expect(obj.guid).toBe(new DataView(m.data.buffer, m.data.byteOffset).getUint32(4, true));
      expect(obj.setupId >>> 24).toBe(0x02);
      if (obj.motionTableId) expect(obj.motionTableId >>> 24).toBe(0x09);
      if (obj.soundTableId) expect(obj.soundTableId >>> 24).toBe(0x20);
      if (obj.peTableId) expect(obj.peTableId >>> 24).toBe(0x34);
      expect(obj.timestamps).toHaveLength(9);
    }
  });

  it('the player, an NPC, a pack item and a wielded weapon carry their 1999 fields', () => {
    const { a } = adapter();
    const objs = capture.filter((m) => m.opcode === 0xf745).map((m) => parseCreate(a.inbound(m.data, m.group)[0]));
    const byName = (n: string) => objs.find((o) => o.name === n)!;

    const player = objs.find((o) => o.guid === 0x50000003)!;
    expect(player.name).toBe('Acjsdbja');
    expect(player.weenieClassId).toBe(1);
    expect(player.iconId).toBe(0x060004da);
    expect(player.itemType).toBe(0x10); // TYPE_CREATURE
    expect(player.objectDescFlags & 0x8).toBe(0x8); // BF_PLAYER
    expect(player.itemsCapacity).toBe(102);
    expect(player.containersCapacity).toBe(7);
    expect(player.radarBehavior).toBe(4);
    expect(player.setupId).toBe(0x02000001);
    expect(player.motionTableId).toBe(0x09000001);
    expect(player.position!.landblock >>> 16).toBe(0xde51); // Shoushi
    expect(player.position!.landblock & 0xffff).toBeLessThan(0x41); // an outdoor cell
    expect(Math.hypot(player.position!.rw, player.position!.rx, player.position!.ry, player.position!.rz)).toBeCloseTo(1, 4);
    expect(player.timestamps![8]).toBe(2); // instance

    const lifestone = byName('Life Stone');
    expect(lifestone.weenieClassId).toBe(509);
    expect(lifestone.radarColor).toBe(1);

    const well = byName('Well');
    expect(well.placement).toBe(0x65); // ANIMFRAME Resting
    expect(well.value).toBe(200);

    const pyreal = byName('Pyreal');
    expect(pyreal.containerId).toBe(0x50000003);
    expect(pyreal.position).toBeNull();
    expect([pyreal.stackSize, pyreal.maxStackSize, pyreal.value]).toEqual([100, 5000, 100]);

    const dart = byName('Throwing Dart');
    expect(dart.physicsParentId).toBe(0x60000073);
    expect(dart.wielderId).toBe(0x60000073);
    expect(dart.parentLocation).toBe(1);

    const banderling = byName('Black Rabbit');
    expect(banderling.weenieClassId).toBe(2566);
  });

  it('ObjDescEvents carry the 1999 appearance with the right DID types', () => {
    const { a } = adapter();
    const { h, got } = recordingHandler();
    for (const m of capture.filter((x) => x.opcode === 0xf625)) h.handleMessage(direct(a.inbound(m.data, m.group)[0]));
    const events = got.objDesc as { guid: number; basePalette: number; subPalettes: { paletteId: number; offset: number; length: number }[];
      textureChanges: { newTexture: number }[]; animPartChanges: { partId: number }[]; instanceSequence: number; visualDescSequence: number }[];
    expect(events.length).toBe(capture.filter((x) => x.opcode === 0xf625).length);
    const player = events.find((e) => e.guid === 0x50000003)!;
    expect(player.basePalette).toBe(0x0400007e);
    expect(player.subPalettes[0]).toEqual({ paletteId: 0x040004a7, offset: 0, length: 0x18 * 8 });
    expect(player.textureChanges.every((t) => t.newTexture >>> 24 === 0x05)).toBe(true);
    expect(player.animPartChanges.every((p) => p.partId >>> 24 === 0x01)).toBe(true);
    expect([player.instanceSequence, player.visualDescSequence]).toEqual([2, 1]);
    const empty = events.find((e) => e.guid === 0x60000011)!;
    expect([empty.subPalettes.length, empty.instanceSequence, empty.visualDescSequence]).toEqual([0, 1, 1]);
  });

  it('PlayerCreate, ObjectDelete, SetState and VectorUpdate keep every field and sequence', () => {
    const { a } = adapter();
    const { h, got } = recordingHandler();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const m of capture) h.handleMessage(direct(a.inbound(m.data, m.group)[0]));
      expect(err).not.toHaveBeenCalled();
    } finally { err.mockRestore(); }
    expect(got.create!.length).toBe(capture.filter((m) => m.opcode === 0xf745).length);
    expect(new DataView((got.playerCreate![0] as Uint8Array).buffer, (got.playerCreate![0] as Uint8Array).byteOffset).getUint32(0, true)).toBe(0x50000003);
    expect(got.delete).toEqual([{ guid: 0x50000003, instanceSequence: 1 }]);
    expect(got.setState).toEqual([{ guid: 0x50000003, physicsState: 0x00400408, instanceSequence: 2, stateSequence: 1 }]);
    const v = got.vector![0] as { guid: number; velocity: { z: number }; instanceSequence: number; vectorSequence: number };
    expect(v.guid).toBe(0x50000003);
    expect(v.velocity.z).toBeCloseTo(3.4754, 3); // a jump
    expect([v.instanceSequence, v.vectorSequence]).toEqual([2, 1]);
  });
});

/** 1999 ObjectCreate built as the AC1999 server's writers lay it out (ObjDesc.cpp, PhysicsDesc.cpp, OldPublicWeenieDesc.cpp). */
function create1999(o: { pdFlags: number; pwdHeader: number; movement?: Uint8Array; tail?: (w: Writer1999) => void }): Uint8Array {
  const w = new Writer1999().u32(0xf745).u32(0x90001234);
  // ObjDesc: 1 subpalette, 1 TMC, 1 APC; a DID offset above 0x7FFF exercises the 4-byte PackedDword.
  w.u8(0x11).u8(1).u8(1).u8(1).u16(0x007e).u16(0x8123).u8(0x18).u8(0).u8(16).u16(0x0abc).u16(0x0abd).u8(3).u16(0x9001).align4();
  w.u32(o.pdFlags).u32(0x408);
  if (o.pdFlags & 0x10000) { w.u32(o.movement!.length).bytes(o.movement!).u32(1); } else if (o.pdFlags & 0x20000) w.u32(0x65);
  if (o.pdFlags & 0x8000) w.u32(0x905c003c).f32(10).f32(20).f32(30).f32(1).f32(0).f32(0).f32(0);
  if (o.pdFlags & 0x2) w.u32(0x09000001);
  if (o.pdFlags & 0x1) w.u32(0x02000155);
  if (o.pdFlags & 0x40) w.u32(1).u32(0x90000001).u32(2);
  if (o.pdFlags & 0x80) w.f32(1.5);
  if (o.pdFlags & 0x4) w.f32(1).f32(2).f32(3);
  for (let i = 0; i < 9; i++) w.u16(i + 1);
  w.align4();
  w.u32(o.pwdHeader).acString('Arrow').u16(0x8100).u16(0x9abc).u32(0x100).u32(0x10);
  o.tail?.(w);
  return w.align4().toBytes();
}

describe('1999 layouts the capture lacks', () => {
  it('maps the PublicWeenieDesc order and widths, dropping the bits EoL means differently', () => {
    const { a, logs } = adapter();
    const bytes = create1999({
      pdFlags: 0x1 | 0x2 | 0x4 | 0x40 | 0x80 | 0x8000 | 0x20000 | 0x40000, // incl. a 1999-meaningless translucency bit
      pwdHeader: 0x1 | 0x8 | 0x20 | 0x80000 | 0x80 | 0x100 | 0x200 | 0x1000 | 0x2000 | 0x4000 | 0x100000 | 0x800000 | 0x1000000 | 0x200000 | 0x400000,
      tail: (w) => w.acString('Arrows').u32(3).f32(2.5).u32(0x80).u32(0x4).u8(1).u8(2).u16(40).u16(250)
        .u32(0x50000003).u8(9).u8(4).u32(0xdeadbeef).u16(4525).u16(0x2bc),
    });
    const obj = parseCreate(a.inbound(bytes, 3)[0]);
    expect(logs).toEqual([]);
    expect(obj.name).toBe('Arrow');
    expect(obj.pluralName).toBe('Arrows');
    expect(obj.weenieClassId).toBe(0x8100);
    expect(obj.iconId).toBe(0x06009abc);
    expect([obj.value, obj.useRadius, obj.targetType, obj.uiEffects]).toEqual([3, 2.5, 0x80, 0x4]);
    expect([obj.ammoType, obj.combatUse, obj.stackSize, obj.maxStackSize]).toEqual([1, 2, 40, 250]);
    expect([obj.containerId, obj.radarColor, obj.radarBehavior, obj.spellDid]).toEqual([0x50000003, 9, 4, 0x2bc]);
    expect(obj.burden).toBe(0); // 1999 0x200000 is the issuing vendor, not burden
    expect(obj.translucency).toBe(0);
    expect(obj.basePalette).toBe(0x0400007e);
    expect(obj.subPalettes).toEqual([{ paletteId: 0x04008123, offset: 0x18 * 8, length: 256 * 8 }]);
    expect(obj.textureChanges).toEqual([{ partIndex: 16, oldTexture: 0x05000abc, newTexture: 0x05000abd }]);
    expect(obj.animPartChanges).toEqual([{ partIndex: 3, partId: 0x01009001 }]);
    expect(obj.position).toEqual({ landblock: 0x905c003c, x: 10, y: 20, z: 30, rw: 1, rx: 0, ry: 0, rz: 0 });
    expect(obj.placement).toBe(0x65);
    expect(obj.objScale).toBe(1.5);
    expect([obj.velocityX, obj.velocityY, obj.velocityZ]).toEqual([1, 2, 3]);
    expect(obj.timestamps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('a MOVEMENT blob goes through the movement translator, or is dropped with a note', () => {
    const blob = new Uint8Array([1, 2, 3, 4]);
    const bytes = create1999({ pdFlags: 0x1 | 0x10000 | 0x20000, pwdHeader: 0, movement: blob });
    const dropped = adapter();
    const obj = parseCreate(dropped.a.inbound(bytes, 3)[0]);
    expect(obj.initialMotion).toBeUndefined();
    expect(obj.placement).toBeUndefined(); // 1999 sent no ANIMFRAME beside MOVEMENT; EoL must not read one
    expect(obj.setupId).toBe(0x02000155);
    expect(dropped.logs.join()).toMatch(/movement blob/);

    const seen: Uint8Array[] = [];
    const kept = adapter({ movement: (b) => { seen.push(b); return new Uint8Array(0); } });
    parseCreate(kept.a.inbound(bytes, 3)[0]);
    expect(seen).toEqual([blob]);
  });

  it('carries every other 1999 header field; burden stays 0 because a 1999 create never sends one', () => {
    // OldPublicWeenieDesc.cpp Pack: capacities, useability, structure, wielder, valid / current
    // location and priority. 1999 has no burden slot (0x200000 is the trade note's issuing vendor),
    // so an item's burden is unknown until appraised (IdentifyObjectResponse keeps ENCUMB_VAL), as in 1999.
    const { a, logs } = adapter();
    const bytes = create1999({
      pdFlags: 0x1,
      pwdHeader: 0x2 | 0x4 | 0x10 | 0x400 | 0x800 | 0x8000 | 0x10000 | 0x20000 | 0x40000 | 0x200000,
      tail: (w) => w.u8(24).u8(3).u32(0x80008).u16(7).u16(10).u32(0x50000003).u32(0x200000).u32(0x200000).u32(0x8)
        .u16(4525),
    });
    const obj = parseCreate(a.inbound(bytes, 3)[0]);
    expect(logs).toEqual([]);
    expect([obj.itemsCapacity, obj.containersCapacity, obj.usable]).toEqual([24, 3, 0x80008]);
    expect([obj.structure, obj.maxStructure]).toEqual([7, 10]);
    expect([obj.wielderId, obj.validLocations, obj.currentWieldedLocation, obj.clothingPriority]).toEqual([0x50000003, 0x200000, 0x200000, 0x8]);
    expect(obj.burden).toBe(0);
  });

  it('rejects a header bit the 1999 reader has no arm for', () => {
    const { a, logs } = adapter();
    expect(a.inbound(create1999({ pdFlags: 0x1, pwdHeader: 0x40 }), 3)).toEqual([]);
    expect(logs.join()).toMatch(/0x40/);
  });

  it('ParentEvent, PickupEvent, SoundEvent, PlayScriptType and PlayerTeleport as the AC1999 server writes them', () => {
    const { a } = adapter();
    const { h, got } = recordingHandler();
    const send = (w: Writer1999) => { for (const m of a.inbound(w.toBytes(), 3)) h.handleMessage(direct(m)); };
    send(new Writer1999().u32(0xf749).u32(0x50000003).u32(0x90000010).u32(1).u32(0x65).u16(2).u16(7));
    send(new Writer1999().u32(0xf74a).u32(0x90000010).u16(1).u16(8));
    send(new Writer1999().u32(0xf750).u32(0x50000003).u32(0x76).f32(1));
    send(new Writer1999().u32(0xf755).u32(0x50000003).u32(0x2c).f32(0.5));
    send(new Writer1999().u32(0xf751).u32(5)); // the server writes the u16 teleport seq as a u32
    expect(got.parent).toEqual([{ creatureGuid: 0x50000003, wieldedGuid: 0x90000010, parentLocation: 1, placement: 0x65, instanceSequence: 2, positionSequence: 7 }]);
    expect(got.pickup).toEqual([{ guid: 0x90000010, instanceSequence: 1, positionSequence: 8 }]);
    expect(got.sound).toEqual([{ guid: 0x50000003, soundId: 0x76, volume: 1 }]);
    // 1999 ordinal 0x2C (Shield block) is EoL 0x2D: 1999 has no SkillDownBlack (30).
    expect(got.effect).toEqual([{ guid: 0x50000003, effectId: 0x2d, scale: 0.5 }]);
    expect(got.teleport).toHaveLength(1);
    expect(direct(a.inbound(new Writer1999().u32(0xf751).u32(5).toBytes(), 3)[0]).payload).toEqual(new Uint8Array([5, 0, 0, 0]));
  });
});

describe('a re-sent 0xF745 (1999 has no 0xF7DB UpdateObject)', () => {
  it('stays an ObjectCreate and updates the held object in place, as the 1999 client does', () => {
    const { a, logs } = adapter();
    // A captured world object (has a position): re-sent with a new name, same instance stamp.
    const m = capture.find((x) => x.opcode === 0xf745 && parseCreate(a.inbound(x.data, 3)[0]).position)!;
    const first = parseCreate(a.inbound(m.data, 3)[0]);
    const resent = a.inbound(m.data, 3);
    expect(resent).toHaveLength(1);
    expect(direct(resent[0]).opcode).toBe(0xf745);
    const again = { ...parseCreate(resent[0]), name: 'Renamed' };
    expect(again.timestamps).toEqual(first.timestamps);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
    let builds = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).buildMesh = () => { builds++; return new THREE.Group(); };
    const deleted: number[] = [];
    som.onObjectDeleted = (o) => { deleted.push(o.guid); };
    const held = som.createObject(first)!;
    expect(som.createObject(again)).toBe(held); // the create path, not UpdateObject's teardown
    expect(held.name).toBe('Renamed');
    expect(builds).toBe(1);
    expect(deleted).toEqual([]);
    expect(logs).toEqual([]);
  });
});
