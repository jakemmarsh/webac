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
 * BUG.doorway-pvs-over-terrain (2026-11-01, Reddit: "when i step out of a
 * building, there is a narrow window where I can see through terrain, into
 * basements, and to houses below me in holt") — the flood was approximated by
 * the viewer cell's whole VisibleCells, every one drawn after the depth
 * clear. A doorway cell's PVS is its whole building (Holtburg 0xA9B4: the
 * doorway 0x145's 17 cells include the cellar 0x147-0x149 under the street;
 * the upstairs doorway 0x15E's include the ground floor 0x151-0x169), so
 * while a trailing camera crossed a doorway cell every room of the building,
 * cellar included, drew over the terrain and the building's own walls.
 * Retail floods instead (floodIndoorView): from the viewer's cell, through
 * each portal whose plane has the viewer on its open side (PView::InitCell
 * @ 005a4b70) and whose polygon survives clipping against the view so far
 * (PView::ClipPortals @ 005a5520 → PView::GetClip @ 005a4320), into the
 * cells of the viewer's PVS only (PView::add_views @ 005a5210 pushes a view
 * on each VisibleCells entry; CEnvCell::GetVisible @ 0052dc10 finds no other),
 * and DrawCells draws each reached cell only inside its clipped view
 * (CEnvCell::setup_view per view). We clip to screen rectangles (a superset
 * of retail's polygons) and draw each rectangle's cells under a scissor.
 * A PVS cell the flood does not reach draws with the landscape, depth-tested
 * against it, as an ordinary frame would.
 */
import * as THREE from 'three';
import { makeGatePortalPoly, type GatePlane, type SurfaceView } from '../world/buildingCells.js';

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
  /**
   * BUG.doorway-pvs-over-terrain — the viewer's cell index (low 16 bits) and
   * the portals of every cell in `cells` (cellPortalGraph). With both, each
   * frame floods from the viewer's cell (floodIndoorView): only the cells it
   * reaches draw in the cell pass, each under its clip rectangle. Without
   * them, every cell in `cells` draws there unclipped (portal data loading).
   */
  viewerCell?: number;
  portalGraph?: PortalGraph;
  /**
   * The clip rectangle (NDC) of a cell in `cells`; a cell not listed draws
   * full-screen. Set by renderIndoorView from the flood.
   */
  cellClip?: ReadonlyMap<number, ClipRect>;
}

/** A rectangle of normalised device coordinates, -1..1 on both axes. */
export interface ClipRect { x0: number; y0: number; x1: number; y1: number }

/** The whole view: the viewer's own cell draws everywhere (DrawInside copies the full screen into its view). */
export const FULL_VIEW: Readonly<ClipRect> = Object.freeze({ x0: -1, y0: -1, x1: 1, y1: 1 });

/** One CCellPortal of a cell, placed in the world. */
export interface CellPortalView {
  /** The cell it opens into (low 16 bits; 0xFFFF = the landscape). */
  other: number;
  /** The portal polygon's plane in AC world coordinates (CPolygon::make_plane), null when unresolved. */
  plane: GatePlane | null;
  /** portal_side 0 (CellPortal flags & 2): the viewer must be on the plane's positive side to see through. */
  requirePositive: boolean;
  /** The polygon in three world coordinates; empty when unresolved (the portal is then always open). */
  verts: readonly THREE.Vector3[];
}

/** Each cell's portals, by cell index (low 16 bits). */
export type PortalGraph = ReadonlyMap<number, readonly CellPortalView[]>;

/** The cell data cellPortalGraph reads: outsidePortalPolygons' plus the cell's CellPortals. */
export interface CellPortalData extends OutsidePortalCellData {
  cellPortals: readonly { flags: number; polygonId: number; otherCellId: number }[];
}

/**
 * The portals of a set of cells (full ids, one landblock), placed as
 * outsidePortalPolygons places them. Null while a cell's data is not loaded.
 * CCellPortal::UnPack @ 0053bab0: portal_side = (~flags >> 1) & 1, and the
 * portal leads outside when flags & 4 (OtherCellId 0xFFFF in the DAT).
 */
