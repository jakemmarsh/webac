/**
 * REMASTER "modernise the same model": rebuild a DAT part from its own DAT
 * triangles and textures, so the silhouette is exactly retail's.
 *
 *  - Geometry: the DAT triangles, unchanged. Hard edges (faces meeting at
 *    more than ~25°) get a rounded bevel in the shading — the normal bends
 *    toward the welded smooth normal within a thin band along the edge — so
 *    they catch light like a modern bevelled asset without moving a vertex.
 *  - Textures: the DAT texture upscaled (bicubic) with fine tileable grain;
 *    a normal map and roughness derived from its luminance; and, optionally,
 *    metalness where the DAT paints a part blue-steel (its blue-dominant
 *    texels), so those read as polished metal.
 *  - Lighting: the remaster's DAT lights (applyRemasterPbr).
 *
 * Works from the hidden DAT meshes the override layer passes in, so any DAT
 * part can be modernised this way.
 */
import * as THREE from 'three';
import { applyRemasterPbr, getRemasterEnvMap } from '../AssetOverrides.js';
import { fbm } from './proc.js';

/** Faces folding more than this (degrees) make a hard, bevelled edge. */
export const HARD_EDGE_DEGREES = 25;
/** Bevel band, as a fraction of the triangle's barycentric extent. */
export const BEVEL_WIDTH = 0.07;

export interface FromDatOptions {
  /** Polished metal where the DAT texture is blue-dominant (lifestone claw edges). */
  metalFromBlue?: boolean;
  /** Texture upscale factor (capped at 1024 px). */
  upscale?: number;
  /** Replace each mesh's material (e.g. glass); receives the DAT material and the upscaled texture. */
  material?: (dat: THREE.Material, upscaled: THREE.Texture | null) => THREE.Material;
}

const posKey = (p: ArrayLike<number>, i: number) => `${Math.round(p[i * 3] * 1e4)},${Math.round(p[i * 3 + 1] * 1e4)},${Math.round(p[i * 3 + 2] * 1e4)}`;

