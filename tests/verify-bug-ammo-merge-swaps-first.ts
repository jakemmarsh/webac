/**
 * BUG.ammo-merge-swaps-first — Jake on AC1999 (prod, 2026-11-01): "if i do try to stack (arrows from my inventory on
 * top of equipped arrows), it seems to initially just swap them, then if i do it again it properly stacks".
 *
 * Retail tries the merge first for an occupied ammo slot in both eras (1999 ItemSlot_AcceptDragObject @ 0x00522830 →
 * PanelUI_AutoWield @ 0x4fee20; end of retail gmPaperDollUI::AcceptDragObject @ 004a3b10 → CPlayerSystem::AutoWield
 * @ 00560a60 → ItemHolder::AttemptMerge @ 005878f0), and so does our decision (acceptPaperdollDrop → resolveAutoWield).
 * The drop resolved the wrong object: a pack cell's drag carried an INDEX into GameUI's inventory snapshot, and
 * main.ts read it back as `playerState.inventory.getAll()[index]`. Any re-sort between the grid's render and the drop
 * (a 0x22 contain-in placing an item at its slot, a merge that empties a stack, a list synced a frame later than
 * the store) named a different object. Retail's drag carries the object id (UIElement_ItemList::ItemList_BeginDrag
 * @ 004e32d0 → CM_Item::SendNotice_BeginDrag(itemID, spellID), which AcceptDragObject reads back), and so does ours now: `dragItemGuid`, and every drop
 * callback / WorldDropSource names the object by id.
 *
 * Also pinned here, per era: the wielded stack the merge needs is known with its wcid / stack / max stack from the
 * era's own CreateObject (end of retail / Dark Majesty: the EoL 0xF745; 1999: the AC1999 server's 0xF745,
 * OldPublicWeenieDesc header 0x1000 / 0x2000, through the shipped 1999 adapter).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EquipMask, resolveAutoWield, UISlotSide } from '@ac/shared';
import {
  BinaryReader, buildStackableMergePayload, deserializeMessage, parseCreateObject, parseCreateObjectFromReader,
  parseStackableMergePayload, type CreateObjectData,
} from '../packages/network/src/MessageSerializer.js';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerObjects1999 } from '../packages/network/src/era1999/codecs/Objects1999.js';
import { Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import { buildInventoryEntry } from '../packages/renderer/src/network/objectSubjectRouting.js';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { acceptPaperdollDrop, type PaperdollWearContext } from '../packages/renderer/src/inventory/PaperdollDragObject.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const PLAYER = 0x50000001;
const AMMO = EquipMask.MissileAmmo; // 0x800000
const F = { StackSize: 0x1000, MaxStackSize: 0x2000, Container: 0x4000, Wielder: 0x8000, ValidLocations: 0x10000, CurrentlyWieldedLocation: 0x20000 };

interface Ammo { guid: number; name: string; wcid: number; stack: number; max: number; wielded?: boolean }
/** ACE-World's Arrow (wcid 300, MaxStackSize 250) and Broadhead Arrow (wcid 301). */
const WIELDED: Ammo = { guid: 0x80000a01, name: 'Arrow', wcid: 300, stack: 50, max: 250, wielded: true };
const PACKED: Ammo = { guid: 0x80000b02, name: 'Arrow', wcid: 300, stack: 20, max: 250 };
const OTHER: Ammo = { guid: 0x80000c03, name: 'Broadhead Arrow', wcid: 301, stack: 10, max: 250 };

/** ACE's 0xF745 (WorldObject_Networking.cs): no model / physics; the weenie header's stack, container or wielder fields. */
function createEoR(a: Ammo): CreateObjectData {
  const b: number[] = [];
  const u8 = (v: number) => b.push(v & 0xff);
  const u16 = (v: number) => { u8(v); u8(v >> 8); };
  const u32 = (v: number) => { u16(v); u16(v >>> 16); };
  const align = () => { while (b.length % 4) u8(0); };
  u32(a.guid);
  u8(0x11); u8(0); u8(0); u8(0); align(); // ObjDesc: nothing
  u32(0); u32(0); // physics flags, state
  for (let i = 0; i < 9; i++) u16(0);
  align();
  u32(F.StackSize | F.MaxStackSize | F.ValidLocations | (a.wielded ? F.Wielder | F.CurrentlyWieldedLocation : F.Container));
  u16(a.name.length); for (const c of a.name) u8(c.charCodeAt(0)); align();
  u16(a.wcid); // PackedDword, 2-byte form
  u16(0x1234); // icon
  u32(0x100); // ItemType.MissileWeapon
  u32(0); // ObjectDescriptionFlags
  align();
  u16(a.stack); u16(a.max);
  u32(PLAYER); // container or wielder
  u32(AMMO);
  if (a.wielded) u32(AMMO);
  align();
  const obj = parseCreateObject(new Uint8Array(b));
  expect(obj).not.toBeNull();
  return obj!;
}

