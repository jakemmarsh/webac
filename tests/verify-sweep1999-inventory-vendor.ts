/**
 * SWEEP1999.inventory — the inventory, vendor and examine differences of the 1999 client.exe as
 * era data (EraClientRules), each driven through the shipped code, with end of retail and the
 * classic eras (which run the end-of-retail exe) pinned unchanged. Findings: the sweep's
 * inventory.md (INV-*) and vendor-trade-examine.md (VTE-*). INV-2 and INV-8 are every-era fixes.
 */
import { describe, it, expect } from 'vitest';
import {
  shopSellPrice, shopBuyPrice, vendorBuyPrice, PROMISSORY_NOTE_RATES_EOR, PROMISSORY_NOTE_RATES_1999,
  TYPE_PROMISSORY_NOTE, PropertyDataId, ItemType, ObjectDescriptionFlag, UISlotSide, type InventoryItem,
} from '@ac/shared';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import {
  buildVendorSellRows, noteIsFromVendor, vendorInqAcceptability, VENDOR_ACCEPTABILITY, planVendorSellDrop,
} from '../packages/renderer/src/ui/VendorSellDrag.js';
import { applyPublicPropertyDataIdUpdate } from '../packages/renderer/src/network/applyPublicPropertyDataId.js';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { deserializeMessage, type DirectMessage } from '../packages/network/src/MessageSerializer.js';
import { ServerMessageHandler, type PropertyUpdateData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { examineInscription, inscriptionCommit, INSCRIBE_HERE } from '../packages/renderer/src/ui/examine/ExaminationWindow.js';
import { BookModel, type BookPage } from '../packages/renderer/src/ui/BookModel.js';
import {
  attemptToPlaceInContainer, placeInBackpack, acceptItemListDrop, PLACEMENT_FULL_STRINGS, type PlacementWorld,
} from '../packages/renderer/src/inventory/ItemHolderPlacement.js';
import { makeWorld, pack, filler, PLAYER } from './_harness/placementWorld.js';
import {
  acceptPaperdollDrop, autoSortDecision, paperdollSlotDragAcceptState, PAPERDOLL_STRINGS,
  type PaperdollEquippedObject, type PaperdollWearContext,
} from '../packages/renderer/src/inventory/PaperdollDragObject.js';
import { targetCompatibleWithObject, leastLimitedTargetUse } from '../packages/renderer/src/input/TargetCompatible.js';
import { attemptPlaceIn3D, type PlaceIn3DContext } from '../packages/renderer/src/inventory/AttemptPlaceIn3D.js';

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const EOR_ERAS = ['eor', 'classicace-customdm', 'classic-dereth'] as const;
const eorRules = (id: string) => eraClientRules(eraProfile(id));

describe('the era profile values (EraClientRules)', () => {
  it('1999 takes the 1999 client.exe values; end of retail and the classic eras keep today\'s', () => {
    expect(R1999).toMatchObject({
      inventoryPlacement: 'ac1999', paperdollSlotDropSwaps: true, dualWieldShieldSlot: false,
      targetedUseConfirmations: false, vendorDropNeedsWholeStack: false, vendorAcceptability: 'ac1999',
      promissoryNoteRates: { sell: 1.1, issuerBuy: 1, foreignBuy: 0.8 },
      inscribePlaceholder: { text: '(inscribe here)', centered: true },
      book: { menuAuthorFormat: '- %s', saveOnlyChanged: true },
    });
    for (const id of EOR_ERAS) {
      expect(eorRules(id), id).toMatchObject({
        inventoryPlacement: 'eor', paperdollSlotDropSwaps: false, dualWieldShieldSlot: true,
        targetedUseConfirmations: true, vendorDropNeedsWholeStack: true, vendorAcceptability: 'eor',
        promissoryNoteRates: { sell: 1.15, issuerBuy: 1, foreignBuy: 1 },
        inscribePlaceholder: { text: '<Inscribe here>', centered: false },
        book: { menuAuthorFormat: '%s', saveOnlyChanged: false },
      });
    }
  });
});

describe('VTE-1 — trade-note prices (ShopSystem_SellPrice @ 0x5f3ce0 / BuyPrice @ 0x5f3c70)', () => {
  it('a 10,000p note costs 11,000p in 1999 and 11,500p in end of retail', () => {
    expect(shopSellPrice(10000, TYPE_PROMISSORY_NOTE, 2, 1, R1999.promissoryNoteRates)).toBe(11000);
    for (const id of EOR_ERAS) expect(shopSellPrice(10000, TYPE_PROMISSORY_NOTE, 2, 1, eorRules(id).promissoryNoteRates), id).toBe(11500);
    // The default stays end of retail's (every existing caller).
    expect(shopSellPrice(10000, TYPE_PROMISSORY_NOTE, 2, 1)).toBe(11500);
    // Ordinary wares are untouched by the note rates.
    expect(shopSellPrice(100, 0x1, 1.25, 1, PROMISSORY_NOTE_RATES_1999)).toBe(125);
  });

  it('selling a note back: face value to its issuer, 80% elsewhere (1999); face value anywhere (end of retail)', () => {
    expect(shopBuyPrice(10000, TYPE_PROMISSORY_NOTE, 0.5, 1, PROMISSORY_NOTE_RATES_1999, true)).toBe(10000);
    expect(shopBuyPrice(10000, TYPE_PROMISSORY_NOTE, 0.5, 1, PROMISSORY_NOTE_RATES_1999, false)).toBe(8000);
    expect(shopBuyPrice(10000, TYPE_PROMISSORY_NOTE, 0.5, 1, PROMISSORY_NOTE_RATES_EOR, false)).toBe(10000);
    expect(vendorBuyPrice({ value: 1000, stackSize: 1, itemType: TYPE_PROMISSORY_NOTE }, 0.5, PROMISSORY_NOTE_RATES_1999, false)).toBe(800);
  });

  it('the sell rows read each note\'s stamped issuer against the open vendor\'s wcid', () => {
    const note = (id: number): InventoryItem => ({
      id, weenieClassId: 2621, name: 'Trade Note (1,000)', value: 1000, burden: 1, stackSize: 1, maxStackSize: 1,
      stackable: false, containerId: PLAYER, itemType: TYPE_PROMISSORY_NOTE,
    });
    const issuers = new Map([[0x80000001, 719], [0x80000002, 720]]);
    const notes = { rates: PROMISSORY_NOTE_RATES_1999, vendorWcid: 719, issuerOf: (g: number) => issuers.get(g) };
    const rows = buildVendorSellRows([note(0x80000001), note(0x80000002), note(0x80000003)], TYPE_PROMISSORY_NOTE, 0.5, notes);
    expect(rows.map((r) => [r.price, r.noteIssuer])).toEqual([[1000, true], [800, false], [800, false]]);
    // End of retail: every note pays face value, issuer or not.
    const eor = buildVendorSellRows([note(0x80000002)], TYPE_PROMISSORY_NOTE, 0.5, { ...notes, rates: PROMISSORY_NOTE_RATES_EOR });
    expect(eor[0].price).toBe(1000);
    expect(noteIsFromVendor({ ...notes, vendorWcid: 0 }, 0x80000001)).toBe(false);
  });

  it('the 1999 adapter keeps a note\'s issuing vendor as the EoL VendorsClassId DID, which the client records', () => {
    const c = emptyCodecs();
    registerObjects1999(c);
    const logs: string[] = [];
    const a = new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) });
    const create = (issuer: number | null): Uint8Array => {
      const w = new Writer1999().u32(0xf745).u32(0x80005678);
      w.u8(0x11).u8(0).u8(0).u8(0).align4();
      w.u32(0).u32(0x408);
      for (let i = 0; i < 9; i++) w.u16(0);
      w.align4();
      w.u32(0x8 | (issuer !== null ? 0x200000 : 0)).acString('Trade Note (1,000)').u16(2621).u16(0x1234).u32(TYPE_PROMISSORY_NOTE).u32(0);
      w.u32(1000);
      if (issuer !== null) w.u16(issuer);
      return w.align4().toBytes();
    };
    const stamped = a.inbound(create(719), 3);
    expect(stamped).toHaveLength(2);
    expect(a.inbound(create(null), 3)).toHaveLength(1);
    expect(logs).toEqual([]);
    const got: PropertyUpdateData[] = [];
    const h = new ServerMessageHandler();
    h.setHandlers({ onPublicUpdatePropertyDataID: (d) => { got.push(d); } });
    h.handleMessage(deserializeMessage(stamped[1]) as DirectMessage);
    expect(got).toEqual([{ guid: 0x80005678, key: PropertyDataId.VendorsClassId, value: 719 }]);
    const noteIssuers = new Map<number, number>();
    applyPublicPropertyDataIdUpdate(got[0], {
      getObject: () => undefined, inventory: { applyPublicPropertyDataId: () => false },
      onInventoryItemChanged: () => {}, noteIssuers, log: () => {},
    });
    expect(noteIssuers.get(0x80005678)).toBe(719);
  });
});

