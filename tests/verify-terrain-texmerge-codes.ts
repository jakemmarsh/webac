/**
 * VISUAL.terrain-type-blending-vs-retail — the landscape's per-cell texture
 * codes against the retail client (TexMergeCodes.ts cites each function).
 *
 * The 2026-10-02 retail A/B town tour showed hard straight-edged patches of
 * the wrong terrain (Fiun drew deep blue sea under the player where retail
 * draws ice). Root cause: overlay alpha maps were laid on the cell with row 0
 * at the SOUTH edge, while retail's CLandBlockStruct::land_uvs puts row 0 at
 * the NORTH edge — every corner/side blend landed on the mirrored corner, so
 * a full-strength overlay edge met a neighbouring base-type cell. Also: the
 * cell's base type was the SW corner instead of TexMerge::GetTerrain's base,
 * the road alpha pick used an invented seed, and the LCG lost its low bits to
 * double precision.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import {
  cellAlphaUVs, cellPalCode, terrainBlend, cellBaseTerrainType, roadCodes, roadCornersFromMask,
  alphaPick, findTerrainAlpha, findRoadAlpha, CORNER_SW, CORNER_SE, CORNER_NE, CORNER_NW,
} from '../packages/renderer/src/terrain/TexMergeCodes.js';
import { LandblockMesh } from '../packages/renderer/src/terrain/LandblockMesh.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';
import { SurfaceTexture } from '../packages/dat-parser/src/file-types/SurfaceTexture.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { CellLandblock } from '../packages/dat-parser/src/file-types/CellLandblock.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';

/** Overlay-quad vertex order used by appendOverlayQuad / cellAlphaUVs. */
const VERTS = ['SW', 'SE', 'NW', 'NE'] as const;
const CORNER_OF: Record<(typeof VERTS)[number], number> = { SW: CORNER_SW, SE: CORNER_SE, NW: CORNER_NW, NE: CORNER_NE };

/** The corners (CORNER_* mask) whose UV satisfies `pred`. */
function cornersWhere(rotation: number, pred: (u: number, v: number) => boolean): number {
  const uv = cellAlphaUVs(rotation);
  let mask = 0;
  VERTS.forEach((name, i) => { if (pred(uv[i * 2], uv[i * 2 + 1])) mask |= CORNER_OF[name]; });
  return mask;
}

describe('alpha maps land on the corner their code names (land_uvs + MergeTexture)', () => {
  // Every EoL corner map is code 8 (NW) with its overlay at texel (0,0),
  // the top-left; the side map is code 9 (SW+NW, the west column).
  it('a corner map rotated to code c puts its (0,0) texel on corner c', () => {
    for (const c of [CORNER_SW, CORNER_SE, CORNER_NE, CORNER_NW]) {
      const m = findTerrainAlpha([{ tCode: 8 }], [], c, 0x10000000)!;
      expect(cornersWhere(m.rotation, (u, v) => u === 0 && v === 0)).toBe(c);
    }
  });

  it('a side map rotated to code s puts its west column (u = 0) on the corners of s', () => {
    for (const s of [3, 6, 12, 9]) {
      const m = findTerrainAlpha([], [{ tCode: 9 }], s, 0x10000000)!;
      expect(cornersWhere(m.rotation, (u) => u === 0)).toBe(s);
    }
  });

  it('ROT_0 maps texture row 0 to the north edge, as land_uvs does', () => {
    expect(cellAlphaUVs(0)).toEqual([0, 1, 1, 1, 0, 0, 1, 0]);
    expect(cornersWhere(0, (_u, v) => v === 0)).toBe(CORNER_NW | CORNER_NE);
  });

  it('appendOverlayQuad writes those UVs', () => {
    const bucket = { verts: [] as number[], uvs: [] as number[], indices: [] as number[], quadCount: 0, material: null as never, layer: 0 };
    TerrainRenderer.appendOverlayQuad(bucket, 0, 0, 24, 0, 0, 0, 0, 3, true);
    expect(bucket.uvs).toEqual(cellAlphaUVs(3));
  });
});

describe('TexMerge::GetTerrain base and overlays', () => {
  it('two ice corners south, two sea corners north: ice base, one north-side sea overlay', () => {
    const b = terrainBlend(cellPalCode(0, 0, 0, 0, 2, 2, 18, 18));
    expect(b.baseTerrainType).toBe(2);
    expect(b.overlays).toEqual([{ terrainType: 18, tcode: CORNER_NE | CORNER_NW }]);
  });

  it('the base is the first type two corners share, not the SW corner', () => {
    // SW=5, SE=9, NE=9, NW=7 → base 9; 5 overlays SW, 7 overlays NW.
    const b = terrainBlend(cellPalCode(0, 0, 0, 0, 5, 9, 9, 7));
    expect(b.baseTerrainType).toBe(9);
    expect(b.overlays).toEqual([{ terrainType: 5, tcode: CORNER_SW }, { terrainType: 7, tcode: CORNER_NW }]);
    expect(cellBaseTerrainType(5, 9, 9, 7)).toBe(9);
  });

  it('a pair with SW wins the base; the other pair widens to a side code', () => {
    // SW=NW=4 is found first (i = 0), so 4 is the base and SE+NE (3) is the east side, code 6.
    const b = terrainBlend(cellPalCode(0, 0, 0, 0, 4, 3, 3, 4));
    expect(b.baseTerrainType).toBe(4);
    expect(b.overlays).toEqual([{ terrainType: 3, tcode: CORNER_SE | CORNER_NE }]);
  });

  it('four different corners: SW base, the rest overlay their own corner', () => {
    const b = terrainBlend(cellPalCode(0, 0, 0, 0, 1, 2, 3, 4));
    expect(b.baseTerrainType).toBe(1);
    expect(b.overlays.map((o) => o.tcode)).toEqual([CORNER_SE, CORNER_NE, CORNER_NW]);
  });

  it('LandblockMesh gives each cell the GetTerrain base type', () => {
    // Cell (0,0) corners: SW=(0,0) 5, SE=(1,0) 9, NE=(1,1) 9, NW=(0,1) 7.
    const terrain = new Array(81).fill(9 << 2);
    terrain[0 * 9 + 0] = 5 << 2;
    terrain[0 * 9 + 1] = 7 << 2;
    const lb = new LandblockMesh({ id: 0x1234ffff, terrain, heights: new Array(81).fill(0) } as never);
    expect(lb.cellTerrainTypes[0]).toBe(9);
  });
});

