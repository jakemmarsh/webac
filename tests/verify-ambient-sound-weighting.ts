/**
 * RECON.ambient-sound-weighting — retail's neighbourhood ambient model.
 *
 * Retail does not play "the STB under the player": on every cell change
 * (CellManager::ChangePosition @ 004559b0) it re-gathers every terrain vertex
 * of the full-detail blocks (LScape::add_ambient_sounds @ 00505810 →
 * CLandBlock::add_ambient_sounds @ 00530310 → Ambient::AddSound @ 00551610):
 *  - CalcWeight @ 00550dd0: 1 inside 20 m, 20²/d² out to 120 m, 0 beyond;
 *  - a constant sound's volume is desc volume × its weight share
 *    (ConstantSound::UpdateSound @ 00551540), heard from 0.03 up;
 *  - an intermittent sound's play chance is base_chance × its share
 *    (IntermitSound::UpdateSound @ 00551310), and it plays in one of the
 *    directions its vertices lie (CalcDir @ 00550e40, IntermitSound::AddTo
 *    @ 00551450, GetSoundPos @ 00551350, LandDefs::heading @ 005a9a30).
 * Decomp: reference/client-eol/decomp/acclient-decompiled.annotated.c.
 */
import { existsSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import {
  AmbientSoundManager,
  AmbientDirection,
  ambientCalcWeight,
  ambientCalcDir,
  ambientDirHeading,
  type AmbientPlay,
} from '../packages/renderer/src/audio/AmbientSoundManager.js';
import {
  gatherAmbientVertices,
  sceneStbIndexForTerrainWord,
  NO_AMBIENT_STB,
  type RegionAmbienceSource,
} from '../packages/renderer/src/terrain/terrainAmbience.js';
import type { SoundDesc } from '@ac/dat-parser/file-types/RegionDesc.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';

function seq(...values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0);
}

/** A sound table where every sound type resolves to one wave. */
const anyTable = { resolveSound: (sType: number) => ({ waveId: 0x0a000000 + sType, volume: 1 }) };

function rig(stbs: SoundDesc['stbDesc'], rng: () => number = () => 0) {
  const player = {
    loadSoundTable: () => anyTable,
    playSound: () => Promise.resolve(null),
    levelThroughCategory: (amp: number) => amp,
  } as never;
  const audio = { isInitialized: true, isRunning: true, getCategoryVolume: () => 1 } as never;
  const mgr = new AmbientSoundManager(player, audio, rng);
  const plays: AmbientPlay[] = [];
  mgr.onPlay = (p) => plays.push(p);
  mgr.loadFromSoundDesc({ stbDesc: stbs } as SoundDesc);
  return { mgr, plays };
}

const constant = (sType: number, volume: number, minRate = 10) =>
  ({ sType, volume, baseChance: 0, minRate, maxRate: minRate });
const intermit = (sType: number, baseChance: number) =>
  ({ sType, volume: 1, baseChance, minRate: 5, maxRate: 5 });