describe('VTE-6 — the sell gate (VendorProfile_InqAcceptability @ 0x5e1920)', () => {
  const profile = { itemTypes: TYPE_PROMISSORY_NOTE | 0x1, minValue: -1, maxValue: 5000 };
  it('a note above max_value is "too valuable" in 1999, exempt in end of retail', () => {
    const big = { itemType: TYPE_PROMISSORY_NOTE, value: 10000, stackSize: 1 };
    expect(vendorInqAcceptability(big, profile, R1999.vendorAcceptability)).toBe(VENDOR_ACCEPTABILITY.tooValuable);
    for (const id of EOR_ERAS) expect(vendorInqAcceptability(big, profile, eorRules(id).vendorAcceptability), id).toBe(VENDOR_ACCEPTABILITY.ok);
    const drop = planVendorSellDrop({ guid: 1, name: 'Trade Note', weenieClassId: 2621, ...big, ownedByPlayer: true }, profile, true, 1, 'ac1999');
    expect(drop).toEqual({ kind: 'refused', notice: 'That item is too valuable to sell here' });
  });
  it('the Retained bit is end of retail\'s alone', () => {
    const retained = { itemType: 0x1, value: 100, stackSize: 1, objectDescFlags: 0x01000000 };
    expect(vendorInqAcceptability(retained, profile, 'eor')).toBe(VENDOR_ACCEPTABILITY.wrongType);
    expect(vendorInqAcceptability(retained, profile, 'ac1999')).toBe(VENDOR_ACCEPTABILITY.ok);
  });
});

