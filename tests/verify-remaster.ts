/**
 * REMASTER — the opt-in modern renderer (packages/renderer/src/remaster/,
 * docs/remaster.md). Retail stays the default: these pin that the mode is off
 * unless asked for, that it only changes what is drawn, and how each piece
 * behaves.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseRemaster, remaster, setRemaster, REMASTER_FEATURES } from '../packages/renderer/src/remaster/RemasterMode.js';
import {
  patchRemasterFragment, remasterCastsShadow, remasterReceivesShadow, REMASTER_LIGHTING_CACHE_KEY,
} from '../packages/renderer/src/remaster/RemasterLighting.js';
import { tessellatePn, raycastAgainstDat, PN_MAX_TRIANGLES } from '../packages/renderer/src/remaster/PnTessellation.js';
import { sampleGround, buildClumpGeometry, averageTextureColor, GRASS_DENSITY, type GrassLandblock } from '../packages/renderer/src/remaster/GrassField.js';
import { applyShadowFlags } from '../packages/renderer/src/remaster/RemasterPipeline.js';
import { applyRetailLighting, RETAIL_LIGHTING_CACHE_KEY, retailLightingKindOf } from '../packages/renderer/src/models/RetailLighting.js';
import type { GfxObjGeometry } from '../packages/renderer/src/models/GfxObjMesh.js';

afterEach(() => setRemaster(null));

describe('RemasterMode: off unless asked for', () => {
  it('no ?remaster is the retail renderer', () => {
    expect(parseRemaster('')).toBeNull();
    expect(parseRemaster('?ace&bridge=ws://x')).toBeNull();
    expect(parseRemaster('?remaster=0')).toBeNull();
    expect(parseRemaster('?remaster=off')).toBeNull();
  });
  it('bare ?remaster turns every feature on', () => {
    const s = parseRemaster('?remaster')!;
    for (const f of REMASTER_FEATURES) expect(s[f]).toBe(true);
    expect(parseRemaster('?remaster=1')).toEqual(s);
  });
  it('a feature list picks features; shadows and grass need the remaster lighting', () => {
    const s = parseRemaster('?remaster=shadows,ao')!;
    expect(s).toMatchObject({ shadows: true, ao: true, lighting: true, bloom: false, models: false, grass: false });
    expect(parseRemaster('?remaster=grass')!.lighting).toBe(true);
    expect(parseRemaster('?remaster=models')!.lighting).toBe(false);
    expect(parseRemaster('?remaster=nonsense')).toBeNull();
  });
  it('outside a browser the mode is off', () => {
    setRemaster(undefined as unknown as null);
    expect(remaster()).toBeNull();
  });
});

describe('RemasterLighting: the shading patch on the real three.js Lambert shader', () => {
  const frag = THREE.ShaderLib.lambert.fragmentShader;
  it('expands and rewrites every anchor (no 1/PI BRDF, smooth point falloff, bump, gamma fog)', () => {
    const out = patchRemasterFragment(frag, 'object');
    expect(out).not.toContain('#include <lights_fragment_begin>');
    expect(out).not.toContain('BRDF_Lambert( material.diffuseColor )');
    expect(out).toContain('acRemasterAtten( lightDistance, pointLight.distance, pointLight.decay )');
    expect(out).toContain('acPerturbNormal');
    expect(out).toContain('totalEmissiveRadiance * diffuseColor.rgb');
    expect(out).toContain('sRGBTransferOETF( vec4( max( gl_FragColor.rgb');
    // DAT light levels are gamma-space: every light goes through the hue-keeping linearisation.
    expect(out).toContain('acLightToLinear( max( ambientLightColor');
    expect(out).toContain('directLight.color = acLightToLinear(');
    expect(out).toContain('acCapLight( acLightToLinear(');
    // acRemasterAtten is declared before lights_pars_begin calls it (a GLSL forward use fails to compile).
    expect(out.indexOf('float acRemasterAtten(')).toBeLessThan(out.indexOf('acRemasterAtten( lightDistance'));
  });
  it('keeps retail light sets: env cells and their objects take no sun', () => {
    expect(patchRemasterFragment(frag, 'envcell')).toMatch(/^#define AC_REMASTER_IN_CELL/);
    expect(patchRemasterFragment(frag, 'cellobject')).toMatch(/^#define AC_REMASTER_IN_CELL/);
    expect(patchRemasterFragment(frag, 'object')).not.toContain('#define AC_REMASTER_IN_CELL');
    expect(patchRemasterFragment(frag, 'object')).toContain('!defined( AC_REMASTER_IN_CELL )');
  });
  it('applyRetailLighting stays retail by default and switches only under the flag (sky always retail)', () => {
    const retail = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object');
    expect(retail.customProgramCacheKey()).toContain(RETAIL_LIGHTING_CACHE_KEY);
    setRemaster(parseRemaster('?remaster'));
    const rm = applyRetailLighting(new THREE.MeshLambertMaterial(), 'object');
    expect(rm.customProgramCacheKey()).toContain(REMASTER_LIGHTING_CACHE_KEY);
    expect(retailLightingKindOf(rm)).toBe('object');
    const sky = applyRetailLighting(new THREE.MeshLambertMaterial(), 'sky');
    expect(sky.customProgramCacheKey()).toContain(RETAIL_LIGHTING_CACHE_KEY);
    const shader = { uniforms: {} as Record<string, unknown>, vertexShader: THREE.ShaderLib.lambert.vertexShader, fragmentShader: frag };
    rm.onBeforeCompile(shader as never, {} as never);
    expect(shader.uniforms.acAmbientScale).toBeDefined();
    expect(shader.fragmentShader).toContain('acRemasterAtten');
  });
  it('shadow roles: objects and cells cast, the ground only receives, the sky neither', () => {
    expect(remasterCastsShadow('object')).toBe(true);
    expect(remasterCastsShadow('landscape')).toBe(false);
    expect(remasterReceivesShadow('landscape')).toBe(true);
    expect(remasterCastsShadow('sky')).toBe(false);
    expect(remasterReceivesShadow('sky')).toBe(false);
  });
});

/** An n-sided open cylinder (a limb) with outward ring normals. */
function cylinder(n: number): GfxObjGeometry {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    for (const y of [0, 1]) { pos.push(Math.cos(a), y, Math.sin(a)); nor.push(Math.cos(a), 0, Math.sin(a)); uv.push(i / n, y); }
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = ((i + 1) % n) * 2;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const tris = idx.length / 3;
  return {
    positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: new Float32Array(uv), indices: new Uint16Array(idx),
    surfaceIndices: new Array(tris).fill(0), doubleSided: new Array(tris).fill(false), clampUV: new Array(tris).fill(false), batchOrdered: false,
  };
}

