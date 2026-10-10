/**
 * BUG.academy-stairs-fall-through — the ground under a frame's move is
 * followed along the path in retail transition steps (ACE Transition.cs
 * CalcNumSteps: ceil(dist / sphere radius)), and an interior body over an
 * open cell drops to the walkable below instead of standing on the arrival
 * height.
 *
 * Unit tests drive the shipped helpers with a model floor that has
 * DungeonCollision.getFloorHeight's search window (2 m above, 5 m below the
 * search height). The DAT-gated tests register the Holtburg academy's
 * EnvCells (landblock 0x8602) in a real DungeonCollision and replay the two
 * live failures: the 42° stair ramp of cell 0x86020328 (z 9 at x 61.67 →
 * z 12 at x 65, y -70) climbed in one long frame, and the stair shaft cell
 * 0x860202C4 (its floor is a portal over the z -6 floor of 0x8602013B).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  traceGroundAlongPath, interiorGroundY, MAX_GROUND_TRACE_STEPS, type InteriorGroundSources,
} from '../packages/renderer/src/world/outdoorGround.js';
import { openDat } from './_harness/dat.js';
import * as OutdoorMovement from '../packages/renderer/src/player/OutdoorMovement.js';

/** The academy ramp's profile along x: z 9 below x 61.67, rising 0.9 per metre, z 12 from x 65. */
const rampZ = (x: number): number => (x <= 61.67 ? 9 : x >= 65 ? 12 : 9 + (x - 61.67) * 0.9);
/** getFloorHeight's window: a floor counts only within 2 m above / `maxDrop` below the search height. */
function windowed(floorZ: (x: number) => number | null) {
  const calls: Array<{ x: number; fromY: number }> = [];
  const query = (x: number, _z: number, fromY: number, maxDrop = 5): number | null => {
    calls.push({ x, fromY });
    const f = floorZ(x);
    return f !== null && f <= fromY + 2 && f >= fromY - maxDrop ? f : null;
  };
  return { query, calls };
}

describe('BUG.academy-stairs-fall-through — traceGroundAlongPath', () => {
  const R = 0.48; // the human body sphere radius (Setup 0x02000001 Spheres[0])

  it('follows a steep ramp across a long frame that one query at the end loses', () => {
    const { query } = windowed(rampZ);
    // 2.8 m in one frame: the end of the ramp is 2.5 m above the old floor.
    expect(query(64.8, 0, rampZ(62))).toBeNull();
    const y = traceGroundAlongPath(query, 62, 0, 64.8, 0, rampZ(62), R);
    expect(y).toBeCloseTo(rampZ(64.8), 6);
  });

  it('carries the climb onto the upper floor', () => {
    const { query } = windowed(rampZ);
    expect(traceGroundAlongPath(query, 61, 0, 66, 0, 9, R)).toBe(12);
  });

  it('a move shorter than the sphere radius is one query at the destination', () => {
    const { query, calls } = windowed(rampZ);
    expect(traceGroundAlongPath(query, 62, 0, 62.3, 0, rampZ(62), R)).toBeCloseTo(rampZ(62.3), 6);
    expect(calls).toEqual([{ x: 62.3, fromY: rampZ(62) }]);
  });

  it('sweeps in ceil(dist / radius) equal steps, each searching from the last floor', () => {
    const { query, calls } = windowed(rampZ);
    traceGroundAlongPath(query, 62, 0, 64, 0, rampZ(62), 0.5);
    expect(calls.map((c) => c.x)).toEqual([62.5, 63, 63.5, 64]);
    expect(calls[1].fromY).toBeCloseTo(rampZ(62.5), 6);
    expect(calls[3].fromY).toBeCloseTo(rampZ(63.5), 6);
  });

  it('a step over a polygon seam keeps the previous height', () => {
    const seamed = windowed((x) => (Math.abs(x - 63.5) < 1e-9 ? null : rampZ(x)));
    expect(traceGroundAlongPath(seamed.query, 62, 0, 65, 0, rampZ(62), 0.5)).toBe(12);
    expect(seamed.calls[3].fromY).toBeCloseTo(rampZ(63), 6); // the step after the seam
  });

  it('no floor at the destination is null', () => {
    const { query } = windowed((x) => (x > 63 ? null : 9));
    expect(traceGroundAlongPath(query, 62, 0, 64, 0, 9, R)).toBeNull();
  });

  it('a move too long to be a walk (snap / teleport) is not traced', () => {
    const { query, calls } = windowed(() => 9);
    const far = R * (MAX_GROUND_TRACE_STEPS + 1);
    traceGroundAlongPath(query, 0, 0, far, 0, 9, R);
    expect(calls).toHaveLength(1);
  });
});