describe('VTE-7 — the vendor\'s type menu (ItemsEnvPanel_OpenVendor @ 0x5a5490)', () => {
  it('1999: Keys, Tools 0x4000 and Cooking Items 0x2400000; the rest as end of retail', () => {
    const m = new Map(R1999.vendorTypeFilters);
    expect(m.get('Keys, Tools')).toBe(0x4000);
    expect(m.get('Cooking Items')).toBe(0x2400000);
    for (const id of EOR_ERAS) {
      const e = new Map(eorRules(id).vendorTypeFilters);
      expect([e.get('Keys, Tools'), e.get('Cooking Items')], id).toEqual([0x20004000, 0x400000]);
    }
    expect(R1999.vendorTypeFilters.map(([l]) => l)).toEqual(eorRules('eor').vendorTypeFilters.map(([l]) => l));
    // A 1999 cooking intermediate (typed 0x2000000 alone) is listed under Cooking Items.
    expect(R1999.vendorTypeFilters.some(([, mask]) => (mask & 0x2000000) !== 0)).toBe(true);
    expect(eorRules('eor').vendorTypeFilters.filter(([l]) => l === 'Cooking Items').every(([, mask]) => (mask & 0x2000000) === 0)).toBe(true);
  });
});

describe('VTE-5 — the empty inscription block', () => {
  it('the era\'s placeholder, marked as one; a commit back to empty restores it', () => {
    const v = examineInscription(0x2, new Map(), R1999.inscribePlaceholder.text);
    expect(v).toMatchObject({ visible: true, text: '(inscribe here)', placeholder: true });
    expect(inscriptionCommit('', { ...v, scribe: 'Me', inscription: 'x' }, 'Me', R1999.inscribePlaceholder.text).view.text).toBe('(inscribe here)');
    for (const id of EOR_ERAS) expect(examineInscription(0x2, new Map(), eorRules(id).inscribePlaceholder.text).text, id).toBe(INSCRIBE_HERE);
    expect(examineInscription(0x2, new Map([[8, 'Bob'], [7, 'Hi']]), R1999.inscribePlaceholder.text)).toMatchObject({ text: 'Hi', signature: '--Bob' });
  });
});

