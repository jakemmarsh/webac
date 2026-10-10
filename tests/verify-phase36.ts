/**
 * Phase 36 — Game Logic Integration
 *
 * Tests:
 *  - CombatController: mode mirror + auto-attack flag (combat itself is
 *    server-authoritative; the local attack sim was deleted)
 *  - MagicController: spellbook management (casting is server-authoritative)
 *  - InventoryController: pickup/drop/equip/use, encumbrance, action log
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CombatMode, MagicSchool, EquipMask } from '@ac/shared';
import type { SpellDefinition } from '@ac/shared';
import { CombatController } from '../packages/renderer/src/controllers/CombatController.js';
import { MagicController } from '../packages/renderer/src/controllers/MagicController.js';
import { InventoryController } from '../packages/renderer/src/controllers/InventoryController.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';

// ── Helpers ──────────────────────────────────────────────────

function makePlayerState(): PlayerState {
  const state = new PlayerState();
  state.initFromCreation({
    name: 'TestHero',
    heritage: 1,
    gender: 0,
    level: 10,
    totalXp: 50000n,
    availableXp: 25000n,
    skillCredits: 50,
    attributes: {
      strength: 100,
      endurance: 100,
      coordination: 80,
      quickness: 60,
      focus: 50,
      self: 50,
    },
    skills: new Map(),
  });
  return state;
}

function makeSpell(overrides?: Partial<SpellDefinition>): SpellDefinition {
  return {
    id: 1,
    name: 'Flame Bolt',
    school: MagicSchool.WarMagic,
    level: 1,
    power: 50,
    manaCost: 10,
    difficulty: 50,
    duration: 0,
    components: [],
    targetType: 1, // SingleTarget
    damage: 30,
    ...overrides,
  };
}

// ============================================================
describe('Phase 36 — Game Logic Integration', () => {

  // F1: CombatController
  describe('CombatController', () => {
    let combat: CombatController;

    beforeEach(() => {
      combat = new CombatController();
    });

    it('should start in non-combat mode', () => {
      expect(combat.mode).toBe(CombatMode.NonCombat);
      expect(combat.isInCombat).toBe(false);
    });

    it('should set specific combat mode', () => {
      combat.setCombatMode(CombatMode.Missile);
      expect(combat.mode).toBe(CombatMode.Missile);
      expect(combat.isInCombat).toBe(true);
    });

    it('should auto-attack toggle', () => {
      expect(combat.autoAttack).toBe(false);
      combat.autoAttack = true;
      expect(combat.autoAttack).toBe(true);
    });

    it('leaving combat (NonCombat) clears auto-attack', () => {
      combat.setCombatMode(CombatMode.Melee);
      combat.autoAttack = true;
      combat.setCombatMode(CombatMode.NonCombat);
      expect(combat.autoAttack).toBe(false);
    });
  });

  // F2: MagicController
  describe('MagicController', () => {
    let magic: MagicController;

    beforeEach(() => {
      magic = new MagicController();
    });

    it('should manage spellbook', () => {
      const spell = makeSpell();
      expect(magic.isSpellKnown(1)).toBe(false);

      magic.learnSpell(spell);
      expect(magic.isSpellKnown(1)).toBe(true);
      expect(magic.knownSpells.length).toBe(1);
      expect(magic.getSpell(1)?.name).toBe('Flame Bolt');

      // Cannot learn same spell twice
      expect(magic.learnSpell(spell)).toBe(false);

      magic.forgetSpell(1);
      expect(magic.isSpellKnown(1)).toBe(false);
    });
  });

  // F4: InventoryController
  describe('InventoryController', () => {
    let inv: InventoryController;
    let state: PlayerState;

    beforeEach(() => {
      inv = new InventoryController();
      state = makePlayerState();
      inv.setPlayerState(state);
    });

    it('should pickup items', () => {
      const action = inv.pickupItem({
        weenieClassId: 100,
        name: 'Iron Sword',
        value: 500,
        burden: 100,
        stackSize: 1,
        maxStackSize: 1,
        stackable: false,
        containerId: 0,
      });
      expect(action.success).toBe(true);
      expect(action.type).toBe('pickup');
      expect(action.message).toContain('Iron Sword');
    });

    it('should drop items', () => {
      const pickup = inv.pickupItem({
        weenieClassId: 100,
        name: 'Iron Sword',
        value: 500,
        burden: 100,
        stackSize: 1,
        maxStackSize: 1,
        stackable: false,
        containerId: 0,
      });
      const drop = inv.dropItem(pickup.itemId);
      expect(drop.success).toBe(true);
      expect(drop.type).toBe('drop');
    });

    it('should fail to drop nonexistent item', () => {
      const drop = inv.dropItem(999);
      expect(drop.success).toBe(false);
    });

    it('should equip and unequip items', () => {
      inv.pickupItem({
        weenieClassId: 100,
        name: 'Iron Sword',
        value: 500,
        burden: 100,
        stackSize: 1,
        maxStackSize: 1,
        stackable: false,
        containerId: 0,
      });

      const equip = inv.equipItem(1, EquipMask.MeleeWeapon);
      expect(equip.success).toBe(true);

      const unequip = inv.unequipItem(EquipMask.MeleeWeapon);
      expect(unequip.success).toBe(true);
    });

    it('should use items', () => {
      inv.pickupItem({
        weenieClassId: 200,
        name: 'Health Potion',
        value: 50,
        burden: 10,
        stackSize: 1,
        maxStackSize: 1,
        stackable: false,
        containerId: 0,
      });
      const use = inv.useItem(1);
      expect(use.success).toBe(true);
      expect(use.message).toContain('Health Potion');
    });

    it('should destroy items', () => {
      inv.pickupItem({
        weenieClassId: 100,
        name: 'Junk',
        value: 1,
        burden: 5,
        stackSize: 1,
        maxStackSize: 1,
        stackable: false,
        containerId: 0,
      });
      const destroy = inv.destroyItem(1);
      expect(destroy.success).toBe(true);
      expect(destroy.message).toContain('Junk');

      // Item should be gone
      const use = inv.useItem(1);
      expect(use.success).toBe(false);
    });

    it('should check encumbrance', () => {
      // maxBurden = strength(100) * 150 = 15000
      expect(inv.maxBurden).toBe(15000);
      expect(inv.canPickup(100)).toBe(true);
      expect(inv.canPickup(20000)).toBe(false);
    });

    it('should apply the Increased Carrying Capacity augmentation bonus to maxBurden', () => {
      // ACE EncumbranceSystem: 150*str + str*min(30*numAugs, 150).
      // 2 augs -> bonus 60/str, capped well under 150.
      state.serverIntProps.set(230 /* AugmentationIncreasedCarryingCapacity */, 2);
      expect(inv.maxBurden).toBe(150 * 100 + 100 * 60);
      expect(inv.canPickup(16000)).toBe(true);
    });

    it('should cap the augmentation bonus at +150% capacity like ACE', () => {
      state.serverIntProps.set(230, 10); // 30*10=300, clamped to 150
      expect(inv.maxBurden).toBe(150 * 100 + 100 * 150);
    });

    it('ignores the server EncumbranceCapacity snapshot — capacity is always recomputed (STATS.burden-capacity-augs-buffs)', () => {
      // ACE sends PropertyInt.EncumbranceCapacity only once, at augmentation
      // time (AugmentationDevice.cs:122-123; not [SendOnLogin]), and the
      // retail client never reads it: CACQualities::InqLoad @ 0058f130
      // recomputes EncumbranceCapacity(enchanted Strength, InqInt(230)).
      state.serverEncumbranceCapacity = 12000;
      state.serverIntProps.set(230, 5); // 30*5 = 150 bonus/str
      expect(inv.maxBurden).toBe(150 * 100 + 100 * 150);
      expect(inv.canPickup(12500)).toBe(true);
    });

    it('should maintain action log', () => {
      inv.pickupItem({
        weenieClassId: 100, name: 'Item', value: 1, burden: 1,
        stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0,
      });
      inv.useItem(1);
      expect(inv.actionLog.length).toBe(2);

      inv.clearActionLog();
      expect(inv.actionLog.length).toBe(0);
    });

    it('should split stacks', () => {
      inv.pickupItem({
        weenieClassId: 100, name: 'Arrows', value: 1, burden: 1,
        stackSize: 10, maxStackSize: 100, stackable: true, containerId: 0,
      });

      const split = inv.splitStack(1, 3);
      expect(split.success).toBe(true);

      // Original stack should have 7, new stack should have 3
      const items = state.inventory.getAll();
      expect(items.length).toBe(2);
    });

    it('should fail operations without player state', () => {
      const noStateInv = new InventoryController();
      const action = noStateInv.pickupItem({
        weenieClassId: 1, name: 'Test', value: 1, burden: 1,
        stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0,
      });
      expect(action.success).toBe(false);
    });
  });
});
