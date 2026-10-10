/**
 * VISUAL.dungeon-lighting-saturation — retail lights each drawn PART only
 * with the pool lights that reach it.
 *
 * `RenderDeviceD3D::DrawMesh` @ 005a0860 runs `Render::viewconeCheck(
 * gfxobj->drawing_sphere)` (local_object_center / local_object_radius =
 * object_scale · radius), then `DrawMeshInternal` → `Render::
 * minimize_object_lighting` @ 0054d480 enables a point light only when
 * |light − centre|² − (falloff + radius)² < F_EPSILON. The gate uses the
 * light's FALLOFF, not the hardware Range (falloff × 1.5). Ours lit every
 * cell object with every pool light within 1.5 × falloff, so a dungeon exit
 * portal (Setup 0x020001B3: magenta c8,00,c8 ×100, falloff 6) painted the
 * player magenta at 7.8 m in Alfreth, where retail adds nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import {
  patchLambertVertex, applyRetailLighting, cellObjectVariantOf, cellObjectBaseOf, setCellLighting,
  retailLightReachesPart, retailLightRange, partSphereOf, retailLightingKindOf,
  CELLOBJECT_DEFINE, PART_SPHERE_UNIFORM, DRAWING_SPHERE_KEY, RETAIL_F_EPSILON, RETAIL_LIGHT_RANGE_ADJUST,
} from '../packages/renderer/src/models/RetailLighting.js';
import { openDat } from './_harness/dat.js';

const PORTAL = 'dat/client_portal.dat';
const datPresent = existsSync(PORTAL);

describe('minimize_object_lighting — the per-part reach test (JS mirror)', () => {
  it('Alfreth: the exit portal (falloff 6) does not reach a part 7.8 m away, though it is inside the 9 m hardware range', () => {
    const portal = [0, 0, 0];
    expect(7.8).toBeLessThan(retailLightRange(6));
    expect(retailLightReachesPart(portal, 6, [7.8, 0, 0], 0.5)).toBe(false);
    expect(retailLightReachesPart(portal, 6, [6.4, 0, 0], 0.5)).toBe(true);
  });

  it('the boundary is falloff + radius, with F_EPSILON slack', () => {
    expect(RETAIL_F_EPSILON).toBe(0.0002);
    expect(retailLightReachesPart([0, 0, 0], 3, [0, 4, 0], 1)).toBe(true); // 16 − 16 = 0 < ε
    expect(retailLightReachesPart([0, 0, 0], 3, [0, 4.001, 0], 1)).toBe(false);
    // A bigger part (object scale already folded into the radius) is reached from further.
    expect(retailLightReachesPart([0, 0, 0], 3, [0, 0, 5], 2.5)).toBe(true);
  });
});

describe('VISUAL.dungeon-lighting-saturation — the cellobject shader gates the point loop by the part sphere', () => {
  const vsrc = THREE.ShaderLib.lambert.vertexShader;
  const UNROLL = /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;

  it('the gate sits inside the unrolled point loop, under the cellobject define only', () => {
    const cell = patchLambertVertex(vsrc, 'cellobject');
    expect(cell).toContain(`uniform vec4 ${PART_SPHERE_UNIFORM};`);
    expect(cell).toContain(`float falloff = light.distance / ${RETAIL_LIGHT_RANGE_ADJUST};`);
    expect(cell).toContain(`return dot( dc, dc ) - ( falloff + r ) * ( falloff + r ) < ${RETAIL_F_EPSILON};`);
    const numbered = cell.replace(/NUM_DIR_LIGHTS/g, '1').replace(/NUM_POINT_LIGHTS/g, '3');
    const loops = [...numbered.matchAll(UNROLL)];
    const pointLoop = loops.find((l) => l[3].includes('acPointLight'))!;
    expect(pointLoop[3]).toContain(`#ifdef ${CELLOBJECT_DEFINE}`);
    expect(pointLoop[3]).toContain('if ( acPartLit( pointLights[ i ], acPartC.xyz, acPartR ) )');
    // The centre goes through the instance matrix for the batched furniture.
    expect(cell).toMatch(/#ifdef USE_INSTANCING\s+acPartC = instanceMatrix \* acPartC;/);
    // Every other kind compiles the gate out (same text, no define).
    expect(patchLambertVertex(vsrc, 'object').startsWith(`#define ${CELLOBJECT_DEFINE}`)).toBe(false);
  });
});

describe('VISUAL.dungeon-lighting-saturation — one cellobject variant per (material, drawing sphere)', () => {
  function geom(sphere?: number[]): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    if (sphere) g.userData[DRAWING_SPHERE_KEY] = sphere;
    return g;
  }

  it('the variant carries the part sphere; same sphere → same variant; different → different, same base', () => {
    const base = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object');
    const a = cellObjectVariantOf(base, geom([0, 1, 0, 0.8]));
    const a2 = cellObjectVariantOf(base, geom([0, 1, 0, 0.8]));
    const b = cellObjectVariantOf(base, geom([0, 2, 0, 1.5]));
    expect(a).toBe(a2);
    expect(b).not.toBe(a);
    expect(partSphereOf(a)).toEqual([0, 1, 0, 0.8]);
    expect(partSphereOf(b)).toEqual([0, 2, 0, 1.5]);
    expect(retailLightingKindOf(b)).toBe('cellobject');
    expect(cellObjectBaseOf(a)).toBe(base);
    expect(cellObjectBaseOf(b)).toBe(base);
    // No sphere known: every light reaches (w < 0), as before.
    expect(partSphereOf(cellObjectVariantOf(base))).toEqual([0, 0, 0, -1]);
  });

  it('the sphere is handed to the compiled program as a uniform', () => {
    const base = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object');
    const v = cellObjectVariantOf(base, geom([1, 2, 3, 4]));
    const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
    v.onBeforeCompile(shader as never, {} as never);
    expect((shader.uniforms[PART_SPHERE_UNIFORM].value as THREE.Vector4).toArray()).toEqual([1, 2, 3, 4]);
  });

  it('setCellLighting picks each mesh\'s variant by its own geometry', () => {
    const base = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object');
    const root = new THREE.Group();
    const m1 = new THREE.Mesh(geom([0, 0, 0, 1]), base);
    const m2 = new THREE.Mesh(geom([0, 0, 0, 2]), base);
    root.add(m1, m2);
    setCellLighting(root, true);
    expect(partSphereOf(m1.material as THREE.Material)).toEqual([0, 0, 0, 1]);
    expect(partSphereOf(m2.material as THREE.Material)).toEqual([0, 0, 0, 2]);
    setCellLighting(root, false);
    expect(m1.material).toBe(base);
  });
});

describe.skipIf(!datPresent)('VISUAL.dungeon-lighting-saturation — ModelRenderer tags each part with its DAT drawing sphere', () => {
  let mr: import('../packages/renderer/src/models/ModelRenderer.js').ModelRenderer;
  beforeAll(async () => {
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const portalDb = openDat(PORTAL);
    mr = new ModelRenderer(portalDb, new MaterialFactory(portalDb, new TextureManager(portalDb)));
  });

  it('the dungeon exit portal\'s parts carry the drawing-BSP root sphere in geometry axes (AC x, z, y)', async () => {
    const { SetupModel } = await import('../packages/dat-parser/src/index.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const portalDb = openDat(PORTAL);
    const setup = new SetupModel(new DatReader(portalDb.getFileData(0x020001b3)!));
    let checked = 0;
    for (const partId of setup.parts) {
      const gfx = mr.loadGfxObj(partId);
      const s = (gfx?.drawingBSP?.rootNode as { sphere?: { origin: { x: number; y: number; z: number }; radius: number } } | undefined)?.sphere;
      const group = mr.createMesh(partId);
      if (!s || !group) continue;
      for (const child of group.children) {
        expect((child as THREE.Mesh).geometry.userData[DRAWING_SPHERE_KEY]).toEqual([s.origin.x, s.origin.z, s.origin.y, s.radius]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
