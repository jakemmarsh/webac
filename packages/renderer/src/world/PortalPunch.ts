/**
 * VISUAL.landblock-statics-missing-vs-retail — building portal "punch".
 *
 * Retail draws the landscape terrain normally, also under sunken buildings
 * (Xarabydun's dungeon pit, 0x01002bef at 0x934B, sits on terrain that is
 * flat at the pit's rim). When it then draws a building
 * (RenderDeviceD3D::DrawBuilding @ 0059f2a0), the portals-only pass first
 * draws each portal polygon of the building's drawing BSP
 * (BSPPORTAL::portal_draw_portals_only @ 0053d870 → PView::DrawPortal @
 * 005a5ab0 → ConstructView @ 005a59a0, which draws it only while the viewer
 * is on its enterable side) through D3DPolyRender::DrawPortalPolyInternal
 * @ 0059bc90:
 *
 *   SetDepthBufferMode(DEPTHTEST_ALWAYS, depth write on); vertex z = 0.99999899
 *   (the far plane); alpha 0 under SRCALPHA blending (invisible).
 *
 * That erases the terrain's depth inside the portal's screen footprint, so
 * the building's cells drawn next (PView::DrawCells @ 005a4840) show
 * through the terrain where the doorway / pit opening is.
 *
 * Here: the terrain base meshes draw first among the opaque objects
 * (TERRAIN_RENDER_ORDER), the punch next (PORTAL_PUNCH_RENDER_ORDER; see
 * createPortalPunch for its two passes), then everything else, so the
 * cells beat the terrain's depth inside the opening while the terrain's
 * colour stays wherever no cell covers it, as in retail. Our terrain blend
 * / road overlays are transparent and draw after every opaque cell, so they
 * skip the pixels the punch marked with PORTAL_PUNCH_STENCIL_BIT (retail
 * draws those layers with the terrain, before the punch).
 */
import * as THREE from 'three';
import { markSharedMaterial } from '../models/MaterialOwnership.js';

/** The stencil bit the punch writes and terrain tests. */
export const PORTAL_PUNCH_STENCIL_BIT = 0x80;

/** Terrain base meshes: the first opaque draws after the sky (renderOrder −100 / −50 + i). */
export const TERRAIN_RENDER_ORDER = -10;

/** After the terrain, ahead of every other opaque object (renderOrder 0): mark pass; erase pass at +1. */
export const PORTAL_PUNCH_RENDER_ORDER = -5;

/**
 * DrawPortalPolyInternal's z for the punch pass (maxZ1 = 7, bit 0 set):
 * ___real_3f7fffef = 0.99999899 in D3D's [0, 1] depth range, i.e.
 * 2·z − 1 in GL's [−1, 1] NDC.
 */
export const PORTAL_PUNCH_D3D_Z = 0.99999899;
const PORTAL_PUNCH_NDC_Z = 2 * PORTAL_PUNCH_D3D_Z - 1;

/** DrawPortalPolyInternal's guard constants (±12.0, ___real_4028000000000000). */
const RETAIL_PORTAL_EDGE = 12;

interface Vec3 { x: number; y: number; z: number }

/**
 * DrawPortalPolyInternal skips a portal polygon whose vertices ALL lie on
 * x = 12, x = −12, y = 12 or y = −12 (model-local coords). True when the
 * polygon is drawn.
 */
export function retailPortalPunchDrawn(localVerts: readonly Vec3[]): boolean {
  if (localVerts.length === 0) return false;
  let allXPos = true, allXNeg = true, allYPos = true, allYNeg = true;
  for (const v of localVerts) {
    if (v.x !== RETAIL_PORTAL_EDGE) allXPos = false;
    if (v.x !== -RETAIL_PORTAL_EDGE) allXNeg = false;
    if (v.y !== RETAIL_PORTAL_EDGE) allYPos = false;
    if (v.y !== -RETAIL_PORTAL_EDGE) allYNeg = false;
  }
  return !allXPos && !allXNeg && !allYPos && !allYNeg;
}

/**
 * Make a terrain overlay material skip pixels a portal punch marked. three.js only
 * enables the stencil test while `stencilWrite` is set, so the write mask is
 * zeroed instead. Idempotent.
 */
