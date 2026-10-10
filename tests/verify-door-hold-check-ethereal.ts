/**
 * BUG.door-collision-static-pose-no-hold (B) — a door closing on a body
 * stays Ethereal until the body is out of it.
 *
 * Retail CPhysicsObj::set_ethereal(0) @ 00511c40 runs
 * ethereal_check_for_collisions @ 00510a40: if anything overlaps the object
 * as it stands it stays Ethereal and sets transient 0x100 CHECK_ETHEREAL,
 * and UpdateObjectInternal @ 005156b0 calls set_ethereal(0) again every
 * frame until it is clear (ACE mirrors it: allow_door_hold, Door.cs:182-207,
 * PhysicsObj.cs:3605). Our EtherealHook cleared Ethereal at once, so a
 * player standing in a closing door was embedded in its slab. SetState
 * (set_state @ 00514dd0) still replaces the state unconditionally.
 *
 * Driven through the real ServerObjectManager: the door's own animation
 * fires the frame-1 Ethereal(0) hook as it closes (MovementEvent Off,
 * updateAnimations), and the walks go through getBlockersNear →
 * addCreatureObstacles → DungeonCollision as the movement step does.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { PhysicsState } from '@ac/shared';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { GfxObj } from '../packages/dat-parser/src/file-types/GfxObj.js';
import { PHYSICS_STATE_KEY } from '../packages/renderer/src/models/ObjectTranslucency.js';
import { resolveObjectPhysics, type ObjectPhysicsModel } from '../packages/renderer/src/world/ObjectCollision.js';
import { DAT_PATHS } from './_harness/dat.js';
import {
  DOOR_STATE, OFF, ON, SYN_SETUP, SYN_TABLE, makeDoor, objectData, motionEvent, synPhysics, synPortal, tick, walk, type DoorRig,
} from './_harness/doorFixture.js';

const OPEN_STATE = DOOR_STATE | PhysicsState.Ethereal; // 0x1000C

/** Put our character's feet at door + (dx, dy) (AC, door-relative). */
function standAt(r: DoorRig, dx: number, dy: number): void {
  r.som.localPlayerPosition = () => ({ x: r.ox + dx, z: r.oy + dy, y: r.floor, radius: 0.68 });
}
const door = (r: DoorRig) => r.som.getObject(r.guid)!;
const isEthereal = (r: DoorRig) => (door(r).physicsState & PhysicsState.Ethereal) !== 0;

describe('synthetic door: set_ethereal(0) holds a door that closes on our character (CI)', () => {
  // Closed, the slab spans y ∈ [0, 2] at x ≈ 0; a body at (0, 1) stands in it.
  function openDoorWithPlayerInside(): DoorRig {
    const r = makeDoor({ portal: synPortal(), setupId: SYN_SETUP, motionTableId: SYN_TABLE, physics: synPhysics, numParts: 1, initial: ON, state: OPEN_STATE });
    r.som.objectPhysics = synPhysics;
    standAt(r, 0, 1);
    return r;
  }

  it('Off through frame 1: the door stays Ethereal (CHECK_ETHEREAL) and the player walks out', () => {
    const r = openDoorWithPlayerInside();
    r.som.handleMovementEvent(motionEvent(r.guid, OFF) as never);
    tick(r.som, 2);
    expect(r.som.getAnimated(r.guid)!.motionManager.animationPlayer.currentFrameIndex).toBe(0);
    expect(isEthereal(r)).toBe(true);
    expect(door(r).checkEthereal).toBe(true);
    // The physics object and the mesh carry the held state too.
    expect(door(r).physics!.state & PhysicsState.Ethereal).toBeTruthy();
    expect(door(r).mesh!.userData[PHYSICS_STATE_KEY] & PhysicsState.Ethereal).toBeTruthy();
    // Out through the closed slab's plane: nothing in the way.
    expect(walk(r, { x: 0, y: 1 }, { x: 1, y: 0 }, 3).x).toBeGreaterThan(2.9);
  });

  it('once the player is clear the retry clears Ethereal and the door blocks', () => {
    const r = openDoorWithPlayerInside();
    r.som.handleMovementEvent(motionEvent(r.guid, OFF) as never);
    tick(r.som, 2);
    tick(r.som, 1); // still inside: still held
    expect(isEthereal(r)).toBe(true);
    standAt(r, 3, 1);
    tick(r.som, 1 / 60);
    expect(isEthereal(r)).toBe(false);
    expect(door(r).checkEthereal).toBe(false);
    expect(door(r).physics!.state & PhysicsState.Ethereal).toBe(0);
    expect(door(r).mesh!.userData[PHYSICS_STATE_KEY]).toBe(DOOR_STATE);
    const end = walk(r, { x: -3, y: 1 }, { x: 1, y: 0 }, 6);
    expect(end.x).toBeLessThan(-0.5);
  });

  it('nobody inside: Ethereal clears on the frame-1 hook', () => {
    const r = openDoorWithPlayerInside();
    standAt(r, 5, 5);
    r.som.handleMovementEvent(motionEvent(r.guid, OFF) as never);
    tick(r.som, 2);
    expect(isEthereal(r)).toBe(false);
    expect(door(r).checkEthereal).toBe(false);
  });

  it('a creature standing in the doorway holds it too', () => {
    const r = openDoorWithPlayerInside();
    standAt(r, 5, 5);
    const CREATURE_SETUP = 0x02000f02;
    r.som.objectPhysics = (id) => (id === CREATURE_SETUP
      ? { parts: [], hasPhysicsBSP: false, cylSpheres: [], spheres: [{ origin: { x: 0, y: 0, z: 0.5 }, radius: 0.5 }], sortingSphere: { origin: { x: 0, y: 0, z: 0.5 }, radius: 0.5 } }
      : synPhysics(id));
    const d = door(r);
    // Its sphere (r 0.5 at 0.5 m) at the doorway's middle, where the slab closes.
    const drudge = r.som.createObject(objectData({
      guid: 0x80001234, name: 'Drudge', weenieClassId: 1, itemType: 0x10, setupId: CREATURE_SETUP,
      position: { ...d.position!, y: d.position!.y + 1 },
    }));
    expect(drudge).toBeTruthy();
    r.som.handleMovementEvent(motionEvent(r.guid, OFF) as never);
    tick(r.som, 2);
    expect(isEthereal(r)).toBe(true);
    r.som.deleteObject(0x80001234);
    tick(r.som, 1 / 60);
    expect(isEthereal(r)).toBe(false);
  });

  it('a SetState 0x10008 still clears Ethereal while the player overlaps (set_state is unconditional)', () => {
    const r = openDoorWithPlayerInside();
    r.som.handleMovementEvent(motionEvent(r.guid, OFF) as never);
    tick(r.som, 2);
    expect(isEthereal(r)).toBe(true);
    r.som.setPhysicsState(r.guid, DOOR_STATE);
    expect(door(r).physicsState).toBe(DOOR_STATE);
    expect(door(r).mesh!.userData[PHYSICS_STATE_KEY]).toBe(DOOR_STATE);
  });

  it('the Ethereal(1) hook on reopening clears a pending CHECK_ETHEREAL', () => {
    const r = openDoorWithPlayerInside();
    r.som.handleMovementEvent(motionEvent(r.guid, OFF) as never);
    tick(r.som, 2);
    expect(door(r).checkEthereal).toBe(true);
    r.som.handleMovementEvent(motionEvent(r.guid, ON) as never);
    tick(r.som, 2);
    expect(door(r).checkEthereal).toBe(false);
    expect(isEthereal(r)).toBe(true);
  });

  it('without objectPhysics wired the hook clears Ethereal at once (no overlap test)', () => {
    const r = openDoorWithPlayerInside();
    r.som.objectPhysics = null;
    r.som.handleMovementEvent(motionEvent(r.guid, OFF) as never);
    tick(r.som, 2);
    expect(isEthereal(r)).toBe(false);
  });
});

