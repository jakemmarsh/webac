/**
 * BUG.updateobject-own-inventory-routed-to-world — behavioral coverage for
 * the shared ObjectCreate (0xF745) / ObjectUpdate (0xF7DB) subject routing.
 *
 * Retail ground truth: SmartBox::HandleUpdateObject @ 00455580 is a tail
 * call into HandleCreateObject(..., is_update=1) — both opcodes take ONE
 * routing path (destroy the existing object, re-create from the wire
 * descs). ACE's routine UpdateObject senders target items inside the
 * recipient's own inventory with the identical wire shape as ObjectCreate
 * (SerializeUpdateObject delegates to SerializeCreateObject):
 *   - Tailoring.cs:504,563  (tailored armor/weapon result)
 *   - Aetheria.cs:241       (aetheria surge level-up)
 *   - RecipeManager.cs:397  (every recipe that modifies a target — dyes,
 *                            imbues, quest combines)
 * so contained subjects arrive with containerId set and NO Position block.
 *
 * Pre-fix, main.ts onObjectUpdate world-routed every subject into
 * ServerObjectManager.createObject: the inventory entry stayed stale and a
 * phantom mesh was scene-added at world origin. These tests execute the
 * shipped routing + entry-building + InventoryManager upsert/reorder that
 * the fixed handler composes (converted from the source-text pin that used
 * to freeze the defective delegation in verify-object-refresh-wiring.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  routeObjectSubject,
  buildInventoryEntry,
} from '../packages/renderer/src/network/objectSubjectRouting';
import { InventoryManager } from '@ac/shared';

const CHAR_GUID = 0x50000001;
const SIDE_PACK = 0x80001234;

const ids = (guid: number, containerId = 0, wielderId = 0) => ({ guid, containerId, wielderId });

/** A contained-item CreateObject/UpdateObject payload slice (no Position block on the wire). */
function containedItem(overrides: Record<string, unknown> = {}) {
  return {
    guid: 0x80005678,
    weenieClassId: 2621, // leather armor-ish
    name: 'Leather Vest',
    pluralName: '',
    value: 120,
    burden: 250,
    stackSize: 0,
    maxStackSize: 0,
    containerId: CHAR_GUID,
    iconId: 0x060013f0,
    validLocations: 0x200,
    itemType: 2, // Armor
    uiEffects: 0,
    usable: 0,
    combatUse: 0,
    iconOverlayId: 0,
    iconUnderlayId: 0,
    ...overrides,
  };
}

describe('BUG.updateobject-own-inventory — subject routing (retail HandleUpdateObject → HandleCreateObject path)', () => {
  it('routes the local player guid to self', () => {
    expect(routeObjectSubject(ids(CHAR_GUID), CHAR_GUID, [])).toBe('self');
  });

  it('routes a subject contained by the player to own-inventory (Tailoring/Recipe target)', () => {
    expect(routeObjectSubject(ids(0x80005678, CHAR_GUID, 0), CHAR_GUID, [])).toBe('own-inventory');
  });

  it('routes a subject wielded by the player to own-inventory', () => {
    expect(routeObjectSubject(ids(0x80005678, 0, CHAR_GUID), CHAR_GUID, [])).toBe('own-inventory');
  });

  it('routes a subject inside a tracked side pack to own-inventory', () => {
    expect(routeObjectSubject(ids(0x80005678, SIDE_PACK, 0), CHAR_GUID, [SIDE_PACK])).toBe('own-inventory');
  });

  it('routes an uncontained subject to world (Hook.cs:175 UpdateObject broadcast)', () => {
    expect(routeObjectSubject(ids(0x80009999, 0, 0), CHAR_GUID, [SIDE_PACK])).toBe('world');
  });

  it('routes a subject contained by someone else to world', () => {
    expect(routeObjectSubject(ids(0x80009999, 0x50000002, 0), CHAR_GUID, [])).toBe('world');
  });

  it('routes everything to world when no ACE character guid is known', () => {
    expect(routeObjectSubject(ids(0x80005678, CHAR_GUID, 0), null, [])).toBe('world');
  });
});