describe('Ambient::CalcWeight / CalcDir / LandDefs::heading', () => {
  it('weighs a vertex 1 inside 20 m, 20²/d² out to 120 m, 0 beyond', () => {
    expect(ambientCalcWeight(0, 0, 0)).toBe(1);
    expect(ambientCalcWeight(19.9, 0, 0)).toBe(1);
    expect(ambientCalcWeight(40, 0, 0)).toBeCloseTo(0.25, 12);
    expect(ambientCalcWeight(0, 60, 80)).toBeCloseTo(400 / 10000, 12); // 3-D distance
    expect(ambientCalcWeight(120, 0, 0)).toBeCloseTo(400 / 14400, 12);
    expect(ambientCalcWeight(120.01, 0, 0)).toBe(0);
  });

  it('bins a horizontal offset: in the viewer block inside √200 m, else eight compass directions', () => {
    expect(ambientCalcDir(10, 9.9)).toBe(AmbientDirection.InViewerBlock); // 198 < 200
    expect(ambientCalcDir(0, 50)).toBe(AmbientDirection.North);
    expect(ambientCalcDir(10, -50)).toBe(AmbientDirection.South);   // |y|/|x| 5 > 2
    expect(ambientCalcDir(50, 10)).toBe(AmbientDirection.East);
    expect(ambientCalcDir(-50, 0)).toBe(AmbientDirection.West);
    expect(ambientCalcDir(30, 30)).toBe(AmbientDirection.NorthEast);
    expect(ambientCalcDir(-30, 30)).toBe(AmbientDirection.NorthWest);
    expect(ambientCalcDir(-30, -30)).toBe(AmbientDirection.SouthWest);
    expect(ambientCalcDir(30, -60)).toBe(AmbientDirection.SouthEast); // ratio exactly 2 is diagonal
  });

  it('headings run clockwise from north', () => {
    expect(ambientDirHeading(AmbientDirection.North)).toBe(0);
    expect(ambientDirHeading(AmbientDirection.NorthEast)).toBeCloseTo(Math.PI / 4, 6);
    expect(ambientDirHeading(AmbientDirection.East)).toBeCloseTo(Math.PI / 2, 6);
    expect(ambientDirHeading(AmbientDirection.SouthEast)).toBeCloseTo(3 * Math.PI / 4, 6);
    expect(ambientDirHeading(AmbientDirection.South)).toBeCloseTo(Math.PI, 6);
    expect(ambientDirHeading(AmbientDirection.SouthWest)).toBeCloseTo(5 * Math.PI / 4, 6);
    expect(ambientDirHeading(AmbientDirection.West)).toBeCloseTo(3 * Math.PI / 2, 6);
    expect(ambientDirHeading(AmbientDirection.NorthWest)).toBeCloseTo(7 * Math.PI / 4, 6);
  });
});

