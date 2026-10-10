/**
 * VISUAL.particle-surfaces-unlit (2026-09-28) — particles are LIT like any
 * object part and FOGGED unless Additive.
 *
 * Retail: a particle is a CPhysicsPart of the emitter's HW GfxObj drawn by
 * CPhysicsPart::Draw @ 0050d7a0 → D3DPolyRender::RenderMeshSubset @ 0059ca10,
 * which keeps D3DRS_LIGHTING on (SetFFLighting(true)) and adds the surface's
 * `luminosity` float as the D3D material emissive (EoL census,
 * tools/census-particle-surfaces.ts: no particle surface has the Luminous
 * bit; luminosity is 1 on most — saturated full-bright — and 0 on 176
 * emitter-surfaces: smoke, debris, leaves). SetSurface @ 0059c4d0 turns fog
 * off only for Additive (0x10000) surfaces. The light set is the parent's
 * pass: the sun + ambient outdoors, the pool lights in an env cell; the
 * normals are the GfxObj's own vertex normals (FVF 0x252). GameSky::Draw
 * @ 00506ff0 draws the sky cell's objects with fog off.
 *
 * Drives the real makeParticleMaterial / ParticleSystem / buildParticleSubmeshes /
 * resolveEmitterSprite / MaterialFactory.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import { makeParticleMaterial, ParticleSystem, type ParticleFrameSource } from '../packages/renderer/src/effects/ParticleSystem.js';
import { fallbackParticleGfx } from '../packages/renderer/src/effects/ParticleGfx.js';
import { SurfaceType } from '@ac/dat-parser/file-types/Surface.js';
import { buildParticleSubmeshes, type ParticleSurface } from '../packages/renderer/src/effects/ParticleGfx.js';
import { resolveEmitterSprite } from '../packages/renderer/src/effects/EmitterSprite.js';
import { makeEmitterFrameSource } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { retailLightingKindOf, isRetailLit, CELL_LIGHTING_KEY } from '../packages/renderer/src/models/RetailLighting.js';
import { MaterialFactory } from '../packages/renderer/src/models/MaterialFactory.js';
import { ParticleEmitterInfo } from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { openDat } from './_harness/dat.js';

const surf = (over: Partial<ParticleSurface> = {}): ParticleSurface =>
  ({ map: null, additive: false, color: 0xffffff, opacity: 1, alphaTest: 0, luminosity: 0, ...over });

/** Run a material's onBeforeCompile over three's real Lambert shader text. */
function compiled(mat: THREE.Material): { vertexShader: string; fragmentShader: string } {
  const shader = {
    uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  mat.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
  return shader;
}

const info = () => Object.assign(Object.create(ParticleEmitterInfo.prototype), {
  id: 0x32000999, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: 0,
  birthrate: 0, maxParticles: 2, initialParticles: 2, totalParticles: 2, totalSeconds: 0,
  lifespan: 5, lifespanRand: 0, offsetDir: { x: 0, y: 0, z: 1 }, minOffset: 0, maxOffset: 0,
  a: { x: 0, y: 0, z: 0 }, minA: 0, maxA: 0, b: { x: 0, y: 0, z: 0 }, minB: 0, maxB: 0,
  c: { x: 0, y: 0, z: 0 }, minC: 0, maxC: 0, startScale: 1, finalScale: 1, scaleRand: 0,
  startTrans: 0, finalTrans: 0, transRand: 0, isParentLocal: 0,
}) as ParticleEmitterInfo;

describe('makeParticleMaterial — the retail object equation, luminosity as emissive', () => {
  it('a lum-0 smoke surface is a retail-lit Lambert, fogged, no emissive', () => {
    const m = makeParticleMaterial(surf({ luminosity: 0 }), new THREE.Color(1, 1, 1), 'object');
    expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(isRetailLit(m)).toBe(true);
    expect(retailLightingKindOf(m)).toBe('object');
    expect(m.emissive.r).toBe(0);
    expect(m.fog).toBe(true);
    expect(m.blending).toBe(THREE.NormalBlending);
  });

  it('a lum-1 additive glow saturates (emissive 1) and is never fogged', () => {
    const m = makeParticleMaterial(surf({ additive: true, luminosity: 1 }), new THREE.Color(1, 1, 1), 'object');
    expect(m.emissive.toArray()).toEqual([1, 1, 1]);
    expect(m.fog).toBe(false);
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.depthWrite).toBe(false);
  });

  it('partial luminosity (0.25 / 0.5) is the raw emissive level', () => {
    expect(makeParticleMaterial(surf({ luminosity: 0.25 }), new THREE.Color(1, 1, 1), 'object').emissive.g).toBeCloseTo(0.25);
  });

  it('the compiled program is the Gouraud retail sum + the per-instance translucency before the alpha test', () => {
    const m = makeParticleMaterial(surf({ alphaTest: 0.5 }), new THREE.Color(1, 1, 1), 'object');
    const { vertexShader, fragmentShader } = compiled(m);
    expect(vertexShader).toContain('attribute float instanceAlpha;');
    expect(vertexShader).toContain('vAcInstanceAlpha = instanceAlpha;');
    expect(vertexShader).toContain('vAcLight = clamp( acSum, 0.0, 1.0 );');
    expect(fragmentShader).toContain('clamp( AC_VERTEX_LIGHT + totalEmissiveRadiance, 0.0, 1.0 )');
    const mul = fragmentShader.indexOf('diffuseColor.a *= vAcInstanceAlpha;');
    const test = fragmentShader.indexOf('#include <alphatest_fragment>');
    expect(mul).toBeGreaterThan(0);
    expect(mul).toBeLessThan(test);
    expect(m.customProgramCacheKey()).toContain('acParticleAlpha');
  });

  it('the cell pass variant compiles the sun out and the pool lights in', () => {
    const { vertexShader } = compiled(makeParticleMaterial(surf(), new THREE.Color(1, 1, 1), 'cellobject'));
    expect(vertexShader.startsWith('#define AC_CELLOBJECT')).toBe(true);
  });
});

