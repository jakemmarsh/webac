/**
 * webac#23 — "Landscape detail texture option": the 1999 client's landscape detail pass, an AC1999
 * option only.
 *
 * 1999 client.exe (reference/ac1999/Client/decomp + the exe's own bytes):
 *   PerformancePanel @ 0x594e00 — "Detail Texture" with "Landscape" / "Environment" checkboxes;
 *   render-options defaults @ 0x42c236 — every detail flag 0 (off);
 *   LScape_SetDetailTexturing @ 0x44340f — GenerateDetailSurface(0): terrain_desc[0]'s detail texture;
 *   the D3D land draw (0x57e9de / 0x583a58) — SRCALPHA / INVSRCALPHA second draw, base cell UVs ×
 *     the tiling, vertex alpha 255 below screen z 0.02 → 0 at 0.04 (.rdata 0x60e740 / 0x60e744),
 *     screen z = view depth / 500 (0x61c4d4): 10 m → 20 m.
 * End of retail (reference/client-eol): Render::UpdateFromPreferences @ 0054d850 forces landscape
 *   detail off; gmConfigUI attaches no Render.LandscapeDetailTextures row. The classic eras run that exe.
 *
 * Drives the shipped EraWorldRules, DetailTexturing, RetailLighting, TerrainRenderer and GameUI.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import {
  AC1999_LANDSCAPE_DETAIL, CLASSIC_LANDSCAPE_DETAIL, CLASSIC_WORLD_RULES, EOR_WORLD_RULES, landscapeDetailTexturesOption,
} from '../packages/renderer/src/era/EraWorldRules.js';
import {
  DetailTexturing, detailTexturing, regionDetailSurfaces, retailLandscapeDetail, landscapeDetailFade,
  landscapeDetailUv, patchLandscapeDetailFragment, patchLandscapeDetailVertex, RETAIL_OUTGOING_LINE,
  LAND_DETAIL_MAP_UNIFORM, LAND_DETAIL_ON_UNIFORM, LAND_DETAIL_SCALE_UNIFORM, LAND_DETAIL_ORIGIN_UNIFORM,
  LAND_DETAIL_FADE_UNIFORM, LAND_DETAIL_UV_VARYING, LAND_DETAIL_ALPHA_VARYING, LAND_DETAIL_CACHE_KEY,
  DETAIL_MAP_UNIFORM, DETAIL_CACHE_KEY, landscapeDetailSeeThrough, LANDSCAPE_DETAIL_MAX_MEAN_ALPHA,
} from '../packages/renderer/src/models/DetailTexturing.js';
import {
  applyRetailLighting, patchLambertFragment, patchLambertVertex, retailLightingCacheKey,
} from '../packages/renderer/src/models/RetailLighting.js';
import { patchSamplerBias, SAMPLER_BIAS_CACHE_KEY, MIP_BIAS_UNIFORM } from '../packages/renderer/src/models/TextureSamplerPrefs.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';
import { TerrainManager } from '../packages/renderer/src/terrain/TerrainManager.js';
import { DatDatabase, DatReader } from '../packages/dat-parser/src/index.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { DAT_PATHS, DAT_SETS_DIR, openDat } from './_harness/dat.js';

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const EOR = eraClientRules(eraProfile('eor'));
const CLASSIC = ['classic-dereth', 'classic-dereth-1-0', 'classicace-customdm', 'classicace-infiltration']
  .map((id) => [id, eraClientRules(eraProfile(id))] as const);

/** Run a material's onBeforeCompile the way WebGLPrograms does. */
function compile(mat: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mat.onBeforeCompile as any)(shader, {});
  return shader;
}