describe('Ambient::AddSound + UpdatePlayQueue — neighbourhood weighting', () => {
  it('a constant sound plays at its STB\'s share of the total weight', () => {
    // STB 0 under the player (weight 1), STB 1 40 m east (weight 0.25): total 1.25.
    const { mgr, plays } = rig([
      { stbId: 0x20000001, ambientSounds: [constant(1, 0.5)] },
      { stbId: 0x20000002, ambientSounds: [constant(2, 0.5)] },
    ] as never);
    mgr.applyNeighbourhood([
      { stbIndex: 0, dx: 0, dy: 0, dz: 0 },
      { stbIndex: 1, dx: 40, dy: 0, dz: 0 },
    ]);
    expect(mgr.getTotalSoundCount()).toBeCloseTo(1.25, 12);
    const vol = Object.fromEntries(mgr.getSoundStates().map(s => [s.sType, s.currentVolume]));
    expect(vol[1]).toBeCloseTo(0.5 * 1 / 1.25, 12);
    expect(vol[2]).toBeCloseTo(0.5 * 0.25 / 1.25, 12);
    // both from the centre, at their weighted levels
    expect(plays.map(p => p.distance)).toEqual([0, 0]);
    expect(plays[0].amplitude).toBeGreaterThan(plays[1].amplitude);
  });

  it('a neighbouring sound weighted below ambient_sound_min_vol (0.03) is not heard', () => {
    const { mgr, plays } = rig([
      { stbId: 0x20000001, ambientSounds: [constant(1, 0.5)] },
      { stbId: 0x20000002, ambientSounds: [constant(2, 0.2)] },
    ] as never);
    // STB 1 at 100 m: weight 0.04 of 1.04 → 0.2 × 0.0385 = 0.0077 < 0.03
    mgr.applyNeighbourhood([
      { stbIndex: 0, dx: 0, dy: 0, dz: 0 },
      { stbIndex: 1, dx: 0, dy: 100, dz: 0 },
    ]);
    expect(plays.map(p => p.sType)).toEqual([1]);
    const quiet = mgr.getSoundStates().find(s => s.sType === 2)!;
    expect(quiet.onQueue).toBe(false); // CanHear failed → off the queue
  });

  it('vertices beyond 120 m add nothing', () => {
    const { mgr, plays } = rig([{ stbId: 0x20000001, ambientSounds: [constant(1, 0.5)] }] as never);
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 121, dy: 0, dz: 0 }]);
    expect(mgr.getTotalSoundCount()).toBe(0);
    expect(plays).toHaveLength(0);
  });

  it('every vertex counts: many grass vertices outweigh one forest vertex', () => {
    const { mgr } = rig([
      { stbId: 0x20000001, ambientSounds: [constant(1, 1)] },
      { stbId: 0x20000002, ambientSounds: [constant(2, 1)] },
    ] as never);
    mgr.applyNeighbourhood([
      { stbIndex: 1, dx: 0, dy: 0, dz: 0 },     // the vertex under the player
      { stbIndex: 0, dx: 10, dy: 0, dz: 0 },
      { stbIndex: 0, dx: 0, dy: 10, dz: 0 },
      { stbIndex: 0, dx: -10, dy: 0, dz: 0 },
    ]);
    const vol = Object.fromEntries(mgr.getSoundStates().map(s => [s.sType, s.currentVolume]));
    expect(vol[1]).toBeCloseTo(0.75, 12);
    expect(vol[2]).toBeCloseTo(0.25, 12);
  });

  it('an intermittent sound\'s play chance is base_chance × its share', () => {
    const { mgr } = rig([
      { stbId: 0x20000001, ambientSounds: [constant(1, 0.5)] },
      { stbId: 0x20000002, ambientSounds: [intermit(2, 0.8)] },
    ] as never);
    mgr.applyNeighbourhood([
      { stbIndex: 0, dx: 0, dy: 0, dz: 0 },
      { stbIndex: 1, dx: 40, dy: 0, dz: 0 },
    ]);
    const s = mgr.getSoundStates().find(x => x.sType === 2)!;
    expect(s.playChance).toBeCloseTo(0.8 * 0.25 / 1.25, 12);
  });

  it('an intermittent sound plays toward its vertices, d ± 10 m away', () => {
    // Only vertex: 40 m east → one band East, 30–50 m.
    // Rolls: PlayNow 0, direction 0, heading 0.5 (no jitter), distance r = 1 → 50 m.
    const { mgr, plays } = rig([{ stbId: 0x20000002, ambientSounds: [intermit(2, 0.8)] }] as never,
      seq(0, 0, 0.5, 1, 0, 0));
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 40, dy: 0, dz: 0 }]);
    const s = mgr.getSoundStates()[0];
    expect(s.dirs).toEqual([{ dir: AmbientDirection.East, min: 30, max: 50 }]);
    expect(plays).toHaveLength(1);
    expect(plays[0].dx).toBeCloseTo(50, 9);
    expect(plays[0].dy).toBeCloseTo(0, 9);
    expect(plays[0].distance).toBeCloseTo(50, 9);
  });

  it('IntermitSound::AddDir widens a direction band over several vertices', () => {
    const { mgr } = rig([{ stbId: 0x20000002, ambientSounds: [intermit(2, 0.5)] }] as never);
    mgr.applyNeighbourhood([
      { stbIndex: 0, dx: 0, dy: 40, dz: 0 },
      { stbIndex: 0, dx: 0, dy: 80, dz: 0 },
      { stbIndex: 0, dx: 0, dy: 5, dz: 0 }, // in the viewer block: all eight, 4–10 m
    ]);
    const dirs = mgr.getSoundStates()[0].dirs;
    expect(dirs).toHaveLength(8);
    expect(dirs.find(d => d.dir === AmbientDirection.North)).toEqual({ dir: AmbientDirection.North, min: 4, max: 90 });
    expect(dirs.find(d => d.dir === AmbientDirection.West)).toEqual({ dir: AmbientDirection.West, min: 4, max: 10 });
  });

  it('a sound still queued keeps its timer across a re-gather; one that went silent replays at once on return', () => {
    const { mgr, plays } = rig([
      { stbId: 0x20000001, ambientSounds: [constant(1, 0.5, 10)] },
      { stbId: 0x20000002, ambientSounds: [constant(2, 0.5, 10)] },
    ] as never);
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 0, dy: 0, dz: 0 }]);
    expect(plays.map(p => p.sType)).toEqual([1]);
    mgr.update(4);
    // walk a cell over: STB 0 still around, STB 1 now too
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 0, dy: 0, dz: 0 }, { stbIndex: 1, dx: 0, dy: 10, dz: 0 }]);
    expect(plays.map(p => p.sType)).toEqual([1, 2]); // 1 not replayed: still queued
    expect(mgr.getSoundStates().find(s => s.sType === 1)!.nextPlayIn).toBeCloseTo(6, 9);
    // walk out of STB 0's reach: its next Play finds it silent and drops it
    mgr.applyNeighbourhood([{ stbIndex: 1, dx: 0, dy: 0, dz: 0 }]);
    mgr.update(6.1);
    expect(plays.map(p => p.sType)).toEqual([1, 2]);
    expect(mgr.getSoundStates().find(s => s.sType === 1)!.onQueue).toBe(false);
    // and back: off the queue → UpdatePlayQueue plays it at once
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 0, dy: 0, dz: 0 }]);
    expect(plays.map(p => p.sType)).toEqual([1, 2, 1]);
  });

  it('an empty gather (a dungeon) silences everything', () => {
    const { mgr, plays } = rig([{ stbId: 0x20000001, ambientSounds: [constant(1, 0.5, 10)] }] as never);
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 0, dy: 0, dz: 0 }]);
    mgr.applyNeighbourhood([]);
    mgr.update(30);
    expect(plays).toHaveLength(1);
    expect(mgr.getActiveSoundStates()).toHaveLength(0);
  });
});