export function cellPortalGraph(
  cellIds: Iterable<number>, data: (cellId: number) => CellPortalData | null,
): Map<number, CellPortalView[]> | null {
  const out = new Map<number, CellPortalView[]>();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  for (const cellId of cellIds) {
    const d = data(cellId >>> 0);
    if (!d) return null;
    const offX = ((cellId >>> 24) & 0xff) * 192;
    const offY = ((cellId >>> 16) & 0xff) * 192;
    const o = d.position.orientation;
    q.set(o.x, o.y, o.z, o.w);
    const portals: CellPortalView[] = [];
    for (const cp of d.cellPortals) {
      const other = (cp.flags & 4) !== 0 ? 0xffff : cp.otherCellId;
      const poly = d.cellStruct.polygons.get(cp.polygonId);
      const ac: { x: number; y: number; z: number }[] = [];
      for (const vi of poly?.vertexIndices ?? []) {
        const v = d.cellStruct.vertexArray.vertices.get(vi);
        if (!v) continue;
        p.set(v.origin.x, v.origin.y, v.origin.z).applyQuaternion(q);
        ac.push({ x: offX + d.position.origin.x + p.x, y: offY + d.position.origin.y + p.y, z: d.position.origin.z + p.z });
      }
      const gate = makeGatePortalPoly(ac, cp.flags);
      portals.push({
        other,
        plane: gate?.plane ?? null,
        requirePositive: (cp.flags & 2) !== 0,
        verts: gate ? ac.map((v) => new THREE.Vector3(v.x, v.z, v.y)) : [],
      });
    }
    out.set(cellId & 0xffff, portals);
  }
  return out;
}

const gateFrustum = new THREE.Frustum();
const gateProj = new THREE.Matrix4();
const gateEye = new THREE.Vector3();

/**
 * The building-portal gates' view for this frame (applySurfaceCellVisibility):
 * the camera's position and frustum, AC world coordinates (three (X, Y, Z) =
 * AC (x, z, y)). The CAMERA alone, as retail: PView::ConstructView
 * (CBldPortal) @ 005a59a0 tests Render::FrameCurrent->viewer against the
 * portal plane, so a doorway's stab cells and its punch (PortalPunch.ts)
 * draw only from its open side for the camera.
 * BUG.doorway-pvs-over-terrain — the player was a second viewpoint: while
 * the camera trailed through a doorway with the player already out (or in),
 * the doorway's punch drew from its closed side. Its mark pass covered the
 * doorway seen from inside, so the road / blend overlays outside the door
 * skipped those pixels (the cobblestones flashed out and in at the
 * threshold), and its erase pass wrote far depth over the terrain there
 * (what lies past the hill showed through it). `out` keeps its viewpoint and
 * plane objects; its first viewpoint is set and the list cut to one.
 */
export function cameraGateView(camera: THREE.Camera, out: SurfaceView): SurfaceView {
  camera.getWorldPosition(gateEye);
  gateProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  gateFrustum.setFromProjectionMatrix(gateProj);
  const vp = out.viewpoints[0] ?? { x: 0, y: 0, z: 0 };
  vp.x = gateEye.x; vp.y = gateEye.z; vp.z = gateEye.y;
  out.viewpoints.length = 0;
  out.viewpoints.push(vp);
  for (let i = 0; i < 6; i++) {
    const p = gateFrustum.planes[i];
    const fp = out.frustum[i] ?? (out.frustum[i] = { nx: 0, ny: 0, nz: 0, d: 0 });
    fp.nx = p.normal.x; fp.ny = p.normal.z; fp.nz = p.normal.y; fp.d = p.constant;
  }
  return out;
}

/** Client F_EPSILON: a viewer this close to a portal's plane sees through it either way (PView::InitCell). */
const PORTAL_PLANE_EPSILON = 0.0002;
/** Clip-space w below which a vertex is at or behind the eye (the polygon is cut there before the divide). */
const CLIP_W_EPSILON = 1e-5;
let clipIn: THREE.Vector4[] = [];
let clipOut: THREE.Vector4[] = [];
const clipPool: THREE.Vector4[] = [];
let clipUsed = 0;
const clipVec = () => (clipPool[clipUsed] ??= new THREE.Vector4(), clipPool[clipUsed++]);

