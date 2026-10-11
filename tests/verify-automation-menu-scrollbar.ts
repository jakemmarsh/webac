/**
 * The automation dropdown menu (GameUI.openAutomationMenu) is built from the
 * retail UIElement_Menu art (rows 0x060012b3 / hover 0x060012b4, layout
 * 0x21000043): its listbox scrolls with the HUD scrollbar beside it (the
 * popup 0x1000034f's 0x10000351, base 0x2100003e:0x10000455, p121 = true:
 * hidden while the rows fit), never the browser's own bar (Jake 2026-10-11).
 * BEHAVIORAL: the real GameUI in happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('automation menu scrolls with the retail scrollbar', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  beforeAll(async () => {
    H = await mountGameUI();
    ui = H.ui;
    ui.getTexURL = () => null;
  });
  // openAutomationMenu arms its outside-click / Escape listeners on the next tick.
  afterAll(async () => { await new Promise((r) => setTimeout(r, 0)); H?.teardown(); });

  const items = Array.from({ length: 15 }, (_, i) => ({ label: `Item ${i}`, value: `v${i}` }));
  const open = (): { list: HTMLElement; bar: HTMLElement } => {
    const anchor = H.win.document.createElement('div') as HTMLElement;
    ui.hudContainer.appendChild(anchor);
    ui.openAutomationMenu(anchor, items, () => {}, { search: true, width: 200 });
    const menu = ui.automationMenuEl as HTMLElement;
    return {
      list: menu.querySelector('[data-menu-list]') as HTMLElement,
      bar: menu.querySelector('[data-menu-scrollbar]') as HTMLElement,
    };
  };
  const layOut = (bar: HTMLElement, list: HTMLElement, rows: number): void => {
    const view = Math.min(rows, 10) * 18;
    Object.defineProperty(bar, 'clientHeight', { value: view, configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: rows * 18, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: view, configurable: true });
    list.dispatchEvent(new Event('scroll'));
  };

  it('15 rows: a 10-row list, native bar hidden, the DAT bar shown beside it and stepping one row', () => {
    const { list, bar } = open();
    expect(list.children.length).toBe(15);
    expect(list.style.height).toBe('180px');
    expect(list.style.width).toBe('172px'); // 200 − 12 padding − the 16 px bar
    expect(bar.style.width).toBe('16px');
    expect(bar.style.height).toBe('180px');
    expect(list.style.getPropertyValue('scrollbar-width')).toBe('none');
    let top = 0;
    Object.defineProperty(list, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, v); }, configurable: true });
    layOut(bar, list, 15);
    expect(bar.style.display).not.toBe('none');
    (bar.querySelector('[data-dat-scroll-btn="down"]') as HTMLElement).click();
    expect(top).toBe(18);
  });

  it('a search that leaves 3 rows shrinks the list and hides the bar (p121)', () => {
    const { list, bar } = open();
    const search = (ui.automationMenuEl as HTMLElement).querySelector('[data-menu-search] input') as HTMLInputElement;
    search.value = 'Item 1';
    search.dispatchEvent(new Event('input'));
    // "Item 1", "Item 10" … "Item 14": 6 rows.
    expect(list.children.length).toBe(6);
    expect(list.style.height).toBe('108px');
    expect(bar.style.height).toBe('108px');
    layOut(bar, list, 6);
    expect(bar.style.display).toBe('none');
  });
});