describe('VTE-8 — books (ReadWritePanel_UpdateMenu @ 0x521230 / CloseCurPage @ 0x521820)', () => {
  const ME = 0x50000001;
  const harness = (rules?: { menuAuthorFormat: string; saveOnlyChanged: boolean }) => {
    const sent: string[] = [];
    const m = new BookModel({
      playerId: () => ME, playerName: () => 'Me', bookName: () => 'Tome',
      pageData: () => {}, addPage: () => {}, modifyPage: (b, n, t) => sent.push(`modify ${n} ${t}`),
      deletePage: () => {}, bookData: () => {}, notice: () => {},
    });
    if (rules) m.rules = rules;
    return { m, sent };
  };
  const pg = (authorName: string, pageText: string): BookPage => ({ authorId: ME, authorName, textIncluded: true, ignoreAuthor: false, pageText });

  it('1999 menu rows read "- <author>", nothing for an empty author; end of retail the bare name', () => {
    const y = harness(R1999.book);
    y.m.openBook(1, 3, [pg('Me', 'a'), pg('', 'b')], '', 0, '');
    expect(y.m.menu.map((r) => r.text)).toEqual(['- Me', '', '(blank)']);
    const e = harness(eorRules('eor').book);
    e.m.openBook(1, 3, [pg('Me', 'a'), pg('', 'b')], '', 0, '');
    expect(e.m.menu.map((r) => r.text)).toEqual(['Me', '', '(blank)']);
  });

  it('1999 saves a page only when its text changed; end of retail on every leave', () => {
    const y = harness(R1999.book);
    y.m.openBook(1, 3, [pg('Me', 'a'), pg('Me', 'b')], '', 0, '');
    y.m.setCurPage(1);
    expect(y.sent).toEqual([]);
    y.m.pageText = 'b2';
    y.m.setCurPage(0);
    expect(y.sent).toEqual(['modify 1 b2']);
    const e = harness();
    e.m.openBook(1, 3, [pg('Me', 'a'), pg('Me', 'b')], '', 0, '');
    e.m.setCurPage(1);
    expect(e.sent).toEqual(['modify 0 a']);
  });
});

