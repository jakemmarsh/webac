/**
 * BUG.vendor-dblclick-buy-dropped — "I cannot double click an item to buy
 * from vendors."
 *
 * Retail: gmVendorUI::HandleMousePresses @ 004c40d0, message 10 (a
 * double-click) on the shop list → BuySingleItem. Ours: the shop cell's first
 * click selects the item and re-renders the vendor panel, so the second click
 * lands on a NEW cell, and Chrome sends no `dblclick` when the first click's
 * node was replaced (lead's live log: mousedown 1 → click 1 → mousedown 2 →
 * click 2, no dblclick). The pair is now read from the click count on the same
 * logical item (DoubleClickAcrossRedraw), shared by every list double-click.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'PointerEvent'] as const;

/** A real press: mousedown + click (the browser's order), with the OS click count. */
function press(el: Element, detail: number): void {
  el.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, detail }));
  el.dispatchEvent(new domWindow.MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, detail }));
  el.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail }));
}
function nativeDblclick(el: Element): void {
  el.dispatchEvent(new domWindow.MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0, detail: 2 }));
}

describe('DoubleClickAcrossRedraw — the recogniser itself', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rec: any;
  let host: HTMLElement;
  let acts: string[];
  /** A list whose every click rebuilds it (the vendor shape). */
  const build = (rebuildOnClick: boolean): void => {
    host.replaceChildren();
    for (const key of ['a', 'b']) {
      const cell = domWindow.document.createElement('div');
      cell.dataset.key = key;
      if (rebuildOnClick) cell.addEventListener('click', () => build(true));
      rec.bind(cell, () => key, () => acts.push(key));
      host.appendChild(cell);
    }
  };
  const cell = (k: string): Element => host.querySelector(`[data-key="${k}"]`)!;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const { DoubleClickAcrossRedraw } = await import('../packages/renderer/src/ui/DoubleClickAcrossRedraw.js');
    rec = new DoubleClickAcrossRedraw(domWindow.document);
    host = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(host);
  });
  afterAll(() => { host.remove(); restoreDomGlobals(DOM_GLOBALS, saved); });
  beforeEach(() => { acts = []; });

  it('first click rebuilds; the second (detail 2) lands on the new node → one action', () => {
    build(true);
    const first = cell('a');
    press(first, 1);
    expect(first.isConnected).toBe(false);
    press(cell('a'), 2);
    expect(acts).toEqual(['a']);
  });

  it('no rebuild: click detail 2 and the native dblclick that follows act once', () => {
    build(false);
    press(cell('a'), 1);
    press(cell('a'), 2);
    nativeDblclick(cell('a'));
    expect(acts).toEqual(['a']);
  });

  it('a bare native dblclick (synthetic, or a browser that sends one) acts once', () => {
    build(false);
    nativeDblclick(cell('b'));
    expect(acts).toEqual(['b']);
  });

  it('two slow single clicks (detail 1 each) never act', () => {
    build(true);
    press(cell('a'), 1);
    press(cell('a'), 1);
    expect(acts).toEqual([]);
  });

  it('the pair must be on the same item: a then b (detail 2) does not act', () => {
    build(true);
    press(cell('a'), 1);
    press(cell('b'), 2);
    expect(acts).toEqual([]);
  });

  it('Win32 counting: a triple-click acts once, a quadruple-click twice', () => {
    build(true);
    press(cell('a'), 1); press(cell('a'), 2); press(cell('a'), 3);
    expect(acts).toEqual(['a']);
    press(cell('a'), 4);
    expect(acts).toEqual(['a', 'a']);
  });

  it('an empty key (nothing in the slot) never acts from the click count', () => {
    host.replaceChildren();
    const empty = domWindow.document.createElement('div');
    rec.bind(empty, () => '', () => acts.push('empty'));
    host.appendChild(empty);
    press(empty, 1); press(empty, 2);
    expect(acts).toEqual([]);
  });
});

const ITEMS_LIST = 0x100000bd;
const ITEMS_SCROLL = 0x100000be;
const BUY_LIST = 0x100000c5;
const BUY_SCROLL = 0x100000c6;

