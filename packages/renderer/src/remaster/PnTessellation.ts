/**
 * REMASTER models — smoother silhouettes from the DAT's own vertex normals.
 *
 * AC's models are low-poly, but their vertex normals already describe the
 * smooth surface the artists meant (that is why Gouraud lighting looks round
 * while the outline stays polygonal). Curved PN triangles (Vlachos et al.,
 * "Curved PN Triangles", 2001) turn each triangle into a cubic patch that
 * passes through its three corners and follows those normals, then sample it
 * on a finer grid. Nothing is invented: the patch is fully determined by the
 * DAT positions and normals.
 *
 * Hard edges stay hard. An edge is curved only when every triangle sharing it
 * agrees on the normal at both of its ends; a crease (a box corner, a sword
 * edge, a roof ridge) or an open boundary (where one body part meets the
 * next) stays straight, so neighbouring triangles and neighbouring parts keep
 * meeting exactly and flat-shaded props keep their shape. Triangles with no
 * curved edge are not subdivided at all.
 */
import * as THREE from 'three';
import type { GfxObjGeometry } from '../models/GfxObjMesh.js';

/** Normals within ~11° count as the same smooth surface. */
const SMOOTH_DOT = 0.98;
/**
 * And the two faces meet at under ~65°: a box whose DAT normals are averaged
 * across its corners (bookcases, crates) keeps its edges, while a six- or
 * eight-sided limb still curves.
 */
/**
 * A triangle curves only when each corner's DAT normal is within ~40° of the
 * face: a limb's ring of normals is (22–30°), a box with corner-averaged
 * normals (~55°) is not, so furniture keeps flat panels.
 */
const MIN_CORNER_FACE_COS = Math.cos((40 * Math.PI) / 180);
const MAX_DIHEDRAL_COS = Math.cos((65 * Math.PI) / 180);
/** Larger meshes (buildings, terrain-sized props) are left alone. */
export const PN_MAX_TRIANGLES = 3000;

export function pnLevelFor(triangles: number): number {
  return triangles <= 400 ? 3 : 2;
}

type V3 = [number, number, number];

function keyOf(p: Float32Array, i: number): string {
  return `${Math.round(p[i * 3] * 1e4)},${Math.round(p[i * 3 + 1] * 1e4)},${Math.round(p[i * 3 + 2] * 1e4)}`;
}

/**
 * Tessellate a GfxObj geometry into curved PN triangles. Returns the input
 * unchanged when nothing in it is smooth, it is too large, or the result
 * would not fit 16-bit indices.
 */
