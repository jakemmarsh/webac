/**
 * BUG.wall-hairline-step-refused (2026-11-07) — checked, retail. Bulwark's three stalls in Monty's Den (0xA9B20113,
 * 2026-10-17 11:58Z) were not a body pressed a hair into a wall: room 0x0113 has no wall on the plane x 88.5 north of
 * y 89. That stretch is the 5.5 m open portal into the alcove 0xA9B2010B, whose south wall (the plane y 89, x 88.5 to
 * 92.9) ends there in a bare vertical edge: the jamb. A body at x 88.025–88.04 reaches 1–2 cm past the opening's
 * plane, and walking south its sphere meets that edge. Retail refuses those steps too:
 *  - CEnvCell::find_transit_cells @ 0052c820 puts 0x010B in the cell array: CCellStruct::sphere_intersects_cell
 *    (BSPNODE::sphere_intersects_cell_bsp @ 0053c260) tests the sphere at radius + 0.01;
 *  - BSPTREE::find_collisions @ 0053a440 (in contact): BSPNODE::sphere_intersects_poly → CPolygon::pos_hits_sphere
 *    @ 005394f0 (polygon_hits_sphere_slow_but_sure @ 00538a10 at radius − F_EPSILON, movement · N < 0) hits the
 *    wall's edge, and step_sphere_up @ 00539f20 runs with the FACE normal (0, +1, 0), not a radial one;
 *  - CTransition::step_up @ 0050b610 → step_down @ 0050b2a0 ends in a PLACEMENT_INSERT, and BSPLEAF::
 *    sphere_intersects_solid @ 0053d5f0 (CPolygon::hits_sphere) refuses it: the sphere overlaps the wall;
 *  - SPHEREPATH::step_up_slide @ 0050c3b0 → CSphere::slide_sphere @ 00537440: direction = N × contact-plane N =
 *    (1, 0, 0); a south offset projects to nothing, |offset|² < F_EPSILON → COLLIDED_TS.
 * Our DungeonCollision runs the same rule, so the step stays refused (no change). What frees the body is what
 * frees a retail player: a step off the line (west, or a few degrees off south), the agent's sidestep since
 * AGENT.stream-reports-2026-10-17-1207-walk.
 *
 * The sweep blocks pin the opposite worry across all three eras' dungeons: a body that does sit 0.5–4 cm inside a
 * plain wall's contact distance (a server snap or MoveTo can leave one there) still steps off the wall and slides
 * along it, and a step into a wall never takes it deeper.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999CellOverlay, ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { stepPlayerMovement, type MovementServices } from '../packages/renderer/src/player/OutdoorMovement.ts';
import type { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.ts';
import { DAT_PATHS, DAT_SETS_DIR } from './_harness/dat.js';

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
const DM = { portal: resolve(DAT_SETS_DIR, 'classic-dereth-1.1/client_portal.dat'), cell: resolve(DAT_SETS_DIR, 'classic-dereth-1.1/client_cell_1.dat') };
const A99 = { portal: resolve(DAT_SETS_DIR, 'ac1999-retail/portal.dat'), cell: resolve(DAT_SETS_DIR, 'ac1999-retail/cell.dat') };
const haveDm = existsSync(DM.portal) && existsSync(DM.cell);
const have1999 = existsSync(A99.portal) && existsSync(A99.cell);

const BX = 0xa9, BY = 0xb2, OX = BX * 192, OY = BY * 192;
const ROOM = 0xa9b20113, ALCOVE = 0xa9b2010b;
/** The jamb: the end of the alcove's south wall (plane y 89) at x 88.5, landblock-local. */
const JAMB = { x: 88.5, y: 89 };

