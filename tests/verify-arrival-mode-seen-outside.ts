/**
 * BUG.seen-outside-arrival-dungeon-mode (2026-10-09) — a login or teleport
 * into ANY interior cell used to put the player in interior ("dungeon")
 * mode, including a surface building's SeenOutside cells such as the
 * Holtburg tavern vestibule 0xA9B40165. That mode's collider holds only the
 * landblock's cells and building shells, no terrain, so past the doorway
 * the dungeon floor query is null and precipiceStep reads the doorway's
 * floor edge as a ledge ('collided'). Live (acjs-c8): a character logged in
 * inside the tavern stopped at x 97.507 heading west, door open, forever —
 * interior mode only ends on a teleport.
 *
 * Retail has one cell array: CEnvCell::find_transit_cells @ 0052c820 calls
 * CLandCell::add_all_outside_cells for a portal whose other_cell_id is
 * 0xFFFFFFFF, so the terrain joins the transition and the step down lands
 * on it. Our equivalent is the outdoor collision world a walk-in already
 * uses: a SeenOutside arrival stays in outdoor mode (world/arrivalMode.ts);
 * only a sealed cell (a real dungeon) is interior mode.
 *
 * Behavioral: the shipped arrivalMode / confirmSurfaceArrival with the real
 * EnvCell flags, then the shipped stepPlayerMovement + outdoor floor follow
 * in the real A9B4 world (terrain + doorway-reachable interior cells, as
 * LandblockObjectStreamer registers them), with the old interior-mode
 * collider as the contrast.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { arrivalMode, confirmSurfaceArrival } from '../packages/renderer/src/world/arrivalMode.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { outdoorGroundY, traceGroundAlongPath, floorSearchFromY } from '../packages/renderer/src/world/outdoorGround.js';
import { precipiceStep, stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const TAVERN_VESTIBULE = 0xa9b40165;
const SEALED_DUNGEON = 0x01d90108;
const DRUDGE_HIDEOUT = 0x019e0110;

describe('arrivalMode (unit)', () => {
  const seen = new Set([TAVERN_VESTIBULE]);
  const isSeenOutside = (id: number) => seen.has(id >>> 0);

  it('an outdoor land cell is outdoor mode with no surface cell', () => {
    expect(arrivalMode(0xa9b4001e, isSeenOutside)).toEqual({ kind: 'outdoor', surfaceCellId: 0 });
    expect(arrivalMode(0xa9b4ffff, isSeenOutside)).toEqual({ kind: 'outdoor', surfaceCellId: 0 });
  });

  it('a SeenOutside interior cell is outdoor mode seeded with that cell', () => {
    expect(arrivalMode(TAVERN_VESTIBULE, isSeenOutside)).toEqual({ kind: 'outdoor', surfaceCellId: TAVERN_VESTIBULE });
  });

  it('a sealed interior cell is interior mode', () => {
    expect(arrivalMode(SEALED_DUNGEON, isSeenOutside)).toEqual({ kind: 'interior' });
  });

  it('a surface arrival whose cell no surface collision holds falls back to interior mode', () => {
    const mode = arrivalMode(TAVERN_VESTIBULE, isSeenOutside);
    expect(confirmSurfaceArrival(mode, () => false)).toEqual({ kind: 'interior' });
    expect(confirmSurfaceArrival(mode, (id) => id === TAVERN_VESTIBULE)).toBe(mode);
    // Outdoor and interior arrivals pass through untouched.
    const outdoor = arrivalMode(0xa9b4001e, isSeenOutside);
    expect(confirmSurfaceArrival(outdoor, () => false)).toBe(outdoor);
    const interior = arrivalMode(SEALED_DUNGEON, isSeenOutside);
    expect(confirmSurfaceArrival(interior, () => true)).toBe(interior);
  });
});

/** The EnvCell SeenOutside flag as main.ts's isCellSeenOutside reads it (unreadable → sealed). */
async function seenOutsideReader(db: DatDatabase): Promise<(id: number) => boolean> {
  const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
  const { EnvCell, EnvCellFlags } = await import('../packages/dat-parser/src/file-types/EnvCell.js');
  return (id) => {
    const bytes = db.getFileData(id >>> 0);
    if (!bytes) return false;
    return (new EnvCell(new DatReader(bytes)).flags & EnvCellFlags.SeenOutside) !== 0;
  };
}

