/**
 * SOUND.ambient-seen-outside — ambient follows the player's cell, not how
 * they got there.
 *
 * Retail CellManager::ChangePosition @ 004559b0 re-gathers on every cell
 * change: Ambient::InitSounds @ 005515d0 zeroes the counts, and
 * LScape::add_ambient_sounds runs only when the cell is outdoor or
 * seen_outside. A sealed cell gets an empty gather; nothing in flight is
 * stopped. Pre-fix, a login or teleport into ANY interior latched a
 * "dungeon" flag that stopped the re-gather (stale or no ambient inside a
 * surface building) and cut the sounds outright in a sealed one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AmbientCellGate, type AmbientCellState } from '../packages/renderer/src/audio/AmbientCellGate.js';
import { AmbientSoundManager, type AmbientPlay } from '../packages/renderer/src/audio/AmbientSoundManager.js';
import { AudioManager } from '../packages/renderer/src/audio/AudioManager.js';
import type { SoundDesc } from '@ac/dat-parser/file-types/RegionDesc.js';

const outdoor = (gx: number, gy: number, extra: Partial<AmbientCellState> = {}): AmbientCellState => ({
  envCellId: 0, seenOutside: false, gridX: gx, gridY: gy, loadedBlocks: 9, ownBlockLoaded: true, ...extra,
});
const BUILDING = 0xa9b40105; // a Holtburg surface-building cell
const CELLAR = 0x01250110;   // a sealed dungeon cell

describe('AmbientCellGate — the retail cell-change rule', () => {
  let gate: AmbientCellGate;
  beforeEach(() => { gate = new AmbientCellGate(); });

  it('outdoors: gathers the landscape once per cell, again on a cell change', () => {
    expect(gate.step(outdoor(10, 20))).toBe('landscape');
    expect(gate.step(outdoor(10, 20))).toBe('none');
    expect(gate.step(outdoor(11, 20))).toBe('landscape');
  });

  it('logging in (or teleporting) into a seen_outside building hears the landscape', () => {
    const inside = outdoor(10, 20, { envCellId: BUILDING, seenOutside: true });
    expect(gate.step(inside)).toBe('landscape');
    expect(gate.step(inside)).toBe('none');
  });

  it('teleporting from outdoors into a building re-gathers (no stale neighbourhood)', () => {
    expect(gate.step(outdoor(10, 20))).toBe('landscape');
    // Same 24 m grid square, but the player is now in the building's cell.
    expect(gate.step(outdoor(10, 20, { envCellId: BUILDING, seenOutside: true }))).toBe('landscape');
  });

  it('a sealed cell gets one empty gather, and another on each sealed cell change', () => {
    const sealed = outdoor(0, 0, { envCellId: CELLAR, seenOutside: false, loadedBlocks: 0, ownBlockLoaded: false });
    expect(gate.step(sealed)).toBe('sealed');
    expect(gate.step(sealed)).toBe('none');
    expect(gate.step({ ...sealed, envCellId: CELLAR + 1 })).toBe('sealed');
  });

  it('leaving a sealed cell for the surface gathers the landscape again', () => {
    gate.step(outdoor(0, 0, { envCellId: CELLAR, ownBlockLoaded: false }));
    expect(gate.step(outdoor(10, 20))).toBe('landscape');
  });

  it('waits for the player\'s own block to stream in, then re-gathers as neighbours arrive', () => {
    expect(gate.step(outdoor(10, 20, { ownBlockLoaded: false, loadedBlocks: 2 }))).toBe('none');
    expect(gate.step(outdoor(10, 20, { loadedBlocks: 4 }))).toBe('landscape');
    expect(gate.step(outdoor(10, 20, { loadedBlocks: 9 }))).toBe('landscape');
  });

  it('reset() makes the next step gather even in the same cell', () => {
    gate.step(outdoor(10, 20));
    gate.reset();
    expect(gate.step(outdoor(10, 20))).toBe('landscape');
  });
});

describe('a sealed (empty) gather on the real AmbientSoundManager', () => {
  const plays: AmbientPlay[] = [];
  const soundPlayer = {
    loadSoundTable: () => ({ resolveSound: () => ({ waveId: 0x0a000001 }) }),
    playSound: () => Promise.resolve(null),
    levelThroughCategory: (a: number) => a,
  } as unknown as ConstructorParameters<typeof AmbientSoundManager>[0];
  const desc: SoundDesc = { stbDesc: [{ stbId: 0x20000001, ambientSounds: [
    { sType: 1, volume: 1.0, baseChance: 0, minRate: 2, maxRate: 2 },   // constant
    { sType: 2, volume: 1.0, baseChance: 1, minRate: 3, maxRate: 3 },   // intermittent, always plays
  ] }] } as unknown as SoundDesc;

  function make(): AmbientSoundManager {
    plays.length = 0;
    const mgr = new AmbientSoundManager(soundPlayer, new AudioManager(), () => 0);
    mgr.onPlay = (p) => plays.push(p);
    mgr.loadFromSoundDesc(desc);
    return mgr;
  }

  it('the landscape plays, then a sealed gather drops every sound at its next turn', () => {
    const mgr = make();
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 0, dy: 0, dz: 0 }]);
    expect(plays.map(p => p.sType)).toEqual([1, 2]);

    mgr.applyNeighbourhood([]);
    expect(mgr.getTotalSoundCount()).toBe(0);
    // Still on the queue until its turn comes (retail stops nothing here)…
    expect(mgr.getSoundStates().every(s => s.onQueue)).toBe(true);
    // …and the master switch is untouched: this is not the Ambient option.
    expect(mgr.isEnabled).toBe(true);

    plays.length = 0;
    mgr.update(10);
    expect(plays).toEqual([]);
    expect(mgr.getSoundStates().every(s => !s.onQueue && s.soundCount === 0)).toBe(true);
  });

  it('a landscape gather after the sealed one brings the sounds straight back', () => {
    const mgr = make();
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 0, dy: 0, dz: 0 }]);
    mgr.applyNeighbourhood([]);
    mgr.update(10);
    plays.length = 0;
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 0, dy: 0, dz: 0 }]);
    expect(plays.map(p => p.sType)).toEqual([1, 2]);
  });
});
