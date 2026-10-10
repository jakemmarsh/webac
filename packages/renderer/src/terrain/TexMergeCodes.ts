/**
 * VISUAL.terrain-type-blending-vs-retail — the per-cell landscape texture
 * codes, ported from the retail client (decomp, build ac1_sep13):
 *
 * - `CLandBlockStruct::GetCellRotation` @ 00532170 packs the cell's palcode:
 *   road bits SW/SE/NE/NW at 26/24/22/20, terrain types SW/SE/NE/NW at
 *   15/10/5/0, and a size code at bit 28 (1 at full detail, 4 on a reduced
 *   block). With TexMerge (no PalShift) `LandSurf::SelectTerrain` @ 00503070
 *   keeps that unrotated code at ROT_0.
 * - `TexMerge::GetTerrain` @ 00503dc0 picks the cell's base terrain and up to
 *   three overlay corner codes (1 = SW, 2 = SE, 4 = NE, 8 = NW).
 * - `TexMerge::GetRoadCode` @ 005033f0 turns the road corners into up to two
 *   road codes (same corner bits), or "all road".
 * - `TexMerge::FindTerrainAlpha` @ 00503700 / `FindRoadAlpha` @ 00503600 pick
 *   an alpha map with a 32-bit LCG of the palcode and the rotation that turns
 *   the map's code into the wanted one.
 * - `ImgTex::MergeTexture` @ 0053e870 samples the alpha map rotated, and
 *   `CLandBlockStruct::ConstructUVs` @ 005329a0 maps the merged surface onto
 *   the cell with `land_uvs` = {(0,1),(1,1),(1,0),(0,0)}: texture row 0 is the
 *   cell's NORTH edge. `cellAlphaUVs` gives the alpha-map UV each corner
 *   samples under a rotation, which is exactly `land_uvs[Corner[rot]]`.
 */

/** Corner bit of a terrain/road code (TexMerge::GetTerrain / GetRoadCode). */
export const CORNER_SW = 1;
export const CORNER_SE = 2;
export const CORNER_NE = 4;
export const CORNER_NW = 8;

/** CLandBlockStruct::land_uvs (static init @ 296050 in the decomp). */
const LAND_UVS: readonly (readonly [number, number])[] = [[0, 1], [1, 1], [1, 0], [0, 0]];
/** SW_Corner / SE_Corner / NE_Corner / NW_Corner globals, indexed by rotation. */
const SW_CORNER = [0, 3, 2, 1];
const SE_CORNER = [1, 0, 3, 2];
const NE_CORNER = [2, 1, 0, 3];
const NW_CORNER = [3, 2, 1, 0];

/**
 * Alpha-map UVs for an overlay quad under `rotation` (0..3), in the quad's
 * vertex order SW, SE, NW, NE, flattened [u, v, …]. UV (0,0) is the alpha
 * map's first texel (row 0 = north, column 0 = west).
 */
export function cellAlphaUVs(rotation: number): number[] {
  const r = rotation & 3;
  return [
    ...LAND_UVS[SW_CORNER[r]],
    ...LAND_UVS[SE_CORNER[r]],
    ...LAND_UVS[NW_CORNER[r]],
    ...LAND_UVS[NE_CORNER[r]],
  ];
}

/**
 * The cell's palcode (GetCellRotation). Corners in SW, SE, NE, NW order;
 * `reduced` = the block is drawn at a reduced LOD (size code 4, else 1).
 */
export function cellPalCode(
  r1: number, r2: number, r3: number, r4: number,
  t1: number, t2: number, t3: number, t4: number,
  reduced = false,
): number {
  const size = reduced ? 4 : 1;
  const roadBits = ((r1 & 3) << 26) | ((r2 & 3) << 24) | ((r3 & 3) << 22) | ((r4 & 3) << 20);
  const terrainBits = ((t1 & 0x1f) << 15) | ((t2 & 0x1f) << 10) | ((t3 & 0x1f) << 5) | (t4 & 0x1f);
  return ((size << 28) + (roadBits | terrainBits)) >>> 0;
}

export interface TerrainBlend {
  /** The cell's base terrain type (the merged surface starts as this). */
  baseTerrainType: number;
  /** Overlays merged over the base in order, each with its corner code. */
  overlays: { terrainType: number; tcode: number }[];
}

