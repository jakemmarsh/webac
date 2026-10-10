/**
 * FAITHFUL.544 — Inventory cells visually flag items currently on the
 * trade table so the player can tell at a glance which items are
 * "reserved" and will reject inventory actions.
 *
 *  Server-side: ACE Player_Use.cs:126,132,190 + Player_Inventory.cs
 *  (10 sites: 862, 1404, 2322, 2530, 2660, 2968, 2973, 3234, 3277, 3413)
 *  reject any inventory action (use, drop, equip, split, merge, give, etc.)
 *  on an item whose guid is in `ItemsInTradeWindow`. FAITHFUL.540 gave
 *  WeenieError.TradeItemBeingTraded user-visible chat text — but the
 *  player had no way to know WHICH inventory items were "reserved"
 *  without trial-and-error or remembering what they added to trade.
 *
 *  Fix: inventory render builds a Set of guids from
 *  `tradeData.yourItems` (extended with guid field in .535), and each
 *  cell that matches gets:
 *    - a green highlight — since VISUAL.3 (beveled stone tiles) this is a
 *      green inset outline via styleSlotTile(cell, 'trade') layered on the
 *      recessed bevel, replacing the old flat green 1px border
 *    - (no dim: RECON.inventory-grid-dat-cells removed the invented 55%
 *      opacity — UIItem_Update only toggles Icon_TradeState)
 *    - " (in trade)" appended to the hover title
 *
 *  Re-render plumbing: setTradeData + hideTradeWindow now also refresh
 *  the inventory panel so the highlights track add/remove/close
 *  events synchronously without the user needing to re-open inventory.
 *  REND.gameui-listener-observer-leaks — that refresh restyles the open
 *  grid's cells IN PLACE (no panel rebuild); the former source-text pins
 *  for this file are now the behavioral cases below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// happy-dom drives the real GameUI (the former source-text pins were
// converted to behavior per the no-source-grep-pins rule).
const HAPPY_DOM_PKG = ['happy', 'dom'].join('-');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let domWindow: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ HAPPY_DOM_PKG);
  domWindow = new mod.Window({ innerWidth: 1024, innerHeight: 768 });
} catch { /* skip */ }
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const INVENTORY_ELEMENT_IDS = [0x100001d0, 0x100001cd, 0x100001ce, 0x100001cf];

