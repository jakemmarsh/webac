import type { DatFileSource } from '@ac/dat-parser/RangedDat.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { Wave } from '@ac/dat-parser/file-types/Wave.js';
import { SoundTable } from '@ac/dat-parser/file-types/SoundTable.js';
import type { AudioManager } from './AudioManager.js';
import { retailPanGains, retailSoundAttenuation, retailSoundPan } from './RetailSound.js';
import { wavePrefetch } from './WavePrefetch.js';

/** `SoundManager::playing_sounds_` — the fixed voice table (16 slots, `& 0xf`). */
export const RETAIL_VOICE_SLOTS = 16;

/**
 * The priority every played buffer carries. `PlaySoundInternal` compares
 * `SoundBufRef::data_.priority_`, and the SoundBufRef's `data_` is only ever
 * the `SoundData::SoundData` @ 00551cb0 default (priority 0.0) —
 * `SoundManager::CreateSound` @ 00550bf0 never fills it from the table
 * variant (GetSound @ 00550680 copies the variant's priority into a local
 * SoundData instead). So in retail every voice has priority 0, nothing is
 * ever pre-empted, and a full table drops the new sound.
 */
export const RETAIL_SOUNDBUF_PRIORITY = 0;

/**
 * Which portal a sound comes from (docs/ac1999-support-scope.md Phase 1.3):
 * 'ui' for the interface sounds (playGameSound / playFromCenter: the UI table
 * 0x2000004B and layout media waves), 'world' for object, ambient and music
 * sounds. One DAT serves both unless the era has a separate world portal.
 */
export type SoundSource = 'world' | 'ui';

/** A started voice the pool can stop. */
export interface RetailVoice { stop(): void }

/**
 * DECOMP.sound-voice-limit — `SoundManager::PlaySoundInternal(SoundBufRef*,
 * pan, vol)` @ 0054fec0: a 16-slot ring searched from `curr_playing_buffer_`.
 * Pass 1 takes the first slot that is empty or whose buffer has stopped
 * playing; pass 2 takes the first slot whose priority is LOWER than the new
 * sound's, stopping that voice; with neither, the new sound is not played.
 * The next search starts one past the slot used.
 */
export class RetailVoicePool {
  private readonly slots: Array<{ voice: RetailVoice | null; playing: boolean; priority: number }> =
    Array.from({ length: RETAIL_VOICE_SLOTS }, () => ({ voice: null, playing: false, priority: 0 }));
  private curr = 0;

  /**
   * Claim a slot for a sound of `priority`. Returns the slot index, or -1
   * when every slot holds a playing voice of equal or higher priority.
   */
  claim(priority: number = RETAIL_SOUNDBUF_PRIORITY): number {
    let slot = -1;
    for (let i = 0; i < RETAIL_VOICE_SLOTS; i++) {
      const k = (this.curr + i) & (RETAIL_VOICE_SLOTS - 1);
      if (!this.slots[k].voice || !this.slots[k].playing) { slot = k; break; }
    }
    if (slot < 0) {
      for (let i = 0; i < RETAIL_VOICE_SLOTS; i++) {
        const k = (this.curr + i) & (RETAIL_VOICE_SLOTS - 1);
        if (this.slots[k].priority < priority) { slot = k; break; }
      }
      if (slot < 0) return -1;
      try { this.slots[slot].voice?.stop(); } catch { /* already stopped */ }
    }
    this.slots[slot] = { voice: null, playing: false, priority };
    this.curr = (slot + 1) & (RETAIL_VOICE_SLOTS - 1);
    return slot;
  }

  /** Attach the started voice to a claimed slot. */
  start(slot: number, voice: RetailVoice): void {
    this.slots[slot].voice = voice;
    this.slots[slot].playing = true;
  }

  /** The slot's voice finished (`SoundBuf::GetStatus & 1 == 0`). */
  ended(slot: number, voice: RetailVoice): void {
    if (this.slots[slot].voice === voice) this.slots[slot].playing = false;
  }

  /** Voices currently playing. */
  get playingCount(): number {
    return this.slots.filter((s) => s.voice && s.playing).length;
  }
}

/**
 * SoundPlayer — loads and plays WAV sounds from portal.dat.
 *
 * Supports positional (3D) audio, SoundTable-based enum lookup,
 * and direct wave ID playback. Every one-shot goes through the retail
 * 16-voice table (RetailVoicePool) and the "Play Sounds Only When Active"
 * gate.
 */
