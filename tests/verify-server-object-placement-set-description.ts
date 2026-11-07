/**
 * BUG.server-object-placement-default-vs-set-description — the placement frame a CreateObject leaves.
 *
 * Retail: CPhysicsObj::makeObject (EoL @ 0x00513970) ends in InitObjectEnd @ 0x0050ffe0, which sets
 * Resting (0x65); SmartBox's create path (ObjMgr CreateObject, EoL @ 0x00558xxx caller of
 * set_description at 0x00514f40; 1999 @ 0x0043b510) then runs set_description: with a Movement
 * buffer it unpacks the motion (Resting stays), otherwise SetPlacementFrameInternal(animframe_id)
 * @ 0x0050f690. PhysicsDesc::UnPack @ 0x0051ddd0 begins with Destroy @ 0x0051d5d0 (animframe_id = 0)
 * and reads animframe_id only without Movement, so a desc with neither poses at Default (0).
 * CPartArray::SetPlacementFrame @ 0x005193d0 falls back to frame 0 when the Setup lacks the key.
 * A CreateObject for an object already held at the same instance (HandleCreateObject @ 0x00454c80)
 * hands the raw animframe_id to DoParentEvent @ 0x00452290 (SetPlacementFrame always) or
 * HandleReceivedPosition @ 0x00453fd0 (SetPlacementFrame when the object has no animations).
 *
 * Who sends neither field (measured 2026-11-07):
 *  - ACE / ClassicACE: every world object carries one (SetEphemeralValues defaults Placement to
 *    Resting; a motion table gives Movement) EXCEPT missiles: SetProjectilePhysicsState nulls both
 *    for every spell projectile and for thrown ammo whose Setup lacks MissileFlight (52).
 *  - GDLE (Classic Dereth / Seedsow): GetPhysicsObjData writes Movement or AnimationFrame, always.
 *  - AC1999 server: BuildPhysicsDesc1999 never writes Movement and writes ANIMFRAME only when the
 *    server part array's frame is non-zero, so an omitted field means frame 0 already (Setups
 *    without 0x65, e.g. Shoushi Outpost 0x02000612, the door / creature / lifestone / portal Setups).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import * as THREE from 'three';
import { BinaryReader, parseCreateObjectFromReader, deserializeMessage, PhysicsTimestamp, type CreateObjectData } from '../packages/network/src/MessageSerializer.js';
import { decodeCapture } from '../tools/ac1999/decode-capture.js';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { NonWorldObjectRecords } from '../packages/renderer/src/world/NonWorldObjectRecords.js';
import { createObjectAnimFrame, createObjectPlacement, serverObjectPlacement } from '../packages/renderer/src/models/WieldedItemVisual.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { getPartPlacements, PLACEMENT_RESTING } from '../packages/renderer/src/models/SetupModelGroup.js';
import { DAT_PATHS, DAT_SETS_DIR, openDat } from './_harness/dat.js';

const MISSILE_STATE = 0x40;        // PhysicsState.Missile
const MISSILE_FLIGHT = 52;         // Placement.MissileFlight
const RIGHT_HAND_COMBAT = 1;       // Placement.RightHandCombat
const CELL = 0xa9b40019;

// ── EoL PhysicsDesc bytes (ACE WorldObject_Networking.cs SerializePhysicsData; GDLE ObjectMsgs.cpp
//    GetPhysicsObjData writes the same layout) ──
const PD = { CSetup: 0x1, MTable: 0x2, Velocity: 0x4, Parent: 0x20, Position: 0x8000, Movement: 0x10000, AnimFrame: 0x20000 };

class Bytes {
  private b: number[] = [];
  u32(v: number): this { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v >>> 0, true); this.b.push(...a); return this; }
  u16(v: number): this { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v & 0xffff, true); this.b.push(...a); return this; }
  f32(v: number): this { const a = new Uint8Array(4); new DataView(a.buffer).setFloat32(0, v, true); this.b.push(...a); return this; }
  raw(xs: number[]): this { this.b.push(...xs); return this; }
  align(): this { while (this.b.length % 4) this.b.push(0); return this; }
  get length(): number { return this.b.length; }
  done(): Uint8Array { return new Uint8Array(this.b); }
}

/** Headerless MovementData (Invalid, NonCombat stance, CurrentStyle only): ACE's CurrentMotionState blob. */
const STANCE_BLOB = new Bytes().raw([0, 0]).u16(0x3d).u32(0x1).u16(0x3d).align().done();