describe('ParticleSystem draws in its parent\'s pass', () => {
  const frame = (inCell: () => boolean): ParticleFrameSource => ({
    offset: { x: 0, y: 0, z: 0 },
    getFrame: (p, q) => { p.set(0, 0, 0); q.identity(); return true; },
    inCell,
  });

  // An opaque, non-fading particle surface (Base1Image only): retail draws it
  // in its cell (RENDER.cell-particles-delayed-light-set — blended, clip-map
  // and fading draws are delayed and keep the landscape pass).
  const opaqueGfx = () => {
    const gfx = fallbackParticleGfx(1);
    gfx.gfxObjs[0][0].surface = { ...gfx.gfxObjs[0][0].surface, type: SurfaceType.Base1Image, luminosity: 0 };
    return gfx;
  };

  it('outdoors: the landscape (sun) pass; entering a cell swaps to the cell pass and back', () => {
    let inCell = false;
    const sys = new ParticleSystem(info(), 0xffffff, { gfx: opaqueGfx() }, frame(() => inCell));
    expect(sys.lightingPass).toBe('object');
    expect(retailLightingKindOf(sys.meshes[0].material as THREE.Material)).toBe('object');
    inCell = true;
    sys.update(0.016);
    expect(sys.lightingPass).toBe('cellobject');
    expect(retailLightingKindOf(sys.meshes[0].material as THREE.Material)).toBe('cellobject');
    inCell = false;
    sys.update(0.016);
    expect(retailLightingKindOf(sys.meshes[0].material as THREE.Material)).toBe('object');
    sys.dispose();
  });

  it('the frame source reads the cell pass off the parent (setCellLighting\'s tag)', () => {
    const owner = new THREE.Group();
    const hand = new THREE.Group();
    owner.add(hand);
    const src = makeEmitterFrameSource(hand, { x: 0, y: 0, z: 0 });
    expect(src.inCell?.()).toBe(false);
    owner.userData[CELL_LIGHTING_KEY] = true;
    expect(src.inCell?.()).toBe(true);
  });

  it('a sky emitter\'s particles are not fogged (GameSky::Draw)', () => {
    const sys = new ParticleSystem(info(), 0xffffff, undefined);
    expect((sys.meshes[0].material as THREE.MeshLambertMaterial).fog).toBe(true);
    sys.setFogEnabled(false);
    expect((sys.meshes[0].material as THREE.MeshLambertMaterial).fog).toBe(false);
    sys.dispose();
  });
});

