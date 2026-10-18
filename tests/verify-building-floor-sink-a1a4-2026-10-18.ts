/**
 * BUG.building-floor-sink-a1a4 — 2026-10-18 03:47–03:53Z, end-of-retail local
 * ACE: Claude Bulwark, leaving the Glenden Wood shop (landblock 0xA1A4,
 * building 0x01000A2B at local (129.5, 135.6)) by its west door #7A1A400A,
 * was seen "almost entirely underground": stall 1 at local (125.3, 135.6)
 * z 48.08 in cell 0xA1A40120, then z 47.96, z 46.04 and cell 0xA1A4011F, and
 * no walk out until he recalled.
 *
 * The shop's cellar (cells 0x11E, 0x11F, 0x120; floors z 46.04–47.0, ceilings
 * z 49.84) lies mostly OUTSIDE the house: under the open yard west of it
 * (terrain z 50.0), the door #7A1A400A at (129.0, 127.0) opening onto it.
 * outdoorGroundY's cell rule (BUG.holtburg-statue-tunnel-wall: a cell's floor
 * under the terrain is the ground) asked only whether the FLOOR lies in a cell,
 * so a body walking on the grass there had the cellar floor 4 m down for its
 * ground: it fell through the terrain, carried on under the house wall, and
 * landed on the crate stack (statics 0x020000A5, top z 48.09) under the shop
 * floor. Retail reaches an EnvCell from the landscape only through a
 * building's portals (CSortCell::find_transit_cells @ 00534080 →
 * CBuildingObj::find_building_transit_cells @ 006b52a0), and the cellar has
 * none: ACE's own physics (tools/ace-physics-harness/run.sh walk A1A4 119 128
 * 125.3 135.6) walks the same line on the terrain in land cell 0xA1A4002E at
 * z 50.01 until the house's wall stops it at (123.63, 133.58), and (121, 131)
 * → (126, 131.5) all the way at z 50.01. The rule now also needs the body to
 * be in a cell where it stands.
 *
 * Behavioural: the shipped outdoorGroundY, DungeonCollision and
 * stepPlayerMovement over the real cell DAT (tests/_harness/a9b4-world.ts
 * buildLandblockWorld), with main.ts's frame order for the vertical
 * (traceGroundAlongPath → losesContact → advanceAirborneFrame). The same house
 * and cellar are in the Dark Majesty and 1999 DATs; those run when present.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { outdoorGroundY, traceGroundAlongPath, floorSearchFromY, type OutdoorGroundSources } from '../packages/renderer/src/world/outdoorGround.js';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.js';
import { losesContact, advanceAirborneFrame, airborneReferenceY } from '../packages/renderer/src/world/fallPhysics.js';
import type { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { DAT_PATHS } from './_harness/dat.js';

describe('outdoorGroundY — a cell floor under the terrain needs the body in a cell', () => {
  const CELLAR = 0xa1a40120;
  /** Terrain 50; one floor at 46.04 inside the cellar (cell up to 49.84); the body's cell by its feet height. */
  const yard = (floor: number | null): OutdoorGroundSources => ({
    terrainHeight: () => 50,
    floorHeight: () => floor,
    cellAt: (_x, _z, footY) => (footY < 49.84 ? CELLAR : 0),
  });

  it('a body on the grass over the cellar stands on the grass', () => {
    expect(outdoorGroundY(yard(46.04), 0, 0, 50)).toBe(50);
  });

  it('a body in the cellar stands on its floor', () => {
    expect(outdoorGroundY(yard(46.04), 0, 0, 46.04)).toBe(46.04);
    // A teleport / login arrival there (the search starts at the arrival height).
    expect(outdoorGroundY(yard(46.04), 0, 0, 46.1)).toBe(46.04);
  });

  it('a BSP floor at or over the terrain is unchanged', () => {
    expect(outdoorGroundY(yard(50.04), 0, 0, 50)).toBe(50.04);
    expect(outdoorGroundY(yard(null), 0, 0, 50)).toBe(50);
  });
});

const REPO = resolve(__dirname, '..');
const ERAS: { name: string; dats?: { portal: string; cell: string; ac1999?: boolean } }[] = [
  { name: 'end of retail' },
  { name: 'Dark Majesty', dats: { portal: resolve(REPO, 'dat-sets/classic-dereth-1.1/client_portal.dat'), cell: resolve(REPO, 'dat-sets/classic-dereth-1.1/client_cell_1.dat') } },
  { name: 'AC1999', dats: { portal: resolve(REPO, 'dat-sets/ac1999-retail/portal.dat'), cell: resolve(REPO, 'dat-sets/ac1999-retail/cell.dat'), ac1999: true } },
];
const present = (e: (typeof ERAS)[number]) => (e.dats ? existsSync(e.dats.portal) && existsSync(e.dats.cell) : existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell));