interface Desc {
  guid: number; setupId: number; name?: string; state?: number;
  placement?: number;
  /** true = STANCE_BLOB; bytes = that buffer as sent (empty: length 0, no IsAutonomous). */
  movement?: boolean | Uint8Array;
  position?: boolean; parent?: [number, number]; velocity?: [number, number, number];
  instance?: number; positionTs?: number;
}

/** A CreateObject body as ACE / GDLE write it (EoL layout), parsed by the real EoL parser. */
function eolCreate(d: Desc): CreateObjectData {
  let flags = PD.CSetup;
  if (d.movement) flags |= PD.Movement; else if (d.placement !== undefined) flags |= PD.AnimFrame;
  if (d.position !== false && !d.parent) flags |= PD.Position;
  if (d.parent) flags |= PD.Parent;
  if (d.velocity) flags |= PD.Velocity;
  const w = new Bytes().u32(d.guid).raw([0x11, 0, 0, 0]).u32(flags).u32(d.state ?? 0);
  if (d.movement) {
    const blob = d.movement === true ? STANCE_BLOB : d.movement;
    w.u32(blob.length).raw([...blob]);
    if (blob.length > 0) w.u32(0); // IsAutonomous follows a non-empty buffer
  }
  else if (d.placement !== undefined) w.u32(d.placement);
  if (flags & PD.Position) { w.u32(CELL); for (const f of [84, 7.1, 94, 1, 0, 0, 0]) w.f32(f); }
  w.u32(d.setupId);
  if (d.parent) w.u32(d.parent[0]).u32(d.parent[1]);
  if (d.velocity) for (const v of d.velocity) w.f32(v);
  const ts = [d.positionTs ?? 1, 0, 0, 0, 0, 0, 0, 0, d.instance ?? 1];
  for (const t of ts) w.u16(t);
  w.align().u32(0);
  const name = d.name ?? 'Thing';
  w.u16(name.length).raw([...new TextEncoder().encode(name)]).align();
  w.u16(1000).u16(0x10).u32(0x80).u32(0);
  return parseCreateObjectFromReader(new BinaryReader(w.done()));
}

/** The real ServerObjectManager, recording the placement key each build and pose uses. */
function client() {
  const built: Array<{ setupId: number; key: number }> = [];
  const posed: number[] = [];
  const mesh = () => { const g = new THREE.Group(); const p = new THREE.Object3D(); p.name = 'part_0'; g.add(p); return g; };
  const som = new ServerObjectManager(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      createSetupMeshWithOverrides: (setupId: number, key: number) => { built.push({ setupId, key }); return mesh(); },
      loadSetupModel: () => null,
      posePlacement: (_g: unknown, _s: number, p: number) => { posed.push(p); return true; },
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { loadPaletteColors: () => null } as any,
    new THREE.Scene(),
  );
  return { som, built, posed, lastKey: () => built[built.length - 1]?.key };
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the retail rule (set_description @ 0x00514f40 / 1999 @ 0x0043b510)', () => {
  it('a sent AnimationFrame wins; neither field = Default (0); Movement keeps Resting (InitObjectEnd)', () => {
    expect(serverObjectPlacement({ placement: MISSILE_FLIGHT })).toBe(MISSILE_FLIGHT);
    expect(serverObjectPlacement({ placement: 0 })).toBe(0);
    expect(serverObjectPlacement({})).toBe(0);
    expect(serverObjectPlacement({ initialMotion: {} })).toBe(PLACEMENT_RESTING);
    // The held-item helper it shares (webac#26).
    expect(createObjectPlacement({ initialMotion: {} })).toBeUndefined();
  });

  it('the same-instance branch hands DoParentEvent / HandleReceivedPosition the raw animframe_id (0 unless sent)', () => {
    expect(createObjectAnimFrame({ placement: PLACEMENT_RESTING })).toBe(PLACEMENT_RESTING);
    expect(createObjectAnimFrame({})).toBe(0);
    expect(createObjectAnimFrame({ initialMotion: {} })).toBe(0);
  });
});

