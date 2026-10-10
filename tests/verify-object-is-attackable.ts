/**
 * RECON.object-is-attackable-port — ClientCombatSystem::ObjectIsAttackable
 * @ 0056a600, every branch: creature gate, FreePK on either side, the
 * non-player Attackable bit unless a pet owner is set, and the player-vs-
 * player PK / PK-lite pairing (ACCWeenieObject::IsPlayer bit 0x8, IsPK 0x20,
 * IsPKLite 0x2000000).
 */
import { describe, it, expect } from 'vitest';
import { ItemType, ObjectDescriptionFlag as F, CombatMode } from '@ac/shared';
import { isObjectAttackable, tracksCombatTarget } from '../packages/renderer/src/input/InteractionSystem.js';

const C = ItemType.Creature;

describe('ObjectIsAttackable (RECON.object-is-attackable-port)', () => {
  it('only creatures', () => {
    expect(isObjectAttackable({ itemType: 0x1, objectDescFlags: F.Attackable })).toBe(false);
  });

  it('monsters: the Attackable bit; vendors / NPCs without it are not', () => {
    expect(isObjectAttackable({ itemType: C, objectDescFlags: F.Attackable })).toBe(true);
    expect(isObjectAttackable({ itemType: C, objectDescFlags: F.Vendor | F.Stuck })).toBe(false);
  });

  it('an owned pet is never attackable, even with the Attackable bit', () => {
    expect(isObjectAttackable({ itemType: C, objectDescFlags: F.Attackable, petOwner: 0x50000001 })).toBe(false);
    expect(isObjectAttackable({ itemType: C, objectDescFlags: F.Attackable, petOwner: 0 })).toBe(true);
  });

  it('FreePK on the target or on the player makes any creature attackable (pets included)', () => {
    expect(isObjectAttackable({ itemType: C, objectDescFlags: F.FreePkStatus, petOwner: 7 })).toBe(true);
    expect(isObjectAttackable({ itemType: C, objectDescFlags: F.Player }, F.FreePkStatus)).toBe(true);
  });

  it('players: only PK vs PK or PK-lite vs PK-lite; Attackable alone is not enough', () => {
    const player = (bits: number) => ({ itemType: C, objectDescFlags: F.Player | F.Attackable | bits });
    expect(isObjectAttackable(player(0), F.Player)).toBe(false);
    expect(isObjectAttackable(player(F.PlayerKiller), F.Player)).toBe(false);
    expect(isObjectAttackable(player(0), F.Player | F.PlayerKiller)).toBe(false);
    expect(isObjectAttackable(player(F.PlayerKiller), F.Player | F.PlayerKiller)).toBe(true);
    expect(isObjectAttackable(player(F.PkLiteStatus), F.Player | F.PkLiteStatus)).toBe(true);
    expect(isObjectAttackable(player(F.PkLiteStatus), F.Player | F.PlayerKiller)).toBe(false);
  });

  it('the double-click and target-tracking gates use the same rule with the player flags', () => {
    const pkTarget = { itemType: C, objectDescFlags: F.Player | F.PlayerKiller };
    // (the double-click's UseObject takes ObjectIsAttackable with these flags — input/UseObject.ts)
    expect(isObjectAttackable(pkTarget, F.Player)).toBe(false);
    expect(isObjectAttackable(pkTarget, F.Player | F.PlayerKiller)).toBe(true);
    const pet = { itemType: C, objectDescFlags: F.Attackable, petOwner: 9, inWorld: true };
    expect(tracksCombatTarget(true, CombatMode.Melee, pet, F.Player)).toBe(false);
    expect(tracksCombatTarget(true, CombatMode.Melee, { ...pet, petOwner: 0 }, F.Player)).toBe(true);
  });
});
