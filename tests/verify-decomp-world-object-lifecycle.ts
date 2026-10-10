/**
 * 2026-09-30 decomp-diff sweep, world-object lifecycle group
 * (docs/decomp-diff-sweep-2026-09-30.md W2 / W6 / W8 / W9). Drives the real
 * ServerObjectManager and CreateObject parser.
 *
 *  - DECOMP.pickup-event-ignored — SmartBox::DoPickupEvent @ 00452240:
 *    position-timestamp gate, then unset_parent + leave_world. The record
 *    stays; a position puts the object back.
 *  - DECOMP.invented-terrain-snap — server Z is used as sent (the 5 m
 *    snap-to-terrain pulled bridge / dock / stair objects into the ground).
 *  - DECOMP.objdesc-drops-held-item — an ObjDesc rebuild keeps the held
 *    object meshes on their holding parts (CHILDLIST, UpdateChild @ 00512d50).
 *  - DECOMP.recreate-teardown — SmartBox::HandleCreateObject @ 00454c80:
 *    same instance → update in place; older → dropped; newer / UpdateObject
 *    → rebuilt.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parseCreateObject, PhysicsTimestamp, type CreateObjectData } from '@ac/network';
import {
  ServerObjectManager, takeHeldAttachments, restoreHeldAttachments,
} from '../packages/renderer/src/world/ServerObjectManager.js';

// ─── helpers ───────────────────────────────────────────────────────────────

function makeSOM(opts: { terrainY?: number } = {}): { som: ServerObjectManager; builds: THREE.Group[]; deleted: number[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
  const builds: THREE.Group[] = [];
  // A two-part setup group, like SetupModelRenderer builds (parts are direct children).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (som as any).buildMesh = () => {
    const g = new THREE.Group();
    for (let i = 0; i < 2; i++) { const p = new THREE.Group(); p.name = `part_${i}`; g.add(p); }
    builds.push(g);
    return g;
  };
  if (opts.terrainY !== undefined) {
    const y = opts.terrainY;
    som.setTerrainCollision({ getHeightAt: () => y } as never);
  }
  const deleted: number[] = [];
  som.onObjectDeleted = (o) => { deleted.push(o.guid); };
  return { som, builds, deleted };
}

/** timestamps in PhysicsTimestamp order: position, movement, state, vector, teleport, scm, force, objdesc, instance */
function ts(over: Partial<Record<keyof typeof PhysicsTimestamp, number>> = {}): number[] {
  const t = new Array(9).fill(1);
  for (const [k, v] of Object.entries(over)) t[PhysicsTimestamp[k as keyof typeof PhysicsTimestamp]] = v;
  return t;
}

const LB = 0xA9B40017; // an outdoor Holtburg land cell
function createData(guid: number, over: Partial<CreateObjectData> = {}): CreateObjectData {
  return {
    guid, name: 'Pack', weenieClassId: 166, itemType: 0x200 /* Container */,
    position: { landblock: LB, x: 100, y: 120, z: 12, rw: 1, rx: 0, ry: 0, rz: 0 },
    setupId: 0x02000181, motionTableId: 0, iconId: 0,
    physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
    containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
    validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
    uiEffects: 0, usable: 0, useRadius: 0.6,
    velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0,
    objScale: 1.0, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1.0,
    iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
    timestamps: ts({ Instance: 5 }),
    ...over,
  };
}

// ─── DECOMP.recreate-teardown ─────────────────────────────────────────────