/** One Sutherland–Hodgman step: keep the part of clipIn where a·(x, y, z, w) + b·w >= 0 (clip space), into clipOut. */
function clipAgainst(ax: number, ay: number, aw: number, k: number): void {
  clipOut.length = 0;
  const n = clipIn.length;
  for (let i = 0; i < n; i++) {
    const a = clipIn[i];
    const b = clipIn[(i + 1) % n];
    const da = ax * a.x + ay * a.y + aw * a.w + k;
    const db = ax * b.x + ay * b.y + aw * b.w + k;
    if (da >= 0) clipOut.push(a);
    if ((da >= 0) !== (db >= 0)) clipOut.push(clipVec().copy(a).lerp(b, da / (da - db)));
  }
  const t = clipIn; clipIn = clipOut; clipOut = t;
}

/**
 * The screen rectangle a portal polygon covers inside `parent`, written to
 * `out`; false when nothing is left (PView::GetClip @ 005a4320's empty
 * clip). Like GetClip the polygon is clipped to the view it is seen in (here
 * the parent rectangle's four sides, in clip space) and the rectangle bounds
 * what is left. It is cut at the eye (w > 0), never at the near plane: a
 * portal nearer than the near distance still opens on everything past it.
 */
export function portalClipRect(verts: readonly THREE.Vector3[], viewProj: THREE.Matrix4, parent: ClipRect, out: ClipRect): boolean {
  clipUsed = 0;
  clipIn.length = 0;
  for (const v of verts) clipIn.push(clipVec().set(v.x, v.y, v.z, 1).applyMatrix4(viewProj));
  clipAgainst(0, 0, 1, -CLIP_W_EPSILON); // w >= eps
  clipAgainst(1, 0, -parent.x0, 0); // x >= x0·w
  clipAgainst(-1, 0, parent.x1, 0); // x <= x1·w
  clipAgainst(0, 1, -parent.y0, 0); // y >= y0·w
  clipAgainst(0, -1, parent.y1, 0); // y <= y1·w
  if (clipIn.length === 0) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of clipIn) {
    const x = c.x / c.w, y = c.y / c.w;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  // The divide can land a hair past a side the polygon was cut on.
  out.x0 = Math.max(x0, parent.x0);
  out.y0 = Math.max(y0, parent.y0);
  out.x1 = Math.min(x1, parent.x1);
  out.y1 = Math.min(y1, parent.y1);
  return out.x0 < out.x1 && out.y0 < out.y1;
}

const floodViewProj = new THREE.Matrix4();
const floodEye = new THREE.Vector3();
const floodRect: ClipRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
const floodTodo: number[] = [];

/**
 * PView::ConstructView (CEnvCell) @ 005a57b0 as screen rectangles: the
 * cells the viewer's cell reaches through portals that are on screen, each
 * with the rectangle it is seen in (`out`, cleared first; the viewer's cell
 * gets FULL_VIEW). A portal is looked through only from its open side
 * (PView::InitCell @ 005a4b70: the viewer's distance to the portal plane
 * against portal_side, in-plane passes) and only into a cell of `graph` (the
 * viewer's PVS: PView::add_views @ 005a5210 / CEnvCell::GetVisible @
 * 0052dc10). Its polygon is clipped to the rectangle of the cell it is seen
 * from (PView::ClipPortals @ 005a5520 → GetClip @ 005a4320); a cell seen
 * through several portals takes the union. An outside portal (0xFFFF) leads
 * to the landscape pass, not here. A portal with no resolved polygon stays
 * open with the whole rectangle of its cell: never less than retail draws.
 */
