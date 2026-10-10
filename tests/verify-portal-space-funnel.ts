/**
 * VISUAL2.1 — Portal space is walled with the REAL DAT membrane texture (off
 * Setup 0x02000306), NOT a landblock-0x526A rock-tunnel flythrough.
 *
 * Ground truth (portal-space-research 2026-06-12 + geometry re-derivation
 * 2026-06-12): the retail "In Portal Space" object is Setup 0x02000306
 * "portalspace_background" — two FLAT fan-shaped membrane sheets (GfxObj
 * 0x0100080B, each ±5.6 thin) that spin facing the camera. Rendered literally
 * that reads as "a ring with a black hole rotating", not the FPV wormhole the
 * transition should feel like, so PortalSpaceRenderer harvests the funnel's
 * tunnel-wall MATERIAL/TEXTURE and re-walls a long cylinder the camera flies down
 * (texture stretched into radial warp streaks + forward scroll + swirl + the
 * decompiled barrel-roll). The funnel has TWO surfaces: the OPAQUE backing
 * (surface 0x08000C32 / SurfaceTexture 0x050001B2, 128², avg RGB ~[40,56,69] —
 * dark blue-grey, the real wall colour the reference shows) and the translucent
 * membrane (0x08000C31 / 0x05000E0F, 32², purple — glow accent only). The renderer
 * harvests the OPAQUE backing. This test pins the dependency: the funnel setup
 * loads, builds drawable meshes, and exposes a TEXTURED OPAQUE (backing) material.
 * DAT-gated — skips in CI without dat/.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { TextureManager } from '@ac/renderer/models/TextureManager.js';
import { MaterialFactory } from '@ac/renderer/models/MaterialFactory.js';
import { ModelRenderer } from '@ac/renderer/models/ModelRenderer.js';
import { SetupModelRenderer } from '@ac/renderer/models/SetupModelRenderer.js';
import { openDat } from './_harness/dat.js';

const PORTAL_SETUP_ID = 0x02000306;
const PORTAL_GFXOBJ_ID = 0x0100080b;

const hasDats = fs.existsSync('dat/client_portal.dat');
let setupModelRenderer: SetupModelRenderer;

beforeAll(() => {
  if (!hasDats) return;
  const portalDb = openDat('dat/client_portal.dat');
  const textureManager = new TextureManager(portalDb);
  const materialFactory = new MaterialFactory(portalDb, textureManager);
  const modelRenderer = new ModelRenderer(portalDb, materialFactory);
  setupModelRenderer = new SetupModelRenderer(portalDb, modelRenderer);
});

describe.skipIf(!hasDats)('VISUAL2.1: portal space uses the DAT funnel mesh', () => {
  it('loads Setup 0x02000306 "portalspace_background"', () => {
    const setup = setupModelRenderer.loadSetupModel(PORTAL_SETUP_ID);
    expect(setup).not.toBeNull();
    // Both parts are the funnel GfxObj 0x0100080B.
    expect(setup!.parts.length).toBeGreaterThanOrEqual(1);
    expect(setup!.parts).toContain(PORTAL_GFXOBJ_ID);
  });

  it('builds a drawable funnel mesh group from the setup', () => {
    const group = setupModelRenderer.createSetupMesh(PORTAL_SETUP_ID);
    expect(group).not.toBeNull();
    let meshes = 0, verts = 0;
    group!.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        meshes++;
        const pos = mesh.geometry.getAttribute('position');
        if (pos) verts += pos.count;
      }
    });
    // The funnel GfxObj has 352 verts across its parts — real curved geometry,
    // not flat rock facets.
    expect(meshes).toBeGreaterThan(0);
    expect(verts).toBeGreaterThan(100);
  });

  it('the funnel exposes a TEXTURED OPAQUE (backing) material — the dark blue-grey wall the tube harvests', () => {
    const group = setupModelRenderer.createSetupMesh(PORTAL_SETUP_ID)!;
    let translucent = 0;
    let opaqueWallTex: THREE.Texture | null = null;
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const mat = m as THREE.MeshStandardMaterial;
        if (mat.transparent) translucent++;
        // The opaque backing (surface 0x08000C32 / tex 0x050001B2) is what the
        // renderer harvests for the wall colour — mirror its selection here.
        else if (mat.map && !opaqueWallTex) opaqueWallTex = mat.map;
      }
    });
    // Both surfaces present: the translucent membrane (glow accent) AND…
    expect(translucent).toBeGreaterThan(0);
    // …the opaque backing with a texture — without it the tube has no wall colour.
    expect(opaqueWallTex, 'no opaque backing material with a .map to harvest').not.toBeNull();
  });
});
