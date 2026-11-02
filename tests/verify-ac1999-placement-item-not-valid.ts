/**
 * BUG.ac1999-placement-item-not-valid — a live AC1999 player (2026-11-02 05:28:52Z, build
 * a8cf42468e84) got "The item to be placed in the _ is not valid": the 1999
 * ItemHolder_AttemptPlaceInContainerIsLegal @ 0x004e57b0 head (placementLegalHead1999) refuses an
 * item its object() does not resolve. Retail reads the client's one object table (every object the
 * server created and has not deleted). Ours read the world records and the kept world CreateObject,
 * never the CreateObject of an object created without a world record (NonWorldObjectRecords), so
 * an object known only by that read as unknown. The sweep: end of retail's _IsItemLegal @ 005870c0
 * says "That item is not valid!" for the same miss, where ours refused in silence; and the
 * placement refusals now carry the selection / pending-request context. Every case runs the
 * shipped modules.
 */
import { describe, it, expect } from 'vitest';
import type { CreateObjectData } from '../packages/network/src/MessageSerializer.js';
import { ObjectDescriptionFlag } from '../packages/shared/src/index.js';
import { placementObjectFromRecords, type PlacementRecord } from '../packages/renderer/src/inventory/PlacementObjectOf.js';
import {
  attemptToPlaceInContainer, placementLegalHead1999, isItemLegalHead, acceptItemListDrop,
  ITEM_LEGAL_STRINGS, type PlacementObject, type PlacementWorld,
} from '../packages/renderer/src/inventory/ItemHolderPlacement.js';
import { NonWorldObjectRecords } from '../packages/renderer/src/world/NonWorldObjectRecords.js';
import { eraProfile, EOR_ERA_ID } from '../packages/renderer/src/era/EraProfiles.js';
import { eraClientRules, type EraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { castRefusalDetail, selectionRefusalDetail, cleanRefusalDetail } from '../packages/renderer/src/telemetry/RefusalTemplates.js';

const PLAYER = 0x50000001;
const CHEST = 0x7a000001;
const STUCK_STATUE = 0x80000101; // a Stuck object in the chest: no kept world record (WorldObjectRecords skips it)
const GEM = 0x80000102; // a plain item the server listed but never created
const AC1999 = eraClientRules(eraProfile('ac1999-retail'));
const EOR = eraClientRules(eraProfile(EOR_ERA_ID));
const DM = eraClientRules(eraProfile('classic-dereth'));

const player: PlacementObject = {
  id: PLAYER, name: 'Tester', weenieClassId: 0, stackSize: 0, maxStackSize: 0, itemsCapacity: 102, containersCapacity: 7,
  isContainer: true, holder: true, inTrade: false, isPlayer: true,
};

/** A world as main.ts builds it: the player, then the object table's three parts (placementObjectFromRecords). */
function worldOf(rules: EraClientRules, records: Map<number, { world?: PlacementRecord; kept?: PlacementRecord; created?: PlacementRecord }>,
  openContainer: ReadonlySet<number> = new Set()): PlacementWorld {
  return {
    playerId: PLAYER,
    object: (id) => (id === PLAYER ? player
      : placementObjectFromRecords(id, records.get(id) ?? {}, { inTrade: false, inOpenContainer: openContainer.has(id) })),
    itemsOf: () => [], containersOf: () => [],
    splitSize: 1, maxSplitSize: 1, objectSplitSize: () => 1, dragSplit: () => ({ amount: 1, partial: false }),
    text: rules.placementText, rule: rules.inventoryPlacement,
  };
}

describe('BUG.ac1999-placement-item-not-valid — the placement reads the whole object table', () => {
  it('an object known only by its CreateObject (no world record, no kept record) resolves', () => {
    const rec = new NonWorldObjectRecords();
    rec.remember({
      guid: STUCK_STATUE, name: 'Statuette', weenieClassId: 42, stackSize: 1, maxStackSize: 1,
      objectDescFlags: ObjectDescriptionFlag.Stuck, itemType: 0x80, containerId: CHEST, wielderId: 0, currentWieldedLocation: 0,
    } as unknown as CreateObjectData);
    const made = rec.get(STUCK_STATUE)!;
    expect(made.name).toBe('Statuette');
    const o = placementObjectFromRecords(STUCK_STATUE, { created: { ...made, wieldedLocation: made.currentWieldedLocation } },
      { inTrade: false, inOpenContainer: false })!;
    expect(o).toMatchObject({ id: STUCK_STATUE, name: 'Statuette', weenieClassId: 42, stuck: true, contained: true, isContainer: false });
    // _IsItemLegal: stuck but in a container — legal (retail: BF_STUCK && containerID == 0 && wielderID == 0).
    expect(isItemLegalHead(STUCK_STATUE, worldOf(EOR, new Map([[STUCK_STATUE, { created: made }]])))).toBeNull();
    // Deleted: forgotten, so unknown again.
    rec.forget(STUCK_STATUE);
    expect(rec.get(STUCK_STATUE)).toBeUndefined();
    expect(placementObjectFromRecords(STUCK_STATUE, { created: rec.get(STUCK_STATUE) }, { inTrade: false, inOpenContainer: false })).toBeUndefined();
  });

  it('the world record wins over the kept and created records; a kept record alone reads as before', () => {
    const world: PlacementRecord = { name: 'Hook', objectDescFlags: 0x1, itemsCapacity: 1, hookItemTypes: 0x2, houseOwnerId: PLAYER, wielderId: 0 };
    const kept: PlacementRecord = { name: 'Old name', itemsCapacity: 5, hookItemTypes: 0x8 };
    const both = placementObjectFromRecords(9, { world, kept, created: { name: 'Created', hookItemTypes: 0x40 } }, { inTrade: true, inOpenContainer: false })!;
    expect(both).toMatchObject({ name: 'Hook', itemsCapacity: 1, hookItemTypes: 0x2, houseOwnerId: PLAYER, holder: true, inTrade: true, contained: false });
    // The kept world CreateObject alone (a ground object): no hook / wield fields, contained only in the open container.
    const keptOnly = placementObjectFromRecords(9, { kept: { name: 'Gem', containerId: CHEST, stackSize: 3, maxStackSize: 10 } }, { inTrade: false, inOpenContainer: false })!;
    expect(keptOnly).toMatchObject({ name: 'Gem', stackSize: 3, maxStackSize: 10, hookItemTypes: 0, houseOwnerId: 0, contained: false, wieldedLocation: 0 });
    expect(placementObjectFromRecords(9, { kept: { name: 'Gem' } }, { inTrade: false, inOpenContainer: true })!.contained).toBe(true);
  });

  it('1999: a pick-up of an object known only by its CreateObject goes out; one the client never had keeps the retail line', () => {
    const records = new Map([[STUCK_STATUE, { created: { name: 'Statuette', weenieClassId: 42, stackSize: 1, maxStackSize: 1, containerId: CHEST } }]]);
    const w = worldOf(AC1999, records, new Set([STUCK_STATUE]));
    expect(placementLegalHead1999(STUCK_STATUE, PLAYER, w)).toBeNull();
    expect(attemptToPlaceInContainer(STUCK_STATUE, PLAYER, 0, true, 0, w)).toEqual({ kind: 'put', containerId: PLAYER, placement: 0 });
    // An id the server listed but never created: retail's ObjMgr has no object either — the 1999 line stays.
    expect(attemptToPlaceInContainer(GEM, PLAYER, 0, true, 0, w)).toEqual({ kind: 'refused', notice: 'The item to be placed in the Tester is not valid' });
  });

  it('end of retail and Dark Majesty: an unknown object says "That item is not valid!" (was a silent refusal); nothing is sent', () => {
    for (const rules of [EOR, DM]) {
      const w = worldOf(rules, new Map());
      expect(isItemLegalHead(GEM, w)).toBe(ITEM_LEGAL_STRINGS.invalid);
      expect(attemptToPlaceInContainer(GEM, PLAYER, 0, true, 0, w)).toEqual({ kind: 'refused', notice: 'That item is not valid!' });
      // Known only by its CreateObject: placed.
      const known = worldOf(rules, new Map([[GEM, { created: { name: 'Gem', weenieClassId: 7, stackSize: 1, maxStackSize: 1, containerId: CHEST } }]]));
      expect(attemptToPlaceInContainer(GEM, PLAYER, 0, true, 0, known)).toEqual({ kind: 'put', containerId: PLAYER, placement: 0 });
      // The item-list drop keeps its own silent refusal for an unknown drag (nothing sent either way).
      expect(acceptItemListDrop({ itemId: GEM, cellItemId: 0, listContainerId: PLAYER, cellPlacement: 0, containerList: false }, w)).toEqual({ kind: 'refused' });
    }
    // The player is still "You cannot place yourself within a container!" (it is always known).
    expect(isItemLegalHead(PLAYER, worldOf(EOR, new Map()))).toBe(ITEM_LEGAL_STRINGS.self);
  });

  it('a placement refusal carries where the selection resolves; the cast detail is unchanged', () => {
    const placeOf = (g: number) => (g === GEM ? { place: 'unknown' as const } : { place: 'world' as const, itemType: 0x80 });
    expect(selectionRefusalDetail({ selectedGuid: GEM, prevSelectedGuid: 0, msSinceSelectionChange: 10, placeOf })).toEqual({ selection: 'unknown' });
    expect(selectionRefusalDetail({ selectedGuid: 0, prevSelectedGuid: CHEST, msSinceSelectionChange: 1234.4, placeOf }))
      .toEqual({ selection: 'none', prevSelection: 'world', prevSelectionType: 0x80, selectionGoneMs: 1234 });
    // With the pending part, through the page-side validation the reporter applies.
    expect(cleanRefusalDetail({ pending: 'put_in_container', pendingMs: 102, ...selectionRefusalDetail({ selectedGuid: GEM, prevSelectedGuid: 0, msSinceSelectionChange: null, placeOf }) }))
      .toEqual({ pending: 'put_in_container', pendingMs: 102, selection: 'unknown' });
    expect(castRefusalDetail({ spellTargetType: 0x10, selectedGuid: CHEST, prevSelectedGuid: 0, msSinceSelectionChange: null, placeOf }))
      .toEqual({ spellTargetType: 0x10, selection: 'world', selectionType: 0x80 });
  });
});
