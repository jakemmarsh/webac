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
 */
export function renderIndoorView(
  renderer: IndoorViewRenderer, scene: THREE.Scene, camera: THREE.Camera, ctx: IndoorViewContext,
): void {
  const kids = scene.children;
  const n = kids.length;
  const shown = new Array<boolean>(n);
  const pass = new Array<IndoorPass>(n);
  let insideLights = 0;
  let outsideLights = 0;
  for (let i = 0; i < n; i++) {
    shown[i] = kids[i].visible;
    pass[i] = shown[i] ? indoorPassOf(kids[i], ctx) : 'outside';
    if (!shown[i] || pass[i] === 'both') continue;
    const lights = countPointLights(kids[i], camera.layers);
    if (pass[i] === 'inside') insideLights += lights; else outsideLights += lights;
  }
  // New pads append after the snapshot (index >= n), hidden; showPads alone drives them.
  const pads = padLights(scene, Math.max(insideLights, outsideLights));
  const showPads = (count: number) => { for (let i = 0; i < pads.length; i++) pads[i].visible = i < count; };
  const autoClear = renderer.autoClear;
  const background = scene.background;
  const info = renderer.info;
  const infoAutoReset = info?.autoReset ?? false;
  try {
    if (info && infoAutoReset) { info.reset(); info.autoReset = false; }
    for (let i = 0; i < n; i++) kids[i].visible = shown[i] && pass[i] !== 'inside';
    showPads(insideLights);
    renderer.render(scene, camera);
    for (let i = 0; i < n; i++) kids[i].visible = shown[i] && pass[i] !== 'outside';
    showPads(outsideLights);
    renderer.autoClear = false;
    renderer.clearDepth();
    scene.background = null;
    renderer.render(scene, camera);
  } finally {
    if (info) info.autoReset = infoAutoReset;
    scene.background = background;
    renderer.autoClear = autoClear;
    for (let i = 0; i < n; i++) kids[i].visible = shown[i];
    showPads(0);
  }
}
