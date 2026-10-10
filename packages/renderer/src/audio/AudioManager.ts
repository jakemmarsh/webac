/**
 * AudioManager — manages Web Audio API context and sound playback.
 *
 * Provides category-based volume control (ambient, effects, music, UI),
 * positional/3D sound support, and WAV buffer decoding.
 */
export interface AudioCategory {
  name: string;
  volume: number;
  muted: boolean;
}

export class AudioManager {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private categoryGains = new Map<string, GainNode>();
  private categories = new Map<string, AudioCategory>();
  private initialized = false;

  /** Default audio categories. */
  static readonly CATEGORY_AMBIENT = 'ambient';
  static readonly CATEGORY_EFFECTS = 'effects';
  static readonly CATEGORY_MUSIC = 'music';
  static readonly CATEGORY_UI = 'ui';

  constructor() {
    // Initialize default categories
    for (const name of [
      AudioManager.CATEGORY_AMBIENT,
      AudioManager.CATEGORY_EFFECTS,
      AudioManager.CATEGORY_MUSIC,
      AudioManager.CATEGORY_UI,
    ]) {
      this.categories.set(name, { name, volume: 1.0, muted: false });
    }
  }

  /**
   * Initialize the audio context. Must be called after user interaction
   * (browser autoplay policy requires user gesture).
   */
  init(): boolean {
    if (this.initialized) return true;

    try {
      const AudioCtx = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
      if (!AudioCtx) return false;

      const ctx: AudioContext = new AudioCtx();
      this.context = ctx;
      const master = ctx.createGain();
      this.masterGain = master;
      master.connect(ctx.destination);

      // Create gain nodes for each category
      for (const [name, cat] of this.categories) {
        const gain = ctx.createGain();
        gain.gain.value = cat.muted ? 0 : cat.volume;
        gain.connect(master);
        this.categoryGains.set(name, gain);
      }

      this.initialized = true;
      return true;
    } catch {
      return false;
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get audioContext(): AudioContext | null {
    return this.context;
  }

  /**
   * Set volume for a category (0.0 to 1.0).
   */
  setCategoryVolume(category: string, volume: number): void {
    const cat = this.categories.get(category);
    if (cat) {
      cat.volume = Math.max(0, Math.min(1, volume));
      const gain = this.categoryGains.get(category);
      if (gain) {
        gain.gain.value = cat.muted ? 0 : cat.volume;
      }
    }
  }

  /**
   * Get volume for a category.
   */
  getCategoryVolume(category: string): number {
    return this.categories.get(category)?.volume ?? 0;
  }

  /**
   * Mute/unmute a category.
   */
  setCategoryMuted(category: string, muted: boolean): void {
    const cat = this.categories.get(category);
    if (cat) {
      cat.muted = muted;
      const gain = this.categoryGains.get(category);
      if (gain) {
        gain.gain.value = muted ? 0 : cat.volume;
      }
    }
  }

  /**
   * Check if a category is muted.
   */
  isCategoryMuted(category: string): boolean {
    return this.categories.get(category)?.muted ?? false;
  }

  /**
   * Get the gain node for a category (for connecting audio sources).
   */
  getCategoryGain(category: string): GainNode | null {
    return this.categoryGains.get(category) ?? null;
  }

  /**
   * Set master volume (0.0 to 1.0).
   */
  setMasterVolume(volume: number): void {
    if (this.masterGain) {
      this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  /**
   * Get the master volume.
   */
  getMasterVolume(): number {
    return this.masterGain?.gain.value ?? 1.0;
  }

  /**
   * Decode WAV buffer data into an AudioBuffer.
   */
  async decodeWavData(wavBuffer: ArrayBuffer): Promise<AudioBuffer | null> {
    if (!this.context) return null;
    try {
      return await this.context.decodeAudioData(wavBuffer.slice(0));
    } catch {
      return null;
    }
  }

  /**
   * Get list of category names.
   */
  getCategoryNames(): string[] {
    return Array.from(this.categories.keys());
  }

  /**
   * Resume audio context (needed after user interaction).
   */
  async resume(): Promise<void> {
    if (this.context?.state === 'suspended') {
      await this.context.resume();
    }
  }

  /**
   * Suspend audio context (save resources).
   */
  async suspend(): Promise<void> {
    if (this.context?.state === 'running') {
      await this.context.suspend();
    }
  }

  /**
   * Dispose of the audio manager.
   */
  dispose(): void {
    if (this.context) {
      this.context.close().catch(() => {});
      this.context = null;
    }
    this.masterGain = null;
    this.categoryGains.clear();
    this.initialized = false;
  }
}
