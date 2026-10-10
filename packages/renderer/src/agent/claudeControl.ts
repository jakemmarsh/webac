/**
 * AGENT.hosted-mcp-connector step 4 — the player and Claude in one tab
 * (docs/hosted-agent-connector.md §5). The player always wins:
 *
 * - **The player takes over** by acting themselves (a key outside chat, a
 *   click in the game) while Claude is active. Claude's movement stops, a
 *   routine Claude started pauses, and Claude's acting calls are refused
 *   until the player has been idle 60 s or types `/automation resume`.
 *   Reading calls (observe, status, inventory …) still answer, so Claude
 *   can see what changed.
 * - **Pause** (`/automation pause`) refuses every call but `status` until resume.
 * - **History:** the last 100 calls (time, method, ok, ms) for
 *   `/automation claude`, no arguments kept.
 */
export type Control = 'claude' | 'player';

/** Agent-surface methods that only read: answered even while the player has control. */
export const READ_METHODS = new Set([
  'version', 'observe', 'self', 'events', 'waitFor', 'inventory', 'spells', 'characterSheet', 'allegiance', 'map', 'probe', 'where',
  'itemPalettes', 'keys', 'vendor', 'trace', 'status', 'goal', 'routineStats', 'routineStatus', 'routineDryRun', 'routinesLoad',
]);

export const PLAYER_IDLE_RESUME_MS = 60_000;
/** Claude counts as active (so player input takes over) this long after its last acting call. */
export const CLAUDE_ACTIVE_MS = 30_000;
const HISTORY = 100;

export interface ControlHooks {
  /** Stop Claude's movement (the agent API's stopMoving). */
  stopMoving(): void;
  /** Pause the routine Claude started, if it is running. */
  pauseRoutine(): void;
  /** Tell the player (a chat line). */
  say(text: string): void;
}

export interface HistoryEntry { at: number; method: string; ok: boolean; ms: number }

export class ClaudeControl {
  control: Control = 'claude';
  paused = false;
  private lastActAt = -Infinity;
  private lastPlayerAt = -Infinity;
  private announced = false;
  /** Claude started a routine through the relay (so a take-over pauses it). */
  claudeRoutine = false;
  readonly history: HistoryEntry[] = [];

  constructor(private readonly hooks: ControlHooks, private readonly now: () => number = () => Date.now()) {}

  /** Before a relay call runs: why it is refused, or null. */
  gate(method: string): string | null {
    // Paused: everything is refused but ac_status, so Claude can say why it stopped.
    if (this.paused && method !== 'status') return 'paused by the player (they type /automation resume to hand back)';
    const read = READ_METHODS.has(method);
    if (this.control === 'player' && !read) {
      const idle = this.now() - this.lastPlayerAt;
      if (idle < PLAYER_IDLE_RESUME_MS) return `the player has taken control (${Math.round(idle / 1000)} s ago); wait until they have been idle ${PLAYER_IDLE_RESUME_MS / 1000} s, then try again`;
      this.control = 'claude';
    }
    if (!read) {
      this.lastActAt = this.now();
      if (method === 'routineStart') this.claudeRoutine = true;
      if (method === 'routineStop') this.claudeRoutine = false;
      if (!this.announced) { this.announced = true; this.hooks.say('Claude is playing this character. Act yourself to take over; /automation pause stops it.'); }
    }
    return null;
  }

  /** After a relay call answered. */
  done(method: string, ok: boolean, ms: number): void {
    this.history.push({ at: this.now(), method, ok, ms });
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
  }

  /** The player acted (trusted input outside chat). Takes control when Claude is active. */
  playerInput(): void {
    const t = this.now();
    this.lastPlayerAt = t;
    if (this.control === 'player' || this.paused || t - this.lastActAt > CLAUDE_ACTIVE_MS) return;
    this.control = 'player';
    this.hooks.stopMoving();
    if (this.claudeRoutine) this.hooks.pauseRoutine();
    this.hooks.say(`You took control; Claude stopped. It carries on after you've been idle ${PLAYER_IDLE_RESUME_MS / 1000} s, or type /automation resume.`);
  }

  pause(): string {
    if (this.paused) return 'Claude is already paused. /automation resume hands back.';
    this.paused = true;
    this.hooks.stopMoving();
    if (this.claudeRoutine) this.hooks.pauseRoutine();
    return 'Claude is paused: its calls are refused. /automation resume hands back.';
  }

  resume(): string {
    const was = this.paused || this.control === 'player';
    this.paused = false;
    this.control = 'claude';
    return was ? 'Claude can play again.' : 'Claude already has control.';
  }

  /** The state line for /automation claude. */
  summary(goal: string | null): string {
    const last = this.history[this.history.length - 1];
    const parts = [this.paused ? 'paused' : this.control === 'player' ? 'you have control' : 'Claude has control'];
    if (last) parts.push(`last call ${last.method} ${Math.max(0, Math.round((this.now() - last.at) / 1000))} s ago`);
    if (goal) parts.push(`goal: ${goal}`);
    return parts.join(' · ');
  }

  /** The last n calls, newest last, for the player. */
  recent(n = 10): string[] {
    return this.history.slice(-n).map((h) => `${new Date(h.at).toTimeString().slice(0, 8)} ${h.method} ${h.ok ? 'ok' : 'refused/failed'} ${h.ms} ms`);
  }
}