describe('INV-1 — where a pick-up goes (ItemHolder_AttemptPlaceInContainer @ 0x4e55b0)', () => {
  const SIDE = 0x70000001;
  const GROUND = 0x80009999;
  const with1999 = (w: PlacementWorld): PlacementWorld => ({ ...w, rule: R1999.inventoryPlacement, text: R1999.placementText });

  it('1999 ignores the shown side pack: the main pack, or "<name> is full"', () => {
    const w = makeWorld([pack(SIDE, 24), { id: GROUND }]);
    expect(placeInBackpack(GROUND, SIDE, false, with1999(w))).toEqual({ kind: 'put', containerId: PLAYER, placement: 0 });
    expect(placeInBackpack(GROUND, SIDE, false, w)).toEqual({ kind: 'put', containerId: SIDE, placement: 0 });
    const full = makeWorld([pack(SIDE, 24), ...filler(PLAYER, 2, 0x80002000), { id: GROUND }], { playerItems: 2 });
    expect(placeInBackpack(GROUND, 0, false, with1999(full))).toEqual({ kind: 'refused', notice: 'Tester is full' });
    // End of retail falls back to the side pack with room.
    expect(placeInBackpack(GROUND, 0, false, full)).toEqual({ kind: 'put', containerId: SIDE, placement: 0 });
  });

  it('1999 refuses at the container asked for: a full pack, and a player with no container slots', () => {
    const w = makeWorld([pack(SIDE, 1, 'Sack'), ...filler(SIDE, 1, 0x80001000), { id: GROUND }]);
    expect(attemptToPlaceInContainer(GROUND, SIDE, 0, true, 0, with1999(w))).toEqual({ kind: 'refused', notice: 'The Sack is full' });
    expect(attemptToPlaceInContainer(GROUND, SIDE, 0, true, 0, w)).toEqual({ kind: 'refused', notice: PLACEMENT_FULL_STRINGS.items.replace('%s', 'Sack') });
    const packs = makeWorld([{ ...pack(SIDE, 24), containersCapacity: 0 }, { id: 0x70000002, isContainer: true, holder: true, itemsCapacity: 24, name: 'Pouch' }], { playerContainers: 1 });
    expect(attemptToPlaceInContainer(0x70000002, PLAYER, 0, true, 0, with1999(packs))).toEqual({ kind: 'refused', notice: 'Tester can carry no more containers' });
  });

  it('1999 auto-merges into the main pack\'s own stacks only, and says so when a stack had no room', () => {
    const stack = (id: number, inId: number, n: number) => ({ id, in: inId, weenieClassId: 7, stackSize: n, maxStackSize: 100, name: 'Pyreal' });
    const side = makeWorld([pack(SIDE, 24), stack(0x80003001, SIDE, 10), { ...stack(GROUND, 0, 5), in: undefined }], { splitSize: 5, maxSplitSize: 5, selectedId: GROUND });
    expect(placeInBackpack(GROUND, 0, false, with1999(side))).toEqual({ kind: 'put', containerId: PLAYER, placement: 0 });
    expect(placeInBackpack(GROUND, 0, false, side)).toMatchObject({ kind: 'merge', targetId: 0x80003001 });
    const main = makeWorld([stack(0x80003002, PLAYER, 10), { ...stack(GROUND, 0, 5), in: undefined }], { splitSize: 5, maxSplitSize: 5, selectedId: GROUND });
    expect(placeInBackpack(GROUND, 0, false, with1999(main))).toEqual({ kind: 'merge', targetId: 0x80003002, amount: 5 });
    const tight = makeWorld([stack(0x80003002, PLAYER, 98), { ...stack(GROUND, 0, 5), in: undefined }], { splitSize: 5, maxSplitSize: 5, selectedId: GROUND });
    expect(placeInBackpack(GROUND, 0, false, with1999(tight))).toEqual({ kind: 'put', containerId: PLAYER, placement: 0, notice: 'Too big to merge. Putting in Tester.' });
  });

  it('a 1999 drop on a full main-pack grid refuses instead of spilling into a side pack', () => {
    const w = makeWorld([pack(SIDE, 24), ...filler(PLAYER, 2, 0x80002000), { id: GROUND }], { playerItems: 2 });
    const drop = { itemId: GROUND, cellItemId: 0, listContainerId: PLAYER, cellPlacement: 2, containerList: false };
    expect(acceptItemListDrop(drop, with1999(w))).toEqual({ kind: 'refused', notice: 'Tester is full' });
    expect(acceptItemListDrop(drop, w)).toMatchObject({ kind: 'put', containerId: SIDE });
  });
});

const PLAYER_ID = 0x50000001;
const wearCtx = (equipped: PaperdollEquippedObject[], over: Partial<PaperdollWearContext> = {}): PaperdollWearContext =>
  ({ playerId: PLAYER_ID, equipped, inCombat: false, readyRefusal: null, ...over });

describe('INV-2 (every era) — a double-clicked armor piece is AutoSort, not AutoWield', () => {
  const hauberk = { id: 0x80000010, name: 'Chainmail Hauberk', validLocations: 0x200 | 0x800 | 0x1000, clothingPriority: 0x400 | 0x1000 | 0x2000 };
  it('wears it at the whole valid mask when nothing covers it', () => {
    expect(autoSortDecision(hauberk, wearCtx([]), true)).toEqual({ kind: 'wear', location: 0x1a00 });
  });
  it('refuses with "You must remove your X to wear that" and takes nothing off', () => {
    const sleeves = { id: 0x80000011, name: 'Sleeves', slot: 0x800, validLocations: 0x800, clothingPriority: 0x1000 };
    const r = autoSortDecision(hauberk, wearCtx([sleeves]), true);
    expect(r).toEqual({ kind: 'none', notice: PAPERDOLL_STRINGS.mustRemoveToWear.replace('%s', 'Sleeves') });
  });
  it('jewellery and weapons go on to AutoWield; an unowned piece to the backpack', () => {
    expect(autoSortDecision({ id: 1, name: 'Ring', validLocations: 0xc0000 }, wearCtx([]), true)).toEqual({ kind: 'wield' });
    const covered = autoSortDecision(hauberk, wearCtx([{ id: 2, name: 'Shirt', slot: 0x200, clothingPriority: 0x400 }]), false);
    expect(covered.kind).toBe('backpack');
  });
  it('a request in flight refuses with its line', () => {
    expect(autoSortDecision(hauberk, wearCtx([], { readyRefusal: 'busy' }), true)).toEqual({ kind: 'none', notice: 'busy' });
  });
});

