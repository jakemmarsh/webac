/**
 * BUG.door-collision-static-pose-no-hold (A) — a door collides where its
 * leaf is drawn, not as the closed slab.
 *
 * Live (EoR local ACE, 2026-10-09): standing 0.5 m from Holtburg door
 * 0x7A9B401E with the leaf drawn open, the player could not walk out of the
 * doorway. addObjectCollision placed every part at the Setup's static
 * placement frame, so door Setup 0x020019FF always collided as the closed
 * slab across the doorway. Retail places the parts at the current animation
 * frame (CPartArray::SetFrame → UpdateParts @ 005190f0: object frame ×
 * CSequence::get_curr_animframe), and CPartArray::FindObjCollisions
 * @ 00518180 → CPhysicsPart::find_obj_collisions @ 0050d8d0 tests that
 * `part->pos`. getBlockersNear now carries each part's current frame.
 *
 * Driven through the real ServerObjectManager (createObject with the
 * initial On motion, MovementEvent Off, updateAnimations) → getBlockersNear
 * → addCreatureObstacles → DungeonCollision.getAdjustedMovement, the
 * movement step's own path. The door's state is 0x10008 (not Ethereal) so
 * only its pose decides.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { GfxObj } from '../packages/dat-parser/src/file-types/GfxObj.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { resolveObjectPhysics, type ObjectPhysicsModel } from '../packages/renderer/src/world/ObjectCollision.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import {
  DOOR_STATE, OFF, ON, SYN_SETUP, SYN_TABLE, makeDoor, motionEvent, synPhysics, synPortal, tick, walk,
} from './_harness/doorFixture.js';

describe('synthetic door: the collision follows the leaf (CI)', () => {
  // The slab is hinged at the origin; closed it spans y ∈ [0, 2] at x ≈ 0
  // (the doorway's normal is X), open it lies along −X at y ≈ 0.
  const rig = () => makeDoor({ portal: synPortal(), setupId: SYN_SETUP, motionTableId: SYN_TABLE, physics: synPhysics, numParts: 1, initial: ON, state: DOOR_STATE });
  const throughDoorway = (r: ReturnType<typeof rig>) => walk(r, { x: -3, y: 1 }, { x: 1, y: 0 }, 6);
  const intoOpenLeaf = (r: ReturnType<typeof rig>) => walk(r, { x: -1, y: -3 }, { x: 0, y: 1 }, 6);

  it('created open (On): the part frames are the animation\'s last frame', () => {
    const r = rig();
    const anim = r.som.getAnimated(r.guid)!;
    expect(anim.motionManager.activeMotionTable).toBeTruthy();
    const b = r.som.getBlockersNear(r.ox, r.oy, 10);
    expect(b).toHaveLength(1);
    const q = b[0].partFrames![0]!.orientation;
    expect(2 * Math.atan2(q.z, q.w)).toBeCloseTo(Math.PI / 2, 3);
  });

  it('open: a walk through the doorway passes; a walk into the open leaf stops at it', () => {
    const r = rig();
    tick(r.som, 0.1);
    expect(throughDoorway(r).x).toBeGreaterThan(2.9);
    const leaf = intoOpenLeaf(r);
    expect(leaf.y).toBeLessThan(-0.1 - 0.4); // its body sphere stops at the leaf's −Y face
    expect(leaf.y).toBeGreaterThan(-1.2);
  });

  it('Off + 2 s: the leaf is back across the doorway and the same walk stops at the slab', () => {
    const r = rig();
    r.som.handleMovementEvent(motionEvent(r.guid, OFF) as never);
    tick(r.som, 2);
    const q = r.som.getBlockersNear(r.ox, r.oy, 10)[0].partFrames![0]!.orientation;
    expect(Math.abs(q.z)).toBeLessThan(1e-6);
    const end = throughDoorway(r);
    expect(end.x).toBeLessThan(-0.1 - 0.4);
    expect(end.x).toBeGreaterThan(-1.2);
    // and the space the leaf swung through is clear again
    expect(intoOpenLeaf(r).y).toBeGreaterThan(2.9);
  });

  it('created closed (Off): the doorway is blocked and the swing space is clear', () => {
    const r = makeDoor({ portal: synPortal(), setupId: SYN_SETUP, motionTableId: SYN_TABLE, physics: synPhysics, numParts: 1, initial: OFF, state: DOOR_STATE });
    expect(throughDoorway(r).x).toBeLessThan(-0.5);
    expect(intoOpenLeaf(r).y).toBeGreaterThan(2.9);
  });
});

// ── the real door: weenie 412 door-aluvian-house ──────────────────────

const SETUP = 0x020019ff;
const TABLE = 0x09000202;

describe.skipIf(!existsSync(DAT_PATHS.portal))('end of retail: door Setup 0x020019FF (MotionTable 0x09000202, animation 0x03000C20)', () => {
  let db: DatDatabase;
  let physics: (id: number) => ObjectPhysicsModel | null;
  beforeAll(() => {
    db = openDat(DAT_PATHS.portal);
    const cache = new Map<number, ObjectPhysicsModel | null>();
    const src = {
      loadSetupModel: (id: number) => { const d = db.getFileData(id); return d ? new SetupModel(new DatReader(d)) : null; },
      loadGfxObj: (id: number) => { const d = db.getFileData(id); return d ? new GfxObj(new DatReader(d)) : null; },
    };
    physics = (id) => { if (!cache.has(id)) cache.set(id, resolveObjectPhysics(id, src)); return cache.get(id)!; };
  });
  const rig = (initial: number) => makeDoor({ portal: db, setupId: SETUP, motionTableId: TABLE, physics, numParts: 3, initial, state: DOOR_STATE });
  // The leaf (GfxObj 0x010044B5, the only part with a physics BSP) spans
  // x ∈ [−0.95, 0.97] across the doorway closed (its normal is Y); frame 29
  // swings it ~98° to lie along x ≈ −0.95, y ∈ [−1.9, 0].
  const throughDoorway = (r: ReturnType<typeof rig>) => walk(r, { x: 0, y: 3 }, { x: 0, y: -1 }, 6);
  const intoOpenLeaf = (r: ReturnType<typeof rig>) => walk(r, { x: 1.5, y: -1 }, { x: -1, y: 0 }, 4);

  it('only part 0 has a physics BSP', () => {
    const m = physics(SETUP)!;
    expect(m.parts.map((p) => !!p.gfx?.physicsBSP)).toEqual([true, false, false]);
  });

  it('open (On, frame 29): the doorway is clear and the open leaf blocks', () => {
    const r = rig(ON);
    tick(r.som, 0.1);
    expect(r.som.getAnimated(r.guid)!.motionManager.animationPlayer.currentFrameIndex).toBe(29);
    expect(throughDoorway(r).y).toBeLessThan(-2.9);
    const leaf = intoOpenLeaf(r);
    expect(leaf.x).toBeGreaterThan(-0.9 + 0.3);
    expect(leaf.x).toBeLessThan(0.5);
  });

  it('Off + 2 s: the walk out of the doorway stops ~0.79 m from the origin', () => {
    const r = rig(ON);
    r.som.handleMovementEvent(motionEvent(r.guid, OFF) as never);
    tick(r.som, 2);
    expect(r.som.getAnimated(r.guid)!.motionManager.animationPlayer.currentFrameIndex).toBe(0);
    const end = throughDoorway(r);
    expect(end.y).toBeGreaterThan(0.6);
    expect(end.y).toBeLessThan(1.0);
    expect(intoOpenLeaf(r).x).toBeLessThan(-2.4);
  });
});
