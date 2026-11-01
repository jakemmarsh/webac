/**
 * BUG.doorway-pvs-over-terrain — the threshold crossing, frame by frame.
 *
 * Two live reports with the same root (Jake, AC1999 prod, 2026-11-01):
 *  - "as i pass over the threshold of a building doorway, i see a cobblestone
 *    path outside flash in and out";
 *  - at a shop's open counter window, the window's outside corner missing:
 *    grass and the building's underside where the stone should be, the
 *    interior floor showing through.
 * And the Reddit one: stepping out, "a narrow window where I can see through
 * terrain ... to houses below me".
 *
 * Retail decides it all from the VIEWER (the camera): SmartBox::update_viewer
 * @ 00453ce0 carries the viewer sphere from the player's cell to the camera
 * by a CTransition, so a camera trailing back through a doorway (or into a
 * counter-window niche) is in that building cell even with the player
 * outdoors, and the frame is PView::DrawInside from it; a building portal is
 * drawn (its stab cells, and its punch, DrawPortalPolyInternal @ 0059bc90)
 * only from its open side for the viewer (PView::ConstructView(CBldPortal) @
 * 005a59a0 tests Render::FrameCurrent->viewer).
 *
 * Ours had: (1) an outdoor player's viewer always outdoors
 * (ViewerBoom.surfaceViewerCell), so with the player just out of the door and
 * the camera still in the doorway the frame was the outdoor single pass; and
 * (2) the gate tested the player too (any viewpoint on the open side), so in
 * that frame the doorway's punch drew from the closed side: it marked the
 * stencil over the whole doorway (the road overlays seen out of the door
 * skipped there: the cobblestones vanished, and came back a few frames later)
 * and wrote far depth over the terrain behind it (what lies past the hill
 * drew over it). Now the gate takes the camera alone and the camera's cell
 * decides the frame.
 *
 * The sweep walks a player out of a real doorway (and past the 1999 counter
 * window) in 5 cm steps with a trailing camera, and runs the shipped
 * decisions per frame: the viewer cell (surfaceViewerCell), the doorway's
 * gate / punch (buildBuildingGates + gateOpen on the building's real
 * drawing-BSP portal polygons, resolveBuildingGatePolys), and the indoor flood.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { EnvCellFlags } from '../packages/dat-parser/src/file-types/EnvCell.js';
import { LandblockInfo } from '../packages/dat-parser/src/file-types/LandblockInfo.js';
import { buildBuildingGates, gateOpen, type BuildingGate, type SurfaceView } from '../packages/renderer/src/world/buildingCells.js';
import { resolveBuildingGatePolys } from '../packages/renderer/src/world/LandblockObjectStreamer.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { surfaceViewerCell } from '../packages/renderer/src/scene/ViewerBoom.js';
import { cameraGateView, cellPortalGraph, floodIndoorView, type CellPortalView } from '../packages/renderer/src/scene/IndoorView.js';
import { mirrorCameraX } from '../packages/renderer/src/scene/WorldMirror.js';

const REPO = resolve(__dirname, '..');

interface World {
  block: number;
  info: LandblockInfo;
  collision: DungeonCollision;
  seenOutside: Set<number>;
  graph: Map<number, CellPortalView[]>;
  pvs: Map<number, Set<number>>;
  gates: BuildingGate[][];
}

async function loadWorld(portal: string, cell: string, ac1999: boolean, block: number): Promise<World> {
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
  const smr = new SetupModelRenderer(portalDb, mr);
  const env = new EnvCellRenderer(portalDb, cellDb, mf, smr, mr);
  const prefix = (block << 16) >>> 0;
  const info = new LandblockInfo(new DatReader(cellDb.getFileData((prefix | 0xfffe) >>> 0)!));
  const ids: number[] = [];
  for (let i = 0x100; i < 0x100 + info.numCells; i++) ids.push((prefix | i) >>> 0);
  const w: World = {
    block, info, collision: new DungeonCollision(), seenOutside: new Set(), pvs: new Map(),
    graph: cellPortalGraph(ids, (id) => env.getCellCollisionData(id))!, gates: [],
  };
  for (const id of ids) {
    const e = env.loadEnvCell(id)!;
    if (e.flags & EnvCellFlags.SeenOutside) w.seenOutside.add(id >>> 0);
    w.pvs.set(id & 0xffff, new Set([id & 0xffff, ...e.visibleCells]));
    const d = env.getCellCollisionData(id)!;
    w.collision.addCell(id, d.cellStruct, d.position, d.outsidePortalPolygonIds, d.neighborCellIds);
  }
  const ox = ((block >>> 8) & 0xff) * 192, oy = (block & 0xff) * 192;
  const deps = { setupModels: smr, models: mr, warn: { warn: () => {} } };
  for (const b of info.buildings) {
    const { gatePolys } = resolveBuildingGatePolys(b, ox, oy, deps as never);
    w.gates.push(buildBuildingGates(b.portals, gatePolys, info.numCells));
  }
  return w;
}

const centre = (p: CellPortalView) => p.verts.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / p.verts.length);

/** The gate's view: main.ts's (cameraGateView, the camera alone), or the old one with the player added. */
function gateView(cam: THREE.PerspectiveCamera, player?: THREE.Vector3): SurfaceView {
  const v = cameraGateView(cam, { viewpoints: [], frustum: [] });
  if (player) v.viewpoints.push({ x: player.x, y: player.z, z: player.y });
  return v;
}