describe.skipIf(!haveDat)('Monty\'s Den (0xA9B2, end of retail): the alcove jamb Bulwark stood at', () => {
  let base: MovementServices;
  let col: DungeonCollision;
  let groundAt: (x: number, z: number, y: number) => number | null;
  beforeAll(async () => {
    const { buildLandblockWorld } = await import('./_harness/a9b4-world.ts');
    const { outdoorGroundY } = await import('../packages/renderer/src/world/outdoorGround.ts');
    // ACE world landblock_instance: the building's doors (weenie 412, Setup 0x020019FF), as verify-stream-reports-2026-10-17-1207-walk.ts.
    const door = (guid: number, x: number, y: number, w: number, z: number, open: boolean) => ({ guid, worldX: OX + x, worldY: 94, worldZ: OY + y, collisionRadius: 0, setupId: 0x020019ff, quat: { w, x: 0, y: 0, z }, scale: 1, physicsState: open ? 0x1000c : 0x10008 });
    const blockers = [door(0x7a9b2003, 89.01, 87.435, 0.707107, 0.707107, false), door(0x7a9b2004, 88.485, 84.01, 0.707107, -0.707107, false), door(0x7a9b2006, 84, 95.01, 0, -1, true)];
    base = (await buildLandblockWorld(BX, BY, { interiors: true, blockers }))({ slidingNormal: null });
    col = base.outdoorCollision as DungeonCollision;
    col.setBodyCell(ROOM);
    groundAt = (x, z, y) => outdoorGroundY({ terrainHeight: (a, b) => base.terrain.getHeightAt(a, b), floorHeight: (a, b, f) => col.getFloorHeight(a, b, f), cellAt: (a, b, f) => col.findCellContaining(a, b, f + col.lowerSphereHeight) }, x, z, y);
  }, 120_000);

  /** One frame step of the body at landblock-local (x, y) on the room's floor (z 94). */
  const step = (x: number, y: number, dx: number, dy: number) => {
    const r = stepPlayerMovement({ x: OX + x, z: OY + y, floorY: 94, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null }, dx, dy, 1 / 30, { ...base, groundAt, slide: { slidingNormal: null } });
    return { x: r.x - OX, y: r.z - OY, normal: col.collisionNormal };
  };

  it('the room has no wall at x 88.5 north of y 89: that is the open portal into the alcove 0x010B', () => {
    // A body at x 88.03 stands in the room, and the east side of its 0.48 m sphere reaches into the alcove.
    expect(col.findCellContaining(OX + 88.03, OY + 89.25, 94.5)).toBe(ROOM);
    expect(col.findCellContaining(OX + 88.505, OY + 89.25, 94.5)).toBe(ALCOVE);
    expect(col.findCellContaining(OX + 88.505, OY + 88.75, 94.5)).not.toBe(ALCOVE);
    // South of y 89 the room's own east wall stops a step east short of contact, as every slide leaves a body.
    const wall = step(88.0, 88.7, 0.133, 0);
    expect(wall.x).toBeLessThanOrEqual(88.5 - 0.4798 + 1e-4);
  });

  it('a body 2.5–4 cm past the opening\'s plane has its frame steps south refused at the jamb, on the wall\'s face normal', () => {
    for (const x of [88.025, 88.03, 88.04]) {
      for (const s of [0.05, 0.133]) {
        const r = step(x, JAMB.y + 0.05 + s, 0, -s);
        expect(r.y, `x ${x}, step ${s}`).toBeCloseTo(JAMB.y + 0.05 + s, 6);
        expect(r.x).toBeCloseTo(x, 6);
        // CSphere::slide_sphere got the alcove wall's face normal (+y here, Three z), not the radial one off the edge.
        expect(r.normal?.x ?? NaN).toBeCloseTo(0, 6);
        expect(r.normal?.z ?? NaN).toBeCloseTo(1, 6);
      }
    }
  });

  it('a body 2 cm further west, or turned a few degrees off south, or stepping west, goes on (what frees a retail player)', () => {
    expect(step(88.0, JAMB.y + 0.1, 0, -0.05).y).toBeCloseTo(JAMB.y + 0.05, 6);
    const yaw = (10 * Math.PI) / 180;
    const off = step(88.03, JAMB.y + 0.1, -Math.sin(yaw) * 0.133, -Math.cos(yaw) * 0.133);
    expect(off.y).toBeLessThan(JAMB.y);
    expect(step(88.03, JAMB.y + 0.05, -0.1, 0).x).toBeCloseTo(87.93, 6);
  });

  it('never through the jamb\'s walls: the alcove\'s south wall holds a step into it', () => {
    const r = step(88.8, JAMB.y + 0.55, 0, -0.133);
    expect(r.y - JAMB.y).toBeGreaterThanOrEqual(0.4798 - 1e-4);
  });
});