export class SoundPlayer {
  private portalDb: DatFileSource;
  private audioManager: AudioManager;
  private waveCache = new Map<number, Wave>();
  /**
   * RELEASE.dat-streaming — a streamed portal.dat answers a Wave that is not
   * resident yet with null; this fetches it (resolves true once resident) so
   * the sound plays ~1 round trip late instead of not at all. `src` names the
   * portal it is missing from (the interface's and the world's can be
   * different sets: AC1999). Unset = whole DATs.
   */
  fetchMissing: ((waveId: number, src: SoundSource) => Promise<boolean>) | null = null;
  private bufferCache = new Map<number, AudioBuffer>();
  private soundTableCache = new Map<number, SoundTable>();
  /** DECOMP.sound-voice-limit — SoundManager::playing_sounds_. */
  readonly voices = new RetailVoicePool();

  /**
   * DECOMP.sound-voice-limit — `SoundManager::s_bPlaySoundOnlyWhenActive`
   * (the Config "Play Sounds Only When Active" pref; .data default true).
   * While it is set and the app is inactive (`Device::m_bIsActiveApp`,
   * cleared by `Device::Deactivate` @ 00439020 on WM_ACTIVATEAPP), every
   * SoundManager play entry point (PlaySoundA, PlaySoundFromCenter,
   * PlaySoundInternal) returns without starting anything. Sounds already
   * playing are NOT cut.
   */
  playOnlyWhenActive = true;
  /** `Device::m_bIsActiveApp` — the page has focus and is visible. */
  appActive = true;

  /**
   * RECON.ambient-sound-weighting.pan — `SoundManager::s_SoundFeatures`
   * (Config "Sound Features"): Stereo (0, the default) pans positional
   * sounds; Mono (1) skips `PlaySoundInternal`'s pan step. That is the
   * pref's only reader.
   */
  stereo = true;

  /** The interface sounds' portal and caches (the world's own when it is the same DAT). */
  private readonly uiDb: DatFileSource;
  private readonly uiWaveCache: Map<number, Wave>;
  private readonly uiBufferCache: Map<number, AudioBuffer>;
  private readonly uiSoundTableCache: Map<number, SoundTable>;

  constructor(portalDb: DatFileSource, audioManager: AudioManager, uiPortalDb: DatFileSource = portalDb) {
    this.portalDb = portalDb;
    this.audioManager = audioManager;
    this.uiDb = uiPortalDb;
    const shared = uiPortalDb === portalDb;
    this.uiWaveCache = shared ? this.waveCache : new Map();
    this.uiBufferCache = shared ? this.bufferCache : new Map();
    this.uiSoundTableCache = shared ? this.soundTableCache : new Map();
  }

  private source(src: SoundSource) {
    return src === 'ui'
      ? { db: this.uiDb, waves: this.uiWaveCache, buffers: this.uiBufferCache, tables: this.uiSoundTableCache }
      : { db: this.portalDb, waves: this.waveCache, buffers: this.bufferCache, tables: this.soundTableCache };
  }

  /** The `(!s_bPlaySoundOnlyWhenActive || Device::m_bIsActiveApp)` gate. */
  get canStartSounds(): boolean {
    return !this.playOnlyWhenActive || this.appActive;
  }

  /**
   * Load a SoundTable (0x20xxxxxx) from portal.dat (cached).
   */
  loadSoundTable(soundTableId: number, src: SoundSource = 'world'): SoundTable | null {
    const from = this.source(src);
    const cached = from.tables.get(soundTableId);
    if (cached) return cached;

    const data = from.db.getFileData(soundTableId);
    if (!data) return null;

    const table = SoundTable.read(new DatReader(data));
    from.tables.set(soundTableId, table);
    // SOUND.wave-precache — SoundTableData::UnPack → CreateSound per wave.
    if (src === 'world') wavePrefetch().table(table.data);
    return table;
  }

  /**
   * `SoundManager::PlaySoundFromCenter(SoundType, CSoundTable*)` @ 00550950
   * — a table sound with no position (UI / interface sounds): `GetSound`'s
   * uniform variant, `PlayProbability`, then `GetAttenuation(0, variant
   * volume)` (the ceiled-dB level, not played below −50 dB). `volumeScale`
   * multiplies the variant's volume (1 = retail). Object sounds do NOT come
   * here: a server Sound message plays AT its object
   * (RetailSound.resolveServerSound → playPositionalSound).
   *
   * DECOMP.volume-pref-routing — GetAttenuation's `param_4 = 0` makes the
   * preference `effect_sound_volume` (the Sound Effects slider), for UI
   * sounds too: `interface_sound_volume` is registered and shown on the
   * Config page but no play path reads it. `interface_sounds_enabled` (the
   * Interface Sounds check box = the 'ui' category mute) is what gates them.
   */
  async playGameSound(soundTableId: number, soundEnum: number, category = 'effects', volumeScale = 1.0): Promise<void> {
    if (!this.canStartSounds) return;
    const table = this.loadSoundTable(soundTableId, 'ui');
    if (!table) return;

    const resolved = table.resolveSound(soundEnum);
    if (!resolved) return;

    await this.playFromCenter(resolved.waveId, resolved.volume * volumeScale, category);
  }