/** A unit box whose corner normals are averaged (the bookcase case): 8 shared vertices. */
function smoothBox(): GfxObjGeometry {
  const pos: number[] = [], nor: number[] = [];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? 1 : -1, y = i & 2 ? 1 : -1, z = i & 4 ? 1 : -1;
    pos.push(x, y, z);
    const l = Math.sqrt(3);
    nor.push(x / l, y / l, z / l);
  }
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const idx: number[] = [];
  for (const [a, b, c, d] of quads) idx.push(a, b, c, a, c, d);
  const tris = idx.length / 3;
  return {
    positions: new Float32Array(pos), normals: new Float32Array(nor), uvs: new Float32Array(16), indices: new Uint16Array(idx),
    surfaceIndices: new Array(tris).fill(0), doubleSided: new Array(tris).fill(false), clampUV: new Array(tris).fill(false), batchOrdered: false,
  };
}

describe('PnTessellation: smoother silhouettes from the DAT normals, hard shapes kept', () => {
  it('rounds a limb: more triangles, points pushed out toward the true circle, corners kept', () => {
    const g = cylinder(8);
    const t = tessellatePn(g, 3);
    expect(t).not.toBe(g);
    expect(t.indices.length / 3).toBe((g.indices.length / 3) * 9);
    let maxR = 0;
    for (let i = 0; i < t.positions.length; i += 3) maxR = Math.max(maxR, Math.hypot(t.positions[i], t.positions[i + 2]));
    // A flat octagon face's midpoint sits at cos(22.5°) = 0.924; mid-height the curved patch
    // bulges toward the circle (the open rims at y = 0 and 1 stay straight, as part joins must).
    let minMid = Infinity;
    for (let i = 0; i < t.positions.length; i += 3) {
      if (t.positions[i + 1] > 0.3 && t.positions[i + 1] < 0.7) minMid = Math.min(minMid, Math.hypot(t.positions[i], t.positions[i + 2]));
    }
    expect(minMid).toBeGreaterThan(0.924 + 0.01);
    expect(maxR).toBeLessThan(1.05);
    expect(t.surfaceIndices.length).toBe(t.indices.length / 3);
  });
  it('leaves a box with averaged corner normals alone (bookcases, crates stay flat)', () => {
    const g = smoothBox();
    expect(tessellatePn(g, 3)).toBe(g);
  });
  it('skips meshes too large to be props or bodies', () => {
    const big = cylinder(Math.ceil(PN_MAX_TRIANGLES / 2) + 2);
    expect(tessellatePn(big, 2)).toBe(big);
  });
  it('raycasts hit the DAT triangles, not the smoothed ones (visual-only)', () => {
    const g = cylinder(8);
    const t = tessellatePn(g, 3);
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.geometry.setAttribute('position', new THREE.BufferAttribute(t.positions, 3));
    mesh.geometry.setIndex(new THREE.BufferAttribute(t.indices, 1));
    raycastAgainstDat(mesh, g, Array.from(g.indices));
    mesh.updateMatrixWorld(true);
    // A ray toward the centre of a face hits the flat DAT face at cos(22.5°), not the bulge.
    const a = Math.PI / 8;
    const rc = new THREE.Raycaster(new THREE.Vector3(Math.cos(a) * 5, 0.5, Math.sin(a) * 5), new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a)));
    const hit = rc.intersectObject(mesh)[0];
    expect(hit.object).toBe(mesh);
    expect(5 - hit.distance).toBeCloseTo(Math.cos(Math.PI / 8), 3);
  });
});