const BX = 0xa1, BY = 0xa4;
const OX = BX * 192, OY = BY * 192;
const SHOP_FLOOR = 50.04;
const TERRAIN = 50;

for (const era of ERAS) {
  describe.skipIf(!present(era))(`BUG.building-floor-sink-a1a4 — the Glenden Wood shop's yard over its cellar (${era.name} DATs)`, () => {
    let services: MovementServices;
    let dc: DungeonCollision;
    let probeGround: OutdoorGroundSources;
    let bodyGround: OutdoorGroundSources;

    beforeAll(async () => {
      const { buildLandblockWorld } = await import('./_harness/a9b4-world.js');
      services = (await buildLandblockWorld(BX, BY, { interiors: true, dats: era.dats }))({ slidingNormal: null });
      dc = services.outdoorCollision as DungeonCollision;
      // main.ts outdoorGroundSources / playerGroundSources.
      const cellAt = (x: number, z: number, footY: number) => dc.findCellContaining(x, z, footY + dc.lowerSphereHeight, 0);
      probeGround = { terrainHeight: (x, z) => services.terrain.getHeightAt(x, z), floorHeight: (x, z, y) => dc.getFloorHeight(x, z, y), cellAt };
      bodyGround = { ...probeGround, floorHeight: (x, z, y) => dc.getBodyFloorHeight(x, z, y, services.stepDownHeight) };
      (services as { groundAt?: MovementServices['groundAt'] }).groundAt = (x, z, y) => outdoorGroundY(probeGround, x, z, y);
    }, 180_000);

    /**
     * Run toward each local waypoint in turn at `speed` m/s, `chunks` physics
     * chunks of `dt` per frame, as main.ts's frame loop moves and follows the
     * floor (no creatures). Returns every frame's feet height, position and cell.
     */
    function walk(x0: number, y0: number, legs: [number, number][], opts: { speed?: number; dt?: number; chunks?: number; seconds?: number; floor?: number } = {}) {
      const { speed = 4.5, dt = 1 / 60, chunks = 1, seconds = 6 } = opts;
      let x = OX + x0, z = OY + y0;
      let last = opts.floor ?? (outdoorGroundY(bodyGround, x, z, TERRAIN) as number);
      let air = false, base = 0, off = 0, vy = 0, jvx = 0, jvz = 0;
      let prevGrounded: number | null = last;
      services.slide!.slidingNormal = null;
      const frames: { x: number; y: number; feet: number; cell: number }[] = [];
      let leg = 0;
      for (let t = 0; t < seconds && leg < legs.length; t += dt * chunks) {
        const dx = OX + legs[leg][0] - x, dz = OY + legs[leg][1] - z, d = Math.hypot(dx, dz);
        if (d < 0.3) { leg++; continue; }
        const preX = x, preZ = z;
        for (let c = 0; c < chunks; c++) {
          const st = stepPlayerMovement({ x, z, floorY: airborneReferenceY(air, base, off, last), inDungeon: false, airborne: air, jumpVelocityX: jvx, jumpVelocityZ: jvz },
            (dx / d) * speed * dt, (dz / d) * speed * dt, dt, services);
          x = st.x; z = st.z;
        }
        const from = floorSearchFromY(null, airborneReferenceY(air, base, off, last), dc.lastStepUp);
        const g = traceGroundAlongPath((px, pz, fy) => outdoorGroundY(bodyGround, px, pz, fy), preX, preZ, x, z, from, dc.transitionSphereRadius);
        const groundY = g ?? 0;
        last = groundY;
        if (!air && losesContact(prevGrounded, g, services.stepDownHeight)) {
          air = true; base = prevGrounded as number; off = 0; vy = 0;
          jvx = (x - preX) / (dt * chunks); jvz = (z - preZ) / (dt * chunks);
        }
        prevGrounded = air || g === null ? null : groundY;
        if (air) {
          const r = advanceAirborneFrame(base, off, vy, new Array(chunks).fill(dt), groundY, -9.8, {
            riseLimit: (a, b) => dc.riseLimit(x, z, a, b), floorAtHead: (h) => services.groundAt!(x, z, h), height: dc.playerHeight,
          });
          off = r.offsetY; vy = r.velocityY;
          if (r.landed) { air = false; off = 0; vy = 0; jvx = 0; jvz = 0; }
        }
        const feet = air ? base + off : groundY;
        frames.push({ x: x - OX, y: z - OY, feet, cell: dc.findCellContaining(x, z, feet + dc.lowerSphereHeight, 0) });
      }
      return frames;
    }

    it('the yard is open ground over the cellar: no cell where a body on the grass stands, the cellar under it', () => {
      const x = OX + 123.5, z = OY + 134.0;
      expect(services.terrain.getHeightAt(x, z)).toBeCloseTo(TERRAIN, 2);
      expect(dc.findCellContaining(x, z, TERRAIN + dc.lowerSphereHeight)).toBe(0);
      expect(dc.findCellContaining(x, z, 46.5)).toBe(0xa1a40120);
      expect(dc.floorPlanesAt(x, z).map((p) => +p.y.toFixed(2))).toEqual([46.04]);
      // The body's floor search alone finds the cellar floor 4 m down; the ground is the grass.
      expect(dc.getBodyFloorHeight(x, z, TERRAIN, services.stepDownHeight)).toBeCloseTo(46.04, 2);
      expect(outdoorGroundY(bodyGround, x, z, TERRAIN)).toBeCloseTo(TERRAIN, 2);
    });

    it('every spot of the open ground round the shop keeps a body on the grass', () => {
      let yard = 0;
      const sunk: string[] = [];
      for (let lx = 110; lx <= 150; lx += 0.5) for (let ly = 110; ly <= 150; ly += 0.5) {
        const x = OX + lx, z = OY + ly;
        const t = services.terrain.getHeightAt(x, z)!;
        if (dc.findCellContaining(x, z, t + dc.lowerSphereHeight)) continue; // inside the house
        if (dc.floorPlanesAt(x, z).some((p) => p.y < t - 1)) yard++;
        for (const src of [bodyGround, probeGround]) {
          const g = outdoorGroundY(src, x, z, t)!;
          if (g < t - 0.05) sunk.push(`(${lx}, ${ly}) ${g.toFixed(2)}`);
        }
      }
      expect(yard).toBeGreaterThan(300); // ~95 m² of yard over the cellar (375 spots at 0.5 m)
      expect(sunk).toEqual([]);
    });

      it('walking out of the west door #7A1A400A onto the yard stays on the grass', () => {
      // From inside the jeweler's room (0x11A, floor 50.04) out through the doorway and across the yard over the cellar.
      const f = walk(130.1, 125.9, [[129.0, 127.0], [128.0, 128.1], [126.5, 129.5], [124.5, 131.0]], { floor: SHOP_FLOOR });
      expect(Math.min(...f.map((s) => s.feet))).toBeGreaterThan(TERRAIN - 0.05);
      expect((f[0].cell & 0xffff)).toBe(0x11a);
      expect(f.every((s) => ![0x11e, 0x11f, 0x120].includes(s.cell & 0xffff))).toBe(true);
      const end = f.at(-1)!;
      expect(Math.hypot(end.x - 124.5, end.y - 131.0)).toBeLessThan(0.5);
      expect(end.cell).toBe(0);
      expect(end.feet).toBeCloseTo(TERRAIN, 1);
    });

    it('Bulwark\'s line across the yard toward (125.3, 135.6) stops at the house wall on the grass, as ACE\'s physics does', () => {
      // Was: lost contact at (120.96, 130.61), fell to the cellar floor, ran on under the wall to (124.69, 135.24).
      for (const opts of [{}, { dt: 0.1, chunks: 3 }, { dt: 0.1, chunks: 10 }]) {
        const f = walk(119, 128, [[125.3, 135.6]], opts);
        expect(Math.min(...f.map((s) => s.feet))).toBeGreaterThan(TERRAIN - 0.05);
        expect(f.every((s) => s.cell === 0)).toBe(true);
        const end = f.at(-1)!;
        // ACE: blocked at (123.63, 133.58), z 50.01, land cell 0xA1A4002E.
        expect(Math.hypot(end.x - 123.63, end.y - 133.58)).toBeLessThan(0.4);
      }
      // ACE walks (121, 131) → (126, 131.5) on the terrain the whole way.
      const across = walk(121, 131, [[126, 131.5]]);
      expect(Math.min(...across.map((s) => s.feet))).toBeGreaterThan(TERRAIN - 0.05);
      expect(Math.hypot(across.at(-1)!.x - 126, across.at(-1)!.y - 131.5)).toBeLessThan(0.5);
    });

    it('the shop floor over the cellar\'s crates still holds a walk (the stall\'s own legs)', () => {
      const f = walk(125.8, 135.3, [[125.3, 135.6], [126.5, 136.2], [127.5, 134.5]], { floor: SHOP_FLOOR });
      expect(f.length).toBeGreaterThan(10);
      for (const s of f) expect(s.feet).toBeCloseTo(SHOP_FLOOR, 2);
      expect(f.every((s) => (s.cell & 0xffff) === 0x116)).toBe(true);
    });

    it('a body in the cellar keeps the cellar floor (the rule still holds where the body is in the cell)', () => {
      // Under the yard at (123.5, 134.0): the cellar floor, walking the strip toward the house.
      expect(outdoorGroundY(bodyGround, OX + 123.5, OY + 134.0, 46.04)).toBeCloseTo(46.04, 2);
      const f = walk(123.0, 133.4, [[124.2, 134.4]], { floor: 46.04 });
      expect(f.length).toBeGreaterThan(5);
      for (const s of f) expect(s.feet).toBeCloseTo(46.04, 2);
      expect(f.every((s) => (s.cell & 0xffff) === 0x120)).toBe(true);
    });
  });
}
