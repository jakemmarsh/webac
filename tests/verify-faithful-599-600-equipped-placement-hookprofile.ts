/**
 * FAITHFUL.599 + FAITHFUL.600 (faithfulness sweep findings #12, #13;
 * parsed-unused shape).
 *
 * 599 — SUPERSEDED by BUG.clothingpriority-never-lands: the login stamp this
 *       file used to pin was a runtime no-op (equipped CreateObjects arrive
 *       after PlayerDescription, and own equipment never enters
 *       ServerObjectManager). ClothingPriority now lands via the per-object
 *       CreateObject WeenieHeaderFlag.Priority field — behavioral coverage
 *       in tests/verify-bug-clothingpriority-never-lands.ts.
 *
 * 600 — IdentifyResponse HookProfile (flag 0x0040, 12 bytes per ACE
 *       HookProfile.cs: HookFlags + ValidLocations + AmmoType). Now verifies
 *       how the end-of-retail appraisal uses it, via the shipped builder
 *       `packages/renderer/src/ui/examine/ItemAppraisalText.ts`: retail
 *       prints NO "hooked item" row of flags / slot names / ammo type (the
 *       old invented rows). ItemExamineUI::SetAppraiseInfo @ 004b72b0
 *       instead, for a weenie whose IsHooked is true, substitutes the hook
 *       profile's ValidLocations + AmmoType for the PublicWeenieDesc ones
 *       (driving Appraisal_ShowWeaponAndArmorData @ 004b10e0's ammo /
 *       coverage lines), treats HookFlags 0x2 as IsHealer
 *       (Appraisal_ShowHealKitValues @ 004b25a0), and
 *       Appraisal_ShowCapacity @ 004b2680 returns early.
 */
import { describe, it, expect } from 'vitest';
import { EquipMask } from '@ac/shared';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText, type AppraisedWeenieInfo } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';

const BOOST_VALUE = 90; // PropertyInt.BoostValue
const BOOSTER_ENUM = 89; // PropertyInt.BoosterEnum

function examine(hookProfile: IdentifyResponseData['hookProfile'], weenie: AppraisedWeenieInfo, ints: Array<[number, number]> = []): string {
  return buildItemAppraisalText(
    { guid: 0x80001111, flags: 0x40, hookProfile, propertiesInt: new Map(ints) },
    { hasValueBurdenElements: true, weenie },
  ).text;
}

describe('FAITHFUL.600: hookProfile in the retail item appraisal', () => {
  it("a hooked item's ValidLocations + AmmoType come from the hook profile, not the weenie", () => {
    const hooked = { isHooked: true, validLocations: 0, ammoType: 0 };
    expect(examine({ hookFlags: 0, validLocations: EquipMask.MissileAmmo, ammoType: 1 }, hooked)).toContain('Used as ammunition by bows.');
    expect(examine({ hookFlags: 0, validLocations: EquipMask.MissileWeapon, ammoType: 2 }, hooked)).toContain('Uses quarrels as ammunition.');
    expect(examine({ hookFlags: 0, validLocations: EquipMask.HeadWear, ammoType: 0 }, { ...hooked, priority: 0x4000 })).toContain('Covers Head');
  });

  it('a weenie that is not hooked ignores the hook profile', () => {
    const text = examine({ hookFlags: 0x2, validLocations: EquipMask.MissileAmmo, ammoType: 1 }, { isHooked: false }, [[BOOST_VALUE, 25], [BOOSTER_ENUM, 2]]);
    expect(text).not.toContain('ammunition');
    expect(text).toBe('Restores 25 Health when used.');
  });

  it('HookFlags 0x2 (IsHealer) switches the boost line to the heal-kit line', () => {
    const text = examine({ hookFlags: 0x2, validLocations: 0, ammoType: 0 }, { isHooked: true }, [[BOOST_VALUE, 25], [BOOSTER_ENUM, 2]]);
    expect(text).toBe('Bonus to Healing Skill: 25');
  });

  it('a hooked item with a hook profile writes no capacity line', () => {
    const w = { itemsCapacity: 24, containersCapacity: 0 };
    expect(examine(undefined, w)).toBe('Can hold up to 24 items.');
    expect(examine({ hookFlags: 0, validLocations: 0, ammoType: 0 }, { ...w, isHooked: true })).not.toContain('Can hold');
  });

  it('retail prints no hook-flag / slot-name / ammo-type row', () => {
    const text = examine({ hookFlags: 0x1 | 0x4 | 0x8, validLocations: EquipMask.HeadWear | EquipMask.ChestWear, ammoType: 2 }, { isHooked: true });
    for (const s of ['Inscribable', 'Food', 'Lockpick', 'Head Wear', 'Chest Wear', 'Equippable', 'type 2', 'Hooked']) expect(text).not.toContain(s);
  });
});
