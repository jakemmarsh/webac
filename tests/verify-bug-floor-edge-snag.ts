/**
 * BUG.floor-edge-snag (2026-11-08) — a walk stopped dead on open floor at an edge lying in the floor's plane.
 *
 * Found by the jump-planner work (348da4479): in Mountain Keep (end of retail, 0x01D2) a walk from (70, −65) in the
 * corridor 0x01D20294 toward (66.52, −50) stopped at (68.81, −55.02) or (68.34, −55.02), at the doorway into the room
 * 0x0293, while the same walk with its heading 0.0005 rad different got through. 0x0293's floor (z 0) is a portal
 * over three cells below; one, 0x01D201D0, has a ceiling of two faces sloping down from the floor's plane, whose top
 * edges run along y −55 and y −45 at z 0, under the doorway and across the walkway beyond.
 *
 * Cause: our body stands with its feet sphere's centre lowerSphereHeight (0.475) over the floor, and the movement
 * test put the sphere (radius 0.48) there, 4.8 mm into the floor's plane past F_EPSILON. A step north moves into
 * the ceiling face (movement · N < 0), and CPolygon::pos_hits_sphere's precise test reached its top edge whenever
 * the body's centre was within 6.8 cm of it: the step was refused, the slide along that face refused too, and the
 * step up only now and then got the body over, by the heading. On the walkway beyond, the y −45 edge threw fast
 * walks past the edge slide into the pit (46 of 81 headings at 6.5 m/s fell 6 m).
 *
 * Retail: CPolygon::adjust_sphere_to_plane @ 00538210 rests the feet sphere its full radius off the floor (the body
 * floats 0.48 − 0.475 = 5 mm), so no point at or under the floor's plane is within radius − F_EPSILON of its centre
 * (polygon_hits_sphere_slow_but_sure @ 00538a10): the edge is never met. Not BUG.wall-hairline-step-refused's
 * shape (a vertical jamb at the body's height, which retail meets too). Fix: DungeonCollision's movement tests put
 * the body spheres where retail's are (restFloat).
 *
 * Both directions: the Mountain Keep walks through the doorway (every heading in the band, its mirror on the east
 * jamb, and back south), the walkway's edge slide, the corridor's walls and the jamb still holding; and in every
 * era's dungeons, every edge lying in a floor's plane with its polygon under the floor is crossed from the floor
 * wherever a body 1 cm higher crosses it (nothing left that snags), while the hairline-wall sweep
 * (verify-wall-hairline-step-retail.ts) pins that no wall lets the body deeper.
 */
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.ts';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.ts';
import type { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.ts';
import { DAT_PATHS, dataPath } from './_harness/dat.ts';
import { ac1999Dats, dungeonNav, type DungeonNav } from './_harness/dungeonNav.ts';
import { liveFramesOver } from './_harness/liveFrames.ts';

const haveEor = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);
type Dats = { portal: DatDatabase; cell: DatDatabase };
const eraSet = (dir: string) => {
  const p = dataPath(`dat-sets/${dir}/client_portal.dat`), c = dataPath(`dat-sets/${dir}/client_cell_1.dat`);
  return { present: existsSync(p) && existsSync(c), open: (): Dats => ({ portal: new DatDatabase(new FileDatBytes(p)), cell: new DatDatabase(new FileDatBytes(c)) }) };
};
const DM = eraSet('classicace-customdm-1.60');
const have1999 = existsSync(dataPath('dat-sets/ac1999-retail/portal.dat')) && existsSync(dataPath('dat-sets/ac1999-retail/cell.dat'));

const MK = 0x01d20000;
const BX = 0x01 * 192, BY = 0xd2 * 192;
const START = { x: 70, y: -65, z: 0 };
const WALK = 3.12;

function walkToward(nav: DungeonNav, from: { x: number; y: number; z: number }, heading: number, speed: number, seconds: number) {
  return liveFramesOver(nav, MK, from, { walk: { vx: speed * Math.cos(heading), vy: speed * Math.sin(heading) }, seconds });
}