/** A flat-ish landblock: heights rise 1 m per vertex eastward; corner types/roads per cell. */
function landblock(type: number, road = false): GrassLandblock {
  const positions = new Float32Array(81 * 3);
  for (let c = 0; c < 9; c++) for (let r = 0; r < 9; r++) {
    const i = (c * 9 + r) * 3;
    positions[i] = c * 24; positions[i + 1] = c; positions[i + 2] = r * 24;
  }
  return {
    geometry: { positions },
    cellCornerTerrainTypes: new Array(256).fill(type),
    cellCornerRoadBits: new Array(256).fill(road ? 1 : 0),
    source: { landblockId: 0xa9b4ffff },
  };
}

describe('GrassField: grown from the DAT landscape', () => {
  it('stands on the drawn terrain plane', () => {
    const lb = landblock(0x3);
    expect(sampleGround(lb, 12, 12).height).toBeCloseTo(0.5, 5);
    expect(sampleGround(lb, 36, 5).height).toBeCloseTo(1.5, 5);
  });
  it('grows by terrain type: lush > grassland > none on dirt, sand, water', () => {
    expect(sampleGround(landblock(0x3), 10, 10).density).toBeCloseTo(GRASS_DENSITY[0x3], 5);
    expect(sampleGround(landblock(0x1), 10, 10).density).toBeCloseTo(GRASS_DENSITY[0x1], 5);
    for (const bare of [0x0, 0x5, 0x7, 0xa, 0x10, 0x14]) expect(sampleGround(landblock(bare), 10, 10).density).toBe(0);
  });
  it('nothing grows on road; a cell with one road corner keeps grass away from it', () => {
    expect(sampleGround(landblock(0x3, true), 10, 10).density).toBe(0);
    const lb = landblock(0x3);
    lb.cellCornerRoadBits[0] = 1; // cell (0,0)'s SW corner is road
    expect(sampleGround(lb, 1, 1).density).toBe(0);
    expect(sampleGround(lb, 18, 18).density).toBeCloseTo(GRASS_DENSITY[0x3], 5);
  });
  it('a clump is a handful of tapered blades with a root-to-tip attribute', () => {
    const g = buildClumpGeometry();
    const tip = g.getAttribute('grassTip');
    expect(tip.count).toBe(g.getAttribute('position').count);
    let min = 1, max = 0;
    for (let i = 0; i < tip.count; i++) { min = Math.min(min, tip.getX(i)); max = Math.max(max, tip.getX(i)); }
    expect([min, max]).toEqual([0, 1]);
  });
  it('averages a DAT texture into a linear colour', () => {
    const c = averageTextureColor(new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255]));
    expect(c.r).toBeCloseTo(1, 5);
    expect(c.g).toBe(0);
  });
});