describe('DECOMP.recreate-teardown — CreateObject for a held guid', () => {
  it('parseCreateObject keeps the 9 PhysicsDesc timestamps in retail order', () => {
    const bytes: number[] = [];
    const u8 = (v: number) => bytes.push(v & 0xff);
    const u16 = (v: number) => { u8(v); u8(v >> 8); };
    const u32 = (v: number) => { u16(v & 0xffff); u16(v >>> 16); };
    const align = () => { while (bytes.length % 4) u8(0); };
    u32(0x80031111); u8(0x11); u8(0); u8(0); u8(0); align();
    u32(0); u32(0); // physFlags, physicsState
    for (let i = 0; i < 9; i++) u16(100 + i);
    align();
    u32(0); u16(0); u16(0); // weenie flags, empty name (+pad)
    u16(300); u16(1); u32(0); u32(0); align();
    const d = parseCreateObject(new Uint8Array(bytes));
    expect(d!.timestamps).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108]);
    expect(d!.timestamps![PhysicsTimestamp.Instance]).toBe(108);
    expect(d!.timestamps![PhysicsTimestamp.ObjDesc]).toBe(107);
  });

  it('the same instance updates the object in place: same record, same mesh, no teardown', () => {
    const { som, builds, deleted } = makeSOM();
    const first = som.createObject(createData(0x7001))!;
    const mesh = first.mesh;
    const again = som.createObject(createData(0x7001, {
      name: 'Renamed Pack', stackSize: 3,
      position: { landblock: LB, x: 104, y: 120, z: 12, rw: 1, rx: 0, ry: 0, rz: 0 },
      timestamps: ts({ Instance: 5, Position: 2 }), // a newer POSITION_TS (an equal one is stale)
    }))!;
    expect(again).toBe(first);
    expect(again.mesh).toBe(mesh);
    expect(builds).toHaveLength(1);
    expect(deleted).toEqual([]);
    expect(again.name).toBe('Renamed Pack');
    expect(again.stackSize).toBe(3);
    // HandleReceivedPosition → MoveOrTeleport: a grounded position is interpolated to.
    const q = again.physics!.interp.queue;
    expect(q[q.length - 1].p.pos.x).toBeCloseTo(0xA9 * 192 + 104, 5);
  });

  it('an in-place update only rebuilds the appearance when its OBJDESC_TS is newer', () => {
    const { som, builds } = makeSOM();
    som.createObject(createData(0x7002, { timestamps: ts({ Instance: 5, ObjDesc: 3 }) }));
    som.createObject(createData(0x7002, { timestamps: ts({ Instance: 5, ObjDesc: 3 }), basePalette: 0x04000002 }));
    expect(builds).toHaveLength(1);
    som.createObject(createData(0x7002, { timestamps: ts({ Instance: 5, ObjDesc: 4 }), basePalette: 0x04000002 }));
    expect(builds).toHaveLength(2);
    expect(som.getObject(0x7002)!.basePalette).toBe(0x04000002);
  });

  it('an OLDER instance is dropped (NETBLOB_OLD_INSTANCE)', () => {
    const { som, builds } = makeSOM();
    const held = som.createObject(createData(0x7003))!;
    const r = som.createObject(createData(0x7003, { name: 'stale', timestamps: ts({ Instance: 4 }) }));
    expect(r).toBe(held);
    expect(held.name).toBe('Pack');
    expect(builds).toHaveLength(1);
  });

  it('a NEWER instance, or an UpdateObject, destroys and rebuilds', () => {
    const { som, builds, deleted } = makeSOM();
    const held = som.createObject(createData(0x7004))!;
    const newer = som.createObject(createData(0x7004, { timestamps: ts({ Instance: 6 }) }))!;
    expect(newer).not.toBe(held);
    expect(builds).toHaveLength(2);
    expect(deleted).toEqual([0x7004]);
    const updated = som.createObject(createData(0x7004, { timestamps: ts({ Instance: 6 }) }), true)!;
    expect(updated).not.toBe(newer);
    expect(builds).toHaveLength(3);
  });

  it('seeds the SetState / ObjDesc gates from the create: an equal STATE_TS SetState is a retransmit', () => {
    const { som } = makeSOM();
    const o = som.createObject(createData(0x7005, { timestamps: ts({ Instance: 5, State: 9 }) }))!;
    som.setPhysicsState(0x7005, 0x4000 /* Hidden */, 9);
    expect(o.physicsState).toBe(0);
    som.setPhysicsState(0x7005, 0x4000, 10);
    expect(o.physicsState).toBe(0x4000);
  });
});

// ─── DECOMP.pickup-event-ignored ──────────────────────────────────────────