// ── the real doors, both eras: the frame-1 hook holds and releases ────

const SETS = [
  { era: 'AC1999', path: resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat'), overlay: true, setup: 0x0200024f, table: 0x09000016 },
  { era: 'end of retail', path: DAT_PATHS.portal, overlay: false, setup: 0x020019ff, table: 0x09000202 },
];
for (const set of SETS) {
  describe.skipIf(!existsSync(set.path))(`${set.era}: door Setup ${set.setup.toString(16)} / MotionTable ${set.table.toString(16)}`, () => {
    let db: DatDatabase;
    let physics: (id: number) => ObjectPhysicsModel | null;
    let numParts = 0;
    beforeAll(() => {
      db = new DatDatabase(new FileDatBytes(set.path));
      if (set.overlay) db.setOverlay(ac1999PortalOverlay());
      const src = {
        loadSetupModel: (id: number) => { const d = db.getFileData(id); return d ? new SetupModel(new DatReader(d)) : null; },
        loadGfxObj: (id: number) => { const d = db.getFileData(id); return d ? new GfxObj(new DatReader(d)) : null; },
      };
      const cache = new Map<number, ObjectPhysicsModel | null>();
      physics = (id) => { if (!cache.has(id)) cache.set(id, resolveObjectPhysics(id, src)); return cache.get(id)!; };
      numParts = physics(set.setup)!.parts.length;
    });

    /** Where the closed leaf is: the BSP part's placement origin (door-local, AC). */
    function leafSpot(): { x: number; y: number } {
      const part = physics(set.setup)!.parts.find((p) => p.gfx?.physicsBSP)!;
      return { x: part.frame.origin.x, y: part.frame.origin.y };
    }

    it('closing on a body in the leaf: held Ethereal through frame 1, released once the body is clear', () => {
      const r = makeDoor({ portal: db, setupId: set.setup, motionTableId: set.table, physics, numParts, initial: ON, state: OPEN_STATE });
      r.som.objectPhysics = physics;
      const spot = leafSpot();
      standAt(r, spot.x, spot.y);
      r.som.handleMovementEvent(motionEvent(r.guid, OFF) as never);
      tick(r.som, 3);
      expect(r.som.getAnimated(r.guid)!.motionManager.animationPlayer.currentFrameIndex).toBe(0);
      expect(isEthereal(r)).toBe(true);
      expect(door(r).checkEthereal).toBe(true);
      standAt(r, spot.x + 6, spot.y + 6);
      tick(r.som, 1 / 60);
      expect(isEthereal(r)).toBe(false);
    });

    it('nobody near: the frame-1 Ethereal(0) hook clears Ethereal as before', () => {
      const r = makeDoor({ portal: db, setupId: set.setup, motionTableId: set.table, physics, numParts, initial: ON, state: OPEN_STATE });
      r.som.objectPhysics = physics;
      standAt(r, 8, 8);
      r.som.handleMovementEvent(motionEvent(r.guid, OFF) as never);
      tick(r.som, 3);
      expect(isEthereal(r)).toBe(false);
    });
  });
}
