/**
 * BUG.doorway-pvs-over-terrain — the two-sided standing sweep.
 *
 * For camera poses inside every SeenOutside surface cell of real buildings
 * (the indoor view runs only there: main.ts updateIndoorView), each screen
 * sample is labelled three ways:
 *   - retail: PView::ConstructView (CEnvCell) @ 005a57b0 draws cell C at a
 *     pixel only when that pixel's ray crosses the chain of portal polygons
 *     from the viewer's cell to C (each portal looked through from its open
 *     side, PView::InitCell @ 005a4b70; C in the viewer's PVS,
 *     PView::add_views @ 005a5210), and DrawCells @ 005a4840 draws C inside
 *     that clipped view after the depth-only clear. The pixel shows the
 *     nearest surface of those cells; with none, the landscape.
 *   - ours: the cells floodIndoorView reaches whose clip rectangle holds the
 *     pixel (renderIndoorView's scissored cell pass).
 *   - before the fix: every cell of the viewer's PVS, full screen.
 * Two ways to be wrong:
 *   (a) missing: retail shows a cell's surface at a pixel and ours does not;
 *   (b) extra: ours shows a cell's surface at a pixel where retail draws no
 *       such cell (a cellar under the street, a room behind a wall: drawn
 *       over the landscape after the depth clear).
 * (a) must stay 0. (b) is bounded by the rectangle approximation of retail's
 * clip polygons; the standing bound is far below what the old full-PVS draw
 * did on the same poses (counted alongside).
 *
 * `ACJS_SWEEP_FULL=1` runs the wide pose set and prints the counts per case.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { cellPortalGraph, floodIndoorView, type CellPortalView, type PortalGraph } from '../packages/renderer/src/scene/IndoorView.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { mirrorCameraX } from '../packages/renderer/src/scene/WorldMirror.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { EnvCellFlags } from '../packages/dat-parser/src/file-types/EnvCell.js';
import { LandblockInfo } from '../packages/dat-parser/src/file-types/LandblockInfo.js';

const REPO = resolve(__dirname, '..');
const FULL = process.env.ACJS_SWEEP_FULL === '1';
/** A sub-pixel tolerance on a rectangle's edge (NDC; a pixel at 1920 wide is 0.001). */
const EDGE = 1e-4;

interface Block {
  /** Full-id prefix (0xXXYY0000). */
  prefix: number;
  /** Every cell's portals (cellPortalGraph over the block). */
  graph: Map<number, CellPortalView[]>;
  pvs: Map<number, Set<number>>;
  seenOutside: Set<number>;
  collision: DungeonCollision;
  meshes: Map<number, THREE.Object3D>;
}

async function loadBlock(portal: string, cell: string, ac1999: boolean, block: number, only?: (idx: number) => boolean): Promise<Block> {
  const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
  const { FileDatBytes } = await import('../packages/dat-parser/src/node/FileDatBytes.js');
  const { ac1999CellOverlay, ac1999PortalOverlay } = await import('../packages/dat-parser/src/era1999/Ac1999Overlay.js');
  const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
  const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
  const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
  const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
  const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
  const portalDb = new DatDatabase(new FileDatBytes(resolve(REPO, portal)));
  const cellDb = new DatDatabase(new FileDatBytes(resolve(REPO, cell)));
  if (ac1999) { portalDb.setOverlay(ac1999PortalOverlay()); cellDb.setOverlay(ac1999CellOverlay()); }
  const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
  const mr = new ModelRenderer(portalDb, mf);
  const env = new EnvCellRenderer(portalDb, cellDb, mf, new SetupModelRenderer(portalDb, mr), mr);
  const prefix = (block << 16) >>> 0;
  const info = new LandblockInfo(new DatReader(cellDb.getFileData((prefix | 0xfffe) >>> 0)!));
  const ids: number[] = [];
  for (let i = 0x100; i < 0x100 + info.numCells; i++) if (!only || only(i)) ids.push((prefix | i) >>> 0);
  const b: Block = {
    prefix, graph: cellPortalGraph(ids, (id) => env.getCellCollisionData(id))!, pvs: new Map(), seenOutside: new Set(),
    collision: new DungeonCollision(), meshes: new Map(),
  };
  for (const id of ids) {
    const e = env.loadEnvCell(id)!;
    const idx = id & 0xffff;
    b.pvs.set(idx, new Set([idx, ...e.visibleCells]));
    if (e.flags & EnvCellFlags.SeenOutside) b.seenOutside.add(idx);
    const d = env.getCellCollisionData(id)!;
    b.collision.addCell(id, d.cellStruct, d.position, d.outsidePortalPolygonIds, d.neighborCellIds);
    const m = env.createCellMesh(id)!;
    m.updateMatrixWorld(true);
    b.meshes.set(idx, m);
  }
  return b;
}

