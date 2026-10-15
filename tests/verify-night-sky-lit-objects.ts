/**
 * VISUAL.night-sky-vs-retail — sky objects are LIT like retail's.
 *
 * Retail A/B 2026-10-02 (Holtburg, Sunny group, phase 0.994): retail draws a
 * near-black sky with faint PURPLE cloud streaks and dim purple stars; ours
 * drew white stars at full brightness and grey cloud bands. Decomp ground
 * truth:
 *  - `D3DPolyRender::RenderMeshSubset` @ 0059ca10 forces
 *    `SetFFLighting(true)` while `GameSky::Draw` @ 00506ff0 holds the sky
 *    flag: a sky object is lit (world ambient + sun) through its own D3D
 *    material — `CMaterial::CMaterial` @ 00539770 Ambient = Diffuse = 1,
 *    Emissive = 0; `SetLuminositySimple` = Emissive, `SetDiffuseSimple` =
 *    Diffuse, `SetTranslucencySimple` = 1 - alpha.
 *  - `SkyDesc::GetSky` @ 00501ec0 starts every value at -1 and interpolates
 *    a replace column only when both keyframes carry it (> 0, or >= 0 for
 *    transparent); `GameSky::UseTime` @ 005075b0 applies a value only when
 *    it is set (× 0.01), so a -1 keeps the previous one.
 * The Sunny night ambient is 0xC864FF × 0.40 — the purple.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { GfxObj } from '../packages/dat-parser/src/file-types/GfxObj.js';
import { buildGfxObjGeometry } from '../packages/renderer/src/models/GfxObjMesh.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import * as THREE from 'three';
import {
  SkyboxRenderer, skyReplaceAt, applySkyReplace, type SkyMaterialState,
} from '../packages/renderer/src/effects/SkyboxRenderer.js';
import {
  applyRetailLighting, retailLightingKindOf, setSkyDiffuse, skyDiffuseOf,
  patchLambertVertex, SKY_DEFINE, SKY_DIFFUSE_UNIFORM,
} from '../packages/renderer/src/models/RetailLighting.js';

type Replace = { objectIndex: number; gfxObjId: number; rotate: number; transparent: number; luminosity: number; maxBright: number };
const rep = (objectIndex: number, transparent: number, luminosity: number, maxBright = luminosity): Replace =>
  ({ objectIndex, gfxObjId: 0, rotate: 0, transparent, luminosity, maxBright });

function timeEntry(begin: number, skyObjReplace: Replace[] = []) {
  return {
    begin, dirBright: 0.35, dirHeading: 270, dirPitch: 0.9, dirColor: 0xffdcdcdc,
    ambBright: 0.4, ambColor: 0xffc864ff, minWorldFog: 0, maxWorldFog: 400,
    worldFogColor: 0xff171723, worldFog: 1, skyObjReplace,
  };
}

/** The Sunny group's night keyframes (RegionDesc 0x13000000, day group 0). */
const SUNNY_NIGHT = [
  timeEntry(0, [rep(0, -1, 11), rep(1, 0, 0), rep(4, 100, 15)]),
  timeEntry(0.02, [rep(0, -1, 11), rep(1, 0, 0), rep(4, 0, 15)]),
  timeEntry(0.5, [rep(0, -1, 100), rep(1, 100, 0), rep(4, 0, 100)]),
  timeEntry(0.96, [rep(0, -1, 11), rep(1, 0, 0), rep(4, 0, 15)]),
  timeEntry(0.999, [rep(0, -1, 11), rep(1, 0, 0), rep(4, 100, 15)]),
];

function skyObject(over: Partial<Record<string, number>> = {}) {
  return {
    beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0,
    texVelocityX: 0, texVelocityY: 0,
    defaultGFXObjectId: 0x010015ee, defaultPESObjectId: 0, properties: 0,
    ...over,
  };
}

/** Sunny's sky box (0), star dome (1) and cloud layer (4) — indices 2/3 padded. */
function sunnySkyDesc() {
  return {
    tickSize: 30, lightTickSize: 30,
    dayGroups: [{
      chanceOfOccur: 5, dayName: 'Sunny',
      skyObjects: [
        skyObject({ defaultGFXObjectId: 0x010015ee }),
        skyObject({ defaultGFXObjectId: 0x010015ef }),
        skyObject({ defaultGFXObjectId: 0x01001f67, beginTime: 0.04, endTime: 0.21, beginAngle: -20, endAngle: 190 }),
        skyObject({ defaultGFXObjectId: 0x01001f6a, beginTime: 0, endTime: 0.23, beginAngle: -20, endAngle: 190 }),
        skyObject({ defaultGFXObjectId: 0x01004c36, texVelocityX: -0.013, texVelocityY: 0.013, properties: 2 }),
      ],
      skyTime: SUNNY_NIGHT,
    }],
  } as never;
}