describe('INV-4 / INV-5 — the paperdoll slot drop', () => {
  const ring = { id: 0x80000020, name: 'Gold Ring', validLocations: 0x40000 | 0x80000 };
  const worn = { id: 0x80000021, name: 'Silver Ring', slot: 0x40000, validLocations: 0xc0000 };
  it('1999: a drop on an occupied slot swaps on that side; end of retail refuses silently', () => {
    const y = acceptPaperdollDrop(ring, { kind: 'slot', mask: 0x40000 }, wearCtx([worn], { slotDropSwaps: R1999.paperdollSlotDropSwaps }));
    expect(y).toEqual({ wieldLocation: null, swap: { side: UISlotSide.Left } });
    for (const id of EOR_ERAS) {
      const e = acceptPaperdollDrop(ring, { kind: 'slot', mask: 0x40000 }, wearCtx([worn], { slotDropSwaps: eorRules(id).paperdollSlotDropSwaps }));
      expect(e, id).toEqual({ wieldLocation: null });
    }
  });
  it('1999 has no dual-wield shield slot; end of retail does', () => {
    const sword = { id: 0x80000030, name: 'Sword', validLocations: 0x100000, combatUse: 1 };
    const y = wearCtx([], { dualWieldShieldSlot: R1999.dualWieldShieldSlot });
    expect(acceptPaperdollDrop(sword, { kind: 'slot', mask: 0x200000 }, y)).toEqual({ wieldLocation: null });
    expect(paperdollSlotDragAcceptState(sword, 0x200000, y)).toBe(0x10000041);
    const e = wearCtx([], { dualWieldShieldSlot: eorRules('eor').dualWieldShieldSlot });
    expect(paperdollSlotDragAcceptState(sword, 0x200000, e)).toBe(0x10000040);
    expect(acceptPaperdollDrop(sword, { kind: 'slot', mask: 0x200000 }, e).wieldLocation).not.toBeNull();
  });
});