/** The ray parameter where `ray` crosses a portal polygon, or null (three world coordinates). */
function crossPortal(ray: THREE.Ray, p: CellPortalView, tMin: number): number | null {
  const v = p.verts;
  if (v.length < 3) return null;
  const n = new THREE.Vector3();
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  n.normalize();
  const denom = n.dot(ray.direction);
  if (Math.abs(denom) < 1e-9) return null;
  const t = n.dot(v[0].clone().sub(ray.origin)) / denom;
  if (t < tMin - 1e-6) return null;
  const hit = ray.at(t, new THREE.Vector3());
  // Point in polygon, projected on the plane's dominant axis.
  const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
  const [u, w] = ax >= ay && ax >= az ? ['y', 'z'] as const : ay >= az ? ['x', 'z'] as const : ['x', 'y'] as const;
  let inside = false;
  for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
    const vi = v[i], vj = v[j];
    if ((vi[w] > hit[w]) !== (vj[w] > hit[w]) && hit[u] < ((vj[u] - vi[u]) * (hit[w] - vi[w])) / (vj[w] - vi[w]) + vi[u]) inside = !inside;
  }
  return inside ? t : null;
}

/** Retail's cells at one pixel: those whose portal chain from the viewer's cell the pixel's ray crosses. */
function retailCells(ray: THREE.Ray, viewer: number, graph: PortalGraph, eyeAc: THREE.Vector3): Set<number> {
  const out = new Set<number>([viewer]);
  const walk = (cell: number, t: number, path: Set<number>) => {
    for (const p of graph.get(cell) ?? []) {
      if (p.other === 0xffff || !graph.has(p.other) || path.has(p.other)) continue;
      if (p.plane) {
        const d = p.plane.nx * eyeAc.x + p.plane.ny * eyeAc.y + p.plane.nz * eyeAc.z + p.plane.d;
        if (p.requirePositive ? d < -0.0002 : d > 0.0002) continue;
      }
      const tc = crossPortal(ray, p, t);
      if (tc === null) continue;
      out.add(p.other);
      path.add(p.other);
      walk(p.other, tc, path);
      path.delete(p.other);
    }
  };
  walk(viewer, 0, new Set([viewer]));
  return out;
}

interface Counts {
  poses: number; samples: number;
  /** (a): retail draws the cell showing at the sample, ours does not draw it there. */
  missing: number;
  /** (b): ours shows a cell where retail draws none: any, and those retail draws nowhere in that pose. */
  extra: number; extraUnreached: number;
  /** The same (b) counts for the old full-PVS cell pass. */
  oldExtra: number; oldExtraUnreached: number;
  examples: string[];
  /** extraUnreached by viewer -> cell (printed with ACJS_SWEEP_PRINT=1). */
  byCell: Map<string, number>;
}

