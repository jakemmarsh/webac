/**
 * SWEEP1006B.player-input.entering-melee-missile-mode-never — the parts of
 * ClientCombatSystem::SetCombatMode @ 0056be30 that decide WHEN a requested
 * mode change applies and WHAT the attack target is. Pure logic; main.ts
 * supplies the player's motion state and the object lookups.
 *
 *   - SetCombatMode (requested): after the weapon and portal-space checks,
 *     `if (!PlayerInReadyPosition(this,false)) { pendingCombatMode = mode;
 *     return; }`; UseTime @ 0056c1f0 applies the pending mode
 *     (SetCombatMode(pending, true)) once the player is ready.
 *   - PlayerInReadyPosition @ 0056b820 (param_1 = false), by the CURRENT mode:
 *     peace / magic → !motions_pending; melee → no CombatTable (PlayerDesc
 *     DID 4) means false, else !motions_pending; missile → the style must
 *     be a missile style and forward_command Ready (0x41000003), then
 *     !motions_pending; anything else → false.
 *   - GetAttackTarget @ 0056a8f0: 0 for no selection, an unknown object or
 *     one IsOwnedByPlayer @ 0058d160 (the player itself, its packs, worn
 *     and contained items); a child part's physics parent otherwise.
 */
import { CombatMode } from '@ac/shared';
import { modeOfStance } from '../agent/macro/modeGate.js';

/** Which era's CompatibleCombatMode applies (era/EraFeatures.ts EraClientRules.combatModeCheck). */
export type CombatModeCheck = 'eor' | 'ac1999';

/** MotionCommand.Ready, the forward_command PlayerInReadyPosition wants in missile mode. */
export const READY_FORWARD_COMMAND = 0x41000003;

/**
 * PlayerInReadyPosition's missile styles. The 2013 exe lists 0x8000003f
 * (Bow), 0x41 (Crossbow), 0x43 (Sling), 0x47 (ThrownWeapon) and its own
 * numbering 0x138 / 0x139 for Atlatl and ThrownShield; the 2017 DATs (and
 * ACE's MotionStance, "138 in PY16") number those 0x13b / 0x13c, and the
 * DAT wins.
 */
export const MISSILE_READY_STYLES: ReadonlySet<number> = new Set([
  0x8000003f, 0x80000041, 0x80000043, 0x80000047, 0x8000013b, 0x8000013c,
]);

export interface ReadyPositionState {
  /** The CURRENT combat mode (the one being left). */
  mode: CombatMode;
  /** CPhysicsObj::motions_pending: an action or style change still playing. */
  motionsPending: boolean;
  /** InterpretedMotionState::current_style. */
  style: number;
  /** InterpretedMotionState::forward_command. */
  forwardCommand: number;
  /** PlayerDesc InqDataID(4): the player has a CombatTable. */
  hasCombatTable: boolean;
}

/** PlayerInReadyPosition @ 0056b820 with param_1 = false. */
export function playerInReadyPosition(s: ReadyPositionState): boolean {
  switch (s.mode) {
    case CombatMode.NonCombat:
    case CombatMode.Magic:
      return !s.motionsPending;
    case CombatMode.Melee:
      return s.hasCombatTable && !s.motionsPending;
    case CombatMode.Missile:
      return MISSILE_READY_STYLES.has(s.style >>> 0)
        && s.forwardCommand >>> 0 === READY_FORWARD_COMMAND
        && !s.motionsPending;
    default:
      return false;
  }
}

/** ClientCombatSystem::pendingCombatMode (UNDEF_COMBAT_MODE = 0 when none). */
export class PendingCombatMode {
  pending: CombatMode = CombatMode.Undef;

  /**
   * SetCombatMode's ready-position step for a requested change: true when
   * the change applies now; false when it was parked until UseTime finds
   * the player ready.
   */
  request(mode: CombatMode, ready: boolean): boolean {
    if (ready) return true;
    this.pending = mode;
    return false;
  }

