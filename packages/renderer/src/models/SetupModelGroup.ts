import type { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import { Placement } from '@ac/shared';

/**
 * Part placement info for a multi-part model.
 * Each part is a GfxObj placed at a specific position/orientation.
 */
export interface PartPlacement {
  partIndex: number;
  gfxObjId: number;
  frame: Frame;
  scale?: { x: number; y: number; z: number };
  parentIndex?: number;
}

/**
 * Placement 0x65 (Resting): the frame every object is built at. CPhysicsObj::
 * InitObjectEnd @ 0050ffe0 and CPartArray::CreateSetup @ 005195a0 call
 * SetPlacementFrame(0x65) (ACE PhysicsObj.cs:711/746, PartArray.cs:110), so
 * a static, scenery piece, building or server object with no placement or
 * motion of its own rests at 0x65, else Default (0). 2,284 EoL Setups carry
 * a Resting frame that differs from Default: the Facility Hub corridor
 * beam frame 0x020001E7 stands its legs on the floor and lifts its
 * crossbeam to the ceiling (z 2.8) at 0x65, but sinks half into the floor
 * with the beam at chest height (z 1.3) at 0.
 */
export const PLACEMENT_RESTING: number = Placement.Resting;

/**
 * A Setup's placement frame by key, falling back to key 0 (Default) on a
 * miss — ACE PartArray.cs:504-521 SetPlacementFrame (TryGetValue(placementID)
 * miss falls back to TryGetValue(0) before giving up to an identity frame).
 */
export function placementFrameOf(
  setup: Pick<SetupModel, 'placementFrames'>,
  placementKey: number = PLACEMENT_RESTING,
): ReturnType<SetupModel['placementFrames']['get']> {
  return setup.placementFrames.get(placementKey) ?? setup.placementFrames.get(0);
}

/**
 * Extract part placements from a SetupModel for rendering, at the Resting
 * placement unless a key is given (BUG.parent-event-placement-dropped —
 * a missing key falls back to Default, see placementFrameOf).
 */
export function getPartPlacements(setup: SetupModel, placementKey: number = PLACEMENT_RESTING): PartPlacement[] {
  const placements: PartPlacement[] = [];
  const placementFrame = placementFrameOf(setup, placementKey);

  for (let i = 0; i < setup.parts.length; i++) {
    const placement: PartPlacement = {
      partIndex: i,
      gfxObjId: setup.parts[i],
      frame: placementFrame?.frames[i] ?? {
        origin: { x: 0, y: 0, z: 0 },
        orientation: { w: 1, x: 0, y: 0, z: 0 },
      },
    };

    if (setup.defaultScale.length > i) {
      placement.scale = setup.defaultScale[i];
    }

    if (setup.parentIndex.length > i) {
      placement.parentIndex = setup.parentIndex[i];
    }

    placements.push(placement);
  }

  return placements;
}