  /**
   * `SoundManager::PlaySoundFromCenter(DID, float)` @ 005509e0 — a raw wave
   * with no position (a layout media sound whose SoundType is 0 plays at
   * 1.0, MediaMachine::Update_Sound @ 004658b0): `GetAttenuation(0, volume)`
   * with the effect-volume preference (DECOMP.volume-pref-routing).
   */
  async playFromCenter(waveId: number, volume = 1.0, category = 'ui'): Promise<void> {
    if (!this.canStartSounds) return;
    const pref = this.audioManager.getCategoryVolume('effects');
    const amp = retailSoundAttenuation(0, volume, pref);
    if (amp <= 0) return;
    await this.playSound(waveId, category, this.levelThroughCategory(amp, category), 'ui');
  }

  /**
   * The source gain that makes a sound heard at exactly `amp` after the
   * category node (its volume slider) multiplies it: retail applies the
   * preference once, inside GetAttenuation, so the node's volume is divided
   * back out. The node's mute (the category's enable check box) still acts.
   */
  levelThroughCategory(amp: number, category: string): number {
    const nodeVolume = this.audioManager.getCategoryGain(category) ? this.audioManager.getCategoryVolume(category) : 1;
    return nodeVolume > 0 ? amp / nodeVolume : 0;
  }

  /**
   * Load a Wave file from portal.dat (cached).
   */
  loadWave(waveId: number, src: SoundSource = 'world'): Wave | null {
    const from = this.source(src);
    const cached = from.waves.get(waveId);
    if (cached) return cached;

    const data = from.db.getFileData(waveId);
    if (!data) return null;

    const wave = new Wave(new DatReader(data));
    from.waves.set(waveId, wave);
    return wave;
  }

  /**
   * Decode a Wave into an AudioBuffer (cached, async).
   */
  async decodeWave(waveId: number, src: SoundSource = 'world'): Promise<AudioBuffer | null> {
    const from = this.source(src);
    const cached = from.buffers.get(waveId);
    if (cached) return cached;

    let wave = this.loadWave(waveId, src);
    if (!wave && this.fetchMissing && await this.fetchMissing(waveId, src).catch(() => false)) wave = this.loadWave(waveId, src);
    if (!wave) return null;

    // MP3-flagged waves (ACE Wave.cs: Header[0]==0x55, WAVE_FORMAT_MPEGLAYER3)
    // store a bare MPEG elementary stream, not PCM — decodeAudioData sniffs
    // and decodes that directly, so skip the RIFF/PCM wrapper for those.
    const encoded = wave.isMP3 ? (wave.data.buffer as ArrayBuffer) : wave.toWavBuffer();
    const audioBuffer = await this.audioManager.decodeWavData(encoded);
    if (audioBuffer) {
      from.buffers.set(waveId, audioBuffer);
    }
    return audioBuffer;
  }

  /**
   * Play a sound effect at source gain `volume`, in a retail voice slot,
   * panned `pan` dB (RetailSound.retailSoundPan; 0 = centred). Null when
   * inactive-gated, undecodable, or all 16 voices are busy.
   */
  async playSound(waveId: number, category = 'effects', volume = 1.0, src: SoundSource = 'world', pan = 0): Promise<AudioBufferSourceNode | null> {
    const ctx = this.audioManager.audioContext;
    if (!ctx) return null;
    if (!this.canStartSounds) return null;
    if (this.audioManager.isCategoryMuted(category)) return null;

    const buffer = await this.decodeWave(waveId, src);
    if (!buffer) return null;

    return this.startVoice(ctx, buffer, category, volume, pan);
  }