export function floodIndoorView(
  viewerCell: number, graph: PortalGraph, camera: THREE.Camera, out: Map<number, ClipRect>,
): Map<number, ClipRect> {
  out.clear();
  if (!graph.has(viewerCell)) return out;
  floodViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  camera.getWorldPosition(floodEye);
  // three world (X, Y, Z) = AC (x, z, y).
  const ex = floodEye.x, ey = floodEye.z, ez = floodEye.y;
  out.set(viewerCell, { ...FULL_VIEW });
  floodTodo.length = 0;
  floodTodo.push(viewerCell);
  // Each push grows a rectangle; the bound only guards degenerate data.
  for (let guard = 0; floodTodo.length > 0 && guard < 4096; guard++) {
    const cell = floodTodo.pop()!;
    const rect = out.get(cell)!;
    for (const p of graph.get(cell) ?? []) {
      if (p.other === 0xffff || !graph.has(p.other)) continue;
      if (p.plane) {
        const d = p.plane.nx * ex + p.plane.ny * ey + p.plane.nz * ez + p.plane.d;
        if (p.requirePositive ? d < -PORTAL_PLANE_EPSILON : d > PORTAL_PLANE_EPSILON) continue;
        const inPlane = Math.abs(d) <= PORTAL_PLANE_EPSILON;
        if (inPlane) Object.assign(floodRect, rect);
        else if (!portalClipRect(p.verts, floodViewProj, rect, floodRect)) continue;
      } else {
        Object.assign(floodRect, rect);
      }
      const had = out.get(p.other);
      if (!had) {
        out.set(p.other, { ...floodRect });
        floodTodo.push(p.other);
      } else if (floodRect.x0 < had.x0 || floodRect.y0 < had.y0 || floodRect.x1 > had.x1 || floodRect.y1 > had.y1) {
        had.x0 = Math.min(had.x0, floodRect.x0);
        had.y0 = Math.min(had.y0, floodRect.y0);
        had.x1 = Math.max(had.x1, floodRect.x1);
        had.y1 = Math.max(had.y1, floodRect.y1);
        floodTodo.push(p.other);
      }
    }
  }
  return out;
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
  const cell = indoorCellOf(obj, ctx);
  if (cell === 'both') return 'both';
  return isViewerCell(cell, ctx) ? 'inside' : 'outside';
}

/**
 * The cell (full id) a top-level scene child draws with, 0 for the
 * landscape, 'both' for a light (indoorPassOf's rules).
 */
export function indoorCellOf(obj: THREE.Object3D, ctx: IndoorViewContext): number | 'both' {
  if ((obj as THREE.Light).isLight || obj.name === 'object-light-carrier') return 'both';
  const name = obj.name;
  // EnvCellRenderer.createCellMesh tags its group; the name is the fallback.
  const envCellId = obj.userData?.envCellId as number | undefined;
  if (envCellId !== undefined) return envCellId >>> 0;
  const env = name.startsWith('envcell_') ? ENV_CELL.exec(name) : null;
  if (env) return parseInt(env[1], 16) >>> 0;
  if (name.startsWith('player_')) return ctx.playerCellId >>> 0;
  const objCellId = obj.userData?.objCellId as number | undefined;
  if (objCellId !== undefined) return objCellId >>> 0;
  // A world-space particle system's node stays at the scene origin; it draws with its parent
  // (the portal vortex of a bunker's town portal is one).
  const anchor = obj.userData?.indoorAnchor as ((out: THREE.Vector3) => THREE.Vector3 | null) | undefined;
  const p = anchor ? anchor(anchorPos) : BY_POSITION.test(name) ? obj.position : null;
  // three world (X, Y, Z) = AC (x, z, y); the point is raised off the floor it may rest on.
  if (p) return ctx.cellAt(p.x, p.z, p.y + ANCHOR_LIFT) >>> 0;
  return 0;
}

/** The renderer calls an indoor-view frame needs (SceneManager's WebGLRenderer). */
export interface IndoorViewRenderer {
  autoClear: boolean;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  clearDepth(): void;
  /** three.js frame counters: held across both passes so draws / triangles count the whole frame (WorldReporter). */
  info?: { autoReset: boolean; reset(): void };
  /** BUG.doorway-pvs-over-terrain — the scissor that holds a flooded cell to its clip rectangle (CSS pixels, origin bottom left). */
  getSize?(target: THREE.Vector2): THREE.Vector2;
  setScissor?(x: number, y: number, width: number, height: number): void;
  setScissorTest?(on: boolean): void;
  getScissorTest?(): boolean;
}

