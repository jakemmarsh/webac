/**
 * GameLoop — central game logic tick, separate from the render loop.
 * Runs at a fixed rate (default 10Hz) for game mechanics:
 * - Enchantment ticking
 * - AI updates
 * - Combat cooldowns
 * - Spawn timers
 */
import type { PlayerState } from './player/PlayerState.js';

export type GameTickCallback = (dt: number, elapsed: number) => void;

export class GameLoop {
  private tickRate: number;
  private tickInterval: number; // seconds between ticks
  private accumulator = 0;
  private elapsed = 0;
  private callbacks: GameTickCallback[] = [];
  private playerState: PlayerState | null = null;
  private running = false;
  constructor(tickRate = 10) {
    this.tickRate = tickRate;
    this.tickInterval = 1.0 / tickRate;
  }

  /** Set the player state to update each tick */
  setPlayerState(state: PlayerState): void {
    this.playerState = state;
  }

  /** Register a callback to run each game tick */
  onTick(callback: GameTickCallback): void {
    this.callbacks.push(callback);
  }

  /** Remove a tick callback */
  offTick(callback: GameTickCallback): void {
    const idx = this.callbacks.indexOf(callback);
    if (idx >= 0) this.callbacks.splice(idx, 1);
  }

  /** Start the game loop */
  start(): void {
    this.running = true;
  }

  /** Stop the game loop */
  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get totalElapsed(): number {
    return this.elapsed;
  }

  get ticksPerSecond(): number {
    return this.tickRate;
  }

  /**
   * Feed delta time from the render loop.
   * Accumulates time and fires game ticks at the fixed rate.
   */
  update(dt: number): void {
    if (!this.running) return;

    this.accumulator += dt;

    // Process ticks at fixed rate
    while (this.accumulator >= this.tickInterval) {
      this.accumulator -= this.tickInterval;
      this.elapsed += this.tickInterval;

      this.gameTick(this.tickInterval);
    }
  }

  /** Process a single game tick */
  private gameTick(dt: number): void {
    // Vitals are NOT regenerated here. Retail never predicts regen: a
    // vital's current value changes only through the server's stat update
    // (ClientObjMaintSystem::UpdateStat<Attribute_2nd> @ 00557d80/00557e00 →
    // CACQualities::SetAttribute2nd → gmVitalsUI::OnQualityChanged) or the
    // PlayerDescription load; gmVitalsUI::Update @ 004bfe30 runs on no timer.
    // ACE regenerates on its own VitalHeartBeat and pushes each change
    // (SWEEP1006B.hud-status.client-predicts-vital-regeneration-5).
    if (this.playerState && !this.playerState.isDead) {
      // Tick enchantments
      const ticks = this.playerState.enchantments.tick(dt);
      // Ticks could contain periodic healing/damage effects
      for (const tick of ticks) {
        if (tick.expired) {
          // Enchantment expired — could notify UI
        }
      }
    }

    // Fire registered callbacks
    for (const cb of this.callbacks) {
      cb(dt, this.elapsed);
    }
  }
}
