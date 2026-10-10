import { AnimationHookType, type AnimationFrame } from '@ac/dat-parser/file-types/AnimationHook.js';
import type { SoundData } from '@ac/dat-parser/file-types/SoundTable.js';

/**
 * SOUND.wave-precache — retail loads every wave a sound table or a sound hook
 * names as the table / animation itself loads: `SoundTableData::UnPack`
 * @ 00552370, `SoundHook::UnPack` @ 005276c0 and `SoundTweakedHook::UnPack`
 * @ 00527780 each call `SoundManager::CreateSound`, so a sound is in
 * `sound_hash_` before anything plays it. A streamed DAT set fetched a
 * Wave only when it was first played, so each sound's first play in a
 * session came a round trip late. This asks for those waves at background
 * priority as their tables and animations are read (never gating a load).
 */
export class WavePrefetch {
  private readonly asked = new Set<number>();

  /** `fetch` requests one Wave (the streamed store, background priority); null = whole DATs, nothing to do. */
  constructor(private readonly fetch: ((waveId: number) => void) | null = null) {}

  /** Request one wave once per session. */
  wave(id: number): void {
    if (!this.fetch) return;
    const w = id >>> 0;
    if ((w >>> 24) !== 0x0a || this.asked.has(w)) return;
    this.asked.add(w);
    this.fetch(w);
  }

  /** Every variant of every entry in a sound table (SoundTableData::UnPack). */
  table(data: ReadonlyMap<number, SoundData>): void {
    if (!this.fetch) return;
    for (const entry of data.values()) for (const v of entry.data) this.wave(v.soundId);
  }

  /** The Sound / SoundTweaked hooks of an animation's frames (or a script's hooks). */
  hooks(frames: readonly Pick<AnimationFrame, 'hooks'>[]): void {
    if (!this.fetch) return;
    for (const f of frames) {
      for (const h of f.hooks) {
        if (h.hookType === AnimationHookType.Sound || h.hookType === AnimationHookType.SoundTweaked) {
          this.wave((h as { soundId: number }).soundId);
        }
      }
    }
  }

  /** Waves requested so far (tests / diagnostics). */
  get requested(): number { return this.asked.size; }
}

/** The session's prefetcher (set once at boot when the DATs stream). */
let current = new WavePrefetch();
export function setWavePrefetch(p: WavePrefetch): void { current = p; }
export function wavePrefetch(): WavePrefetch { return current; }
