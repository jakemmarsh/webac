/**
 * FAITHFUL.542 — Trade panel slots render DAT item icons next to name+value.
 *
 *  Pre-fix the trade slots were text-only ("Platinum Scarab     10000")
 *  which diverged sharply from the AC retail trade window's icon-based
 *  layout. Threading iconDid through tradeData entries lets each row
 *  render the actual DAT item icon (32x32 in retail; 18x18 here to fit
 *  the DAT-anchored 70px list height).
 *
 *  Icon source: inventory items already carry iconDid; ServerObject
 *  uses iconId (same value, different field name historically). The
 *  AddToTrade handler picks the right field based on tradeSide.
 *
 *  Falls through gracefully: iconDid=0 → no icon div, just the name+value
 *  text (preserves the pre-fix visual for items without an icon).
 *
 *  CORE.17.k.b.b.c.c.a.a.c.a.b — the lists are the DAT's UIElement_ItemLists
 *  (0x10000088 the player's, 0x10000081 the partner's): each item is a 32-px
 *  UIItem cell (the full-size icon, no name / value text — the name is the
 *  cell's tooltip), padded with empty tiles (UpdateEmptySlots). The render
 *  half of this file is behavioural (GameUI through happy-dom, a stub dock
 *  handle); the AddToTrade row is main.ts's tradeItemEntryFor (CORE.18.c.a
 *  converted the old handler text pins to calls of it).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { tradeItemEntryFor } from '../packages/renderer/src/ui/tradeItemEntry.js';

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

describe('FAITHFUL.542 — trade panel item icons', () => {
  it('onAddToTrade extracts iconDid from inventory iconDid OR ServerObject iconId', () => {
    // Self: the InventoryItem's iconDid (its iconId, if any, is ignored).
    expect(tradeItemEntryFor(0x5001, { name: 'Scarab', iconDid: 0x06001234, iconId: 0x06009999 }, true).iconDid).toBe(0x06001234);
    // Partner: the ServerObject's iconId (same value, the mirror's name for it).
    expect(tradeItemEntryFor(0x5002, { name: 'Scarab', iconId: 0x06004321, iconDid: 0x06009999 }, false).iconDid).toBe(0x06004321);
    // Unknown object → a blank slot (0), placeholder name, zero value / burden.
    expect(tradeItemEntryFor(0x5003, undefined, false)).toMatchObject({ name: 'Item 0x5003', value: 0, burden: 0, iconDid: 0 });
  });

  it('AddToTrade entry includes iconDid field (and RenderIcons\' inputs — CORE.18.c.a)', () => {
    const self = tradeItemEntryFor(0x5004, {
      name: 'Pyreal', value: 25, burden: 3, iconDid: 0x06001111, itemType: 0x40, uiEffects: 1,
      iconOverlayDid: 0x06006c34, iconUnderlayDid: 0x06005b0c,
    }, true);
    expect(self).toEqual({
      name: 'Pyreal', value: 25, guid: 0x5004, burden: 3, iconDid: 0x06001111,
      itemType: 0x40, uiEffects: 1, iconOverlayDid: 0x06006c34, iconUnderlayDid: 0x06005b0c,
    });
    // ServerObject spells the overlay / underlay DIDs *Id; 0 → no layer.
    const partner = tradeItemEntryFor(0x5005, { name: 'Gem', iconId: 0x06002222, itemType: 0x800, iconOverlayId: 0x06006c35, iconUnderlayId: 0 }, false);
    expect(partner.iconOverlayDid).toBe(0x06006c35);
    expect(partner.iconUnderlayDid).toBeUndefined();
    expect(partner.itemType).toBe(0x800);
  });

});

describe('FAITHFUL.542 / CORE.17.k.b.b.c.c.a.a.c.a.b — the trade lists draw 32-px icon cells (behavioral)', () => {
  const H = tradeHarness();
  const iconCalls: Array<[number, number]> = [];
  beforeAll(async () => {
    await H.setup();
    const real = H.ui.buildItemIconElement.bind(H.ui);
    H.ui.buildItemIconElement = (did: number, size: number, ...rest: unknown[]) => {
      iconCalls.push([did, size]);
      const el = real(did, size, ...rest) ?? domWindow.document.createElement('div');
      el.dataset.icon = `0x${did.toString(16)}`;
      return el;
    };
  });
  afterAll(() => H.teardown());
  beforeEach(() => { H.ui.hideTradeWindow(); iconCalls.length = 0; });

  const cells = (listId: number): HTMLElement[] => Array.from(H.el(listId).querySelectorAll('[data-ac-trade-cell]')) as HTMLElement[];

  it('tradeData entries carry iconDid through setTradeData / getTradeData', () => {
    H.open({ yourItems: [{ name: 'Arrow', value: 1, guid: 0x80001111, burden: 1, iconDid: 0x06001234 }] });
    expect(H.ui.getTradeData().yourItems[0].iconDid).toBe(0x06001234);
  });

  it('the player\'s items fill the RIGHT list 0x10000088, the partner\'s the LEFT 0x10000081, each item one cell with its icon at 32 px and its name as tooltip, no name/value text', () => {
    H.open({
      yourItems: [{ name: 'Arrow', value: 10, guid: 0x80001111, burden: 1, iconDid: 0x06001234 }],
      theirItems: [{ name: 'Gem', value: 100, guid: 0x80002222, burden: 1, iconDid: 0x06005678 }],
    });
    const mine = cells(0x10000088).filter((c) => c.dataset.acTradeCell === 'item');
    const theirs = cells(0x10000081).filter((c) => c.dataset.acTradeCell === 'item');
    expect(mine.map((c) => c.dataset.guid)).toEqual([String(0x80001111)]);
    expect(theirs.map((c) => c.dataset.guid)).toEqual([String(0x80002222)]);
    expect(iconCalls).toEqual([[0x06001234, 32], [0x06005678, 32]]);
    expect(mine[0].querySelector('[data-icon="0x6001234"]')).toBeTruthy();
    expect(mine[0].textContent).not.toContain('10');
    expect((H.ui.tradePanel as HTMLElement).textContent).not.toContain('Arrow');
  });

  it('UpdateEmptySlots: both 295-px lists pad to 9 tiles; the player\'s keeps one empty tile after its last item (attr 0x10000017), the partner\'s does not', () => {
    const many = (n: number, base: number) => Array.from({ length: n }, (_, i) => ({ name: `I${i}`, value: 1, guid: base + i, burden: 1, iconDid: 0 }));
    H.open();
    expect([cells(0x10000088).length, cells(0x10000081).length]).toEqual([9, 9]);
    H.open({ yourItems: many(9, 0x80001000), theirItems: many(9, 0x80002000) });
    expect([cells(0x10000088).length, cells(0x10000081).length]).toEqual([10, 9]);
    expect(cells(0x10000088).at(-1)!.dataset.acTradeCell).toBe('empty');
  });

  it('an item with iconDid 0 still takes its cell (its initial as a placeholder), no icon lookup', () => {
    H.open({ yourItems: [{ name: 'Rock', value: 0, guid: 0x80003333, burden: 1, iconDid: 0 }] });
    const cell = cells(0x10000088)[0];
    expect(cell.dataset.acTradeCell).toBe('item');
    expect(iconCalls).toEqual([]);
    expect(cell.textContent).toContain('R');
  });
});
