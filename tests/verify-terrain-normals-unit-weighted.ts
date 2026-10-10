/**
 * SWEEP1006 terrain normals — CLandBlockStruct::calc_lighting @ 00531700
 * adds each polygon's unit plane normal (plane.N) to its vertices, then
 * normalises: every adjacent face weighs the same. Ours summed the raw cross
 * products, weighting a face by its area.
 */
import { describe, it, expect } from 'vitest';
import { computeSmoothNormals } from '../packages/renderer/src/terrain/LandblockMesh.js';

describe('terrain vertex normals average the unit face normals', () => {
  it('a big flat face and a small steep face count equally at the shared vertex', () => {
    // Vertex 0 at the origin. Face A: big, flat (normal +Y). Face B: small, vertical (normal +Z).
    const positions = new Float32Array([
      0, 0, 0, // 0 shared
      0, 0, -10, // 1
      10, 0, 0, // 2  (A: 0,2,1 → +Y, area 50)
      1, 0, 0, // 3
      0, 1, 0, // 4  (B: 0,3,4 → +Z, area 0.5)
    ]);
    const indices = new Uint16Array([0, 2, 1, 0, 3, 4]); // A wound so its normal is +Y
    const n = computeSmoothNormals(positions, indices);
    // Equal weights: (0, 1, 1)/√2 at vertex 0 — not ≈ +Y as area weighting gives.
    expect(n[0]).toBeCloseTo(0, 6);
    expect(n[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(n[2]).toBeCloseTo(Math.SQRT1_2, 6);
  });
});