/** Non-indexed copy of the DAT meshes' triangles with face / smooth normals, barycentrics and hard-edge flags. */
export function buildBevelGeometries(meshes: THREE.Mesh[]): THREE.BufferGeometry[] {
  interface Tri { mesh: number; v: [number, number, number]; keys: [string, string, string]; n: THREE.Vector3; area: number }
  const tris: Tri[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  meshes.forEach((m, mi) => {
    const g = m.geometry;
    const P = g.getAttribute('position').array as ArrayLike<number>;
    const N = g.getAttribute('normal')?.array as ArrayLike<number> | undefined;
    const I = g.getIndex()!.array as ArrayLike<number>;
    for (let t = 0; t < I.length; t += 3) {
      const v: [number, number, number] = [I[t], I[t + 1], I[t + 2]];
      a.fromArray(P as number[], v[0] * 3); b.fromArray(P as number[], v[1] * 3); c.fromArray(P as number[], v[2] * 3);
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const area = n.length() / 2;
      if (area < 1e-9) continue;
      n.normalize();
      // Orient the face by its DAT vertex normals (the world swizzle mirrors winding).
      if (N) {
        const avg = (N[v[0] * 3] + N[v[1] * 3] + N[v[2] * 3]) * n.x + (N[v[0] * 3 + 1] + N[v[1] * 3 + 1] + N[v[2] * 3 + 1]) * n.y + (N[v[0] * 3 + 2] + N[v[1] * 3 + 2] + N[v[2] * 3 + 2]) * n.z;
        if (avg < 0) n.negate();
      }
      tris.push({ mesh: mi, v, keys: [posKey(P, v[0]), posKey(P, v[1]), posKey(P, v[2])], n, area });
    }
  });
  // Welded smooth normals (area-weighted) and edge adjacency across all of the part's meshes.
  const smooth = new Map<string, THREE.Vector3>();
  const edges = new Map<string, THREE.Vector3[]>();
  const ek = (p: string, q: string) => (p < q ? `${p}|${q}` : `${q}|${p}`);
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const s = smooth.get(t.keys[k]) ?? new THREE.Vector3();
      smooth.set(t.keys[k], s.addScaledVector(t.n, t.area));
      const e = ek(t.keys[(k + 1) % 3], t.keys[(k + 2) % 3]);
      (edges.get(e) ?? edges.set(e, []).get(e)!).push(t.n);
    }
  }
  for (const s of smooth.values()) s.normalize();
  const cosHard = Math.cos((HARD_EDGE_DEGREES * Math.PI) / 180);
  const hardEdge = (p: string, q: string) => {
    const ns = edges.get(ek(p, q)) ?? [];
    if (ns.length < 2) return true;
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) if (Math.abs(ns[i].dot(ns[j])) < cosHard) return true;
    return false;
  };
  return meshes.map((m, mi) => {
    const g = m.geometry;
    const P = g.getAttribute('position').array as ArrayLike<number>;
    const UV = g.getAttribute('uv')?.array as ArrayLike<number> | undefined;
    const pos: number[] = [], nor: number[] = [], sn: number[] = [], uv: number[] = [], bary: number[] = [], hard: number[] = [];
    for (const t of tris) {
      if (t.mesh !== mi) continue;
      // Edge opposite corner k joins corners k+1, k+2.
      const h = [0, 1, 2].map(k => (hardEdge(t.keys[(k + 1) % 3], t.keys[(k + 2) % 3]) ? 1 : 0));
      for (let k = 0; k < 3; k++) {
        const vi = t.v[k];
        pos.push(P[vi * 3], P[vi * 3 + 1], P[vi * 3 + 2]);
        nor.push(t.n.x, t.n.y, t.n.z);
        const s = smooth.get(t.keys[k])!;
        sn.push(s.x, s.y, s.z);
        uv.push(UV ? UV[vi * 2] : 0, UV ? UV[vi * 2 + 1] : 0);
        bary.push(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
        hard.push(h[0], h[1], h[2]);
      }
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    out.setAttribute('acSmoothNormal', new THREE.Float32BufferAttribute(sn, 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    out.setAttribute('acBary', new THREE.Float32BufferAttribute(bary, 3));
    out.setAttribute('acHard', new THREE.Float32BufferAttribute(hard, 3));
    out.computeBoundingSphere();
    return out;
  });
}

/** Catmull-Rom bicubic sample of an RGBA byte image (wrapping), returning 0..1 floats. */
function sampleBicubic(d: ArrayLike<number>, w: number, h: number, x: number, y: number, ch: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  const px = (i: number, j: number) => d[((((j % h) + h) % h) * w + (((i % w) + w) % w)) * 4 + ch] / 255;
  const row = (j: number) => cr(px(xi - 1, j), px(xi, j), px(xi + 1, j), px(xi + 2, j), fx);
  return cr(row(yi - 1), row(yi), row(yi + 1), row(yi + 2), fy);
}

export interface UpscaledMaps { albedo: THREE.DataTexture; normal: THREE.DataTexture; roughness: THREE.DataTexture; metalness: THREE.DataTexture }

/** The DAT texture, upscaled with grain, plus derived normal / roughness / metalness maps. */
export function upscaleDatTexture(src: THREE.Texture, factor: number, metalFromBlue: boolean): UpscaledMaps | null {
  const img = src.image as { data?: ArrayLike<number>; width?: number; height?: number } | undefined;
  if (!img?.data || !img.width || !img.height) return null;
  const sw = img.width, sh = img.height;
  const w = Math.min(1024, sw * factor), h = Math.min(1024, sh * factor);
  const alb = new Uint8Array(w * h * 4), nor = new Uint8Array(w * h * 4), rgh = new Uint8Array(w * h * 4), met = new Uint8Array(w * h * 4);
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) * sw / w - 0.5, sy = (y + 0.5) * sh / h - 0.5;
      const grain = (fbm(x / w, y / h, 32, 3, 77) - 0.5) * 0.09;
      const i = (y * w + x) * 4;
      const rgb = [0, 1, 2].map(ch => Math.min(1, Math.max(0, sampleBicubic(img.data!, sw, sh, sx, sy, ch) * (1 + grain))));
      alb[i] = rgb[0] * 255; alb[i + 1] = rgb[1] * 255; alb[i + 2] = rgb[2] * 255;
      alb[i + 3] = Math.round(Math.min(1, Math.max(0, sampleBicubic(img.data!, sw, sh, sx, sy, 3))) * 255);
      const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      lum[y * w + x] = l;
      const blue = metalFromBlue ? Math.min(1, Math.max(0, (rgb[2] - Math.max(rgb[0], rgb[1]) - 0.04) * 6)) : 0;
      met[i] = met[i + 1] = met[i + 2] = Math.round(blue * 230); met[i + 3] = 255;
      const r = (0.88 - 0.35 * l) * (1 - blue) + 0.28 * blue;
      rgh[i] = rgh[i + 1] = rgh[i + 2] = Math.round(r * 255); rgh[i + 3] = 255;
    }
  }
  const at = (x: number, y: number) => lum[(((y + h) % h) * w) + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, s = 3.5 * (w / 256);
      const dx = (at(x + 1, y) - at(x - 1, y)) * s, dy = (at(x, y + 1) - at(x, y - 1)) * s;
      const l = Math.hypot(dx, dy, 1);
      nor[i] = Math.round(255 * (0.5 - 0.5 * dx / l)); nor[i + 1] = Math.round(255 * (0.5 - 0.5 * dy / l)); nor[i + 2] = Math.round(255 * (0.5 + 0.5 / l)); nor[i + 3] = 255;
    }
  }
  const tex = (data: Uint8Array, srgb: boolean) => {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    t.wrapS = src.wrapS; t.wrapT = src.wrapT;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { albedo: tex(alb, true), normal: tex(nor, false), roughness: tex(rgh, false), metalness: tex(met, false) };
}

