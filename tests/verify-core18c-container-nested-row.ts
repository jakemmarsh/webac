/**
 * CORE.18.c — the open-container strip's nested-container row.
 *
 * Retail frame (real client, @create 143 Chest, Use):
 * verification/retail-client/ab/retail-container-open.png — the chest's own
 * cell carries the selection ants, and m_containerList (0x10000067) shows 13
 * EMPTY 36-px cells even though a chest has no side packs. Ground truth:
 *  - gmExternalContainerUI::SetGroundObject @ 004cbbd0:
 *    ItemList_SetParentContainer(m_containerList, guid, 0, 1) →
 *    ItemList_UpdateContainerListSize @ 004e39e0 reads the ground object's
 *    pwd._containersCapacity (containerList set); < 0 → attribute
 *    0x10000015 = -1 + UpdateEmptySlots @ 004e3700, whose p95 = -1 arm
 *    appends (viewW − n·cellW) / cellW empty UIItems (state 0x1000001c).
 *    The dock's 480-px list over the 36-px cell template 0x1000033f = 13.
 *  - PublicWeenieDesc::UnPack @ 005ad470 reads _containersCapacity as a
 *    SIGNED char, like _itemsCapacity.
 *  - The cell template 0x1000033f's icon (template 0x1000033e, 32x32 at
 *    (2,2)) draws 0x06000f6e in the empty state; its overlays child
 *    (base 0x10000346) draws the ants 0x06004d09 on the selected object.
 *  - UIElement_ItemList::ListenToElementMessage @ 004e4d50: message 7 on any
 *    UIItem calls ACCWeenieObject::SetSelectedObject(itemID).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { parseCreateObject } from '../packages/network/src/MessageSerializer.js';
import { OpenContainerTracker, horizontalListCellCount } from '../packages/renderer/src/world/OpenContainerTracker.js';
import { ObjectDescriptionFlag } from '@ac/shared';

/* ================================================================ */
/*  1. The wire: _containersCapacity is a signed byte                */
/* ================================================================ */

class Writer {
  private bytes: number[] = [];
  private get pos(): number { return this.bytes.length; }
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  align(boundary = 4): this { const rem = this.pos % boundary; if (rem !== 0) for (let i = 0; i < boundary - rem; i++) this.u8(0); return this; }
  string16(s: string): this {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    const rem = (2 + s.length) % 4;
    if (rem !== 0) for (let i = 0; i < 4 - rem; i++) this.u8(0);
    return this;
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.bytes); }
}

const FLAG_ITEMS_CAPACITY = 0x2;
const FLAG_CONTAINERS_CAPACITY = 0x4;
const FLAG_VALUE = 0x8;

function chestPayload(weenieFlags: number, itemsCapacity: number, containersCapacity: number, value = 0): Uint8Array {
  const w = new Writer();
  w.u32(0x80036666);
  w.u8(0x11).u8(0).u8(0).u8(0);
  w.align(4);
  w.u32(0); w.u32(0);
  for (let i = 0; i < 9; i++) w.u16(0);
  w.align(4);
  w.u32(weenieFlags);
  w.string16('Chest');
  w.u16(143); // weenieClassId
  w.u16(1); // iconId
  w.u32(0x200); // Container
  w.u32(ObjectDescriptionFlag.Openable);
  w.align(4);
  if (weenieFlags & FLAG_ITEMS_CAPACITY) w.u8(itemsCapacity);
  if (weenieFlags & FLAG_CONTAINERS_CAPACITY) w.u8(containersCapacity);
  if (weenieFlags & FLAG_VALUE) w.u32(value);
  w.align(4);
  return w.toUint8Array();
}

