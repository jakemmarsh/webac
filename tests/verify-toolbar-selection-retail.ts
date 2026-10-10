/**
 * gmToolbarUI::HandleSelectionChanged @ 004bf380 — the selection-driven
 * decisions (packages/renderer/src/ui/ToolbarSelection.ts).
 *
 * SWEEP1006B.hud-status.selection-heart-meter-shows-creature — retail sends
 * Event_QueryHealth only for a player (IsPlayer), a pet (_pet_owner) or an
 * ObjectIsAttackable @ 0056a600 object; a stack of >= 2 queries nothing; an
 * owned non-attackable object gets Event_QueryItemMana. The heart meter
 * shows only after RecvNotice_UpdateObjectHealth @ 004bd110.
 *
 * SWEEP1006B.hud-status.toolbar-use-button-greyed-target — the Use button is
 * disabled only for _combatUse == 0, not Armor/Clothing/Jewelry, and
 * ItemUses::IsUseable @ 004fccc0 false (ItemUseable bit 0 set).
 */
import { describe, it, expect } from 'vitest';
import { ItemType, ObjectDescriptionFlag as F } from '@ac/shared';
import {
  selectionQueryFor,
  targetHealthMeterVisible,
  toolbarUseButtonDisabled,
} from '../packages/renderer/src/ui/ToolbarSelection.js';

const notOwned = { ownedByPlayer: false, playerFlags: 0 };

describe('selectionQueryFor — which query a new selection fires', () => {
  it('an attackable monster → QueryHealth', () => {
    expect(selectionQueryFor({ itemType: ItemType.Creature, objectDescFlags: F.Attackable }, notOwned)).toBe('health');
  });

  it('a Yellow-radar vendor (creature, not Attackable) → nothing', () => {
    expect(selectionQueryFor({ itemType: ItemType.Creature, objectDescFlags: F.Vendor }, notOwned)).toBe('none');
  });

  it('the Loom (weenie 19128: Creature, Attackable False) → nothing', () => {
    expect(selectionQueryFor({ itemType: ItemType.Creature, objectDescFlags: 0 }, notOwned)).toBe('none');
  });

  it('a stack of 2 or more → nothing, even when attackable', () => {
    expect(selectionQueryFor({ itemType: ItemType.Creature, objectDescFlags: F.Attackable, stackSize: 2 }, notOwned)).toBe('none');
  });

  it('another player (IsPlayer) and the player themself → QueryHealth', () => {
    expect(selectionQueryFor({ itemType: ItemType.Creature, objectDescFlags: F.Player }, notOwned)).toBe('health');
    expect(selectionQueryFor({ itemType: ItemType.Creature }, { ...notOwned, isSelf: true })).toBe('health');
  });

  it('a pet (_pet_owner set) → QueryHealth, though ObjectIsAttackable refuses it', () => {
    expect(selectionQueryFor({ itemType: ItemType.Creature, objectDescFlags: F.Attackable, petOwner: 0x50000001 }, notOwned)).toBe('health');
  });

  it('FreePkStatus on the local player makes any creature attackable → QueryHealth', () => {
    expect(selectionQueryFor({ itemType: ItemType.Creature }, { ownedByPlayer: false, playerFlags: F.FreePkStatus })).toBe('health');
  });

  it('an owned non-creature → QueryItemMana; an unowned one → nothing', () => {
    expect(selectionQueryFor({ itemType: ItemType.Caster }, { ownedByPlayer: true, playerFlags: 0 })).toBe('mana');
    expect(selectionQueryFor({ itemType: ItemType.Caster }, notOwned)).toBe('none');
  });
});

describe('targetHealthMeterVisible — only after a health reply', () => {
  it('hidden without a reply, shown with one', () => {
    expect(targetHealthMeterVisible({})).toBe(false);
    expect(targetHealthMeterVisible({ healthReceived: true })).toBe(true);
  });
  it('a stack or the snake mana meter takes the slot', () => {
    expect(targetHealthMeterVisible({ healthReceived: true, stackSize: 3 })).toBe(false);
    expect(targetHealthMeterVisible({ healthReceived: true, manaFraction: 0.5 })).toBe(false);
  });
});

