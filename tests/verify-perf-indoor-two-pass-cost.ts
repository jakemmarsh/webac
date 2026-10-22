/**
 * PERF.indoor-two-pass-cost (2026-10-21). After 622f9ddd9 an indoor frame
 * facing a doorway took 16 ms against 8 ms outdoors (Firefox, Apple Silicon,
 * 120 Hz; the reporter runs a 4-core Windows machine). Measured with
 * tools/bench-indoor-view.ts on a town-sized scene (18.7k objects, a real
 * WebGLRenderer on the stub context, interleaved medians): ordinary frame
 * 4.9 ms, indoor frame 6.9 ms (+42%). The second render() repeated three's
 * scene.updateMatrixWorld (1.4 ms: every unfrozen node) and the pad-light
 * count walked every visible node (0.5 ms).
 *
 * Now (scene/IndoorView.ts renderIndoorView):
 *  - the world matrices update once per indoor frame;
 *  - the pad count comes from the DAT light list (DatLightBudget.forEachLight);
 *  - the landscape backdrop draws only while an outside portal of the
 *    viewer's cells is in view: PView::DrawCells @ 005a4840 draws LScape only
 *    when `outside_view.view_count != 0`, and PView::ClipPortals @ 005a5520
 *    adds a view there only for an outside portal (other_cell_id 0xFFFFFFFF)
 *    whose PView::GetClip @ 005a4320 leaves something on screen.
 * Bench after: 5.0 ms with a doorway in view (+3%), 1.6 ms facing a wall.
 *
 * Driven through a real THREE.WebGLRenderer on the recording stub context
 * (tests/_harness/stubGl.ts), and, per era, through the real EnvCellRenderer
 * on that era's DATs (the cells' outside portals main.ts feeds the gate).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  backdropVisible, nearPlaneInsideCell, outsidePortalPolygons, outsideViewVisible, portalPolygonInFrustum, renderIndoorView,
  type IndoorViewContext, type OutsidePortalCellData, type PortalPolygon,
} from '../packages/renderer/src/scene/IndoorView.js';
import { DatLightBudget } from '../packages/renderer/src/effects/DatLightBudget.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { mirrorCameraX } from '../packages/renderer/src/scene/WorldMirror.js';
import { createStubRenderer, GL_COLOR_BUFFER_BIT, GL_DEPTH_BUFFER_BIT } from './_harness/stubGl.js';

const SHOP = 0x7d640105;
const ctx = (over: Partial<IndoorViewContext> = {}): IndoorViewContext => ({
  blockKey: 0x7d64, cells: new Set([0x105, 0x106]), playerCellId: SHOP, cellAt: () => SHOP, ...over,
});

function datLight(on = true): THREE.PointLight {
  const pl = new THREE.PointLight(0xffc080, 1, 6, 1);
  pl.userData.datLight = true;
  pl.visible = on;
  return pl;
}

/**
 * A shop interior and the street outside: terrain, a door (server object in a
 * land cell) and a lamp post with two DAT lights outdoors; the shop's cell
 * with a sconce light; a walking NPC (unfrozen part tree) outdoors; sun,
 * ambient and viewer light at the top level. Camera at the origin looking
 * down -Z; the shop's doorway polygon is 4 m ahead (`ahead`) or behind.
 */
function shopScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.85, 0.88, 0.95);
  const geo = new THREE.PlaneGeometry(1, 1);
  const mat = new THREE.MeshLambertMaterial();
  const terrain = new THREE.Mesh(geo, mat);
  const door = new THREE.Mesh(geo, mat);
  door.name = 'server_7d64a001_Door';
  door.userData.objCellId = 0x7d640021;
  const lampPost = new THREE.Group();
  lampPost.name = 'setup_02000a3e';
  lampPost.add(new THREE.Mesh(geo, mat), datLight(), datLight());
  const npc = new THREE.Group();
  npc.name = 'server_7d64a002_Guard';
  npc.userData.objCellId = 0x7d640021;
  for (let i = 0; i < 10; i++) { const part = new THREE.Group(); part.add(new THREE.Mesh(geo, mat)); npc.add(part); }
  const cell = new THREE.Group();
  cell.name = 'envcell_7d640105';
  cell.userData.envCellId = SHOP;
  const sconce = new THREE.Group();
  sconce.add(new THREE.Mesh(geo, mat), datLight());
  cell.add(new THREE.Mesh(geo, mat), sconce);
  scene.add(terrain, door, lampPost, npc, cell, new THREE.DirectionalLight(), new THREE.AmbientLight(), new THREE.PointLight());
  for (const o of [terrain, door, cell, npc, lampPost]) o.position.set(0, 0, -5);
  const lights: THREE.Object3D[] = [];
  scene.traverse((o) => { if (o.userData.datLight) lights.push(o); });
  const forEachPointLight: IndoorViewContext['forEachPointLight'] = (visit) => { for (const l of lights) visit(l); };
  return { scene, door, cell, npc, lampPost, forEachPointLight };
}

const doorway = (z: number): PortalPolygon => [
  new THREE.Vector3(-1, -1, z), new THREE.Vector3(1, -1, z), new THREE.Vector3(1, 2, z), new THREE.Vector3(-1, 2, z),
];
const ahead = doorway(-4);
const behind = doorway(4);

function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  cam.updateMatrixWorld();
  return cam;
}

const pointLightsSeen = (scene: THREE.Scene) => {
  let n = 0;
  scene.traverseVisible((x) => { if ((x as THREE.PointLight).isPointLight) n++; });
  return n;
};

afterEach(() => { vi.restoreAllMocks(); });

describe('PERF.indoor-two-pass-cost — the scene graph is walked once per indoor frame', () => {
  it('an indoor frame updates world matrices on no more nodes than an ordinary frame (was twice)', () => {
    const spy = vi.spyOn(THREE.Object3D.prototype, 'updateMatrixWorld');
    const { renderer } = createStubRenderer();
    const s = shopScene();
    const cam = camera();
    // A first indoor frame adds its pad lights (top-level nodes the ordinary frame then walks too).
    renderIndoorView(renderer, s.scene, cam, ctx({ outsidePortals: [ahead], forEachPointLight: s.forEachPointLight }));
    spy.mockClear();
    renderer.render(s.scene, cam);
    const ordinary = spy.mock.calls.length;
    spy.mockClear();
    renderIndoorView(renderer, s.scene, cam, ctx({ outsidePortals: [ahead], forEachPointLight: s.forEachPointLight }));
    expect(ordinary).toBeGreaterThan(10);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(ordinary);
    // The scene's own flag is back for the next ordinary frame.
    expect(s.scene.matrixWorldAutoUpdate).toBe(true);
  });

  it('both passes draw with this frame\'s matrices: an object moved before the frame is drawn where it now is', () => {
    const { renderer } = createStubRenderer();
    const s = shopScene();
    const cam = camera();
    renderIndoorView(renderer, s.scene, cam, ctx({ outsidePortals: [ahead] }));
    s.npc.position.set(0, 0, -7);
    const sconceMesh = s.cell.children[1].children[0] as THREE.Mesh;
    s.cell.children[1].position.set(0.5, 0, 0);
    let npcZ = NaN;
    let sconceX = NaN;
    (s.npc.children[0].children[0] as THREE.Mesh).onBeforeRender = (_r, _s, _c, _g, _m) => { npcZ = s.npc.children[0].children[0].matrixWorld.elements[14]; };
    sconceMesh.onBeforeRender = () => { sconceX = sconceMesh.matrixWorld.elements[12]; };
    renderIndoorView(renderer, s.scene, cam, ctx({ outsidePortals: [ahead] }));
    expect(npcZ).toBeCloseTo(-7); // backdrop pass
    expect(sconceX).toBeCloseTo(0.5); // cell pass
  });

  it('each object is frustum-tested once per frame, as in an ordinary frame; with no portal in view the outdoors is not tested at all', () => {
    const spy = vi.spyOn(THREE.Mesh.prototype, 'intersectsFrustum');
    const { renderer } = createStubRenderer();
    const s = shopScene();
    const cam = camera();
    renderer.render(s.scene, cam);
    spy.mockClear();
    renderer.render(s.scene, cam);
    const ordinary = spy.mock.calls.length;
    spy.mockClear();
    renderIndoorView(renderer, s.scene, cam, ctx({ outsidePortals: [ahead] }));
    expect(spy.mock.calls.length).toBe(ordinary);
    spy.mockClear();
    renderIndoorView(renderer, s.scene, cam, ctx({ outsidePortals: [behind] }));
    const tested = new Set(spy.mock.contexts as THREE.Object3D[]);
    let cellMeshes = 0;
    s.cell.traverse((o) => { if ((o as THREE.Mesh).isMesh) cellMeshes++; });
    expect(tested.size).toBe(cellMeshes);
    expect(tested.has(s.door)).toBe(false);
  });
});