function rgba(width: number, height: number, px: [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(px, i * 4);
  return { width, height, data };
}

function fakeTexMerge(entries: Array<[gid: number, tiling: number]>) {
  return { terrainDesc: entries.map(([gid, tiling]) => ({ terrainTex: { detailTexGID: gid, detailTexTiling: tiling } })) };
}

/** A TextureManager.getRGBA stand-in that counts decodes per GID. */
function fakeSource() {
  const decodes = new Map<number, number>();
  return {
    decodes,
    getRGBA(id: number) {
      decodes.set(id, (decodes.get(id) ?? 0) + 1);
      return rgba(4, 4, [100, 100, 100, 51]);
    },
  };
}

afterEach(() => {
  // The singleton is shared with every other test file in the worker: leave it as main.ts would
  // for an end-of-retail page.
  detailTexturing.setLandscapeRule(null);
  detailTexturing.setLandscapeEnabled(false);
});

describe('the era rules: AC1999 (its client) and the classic eras (Jake, webac#23) have the option; end of retail none', () => {
  it('AC1999 fades 10 m → 20 m; every classic era 10 m → 50 m (the EoL exe\'s dormant constants); end of retail: none', () => {
    expect(R1999.world.landscapeDetailTextures).toEqual({ fadeMinZ: 10, fadeMaxZ: 20 });
    expect(R1999.world.landscapeDetailTextures).toBe(AC1999_LANDSCAPE_DETAIL);
    expect(landscapeDetailTexturesOption(R1999.world)).toBe(true);
    expect(EOR.world.landscapeDetailTextures).toBeNull();
    expect(landscapeDetailTexturesOption(EOR.world)).toBe(false);
    expect(EOR.world).toBe(EOR_WORLD_RULES);
    for (const [id, r] of CLASSIC) {
      expect(r.world, id).toBe(CLASSIC_WORLD_RULES);
      expect(r.world.landscapeDetailTextures, id).toEqual({ fadeMinZ: 10, fadeMaxZ: 50 });
      expect(landscapeDetailTexturesOption(r.world), id).toBe(true);
      // Everything else in the classic world is end of retail's.
      expect({ ...r.world, landscapeDetailTextures: null }, id).toEqual({ ...EOR_WORLD_RULES });
      // …and the rest of the client rules too (the map-note renames aside).
      const { world: _w, mapPanel: _m, ...rest } = r;
      const { world: _ew, mapPanel: _em, ...eorRest } = EOR;
      expect(rest, id).toEqual(eorRest);
    }
    expect(CLASSIC_LANDSCAPE_DETAIL).toEqual({ fadeMinZ: 10, fadeMaxZ: 50 });
  });

  it('the see-through gate: mean alpha ≤ 127 is offered, an opaque texture is not', () => {
    expect(LANDSCAPE_DETAIL_MAX_MEAN_ALPHA).toBe(127);
    expect(landscapeDetailSeeThrough(rgba(4, 4, [100, 100, 100, 51]))).toBe(true);
    expect(landscapeDetailSeeThrough(rgba(4, 4, [100, 100, 100, 127]))).toBe(true);
    expect(landscapeDetailSeeThrough(rgba(4, 4, [100, 100, 100, 128]))).toBe(false);
    expect(landscapeDetailSeeThrough(rgba(4, 4, [100, 100, 100, 255]))).toBe(false);
    expect(landscapeDetailSeeThrough(null)).toBe(false);
  });
});

describe('the pass as equations (1999 D3D: SRCALPHA / INVSRCALPHA over MODULATE(texture, lit diffuse))', () => {
  it('the vertex fade: 1 below 10 m, linear, 0 beyond 20 m', () => {
    const f = AC1999_LANDSCAPE_DETAIL;
    expect(landscapeDetailFade(0, f)).toBe(1);
    expect(landscapeDetailFade(9.99, f)).toBe(1);
    expect(landscapeDetailFade(10, f)).toBe(1);
    expect(landscapeDetailFade(15, f)).toBeCloseTo(0.5, 12);
    expect(landscapeDetailFade(20, f)).toBe(0);
    expect(landscapeDetailFade(500, f)).toBe(0);
  });

  it('a pixel: lit detail blended over the lit texel by detail.a × fade; fade 0 or alpha 0 is the identity', () => {
    const texel: [number, number, number] = [0.6, 0.4, 0.2];
    const light: [number, number, number] = [0.8, 0.8, 0.8];
    const lit = texel.map((t, i) => t * light[i]);
    const d: [number, number, number, number] = [0.4, 0.4, 0.4, 0.2];
    expect(retailLandscapeDetail(texel, light, d, 0)).toEqual(lit);
    expect(retailLandscapeDetail(texel, light, [1, 1, 1, 0], 1)).toEqual(lit);
    const out = retailLandscapeDetail(texel, light, d, 1);
    for (let c = 0; c < 3; c++) expect(out[c]).toBeCloseTo(0.4 * 0.8 * 0.2 + lit[c] * 0.8, 12);
    // Half faded: half the weight.
    const half = retailLandscapeDetail(texel, light, d, 0.5);
    for (let c = 0; c < 3; c++) expect(half[c]).toBeCloseTo(0.4 * 0.8 * 0.1 + lit[c] * 0.9, 12);
    // The lit detail clamps like the D3D modulate.
    expect(retailLandscapeDetail([1, 1, 1], [1, 1, 1], [2, 2, 2, 1], 1)).toEqual([1, 1, 1]);
  });

  it('UVs: one 0..1 per 24 m cell (u east, v south, land_uvs) × the tiling', () => {
    expect(landscapeDetailUv(24, 0, 8)).toEqual([8, -0]);
    expect(landscapeDetailUv(0, 24, 8)).toEqual([0, -8]);
    expect(landscapeDetailUv(12, 12, 4)).toEqual([2, -2]);
  });
});

describe('the GLSL patch rides on the retail-lit landscape program', () => {
  const retailLand = () => ({
    vertexShader: patchLambertVertex(THREE.ShaderLib.lambert.vertexShader, 'landscape'),
    fragmentShader: patchSamplerBias(patchLambertFragment(THREE.ShaderLib.lambert.fragmentShader, 'landscape')),
  });

  it('the fragment replaces the outgoing line with the blend and declares its inputs; idempotent; order guarded', () => {
    const { fragmentShader } = retailLand();
    const out = patchLandscapeDetailFragment(fragmentShader);
    expect(out).not.toContain(RETAIL_OUTGOING_LINE);
    expect(out).toContain(`uniform sampler2D ${LAND_DETAIL_MAP_UNIFORM};`);
    expect(out).toContain(`uniform float ${LAND_DETAIL_ON_UNIFORM};`);
    expect(out).toContain(`varying float ${LAND_DETAIL_ALPHA_VARYING};`);
    expect(out).toContain(`texture2D( ${LAND_DETAIL_MAP_UNIFORM}, ${LAND_DETAIL_UV_VARYING}, ${MIP_BIAS_UNIFORM} )`);
    expect(out).toContain('mix( acTexel * acLight, clamp( acLandDetail.rgb * acLight, 0.0, 1.0 ), acLandDetailA )');
    expect(patchLandscapeDetailFragment(out)).toBe(out);
    expect(() => patchLandscapeDetailFragment(THREE.ShaderLib.lambert.fragmentShader)).toThrow(/outgoing line/);
    expect(() => patchLandscapeDetailFragment(patchLambertFragment(THREE.ShaderLib.lambert.fragmentShader, 'landscape')))
      .toThrow(/sampler-bias/);
  });

  it('the vertex computes the UVs from world x / north and the fade from view depth, after project_vertex', () => {
    const out = patchLandscapeDetailVertex(retailLand().vertexShader);
    expect(out).toContain(`uniform vec2 ${LAND_DETAIL_FADE_UNIFORM};`);
    const at = out.indexOf('#include <project_vertex>');
    const body = out.indexOf(`${LAND_DETAIL_ALPHA_VARYING} = 1.0 - clamp( ( -mvPosition.z`);
    expect(at).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(at);
    expect(out).toContain(`vec2( acLdWorld.x - ${LAND_DETAIL_ORIGIN_UNIFORM}.x, ${LAND_DETAIL_ORIGIN_UNIFORM}.y - acLdWorld.z ) * ${LAND_DETAIL_SCALE_UNIFORM}`);
    expect(patchLandscapeDetailVertex(out)).toBe(out);
    expect(() => patchLandscapeDetailVertex('void main() {}')).toThrow(/project_vertex/);
  });

  it('end of retail (no rule): landscape materials carry no detail program and keep their cache key', () => {
    detailTexturing.setLandscapeRule(EOR.world.landscapeDetailTextures);
    const land = applyRetailLighting(new THREE.MeshLambertMaterial(), 'landscape');
    expect(land.customProgramCacheKey()).toBe(`${retailLightingCacheKey('landscape')}|${SAMPLER_BIAS_CACHE_KEY}`);
    const s = compile(land);
    expect(s.fragmentShader).toContain(RETAIL_OUTGOING_LINE);
    expect(s.fragmentShader).not.toContain(LAND_DETAIL_MAP_UNIFORM);
    expect(s.uniforms[LAND_DETAIL_MAP_UNIFORM]).toBeUndefined();
  });

  it('AC1999: every landscape material carries it with the shared uniforms; objects and buildings do not', () => {
    detailTexturing.setLandscapeRule(R1999.world.landscapeDetailTextures);
    const land = applyRetailLighting(new THREE.MeshLambertMaterial(), 'landscape');
    const obj = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object');
    const bld = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object', 'building');
    expect(land.customProgramCacheKey()).toBe(`${retailLightingCacheKey('landscape')}|${SAMPLER_BIAS_CACHE_KEY}|${LAND_DETAIL_CACHE_KEY}`);
    expect(obj.customProgramCacheKey()).toBe(`${retailLightingCacheKey('object')}|${SAMPLER_BIAS_CACHE_KEY}`);
    expect(bld.customProgramCacheKey()).toBe(`${retailLightingCacheKey('object')}|${SAMPLER_BIAS_CACHE_KEY}|${DETAIL_CACHE_KEY}:building`);

    const s = compile(land);
    const u = detailTexturing.landscapeUniformsFor();
    expect(s.uniforms[LAND_DETAIL_MAP_UNIFORM]).toBe(u.map);
    expect(s.uniforms[LAND_DETAIL_ON_UNIFORM]).toBe(u.on);
    expect(s.uniforms[LAND_DETAIL_SCALE_UNIFORM]).toBe(u.scale);
    expect(s.uniforms[LAND_DETAIL_ORIGIN_UNIFORM]).toBe(u.origin);
    expect(s.uniforms[LAND_DETAIL_FADE_UNIFORM]).toBe(u.fade);
    expect((u.fade.value as THREE.Vector2).toArray()).toEqual([10, 20]);
    expect(s.fragmentShader).not.toContain(RETAIL_OUTGOING_LINE);
    expect(s.vertexShader).toContain(`varying vec2 ${LAND_DETAIL_UV_VARYING};`);

    const objShader = compile(obj);
    expect(objShader.fragmentShader).not.toContain(LAND_DETAIL_MAP_UNIFORM);
    const bldShader = compile(bld);
    expect(bldShader.fragmentShader).toContain(DETAIL_MAP_UNIFORM);
    expect(bldShader.fragmentShader).not.toContain(LAND_DETAIL_MAP_UNIFORM);
  });

  it('AC1999: the TerrainRenderer\'s own landscape materials (default, base, blend, road) all take it', () => {
    detailTexturing.setLandscapeRule(R1999.world.landscapeDetailTextures);
    const tr = new TerrainRenderer(new THREE.Scene(), new TerrainManager());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fallback = (tr as any).material as THREE.Material;
    expect(fallback.customProgramCacheKey()).toContain(LAND_DETAIL_CACHE_KEY);
    expect(compile(fallback).uniforms[LAND_DETAIL_ON_UNIFORM]).toBe(detailTexturing.landscapeUniformsFor().on);
    const alpha = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    const base = new THREE.DataTexture(new Uint8Array(4), 1, 1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blend = (tr as any).getMergedBlendMaterial(1, base, 0x05000001, alpha) as THREE.Material;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const road = (tr as any).getMergedRoadMaterial(0x05000002, alpha) as THREE.Material;
    for (const m of [blend, road]) {
      expect(m.customProgramCacheKey()).toContain(LAND_DETAIL_CACHE_KEY);
      expect(compile(m).fragmentShader).toContain(`uniform sampler2D ${LAND_DETAIL_MAP_UNIFORM};`);
    }
  });
});

describe('DetailTexturing: the landscape surface, the checkbox and the UV origin', () => {
  it('without the era rule terrain_desc[0] is never decoded and the pass stays off, checkbox or not', () => {
    const dt = new DetailTexturing();
    const src = fakeSource();
    dt.setLandscapeEnabled(true);
    dt.loadSurfaces(fakeTexMerge([[0x5001786, 8], [0x5001787, 3], [0x5001787, 3], [0x5001786, 2]]), src);
    expect(dt.landscapeAvailable).toBe(false);
    expect(dt.landscapeTexture()).toBeNull();
    expect(dt.isLandscapeDrawing).toBe(false);
    expect(src.decodes.get(0x5001786)).toBeUndefined();
  });

  it('with the 1999 rule: terrain_desc[0] at its tiling per cell; on only with the checkbox; off by default', () => {
    const dt = new DetailTexturing();
    const src = fakeSource();
    dt.setLandscapeRule(AC1999_LANDSCAPE_DETAIL);
    dt.loadSurfaces(fakeTexMerge([[0x5001786, 8], [0x5001787, 3], [0x5001787, 3], [0x5001786, 2]]), src);
    const u = dt.landscapeUniformsFor();
    expect(dt.isLandscapeEnabled).toBe(false);
    expect(dt.isLandscapeDrawing).toBe(false);
    expect(u.scale.value).toBeCloseTo(8 / 24, 12);
    const tex = dt.landscapeTexture()!;
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect(tex.wrapS).toBe(THREE.RepeatWrapping);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
    expect(src.decodes.get(0x5001786)).toBe(1);
    expect(dt.setLandscapeEnabled(true)).toBe(true);
    expect(dt.setLandscapeEnabled(true)).toBe(false);
    expect(dt.isLandscapeDrawing).toBe(true);
    expect(u.on.value).toBe(1);
    // The building / environment toggle is independent.
    dt.setEnabled(false);
    expect(u.on.value).toBe(1);
    dt.setLandscapeEnabled(false);
    expect(u.on.value).toBe(0);
  });

  it('an opaque region texture (classic-dereth\'s 0x5001786) is not offered: no row, no terrain program, nothing drawn', () => {
    const dt = new DetailTexturing();
    dt.setLandscapeRule(CLASSIC_LANDSCAPE_DETAIL);
    dt.setLandscapeEnabled(true);
    expect(dt.landscapeAvailable).toBe(true); // before the region loads
    const opaque = { getRGBA: () => rgba(4, 4, [120, 130, 90, 255]) };
    dt.loadSurfaces(fakeTexMerge([[0x5001786, 4], [0x5001787, 4], [0x5001787, 4]]), opaque);
    expect(dt.landscapeAvailable).toBe(false);
    expect(dt.landscapeTexture()).toBeNull();
    expect(dt.isLandscapeDrawing).toBe(false);
    // The building / environment surfaces are unaffected.
    expect(dt.textureFor('building')).not.toBeNull();
    // The singleton, opaque: landscape materials made after the region load stay unpatched.
    detailTexturing.setLandscapeRule(CLASSIC_LANDSCAPE_DETAIL);
    detailTexturing.loadSurfaces(fakeTexMerge([[0x5001786, 4]]), opaque);
    const land = applyRetailLighting(new THREE.MeshLambertMaterial(), 'landscape');
    expect(land.customProgramCacheKey()).not.toContain(LAND_DETAIL_CACHE_KEY);
    // A region with a see-through texture afterwards offers it again (each GID is judged once).
    detailTexturing.loadSurfaces(fakeTexMerge([[0x5001788, 4]]), fakeSource());
    expect(detailTexturing.landscapeAvailable).toBe(true);
  });

  it('a region with no landscape surface (INVALID_DID) draws nothing even when ticked', () => {
    const dt = new DetailTexturing();
    dt.setLandscapeRule(AC1999_LANDSCAPE_DETAIL);
    dt.setLandscapeEnabled(true);
    dt.loadSurfaces(fakeTexMerge([[0xffffffff, 8], [0x5001787, 3]]), fakeSource());
    expect(dt.landscapeTexture()).toBeNull();
    expect(dt.isLandscapeDrawing).toBe(false);
  });

  it('the UV origin snaps to the camera\'s landblock, so an integer tiling draws the same texels from any origin', () => {
    const dt = new DetailTexturing();
    dt.setLandscapeOrigin(30000.5, 12345.25);
    const o = dt.landscapeUniformsFor().origin.value;
    expect(o.x).toBe(Math.floor(30000.5 / 192) * 192);
    expect(o.y).toBe(Math.floor(12345.25 / 192) * 192);
    // Same world point, two origins: the UVs differ by whole repeats.
    const tiling = 8;
    const scale = tiling / 24;
    const uv = (ox: number, oy: number, x: number, n: number) => [(x - ox) * scale, (oy - n) * scale];
    const a = uv(o.x, o.y, 30010.75, 12350.5);
    const b = uv(o.x + 192, o.y - 192, 30010.75, 12350.5);
    expect(Number.isInteger(Math.round((a[0] - b[0]) * 1e6) / 1e6)).toBe(true);
    expect(Number.isInteger(Math.round((a[1] - b[1]) * 1e6) / 1e6)).toBe(true);
  });
});

// ── The DATs ─────────────────────────────────────────────────────────────────

const ERA_PORTALS: Array<[name: string, path: string]> = [
  ['end of retail', DAT_PATHS.portal],
  ['classic-dereth-1.0', resolve(DAT_SETS_DIR, 'classic-dereth-1.0', 'client_portal.dat')],
  ['classic-dereth-1.1', resolve(DAT_SETS_DIR, 'classic-dereth-1.1', 'client_portal.dat')],
  ['classicace-customdm-1.60', resolve(DAT_SETS_DIR, 'classicace-customdm-1.60', 'client_portal.dat')],
  ['classicace-infiltration-1.9', resolve(DAT_SETS_DIR, 'classicace-infiltration-1.9', 'client_portal.dat')],
];
const PORTAL_1999 = resolve(DAT_SETS_DIR, 'ac1999-retail', 'portal.dat');
const EXE_1999 = resolve(DAT_SETS_DIR, 'ac1999-retail', 'client.exe');

function texMergeOf(db: { getFileData(id: number): ArrayBuffer | null }) {
  const rd = new RegionDesc(new DatReader(db.getFileData(0x13000000)!));
  return rd.terrainInfo.landSurfaces.texMerge!;
}

describe.skipIf(!ERA_PORTALS.every(([, p]) => existsSync(p)))('the detail table per era (RegionDesc 0x13000000 terrain_desc)', () => {
  it('end of retail and every classic set: terrain_desc[0] = 0x5001786 ×4 (building / environment 0x5001787 ×4)', () => {
    for (const [name, path] of ERA_PORTALS) {
      const s = regionDetailSurfaces(texMergeOf(openDat(path)));
      expect(s.landscape, name).toEqual({ texGID: 0x5001786, tiling: 4 });
      expect(s.building, name).toEqual({ texGID: 0x5001787, tiling: 4 });
      expect(s.environment, name).toEqual({ texGID: 0x5001787, tiling: 4 });
      expect(s.object, name).toEqual({ texGID: 0x5001786, tiling: 4 });
    }
  });

  it('the gate per set: end of retail / CustomDM / Infiltration see-through (offered on a classic world); Classic Dereth 1.0 / 1.1 opaque 512² (not offered)', () => {
    const expected: Record<string, boolean> = {
      'end of retail': true, 'classicace-customdm-1.60': true, 'classicace-infiltration-1.9': true,
      'classic-dereth-1.0': false, 'classic-dereth-1.1': false,
    };
    for (const [name, path] of ERA_PORTALS) {
      const tm = new TextureManager(openDat(path));
      const img = tm.getRGBA(0x5001786)!;
      expect(landscapeDetailSeeThrough(img), name).toBe(expected[name]);
      if (!expected[name]) {
        expect([img.width, img.height], name).toEqual([512, 512]);
        for (let i = 3; i < img.data.length; i += 4 * 1009) expect(img.data[i], name).toBe(255);
      }
      const dt = new DetailTexturing();
      dt.setLandscapeRule(CLASSIC_LANDSCAPE_DETAIL);
      dt.setLandscapeEnabled(true);
      dt.loadSurfaces(texMergeOf(openDat(path)), tm);
      expect(dt.landscapeAvailable, name).toBe(expected[name]);
      expect(dt.isLandscapeDrawing, name).toBe(expected[name]);
      if (expected[name]) expect(dt.landscapeUniformsFor().scale.value, name).toBeCloseTo(4 / 24, 12);
    }
  });

  it('end of retail\'s 0x5001786: 256×256 grey with alpha 48..60 (≈ 0.2 weight)', () => {
    const tm = new TextureManager(openDat(DAT_PATHS.portal));
    const img = tm.getRGBA(0x5001786)!;
    expect([img.width, img.height]).toEqual([256, 256]);
    let amin = 255, amax = 0;
    for (let i = 3; i < img.data.length; i += 4) { amin = Math.min(amin, img.data[i]); amax = Math.max(amax, img.data[i]); }
    expect([amin, amax]).toEqual([48, 60]);
  });
});

describe.skipIf(!existsSync(PORTAL_1999))('the 1999 portal: the hardware region\'s landscape detail', () => {
  let db: DatDatabase;
  beforeAll(() => {
    db = new DatDatabase(new FileDatBytes(PORTAL_1999));
    db.setOverlay(ac1999PortalOverlay());
  });

  it('terrain_desc[0] = 0x5001786 ×8 per cell (building / environment 0x5001787 ×3)', () => {
    const s = regionDetailSurfaces(texMergeOf(db));
    expect(s.landscape).toEqual({ texGID: 0x5001786, tiling: 8 });
    expect(s.building).toEqual({ texGID: 0x5001787, tiling: 3 });
    expect(s.environment).toEqual({ texGID: 0x5001787, tiling: 3 });
    expect(s.object).toEqual({ texGID: 0x5001786, tiling: 2 });
  });

  it('0x5001786 decodes to 256×256 grey with a constant alpha of 51 (0.2), and loadSurfaces wires it at 8 / 24 m', () => {
    const tm = new TextureManager(db);
    const img = tm.getRGBA(0x5001786)!;
    expect([img.width, img.height]).toEqual([256, 256]);
    for (let i = 3; i < img.data.length; i += 4 * 97) expect(img.data[i]).toBe(51);
    const dt = new DetailTexturing();
    dt.setLandscapeRule(AC1999_LANDSCAPE_DETAIL);
    dt.setLandscapeEnabled(true);
    dt.loadSurfaces(texMergeOf(db), tm);
    expect(dt.landscapeTexture()!.image.width).toBe(256);
    expect(dt.landscapeUniformsFor().scale.value).toBeCloseTo(8 / 24, 12);
    expect(dt.isLandscapeDrawing).toBe(true);
  });
});

describe.skipIf(!existsSync(EXE_1999))('the 1999 client.exe: the fade constants and the default', () => {
  let exe: Buffer;
  let va: (addr: number) => number;
  beforeAll(() => {
    exe = readFileSync(EXE_1999);
    const pe = exe.readUInt32LE(0x3c);
    const nsec = exe.readUInt16LE(pe + 6);
    const opt = exe.readUInt16LE(pe + 20);
    const secs: Array<{ va: number; rs: number; ra: number }> = [];
    for (let i = 0, o = pe + 24 + opt; i < nsec; i++, o += 40) {
      secs.push({ va: exe.readUInt32LE(o + 12), rs: exe.readUInt32LE(o + 16), ra: exe.readUInt32LE(o + 20) });
    }
    va = (addr: number) => {
      const rva = addr - 0x400000;
      const s = secs.find((x) => rva >= x.va && rva < x.va + x.rs)!;
      return s.ra + rva - s.va;
    };
  });

  it('screen z 0.02 / 0.04 (.rdata 0x60e740 / 0x60e744) × the 500 depth scale (0x61c4d4) = the 10 m / 20 m rule', () => {
    const near = exe.readFloatLE(va(0x60e740));
    const far = exe.readFloatLE(va(0x60e744));
    const depth = exe.readFloatLE(va(0x61c4d4));
    expect(near).toBeCloseTo(0.02, 6);
    expect(far).toBeCloseTo(0.04, 6);
    expect(depth).toBe(500);
    expect(near * depth).toBeCloseTo(AC1999_LANDSCAPE_DETAIL.fadeMinZ, 4);
    expect(far * depth).toBeCloseTo(AC1999_LANDSCAPE_DETAIL.fadeMaxZ, 4);
  });

  it('the render-options defaults @ 0x42c236 zero the landscape flag: xor eax,eax; mov [ecx],0x1c; mov [ecx+4],eax', () => {
    const at = va(0x42c236);
    expect([...exe.subarray(at, at + 11)]).toEqual([0x33, 0xc0, 0xc7, 0x01, 0x1c, 0, 0, 0, 0x89, 0x41, 0x04]);
  });
});

// ── The Config row ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];

describe('the Config page: a Landscape Detail Textures row on AC1999 and the classic eras, off by default, live', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUIClass: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stubLayout(target: any): void {
    target.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of OPT_IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
          if (id === 0x10000211) {
            for (const bid of [0x100001fc, 0x100001fd, 0x100001fe]) {
              const btn = domWindow.document.createElement('div');
              btn.dataset.elementId = `0x${bid.toString(16)}`;
              el.appendChild(btn);
            }
          }
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (id: number, parent: HTMLElement) => (target.layoutRenderer as any).renderPanel(id, parent),
    };
    target.callbacks.onCharacterOptionToggle = () => {};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function makeUi(rules: typeof R1999): any {
    const ui = new GameUIClass(container);
    ui.setClientRules(rules);
    stubLayout(ui);
    return ui;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function openConfig(ui: any): void {
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
    ui.optionsTab = 'config';
    ui.optionsSettings.optionsTab = 'config';
    ui.toggleOptionsPanel();
    expect(ui.optionsPanelVisible).toBe(true);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rowOf = (ui: any, key: string): HTMLElement | null => ui.optionsPanel.querySelector(`[data-option-key="${key}"]`);

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (g as any).requestAnimationFrame !== 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (g as any).requestAnimationFrame = () => 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (g as any).cancelAnimationFrame = () => {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (domWindow as any).requestAnimationFrame = (g as any).requestAnimationFrame;
    }
    domWindow.localStorage.removeItem('ac_options_settings_v1');
    GameUIClass = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
    container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
  });
  afterAll(() => {
    domWindow.localStorage.removeItem('ac_options_settings_v1');
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('the default is off (1999 render-options defaults), and a fresh profile reads it off', () => {
    expect(GameUIClass.OPTIONS_DEFAULTS.landscapeDetailTextures).toBe(false);
    expect(GameUIClass.readPersistedOptionsSettings().landscapeDetailTextures).toBe(false);
  });

  it('end of retail lists no such row', () => {
    const ui = makeUi(EOR);
    openConfig(ui);
    expect(rowOf(ui, 'landscapeDetailTextures')).toBeNull();
    expect(rowOf(ui, 'buildingDetailTextures')).not.toBeNull();
    ui.toggleOptionsPanel();
  });

  it('every classic era lists it, unless the world says its region texture is opaque (Classic Dereth)', () => {
    for (const [id, rules] of CLASSIC) {
      const ui = makeUi(rules);
      openConfig(ui);
      expect(rowOf(ui, 'landscapeDetailTextures'), id).not.toBeNull();
      ui.toggleOptionsPanel();
      ui.setUIHost({ landscapeDetailAvailable: () => false });
      openConfig(ui);
      expect(rowOf(ui, 'landscapeDetailTextures'), id).toBeNull();
      ui.toggleOptionsPanel();
      ui.setUIHost({ landscapeDetailAvailable: () => true });
      openConfig(ui);
      expect(rowOf(ui, 'landscapeDetailTextures'), id).not.toBeNull();
      ui.toggleOptionsPanel();
    }
  });

  it('AC1999: the row follows Environment Detail Textures, ships its state, persists, and Defaults leaves it (PerformancePanel_Reset(1))', () => {
    const calls: boolean[] = [];
    const ui = makeUi(R1999);
    ui.setUIHost({ setLandscapeDetailTexturing: (on: boolean) => { calls.push(on); return true; } });
    openConfig(ui);
    const row = rowOf(ui, 'landscapeDetailTextures');
    expect(row).not.toBeNull();
    const env = rowOf(ui, 'buildingDetailTextures')!;
    expect(env.compareDocumentPosition(row!) & domWindow.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row!.dataset.optionOn).toBe('0');
    expect(calls.at(-1)).toBe(false); // opening applies the current value

    row!.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(ui.optionsSettings.landscapeDetailTextures).toBe(true);
    expect(calls.at(-1)).toBe(true);
    expect(JSON.parse(domWindow.localStorage.getItem('ac_options_settings_v1')).landscapeDetailTextures).toBe(true);
    expect(GameUIClass.readPersistedOptionsSettings().landscapeDetailTextures).toBe(true);

    // The 1999 Performance panel's Defaults (PerformancePanel_Reset(1) @ 0x00598a70) re-reads the
    // Detail Texture checkboxes from the live render flags: it never turns them off
    // (EraClientRules.configDefaultsKeep, BUG.ac1999-environment-detail-default).
    const btn = ui.optionsPanel.querySelector('[data-element-id="0x100001fe"]') as HTMLElement;
    btn.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(ui.optionsSettings.landscapeDetailTextures).toBe(true);
    expect(calls.at(-1)).toBe(true);
    ui.toggleOptionsPanel();
  });

  it('a classic era\'s Defaults (end of retail\'s OptionPage::RestoreDefaultValues) turns it off', () => {
    const calls: boolean[] = [];
    const ui = makeUi(CLASSIC[0][1]);
    ui.setUIHost({ setLandscapeDetailTexturing: (on: boolean) => { calls.push(on); return true; } });
    ui.optionsSettings.landscapeDetailTextures = true;
    openConfig(ui);
    const btn = ui.optionsPanel.querySelector('[data-element-id="0x100001fe"]') as HTMLElement;
    btn.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(ui.optionsSettings.landscapeDetailTextures).toBe(false);
    expect(calls.at(-1)).toBe(false);
    ui.toggleOptionsPanel();
  });
});