/** The camera is on the closed side of every polygon of the gate (retail's ConstructView refuses it). */
function closedSide(gate: BuildingGate, eye: THREE.Vector3): boolean {
  return gate.polys.every((p) => {
    const d = p.plane.nx * eye.x + p.plane.ny * eye.z + p.plane.nz * eye.y + p.plane.d;
    return p.requirePositive ? d < -0.0002 : d > 0.0002;
  });
}

interface Frame {
  playerCell: number; viewerCell: number; cameraInside: boolean;
  /** The opening's punch / stab cells drawn by the gate rule (now: camera alone; before: camera or player). */
  punch: boolean; punchBefore: boolean; closed: boolean;
  /** The frame draws from a building cell (renderIndoorView); before the fix only with the player in one. */
  indoor: boolean; indoorBefore: boolean;
  reached: number[];
}

/**
 * The player walks from `inside` out through the opening to 3 m past it, 5 cm a frame, facing out; the
 * camera trails `boom` m behind and 0.6 m up, looking at the player's head.
 */
function walkOut(w: World, doorway: number, boom: number): Frame[] {
  const ps = w.graph.get(doorway)!;
  const out = ps.find((p) => p.other === 0xffff)!;
  const inner = ps.find((p) => p.other !== 0xffff)!;
  const a = centre(inner), b = centre(out);
  const dir = b.clone().sub(a).setY(0).normalize();
  const floorY = Math.min(...out.verts.map((v) => v.y));
  const start = a.clone().addScaledVector(dir, -1.2).setY(floorY + 0.05);
  const frames: Frame[] = [];
  const gate = gateOf(w, doorway);
  for (let s = 0; s <= 6; s += 0.05) {
    const feet = start.clone().addScaledVector(dir, s);
    const head = feet.clone().setY(feet.y + 1.6);
    frames.push(frame(w, gate, feet, head.clone().addScaledVector(dir, -boom).setY(head.y + 0.6), head));
  }
  return frames;
}

const gateOf = (w: World, cell: number) => w.gates.flat().find((g) => g.cells.includes(cell) && g.polys.length > 0)!;

