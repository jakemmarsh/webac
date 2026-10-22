/**
 * BUG.bunker-terrain-over-stairs — retail's draw order for a viewer inside a
 * surface building cell.
 *
 * SmartBox::RenderNormalMode @ 00453aa0 branches on the VIEWER's (camera's)
 * cell: outdoors it draws LScape::draw; in an env cell it runs
 * PView::DrawInside(indoor_pview, viewer_cell). PView::ConstructView
 * (CEnvCell) @ 005a57b0 floods out from that cell through its portals, and
 * PView::DrawCells @ 005a4840 then draws, in this order:
 *   1. the landscape (LScape::draw: terrain, its land cells' objects and
 *      building shells, other buildings with their own interiors), seen
 *      through the outside portals the flood reached;
 *   2. Clear(4) — RenderDeviceD3D::Clear @ 0059fd30 maps 4 to
 *      D3DCLEAR_ZBUFFER: the depth buffer only;
 *   3. the flood's cells and the objects standing in them.
 * So the landscape is a backdrop and can never cover the viewer's rooms. We
 * drew everything in one depth-tested pass: in a room under the landscape
 * (the classic town portal bunkers 0x010011C0, the drudge statue pedestals
 * 0x01002A1B) the terrain at the hut floor's height covered the stair
 * opening and the room below it (2026-10-18 report: "none of the 'bunker'
 * portals are appearing").
 *
 * The flood is approximated by the viewer cell's VisibleCells (the PVS the
 * DAT precomputes from the same portals; CObjCell::draw_visible), as the
 * surface cell rule already does.
 */
import * as THREE from 'three';

/** Which pass a top-level scene child draws in: the landscape backdrop, the viewer's cells, or both (lights). */
export type IndoorPass = 'outside' | 'inside' | 'both';

export interface IndoorViewContext {
  /** The viewer's cell's landblock (full cell id >>> 16). */
  blockKey: number;
  /** The viewer's cell index and its VisibleCells (low 16 bits, all >= 0x100). */
  cells: ReadonlySet<number>;
  /** The player's full cell id (0 outdoors). */
  playerCellId: number;
  /** The interior cell (full id) holding an AC world point, 0 for none. */
  cellAt(acX: number, acY: number, acZ: number): number;
  /**
   * PERF.indoor-two-pass-cost — the outside portals (OtherCellId 0xFFFF) of
   * the viewer's cells, as polygons in three world coordinates
   * (outsidePortalPolygons). PView::DrawCells @ 005a4840 draws the landscape
   * only while `outside_view.view_count != 0`: PView::ClipPortals @ 005a5520
   * adds a view to outside_view only for an outside portal whose clip
   * (PView::GetClip) leaves something on screen. With none in the camera's
   * frustum (and the near plane inside the eye's cell, nearPlaneInsideCell) the backdrop pass is skipped. Undefined: always draw it (no
   * portal data yet).
   */
  outsidePortals?: readonly PortalPolygon[];
  /**
   * PERF.indoor-two-pass-cost — every point light that can hang under a
   * top-level child (DatLightBudget's DAT lights: each starts disabled and
   * only the budget enables it). The pad count then comes from these few
   * instead of a walk of the whole visible scene. Undefined: walk the scene.
   */
  forEachPointLight?: (visit: (light: THREE.Object3D) => void) => void;
}

/** A portal polygon's vertices in three world coordinates, in winding order. */
export type PortalPolygon = readonly THREE.Vector3[];

/** The cell data outsidePortalPolygons reads (EnvCellRenderer.getCellCollisionData). */
export interface OutsidePortalCellData {
  cellStruct: {
    vertexArray: { vertices: ReadonlyMap<number, { origin: { x: number; y: number; z: number } }> };
    polygons: ReadonlyMap<number, { vertexIndices: readonly number[] }>;
  };
  position: { origin: { x: number; y: number; z: number }; orientation: { w: number; x: number; y: number; z: number } };
  outsidePortalPolygonIds: readonly number[];
}

