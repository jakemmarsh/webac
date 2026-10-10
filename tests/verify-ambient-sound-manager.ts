/**
 * FAITHFUL.50 — AmbientSoundManager state-machine pin tests.
 *
 * Companions to FAITHFUL.49's splash-font close. The actual sound playback
 * needs Web Audio + a live ACE region to verify, so these tests pin the
 * deterministic logic — STB selection, continuous-vs-probabilistic
 * classification, enable/disable, STB switching — that the in-game ambient
 * loop depends on.
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/Entity/AmbientSoundDesc.cs
 * (baseChance == 0 ⇒ ConstantSound replayed every minRate, > 0 ⇒ Bernoulli trial per interval).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AmbientSoundManager } from '../packages/renderer/src/audio/AmbientSoundManager.js';
import { AudioManager } from '../packages/renderer/src/audio/AudioManager.js';
import type { SoundDesc } from '@ac/dat-parser/file-types/RegionDesc.js';

// Lightweight stub for SoundPlayer — AmbientSoundManager only calls
// loadSoundTable / decodeWave / playSound in actual playback paths, which we
// don't exercise here. State-machine tests never reach those paths because
// the test AudioManager is left uninitialized (audioManager.isInitialized = false).
const stubSoundPlayer = {
  loadSoundTable: () => null,
  decodeWave: () => null,
  playSound: () => Promise.resolve(),
  playPositionalSound: () => Promise.resolve(),
} as unknown as ConstructorParameters<typeof AmbientSoundManager>[0];

function makeDesc(
  stbs: Array<{
    stbId: number;
    ambientSounds: Array<{
      sType: number; volume: number; baseChance: number;
      minRate: number; maxRate: number;
    }>;
  }>,
): SoundDesc {
  return { stbDesc: stbs as SoundDesc['stbDesc'] };
}

/** One vertex under the player carrying STB `i` (a uniform region). */
const under = (stbIndex: number) => [{ stbIndex, dx: 0, dy: 0, dz: 0 }];

describe('AmbientSoundManager — STB loading + gathering', () => {
  let am: AudioManager;
  let mgr: AmbientSoundManager;

  beforeEach(() => {
    am = new AudioManager();
    mgr = new AmbientSoundManager(stubSoundPlayer, am);
  });

  it('loads the STB descriptors but plays nothing until the first gather (retail Ambient starts empty)', () => {
    const desc = makeDesc([
      { stbId: 0x20000001, ambientSounds: [{ sType: 1, volume: 1.0, baseChance: 0, minRate: 0, maxRate: 0 }] },
      { stbId: 0x20000002, ambientSounds: [{ sType: 2, volume: 0.5, baseChance: 0.3, minRate: 5, maxRate: 15 }] },
    ]);
    mgr.loadFromSoundDesc(desc);
    expect(mgr.getSoundStates()).toHaveLength(0);
    mgr.applyNeighbourhood(under(1));
    expect(mgr.getActiveSoundStates().map(s => s.stbId)).toEqual([0x20000002]);
  });

  it('classifies baseChance===0 as a constant sound and >0 as intermittent', () => {
    const desc = makeDesc([{
      stbId: 0x20000001,
      ambientSounds: [
        { sType: 1, volume: 1.0, baseChance: 0, minRate: 0, maxRate: 0 },
        { sType: 2, volume: 1.0, baseChance: 0.5, minRate: 5, maxRate: 10 },
      ],
    }]);
    mgr.loadFromSoundDesc(desc);
    mgr.applyNeighbourhood(under(0));
    const states = mgr.getActiveSoundStates();
    expect(states.length).toBe(2);
    expect(states[0].isContinuous).toBe(true);
    expect(states[1].isContinuous).toBe(false);
  });

  it('a gather over another STB makes its sounds active and the old ones silent (count 0)', () => {
    const desc = makeDesc([
      { stbId: 0x20000001, ambientSounds: [{ sType: 1, volume: 1.0, baseChance: 0, minRate: 0, maxRate: 0 }] },
      { stbId: 0x20000002, ambientSounds: [
        { sType: 2, volume: 1.0, baseChance: 0, minRate: 0, maxRate: 0 },
        { sType: 3, volume: 0.5, baseChance: 0.1, minRate: 30, maxRate: 60 },
      ]},
    ]);
    mgr.loadFromSoundDesc(desc);
    mgr.applyNeighbourhood(under(0));
    expect(mgr.getActiveSoundStates().length).toBe(1);

    mgr.applyNeighbourhood(under(1));
    expect(mgr.getActiveSoundStates().map(s => s.sType)).toEqual([2, 3]);
    // Ambient::GetSound keeps every sound met; STB 0's is now weightless.
    const old = mgr.getSoundStates().find(s => s.sType === 1)!;
    expect(old.soundCount).toBe(0);
    expect(old.currentVolume).toBe(0);
  });

  it('a vertex whose STB index is out of range adds nothing (retail GetSTBDesc → null)', () => {
    mgr.loadFromSoundDesc(makeDesc([{ stbId: 1, ambientSounds: [] }]));
    mgr.applyNeighbourhood(under(99));
    expect(mgr.getTotalSoundCount()).toBe(0);
    expect(mgr.getSoundStates()).toHaveLength(0);
  });

  it('setEnabled(false) drops every sound from the queue; true re-gathers the last neighbourhood', () => {
    const desc = makeDesc([{ stbId: 1, ambientSounds: [
      { sType: 1, volume: 1.0, baseChance: 0.5, minRate: 5, maxRate: 10 },
    ]}]);
    mgr.loadFromSoundDesc(desc);
    mgr.applyNeighbourhood(under(0));
    expect(mgr.isEnabled).toBe(true);
    expect(mgr.getActiveSoundStates()[0].onQueue).toBe(true);

    mgr.setEnabled(false);
    expect(mgr.isEnabled).toBe(false);
    expect(mgr.getSoundStates()[0].onQueue).toBe(false);

    mgr.setEnabled(true);
    expect(mgr.getActiveSoundStates()[0].onQueue).toBe(true);
    expect(mgr.getActiveSoundStates()[0].playChance).toBeCloseTo(0.5, 9);
  });

  it('an intermittent sound is played at once and re-queued after RollDice(min_rate, max_rate)', () => {
    // BUG.server-sound-not-positional — Ambient::UpdatePlayQueue plays a
    // sound not yet on the queue (verify-bug-server-sound-not-positional.ts
    // drives the schedule).
    const desc = makeDesc([{
      stbId: 1,
      ambientSounds: [
        { sType: 1, volume: 1.0, baseChance: 0.1, minRate: 5, maxRate: 15 },
      ],
    }]);
    mgr = new AmbientSoundManager(stubSoundPlayer, am, () => 0.5);
    mgr.loadFromSoundDesc(desc);
    mgr.applyNeighbourhood(under(0));
    const state = mgr.getActiveSoundStates()[0];
    expect(state.onQueue).toBe(true);
    expect(state.nextPlayIn).toBeCloseTo(10, 9);
  });

  it('a constant sound re-queues every min_rate', () => {
    const desc = makeDesc([{
      stbId: 1,
      ambientSounds: [{ sType: 1, volume: 1.0, baseChance: 0, minRate: 9.04, maxRate: 12.08 }],
    }]);
    mgr.loadFromSoundDesc(desc);
    mgr.applyNeighbourhood(under(0));
    expect(mgr.getActiveSoundStates()[0].nextPlayIn).toBeCloseTo(9.04, 9);
  });
});