/** At most this many scissored cell renders a frame (each is a render() call); further rectangles merge into the last. */
export const MAX_CELL_CLIP_GROUPS = 8;

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
  renderer: IndoorViewRenderer, scene: THREE.Scene, camera: THREE.Camera, viewCtx: IndoorViewContext,
): void {
  // One world-matrix update for the frame (three's render() would run it per pass); the flood reads the camera's.
  const matrixAuto = scene.matrixWorldAutoUpdate;
  const cameraAuto = camera.matrixWorldAutoUpdate;
  if (matrixAuto) scene.updateMatrixWorld();
  if (camera.parent === null && cameraAuto) camera.updateMatrixWorld();
  const ctx = floodedContext(viewCtx, camera);
  const kids = scene.children;
  const n = kids.length;
  const shown = shownScratch;
  const pass = passScratch;
  shown.length = n;
  pass.length = n;
  // Cell pass groups: 0 is the full view; each other is one scissor rectangle (pixels).
  const groups = groupScratch;
  groups.length = 1;
  groupCells.clear();
  const size = renderer.getSize && renderer.setScissor && renderer.setScissorTest && ctx.cellClip
    ? renderer.getSize(sizeScratch) : null;
  const groupOf = (cellId: number): number => {
    const idx = cellId & 0xffff;
    let g = groupCells.get(idx);
    if (g === undefined) { g = clipGroup(ctx.cellClip?.get(idx), size, groups); groupCells.set(idx, g); }
    return g;
  };
  const passOf = (obj: THREE.Object3D): number => {
    const cell = indoorCellOf(obj, ctx);
    if (cell === 'both') return PASS_BOTH;
    return isViewerCell(cell, ctx) ? groupOf(cell) : PASS_OUTSIDE;
  };
  const lightsIn = lightsScratch;
  let outsideLights = 0;
  const walk = !ctx.forEachPointLight;
  for (let i = 0; i < n; i++) {
    shown[i] = kids[i].visible;
    pass[i] = shown[i] ? passOf(kids[i]) : PASS_OUTSIDE;
  }
  lightsIn.length = groups.length;
  lightsIn.fill(0);
  for (let i = 0; i < n; i++) {
    if (!walk || !shown[i] || pass[i] === PASS_BOTH) continue;
    const lights = countPointLights(kids[i], camera.layers);
    if (pass[i] >= 0) lightsIn[pass[i]] += lights; else outsideLights += lights;
  }
  if (ctx.forEachPointLight) {
    ctx.forEachPointLight((light) => {
      const top = drawnTopLevel(light, scene, camera.layers);
      if (!top) return;
      const p = passOf(top);
      if (p >= 0) lightsIn[p] = (lightsIn[p] ?? 0) + 1; else if (p === PASS_OUTSIDE) outsideLights++;
    });
  }
  // A light under a cell first met here may have opened a group with no top-level child yet: it still draws.
  for (let g = lightsIn.length; g < groups.length; g++) lightsIn[g] = 0;
  let insideLights = 0;
  for (let g = 0; g < groups.length; g++) insideLights += lightsIn[g];
  // Every pass shows pads for what it hides, so each sees the ordinary frame's point-light count.
  const total = insideLights + outsideLights;
  const backdrop = backdropVisible(camera, ctx);
  let padsWanted = 0;
  if (backdrop) padsWanted = insideLights;
  for (let g = 0; g < groups.length; g++) padsWanted = Math.max(padsWanted, total - lightsIn[g]);
  // New pads append after the snapshot (index >= n), hidden; showPads alone drives them.
  const pads = padLights(scene, padsWanted);
  const showPads = (count: number) => { for (let i = 0; i < pads.length; i++) pads[i].visible = i < count; };
  const autoClear = renderer.autoClear;
  const background = scene.background;
  const info = renderer.info;
  const infoAutoReset = info?.autoReset ?? false;
  const scissorWas = renderer.getScissorTest?.() ?? false;
  let scissored = false;
  try {
    scene.matrixWorldAutoUpdate = false;
    camera.matrixWorldAutoUpdate = false;
    if (info && infoAutoReset && (backdrop || groups.length > 1)) { info.reset(); info.autoReset = false; }
    if (backdrop) {
      for (let i = 0; i < n; i++) kids[i].visible = shown[i] && pass[i] < 0;
      showPads(insideLights);
      renderer.render(scene, camera);
      renderer.autoClear = false;
      renderer.clearDepth();
      scene.background = null;
    }
    for (let g = 0; g < groups.length; g++) {
      for (let i = 0; i < n; i++) kids[i].visible = shown[i] && (pass[i] === g || pass[i] === PASS_BOTH);
      showPads(total - lightsIn[g]);
      const r = groups[g];
      if (r) { renderer.setScissor!(r.x, r.y, r.w, r.h); renderer.setScissorTest!(true); scissored = true; }
      renderer.render(scene, camera);
      if (r) renderer.setScissorTest!(false);
      // Later groups add to this frame: no clear, and no background (a Color background always clears).
      renderer.autoClear = false;
      scene.background = null;
    }
  } finally {
    scene.matrixWorldAutoUpdate = matrixAuto;
    camera.matrixWorldAutoUpdate = cameraAuto;
    if (info) info.autoReset = infoAutoReset;
    scene.background = background;
    renderer.autoClear = autoClear;
    if (scissored && size) { renderer.setScissor!(0, 0, size.x, size.y); renderer.setScissorTest!(scissorWas); }
    for (let i = 0; i < n; i++) kids[i].visible = shown[i];
    showPads(0);
  }
}