export function tessellatePn(geom: GfxObjGeometry, level?: number): GfxObjGeometry {
  const triCount = geom.indices.length / 3;
  if (triCount === 0 || triCount > PN_MAX_TRIANGLES) return geom;
  const L = Math.max(1, Math.floor(level ?? pnLevelFor(triCount)));
  if (L === 1) return geom;
  const P = geom.positions, N = geom.normals, T = geom.uvs, I = geom.indices;
  const vCount = P.length / 3;

  const posId = new Int32Array(vCount);
  const ids = new Map<string, number>();
  for (let v = 0; v < vCount; v++) {
    const k = keyOf(P, v);
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    posId[v] = id;
  }

  // Per (edge, end): the normals every triangle uses there; an edge is smooth
  // when it has 2+ triangles and each end's normals all agree.
  interface EdgeInfo { tris: number; na: V3; nb: V3; face: V3; smooth: boolean }
  const edges = new Map<string, EdgeInfo>();
  const nrm = (v: number): V3 => [N[v * 3], N[v * 3 + 1], N[v * 3 + 2]];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  const faceNormal = (a: number, b: number, c: number): V3 => {
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const n: V3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  const visitEdge = (va: number, vb: number, face: V3) => {
    const a = posId[va], b = posId[vb];
    if (a === b) return;
    const k = edgeKey(a, b);
    const lo = a < b ? va : vb, hi = a < b ? vb : va;
    const e = edges.get(k);
    if (!e) { edges.set(k, { tris: 1, na: nrm(lo), nb: nrm(hi), face, smooth: true }); return; }
    e.tris++;
    if (dot(e.na, nrm(lo)) < SMOOTH_DOT || dot(e.nb, nrm(hi)) < SMOOTH_DOT) e.smooth = false;
    // Faces folding past the crease angle (either winding: a SidesType copy) keep the edge.
    if (Math.abs(dot(e.face, face)) < MAX_DIHEDRAL_COS) e.smooth = false;
  };
  for (let t = 0; t < triCount; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const f = faceNormal(a, b, c);
    visitEdge(a, b, f); visitEdge(b, c, f); visitEdge(c, a, f);
  }
  // Second pass: a triangle with a corner normal far off its face pins all three edges straight.
  for (let t = 0; t < triCount; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    // Orient the face normal with its vertex normals: the world's AC → three
    // axis swap mirrors every mesh, which reverses the winding.
    const f0 = faceNormal(a, b, c);
    const na = nrm(a), nb = nrm(b), nc = nrm(c);
    const sgn = dot([na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]], f0) < 0 ? -1 : 1;
    const f: V3 = [f0[0] * sgn, f0[1] * sgn, f0[2] * sgn];
    if (dot(nrm(a), f) >= MIN_CORNER_FACE_COS && dot(nrm(b), f) >= MIN_CORNER_FACE_COS && dot(nrm(c), f) >= MIN_CORNER_FACE_COS) continue;
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const e = edges.get(edgeKey(posId[x], posId[y]));
      if (e) e.smooth = false;
    }
  }
  const smoothEdge = (va: number, vb: number): boolean => {
    const e = edges.get(edgeKey(posId[va], posId[vb]));
    return !!e && e.smooth && e.tris >= 2;
  };

  const subTris = (L * L);
  const subVerts = ((L + 1) * (L + 2)) / 2;
  const curved: boolean[] = [];
  let outVerts = 0, outTris = 0, anyCurved = false;
  for (let t = 0; t < triCount; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const cur = smoothEdge(a, b) || smoothEdge(b, c) || smoothEdge(c, a);
    curved.push(cur);
    anyCurved ||= cur;
    outVerts += cur ? subVerts : 3;
    outTris += cur ? subTris : 1;
  }
  if (!anyCurved || outVerts > 65535) return geom;

  const pos = new Float32Array(outVerts * 3);
  const nor = new Float32Array(outVerts * 3);
  const uv = new Float32Array(outVerts * 2);
  const idx = new Uint16Array(outTris * 3);
  const surfaceIndices: number[] = [];
  const doubleSided: boolean[] = [];
  const clampUV: boolean[] = [];
  let vo = 0, io = 0;

  const put = (p: V3, n: V3, u: number, v: number): number => {
    pos[vo * 3] = p[0]; pos[vo * 3 + 1] = p[1]; pos[vo * 3 + 2] = p[2];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    nor[vo * 3] = n[0] / l; nor[vo * 3 + 1] = n[1] / l; nor[vo * 3 + 2] = n[2] / l;
    uv[vo * 2] = u; uv[vo * 2 + 1] = v;
    return vo++;
  };
  const pt = (v: number): V3 => [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]];

  for (let t = 0; t < triCount; t++) {
    const i1 = I[t * 3], i2 = I[t * 3 + 1], i3 = I[t * 3 + 2];
    const keep = () => {
      surfaceIndices.push(geom.surfaceIndices[t]);
      doubleSided.push(geom.doubleSided[t]);
      clampUV.push(geom.clampUV[t]);
    };
    if (!curved[t]) {
      for (const v of [i1, i2, i3]) idx[io++] = put(pt(v), nrm(v), T[v * 2], T[v * 2 + 1]);
      keep();
      continue;
    }
    const p1 = pt(i1), p2 = pt(i2), p3 = pt(i3);
    const n1 = nrm(i1), n2 = nrm(i2), n3 = nrm(i3);
    // Edge control point near `pa` on edge pa→pb (linear for a crease / boundary).
    const ctrl = (pa: V3, pb: V3, na: V3, curvedEdge: boolean): V3 => {
      const w = curvedEdge ? (pb[0] - pa[0]) * na[0] + (pb[1] - pa[1]) * na[1] + (pb[2] - pa[2]) * na[2] : 0;
      return [(2 * pa[0] + pb[0] - w * na[0]) / 3, (2 * pa[1] + pb[1] - w * na[1]) / 3, (2 * pa[2] + pb[2] - w * na[2]) / 3];
    };
    const s12 = smoothEdge(i1, i2), s23 = smoothEdge(i2, i3), s31 = smoothEdge(i3, i1);
    const b210 = ctrl(p1, p2, n1, s12), b120 = ctrl(p2, p1, n2, s12);
    const b021 = ctrl(p2, p3, n2, s23), b012 = ctrl(p3, p2, n3, s23);
    const b102 = ctrl(p3, p1, n3, s31), b201 = ctrl(p1, p3, n1, s31);
    const b111: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const e = (b210[k] + b120[k] + b021[k] + b012[k] + b102[k] + b201[k]) / 6;
      const c = (p1[k] + p2[k] + p3[k]) / 3;
      b111[k] = e + (e - c) / 2;
    }
    const grid: number[][] = [];
    for (let i = 0; i <= L; i++) {
      grid.push([]);
      for (let j = 0; j <= L - i; j++) {
        const u = i / L, v = j / L, w = 1 - u - v;   // w → p1, u → p2, v → p3
        const p: V3 = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          p[k] = p1[k] * w * w * w + p2[k] * u * u * u + p3[k] * v * v * v
            + 3 * (b210[k] * w * w * u + b120[k] * w * u * u + b201[k] * w * w * v
              + b021[k] * u * u * v + b102[k] * w * v * v + b012[k] * u * v * v)
            + 6 * b111[k] * w * u * v;
        }
        const n: V3 = [n1[0] * w + n2[0] * u + n3[0] * v, n1[1] * w + n2[1] * u + n3[1] * v, n1[2] * w + n2[2] * u + n3[2] * v];
        const tu = T[i1 * 2] * w + T[i2 * 2] * u + T[i3 * 2] * v;
        const tv = T[i1 * 2 + 1] * w + T[i2 * 2 + 1] * u + T[i3 * 2 + 1] * v;
        grid[i].push(put(p, n, tu, tv));
      }
    }
    for (let i = 0; i < L; i++) {
      for (let j = 0; j < L - i; j++) {
        idx[io++] = grid[i][j]; idx[io++] = grid[i + 1][j]; idx[io++] = grid[i][j + 1];
        keep();
        if (j < L - i - 1) {
          idx[io++] = grid[i + 1][j]; idx[io++] = grid[i + 1][j + 1]; idx[io++] = grid[i][j + 1];
          keep();
        }
      }
    }
  }

  return {
    positions: pos, normals: nor, uvs: uv, indices: idx,
    surfaceIndices, doubleSided, clampUV, batchOrdered: geom.batchOrdered,
  };
}

/**
 * Make a smoothed mesh answer raycasts with its DAT triangles: a hidden proxy
 * over the original positions and this surface's original indices, placed
 * with the mesh's own world matrix. Hits report the drawn mesh as their object,
 * so every caller (picking, camera / wall rays) sees exactly what retail
 * geometry gives it.
 */
export function raycastAgainstDat(mesh: THREE.Mesh, dat: GfxObjGeometry, indices: number[]): void {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(dat.positions, 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));
  const proxy = new THREE.Mesh(geom);
  mesh.raycast = (raycaster, hits) => {
    proxy.material = mesh.material;
    proxy.matrixWorld.copy(mesh.matrixWorld);
    const start = hits.length;
    proxy.raycast(raycaster, hits);
    for (let i = start; i < hits.length; i++) hits[i].object = mesh;
  };
}
