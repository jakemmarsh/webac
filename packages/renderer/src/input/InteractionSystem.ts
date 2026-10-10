import { CombatMode, ItemType, ObjectDescriptionFlag } from '@ac/shared';

export type InteractionType =
  | 'attack'
  | 'talk'
  | 'buy-sell'
  | 'pick-up'
  | 'use-portal'
  | 'use-lifestone'
  | 'open-container'
  | 'examine'
  | 'trade'
  | 'follow';

export interface InteractionEvent {
  type: InteractionType;
  targetId: number;
  targetType: string;
  timestamp: number;
}

/** The fields ObjectIsAttackable reads from a target's PublicWeenieDesc. */
export interface AttackableTarget {
  itemType: number;
  objectDescFlags: number;
  /** _pet_owner (WeenieHeaderFlag2.PetOwner); absent / 0 = not a pet. */
  petOwner?: number;
}

/**
 * Retail ClientCombatSystem::ObjectIsAttackable @ 0x0056a600
 * (RECON.object-is-attackable-port — every branch):
 *   - the target must be a creature (GetObjectType & 0x10);
 *   - FreePkStatus (0x200000) on the target OR on the player → attackable;
 *   - a non-player target (IsPlayer, bit 0x8, clear): attackable when it has
 *     no pet owner and carries Attackable (0x10) — an owned pet never is;
 *   - a player target: only when both are PK (IsPK, 0x20) or both are PK-lite
 *     (IsPKLite, 0x2000000).
 * `playerFlags` is the local player's own ObjectDescriptionFlag bits. (Retail
 * also returns true for no target and for the player itself; the callers
 * here never pass either.)
 */
export function isObjectAttackable(target: AttackableTarget, playerFlags = 0): boolean {
  if ((target.itemType & ItemType.Creature) === 0) return false;
  const F = ObjectDescriptionFlag;
  if ((target.objectDescFlags & F.FreePkStatus) !== 0) return true;
  if ((playerFlags & F.FreePkStatus) !== 0) return true;
  if ((target.objectDescFlags & F.Player) === 0) {
    if (target.petOwner) return false;
    return (target.objectDescFlags & F.Attackable) !== 0;
  }
  const both = (bit: number): boolean => (target.objectDescFlags & bit) !== 0 && (playerFlags & bit) !== 0;
  return both(F.PlayerKiller) || both(F.PkLiteStatus);
}

/**
 * CORE.18.b.a.a.a.a — ClientCombatSystem::UpdateTargetTracking @ 0056a950:
 * the camera tracks the attack target (CameraSet::TrackTarget(id)) only
 * while the ViewCombatTarget option ("Target In View", CharacterOptions1
 * 0x80 — off in ACE's default set) is on, the combat mode is melee or
 * missile, and GetAttackTarget's selection (a world object, not one the
 * player owns) passes ObjectIsAttackable. Re-evaluated on a selection
 * change, a combat-mode change and the option toggle; anything else is
 * TrackTarget(0). Returns whether to track `target`.
 */
export function tracksCombatTarget(
  viewCombatTarget: boolean,
  combatMode: CombatMode,
  target: (AttackableTarget & { inWorld: boolean }) | null | undefined,
  playerFlags = 0,
): boolean {
  if (!viewCombatTarget) return false;
  if (combatMode !== CombatMode.Melee && combatMode !== CombatMode.Missile) return false;
  if (!target || !target.inWorld) return false;
  return isObjectAttackable(target, playerFlags);
}

/* The world double-click's decision is ItemHolder::UseObject's, in input/UseObject.ts (SWEEP1006 world use). */

const DEFAULT_INTERACTIONS: Record<string, InteractionType> = {
  creature: 'attack',
  npc: 'talk',
  vendor: 'buy-sell',
  item: 'pick-up',
  portal: 'use-portal',
  lifestone: 'use-lifestone',
  container: 'open-container',
  player: 'examine',
};

export class InteractionSystem {
  private _pendingInteractions: InteractionEvent[] = [];
  private _lastInteraction: InteractionEvent | null = null;
  private _interactionRange = 5.0;

  /**
   * Determine the default interaction for a double-click based on entity type.
   * Falls back to 'examine' for unknown entity types.
   */
  getDefaultInteraction(entityType: string): InteractionType {
    return DEFAULT_INTERACTIONS[entityType] ?? 'examine';
  }

  /**
   * Queue an interaction to be processed on the next game tick.
   */
  queueInteraction(type: InteractionType, targetId: number, targetType: string): void {
    const event: InteractionEvent = {
      type,
      targetId,
      targetType,
      timestamp: Date.now(),
    };
    this._pendingInteractions.push(event);
    this._lastInteraction = event;
  }

  /**
   * Drain and return all pending interactions, clearing the queue.
   */
  consumeInteractions(): InteractionEvent[] {
    const interactions = this._pendingInteractions;
    this._pendingInteractions = [];
    return interactions;
  }

  get hasPendingInteractions(): boolean {
    return this._pendingInteractions.length > 0;
  }

  get lastInteraction(): InteractionEvent | null {
    return this._lastInteraction;
  }

  /**
   * Check whether the player is within interaction range of the target.
   */
  isInRange(
    playerPos: { x: number; y: number; z: number },
    targetPos: { x: number; y: number; z: number },
  ): boolean {
    const dx = playerPos.x - targetPos.x;
    const dy = playerPos.y - targetPos.y;
    const dz = playerPos.z - targetPos.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    return distSq <= this._interactionRange * this._interactionRange;
  }

  get interactionRange(): number {
    return this._interactionRange;
  }

  set interactionRange(range: number) {
    this._interactionRange = range;
  }
}