describe.skipIf(!haveEor)('Mountain Keep 0x01D2 (end of retail): the doorway 0x0294 → 0x0293 over 0x01D201D0', () => {
  let nav: DungeonNav;
  beforeAll(async () => { nav = await dungeonNav(MK, { statics: true }); }, 120_000);

  it('the reported walk, at every heading within ±0.02 rad, goes through the doorway (none held at y −55)', () => {
    const base = Math.atan2(-50 - START.y, 66.52 - START.x);
    const held: string[] = [];
    for (let k = -40; k <= 40; k++) {
      const r = walkToward(nav, START, base + k * 0.0005, WALK, 5);
      if (r.y < -53 || Math.abs(r.z) > 0.01) held.push(`${k}: (${r.x.toFixed(2)}, ${r.y.toFixed(2)}, ${r.z.toFixed(2)})`);
    }
    expect(held).toEqual([]);
  }, 120_000);

  it('the mirror walk along the east wall, and the walk back south out of 0x0293, go through as well', () => {
    const east = Math.atan2(-50 - START.y, 73.48 - START.x);
    const south = Math.atan2(-65 - -50, 70 - 69);
    const held: string[] = [];
    for (let k = -20; k <= 20; k++) {
      const a = walkToward(nav, START, east + k * 0.001, WALK, 5);
      if (a.y < -53 || Math.abs(a.z) > 0.01) held.push(`east ${k}: (${a.x.toFixed(2)}, ${a.y.toFixed(2)})`);
      const b = walkToward(nav, { x: 69, y: -50, z: 0 }, south + k * 0.001, WALK, 4);
      if (b.y > -58 || Math.abs(b.z) > 0.01) held.push(`south ${k}: (${b.x.toFixed(2)}, ${b.y.toFixed(2)})`);
    }
    expect(held).toEqual([]);
  }, 120_000);

  it('where the walk stopped, a step north on the floor is taken whole, as 1 cm higher it always was', () => {
    const col = nav.col;
    col.setBodyCell(0x01d20294);
    for (const x of [68.81, 69.5, 70.5]) {
      for (const y of [-55.06, -55.02, -54.98]) {
        expect(col.getAdjustedMovement(new THREE.Vector3(BX + x, 0, BY + y), 0, 0.0507)).toEqual([0, 0.0507]);
        expect(col.getAdjustedMovement(new THREE.Vector3(BX + x, 0.01, BY + y), 0, 0.0507)).toEqual([0, 0.0507]);
      }
    }
    col.setBodyCell(0);
  });

  it('a run on to the walkway beyond is held on it by the edge slide across the y −45 seam (none falls into the pit)', () => {
    // Before the fix the y −45 edge's hit took a step up, which skips the precipice rule: 46 of 81 headings at
    // 6.5 m/s ran off the walkway's west edge at the seam and fell 6 m. A few headings still stop at that seam
    // (BUG.ledge-seam-edge-slide-stall: the edge slide at a triangulated floor's diagonal), but on the walkway.
    const base = Math.atan2(-50 - START.y, 66.52 - START.x);
    const fell: string[] = [];
    for (let k = -40; k <= 40; k += 4) {
      for (const speed of [4.5, 6.5]) {
        const r = walkToward(nav, START, base + k * 0.0005, speed, 6);
        if (r.z < -0.01 || r.x < 68.0) fell.push(`${speed} ${k}: (${r.x.toFixed(2)}, ${r.y.toFixed(2)}, ${r.z.toFixed(2)})`);
      }
    }
    expect(fell).toEqual([]);
  }, 120_000);

  it('the corridor\'s walls and the doorway\'s jambs still hold a walk into them', () => {
    // West and east into the corridor's walls (planes x 68.33 / 71.67), and north-west / north-east at the jambs.
    for (const [h, check] of [
      [Math.PI, (r: { x: number }) => r.x > 68.33 + 0.47],
      [0, (r: { x: number }) => r.x < 71.67 - 0.47],
    ] as const) {
      const r = walkToward(nav, { x: 70, y: -60, z: 0 }, h, WALK, 2);
      expect(check(r)).toBe(true);
    }
    for (const h of [Math.PI * 0.75, Math.PI * 0.85, Math.PI * 0.25, Math.PI * 0.15]) {
      const frames: { x: number; y: number }[] = [];
      liveFramesOver(nav, MK, { x: 70, y: -57, z: 0 }, { walk: { vx: WALK * Math.cos(h), vy: WALK * Math.sin(h) }, seconds: 3, onFrame: (f) => frames.push(f) });
      // Never inside the jamb's wall while still south of the doorway's plane.
      for (const f of frames) if (f.y < -55 - 0.01) expect(f.x > 68.33 + 0.47 - 0.01 && f.x < 71.67 - 0.47 + 0.01).toBe(true);
    }
  }, 60_000);
});

