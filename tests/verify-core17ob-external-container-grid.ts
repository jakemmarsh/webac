/**
 * CORE.17.o.b — the EXTERNAL container panel (chest / bookshelf / corpse)
 * sizes its item list like retail's UIElement_ItemList: fixed to the
 * container's ItemsCapacity when >= 0, visible-area padding at -1.
 *
 * Retail ground truth (decompiled EoL client):
 *  - gmExternalContainerUI::SetGroundObject @ 004cbbd0 (decomp :197431):
 *    ItemList_AddItem(m_topContainer, guid) then
 *    ItemList_OpenContainer(m_topContainer, guid, 1).
 *  - UIElement_ItemList::ItemList_OpenContainer @ 004e4ae0: with a child
 *    list, ItemList_SetParentContainer(childList, guid, 0, 1) — the panel's
 *    item list (element 0x1000006a of layout 0x21000008) is parented to
 *    the ground container.
 *  - ItemList_SetParentContainer @ 004e49d0 → ItemList_UpdateContainerListSize
 *    @ 004e39e0: capacity = pwd._itemsCapacity; a container whose bitfield
 *    lacks Openable (0x1) and is not the player → 0; capacity < 0 →
 *    attribute 0x10000015 = -1 + UpdateEmptySlots (visible-area padding),
 *    else the attribute + UpdateFixedSlots (EXACTLY that many cells).
 *  - ACE: WorldObject_Networking.cs:848-855 sets Openable on an unlocked
 *    Container / Chest / Corpse / Hook / Storage; the world DB carries
 *    ItemsCapacity 10 for bookshelves (1115), 24 for packs, 26 for the
 *    storage chest (9687), -1 for chests / corpses.
 *
 * Pre-fix: ServerObject dropped the capacity byte, the tracker knew no
 * capacity, and renderContainerPanel drew only the occupied cells (or an
 * "Empty" label) — no empty tiles at all, whatever the container's capacity.
 *
 * This suite drives the shipped code: the real ServerObjectManager, the real
 * OpenContainerTracker, and the real GameUI container panel (happy-dom).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { ObjectDescriptionFlag, ContainerType } from '../packages/shared/src/index.js';
import {
  OpenContainerTracker,
  itemListCapacity,
} from '../packages/renderer/src/world/OpenContainerTracker.js';
import type { CreateObjectData } from '@ac/network';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';

const OPENABLE = ObjectDescriptionFlag.Openable;

function makeSOM(): ServerObjectManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
}

function makeCreateData(guid: number, extra: Partial<CreateObjectData>): CreateObjectData {
  return {
    guid, name: 'Bookshelf', weenieClassId: 1115, itemType: 0x200 /* Container */,
    position: null, setupId: 0x02000001, motionTableId: 0, iconId: 0,
    physicsState: 0, objectDescFlags: OPENABLE, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
    containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0,
    validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
    uiEffects: 0, usable: 0, useRadius: 0.6,
    velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0,
    objScale: 1.0, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1.0,
    iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
    ...extra,
  };
}

describe('CORE.17.o.b — ServerObject keeps the CreateObject ItemsCapacity byte', () => {
  it('a bookshelf (10) lands on the world object', () => {
    const som = makeSOM();
    const obj = som.createObject(makeCreateData(0x80001001, { itemsCapacity: 10 }));
    expect(obj).not.toBeNull();
    expect(som.getObject(0x80001001)!.itemsCapacity).toBe(10);
  });

  it('a chest / corpse -1 survives signed', () => {
    const som = makeSOM();
    som.createObject(makeCreateData(0x80001002, { itemsCapacity: -1 }));
    expect(som.getObject(0x80001002)!.itemsCapacity).toBe(-1);
  });

  it('an object with no capacity on the wire keeps the PublicWeenieDesc default 0', () => {
    const som = makeSOM();
    som.createObject(makeCreateData(0x80001003, {}));
    expect(som.getObject(0x80001003)!.itemsCapacity).toBe(0);
  });
});