describe('RemasterPipeline: shadow roles from each mesh\'s lighting kind', () => {
  it('objects cast and receive, ground receives, particles and grass never cast', () => {
    setRemaster(parseRemaster('?remaster'));
    const scene = new THREE.Scene();
    const obj = new THREE.Mesh(new THREE.BoxGeometry(), applyRetailLighting(new THREE.MeshLambertMaterial(), 'object'));
    const ground = new THREE.Mesh(new THREE.BoxGeometry(), applyRetailLighting(new THREE.MeshLambertMaterial(), 'landscape'));
    const particleMat = applyRetailLighting(new THREE.MeshLambertMaterial({ transparent: true }), 'object');
    particleMat.userData.particleSurface = {};
    const particle = new THREE.Mesh(new THREE.BoxGeometry(), particleMat);
    const grass = new THREE.Mesh(new THREE.BoxGeometry(), applyRetailLighting(new THREE.MeshLambertMaterial(), 'object'));
    grass.userData.remasterGrass = true;
    scene.add(obj, ground, particle, grass);
    applyShadowFlags(scene, true);
    expect([obj.castShadow, obj.receiveShadow]).toEqual([true, true]);
    expect([ground.castShadow, ground.receiveShadow]).toEqual([false, true]);
    expect(particle.castShadow).toBe(false);
    expect(grass.castShadow).toBe(false);
    applyShadowFlags(scene, false);
    expect(obj.castShadow || obj.receiveShadow).toBe(false);
  });
});

