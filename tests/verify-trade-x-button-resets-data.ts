/**
 * FAITHFUL.536 — the close box resets tradeData inline, not only on the
 *  server's CloseTrade round trip (hideTradeWindow, FAITHFUL.531): during
 *  the ~50-200 ms before the server answers, the inventory right-click
 *  "Add to Trade" gate (`partnerGuid !== 0`) must already be false.
 *
 *  CORE.17.k.b.b.c.c.a.a.c.a — the close box is gmSecureTradeUI's own
 *  0x1000008b ((778,0) 22x20, L2 → 578 in the dock's 600-wide slot);
 *  SetVisible(0) → OnVisibilityChanged(false) @ 004ca470 →
 *  CloseTradeNegotiations. The dock displacing the panel takes the same path.
 *
 *  Behavioural (converted from a source-text pin in CORE.17.k.b.b.c.c.a.a.c.a).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'Image', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * GameUI (no DATs) with the trade callbacks, the UI sounds and the texture
 * lookups recorded. The LayoutRenderer is stubbed with a dock handle carrying
 * the trade slot 0x1000005f's elements (CORE.17.k.b.b.c.c.a.a.c.a.b — the
 * panel is the DAT slot); verify-core17kbbccaaacab-trade-slot.ts renders the
 * real one.
 */
function tradeHarness() {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  const calls: string[] = [];
  const sounds: number[] = [];
  /** The last dock handle's element texts / states, by element id. */
  const texts = new Map<number, string>();
  const states = new Map<number, number>();
  let elements = new Map<number, HTMLElement>();
  let ui: Any;
  const setup = async (): Promise<void> => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    if (typeof g.requestAnimationFrame !== 'function') {
      g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {};
      domWindow.requestAnimationFrame = g.requestAnimationFrame;
    }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const { SECURE_TRADE_EL } = await import('../packages/renderer/src/ui/SecureTradePanel.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.getTexURL = (id: number): string => `tex:0x${id.toString(16)}`;
    ui.playUISound = (s: number) => { sounds.push(s); };
    ui.layoutRenderer = {
      // The transaction dock 0x2100006d with the trade slot's elements.
      render: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const slot = domWindow.document.createElement('div');
        slot.dataset.elementId = '0x1000005f';
        root.appendChild(slot);
        elements = new Map([[0x1000005f, slot]]);
        texts.clear();
        states.clear();
        for (const id of Object.values(SECURE_TRADE_EL)) {
          if (id === SECURE_TRADE_EL.root) continue;
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          if (id === SECURE_TRADE_EL.selfList || id === SECURE_TRADE_EL.partnerList) el.style.width = '295px';
          slot.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements, descs: new Map(),
          setText: (id: number, t: string) => { texts.set(id, t); const el = elements.get(id); if (el) el.textContent = t; },
          setFill: () => {}, setPalette: () => {},
          setVisible: (id: number, v: boolean) => { const el = elements.get(id); if (el) el.style.display = v ? '' : 'none'; },
          setState: (id: number, s: number) => { states.set(id, s); },
          setInteractive: (id: number, h?: (id: number, el: HTMLElement) => void) => {
            const el = elements.get(id);
            if (el && h) el.addEventListener('click', () => h(id, el));
          },
          onClick: () => {},
          destroy: () => { root.remove(); },
        };
      },
    };
    ui.setTradeCallbacks({
      onAcceptTrade: () => calls.push('accept'),
      onDeclineTrade: () => calls.push('decline'),
      onResetTrade: () => calls.push('reset'),
      onCloseTrade: () => calls.push(`close:partner=${ui.getTradeData().partnerGuid}`),
    });
  };
  const teardown = (): void => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  };
  const open = (over: Record<string, unknown> = {}): void => {
    ui.showTradeWindow('Og');
    ui.setTradeData({
      yourItems: [], theirItems: [], theirName: 'Og', yourName: 'Me',
      partnerGuid: 0x50002222, initiatorGuid: 0x50000001, tradeStamp: 0, tradeStatus: 0,
      yourReady: false, theirReady: false, ...over,
    });
  };
  /** The trade slot box inside the dock host (CORE.17.k.b.b.c.c.a.a.c.a). */
  const slot = (): HTMLElement => (ui.tradePanel as HTMLElement).querySelector('[data-element-id="0x1000005f"]') as HTMLElement;
  /** An element of the current handle, by DAT id. */
  const el = (id: number): HTMLElement => elements.get(id)!;
  const click = (target: HTMLElement): void => { target.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true })); };
  return { setup, teardown, open, slot, el, click, calls, sounds, texts, states, get ui() { return ui; } };
}

describe('FAITHFUL.536 — the close box resets tradeData (behavioral)', () => {
  const H = tradeHarness();
  beforeAll(async () => { await H.setup(); });
  afterAll(() => H.teardown());
  beforeEach(() => { H.ui.hideTradeWindow(); H.calls.length = 0; });

  const closeBox = (): HTMLElement => (H.ui.tradePanel as HTMLElement).querySelector('[data-element-id="0x1000008b"]') as HTMLElement;

  it('the close box is the slot\'s own 0x1000008b (its (578,0) 22x20 reflow is pinned against the DAT in verify-core17kbbccaaacab-trade-slot.ts)', () => {
    H.open();
    expect(closeBox()).toBe(H.el(0x1000008b));
    expect(closeBox().closest('[data-element-id="0x1000005f"]')).toBe(H.slot());
  });

  it('a click resets tradeData BEFORE onCloseTrade fires (the callback sees partner 0), and tears the panel down', () => {
    H.open();
    H.click(closeBox());
    expect(H.calls).toEqual(['close:partner=0']);
    expect(H.ui.getTradeData().partnerGuid).toBe(0);
    expect(H.ui.getTradeData().yourName).toBe('');
    expect(H.ui.tradePanel).toBeNull();
  });

  it('hideTradeWindow (the server path) resets too, without sending a close', () => {
    H.open();
    H.ui.hideTradeWindow();
    expect(H.ui.getTradeData().partnerGuid).toBe(0);
    expect(H.calls).toEqual([]);
  });

  it('the dock displacing the trade (a vendor / container / salvage / slumlord shown) closes it the close box\'s way', () => {
    H.open();
    H.ui.showSalvagePanel(0x80006666);
    expect(H.calls).toEqual(['close:partner=0']);
    expect(H.ui.tradePanel).toBeNull();
    H.ui.hideSalvagePanel();
  });
});
