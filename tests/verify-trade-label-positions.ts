/**
 * FAITHFUL.543 — Trade panel labels positioned per LayoutDesc with
 * DAT-anchored character-name placeholders.
 *
 *  Per LayoutDesc 0x2100000d dump:
 *    elem 0x1000007e (left label):  xy=(200,3) wh=150x18 p199=str#58579907 = "..."
 *    elem 0x10000085 (right label): xy=(200,3) wh=150x18 p23=str#263234268 = "You"
 *
 *  CORE.17.k.b.b.c.c.a.a.c.a.b — premise corrected by the decompiled client.
 *  FAITHFUL.543 read the left "..." as the local player's name and the right
 *  "You" as the partner's; gmSecureTradeUI::PostInit @ 004ca160 binds the
 *  other way round: 0x1000007e is m_pOtherPlayerName (the PARTNER — set by
 *  SetTradePartner @ 004c9dd0 from RegisterTrade, cleared by CloseTrade) and
 *  0x10000085 is m_pSelfPlayerName, which no code ever re-texts: the right
 *  half reads the DAT's "You". The invented "Your Items" / "Their Items"
 *  fallbacks are gone (an unset partner leaves the DAT's "...").
 *
 * Behavioural: GameUI through happy-dom with a stub dock handle; the texts it
 * sets are read back. Positions are the DAT slot's (verify-core17kbbccaaacab-
 * trade-slot.ts renders the real layout).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const domWindow: Any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'Image', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

const tradeData = (yourName: string, theirName: string) => ({
  yourItems: [], theirItems: [], theirName, yourName,
  partnerGuid: 0x50000123, initiatorGuid: 0x50000001, tradeStamp: 0, tradeStatus: 0,
  yourReady: false, theirReady: false,
});

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

describe('FAITHFUL.543 / CORE.17.k.b.b.c.c.a.a.c.a.b — the trade names: the partner left, "You" right (happy-dom)', () => {
  const H = tradeHarness();
  beforeAll(async () => { await H.setup(); });
  afterAll(() => H.teardown());
  beforeEach(() => { H.ui.hideTradeWindow(); });

  it('tradeData carries yourName: setTradeData stores it and getTradeData returns it', () => {
    H.ui.setTradeData(tradeData('Perf Tester', 'Og the Barbarian'));
    expect(H.ui.getTradeData().yourName).toBe('Perf Tester');
    expect(H.ui.getTradeData().theirName).toBe('Og the Barbarian');
  });

  it('SetTradePartner: the partner\'s name goes to the LEFT label 0x1000007e; the right label 0x10000085 is never re-texted (the DAT\'s "You"), and our own name is drawn nowhere', () => {
    H.ui.setTradeData(tradeData('Perf Tester', 'Og the Barbarian'));
    H.ui.showTradeWindow('Og the Barbarian');
    expect(H.texts.get(0x1000007e)).toBe('Og the Barbarian');
    expect(H.texts.has(0x10000085)).toBe(false);
    expect([...H.texts.values()]).not.toContain('Perf Tester');
  });

  it('no invented fallbacks: an unset partner leaves the DAT\'s "..." (no setText), and "Your Items" / "Their Items" appear nowhere', () => {
    H.ui.setTradeData(tradeData('', ''));
    H.ui.showTradeWindow('');
    expect(H.texts.has(0x1000007e)).toBe(false);
    const all = (H.ui.tradePanel as HTMLElement).textContent ?? '';
    expect(all).not.toContain('Your Items');
    expect(all).not.toContain('Their Items');
  });

  it('hideTradeWindow and the panel\'s close box both reset yourName (and the partner) to the empty trade', () => {
    H.ui.setTradeData(tradeData('Perf Tester', 'Og the Barbarian'));
    H.ui.showTradeWindow('Og the Barbarian');
    H.ui.hideTradeWindow();
    expect(H.ui.getTradeData().yourName).toBe('');
    expect(H.ui.getTradeData().partnerGuid).toBe(0);
    H.ui.setTradeData(tradeData('Perf Tester', 'Og the Barbarian'));
    H.ui.showTradeWindow('Og the Barbarian');
    H.click(H.el(0x1000008b));
    expect(H.ui.getTradeData().yourName).toBe('');
    expect(H.ui.getTradeData().theirName).toBe('');
    expect(H.ui.getTradeData().partnerGuid).toBe(0);
  });
});