describe('BUG.updateobject-own-inventory — inventory entry building + upsert refresh', () => {
  it('maps CreateObject wire fields onto the inventory entry', () => {
    const entry = buildInventoryEntry(containedItem() as any);
    expect(entry.weenieClassId).toBe(2621);
    expect(entry.name).toBe('Leather Vest');
    expect(entry.containerId).toBe(CHAR_GUID);
    expect(entry.iconDid).toBe(0x060013f0);
    expect(entry.value).toBe(120);
    expect(entry.burden).toBe(250);
    // zero stack fields normalize to 1/1 non-stackable
    expect(entry.stackSize).toBe(1);
    expect(entry.maxStackSize).toBe(1);
    expect(entry.stackable).toBe(false);
    // empty pluralName normalizes to undefined
    expect(entry.pluralName).toBeUndefined();
  });

  it('marks stackables and keeps stack counts', () => {
    const entry = buildInventoryEntry(containedItem({ stackSize: 40, maxStackSize: 100 }) as any);
    expect(entry.stackSize).toBe(40);
    expect(entry.maxStackSize).toBe(100);
    expect(entry.stackable).toBe(true);
  });

  it('an UpdateObject re-add with the same guid refreshes name/icon in place (tailoring result), no duplicate', () => {
    const inv = new InventoryManager();
    const guid = 0x80005678;
    inv.addItem(buildInventoryEntry(containedItem() as any), guid);
    expect(inv.getItem(guid)!.name).toBe('Leather Vest');

    // Tailoring changed the item's identity — same guid, new name + icon.
    inv.addItem(
      buildInventoryEntry(containedItem({ name: 'Amuli Coat', iconId: 0x06001aaa }) as any),
      guid,
    );
    const refreshed = inv.getItem(guid)!;
    expect(refreshed.name).toBe('Amuli Coat');
    expect(refreshed.iconDid).toBe(0x06001aaa);
    // Upsert, not append — still exactly one entry for the guid.
    expect(inv.getAll().filter(i => i.id === guid)).toHaveLength(1);
  });

  it('moves the updated item to the first slot of its container (RecipeManager.cs:407-416 retail-client mimic)', () => {
    const inv = new InventoryManager();
    const a = 0x80000001, b = 0x80000002, c = 0x80000003;
    inv.addItem(buildInventoryEntry(containedItem({ name: 'A' }) as any), a);
    inv.addItem(buildInventoryEntry(containedItem({ name: 'B' }) as any), b);
    inv.addItem(buildInventoryEntry(containedItem({ name: 'C' }) as any), c);
    inv.setPlacementOrder([a, b, c]);

    // UpdateObject for C → upsert then move-to-first, as the handler does.
    inv.addItem(buildInventoryEntry(containedItem({ name: 'C dyed' }) as any), c);
    inv.reorderItem(c, 0);

    expect(inv.getByContainer(CHAR_GUID).map(i => i.id)).toEqual([c, a, b]);
    expect(inv.getByContainer(CHAR_GUID)[0].name).toBe('C dyed');
  });
});

/**
 * RELEASE.gdle-untested-surfaces — GDLE's CContainerWeenie::SpawnInContainer
 * (vendor purchase, quest reward) sends ServerSaysContainId (0x0022) first,
 * then a CreateObject with no container (but a Position), a PickupEvent and
 * the Container PublicUpdateInstanceID (captured live, 2026-10-09). Retail's ServerSaysContainID @ 0058be40 lists the
 * still-unknown item in the container's own list, so the CreateObject lands
 * in the pack. Pre-fix it routed to the world: pyreals spent, nothing bought.
 */
describe('ContainId before CreateObject (GDLE spawn order)', async () => {
  const { PendingContainIds } = await import('../packages/renderer/src/network/objectSubjectRouting');
  const GRAPES = 0x90001502;

  it('a remembered container makes the container-less CreateObject own inventory', () => {
    const pending = new PendingContainIds();
    pending.note(GRAPES, CHAR_GUID);
    // GDLE's record carries a Position; the PickupEvent after it lifts it out of the world.
    const wire = { ...ids(GRAPES), position: { cell: 0xA9B4016A } };
    expect(routeObjectSubject(wire, CHAR_GUID, [SIDE_PACK])).toBe('world');
    const seen = pending.resolve(wire);
    expect(seen.containerId).toBe(CHAR_GUID);
    expect(routeObjectSubject(seen, CHAR_GUID, [SIDE_PACK])).toBe('own-inventory');
    // Consumed: a later re-create of the same guid is routed by its own fields.
    expect(pending.size).toBe(0);
    expect(pending.resolve(wire).containerId).toBe(0);
  });

  it('into a side pack, the item joins that pack', () => {
    const pending = new PendingContainIds();
    pending.note(GRAPES, SIDE_PACK);
    const seen = pending.resolve({ ...ids(GRAPES), position: null });
    expect(routeObjectSubject(seen, CHAR_GUID, [SIDE_PACK])).toBe('own-inventory');
    const inv = new InventoryManager();
    inv.addItem(buildInventoryEntry(containedItem({ guid: GRAPES, containerId: seen.containerId })), GRAPES);
    expect(inv.getByContainer(SIDE_PACK).map((i) => i.id)).toEqual([GRAPES]);
  });

  it('ACE order (CreateObject first, with its container) and wielded objects are left alone', () => {
    const pending = new PendingContainIds();
    // ACE: the CreateObject already names the container; nothing was noted.
    expect(pending.resolve({ ...ids(GRAPES, CHAR_GUID), position: null }).containerId).toBe(CHAR_GUID);
    // A wire record that names its own wielder wins over the note.
    pending.note(GRAPES, CHAR_GUID);
    expect(pending.resolve({ ...ids(GRAPES, 0, 0x50000002), position: null }).containerId).toBe(0);
    // Deleted (or contained elsewhere) before its CreateObject: forgotten.
    pending.note(GRAPES, CHAR_GUID);
    pending.forget(GRAPES);
    expect(pending.resolve({ ...ids(GRAPES), position: null }).containerId).toBe(0);
  });
});