/**
 * The outside portals of a set of cells in three world coordinates: each
 * portal polygon's cell-local vertices carried through the cell's Frame and
 * the landblock offset, AC (x, y, z) -> three (x, z, y), as
 * EnvCellRenderer.createCellMesh places the cell. Null when a cell's data is
 * not loaded (the caller then draws the backdrop every frame).
 */
export function outsidePortalPolygons(
  cellIds: Iterable<number>, data: (cellId: number) => OutsidePortalCellData | null,
): PortalPolygon[] | null {
  const out: PortalPolygon[] = [];
  const q = new THREE.Quaternion();
  for (const cellId of cellIds) {
    const d = data(cellId >>> 0);
    if (!d) return null;
    const offX = ((cellId >>> 24) & 0xff) * 192;
    const offY = ((cellId >>> 16) & 0xff) * 192;
    const o = d.position.orientation;
    q.set(o.x, o.y, o.z, o.w);
    for (const polyId of d.outsidePortalPolygonIds) {
      const poly = d.cellStruct.polygons.get(polyId);
      if (!poly) continue;
      const verts: THREE.Vector3[] = [];
      for (const vi of poly.vertexIndices) {
        const v = d.cellStruct.vertexArray.vertices.get(vi);
        if (!v) continue;
        const p = new THREE.Vector3(v.origin.x, v.origin.y, v.origin.z).applyQuaternion(q);
        verts.push(new THREE.Vector3(offX + d.position.origin.x + p.x, d.position.origin.z + p.z, offY + d.position.origin.y + p.y));
      }
      if (verts.length >= 3) out.push(verts);
    }
  }
  return out;
}

/**
 * Whether a portal polygon can be on screen: false only when every vertex
 * lies outside one of the frustum's side or far planes. A conservative
 * superset of retail's PView::GetClip @ 005a4320 (which also clips through
 * the chain of inner portal views), so the backdrop is never skipped where
 * retail draws it. The near plane is left out: a viewer standing in the
 * doorway (the portal nearer than the near distance) still sees out.
 */
export function portalPolygonInFrustum(poly: PortalPolygon, frustum: THREE.Frustum): boolean {
  // three's Frustum.planes: right, left, bottom, top, far, near.
  for (let i = 0; i < 5; i++) {
    const plane = frustum.planes[i];
    let outside = true;
    for (const v of poly) if (plane.distanceToPoint(v) >= 0) { outside = false; break; }
    if (outside) return false;
  }
  return true;
}

const viewFrustum = new THREE.Frustum();
const viewProj = new THREE.Matrix4();

/** PView::DrawCells' `outside_view.view_count != 0`: an outside portal of the viewer's cells is in the camera's view. */
export function outsideViewVisible(portals: readonly PortalPolygon[], camera: THREE.Camera): boolean {
  viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  viewFrustum.setFromProjectionMatrix(viewProj);
  for (const poly of portals) if (portalPolygonInFrustum(poly, viewFrustum)) return true;
  return false;
}

/**
 * How far past the near plane's rectangle (as a factor of its distance from
 * the eye) a sample point is taken: the wall the near plane cuts may be a few
 * centimetres beyond a sample, so points a little outside it are tested too.
 */
export const NEAR_PLANE_MARGIN = 1.5;
const nearSample = new THREE.Vector3();
const eyePos = new THREE.Vector3();

/**
 * Whether the near plane stays inside the camera's own cell. A camera
 * within ~0.25 m of a wall (the near rectangle is 0.1 m out and, at 90°
 * vertical FOV on a wide window, 0.2 m to each side) cuts the wall with its
 * near plane and sees past it, into the wall's thickness and whatever stands
 * behind: no outside portal is in view, yet the landscape shows there.
 * PERF.indoor-two-pass-cost regression (Yaraq grocer 0x7D64 0x113, lead's
 * Firefox check 2026-10-21): the gate skipped the backdrop and that strip
 * showed the clear colour instead of the building shell. The eye's cell is
 * found with ctx.cellAt; nine points of the near rectangle (corners, edge
 * midpoints, centre), pushed out by NEAR_PLANE_MARGIN, must lie in it.
 */
