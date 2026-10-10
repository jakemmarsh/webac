/**
 * BUG.ambient-stb-hardcoded-zero — scene-type-driven ambient STB selection.
 *
 * Retail selects the ambient soundscape per terrain vertex's SceneType:
 *   terrainType = (t >> 2) & 0x1f, sceneType = t >> 11, guarded by
 *   sceneType < NumSceneType(terrainType), then
 *   terrain_types[tt].scene_types[st]->sound_table_desc (null when the
 *   SceneType's stbIndex is 0xFFFFFFFF).
 * Reference: reference/client-eol/decomp/acclient-decompiled.c:296702-296709
 * (per-vertex ambient pass), :248582-248596 (CTerrainDesc::GetSTBDesc),
 * :245629-245634 (stbIndex→sound_table_desc wiring at unpack);
 * reference/ACE/Source/ACE.DatLoader/Entity/SceneType.cs (StbIndex).
 *
 * Pre-fix our client called setActiveSTB(0) once at startup and never again —
 * every biome played STB 0's ambience. These tests drive the real decode
 * helper + AmbientSoundManager and assert the active STB follows the terrain
 * scene type instead of staying 0.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  sceneStbIndexForTerrainWord,
  gatherAmbientVertices,
  NO_AMBIENT_STB,
  type RegionAmbienceSource,
} from '../packages/renderer/src/terrain/terrainAmbience.js';
import { AmbientSoundManager } from '../packages/renderer/src/audio/AmbientSoundManager.js';
import { AudioManager } from '../packages/renderer/src/audio/AudioManager.js';
import type { SoundDesc } from '@ac/dat-parser/file-types/RegionDesc.js';
import { openDat } from './_harness/dat.js';

const stubSoundPlayer = {
  loadSoundTable: () => null,
  decodeWave: () => null,
  playSound: () => Promise.resolve(),
  playPositionalSound: () => Promise.resolve(),
} as unknown as ConstructorParameters<typeof AmbientSoundManager>[0];

/** terrain word from parts: road(0-1) | terrainType(2-6) | sceneType(11-15) */
function terrainWord(terrainType: number, sceneType: number): number {
  return ((terrainType & 0x1f) << 2) | ((sceneType & 0x1f) << 11);
}

function makeRegion(): RegionAmbienceSource {
  return {
    // terrainType 0 → sceneInfo rows [0, 1]; terrainType 1 → rows [2]
    terrainInfo: {
      terrainTypes: [
        { terrainName: 'BarrenRock', terrainColor: 0, sceneTypes: [0, 1] },
        { terrainName: 'Grassland', terrainColor: 0, sceneTypes: [2] },
      ],
      landSurfaces: {} as never,
    },
    sceneInfo: {
      sceneTypes: [
        { stbIndex: 5, scenes: [] },
        { stbIndex: 0xffffffff, scenes: [] },
        { stbIndex: 2, scenes: [] },
      ],
    },
  };
}

describe('sceneStbIndexForTerrainWord — retail decode chain', () => {
  const region = makeRegion();

  it('decodes terrainType bits 2-6 + sceneType bits 11-15 through the region tables', () => {
    expect(sceneStbIndexForTerrainWord(terrainWord(0, 0), region)).toBe(5);
    expect(sceneStbIndexForTerrainWord(terrainWord(1, 0), region)).toBe(2);
  });

  it('passes stbIndex 0xFFFFFFFF through as NO_AMBIENT_STB (retail: null sound_table_desc)', () => {
    expect(sceneStbIndexForTerrainWord(terrainWord(0, 1), region)).toBe(NO_AMBIENT_STB);
  });

  it('guards sceneType >= NumSceneType(terrainType) → no ambience (retail guard)', () => {
    // terrainType 1 has only 1 scene type; sceneType 1 is out of range
    expect(sceneStbIndexForTerrainWord(terrainWord(1, 1), region)).toBe(NO_AMBIENT_STB);
    // terrainType 2 doesn't exist at all
    expect(sceneStbIndexForTerrainWord(terrainWord(2, 0), region)).toBe(NO_AMBIENT_STB);
  });

  it('returns NO_AMBIENT_STB when region tables are missing', () => {
    expect(sceneStbIndexForTerrainWord(terrainWord(0, 0), {})).toBe(NO_AMBIENT_STB);
  });
});