  /**
   * Start a decoded buffer in a retail voice slot (PlaySoundInternal @
   * 0054fec0). Returns null when all 16 slots hold playing voices. A
   * non-zero `pan` is `SoundBuf::Play`'s SetPan: the buffer is heard on both
   * channels (a mono wave on each) and the far one is turned down.
   */
  private startVoice(ctx: AudioContext, buffer: AudioBuffer, category: string, volume: number, pan = 0): AudioBufferSourceNode | null {
    // SOUND.enable-checkboxes-persist — a disabled category
    // (effect_/ambient_/interface_sounds_enabled) returns before
    // PlaySoundInternal: no voice slot is used.
    if (this.audioManager.isCategoryMuted(category)) return null;
    const slot = this.voices.claim(RETAIL_SOUNDBUF_PRIORITY);
    if (slot < 0) return null;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const gainNode = ctx.createGain();
    gainNode.gain.value = volume;

    const categoryGain = this.audioManager.getCategoryGain(category);
    if (categoryGain) {
      gainNode.connect(categoryGain);
    } else {
      gainNode.connect(ctx.destination);
    }

    if (pan) SoundPlayer.connectPanned(ctx, source, gainNode, pan);
    else source.connect(gainNode);
    this.voices.start(slot, source);
    source.addEventListener('ended', () => this.voices.ended(slot, source));
    source.start(0);
    return source;
  }

  /**
   * source → stereo up-mix → per-channel SetPan gains → gainNode. The
   * up-mix gain plays a mono wave on both channels (DirectSound's mono
   * buffer), so only the pan attenuation differs between them.
   */
  static connectPanned(ctx: BaseAudioContext, source: AudioNode, out: AudioNode, pan: number): void {
    const { left, right } = retailPanGains(pan);
    const upmix = ctx.createGain();
    upmix.channelCount = 2;
    upmix.channelCountMode = 'explicit';
    upmix.channelInterpretation = 'speakers';
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const l = ctx.createGain();
    const r = ctx.createGain();
    l.gain.value = left;
    r.gain.value = right;
    source.connect(upmix);
    upmix.connect(split);
    split.connect(l, 0);
    split.connect(r, 1);
    l.connect(merge, 0, 0);
    r.connect(merge, 0, 1);
    merge.connect(out);
  }

  /**
   * SWEEP1006 hook volume — the effects preference (effect_sound_volume).
   * SoundManager::PlaySoundA(DID, obj) @ 00550730 — what a raw-wave
   * SoundHook plays — passes it as the sound's own volume, and
   * GetAttenuation @ 00550020 multiplies by it again: such a wave is heard
   * at the preference squared.
   */
  get effectsVolume(): number {
    return this.audioManager.getCategoryVolume('effects');
  }

  /**
   * Play a sound at a world position, attenuated the retail way
   * (`SoundManager::GetAttenuation` — see audio/RetailSound): full volume
   * within 5 m of the listener, inverse-square beyond, not played below
   * -50 dB. `volume` is the sound's own level (a SoundTable variant's
   * volume, a SoundTweaked hook's vol); the category gain is the user's
   * volume preference and takes part in the -50 dB cut, as retail's
   * effect_sound_volume did.
   *
   * Positions are world (three.js) coordinates: x east, z north, y up. When
   * the listener carries `heading` (the viewer's compass heading, degrees)
   * and Sound Features is Stereo, the sound is panned the retail way
   * (RetailSound.retailSoundPan).
   */
  async playPositionalSound(
    waveId: number,
    position: { x: number; y: number; z: number },
    listenerPosition: { x: number; y: number; z: number; heading?: number },
    category = 'effects',
    volume = 1.0,
  ): Promise<void> {
    const ctx = this.audioManager.audioContext;
    if (!ctx) return;
    if (!this.canStartSounds) return;

    const categoryGain = this.audioManager.getCategoryGain(category);
    const pref = categoryGain ? categoryGain.gain.value : 1;
    const distance = SoundPlayer.calculateDistance(position, listenerPosition);
    const amp = retailSoundAttenuation(distance, volume, pref);
    if (amp <= 0) return; // below VOL_MIN: retail does not start it
    const pan = this.stereo && listenerPosition.heading !== undefined
      ? retailSoundPan(listenerPosition.x - position.x, listenerPosition.z - position.z, distance, listenerPosition.heading)
      : 0;

    const buffer = await this.decodeWave(waveId);
    if (!buffer) return;

    // The category node applies the preference again; divide it back out so
    // the heard level is exactly GetAttenuation's.
    this.startVoice(ctx, buffer, category, categoryGain ? (pref > 0 ? amp / pref : 0) : amp, pan);
  }

  /**
   * Calculate distance between two points.
   * Public for testing purposes.
   */
  static calculateDistance(
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
  ): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Get number of cached Wave files.
   */
  get waveCacheSize(): number {
    return this.waveCache.size;
  }

  /**
   * Clear all caches.
   */
  clearCache(): void {
    this.waveCache.clear();
    this.bufferCache.clear();
    this.uiWaveCache.clear();
    this.uiBufferCache.clear();
  }
}