describe('INV-8 (every era) — ItemHolder::TargetCompatibleWithObject', () => {
  // A lockpick: source contained (8), target remote (0x20 << 16), any type.
  const kit = { name: 'Lockpick', useability: (0x20 << 16) | 0x8, targetType: ItemType.Misc | ItemType.Container, ownedByPlayer: true };
  const chest = { guid: 0x70000099, name: 'Chest', itemType: ItemType.Container, ownedByPlayer: false, isPlayer: false };
  const E = eorRules('eor').useWithTargetText;
  const Y = R1999.useWithTargetText;
  it('a pass prints "Using the X with the Y" (" on " for a player) before the send', () => {
    expect(targetCompatibleWithObject(kit, chest, PLAYER_ID, E)).toEqual({ ok: true, line: 'Using the Lockpick with the Chest' });
    expect(targetCompatibleWithObject(kit, chest, PLAYER_ID, Y)).toEqual({ ok: true, line: 'Using the Lockpick with the Chest' });
    const heal = { name: 'Healing Kit', useability: ((0x8 | 0x2) << 16) | 0x8, targetType: ItemType.Creature, ownedByPlayer: true };
    const bob = { guid: 0x50000002, name: 'Bob', itemType: ItemType.Creature, ownedByPlayer: false, isPlayer: true };
    expect(targetCompatibleWithObject(heal, { ...bob, ownedByPlayer: true }, PLAYER_ID, E).line).toBe('Using the Healing Kit on Bob');
  });
  it('ownership and wield refusals, era wording (1999 ends them with a period)', () => {
    const stone = { name: 'Mana Stone', useability: (0x8 << 16) | 0x8, targetType: ItemType.Armor, ownedByPlayer: true };
    const armor = { guid: 0x70000001, name: 'Helm', itemType: ItemType.Armor, ownedByPlayer: false, isPlayer: false };
    expect(targetCompatibleWithObject(stone, armor, PLAYER_ID, E)).toEqual({ ok: false, line: "You can't use the Mana Stone on what you don't own" });
    expect(targetCompatibleWithObject(stone, armor, PLAYER_ID, Y)).toEqual({ ok: false, line: "You can't use the Mana Stone on what you don't own." });
    const wieldOnly = { ...stone, useability: (0x4 << 16) | 0x8 };
    expect(targetCompatibleWithObject(wieldOnly, armor, PLAYER_ID, Y).line).toBe("You can't use the Mana Stone on what you aren't wielding.");
    expect(leastLimitedTargetUse(wieldOnly.useability)).toBe(0x4);
    const groundSource = { ...stone, ownedByPlayer: false };
    expect(targetCompatibleWithObject(groundSource, { ...armor, ownedByPlayer: true }, PLAYER_ID, E).line).toBe('You must own the Mana Stone to use it');
    expect(targetCompatibleWithObject(groundSource, { ...armor, ownedByPlayer: true }, PLAYER_ID, Y).line).toBe('You must own the Mana Stone to use it.');
  });
  it('the player as target needs the Self target use; a type mismatch names both', () => {
    const me = { guid: PLAYER_ID, name: 'Me', itemType: ItemType.Creature, ownedByPlayer: true, isPlayer: true };
    expect(targetCompatibleWithObject(kit, me, PLAYER_ID, E)).toEqual({ ok: false, line: 'Cannot use the Lockpick on yourself' });
    const food = { guid: 0x80000005, name: 'Apple', itemType: ItemType.Food, ownedByPlayer: true, isPlayer: false };
    expect(targetCompatibleWithObject(kit, food, PLAYER_ID, Y)).toEqual({ ok: false, line: 'Cannot use the Lockpick with the Apple' });
  });
  it('the trade check is end of retail\'s alone', () => {
    const traded = { ...chest, ownedByPlayer: true, beingTraded: true };
    expect(targetCompatibleWithObject(kit, traded, PLAYER_ID, E).line).toBe("You can't use the Lockpick on an item you are trading");
    expect(targetCompatibleWithObject(kit, traded, PLAYER_ID, Y).ok).toBe(true);
  });
});

describe('INV-9 / INV-12 — the target-mode confirmations and the vendor drop', () => {
  it('only end of retail confirms a mana stone / salvage use', () => {
    expect(R1999.targetedUseConfirmations).toBe(false);
    for (const id of EOR_ERAS) expect(eorRules(id).targetedUseConfirmations, id).toBe(true);
  });
  it('a partial split dropped on a vendor sells in 1999 and is refused in end of retail', () => {
    const vendor = { id: 0x70001234, name: 'Shopkeep', weenieClassId: 1, itemType: ItemType.Creature, objectDescFlags: ObjectDescriptionFlag.Vendor, stackSize: 0, maxStackSize: 0, inTrade: false };
    const item = { id: 0x8000aaaa, name: 'Arrow', ownedByPlayer: true, inTrade: false, in3DView: false, weenieClassId: 300, stackSize: 42, maxStackSize: 250 };
    const ctx = (over: Partial<PlaceIn3DContext>): PlaceIn3DContext => ({ playerId: PLAYER_ID, ready: true, dragAmount: 3, splitPartial: true, dragItemOnPlayerOpensSecureTrade: false, playerOnGround: true, groundObjectId: 0, ...over });
    expect(attemptPlaceIn3D(item, vendor, true, ctx({ vendorDropNeedsWholeStack: R1999.vendorDropNeedsWholeStack })).action).toEqual({ kind: 'sell' });
    const eor = attemptPlaceIn3D(item, vendor, true, ctx({ vendorDropNeedsWholeStack: eorRules('eor').vendorDropNeedsWholeStack }));
    expect(eor).toEqual({ action: { kind: 'none' }, notices: ['You must split the stack before selling it.'] });
  });
});
