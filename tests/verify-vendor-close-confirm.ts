/**
 * gmVendorUI::HandleButtonClicks @ 004c50d0 case 0x100000d6 (the close box,
 * decomp :191062-191090): with an item still on the Buying or Selling list
 * the vendor asks "You have not completed all transactions. Are you sure you
 * want to leave this vendor?" and CloseVendorDialogCallback closes on Yes;
 * with both lists empty it closes at once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('vendor close box asks before dropping queued transactions', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  let closed = 0;
  let asked: Array<{ text: string; answer: (yes: boolean) => void }> = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.hideVendorWindow = () => { closed++; };
    ui.showConfirmationDialog = (text: string, answer: (yes: boolean) => void) => { asked.push({ text, answer }); };
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const reset = (buy: number, sell: number) => {
    closed = 0; asked = [];
    ui.vendorData.buyList = buy ? [{ guid: 0x8000_0001, qty: buy }] : [];
    ui.vendorData.sellList = sell ? [{ guid: 0x8000_0002, qty: sell }] : [];
  };

  it('both lists empty: closes at once, no dialog', () => {
    reset(0, 0);
    ui.closeVendorFromUi();
    expect(closed).toBe(1);
    expect(asked).toEqual([]);
  });

  it('a queued buy: the retail confirmation, closing only on Yes', () => {
    reset(3, 0);
    ui.closeVendorFromUi();
    expect(closed).toBe(0);
    expect(asked.map((a) => a.text)).toEqual([mod.VENDOR_LEAVE_CONFIRM_TEXT]);
    expect(mod.VENDOR_LEAVE_CONFIRM_TEXT).toBe('You have not completed all transactions. Are you sure you want to leave this vendor?');
    asked[0].answer(false);
    expect(closed).toBe(0);
    asked[0].answer(true);
    expect(closed).toBe(1);
  });

  it('a queued sell asks too', () => {
    reset(0, 1);
    ui.closeVendorFromUi();
    expect(asked.length).toBe(1);
    expect(closed).toBe(0);
  });
});