export function nearPlaneInsideCell(camera: THREE.Camera, ctx: Pick<IndoorViewContext, 'cellAt'>): boolean {
  camera.getWorldPosition(eyePos);
  // three world (X, Y, Z) = AC (x, z, y).
  const cell = ctx.cellAt(eyePos.x, eyePos.z, eyePos.y);
  if (cell === 0) return false;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      nearSample.set(i, j, -1).unproject(camera).sub(eyePos).multiplyScalar(NEAR_PLANE_MARGIN).add(eyePos);
      if (ctx.cellAt(nearSample.x, nearSample.z, nearSample.y) !== cell) return false;
    }
  }
  return true;
}

/**
 * Whether the landscape backdrop draws this frame: retail's gate (an outside
 * portal in view, outsideViewVisible), or, in doubt, whenever the near plane
 * leaves the eye's cell (nearPlaneInsideCell). No portal data: always.
 */
export function backdropVisible(camera: THREE.Camera, ctx: IndoorViewContext): boolean {
  if (!ctx.outsidePortals) return true;
  return outsideViewVisible(ctx.outsidePortals, camera) || !nearPlaneInsideCell(camera, ctx);
}

/** Whether a full cell id is one of the viewer's cells. */
export function isViewerCell(cellId: number, ctx: IndoorViewContext): boolean {
  return cellId !== 0 && (cellId >>> 16) === ctx.blockKey && ctx.cells.has(cellId & 0xffff);
}

const ENV_CELL = /^envcell_([0-9a-f]{8})$/i;
/** Scratch for a world-space effect's anchor. */
const anchorPos = new THREE.Vector3();
/**
 * An object's origin often rests exactly on its floor (the bunker portal at z 73.6 on the 73.6
 * floor), where the containment test can fall just outside the cell; test half a metre up.
 */
const ANCHOR_LIFT = 0.5;
/** Top-level objects placed by position rather than by a known cell (effects, static scripts). */
const BY_POSITION = /^(particles_|static_script_)/;

/**
 * The pass a top-level scene child draws in while the viewer is in a
 * surface cell. Lights light both passes. A cell mesh, the player and a
 * server object draw inside when their cell is one of the viewer's (a
 * server object's cell is `userData.objCellId`, set by
 * ServerObjectManager.updateInteriorVisibility); effects by the cell their
 * position (a world-space particle system: its parent's) lies in. Everything else (terrain, roads, sky, outdoor buildings,
 * scenery, other buildings' cells) is the landscape backdrop.
 */
export function indoorPassOf(obj: THREE.Object3D, ctx: IndoorViewContext): IndoorPass {
  if ((obj as THREE.Light).isLight || obj.name === 'object-light-carrier') return 'both';
  const name = obj.name;
  // EnvCellRenderer.createCellMesh tags its group; the name is the fallback.
  const envCellId = obj.userData?.envCellId as number | undefined;
  if (envCellId !== undefined) return isViewerCell(envCellId >>> 0, ctx) ? 'inside' : 'outside';
  const env = name.startsWith('envcell_') ? ENV_CELL.exec(name) : null;
  if (env) return isViewerCell(parseInt(env[1], 16) >>> 0, ctx) ? 'inside' : 'outside';
  if (name.startsWith('player_')) return isViewerCell(ctx.playerCellId, ctx) ? 'inside' : 'outside';
  const objCellId = obj.userData?.objCellId as number | undefined;
  if (objCellId !== undefined) return isViewerCell(objCellId >>> 0, ctx) ? 'inside' : 'outside';
  // A world-space particle system's node stays at the scene origin; it draws with its parent
  // (the portal vortex of a bunker's town portal is one).
  const anchor = obj.userData?.indoorAnchor as ((out: THREE.Vector3) => THREE.Vector3 | null) | undefined;
  const p = anchor ? anchor(anchorPos) : BY_POSITION.test(name) ? obj.position : null;
  // three world (X, Y, Z) = AC (x, z, y); the point is raised off the floor it may rest on.
  if (p) return isViewerCell(ctx.cellAt(p.x, p.z, p.y + ANCHOR_LIFT), ctx) ? 'inside' : 'outside';
  return 'outside';
}