describe('the particle mesh carries the GfxObj\'s vertex normals', () => {
  it('buildParticleSubmeshes writes each vertex normal, AC (x, y, z) → three (x, z, y)', () => {
    const v = (x: number, z: number) => ({ origin: { x, y: 0, z }, normal: { x: 0, y: -1, z: 0 }, uvs: [{ u: 0, v: 0 }] });
    const gfx = {
      vertexArray: { vertices: new Map([[0, v(-1, 1)], [1, v(1, 1)], [2, v(1, -1)]]) },
      polygons: [{ vertexIndices: [0, 1, 2], posUVIndices: [0, 0, 0], posSurface: 0 }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [sub] = buildParticleSubmeshes(gfx as any, [surf()]);
    expect(Array.from(sub.geometry.getAttribute('normal').array)).toEqual([0, 0, -1, 0, 0, -1, 0, 0, -1]);
  });
});

describe('MaterialFactory: an Additive object surface is not fogged either (SetSurface @ 0059c4d0)', () => {
  const surfaceBytes = (type: number): ArrayBuffer => {
    const b = new ArrayBuffer(20);
    const d = new DataView(b);
    d.setUint32(0, type, true);
    d.setUint32(4, 0xff8040, true);
    d.setFloat32(8, 0, true);
    d.setFloat32(12, 1, true);
    d.setFloat32(16, 1, true);
    return b;
  };
  const factory = (type: number) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new MaterialFactory({ getFileData: () => surfaceBytes(type) } as any, {} as any);

  it('Base1Solid | Additive → unfogged; Base1Solid | Luminous → fogged', () => {
    expect((factory(0x10001).getMaterial(0x08000001) as THREE.MeshBasicMaterial).fog).toBe(false);
    expect((factory(0x41).getMaterial(0x08000002) as THREE.MeshBasicMaterial).fog).toBe(true);
  });
});

const hasDat = fs.existsSync('dat/client_portal.dat');
describe.skipIf(!hasDat)('DAT: the sprite carries the surface luminosity', () => {
  let db: DatDatabase;
  beforeAll(() => { db = openDat('dat/client_portal.dat'); });
  const tm = { getTexture: () => new THREE.Texture() };

  it('0x32000478 (HW 0x01001AB0, surface 0x08000016: ClipMap, lum 0) is lit and fogged', () => {
    const e = new ParticleEmitterInfo(new DatReader(db.getFileData(0x32000478)!));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sprite = resolveEmitterSprite(e, db, tm as any)!;
    const s0 = sprite.gfx!.gfxObjs[0][0].surface;
    expect(s0.luminosity).toBe(0);
    expect(s0.additive).toBe(false);
    const sys = new ParticleSystem(e, 0xffffff, sprite);
    const m = sys.meshes[0].material as THREE.MeshLambertMaterial;
    expect(m.emissive.r).toBe(0);
    expect(m.fog).toBe(true);
    expect(sprite.gfx!.gfxObjs[0][0].geometry.getAttribute('normal')).toBeDefined();
    sys.dispose();
  });

  it('0x3200000B (HW 0x0100173E, surface 0x0800003F: Additive, lum 1) is full-bright and unfogged', () => {
    const e = new ParticleEmitterInfo(new DatReader(db.getFileData(0x3200000b)!));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sprite = resolveEmitterSprite(e, db, tm as any)!;
    const sys = new ParticleSystem(e, 0xffffff, sprite);
    const m = sys.meshes[0].material as THREE.MeshLambertMaterial;
    expect(m.emissive.r).toBe(1);
    expect(m.fog).toBe(false);
    sys.dispose();
  });
});