function sweepCell(b: Block, viewer: number, counts: Counts, opts: { step: number; yaws: number; pitches: number[]; grid: number }): void {
  const pvs = b.pvs.get(viewer)!;
  const graph: PortalGraph = new Map([...pvs].filter((c) => b.graph.has(c)).map((c) => [c, b.graph.get(c)!]));
  const mesh = b.meshes.get(viewer)!;
  const box = new THREE.Box3().setFromObject(mesh);
  const pvsMeshes = [...pvs].map((c) => b.meshes.get(c)).filter((m): m is THREE.Object3D => !!m);
  const cellOf = (o: THREE.Object3D | null): number => {
    for (; o; o = o.parent) if (o.userData.envCellId !== undefined) return o.userData.envCellId & 0xffff;
    return -1;
  };
  const rc = new THREE.Raycaster();
  rc.near = 0.1;
  const viewerId = (b.prefix | viewer) >>> 0;
  for (let x = box.min.x + opts.step / 2; x < box.max.x; x += opts.step) {
    for (let z = box.min.z + opts.step / 2; z < box.max.z; z += opts.step) {
      for (const h of [1.2, 1.8]) {
        const eye = new THREE.Vector3(x, box.min.y + h, z);
        if (b.collision.findCellContaining(eye.x, eye.z, eye.y, viewerId) !== viewerId) continue;
        const eyeAc = new THREE.Vector3(eye.x, eye.z, eye.y);
        for (let k = 0; k < opts.yaws; k++) {
          const yaw = (k / opts.yaws) * Math.PI * 2;
          for (const pitch of opts.pitches) {
            const cam = mirrorCameraX(new THREE.PerspectiveCamera(90, 2, 0.1, 4000));
            cam.position.copy(eye);
            const pr = (pitch * Math.PI) / 180;
            cam.lookAt(eye.x + Math.cos(yaw) * Math.cos(pr), eye.y + Math.sin(pr), eye.z + Math.sin(yaw) * Math.cos(pr));
            cam.updateMatrixWorld();
            counts.poses++;
            const ours = floodIndoorView(viewer, graph, cam, new Map());
            const truthAll = new Set<number>();
            const extras: number[] = [];
            const oldExtras: number[] = [];
            for (let i = 0; i < opts.grid; i++) for (let j = 0; j < opts.grid; j++) {
              const sx = -0.97 + (1.94 * i) / (opts.grid - 1), sy = -0.97 + (1.94 * j) / (opts.grid - 1);
              rc.setFromCamera(new THREE.Vector2(sx, sy), cam);
              const truth = retailCells(rc.ray, viewer, graph, eyeAc);
              // The scissor pads each rectangle by a pixel (renderIndoorView clipGroup): a sample on its edge is inside.
              const oursAt = (c: number) => { const r = ours.get(c); return !!r && sx >= r.x0 - EDGE && sx <= r.x1 + EDGE && sy >= r.y0 - EDGE && sy <= r.y1 + EDGE; };
              const hits = rc.intersectObjects(pvsMeshes, true);
              const first = (pred: (c: number) => boolean) => { for (const hit of hits) { const c = cellOf(hit.object); if (c >= 0 && pred(c)) return c; } return -1; };
              const retailShows = first((c) => truth.has(c));
              const oursShows = first(oursAt);
              const oldShows = first(() => true);
              counts.samples++;
              for (const t of truth) truthAll.add(t);
              if (retailShows >= 0 && !oursAt(retailShows)) {
                counts.missing++;
                if (counts.examples.length < 6) counts.examples.push(`missing 0x${retailShows.toString(16)} from 0x${viewer.toString(16)} eye ${eye.toArray().map((v) => v.toFixed(2))} yaw ${(yaw * 180 / Math.PI).toFixed(0)} pitch ${pitch} @ (${sx.toFixed(2)}, ${sy.toFixed(2)})`);
              }
              if (oursShows >= 0 && !truth.has(oursShows)) { counts.extra++; extras.push(oursShows); }
              if (oldShows >= 0 && !truth.has(oldShows)) { counts.oldExtra++; oldExtras.push(oldShows); }
            }
            for (const x of extras) if (!truthAll.has(x)) {
              counts.extraUnreached++;
              const k = `0x${viewer.toString(16)}->0x${x.toString(16)}`;
              counts.byCell.set(k, (counts.byCell.get(k) ?? 0) + 1);
            }
            counts.oldExtraUnreached += oldExtras.filter((x) => !truthAll.has(x)).length;
          }
        }
      }
    }
  }
}

interface SweepCase {
  name: string; portal: string; cell: string; ac1999: boolean; block: number;
  /** Restrict the loaded cells (the 0x40D8 cave: its stairs and first rooms). */
  only?: (idx: number) => boolean;
  /** Standing bound on (b) as a share of samples (the rectangles' overreach of retail's clip polygons). */
  maxExtraShare: number;
  /** Holtburg's hillside, the reported block: the old cell pass drew many times more cells retail never draws. */
  reported?: boolean;
}

