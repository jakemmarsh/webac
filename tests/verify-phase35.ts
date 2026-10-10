/**
 * Phase 35 — UI Panels + Input
 *
 * Tests:
 *  - InventoryPanel syncs from items, tracks selection
 *  - PaperDoll has all equipment slots, syncs from equipped items
 *  - SpellBar slot assignment, casting lifecycle, cooldowns
 *  - DialogPanel open/close/response lifecycle
 *  - Minimap zoom, dots, world-to-minimap coordinate conversion
 *  - InputManager key state, mouse delta, tab targeting
 *  - InteractionSystem default interactions, queue, range checks
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EquipMask } from '@ac/shared';
import type { InventoryItem, EquippedItem } from '@ac/shared';
import { InventoryPanel } from '../packages/renderer/src/ui/InventoryPanel.js';
import { PaperDoll } from '../packages/renderer/src/ui/PaperDoll.js';
import { SpellBar } from '../packages/renderer/src/ui/SpellBar.js';
import { DialogPanel } from '../packages/renderer/src/ui/DialogPanel.js';
import { Minimap } from '../packages/renderer/src/ui/Minimap.js';
import { InputManager } from '../packages/renderer/src/input/InputManager.js';
import { InteractionSystem, isObjectAttackable } from '../packages/renderer/src/input/InteractionSystem.js';
import { containedUseSubject, decideUseObject, isComponentPack, ownedUseSubject, type UseSubject } from '../packages/renderer/src/input/UseObject.js';

// ── Helpers ──────────────────────────────────────────────────

function makeItem(id: number, name: string, burden = 10, value = 100): InventoryItem {
  return {
    id,
    weenieClassId: id + 1000,
    name,
    value,
    burden,
    stackSize: 1,
    maxStackSize: 1,
    stackable: false,
    containerId: 0,
  };
}

function makeEquipped(id: number, name: string, slot: EquipMask): EquippedItem {
  return {
    id,
    weenieClassId: id + 1000,
    name,
    value: 100,
    burden: 10,
    stackSize: 1,
    maxStackSize: 1,
    stackable: false,
    containerId: 0,
    slot,
  };
}

// ============================================================
describe('Phase 35 — UI Panels + Input', () => {

  // D5: InventoryPanel
  describe('InventoryPanel', () => {
    it('should start hidden with no items', () => {
      const panel = new InventoryPanel();
      expect(panel.visible).toBe(false);
      expect(panel.itemCount).toBe(0);
    });

    it('should sync from inventory items', () => {
      const panel = new InventoryPanel();
      const items = [makeItem(1, 'Sword'), makeItem(2, 'Shield')];
      panel.syncFromInventory(items);
      expect(panel.itemCount).toBe(2);
      expect(panel.getSlot(0)?.item?.name).toBe('Sword');
    });

    it('should select and clear slots', () => {
      const panel = new InventoryPanel();
      panel.syncFromInventory([makeItem(1, 'Sword'), makeItem(2, 'Shield')]);
      panel.selectSlot(1);
      expect(panel.selectedSlot).toBe(1);
      expect(panel.selectedItem?.name).toBe('Shield');

      panel.clearSelection();
      expect(panel.selectedSlot).toBe(-1);
      expect(panel.selectedItem).toBeNull();
    });

    it('should find item slot by ID', () => {
      const panel = new InventoryPanel();
      panel.syncFromInventory([makeItem(1, 'Sword'), makeItem(2, 'Shield')]);
      expect(panel.findItemSlot(2)).toBe(1);
      expect(panel.findItemSlot(999)).toBe(-1);
    });

    it('should toggle visibility', () => {
      const panel = new InventoryPanel();
      panel.toggle();
      expect(panel.visible).toBe(true);
      panel.toggle();
      expect(panel.visible).toBe(false);
    });
  });

  // D6: PaperDoll
  describe('PaperDoll', () => {
    it('should have all equipment slot definitions', () => {
      const doll = new PaperDoll();
      const slots = doll.getSlots();
      // Should have at least head, chest, hands, feet, main hand
      expect(slots.length).toBeGreaterThanOrEqual(10);
      const labels = slots.map(s => s.label);
      expect(labels).toContain('Head');
      expect(labels).toContain('Main Hand');
    });

    it('should sync from equipment', () => {
      const doll = new PaperDoll();
      const equipped = [
        makeEquipped(1, 'Iron Helm', EquipMask.HeadWear),
        makeEquipped(2, 'Iron Sword', EquipMask.MeleeWeapon),
      ];
      doll.syncFromEquipment(equipped);
      expect(doll.isSlotFilled(EquipMask.HeadWear)).toBe(true);
      expect(doll.isSlotFilled(EquipMask.MeleeWeapon)).toBe(true);
      expect(doll.isSlotFilled(EquipMask.ChestArmor)).toBe(false);
      expect(doll.equippedCount).toBe(2);
    });

    it('should toggle visibility', () => {
      const doll = new PaperDoll();
      expect(doll.visible).toBe(false);
      doll.toggle();
      expect(doll.visible).toBe(true);
    });
  });

  // D7: SpellBar
  describe('SpellBar', () => {
    it('should create with 10 empty slots', () => {
      const bar = new SpellBar();
      expect(bar.slotCount).toBe(10);
      expect(bar.getFilledSlots().length).toBe(0);
    });

    it('should assign spells to slots', () => {
      const bar = new SpellBar();
      bar.setSlot(0, 100, 'Flame Bolt');
      expect(bar.getSlot(0)?.spellId).toBe(100);
      expect(bar.getSlot(0)?.spellName).toBe('Flame Bolt');
      expect(bar.getFilledSlots().length).toBe(1);
    });

    it('should clear spell slots', () => {
      const bar = new SpellBar();
      bar.setSlot(0, 100, 'Flame Bolt');
      bar.clearSlot(0);
      expect(bar.getSlot(0)?.spellId).toBeNull();
    });

    it('should handle casting lifecycle', () => {
      const bar = new SpellBar();
      bar.setSlot(0, 100, 'Flame Bolt');
      expect(bar.isCasting).toBe(false);

      bar.startCast(100, 2.0); // 2 second cast
      expect(bar.isCasting).toBe(true);
      expect(bar.castSpellId).toBe(100);
      expect(bar.castProgress).toBeCloseTo(0);

      // Half-way through
      const done1 = bar.updateCast(1.0);
      expect(done1).toBe(false);
      expect(bar.castProgress).toBeCloseTo(0.5);

      // Complete
      const done2 = bar.updateCast(1.0);
      expect(done2).toBe(true);
      expect(bar.isCasting).toBe(false);
    });

    it('should cancel casting', () => {
      const bar = new SpellBar();
      bar.setSlot(0, 100, 'Flame Bolt');
      bar.startCast(100, 2.0);
      bar.updateCast(0.5);
      bar.cancelCast();
      expect(bar.isCasting).toBe(false);
      expect(bar.castProgress).toBe(0);
    });

    it('should track cooldowns', () => {
      const bar = new SpellBar();
      bar.setSlot(0, 100, 'Flame Bolt');
      bar.setCooldown(100, 5.0);
      expect(bar.getSlot(0)?.cooldownRemaining).toBe(5.0);

      bar.updateCooldowns(2.0);
      expect(bar.getSlot(0)?.cooldownRemaining).toBeCloseTo(3.0);

      bar.updateCooldowns(5.0);
      expect(bar.getSlot(0)?.cooldownRemaining).toBe(0);
    });
  });

  // D9: DialogPanel
  describe('DialogPanel', () => {
    it('should open with NPC info and responses', () => {
      const dialog = new DialogPanel();
      dialog.open(42, 'Town Crier', 'Welcome!', [
        { id: 1, text: 'Tell me news', action: 'news' },
        { id: 2, text: 'Goodbye', action: 'close' },
      ]);
      expect(dialog.visible).toBe(true);
      expect(dialog.npcName).toBe('Town Crier');
      expect(dialog.npcId).toBe(42);
      expect(dialog.dialogText).toBe('Welcome!');
      expect(dialog.responses.length).toBe(2);
    });

    it('should select a response by ID', () => {
      const dialog = new DialogPanel();
      dialog.open(1, 'NPC', 'Hello', [
        { id: 1, text: 'Option A', action: 'a' },
        { id: 2, text: 'Option B', action: 'b' },
      ]);
      const resp = dialog.selectResponse(2);
      expect(resp?.text).toBe('Option B');
      expect(resp?.action).toBe('b');
    });

    it('should update dialog for multi-page', () => {
      const dialog = new DialogPanel();
      dialog.open(1, 'NPC', 'Page 1', []);
      dialog.setDialog('Page 2', [{ id: 1, text: 'Continue', action: 'next' }]);
      expect(dialog.dialogText).toBe('Page 2');
      expect(dialog.responses.length).toBe(1);
    });

    it('should close and clear state', () => {
      const dialog = new DialogPanel();
      dialog.open(1, 'NPC', 'Hello', []);
      dialog.close();
      expect(dialog.visible).toBe(false);
      expect(dialog.npcName).toBe('');
      expect(dialog.dialogText).toBe('');
    });
  });

  // D12: Minimap
  describe('Minimap', () => {
    it('should start visible at zoom 1.0', () => {
      const map = new Minimap();
      expect(map.visible).toBe(true);
      expect(map.zoom).toBe(1.0);
    });

    it('should update player position', () => {
      const map = new Minimap();
      map.updatePlayerPosition(100, 200, Math.PI / 4);
      expect(map.playerPosition).toEqual({ x: 100, y: 200 });
      expect(map.playerHeading).toBeCloseTo(Math.PI / 4);
    });

    it('should clamp zoom to valid range', () => {
      const map = new Minimap();
      map.setZoom(0.1); // below min
      expect(map.zoom).toBe(0.5);
      map.setZoom(10); // above max
      expect(map.zoom).toBe(4.0);
    });

    it('should zoom in and out by steps', () => {
      const map = new Minimap();
      map.zoomIn();
      expect(map.zoom).toBe(1.25);
      map.zoomOut();
      expect(map.zoom).toBe(1.0);
    });

    it('should add and clear entity dots', () => {
      const map = new Minimap();
      map.addDot(10, 20, 'red', 'creature');
      map.addDot(30, 40, 'blue', 'npc');
      expect(map.dots.length).toBe(2);
      map.clearDots();
      expect(map.dots.length).toBe(0);
    });

    it('should convert world to minimap coordinates', () => {
      const map = new Minimap();
      map.updatePlayerPosition(100, 100, 0); // facing north, heading=0

      // Player is at center of minimap
      const center = map.worldToMinimap(100, 100);
      expect(center).not.toBeNull();
      expect(center!.x).toBeCloseTo(map.size / 2);
      expect(center!.y).toBeCloseTo(map.size / 2);
    });

    it('should toggle visibility', () => {
      const map = new Minimap();
      map.toggle();
      expect(map.visible).toBe(false);
      map.toggle();
      expect(map.visible).toBe(true);
    });
  });

  // E1: InputManager
  describe('InputManager', () => {
    it('should track key state', () => {
      const input = new InputManager();
      expect(input.isKeyDown('KeyW')).toBe(false);
      input.onKeyDown('KeyW');
      expect(input.isKeyDown('KeyW')).toBe(true);
      input.onKeyUp('KeyW');
      expect(input.isKeyDown('KeyW')).toBe(false);
    });

    it('should accumulate mouse delta', () => {
      const input = new InputManager();
      input.onMouseMove(100, 200, 5, -3);
      input.onMouseMove(105, 197, 10, 2);
      const delta = input.consumeMouseDelta();
      expect(delta.dx).toBe(15);
      expect(delta.dy).toBe(-1);
      // Consuming clears delta
      const delta2 = input.consumeMouseDelta();
      expect(delta2.dx).toBe(0);
      expect(delta2.dy).toBe(0);
    });

    it('should have default key bindings', () => {
      const input = new InputManager();
      expect(input.bindings.toggleInventory).toBe('KeyI');
      expect(input.bindings.spellBar.length).toBe(10);
    });

    it('should check binding state', () => {
      const input = new InputManager();
      input.onKeyDown('KeyI');
      expect(input.isBindingPressed('toggleInventory')).toBe(true);
      input.onKeyUp('KeyI');
      expect(input.isBindingPressed('toggleInventory')).toBe(false);
    });

    it('should consume keys (one-shot)', () => {
      const input = new InputManager();
      input.onKeyDown('Tab');
      expect(input.consumeKey('Tab')).toBe(true);
      expect(input.consumeKey('Tab')).toBe(false); // already consumed
    });

    it('should cycle through nearby targets', () => {
      const input = new InputManager();
      input.setNearbyEntities([
        { id: 1, type: 'creature', distance: 10 },
        { id: 2, type: 'npc', distance: 5 },
        { id: 3, type: 'creature', distance: 15 },
      ]);

      // First cycle selects closest (sorted by distance)
      const t1 = input.cycleTarget();
      expect(t1?.id).toBe(2); // npc at distance 5

      const t2 = input.cycleTarget();
      expect(t2?.id).toBe(1); // creature at distance 10

      const t3 = input.cycleTarget();
      expect(t3?.id).toBe(3); // creature at distance 15

      // Wraps around
      const t4 = input.cycleTarget();
      expect(t4?.id).toBe(2);
    });

    it('should clear target', () => {
      const input = new InputManager();
      input.setNearbyEntities([{ id: 1, type: 'creature', distance: 10 }]);
      input.cycleTarget();
      expect(input.currentTarget).not.toBeNull();
      input.clearTarget();
      expect(input.currentTarget).toBeNull();
    });

    it('should clear all keys', () => {
      const input = new InputManager();
      input.onKeyDown('KeyW');
      input.onKeyDown('KeyA');
      input.clearAllKeys();
      expect(input.isKeyDown('KeyW')).toBe(false);
      expect(input.isKeyDown('KeyA')).toBe(false);
    });
  });

  // E2: InteractionSystem
  describe('InteractionSystem', () => {
    it('should return default interaction for entity types', () => {
      const sys = new InteractionSystem();
      expect(sys.getDefaultInteraction('creature')).toBe('attack');
      expect(sys.getDefaultInteraction('npc')).toBe('talk');
      expect(sys.getDefaultInteraction('vendor')).toBe('buy-sell');
      expect(sys.getDefaultInteraction('item')).toBe('pick-up');
      expect(sys.getDefaultInteraction('portal')).toBe('use-portal');
      expect(sys.getDefaultInteraction('lifestone')).toBe('use-lifestone');
      expect(sys.getDefaultInteraction('container')).toBe('open-container');
      expect(sys.getDefaultInteraction('unknown')).toBe('examine');
    });

    it('should queue and consume interactions', () => {
      const sys = new InteractionSystem();
      expect(sys.hasPendingInteractions).toBe(false);

      sys.queueInteraction('attack', 42, 'creature');
      sys.queueInteraction('talk', 99, 'npc');
      expect(sys.hasPendingInteractions).toBe(true);

      const interactions = sys.consumeInteractions();
      expect(interactions.length).toBe(2);
      expect(interactions[0].type).toBe('attack');
      expect(interactions[0].targetId).toBe(42);
      expect(interactions[1].type).toBe('talk');

      // Queue should be empty now
      expect(sys.hasPendingInteractions).toBe(false);
    });

    it('should track last interaction', () => {
      const sys = new InteractionSystem();
      expect(sys.lastInteraction).toBeNull();
      sys.queueInteraction('examine', 1, 'item');
      expect(sys.lastInteraction?.type).toBe('examine');
    });

    it('should check interaction range', () => {
      const sys = new InteractionSystem();
      const player = { x: 0, y: 0, z: 0 };
      const nearTarget = { x: 3, y: 0, z: 4 }; // distance = 5
      const farTarget = { x: 10, y: 0, z: 10 }; // distance = ~14.1

      expect(sys.isInRange(player, nearTarget)).toBe(true);
      expect(sys.isInRange(player, farTarget)).toBe(false);
    });

    it('should allow configurable interaction range', () => {
      const sys = new InteractionSystem();
      sys.interactionRange = 20;
      expect(sys.interactionRange).toBe(20);
      const player = { x: 0, y: 0, z: 0 };
      const target = { x: 10, y: 0, z: 10 }; // ~14.1
      expect(sys.isInRange(player, target)).toBe(true);
    });
  });

  // BUG.dblclick-vendor-npc-auto-attacks — world double-click dispatch must
  // mirror retail ItemHolder::UseObject @ 0x00588a80 + ClientCombatSystem::
  // ObjectIsAttackable @ 0x0056a600: attack only when the target carries
  // ItemType.Creature AND ObjectDescriptionFlag.Attackable AND the player is
  // already in a combat mode; everything else (vendors, NPCs, peace mode)
  // falls through to Use. Peace mode NEVER auto-enters combat.
  describe('world double-click → ItemHolder::UseObject (SWEEP1006 world use)', () => {
    const ITEM_TYPE_CREATURE = 0x10;
    const ODF_ATTACKABLE = 0x10;
    const ODF_STUCK = 0x4;
    const ODF_VENDOR_STUCK = 0x204;
    const ODF_FREE_PK = 0x200000;
    // Live ACE (2026-10-06): a drudge arrives Stuck|Attackable (0x14) with ItemUseable No (1);
    // NPCs / vendors Stuck (0x4 / 0x204) with Remote (0x20).
    const subject = (over: Partial<UseSubject>): UseSubject => ({
      guid: 0x80001, name: 'Drudge', containerId: 0, wielderId: 0, bitfield: 0, itemsCapacity: 0, containersCapacity: 0,
      itemType: ITEM_TYPE_CREATURE, combatUse: 0, validLocations: 0, location: 0, useability: 1, ownedByPlayer: false, isPlayer: false, ...over,
    });
    const ctx = (target: { itemType: number; objectDescFlags: number }, inCombat: boolean) => ({
      playerGuid: 0x50000001, groundObject: 0, allowSelection: false, skipDetermine: false, selectedGuid: 0,
      attackable: isObjectAttackable(target), peaceMode: !inCombat, confirmVolatileRare: false, selectionCompatible: false,
    });
    const monster = { itemType: ITEM_TYPE_CREATURE, objectDescFlags: ODF_ATTACKABLE };
    const vendor = { itemType: ITEM_TYPE_CREATURE, objectDescFlags: ODF_VENDOR_STUCK };

    it('attackable monster + combat mode → nothing (no Use, no attack)', () => {
      expect(decideUseObject(subject({ bitfield: ODF_ATTACKABLE | ODF_STUCK }), ctx(monster, true))).toEqual({ kind: 'silent' });
    });
    it('attackable monster + peace mode → no Use: the dove-icon line, never auto-enter combat', () => {
      expect(decideUseObject(subject({ bitfield: ODF_ATTACKABLE | ODF_STUCK }), ctx(monster, false)))
        .toEqual({ kind: 'message', text: 'To attack Drudge, click on the dove icon first' });
    });
    it('Vendor-flagged NPC (Remote) → Use in both modes, "Approaching"', () => {
      const v = subject({ name: 'Shopkeeper', bitfield: ODF_VENDOR_STUCK, useability: 0x20 });
      expect(decideUseObject(v, ctx(vendor, false))).toEqual({ kind: 'use', text: 'Approaching Shopkeeper' });
      expect(decideUseObject(v, ctx(vendor, true))).toEqual({ kind: 'use', text: 'Approaching Shopkeeper' });
    });
    it('a stuck non-creature object → Use, "Using the"', () => {
      const chest = subject({ name: 'Chest', itemType: 0x200, bitfield: 0x5 /* Openable|Stuck */, useability: 0x30, itemsCapacity: 24 });
      expect(decideUseObject(chest, ctx({ itemType: 0x200, objectDescFlags: 0x5 }, true))).toEqual({ kind: 'use', text: 'Using the Chest' });
    });
    it('FreePkStatus creature is attackable even without the Attackable bit', () => {
      const freePk = { itemType: ITEM_TYPE_CREATURE, objectDescFlags: ODF_FREE_PK };
      expect(isObjectAttackable(freePk)).toBe(true);
      expect(decideUseObject(subject({ bitfield: ODF_FREE_PK | ODF_STUCK }), ctx(freePk, true))).toEqual({ kind: 'silent' });
    });
    // ACCWeenieObject::IsComponentPack @ 00588400 inside DetermineUseResult @ 00588460.
    // Live ACE: a focus (packwaressence 15271) arrives RequiresPackSlot (bool 81), ItemType Misc,
    // ItemUseable 56 (Contained|Viewed|Remote).
    const focus = (over: Partial<UseSubject>) => subject({
      name: 'Foci of Strife', itemType: 0x80, bitfield: 0x800000, useability: 56, ...over,
    });
    const peace = { ...ctx({ itemType: 0x80, objectDescFlags: 0x800000 }, false) };
    it('a component pack on the ground is picked up (UsingItem 2), not used', () => {
      expect(decideUseObject(focus({ componentPack: true }), peace)).toEqual({ kind: 'usingItem', result: 2 });
    });
    it('any other RequiresPackSlot object on the ground is used', () => {
      expect(decideUseObject(focus({ name: 'Pack', componentPack: false }), peace)).toEqual({ kind: 'use', text: 'Using the Pack' });
    });
    it('an owned rare gem keeps its _bitfield: Use asks the volatile-rare confirmation (UseObject decomp :377640-377656)', () => {
      const gem = ownedUseSubject(0x8000_00aa, { name: 'Rare Gem', containerId: 0x5000_0001, itemType: 0x800, usable: 8, objectDescFlags: 0x10000000 });
      expect(gem.bitfield).toBe(0x10000000);
      const c = { ...ctx({ itemType: 0x800, objectDescFlags: 0x10000000 }, false), confirmVolatileRare: true };
      expect(decideUseObject(gem, c)).toEqual({ kind: 'confirm', which: 'volatileRare' });
    });
    // SWEEP1006B — a worn item's double-click / shortcut use comes off into
    // the pack: wielded by the player, in no container → DetermineUseResult 2.
    it('an owned WORN item is DetermineUseResult case 2 (PlaceInBackpack), even a weapon', () => {
      const sword = ownedUseSubject(0x8000_00bb, { name: 'Sword', containerId: 0x5000_0001, itemType: 0x1, combatUse: 1, validLocations: 0x100000, slot: 0x100000, usable: 1 }, 0x5000_0001);
      expect(sword.wielderId).toBe(0x5000_0001);
      expect(sword.containerId).toBe(0);
      const c = { ...ctx({ itemType: 0x1, objectDescFlags: 0 }, false), playerGuid: 0x5000_0001 };
      expect(decideUseObject(sword, c)).toEqual({ kind: 'usingItem', result: 2 });
      // The same sword in a pack wields instead (case 3).
      const packed = ownedUseSubject(0x8000_00bb, { name: 'Sword', containerId: 0x5000_0001, itemType: 0x1, combatUse: 1, validLocations: 0x100000, usable: 1 }, 0x5000_0001);
      expect(decideUseObject(packed, c)).toEqual({ kind: 'usingItem', result: 3 });
    });
    // A carried sword stored in a chest keeps its weenie: double-clicked in
    // the open chest it is the groundObject's item → case 2 (PlaceInBackpack),
    // no longer ours (no wield); with the chest closed it is a plain use.
    it('a stored item in the open chest is DetermineUseResult case 2, not a wield', () => {
      const chest = 0x8000_0c00;
      const stored = containedUseSubject(0x8000_00bb, { name: 'Sword', containerId: 0x5000_0001, itemType: 0x1, combatUse: 1, validLocations: 0x100000, slot: 0x100000, usable: 1 }, chest);
      expect(stored).toMatchObject({ containerId: chest, wielderId: 0, location: 0, ownedByPlayer: false });
      const c = { ...ctx({ itemType: 0x1, objectDescFlags: 0 }, false), playerGuid: 0x5000_0001 };
      expect(decideUseObject(stored, { ...c, groundObject: chest })).toEqual({ kind: 'usingItem', result: 2 });
      expect(decideUseObject(stored, { ...c, groundObject: 0 })).not.toEqual({ kind: 'usingItem', result: 3 });
    });
    it('isComponentPack is a wcid set lookup', () => {
      const packs = new Set([15271, 15270, 15269, 15268, 43173]);
      expect(isComponentPack(15271, packs)).toBe(true);
      expect(isComponentPack(43173, packs)).toBe(true);
      expect(isComponentPack(136, packs)).toBe(false);
      expect(isComponentPack(0, new Set([0]))).toBe(false);
    });
  });
});