/** One frame's shipped decisions for a player at `feet` and a camera at `camPos` looking at `target`. */
function frame(w: World, gate: BuildingGate, feet: THREE.Vector3, camPos: THREE.Vector3, target: THREE.Vector3): Frame {
  const land = ((w.block << 16) | 0x0001) >>> 0;
  const cam = mirrorCameraX(new THREE.PerspectiveCamera(90, 2, 0.1, 4000));
  cam.position.copy(camPos);
  cam.lookAt(target);
  cam.updateMatrixWorld();
  const pc = w.collision.findCellContaining(feet.x, feet.z, feet.y + 0.5);
  const world = { collision: w.collision, seenOutside: (id: number) => w.seenOutside.has(id >>> 0) };
  const vc = surfaceViewerCell(world, pc || land, camPos);
  const inCell = (vc & 0xffff) >= 0x100;
  const camCell = w.collision.findCellContaining(camPos.x, camPos.z, camPos.y);
  return {
    playerCell: pc & 0xffff, viewerCell: inCell ? vc & 0xffff : 0, cameraInside: camCell !== 0 && w.seenOutside.has(camCell >>> 0),
    punch: gateOpen(gate, gateView(cam)),
    punchBefore: gateOpen(gate, gateView(cam, feet.clone().setY(feet.y + 0.9))),
    closed: closedSide(gate, camPos),
    indoor: inCell,
    indoorBefore: pc !== 0 && (camCell !== 0 || !w.seenOutside.has(pc >>> 0)),
    reached: inCell ? [...floodIndoorView(vc & 0xffff, new Map([...w.pvs.get(vc & 0xffff)!].map((c) => [c, w.graph.get(c)!])), cam, new Map()).keys()] : [],
  };
}

/** A player standing outside the opening facing it; the camera orbits them (it passes into the opening's cell). */
function orbit(w: World, cell: number): Frame[] {
  const ps = w.graph.get(cell)!;
  const out = ps.find((p) => p.other === 0xffff)!;
  const inner = ps.find((p) => p.other !== 0xffff)!;
  const b = centre(out);
  const dir = b.clone().sub(centre(inner)).setY(0).normalize();
  const floorY = Math.min(...[...w.graph.get(cell)!].flatMap((p) => p.verts.map((v) => v.y)));
  const feet = b.clone().addScaledVector(dir, 0.7).setY(floorY);
  const head = feet.clone().setY(feet.y + 1.6);
  const gate = gateOf(w, cell);
  const frames: Frame[] = [];
  for (let yaw = 0; yaw < 360; yaw += 5) {
    for (const r of [0.8, 1.5, 2.5]) {
      for (const up of [-0.4, 0, 0.5]) {
        const a = (yaw * Math.PI) / 180;
        const camPos = head.clone().add(new THREE.Vector3(Math.cos(a) * r, up, Math.sin(a) * r));
        frames.push(frame(w, gate, feet, camPos, head));
      }
    }
  }
  return frames;
}

interface Case { era: string; portal: string; cell: string; ac1999: boolean; block: number; doorway: number; cellar: number[]; walk: 'out' | 'orbit' }
const CASES: Case[] = [
  { era: 'end of retail', portal: 'dat/client_portal.dat', cell: 'dat/client_cell_1.dat', ac1999: false, block: 0xa9b4, doorway: 0x145, cellar: [0x147, 0x148, 0x149], walk: 'out' },
  { era: 'Dark Majesty', portal: 'dat/sets/classic-dereth/client_portal.dat', cell: 'dat/sets/classic-dereth/client_cell_1.dat', ac1999: false, block: 0xa9b4, doorway: 0x145, cellar: [0x147, 0x148, 0x149], walk: 'out' },
  { era: 'AC1999', portal: 'dat-sets/ac1999-retail/portal.dat', cell: 'dat-sets/ac1999-retail/cell.dat', ac1999: true, block: 0xa9b4, doorway: 0x145, cellar: [0x147, 0x148, 0x149], walk: 'out' },
  // The counter window: Holtburg house 0x127-0x137 (model 0x01000827), niche 0x129, opening z 67-68.5 over a 66 floor.
  { era: 'AC1999 counter window', portal: 'dat-sets/ac1999-retail/portal.dat', cell: 'dat-sets/ac1999-retail/cell.dat', ac1999: true, block: 0xa9b4, doorway: 0x129, cellar: [], walk: 'orbit' },
  { era: 'end of retail counter window', portal: 'dat/client_portal.dat', cell: 'dat/client_cell_1.dat', ac1999: false, block: 0xa9b4, doorway: 0x129, cellar: [], walk: 'orbit' },
];

