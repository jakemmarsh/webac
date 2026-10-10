import type { AudioManager } from './AudioManager.js';

/**
 * MusicTrack — represents a music track with crossfade support.
 */
export interface MusicTrack {
  id: string;
  buffer: AudioBuffer;
}

/**
 * MusicPlayer — background music playback with crossfade transitions.
 *
 * Manages a single active music track with smooth crossfade
 * when transitioning between tracks.
 */
export class MusicPlayer {
  private audioManager: AudioManager;
  private waveLoader: (waveId: number) => Promise<AudioBuffer | null>;
  private currentTrack: { id: string; source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private fadingTrack: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private crossfadeDuration = 2.0; // seconds
  private _volume = 1.0;
  private playing = false;
  private trackId = '';

  /**
   * @param waveLoader Decodes a portal.dat Wave (0x0Axxxxxx) into an
   * AudioBuffer — pass `soundPlayer.decodeWave` so music shares the exact
   * DAT Wave -> AudioBuffer pipeline SFX uses instead of any side-channel.
   */
  constructor(audioManager: AudioManager, waveLoader: (waveId: number) => Promise<AudioBuffer | null>) {
    this.audioManager = audioManager;
    this.waveLoader = waveLoader;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get currentTrackId(): string {
    return this.trackId;
  }

  get volume(): number {
    return this._volume;
  }

  set volume(v: number) {
    this._volume = Math.max(0, Math.min(1, v));
    if (this.currentTrack) {
      this.currentTrack.gain.gain.value = this._volume;
    }
  }

  /**
   * Set the crossfade duration in seconds.
   */
  setCrossfadeDuration(seconds: number): void {
    this.crossfadeDuration = Math.max(0, seconds);
  }

  get crossfade(): number {
    return this.crossfadeDuration;
  }

  /**
   * Play a music track with optional crossfade from current track.
   */
  play(trackId: string, buffer: AudioBuffer, loop = true): void {
    const ctx = this.audioManager.audioContext;
    if (!ctx) return;

    const musicGain = this.audioManager.getCategoryGain('music');
    const outputNode = musicGain ?? ctx.destination;

    // Fade out current track if playing
    if (this.currentTrack) {
      this.fadeOutCurrent();
    }

    // Create new source
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(outputNode);
    source.connect(gain);

    source.start(0);

    // Fade in
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(this._volume, now + this.crossfadeDuration);

    this.currentTrack = { id: trackId, source, gain };
    this.trackId = trackId;
    this.playing = true;
  }

  /**
   * Play a music track by AC portal.dat Wave ID, decoded via the injected
   * waveLoader (the same Wave -> AudioBuffer pipeline SoundPlayer uses for
   * SFX — there is no separate DAT range or format for music; see GAP.4/
   * GAP.83). Returns true if playback started, false if the wave isn't in
   * the DAT or the AudioContext isn't ready. Idempotent: re-requesting the
   * same trackId during the same session reuses the cached buffer.
   */
  async loadAndPlay(waveId: number, loop = true): Promise<boolean> {
    const ctx = this.audioManager.audioContext;
    if (!ctx) return false;
    const trackId = '0x' + waveId.toString(16);
    if (this.trackId === trackId && this.playing) return true; // already playing
    const cached = this.buffers.get(waveId);
    if (cached) {
      this.play(trackId, cached, loop);
      return true;
    }
    const buffer = await this.waveLoader(waveId);
    if (!buffer) return false;
    this.buffers.set(waveId, buffer);
    this.play(trackId, buffer, loop);
    return true;
  }

  /** Decoded buffer cache so repeat play()s don't refetch. */
  private buffers = new Map<number, AudioBuffer>();

  /**
   * Stop the current track with fade out.
   */
  stop(): void {
    if (this.currentTrack) {
      this.fadeOutCurrent();
      this.currentTrack = null;
    }
    this.playing = false;
    this.trackId = '';
  }

  /**
   * Fade out the current track.
   */
  private fadeOutCurrent(): void {
    if (!this.currentTrack) return;

    const ctx = this.audioManager.audioContext;
    if (!ctx) return;

    const { source, gain } = this.currentTrack;
    const now = ctx.currentTime;

    // Stop old fading track if any
    if (this.fadingTrack) {
      try { this.fadingTrack.source.stop(); } catch {}
      this.fadingTrack = null;
    }

    // Fade out
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + this.crossfadeDuration);

    // Schedule stop after fade
    this.fadingTrack = { source, gain };
    setTimeout(() => {
      try { source.stop(); } catch {}
      if (this.fadingTrack?.source === source) {
        this.fadingTrack = null;
      }
    }, this.crossfadeDuration * 1000 + 100);
  }

  /**
   * Dispose of the music player.
   */
  dispose(): void {
    if (this.currentTrack) {
      try { this.currentTrack.source.stop(); } catch {}
      this.currentTrack = null;
    }
    if (this.fadingTrack) {
      try { this.fadingTrack.source.stop(); } catch {}
      this.fadingTrack = null;
    }
    this.playing = false;
  }
}
