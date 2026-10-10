/**
 * CombatController -- combat-mode state + the melee/missile approach and
 * range helpers main.ts drives. Pure logic: no DOM or Three.js.
 */

import { CombatMode, AttackHeight } from '@ac/shared';
import { serializeGameAction, GameActionType, buildTargetedMissileAttackPayload } from '@ac/network';
import type { AttackHeightName } from './AttackRequest.js';

/**
 * FAITHFUL.464 — should switching to `mode` cancel an in-progress melee
 * swing chain (meleeApproachTarget in main.ts)?
 *
 * `combatController.isInCombat` is true for ALL non-NonCombat modes
 * (Magic/Missile/Melee), so without this the AttackDone chain would still
 * try to fire a chained melee swing after switching to Magic/Missile mid-
 * fight — ACE rejects with WeenieError.YouMustBeInCombatMode, visible to
 * the player as a spurious "you cannot attack" toast.
 */
export function shouldClearMeleeChainOnModeChange(mode: CombatMode): boolean {
  return mode !== CombatMode.Melee;
}

/**
 * FAITHFUL.463 — the auto-attack/melee-chain clear applied by
 * onPlayerTeleport (and the pre-existing death/respawn cleanup blocks it
 * mirrors). PlayerTeleport is sent by ACE for lifestone recall, /house,
 * portal traversal, etc. — every case moves the player well outside normal
 * engagement range of the previous target, so leaving `autoAttack` true
 * with a stale `meleeApproachTarget` would keep an unreachable GUID as the
 * attack chain's target after the teleport completes.
 *
 * Turns off `combatController.autoAttack` in place and returns the reset
 * value for main.ts's `meleeApproachTarget`.
 */
export function clearAutoAttackChain(combatController: CombatController): null {
  combatController.autoAttack = false;
  return null;
}

/**
 * The melee/missile attack-chain reset used by every main.ts site that
 * ends an in-progress chain (death, mode change, target deleted, session
 * end, etc.). BUG.combat-attack-charge-build.b retired the client refill
 * re-send (the server repeats the swing itself), so the chain is only its
 * target: returns the reset value for main.ts's `meleeApproachTarget`.
 */
export function resetMeleeChain(): null {
  return null;
}

/**
 * BUG.melee-approach-speed-hardcoded — the melee auto-approach step, shared
 * by main.ts's per-frame approach loop. True ACE run speed is
 * RunAnimSpeed(4.0) x runRate (ACE.Server/Physics/Animation/MotionInterp.cs;
 * runRate derived from Run skill/burden by MovementSystem.getRunRate, same
 * as CameraController's WASD forward-run branch), not an unsourced flat
 * guess — a flat constant is wrong across the entire Run-skill range and
 * never scales with burden.
 */
export function computeMeleeApproachStep(
  runAnimSpeed: number,
  runRate: number,
  dt: number,
  distanceRemaining: number,
): number {
  return Math.min(runAnimSpeed * runRate * dt, distanceRemaining);
}

/**
 * BUG.melee-approach-range-hardcoded-ignores-radius — ACE's melee range gate
 * (Player_Melee.cs:166-174 HandleActionTargetedMeleeAttack_Inner) is
 * `dist <= MeleeDistance || (dist <= StickyDistance && IsMeleeVisible(target))`,
 * where `dist` is GetCylinderDistance (WorldObject_Use.cs:57-61) — center-to-
 * center distance minus both entities' collision radii, then combined with a
 * height-aware diffZ term (Physics/Common/Position.cs:100-114 CylinderDistance).
 * We don't model line-of-sight for melee client-side, so IsMeleeVisible is
 * treated as always-true (reasonable once a target mesh is tracked at all)
 * and the two thresholds collapse to a single `dist <= MELEE_STICKY_DISTANCE`
 * gate, since MeleeDistance's range is a subset of StickyDistance's.
 */
export const MELEE_DISTANCE = 0.6; // ACE Player_Melee.cs MeleeDistance
export const MELEE_STICKY_DISTANCE = 4.0; // ACE Player_Melee.cs StickyDistance