/** Surface luminosity per GfxObj, as in the DAT (box 1, stars 0, clouds 0, sun glow 1 additive). */
const SURFACES: Record<number, { luminosity: number; additive: boolean; doubleSided?: boolean }> = {
  0x010015ee: { luminosity: 1, additive: false },
  0x010015ef: { luminosity: 0, additive: false },
  0x01001f67: { luminosity: 1, additive: false },
  0x01001f6a: { luminosity: 1, additive: true },
  0x01004c36: { luminosity: 0, additive: false },
  // The Rainy rain dome 0x1004c42: surface 0x80000c5, type 0x10112
  // (Additive | Alpha | Translucent | Base1Image), luminosity 0.148438.
  // Its polygons are SidesType 1 (no culling): GfxObjMesh gives it DoubleSide.
  0x01004c42: { luminosity: 0.1484380066394806, additive: true, doubleSided: true },
};

function stubModelRenderer() {
  return {
    createMesh: (gfxId: number) => {
      const g = new THREE.Group();
      const s = SURFACES[gfxId];
      const mat = s?.additive
        ? new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending, transparent: true })
        : new THREE.MeshLambertMaterial();
      mat.side = s?.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.userData.surfaceId = gfxId; // the stub keys surfaces by GfxObj id
      g.add(mesh);
      return g;
    },
    getSurface: (surfaceId: number) => {
      const s = SURFACES[surfaceId];
      return s ? { luminosity: s.luminosity } : null;
    },
  } as never;
}

interface Entry {
  index: number;
  mesh: THREE.Object3D;
  materials: THREE.MeshBasicMaterial[];
  litMaterials: Array<{ material: THREE.MeshLambertMaterial; surfaceLuminosity: number }>;
  state: SkyMaterialState;
}
const entries = (sky: SkyboxRenderer): Entry[] => (sky as unknown as { skyObjectEntries: Entry[] }).skyObjectEntries;
const entry = (sky: SkyboxRenderer, i: number): Entry => entries(sky).find(e => e.index === i)!;

describe('VISUAL.night-sky-vs-retail: SkyDesc::GetSky replace semantics', () => {
  const [, k002, , k096, k0999] = SUNNY_NIGHT as never as Array<ReturnType<typeof timeEntry>>;

  it('interpolates a column only when both keyframes carry it', () => {
    // Cloud layer between 0.96 (transparent 0) and 0.999 (transparent 100).
    const r = skyReplaceAt(k096 as never, k0999 as never, 4, 0.5);
    expect(r.transparent).toBeCloseTo(50, 5);
    expect(r.luminosity).toBe(15);
    expect(r.maxBright).toBe(15);
  });

  it('a 0 luminosity/max_bright end leaves the value at -1 (keep as is)', () => {
    // Star dome: luminosity 0 / max_bright 0 at every keyframe, transparent 0.
    const r = skyReplaceAt(k096 as never, k0999 as never, 1, 0.3);
    expect(r).toEqual({ luminosity: -1, maxBright: -1, transparent: 0 });
  });

  it('transparent -1 (the sky box) is never applied', () => {
    const r = skyReplaceAt(k002 as never, k096 as never, 0, 0.5);
    expect(r.transparent).toBe(-1);
    expect(r.luminosity).toBeCloseTo(11, 5);
  });

  it('no replace in the next keyframe leaves everything at -1', () => {
    const next = timeEntry(0.5, []);
    expect(skyReplaceAt(k096 as never, next as never, 4, 0.5)).toEqual({ luminosity: -1, maxBright: -1, transparent: -1 });
  });

  it('GameSky::UseTime applies set values × 0.01 and keeps the last value on -1', () => {
    const state: SkyMaterialState = { luminosity: null, diffuse: null, translucency: null };
    applySkyReplace(state, { luminosity: 15, maxBright: 15, transparent: 87 });
    expect(state.luminosity).toBeCloseTo(0.15, 6);
    expect(state.diffuse).toBeCloseTo(0.15, 6);
    expect(state.translucency).toBeCloseTo(0.87, 6);
    applySkyReplace(state, { luminosity: -1, maxBright: -1, transparent: -1 });
    expect(state.luminosity).toBeCloseTo(0.15, 6);
    expect(state.diffuse).toBeCloseTo(0.15, 6);
    expect(state.translucency).toBeCloseTo(0.87, 6);
  });
});