  /** UseTime @ 0056c1f0: the parked mode to apply now, or Undef. */
  poll(ready: boolean): CombatMode {
    if (this.pending === CombatMode.Undef || !ready) return CombatMode.Undef;
    const mode = this.pending;
    this.pending = CombatMode.Undef;
    return mode;
  }

  clear(): void {
    this.pending = CombatMode.Undef;
  }
}

export interface AttackTargetLookup {
  /** SmartBox::smartbox->player_id. */
  playerId: number;
  /** ClientObjMaintSystem::GetWeenieObject(guid) != null. */
  exists(guid: number): boolean;
  /** IsOwnedByPlayer: in the player's packs, worn, or contained by them. */
  ownedByPlayer(guid: number): boolean;
  /** The CPhysicsObj parent's id (a held item's holder), 0 for none. */
  parentOf(guid: number): number;
}

/** GetAttackTarget @ 0056a8f0 for `selected`. */
export function getAttackTarget(selected: number, l: AttackTargetLookup): number {
  if (selected === 0) return 0;
  if (selected === l.playerId) return 0; // IsOwnedByObject: this->id == player_id
  if (!l.exists(selected) || l.ownedByPlayer(selected)) return 0;
  const target = l.parentOf(selected) || selected;
  if (target !== 0 && target !== l.playerId && !l.exists(target)) return 0;
  return target;
}

/**
 * ClientCombatSystem::CompatibleCombatMode @ 0056a580 (decomp :352853-352881)
 * on CPlayerSystem::inventoryMask (the worn EquipMask bits): missile needs
 * MissileWeapon (0x400000), magic needs Held (0x1000000); melee is refused
 * only when neither MeleeWeapon (0x100000) nor TwoHanded (0x2000000) is worn
 * while something in 0x3500000 (a missile weapon or a caster) is. Peace and
 * every other mode are always compatible.
 *
 * 1999 (client.exe linked 1999-10-09, dat-sets/ac1999-retail): UI::SetCombatMode
 * @ 0x4d04c0 itself refuses only melee / missile while a Held item is wielded,
 * but it is only ever asked for the mode PanelUI::GetDefaultCombatMode
 * @ 0x4f9130 picks (the toggle @ 0x4f6b36 / 0x502077; the other callers are the
 * pending retry and the server's CombatMode int). That chooser gives missile
 * only with a missile weapon worn (0x500000 slot, CombatUse 2) and magic only
 * with a Caster (ItemType 0x8000) in the Held slot; bare-handed it gives melee,
 * and UI_CastSpell @ 0x4d1bd0 never changes the mode. So no 1999 path asks for
 * magic without a caster or missile without a missile weapon, and the AC1999
 * server refuses both (Player.cpp CPlayerWeenie::ChangeCombatMode,
 * "no-held-item" / "no-missile-weapon").
 */
export function compatibleCombatMode(mode: CombatMode, inventoryMask: number, check: CombatModeCheck = 'eor'): boolean {
  const m = inventoryMask >>> 0;
  if (check === 'ac1999') {
    if ((mode === CombatMode.Melee || mode === CombatMode.Missile) && (m & 0x1000000) !== 0) return false;
    if (mode === CombatMode.Missile) return (m & 0x400000) !== 0;
    if (mode === CombatMode.Magic) return (m & 0x1000000) !== 0;
    return true;
  }
  if (mode === CombatMode.Missile) return (m & 0x400000) !== 0;
  if (mode === CombatMode.Magic) return (m & 0x1000000) !== 0;
  if (mode === CombatMode.Melee) return (m & 0x100000) !== 0 || (m & 0x2000000) !== 0 || (m & 0x3500000) === 0;
  return true;
}

/** CombatEnumMapper::CombatModeToString @ 005c9b80. */
export function combatModeName(mode: CombatMode): string {
  switch (mode) {
    case CombatMode.NonCombat: return 'peace';
    case CombatMode.Melee: return 'melee';
    case CombatMode.Missile: return 'missile';
    case CombatMode.Magic: return 'magic';
    default: return 'unknown';
  }
}