describe('PERF.indoor-two-pass-cost — PView::DrawCells draws the landscape only while an outside portal is in view', () => {
  it('doorway in view: backdrop (colour clear), depth-only clear, then the cells — the 622f9ddd9 frame', () => {
    const { renderer, stub } = createStubRenderer();
    const s = shopScene();
    const order: string[] = [];
    s.door.onBeforeRender = () => { order.push('door'); };
    (s.cell.children[0] as THREE.Mesh).onBeforeRender = () => { order.push('cell'); };
    renderIndoorView(renderer, s.scene, camera(), ctx({ outsidePortals: [ahead], forEachPointLight: s.forEachPointLight }));
    expect(order).toEqual(['door', 'cell']);
    expect(stub.log.clears[0] & GL_COLOR_BUFFER_BIT).not.toBe(0);
    expect(stub.log.clears.slice(1)).toEqual([GL_DEPTH_BUFFER_BIT]);
  });

  it('doorway behind the camera: one pass, the cells alone, over the scene\'s own colour clear; no depth-only clear', () => {
    const { renderer, stub } = createStubRenderer();
    const s = shopScene();
    const background = s.scene.background;
    const order: string[] = [];
    s.door.onBeforeRender = () => { order.push('door'); };
    (s.cell.children[0] as THREE.Mesh).onBeforeRender = () => { order.push('cell'); };
    const render = vi.spyOn(renderer, 'render');
    renderIndoorView(renderer, s.scene, camera(), ctx({ outsidePortals: [behind], forEachPointLight: s.forEachPointLight }));
    expect(render).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['cell']);
    expect(stub.log.clears).toHaveLength(1);
    expect(stub.log.clears[0] & GL_COLOR_BUFFER_BIT).not.toBe(0);
    expect(s.scene.background).toBe(background);
    expect(renderer.autoClear).toBe(true);
    // Every child's visibility is its own again.
    for (const o of [s.door, s.cell, s.npc, s.lampPost]) expect(o.visible).toBe(true);
  });

  it('a viewer standing in the doorway (the polygon across the near plane) still sees outside', () => {
    const cam = camera();
    expect(outsideViewVisible([doorway(0)], cam)).toBe(true);
    expect(outsideViewVisible([doorway(-0.05)], cam)).toBe(true);
    expect(outsideViewVisible([behind], cam)).toBe(false);
    expect(outsideViewVisible([], cam)).toBe(false);
    // Off to the side, beyond the 60° field of view.
    expect(outsideViewVisible([doorway(-4).map((v) => v.clone().add(new THREE.Vector3(20, 0, 0)))], cam)).toBe(false);
  });

  it('no portal data (cells still loading): the backdrop always draws', () => {
    const { renderer } = createStubRenderer();
    const s = shopScene();
    const render = vi.spyOn(renderer, 'render');
    renderIndoorView(renderer, s.scene, camera(), ctx());
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('in doubt it draws: a wall 0.15 m to the side cuts the near plane, so the backdrop draws with no portal in view', () => {
    // The game camera: 90° vertical FOV on a 2:1 window, znear 0.1 (near rectangle ±0.2 m wide).
    const cam = mirrorCameraX(new THREE.PerspectiveCamera(90, 2, 0.1, 4000));
    cam.updateMatrixWorld();
    const room = (wallX: number): IndoorViewContext => ctx({ outsidePortals: [behind], cellAt: (x) => (x < wallX ? SHOP : 0) });
    expect(nearPlaneInsideCell(cam, room(0.15))).toBe(false);
    expect(nearPlaneInsideCell(cam, room(1))).toBe(true);
    expect(backdropVisible(cam, room(0.15))).toBe(true);
    expect(backdropVisible(cam, room(1))).toBe(false);
    // An eye in no cell at all: draw.
    expect(backdropVisible(cam, ctx({ outsidePortals: [behind], cellAt: () => 0 }))).toBe(true);
    const { renderer } = createStubRenderer();
    const render = vi.spyOn(renderer, 'render');
    renderIndoorView(renderer, shopScene().scene, cam, room(0.15));
    expect(render).toHaveBeenCalledTimes(2);
  });
});

describe('PERF.indoor-two-pass-cost — pads from the DAT light list keep the outdoor program variants', () => {
  for (const [label, portals] of [['doorway in view', ahead], ['doorway behind', behind]] as const) {
    it(`${label}: every pass sees the ordinary frame's point-light count, and it matches the scene walk`, () => {
      const { renderer } = createStubRenderer();
      const s = shopScene();
      const single = pointLightsSeen(s.scene);
      const counts: number[] = [];
      const real = renderer.render.bind(renderer);
      renderer.render = (scene: THREE.Object3D, cam: THREE.Camera) => { counts.push(pointLightsSeen(s.scene)); real(scene, cam); };
      renderIndoorView(renderer, s.scene, camera(), ctx({ outsidePortals: [portals], forEachPointLight: s.forEachPointLight }));
      const fromList = [...counts];
      counts.length = 0;
      renderIndoorView(renderer, s.scene, camera(), ctx({ outsidePortals: [portals] }));
      expect(fromList.every((c) => c === single)).toBe(true);
      expect(fromList).toEqual(counts);
      expect(pointLightsSeen(s.scene)).toBe(single);
    });
  }

  it('a disabled light, a light under a hidden group and a light no longer in the scene are not counted', () => {
    const { renderer } = createStubRenderer();
    const s = shopScene();
    const off = datLight(false);
    const hiddenGroup = new THREE.Group();
    hiddenGroup.visible = false;
    const underHidden = datLight();
    hiddenGroup.add(underHidden);
    s.lampPost.add(off, hiddenGroup);
    const gone = datLight();
    const list: THREE.Object3D[] = [off, underHidden, gone];
    s.forEachPointLight!((l) => { list.push(l); });
    const single = pointLightsSeen(s.scene);
    const counts: number[] = [];
    const real = renderer.render.bind(renderer);
    renderer.render = (scene: THREE.Object3D, cam: THREE.Camera) => { counts.push(pointLightsSeen(s.scene)); real(scene, cam); };
    renderIndoorView(renderer, s.scene, camera(), ctx({ outsidePortals: [ahead], forEachPointLight: (v) => { for (const l of list) v(l); } }));
    expect(counts).toEqual([single, single]);
  });

  it('DatLightBudget.forEachLight lists the gathered DAT lights and the tracked object lights, never its fillers', () => {
    const s = shopScene();
    const budget = new DatLightBudget(s.scene, { fixedLightCount: true });
    const objectLight = datLight();
    objectLight.userData.datLightTracked = true;
    s.scene.add(objectLight);
    budget.track(objectLight);
    budget.update(new THREE.Vector3(0, 0, 0), 0);
    const listed: THREE.Object3D[] = [];
    budget.forEachLight((l) => listed.push(l));
    const dat: THREE.Object3D[] = [];
    s.scene.traverse((o) => { if (o.userData.datLight && !o.userData.datLightFiller) dat.push(o); });
    expect(new Set(listed)).toEqual(new Set([...dat, objectLight]));
    expect(listed.some((l) => l.userData.datLightFiller)).toBe(false);
  });
});

describe('PERF.indoor-two-pass-cost — outsidePortalPolygons places a cell\'s portal like createCellMesh places the cell', () => {
  it('cell-local vertices through the Frame and the landblock offset, AC (x, y, z) -> three (x, z, y)', () => {
    // A doorway 2 m east of a cell turned 90° about AC z (as Yaraq's shop cells are).
    const s = Math.SQRT1_2;
    const data: OutsidePortalCellData = {
      cellStruct: {
        vertexArray: { vertices: new Map([
          [0, { origin: { x: 2, y: -1, z: 0 } }], [1, { origin: { x: 2, y: 1, z: 0 } }], [2, { origin: { x: 2, y: 1, z: 3 } }],
        ]) },
        polygons: new Map([[7, { vertexIndices: [0, 1, 2] }], [8, { vertexIndices: [0, 1, 2] }]]),
      },
      position: { origin: { x: 85.5, y: 109.5, z: 12 }, orientation: { w: s, x: 0, y: 0, z: -s } },
      outsidePortalPolygonIds: [7],
    };
    const polys = outsidePortalPolygons([0x7d640105], () => data)!;
    expect(polys).toHaveLength(1);
    // Rotation -90° about z: (x, y) -> (y, -x). Vertex 0 (2, -1, 0) -> (-1, -2, 0).
    const v0 = polys[0][0];
    expect(v0.x).toBeCloseTo(0x7d * 192 + 85.5 - 1);
    expect(v0.y).toBeCloseTo(12);
    expect(v0.z).toBeCloseTo(0x64 * 192 + 109.5 - 2);
    expect(polys[0][2].y).toBeCloseTo(15);
    // A cell whose data is not loaded yet: no answer (the backdrop keeps drawing).
    expect(outsidePortalPolygons([0x7d640105, 0x7d640106], (id) => (id === 0x7d640105 ? data : null))).toBeNull();
  });

  it('portalPolygonInFrustum culls only a polygon wholly outside one plane', () => {
    const cam = camera();
    const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    // Straddling the left plane: one vertex inside.
    expect(portalPolygonInFrustum([new THREE.Vector3(-100, 0, -10), new THREE.Vector3(0, 0, -10), new THREE.Vector3(-100, 1, -10)], f)).toBe(true);
    expect(portalPolygonInFrustum([new THREE.Vector3(-100, 0, -10), new THREE.Vector3(-90, 0, -10), new THREE.Vector3(-100, 1, -10)], f)).toBe(false);
  });
});

// The three eras' real cells: each era's EnvCellRenderer reads the outside
// portals (OtherCellId 0xFFFF) main.ts feeds the gate, and a DungeonCollision
// of the same cells answers ctx.cellAt as main.ts's outdoorCollision does.
const REPO = resolve(__dirname, '..');

/** The game's world camera: 90° vertical FOV (SceneManager), retail znear 0.1, mirrored (WorldMirror). */
function gameCamera(aspect = 2): THREE.PerspectiveCamera {
  return mirrorCameraX(new THREE.PerspectiveCamera(90, aspect, 0.1, 4000));
}

interface CellWorld {
  /** Outside portal polygons of the viewer cell's PVS. */
  polys: PortalPolygon[];
  pvs: Set<number>;
  collision: DungeonCollision;
  /** The PVS cells' meshes as EnvCellRenderer builds them (what the cell pass draws). */
  meshes: THREE.Group;
}

async function loadCellWorld(portal: string, cell: string, ac1999: boolean, viewerCell: number, withMeshes = false): Promise<CellWorld> {
  const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
  const { FileDatBytes } = await import('../packages/dat-parser/src/node/FileDatBytes.js');
  const { ac1999CellOverlay, ac1999PortalOverlay } = await import('../packages/dat-parser/src/era1999/Ac1999Overlay.js');
  const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
  const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
  const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
  const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
  const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
  // Own instances: the AC1999 overlays change reads (verify-ac1999-world-set.ts).
  const portalDb = new DatDatabase(new FileDatBytes(resolve(REPO, portal)));
  const cellDb = new DatDatabase(new FileDatBytes(resolve(REPO, cell)));
  if (ac1999) { portalDb.setOverlay(ac1999PortalOverlay()); cellDb.setOverlay(ac1999CellOverlay()); }
  const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
  const mr = new ModelRenderer(portalDb, mf);
  const env = new EnvCellRenderer(portalDb, cellDb, mf, new SetupModelRenderer(portalDb, mr), mr);
  // main.ts updateIndoorView: the viewer's cell and its VisibleCells.
  const pvs = new Set([viewerCell & 0xffff, ...env.loadEnvCell(viewerCell)!.visibleCells]);
  const ids = [...pvs].map((c) => ((viewerCell & 0xffff0000) | c) >>> 0);
  const polys = outsidePortalPolygons(ids, (id) => env.getCellCollisionData(id))!;
  const collision = new DungeonCollision();
  const meshes = new THREE.Group();
  for (const id of ids) {
    const d = env.getCellCollisionData(id)!;
    collision.addCell(id, d.cellStruct, d.position, d.outsidePortalPolygonIds, d.neighborCellIds);
    if (withMeshes) meshes.add(env.createCellMesh(id)!);
  }
  meshes.updateMatrixWorld(true);
  return { polys, pvs, collision, meshes };
}

function cellCtx(w: CellWorld, viewerCell: number): IndoorViewContext {
  return {
    blockKey: viewerCell >>> 16, cells: w.pvs, playerCellId: viewerCell, outsidePortals: w.polys,
    cellAt: (x, y, z) => w.collision.findCellContaining(x, y, z, viewerCell),
  };
}

const blockOrigin = (cellId: number) => ({ x: ((cellId >>> 24) & 0xff) * 192, y: ((cellId >>> 16) & 0xff) * 192 });
/** AC block-local (x, y, z up) -> three world. */
const threeAt = (cellId: number, b: readonly [number, number, number]) => {
  const o = blockOrigin(cellId);
  return new THREE.Vector3(o.x + b[0], b[2], o.y + b[1]);
};

interface EraCase {
  era: string; portal: string; cell: string; ac1999: boolean;
  /** The viewer's cell and where it stands (AC block-local), and a view that sees outside / one that does not. */
  cellId: number; eye: [number, number, number]; toward: [number, number, number]; away: [number, number, number];
}
const ERAS: EraCase[] = [
  {
    // End of retail: Yaraq, Nuya bint Mulud the Grocer's shop (world DB: she stands in 0x7D640114 at
    // (78.7, 124.5, 12); building 0x01000E11, cells 0x10E-0x11B). The PVS's outside portals are all
    // north of her: the door 0x119 (x 79-81, y 131.5), 0x115 (x 74-76, y 125, z 16-18.8), 0x11A, 0x10F.
    era: 'end of retail (Yaraq, Nuya\'s shop 0x7D640114)', portal: 'dat/client_portal.dat', cell: 'dat/client_cell_1.dat', ac1999: false,
    cellId: 0x7d640114, eye: [78.7, 124.2, 13.6], toward: [80, 131.5, 13], away: [78.7, 100, 13.6],
  },
  {
    // Dark Majesty: the Holtburg portal bunker (classic Dereth, 0xA9B4 0x185-0x189). In the portal room
    // (y 61-79, floor z 73.7) the hut's doorway (0x189, y 87-88, z 80-83) is up the stairs to the north.
    era: 'Dark Majesty (Holtburg portal bunker 0xA9B40185)', portal: 'dat/sets/classic-dereth/client_portal.dat', cell: 'dat/sets/classic-dereth/client_cell_1.dat', ac1999: false,
    cellId: 0xa9b40185, eye: [108, 70, 75.4], toward: [108, 87.5, 81.5], away: [108, 50, 75.4],
  },
  {
    // AC1999: the Holtburg tavern's front room (0xA9B4 0x155, x 105.5-109.5, y 31.5-40.5, floor z 94). The
    // vestibule 0x165 (the 0.5 m doorway cell at x 97.5-98) holds the door, the outside portal at x 97.5
    // (y 35-37, z 94-96.5); the PVS's others are upstairs (0x15E, z 97.5+) and at x 118.5.
    era: 'AC1999 (Holtburg tavern front room 0xA9B40155)', portal: 'dat-sets/ac1999-retail/portal.dat', cell: 'dat-sets/ac1999-retail/cell.dat', ac1999: true,
    cellId: 0xa9b40155, eye: [107.5, 36, 95.6], toward: [97.5, 36, 95.2], away: [107.5, 36, 0],
  },
];

for (const e of ERAS) {
  const have = existsSync(resolve(REPO, e.portal)) && existsSync(resolve(REPO, e.cell));
  describe.skipIf(!have)(`PERF.indoor-two-pass-cost — ${e.era}`, () => {
    let w: CellWorld;
    beforeAll(async () => { w = await loadCellWorld(e.portal, e.cell, e.ac1999, e.cellId); }, 120_000);

    const look = (at: [number, number, number]) => {
      const cam = gameCamera();
      cam.position.copy(threeAt(e.cellId, e.eye));
      cam.lookAt(threeAt(e.cellId, at));
      cam.updateMatrixWorld();
      return cam;
    };

    it('the viewer\'s cells have outside portals, and they lie in the block; the eye stands in the viewer\'s cell', () => {
      expect(w.polys.length).toBeGreaterThan(0);
      const o = blockOrigin(e.cellId);
      for (const p of w.polys) for (const v of p) {
        expect(v.x).toBeGreaterThanOrEqual(o.x);
        expect(v.x).toBeLessThanOrEqual(o.x + 192);
        expect(v.z).toBeGreaterThanOrEqual(o.y);
        expect(v.z).toBeLessThanOrEqual(o.y + 192);
      }
      const eye = threeAt(e.cellId, e.eye);
      expect(w.collision.findCellContaining(eye.x, eye.z, eye.y, e.cellId)).toBe(e.cellId);
    });

    it('facing the way out the backdrop draws (two passes); facing away it is skipped (one pass, the cells alone)', () => {
      expect(outsideViewVisible(w.polys, look(e.toward))).toBe(true);
      expect(outsideViewVisible(w.polys, look(e.away))).toBe(false);
      const c = cellCtx(w, e.cellId);
      expect(nearPlaneInsideCell(look(e.away), c)).toBe(true);
      const s = shopScene();
      s.cell.name = `envcell_${(e.cellId >>> 0).toString(16).padStart(8, '0')}`;
      s.cell.userData.envCellId = e.cellId >>> 0;
      for (const [at, passes] of [[e.toward, 2], [e.away, 1]] as const) {
        const { renderer, stub } = createStubRenderer();
        const render = vi.spyOn(renderer, 'render');
        const cellDrawn: number[] = [];
        (s.cell.children[0] as THREE.Mesh).frustumCulled = false;
        (s.cell.children[0] as THREE.Mesh).onBeforeRender = () => { cellDrawn.push(stub.log.clears.length); };
        renderIndoorView(renderer, s.scene, look(at), c);
        expect(render).toHaveBeenCalledTimes(passes);
        expect(stub.log.clears.filter((m) => (m & GL_COLOR_BUFFER_BIT) !== 0)).toHaveLength(1);
        expect(cellDrawn).toEqual([passes]); // after the depth clear, or after the frame's one clear
        render.mockRestore();
      }
    });
  });
}

/**
 * Regression (lead's Firefox check of 48024c906, 2026-10-21): in Nuya's shop,
 * at two of eight turns, the right of the screen showed the flat clear colour
 * where 622f9ddd9 drew the building's stone. No outside portal of the
 * building's 14 cells (all in each other's PVS) was in the frustum, but the
 * camera stood within ~0.25 m of a wall: the near plane (0.1 m out, 0.2 m to
 * each side at 90° x 2:1) cut the wall, so the frame saw past it, where only
 * the landscape pass draws. The gate now also draws the backdrop whenever the
 * near rectangle leaves the eye's cell (nearPlaneInsideCell).
 *
 * A pose sweep over Nuya's room (0x114) and the hall behind it (0x113): rays
 * from the near plane through the drawn cell meshes find every pose where
 * something past the cells shows, and the gate must draw the backdrop there.
 */
const NUYA = { portal: 'dat/client_portal.dat', cell: 'dat/client_cell_1.dat', viewer: 0x7d640113 };
describe.skipIf(!(existsSync(resolve(REPO, NUYA.portal)) && existsSync(resolve(REPO, NUYA.cell))))(
  'PERF.indoor-two-pass-cost — Yaraq, Nuya\'s shop (0x7D64 0x10E-0x11B): a camera against a wall still gets the backdrop',
  () => {
    let w: CellWorld;
    beforeAll(async () => { w = await loadCellWorld(NUYA.portal, NUYA.cell, false, NUYA.viewer, true); }, 120_000);

    const pose = (cell: number, eye: THREE.Vector3, yawDeg: number) => {
      const cam = gameCamera();
      cam.position.copy(eye);
      const a = (yawDeg * Math.PI) / 180;
      cam.lookAt(eye.x + Math.cos(a), eye.y, eye.z + Math.sin(a));
      cam.updateMatrixWorld();
      return { cam, ctx: cellCtx(w, cell) };
    };
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector3();
    /** Screen points (7 x 7) whose ray from the near plane meets none of the drawn cells: the landscape pass's pixels. */
    const pastTheCells = (cam: THREE.Camera): number => {
      let n = 0;
      for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
        const sx = (i / 3) * 0.95, sy = (j / 3) * 0.95;
        ray.setFromCamera(new THREE.Vector2(sx, sy), cam);
        ray.ray.origin.copy(ndc.set(sx, sy, -1).unproject(cam));
        if (ray.intersectObject(w.meshes, true).length === 0) n++;
      }
      return n;
    };

    it('the reported view: against the hall\'s west wall, turned 135°, no outside portal is in view yet the wall is cut — the backdrop draws', () => {
      const eye = threeAt(NUYA.viewer, [74.3, 130.8, 13.7]);
      const { cam, ctx } = pose(NUYA.viewer, eye, 135);
      expect(w.collision.findCellContaining(eye.x, eye.z, eye.y, NUYA.viewer)).toBe(NUYA.viewer);
      expect(outsideViewVisible(w.polys, cam)).toBe(false); // 48024c906's gate: skipped
      expect(pastTheCells(cam)).toBeGreaterThan(0); // ...but the frame sees past the wall
      expect(nearPlaneInsideCell(cam, ctx)).toBe(false);
      const { renderer } = createStubRenderer();
      const render = vi.spyOn(renderer, 'render');
      renderIndoorView(renderer, shopScene().scene, cam, ctx);
      expect(render).toHaveBeenCalledTimes(2);
    });

    it('sweep: wherever the frame sees past the cells, the backdrop draws; it is still skipped in a good share of poses', () => {
      let poses = 0, skipped = 0, missed = 0, oldMissed = 0;
      const misses: string[] = [];
      for (const cell of [0x7d640113, 0x7d640114]) {
        const box = new THREE.Box3();
        for (const m of w.meshes.children) if (m.userData.envCellId === cell) box.setFromObject(m);
        for (let x = box.min.x + 0.15; x < box.max.x; x += 0.6) for (let z = box.min.z + 0.15; z < box.max.z; z += 0.6) {
          for (const h of [1.0, 1.8]) {
            const eye = new THREE.Vector3(x, box.min.y + h, z);
            if (w.collision.findCellContaining(eye.x, eye.z, eye.y, cell) !== cell) continue;
            for (let yaw = 0; yaw < 360; yaw += 45) {
              const { cam, ctx } = pose(cell, eye, yaw);
              poses++;
              const drawn = backdropVisible(cam, ctx);
              if (!drawn) skipped++;
              if (pastTheCells(cam) === 0) continue;
              if (!outsideViewVisible(w.polys, cam)) oldMissed++;
              if (!drawn) { missed++; if (misses.length < 5) misses.push(`${cell.toString(16)} (${x.toFixed(2)}, ${z.toFixed(2)}) yaw ${yaw}`); }
            }
          }
        }
      }
      expect(misses).toEqual([]);
      expect(missed).toBe(0);
      expect(oldMissed).toBeGreaterThan(0); // the sweep does reach the reported case
      expect(poses).toBeGreaterThan(500);
      expect(skipped / poses).toBeGreaterThan(0.1);
    }, 120_000);
  },
);