describe('VISUAL.night-sky-vs-retail: the sky lighting kind', () => {
  it('compiles with AC_SKY and scales only the sun term by the per-material Diffuse', () => {
    const vs = patchLambertVertex(THREE.ShaderLib.lambert.vertexShader, 'sky');
    expect(vs.startsWith(`#define ${SKY_DEFINE}`)).toBe(true);
    expect(vs).toContain(`uniform float ${SKY_DIFFUSE_UNIFORM};`);
    expect(vs).toMatch(/acSum \+= AC_SUN_DIFFUSE \* directionalLights\[ i \]\.color/);
    // The ambient term is NOT scaled (material Ambient stays 1).
    expect(vs).toContain('vec3 acSum = ambientLightColor * acAmbientScale;');
  });

  it('gives each material its own Diffuse uniform (default 1) and binds it at compile', () => {
    const a = applyRetailLighting(new THREE.MeshLambertMaterial(), 'sky');
    const b = applyRetailLighting(new THREE.MeshLambertMaterial(), 'sky');
    expect(retailLightingKindOf(a)).toBe('sky');
    expect(skyDiffuseOf(a)).toBe(1);
    setSkyDiffuse(a, 0.15);
    expect(skyDiffuseOf(a)).toBeCloseTo(0.15, 6);
    expect(skyDiffuseOf(b)).toBe(1);
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    };
    a.onBeforeCompile(shader as never, undefined as never);
    expect((shader.uniforms[SKY_DIFFUSE_UNIFORM] as { value: number }).value).toBeCloseTo(0.15, 6);
    // Object materials share the program family but carry no sky uniform.
    const obj = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object');
    const objShader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    };
    obj.onBeforeCompile(objShader as never, undefined as never);
    expect(objShader.uniforms[SKY_DIFFUSE_UNIFORM]).toBeUndefined();
    expect(objShader.vertexShader).toContain('#define AC_SUN_DIFFUSE 1.0');
  });
});

describe('VISUAL.night-sky-vs-retail: SkyboxRenderer lights its sky objects', () => {
  function sunnyAt(t: number): SkyboxRenderer {
    const sky = new SkyboxRenderer(sunnySkyDesc());
    sky.initSkyObjects(stubModelRenderer());
    sky.updateTimeOfDay(t);
    return sky;
  }

  it('a one-sided sky part keeps its front-face culling', () => {
    expect(entry(sunnyAt(0.5), 0).litMaterials[0].material.side).toBe(THREE.FrontSide);
  });

  it('every surface gets the retail-lit sky material, DAT Additive ones included', () => {
    // BUG.rain-invisible-thunder-audible — RenderMeshSubset @ 0059ca10 lights
    // every sky part whatever its surface type; SetSurface @ 0059c4d0 lets
    // the Additive bit pick only the blend (SRCALPHA/ONE) and the fog.
    const sky = sunnyAt(0.994);
    for (const i of [0, 1, 3, 4]) {
      const e = entry(sky, i);
      expect(e.litMaterials).toHaveLength(1);
      expect(retailLightingKindOf(e.litMaterials[0].material)).toBe('sky');
    }
    const glow = entry(sky, 3).litMaterials[0].material;
    expect(glow.blendSrc).toBe(THREE.SrcAlphaFactor);
    expect(glow.blendDst).toBe(THREE.OneFactor);
    expect(glow.userData.skyDatAdditive).toBe(true);
    // The sun glow (Surface lum 1, no replace column) stays full bright.
    expect(glow.emissive.r).toBe(1);
  });

  it('phase 0.994: stars keep Emissive 0 (lit only by the ambient), opaque', () => {
    const stars = entry(sunnyAt(0.994), 1);
    const m = stars.litMaterials[0].material;
    expect(m.emissive.r).toBe(0);
    expect(skyDiffuseOf(m)).toBe(1);
    expect(m.opacity).toBe(1);
    expect(stars.mesh.visible).toBe(true);
  });

  it('phase 0.994: the cloud layer takes Emissive = Diffuse = 0.15 and the lerped translucency', () => {
    const clouds = entry(sunnyAt(0.994), 4);
    const m = clouds.litMaterials[0].material;
    expect(m.emissive.r).toBeCloseTo(0.15, 5);
    expect(skyDiffuseOf(m)).toBeCloseTo(0.15, 5);
    // (0.994 - 0.96) / (0.999 - 0.96) of the way from 0 to 100.
    const frac = (0.994 - 0.96) / (0.999 - 0.96);
    expect(m.opacity).toBeCloseTo(1 - frac, 2);
  });

  it('phase 0.994: the sky box is opaque with Emissive 0.11; at noon 1.0', () => {
    const box = entry(sunnyAt(0.994), 0);
    const m = box.litMaterials[0].material;
    expect(m.emissive.r).toBeCloseTo(0.11, 5);
    expect(m.transparent).toBe(false);
    expect(m.opacity).toBe(1);
    expect(box.mesh.visible).toBe(true);
    const noon = entry(sunnyAt(0.5), 0).litMaterials[0].material;
    expect(noon.emissive.r).toBeCloseTo(1.0, 5);
  });

  it('translucency 1.0 stops the object drawing (CPhysicsPart::SetTranslucency)', () => {
    // Noon: the star dome's transparent column is 100.
    const stars = entry(sunnyAt(0.5), 1);
    expect(stars.state.translucency).toBe(1);
    expect(stars.mesh.visible).toBe(false);
  });
});