describe('End of retail on ACE (and ClassicACE, same writer)', () => {
  it('a world item: ACE sends AnimationFrame Resting (SetEphemeralValues) -> built at 0x65, unchanged', () => {
    const c = client();
    const o = c.som.createObject(eolCreate({ guid: 0x80000101, setupId: 0x020000eb, placement: PLACEMENT_RESTING }))!;
    expect(c.lastKey()).toBe(PLACEMENT_RESTING);
    expect(o.placement).toBe(PLACEMENT_RESTING);
  });

  it('a creature / door / corpse: Movement (CurrentMotionState) -> Resting stays, unchanged', () => {
    const c = client();
    const o = c.som.createObject(eolCreate({ guid: 0x80000102, setupId: 0x02000001, movement: true }))!;
    expect(o.createData?.initialMotion).toBeDefined();
    expect(c.lastKey()).toBe(PLACEMENT_RESTING);
    expect(o.placement).toBe(PLACEMENT_RESTING);
  });

  it('a spell projectile: SetProjectilePhysicsState nulls both -> Default (0), as retail (was Resting)', () => {
    const c = client();
    // Squall of Swords' Whirling Blade (wcid 7307, Setup 0x02000065: Resting differs from Default).
    const o = c.som.createObject(eolCreate({ guid: 0x80000103, setupId: 0x02000065, state: MISSILE_STATE, velocity: [0, 20, 0] }))!;
    expect(o.createData?.placement).toBeUndefined();
    expect(o.createData?.initialMotion).toBeUndefined();
    expect(c.lastKey()).toBe(0);
    expect(o.placement).toBe(0);
  });

  it('thrown ammo: no MissileFlight frame -> neither field -> 0; an arrow with one -> MissileFlight', () => {
    const c = client();
    c.som.createObject(eolCreate({ guid: 0x80000104, setupId: 0x0200130a, state: MISSILE_STATE, velocity: [0, 15, 3] })); // Throwing Axe
    expect(c.lastKey()).toBe(0);
    c.som.createObject(eolCreate({ guid: 0x80000105, setupId: 0x02000131, state: MISSILE_STATE, velocity: [0, 15, 3], placement: MISSILE_FLIGHT })); // Throwing Dart
    expect(c.lastKey()).toBe(MISSILE_FLIGHT);
  });
});

describe('set_description keys on the Movement buffer being present, not on it parsing', () => {
  it('a present but malformed buffer (truncated InterpretedMotionState) keeps Resting', () => {
    // movement_type Invalid, flags, style, then no room for the state bitfield: parseMovementData → null.
    const d = eolCreate({ guid: 0x80000106, setupId: 0x02000065, movement: new Uint8Array([0, 0, 0x3d, 0]) });
    expect(d.initialMotion).toBeUndefined();
    expect(d.hasMovement).toBe(true);
    expect(d.isAutonomous).toBe(false);
    expect(serverObjectPlacement(d)).toBe(PLACEMENT_RESTING);
    expect(createObjectAnimFrame(d)).toBe(0);
    const c = client();
    const o = c.som.createObject(d)!;
    expect(c.lastKey()).toBe(PLACEMENT_RESTING);
    expect(o.placement).toBe(PLACEMENT_RESTING);
  });

  it('a zero-length buffer is no Movement: animframe_id (0) → Default', () => {
    const d = eolCreate({ guid: 0x80000107, setupId: 0x02000065, movement: new Uint8Array(0) });
    expect(d.initialMotion).toBeUndefined();
    expect(d.hasMovement).toBeUndefined();
    const c = client();
    c.som.createObject(d);
    expect(c.lastKey()).toBe(0);
  });

  it('a parsed buffer sets both', () => {
    const d = eolCreate({ guid: 0x80000108, setupId: 0x02000001, movement: true });
    expect(d.hasMovement).toBe(true);
    expect(d.initialMotion).toBeDefined();
  });
});

describe('Dark Majesty on GDLE: Movement or AnimationFrame always (GetPhysicsObjData)', () => {
  it('the sent frame is used either way: unchanged', () => {
    const c = client();
    c.som.createObject(eolCreate({ guid: 0x80000201, setupId: 0x02000180, placement: PLACEMENT_RESTING }));
    expect(c.lastKey()).toBe(PLACEMENT_RESTING);
    // A part array that fell back to frame 0 writes an explicit 0.
    c.som.createObject(eolCreate({ guid: 0x80000202, setupId: 0x02000612, placement: 0 }));
    expect(c.lastKey()).toBe(0);
    c.som.createObject(eolCreate({ guid: 0x80000203, setupId: 0x0200047b, movement: true }));
    expect(c.lastKey()).toBe(PLACEMENT_RESTING);
  });
});