describe('BUG.vendor-dblclick-buy-dropped — the vendor shop list buys on a double-click across its re-render', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let roots: HTMLElement[] = [];
  const buys: Array<{ guid: number; amount: number }> = [];
  const rows = [
    { guid: 0x80001001, weenieClassId: 1, name: 'Mana Scarab', pluralName: 'Mana Scarabs', stackSize: -1, descStackSize: 1, maxStackSize: 1, itemType: 0x1000, burden: 1, price: 50, unitValue: 40, priceRate: 1.25, pricing: 'vendorSells' },
    { guid: 0x80001002, weenieClassId: 2, name: 'Lead Scarab', pluralName: 'Lead Scarabs', stackSize: -1, descStackSize: 1, maxStackSize: 1, itemType: 0x1000, burden: 1, price: 30, unitValue: 24, priceRate: 1.25, pricing: 'vendorSells' },
  ];
  /** The live shop cell for merchandise index `i` (the newest render). */
  const shopCell = (i: number): HTMLElement => {
    const list = roots.map(r => r.querySelector(`[data-list="${ITEMS_LIST}"]`)).filter((x): x is HTMLElement => !!x && x.isConnected).pop()!;
    return list.querySelector(`[data-item-cell="${i}"]`) as HTMLElement;
  };

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      roots.push(root);
      const elements = new Map<number, HTMLElement>();
      for (const id of [ITEMS_LIST, ITEMS_SCROLL, BUY_LIST, BUY_SCROLL]) {
        const el = domWindow.document.createElement('div');
        el.dataset.list = String(id);
        el.style.width = '510px';
        root.appendChild(el);
        elements.set(id, el);
      }
      return {
        root, elements, descs: new Map(),
        setText: () => {}, setInteractive: () => {},
        setVisible: () => {}, setState: () => {}, setFill: () => {}, setPalette: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
    };
    ui.uiManager.setScreen('game');
    ui.renderHUD();
    ui.hud.coinValue = 1_000_000;
    ui.inventoryItemsCapacity = 102;
    ui.inventoryContainersCapacity = 7;
    ui.setVendorCallbacks({ onBuy: (guid: number, amount: number) => { buys.push({ guid, amount }); } });
    ui.showVendorWindow('Lalira the Shopkeeper', rows, [], '1.25', '0.90', undefined, undefined, 0x50002000);
  });
  afterAll(() => { ui.hideVendorWindow(); restoreDomGlobals(DOM_GLOBALS, saved); roots = []; });
  beforeEach(() => { buys.length = 0; });

  it('the first click selects and REBUILDS the cell (the premise of the bug)', () => {
    const before = shopCell(1);
    expect(before).toBeTruthy();
    press(before, 1);
    expect(before.isConnected).toBe(false);
    expect(shopCell(1)).not.toBe(before);
    expect(ui.hud.target?.id).toBe(rows[1].guid);
    expect(buys).toEqual([]);
  });

  it("Chrome's sequence (click 1, rebuild, click 2 on the new cell, no dblclick) buys exactly one", () => {
    press(shopCell(1), 1);
    press(shopCell(1), 2);
    expect(buys).toEqual([{ guid: rows[1].guid, amount: 1 }]);
  });

  it('a native dblclick after the even click does not buy a second time', () => {
    press(shopCell(0), 1);
    press(shopCell(0), 2);
    nativeDblclick(shopCell(0));
    expect(buys).toEqual([{ guid: rows[0].guid, amount: 1 }]);
  });

  it('a native dblclick alone (a browser that sends one) still buys once', () => {
    nativeDblclick(shopCell(0));
    expect(buys).toEqual([{ guid: rows[0].guid, amount: 1 }]);
  });

  it('two slow single clicks buy nothing', () => {
    press(shopCell(1), 1);
    press(shopCell(1), 1);
    expect(buys).toEqual([]);
  });

  it('a triple-click buys once (the third press is a plain click, as in Win32)', () => {
    press(shopCell(1), 1); press(shopCell(1), 2); press(shopCell(1), 3);
    expect(buys).toEqual([{ guid: rows[1].guid, amount: 1 }]);
  });

  it('click on one item then the other buys nothing', () => {
    press(shopCell(0), 1);
    press(shopCell(1), 2);
    expect(buys).toEqual([]);
  });
});