/** The invariants every frame keeps. */
function checkFrames(frames: Frame[], cellar: number[]): void {
  for (const [i, f] of frames.entries()) {
    // A camera inside a building cell draws from it (retail's viewer cell), wherever the player is.
    expect(f.indoor, `frame ${i}`).toBe(f.cameraInside);
    // The punch (its overlay mask and depth erase) never from the opening's closed side.
    if (f.closed) expect(f.punch, `frame ${i}`).toBe(false);
    for (const x of cellar) expect(f.reached.includes(x), `frame ${i}: 0x${x.toString(16)}`).toBe(false);
  }
}

for (const c of CASES) {
  const have = existsSync(resolve(REPO, c.portal)) && existsSync(resolve(REPO, c.cell));
  describe.skipIf(!have)(`BUG.doorway-pvs-over-terrain threshold — ${c.era}, Holtburg 0xA9B4 0x${c.doorway.toString(16)}`, () => {
    let w: World;
    let all: Frame[] = [];
    beforeAll(async () => { w = await loadWorld(c.portal, c.cell, c.ac1999, c.block); }, 120_000);

    if (c.walk === 'out') {
      for (const boom of [1.0, 2.5]) {
        it(`walking out, boom ${boom} m, 5 cm a frame: punched only from outside, drawn from the camera's cell, one switch`, () => {
          const frames = walkOut(w, c.doorway, boom);
          all.push(...frames);
          expect(frames[0].cameraInside).toBe(true);
          expect(frames[frames.length - 1].cameraInside).toBe(false);
          checkFrames(frames, c.cellar);
          let switches = 0;
          for (let i = 1; i < frames.length; i++) if (frames[i].indoor !== frames[i - 1].indoor) switches++;
          expect(switches).toBe(1);
          // The camera is inside after the player is out: those frames are the reported window.
          expect(frames.some((f) => f.cameraInside && f.playerCell === 0)).toBe(true);
        });
      }
    } else {
      it('orbiting a player at the window: punched only from outside; a camera in the niche draws from it', () => {
        const frames = orbit(w, c.doorway);
        all.push(...frames);
        expect(frames.some((f) => f.cameraInside)).toBe(true);
        expect(frames.some((f) => f.punch)).toBe(true);
        checkFrames(frames, c.cellar);
      });
    }

    it('before: the old rules punched from the closed side, or drew a camera inside as outdoors', () => {
      if (all.length === 0) all = c.walk === 'out' ? [...walkOut(w, c.doorway, 1.0), ...walkOut(w, c.doorway, 2.5)] : orbit(w, c.doorway);
      const punchedClosed = all.filter((f) => f.closed && f.punchBefore).length;
      const outdoorInside = all.filter((f) => f.cameraInside && !f.indoorBefore).length;
      if (process.env.ACJS_SWEEP_PRINT === '1') {
        process.stderr.write(`[threshold] ${c.era} 0x${c.doorway.toString(16)}: ${all.length} frames; before: punched from the closed side ${punchedClosed}, camera inside drawn as outdoors ${outdoorInside}; now: ${all.filter((f) => f.closed && f.punch).length} / ${all.filter((f) => f.cameraInside && !f.indoor).length}\n`);
      }
      expect(punchedClosed + outdoorInside).toBeGreaterThan(0);
    });
  });
}