describe('BUG.academy-stairs-fall-through — interiorGroundY', () => {
  const R = 0.48;
  const shaft = (inCell: boolean): InteriorGroundSources & { calls: number[] } => {
    const calls: number[] = [];
    return {
      calls,
      // Floor at z -6 everywhere; nothing at z 0 (the floor is a portal).
      floorHeight: (_x, _z, fromY, maxDrop = 5) => { calls.push(maxDrop); return -6 >= fromY - maxDrop && -6 <= fromY + 2 ? -6 : null; },
      cellAt: () => (inCell ? 0x860202c4 : 0),
    };
  };

  it('inside a cell with no floor in reach, the ground is the walkable below', () => {
    const src = shaft(true);
    expect(interiorGroundY(src, 125, 0, 125.2, 0, 0, R, 0)).toBe(-6);
    expect(src.calls.at(-1)).toBe(Infinity);
  });

  it('outside every registered cell, the fallback height stands (no geometry yet)', () => {
    expect(interiorGroundY(shaft(false), 125, 0, 125.2, 0, 0, R, 0.5)).toBe(0.5);
  });

  it('a floor within reach wins and the deep search never runs', () => {
    const src: InteriorGroundSources = {
      floorHeight: (_x, _z, _y, maxDrop) => { expect(maxDrop).toBeUndefined(); return 3; },
      cellAt: () => { throw new Error('containment must not be tested when a floor is found'); },
    };
    expect(interiorGroundY(src, 0, 0, 0.1, 0, 3, R, 0)).toBe(3);
  });
});

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');
const CELL = resolve(REPO, 'dat/client_cell_1.dat');
const datPresent = existsSync(PORTAL) && existsSync(CELL);