describe('palcode, LCG pick and road codes', () => {
  it('the palcode packs GetCellRotation’s layout with size code 1 / 4', () => {
    expect(cellPalCode(1, 2, 3, 0, 2, 2, 18, 18).toString(16)).toBe((0x10000000 + (1 << 26) + (2 << 24) + (3 << 22) + (2 << 15) + (2 << 10) + (18 << 5) + 18).toString(16));
    expect(cellPalCode(0, 0, 0, 0, 0, 0, 0, 0, true)).toBe(0x40000000);
  });

  it('the LCG wraps at 32 bits like the client (no double-precision loss)', () => {
    for (const pc of [0x10000000, 0x1f0a5a52, 0x4c3f7fff, 0x10048a52]) {
      const u = Number((BigInt(pc) * 0x523aa99en - 0x51c9e74an) & 0xffffffffn);
      expect(alphaPick(pc, 4)).toBe(Math.floor(Math.fround(u) / 2 ** 32 * 4));
    }
  });

  it('GetRoadCode: three road corners split into two side codes, four = all road', () => {
    expect(roadCodes(CORNER_SE | CORNER_NE | CORNER_NW)).toEqual({ rCodes: [6, 12], allRoad: false });
    expect(roadCodes(15)).toEqual({ rCodes: [0, 0], allRoad: true });
    expect(roadCodes(CORNER_SW)).toEqual({ rCodes: [CORNER_SW, 0], allRoad: false });
  });

  it('the mesh road mask (bit0 = NW … bit3 = SW) converts to corner bits', () => {
    expect(roadCornersFromMask(8)).toBe(CORNER_SW);
    expect(roadCornersFromMask(1)).toBe(CORNER_NW);
    expect(roadCornersFromMask(2 | 4)).toBe(CORNER_NE | CORNER_SE);
  });

  it('a road side code finds the side map and lays the road on that side', () => {
    const maps = [{ rCode: 9 }, { rCode: 10 }, { rCode: 8 }];
    const north = CORNER_NE | CORNER_NW;
    const m = findRoadAlpha(maps, north, 0x10000000)!;
    expect(m.roadMap.rCode).toBe(9);
    expect(cornersWhere(m.rotation, (u) => u === 0)).toBe(north);
  });
});

const HAVE_DATS = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);

describe.skipIf(!HAVE_DATS)('Fiun (landblock 0x38F7) from the DATs', () => {
  let portal: DatDatabase;
  let cell: DatDatabase;
  beforeAll(() => {
    portal = openDat(DAT_PATHS.portal);
    cell = openDat(DAT_PATHS.cell);
  });

  /** The first portal texture of a SurfaceTexture, decoded to RGBA. */
  function alphaTexels(surfaceTextureId: number): { width: number; height: number; data: Uint8Array } {
    const st = SurfaceTexture.read(portal.getReader(surfaceTextureId));
    const id = st.textures.find((t) => portal.hasFile(t))!;
    return Texture.read(new DatReader(portal.getFileData(id)!)).toRGBA();
  }

  it('the cell the player spawns in blends ice into sea on its NORTH half, as retail draws it', () => {
    const lb = CellLandblock.read(cell.getReader(0x38f7ffff));
    const ty = (x: number, y: number): number => CellLandblock.getType(lb.terrain[x * 9 + y]);
    // Fiun's POI drop is local (91, 54): cell (3, 2).
    const pc = cellPalCode(0, 0, 0, 0, ty(3, 2), ty(4, 2), ty(4, 3), ty(3, 3));
    const blend = terrainBlend(pc);
    expect(blend.baseTerrainType).toBe(2); // Ice
    expect(blend.overlays).toEqual([{ terrainType: 18, tcode: 12 }]); // shallow sea, north side

    const region = new RegionDesc(portal.getReader(0x13000000));
    const tm = region.terrainInfo.landSurfaces.texMerge!;
    const m = findTerrainAlpha(tm.cornerTerrainMaps, tm.sideTerrainMaps, 12, pc)!;
    const tex = alphaTexels(m.alphaMap.texGID);
    const uv = cellAlphaUVs(m.rotation);
    // MergeTexture: alpha 0 = all overlay, 255 = all base. Sample at each corner.
    const at = (i: number): number => {
      const x = Math.min(tex.width - 1, Math.round(uv[i * 2] * (tex.width - 1)));
      const y = Math.min(tex.height - 1, Math.round(uv[i * 2 + 1] * (tex.height - 1)));
      return tex.data[(y * tex.width + x) * 4 + 3];
    };
    const [sw, se, nw, ne] = [0, 1, 2, 3].map(at);
    expect(nw).toBeLessThan(32);
    expect(ne).toBeLessThan(32);
    expect(sw).toBeGreaterThan(223);
    expect(se).toBeGreaterThan(223);
  });
});