const haveEolDat = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);

describe.skipIf(!haveEolDat)('arrivalMode with the end-of-retail EnvCell flags', () => {
  let isSeenOutside: (id: number) => boolean;
  beforeAll(async () => { isSeenOutside = await seenOutsideReader(openDat(DAT_PATHS.cell)); });

  it('the Holtburg tavern vestibule 0xA9B40165 arrives in outdoor mode, surface cell 0x165', () => {
    const mode = arrivalMode(TAVERN_VESTIBULE, isSeenOutside);
    expect(mode.kind).toBe('outdoor');
    expect(mode.kind === 'outdoor' && mode.surfaceCellId & 0xffff).toBe(0x165);
  });

  it('sealed dungeon cells (0x01D90108, the Drudge Hideout 0x019E0110) arrive in interior mode', () => {
    expect(arrivalMode(SEALED_DUNGEON, isSeenOutside)).toEqual({ kind: 'interior' });
    expect(arrivalMode(DRUDGE_HIDEOUT, isSeenOutside)).toEqual({ kind: 'interior' });
  });
});

const AC1999_CELL = resolve(__dirname, '..', 'dat-sets/ac1999-retail/cell.dat');
describe.skipIf(!existsSync(AC1999_CELL))('arrivalMode with the AC1999 EnvCell flags', () => {
  let isSeenOutside: (id: number) => boolean;
  beforeAll(async () => {
    // Its own instance: the overlay changes reads (verify-ac1999-world-set.ts).
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { FileDatBytes } = await import('../packages/dat-parser/src/node/FileDatBytes.js');
    const { ac1999CellOverlay } = await import('../packages/dat-parser/src/era1999/Ac1999Overlay.js');
    const db = new DatDatabase(new FileDatBytes(AC1999_CELL));
    db.setOverlay(ac1999CellOverlay());
    isSeenOutside = await seenOutsideReader(db);
  });

  it('a sealed 1999 dungeon cell stays interior mode', () => {
    expect(arrivalMode(SEALED_DUNGEON, isSeenOutside)).toEqual({ kind: 'interior' });
    expect(arrivalMode(DRUDGE_HIDEOUT, isSeenOutside)).toEqual({ kind: 'interior' });
  });

  it('the 1999 Holtburg tavern vestibule is a surface cell too', () => {
    expect(arrivalMode(TAVERN_VESTIBULE, isSeenOutside)).toEqual({ kind: 'outdoor', surfaceCellId: TAVERN_VESTIBULE });
  });
});

const DM_CELL = resolve(__dirname, '..', 'dat-sets/classic-dereth-1.1/client_cell_1.dat');
describe.skipIf(!existsSync(DM_CELL))('arrivalMode with the Dark Majesty (classic Dereth) EnvCell flags', () => {
  let isSeenOutside: (id: number) => boolean;
  beforeAll(async () => { isSeenOutside = await seenOutsideReader(openDat(DM_CELL)); });

  it('sealed dungeon cells stay interior mode; the tavern vestibule is outdoor mode', () => {
    expect(arrivalMode(SEALED_DUNGEON, isSeenOutside)).toEqual({ kind: 'interior' });
    expect(arrivalMode(TAVERN_VESTIBULE, isSeenOutside)).toEqual({ kind: 'outdoor', surfaceCellId: TAVERN_VESTIBULE });
  });
});