describe('DECOMP.pickup-event-ignored — DoPickupEvent: unset_parent + leave_world', () => {
  it('takes the object out of the world (not drawn, no cell) and keeps its record', () => {
    const { som, deleted } = makeSOM();
    const o = som.createObject(createData(0x7101, { timestamps: ts({ Instance: 5, Position: 2 }) }))!;
    expect(o.mesh!.visible).toBe(true);
    expect(som.pickupEvent(0x7101, 3, 5)).toBe(true);
    expect(o.mesh!.visible).toBe(false);
    expect(o.outOfWorld).toBe(true);
    expect(o.objCellId).toBe(0);
    expect(som.getObject(0x7101)).toBe(o);
    expect(deleted).toEqual([]);
  });

  it('is gated on the position timestamp and the object instance', () => {
    const { som } = makeSOM();
    const o = som.createObject(createData(0x7102, { timestamps: ts({ Instance: 5, Position: 7 }) }))!;
    expect(som.pickupEvent(0x7102, 7, 5)).toBe(false); // not newer
    expect(som.pickupEvent(0x7102, 8, 4)).toBe(false); // another instance
    expect(o.mesh!.visible).toBe(true);
    expect(som.pickupEvent(0x7102, 8, 5)).toBe(true);
    expect(o.positionSequence).toBe(8);
  });

  it('unparents a held object (the owner drops the held mesh copy)', () => {
    const { som } = makeSOM();
    const o = som.createObject(createData(0x7103, { position: null, wielderId: 0x5000, parentLocation: 1 }))!;
    expect(som.pickupEvent(0x7103, 2)).toBe(true);
    expect(o.wielderId).toBe(0);
    expect(o.parentLocation).toBe(0);
  });

  it('an out-of-world object neither moves nor blocks', () => {
    const { som } = makeSOM();
    const o = som.createObject(createData(0x7104))!;
    o.blockRadius = 1;
    o.physicsState = 0; // not ethereal
    expect(som.getBlockersNear(o.worldX, o.worldZ, 5)).toHaveLength(1);
    som.pickupEvent(0x7104, 2);
    o.physics!.setVelocity({ x: 50, y: 0, z: 0 });
    const x = o.worldX;
    som.updateAnimations(0.1);
    expect(o.worldX).toBe(x);
    expect(som.getBlockersNear(o.worldX, o.worldZ, 5)).toEqual([]);
  });

  it('a later position puts it back in the world at that spot (a dropped item)', () => {
    const { som } = makeSOM();
    const o = som.createObject(createData(0x7105))!;
    som.pickupEvent(0x7105, 2);
    som.updatePosition({
      guid: 0x7105, flags: 0, landblock: LB, x: 10, y: 20, z: 12, rw: 1, rx: 0, ry: 0, rz: 0,
      instanceSequence: 5, positionSequence: 3, teleportSequence: 1, forcePositionSequence: 0,
    });
    expect(o.outOfWorld).toBe(false);
    expect(o.mesh!.visible).toBe(true);
    expect(o.worldX).toBeCloseTo(0xA9 * 192 + 10, 5);
    expect(o.mesh!.position.x).toBeCloseTo(0xA9 * 192 + 10, 5);
  });

  it('a same-instance CreateObject with a position restores it; one without a position picks it up', () => {
    const { som } = makeSOM();
    const o = som.createObject(createData(0x7106))!;
    som.createObject(createData(0x7106, { position: null, timestamps: ts({ Instance: 5, Position: 2 }) }));
    expect(o.outOfWorld).toBe(true);
    som.createObject(createData(0x7106, { timestamps: ts({ Instance: 5, Position: 3 }) }));
    expect(o.outOfWorld).toBe(false);
    expect(o.mesh!.visible).toBe(true);
  });

  it('a CreateObject for a held item (parent, no position) enters no cell: no world mesh drawn', () => {
    const { som } = makeSOM();
    const held = som.createObject(createData(0x7108, { position: null, wielderId: 0x5000, parentLocation: 1 }))!;
    expect(held.outOfWorld).toBe(true);
    expect(held.mesh!.visible).toBe(false);
  });

  // BUG.wielded-item-left-behind-on-teleport — ACE's create for an item
  // wielded in view (Player_Tracking TrackEquippedObject) carries the
  // Parent block AND a position. HandleCreateObject @ 00454c80 tests only
  // PhysicsDesc::get_parent_id: no enter_world. Pre-fix the stone also drew
  // as a world mesh at the wielder's feet and stayed when they portaled.
  it('parseCreateObject surfaces the PhysicsDesc Parent block\'s holder guid', () => {
    const bytes: number[] = [];
    const u8 = (v: number) => bytes.push(v & 0xff);
    const u16 = (v: number) => { u8(v); u8(v >> 8); };
    const u32 = (v: number) => { u16(v & 0xffff); u16(v >>> 16); };
    const f32 = (v: number) => { const b = new Uint8Array(new Float32Array([v]).buffer); b.forEach(u8); };
    const align = () => { while (bytes.length % 4) u8(0); };
    u32(0x8000e3f4); u8(0x11); u8(0); u8(0); u8(0); align();
    u32(0x8000 | 0x20); u32(0); // physFlags Position | Parent, physicsState
    u32(LB); f32(1); f32(2); f32(3); f32(1); f32(0); f32(0); f32(0); // position
    u32(0x5000000b); u32(1); // Parent: holder, ParentLocation RightHand
    for (let i = 0; i < 9; i++) u16(0);
    align();
    u32(0); u16(0); u16(0);
    u16(8904); u16(1); u32(0); u32(0); align();
    const d = parseCreateObject(new Uint8Array(bytes))!;
    expect(d.physicsParentId).toBe(0x5000000b);
    expect(d.parentLocation).toBe(1);
    expect(d.position).not.toBeNull();
  });

  it('a CreateObject with a parent AND a position enters no cell (an item wielded in view)', () => {
    const { som } = makeSOM();
    const stone = som.createObject(createData(0x710a, { wielderId: 0x5000000b, physicsParentId: 0x5000000b, parentLocation: 1 }))!;
    expect(stone.position).not.toBeNull();
    expect(stone.outOfWorld).toBe(true);
    expect(stone.mesh!.visible).toBe(false);
    // the item stays out of the world when the wielder goes (no orphan at its feet)
    som.deleteObject(0x5000000b);
    expect(som.getObject(0x710a)!.mesh!.visible).toBe(false);
  });

  it('a parentless CreateObject with no position (cell 0) enters no cell', () => {
    const { som } = makeSOM();
    expect(som.createObject(createData(0x710b, { position: null }))!.outOfWorld).toBe(true);
    const cell0 = som.createObject(createData(0x710c, { position: { landblock: 0, x: 0, y: 0, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 } }))!;
    expect(cell0.outOfWorld).toBe(true);
    expect(cell0.mesh!.visible).toBe(false);
  });

  it('a same-instance CreateObject parents by the PhysicsDesc parent, not the weenie Wielder', () => {
    const { som } = makeSOM();
    const o = som.createObject(createData(0x710d, { timestamps: ts({ Instance: 5, Position: 2 }) }))!;
    // weenie Wielder set, no Parent block, no position (worn armour): DoPickupEvent
    som.createObject(createData(0x710d, { position: null, wielderId: 0x5002, timestamps: ts({ Instance: 5, Position: 3 }) }));
    expect(o.outOfWorld).toBe(true);
    expect(o.wielderId).toBe(0);
    // a Parent block: DoParentEvent onto that holder
    som.createObject(createData(0x710d, { position: null, wielderId: 0x5002, physicsParentId: 0x5002, parentLocation: 1, timestamps: ts({ Instance: 5, Position: 4 }) }));
    expect(o.wielderId).toBe(0x5002);
    expect(o.parentLocation).toBe(1);
  });

  it('deleting a holder unparents what it held (CObjectMaint::DeleteObject → unparent_children)', () => {
    const { som } = makeSOM();
    som.createObject(createData(0x5003, {}));
    const held = som.createObject(createData(0x710e, { position: null, wielderId: 0x5003, physicsParentId: 0x5003, parentLocation: 1 }))!;
    som.deleteObject(0x5003);
    expect(som.getObject(0x710e)).toBe(held);
    expect(held.wielderId).toBe(0);
    expect(held.parentLocation).toBe(0);
    expect(held.outOfWorld).toBe(true);
  });

  it('a ParentEvent onto a new holder records it (gated like the pickup)', () => {
    const { som } = makeSOM();
    const o = som.createObject(createData(0x7107, { timestamps: ts({ Instance: 5, Position: 2 }) }))!;
    som.pickupEvent(0x7107, 3);
    expect(som.parentEvent(0x7107, 0x5001, 1, 3)).toBe(false); // stale
    expect(som.parentEvent(0x7107, 0x5001, 1, 4)).toBe(true);
    expect(o.wielderId).toBe(0x5001);
    expect(o.parentLocation).toBe(1);
    expect(o.mesh!.visible).toBe(false); // drawn as the holder's attachment, not in a cell
    expect(som.parentEvent(0xDEAD, 0x5001, 1, 1)).toBe(true); // untracked (own item): attach proceeds
  });
});

