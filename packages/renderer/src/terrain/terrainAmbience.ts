/**
 * terrainAmbience — maps a terrain vertex word to its ambient STB index.
 *
 * Retail attaches each outdoor terrain vertex's scene-type ambient sound
 * table (STB) as a positional emitter. The decode chain, per the decompiled
 * EoL client:
 *   - CLandblockStruct ambient pass (acclient-decompiled.c:296702-296709):
 *     terrainType = (t >> 2) & 0x1f, sceneType = t >> 11, guarded by
 *     sceneType < CRegionDesc::NumSceneType(terrainType).
 *   - CTerrainDesc::GetSTBDesc (:248582-248596):
 *     terrain_types[tt].scene_types[st]->sound_table_desc, null-safe.
 *   - CSceneDesc unpack (:245629-245634): sound_table_desc is wired from
 *     the SceneType's stbIndex into the CSoundDesc STB array, with
 *     0xFFFFFFFF meaning "no ambience".
 *
 * ACE.DatLoader/Entity/SceneType.cs (StbIndex) confirms the DAT field.
 */
import type { SceneDesc, TerrainDesc } from '@ac/dat-parser/file-types/RegionDesc.js';

/** Sentinel: this vertex has no ambient soundscape (retail 0xFFFFFFFF). */
export const NO_AMBIENT_STB = 0xffffffff;

/** Minimal RegionDesc slice the ambience decode needs. */
export interface RegionAmbienceSource {
  terrainInfo?: TerrainDesc | null;
  sceneInfo?: SceneDesc | null;
}

/**
 * Decode a terrain vertex uint16 to the ambient STB index of its scene type.
 * Returns NO_AMBIENT_STB when the region tables don't resolve (mirrors
 * retail GetSTBDesc returning null → no ambience at that vertex).
 */
export function sceneStbIndexForTerrainWord(t: number, region: RegionAmbienceSource): number {
  const terrainInfo = region.terrainInfo;
  const sceneInfo = region.sceneInfo;
  if (!terrainInfo || !sceneInfo) return NO_AMBIENT_STB;

  const terrainType = (t >> 2) & 0x1f;
  const sceneType = t >> 11;

  const ttRow = terrainInfo.terrainTypes[terrainType];
  // Retail guard: sceneType < NumSceneType(terrainType)
  if (!ttRow || sceneType >= ttRow.sceneTypes.length) return NO_AMBIENT_STB;

  const sceneInfoIdx = ttRow.sceneTypes[sceneType];
  const sceneTypeRow = sceneInfo.sceneTypes[sceneInfoIdx];
  if (!sceneTypeRow) return NO_AMBIENT_STB;

  // stbIndex 0xFFFFFFFF passes through as "no ambience" (retail unpack
  // leaves sound_table_desc null for it).
  return sceneTypeRow.stbIndex >>> 0;
}

/** One full-detail landblock's terrain, as `gatherAmbientVertices` reads it. */
export interface AmbientBlockSource {
  /** Landblock grid coordinates (world origin = block × 192 m). */
  blockX: number;
  blockY: number;
  /** Raw 9×9 terrain words, index = col*9 + row. */
  terrain: ArrayLike<number>;
  /** 9×9 height bytes, same indexing. */
  heights: ArrayLike<number>;
  /** RegionDesc LandHeightTable (heights index it); raw × 2 without one. */
  landHeightTable?: ArrayLike<number>;
}

/** A vertex's ambient STB and its offset from the player (x east, y north, z up). */
export interface AmbientVertexOffset {
  stbIndex: number;
  dx: number;
  dy: number;
  dz: number;
}

/**
 * `LScape::add_ambient_sounds` @ 00505810 → `CLandBlock::add_ambient_sounds`
 * @ 00530310: every vertex of every full-detail block (edge vertices once per
 * block that holds them, as retail visits each block's own array) whose
 * scene type has an STB, as an offset from the player (`Position::get_offset`).
 * The distance cut and weighting are Ambient::AddSound's (AmbientSoundManager).
 */
export function gatherAmbientVertices(
  player: { x: number; y: number; z: number },
  blocks: Iterable<AmbientBlockSource>,
  region: RegionAmbienceSource,
): AmbientVertexOffset[] {
  const out: AmbientVertexOffset[] = [];
  for (const b of blocks) {
    if (b.terrain.length < 81 || b.heights.length < 81) continue;
    const ox = b.blockX * 192;
    const oy = b.blockY * 192;
    for (let col = 0; col < 9; col++) {
      for (let row = 0; row < 9; row++) {
        const i = col * 9 + row;
        const stbIndex = sceneStbIndexForTerrainWord(b.terrain[i], region);
        if (stbIndex === NO_AMBIENT_STB) continue;
        const raw = b.heights[i];
        const z = b.landHeightTable ? b.landHeightTable[raw] : raw * 2;
        out.push({ stbIndex, dx: ox + col * 24 - player.x, dy: oy + row * 24 - player.y, dz: z - player.z });
      }
    }
  }
  return out;
}
