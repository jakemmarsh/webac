/**
 * FAITHFUL.537 — Accept toggle + Trade button positioned per DAT layout.
 *
 *  CORE.17.k.b.b.c.c.a.a.c.a.b — premise corrected by the decompiled client:
 *  gmSecureTradeUI::PostInit @ 004ca160 binds 0x1000007f as
 *  m_pOtherTradeStatusIndicator (the PARTNER's accepted lamp, states 0xd /
 *  6 — never clicked) and 0x10000086 as m_pTradeButton, the player's own
 *  accept toggle (ListenToElementMessage @ 004cae80: AcceptTheTrade /
 *  DeclineTheTrade; UpdateTradeButtonState @ 004c9700: 0xd while both lists
 *  are empty). The geometry is the DAT slot's (pinned against the real DAT in
 *  verify-core17kbbccaaacab-trade-slot.ts).
 *
 *  LayoutDesc 0x2100000d (classic_securetrade) declares:
 *    elem 0x1000007f (Accept toggle): left-half-relative xy=(362,3) wh=35x27, L2
 *    elem 0x10000086 (Trade button): right-half-relative xy=(0,3) wh=46x30,
 *      label string ID 3474766 = "Trade", state1 texture 0x06004cbc
 *
 *  CORE.17.k.b.b.c.c.a.a.c.a — the panel lives in the transaction dock's
 *  600-wide trade slot: the proportional halves are 300 wide, so the Accept
 *  toggle (L2) sits at 362 − 100 = 262 in the left half and the Trade button
 *  at the right half's origin, slot x 300.
 *
 *  Behavioural (converted from a source-text pin in CORE.17.k.b.b.c.c.a.a.c.a):
 *  GameUI is driven through happy-dom and the rendered buttons read back.
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

describe('FAITHFUL.537 / CORE.17.k.b.b.c.c.a.a.c.a.b — the Trade toggle 0x10000086 and the partner\'s lamp 0x1000007f (behavioral)', () => {
  const H = tradeHarness();
  beforeAll(async () => { await H.setup(); });
  afterAll(() => H.teardown());
  beforeEach(() => { H.ui.hideTradeWindow(); H.calls.length = 0; H.sounds.length = 0; });

  const item = (guid: number) => ({ name: 'Arrow', value: 1, guid, burden: 1, iconDid: 0 });

  it('the lamp 0x1000007f is the PARTNER\'s acceptance (PostInit: m_pOtherTradeStatusIndicator): 0xd until they accept, 6 once they have — our own readiness does not light it', () => {
    H.open();
    expect(H.states.get(0x1000007f)).toBe(0xd);
    H.open({ yourReady: true, yourItems: [item(1)] });
    expect(H.states.get(0x1000007f)).toBe(0xd);
    H.open({ theirReady: true, yourItems: [item(1)] });
    expect(H.states.get(0x1000007f)).toBe(6);
  });

  it('the lamp is not a button: a click on it sends nothing', () => {
    H.open({ yourItems: [item(1)] });
    H.click(H.el(0x1000007f));
    expect(H.calls).toEqual([]);
  });

  it('the Trade toggle (UpdateTradeButtonState): 0xd with nothing on the table, 1 with items, 6 once we accepted', () => {
    H.open();
    expect(H.states.get(0x10000086)).toBe(0xd);
    H.open({ theirItems: [item(2)] });
    expect(H.states.get(0x10000086)).toBe(1);
    H.open({ yourItems: [item(1)], yourReady: true });
    expect(H.states.get(0x10000086)).toBe(6);
  });

  it('a press accepts from 1 (AcceptTrade) and declines from 6 (DeclineTrade); a disabled toggle sends nothing; the click itself plays no sound', () => {
    H.open();
    H.click(H.el(0x10000086));
    expect(H.calls).toEqual([]);
    H.open({ yourItems: [item(1)] });
    H.click(H.el(0x10000086));
    H.open({ yourItems: [item(1)], yourReady: true });
    H.click(H.el(0x10000086));
    expect(H.calls).toEqual(['accept', 'decline']);
    // BUG.ui-buttonpress-on-every-button — the press sound is the element's
    // own state-3 layout media on mouse-down (verify-layout-press-sound.ts:
    // 0x10000086 sounds from 1, and is silent from 6 — it presses into 8).
    expect(H.sounds).toEqual([]);
  });
});