describe('CORE.18.c — parseCreateObject captures WeenieHeaderFlag.ContainersCapacity (signed)', () => {
  it('a chest\'s world-DB -1 arrives as 0xff and decodes to -1; the fields after it stay aligned', () => {
    const obj = parseCreateObject(chestPayload(FLAG_ITEMS_CAPACITY | FLAG_CONTAINERS_CAPACITY | FLAG_VALUE, 0xff, 0xff, 1234));
    expect(obj!.itemsCapacity).toBe(-1);
    expect(obj!.containersCapacity).toBe(-1);
    expect(obj!.value).toBe(1234);
  });
  it('a positive count (house Storage: 1) reads as itself', () => {
    const obj = parseCreateObject(chestPayload(FLAG_CONTAINERS_CAPACITY, 0, 1));
    expect(obj!.containersCapacity).toBe(1);
  });
  it('absent flag → 0, the UnPack default', () => {
    const obj = parseCreateObject(chestPayload(0, 0, 0));
    expect(obj!.containersCapacity).toBe(0);
  });
});

/* ================================================================ */
/*  2. The size rule                                                 */
/* ================================================================ */

describe('CORE.18.c — horizontalListCellCount (UpdateFixedSlots / UpdateEmptySlots p95 = -1)', () => {
  it('-1 pads the view: 480 px of 36-px cells = 13 whatever fits under it', () => {
    expect(horizontalListCellCount(0, -1, 480, 36)).toBe(13);
    expect(horizontalListCellCount(2, -1, 480, 36)).toBe(13);
    expect(horizontalListCellCount(13, -1, 480, 36)).toBe(13);
    expect(horizontalListCellCount(20, -1, 480, 36)).toBe(20);
    // The item row: 584 px of 32-px cells = 18.
    expect(horizontalListCellCount(1, -1, 584, 32)).toBe(18);
  });
  it('a fixed capacity is exactly that many cells (never fewer than listed)', () => {
    expect(horizontalListCellCount(0, 1, 480, 36)).toBe(1);
    expect(horizontalListCellCount(0, 0, 480, 36)).toBe(0);
    expect(horizontalListCellCount(3, 1, 480, 36)).toBe(3);
  });
  it('OpenContainerTracker resolves the nested list capacity through the Openable gate', () => {
    const t = new OpenContainerTracker();
    t.setContainerCapacity(1, ObjectDescriptionFlag.Openable, -1, -1);
    t.setContainerCapacity(2, 0, -1, -1); // locked / not Openable → a zero-cell list
    t.setContainerCapacity(3, ObjectDescriptionFlag.Openable, 26, 1);
    t.setContainerCapacity(4, ObjectDescriptionFlag.Openable, 10); // unknown containers capacity
    expect([1, 2, 3, 4, 5].map(g => t.containerListCapacity(g))).toEqual([-1, 0, 1, -1, -1]);
    expect(t.listCapacity(3)).toBe(26);
    t.clear();
    expect(t.containerListCapacity(3)).toBe(-1);
  });
});