/** The rounded-bevel shading: bend the normal toward the smooth normal along hard edges. */
export function applyBevel<T extends THREE.Material>(material: T): T {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 acBary;\nattribute vec3 acHard;\nattribute vec3 acSmoothNormal;\nvarying vec3 vAcBary;\nvarying vec3 vAcHard;\nvarying vec3 vAcSmoothN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAcBary = acBary;\n\tvAcHard = acHard;\n\tvAcSmoothN = normalMatrix * acSmoothNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vAcBary;\nvarying vec3 vAcHard;\nvarying vec3 vAcSmoothN;')
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
	{
		vec3 acB = mix( vec3( 1.0 ), vAcBary, vAcHard );
		float acEdge = min( acB.x, min( acB.y, acB.z ) );
		float acBev = 1.0 - smoothstep( 0.0, ${BEVEL_WIDTH.toFixed(3)}, acEdge );
		vec3 acS = normalize( vAcSmoothN ) * faceDirection;
		normal = normalize( mix( normal, acS, acBev * 0.85 ) );
	}`);
  };
  material.customProgramCacheKey = () => `${prevKey}|acBevel`;
  material.needsUpdate = true;
  return material;
}

/**
 * Modernise a DAT part from its own (hidden) DAT meshes: same triangles,
 * bevelled edges, upscaled textures, PBR under the DAT lights.
 */
export function remasterFromDat(meshes: THREE.Mesh[], opts: FromDatOptions = {}): THREE.Group {
  const out = new THREE.Group();
  out.name = 'remaster_from_dat';
  const geos = buildBevelGeometries(meshes);
  meshes.forEach((m, i) => {
    const dat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshLambertMaterial;
    const maps = dat.map ? upscaleDatTexture(dat.map, opts.upscale ?? 4, !!opts.metalFromBlue) : null;
    const material = opts.material
      ? opts.material(dat, maps?.albedo ?? null)
      : applyBevel(applyRemasterPbr(new THREE.MeshStandardMaterial({
        map: maps?.albedo ?? null, color: dat.map ? 0xffffff : dat.color,
        normalMap: maps?.normal ?? null, normalScale: new THREE.Vector2(1, 1),
        roughnessMap: maps?.roughness ?? null, roughness: 1,
        metalnessMap: maps?.metalness ?? null, metalness: maps ? 1 : 0,
        envMap: getRemasterEnvMap(), envMapIntensity: 0.8,
        side: dat.side, transparent: dat.transparent, alphaTest: dat.alphaTest, opacity: dat.opacity,
      })));
    const mesh = new THREE.Mesh(geos[i], material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.renderOrder = m.renderOrder;
    out.add(mesh);
  });
  return out;
}
