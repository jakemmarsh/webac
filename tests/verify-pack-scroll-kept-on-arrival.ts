/**
 * BUG.pack-scroll-resets-on-arrival (every era: shared GameUI) — seen live on
 * the local AC1999 server 2026-11-11: with the main pack scrolled down, an item
 * another player gave put the grid back at the top.
 *
 * webac#27 (3ecacfad9) kept the grid's offset across a rebuild by reading the
 * old grid's scrollTop just before tearing it down. That read is only right
 * while the old grid has a layout box: a browser reads scrollTop 0 for an
 * element that is detached or under display:none, and a panel hidden and
 * shown again started from nothing. Retail's list is one persistent element:
 * gmInventoryUI::RecvNotice_SetDisplayInventory @ 004a6750 re-parents only
 * when another container is shown, ItemList_SetParentContainer @ 004e49d0
 * re-lists the same pack without touching the offset, and only
 * ItemList_OpenContainer @ 004e4ae0 (another container) scrolls home.
 *
 * Now the panel also remembers the offsets each scroll event reports, and a
 * rebuild that cannot read them live (or a re-open) restores those, keyed by
 * the shown pack as before. These cases drive the real GameUI.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { captureScroll, unrestoredScroll } from '../packages/renderer/src/ui/ScrollKeep.js';

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const PLAYER = 0x50000001;
const PACK = 0x8000ff01;

function item(id: number, containerId: number, extra: Record<string, unknown> = {}) {
  return {
    id, weenieClassId: id & 0xffff, name: `Item ${id & 0xff}`, value: 1, burden: 10, iconDid: 0,
    stackSize: 1, maxStackSize: 1, stackable: false, containerId, itemType: 0, ...extra,
  };
}

function stubLayoutRenderer() {
  return {
    renderPanel: (_layoutId: number, container: HTMLElement) => {
      const wrapper = domWindow.document.createElement('div');
      container.appendChild(wrapper);
      const root = domWindow.document.createElement('div');
      wrapper.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      for (const id of [0x100001cc, 0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0]) {
        const el = domWindow.document.createElement('div');
        el.dataset.elementId = `0x${id.toString(16)}`;
        root.appendChild(el);
        elements.set(id, el);
      }
      return { root, elements, setText: () => {}, close: () => { wrapper.remove(); } };
    },
  };
}

describe('BUG.pack-scroll-resets-on-arrival — what enters or leaves the shown pack keeps the grid scroll', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let items: ReturnType<typeof item>[] = [];
  const grid = (): HTMLElement => ui.inventoryPanel.querySelector('[data-scroll-key^="inv-grid:"]') as HTMLElement;
  /** A player's scroll: the offset, then the scroll event the browser sends. */
  const scrollGrid = (top: number): void => {
    const g = grid();
    g.scrollTop = top;
    g.dispatchEvent(new domWindow.Event('scroll'));
  };
  const sync = (list: ReturnType<typeof item>[]): void => { items = list; ui.setInventoryData(list, [], 30, 15000, 102); };

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = stubLayoutRenderer();
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  beforeEach(() => {
    const list: ReturnType<typeof item>[] = [];
    for (let i = 0; i < 35; i++) list.push(item(0x80001000 + i, PLAYER, i === 0 ? { stackable: true, stackSize: 10, maxStackSize: 100 } : {}));
    list.push(item(PACK, PLAYER, { itemType: 0x200, itemsCapacity: 24 }));
    for (let i = 0; i < 20; i++) list.push(item(0x80002000 + i, PACK));
    ui.selectedPackSlot = 0;
    ui.setSidePackGuids([PLAYER, PACK]);
    if (ui.inventoryVisible) ui.toggleInventory();
    ui.inventoryScrollSeen = new Map(); // each case starts from a fresh panel at the top
    sync(list);
    ui.toggleInventory();
  });

  // Every way an object reaches or leaves the shown pack ends in setInventoryData (main.ts syncInventoryUI).
  const arrivals: Array<[string, () => ReturnType<typeof item>[]]> = [
    ['a give / pickup / loot / vendor buy: a new object at the end of the pack', () => [...items, item(0x80009001, PLAYER)]],
    ['an object inserted at the front (1999 Container_InsertInventoryItem slot 0, an UpdateObject reorder)', () => [item(0x80009002, PLAYER), ...items]],
    ['a split: the stack shrinks and a new stack arrives', () => [{ ...items[0], stackSize: 4 }, ...items.slice(1), item(0x80009003, PLAYER, { stackable: true, stackSize: 6, maxStackSize: 100 })]],
    ['a merge: one stack leaves, the other grows', () => [{ ...items[0], stackSize: 11 }, ...items.slice(2)]],
    ['a give away / destroy / consume: an object leaves', () => items.filter((_, i) => i !== 5)],
  ];
  for (const [name, next] of arrivals) {
    it(`${name} keeps the main pack offset`, () => {
      scrollGrid(160);
      const before = grid();
      sync(next());
      expect(grid()).not.toBe(before); // the panel really was rebuilt
      expect(grid().scrollTop).toBe(160);
    });
  }

  it('an object arriving in the shown side pack keeps that pack\'s offset', () => {
    ui.openContainedContainer(PACK);
    expect(grid().dataset.scrollKey).toBe(`inv-grid:${PACK}`);
    scrollGrid(64);
    sync([...items, item(0x80009004, PACK)]);
    expect(grid().scrollTop).toBe(64);
  });

  it('a rebuild whose old grid reads scrollTop 0 (detached / no layout box, as a browser reads it) restores the last scroll it reported', () => {
    scrollGrid(128);
    // A browser reads 0 off an element without a layout box; the live capture finds nothing.
    const desc = Object.getOwnPropertyDescriptor(domWindow.Element.prototype, 'scrollTop')
      ?? Object.getOwnPropertyDescriptor(domWindow.HTMLElement.prototype, 'scrollTop');
    expect(desc?.get).toBeTypeOf('function');
    const old = grid();
    Object.defineProperty(old, 'scrollTop', { configurable: true, get: () => 0, set: (v: number) => desc!.set!.call(old, v) });
    sync([...items, item(0x80009005, PLAYER)]);
    expect(grid()).not.toBe(old);
    expect(grid().scrollTop).toBe(128);
  });

  it('closing the inventory and opening it again keeps the shown pack and its offset (retail\'s list persists)', () => {
    scrollGrid(160);
    ui.toggleInventory();
    expect(ui.inventoryPanel).toBeNull();
    sync([...items, item(0x80009006, PLAYER)]); // an arrival while it is closed
    ui.toggleInventory();
    expect(grid().dataset.scrollKey).toBe(`inv-grid:${PLAYER}`);
    expect(grid().scrollTop).toBe(160);
  });

  it('opening a different pack still starts at the top, and so does coming back (ItemList_OpenContainer → ScrollToShow 0)', () => {
    scrollGrid(160);
    ui.openContainedContainer(PACK);
    expect(grid().scrollTop).toBe(0);
    scrollGrid(32);
    ui.openContainedContainer(PLAYER);
    expect(grid().dataset.scrollKey).toBe(`inv-grid:${PLAYER}`);
    expect(grid().scrollTop).toBe(0);
    // ...also when the switch happens across a close / re-open
    scrollGrid(96);
    ui.toggleInventory();
    ui.openContainedContainer(PACK);
    expect(grid().scrollTop).toBe(0);
  });

  it('a pack scrolled back to the top stays at the top through a re-open', () => {
    scrollGrid(160);
    scrollGrid(0);
    ui.toggleInventory();
    ui.toggleInventory();
    expect(grid().scrollTop).toBe(0);
  });

  it('a kept restore logs nothing (the [ScrollKeep] warning is only for one the browser did not take)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scrollGrid(160);
      sync(items.slice());
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[ScrollKeep]'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('ScrollKeep.unrestoredScroll', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  beforeAll(() => installDomGlobals(domWindow, DOM_GLOBALS, saved));
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('names a matched viewport that is not at its clamped offset, and nothing once it is', () => {
    const root = domWindow.document.createElement('div');
    const vp = domWindow.document.createElement('div');
    vp.dataset.scrollKey = 'grid:1';
    root.appendChild(vp);
    vp.scrollTop = 96;
    const snap = captureScroll(root);
    vp.scrollTop = 0;
    expect(unrestoredScroll(root, snap)).toEqual(['k:grid:1 (at 0, wanted 96)']);
    vp.scrollTop = 96;
    expect(unrestoredScroll(root, snap)).toEqual([]);
    // Clamped: content that scrolls only 64 px is "kept" at 64.
    Object.defineProperty(vp, 'scrollHeight', { value: 160 });
    Object.defineProperty(vp, 'clientHeight', { value: 96 });
    vp.scrollTop = 64;
    expect(unrestoredScroll(root, snap)).toEqual([]);
  });
});