/** The renderer calls an indoor-view frame needs (SceneManager's WebGLRenderer). */
export interface IndoorViewRenderer {
  autoClear: boolean;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  clearDepth(): void;
  /** three.js frame counters: held across both passes so draws / triangles count the whole frame (WorldReporter). */
  info?: { autoReset: boolean; reset(): void };
}

/** userData tag of the zero-intensity lights that keep both passes' point-light count equal. */
export const INDOOR_VIEW_PAD_KEY = 'indoorViewPad';

/** Each scene's pad lights (top-level, hidden between frames), grown on demand. */
const padPools = new WeakMap<THREE.Scene, THREE.PointLight[]>();

function padLights(scene: THREE.Scene, want: number): THREE.PointLight[] {
  let pool = padPools.get(scene);
  if (!pool) { pool = []; padPools.set(scene, pool); }
  while (pool.length < want) {
    // Zero intensity adds exactly 0 to every lit sum (DatLightBudget's fillers rely on the same).
    const pad = new THREE.PointLight(0x000000, 0, 1, 1);
    pad.name = 'indoor-view-pad';
    // datLight + datLightFiller: DatLightBudget neither pools it nor counts it as an external light.
    pad.userData.datLight = true;
    pad.userData.datLightFiller = true;
    pad.userData[INDOOR_VIEW_PAD_KEY] = true;
    pad.visible = false;
    scene.add(pad);
    pool.push(pad);
  }
  return pool;
}

/** The point lights three.js collects from a subtree (projectObject: a visible chain, the light on the camera's layers). */
function countPointLights(obj: THREE.Object3D, layers: THREE.Layers): number {
  if (!obj.visible) return 0;
  let n = (obj as THREE.PointLight).isPointLight && obj.layers.test(layers) ? 1 : 0;
  const kids = obj.children;
  for (let i = 0; i < kids.length; i++) n += countPointLights(kids[i], layers);
  return n;
}

/**
 * Draw one frame in PView::DrawCells order: the landscape backdrop, a
 * depth-only clear, then the viewer's cells and what stands in them. Each
 * pass hides the other pass's top-level children; every child's own
 * visibility is restored afterwards.
 *
 * BUG.indoor-backdrop-doors-and-cost (2026-10-21) — two three.js rules the
 * first version missed:
 *  - A THREE.Color scene.background makes WebGLBackground.render clear
 *    colour, depth and stencil on EVERY render() call, autoClear or not
 *    (its `forceClear`). The cell pass wiped the backdrop: a doorway showed
 *    the sky colour as a flat arch (pale by day, navy at night), with no
 *    door and no outdoors. The cell pass now runs with no background, so
 *    Clear(4) stays the depth-only clear retail does.
 *  - Hiding a subtree hides the DAT pool lights under it (a cell's sconces,
 *    a lamp post's lantern), so the two passes saw different point-light
 *    counts: three bumped its lights state twice a frame and re-resolved
 *    every lit material's program in each pass, compiling a new variant for
 *    each new count (the "hitchy/loading lag as you move" indoors, about 2x
 *    the outdoor frame in Firefox). Each pass now shows zero-intensity pad
 *    lights for the ones it hides, so both passes see the single-pass count:
 *    the outdoor program variants (DatLightBudget's constant total).
 *
 * PERF.indoor-two-pass-cost (2026-10-21) — the second render() repeated
 * three's whole-scene work: scene.updateMatrixWorld (every unfrozen node:
 * animated server objects, effects) ran in both passes, and the pad count
 * walked every visible node. Measured on a town-sized scene
 * (tools/bench-indoor-view.ts, 18.7k objects, interleaved medians): 4.9 ms
 * ordinary frame, 6.9 ms indoor frame; updateMatrixWorld is 1.4 ms of a
 * render and the light walk 0.5 ms. After: 5.0 ms with an outside portal in
 * view, 1.6 ms with none.
 * Now the world matrices update once per frame (both passes draw the same
 * frame), the pad count comes from the DAT light list
 * (`ctx.forEachPointLight`), and, as PView::DrawCells does, the backdrop
 * pass runs only while an outside portal of the viewer's cells is in view
 * (`ctx.outsidePortals`); otherwise the frame is the cell pass alone, with
 * the scene's own colour clear.
 */
