/**
 * Objects are built at placement 0x65 (Resting), not 0 (Default).
 *
 * CPhysicsObj::InitObjectEnd @ 0050ffe0 and CPartArray::CreateSetup @
 * 005195a0 call SetPlacementFrame(0x65), which falls back to frame 0 when
 * the Setup has no 0x65 entry (ACE PhysicsObj.cs:711/746, PartArray.cs:110,
 * 504-521). Ours built every DAT-placed static, scenery piece and building
 * at Default. 2,284 EoL Setups have a different Resting frame. In the
 * Facility Hub corridors (0x8A0201BC) the beam frame 0x020001E7 sank its
 * legs half into the floor and hung its crossbeam at chest height, so the
 * corridor looked blocked though nothing collided.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { GfxObj } from '../packages/dat-parser/src/file-types/GfxObj.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { getPartPlacements, placementFrameOf, PLACEMENT_RESTING } from '../packages/renderer/src/models/SetupModelGroup.js';
import { resolveObjectPhysics } from '../packages/renderer/src/world/ObjectCollision.js';
import { Placement } from '../packages/shared/src/ace-enums.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';

const frame = (z: number) => ({ origin: { x: 0, y: 0, z }, orientation: { w: 1, x: 0, y: 0, z: 0 } });

describe('placementFrameOf — Resting first, Default on a miss', () => {
  it('is keyed to Placement.Resting (101 = 0x65)', () => {
    expect(PLACEMENT_RESTING).toBe(Placement.Resting);
    expect(PLACEMENT_RESTING).toBe(0x65);
  });

  it('returns the Resting frame when the Setup has one', () => {
    const setup = { placementFrames: new Map([[0, { frames: [frame(1)], hooks: [] }], [0x65, { frames: [frame(2)], hooks: [] }]]) };
    expect(placementFrameOf(setup as never)?.frames[0].origin.z).toBe(2);
  });

  it('falls back to Default when there is no Resting frame', () => {
    const setup = { placementFrames: new Map([[0, { frames: [frame(1)], hooks: [] }]]) };
    expect(placementFrameOf(setup as never)?.frames[0].origin.z).toBe(1);
  });

  it('an explicit key still wins (wire placements: ParentEvent, PhysicsDesc)', () => {
    const setup = { placementFrames: new Map([[0, { frames: [frame(1)], hooks: [] }], [0x65, { frames: [frame(2)], hooks: [] }], [4, { frames: [frame(4)], hooks: [] }]]) };
    expect(placementFrameOf(setup as never, Placement.Belt)?.frames[0].origin.z).toBe(4);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('Facility Hub corridor beam frame 0x020001E7 (DAT)', () => {
  let portal: DatDatabase;
  let setup: SetupModel;
  beforeAll(() => {
    portal = openDat(DAT_PATHS.portal);
    setup = new SetupModel(new DatReader(portal.getFileData(0x020001e7)!));
  });

  it('draws the crossbeam at the ceiling and the legs standing on the floor', () => {
    const [beam, legA, legB] = getPartPlacements(setup);
    expect(beam.frame.origin.z).toBeCloseTo(2.8, 4);
    // Each leg GfxObj spans z ±1.5 about its origin: 0..3 m at Resting.
    expect(legA.frame.origin.z).toBeCloseTo(1.5, 4);
    expect(legB.frame.origin.z).toBeCloseTo(1.5, 4);
  });

  it('collision uses the same frames as the mesh', () => {
    const model = resolveObjectPhysics(0x020001e7, {
      loadSetupModel: () => setup,
      loadGfxObj: (id: number) => new GfxObj(new DatReader(portal.getFileData(id)!)),
    } as never)!;
    expect(model.parts.map(p => +p.frame.origin.z.toFixed(4))).toEqual([2.8, 1.5, 1.5]);
  });
});
