/**
 * REMASTER grass (opt-in, RemasterMode.ts) — instanced 3D grass near the
 * camera, grown from the DAT landscape:
 *
 *  - where: each landscape cell's four corner terrain types (CellLandblock
 *    terrain bits 2-6, LandDefs.TerrainType) set the density, blended across
 *    the cell, so lush grassland is thick, patchy grassland thin, and dirt,
 *    rock, sand, snow, water and road (the corner road bits) bare;
 *  - height: the drawn terrain triangle under each clump (the landblock's
 *    LandHeightTable heights and its PRNG split, LandblockMesh), so blades
 *    stand on the ground the player sees;
 *  - colour: the average colour of that terrain type's own DAT texture,
 *    darker at the root and lighter at the tip;
 *  - never inside a building's footprint.
 *
 * Purely visual: nothing here is read by collision, picking or the server.
 * Blades receive the sun's shadow, sway in a wind field and fade out with
 * distance.
 */
import * as THREE from 'three';
import { computeCellSplitDir, landblockX, landblockY } from '@ac/shared';
import { applyRetailLighting } from '../models/RetailLighting.js';

/** LandDefs.TerrainType → clumps per square metre. Unlisted types grow nothing. */
export const GRASS_DENSITY: Readonly<Record<number, number>> = {
  0x1: 1.0,   // Grassland
  0x3: 1.25,  // LushGrass
  0x4: 0.55,  // MarshSparseSwamp
  0x8: 0.2,   // PatchyDirt
  0x9: 0.6,   // PatchyGrassland
  0xe: 0.12,  // SemiBarrenRock
};

export const GRASS_PATCH_SIZE = 8;
export const GRASS_RADIUS = 30;
/** Clumps per m² at full density, near the camera; thins to a third at the edge. */
export const GRASS_NEAR_CLUMPS = 7;
/** Patches built per frame (spreads the CPU cost while walking). */
export const GRASS_BUILDS_PER_FRAME = 3;
const BLADES_PER_CLUMP = 5;

/** The full-resolution landscape for one block, as LandblockMesh holds it. */
export interface GrassLandblock {
  geometry: { positions: Float32Array };
  cellCornerTerrainTypes: number[];
  cellCornerRoadBits: number[];
  source: { landblockId?: number };
}

export interface GrassWorld {
  /** The loaded full-resolution landblock for a 0xXXYYFFFF id. */
  landblock(fileId: number): GrassLandblock | undefined;
  /** Average linear colour of a terrain type's DAT texture (null = unknown). */
  terrainColor(terrainType: number): THREE.Color | null;
  /** Building footprints to keep clear (world-space boxes). */
  buildingBoxes(): Iterable<THREE.Box3>;
}

/** Height of the drawn landscape at a point, and the clump density there (0 = bare). */
export function sampleGround(lb: GrassLandblock, lx: number, lz: number): { height: number; density: number; type: number } {
  const col = Math.min(7, Math.max(0, Math.floor(lx / 24)));
  const row = Math.min(7, Math.max(0, Math.floor(lz / 24)));
  const fx = lx / 24 - col, fz = lz / 24 - row;
  const P = lb.geometry.positions;
  const h = (c: number, r: number) => P[(c * 9 + r) * 3 + 1];
  const hsw = h(col, row), hse = h(col + 1, row), hnw = h(col, row + 1), hne = h(col + 1, row + 1);
  const id = lb.source.landblockId;
  const splitNWtoSE = id !== undefined ? computeCellSplitDir(landblockX(id), landblockY(id), col, row) : true;
  let height: number;
  if (splitNWtoSE) {
    height = fx + fz <= 1
      ? hsw + (hse - hsw) * fx + (hnw - hsw) * fz
      : hne + (hnw - hne) * (1 - fx) + (hse - hne) * (1 - fz);
  } else {
    height = fx >= fz
      ? hsw + (hse - hsw) * fx + (hne - hse) * fz
      : hsw + (hnw - hsw) * fz + (hne - hnw) * fx;
  }
  // Corners [SW, SE, NE, NW]; bilinear weights.
  const cell = col * 8 + row;
  const w = [(1 - fx) * (1 - fz), fx * (1 - fz), fx * fz, (1 - fx) * fz];
  let density = 0, best = -1, type = 0, road = 0;
  for (let k = 0; k < 4; k++) {
    const tt = lb.cellCornerTerrainTypes[cell * 4 + k] ?? 0;
    const d = GRASS_DENSITY[tt] ?? 0;
    if (lb.cellCornerRoadBits[cell * 4 + k]) road += w[k];
    density += d * w[k];
    if (w[k] > best && d > 0) { best = w[k]; type = tt; }
  }
  // Road corners pave the part of the cell nearest them: full grass up to a
  // road weight of 0.3, none past 0.6 (a cell's centre with one road corner
  // keeps its grass; the strip along a road of road corners stays bare).
  density *= Math.min(1, Math.max(0, (0.6 - road) / 0.3));
  return { height, density, type };
}

