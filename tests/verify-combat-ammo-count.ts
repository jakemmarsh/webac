/**
 * BUG.ac1999-combat-ammo-count (webac#19) — the toolbar's combat button shows the arrows left in
 * missile mode, in every era.
 *
 * End of retail: gmToolbarUI::UpdateAmmoID @ 004bf210 picks the object at EquipMask 0x400000 when
 * its maxStackSize > 1 (thrown weapons), else the one at 0x800000; UpdateAmmoNumber @ 004be9e0
 * writes its stack size (0 → 1), or "", into 0x21000016:0x10000194 (the missile-mode state).
 * The 1999 client.exe: CombatButton's TextRegion (ctor @ 0x00501950), the same pick at 0x005024a0,
 * GetEffectiveStackSize with "%u" or "" at 0x005025a0, parented only in mode 3 (0x00502310).
 * Ours showed nothing in any era: the toolbar never drew the number.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CombatMode, EquipMask } from '../packages/shared/src/index.js';
import {
  combatAmmoObject, combatAmmoCountText, combatAmmoCountShown,
} from '../packages/renderer/src/ui/CombatAmmoCount.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const BOW = { id: 0x80000101, slot: EquipMask.MissileWeapon, stackSize: 1, maxStackSize: 1 };
const ARROWS = { id: 0x80000102, slot: EquipMask.MissileAmmo, stackSize: 37, maxStackSize: 250 };
const DARTS = { id: 0x80000103, slot: EquipMask.MissileWeapon, stackSize: 12, maxStackSize: 100 };
const SWORD = { id: 0x80000104, slot: EquipMask.MeleeWeapon, stackSize: 1, maxStackSize: 1 };

describe('the pick (UpdateAmmoID @ 004bf210 / 1999 0x005024a0) and the text (UpdateAmmoNumber @ 004be9e0 / 0x005025a0)', () => {
  it('a bow with arrows: the arrows\' stack', () => {
    expect(combatAmmoObject([BOW, ARROWS])?.id).toBe(ARROWS.id);
    expect(combatAmmoCountText([BOW, ARROWS])).toBe('37');
  });

  it('a thrown weapon (maxStackSize > 1) is its own ammunition, ahead of the ammo slot', () => {
    expect(combatAmmoCountText([DARTS])).toBe('12');
    expect(combatAmmoObject([DARTS, ARROWS])?.id).toBe(DARTS.id);
  });

  it('a bow with no arrows, or nothing worn: the empty string (0x5f529c)', () => {
    expect(combatAmmoCountText([BOW])).toBe('');
    expect(combatAmmoCountText([])).toBe('');
    expect(combatAmmoCountText([SWORD])).toBe('');
  });

  it('arrows with no launcher still count (neither client checks the launcher)', () => {
    expect(combatAmmoCountText([ARROWS])).toBe('37');
  });

  it('a stack size of 0 reads 1 (pwd._stackSize 0 → 1; 1999 GetEffectiveStackSize @ 0x004d22c0)', () => {
    expect(combatAmmoCountText([{ ...ARROWS, stackSize: 0 }])).toBe('1');
  });

  it('shown in missile mode only (the 0x10000194 state; 1999 mode 3)', () => {
    expect(combatAmmoCountShown(CombatMode.Missile)).toBe(true);
    for (const m of [CombatMode.NonCombat, CombatMode.Melee, CombatMode.Magic]) expect(combatAmmoCountShown(m)).toBe(false);
  });
});

const item = (o: { id: number; slot: number; stackSize: number; maxStackSize: number }, name: string) => ({
  id: o.id, weenieClassId: 300, name, value: 0, burden: 1, stackSize: o.stackSize, maxStackSize: o.maxStackSize,
  stackable: o.maxStackSize > 1, containerId: 0, slot: o.slot, combatUse: o.slot === EquipMask.MissileWeapon ? 2 : 1,
});

for (const era of ['eor', 'classic-dereth', 'ac1999-retail'] as const) {
  describe(`the real toolbar, era ${era}`, () => {
    let H: GameUIFixture;
    let ui: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const box = (): HTMLElement | null => H.win.document.querySelector('#combat-mode-btn > [data-ac-combat-ammo]');
    const shown = (): string => box()?.textContent ?? '';

    beforeAll(async () => {
      H = await mountGameUI();
      ui = H.ui;
      ui.setClientRules(eraClientRules(eraProfile(era === 'eor' ? null : era)));
      ui.uiManager.setScreen('game');
      ui.renderHUD();
    }, 60_000);
    afterAll(() => H?.teardown());

    it('a bow and 37 arrows: nothing in peace, "37" in missile mode, gone again in peace', () => {
      ui.hudState.setCombatMode(CombatMode.NonCombat);
      ui.updateHUD();
      ui.setInventoryData([], [item(BOW, 'Bow'), item(ARROWS, 'Arrow')], 0, 100);
      expect(box()).not.toBeNull();
      expect(shown()).toBe('');
      ui.toggleCombatMode();
      expect(ui.hudState.combatMode).toBe(CombatMode.Missile);
      expect(shown()).toBe('37');
      expect(box()!.dataset.acCombatAmmo).toBe('37');
      ui.toggleCombatMode();
      expect(shown()).toBe('');
    });

    it('a shot (SetStackSize → inventory sync) counts down; the last arrow gone leaves it empty', () => {
      ui.hudState.setCombatMode(CombatMode.Missile);
      ui.updateHUD();
      ui.setInventoryData([], [item(BOW, 'Bow'), item({ ...ARROWS, stackSize: 36 }, 'Arrow')], 0, 100);
      expect(shown()).toBe('36');
      ui.setInventoryData([], [item(BOW, 'Bow')], 0, 100);
      expect(shown()).toBe('');
    });

    it('a mode the server sets (updateHUD\'s mode change) shows and hides it too', () => {
      ui.setInventoryData([], [item(BOW, 'Bow'), item(ARROWS, 'Arrow')], 0, 100);
      ui.hudState.setCombatMode(CombatMode.Melee);
      ui.updateHUD();
      expect(shown()).toBe('');
      ui.hudState.setCombatMode(CombatMode.Missile);
      ui.updateHUD();
      expect(shown()).toBe('37');
    });

    it('a melee weapon: no number in any mode', () => {
      ui.setInventoryData([], [item(SWORD, 'Sword')], 0, 100);
      for (const m of [CombatMode.NonCombat, CombatMode.Melee, CombatMode.Missile]) {
        ui.hudState.setCombatMode(m);
        ui.updateHUD();
        expect(shown()).toBe('');
      }
    });

    it('the count never takes the pointer (the button still clicks and takes drops)', () => {
      expect(box()!.style.pointerEvents).toBe('none');
    });
  });
}