describe.skipIf(!datPresent)('BUG.academy-stairs-fall-through — the Holtburg academy (needs DAT files)', () => {
  type Collision = import('../packages/renderer/src/world/DungeonCollision.js').DungeonCollision;
  let col: Collision;
  const BX = 0x86 * 192;
  const BY = 0x02 * 192;
  const LB = 0x86020000;
  let src: InteriorGroundSources;

  beforeAll(async () => {
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const portalDb = openDat(PORTAL);
    const cellDb = openDat(CELL);
    const materialFactory = new MaterialFactory(portalDb, new TextureManager(portalDb));
    const modelRenderer = new ModelRenderer(portalDb, materialFactory);
    const envRenderer = new EnvCellRenderer(portalDb, cellDb, materialFactory, new SetupModelRenderer(portalDb, modelRenderer), modelRenderer);
    col = new DungeonCollision();
    for (let c = 0x100; c <= 0x3ff; c++) {
      const cellId = (LB | c) >>> 0;
      const coll = envRenderer.getCellCollisionData(cellId);
      if (coll) col.addCell(cellId, coll.cellStruct, coll.position);
    }
    src = {
      floorHeight: (x, z, fromY, maxDrop) => col.getFloorHeight(x, z, fromY, maxDrop),
      cellAt: (x, z, footY) => col.findCellContaining(x, z, footY + col.lowerSphereHeight, 0),
    };
  }, 120_000);

  it('the stair ramp of 0x86020328 climbed in one 2.5 m frame keeps the feet on the ramp', () => {
    const from = col.getFloorHeight(BX + 62, BY - 70, 9)!;
    expect(from).toBeCloseTo(9.3, 1);
    // The live failure: one query at the end of the move finds nothing in reach…
    expect(col.getFloorHeight(BX + 64.5, BY - 70, from)).toBeNull();
    // …and the ground fell back to the arrival height (the teleloc's z 0).
    const y = interiorGroundY(src, BX + 62, BY - 70, BX + 64.5, BY - 70, from, col.transitionSphereRadius, 0);
    expect(y).toBeCloseTo(11.55, 1);
  });

  it('a long frame from the bottom doorway onto the upper floor lands on z 12', () => {
    const y = interiorGroundY(src, BX + 60, BY - 70, BX + 66.5, BY - 70, 9, col.transitionSphereRadius, 0);
    expect(y).toBeCloseTo(12, 3);
  });

  it('BUG.academy-olthoi-leg-upper-floor — the x = 195.0 doorway seam (0x86020121 | 0x86020111) has no floor; the body keeps its current floor, not the arrival height', () => {
    // The floor along y = -220 is -12 on both sides of the doorway plane…
    expect(col.getFloorHeight(BX + 194.8, BY - 220, -12)).toBeCloseTo(-12, 3);
    expect(col.getFloorHeight(BX + 195.2, BY - 220, -12)).toBeCloseTo(-12, 3);
    // …and nothing exactly on it (a shared polygon edge), nor anywhere below.
    expect(col.getFloorHeight(BX + 195, BY - 220, -12)).toBeNull();
    expect(col.getFloorHeight(BX + 195, BY - 220, -12, Infinity)).toBeNull();
    // A step that ends on the seam falls back to the floor the body stood on
    // (main.ts passes lastFloorAwareGroundY). It was dungeonFloorY, the
    // ARRIVAL height: a fresh character arrives upstairs, so the probe popped
    // 6 m up into 0x860201A7.
    expect(interiorGroundY(src, BX + 195.3, BY - 220, BX + 195, BY - 220, -12, col.transitionSphereRadius, -12)).toBeCloseTo(-12, 3);
  });

  it('the player\'s own floor follow (getBodyFloorHeight, main.ts) keeps every case: ramp frame, long frame, seam, shaft', () => {
    // RECON.transition-stepup-stepdown-port.e — main.ts follows the feet
    // sphere's step-down contact; a long frame's upward trace still rides
    // the centre search, so the values match the plane's.
    const body: InteriorGroundSources = {
      floorHeight: (x, z, fromY, maxDrop) => col.getBodyFloorHeight(x, z, fromY, 0.6, maxDrop),
      cellAt: src.cellAt,
    };
    const from = col.getFloorHeight(BX + 62, BY - 70, 9)!;
    expect(interiorGroundY(body, BX + 62, BY - 70, BX + 64.5, BY - 70, from, col.transitionSphereRadius, 0)).toBeCloseTo(11.55, 1);
    expect(interiorGroundY(body, BX + 60, BY - 70, BX + 66.5, BY - 70, 9, col.transitionSphereRadius, 0)).toBeCloseTo(12, 3);
    expect(interiorGroundY(body, BX + 195.3, BY - 220, BX + 195, BY - 220, -12, col.transitionSphereRadius, -12)).toBeCloseTo(-12, 3);
    expect(interiorGroundY(body, BX + 125.8, BY - 130, BX + 126, BY - 130, 0, col.transitionSphereRadius, 0)).toBeCloseTo(-6, 3);
  });

  it('a keyed walk up the 0x86020328 ramp with the body floor follow climbs it onto z 12', () => {
    const { stepPlayerMovement } = OutdoorMovement;
    const services = {
      dungeonCollision: col, outdoorCollision: col,
      terrain: { getHeightAt: () => null, getTriangleNormalAt: () => null, isWalkable: () => true },
      water: { cellWaterTypeAt: () => null },
      creatureObstacles: null, defaultPlayerRadius: col.playerRadius, edgeSlide: true, stepDownHeight: 0.6,
    } as never;
    const body: InteriorGroundSources = {
      floorHeight: (x, z, fromY, maxDrop) => col.getBodyFloorHeight(x, z, fromY, 0.6, maxDrop),
      cellAt: src.cellAt,
    };
    let x = BX + 60;
    let z = BY - 70;
    let y = 9;
    let prev = y;
    for (let i = 0; i < 90; i++) {
      const r = stepPlayerMovement({ x, z, floorY: y, inDungeon: true, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, 0.1, 0, 1 / 30, services);
      y = interiorGroundY(body, x, z, r.x, r.z, y + col.lastStepUp, col.transitionSphereRadius, y);
      x = r.x;
      z = r.z;
      expect(y).toBeGreaterThanOrEqual(prev - 0.2); // never drops back down the ramp
      prev = y;
    }
    expect(x - BX).toBeGreaterThan(68.9);
    expect(y).toBeCloseTo(12, 3);
  });

  it('stepping off the floor into the stair shaft 0x860202C4 drops to its z -6 floor, not the arrival height', () => {
    // On the z 0 floor of 0x860202C2, stepping east over the shaft's floor portal.
    expect(col.getFloorHeight(BX + 124, BY - 130, 0)).toBeCloseTo(0, 3);
    expect(col.getFloorHeight(BX + 126, BY - 130, 0)).toBeNull();
    expect(src.cellAt(BX + 126, BY - 130, 0)).toBe(0x860202c4);
    expect(interiorGroundY(src, BX + 125.8, BY - 130, BX + 126, BY - 130, 0, col.transitionSphereRadius, 0)).toBeCloseTo(-6, 3);
  });
});
