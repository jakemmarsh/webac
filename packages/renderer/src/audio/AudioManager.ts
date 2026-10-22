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
      // COMPAT.safari-audio-interrupted — Safari moves a running context to its
      // own 'interrupted' state (another app or a call takes the audio device,
      // the page is backgrounded); nothing resumes it on its own. Tell the
      // gesture hook (FirstGestureAudio) so the next click or key resumes it.
      ctx.addEventListener?.('statechange', () => {
        const st = ctx.state as string;
        if ((st === 'interrupted' || st === 'suspended') && !this.selfSuspended) {
          for (const fn of this.stoppedListeners) { try { fn(); } catch { /* a listener never breaks audio */ } }
        }
      });
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

  /** We suspended the context ourselves (suspend()); not an interruption to undo. */
  private selfSuspended = false;
  private readonly stoppedListeners: Array<() => void> = [];

  /** Called whenever the browser stops a running context (Safari 'interrupted', a suspension we didn't ask for). */
  onStopped(fn: () => void): void {
    this.stoppedListeners.push(fn);
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * The context is open AND its clock runs, so a sound started now is heard
   * now. This is the one gate every world / effect sound checks. World entry
   * opens the context (main.ts) whether or not the page has had a user
   * gesture; without one the browser starts it suspended, and a source
   * started then waits on a frozen clock, holds a retail voice slot and
   * plays late in a burst on resume (FirstGestureAudio resumes it).
   * BUG.combat-sounds-need-a-click: server Sound messages and SoundTable
   * hooks used to wait for a document click instead, so a running context
   * that no one had clicked (agent windows, keyboard-only play) played
   * ambient but no swings or hits.
   */
  get isRunning(): boolean {
    return this.initialized && this.context?.state === 'running';
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
    // 'interrupted' is Safari's (COMPAT.safari-audio-interrupted); resume() is what ends it.
    const st = this.context?.state as string | undefined;
    if (st === 'suspended' || st === 'interrupted') {
      this.selfSuspended = false;
      await this.context!.resume();
    }
  }

  /**
   * Suspend audio context (save resources).
   */
  async suspend(): Promise<void> {
    if (this.context?.state === 'running') {
      this.selfSuspended = true;
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