/** A small deterministic PRNG per patch, so a patch regrows identically. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One clump: BLADES_PER_CLUMP tapered three-segment blades, root at the origin. */
export function buildClumpGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], tip: number[] = [], idx: number[] = [];
  const rnd = mulberry32(1234);
  const SEG = 3;
  for (let b = 0; b < BLADES_PER_CLUMP; b++) {
    const ang = rnd() * Math.PI * 2;
    const off = 0.12 * Math.sqrt(rnd());
    const ox = Math.cos(ang) * off, oz = Math.sin(ang) * off;
    const face = rnd() * Math.PI;
    const dx = Math.cos(face), dz = Math.sin(face);
    const lean = (rnd() - 0.5) * 0.18;
    const height = 0.32 + rnd() * 0.28;
    const width = 0.05 + rnd() * 0.035;
    const base = pos.length / 3;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const wHalf = width * (1 - t * 0.85) * 0.5;
      const y = height * t;
      const bend = lean * t * t;
      for (const side of [-1, 1]) {
        pos.push(ox + dx * wHalf * side + -dz * bend, y, oz + dz * wHalf * side + dx * bend);
        // Normals lean up so blades shade like the ground they grow from.
        nor.push(-dz * 0.15, 0.99, dx * 0.15);
        tip.push(t);
      }
    }
    for (let s = 0; s < SEG; s++) {
      const a = base + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('grassTip', new THREE.Float32BufferAttribute(tip, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const windTime = { value: 0 };

/** The grass material: the remaster lighting plus a wind sway and a root-to-tip tint. */
export function buildGrassMaterial(): THREE.MeshLambertMaterial {
  const mat = applyRetailLighting(new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide }), 'object');
  const lit = mat.onBeforeCompile;
  const litKey = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    lit.call(mat, shader, renderer);
    shader.uniforms.acGrassTime = windTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float grassTip;\nuniform float acGrassTime;\nvarying float vGrassTip;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
	vGrassTip = grassTip;
	#ifdef USE_INSTANCING
	vec2 acRoot = instanceMatrix[ 3 ].xz;
	#else
	vec2 acRoot = vec2( 0.0 );
	#endif
	float acGust = sin( acGrassTime * 1.3 + acRoot.x * 0.11 + acRoot.y * 0.07 ) * 0.5 + 0.5;
	float acFlutter = sin( acGrassTime * 4.1 + acRoot.x * 1.7 + acRoot.y * 1.3 );
	float acSway = ( 0.04 + 0.09 * acGust ) * grassTip * grassTip;
	transformed.x += acSway + acFlutter * 0.015 * grassTip;
	transformed.z += acSway * 0.4;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGrassTip;')
      // Both faces of a blade take its up-leaning normal (three flips it for back faces).
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n\tnormal = normalize( vNormal );')
      .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.rgb *= mix( 0.72, 1.15, vGrassTip );');
  };
  mat.customProgramCacheKey = () => `${litKey}|acGrass`;
  mat.needsUpdate = true;
  return mat;
}

/** A built patch; null mesh = bare ground there. */
interface Patch { mesh: THREE.InstancedMesh | null }

export class GrassField {
  private readonly geometry = buildClumpGeometry();
  private readonly material = buildGrassMaterial();
  private readonly patches = new Map<string, Patch>();
  private readonly root = new THREE.Group();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpS = new THREE.Vector3();
  private readonly tmpP = new THREE.Vector3();
  private readonly tmpC = new THREE.Color();
  private readonly start = performance.now();

  constructor(scene: THREE.Scene, private readonly world: GrassWorld) {
    this.root.name = 'remaster_grass';
    scene.add(this.root);
  }

  get patchCount(): number { return this.patches.size; }