const CASES: SweepCase[] = [
  // Holtburg's hillside block: 12 houses, cellars (0x147-0x149, 0x174, 0x176), upper floors (0x14E, 0x15E, …).
  { name: 'end of retail, Holtburg 0xA9B4', portal: 'dat/client_portal.dat', cell: 'dat/client_cell_1.dat', ac1999: false, block: 0xa9b4, maxExtraShare: 0.01, reported: true },
  { name: 'end of retail, Holtburg 0xA9B3 (two-storey house)', portal: 'dat/client_portal.dat', cell: 'dat/client_cell_1.dat', ac1999: false, block: 0xa9b3, maxExtraShare: 0.01 },
  { name: 'end of retail, Holtburg 0xAAB3 (tower)', portal: 'dat/client_portal.dat', cell: 'dat/client_cell_1.dat', ac1999: false, block: 0xaab3, maxExtraShare: 0.01 },
  // webac#15's walk-in cave: the hole's stairs and the rooms just past them.
  { name: 'end of retail, the 0x40D8 cave (webac#15)', portal: 'dat/client_portal.dat', cell: 'dat/client_cell_1.dat', ac1999: false, block: 0x40d8, only: (i) => i <= 0x110 || (i >= 0x270 && i <= 0x290), maxExtraShare: 0.01 },
  // Classic Dereth: the same hillside plus three portal bunkers (0x17B-0x17F, 0x180-0x184, 0x185-0x189; building 0x010011C0 family).
  { name: 'Dark Majesty, Holtburg 0xA9B4 (bunkers)', portal: 'dat/sets/classic-dereth/client_portal.dat', cell: 'dat/sets/classic-dereth/client_cell_1.dat', ac1999: false, block: 0xa9b4, maxExtraShare: 0.01, reported: true },
  { name: 'AC1999, Holtburg 0xA9B4', portal: 'dat-sets/ac1999-retail/portal.dat', cell: 'dat-sets/ac1999-retail/cell.dat', ac1999: true, block: 0xa9b4, maxExtraShare: 0.01, reported: true },
];

for (const c of CASES) {
  const have = existsSync(resolve(REPO, c.portal)) && existsSync(resolve(REPO, c.cell));
  describe.skipIf(!have)(`BUG.doorway-pvs-over-terrain two-sided sweep — ${c.name}`, () => {
    let b: Block;
    beforeAll(async () => { b = await loadBlock(c.portal, c.cell, c.ac1999, c.block, c.only); }, 300_000);

    it('(a) nothing retail shows is missing; (b) what retail would not draw stays within the rectangle bound', () => {
      const counts: Counts = { poses: 0, samples: 0, missing: 0, extra: 0, extraUnreached: 0, oldExtra: 0, oldExtraUnreached: 0, examples: [], byCell: new Map() };
      const opts = FULL
        ? { step: 1.2, yaws: 8, pitches: [-35, 0, 25], grid: 7 }
        : { step: 2.0, yaws: 4, pitches: [-25, 0], grid: 5 };
      for (const viewer of b.seenOutside) if (b.graph.has(viewer)) sweepCell(b, viewer, counts, opts);
      if (FULL || process.env.ACJS_SWEEP_PRINT === '1') process.stderr.write(`[sweep] ${c.name}: ${JSON.stringify({ ...counts, examples: undefined, byCell: undefined })}\n  top (b): ${[...counts.byCell].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ')}\n  ${counts.examples.join('\n  ')}\n`);
      expect(counts.poses).toBeGreaterThan(50);
      expect(counts.examples).toEqual([]);
      expect(counts.missing).toBe(0);
      expect(counts.extra / counts.samples).toBeLessThan(c.maxExtraShare);
      // Cells retail draws nowhere in the pose (the cellar under the street): rare, and far below the old
      // full-PVS cell pass on the same poses (the reported bug).
      expect(counts.extraUnreached / counts.samples).toBeLessThan(0.003);
      expect(counts.oldExtraUnreached).toBeGreaterThanOrEqual(counts.extraUnreached);
      if (c.reported) expect(counts.oldExtraUnreached).toBeGreaterThan(counts.extraUnreached * 3);
    }, 600_000);
  });
}