/**
 * SetCombatMode @ 0056be30's first user-path check (:354322-354340): an
 * incompatible mode is refused. With a ready weapon (weaponReadySlot's
 * object) the 0x1a line is "You can't enter %hs mode while wielding the %s";
 * with none the refusal is silent. Null when the mode is compatible.
 */
export function incompatibleCombatModeRefusal(
  mode: CombatMode, inventoryMask: number, readyWeaponName: string | null, check: CombatModeCheck = 'eor',
): { text: string | null } | null {
  if (compatibleCombatMode(mode, inventoryMask, check)) return null;
  if (readyWeaponName === null) return { text: null };
  if (check === 'ac1999') {
    // The 1999 line names no mode, and only UI::SetCombatMode's Held check
    // prints it ("You can't enter combat mode while wielding the <item>");
    // the client never asks for the other refused modes, so it has no line.
    if ((inventoryMask & 0x1000000) === 0 || mode === CombatMode.Magic) return { text: null };
    return { text: `You can't enter combat mode while wielding the ${readyWeaponName}` };
  }
  return { text: `You can't enter ${combatModeName(mode)} mode while wielding the ${readyWeaponName}` };
}

/**
 * Why a requested combat-mode change would be refused, in words for the
 * automation (the client itself is silent when no weapon is ready). Null when
 * CompatibleCombatMode lets it in. End of retail: magic needs a wand, staff or
 * orb in the Held slot; a player who asks without one gets nothing from the
 * client, and ACE (Player_Combat.cs HandleActionChangeCombatMode_Inner,
 * caster == null) answers a forced request with NonCombat.
 */
export function combatModeRefusalReason(
  mode: CombatMode, inventoryMask: number, readyWeaponName: string | null, check: CombatModeCheck = 'eor',
): string | null {
  const r = incompatibleCombatModeRefusal(mode, inventoryMask, readyWeaponName, check);
  if (!r) return null;
  if (r.text) return r.text;
  if (mode === CombatMode.Magic) return "magic mode needs a wielded wand, staff or orb, and none is wielded (the client won't enter spellcasting mode without one): wield one first";
  if (mode === CombatMode.Missile) return 'missile mode needs a wielded bow, crossbow, atlatl or thrown weapon, and none is wielded';
  return `you can't enter ${combatModeName(mode)} mode with what you wield`;
}

/** The worn slots whose object is the ready weapon: TwoHanded, MeleeWeapon, MissileWeapon, Held. */
export const READY_WEAPON_SLOTS = 0x2000000 | 0x100000 | 0x400000 | 0x1000000;

/** WeenieError.ActionCancelled (WERROR_INTERRUPTED, "Action cancelled!"): GDLE's and the AC1999 server's answer to a refused mode. */
export const MODE_REFUSED_ERROR = 0x0036;
/** How long a sent mode change waits for the server's word before a later ActionCancelled is no longer read as its refusal. */
export const MODE_REFUSAL_WINDOW_MS = 3000;

/**
 * BUG.ac1999-magic-mode-refused — a requested combat mode the server has not
 * taken yet. The client commits a mode when it sends it (SetCombatMode
 * @ 0056be30; the 1999 UI::SetCombatMode @ 0x4d04c0 writes UI+0x5a4 before
 * sending), and the server's word follows:
 *
 *   - ACE answers every request with the CombatMode int, NonCombat for a
 *     refusal (Player_Combat.cs HandleActionChangeCombatMode_Inner), which the
 *     client already follows (OnQualityChanged → SetCombatMode(mode, false)).
 *   - GDLE (the classic servers) and the AC1999 server take a change with a
 *     movement in the new stance (Monster.cpp ChangeCombatMode → DoMotion) and
 *     refuse one with only an ActionCancelled (Player.cpp
 *     CPlayerWeenie::ChangeCombatMode → NotifyWeenieError(WERROR_INTERRUPTED)):
 *     no stance, no CombatMode int. The client was left showing the refused
 *     mode (a magic stance and spell bar over a peace body, every cast failing
 *     with MagicGeneralFailure, 2026-10-16).
 *
 * So an ActionCancelled that arrives while a change is still unconfirmed puts
 * the client back in the mode the server kept. The server's stance in the
 * requested mode, or any CombatMode int, confirms it; a change nobody answers
 * (the server already in that stance) stops waiting after the window.
 */