  update(camera: THREE.Camera): void {
    windTime.value = (performance.now() - this.start) / 1000;
    const cam = camera.getWorldPosition(this.tmpP);
    const cx = Math.floor(cam.x / GRASS_PATCH_SIZE), cz = Math.floor(cam.z / GRASS_PATCH_SIZE);
    const r = Math.ceil(GRASS_RADIUS / GRASS_PATCH_SIZE);
    const want: Array<{ key: string; px: number; pz: number; d: number }> = [];
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const mx = (ix + 0.5) * GRASS_PATCH_SIZE - cam.x, mz = (iz + 0.5) * GRASS_PATCH_SIZE - cam.z;
        const d = Math.hypot(mx, mz);
        if (d > GRASS_RADIUS + GRASS_PATCH_SIZE) continue;
        want.push({ key: `${ix},${iz}`, px: ix, pz: iz, d });
      }
    }
    const keep = new Set(want.map(w => w.key));
    for (const [key, p] of this.patches) {
      if (!keep.has(key)) { if (p.mesh) { this.root.remove(p.mesh); p.mesh.dispose(); } this.patches.delete(key); }
    }
    want.sort((a, b) => a.d - b.d);
    let built = 0;
    for (const w of want) {
      if (built >= GRASS_BUILDS_PER_FRAME) break;
      if (this.patches.has(w.key)) continue;
      const mesh = this.buildPatch(w.px, w.pz, w.d);
      // An unloaded landblock builds nothing yet: retry on a later frame.
      if (mesh === undefined) continue;
      built++;
      this.patches.set(w.key, { mesh });
      if (mesh) this.root.add(mesh);
    }
  }

  /** undefined = its landblock isn't loaded; null = loaded but bare. */
  private buildPatch(px: number, pz: number, distance: number): THREE.InstancedMesh | null | undefined {
    const x0 = px * GRASS_PATCH_SIZE, z0 = pz * GRASS_PATCH_SIZE;
    const blockX = Math.floor((x0 + GRASS_PATCH_SIZE / 2) / 192), blockY = Math.floor((z0 + GRASS_PATCH_SIZE / 2) / 192);
    const fileId = (((blockX & 0xff) << 24) | ((blockY & 0xff) << 16) | 0xffff) >>> 0;
    const lb = this.world.landblock(fileId);
    if (!lb) return undefined;
    const boxes = [...this.world.buildingBoxes()].filter(b =>
      b.max.x > x0 - 1 && b.min.x < x0 + GRASS_PATCH_SIZE + 1 && b.max.z > z0 - 1 && b.min.z < z0 + GRASS_PATCH_SIZE + 1);
    const rnd = mulberry32(((px * 73856093) ^ (pz * 19349663)) >>> 0);
    const lod = 1 - (2 / 3) * Math.min(1, distance / GRASS_RADIUS);
    const maxPer = Math.ceil(GRASS_PATCH_SIZE * GRASS_PATCH_SIZE * GRASS_NEAR_CLUMPS * 1.25 * lod);
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    for (let i = 0; i < maxPer; i++) {
      const wx = x0 + rnd() * GRASS_PATCH_SIZE, wz = z0 + rnd() * GRASS_PATCH_SIZE;
      const keepRoll = rnd(), sRoll = rnd(), yawRoll = rnd(), tintRoll = rnd();
      const bx = Math.floor(wx / 192), bz = Math.floor(wz / 192);
      if (bx !== blockX || bz !== blockY) continue;
      const g = sampleGround(lb, wx - blockX * 192, wz - blockY * 192);
      if (keepRoll >= g.density / 1.25) continue;
      if (boxes.some(b => wx > b.min.x && wx < b.max.x && wz > b.min.z && wz < b.max.z)) continue;
      const base = this.world.terrainColor(g.type) ?? this.tmpC.setRGB(0.18, 0.24, 0.08);
      const s = 0.7 + sRoll * 0.45;
      this.tmpQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yawRoll * Math.PI * 2);
      this.tmpS.set(s, s * (0.8 + g.density * 0.25), s);
      mats.push(new THREE.Matrix4().compose(new THREE.Vector3(wx, g.height - 0.03, wz), this.tmpQ, this.tmpS));
      cols.push(base.clone().multiplyScalar(0.85 + tintRoll * 0.3));
    }
    if (mats.length === 0) return null;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, mats.length);
    mats.forEach((m, i) => { mesh.setMatrixAt(i, m); mesh.setColorAt(i, cols[i]); });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.computeBoundingSphere();
    mesh.name = 'remaster_grass_patch';
    mesh.userData.remasterGrass = true;
    return mesh;
  }

  dispose(): void {
    for (const p of this.patches.values()) p.mesh?.dispose();
    this.patches.clear();
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** Average a DAT texture's RGBA bytes (sRGB) into a linear colour. */
export function averageTextureColor(data: ArrayLike<number>): THREE.Color {
  let r = 0, g = 0, b = 0, n = 0;
  const step = Math.max(4, Math.floor(data.length / 4 / 4096) * 4);
  for (let i = 0; i + 3 < data.length; i += step) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  return new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace);
}