// ── Every era: edges in a floor's plane, of a polygon under the floor ────────────────────────────────────────────

interface FloorEdge { ax: number; ay: number; bx: number; by: number; z: number }

function quatRotate(q: { w: number; x: number; y: number; z: number }, v: { x: number; y: number; z: number }) {
  const { w, x, y, z } = q;
  const ix = w * v.x + y * v.z - z * v.y, iy = w * v.y + z * v.x - x * v.z, iz = w * v.z + x * v.y - y * v.x, iw = -x * v.x - y * v.y - z * v.z;
  return { x: ix * w - iw * x - iy * z + iz * y, y: iy * w - iw * y - iz * x + ix * z, z: iz * w - iw * z - ix * y + iy * x };
}

/** Every level edge (≥ 0.5 m) of an env cell's non-level physics polygon lying wholly at or under that edge (AC landblock-global). */
function underFloorEdges(col: DungeonCollision): FloorEdge[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cells = (col as any).envCells as Map<number, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const polys = (node: any, acc: Set<any>): Set<any> => {
    if (!node) return acc;
    for (const p of node.polygons ?? []) acc.add(p);
    polys(node.posNode, acc); polys(node.negNode, acc);
    return acc;
  };
  const out: FloorEdge[] = [];
  for (const cell of cells.values()) {
    for (const p of polys(cell.bsp, new Set())) {
      if (Math.abs(quatRotate(cell.quat, p.plane.normal).z) > 0.999) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vs = p.vertices.map((v: any) => { const w = quatRotate(cell.quat, v); return { x: w.x + cell.origin.x + cell.blockOffsetX, y: w.y + cell.origin.y + cell.blockOffsetY, z: w.z + cell.origin.z }; });
      for (let i = 0; i < vs.length; i++) {
        const a = vs[i], b = vs[(i + 1) % vs.length];
        if (Math.abs(a.z - b.z) > 1e-3 || Math.hypot(b.x - a.x, b.y - a.y) < 0.5) continue;
        if (vs.some((v: { z: number }) => v.z > a.z + 1e-3)) continue;
        out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, z: a.z });
      }
    }
  }
  return out;
}

/**
 * At every such edge with a level floor at its height on both sides: a body standing on that floor steps across
 * it (both ways, square and at 45°, from 10 cm short to on the edge); count the steps a body 1 cm higher takes
 * that at the floor are refused or taken only as a step up (the floor-plane snag).
 */