describe('gatherAmbientVertices — CLandBlock::add_ambient_sounds', () => {
  const region: RegionAmbienceSource = {
    terrainInfo: {
      terrainTypes: [{ terrainName: 'Grass', terrainColor: 0, sceneTypes: [0, 1] }],
      landSurfaces: {} as never,
    },
    sceneInfo: { sceneTypes: [{ stbIndex: 3, scenes: [] }, { stbIndex: 0xffffffff, scenes: [] }] },
  };

  it('offsets every vertex (index col*9+row, 24 m apart) from the player, heights through the LandHeightTable', () => {
    const terrain = new Array(81).fill(0);
    terrain[1 * 9 + 2] = 1 << 11; // scene type 1 → no STB
    const heights = new Array(81).fill(5);
    const table = Array.from({ length: 256 }, (_, i) => i * 3);
    const out = gatherAmbientVertices({ x: 192 + 30, y: 384 + 10, z: 12 },
      [{ blockX: 1, blockY: 2, terrain, heights, landHeightTable: table }], region);
    expect(out).toHaveLength(80);
    expect(out[0]).toEqual({ stbIndex: 3, dx: -30, dy: -10, dz: 3 });
    // col 8, row 8 is the block's far corner
    expect(out[79]).toEqual({ stbIndex: 3, dx: 192 - 30, dy: 192 - 10, dz: 3 });
    expect(out.some(v => v.dx === 24 - 30 && v.dy === 48 - 10)).toBe(false);
  });

  it('counts a shared edge vertex once per block, as retail visits each block\'s own array', () => {
    const blk = (blockX: number) => ({ blockX, blockY: 0, terrain: new Array(81).fill(0), heights: new Array(81).fill(0) });
    const out = gatherAmbientVertices({ x: 192, y: 0, z: 0 }, [blk(0), blk(1)], region);
    expect(out.filter(v => v.dx === 0 && v.dy === 0)).toHaveLength(2);
  });
});

