/**
 * Decomp-diff sweep 2026-09-30, audio (docs/decomp-diff-sweep-2026-09-30.md):
 *
 *  S7 DECOMP.volume-pref-routing — UI sounds play at the EFFECTS volume
 *     (SoundManager::PlaySoundFromCenter @ 00550950 / 005509e0 →
 *     GetAttenuation(…, param_4 = 0) = effect_sound_volume; the interface
 *     volume pref is never read); the ambient volume applies twice
 *     (PlayAmbientSoundFromCenter @ 005508b0 / PlayAmbientSound @ 00550820
 *     pass ambient × desc volume, and GetAttenuation multiplies by it again).
 *  S8 DECOMP.sound-voice-limit — 16 voices (PlaySoundInternal @ 0054fec0),
 *     priority replacement (every SoundBufRef priority is 0 → a full table
 *     drops the new sound), and no new sound while the app is inactive
 *     (s_bPlaySoundOnlyWhenActive, default on).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AudioManager } from '../packages/renderer/src/audio/AudioManager.js';
import {
  SoundPlayer, RetailVoicePool, RETAIL_VOICE_SLOTS, RETAIL_SOUNDBUF_PRIORITY,
} from '../packages/renderer/src/audio/SoundPlayer.js';
import { AmbientSoundManager } from '../packages/renderer/src/audio/AmbientSoundManager.js';
import { retailSoundAttenuation } from '../packages/renderer/src/audio/RetailSound.js';

// ── a minimal Web Audio graph the REAL AudioManager / SoundPlayer drive ──
interface FakeSource {
  buffer: unknown; started: boolean; stopped: boolean; gain: number;
  onended: (() => void) | null; listeners: Array<() => void>;
  connect(n: FakeGain): void; start(): void; stop(): void;
  addEventListener(t: string, cb: () => void): void; end(): void;
}
interface FakeGain { gain: { value: number }; connect(): void }
let sources: FakeSource[] = [];
class FakeAudioContext {
  destination = {};
  state = 'running';
  createGain(): FakeGain { return { gain: { value: 1 }, connect() {} }; }
  createBufferSource(): FakeSource {
    const s: FakeSource = {
      buffer: null, started: false, stopped: false, gain: 0, onended: null, listeners: [],
      connect(n: FakeGain) { this.gain = n.gain.value; },
      start() { this.started = true; },
      stop() { this.stopped = true; },
      addEventListener(_t: string, cb: () => void) { this.listeners.push(cb); },
      end() { for (const cb of this.listeners) cb(); this.onended?.(); },
    };
    sources.push(s);
    return s;
  }
  async decodeAudioData(): Promise<unknown> { return {}; }
  close(): Promise<void> { return Promise.resolve(); }
}

function makePlayer(tableVolume = 1) {
  const am = new AudioManager();
  expect(am.init()).toBe(true);
  const table = { resolveSound: () => ({ waveId: 0x0a000001, volume: tableVolume }) };
  const portalDb = { getFileData: () => null } as never;
  const sp = new SoundPlayer(portalDb, am);
  // Wave decode is not under test: pre-seed the decoded buffer + table.
  (sp as unknown as { bufferCache: Map<number, unknown> }).bufferCache.set(0x0a000001, {});
  (sp as unknown as { soundTableCache: Map<number, unknown> }).soundTableCache.set(0x20000001, table);
  return { am, sp };
}

beforeEach(() => {
  sources = [];
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
});
afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
});

describe('S8 — RetailVoicePool (SoundManager::PlaySoundInternal @ 0054fec0)', () => {
  const voice = () => ({ stop: vi.fn() });

  it('16 voices; the 17th equal-priority sound is dropped (retail SoundBufRef priority is always 0)', () => {
    const pool = new RetailVoicePool();
    const vs = [];
    for (let i = 0; i < RETAIL_VOICE_SLOTS; i++) {
      const slot = pool.claim();
      expect(slot).toBe(i); // ring order from curr_playing_buffer_ = 0
      const v = voice(); vs.push(v); pool.start(slot, v);
    }
    expect(pool.playingCount).toBe(16);
    expect(pool.claim(RETAIL_SOUNDBUF_PRIORITY)).toBe(-1);
    for (const v of vs) expect(v.stop).not.toHaveBeenCalled();
  });

  it('a finished voice frees its slot for the next sound', () => {
    const pool = new RetailVoicePool();
    const vs = [];
    for (let i = 0; i < 16; i++) { const v = voice(); vs.push(v); pool.start(pool.claim(), v); }
    pool.ended(5, vs[5]);
    expect(pool.claim()).toBe(5);
  });

  it('a higher-priority sound stops the first lower-priority voice from the ring cursor', () => {
    const pool = new RetailVoicePool();
    const vs = [];
    for (let i = 0; i < 16; i++) { const v = voice(); vs.push(v); pool.start(pool.claim(0), v); }
    // cursor wrapped to 0 → slot 0 is the first lower-priority voice
    expect(pool.claim(1)).toBe(0);
    expect(vs[0].stop).toHaveBeenCalledTimes(1);
    expect(vs[1].stop).not.toHaveBeenCalled();
  });
});

describe('S8 — SoundPlayer uses the 16-voice table and the active-app gate', () => {
  it('the 17th overlapping one-shot does not start', async () => {
    const { sp } = makePlayer();
    for (let i = 0; i < 17; i++) await sp.playSound(0x0a000001, 'effects', 1);
    expect(sources.filter((s) => s.started)).toHaveLength(16);
    sources[3].end();
    await sp.playSound(0x0a000001, 'effects', 1);
    expect(sources.filter((s) => s.started)).toHaveLength(17);
  });

  it('while inactive with "Play Sounds Only When Active" on (default), nothing new starts', async () => {
    const { sp } = makePlayer();
    expect(sp.playOnlyWhenActive).toBe(true);
    sp.appActive = false;
    await sp.playSound(0x0a000001);
    await sp.playGameSound(0x20000001, 1, 'ui');
    await sp.playPositionalSound(0x0a000001, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(sources).toHaveLength(0);
    sp.playOnlyWhenActive = false; // option off: plays in the background
    await sp.playSound(0x0a000001);
    expect(sources).toHaveLength(1);
  });

  it('going inactive does not cut a sound already playing', async () => {
    const { sp } = makePlayer();
    await sp.playSound(0x0a000001);
    sp.appActive = false;
    expect(sources[0].stopped).toBe(false);
  });
});

describe('S7 — UI sounds play at the effects volume; the interface slider is unread', () => {
  it('a UI table sound is heard at GetAttenuation(0, vol) × effect_sound_volume', async () => {
    const { am, sp } = makePlayer(1);
    am.setCategoryVolume('effects', 0.5);
    am.setCategoryVolume('ui', 1); // the 'ui' node carries only the Interface Sounds mute
    await sp.playGameSound(0x20000001, 1, 'ui');
    expect(sources).toHaveLength(1);
    expect(sources[0].gain).toBeCloseTo(retailSoundAttenuation(0, 1, 0.5), 6);
  });

  it('the raw-wave UI path (PlaySoundFromCenter(DID, 1.0)) uses the effects volume too', async () => {
    const { am, sp } = makePlayer();
    am.setCategoryVolume('effects', 0.25);
    await sp.playFromCenter(0x0a000001, 1.0, 'ui');
    expect(sources[0].gain).toBeCloseTo(retailSoundAttenuation(0, 1, 0.25), 6);
  });

  it('with the effects slider at 0 a UI sound is not played (below −50 dB)', async () => {
    const { am, sp } = makePlayer();
    am.setCategoryVolume('effects', 0);
    await sp.playGameSound(0x20000001, 1, 'ui');
    expect(sources).toHaveLength(0);
  });

  it('an effects-category centre sound is heard once at the pref (the node\'s own volume divided out)', async () => {
    const { am, sp } = makePlayer();
    am.setCategoryVolume('effects', 0.5);
    await sp.playGameSound(0x20000001, 1, 'effects');
    // source gain × node gain (0.5) = GetAttenuation(0, 1, 0.5)
    expect(sources[0].gain * 0.5).toBeCloseTo(retailSoundAttenuation(0, 1, 0.5), 6);
  });
});

describe('S7 — the ambient volume applies twice', () => {
  it('a continuous ambient sound plays at GetAttenuation(0, pref × desc volume) with pref again', async () => {
    const { am, sp } = makePlayer();
    am.setCategoryVolume('ambient', 0.5);
    const plays: number[] = [];
    const mgr = new AmbientSoundManager(sp, am, () => 0);
    mgr.onPlay = (p) => plays.push(p.amplitude);
    mgr.loadFromSoundDesc({ stbDesc: [{ stbId: 0x20000001, ambientSounds: [
      { sType: 1, volume: 0.8, baseChance: 0, minRate: 9, maxRate: 12 },
    ] }] } as never);
    // one vertex under the player: weight 1 of total 1 → the desc volume
    mgr.applyNeighbourhood([{ stbIndex: 0, dx: 0, dy: 0, dz: 0 }]);
    expect(plays).toHaveLength(1);
    const expected = retailSoundAttenuation(0, 0.5 * 0.8, 0.5); // 0.8 × 0.5² = 0.2 → ceiled dB
    expect(plays[0]).toBeCloseTo(expected, 6);
    expect(plays[0]).toBeLessThan(retailSoundAttenuation(0, 0.8, 0.5)); // not the single-pref level
    await Promise.resolve(); await Promise.resolve();
    // heard = source gain × ambient node gain (0.5)
    expect(sources[0].gain * 0.5).toBeCloseTo(expected, 6);
  });
});