describe('toolbarUseButtonDisabled — LAB_004bf795', () => {
  it('nothing selected → enabled', () => {
    expect(toolbarUseButtonDisabled(null)).toBe(false);
  });
  it('USEABLE_NO (bit 0) on a plain object → disabled', () => {
    expect(toolbarUseButtonDisabled({ itemType: ItemType.Creature, usable: 1 })).toBe(true);
    expect(toolbarUseButtonDisabled({ itemType: ItemType.Misc, usable: 1 })).toBe(true);
  });
  it('a Remote-useable creature NPC (0x20) and an object with no ItemUseable sent → enabled', () => {
    expect(toolbarUseButtonDisabled({ itemType: ItemType.Creature, usable: 0x20 })).toBe(false);
    expect(toolbarUseButtonDisabled({ itemType: ItemType.Creature })).toBe(false);
  });
  it('a combat use or Armor / Clothing / Jewelry → enabled even with USEABLE_NO', () => {
    expect(toolbarUseButtonDisabled({ itemType: ItemType.MeleeWeapon, usable: 1, combatUse: 1 })).toBe(false);
    expect(toolbarUseButtonDisabled({ itemType: ItemType.Armor, usable: 1 })).toBe(false);
    expect(toolbarUseButtonDisabled({ itemType: ItemType.Clothing, usable: 1 })).toBe(false);
    expect(toolbarUseButtonDisabled({ itemType: ItemType.Jewelry, usable: 1 })).toBe(false);
  });
});

describe('ServerObjectManager keeps the Use button desc inputs', () => {
  async function makeSOM() {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const scene = { add: () => {}, remove: () => {} };
    const setupModelRenderer = { createSetupMeshWithOverrides: () => null, loadSetupModel: () => null };
    const appearanceManager = { loadPaletteColors: () => null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new ServerObjectManager(setupModelRenderer as any, appearanceManager as any, scene as any);
  }
  function data(overrides: Record<string, unknown> = {}) {
    return {
      guid: 0x80006666, name: 'Dagger', weenieClassId: 300, itemType: ItemType.MeleeWeapon,
      position: null, setupId: 0, motionTableId: 0, iconId: 0x06000001,
      physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
      basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
      containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
      validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
      uiEffects: 0, usable: 1, velocityX: 0, velocityY: 0, velocityZ: 0,
      soundTableId: 0, objScale: 1.0, translucency: 0, defaultScript: 0,
      defaultScriptIntensity: 1.0, iconOverlayId: 0, iconUnderlayId: 0,
      ...overrides,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('a world object keeps CreateObject.combatUse (0 when not sent)', async () => {
    const som = await makeSOM();
    const dagger = som.createObject(data({ combatUse: 1 }))!;
    expect(dagger.combatUse).toBe(1);
    expect(toolbarUseButtonDisabled(dagger)).toBe(false);
    const rock = som.createObject(data({ guid: 0x80006667, itemType: ItemType.Misc }))!;
    expect(rock.combatUse).toBe(0);
    expect(toolbarUseButtonDisabled(rock)).toBe(true);
  });

  it("the player's own CreateObject feeds playerUseDesc (it never becomes a ServerObject)", async () => {
    const som = await makeSOM();
    som.setPlayerGuid(0x50000001);
    expect(som.createObject(data({ guid: 0x50000001, itemType: ItemType.Creature, usable: 1 }))).toBeNull();
    expect(som.playerUseDesc).toEqual({ itemType: ItemType.Creature, usable: 1, combatUse: 0 });
    expect(toolbarUseButtonDisabled(som.playerUseDesc)).toBe(true);
  });
});