export function applyPortalPunchMask(material: THREE.Material | THREE.Material[]): void {
  for (const m of Array.isArray(material) ? material : [material]) {
    m.stencilWrite = true;
    m.stencilWriteMask = 0;
    m.stencilRef = PORTAL_PUNCH_STENCIL_BIT;
    m.stencilFuncMask = PORTAL_PUNCH_STENCIL_BIT;
    m.stencilFunc = THREE.NotEqualStencilFunc;
  }
}

let markMaterial: THREE.MeshBasicMaterial | null = null;
let eraseMaterial: THREE.MeshBasicMaterial | null = null;

function invisible(): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    colorWrite: false, // alpha 0 under SRCALPHA / INVSRCALPHA
    side: THREE.DoubleSide, // SetCullMode(CULLMODE_NONE)
    fog: false,
  });
}

/**
 * Punch pass 1: mark the stencil bit where the portal polygon is in front
 * of what is drawn so far (the terrain). No colour, no depth write.
 */
export function portalPunchMarkMaterial(): THREE.MeshBasicMaterial {
  if (!markMaterial) {
    const m = invisible();
    m.depthWrite = false;
    m.depthTest = true;
    m.stencilWrite = true;
    m.stencilWriteMask = PORTAL_PUNCH_STENCIL_BIT;
    m.stencilRef = PORTAL_PUNCH_STENCIL_BIT;
    m.stencilFunc = THREE.AlwaysStencilFunc;
    m.stencilZPass = THREE.ReplaceStencilOp;
    markMaterial = markSharedMaterial(m);
  }
  return markMaterial;
}

/**
 * Punch pass 2: on the marked pixels, write the far-plane depth
 * (DEPTHTEST_ALWAYS, depth write, z = PORTAL_PUNCH_D3D_Z). No colour.
 */
export function portalPunchEraseMaterial(): THREE.MeshBasicMaterial {
  if (!eraseMaterial) {
    const m = invisible();
    m.depthWrite = true;
    m.depthTest = true;
    m.depthFunc = THREE.AlwaysDepth; // DEPTHTEST_ALWAYS
    m.stencilWrite = true; // three enables the stencil test only with this set
    m.stencilWriteMask = 0;
    m.stencilRef = PORTAL_PUNCH_STENCIL_BIT;
    m.stencilFuncMask = PORTAL_PUNCH_STENCIL_BIT;
    m.stencilFunc = THREE.EqualStencilFunc;
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>\n\tgl_Position.z = ${PORTAL_PUNCH_NDC_Z.toFixed(8)} * gl_Position.w;`,
      );
    };
    m.customProgramCacheKey = () => 'portal-punch-erase';
    eraseMaterial = markSharedMaterial(m);
  }
  return eraseMaterial;
}

/**
 * A gate's portal punch: its portal polygons (AC world coords, Z up) as
 * triangle fans (DrawPrimitiveUP(D3DPT_TRIANGLEFAN)), drawn by the mark and
 * erase passes; null when no polygon has 3 vertices. Starts hidden: the
 * gate pass shows it while the gate is open.
 *
 * Retail's single pass tests ALWAYS, so it also clears terrain lying in
 * front of the portal; its per-land-cell draw order (DrawBlock: terrain,
 * then that cell's building) lets nearer cells' terrain re-cover it. Here
 * all terrain draws first, so pass 1 depth-tests the real portal depth
 * instead: terrain in front of the opening keeps covering it.
 */
export function createPortalPunch(polys: readonly (readonly Vec3[])[]): THREE.Group | null {
  const positions: number[] = [];
  for (const poly of polys) {
    if (poly.length < 3) continue;
    const a = poly[0];
    for (let i = 1; i + 1 < poly.length; i++) {
      const b = poly[i], c = poly[i + 1];
      // AC (x, y, z) → three (x, z, y)
      positions.push(a.x, a.z, a.y, b.x, b.z, b.y, c.x, c.z, c.y);
    }
  }
  if (positions.length === 0) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeBoundingSphere();
  const group = new THREE.Group();
  group.name = 'portal_punch';
  const mark = new THREE.Mesh(geom, portalPunchMarkMaterial());
  mark.renderOrder = PORTAL_PUNCH_RENDER_ORDER;
  const erase = new THREE.Mesh(geom, portalPunchEraseMaterial());
  erase.renderOrder = PORTAL_PUNCH_RENDER_ORDER + 1;
  for (const m of [mark, erase]) {
    m.raycast = () => {}; // never a pick / camera-collision target
    group.add(m);
  }
  group.visible = false;
  return group;
}