// ─── DECOMP.invented-terrain-snap ─────────────────────────────────────────

describe('DECOMP.invented-terrain-snap — server Z is used as sent', () => {
  it('CreateObject: an object 2 m above the terrain (a bridge / dock) stays at its Z', () => {
    const { som } = makeSOM({ terrainY: 10 });
    const o = som.createObject(createData(0x7201))!; // z = 12
    expect(o.worldY).toBe(12);
    expect(o.mesh!.position.y).toBe(12);
  });

  it('UpdatePosition: the target is the server Z', () => {
    const { som } = makeSOM({ terrainY: 10 });
    const o = som.createObject(createData(0x7202))!;
    som.updatePosition({
      guid: 0x7202, flags: 0x4, landblock: LB, x: 100, y: 121, z: 13, rw: 1, rx: 0, ry: 0, rz: 0,
      instanceSequence: 5, positionSequence: 2, teleportSequence: 1, forcePositionSequence: 0,
    });
    const q = o.physics!.interp.queue;
    expect(q[q.length - 1].p.pos.z).toBe(13);
  });

  it('PublicUpdatePosition: the server Z, and the object\'s cell follows', () => {
    const { som } = makeSOM({ terrainY: 10 });
    const o = som.createObject(createData(0x7203))!;
    som.applyPublicLocationUpdate(0x7203, 0xA9B40018, 5, 5, 11, 1, 0, 0, 0);
    expect(o.worldY).toBe(11);
    expect(o.objCellId).toBe(0xA9B40018);
  });
});