// ── DAT-backed: Holtburg's real 3×3 neighbourhood ──
describe.skipIf(!existsSync(DAT_PATHS.portal) || !existsSync(DAT_PATHS.cell))('Holtburg (0xA9B4) neighbourhood against the real DATs', () => {
  let region: RegionAmbienceSource & { soundInfo: SoundDesc; landDefs: { landHeightTable: Float32Array } };
  let blocks: Array<{ blockX: number; blockY: number; terrain: number[]; heights: number[]; landHeightTable: Float32Array }>;

  beforeAll(async () => {
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc } = await import('../packages/dat-parser/src/file-types/RegionDesc.js');
    const { CellLandblock } = await import('../packages/dat-parser/src/file-types/CellLandblock.js');
    region = new RegionDesc(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x13000000)!)) as never;
    const cell = openDat(DAT_PATHS.cell);
    blocks = [];
    for (let bx = 0xa8; bx <= 0xaa; bx++) {
      for (let by = 0xb3; by <= 0xb5; by++) {
        const lb = CellLandblock.read(new DatReader(cell.getFileData(((bx << 24) | (by << 16) | 0xffff) >>> 0)!));
        blocks.push({ blockX: bx, blockY: by, terrain: lb.terrain, heights: lb.heights, landHeightTable: region.landDefs.landHeightTable });
      }
    }
  });

  it('the gather weighs several vertices and the STB shares sum to the whole', () => {
    // the centre of Holtburg's block, on the ground
    const centre = blocks.find(b => b.blockX === 0xa9 && b.blockY === 0xb4)!;
    const z = centre.landHeightTable[centre.heights[4 * 9 + 4]];
    const player = { x: 0xa9 * 192 + 96, y: 0xb4 * 192 + 96, z };
    const verts = gatherAmbientVertices(player, blocks, region);
    expect(verts.length).toBeGreaterThan(0);
    for (const v of verts) {
      expect(v.stbIndex).not.toBe(NO_AMBIENT_STB);
      expect(v.stbIndex).toBeLessThan(region.soundInfo.stbDesc.length);
    }
    const { mgr } = rig(region.soundInfo.stbDesc);
    mgr.applyNeighbourhood(verts);
    const total = mgr.getTotalSoundCount();
    // the vertex under the player alone weighs 1; neighbours add a fraction
    expect(total).toBeGreaterThan(1);
    const inRange = verts.filter(v => Math.hypot(v.dx, v.dy, v.dz) <= 120);
    expect(total).toBeCloseTo(inRange.reduce((a, v) => a + ambientCalcWeight(v.dx, v.dy, v.dz), 0), 6);
    // each STB's share of the total (one count per STB, its first sound);
    // vertices of a soundless STB still weigh in the total, as in AddSound
    const perStb = new Map<number, number>();
    for (const s of mgr.getActiveSoundStates()) if (s.soundIndex === 0) perStb.set(s.stbIndex, s.soundCount);
    expect(perStb.size).toBeGreaterThan(0);
    const shares = [...perStb.values()].reduce((a, c) => a + c / total, 0);
    const sounded = inRange.filter(v => region.soundInfo.stbDesc[v.stbIndex].ambientSounds.length > 0)
      .reduce((a, v) => a + ambientCalcWeight(v.dx, v.dy, v.dz), 0);
    expect(shares).toBeCloseTo(sounded / total, 9);
    // a constant sound's volume is its desc volume × that share
    for (const s of mgr.getActiveSoundStates()) {
      if (s.isContinuous) expect(s.currentVolume).toBeCloseTo(s.volume * perStb.get(s.stbIndex)! / total, 9);
    }
  });
});