describe.skipIf(!domWindow)('FAITHFUL.544 — inventory cell titles (behavioral, real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of INVENTORY_ELEMENT_IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return { root, elements, setText: () => {}, close: () => { root.remove(); } };
      },
    };
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  function renderWithItems(items: unknown[], inTradeGuid = 0): HTMLElement {
    ui.setTradeData({
      yourItems: inTradeGuid ? [{ name: 'x', value: 0, guid: inTradeGuid, burden: 0, iconDid: 0 }] : [],
      theirItems: [], theirName: '', yourName: '',
      partnerGuid: inTradeGuid ? 0x500 : 0, initiatorGuid: 0, tradeStamp: 0,
      tradeStatus: 0, yourReady: false, theirReady: false,
    });
    if (!ui.inventoryPanelHandle) ui.toggleInventory();
    ui.setInventoryData(items, [], 1, 100);
    const gridEl = ui.inventoryPanelHandle.elements.get(0x100001cf);
    return gridEl.querySelector('div[style*="grid"]') as HTMLElement;
  }

  it('an in-trade cell keeps the bare item name as its DAT tooltip (CORE.17.k.b.b.a.g: UIElement_UIItem::UpdateTooltip — no "(in trade)" suffix, no native title)', () => {
    const grid = renderWithItems([{
      id: 7, weenieClassId: 900, name: 'Plain Dagger', value: 0, burden: 1,
      stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0,
    }], 7);
    const cell = grid.children[0] as HTMLElement;
    expect(cell.dataset.acTooltipText).toBe('Plain Dagger');
    expect(cell.getAttribute('title')).toBeNull();
    // RECON.inventory-grid-dat-cells — UIItem_Update @ 004e21d0 only shows
    // m_elem_Icon_TradeState; the icon is never dimmed.
    expect(cell.style.opacity).toBe('');
  });

  it('CORE.10.e — a stack of >=2 reads "<count> <PluralName>" in its DAT tooltip (UIElement_UIItem::UpdateTooltip L"%d %s"); +s fallthrough when no plural was sent', () => {
    const grid = renderWithItems([
      {
        id: 8, weenieClassId: 273, name: 'Pyreal', pluralName: 'Pyreals', value: 5000, burden: 1,
        stackSize: 5000, maxStackSize: 25000, stackable: true, containerId: 0,
      },
      {
        id: 9, weenieClassId: 901, name: 'Widget', value: 0, burden: 1,
        stackSize: 50, maxStackSize: 100, stackable: true, containerId: 0,
      },
      {
        id: 10, weenieClassId: 273, name: 'Pyreal', pluralName: 'Pyreals', value: 1, burden: 1,
        stackSize: 1, maxStackSize: 25000, stackable: true, containerId: 0,
      },
    ]);
    const titles = [...grid.children].map(c => (c as HTMLElement).dataset.acTooltipText).filter(t => t);
    expect(titles).toContain('5000 Pyreals');   // plural sent, stack >=2
    expect(titles).toContain('50 Widgets');     // no plural sent → client-side +s fallthrough
    expect(titles).toContain('Pyreal');         // stack of 1 → singular
  });
  const dagger = { id: 7, weenieClassId: 900, name: 'Plain Dagger', value: 0, burden: 1, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 };
  const tradeOverlay = (cell: HTMLElement) => [...cell.children].find(c => (c as HTMLElement).dataset.slotState === 'trade') as HTMLElement | undefined;

  it('the in-trade set comes from tradeData.yourItems only while a trade partner exists', () => {
    // Listed but no partner (partnerGuid 0) → not in trade.
    ui.setTradeData({
      yourItems: [{ name: 'x', value: 0, guid: 7, burden: 0, iconDid: 0 }],
      theirItems: [], theirName: '', yourName: '',
      partnerGuid: 0, initiatorGuid: 0, tradeStamp: 0, tradeStatus: 0, yourReady: false, theirReady: false,
    });
    if (!ui.inventoryPanelHandle) ui.toggleInventory();
    ui.setInventoryData([dagger], [], 1, 100);
    let cell = (ui.inventoryPanelHandle.elements.get(0x100001cf).querySelector('div[style*="grid"]') as HTMLElement).children[0] as HTMLElement;
    expect(tradeOverlay(cell)).toBeUndefined();
    cell = renderWithItems([dagger], 7).children[0] as HTMLElement;
    expect(cell.style.opacity).toBe('');
    expect(tradeOverlay(cell)).toBeTruthy();
  });

  it('styleSlotTile draws the trade state as the 0x06001dae badge, or a green (onlineGreen) outline without the texture', async () => {
    const { AC_COLORS } = await import('../packages/renderer/src/ui/GameUI.js');
    ui.uiTextures.set(0x06001dae, 'data:image/png;base64,TRADE');
    let cell = renderWithItems([dagger], 7).children[0] as HTMLElement;
    expect(tradeOverlay(cell)!.style.backgroundImage).toContain('base64,TRADE');
    ui.uiTextures.delete(0x06001dae);
    cell = renderWithItems([dagger], 7).children[0] as HTMLElement;
    const hex = AC_COLORS.onlineGreen.replace('#', '');
    const rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ');
    const outline = tradeOverlay(cell)!.style.outline;
    expect(outline.includes(AC_COLORS.onlineGreen) || outline.includes(rgb)).toBe(true);
  });

  it('setTradeData restyles the open grid in place — the highlight tracks add/remove without a panel rebuild', () => {
    const grid = renderWithItems([dagger], 0);
    const panel = ui.inventoryPanel;
    const cell = grid.children[0] as HTMLElement;
    expect(tradeOverlay(cell)).toBeUndefined();
    ui.setTradeData({
      yourItems: [{ name: 'x', value: 0, guid: 7, burden: 0, iconDid: 0 }],
      theirItems: [], theirName: '', yourName: '',
      partnerGuid: 0x500, initiatorGuid: 0, tradeStamp: 0, tradeStatus: 0, yourReady: false, theirReady: false,
    });
    expect(ui.inventoryPanel).toBe(panel);
    expect(cell.isConnected).toBe(true);
    expect(cell.style.opacity).toBe('');
    expect([...cell.children].filter(c => (c as HTMLElement).dataset.slotState === 'trade')).toHaveLength(1);
    // A repeated update never stacks a second overlay.
    ui.setTradeData({ ...ui.tradeData });
    expect([...cell.children].filter(c => (c as HTMLElement).dataset.slotState === 'trade')).toHaveLength(1);
    ui.setTradeData({ ...ui.tradeData, yourItems: [] });
    expect(ui.inventoryPanel).toBe(panel);
    expect(cell.style.opacity).toBe('');
    expect(tradeOverlay(cell)).toBeUndefined();
  });

  it('hideTradeWindow clears the highlights (in place) when the trade ends', () => {
    const cell = renderWithItems([dagger], 7).children[0] as HTMLElement;
    const panel = ui.inventoryPanel;
    expect(tradeOverlay(cell)).toBeTruthy();
    ui.hideTradeWindow();
    expect(ui.inventoryPanel).toBe(panel);
    expect(cell.style.opacity).toBe('');
    expect(tradeOverlay(cell)).toBeUndefined();
  });

  it('RECON.inventory-grid-dat-cells — a stacked cell draws no count on its icon (UpdateQuantityDisplay shows the quantity text only after a vendor SetQuantity)', () => {
    const grid = renderWithItems([{
      id: 8, weenieClassId: 273, name: 'Pyreal', pluralName: 'Pyreals', value: 5000, burden: 1,
      stackSize: 5000, maxStackSize: 25000, stackable: true, containerId: 0,
    }]);
    const cell = grid.children[0] as HTMLElement;
    expect(cell.dataset.acTooltipText).toBe('5000 Pyreals');
    expect(cell.textContent ?? '').not.toContain('5000');
  });
});