// ─── DECOMP.objdesc-drops-held-item ───────────────────────────────────────

describe('DECOMP.objdesc-drops-held-item — an ObjDesc rebuild keeps held objects', () => {
  it('the wielded mesh moves onto the rebuilt holding part', () => {
    const { som, builds } = makeSOM();
    const npc = som.createObject(createData(0x7301, { itemType: 0x10 /* Creature */ }))!;
    const sword = new THREE.Group();
    sword.name = 'wielded_1';
    sword.userData.wieldedGuid = 0x7302;
    sword.position.set(0.1, 0.2, 0.3);
    npc.mesh!.getObjectByName('part_1')!.add(sword);

    som.updateAppearance({
      guid: 0x7301, basePalette: 0, subPalettes: [], textureChanges: [],
      animPartChanges: [{ partIndex: 0, partId: 0x01000001 }], instanceSequence: 5, visualDescSequence: 2,
    });

    expect(builds).toHaveLength(2);
    expect(npc.mesh).toBe(builds[1]);
    const part = npc.mesh!.children.find(c => c.name === 'part_1')!;
    expect(part.children).toContain(sword);
    expect(sword.position.toArray()).toEqual([0.1, 0.2, 0.3]); // holding-location frame kept
  });

  it('take/restore only touch held objects and match parts by direct child name', () => {
    const root = new THREE.Group();
    const p0 = new THREE.Group(); p0.name = 'part_0'; root.add(p0);
    const lod = new THREE.Mesh(); p0.add(lod);
    const shield = new THREE.Group(); shield.name = 'wielded_3'; p0.add(shield);
    // The held shield's own setup has a part_1 too — it must not be picked.
    const inner = new THREE.Group(); inner.name = 'part_1'; shield.add(inner);
    const held = takeHeldAttachments(root);
    expect(held.map(h => h.partName)).toEqual(['part_0']);
    expect(p0.children).toEqual([lod]);

    const rebuilt = new THREE.Group();
    const n0 = new THREE.Group(); n0.name = 'part_0'; rebuilt.add(n0);
    expect(restoreHeldAttachments(rebuilt, held)).toEqual([]);
    expect(n0.children).toEqual([shield]);
    expect(restoreHeldAttachments(new THREE.Group(), takeHeldAttachments(rebuilt))).toHaveLength(1);
  });
});
