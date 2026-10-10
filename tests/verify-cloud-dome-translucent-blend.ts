/**
 * VISUAL.night-sky-clouds-vs-retail — the Cloudy/Rainy cloud dome blends
 * like an alpha cloud layer, not additively.
 *
 * Retail A/B 2026-10-04 (13 towns, Cloudy night): retail's clouds are lit
 * magenta (the night ambient 0xC864FF × 0.40 over the texel) and hide the
 * stars; ours drew tan unlit clouds with the stars shining through them.
 * The cloud dome 0x01004C35's surface 0x08000023 is type 0x10114 =
 * Additive | Alpha | Translucent | Base1ClipMap. `D3DPolyRender::SetSurface`
 * @ 0059c4d0 first picks SRCALPHA/ONE for Alpha + Additive, then, because the
 * surface is Translucent AND alpha-tested (ClipMap), forces
 * SRCALPHA/INVSRCALPHA with the alpha test off. It is the only surface in
 * the EoL portal.dat with that flag combination.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { MaterialFactory, surfaceBlendsAdditive } from '../packages/renderer/src/models/MaterialFactory.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import { openDat } from './_harness/dat.js';

const PORTAL = 'dat/client_portal.dat';

describe('surfaceBlendsAdditive (D3DPolyRender::SetSurface blend choice)', () => {
  it('keeps plain Additive surfaces additive', () => {
    expect(surfaceBlendsAdditive(0x10000)).toBe(true);
    // Rain domes: Additive | Alpha | Translucent | Base1Image (no clip map).
    expect(surfaceBlendsAdditive(0x10112)).toBe(true);
    // Additive clip map that is not translucent: alpha-tested SRCALPHA/ONE.
    expect(surfaceBlendsAdditive(0x10104)).toBe(true);
  });

  it('a translucent clip map loses the additive blend', () => {
    expect(surfaceBlendsAdditive(0x10114)).toBe(false);
    expect(surfaceBlendsAdditive(0x10014)).toBe(false);
  });

  it('non-additive surfaces are never additive', () => {
    expect(surfaceBlendsAdditive(0x102)).toBe(false);
    expect(surfaceBlendsAdditive(0x114)).toBe(false);
  });
});

describe.skipIf(!existsSync(PORTAL))('the cloud dome surface 0x08000023 (DAT)', () => {
  let factory: MaterialFactory;
  beforeAll(() => {
    const portalDb = openDat(PORTAL);
    factory = new MaterialFactory(portalDb, new TextureManager(portalDb));
  });

  it('is the Additive|Alpha|Translucent|ClipMap surface', () => {
    expect(factory.getSurface(0x08000023)?.type).toBe(0x10114);
  });

  it('builds an alpha-blended material with no alpha test and no fog', () => {
    const mat = factory.getMaterial(0x08000023) as THREE.MeshBasicMaterial;
    expect(mat.blending).toBe(THREE.NormalBlending);
    expect(mat.transparent).toBe(true);
    expect(mat.alphaTest).toBe(0);
    expect(mat.depthWrite).toBe(false);
    expect(mat.fog).toBe(false);
  });

  it('a genuinely additive surface still blends additively', () => {
    // The rain dome surface (type 0x10112) — find it through its GfxObj.
    const rain = factory.getMaterial(0x080000c5) as THREE.MeshBasicMaterial;
    expect(factory.getSurface(0x080000c5)!.type & 0x10000).toBe(0x10000);
    expect(rain.blending).toBe(THREE.AdditiveBlending);
  });

  it('SkyboxRenderer draws the Cloudy cloud dome lit and alpha-composited', () => {
    const cloudy = {
      tickSize: 30, lightTickSize: 30,
      dayGroups: [{
        chanceOfOccur: 5, dayName: 'Cloudy',
        skyObjects: [{
          beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0,
          texVelocityX: 0.005, texVelocityY: -0.0073,
          defaultGFXObjectId: 0x01004c35, defaultPESObjectId: 0, properties: 2,
        }],
        skyTime: [0, 0.5].map(begin => ({
          begin, dirBright: 0.25, dirHeading: 90, dirPitch: 0.9, dirColor: 0xffdcdcdc,
          ambBright: 0.4, ambColor: 0xffc864ff, minWorldFog: 0, maxWorldFog: 400,
          worldFogColor: 0xff171728, worldFog: 1,
          skyObjReplace: [{ objectIndex: 0, gfxObjId: 0, rotate: 0, transparent: 0, luminosity: 15, maxBright: 15 }],
        })),
      }],
    } as never;
    const sky = new SkyboxRenderer(cloudy);
    // The real GfxObj through the real MaterialFactory.
    const modelRenderer = {
      createMesh: () => {
        const g = new THREE.Group();
        const m = new THREE.Mesh(new THREE.BufferGeometry(), factory.getMaterial(0x08000023));
        m.userData.surfaceId = 0x08000023;
        g.add(m);
        return g;
      },
      getSurface: (id: number) => factory.getSurface(id),
    } as never;
    sky.initSkyObjects(modelRenderer);
    sky.updateTimeOfDay(0.02);
    const entries = (sky as unknown as {
      skyObjectEntries: Array<{ materials: THREE.Material[]; litMaterials: Array<{ material: THREE.MeshLambertMaterial }> }>;
    }).skyObjectEntries;
    expect(entries).toHaveLength(1);
    expect(entries[0].materials).toHaveLength(0);
    expect(entries[0].litMaterials).toHaveLength(1);
    const lit = entries[0].litMaterials[0].material;
    expect(lit.blending).toBe(THREE.CustomBlending);
    expect(lit.blendSrc).toBe(THREE.SrcAlphaFactor);
    expect(lit.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    // Emissive = the replace luminosity (15 → 0.15), opaque at transparent 0.
    expect(lit.emissive.r).toBeCloseTo(0.15, 5);
    expect(lit.opacity).toBeCloseTo(1, 5);
  });
});

describe('VISUAL.night-sky-clouds-vs-retail: sky meshes sit at the viewer landblock origin', () => {
  // GameSky::UpdatePosition @ 00506dd0 keeps a non-weather sky object at
  // (0, 0, 0) of the viewer's landblock; a weather object (props & 0x4)
  // takes the viewer's position at z −120 (skyObjectFrame).
  function skyWith(properties: number): SkyboxRenderer {
    const sky = new SkyboxRenderer({
      tickSize: 30, lightTickSize: 30,
      dayGroups: [{
        chanceOfOccur: 5, dayName: 'Test',
        skyObjects: [{
          beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0, texVelocityX: 0, texVelocityY: 0,
          defaultGFXObjectId: 0x010015ef, defaultPESObjectId: 0, properties,
        }],
        skyTime: [0, 0.5].map(begin => ({
          begin, dirBright: 0.25, dirHeading: 90, dirPitch: 0.9, dirColor: 0xffdcdcdc,
          ambBright: 0.4, ambColor: 0xffc864ff, minWorldFog: 0, maxWorldFog: 400,
          worldFogColor: 0xff171728, worldFog: 1, skyObjReplace: [],
        })),
      }],
    } as never);
    sky.initSkyObjects({
      createMesh: () => new THREE.Group().add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial())),
      getSurface: () => null,
    } as never);
    return sky;
  }
  const worldPos = (sky: SkyboxRenderer): THREE.Vector3 => {
    const group = sky.skyObjectsGroup!;
    group.updateMatrixWorld(true);
    const e = (sky as unknown as { skyObjectEntries: Array<{ mesh: THREE.Object3D }> }).skyObjectEntries[0];
    return e.mesh.getWorldPosition(new THREE.Vector3());
  };

  it('a high viewer looks down at the dome: its centre is ¼ of the way to the landblock origin', () => {
    const sky = skyWith(0);
    const cam = new THREE.Vector3(500, 200, 700); // landblock corner (384, 0, 576)
    sky.updateSkyObjectPositions(cam);
    const p = worldPos(sky);
    // camera + the group's SwiftShader epsilon (1.13, 0, 0.61) + (anchor − camera) / 4
    expect(p.x).toBeCloseTo(500 + 1.13 + (384 - 500) / 4, 5);
    expect(p.y).toBeCloseTo(200 + (0 - 200) / 4, 5);
    expect(p.z).toBeCloseTo(700 + 0.61 + (576 - 700) / 4, 5);
  });

  it('follows the viewer into the next landblock', () => {
    const sky = skyWith(0);
    sky.updateSkyObjectPositions(new THREE.Vector3(600, 50, 100));
    const p = worldPos(sky);
    expect(p.x).toBeCloseTo(600 + 1.13 + (576 - 600) / 4, 5);
    expect(p.y).toBeCloseTo(50 - 50 / 4, 5);
    expect(p.z).toBeCloseTo(100 + 0.61 + (0 - 100) / 4, 5);
  });

  it('a weather object stays over the viewer at z −120', () => {
    const sky = skyWith(0x4);
    sky.updateSkyObjectPositions(new THREE.Vector3(500, 200, 700));
    const p = worldPos(sky);
    expect(p.x).toBeCloseTo(500 + 1.13, 5);
    expect(p.y).toBeCloseTo(200 + (-120 - 200) / 4, 5);
    expect(p.z).toBeCloseTo(700 + 0.61, 5);
  });
});