describe.skipIf(!haveEolDat)('walking out of the Holtburg tavern after a vestibule arrival (A9B4 0x165 → outside)', () => {
  let services: MovementServices;
  let dc: DungeonCollision;
  let OX = 0;
  let OY = 0;
  // The old interior-mode world: populateDungeonCollision over 0xA9B4 + main.ts's dungeonGroundAt.
  let dungeon: DungeonCollision;
  let dungeonGroundAt: (x: number, z: number, fromY: number) => number | null;

  beforeAll(async () => {
    const { buildA9b4World, A9B4 } = await import('./_harness/a9b4-world.js');
    OX = A9B4.OX;
    OY = A9B4.OY;
    services = (await buildA9b4World({ interiors: true }))({ slidingNormal: null }, () => undefined);
    dc = services.outdoorCollision as DungeonCollision;

    const portalDb = openDat(DAT_PATHS.portal);
    const cellDb = openDat(DAT_PATHS.cell);
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { LandblockInfo } = await import('../packages/dat-parser/src/file-types/LandblockInfo.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { populateDungeonCollision } = await import('../packages/renderer/src/world/DungeonCollisionBuild.js');
    const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
    const mr = new ModelRenderer(portalDb, mf);
    const sr = new SetupModelRenderer(portalDb, mr);
    const env = new EnvCellRenderer(portalDb, cellDb, mf, sr, mr);
    const lbInfo = (lb: number) => {
      const d = cellDb.getFileData(((lb & 0xffff0000) | 0xfffe) >>> 0);
      return d ? new LandblockInfo(new DatReader(d)) : null;
    };
    dungeon = new DungeonCollision();
    populateDungeonCollision(dungeon, 0xa9b4ffff, {
      findInteriorCells: (lb) => {
        const info = lbInfo(lb)!;
        const out: number[] = [];
        for (let i = 0; i < info.numCells; i++) {
          const id = ((lb & 0xffff0000) | (0x100 + i)) >>> 0;
          if (cellDb.hasFile(id)) out.push(id);
        }
        return out;
      },
      getCellCollisionData: (id) => env.getCellCollisionData(id),
      loadEnvCell: (id) => env.loadEnvCell(id),
      loadSetupModel: (id) => sr.loadSetupModel(id),
      loadGfxObj: (id) => mr.loadGfxObj(id),
      loadLandblockInfo: lbInfo,
    });
    dungeonGroundAt = (x, z, fromY) => dungeon.getFloorHeight(x, z, fromY, Infinity) ?? null;
  });

  it('the outdoor collision holds the vestibule (the surface arrival is confirmed, not a fallback)', () => {
    expect(dc.hasCell(TAVERN_VESTIBULE)).toBe(true);
    const mode = arrivalMode(TAVERN_VESTIBULE, () => true);
    expect(confirmSurfaceArrival(mode, (id) => dc.hasCell(id))).toEqual({ kind: 'outdoor', surfaceCellId: TAVERN_VESTIBULE });
  });

  /** The outdoor-mode walk main.ts runs per substep: stepPlayerMovement + the player's floor follow. */
  function walkWest(x0: number, y0: number, steps: number) {
    const groundAt = (x: number, z: number, fromY: number) => outdoorGroundY({
      terrainHeight: (a, b) => services.terrain.getHeightAt(a, b),
      floorHeight: (a, b, y) => dc.getBodyFloorHeight(a, b, y, services.stepDownHeight),
    }, x, z, fromY);
    let x = OX + x0;
    let z = OY + y0;
    let floorY = 94;
    services.slide!.slidingNormal = null;
    // Heading 270° (west): AC −X.
    const dx = -0.1;
    const dz = 0;
    for (let i = 0; i < steps; i++) {
      const r = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0 }, dx, dz, 1 / 30, services);
      const g = traceGroundAlongPath(groundAt, x, z, r.x, r.z, floorSearchFromY(null, floorY, dc.lastStepUp), dc.transitionSphereRadius);
      x = r.x;
      z = r.z;
      if (g !== null) floorY = g;
    }
    return { x: x - OX, y: z - OY, floorY, cell: dc.findCellContaining(x, z, floorY + 0.475) };
  }

  it('both starts are inside the tavern on its floor (the vestibule 0x165 and the room 0x163 behind it)', () => {
    expect(dc.findCellContaining(OX + 97.507, OY + 35.954, 94.475)).toBe(TAVERN_VESTIBULE);
    expect(dc.findCellContaining(OX + 99.298, OY + 35.954, 94.475)).toBe(0xa9b40163);
    expect(dc.getBodyFloorHeight(OX + 97.507, OY + 35.954, 94, 0.6)).toBeCloseTo(94, 2);
  });

  for (const x0 of [97.507, 99.298]) {
    it(`walks out of the door from (${x0}, 35.954) heading 270° onto the ground outside`, () => {
      const end = walkWest(x0, 35.954, 45);
      expect(end.cell).toBe(0);
      expect(end.x).toBeLessThan(96);
      expect(end.floorY).toBeCloseTo(94, 1);
    });
  }

  it('contrast: the old interior-mode world reads the doorway floor edge as a ledge', () => {
    const X = OX + 97.507;
    const Z = OY + 35.954;
    const p = precipiceStep(dungeon, X, Z, 94, -0.1, 0, 0.6, dungeonGroundAt);
    expect(p).toBe('collided');
  });
});