/** TexMerge::GetTerrain: base terrain + overlay corner codes for a palcode. */
export function terrainBlend(palcode: number): TerrainBlend {
  const t = [(palcode >>> 15) & 0x1f, (palcode >>> 10) & 0x1f, (palcode >>> 5) & 0x1f, palcode & 0x1f];
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (t[i] !== t[j]) continue;
      // A pair shares a type: it is the base; the other corners overlay it.
      const base = t[i];
      const overlays: { terrainType: number; tcode: number }[] = [];
      for (let k = 0; k < 4; k++) {
        if (t[k] === base) continue;
        if (overlays.length === 0) {
          overlays.push({ terrainType: t[k], tcode: 1 << k });
          continue;
        }
        // A second corner of the first overlay type next to it widens that
        // overlay to a side code; anything else is a second overlay.
        if (t[k] === overlays[0].terrainType && overlays[0].tcode === 1 << (k - 1)) {
          overlays[0].tcode += 1 << k;
        } else {
          overlays.push({ terrainType: t[k], tcode: 1 << k });
        }
        break;
      }
      return { baseTerrainType: base, overlays };
    }
  }
  // All four corners differ: SW is the base, the others overlay their corner.
  return {
    baseTerrainType: t[0],
    overlays: [1, 2, 3].map((k) => ({ terrainType: t[k], tcode: 1 << k })),
  };
}

/** The base terrain type of a cell from its SW, SE, NE, NW corner types. */
export function cellBaseTerrainType(sw: number, se: number, ne: number, nw: number): number {
  return terrainBlend(cellPalCode(0, 0, 0, 0, sw, se, ne, nw)).baseTerrainType;
}

/**
 * TexMerge::GetRoadCode: `corners` is the road corner mask (CORNER_* bits).
 * `allRoad` = every corner is road (the surface is the road texture alone).
 */
export function roadCodes(corners: number): { rCodes: [number, number]; allRoad: boolean } {
  switch (corners & 0xf) {
    case 0x0: return { rCodes: [0, 0], allRoad: false };
    case 0x7: return { rCodes: [3, 6], allRoad: false };
    case 0xb: return { rCodes: [9, 3], allRoad: false };
    case 0xd: return { rCodes: [9, 12], allRoad: false };
    case 0xe: return { rCodes: [6, 12], allRoad: false };
    case 0xf: return { rCodes: [0, 0], allRoad: true };
    default: return { rCodes: [corners & 0xf, 0], allRoad: false };
  }
}

/**
 * The road corner mask from the landblock mesh's `cellRoadMasks` layout
 * (bit0 = NW, bit1 = NE, bit2 = SE, bit3 = SW).
 */
export function roadCornersFromMask(mask: number): number {
  return ((mask & 8) ? CORNER_SW : 0) | ((mask & 4) ? CORNER_SE : 0)
    | ((mask & 2) ? CORNER_NE : 0) | ((mask & 1) ? CORNER_NW : 0);
}

/**
 * The alpha-map pick shared by FindTerrainAlpha / FindRoadAlpha:
 * floor(float(u32(palcode · 0x523aa99e − 0x51c9e74a)) · 2⁻³² · count).
 * The client converts the 32-bit value to a float before scaling, so the
 * result can reach `count` (FindTerrainAlpha then uses 0).
 */
export function alphaPick(palcode: number, count: number): number {
  const u = (Math.imul(palcode | 0, 0x523aa99e) - 0x51c9e74a) >>> 0;
  return Math.floor(Math.fround(u) * 2.3283064365386963e-10 * count);
}

/** One step of a code's rotation: corners 8→1→2→4, sides 9→3→6→12. */
function rotateCode(code: number): number {
  const c = code * 2;
  return c > 15 ? c - 15 : c;
}

/** TexMerge::FindTerrainAlpha: the map and rotation for an overlay corner code. */
export function findTerrainAlpha<M extends { tCode: number }>(
  cornerMaps: readonly M[], sideMaps: readonly M[], tcode: number, palcode: number,
): { alphaMap: M; rotation: number } | null {
  const isCorner = tcode === 1 || tcode === 2 || tcode === 4 || tcode === 8;
  const maps = isCorner ? cornerMaps : sideMaps;
  if (maps.length === 0) return null;
  let idx = alphaPick(palcode, maps.length);
  if (idx >= maps.length) idx = 0;
  const alphaMap = maps[idx];
  let code = alphaMap.tCode;
  for (let rot = 0; rot < 4; rot++) {
    if (code === tcode) return { alphaMap, rotation: rot };
    code = rotateCode(code);
  }
  return null;
}

/** TexMerge::FindRoadAlpha: the first map (from the LCG pick on) whose code rotates to `rCode`. */
export function findRoadAlpha<M extends { rCode: number }>(
  roadMaps: readonly M[], rCode: number, palcode: number,
): { roadMap: M; rotation: number } | null {
  const n = roadMaps.length;
  if (n === 0) return null;
  const start = alphaPick(palcode, n);
  for (let i = 0; i < n; i++) {
    const roadMap = roadMaps[(i + start) % n];
    let code = roadMap.rCode;
    for (let rot = 0; rot < 4; rot++) {
      if (code === rCode) return { roadMap, rotation: rot };
      code = rotateCode(code);
    }
  }
  return null;
}