describe('CORE.17.o.b — itemListCapacity is the ItemList_UpdateContainerListSize rule', () => {
  it('an Openable container keeps its capacity (fixed list)', () => {
    expect(itemListCapacity(OPENABLE, 10)).toBe(10);
  });
  it('an Openable container at -1 pads the visible area', () => {
    expect(itemListCapacity(OPENABLE, -1)).toBe(-1);
  });
  it('a container without the Openable bit is a zero-cell list', () => {
    expect(itemListCapacity(0, 24)).toBe(0);
  });
  it('the player is exempt from the Openable gate', () => {
    expect(itemListCapacity(0, 102, true)).toBe(102);
  });
});

describe('CORE.17.o.b — OpenContainerTracker carries each list\'s capacity', () => {
  const SHELF = 0x80002000;
  const POUCH = 0x80002001;
  const APPLE = 0x80002002;

  it('the ground container\'s capacity is recorded at open and read back through listCapacity', () => {
    const t = new OpenContainerTracker();
    t.viewContents(SHELF, []);
    t.setContainerCapacity(SHELF, OPENABLE, 10);
    expect(t.listCapacity(SHELF)).toBe(10);
  });

  it('an unknown container reads -1 (visible-area padding), never a fixed count', () => {
    const t = new OpenContainerTracker();
    t.viewContents(SHELF, []);
    expect(t.listCapacity(SHELF)).toBe(-1);
    expect(t.listCapacity(0x12345)).toBe(-1);
  });

  it('a nested Openable pack\'s CreateObject capacity rides its item entry', () => {
    const t = new OpenContainerTracker();
    t.viewContents(SHELF, [{ guid: POUCH, containerType: ContainerType.Container }]);
    t.trackCreateObject({
      guid: POUCH, containerId: SHELF, name: 'Leather Pouch', iconDid: 0, stackSize: 1, itemType: 0x200,
      objectDescFlags: OPENABLE, itemsCapacity: 24,
    });
    t.trackCreateObject({ guid: APPLE, containerId: SHELF, name: 'Apple', iconDid: 0, stackSize: 1, itemType: 0x80 });
    const pouch = t.items().find((i) => i.guid === POUCH)!;
    expect(pouch.itemsCapacity).toBe(24);
    expect(t.listCapacity(POUCH)).toBe(24);
    const apple = t.items().find((i) => i.guid === APPLE)!;
    expect(apple.itemsCapacity).toBeUndefined();
  });

  it('the gate applies to a nested container too: no Openable bit → a zero-cell list', () => {
    const t = new OpenContainerTracker();
    t.viewContents(SHELF, [{ guid: POUCH, containerType: ContainerType.Container }]);
    t.trackCreateObject({
      guid: POUCH, containerId: SHELF, name: 'Locked Box', iconDid: 0, stackSize: 1, itemType: 0x200,
      objectDescFlags: 0, itemsCapacity: 24,
    });
    expect(t.listCapacity(POUCH)).toBe(0);
  });

  it('clear() forgets the capacities', () => {
    const t = new OpenContainerTracker();
    t.viewContents(SHELF, []);
    t.setContainerCapacity(SHELF, OPENABLE, 10);
    t.clear();
    expect(t.listCapacity(SHELF)).toBe(-1);
  });
});

