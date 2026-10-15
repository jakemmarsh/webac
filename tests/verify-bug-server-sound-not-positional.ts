/**
 * BUG.server-sound-not-positional — a server Sound message (0xF750, ACE
 * GameMessageSound: guid + Sound + volume) played non-positionally from the
 * object's table OR a fallback human table, and SoundTable.resolveSound
 * picked a variant weighted by probability and always played it.
 *
 * Retail (decompiled acclient, build ac1_sep13):
 *  - SmartBox::HandleSoundEvent @ 00451fc0: unknown object → the message is
 *    queued for it (CObjectMaint::QueueBlobForObject).
 *  - CPhysicsObj::play_sound @ 0050f460: no sound table → nothing.
 *  - SoundManager::PlaySoundA(SoundType, CPhysicsObj*, float) @ 00550af0:
 *    GetSound @ 00550680 (UNIFORM variant) + PlayProbability @ 005500e0,
 *    played at the object's position at the SERVER volume.
 *  - Ambient (Ambient::Play @ 005517a0): a ConstantSound replays every
 *    min_rate (GetPlayInterval @ 005510a0), heard only at volume ≥ 0.03;
 *    an IntermitSound plays when RollDice < base_chance at 4–10 m in the
 *    viewer's block; the play level is the ambient desc's volume.
 */
import { describe, it, expect } from 'vitest';
import { SoundTable, retailGetSound, type SoundData } from '../packages/dat-parser/src/file-types/SoundTable.js';
import { resolveServerSound, retailSoundAttenuation, pickRetailTableSound } from '../packages/renderer/src/audio/RetailSound.js';
import { PendingPlayScripts } from '../packages/renderer/src/effects/PlayScriptResolve.js';
import { AmbientSoundManager, AMBIENT_SOUND_MIN_VOL, type AmbientPlay } from '../packages/renderer/src/audio/AmbientSoundManager.js';
import type { SoundDesc } from '@ac/dat-parser/file-types/RegionDesc.js';

/** A scripted rng: returns the given values in order, then 0. */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0);
}

function tableWith(entries: Record<number, Array<{ soundId: number; probability: number; volume: number }>>): SoundTable {
  const t = new SoundTable();
  for (const [k, vs] of Object.entries(entries)) {
    t.data.set(Number(k), { unknown: 0, data: vs.map((v) => ({ priority: 0, ...v })) } as SoundData);
  }
  return t;
}

describe('SoundTable.resolveSound — GetSound (uniform) + PlayProbability', () => {
  const t = tableWith({
    0x40: [
      { soundId: 0x0a000001, probability: 0.9, volume: 0.8 },
      { soundId: 0x0a000002, probability: 0.1, volume: 0.6 },
    ],
    0x41: [{ soundId: 0, probability: 1, volume: 1 }],
  });

  it('picks the variant uniformly, not by probability weight', () => {
    // Roll 0.6 of 2 variants → index 1 (weighted-by-probability would pick 0).
    expect(t.resolveSound(0x40, seq(0.6, 0.05))).toEqual({ waveId: 0x0a000002, volume: 0.6 });
    expect(t.resolveSound(0x40, seq(0.4, 0.5))).toEqual({ waveId: 0x0a000001, volume: 0.8 });
  });

  it('plays the pick only when the roll is under its probability (so a sound can be silent)', () => {
    expect(t.resolveSound(0x40, seq(0.6, 0.1))).toBeNull(); // 0.1 is not < 0.1
    expect(t.resolveSound(0x40, seq(0.4, 0.95))).toBeNull();
  });

  it('a variant with no wave, or a missing entry, plays nothing', () => {
    expect(t.resolveSound(0x41, seq(0, 0))).toBeNull();
    expect(t.resolveSound(0x99, seq(0, 0))).toBeNull();
    expect(retailGetSound(t.data, 0x40, seq(0.99, 0))).toEqual({ waveId: 0x0a000002, volume: 0.6 });
    expect(pickRetailTableSound(t, 0x40, seq(0.99, 0))).toEqual({ waveId: 0x0a000002, volume: 0.6 });
  });
});

describe('resolveServerSound — CPhysicsObj::play_sound → PlaySoundA(type, obj, volume)', () => {
  const t = tableWith({ 0x77: [{ soundId: 0x0a000123, probability: 1, volume: 0.3 }] });
  const load = (id: number) => (id === 0x20000055 ? t : null);

  it('an unknown object is "no-object" (the message is queued)', () => {
    expect(resolveServerSound(null, 0x77, 1, load)).toEqual({ played: false, reason: 'no-object' });
  });

  it('an object with no sound table plays nothing — no fallback table', () => {
    expect(resolveServerSound(0, 0x77, 1, load)).toEqual({ played: false, reason: 'no-sound-table' });
  });

  it('plays the object table\'s wave at the SERVER volume, not the variant\'s', () => {
    expect(resolveServerSound(0x20000055, 0x77, 0.5, load, seq(0, 0))).toEqual({ played: true, waveId: 0x0a000123, volume: 0.5 });
  });

  it('a failed probability roll or a missing entry plays nothing', () => {
    const rare = tableWith({ 0x77: [{ soundId: 0x0a000123, probability: 0.25, volume: 1 }] });
    expect(resolveServerSound(0x20000055, 0x77, 1, () => rare, seq(0, 0.5))).toEqual({ played: false, reason: 'no-sound' });
    expect(resolveServerSound(0x20000055, 0x78, 1, load)).toEqual({ played: false, reason: 'no-sound' });
  });

  it('the played level is GetAttenuation at the object: full within 5 m, 25·v/d² beyond, cut below −50 dB', () => {
    expect(retailSoundAttenuation(3, 1)).toBe(1);
    expect(retailSoundAttenuation(10, 1)).toBeCloseTo(Math.pow(10, -12 / 20), 6);
    expect(retailSoundAttenuation(100, 1)).toBe(0);
  });

  it('a queued sound replays once its object exists (the same blob queue as PlayScript)', () => {
    const q = new PendingPlayScripts();
    let exists = false;
    const played: number[] = [];
    const attempt = () => {
      const r = resolveServerSound(exists ? 0x20000055 : null, 0x77, 1, load, seq(0, 0));
      if (r.played) played.push(r.waveId);
      return r;
    };
    expect(q.park(attempt(), 0x80001234, attempt, 0)).toBe(true);
    q.pump(100, () => exists);
    expect(played).toEqual([]);
    exists = true;
    q.pump(200, () => exists);
    expect(played).toEqual([0x0a000123]);
    expect(q.size).toBe(0);
    // A played or table-less outcome is never parked.
    expect(q.park(resolveServerSound(0, 0x77, 1, load), 1, attempt, 0)).toBe(false);
  });
});