/* ================================================================ */
/*  3. GameUI behaviour                                              */
/* ================================================================ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'WheelEvent'] as const;

describe('CORE.18.c — the strip\'s nested row pads with empty cells; the selection draws its ants (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const CHEST = 0x80004000;
  const POUCH = 0x80004001;
  const IDS = [0x10000063, 0x10000064, 0x10000065, 0x10000066, 0x10000067, 0x10000068, 0x10000069, 0x1000006a, 0x1000006b, 0x10000071, 0x10000072];
  let taken: number[] = [];
  let toolbarSelections: number[] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      render: (_layoutId: number, parent: HTMLElement) => {
        const wrapper = domWindow.document.createElement('div');
        parent.appendChild(wrapper);
        const root = domWindow.document.createElement('div');
        wrapper.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of IDS) {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements,
          setText: () => {}, setTexture: () => {},
          setInteractive: (id: number, fn?: () => void) => { if (fn) elements.get(id)?.addEventListener('click', fn); },
          setVisible: () => {}, resizeSubtree: () => {}, onClick: () => {},
          destroy: () => { wrapper.remove(); },
        };
      },
    };
    // DAT textures by id (the real client decodes them from portal.dat).
    ui.uiTextures.set(0x06000f6e, 'data:tex/0x06000f6e');
    ui.uiTextures.set(0x06004d09, 'data:tex/0x06004d09');
    ui.setContainerCallbacks({ onTakeItem: (guid: number) => { taken.push(guid); } });
    ui.onInventorySelectionToToolbar = (guid: number) => { toolbarSelections.push(guid); };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });
  beforeEach(() => {
    ui.hideContainerPanel();
    ui.hudState.setTarget(null);
    taken = []; toolbarSelections = [];
  });

  function el(id: number): HTMLElement { return ui.containerPanelHandle.elements.get(id) as HTMLElement; }
  function nestedCells(): HTMLElement[] { return [...el(0x10000067).querySelectorAll('[data-ac-container-tab], [data-ac-container-pack-empty]')] as HTMLElement[]; }
  const kind = (c: HTMLElement) => (c.dataset.acContainerPackEmpty ? 'empty' : c.dataset.acContainerTab);
  function ants(): HTMLElement[] { return [...ui.containerPanel.querySelectorAll('[data-slot-state="selected"]')] as HTMLElement[]; }
  function item(guid: number, name: string, containerId = CHEST, extra: Record<string, unknown> = {}) {
    return { guid, name, iconDid: 0, stackSize: 1, containerId, isContainer: false, ...extra };
  }
  function click(target: HTMLElement): void { target.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true })); }
  function dblclick(target: HTMLElement): void { target.dispatchEvent(new domWindow.MouseEvent('dblclick', { bubbles: true })); }

  it('a chest (ContainersCapacity -1) with no nested packs shows 13 empty 36-px cells in m_containerList, each the 0x06000f6e recess at (2,2)', () => {
    ui.showContainerPanel(CHEST, [], -1, { name: 'Chest' }, -1);
    const cells = nestedCells();
    expect(cells).toHaveLength(13);
    for (const c of cells) {
      expect(kind(c)).toBe('empty');
      expect([c.style.width, c.style.height]).toEqual(['36px', '36px']);
      const inset = c.firstElementChild as HTMLElement;
      expect([inset.style.left, inset.style.top, inset.style.width, inset.style.height]).toEqual(['2px', '2px', '32px', '32px']);
      expect(inset.style.backgroundImage).toContain('0x06000f6e');
    }
    const strip = el(0x10000067).querySelector('[data-ac-container-packs]') as HTMLElement;
    expect(strip.style.width).toBe(`${13 * 36}px`);
  });

  it('nested packs fill the first cells and the padding keeps the row at 13; the empties never select or open', () => {
    ui.showContainerPanel(CHEST, [], -1, { name: 'Chest' }, -1);
    ui.setContainerPackGuids([CHEST, POUCH]);
    ui.updateContainerItems([item(POUCH, 'Pouch', CHEST, { isContainer: true, itemsCapacity: 24 })]);
    const cells = nestedCells();
    expect(cells.map(kind)).toEqual([String(POUCH), ...Array(12).fill('empty')]);
    click(cells[5]);
    expect(ui.hudState.target).toBeNull();
    expect(nestedCells()[0].dataset.acContainerOpen).toBeUndefined();
  });

  it('a fixed nested capacity (house Storage: 1) is exactly that many cells; 0 (not Openable) none', () => {
    ui.showContainerPanel(CHEST, [], 26, { name: 'Storage' }, 1);
    expect(nestedCells().map(kind)).toEqual(['empty']);
    ui.showContainerPanel(CHEST, [], 0, { name: 'Locked Chest' }, 0);
    expect(nestedCells()).toHaveLength(0);
  });

  it('the ground container\'s cell carries the ants 0x06004d09 while it is the selection (opened from a world selection)', () => {
    ui.hudState.setTarget({ id: CHEST, name: 'Chest', level: 0, healthFraction: 0, distance: 2, type: 'item' });
    ui.showContainerPanel(CHEST, [item(1, 'Apple')], -1, { name: 'Chest', iconDid: 0 }, -1);
    const a = ants();
    expect(a).toHaveLength(1);
    expect(a[0].style.backgroundImage).toContain('0x06004d09');
    expect([a[0].style.width, a[0].style.height]).toEqual(['32px', '32px']);
    const top = el(0x10000064).firstElementChild as HTMLElement;
    expect(top.contains(a[0])).toBe(true);
  });

  it('a click on a row item selects it (SetSelectedObject): the ants move onto it in place, and the same cell still takes on double-click', () => {
    ui.hudState.setTarget({ id: CHEST, name: 'Chest', level: 0, healthFraction: 0, distance: 2, type: 'item' });
    ui.showContainerPanel(CHEST, [item(1, 'Apple'), item(2, 'Pear')], -1, { name: 'Chest' }, -1);
    const pear = el(0x1000006a).querySelectorAll('[data-ac-container-cell="item"]')[1] as HTMLElement;
    click(pear);
    expect(ui.hudState.target.id).toBe(2);
    expect(toolbarSelections).toEqual([2]);
    const a = ants();
    expect(a).toHaveLength(1);
    expect(pear.contains(a[0])).toBe(true);
    // Not rebuilt: the clicked node is still in the panel, so a double-click on it takes the item.
    expect(ui.containerPanel.contains(pear)).toBe(true);
    dblclick(pear);
    expect(taken).toEqual([2]);
  });

  it('a click on the ground container\'s cell selects it too; a selection elsewhere clears the strip\'s ants', () => {
    ui.showContainerPanel(CHEST, [item(1, 'Apple')], -1, { name: 'Chest' }, -1);
    expect(ants()).toHaveLength(0);
    click(el(0x10000064).firstElementChild as HTMLElement);
    expect(ui.hudState.target.id).toBe(CHEST);
    expect(ants()).toHaveLength(1);
    // The world selection moves to a creature: the next HUD tick drops the ants.
    ui.hudState.setTarget({ id: 0x50000001, name: 'Drudge', level: 5, healthFraction: 1, distance: 9, type: 'creature' });
    ui.refreshContainerSelectionAnts();
    expect(ants()).toHaveLength(0);
  });
});

describe('CORE.18.c — the strip\'s open-container arrow paints over the icon (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const CHEST = 0x80004100;
  const IDS = [0x10000063, 0x10000064, 0x10000065, 0x10000066, 0x10000067, 0x10000068, 0x10000069, 0x1000006a, 0x1000006b, 0x10000071, 0x10000072];
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      render: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of IDS) { const el = domWindow.document.createElement('div'); root.appendChild(el); elements.set(id, el); }
        return {
          root, elements, setText: () => {}, setTexture: () => {}, setInteractive: () => {},
          setVisible: () => {}, resizeSubtree: () => {}, onClick: () => {}, destroy: () => { root.remove(); },
        };
      },
    };
    ui.uiTextures.set(0x06005d9c, 'data:tex/0x06005d9c');
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('the ground container\'s open cell carries 0x06005d9c as its LAST child (0x10000450 after the icon 0x10000340), not as the cell background', () => {
    ui.showContainerPanel(CHEST, [], -1, { name: 'Chest' }, -1);
    const cell = ui.containerPanelHandle.elements.get(0x10000064).firstElementChild as HTMLElement;
    const arrow = cell.lastElementChild as HTMLElement;
    expect(arrow.dataset.acOpenPackArrow).toBe('1');
    expect(arrow.style.backgroundImage).toContain('0x06005d9c');
    expect([arrow.style.left, arrow.style.top, arrow.style.width, arrow.style.height]).toEqual(['0px', '0px', '36px', '36px']);
    expect(cell.style.backgroundImage).toBe('');
  });
});