describe('AssetOverrides: a remodel draws in place of a DAT part (visual only)', () => {
  it('off by default; under remaster assets it hides the DAT meshes, which keep answering raycasts', async () => {
    const { applyAssetOverride, registerAssetOverride, REMASTER_ASSET_KEY } = await import('../packages/renderer/src/remaster/AssetOverrides.js');
    const ID = 0x01fff001;
    registerAssetOverride(ID, () => new THREE.Mesh(new THREE.SphereGeometry(5), new THREE.MeshBasicMaterial()));
    const build = () => {
      const g = new THREE.Group();
      const dat = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      dat.userData.surfaceId = 0x08000001;
      g.add(dat);
      return { g, dat };
    };
    const off = build();
    expect(applyAssetOverride(off.g, ID)).toBe(false);
    expect(off.dat.visible).toBe(true);
    setRemaster(parseRemaster('?remaster=assets'));
    const on = build();
    expect(applyAssetOverride(on.g, ID)).toBe(true);
    expect(on.dat.visible).toBe(false);
    const replacement = on.g.children.find(c => c.userData[REMASTER_ASSET_KEY])!;
    expect(replacement).toBeDefined();
    on.g.updateMatrixWorld(true);
    // A ray that would hit the big replacement sphere at 5 m hits only the 1 m DAT box.
    const hits = new THREE.Raycaster(new THREE.Vector3(10, 0, 0), new THREE.Vector3(-1, 0, 0)).intersectObject(on.g, true);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every(h => h.object === on.dat)).toBe(true);
    expect(hits[0].distance).toBeCloseTo(9.5, 5);
    expect(applyAssetOverride(build().g, 0x01fff002)).toBe(false);
  });
  it('a remodelled part opts out of the DAT degrade chain (it would swap the old meshes back in)', async () => {
    const { DegradeLod } = await import('../packages/renderer/src/models/DegradeLod.js');
    const { REMASTER_ASSET_KEY } = await import('../packages/renderer/src/remaster/AssetOverrides.js');
    const lod = new DegradeLod(null);
    // A two-level chain whose level 0 is the part itself.
    (lod as unknown as { chainFor: () => unknown }).chainFor = () => ({
      infoId: 0x11000001, levelIds: [1, 2],
      degrades: [{ gfxObjId: 1, degradeMode: 1, minDist: 0, idealDist: 0, maxDist: 100 }, { gfxObjId: 2, degradeMode: 1, minDist: 0, idealDist: 50, maxDist: 100 }],
    });
    const plain = new THREE.Group();
    plain.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    expect(lod.attachPart(plain, 1, () => null)).toBe(true);
    const part = new THREE.Group();
    const rep = new THREE.Group(); rep.userData[REMASTER_ASSET_KEY] = true; part.add(rep);
    expect(lod.attachPart(part, 1, () => null)).toBe(false);
  });
  it('the PBR patch lights replacement materials with the same DAT lights (PI-scaled for the 1/PI BRDF)', async () => {
    const { patchRemasterPbrFragment } = await import('../packages/renderer/src/remaster/RemasterLighting.js');
    const out = patchRemasterPbrFragment(THREE.ShaderLib.physical.fragmentShader);
    expect(out).toMatch(/^#define AC_LIGHT_SCALE 3\.14159265/);
    expect(out).toContain('directLight.color = acLightToLinear(');
    expect(out).toContain('acRemasterAtten( lightDistance');
  });
});

describe('Lifestone remodel: the same DAT model, modernised', () => {
  it('replaces the three DAT legs and the crystal', async () => {
    const { LIFESTONE_LEG_IDS, LIFESTONE_CRYSTAL_ID } = await import('../packages/renderer/src/remaster/remodels/Lifestone.js');
    expect([...LIFESTONE_LEG_IDS]).toEqual([0x01000d00, 0x01000d02, 0x01000d06]);
    expect(LIFESTONE_CRYSTAL_ID).toBe(0x01000cfa);
  });
  it('keeps every DAT triangle exactly and flags only the hard edges for bevels', async () => {
    const { buildBevelGeometries } = await import('../packages/renderer/src/remaster/remodels/FromDat.js');
    // A DAT-style box: shared corner vertices, one surface.
    const box = new THREE.BoxGeometry(2, 1, 1).toNonIndexed();
    const merged = (await import('three/examples/jsm/utils/BufferGeometryUtils.js')).mergeVertices(box.deleteAttribute('normal').deleteAttribute('uv'));
    merged.computeVertexNormals();
    merged.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(merged.getAttribute('position').count * 2), 2));
    const dat = new THREE.Mesh(merged, new THREE.MeshLambertMaterial());
    const [g] = buildBevelGeometries([dat]);
    const triCount = merged.getIndex()!.count / 3;
    expect(g.getAttribute('position').count).toBe(triCount * 3);
    // Same triangles, same corners: every output vertex is a DAT vertex.
    const datP = merged.getAttribute('position');
    const corners = new Set(Array.from({ length: datP.count }, (_, i) => `${datP.getX(i)},${datP.getY(i)},${datP.getZ(i)}`));
    const out = g.getAttribute('position');
    for (let i = 0; i < out.count; i++) expect(corners.has(`${out.getX(i)},${out.getY(i)},${out.getZ(i)}`)).toBe(true);
    // A box's diagonals are flat (not bevelled); its 12 real edges are hard.
    const hard = g.getAttribute('acHard');
    let flagged = 0;
    for (let i = 0; i < hard.count; i += 3) flagged += hard.getX(i) + hard.getY(i) + hard.getZ(i);
    expect(flagged).toBe(24); // each of the 12 box edges is shared by 2 triangles
  });
});
