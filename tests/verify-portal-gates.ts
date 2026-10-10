/**
 * CORE.14.b.1 — per-portal doorway-polygon gating for outdoor stab cells.
 *
 * Retail anchor (decompiled EoL client): PView::DrawPortal (@ 005a5ab0)
 * maps each CPortalPoly in the building model's drawing BSP to
 * outdoor_portal_list[portal_index] (the building's CBldPortal), and
 * PView::ConstructView(CBldPortal*, CPolygon*) (@ 005a59a0) draws the
 * portal's stab cells only when (1) the viewer is on the portal's
 * enterable side — portal_side = (~flags>>1)&1 per CBldPortal::UnPack
 * (@ 0053bc40), portal_side==0 (flags bit 0x2 set) requires the POSITIVE
 * side of the polygon plane — and (2) the polygon survives frustum
 * clipping. A building whose doorway faces away draws zero interior cells.
 * Our port is a conservative superset: bounding sphere vs frustum instead
 * of exact clipping, in-plane viewpoints pass, unresolved portals stay
 * always open.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  makeGatePortalPoly,
  buildBuildingGates,
  gateOpen,
  collectDrawingPortalPolys,
  collectBuildingStabCells,
  applySurfaceCellVisibility,
  type BuildingGate,
  type SurfaceView,
  type Vec3,
} from '../packages/renderer/src/world/buildingCells.js';
import { openDat } from './_harness/dat.js';

/** Frustum that accepts everything — isolates the plane-side test. */
const OPEN_FRUSTUM = Array.from({ length: 6 }, () => ({ nx: 0, ny: 0, nz: 1, d: 1e9 }));

function view(viewpoints: Vec3[], frustum = OPEN_FRUSTUM): SurfaceView {
  return { viewpoints, frustum };
}

// A unit doorway square in the x=5 plane. CCW winding seen from +x
// (y then z ascending) → Newell normal +x.
const DOOR_X5: Vec3[] = [
  { x: 5, y: 0, z: 0 },
  { x: 5, y: 2, z: 0 },
  { x: 5, y: 2, z: 3 },
  { x: 5, y: 0, z: 3 },
];

describe('makeGatePortalPoly — winding plane + CBldPortal side flag', () => {
  it('derives the plane from the vertex winding (retail CPolygon::make_plane)', () => {
    const poly = makeGatePortalPoly(DOOR_X5, 0x3)!;
    expect(poly.plane.nx).toBeCloseTo(1, 6);
    expect(poly.plane.ny).toBeCloseTo(0, 6);
    expect(poly.plane.nz).toBeCloseTo(0, 6);
    expect(poly.plane.d).toBeCloseTo(-5, 6);
    // reversed winding flips the normal
    const rev = makeGatePortalPoly([...DOOR_X5].reverse(), 0x3)!;
    expect(rev.plane.nx).toBeCloseTo(-1, 6);
  });

  it('flags bit 0x2 selects the enterable side (portal_side = (~flags>>1)&1)', () => {
    expect(makeGatePortalPoly(DOOR_X5, 0x3)!.requirePositive).toBe(true);  // portal_side 0 → POSITIVE
    expect(makeGatePortalPoly(DOOR_X5, 0x1)!.requirePositive).toBe(false); // portal_side 1 → NEGATIVE
  });

  it('bounding sphere encloses every vertex', () => {
    const poly = makeGatePortalPoly(DOOR_X5, 0x1)!;
    expect(poly.center.x).toBeCloseTo(5, 6);
    expect(poly.center.y).toBeCloseTo(1, 6);
    expect(poly.center.z).toBeCloseTo(1.5, 6);
    for (const v of DOOR_X5) {
      const d = Math.hypot(v.x - poly.center.x, v.y - poly.center.y, v.z - poly.center.z);
      expect(d).toBeLessThanOrEqual(poly.radius + 1e-9);
    }
  });

  it('rejects degenerate polygons (collinear or <3 verts)', () => {
    expect(makeGatePortalPoly([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], 1)).toBeNull();
    expect(makeGatePortalPoly(
      [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }], 1)).toBeNull();
  });
});