describe('AmbientSoundManager — the gathered scene types pick the STBs', () => {
  function makeMgr(): AmbientSoundManager {
    const mgr = new AmbientSoundManager(stubSoundPlayer, new AudioManager());
    const desc: SoundDesc = {
      stbDesc: [
        { stbId: 0x20000001, ambientSounds: [{ sType: 1, volume: 1, baseChance: 0, minRate: 0, maxRate: 0 }] },
        { stbId: 0x20000002, ambientSounds: [{ sType: 2, volume: 1, baseChance: 0, minRate: 0, maxRate: 0 }] },
        { stbId: 0x20000003, ambientSounds: [
          { sType: 3, volume: 1, baseChance: 0, minRate: 0, maxRate: 0 },
          { sType: 4, volume: 1, baseChance: 0.2, minRate: 5, maxRate: 10 },
        ]},
      ] as SoundDesc['stbDesc'],
    };
    mgr.loadFromSoundDesc(desc);
    return mgr;
  }
  /** A 9×9 block whose every vertex has terrain word `t` at height byte 0. */
  const block = (blockX: number, blockY: number, t: number) => ({
    blockX, blockY, terrain: new Array(81).fill(t), heights: new Array(81).fill(0),
  });

  it('full chain: terrain words → decode → gather → the scene type\'s STB is the active one', () => {
    const mgr = makeMgr();
    const region = makeRegion(); // terrainType 1 / scene 0 → stbIndex 2
    mgr.applyNeighbourhood(gatherAmbientVertices({ x: 96, y: 96, z: 0 }, [block(0, 0, terrainWord(1, 0))], region));
    expect(new Set(mgr.getActiveSoundStates().map(s => s.stbId))).toEqual(new Set([0x20000003]));
  });

  it('a block whose scene type has no STB silences (NO_AMBIENT_STB vertices are not gathered)', () => {
    const mgr = makeMgr();
    const region = makeRegion();
    mgr.applyNeighbourhood(gatherAmbientVertices({ x: 96, y: 96, z: 0 }, [block(0, 0, terrainWord(1, 0))], region));
    mgr.applyNeighbourhood(gatherAmbientVertices({ x: 96, y: 96, z: 0 }, [block(0, 0, terrainWord(0, 1))], region));
    expect(mgr.getActiveSoundStates()).toHaveLength(0);
    expect(mgr.getTotalSoundCount()).toBe(0);
  });
});

// ── DAT-backed: the real RegionDesc maps distinct biomes to distinct STBs ──
const PORTAL_DAT = 'dat/client_portal.dat';

describe.skipIf(!existsSync(PORTAL_DAT))('sceneStbIndexForTerrainWord against real RegionDesc 0x13000000', () => {
  let regionDesc: RegionAmbienceSource & { soundInfo?: { stbDesc: unknown[] } | null };

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc } = await import('../packages/dat-parser/src/file-types/RegionDesc.js');
    const db = openDat(PORTAL_DAT);
    regionDesc = new RegionDesc(new DatReader(db.getFileData(0x13000000)!)) as unknown as typeof regionDesc;
  });

  it('resolves multiple distinct STB indices across terrain scene types (not just 0)', () => {
    const seen = new Set<number>();
    const terrainTypes = regionDesc.terrainInfo!.terrainTypes;
    for (let tt = 0; tt < terrainTypes.length; tt++) {
      for (let st = 0; st < terrainTypes[tt].sceneTypes.length; st++) {
        seen.add(sceneStbIndexForTerrainWord(terrainWord(tt, st), regionDesc));
      }
    }
    // Task research: RegionDesc has 89 sceneTypes with stbIndex values
    // spanning ~20 distinct STBs. If everything resolved to one index the
    // pre-fix global-STB-0 behavior would be indistinguishable.
    expect(seen.size).toBeGreaterThan(5);
    // Every resolved index is either NO_AMBIENT_STB or a valid STB slot.
    const stbCount = (regionDesc.soundInfo?.stbDesc ?? []).length;
    for (const idx of seen) {
      if (idx !== NO_AMBIENT_STB) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(stbCount);
      }
    }
  });
});