const PASS_OUTSIDE = -1;
const PASS_BOTH = -2;

/** A cell pass group's scissor in CSS pixels (origin bottom left); null = the full view. */
interface PixelRect { x: number; y: number; w: number; h: number }

/**
 * The group a clip rectangle draws in: 0 (no scissor) for a full view or no
 * scissor support; else the group with the same pixel rectangle, a new one,
 * or, past MAX_CELL_CLIP_GROUPS, the last grown to cover it.
 */
function clipGroup(rect: ClipRect | undefined, size: THREE.Vector2 | null, groups: (PixelRect | null)[]): number {
  if (!rect || !size) return 0;
  const w = size.x, h = size.y;
  // A pixel of margin each side: the rectangle bounds the portal, never cuts it.
  const x0 = Math.max(0, Math.floor(((rect.x0 + 1) / 2) * w) - 1);
  const y0 = Math.max(0, Math.floor(((rect.y0 + 1) / 2) * h) - 1);
  const x1 = Math.min(w, Math.ceil(((rect.x1 + 1) / 2) * w) + 1);
  const y1 = Math.min(h, Math.ceil(((rect.y1 + 1) / 2) * h) + 1);
  if (x0 <= 0 && y0 <= 0 && x1 >= w && y1 >= h) return 0;
  for (let g = 1; g < groups.length; g++) {
    const r = groups[g]!;
    if (r.x === x0 && r.y === y0 && r.w === x1 - x0 && r.h === y1 - y0) return g;
  }
  if (groups.length < MAX_CELL_CLIP_GROUPS) {
    groups.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    return groups.length - 1;
  }
  const last = groups[groups.length - 1]!;
  const lx1 = Math.max(last.x + last.w, x1), ly1 = Math.max(last.y + last.h, y1);
  last.x = Math.min(last.x, x0);
  last.y = Math.min(last.y, y0);
  last.w = lx1 - last.x;
  last.h = ly1 - last.y;
  return groups.length - 1;
}

/**
 * The frame's context: with portal data, the viewer's cells are the ones
 * the flood reaches this frame, each with its clip rectangle
 * (floodIndoorView); otherwise the context as given.
 */
function floodedContext(ctx: IndoorViewContext, camera: THREE.Camera): IndoorViewContext {
  if (!ctx.portalGraph || ctx.viewerCell === undefined || !ctx.portalGraph.has(ctx.viewerCell)) return ctx;
  floodIndoorView(ctx.viewerCell, ctx.portalGraph, camera, floodClips);
  floodCells.clear();
  for (const c of floodClips.keys()) floodCells.add(c);
  return { ...ctx, cells: floodCells, cellClip: floodClips };
}

/** Per-frame scratch (renderIndoorView is not re-entrant). */
const shownScratch: boolean[] = [];
const passScratch: number[] = [];
const groupScratch: (PixelRect | null)[] = [null];
const groupCells = new Map<number, number>();
const lightsScratch: number[] = [];
const sizeScratch = new THREE.Vector2();
const floodClips = new Map<number, ClipRect>();
const floodCells = new Set<number>();

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