/**
 * Every wall face of `lb`'s cells (vertical, 2.2 m tall, 2.4 m wide, standing on a floor) with the body set
 * `delta` inside its contact distance at the face's middle, where a body just outside contact moves along and off
 * the wall. Returns counts of each 0.133 m step's outcome.
 */
async function hairlineSweep(lb: number, dats?: { portal: DatDatabase; cell: DatDatabase }) {
  const { dungeonNav } = await import('./_harness/dungeonNav.ts');
  const nav = await dungeonNav(lb, { statics: true, dats });
  const col = nav.col;
  const sv = (): MovementServices => ({
    dungeonCollision: col, outdoorCollision: col,
    terrain: { getHeightAt: () => null, getTriangleNormalAt: () => null, isWalkable: () => true },
    water: { blockWaterTypeAt: () => null }, creatureObstacles: null, defaultPlayerRadius: col.playerRadius,
    edgeSlide: true, stepDownHeight: nav.stepDown, slide: { slidingNormal: null },
    dungeonGroundAt: (x, z, fromY) => col.getFloorHeight(x, z, fromY, Infinity),
  } as MovementServices);
  const move = (x: number, y: number, floorY: number, dx: number, dy: number) => {
    const r = stepPlayerMovement({ x, z: y, floorY, inDungeon: true, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null }, dx, dy, 1 / 30, sv());
    return { x: r.x, y: r.z, moved: Math.hypot(r.x - x, r.z - y) };
  };
  const contact = 0.48 - 0.0002; // body sphere radius − F_EPSILON (polygon_hits_sphere_slow_but_sure)
  const out = { spots: 0, awayRefused: 0, alongTried: 0, alongRefused: 0, deeper: 0 };
  for (const wf of collectWalls(col)) {
    const s = 0.133;
    const at = (d: number) => ({ x: wf.tx * wf.t + wf.nx * (wf.off + d), y: wf.ty * wf.t + wf.ny * (wf.off + d) });
    const c = at(contact + 0.002);
    const cf = col.getFloorHeight(c.x, c.y, wf.floor + 0.3, 0.6);
    if (cf === null || Math.abs(cf - wf.floor) > 0.05) continue;
    const dirs = [[wf.tx, wf.ty], [-wf.tx, -wf.ty], [wf.nx, wf.ny]];
    if (!dirs.every(([a, b]) => move(c.x, c.y, cf, a * s, b * s).moved > 0.1)) continue;
    out.spots++;
    for (const delta of [0.005, 0.01, 0.02, 0.04]) {
      const p = at(contact - delta);
      if (move(p.x, p.y, cf, wf.nx * s, wf.ny * s).moved < 0.1) out.awayRefused++;
      for (const [a, b] of dirs.slice(0, 2)) {
        out.alongTried++;
        if (move(p.x, p.y, cf, a * s, b * s).moved < 0.1) out.alongRefused++;
      }
      const into = move(p.x, p.y, cf, -wf.nx * s, -wf.ny * s);
      if (into.x * wf.nx + into.y * wf.ny - wf.off < contact - delta - 1e-6) out.deeper++;
    }
  }
  return out;
}

interface WallFace { nx: number; ny: number; tx: number; ty: number; t: number; off: number; floor: number }

function quatRotate(q: { w: number; x: number; y: number; z: number }, v: { x: number; y: number; z: number }) {
  const { w, x, y, z } = q;
  const ix = w * v.x + y * v.z - z * v.y, iy = w * v.y + z * v.x - x * v.z, iz = w * v.z + x * v.y - y * v.x, iw = -x * v.x - y * v.y - z * v.z;
  return { x: ix * w - iw * x - iy * z + iz * y, y: iy * w - iw * y - iz * x + ix * z, z: iz * w - iw * z - ix * y + iy * x };
}

