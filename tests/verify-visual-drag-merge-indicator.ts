/**
 * VISUAL.drag-merge-indicator — what a pack-grid / pack-column cell shows
 * while an item is dragged over it (Jake, AC1999 prod: "when i drag one item
 * over another that it can stack on, is there supposed to be a visual
 * indicator?").
 *
 * Neither retail client marks a mergeable stack specially on the grid:
 *  - End of retail, UIElement_ItemList::ItemList_DragOver @ 004e3400: the
 *    grid's ring 0x10000040 over any cell for a drag that did not leave the
 *    pack column; the pack column's arrow 0x10000046 when the hovered pack
 *    has room, else the circle 0x10000041.
 *  - 1999, the UI_Item draw @ 0x004e7d20 (ring 0x060011f9 / arrow 0x060011f7
 *    / circle 0x060011f8): the ring over any grid cell for a non-pack; the
 *    merge check (ItemHolder_AttemptMergeIsLegal) only decides drops no list
 *    rule covers (a pack over a filled grid cell, an item over a full pack).
 * Before this, our pack grid and pack column showed nothing at all.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CONTAINER_CELL_DRAG_ACCEPT_TEX, DRAG_ACCEPT_INTO, DRAG_ACCEPT_STATE, UIITEM_DRAG_ACCEPT_TEX,
  itemListDragOverState, type ItemListDragOverInput, type ItemListDragWorld,
} from '../packages/renderer/src/ui/UIItemDragAccept.js';
import type { PlacementObject } from '../packages/renderer/src/inventory/ItemHolderPlacement.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { openDat } from './_harness/dat.js';

const RING = DRAG_ACCEPT_STATE.accept;
const CIRCLE = DRAG_ACCEPT_STATE.refuse;
const ARROW = DRAG_ACCEPT_INTO;

const PLAYER = 0x50000001;
const SIDE_PACK = 0x80000100;
const FULL_PACK = 0x80000101;
const ARROWS_A = 0x80000200;
const ARROWS_B = 0x80000201;
const FULL_ARROWS = 0x80000202;
const SWORD = 0x80000203;
const LOOSE_PACK = 0x80000204;

const obj = (id: number, over: Partial<PlacementObject> = {}): PlacementObject => ({
  id, name: 'x', weenieClassId: 1, stackSize: 1, maxStackSize: 1, itemsCapacity: 0, containersCapacity: 0,
  isContainer: false, holder: false, inTrade: false, isPlayer: false, ...over,
});
const OBJECTS = new Map<number, PlacementObject>([
  [PLAYER, obj(PLAYER, { isPlayer: true, isContainer: true, holder: true, itemsCapacity: 102, containersCapacity: 7 })],
  [SIDE_PACK, obj(SIDE_PACK, { isContainer: true, holder: true, itemsCapacity: 24 })],
  [FULL_PACK, obj(FULL_PACK, { isContainer: true, holder: true, itemsCapacity: 1 })],
  [LOOSE_PACK, obj(LOOSE_PACK, { isContainer: true, holder: true, itemsCapacity: 24 })],
  [ARROWS_A, obj(ARROWS_A, { weenieClassId: 300, stackSize: 50, maxStackSize: 250 })],
  [ARROWS_B, obj(ARROWS_B, { weenieClassId: 300, stackSize: 80, maxStackSize: 250 })],
  [FULL_ARROWS, obj(FULL_ARROWS, { weenieClassId: 300, stackSize: 250, maxStackSize: 250 })],
  [SWORD, obj(SWORD, { weenieClassId: 45 })],
]);
const world = (over: { playerItems?: number; playerPacks?: number } = {}): ItemListDragWorld => ({
  object: (id) => OBJECTS.get(id),
  itemsOf: (h) => h === PLAYER ? Array.from({ length: over.playerItems ?? 3 }, (_, i) => 0x81000000 + i)
    : h === FULL_PACK ? [SWORD] : [],
  containersOf: (h) => h === PLAYER ? Array.from({ length: over.playerPacks ?? 2 }, (_, i) => 0x82000000 + i) : [],
});
const drag = (rule: 'eor' | 'ac1999', draggedId: number, containerList: boolean, cellObjectId: number,
  over: Partial<ItemListDragOverInput> = {}): ItemListDragOverInput =>
  ({ rule, draggedId, fromContainerList: false, containerList, cellObjectId, ...over });

describe('end of retail — UIElement_ItemList::ItemList_DragOver @ 004e3400', () => {
  const w = world();
  it('the grid: the ring over every cell, mergeable stack or not (no merge-specific art)', () => {
    expect(itemListDragOverState(w, drag('eor', ARROWS_A, false, ARROWS_B))).toBe(RING); // could merge
    expect(itemListDragOverState(w, drag('eor', ARROWS_A, false, SWORD))).toBe(RING); // could not
    expect(itemListDragOverState(w, drag('eor', ARROWS_A, false, FULL_ARROWS))).toBe(RING);
    expect(itemListDragOverState(w, drag('eor', ARROWS_A, false, 0))).toBe(RING); // an empty cell
    expect(itemListDragOverState(w, drag('eor', LOOSE_PACK, false, SWORD))).toBe(RING); // a pack from the grid
  });
  it('the grid: a drag that left the pack column (DROPITEM_IS_CONTAINER) gets the circle', () => {
    expect(itemListDragOverState(w, drag('eor', SIDE_PACK, false, ARROWS_B, { fromContainerList: true }))).toBe(CIRCLE);
  });
  it('the pack column: the arrow over a pack with room, the circle over a full or empty cell', () => {
    expect(itemListDragOverState(w, drag('eor', ARROWS_A, true, PLAYER))).toBe(ARROW);
    expect(itemListDragOverState(w, drag('eor', ARROWS_A, true, SIDE_PACK))).toBe(ARROW);
    expect(itemListDragOverState(w, drag('eor', ARROWS_A, true, FULL_PACK))).toBe(CIRCLE);
    expect(itemListDragOverState(world({ playerItems: 102 }), drag('eor', ARROWS_A, true, PLAYER))).toBe(CIRCLE);
    expect(itemListDragOverState(w, drag('eor', ARROWS_A, true, 0))).toBe(CIRCLE);
  });
  it('the pack column: a pack-column drag gets the ring', () => {
    expect(itemListDragOverState(w, drag('eor', SIDE_PACK, true, FULL_PACK, { fromContainerList: true }))).toBe(RING);
  });
  it('no object or a shortcut (alias) drag leaves the cell alone', () => {
    expect(itemListDragOverState(w, drag('eor', 0, false, ARROWS_B))).toBeNull();
    expect(itemListDragOverState(w, drag('eor', ARROWS_A, false, ARROWS_B, { isAlias: true }))).toBeNull();
  });
});

describe('AC1999 — the UI_Item draw @ 0x004e7d20', () => {
  const w = world();
  it('the grid: the ring over any cell for a non-pack, mergeable stack or not', () => {
    expect(itemListDragOverState(w, drag('ac1999', ARROWS_A, false, ARROWS_B))).toBe(RING);
    expect(itemListDragOverState(w, drag('ac1999', ARROWS_A, false, SWORD))).toBe(RING);
    expect(itemListDragOverState(w, drag('ac1999', ARROWS_A, false, FULL_ARROWS))).toBe(RING);
    expect(itemListDragOverState(w, drag('ac1999', ARROWS_A, false, 0))).toBe(RING);
  });
  it('the grid: a pack gets the circle (empty cell, or a failed merge onto a filled one)', () => {
    expect(itemListDragOverState(w, drag('ac1999', LOOSE_PACK, false, 0))).toBe(CIRCLE);
    expect(itemListDragOverState(w, drag('ac1999', LOOSE_PACK, false, SWORD))).toBe(CIRCLE);
  });
  it('the pack column: the arrow into a pack with item room; a full pack falls to the merge check (circle)', () => {
    expect(itemListDragOverState(w, drag('ac1999', ARROWS_A, true, SIDE_PACK))).toBe(ARROW);
    expect(itemListDragOverState(w, drag('ac1999', ARROWS_A, true, PLAYER))).toBe(ARROW);
    expect(itemListDragOverState(w, drag('ac1999', ARROWS_A, true, FULL_PACK))).toBe(CIRCLE);
  });
  it('the pack column: a side pack over a side pack is the ring, over the main pack the arrow while it has pack room', () => {
    expect(itemListDragOverState(w, drag('ac1999', LOOSE_PACK, true, SIDE_PACK))).toBe(RING);
    expect(itemListDragOverState(w, drag('ac1999', LOOSE_PACK, true, PLAYER))).toBe(ARROW);
    expect(itemListDragOverState(world({ playerPacks: 7 }), drag('ac1999', LOOSE_PACK, true, PLAYER))).toBe(CIRCLE);
  });
  it('empty pack-column cells: the ring for a pack, the circle for an item', () => {
    expect(itemListDragOverState(w, drag('ac1999', LOOSE_PACK, true, 0))).toBe(RING);
    expect(itemListDragOverState(w, drag('ac1999', ARROWS_A, true, 0))).toBe(CIRCLE);
  });
  it('a shortcut drag or an unknown object leaves the cell alone', () => {
    expect(itemListDragOverState(w, drag('ac1999', ARROWS_A, false, ARROWS_B, { isAlias: true }))).toBeNull();
    expect(itemListDragOverState(w, drag('ac1999', 0x89999999, false, ARROWS_B))).toBeNull();
  });
});

describe('the art and the era rule', () => {
  it('the pack column adds the arrow 0x060011f7 to the ring / circle; the grid keeps the two', () => {
    expect(CONTAINER_CELL_DRAG_ACCEPT_TEX[ARROW]).toBe(0x060011f7);
    expect(CONTAINER_CELL_DRAG_ACCEPT_TEX[RING]).toBe(0x060011f9);
    expect(CONTAINER_CELL_DRAG_ACCEPT_TEX[CIRCLE]).toBe(0x060011f8);
    expect(UIITEM_DRAG_ACCEPT_TEX[ARROW]).toBeUndefined();
  });
  it('1999 takes the 1999 draw; end of retail and the classic eras ItemList_DragOver', () => {
    expect(eraClientRules(eraProfile('ac1999-retail')).itemListDragOver).toBe('ac1999');
    for (const id of ['eor', 'classicace-customdm', 'classic-dereth']) {
      expect(eraClientRules(eraProfile(id)).itemListDragOver, id).toBe('eor');
    }
  });
});

const LOCAL_DAT = resolve(__dirname, '../dat/client_local_English.dat');
const PORTAL_DAT = resolve(__dirname, '../dat/client_portal.dat');
describe.skipIf(!existsSync(LOCAL_DAT) || !existsSync(PORTAL_DAT))('DAT: the cells\' drag-accept elements (0x21000037)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layout: any;
  beforeAll(async () => {
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes } =
      await import('../packages/dat-parser/src/file-types/LayoutDesc.js');
    setMasterPropertyTypes(parseMasterProperty(new DatReader(openDat(PORTAL_DAT).getFileData(0x39000001)!)));
    layout = parseLayoutDesc(new DatReader(openDat(LOCAL_DAT).getFileData(0x21000037)!));
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const top = (id: number): any => [...layout.elements.values()].find((e: { elementId: number }) => e.elementId === id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child = (parent: number, id: number): any => [...(top(parent).children?.values() ?? [])].find((e: { elementId: number }) => e.elementId === id);
  const media = (id: number, state: number) => (top(id).states.get(state)?.media ?? []).map((m: { file?: number }) => m.file);

  it('the grid cell 0x1000033a → 0x1000045d (ring / circle); the pack-column cell 0x1000033e → 0x1000045e (+ arrow)', () => {
    expect(child(0x1000033a, 0x1000045a).baseElement).toBe(0x1000045d);
    expect(child(0x1000033e, 0x1000045a).baseElement).toBe(0x1000045e);
    expect(media(0x1000045d, RING)).toEqual([UIITEM_DRAG_ACCEPT_TEX[RING]]);
    expect(media(0x1000045d, CIRCLE)).toEqual([UIITEM_DRAG_ACCEPT_TEX[CIRCLE]]);
    expect(media(0x1000045d, ARROW)).toEqual([]);
    for (const s of [RING, CIRCLE, ARROW]) expect(media(0x1000045e, s)).toEqual([CONTAINER_CELL_DRAG_ACCEPT_TEX[s]]);
  });
});
