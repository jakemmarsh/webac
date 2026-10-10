/**
 * VISUAL.lifestone-crystal-glow — a lit surface's DAT luminosity is its D3D
 * Emissive (`D3DPolyRender::RenderMeshSubset` @ 0059ca10, decomp :399334).
 *
 * The lifestone crystal (GfxObj 0x01000CFA, Setup 0x020002EE) uses surface
 * 0x080011DE: type 0x12 (Base1Image | Translucent), translucency 0.25,
 * luminosity 0.75. Retail lights it with that 0.75 on top of the world light,
 * so the crystal reaches its raw texel (cyan-white base); we dropped the
 * luminosity unless the Luminous type flag was set and drew it dark blue.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { MaterialFactory } from '@ac/renderer/models/MaterialFactory.js';
import { Surface, SurfaceType } from '@ac/dat-parser/file-types/Surface.js';
import {
  SURFACE_LUMINOSITY_KEY, setMaterialLuminosity, surfaceLuminosityOf, patchLambertFragment,
} from '../packages/renderer/src/models/RetailLighting.js';
import { applyLightingLevels, LIGHT_HIGH, LIGHT_LOW, setObjectLighting } from '../packages/renderer/src/world/SelectionLighting.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { EnvCellRenderer } from '../packages/renderer/src/world/EnvCellRenderer.js';
import { AnimationHookType } from '@ac/dat-parser/file-types/AnimationHook.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

function factoryFor(surface: Surface): MaterialFactory {
  const tex = { image: { width: 1, height: 1 }, needsUpdate: true } as unknown as THREE.DataTexture;
  const tm = { getTexture: () => tex, getTextureWithPalette: () => tex } as unknown as ConstructorParameters<typeof MaterialFactory>[1];
  const db = { getFileData: () => null } as unknown as ConstructorParameters<typeof MaterialFactory>[0];
  const f = new MaterialFactory(db, tm);
  // @ts-expect-error reach the private loader with a synthetic surface
  f.loadSurface = () => surface;
  return f;
}

function surfaceOf(type: number, luminosity: number, translucency = 0): Surface {
  const s = new Surface();
  s.type = type;
  s.origTextureId = 0x05002b92;
  s.translucency = translucency;
  s.luminosity = luminosity;
  s.diffuse = 1;
  return s;
}

/** The lifestone crystal surface 0x080011DE as the DAT stores it. */
const CRYSTAL = (): Surface => surfaceOf(SurfaceType.Base1Image | SurfaceType.Translucent, 0.75, 0.25);