export function renderIndoorView(
  renderer: IndoorViewRenderer, scene: THREE.Scene, camera: THREE.Camera, ctx: IndoorViewContext,
): void {
  const kids = scene.children;
  const n = kids.length;
  const shown = shownScratch;
  const pass = passScratch;
  shown.length = n;
  pass.length = n;
  let insideLights = 0;
  let outsideLights = 0;
  const walk = !ctx.forEachPointLight;
  for (let i = 0; i < n; i++) {
    shown[i] = kids[i].visible;
    pass[i] = shown[i] ? indoorPassOf(kids[i], ctx) : 'outside';
    if (!walk || !shown[i] || pass[i] === 'both') continue;
    const lights = countPointLights(kids[i], camera.layers);
    if (pass[i] === 'inside') insideLights += lights; else outsideLights += lights;
  }
  if (ctx.forEachPointLight) {
    ctx.forEachPointLight((light) => {
      const top = drawnTopLevel(light, scene, camera.layers);
      if (!top) return;
      const p = indoorPassOf(top, ctx);
      if (p === 'inside') insideLights++; else if (p === 'outside') outsideLights++;
    });
  }
  // One world-matrix update for the frame (three's render() would run it per pass).
  const matrixAuto = scene.matrixWorldAutoUpdate;
  const cameraAuto = camera.matrixWorldAutoUpdate;
  if (matrixAuto) scene.updateMatrixWorld();
  if (camera.parent === null && cameraAuto) camera.updateMatrixWorld();
  const backdrop = backdropVisible(camera, ctx);
  // New pads append after the snapshot (index >= n), hidden; showPads alone drives them.
  const pads = padLights(scene, backdrop ? Math.max(insideLights, outsideLights) : outsideLights);
  const showPads = (count: number) => { for (let i = 0; i < pads.length; i++) pads[i].visible = i < count; };
  const autoClear = renderer.autoClear;
  const background = scene.background;
  const info = renderer.info;
  const infoAutoReset = info?.autoReset ?? false;
  try {
    scene.matrixWorldAutoUpdate = false;
    camera.matrixWorldAutoUpdate = false;
    if (backdrop) {
      if (info && infoAutoReset) { info.reset(); info.autoReset = false; }
      for (let i = 0; i < n; i++) kids[i].visible = shown[i] && pass[i] !== 'inside';
      showPads(insideLights);
      renderer.render(scene, camera);
      renderer.autoClear = false;
      renderer.clearDepth();
      scene.background = null;
    }
    for (let i = 0; i < n; i++) kids[i].visible = shown[i] && pass[i] !== 'outside';
    showPads(outsideLights);
    renderer.render(scene, camera);
  } finally {
    scene.matrixWorldAutoUpdate = matrixAuto;
    camera.matrixWorldAutoUpdate = cameraAuto;
    if (info) info.autoReset = infoAutoReset;
    scene.background = background;
    renderer.autoClear = autoClear;
    for (let i = 0; i < n; i++) kids[i].visible = shown[i];
    showPads(0);
  }
}

/** Per-frame scratch (renderIndoorView is not re-entrant). */
const shownScratch: boolean[] = [];
const passScratch: IndoorPass[] = [];

/**
 * The top-level child a point light draws under, when three would collect
 * it in an ordinary frame (the light and every ancestor visible, the light
 * on the camera's layers); null for a light that is itself top-level (it
 * lights both passes), hidden, or no longer in the scene.
 */
function drawnTopLevel(light: THREE.Object3D, scene: THREE.Scene, layers: THREE.Layers): THREE.Object3D | null {
  if (!(light as THREE.PointLight).isPointLight || !light.visible || !light.layers.test(layers)) return null;
  let node = light;
  for (let p = light.parent; p; node = p, p = p.parent) {
    if (p === scene) return node === light ? null : node;
    if (!p.visible) return null;
  }
  return null;
}
