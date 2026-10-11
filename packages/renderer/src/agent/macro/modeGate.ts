/**
 * VirindiTank's combat-mode gate (docs/vtank-macro-behavior.md "The combat-mode
 * gate"; facts from MOSS CombatModeGate, read for facts only):
 *
 * - A mode change is the client's word until the server takes it. A spell sent
 *   in between is cast in the old mode and fizzles when the change lands, so
 *   the macro does nothing in the new mode until the server has put the body in
 *   it. The server's word is the stance of its next movement for the player
 *   (every server sends one on a change: ACE Player.SetCombatMode, GDLE and
 *   AC1999 Monster.cpp ChangeCombatMode's DoMotion) or its CombatMode property
 *   (ACE after every change; GDLE / AC1999 only when it refuses one). A host
 *   that can't say waits out VTank's 0.6 s confirmation window instead.
 * - A drop to peace that doesn't take (the client still in a combat mode at
 *   the next try) is counted; at DropToPeaceModeRetryCount (34) tries the
 *   combat state is bugged, and wielding an item clears it: the first caster
 *   on the Items tab ("Warning: Macro detected bugged combat state. Attempting
 *   to wield an item to clear it.").
 */
import type { CombatModeName } from '../AgentApi.ts';

/** VTank's confirmation window for a host that doesn't pass the server's stance on. */
export const MODE_CONFIRM_MS = 600;
/** How long a change waits for the server's stance before the macro goes on anyway. */
export const MODE_CONFIRM_MAX_MS = 3000;

export const BUGGED_COMBAT_STATE = 'Warning: Macro detected bugged combat state. Attempting to wield an item to clear it.';

/**
 * The combat mode a player stance means (MotionStance ids, MotionCommands.ts): NonCombat is peace,
 * Magic magic, the bow / crossbow / sling / atlatl / thrown stances (with or without ammunition)
 * missile, every other combat stance melee; anything else (not a stance) null.
 */
export function modeOfStance(stance: number): CombatModeName | null {
  const s = stance >>> 0;
  if (s === 0x8000003d) return 'peace';
  if (s === 0x80000049) return 'magic';
  if ([0x8000003f, 0x80000041, 0x80000043, 0x80000047, 0x800000e8, 0x800000e9, 0x8000013b, 0x8000013c].includes(s)) return 'missile';
  if ([0x8000003c, 0x8000003e, 0x80000040, 0x80000042, 0x80000044, 0x80000045, 0x80000046].includes(s)) return 'melee';
  return null;
}

export class ModeGate {
  private pending: { mode: CombatModeName; at: number } | null = null;
  private peaceTries = 0;

  constructor(private readonly now: () => number) {}

  /** The macro asks for `mode` (from `current`). True when this is a drop to peace that has now failed DropToPeaceModeRetryCount times. */
  request(mode: CombatModeName, current: string, retryCount: number): boolean {
    this.pending = { mode, at: this.now() };
    if (current === 'peace') this.peaceTries = 0;
    if (mode !== 'peace' || current === 'peace') return false;
    this.peaceTries++;
    if (this.peaceTries < Math.max(1, retryCount)) return false;
    this.peaceTries = 0;
    return true;
  }

  /**
   * Whether the last change is still only the client's word. `client` is the mode the client shows,
   * `server` the one the server's stance says (undefined: the host can't say).
   */
  unconfirmed(client: string, server: string | undefined): CombatModeName | null {
    const p = this.pending;
    if (client === 'peace') this.peaceTries = 0;
    if (!p) return null;
    const age = this.now() - p.at;
    // The client gave up on it (refused, or changed since): nothing to wait for.
    const settled = client !== p.mode
      || (server !== undefined ? server === p.mode : age >= MODE_CONFIRM_MS)
      || age >= MODE_CONFIRM_MAX_MS;
    if (settled) { this.pending = null; return null; }
    return p.mode;
  }

  reset(): void { this.pending = null; this.peaceTries = 0; }
}