/** The AC1999 server's 0xF745 (ObjectMsgs.cpp BuildPublicWeenieDesc1999 → OldPublicWeenieDesc order), through the shipped 1999 adapter. */
function create1999(a: Ammo): CreateObjectData {
  const w = new Writer1999().u32(0xf745).u32(a.guid);
  w.u8(0x11).u8(0).u8(0).u8(0).align4();
  w.u32(0).u32(0x408);
  for (let i = 0; i < 9; i++) w.u16(0);
  w.align4();
  w.u32(F.StackSize | F.MaxStackSize | F.ValidLocations | (a.wielded ? F.Wielder | F.CurrentlyWieldedLocation : F.Container))
    .acString(a.name).u16(a.wcid).u16(0x1234).u32(0x100).u32(0);
  w.u16(a.stack).u16(a.max);
  w.u32(PLAYER);
  w.u32(AMMO);
  if (a.wielded) w.u32(AMMO);
  const c = emptyCodecs();
  registerObjects1999(c);
  const out = new Adapter1999(c, { account: 'acjs', log: () => {} }).inbound(w.align4().toBytes(), 3);
  const m = deserializeMessage(out[0]);
  if (m.type !== 'direct') throw new Error('not a direct message');
  return parseCreateObjectFromReader(new BinaryReader(m.payload));
}

const ERAS = [
  { id: 'eor', create: createEoR },
  { id: 'classicace-customdm', create: createEoR },
  { id: 'ac1999-retail', create: create1999 },
] as const;

/** main.ts's own-inventory branch of onObjectCreate, its paperdollWearContext and dropHeldOnPaperdoll's merge send. */
function world(eraId: string, create: (a: Ammo) => CreateObjectData) {
  const rules = eraClientRules(eraProfile(eraId));
  const state = new PlayerState();
  const arrive = (a: Ammo) => {
    const data = create(a);
    state.inventory.addItem(buildInventoryEntry(data), data.guid);
    if (data.wielderId === PLAYER && data.currentWieldedLocation) {
      state.equipment.equipItem(state.inventory.getItem(data.guid)!, data.currentWieldedLocation, false);
    }
  };
  const ctx = (): PaperdollWearContext => ({
    playerId: PLAYER, equipped: state.equipment.getAll(), inCombat: false, readyRefusal: null,
    slotDropSwaps: rules.paperdollSlotDropSwaps, dualWieldShieldSlot: rules.dualWieldShieldSlot,
  });
  /** onDropToSlot(guid) → dropHeldOnPaperdoll: the StackableMerge it sends, or null for anything else. */
  const dropOnSlot = (guid: number, mask: number) => {
    const item = state.inventory.getItem(guid);
    if (!item) return null;
    const outcome = acceptPaperdollDrop({ ...item, inTrade: false, dragAmount: item.stackSize }, { kind: 'slot', mask }, ctx());
    return outcome.merge ? parseStackableMergePayload(buildStackableMergePayload(item.id, outcome.merge.targetId, outcome.merge.amount)) : null;
  };
  return { state, arrive, ctx, dropOnSlot };
}