describe('BUG.rain-invisible-thunder-audible: the Rainy rain domes draw while the storm plays', () => {
  // Rainy (RegionDesc 0x13000000 day groups 3/7/9/15/16): the rain domes
  // 0x1004c42 (props 4) / 0x1004c44 (props 5) have no time window (0–0) and a
  // replace column of transparent 0, luminosity 0, max_bright 0 from 0.02 to
  // 0.999 — on through every thunder window of Setup 0x2000ba6 (0.03–0.19,
  // 0.40–0.50, 0.91–0.98). A luminosity of 0 is never applied (GameSky::
  // UseTime @ 005075b0), so the dome keeps its Surface's Emissive 0.148.
  // The old unlit path drew it at max(0.1, 0/100) = 10% — invisible rain.
  function rainyAt(t: number): SkyboxRenderer {
    const rows = (tr: number) => [{ objectIndex: 0, gfxObjId: 0, rotate: 0, transparent: tr, luminosity: 0, maxBright: 0 }];
    const sky = new SkyboxRenderer({
      tickSize: 30, lightTickSize: 30,
      dayGroups: [{
        chanceOfOccur: 5, dayName: 'Rainy',
        skyObjects: [skyObject({ defaultGFXObjectId: 0x01004c42, texVelocityX: 0.02, texVelocityY: -2, properties: 4 })],
        skyTime: [
          timeEntry(0, rows(100)), timeEntry(0.02, rows(0)), timeEntry(0.5, rows(0)),
          timeEntry(0.96, rows(0)), timeEntry(0.999, rows(100)),
        ],
      }],
    } as never);
    sky.initSkyObjects(stubModelRenderer());
    sky.updateTimeOfDay(t);
    return sky;
  }

  it('at night (a thunder window, phase 0.95) the dome is lit with its Surface Emissive, opaque, additive', () => {
    const dome = entry(rainyAt(0.95), 0);
    expect(dome.litMaterials).toHaveLength(1);
    const m = dome.litMaterials[0].material;
    expect(retailLightingKindOf(m)).toBe('sky');
    expect(m.emissive.r).toBeCloseTo(0.148438, 5);
    expect(skyDiffuseOf(m)).toBe(1);
    expect(m.opacity).toBe(1);
    expect(m.blendDst).toBe(THREE.OneFactor);
    expect(m.fog).toBe(false);
    expect(dome.mesh.visible).toBe(true);
  });

  it('at noon too: a 0 luminosity never dims it', () => {
    const dome = entry(rainyAt(0.5), 0);
    expect(dome.litMaterials[0].material.emissive.r).toBeCloseTo(0.148438, 5);
    expect(dome.mesh.visible).toBe(true);
  });

  it('keeps its polygons\' cull mode: double-sided, so it shows from inside (the viewer stands in it)', () => {
    // The dome is a 113 m-radius cylinder centred on the viewer (skyObjectFrame,
    // props&0x4). Forced FrontSide, every face seen from inside was culled.
    expect(entry(rainyAt(0.95), 0).litMaterials[0].material.side).toBe(THREE.DoubleSide);
  });

  it('the DisableMostWeatherEffects gate still hides it', () => {
    const sky = rainyAt(0.95);
    sky.setWeatherEnabled(false);
    expect(entry(sky, 0).mesh.visible).toBe(false);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('BUG.rain-invisible-thunder-audible: the real rain domes are double-sided', () => {
  let portal: DatDatabase;
  beforeAll(() => { portal = openDat(DAT_PATHS.portal); });

  it('GfxObjMesh builds 0x1004c42 / 0x1004c44 as double-sided batches (SidesType 1 polygons)', () => {
    for (const id of [0x01004c42, 0x01004c44]) {
      const gfx = new GfxObj(new DatReader(portal.getFileData(id)!));
      const geo = buildGfxObjGeometry(gfx);
      expect(geo.doubleSided.length).toBeGreaterThan(0);
      expect(geo.doubleSided.every(Boolean)).toBe(true);
    }
  });
});