describe('VISUAL.lifestone-crystal-glow — surface luminosity is the lit material emissive', () => {
  it('a lit surface with luminosity 0.75 draws Lambert with emissive grey 0.75', () => {
    const m = factoryFor(CRYSTAL()).getMaterial(0x080011de) as THREE.MeshLambertMaterial;
    expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect([m.emissive.r, m.emissive.g, m.emissive.b]).toEqual([0.75, 0.75, 0.75]);
    expect(m.emissiveIntensity).toBe(1);
    expect(m.opacity).toBeCloseTo(0.75, 6);
    expect(surfaceLuminosityOf(m)).toBe(0.75);
  });

  it('a surface without luminosity keeps a black emissive and no record', () => {
    const m = factoryFor(surfaceOf(SurfaceType.Base1Image, 0)).getMaterial(0x08000001) as THREE.MeshLambertMaterial;
    expect(m.emissive.r).toBe(0);
    expect(m.userData[SURFACE_LUMINOSITY_KEY]).toBeUndefined();
  });

  it('the emissive sits inside the clamped vertex colour that modulates the texel', () => {
    const frag = patchLambertFragment(THREE.ShaderLib.lambert.fragmentShader, 'object');
    expect(frag).toContain('clamp( AC_VERTEX_LIGHT + totalEmissiveRadiance, 0.0, 1.0 )');
  });

  it('the selection blink cannot dim a luminous surface; it still sets the diffuse', () => {
    const m = factoryFor(CRYSTAL()).getMaterial(0x080011de) as THREE.MeshLambertMaterial;
    const root = new THREE.Group().add(new THREE.Mesh(new THREE.BufferGeometry(), m));
    const copies = new Map();
    setObjectLighting(root, LIGHT_LOW, copies);
    const copy = (root.children[0] as THREE.Mesh).material as THREE.MeshLambertMaterial;
    expect(copy).not.toBe(m);
    expect(copy.emissive.r).toBe(0.75); // RenderMeshSubset: the surface's luminosity wins
    expect(copy.color.r).toBeLessThan(1); // LIGHT_LOW diffuse 0.35 still applies
    expect(m.emissive.r).toBe(0.75);

    const plain = factoryFor(surfaceOf(SurfaceType.Base1Image, 0)).getMaterial(0x08000002) as THREE.MeshLambertMaterial;
    const plainCopy = plain.clone();
    applyLightingLevels(plainCopy, LIGHT_HIGH);
    expect(plainCopy.emissive.r).toBe(0.99);
  });

  it('setMaterialLuminosity writes Emissive = grey(value) unless the surface has its own', () => {
    const m = new THREE.MeshLambertMaterial();
    m.emissiveIntensity = 3;
    setMaterialLuminosity(m, 0.4);
    expect(m.emissive.r).toBeCloseTo(0.4, 6);
    expect(m.emissiveIntensity).toBe(1);
    m.userData[SURFACE_LUMINOSITY_KEY] = 0.75;
    setMaterialLuminosity(m, 0);
    expect(m.emissive.r).toBe(0.75);
  });

  it('a Luminous animation hook sets the part luminosity (CPhysicsPart::SetLuminosity), and leaves a luminous surface lit', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const player = new PhysicsScriptPlayer({ getListenerPos: () => ({ x: 0, y: 0, z: 0 }) } as any);
    const plain = new THREE.MeshLambertMaterial();
    const crystal = factoryFor(CRYSTAL()).getMaterial(0x080011de) as THREE.MeshLambertMaterial;
    const anchor = new THREE.Group();
    anchor.add(new THREE.Mesh(new THREE.BufferGeometry(), plain), new THREE.Mesh(new THREE.BufferGeometry(), crystal));
    player.executeHook({ hookType: AnimationHookType.Luminous, direction: 0, start: 0, end: 0.6, time: 0 } as never, anchor);
    const [a, b] = anchor.children.map((c) => (c as THREE.Mesh).material as THREE.MeshLambertMaterial);
    expect(a.emissive.r).toBeCloseTo(0.6, 6);
    expect(b.emissive.r).toBe(0.75);
    expect(crystal.emissive.r).toBe(0.75); // the shared factory material is untouched
  });

  it('env-cell geometry drops the surface luminosity (burned-in vertex emissive)', () => {
    const factory = factoryFor(CRYSTAL());
    const r = new EnvCellRenderer({} as never, {} as never, factory);
    const v = (x: number, y: number) => ({ origin: { x, y, z: 0 }, normal: { x: 0, y: 0, z: 1 }, uvs: [{ u: x, v: y }] });
    const cellStruct = {
      vertexArray: { vertices: new Map([[0, v(0, 0)], [1, v(1, 0)], [2, v(0, 1)]]) },
      polygons: new Map([[0, { stippling: 0, sidesType: 0, posSurface: 0, negSurface: 0, vertexIndices: [0, 1, 2], posUVIndices: [0, 0, 0], negUVIndices: [] }]]),
    };
    const group = r.buildCellGeometry(cellStruct as never, [0x080011de]);
    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o); });
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) {
      const mat = mesh.material as THREE.MeshLambertMaterial;
      expect(mat.emissive.r).toBe(0);
      expect(surfaceLuminosityOf(mat)).toBe(0);
    }
    // ...while the factory's object material keeps its glow.
    expect((factory.getMaterial(0x080011de) as THREE.MeshLambertMaterial).emissive.r).toBe(0.75);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('VISUAL.lifestone-crystal-glow — the DAT lifestone (needs portal.dat)', () => {
  let factory: MaterialFactory;
  beforeAll(async () => {
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const portal = openDat(DAT_PATHS.portal);
    factory = new MaterialFactory(portal, new TextureManager(portal));
  });

  it('the crystal surface 0x080011DE draws with emissive 0.75, the leg surfaces with none', () => {
    const crystal = factory.getMaterial(0x080011de) as THREE.MeshLambertMaterial;
    expect(crystal).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(crystal.emissive.r).toBeCloseTo(0.75, 6);
    expect(crystal.transparent).toBe(true);
    expect(crystal.opacity).toBeCloseTo(0.75, 6);
    const leg = factory.getMaterial(0x080011df) as THREE.MeshLambertMaterial;
    expect(leg.emissive.r).toBe(0);
  });
});
