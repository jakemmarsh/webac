/**
 * Procedural noise for REMASTER remodels: tileable value-noise fBm (the fine
 * grain FromDat adds to upscaled DAT textures).
 */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Tileable value noise on a period×period lattice. */
export function valueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const w = (a: number) => ((a % period) + period) % period;
  const a = hash(w(xi), w(yi), seed), b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed), d = hash(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Tileable fBm in [0,1): `u`,`v` in [0,1), `base` lattice cells across the tile. */
export function fbm(u: number, v: number, base: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0, f = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u * f, v * f, f, seed + o * 17);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}
