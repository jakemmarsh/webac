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
  const env = ENV_CELL.exec(name);
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
}

/**
 * Draw one frame in PView::DrawCells order: the landscape backdrop, a
 * depth-only clear, then the viewer's cells and what stands in them. Each
 * pass hides the other pass's top-level children; every child's own
 * visibility is restored afterwards.
 */
export function renderIndoorView(
  renderer: IndoorViewRenderer, scene: THREE.Scene, camera: THREE.Camera, ctx: IndoorViewContext,
): void {
  const kids = scene.children;
  const n = kids.length;
  const shown = new Array<boolean>(n);
  const pass = new Array<IndoorPass>(n);
  for (let i = 0; i < n; i++) {
    shown[i] = kids[i].visible;
    pass[i] = shown[i] ? indoorPassOf(kids[i], ctx) : 'outside';
  }
  const autoClear = renderer.autoClear;
  try {
    for (let i = 0; i < n; i++) kids[i].visible = shown[i] && pass[i] !== 'inside';
    renderer.render(scene, camera);
    for (let i = 0; i < n; i++) kids[i].visible = shown[i] && pass[i] !== 'outside';
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, camera);
  } finally {
    renderer.autoClear = autoClear;
    for (let i = 0; i < n; i++) kids[i].visible = shown[i];
  }
}
