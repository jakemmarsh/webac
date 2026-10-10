/**
 * BUG.parent-event-placement-dropped — ParentEvent.placement was parsed off
 * the wire (verify-parent-event-wire-format.ts, FAITHFUL.339) and forwarded
 * to onParentEvent, but attachWieldedToPlayer/attachWieldedToCreature always
 * called createSetupMeshWithOverrides(setupId) with no placement argument,
 * so getPartPlacements() always fell through to placementKey=0 (Default) —
 * wielded items rendered in whatever pose their Default PlacementFrame
 * encodes, never the combat-drawn/sheathed/quiver/belt pose the server
 * actually reported.
 *
 * Ground truth (decompiled retail client, SmartBox::DoParentEvent @
 * 00452290): the client's ParentEvent handler makes TWO independent calls —
 * CPhysicsObj::set_parent(item, creature, parentLocation) then
 * CPhysicsObj::SetPlacementFrame(item, placement, 1). ParentLocation picks
 * the attach bone on the PARENT's SetupModel (holdingLocations); Placement
 * is a wholly separate lookup into the ITEM's OWN SetupModel.placementFrames
 * — this is what selects RightHandCombat vs RightHandNonCombat/Belt/Quiver
 * pose for the item itself. Same two-dictionary split confirmed server-side
 * in ACE Creature_Equipment.cs:504-556 GetPlacementLocation (which computes
 * a Placement AND a ParentLocation from the same EquipMask) and
 * ACE.Server.Physics.PartArray.cs:504-521 SetPlacementFrame (falls back to
 * PlacementFrames[0] when the requested key has no entry, then to an
 * identity/null frame — never just "always use key 0").
 *
 * This suite behaviorally drives the actually-exported, actually-pure
 * placement-resolution logic (getPartPlacements) rather than pinning
 * source text — the two call-site fixes in main.ts (threading
 * data.placement through attachWieldedToPlayer/attachWieldedToCreature)
 * live in unexported closures inside main.ts's monolithic setup function
 * and are covered by updated pins in verify-parent-event.ts, consistent
 * with the rest of this file's existing coverage of that same function.
 */
import { describe, it, expect } from 'vitest';
import { getPartPlacements } from '../packages/renderer/src/models/SetupModelGroup.js';
import type { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { Placement } from '../packages/shared/src/ace-enums.js';

function fakeSetup(overrides: Partial<SetupModel> = {}): SetupModel {
  return {
    id: 0,
    flags: 0,
    allowFreeHeading: false,
    hasPhysicsBSP: false,
    parts: [0x01000001],
    parentIndex: [],
    defaultScale: [],
    holdingLocations: new Map(),
    connectionPoints: new Map(),
    placementFrames: new Map(),
    cylSpheres: [],
    spheres: [],
    height: 0,
    radius: 0,
    stepUpHeight: 0,
    stepDownHeight: 0,
    sortingSphere: { origin: { x: 0, y: 0, z: 0 }, radius: 0 },
    selectionSphere: { origin: { x: 0, y: 0, z: 0 }, radius: 0 },
    lights: new Map(),
    defaultAnimation: 0,
    defaultScript: 0,
    defaultMotionTable: 0,
    defaultSoundTable: 0,
    defaultScriptTable: 0,
    ...overrides,
  } as SetupModel;
}

const DEFAULT_FRAME = { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } };
const COMBAT_FRAME = { origin: { x: 0.1, y: 0.2, z: 0.3 }, orientation: { w: 0.9, x: 0.1, y: 0, z: 0 } };

describe('BUG.parent-event-placement-dropped — getPartPlacements selects the requested Placement', () => {
  it('uses the RightHandCombat (1) PlacementFrame when passed the wire value, not Default', () => {
    const setup = fakeSetup({
      placementFrames: new Map([
        [Placement.Default, { frames: [DEFAULT_FRAME], hooks: [] }],
        [Placement.RightHandCombat, { frames: [COMBAT_FRAME], hooks: [] }],
      ]),
    });
    const placements = getPartPlacements(setup, Placement.RightHandCombat);
    expect(placements).toHaveLength(1);
    expect(placements[0].frame).toEqual(COMBAT_FRAME);
  });

  it('with no placement argument, Resting (0x65) else Default — CPartArray::CreateSetup sets 0x65', () => {
    const setup = fakeSetup({
      placementFrames: new Map([
        [Placement.Default, { frames: [DEFAULT_FRAME], hooks: [] }],
        [Placement.RightHandCombat, { frames: [COMBAT_FRAME], hooks: [] }],
      ]),
    });
    expect(getPartPlacements(setup)[0].frame).toEqual(DEFAULT_FRAME);
    setup.placementFrames.set(Placement.Resting, { frames: [COMBAT_FRAME], hooks: [] });
    expect(getPartPlacements(setup)[0].frame).toEqual(COMBAT_FRAME);
  });

  it('falls back to PlacementFrames[0] (Default) when the requested placement has no entry — ACE PartArray.cs:517-521', () => {
    const setup = fakeSetup({
      placementFrames: new Map([
        [Placement.Default, { frames: [DEFAULT_FRAME], hooks: [] }],
        // No entry for Belt (4) — most weapon SetupModels don't define every Placement key.
      ]),
    });
    const placements = getPartPlacements(setup, Placement.Belt);
    expect(placements[0].frame).toEqual(DEFAULT_FRAME);
  });

  it('falls back to an identity frame only when NEITHER the requested key NOR 0 has an entry', () => {
    const setup = fakeSetup({ placementFrames: new Map() });
    const placements = getPartPlacements(setup, Placement.Quiver);
    expect(placements[0].frame).toEqual(DEFAULT_FRAME); // identity == same shape as DEFAULT_FRAME here
  });

  it('distinguishes RightHandCombat from RightHandNonCombat/Shield/Belt/Quiver — each is an independent lookup', () => {
    const setup = fakeSetup({
      placementFrames: new Map([
        [Placement.Default, { frames: [DEFAULT_FRAME], hooks: [] }],
        [Placement.RightHandCombat, { frames: [{ origin: { x: 1, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }], hooks: [] }],
        [Placement.Belt, { frames: [{ origin: { x: 2, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }], hooks: [] }],
        [Placement.Quiver, { frames: [{ origin: { x: 3, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }], hooks: [] }],
      ]),
    });
    expect(getPartPlacements(setup, Placement.RightHandCombat)[0].frame.origin.x).toBe(1);
    expect(getPartPlacements(setup, Placement.Belt)[0].frame.origin.x).toBe(2);
    expect(getPartPlacements(setup, Placement.Quiver)[0].frame.origin.x).toBe(3);
  });
});