async function floorEdgeSweep(lb: number, dats?: Dats) {
  const nav = await dungeonNav(lb, { dats }); // the cells alone: the edges are theirs
  const col = nav.col;
  const out = { edges: 0, steps: 0, snags: [] as string[] };
  const step = 0.05;
  for (const e of underFloorEdges(col)) {
    const len = Math.hypot(e.bx - e.ax, e.by - e.ay);
    const tx = (e.bx - e.ax) / len, ty = (e.by - e.ay) / len, nx = -ty, ny = tx;
    const mx = (e.ax + e.bx) / 2, my = (e.ay + e.by) / 2;
    const floorAt = (x: number, y: number) => col.getBodyFloorHeight(x, y, e.z + 0.3, nav.stepDown);
    const level = [-0.15, 0.15].every((d) => { const f = floorAt(mx + nx * d, my + ny * d); return f !== null && Math.abs(f - e.z) < 0.002; });
    if (!level) continue;
    const cellOn = (d: number) => col.findCellContaining(mx + nx * d, my + ny * d, e.z + col.lowerSphereHeight);
    const cellId = cellOn(0.15) || cellOn(-0.15);
    if (cellId === 0) continue;
    out.edges++;
    for (const side of [1, -1]) {
      for (const turn of [0, 0.25 * Math.PI, -0.25 * Math.PI]) {
        // Across the edge from side `side`: −side × the normal, turned.
        const c = Math.cos(turn), s = Math.sin(turn);
        const ux = -side * (nx * c - ny * s), uy = -side * (nx * s + ny * c);
        for (const d of [0.1, 0.06, 0.03, 0]) {
          const x = mx + side * nx * d, y = my + side * ny * d;
          col.setBodyCell(col.findCellContaining(x, y, e.z + col.lowerSphereHeight) || cellId);
          const lifted = col.getAdjustedMovement(new THREE.Vector3(x, e.z + 0.01, y), ux * step, uy * step);
          if (Math.hypot(lifted[0], lifted[1]) < step * 0.9) continue; // something else in the way
          out.steps++;
          const at = col.getAdjustedMovement(new THREE.Vector3(x, e.z, y), ux * step, uy * step);
          // Refused, or taken only as a step up (a level floor has nothing to step onto; a step up also skips
          // the edge slide's precipice rule, so it walked bodies off ledges).
          if (Math.hypot(at[0], at[1]) < step * 0.9 || (col.lastStepUp ?? 0) > 0) out.snags.push(`(${(x % 192).toFixed(2)}, ${(y % 192).toFixed(2)}, ${e.z.toFixed(2)}) → (${ux.toFixed(2)}, ${uy.toFixed(2)})`);
        }
      }
    }
  }
  col.setBodyCell(0);
  return out;
}

describe.skipIf(!haveEor)('end of retail: a step across an edge in the floor\'s plane is taken at the floor', () => {
  it('Mountain Keep 0x01D2', async () => {
    const r = await floorEdgeSweep(MK);
    expect(r.edges).toBeGreaterThanOrEqual(10);
    expect(r.snags).toEqual([]);
  }, 240_000);
});

describe.skipIf(!DM.present)('Dark Majesty (ClassicACE CustomDM 1.60): a step across an edge in the floor\'s plane is taken at the floor', () => {
  it('Mountain Keep 0x01D2', async () => {
    const r = await floorEdgeSweep(MK, DM.open());
    expect(r.edges).toBeGreaterThanOrEqual(10);
    expect(r.snags).toEqual([]);
  }, 240_000);
});

describe.skipIf(!have1999)('AC1999: a step across an edge in the floor\'s plane is taken at the floor', () => {
  // Of the 84 AC1999 dungeons in 0x00–0x07xx with such edges (1951 edges), 22 snagged before the fix (1676 of
  // 45368 steps); these two had the most.
  it('the tutorial dungeon 0x017E and 0x0183', async () => {
    const dats = ac1999Dats()!;
    for (const [lb, minEdges] of [[0x017e0000, 10], [0x01830000, 30]] as const) {
      const r = await floorEdgeSweep(lb, dats);
      expect(r.edges).toBeGreaterThanOrEqual(minEdges);
      expect(r.snags).toEqual([]);
    }
  }, 240_000);
});