describe('gateOpen — retail ConstructView sidedness + frustum, conservative', () => {
  const gatePos: BuildingGate = { cells: [0x0100], polys: [makeGatePortalPoly(DOOR_X5, 0x3)!] };
  const gateNeg: BuildingGate = { cells: [0x0100], polys: [makeGatePortalPoly(DOOR_X5, 0x1)!] };

  it('wrong-side viewer closes the gate (door faces away → zero interior draws)', () => {
    expect(gateOpen(gatePos, view([{ x: 0, y: 1, z: 1 }]))).toBe(false);  // needs +x side
    expect(gateOpen(gatePos, view([{ x: 9, y: 1, z: 1 }]))).toBe(true);
    expect(gateOpen(gateNeg, view([{ x: 9, y: 1, z: 1 }]))).toBe(false);  // needs -x side
    expect(gateOpen(gateNeg, view([{ x: 0, y: 1, z: 1 }]))).toBe(true);
  });

  it('any viewpoint on the enterable side passes (camera OR player)', () => {
    // camera trailing inside during a door crossing + player already outside
    expect(gateOpen(gatePos, view([{ x: 4, y: 1, z: 1 }, { x: 6, y: 1, z: 1 }]))).toBe(true);
  });

  it('an in-plane viewpoint passes (conservative superset of retail IN_PLANE)', () => {
    expect(gateOpen(gatePos, view([{ x: 5, y: 1, z: 1 }]))).toBe(true);
    expect(gateOpen(gateNeg, view([{ x: 5, y: 1, z: 1 }]))).toBe(true);
  });

  it('sphere fully outside any frustum plane closes the gate', () => {
    const behindCam = [
      // plane x <= 20 half-space fails the doorway at x=5? no — make one that
      // excludes it: inside is x >= 20 (n=+x, d=-20); door sphere at x=5.
      { nx: 1, ny: 0, nz: 0, d: -20 },
      ...OPEN_FRUSTUM.slice(1),
    ];
    expect(gateOpen(gatePos, view([{ x: 9, y: 1, z: 1 }], behindCam))).toBe(false);
    // sphere merely touching the plane keeps it open (radius slack)
    const grazing = [{ nx: 1, ny: 0, nz: 0, d: -6 }, ...OPEN_FRUSTUM.slice(1)];
    expect(gateOpen(gatePos, view([{ x: 9, y: 1, z: 1 }], grazing))).toBe(true);
  });

  it('a gate with no resolved polygon is always open (never hide unproven cells)', () => {
    expect(gateOpen({ cells: [0x0100], polys: [] }, view([{ x: -99, y: 0, z: 0 }]))).toBe(true);
  });
});

describe('buildBuildingGates — per-CBldPortal gates', () => {
  it('one gate per portal: otherCellId + stabList, range-filtered', () => {
    const gates = buildBuildingGates(
      [
        { flags: 3, otherCellId: 0x0100, stabList: [0x0101, 0xffff] },
        { flags: 1, otherCellId: 0x0102, stabList: [] },
      ],
      new Map([[0, [DOOR_X5]]]),
      8,
    );
    expect(gates).toHaveLength(2);
    expect(new Set(gates[0].cells)).toEqual(new Set([0x0100, 0x0101]));
    expect(gates[0].polys).toHaveLength(1);
    expect(gates[0].polys[0].requirePositive).toBe(true);
    expect(gates[1].cells).toEqual([0x0102]);
    expect(gates[1].polys).toHaveLength(0); // unresolved → always open
  });

  it('drops portals with no in-range cells, keeps degenerate polys always-open', () => {
    const gates = buildBuildingGates(
      [
        { flags: 3, otherCellId: 0xffff, stabList: [0x0900] },
        { flags: 3, otherCellId: 0x0100, stabList: [] },
      ],
      new Map([[1, [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }]]]]),
      4,
    );
    expect(gates).toHaveLength(1);
    expect(gates[0].cells).toEqual([0x0100]);
    expect(gates[0].polys).toHaveLength(0);
  });
});

