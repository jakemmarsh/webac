/**
 * BUG.ac1999-forced-position-snap — a door opens for collision through its
 * animation's Ethereal hook.
 *
 * EtherealHook::Execute @ 00526bc0 → CPhysicsObj::set_ethereal @ 00511c40:
 * 1 sets ETHEREAL_PS (0x4) in the object's state, 0 clears it. The AC1999
 * server opens a door with the On motion alone (CBaseDoor::OpenDoor, no
 * SetState); our client only flagged the mesh (userData), so collision kept
 * the door solid while the server walked the player through it and then
 * snapped them on, 19-28 m (2026-10-08, tutorial dungeon 0x016F). ACE also
 * sends SetState, which still replaces the whole state.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PhysicsState } from '@ac/shared';
import { AnimationHookType, type AnimationHook } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { Animation } from '../packages/dat-parser/src/file-types/Animation.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { blocksLocalPlayer } from '../packages/renderer/src/world/CreatureCollision.js';

const CLOSED_DOOR = PhysicsState.HasPhysicsBSP | PhysicsState.ReportCollisions | PhysicsState.IgnoreCollisions; // 0x10018

function doorManager() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (som as any).buildMesh = () => new THREE.Group();
  const door = som.createObject({
    guid: 0x7016f008, name: 'Door', setupId: 0x0200024f, physicsState: CLOSED_DOOR, objectDescFlags: 0,
    position: { landblock: 0x016f012f, x: 29.98, y: -65.15, z: -6, rw: 0, rx: 0, ry: 0, rz: -1 },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)!;
  return { som, door };
}
const ethereal = (on: number): AnimationHook => ({ hookType: AnimationHookType.Ethereal, direction: 0, ethereal: on } as AnimationHook);

describe('the Ethereal hook sets the object physics state (set_ethereal)', () => {
  it('open (1): the door stops blocking; close (0): it blocks again; the hook still reaches onAnimationHook', () => {
    const { som, door } = doorManager();
    const forwarded: number[] = [];
    som.onAnimationHook = (guid) => { forwarded.push(guid); };
    expect(blocksLocalPlayer(door, 0)).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).runObjectHook(door.guid, ethereal(1), new THREE.Group());
    expect(door.physicsState).toBe(CLOSED_DOOR | PhysicsState.Ethereal);
    expect(blocksLocalPlayer(door, 0)).toBe(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).runObjectHook(door.guid, ethereal(0), new THREE.Group());
    expect(door.physicsState).toBe(CLOSED_DOOR);
    expect(blocksLocalPlayer(door, 0)).toBe(true);
    expect(forwarded).toEqual([door.guid, door.guid]);
  });

  it('other hooks leave the state alone', () => {
    const { som, door } = doorManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).runObjectHook(door.guid, { hookType: AnimationHookType.NoDraw, direction: 0, noDraw: 1 } as any, new THREE.Group());
    expect(door.physicsState).toBe(CLOSED_DOOR);
  });
});

// ── the real door animation (both eras): open and close are directed Ethereal hooks ──

const DOOR_ANIM = 0x03000559; // MotionTable 0x09000016 On (0x3d000b) / Off (0x3d000c) cycles
const SETS = [
  { era: 'AC1999', path: resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat'), overlay: true },
  { era: 'end of retail', path: resolve(__dirname, '..', 'dat', 'client_portal.dat'), overlay: false },
];
for (const set of SETS) {
  describe.skipIf(!existsSync(set.path))(`${set.era}: door animation 0x03000559`, () => {
    it('frame 1 carries Ethereal 1 and Ethereal 0 hooks in opposite directions', () => {
      const db = new DatDatabase(new FileDatBytes(set.path));
      if (set.overlay) db.setOverlay(ac1999PortalOverlay());
      const anim = new Animation(new DatReader(db.getFileData(DOOR_ANIM)!));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hooks = ((anim.partFrames[1] as any).hooks as Array<{ hookType: number; direction: number; ethereal: number }>)
        .filter((h) => h.hookType === AnimationHookType.Ethereal);
      expect(hooks.map((h) => h.ethereal).sort()).toEqual([0, 1]);
      const open = hooks.find((h) => h.ethereal === 1)!;
      const close = hooks.find((h) => h.ethereal === 0)!;
      expect(open.direction).not.toBe(close.direction);
    });
  });
}
