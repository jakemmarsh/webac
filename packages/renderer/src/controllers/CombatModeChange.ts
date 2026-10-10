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
 */
export function compatibleCombatMode(mode: CombatMode, inventoryMask: number): boolean {
  const m = inventoryMask >>> 0;
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
  mode: CombatMode, inventoryMask: number, readyWeaponName: string | null,
): { text: string | null } | null {
  if (compatibleCombatMode(mode, inventoryMask)) return null;
  return { text: readyWeaponName === null ? null : `You can't enter ${combatModeName(mode)} mode while wielding the ${readyWeaponName}` };
}

/** The worn slots whose object is the ready weapon: TwoHanded, MeleeWeapon, MissileWeapon, Held. */
export const READY_WEAPON_SLOTS = 0x2000000 | 0x100000 | 0x400000 | 0x1000000;