describe('applySurfaceCellVisibility — gated outdoor rule', () => {
  function meshes(indices: number[]) {
    return new Map(indices.map((i) => [i, { visible: true }]));
  }

  it('outdoors: only cells behind an on-screen doorway render', () => {
    const doorA = makeGatePortalPoly(DOOR_X5, 0x3)!;                     // +x enterable
    const doorB = makeGatePortalPoly([...DOOR_X5].reverse(), 0x3)!;      // -x enterable
    const block = {
      meshes: meshes([0x0100, 0x0101, 0x0102]),
      stabSet: new Set([0x0100, 0x0101, 0x0102]),
      gates: [
        { cells: [0x0100, 0x0101], polys: [doorA] },
        { cells: [0x0102], polys: [doorB] },
      ],
    };
    const registry = new Map([[0xa9b4, block]]);
    // viewer east of both doors: A enterable, B faces away
    applySurfaceCellVisibility(registry, -1, new Set(), view([{ x: 9, y: 1, z: 1 }]));
    expect(block.meshes.get(0x0100)!.visible).toBe(true);
    expect(block.meshes.get(0x0101)!.visible).toBe(true);
    expect(block.meshes.get(0x0102)!.visible).toBe(false);
    // viewer west: roles swap
    applySurfaceCellVisibility(registry, -1, new Set(), view([{ x: 0, y: 1, z: 1 }]));
    expect(block.meshes.get(0x0100)!.visible).toBe(false);
    expect(block.meshes.get(0x0102)!.visible).toBe(true);
  });

  it('indoor PVS overrides closed gates in the player block only', () => {
    const door = makeGatePortalPoly(DOOR_X5, 0x3)!;
    const mk = () => ({
      meshes: meshes([0x0100, 0x0101]),
      stabSet: new Set([0x0100, 0x0101]),
      gates: [{ cells: [0x0100, 0x0101], polys: [door] }],
    });
    const home = mk();
    const other = mk();
    const registry = new Map([[0xa9b4, home], [0xacb5, other]]);
    // viewer deep inside (west of the door plane → gate closed)
    applySurfaceCellVisibility(registry, 0xa9b4, new Set([0x0101]), view([{ x: 2, y: 1, z: 1 }]));
    expect(home.meshes.get(0x0101)!.visible).toBe(true);   // PVS
    expect(home.meshes.get(0x0100)!.visible).toBe(false);  // gate closed, not in PVS
    expect(other.meshes.get(0x0101)!.visible).toBe(false); // PVS never leaks
  });

  it('without a view (or without gates) the full stab set draws — pre-gating rule', () => {
    const door = makeGatePortalPoly(DOOR_X5, 0x3)!;
    const gated = {
      meshes: meshes([0x0100]),
      stabSet: new Set([0x0100]),
      gates: [{ cells: [0x0100], polys: [door] }],
    };
    const ungated = { meshes: meshes([0x0100]), stabSet: new Set([0x0100]) };
    const registry = new Map([[0xa9b4, gated], [0xacb5, ungated]]);
    applySurfaceCellVisibility(registry, -1, new Set());
    expect(gated.meshes.get(0x0100)!.visible).toBe(true);
    // and a closed gate hides it once a view arrives; the ungated block keeps stab
    applySurfaceCellVisibility(registry, -1, new Set(), view([{ x: 0, y: 1, z: 1 }]));
    expect(gated.meshes.get(0x0100)!.visible).toBe(false);
    expect(ungated.meshes.get(0x0100)!.visible).toBe(true);
  });
});

// ── DAT-backed: real EoL building doorways ──────────────────────────────
const REPO = resolve(__dirname, '..');
const CELL_DAT = resolve(REPO, 'dat/client_cell_1.dat');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const datPresent = existsSync(CELL_DAT) && existsSync(PORTAL_DAT);