/* ================================================================ */
/*  GameUI container panel — the grid's cell count                   */
/* ================================================================ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.17.o.b — GameUI container panel grid (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const SHELF = 0x80003000;
  const POUCH = 0x80003001;
  // CORE.17.o.c — the strip's elements (layout 0x21000008).
  const IDS = [0x10000063, 0x10000064, 0x10000065, 0x10000066, 0x10000067, 0x10000068, 0x10000069, 0x1000006a, 0x1000006b, 0x10000071, 0x10000072];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements,
          setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); }, destroy: () => { root.remove(); },
        };
      },
      render: (_layoutId: number, parent: HTMLElement) => (ui.layoutRenderer.renderPanel(_layoutId, parent)),
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });
  beforeEach(() => { ui.hideContainerPanel(); });

  function panel(): HTMLElement { return ui.containerPanel as HTMLElement; }
  function cells(kind?: 'item' | 'empty'): HTMLElement[] {
    const sel = kind ? `[data-ac-container-cell="${kind}"]` : '[data-ac-container-cell]';
    return [...panel().querySelectorAll(sel)] as HTMLElement[];
  }
  function item(guid: number, name: string, containerId = SHELF, extra: Record<string, unknown> = {}) {
    return { guid, name, iconDid: 0, stackSize: 1, containerId, isContainer: false, ...extra };
  }

  it('a bookshelf (capacity 10) with nothing in it is EXACTLY ten empty tiles — no "Empty" label, no viewport padding', () => {
    ui.showContainerPanel(SHELF, [], 10);
    expect(cells()).toHaveLength(10);
    expect(cells('empty')).toHaveLength(10);
    expect(panel().textContent).not.toContain('Empty');
  });

  it('three items in the ten-cell shelf: three occupied cells + seven empty tiles', () => {
    ui.showContainerPanel(SHELF, [item(1, 'Book A'), item(2, 'Book B'), item(3, 'Book C')], 10);
    expect(cells('item')).toHaveLength(3);
    expect(cells('empty')).toHaveLength(7);
  });

  it('more items than the fixed count never hides one (max with the item count, like the side pack)', () => {
    const many = Array.from({ length: 12 }, (_, i) => item(100 + i, `Book ${i}`));
    ui.showContainerPanel(SHELF, many, 10);
    expect(cells('item')).toHaveLength(12);
    expect(cells('empty')).toHaveLength(0);
  });

  it('a chest / corpse (-1) pads the visible area: the cells the ONE row can show (584 px in the 600-wide dock slot = 18), the item count when there are more', () => {
    // CORE.17.o.c — the list is a single 32-px row (0x1000006a, authored
    // 784x32, 584 wide in the 600-wide dock slot — CORE.17.k.b.b.c.c.a.a.c.a;
    // the stub renders no width, so the slot's reflowed width applies).
    ui.showContainerPanel(SHELF, [], -1);
    expect(cells()).toHaveLength(18); // 584 px of the 600-wide dock slot (CORE.17.k.b.b.c.c.a.a.c.a)
    ui.showContainerPanel(SHELF, Array.from({ length: 7 }, (_, i) => item(200 + i, `Loot ${i}`)), -1);
    expect(cells()).toHaveLength(18); // 584 px of the 600-wide dock slot (CORE.17.k.b.b.c.c.a.a.c.a)
    expect(cells('item')).toHaveLength(7);
    ui.showContainerPanel(SHELF, Array.from({ length: 30 }, (_, i) => item(300 + i, `Loot ${i}`)), -1);
    expect(cells()).toHaveLength(30);
    expect(cells('empty')).toHaveLength(0);
  });

  it('the default (no capacity given) is the padded list', () => {
    ui.showContainerPanel(SHELF, []);
    expect(cells()).toHaveLength(18); // 584 px of the 600-wide dock slot (CORE.17.k.b.b.c.c.a.a.c.a)
  });

  it('a non-openable container (gate → 0) shows only what it holds', () => {
    ui.showContainerPanel(SHELF, [item(1, 'Book A')], 0);
    expect(cells('item')).toHaveLength(1);
    expect(cells('empty')).toHaveLength(0);
  });

  it('a nested pack\'s cell re-parents the row to the PACK\'s own capacity (24); the ground container\'s cell restores its (10)', () => {
    ui.showContainerPanel(SHELF, [], 10);
    ui.setContainerPackGuids([SHELF, POUCH]);
    ui.updateContainerItems([
      item(POUCH, 'Leather Pouch', SHELF, { isContainer: true, itemsCapacity: 24 }),
      item(5, 'Emerald', POUCH),
    ]);
    expect(cells()).toHaveLength(10);
    const tabs = [...panel().querySelectorAll('[data-ac-container-tab]')] as HTMLElement[];
    tabs[1].dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(cells()).toHaveLength(24);
    expect(cells('item')).toHaveLength(1);
    const back = [...panel().querySelectorAll('[data-ac-container-tab]')] as HTMLElement[];
    back[0].dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(cells()).toHaveLength(10);
  });

  it('updateContainerItems keeps the capacity the panel was opened with', () => {
    ui.showContainerPanel(SHELF, [], 10);
    ui.updateContainerItems([item(1, 'Book A')]);
    expect(cells()).toHaveLength(10);
  });

  it('every cell is the 32-px item cell of the retail list (element 0x1000006a is 32 px tall)', () => {
    ui.showContainerPanel(SHELF, [item(1, 'Book A')], 10);
    for (const c of cells()) { expect(c.style.width).toBe('32px'); expect(c.style.height).toBe('32px'); }
  });
});