describe('AC1999 server: ANIMFRAME only when non-zero, never Movement (BuildPhysicsDesc1999)', () => {
  const captured = () => decodeCapture(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
    .filter((m) => m.dir === 's2c' && m.opcode === 0xf745);
  function create1999(guid: number): CreateObjectData {
    const codecs = emptyCodecs();
    registerObjects1999(codecs, { movement: (b) => b });
    const a = new Adapter1999(codecs, { account: 'acjs', log: () => {} });
    for (const m of captured()) {
      const msg = deserializeMessage(a.inbound(m.data, m.group)[0]);
      if (msg.type !== 'direct') continue;
      const o = parseCreateObjectFromReader(new BinaryReader(msg.payload));
      if (o.guid === guid) return o;
    }
    throw new Error(`0x${guid.toString(16)} not in the capture`);
  }

  it('the Well (sent 0x65) builds at Resting; Shoushi Outpost (omitted) builds at 0', () => {
    const c = client();
    const well = create1999(0x7de51007);
    expect(well.placement).toBe(PLACEMENT_RESTING);
    c.som.createObject(well);
    expect(c.lastKey()).toBe(PLACEMENT_RESTING);
    const outpost = create1999(0x7de51003);
    expect(outpost.placement).toBeUndefined();
    expect(outpost.initialMotion).toBeUndefined();
    c.som.createObject(outpost);
    expect(c.lastKey()).toBe(0);
  });

  it('a creature (no Movement on the 1999 wire) builds at 0', () => {
    const c = client();
    c.som.createObject(create1999(0x60000011)); // Black Rabbit
    expect(c.lastKey()).toBe(0);
  });

  describe.skipIf(!existsSync(resolve(DAT_SETS_DIR, 'ac1999-retail', 'portal.dat')))('1999 portal.dat', () => {
    let portal: ReturnType<typeof openDat>;
    beforeAll(() => { portal = openDat(resolve(DAT_SETS_DIR, 'ac1999-retail', 'portal.dat')); });
    it('every Setup the capture omits ANIMFRAME for has no Resting frame: 0 and Resting draw the same', () => {
      // Shoushi Outpost, the door, the lifestone, the tutorial portal, the rabbit.
      for (const id of [0x02000612, 0x0200027c, 0x020002ee, 0x020001b3, 0x0200047b]) {
        const s = new SetupModel(new DatReader(portal.getFileData(id)!));
        expect(s.placementFrames.has(PLACEMENT_RESTING), `0x${id.toString(16)}`).toBe(false);
        expect(getPartPlacements(s, 0)).toEqual(getPartPlacements(s, PLACEMENT_RESTING));
      }
    });
  });
});

describe('transitions keep the pose the server set', () => {
  it('an ObjDesc rebuild and a streamed rebuild keep Default for a desc with neither field', () => {
    const c = client();
    const data = eolCreate({ guid: 0x80000301, setupId: 0x02000065, state: MISSILE_STATE, velocity: [0, 20, 0] });
    const o = c.som.createObject(data)!;
    c.som.updateAppearance({ guid: o.guid, basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], instanceSequence: 1, visualDescSequence: 1 });
    expect(c.built.map((b) => b.key)).toEqual([0, 0]);
  });

  it('a Movement object ObjectMaint lets go comes back at Resting (its record drops the motion, not the pose)', () => {
    const c = client();
    const o = c.som.createObject(eolCreate({ guid: 0x80000302, setupId: 0x02000001, movement: true }))!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c.som as any).keepReleasedRecord(o);
    const rec = [...c.som.releasedRecords()].find((r) => r.guid === o.guid)!;
    expect(rec.initialMotion).toBeUndefined();
    expect(rec.placement).toBe(PLACEMENT_RESTING);
    c.som.deleteObject(o.guid, 'maint');
    c.som.createObject(rec);
    expect(c.lastKey()).toBe(PLACEMENT_RESTING);
  });

  it('a same-instance CreateObject placing a held object on the ground poses it at the sent frame (ACE drop: Resting)', () => {
    const c = client();
    const guid = 0x80000303;
    // Held: Parent block, AnimationFrame RightHandCombat.
    const o = c.som.createObject(eolCreate({ guid, setupId: 0x0200130a, parent: [0x50000001, 1], placement: RIGHT_HAND_COMBAT }))!;
    expect(o.placement).toBe(RIGHT_HAND_COMBAT);
    // Dropped (Player_Inventory.cs TryDropItem: Placement = Resting), same instance, newer position.
    c.som.createObject(eolCreate({ guid, setupId: 0x0200130a, placement: PLACEMENT_RESTING, positionTs: 2 }));
    expect(c.posed).toEqual([PLACEMENT_RESTING]);
    expect(o.placement).toBe(PLACEMENT_RESTING);
  });

  it('a same-instance CreateObject with a Parent block takes its raw animframe_id (DoParentEvent)', () => {
    const c = client();
    const guid = 0x80000304;
    const o = c.som.createObject(eolCreate({ guid, setupId: 0x0200130a, placement: PLACEMENT_RESTING }))!;
    c.som.createObject(eolCreate({ guid, setupId: 0x0200130a, parent: [0x50000002, 1], positionTs: 2 }));
    expect(o.wielderId).toBe(0x50000002);
    expect(o.placement).toBe(0);
  });

  it('a later UpdatePosition placement still re-poses an object without animations', () => {
    const c = client();
    const o = c.som.createObject(eolCreate({ guid: 0x80000305, setupId: 0x02000065 }))!;
    expect(o.placement).toBe(0);
    c.som.updatePosition({ guid: o.guid, landblock: CELL, x: 84, y: 7.1, z: 94, rw: 1, rx: 0, ry: 0, rz: 0, flags: 0x04, positionSequence: 2, teleportSequence: 0, instanceSequence: 1, placementId: PLACEMENT_RESTING } as never);
    expect(c.posed).toEqual([PLACEMENT_RESTING]);
  });

  it('a pickup leaves the pose alone (the object leaves the world)', () => {
    const c = client();
    const o = c.som.createObject(eolCreate({ guid: 0x80000306, setupId: 0x02000065, placement: PLACEMENT_RESTING }))!;
    expect(c.som.pickupEvent(o.guid, 2)).toBe(true);
    expect(o.placement).toBe(PLACEMENT_RESTING);
    expect(c.posed).toEqual([]);
  });

  it('AC1999 drop by position alone: the 0xF748 placement, 0 when absent, never the wielded frame', () => {
    const records = new NonWorldObjectRecords();
    const wielded = eolCreate({ guid: 0x80000307, setupId: 0x0200130a, parent: [0x50000003, 1], placement: RIGHT_HAND_COMBAT });
    const at = { guid: wielded.guid, landblock: CELL, x: 1, y: 2, z: 3, rw: 1, rx: 0, ry: 0, rz: 0, instanceSequence: 1, positionSequence: 2, teleportSequence: 0 };
    records.remember(wielded);
    expect(records.placeAt({ ...at, placementId: 0 })!.placement).toBe(0);
    records.remember(wielded);
    expect(records.placeAt({ ...at, placementId: PLACEMENT_RESTING })!.placement).toBe(PLACEMENT_RESTING);
    const c = client();
    records.remember(wielded);
    const placed = records.placeAt({ ...at, placementId: 0 })!;
    expect(placed.timestamps?.[PhysicsTimestamp.Position]).toBe(2);
    c.som.createObject(placed);
    expect(c.lastKey()).toBe(0);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('end-of-retail Setups that change pose (portal.dat)', () => {
  let portal: ReturnType<typeof openDat>;
  beforeAll(() => { portal = openDat(DAT_PATHS.portal); });
  it('Throwing Axe 0x0200130A and Whirling Blade 0x02000065 fly at Default, which differs from Resting', () => {
    for (const id of [0x0200130a, 0x02000065]) {
      const s = new SetupModel(new DatReader(portal.getFileData(id)!));
      const key = serverObjectPlacement({}); // ACE missile desc: neither field
      expect(key).toBe(0);
      expect(getPartPlacements(s, key)).not.toEqual(getPartPlacements(s, PLACEMENT_RESTING));
      expect(s.placementFrames.has(MISSILE_FLIGHT)).toBe(false);
    }
  });
});