describe.skipIf(!datPresent)('portal gates — EoL cell.dat ground truth (needs DAT files)', () => {
  let cellDb: any, portalDb: any;
  let DatReader: any, LandblockInfo: any, SetupModel: any, GfxObj: any, EnvCell: any, Environment: any;
  let composeFrames: (
    po: Vec3, pq: { w: number; x: number; y: number; z: number },
    co: Vec3, cq: { w: number; x: number; y: number; z: number },
  ) => { origin: Vec3; orientation: { w: number; x: number; y: number; z: number } };
  const IDQ = { w: 1, x: 0, y: 0, z: 0 };

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    ({ DatReader } = await import('../packages/dat-parser/src/DatReader.js'));
    ({ LandblockInfo } = await import('../packages/dat-parser/src/file-types/LandblockInfo.js'));
    ({ SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel.js'));
    ({ GfxObj } = await import('../packages/dat-parser/src/file-types/GfxObj.js'));
    ({ EnvCell } = await import('../packages/dat-parser/src/file-types/EnvCell.js'));
    ({ Environment } = await import('../packages/dat-parser/src/file-types/Environment.js'));
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.js');
    composeFrames = DungeonCollision.composeFrames;
    cellDb = openDat(CELL_DAT);
    portalDb = openDat(PORTAL_DAT);
  });

  /** Same resolution main.ts performs: drawing-BSP portal polys → world verts. */
  function resolveGates(blockId: number) {
    const info = new LandblockInfo(new DatReader(cellDb.getFileData(((blockId << 16) | 0xfffe) >>> 0)!));
    const offX = ((blockId >> 8) & 0xff) * 192;
    const offY = (blockId & 0xff) * 192;
    const gates: BuildingGate[] = [];
    for (const b of info.buildings) {
      const parts: { gfxId: number; frame: { origin: Vec3; orientation: { w: number; x: number; y: number; z: number } } | null }[] = [];
      if (((b.modelId >> 24) & 0xff) === 0x02) {
        const setup = new SetupModel(new DatReader(portalDb.getFileData(b.modelId)!));
        const placement = setup.placementFrames.get(0);
        setup.parts.forEach((p: number, pi: number) =>
          parts.push({ gfxId: p, frame: placement?.frames[pi] ?? null }));
      } else {
        parts.push({ gfxId: b.modelId, frame: null });
      }
      const polysByPortal = new Map<number, Vec3[][]>();
      for (const part of parts) {
        const gd = portalDb.getFileData(part.gfxId);
        if (!gd) continue;
        const gfx = new GfxObj(new DatReader(gd));
        if (!gfx.drawingBSP) continue;
        let origin = b.frame.origin;
        let quat = b.frame.orientation;
        if (part.frame) {
          const c = composeFrames(origin, quat, part.frame.origin, part.frame.orientation);
          origin = c.origin;
          quat = c.orientation;
        }
        for (const ref of collectDrawingPortalPolys(gfx.drawingBSP.rootNode)) {
          if (ref.portalIndex < 0 || ref.portalIndex >= b.portals.length) continue;
          const poly = gfx.polygonMap.get(ref.polygonId);
          if (!poly) continue;
          const verts = poly.vertexIndices.map((vi: number) => {
            const v = gfx.vertexArray!.vertices.get(vi)!;
            const w = composeFrames(origin, quat, v.origin, IDQ).origin;
            return { x: offX + w.x, y: offY + w.y, z: w.z };
          });
          const list = polysByPortal.get(ref.portalIndex);
          if (list) list.push(verts);
          else polysByPortal.set(ref.portalIndex, [verts]);
        }
      }
      gates.push(...buildBuildingGates(b.portals, polysByPortal, info.numCells));
    }
    return { info, gates, offX, offY };
  }

  it('Holtburg 0xA9B4: every portal gate resolves a doorway polygon; union === stablist', () => {
    const { info, gates } = resolveGates(0xa9b4);
    expect(gates.length).toBeGreaterThan(0);
    const union = new Set<number>();
    for (const g of gates) {
      expect(g.polys.length).toBeGreaterThan(0); // every EoL town doorway resolves
      for (const c of g.cells) union.add(c);
    }
    expect(union).toEqual(collectBuildingStabCells(info.buildings, info.numCells));
  });

  it('doorway polys are sane: vertical openings inside the landblock, sub-30m', () => {
    for (const blockId of [0xa9b4, 0xc6a9]) {
      const { gates, offX, offY } = resolveGates(blockId);
      for (const g of gates) {
        for (const p of g.polys) {
          expect(p.radius).toBeGreaterThan(0.2);
          expect(p.radius).toBeLessThan(30);
          expect(p.center.x).toBeGreaterThanOrEqual(offX - 16);
          expect(p.center.x).toBeLessThanOrEqual(offX + 192 + 16);
          expect(p.center.y).toBeGreaterThanOrEqual(offY - 16);
          expect(p.center.y).toBeLessThanOrEqual(offY + 192 + 16);
        }
      }
    }
  });

  it('the enterable side of every doorway is the OUTDOORS (retail sidedness)', () => {
    // For each building portal, the doorway cell's geometry centroid (an
    // interior point) must lie on the NON-enterable side of the portal
    // plane — retail viewers outside the door are on the enterable side.
    let checked = 0;
    for (const blockId of [0xa9b4, 0xc6a9, 0xacb5]) {
      const info = new LandblockInfo(new DatReader(cellDb.getFileData(((blockId << 16) | 0xfffe) >>> 0)!));
      const offX = ((blockId >> 8) & 0xff) * 192;
      const offY = (blockId & 0xff) * 192;
      const { gates } = resolveGates(blockId);
      // rebuild the flat portal list in the same order buildBuildingGates kept
      const flat: { flags: number; otherCellId: number }[] = [];
      for (const b of info.buildings) {
        for (const p of b.portals) {
          const cellSet = collectBuildingStabCells(
            [{ portals: [{ otherCellId: p.otherCellId, stabList: p.stabList }] }], info.numCells);
          if (cellSet.size > 0) flat.push(p);
        }
      }
      expect(flat.length).toBe(gates.length);
      for (let i = 0; i < gates.length; i++) {
        const bp = flat[i];
        if (bp.otherCellId < 0x0100) continue;
        const cd = cellDb.getFileData(((blockId << 16) | bp.otherCellId) >>> 0);
        if (!cd) continue;
        const env = new EnvCell(new DatReader(cd));
        const envData = portalDb.getFileData(env.environmentId);
        if (!envData) continue;
        const cs = new Environment(new DatReader(envData)).cells.get(env.cellStructure);
        if (!cs) continue;
        let cx = 0, cy = 0, cz = 0, n = 0;
        for (const v of cs.vertexArray.vertices.values()) {
          cx += v.origin.x; cy += v.origin.y; cz += v.origin.z; n++;
        }
        const wc = composeFrames(
          env.position.origin, env.position.orientation,
          { x: cx / n, y: cy / n, z: cz / n }, IDQ).origin;
        const interior = { x: offX + wc.x, y: offY + wc.y, z: wc.z };
        for (const poly of gates[i].polys) {
          const dist = poly.plane.nx * interior.x + poly.plane.ny * interior.y
            + poly.plane.nz * interior.z + poly.plane.d;
          const interiorEnterable = poly.requirePositive ? dist > 0 : dist < 0;
          expect(interiorEnterable).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100); // 163 doorways across the three blocks
  });

  it('behavioral: a Holtburg door opens from outside-front and closes from behind', () => {
    const { gates } = resolveGates(0xa9b4);
    let exercised = 0;
    for (const g of gates) {
      if (g.polys.length !== 1) continue;
      const p = g.polys[0];
      const sign = p.requirePositive ? 1 : -1;
      const front = {
        x: p.center.x + sign * 3 * p.plane.nx,
        y: p.center.y + sign * 3 * p.plane.ny,
        z: p.center.z + sign * 3 * p.plane.nz,
      };
      const back = {
        x: p.center.x - sign * 3 * p.plane.nx,
        y: p.center.y - sign * 3 * p.plane.ny,
        z: p.center.z - sign * 3 * p.plane.nz,
      };
      expect(gateOpen(g, view([front]))).toBe(true);
      expect(gateOpen(g, view([back]))).toBe(false);
      exercised++;
    }
    expect(exercised).toBeGreaterThan(20);
  });
});