/**
 * BUG.melee-cylinder-distance-ignores-height — ACE's real CylinderDistance
 * (Physics/Common/Position.cs:100-114, NOT the StickyManager-only
 * CylinderDistanceNoZ at :133-137) is:
 *
 *   offset = otherPos - pos                      (full 3D offset)
 *   reach  = offset.Length() - (radius + otherRadius)
 *   diffZ  = pos.Z <= otherPos.Z
 *              ? otherPos.Z - (pos.Z + height)
 *              : pos.Z - (otherPos.Z + otherHeight)
 *   if diffZ > 0 && reach > 0:  sqrt(diffZ² + reach²)
 *   if diffZ < 0 && reach < 0: -sqrt(diffZ² + reach²)
 *   else:                       reach
 *
 * `dx`/`dy`/`dz` are the target-minus-attacker offset in Three.js axes
 * (dy = AC's Z/height axis, matching getMissileTargetDistance's convention).
 * `attackerHeight`/`targetHeight` are each entity's SetupModel.height * scale
 * (PhysicsObj.GetHeight()) — the collision cylinder's height, not eye height.
 */
export function getMeleeCylinderDistance(
  dx: number,
  dy: number,
  dz: number,
  attackerRadius: number,
  attackerHeight: number,
  targetRadius: number,
  targetHeight: number,
): number {
  const offsetLength = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const reach = offsetLength - (attackerRadius + targetRadius);
  const diffZ = dy >= 0
    ? dy - attackerHeight
    : -dy - targetHeight;
  if (diffZ > 0 && reach > 0) return Math.sqrt(diffZ * diffZ + reach * reach);
  if (diffZ < 0 && reach < 0) return -Math.sqrt(diffZ * diffZ + reach * reach);
  return reach;
}

/**
 * BUG.missile-range-gate-ignores-height — ACE's missile range gate
 * (Player_Missile.cs:346-354 TargetInRange) compares against
 * Position.cs:468-489 DistanceTo, a true 3D Euclidean distance including the
 * vertical offset. A horizontal-only (x,z) distance is always <= the true 3D
 * distance, so omitting height one-directionally lets the client send
 * missile-attacks the server would reject via MissileOutOfRange for
 * elevated/lowered targets (cliffs, towers, multi-level dungeons).
 */
export function getMissileTargetDistance(
  dx: number,
  dy: number,
  dz: number,
): number {
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const ATTACK_HEIGHT_BY_NAME: Record<AttackHeightName, AttackHeight> = {
  high: AttackHeight.High,
  medium: AttackHeight.Medium,
  low: AttackHeight.Low,
};

/**
 * RECON.missile-suppressed-send-stuck — the TargetedMissileAttack (0x000A)
 * game action retail ExecuteAttack @ 0056bb70 sends via
 * CM_Combat::Event_TargetedMissileAttack(target, height, power) whenever
 * the target is attackable and the player is in a ready position. There
 * is no client-side ammo, target-type or range check: the server rejects
 * those and answers each with AttackDone (ACE Player_Missile.cs
 * HandleActionTargetedMissileAttack / LaunchMissile, MissileOutOfRange
 * included), which is what clears attackServerResponsePending.
 */
export function serializeTargetedMissileAttack(
  sequence: number,
  targetGuid: number,
  height: AttackHeightName,
  accuracyLevel: number,
): Uint8Array {
  const payload = buildTargetedMissileAttackPayload(targetGuid, ATTACK_HEIGHT_BY_NAME[height] ?? AttackHeight.Medium, accuracyLevel);
  return serializeGameAction(sequence, GameActionType.TargetedMissileAttack, payload);
}

/* ------------------------------------------------------------------ */
/*  CombatController                                                   */
/* ------------------------------------------------------------------ */

/**
 * The client's mirror of the server's combat mode + auto-attack intent.
 * Combat is server-authoritative (ACE Player_Melee.cs / Player_Missile.cs
 * roll every hit, damage and block), so no local attack simulation lives
 * here — only the state main.ts gates input on.
 */
export class CombatController {
  private _mode: CombatMode = CombatMode.NonCombat;
  private _autoAttack = false;

  get mode(): CombatMode {
    return this._mode;
  }

  setCombatMode(mode: CombatMode): void {
    this._mode = mode;
    if (mode === CombatMode.NonCombat) this._autoAttack = false;
  }

  get isInCombat(): boolean {
    return this._mode !== CombatMode.NonCombat;
  }

  get autoAttack(): boolean {
    return this._autoAttack;
  }

  set autoAttack(val: boolean) {
    this._autoAttack = val;
  }
}
