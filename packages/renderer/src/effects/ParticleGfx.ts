import * as THREE from 'three';
import type { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import type { GfxObjLOD } from '@ac/dat-parser/file-types/GfxObjDegradeInfo.js';

/**
 * VISUAL.particles-oriented-quads — what one particle draws.
 *
 * Retail draws every particle as a CPhysicsPart of the emitter's own
 * particle object (ParticleEmitter::SetInfo @ 0051ce90:
 * `CPhysicsPart::makePhysicsPart(info->hw_gfxobj_id)` × max_particles), so a
 * particle is the HW GfxObj's real mesh — usually one textured quad in the
 * GfxObj's local XZ plane, sometimes a non-square or off-centre quad, a flat
 * (XY) ground quad, or a small multi-polygon mesh — drawn through
 * CPhysicsPart::Draw @ 0050d7a0 at `gfxobj_scale` (Particle::Update's
 * lerped scale) in the part's frame:
 *
 * - Particle::Update @ 0051c290 writes only the part ORIGIN for every type
 *   except the GR ones (4 / 9 / 11), which copy the parent (or start) frame
 *   and then `Frame::rotate(C·t)` — so a non-GR particle keeps the identity
 *   (world-axis) orientation and a GR particle spins by C·t about an axis in
 *   the parent's frame.
 * - CPhysicsPart::UpdateViewerDistance @ 0050e030 picks the degrade level
 *   of the GfxObj's DIDDegrade chain (GfxObjDegradeInfo::get_degrade @
 *   0051e4b0, from |viewer − part| / scale): a level's GfxObj INVALID draws
 *   nothing (the particle LOD cut), and its degrade_mode re-orients the draw
 *   frame (CPhysicsPart::calc_draw_frame @ 0050dfa0): 2 = billboard
 *   (Frame::set_vector_heading), 5 = cylindrical about the part's local Z.
 *   A GfxObj without a chain stays mode 1 — drawn in its own frame.
 *
 * EoL census (every 0x32 emitter's HW GfxObj): 1,583 emitters use chain
 * modes "2 then INVALID" (billboard quads, e.g. the casting glows), 207
 * have no chain (drawn in-frame, e.g. the portal swirl 0x010016C8),
 * 159 "1 then INVALID", 54 "5 then INVALID", a handful multi-level.
 */

/** The surface a particle submesh draws with (the GfxObj's level-0 surface). */
export interface ParticleSurface {
  /** Surface texture (null: a solid-colour surface). */
  map: THREE.Texture | null;
  /** Surface Additive bit (0x10000). */
  additive: boolean;
  /** Surface colorValue (RGB) for an untextured surface; white otherwise. */
  color: number;
  /** 1 − Surface.translucency when the Translucent bit is set, else 1. */
  opacity: number;
  /** SetSurface's alpha-test ref for the surface (MaterialFactory.alphaTestRefFor), 0 = none. */
  alphaTest: number;
  /**
   * RENDER.particle-surface-state — the DAT Surface.type: blend, alpha test and
   * depth write follow MaterialFactory.surfaceMaterialState like every other
   * mesh (particles draw their HW GfxObj through DrawMesh → RenderMeshSubset
   * → SetSurface). Absent on the synthetic fallback square: Base1Image |
   * Alpha (| Additive when `additive`).
   */
  type?: number;
  /**
   * VISUAL.particle-surfaces-unlit — Surface.luminosity: the D3D material
   * emissive `D3DPolyRender::RenderMeshSubset` @ 0059ca10 adds to the lit
   * vertex colour (1 on most particle surfaces — saturated, full-bright;
   * 0 on smoke / debris — lit by the sun or the cell's lights like any part).
   */
  luminosity: number;
}

/** The polygons of one GfxObj that share one surface, as three.js geometry (AC → three axes). */
export interface ParticleSubmesh {
  geometry: THREE.BufferGeometry;
  surface: ParticleSurface;
}

/** Everything a ParticleSystem needs to draw its particles the retail way. */
export interface ParticleGfx {
  /** One entry per distinct drawable GfxObj of the chain; each is its per-surface submeshes. */
  gfxObjs: ParticleSubmesh[][];
  /**
   * The HW GfxObj's degrade chain (0x11 GfxObjDegradeInfo). Empty: one
   * level drawing gfxObjs[0] in mode 1, never degraded (no DIDDegrade).
   */
  degrades: GfxObjLOD[];
  /** Per degrade level: index into gfxObjs, −1 = INVALID_DID (draw nothing). */
  levelGfx: number[];
  /** Level-0 GfxObj sort centre (AC axes) — the viewer-distance point. */
  sortCenter: { x: number; y: number; z: number };
}

/**
 * GfxObjDegradeInfo::get_max_degrade_distance @ 0051e2d0 (via
 * CPhysicsPart::GetMaxDegradeDistance @ 0050d510, 100 m without a chain):
 * the emitter's degrade_distance — CPhysicsObj::ShouldDrawParticles @
 * 0050fe60 draws nothing while the emitter is farther than this.
 */
export function particleMaxDegradeDistance(degrades: readonly GfxObjLOD[]): number {
  const n = degrades.length;
  if (n === 0) return 100;
  const d = n > 2 ? degrades[n - 2].maxDist : degrades[0].maxDist;
  return d >= FLT_MAX ? Infinity : d;
}

/**
 * Triangulate a GfxObj's drawing polygons into per-surface geometries in
 * three.js axes (AC x, y, z → x, z, y; fan winding reversed for the
 * reflection, as GfxObjMesh does). Every polygon's UV comes from its own
 * posUVIndices and every vertex its own normal (VISUAL.particle-surfaces-
 * unlit: the fixed-function pipeline lights particles through the GfxObj's
 * vertex normals, FVF 0x252). `surfaces[i]` is the surface for GfxObj surface slot i —
 * retail draws every degrade level through the level-0 surface array
 * (CPhysicsPart::SetGfxObjArray @ 0050e2e0).
 */
export function buildParticleSubmeshes(gfxObj: GfxObj, surfaces: readonly ParticleSurface[]): ParticleSubmesh[] {
  const va = gfxObj.vertexArray;
  if (!va) return [];
  const bySurface = new Map<number, { pos: number[]; nrm: number[]; uv: number[]; idx: number[] }>();
  for (const poly of gfxObj.polygons) {
    const n = poly.vertexIndices.length;
    if (n < 3) continue;
    const slot = poly.posSurface;
    if (!surfaces[slot]) continue;
    let b = bySurface.get(slot);
    if (!b) { b = { pos: [], nrm: [], uv: [], idx: [] }; bySurface.set(slot, b); }
    const base = b.pos.length / 3;
    let ok = 0;
    for (let i = 0; i < n; i++) {
      const v = va.vertices.get(poly.vertexIndices[i] & 0xffff);
      if (!v) break;
      const uvI = i < poly.posUVIndices.length ? poly.posUVIndices[i] : 0;
      const uv = v.uvs[uvI] ?? v.uvs[0] ?? { u: 0, v: 0 };
      b.pos.push(v.origin.x, v.origin.z, v.origin.y);
      b.nrm.push(v.normal.x, v.normal.z, v.normal.y);
      b.uv.push(uv.u, uv.v);
      ok++;
    }
    if (ok !== n) { b.pos.length = base * 3; b.nrm.length = base * 3; b.uv.length = base * 2; continue; }
    for (let i = 2; i < n; i++) b.idx.push(base, base + i, base + i - 1);
  }
  const out: ParticleSubmesh[] = [];
  for (const [slot, b] of [...bySurface.entries()].sort((x, y) => x[0] - y[0])) {
    if (b.idx.length === 0) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setIndex(b.idx);
    out.push({ geometry: g, surface: surfaces[slot] });
  }
  return out;
}

/** FLT_MAX — the DAT's "never" distance (the INVALID level's thresholds). */
const FLT_MAX = 3.4028234663852886e38;

/**
 * A particle without DAT sprite data (a synthetic burst, or a sprite that
 * failed to resolve): one `extent`-metre square in the AC XZ plane with the
 * given texture, always billboarded (mode 2) and never degraded — what the
 * old camera-facing point sprites drew, now as a world-size quad.
 */
export function fallbackParticleGfx(
  extent: number,
  map: THREE.Texture | null = null,
  additive = false,
): ParticleGfx {
  const h = extent / 2;
  const g = new THREE.BufferGeometry();
  // AC (x, 0, z) → three (x, z, 0); UV v = 0 at the top (AC +z), as the DAT quads.
  g.setAttribute('position', new THREE.Float32BufferAttribute([-h, h, 0, h, h, 0, h, -h, 0, -h, -h, 0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  // The textured face looks along AC −Y (the billboard's viewer side) → three −Z.
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1], 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  return {
    // Luminosity 1: saturated full-bright, as the DAT's glow surfaces are.
    gfxObjs: [[{ geometry: g, surface: { map, additive, color: 0xffffff, opacity: 1, alphaTest: 0, luminosity: 1 } }]],
    degrades: [{ gfxObjId: 1, degradeMode: 2, minDist: FLT_MAX, idealDist: FLT_MAX, maxDist: FLT_MAX }],
    levelGfx: [0],
    sortCenter: { x: 0, y: 0, z: 0 },
  };
}
