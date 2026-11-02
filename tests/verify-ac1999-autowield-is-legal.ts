/**
 * BUG.ac1999-autowield-is-legal + VISUAL.ac1999-spellbar-drag-autoscroll, and the sweep for the same
 * shape (client-side legality the era client runs before sending). Every case drives the shipped
 * module; end of retail and Dark Majesty (which run the end-of-retail exe) are pinned beside 1999.
 *
 *  - AutoWieldIsLegal (end of retail CPlayerSystem::AutoWieldIsLegal @ 0055ed60, 1999
 *    PanelUI_AutoWieldIsLegal @ 0x004ff660): ammo the launcher doesn't take, a shield beside a weapon
 *    that keeps it off, a held non-caster outside peace. Both directions: nothing 1999 allowed is refused.
 *  - The 1999 combat button's param_5 branch: ". Moving to backpack." for an object not owned.
 *  - The shield rule per era (BlocksUseOfShield @ 0055d3e0 vs the 1999 combatUse == Missile test).
 *  - AutoWield's param_4: the swap (paperdoll slot drop, every era) and AutoSort's kept occupant line.
 *  - ItemHolder_AttemptPlaceIn3D @ 0x004e50c0's 1999 order, AttemptPlaceInContainerIsLegal
 *    @ 0x004e57b0's 1999 lines, ItemList_AcceptDragObject @ 0x0053ade0, the 1999 Give prompt.
 *  - The spell bar's drag scroll: the DAT attributes of 0x21000010:0x100000b6 (end of retail) and the
 *    1999 constants (Global_Loop @ 0x00515120).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import {
  blocksUseOfShield, resolveAutoWield, UISlotSide, EquipMask, CombatUse, ItemType, ObjectDescriptionFlag, AUTOWIELD_RINGS_FULL,
} from '@ac/shared';
import { parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, type ElementDesc } from '@ac/dat-parser';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import {
  acceptPaperdollDrop, autoWieldPrecheck, eraAutoWieldLine, paperdollSlotDragAcceptState,
  type PaperdollDropObject, type PaperdollEquippedObject, type PaperdollWearContext,
} from '../packages/renderer/src/inventory/PaperdollDragObject.js';
import { attemptPlaceIn3D, PLACE_IN_3D_STRINGS, type PlaceIn3DContext, type PlaceIn3DItem, type PlaceIn3DTarget } from '../packages/renderer/src/inventory/AttemptPlaceIn3D.js';
import {
  attemptToPlaceInContainer, acceptItemListDrop, AC1999_CONTAINER_LEGAL_STRINGS, CONTAINER_LEGAL_STRINGS, ITEM_LIST_DROP_STRINGS,
  ITEM_LEGAL_STRINGS, type PlacementWorld,
} from '../packages/renderer/src/inventory/ItemHolderPlacement.js';
import { giveSelectedObject, GIVE_DROP_STRINGS } from '../packages/renderer/src/inventory/GiveDropCommands.js';
import {
  AC1999_SPELLBAR_DRAG_SCROLL, DragScrollClock, dragScrollRegion, layoutDragScrollRule, ITEMLIST_DRAG_SCROLL_PROPS,
} from '../packages/renderer/src/ui/SpellBarDragScroll.js';
import { makeWorld, pack, PLAYER } from './_harness/placementWorld.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const EOR_ERAS = ['eor', 'classicace-customdm', 'classic-dereth'] as const;
const rulesOf = (id: string) => eraClientRules(eraProfile(id));

const BOW: PaperdollEquippedObject = { id: 0x80000010, name: 'Yew Longbow', slot: EquipMask.MissileWeapon, validLocations: EquipMask.MissileWeapon, combatUse: CombatUse.Missile, ammoType: 1 };
const DARTS: PaperdollEquippedObject = { id: 0x80000011, name: 'Throwing Dart', slot: EquipMask.MissileWeapon, validLocations: EquipMask.MissileWeapon, combatUse: CombatUse.Missile };
const SWORD: PaperdollEquippedObject = { id: 0x80000012, name: 'Long Sword', slot: EquipMask.MeleeWeapon, validLocations: EquipMask.MeleeWeapon, combatUse: CombatUse.Melee };
const GREATSWORD: PaperdollEquippedObject = { id: 0x80000013, name: 'Greatsword', slot: EquipMask.TwoHanded, validLocations: EquipMask.TwoHanded, combatUse: CombatUse.TwoHanded };
const WAND: PaperdollEquippedObject = { id: 0x80000014, name: 'Wand', slot: EquipMask.Held, validLocations: EquipMask.Held, itemType: 0x8000 };
const ARROWS: PaperdollDropObject = { id: 0x80000020, name: 'Arrow', pluralName: 'Arrows', stackSize: 50, validLocations: EquipMask.MissileAmmo, combatUse: 3, ammoType: 1 };
const BOLTS: PaperdollDropObject = { id: 0x80000021, name: 'Quarrel', pluralName: 'Quarrels', stackSize: 1, validLocations: EquipMask.MissileAmmo, combatUse: 3, ammoType: 2 };
const SHIELD: PaperdollDropObject = { id: 0x80000022, name: 'Kite Shield', validLocations: EquipMask.Shield, combatUse: 4 };
const TORCH: PaperdollDropObject = { id: 0x80000023, name: 'Torch', validLocations: EquipMask.Held, itemType: 0x80 };
const ORB: PaperdollDropObject = { id: 0x80000024, name: 'Orb', validLocations: EquipMask.Held, itemType: 0x8000 };
const AXE: PaperdollDropObject = { id: 0x80000025, name: 'Axe', validLocations: EquipMask.MeleeWeapon, combatUse: CombatUse.Melee };

function ctx(equipped: PaperdollEquippedObject[], rules = eraClientRules(null), over: Partial<PaperdollWearContext> = {}): PaperdollWearContext {
  return {
    playerId: PLAYER, equipped, inCombat: false, readyRefusal: null,
    slotDropSwaps: rules.paperdollSlotDropSwaps, dualWieldShieldSlot: rules.dualWieldShieldSlot, shieldBlockRule: rules.shieldBlockRule,
    ...over,
  };
}

describe('the era rules (EraClientRules)', () => {
  it('1999 takes the 1999 client.exe values; end of retail and Dark Majesty end of retail\'s', () => {
    expect(R1999).toMatchObject({
      shieldBlockRule: 'ac1999', autoWieldMoveToBackpackLine: '. Moving to backpack.',
      autoWieldRingsFullLine: "You're already wearing rings on both hands.", spellBarDragScroll: 'ac1999', paperdollSlotDropSwaps: true,
    });
    for (const id of EOR_ERAS) {
      expect(rulesOf(id), id).toMatchObject({
        shieldBlockRule: 'eor', autoWieldMoveToBackpackLine: null,
        autoWieldRingsFullLine: AUTOWIELD_RINGS_FULL, spellBarDragScroll: 'layout', paperdollSlotDropSwaps: true,
      });
    }
    expect(eraClientRules(null).shieldBlockRule).toBe('eor');
  });
});

describe('AutoWieldIsLegal — the refusals, both clients, the same words', () => {
  for (const [era, rules] of [['1999', R1999], ...EOR_ERAS.map((id) => [id, rulesOf(id)] as const)] as const) {
    it(`${era}: ammunition the launcher doesn't take — "Cannot be used with <launcher>"`, () => {
      expect(autoWieldPrecheck(BOLTS, ctx([BOW], rules))).toEqual({ kind: 'refused', notice: 'Cannot be used with Yew Longbow' });
    });
    it(`${era}: a shield beside the bow — "A shield may not be worn with the <weapon>"`, () => {
      expect(autoWieldPrecheck(SHIELD, ctx([BOW], rules))).toEqual({ kind: 'refused', notice: 'A shield may not be worn with the Yew Longbow' });
      expect(autoWieldPrecheck(SHIELD, ctx([WAND], rules))).toEqual({ kind: 'refused', notice: 'A shield may not be worn with the Wand' });
    });
    it(`${era}: a held non-caster outside peace — "Cannot hold <it> while in combat"`, () => {
      expect(autoWieldPrecheck(TORCH, ctx([], rules, { inCombat: true }))).toEqual({ kind: 'refused', notice: 'Cannot hold Torch while in combat' });
    });
    it(`${era}: the inverse — what the client allowed is still allowed`, () => {
      expect(autoWieldPrecheck(ARROWS, ctx([BOW], rules))).toEqual({ kind: 'proceed' }); // bow + arrows
      expect(autoWieldPrecheck(BOLTS, ctx([], rules))).toEqual({ kind: 'proceed' }); // no launcher
      expect(autoWieldPrecheck(BOLTS, ctx([SWORD], rules))).toEqual({ kind: 'proceed' }); // a launcher-less weapon
      expect(autoWieldPrecheck(SHIELD, ctx([SWORD], rules))).toEqual({ kind: 'proceed' }); // sword and board
      expect(autoWieldPrecheck(TORCH, ctx([], rules))).toEqual({ kind: 'proceed' }); // a torch in peace
      expect(autoWieldPrecheck(ORB, ctx([], rules, { inCombat: true }))).toEqual({ kind: 'proceed' }); // a caster in combat
      expect(autoWieldPrecheck(AXE, ctx([SWORD], rules, { inCombat: true }))).toEqual({ kind: 'proceed' }); // a weapon swap mid-fight
      expect(autoWieldPrecheck(AXE, ctx([SWORD], rules))).toEqual({ kind: 'proceed' }); // a weapon swap in peace
    });
    it(`${era}: silent (AutoSort's param_3 = 1) refuses without a word; another creature's object is refused`, () => {
      expect(autoWieldPrecheck(BOLTS, ctx([BOW], rules), { silent: true })).toEqual({ kind: 'refused' });
      expect(autoWieldPrecheck({ ...AXE, wielderId: 0x50000099 }, ctx([], rules)))
        .toEqual({ kind: 'refused', notice: 'The Axe is being wielded by someone else' });
    });
  }

  it('the shield test differs: a thrown weapon blocks it in 1999 only, a two-hander at end of retail only', () => {
    expect(autoWieldPrecheck(SHIELD, ctx([DARTS], R1999))).toEqual({ kind: 'refused', notice: 'A shield may not be worn with the Throwing Dart' });
    expect(autoWieldPrecheck(SHIELD, ctx([GREATSWORD], R1999))).toEqual({ kind: 'proceed' });
    for (const id of EOR_ERAS) {
      expect(autoWieldPrecheck(SHIELD, ctx([DARTS], rulesOf(id))), id).toEqual({ kind: 'proceed' });
      expect(autoWieldPrecheck(SHIELD, ctx([GREATSWORD], rulesOf(id))), id).toEqual({ kind: 'refused', notice: 'A shield may not be worn with the Greatsword' });
    }
  });

  it('the paperdoll slot\'s ring follows the same test (OnItemListDragOver)', () => {
    expect(paperdollSlotDragAcceptState(BOLTS, EquipMask.MissileAmmo, ctx([BOW]))).toBe(0x10000041);
    expect(paperdollSlotDragAcceptState(ARROWS, EquipMask.MissileAmmo, ctx([BOW]))).toBe(0x10000040);
    expect(paperdollSlotDragAcceptState(SHIELD, EquipMask.Shield, ctx([DARTS], R1999))).toBe(0x10000041);
    expect(paperdollSlotDragAcceptState(SHIELD, EquipMask.Shield, ctx([DARTS]))).toBe(0x10000040);
  });
});

describe('the 1999 combat button (PanelUI_AutoWield(obj, 2, 0, 1, 1, 1) @ 0x00502180)', () => {
  const how = { moveToBackpack: true, moveToBackpackLine: R1999.autoWieldMoveToBackpackLine };
  it('an object off the ground that can\'t be wielded goes to the pack with ". Moving to backpack."', () => {
    expect(autoWieldPrecheck(BOLTS, ctx([BOW], R1999), { ...how, ownedByPlayer: false }))
      .toEqual({ kind: 'backpack', notice: 'Cannot be used with Yew Longbow. Moving to backpack.' });
    expect(autoWieldPrecheck(SHIELD, ctx([BOW], R1999), { ...how, ownedByPlayer: false }))
      .toEqual({ kind: 'backpack', notice: 'A shield may not be worn with the Yew Longbow. Moving to backpack.' });
  });
  it('an object the player carries is only refused; a legal one proceeds either way', () => {
    expect(autoWieldPrecheck(BOLTS, ctx([BOW], R1999), { ...how, ownedByPlayer: true }))
      .toEqual({ kind: 'refused', notice: 'Cannot be used with Yew Longbow' });
    expect(autoWieldPrecheck(ARROWS, ctx([BOW], R1999), { ...how, ownedByPlayer: false })).toEqual({ kind: 'proceed' });
  });
});

describe('the shield rule in the slot chain (resolveAutoWield)', () => {
  const shieldWorn = (bits: number) => (bits & EquipMask.Shield ? 0x80000099 : 0);
  it('a thrown weapon wielded beside a worn shield: 1999 takes the shield off, end of retail leaves it', () => {
    const darts = { id: 1, validLocations: EquipMask.MissileWeapon, combatUse: CombatUse.Missile };
    expect(resolveAutoWield(darts, EquipMask.Shield, shieldWorn, UISlotSide.Right, true, undefined, 'ac1999'))
      .toEqual({ kind: 'blocked', blockingId: 0x80000099, notice: undefined });
    expect(resolveAutoWield(darts, EquipMask.Shield, shieldWorn)).toEqual({ kind: 'wield', slot: EquipMask.MissileWeapon });
  });
  it('a bow takes the shield off in both; a two-hander only at end of retail', () => {
    const bow = { id: 1, validLocations: EquipMask.MissileWeapon, combatUse: CombatUse.Missile, ammoType: 1 };
    expect(resolveAutoWield(bow, EquipMask.Shield, shieldWorn).kind).toBe('blocked');
    expect(resolveAutoWield(bow, EquipMask.Shield, shieldWorn, UISlotSide.Right, true, undefined, 'ac1999').kind).toBe('blocked');
    expect(blocksUseOfShield({ id: 1, validLocations: 0, combatUse: CombatUse.TwoHanded }, 'ac1999')).toBe(false);
    expect(blocksUseOfShield({ id: 1, validLocations: 0, combatUse: CombatUse.TwoHanded })).toBe(true);
    expect(blocksUseOfShield({ id: 1, validLocations: 0, itemType: 0x8000 }, 'ac1999')).toBe(true);
  });
});

describe('AutoWield param_4: the swap and the kept occupant', () => {
  const ring = { id: 0x80000030, name: 'Gold Ring', validLocations: 0xc0000 };
  const worn: PaperdollEquippedObject = { id: 0x80000031, name: 'Silver Ring', slot: 0x40000, validLocations: 0xc0000 };
  it('a paperdoll slot drop on a taken slot swaps in every era (AcceptDragObject passes param_4 = 1)', () => {
    for (const rules of [R1999, ...EOR_ERAS.map(rulesOf)]) {
      expect(acceptPaperdollDrop(ring, { kind: 'slot', mask: 0x40000 }, ctx([worn], rules))).toEqual({ wieldLocation: null, swap: { side: UISlotSide.Left } });
    }
  });
  it('AutoSort\'s kept occupant says so in the era\'s words', () => {
    const both = (bits: number) => (bits & 0xc0000 ? worn.id : 0);
    const res = resolveAutoWield({ id: ring.id, validLocations: ring.validLocations }, 0xc0000, both);
    expect(res).toMatchObject({ kind: 'blocked', notice: AUTOWIELD_RINGS_FULL });
    expect(eraAutoWieldLine(res.kind === 'blocked' ? res.notice : undefined, R1999.autoWieldRingsFullLine)).toBe("You're already wearing rings on both hands.");
    for (const id of EOR_ERAS) expect(eraAutoWieldLine(AUTOWIELD_RINGS_FULL, rulesOf(id).autoWieldRingsFullLine)).toBe("You're already wearing jewelry on both hands.");
    expect(eraAutoWieldLine("You're already wearing jewelry on both wrists.", R1999.autoWieldRingsFullLine)).toBe("You're already wearing jewelry on both wrists.");
  });
});

describe('ItemHolder_AttemptPlaceIn3D — the 1999 order (0x004e50c0)', () => {
  const ground: PlaceIn3DItem = { id: 0x80000040, name: 'Pyreal', ownedByPlayer: false, inTrade: false, in3DView: true, weenieClassId: 273, stackSize: 5, maxStackSize: 25000 };
  const carried: PlaceIn3DItem = { ...ground, id: 0x80000041, ownedByPlayer: true, in3DView: false };
  const pile: PlaceIn3DTarget = { id: 0x80000042, name: 'Pyreal', weenieClassId: 273, itemType: 0x40, objectDescFlags: 0, stackSize: 10, maxStackSize: 25000, inTrade: false };
  const chest: PlaceIn3DTarget = { id: 0x80000043, name: 'Chest', weenieClassId: 1, itemType: ItemType.Container, objectDescFlags: ObjectDescriptionFlag.Openable, stackSize: 1, maxStackSize: 1, inTrade: false };
  const drudge: PlaceIn3DTarget = { id: 0x80000044, name: 'Drudge', weenieClassId: 2, itemType: ItemType.Creature, objectDescFlags: 0, stackSize: 1, maxStackSize: 1, inTrade: false };
  const base = (order: 'eor' | 'ac1999', over: Partial<PlaceIn3DContext> = {}): PlaceIn3DContext => ({
    playerId: PLAYER, ready: true, dragAmount: 5, splitPartial: false, dragItemOnPlayerOpensSecureTrade: false,
    playerOnGround: true, groundObjectId: chest.id, order, ...over,
  });
  it('1999: an object off the ground merges onto a stack and goes into the open chest; end of retail refuses both', () => {
    expect(attemptPlaceIn3D(ground, pile, true, base('ac1999')).action).toEqual({ kind: 'merge', amount: 5 });
    expect(attemptPlaceIn3D(ground, chest, true, base('ac1999')).action).toEqual({ kind: 'container' });
    for (const t of [pile, chest]) {
      expect(attemptPlaceIn3D(ground, t, true, base('eor'))).toEqual({ action: { kind: 'none' }, notices: ['You must first pick up the Pyreal'] });
    }
  });
  it('1999: a ground stack onto a ground stack — the merge path asks no ownership (0x004e4e80 → 0x004e4f70 → UIAttemptMerge)', () => {
    const groundPile = { ...pile, id: 0x80000045 }; // another stack lying on the ground, not the player's
    const ctx1999 = { ...base('ac1999'), text: R1999.placementText };
    expect(attemptPlaceIn3D(ground, groundPile, true, ctx1999)).toEqual({ action: { kind: 'merge', amount: 5 }, notices: [] });
    // A refused merge says 1999's line, then the drop falls to the ground branch, where ownership is asked.
    expect(attemptPlaceIn3D(ground, { ...groundPile, weenieClassId: 999 }, true, ctx1999).notices)
      .toEqual(['Cannot Merge Different Stack Types.', 'You must first pick up the Pyreal']);
    expect(attemptPlaceIn3D(ground, { ...groundPile, stackSize: 25000 }, true, ctx1999).notices)
      .toEqual(["This stack's too big to add to", 'You must first pick up the Pyreal']);
    // A carried stack onto a full ground stack: the line, then it is put down beside it.
    expect(attemptPlaceIn3D(carried, { ...groundPile, stackSize: 25000 }, true, ctx1999))
      .toEqual({ action: { kind: 'put3d' }, notices: ["This stack's too big to add to"] });
  });
  it('1999: giving needs the object carried; a creature can\'t be given', () => {
    expect(attemptPlaceIn3D(ground, drudge, true, base('ac1999'))).toEqual({ action: { kind: 'none' }, notices: ['You must first pick up the Pyreal'] });
    expect(attemptPlaceIn3D(carried, drudge, true, base('ac1999')).action).toEqual({ kind: 'give', amount: 5 });
    const rat = { ...ground, name: 'Rat', itemType: ItemType.Creature, maxStackSize: 1 };
    expect(attemptPlaceIn3D(rat, drudge, false, base('ac1999')).notices).toEqual(['You cannot give the Rat']);
  });
  it('1999: on the ground, mid-air is asked before ownership', () => {
    expect(attemptPlaceIn3D(ground, null, true, base('ac1999', { playerOnGround: false })).notices).toEqual([PLACE_IN_3D_STRINGS.midAir]);
    expect(attemptPlaceIn3D(ground, null, true, base('eor', { playerOnGround: false })).notices).toEqual(['You must first pick up the Pyreal']);
    expect(attemptPlaceIn3D(carried, null, true, base('ac1999')).action).toEqual({ kind: 'put3d' });
  });
  it('end of retail is unchanged with no order given', () => {
    const { order: _drop, ...noOrder } = base('eor');
    expect(attemptPlaceIn3D(ground, pile, true, noOrder)).toEqual(attemptPlaceIn3D(ground, pile, true, base('eor')));
    expect(attemptPlaceIn3D(carried, drudge, true, noOrder).action).toEqual({ kind: 'give', amount: 5 });
  });
});

describe('AttemptPlaceInContainerIsLegal — the 1999 lines and order (0x004e57b0)', () => {
  const sack = pack(0x80000050, 24, 'Sack');
  const w = (rule: 'eor' | 'ac1999', extra: Parameters<typeof makeWorld>[0] = []): PlacementWorld =>
    ({ ...makeWorld([sack, { id: 0x80000051, name: 'Gem', in: PLAYER, ownedByPlayer: true }, ...extra]), rule, text: rule === 'ac1999' ? R1999.placementText : undefined });
  it('1999 words them its own way', () => {
    expect(attemptToPlaceInContainer(0x80000051, 0x80000099, 0, false, 0, w('ac1999')))
      .toEqual({ kind: 'refused', notice: 'The container in which to place the Gem is not valid' });
    expect(attemptToPlaceInContainer(0x80000099, sack.id, 0, false, 0, w('ac1999')))
      .toEqual({ kind: 'refused', notice: 'The item to be placed in the Sack is not valid' });
    expect(attemptToPlaceInContainer(sack.id, sack.id, 0, false, 0, w('ac1999')))
      .toEqual({ kind: 'refused', notice: "Can't place Sack within itself" });
    expect(attemptToPlaceInContainer(PLAYER, sack.id, 0, false, 0, w('ac1999')))
      .toEqual({ kind: 'refused', notice: "Can't place yourself within the Sack" });
    expect(AC1999_CONTAINER_LEGAL_STRINGS.locked).toBe('The %s is locked');
  });
  it('end of retail keeps its lines', () => {
    expect(attemptToPlaceInContainer(0x80000051, 0x80000099, 0, false, 0, w('eor'))).toEqual({ kind: 'refused', notice: CONTAINER_LEGAL_STRINGS.invalid });
    expect(attemptToPlaceInContainer(sack.id, sack.id, 0, false, 0, w('eor'))).toEqual({ kind: 'refused', notice: CONTAINER_LEGAL_STRINGS.withinItself });
    expect(attemptToPlaceInContainer(PLAYER, sack.id, 0, false, 0, w('eor'))).toEqual({ kind: 'refused', notice: ITEM_LEGAL_STRINGS.self });
  });
  it('a legal put is a put in both', () => {
    expect(attemptToPlaceInContainer(0x80000051, sack.id, 0, false, 0, w('ac1999')).kind).toBe('put');
    expect(attemptToPlaceInContainer(0x80000051, sack.id, 0, false, 0, w('eor')).kind).toBe('put');
  });
});

describe('ItemList_AcceptDragObject — the 1999 list (0x0053ade0)', () => {
  const box = { id: 0x80000060, name: 'Jewelry Box', in: PLAYER, isContainer: true, holder: true, itemsCapacity: 0, containersCapacity: 0 };
  const gem = { id: 0x80000061, name: 'Gem', in: PLAYER, ownedByPlayer: true };
  const drop = { itemId: gem.id, cellItemId: box.id, listContainerId: PLAYER, cellPlacement: 3, containerList: false };
  it('a container cell that takes no items: end of retail refuses, 1999 puts the item in the list at that cell', () => {
    expect(acceptItemListDrop(drop, { ...makeWorld([box, gem]), rule: 'eor' }))
      .toEqual({ kind: 'refused', notice: ITEM_LIST_DROP_STRINGS.cannotAcceptItems.replace('%s', 'Jewelry Box') });
    expect(acceptItemListDrop(drop, { ...makeWorld([box, gem]), rule: 'ac1999' })).toEqual({ kind: 'put', containerId: PLAYER, placement: 3 });
  });
  it('1999: the player dropped on the player\'s own list', () => {
    const self = { ...drop, itemId: PLAYER, cellItemId: 0 };
    expect(acceptItemListDrop(self, { ...makeWorld([]), rule: 'ac1999' })).toEqual({ kind: 'refused', notice: 'You cannot place yourself in your inventory!' });
  });
});

describe('the keyboard Give\'s prompt', () => {
  const lookup = { item: () => null, target: () => ({ id: 2, name: 'Chest', weenieClassId: 1, itemType: ItemType.Container, objectDescFlags: 0, stackSize: 1, maxStackSize: 1, inTrade: false }) };
  const noCtx = () => { throw new Error('not reached'); };
  it('1999 has no full stop; end of retail does', () => {
    const r = giveSelectedObject(1, 2, lookup, noCtx, R1999.placementText);
    expect(r.handled && r.notices).toEqual(['You must select a creature or a character to give that to']);
    for (const id of EOR_ERAS) {
      const e = giveSelectedObject(1, 2, lookup, noCtx, rulesOf(id).placementText);
      expect(e.handled && e.notices, id).toEqual([GIVE_DROP_STRINGS.mustSelectCreature]);
    }
  });
});

describe('the spell bar drag scroll (VISUAL.ac1999-spellbar-drag-autoscroll)', () => {
  const rect = { left: 0, top: 0, right: 439, bottom: 32 };
  const eor = { zone: 'outside' as const, margin: 32, delaySeconds: 0.2, stepPx: 32 };
  it('1999: the inner 30 px of either end, between top and bottom', () => {
    const r = AC1999_SPELLBAR_DRAG_SCROLL;
    expect(r).toEqual({ zone: 'inside', margin: 30, delaySeconds: 0.4, stepPx: 32 });
    expect(dragScrollRegion(r, rect, 0, 10)).toBe(-1);
    expect(dragScrollRegion(r, rect, 29, 10)).toBe(-1);
    expect(dragScrollRegion(r, rect, 30, 10)).toBe(0);
    expect(dragScrollRegion(r, rect, 410, 10)).toBe(1);
    expect(dragScrollRegion(r, rect, 409, 10)).toBe(0);
    expect(dragScrollRegion(r, rect, -5, 10)).toBe(0); // off the list: no drag-over
    expect(dragScrollRegion(r, rect, 5, 40)).toBe(0);
  });
  it('end of retail: the 32 px beyond either end, not on the list', () => {
    expect(dragScrollRegion(eor, rect, -1, 10)).toBe(-1);
    expect(dragScrollRegion(eor, rect, -32, 10)).toBe(-1);
    expect(dragScrollRegion(eor, rect, -33, 10)).toBe(0);
    expect(dragScrollRegion(eor, rect, 0, 10)).toBe(0);
    expect(dragScrollRegion(eor, rect, 440, 10)).toBe(1);
    expect(dragScrollRegion(eor, rect, 471, 10)).toBe(1);
    expect(dragScrollRegion(eor, rect, 472, 10)).toBe(0);
  });
  it('the rest clock: a step one delay after entering, then every delay; leaving or switching ends re-arms', () => {
    const c = new DragScrollClock(0.4);
    expect(c.tick(-1, 10)).toBe(0);
    expect(c.tick(-1, 10.39)).toBe(0);
    expect(c.tick(-1, 10.4)).toBe(-1);
    expect(c.tick(-1, 10.7)).toBe(0);
    expect(c.tick(-1, 10.8)).toBe(-1);
    expect(c.tick(1, 10.9)).toBe(0); // the other end starts its own clock
    expect(c.tick(1, 11.3)).toBe(1);
    expect(c.tick(0, 11.4)).toBe(0);
    expect(c.tick(1, 11.5)).toBe(0);
  });
  it('the layout rule reads the list\'s attributes, off when either flag is', () => {
    const P = ITEMLIST_DRAG_SCROLL_PROPS;
    const props = new Map<number, { valueBool?: boolean; valueInt?: number; valueFloat?: number }>([
      [P.horizontal, { valueBool: true }], [P.spellScrolling, { valueBool: true }],
      [P.marginWidth, { valueInt: 32 }], [P.jumpDistance, { valueInt: 32 }], [P.delay, { valueFloat: 0.2 }],
    ]);
    expect(layoutDragScrollRule(props)).toEqual({ zone: 'outside', margin: 32, delaySeconds: 0.2, stepPx: 32 });
    expect(layoutDragScrollRule(new Map([...props, [P.spellScrolling, { valueBool: false }]]))).toBeNull();
    expect(layoutDragScrollRule(undefined)).toBeNull();
  });
});

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
describe.skipIf(!hasDats)('the spell bar list\'s DAT attributes (0x21000010:0x100000b6)', () => {
  const lists: ElementDesc[] = [];
  beforeAll(() => {
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    setMasterPropertyTypes(parseMasterProperty(portal.getReader(0x39000001)));
    const walk = (m: Map<number, ElementDesc>) => {
      for (const e of m.values()) { if (e.elementId === 0x100000b6) lists.push(e); walk(e.children); }
    };
    walk(parseLayoutDesc(local.getReader(0x21000010)).elements);
  });
  it('every tab page\'s list scrolls a cell for a spell drag rested 32 px beyond an end, every 0.2 s', () => {
    expect(lists.length).toBeGreaterThan(0);
    for (const l of lists) {
      const r = layoutDragScrollRule(l.properties);
      expect(r).not.toBeNull();
      expect(r!.zone).toBe('outside');
      expect(r!.margin).toBe(32);
      expect(r!.stepPx).toBe(32);
      expect(r!.delaySeconds).toBeCloseTo(0.2, 5);
    }
  });
});