export class UnconfirmedCombatMode {
  private pending: { from: CombatMode; fromStance: number; to: CombatMode; at: number } | null = null;

  constructor(private readonly windowMs = MODE_REFUSAL_WINDOW_MS) {}

  /** A change from `from` (the body in `fromStance`) to `to` was sent. A change sent while one waits keeps the first `from`: the server never took it. */
  sent(from: CombatMode, fromStance: number, to: CombatMode, now: number): void {
    if (this.pending && now - this.pending.at <= this.windowMs) this.pending = { ...this.pending, to, at: now };
    else this.pending = { from, fromStance, to, at: now };
  }

  /** The server's movement put the player in a stance meaning `mode` (null: not a stance): the change is taken when it is the requested one. */
  stance(mode: CombatMode | null): void {
    if (this.pending && mode === this.pending.to) this.pending = null;
  }

  /** The server's CombatMode int arrived: the server has said the mode itself. */
  serverMode(): void {
    this.pending = null;
  }

  /** The mode the client waits on, or null. */
  get waiting(): CombatMode | null {
    return this.pending?.to ?? null;
  }

  /**
   * A WeenieError arrived. When it is the refusal and a change is unconfirmed,
   * the mode (and body stance) the server kept, to put back; else null.
   */
  refused(errorType: number, now: number): { mode: CombatMode; stance: number } | null {
    const p = this.pending;
    if (!p || errorType >>> 0 !== MODE_REFUSED_ERROR) return null;
    this.pending = null;
    if (now - p.at > this.windowMs) return null;
    return { mode: p.from, stance: p.fromStance };
  }

  clear(): void {
    this.pending = null;
  }
}

/** What following a refused mode touches: the client's mode (controller, HUD, cursor) and the body's stance. */
export interface CombatModeFollower {
  setMode(mode: CombatMode): void;
  stance(): number;
  setStance(stance: number): void;
}

/**
 * onWeenieError's step for a refused mode: when `errorType` refuses the change
 * `tracker` waits on, the client goes back to the mode and stance the server
 * kept. True when it did.
 */
export function followModeRefusal(tracker: UnconfirmedCombatMode, errorType: number, now: number, client: CombatModeFollower): boolean {
  const kept = tracker.refused(errorType, now);
  if (!kept) return false;
  client.setMode(kept.mode);
  if (kept.stance && client.stance() !== kept.stance) client.setStance(kept.stance);
  return true;
}

/**
 * The cast's auto-switch into magic mode (main.ts sendCastSpellAction) sends
 * the cast only once the server has taken the mode: not while the change is
 * unconfirmed (up to MODE_REFUSAL_WINDOW_MS), and never once the client is
 * back out of magic (refused). A cast sent into a refused mode fails
 * (MagicGeneralFailure on the AC1999 server, 2026-10-16).
 */
export function castOnceMagicTaken(deps: {
  mode(): CombatMode;
  waiting(): CombatMode | null;
  schedule(fn: () => void, ms: number): void;
  cast(): void;
  suppressed(): void;
}, waitedMs = 0): void {
  if (deps.mode() !== CombatMode.Magic) { deps.suppressed(); return; }
  if (deps.waiting() === CombatMode.Magic && waitedMs < MODE_REFUSAL_WINDOW_MS) {
    deps.schedule(() => castOnceMagicTaken(deps, waitedMs + 100), 100);
    return;
  }
  deps.cast();
}

/** The combat mode a player stance (MotionStance id) means, or null for a non-stance (agent/macro/modeGate.ts modeOfStance). */
export function combatModeOfStance(stance: number): CombatMode | null {
  const name = modeOfStance(stance);
  return name === null ? null : { peace: CombatMode.NonCombat, melee: CombatMode.Melee, missile: CombatMode.Missile, magic: CombatMode.Magic }[name];
}