/** The wall faces of every registered env cell (DungeonCollision's private envCells; AC landblock-global, z up). */
function collectWalls(col: DungeonCollision): WallFace[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cells = (col as any).envCells as Map<number, any>;
  const faces: WallFace[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const polys = (node: any, acc: Set<any>): Set<any> => {
    if (!node) return acc;
    for (const p of node.polygons ?? []) acc.add(p);
    polys(node.posNode, acc); polys(node.negNode, acc);
    return acc;
  };
  for (const cell of cells.values()) {
    for (const p of polys(cell.bsp, new Set())) {
      const g = quatRotate(cell.quat, p.plane.normal);
      if (Math.abs(g.z) > 0.01) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vs = p.vertices.map((v: any) => { const w = quatRotate(cell.quat, v); return { x: w.x + cell.origin.x + cell.blockOffsetX, y: w.y + cell.origin.y + cell.blockOffsetY, z: w.z + cell.origin.z }; });
      const zs = vs.map((v: { z: number }) => v.z);
      if (Math.max(...zs) - Math.min(...zs) < 2.2) continue;
      const rx = Math.abs(g.x) < 1e-5 ? 0 : g.x, ry = Math.abs(g.y) < 1e-5 ? 0 : g.y;
      const hl = Math.hypot(rx, ry);
      const nx = rx / hl, ny = ry / hl, tx = -ny, ty = nx;
      const ts = vs.map((v: { x: number; y: number }) => v.x * tx + v.y * ty);
      if (Math.max(...ts) - Math.min(...ts) < 2.4) continue;
      faces.push({ nx, ny, tx, ty, t: (Math.max(...ts) + Math.min(...ts)) / 2, off: vs[0].x * nx + vs[0].y * ny, floor: Math.min(...zs) });
    }
  }
  return faces;
}

describe.skipIf(!haveDat)('a body inside a plain wall\'s contact distance (0.5–4 cm): end of retail, 0x01E0', () => {
  it('steps off the wall and slides along it; a step into it goes no deeper', async () => {
    const r = await hairlineSweep(0x01e00000);
    expect(r.spots).toBeGreaterThan(50);
    expect(r).toMatchObject({ awayRefused: 0, alongRefused: 0, deeper: 0 });
  }, 120_000);
});

describe.skipIf(!haveDm)('a body inside a plain wall\'s contact distance (0.5–4 cm): Dark Majesty, 0x01E0', () => {
  it('steps off the wall and slides along it; a step into it goes no deeper', async () => {
    const dats = { portal: new DatDatabase(new FileDatBytes(DM.portal)), cell: new DatDatabase(new FileDatBytes(DM.cell)) };
    const r = await hairlineSweep(0x01e00000, dats);
    expect(r.spots).toBeGreaterThan(50);
    expect(r).toMatchObject({ awayRefused: 0, alongRefused: 0, deeper: 0 });
  }, 120_000);
});

describe.skipIf(!have1999)('a body inside a plain wall\'s contact distance (0.5–4 cm): AC1999, 0x017E', () => {
  it('steps off the wall and slides along it; a step into it goes no deeper', async () => {
    const portal = new DatDatabase(new FileDatBytes(A99.portal)); portal.setOverlay(ac1999PortalOverlay());
    const cell = new DatDatabase(new FileDatBytes(A99.cell)); cell.setOverlay(ac1999CellOverlay());
    const r = await hairlineSweep(0x017e0000, { portal, cell });
    expect(r.spots).toBeGreaterThan(100);
    expect(r).toMatchObject({ awayRefused: 0, deeper: 0 });
    // The few along-wall refusals are float-noise contacts: a slide whose re-test meets the same 45° face (or a
    // static's back face 1 cm in front of the wall) with movement · N a hair below 0 (~1e-17), which retail's
    // pos_hits_sphere (movement · N < 0, in float32) is as exposed to. Under 3% of the tries.
    expect(r.alongRefused / r.alongTried).toBeLessThan(0.03);
  }, 120_000);
});