describe('AmbientSoundManager — Ambient::Play / UseTime', () => {
  function rig(sounds: SoundDesc['stbDesc'][number]['ambientSounds'], table: SoundTable, rng: () => number) {
    const started: Array<{ wave: number; amp: number }> = [];
    const player = {
      loadSoundTable: () => table,
      playSound: (wave: number, _cat: string, amp: number) => { started.push({ wave, amp }); return Promise.resolve(null); },
      // the ambient node at volume 1 → the source gain is the heard level
      levelThroughCategory: (amp: number) => amp,
    } as never;
    // Ambient slider at 1 (DECOMP.volume-pref-routing: it applies twice, so
    // 1 keeps GetAttenuation(distance, desc volume)).
    const audio = { isInitialized: true, isRunning: true, getCategoryVolume: () => 1 } as never;
    const mgr = new AmbientSoundManager(player, audio, rng);
    const plays: AmbientPlay[] = [];
    mgr.onPlay = (p) => plays.push(p);
    mgr.loadFromSoundDesc({ stbDesc: [{ stbId: 0x20000017, ambientSounds: sounds }] } as SoundDesc);
    // A uniform region: the one vertex under the player carries the STB
    // (RECON.ambient-sound-weighting — weight 1 of total 1). The gather's
    // UpdatePlayQueue plays every sound not yet queued at once.
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 0, dy: 0, dz: 0 }]);
    return { mgr, plays, started };
  }

  it('a continuous sound is a one-shot replayed every min_rate at the desc volume (the variant volume unused)', () => {
    const table = tableWith({ 77: [{ soundId: 0x0a0002d1, probability: 1, volume: 0.5 }] });
    const { mgr, plays, started } = rig([{ sType: 77, volume: 0.25, baseChance: 0, minRate: 12.08, maxRate: 12.08 }] as never, table, () => 0);
    expect(plays).toHaveLength(1); // not on the queue yet → played at once
    expect(plays[0].distance).toBe(0); // from the centre
    expect(plays[0].amplitude).toBeCloseTo(retailSoundAttenuation(0, 0.25), 9);
    expect(started[0]).toEqual({ wave: 0x0a0002d1, amp: plays[0].amplitude });
    mgr.update(12.0);
    expect(plays).toHaveLength(1);
    mgr.update(0.1);
    expect(plays).toHaveLength(2);
  });

  it('a continuous sound quieter than ambient_sound_min_vol (0.03) is not heard', () => {
    expect(AMBIENT_SOUND_MIN_VOL).toBe(0.03);
    const table = tableWith({ 70: [{ soundId: 0x0a0002e0, probability: 1, volume: 1 }] });
    const { mgr, plays } = rig([{ sType: 70, volume: 0.02, baseChance: 0, minRate: 5.8, maxRate: 5.8 }] as never, table, () => 0);
    mgr.update(6);
    expect(plays).toHaveLength(0);
  });

  it('an intermittent sound rolls base_chance, plays 4–10 m away, and re-queues after RollDice(min, max)', () => {
    const table = tableWith({ 70: [{ soundId: 0x0a0001f4, probability: 1, volume: 1 }] });
    // PlayNow 0.2 < 0.5 → plays; GetSoundPos: direction roll 0 → the first
    // of the eight in-block bins (north), heading roll 0.5 → no jitter,
    // distance roll r = 0.5 → (10−4)·0.25 + 4 = 5.5 m; GetSound 0 +
    // probability 0; interval roll 0.5 → 1.4 + 0.5·8.6 = 5.7 s.
    const { mgr, plays } = rig([{ sType: 70, volume: 0.6, baseChance: 0.5, minRate: 1.4, maxRate: 10 }] as never, table,
      seq(0.2, 0, 0.5, 0.5, 0, 0, 0.5, /* next Play: PlayNow fails */ 0.9, 0.5));
    expect(plays).toHaveLength(1);
    expect(plays[0].distance).toBeCloseTo(5.5, 9);
    expect(plays[0].dx).toBeCloseTo(0, 9);
    expect(plays[0].dy).toBeCloseTo(5.5, 9);
    expect(plays[0].amplitude).toBeCloseTo(retailSoundAttenuation(5.5, 0.6), 9);
    expect(mgr.getActiveSoundStates()[0].nextPlayIn).toBeCloseTo(5.7, 9);
    mgr.update(5.8);
    expect(plays).toHaveLength(1); // rolled 0.9 ≥ 0.5: silent this time
  });
});
