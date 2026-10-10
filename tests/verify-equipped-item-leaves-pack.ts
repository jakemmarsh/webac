/**
 * BUG.equipped-item-stays-in-pack — equipping an item takes it out of the
 * pack grid: a wielded item is in no pack (retail ServerSaysMoveItem for a
 * wield: container 0, wielder = the player), it shows on the paperdoll. Our
 * pack record keeps its containerId through a live equip, so the grid asks
 * the equipment model. Unequipping puts it back. Real GameUI in happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const HAPPY_DOM_PKG = ['happy', 'dom'].join('-');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let domWindow: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ HAPPY_DOM_PKG);
  domWindow = new mod.Window({ innerWidth: 1600, innerHeight: 900 });
} catch { /* skip */ }
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const INVENTORY_ELEMENT_IDS = [0x100001d0, 0x100001cd, 0x100001ce, 0x100001cf];
class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } }

describe.skipIf(!domWindow)('equipped items leave the pack grid (real GameUI)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const ME = 0x50000003;
  const dirk = { id: 0x80000f4f, weenieClassId: 23320, name: 'Rusted Dirk', value: 5, burden: 50, stackSize: 1, maxStackSize: 1, stackable: false, containerId: ME, validLocations: 0x100000 };
  const apple = { id: 0x800009e4, weenieClassId: 258, name: 'Apple', value: 7, burden: 50, stackSize: 1, maxStackSize: 1, stackable: false, containerId: ME };
  const gridNames = () => [...domWindow.document.querySelectorAll('[data-inv-slot]')].map((c: HTMLElement) => c.dataset.acTooltipText ?? '');
  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    saved.MutationObserver = g.MutationObserver; saved.ResizeObserver = g.ResizeObserver;
    g.MutationObserver = NoopObserver; g.ResizeObserver = NoopObserver;
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_id: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of INVENTORY_ELEMENT_IDS) { const el = domWindow.document.createElement('div'); root.appendChild(el); elements.set(id, el); }
        return { root, elements, setText: () => {}, close: () => { root.remove(); } };
      },
    };
    ui.setSidePackGuids([ME]);
    ui.toggleInventory();
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of [...DOM_GLOBALS, 'MutationObserver', 'ResizeObserver']) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  it('carried: both items are in the grid', () => {
    ui.setInventoryData([dirk, apple], [], 100, 15000);
    ui.renderInventoryPanel();
    expect(gridNames()).toEqual(expect.arrayContaining(['Rusted Dirk', 'Apple']));
  });
  it('wielded: the dirk leaves the grid (it is on the paperdoll), the apple stays', () => {
    ui.setInventoryData([dirk, apple], [{ ...dirk, slot: 0x100000 }], 100, 15000);
    ui.renderInventoryPanel();
    expect(gridNames()).not.toContain('Rusted Dirk');
    expect(gridNames()).toContain('Apple');
  });
  it('BUG.side-packs-in-item-grid: a side pack sits in the pack column, not the item grid', () => {
    const sack = { id: 0x80000786, weenieClassId: 166, name: 'Sack', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: ME, itemsCapacity: 24 };
    ui.setSidePackGuids([ME, sack.id]);
    ui.setInventoryData([dirk, apple, sack], [], 100, 15000);
    ui.renderInventoryPanel();
    expect(gridNames()).not.toContain('Sack');
    expect(gridNames()).toEqual(expect.arrayContaining(['Rusted Dirk', 'Apple']));
    ui.setSidePackGuids([ME]);
  });

  it('unwielded again: back in the grid', () => {
    ui.setInventoryData([dirk, apple], [], 100, 15000);
    ui.renderInventoryPanel();
    expect(gridNames()).toContain('Rusted Dirk');
  });
});
