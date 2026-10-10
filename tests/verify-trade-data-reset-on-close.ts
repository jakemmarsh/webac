/**
 * FAITHFUL.531 — hideTradeWindow resets tradeData so the inventory
 *  right-click "Add to Trade" verb disappears once the trade is over
 *  (the menu gates it on `getTradeData().partnerGuid !== 0`).
 *
 *  Behavioural (converted from a source-text pin in CORE.17.k.b.b.c.c.a.a.c.a):
 *  hideTradeWindow — the server's CloseTrade path — tears the panel down and
 *  empties tradeData, without sending a close of its own.
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

describe('FAITHFUL.531 — hideTradeWindow resets tradeData (behavioral)', () => {
  const H = tradeHarness();
  beforeAll(async () => { await H.setup(); });
  afterAll(() => H.teardown());
  beforeEach(() => { H.ui.hideTradeWindow(); H.calls.length = 0; });

  it('hideTradeWindow assigns a fresh empty tradeData: partner, initiator, names, items and ready flags', () => {
    H.open({
      yourItems: [{ name: 'Arrow', value: 1, guid: 0x80001111, burden: 1, iconDid: 0 }],
      theirItems: [{ name: 'Gem', value: 5, guid: 0x80002222, burden: 1, iconDid: 0 }],
      yourReady: true, theirReady: true,
    });
    H.ui.hideTradeWindow();
    expect(H.ui.getTradeData()).toEqual({
      yourItems: [], theirItems: [], theirName: '', yourName: '',
      partnerGuid: 0, initiatorGuid: 0, tradeStamp: 0, tradeStatus: 0,
      yourReady: false, theirReady: false,
    });
  });

  it('the DOM is torn down with it, the dock is released, and no close is sent (the server already closed the trade)', () => {
    H.open();
    const host = H.ui.tradePanel as HTMLElement;
    H.ui.hideTradeWindow();
    expect(H.ui.tradePanel).toBeNull();
    expect(host.isConnected).toBe(false);
    expect(H.ui.transactionDockPanel).toBeNull();
    expect(H.calls).toEqual([]);
  });
});

/**
 * SWEEP1006 trade close — gmSecureTradeUI::RecvNotice_CloseTrade @ 004ca550
 * only Resets the panel (Reset @ 004ca100): the server's CloseTrade leaves it
 * open and empty; the close box hides it.
 */
describe('resetTradeWindow — the server CloseTrade keeps the panel open, emptied', () => {
  const H = tradeHarness();
  beforeAll(async () => { await H.setup(); });
  afterAll(() => H.teardown());
  beforeEach(() => { H.ui.hideTradeWindow(); H.calls.length = 0; });

  it('tradeData is the empty Reset state, the panel stays in the dock, and nothing is sent', () => {
    H.open({
      yourItems: [{ name: 'Arrow', value: 1, guid: 0x80001111, burden: 1, iconDid: 0 }],
      theirItems: [{ name: 'Gem', value: 5, guid: 0x80002222, burden: 1, iconDid: 0 }],
      yourReady: true, theirReady: true,
    });
    H.ui.resetTradeWindow();
    expect(H.ui.getTradeData()).toEqual({
      yourItems: [], theirItems: [], theirName: '', yourName: '',
      partnerGuid: 0, initiatorGuid: 0, tradeStamp: 0, tradeStatus: 0,
      yourReady: false, theirReady: false,
    });
    expect(H.ui.tradeVisible).toBe(true);
    expect((H.ui.tradePanel as HTMLElement).isConnected).toBe(true);
    expect(H.calls).toEqual([]);
  });
});
