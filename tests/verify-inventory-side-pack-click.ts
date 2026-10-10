/**
 * BUG.side-pack-click-swallowed — clicking a bag in the inventory's pack
 * column switches the grid to that pack ("Contents of <pack>"). The pack
 * list frame (0x100001ca's stand-in) lies OVER the side-pack slots and is
 * pointer-events:none on purpose; bindDatScrollbarWidget briefly forced
 * every viewport to 'auto' (for touchpad scrolling of DAT text), which
 * swallowed every click on a bag. Real GameUI in happy-dom.
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

describe.skipIf(!domWindow)('side-pack click (real GameUI)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
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
    const sack = { id: 0x80000786, weenieClassId: 166, name: 'Sack', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0x50000003, itemsCapacity: 24 };
    const apple = { id: 0x800009e4, weenieClassId: 258, name: 'Apple', value: 7, burden: 50, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0x80000786 };
    ui.setSidePackGuids([0x50000003, 0x80000786]);
    ui.toggleInventory();
    ui.setInventoryData([sack, apple], [], 51, 15000);
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of [...DOM_GLOBALS, 'MutationObserver', 'ResizeObserver']) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  it('the pack-list frame over the bags stays click-through after its scrollbar binds', () => {
    const frame = domWindow.document.querySelector('[data-dat-pack-list]');
    expect(frame).toBeTruthy();
    expect(frame.style.pointerEvents).toBe('none');
  });
  it('clicking the first side pack opens it in the grid', () => {
    const strip = ui.inventoryPanelHandle.elements.get(0x100001ce);
    const slots = [...strip.children].filter((d: HTMLElement) => d.style.width === '36px' && d.style.height === '36px' && d.style.top === '73px');
    slots[slots.length - 1].dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.selectedPackSlot).toBe(1);
    expect(domWindow.document.body.textContent).toContain('Contents of Sack');
  });
});
