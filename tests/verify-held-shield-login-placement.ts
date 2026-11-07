/**
 * webac#26 (shield wrongly rotated after login, right after a re-equip) —
 * the held copy's own frame is the same on both paths.
 *
 * Login: the shield's CreateObject carries PhysicsDesc AnimationFrame
 * (ACE / ClassicACE write item.Placement = Shield (6), set by SetChildren;
 * GDLE writes its physics object's placement_frame_id, 0 after the miss) and
 * attachWieldedToPlayer runs with no ParentEvent placement. Re-equip: the
 * ParentEvent carries Placement.Shield (6). The round shield Setup
 * 0x02000162 has no frame 6, so CPartArray::SetPlacementFrame @ 005193d0
 * falls back to Default (0) on every path. This pins that equivalence with
 * the real DAT frames, so the live repro can look elsewhere (the holder's
 * pose), and pins the inverse: Resting (0x65) really does turn the shield.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { getPartPlacements, PLACEMENT_RESTING } from '../packages/renderer/src/models/SetupModelGroup.js';
import { buildInventoryEntry, type InventoryEntrySource } from '../packages/renderer/src/network/objectSubjectRouting.js';
import { buildWieldedItemMesh, WIELDED_PLACEMENT_KEY, type WieldedMeshBuilder } from '../packages/renderer/src/models/WieldedItemVisual.js';

const ROUND_SHIELD_SETUP = 0x02000162; // Metal Round Shield (wcid 1313) and Round Shield (93)
const PLACEMENT_SHIELD = 6;

function shieldCreateObject(placement: number | undefined): InventoryEntrySource {
  return {
    weenieClassId: 1313, name: 'Metal Round Shield', value: 100, burden: 100, stackSize: 1, maxStackSize: 1,
    containerId: 0, iconId: 0x060013ff, validLocations: 0x00200000, itemType: 0x2, uiEffects: 0, usable: 1,
    setupId: ROUND_SHIELD_SETUP, objScale: 1, basePalette: 0x04000bef, subPalettes: [],
    textureChanges: [{ partIndex: 0, oldTexture: 0x05000fd9, newTexture: 0x05000fd8 }], animPartChanges: [],
    placement,
  };
}

describe.skipIf(!existsSync(DAT_PATHS.portal))('webac#26 — held round shield: login and re-equip build the same frame', () => {
  let builder: WieldedMeshBuilder;
  beforeAll(() => {
    const db = openDat(DAT_PATHS.portal);
    const setup = new SetupModel(db.getReader(ROUND_SHIELD_SETUP));
    // Poses part_N exactly as SetupModelRenderer.createSetupMeshWithOverrides does.
    builder = {
      createSetupMeshWithOverrides: (_id, placementKey = PLACEMENT_RESTING) => {
        const g = new THREE.Group();
        for (const p of getPartPlacements(setup, placementKey)) {
          const part = new THREE.Object3D();
          part.name = `part_${p.partIndex}`;
          part.quaternion.set(-p.frame.orientation.x, -p.frame.orientation.z, -p.frame.orientation.y, p.frame.orientation.w);
          part.position.set(p.frame.origin.x, p.frame.origin.z, p.frame.origin.y);
          g.add(part);
        }
        return g;
      },
    };
  });

  const partQuat = (mesh: THREE.Object3D | null) => (mesh!.getObjectByName('part_0') as THREE.Object3D).quaternion;

  it('login (CreateObject Placement 6, ACE / ClassicACE) = re-equip (ParentEvent 6) = GDLE login (0)', () => {
    const ace = buildInventoryEntry(shieldCreateObject(PLACEMENT_SHIELD)).visualDesc!;
    const gdle = buildInventoryEntry(shieldCreateObject(0)).visualDesc!;
    const login = buildWieldedItemMesh(builder, ace, undefined, () => null);
    const reequip = buildWieldedItemMesh(builder, ace, PLACEMENT_SHIELD, () => null);
    const gdleLogin = buildWieldedItemMesh(builder, gdle, undefined, () => null);
    expect(login!.userData[WIELDED_PLACEMENT_KEY]).toBe(PLACEMENT_SHIELD);
    expect(partQuat(login).angleTo(partQuat(reequip))).toBeLessThan(1e-6);
    expect(partQuat(gdleLogin).angleTo(partQuat(reequip))).toBeLessThan(1e-6);
    // Setup 0x02000162 has no frame 6: both are the Default (identity) frame.
    expect(partQuat(reequip).angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
  });

  it('inverse: a CreateObject with no placement rests at 0x65, a 90° turn about the shield X axis', () => {
    const none = buildInventoryEntry(shieldCreateObject(undefined)).visualDesc!;
    const resting = buildWieldedItemMesh(builder, none, undefined, () => null);
    expect(resting!.userData[WIELDED_PLACEMENT_KEY]).toBe(PLACEMENT_RESTING);
    expect(THREE.MathUtils.radToDeg(partQuat(resting).angleTo(new THREE.Quaternion()))).toBeCloseTo(90, 1);
  });
});