describe('BUG.ammo-merge-swaps-first — the wielded stack is known from the era\'s CreateObject, and the drop merges', () => {
  for (const era of ERAS) {
    describe(era.id, () => {
      it('the wielded arrows carry wcid / stack / max stack into the paperdoll record', () => {
        const w = world(era.id, era.create);
        for (const a of [WIELDED, PACKED, OTHER]) w.arrive(a);
        expect(w.state.equipment.getAll().map((e) => [e.id, e.slot, e.weenieClassId, e.stackSize, e.maxStackSize]))
          .toEqual([[WIELDED.guid, AMMO, 300, 50, 250]]);
        expect(w.state.inventory.getItem(PACKED.guid)).toMatchObject({ weenieClassId: 300, stackSize: 20, maxStackSize: 250 });
      });

      it('same-wcid arrows dropped on the ammo slot merge into the wielded stack (nothing is swapped)', () => {
        const w = world(era.id, era.create);
        for (const a of [WIELDED, PACKED, OTHER]) w.arrive(a);
        expect(w.dropOnSlot(PACKED.guid, AMMO)).toEqual({ mergeFromGuid: PACKED.guid, mergeToGuid: WIELDED.guid, amount: 20 });
        // The double-click's AutoWield (CPlayerSystem::AutoWield / PanelUI_AutoWield) merges the same way.
        const item = w.state.inventory.getItem(PACKED.guid)!;
        const occupied = w.state.equipment.getAll().reduce((m, e) => m | e.slot, 0);
        expect(resolveAutoWield(
          { ...item, validLocations: item.validLocations!, dragAmount: item.stackSize },
          occupied, (bits) => w.state.equipment.getAll().find((e) => (e.slot & bits) !== 0)?.id ?? 0, UISlotSide.Right, true,
          (id) => w.state.equipment.getAll().find((e) => e.id === id),
        )).toEqual({ kind: 'merge', targetId: WIELDED.guid, amount: 20 });
      });

      it('another ammo (a different wcid) is no merge: the slot drop blocks (1999 swaps, end of retail refuses quietly)', () => {
        const w = world(era.id, era.create);
        for (const a of [WIELDED, PACKED, OTHER]) w.arrive(a);
        expect(w.dropOnSlot(OTHER.guid, AMMO)).toBeNull();
        const item = w.state.inventory.getItem(OTHER.guid)!;
        const outcome = acceptPaperdollDrop({ ...item, inTrade: false, dragAmount: item.stackSize }, { kind: 'slot', mask: AMMO }, w.ctx());
        expect(outcome.swap !== undefined).toBe(era.id === 'ac1999-retail');
      });
    });
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const INV_ELEMENT_IDS = [0x100001c6, 0x100001c7, 0x100001c8, 0x100001c9, 0x100001ca, 0x100001cb, 0x100001cc, 0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0];

describe('BUG.ammo-merge-swaps-first — the real GameUI drag carries the object id across a re-sort', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    mod = await import('../packages/renderer/src/ui/GameUI.js');
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });

  function freshUi(eraId: string) {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.setClientRules(eraClientRules(eraProfile(eraId)));
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, host: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        host.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of INV_ELEMENT_IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return { root, elements, setText: () => {}, setVisible: () => {}, setInteractive: () => {}, close: () => { root.remove(); }, destroy: () => { root.remove(); } };
      },
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gridCells = (): any[] => [...ui.inventoryPanelHandle.elements.get(0x100001cf).querySelectorAll('div')].filter((c: any) => c.draggable === true);
  const ammoSlot = (): HTMLElement => ui.inventoryPanelHandle.elements.get(0x100001cd).querySelector('[data-equip-slot="Ammunition"]');
  const fire = (el: HTMLElement, type: string) => el.dispatchEvent(new domWindow.Event(type, { bubbles: true, cancelable: true }));

  for (const era of ERAS) {
    it(`${era.id}: a 0x22 re-sort between the grid's render and the drop still merges the dragged stack`, () => {
      freshUi(era.id);
      const w = world(era.id, era.create);
      for (const a of [WIELDED, OTHER, PACKED]) w.arrive(a);
      const dropped: number[] = [];
      const merges: unknown[] = [];
      ui.setDragCallbacks({
        // main.ts's onDropToSlot: resolve the dragged object, then dropHeldOnPaperdoll.
        onDropToSlot: (guid: number, target: { kind: string; mask?: number }) => {
          dropped.push(guid);
          merges.push(w.dropOnSlot(guid, target.mask ?? 0));
        },
      });
      // The grid as the player sees it: [Broadhead Arrow, Arrow] (the wielded Arrow is on the paperdoll).
      ui.setInventoryData(w.state.inventory.getAll(), w.state.equipment.getAll(), 30, 15000);
      if (!ui.inventoryVisible) ui.toggleInventory();
      const at = ui.inventoryItems.findIndex((i: { id: number }) => i.id === PACKED.guid);
      const cell = gridCells().find((c) => c.dataset.invSlot === String(at));
      expect(cell).toBeTruthy();
      fire(cell, 'dragstart');
      // Mid-drag the server's 0x22s re-slot the pack (IDList::AddAtNum): the store re-sorts and the next frame's
      // sync hands GameUI the new order. The Broadhead Arrow now sits where the carried Arrow was: pre-fix the drop
      // named it, and its AutoWield (another wcid) swapped it in (1999) instead of merging the Arrow.
      w.state.inventory.setSlotForItem(PACKED.guid, 0);
      w.state.inventory.setSlotForItem(WIELDED.guid, 1);
      w.state.inventory.setSlotForItem(OTHER.guid, 2);
      expect(w.state.inventory.getAll()[at]?.id).toBe(OTHER.guid);
      ui.setInventoryData(w.state.inventory.getAll(), w.state.equipment.getAll(), 30, 15000);
      fire(ammoSlot(), 'drop');
      expect(dropped).toEqual([PACKED.guid]);
      expect(merges).toEqual([{ mergeFromGuid: PACKED.guid, mergeToGuid: WIELDED.guid, amount: 20 }]);
    });
  }

  it('the 3D-view / toolbar / item-list drag source names the object, not its place in the list', () => {
    freshUi('eor');
    const w = world('eor', createEoR);
    for (const a of [WIELDED, OTHER, PACKED]) w.arrive(a);
    ui.setInventoryData(w.state.inventory.getAll(), w.state.equipment.getAll(), 30, 15000);
    if (!ui.inventoryVisible) ui.toggleInventory();
    const at = ui.inventoryItems.findIndex((i: { id: number }) => i.id === OTHER.guid);
    fire(gridCells().find((c) => c.dataset.invSlot === String(at)), 'dragstart');
    w.state.inventory.setSlotForItem(PACKED.guid, 0);
    ui.setInventoryData(w.state.inventory.getAll(), w.state.equipment.getAll(), 30, 15000);
    expect(ui.worldDropSource()).toEqual({ kind: 'inventory', guid: OTHER.guid });
  });
});
