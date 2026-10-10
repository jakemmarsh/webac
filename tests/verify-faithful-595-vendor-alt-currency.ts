/**
 * FAITHFUL.595 — vendor alternate currency surfaced in the UI
 * (faithfulness sweep 2026-06-03 finding #8; parsed-unused shape).
 *
 * ACE GameEventApproachVendor.cs:27-46 writes, after sellPrice: the
 * AlternateCurrency wcid (u32), the count of that currency the player holds
 * (u32), and its plural name (String16L) — sent precisely so the client can
 * label prices in that currency. Vendor.cs:546-563 + Player_Commerce.cs:63
 * denominate purchases at such vendors in the alt currency, not pyreals.
 *
 * Pre-fix: parseApproachVendor read all three fields byte-correctly and the
 * consumer dropped them — alt-currency vendors displayed pyreal-style
 * prices with no indication of the real denomination or the player's
 * holdings.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(__dir, '..', 'packages', 'renderer', 'src');
const mainSrc = readFileSync(join(RENDERER, 'main.ts'), 'utf8');
const gameUiSrc = readFileSync(join(RENDERER, 'ui', 'GameUI.ts'), 'utf8');

describe('FAITHFUL.595: alt-currency fields reach the vendor UI', () => {
  it('onApproachVendor passes altCurrencyName + altCurrencyAmount when alternateCurrency != 0', () => {
    expect(mainSrc).toMatch(/const hasAltCurrency = \(parsed\.alternateCurrency \?\? 0\) !== 0;/);
    expect(mainSrc).toMatch(/hasAltCurrency \? \(parsed\.altCurrencyName \|\| 'tokens'\) : undefined/);
    expect(mainSrc).toMatch(/hasAltCurrency \? \(parsed\.altCurrencyAmount \?\? 0\) : undefined/);
  });

  it('showVendorWindow accepts and stores the alt-currency params', () => {
    expect(gameUiSrc).toMatch(/altCurrencyName\?: string,\s*\n\s*altCurrencyHeld\?: number,/);
    expect(gameUiSrc).toMatch(/this\.vendorData\.altCurrencyName = altCurrencyName \?\? null;/);
    expect(gameUiSrc).toMatch(/this\.vendorData\.altCurrencyHeld = altCurrencyHeld \?\? 0;/);
  });

  it('resets alt-currency state on each vendor open (no stale label on pyreal vendors)', () => {
    // The ?? null / ?? 0 forms are unconditional assignments in showVendorWindow,
    // unlike the `if (buyRate)`-style updates above them.
    const m = gameUiSrc.match(/showVendorWindow\([\s\S]{0,4000}?this\.vendorVisible = true;/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain('altCurrencyName ?? null');
    expect(m![0]).toContain('altCurrencyHeld ?? 0');
  });
});

// CORE.10.g/.a — behavioral: on the rebuilt classic_vendor bar the retail
// surfaces for the alt currency are the Items cost line + the Buying
// value/purse lines (VendorBuyUI::UpdateTransactionValue / UpdateTotalValue
// non-pyreal sprintf branches). Sell proceeds stay pyreals (ACE
// Player_Commerce sell path; VendorSellUI @ 004c35b0/004c3750 has no
// alt-currency branch), so NEITHER Selling line ever carries the currency
// name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const VENDOR_ELEMENT_IDS = [
  0x100000b7, 0x100000d6, 0x100000b9, 0x100000ba, 0x100000bb,
  0x100000bc, 0x100000c4, 0x100000cd,
  0x100000bf, 0x1000034d, 0x100000c0, 0x100000c1, 0x100000bd, 0x100000be, 0x100000c2, 0x100000c3,
  0x100000c5, 0x100000c6, 0x100000c7, 0x100000c8, 0x100000c9, 0x100000ca, 0x100000cb, 0x100000cc,
  0x100000ce, 0x100000cf, 0x100000d0, 0x100000d1, 0x100000d2, 0x100000d3, 0x100000d4, 0x100000d5,
];

describe('FAITHFUL.595 + CORE.10.g — alt-currency value/purse lines (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const texts = new Map<number, string>();

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      render: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of VENDOR_ELEMENT_IDS) {
          const el = domWindow.document.createElement('div');
          el.setAttribute('data-element-id', `0x${id.toString(16)}`);
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements, descs: new Map(),
          setText: (id: number, text: string) => { texts.set(id, text); },
          setState: () => {}, setVisible: () => {}, setFill: () => {}, setPalette: () => {},
          setInteractive: (id: number, fn?: (id: number, el: HTMLElement) => void) => {
            const el = elements.get(id);
            if (el && fn) el.addEventListener('click', () => fn(id, el));
          },
        };
      },
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  // CORE.10.g.a — retail line formats recovered from the acclient.exe push
  // operands (the decompile lost the sprintf/Formatted format args):
  // alt-currency branches are the narrow strings "This item costs %d %s.
  // You have %d %s." / "Buying %d %s worth %d %s." / "You have %d %s."
  // (plain %d — NO comma grouping, trailing periods), replacing the
  // previously-invented "N CurrencyName" labels.
  it('alt-currency vendor: Items-tab cost line is denominated in the currency, purse shows held count', () => {
    texts.clear();
    ui.showVendorWindow('Token Vendor', [
      { guid: 11, weenieClassId: 900, name: 'Promissory Note', price: 1250, burden: 1, itemType: 0x40000 },
    ], [], '1.25', '0.75', 'Colosseum Tokens', 4321, 0x70130001);
    // Select the merchandise item → cost line (0x100000c1) updates.
    const listEl = ui.vendorLayoutHandle.elements.get(0x100000bd) as HTMLElement;
    ((listEl.children[0] as HTMLElement).children[0] as HTMLElement).click();
    expect(texts.get(0x100000c1)).toBe('This item costs 1250 Colosseum Tokens. You have 4321 Colosseum Tokens.');
    // Buying tab purse line (0x100000c8) shows the alt-currency holdings.
    ui.vendorData.tab = 1;
    ui.renderVendorPanel();
    expect(texts.get(0x100000c8)).toBe('You have 4321 Colosseum Tokens.');
    expect(texts.get(0x100000c7)).toBe('Buying 0 items worth 0 Colosseum Tokens.');
  });

  it('pyreal vendor: retail sentences with comma values + "p" suffix, purse = CoinValue', () => {
    texts.clear();
    ui.hud.coinValue = 98765;
    ui.showVendorWindow('Pyreal Vendor', [
      { guid: 12, weenieClassId: 901, name: 'Dagger', price: 150, burden: 1, itemType: 0x1 },
    ], [], '1.25', '0.75', undefined, undefined, 0x70130002);
    const listEl = ui.vendorLayoutHandle.elements.get(0x100000bd) as HTMLElement;
    ((listEl.children[0] as HTMLElement).children[0] as HTMLElement).click();
    // "%s %hsp (you have %hsp)" with %s = "costs" for a split of 1.
    expect(texts.get(0x100000c1)).toBe('costs 150p (you have 98,765p)');
    ui.vendorData.tab = 1;
    ui.renderVendorPanel();
    expect(texts.get(0x100000c8)).toBe('You have 98,765p');
  });

  it('Selling lines stay pyreal-denominated even at an alt-currency vendor', () => {
    texts.clear();
    ui.hud.coinValue = 98765;
    ui.showVendorWindow('Token Vendor', [], [
      { guid: 13, weenieClassId: 902, name: 'Loot', price: 500, burden: 1, stackSize: 1 },
    ], '1.25', '0.75', 'Colosseum Tokens', 7, 0x70130003);
    ui.addVendorSellListItem(13, 1);
    expect(texts.get(0x100000d0)).toBe('Selling 1 item worth 500p');
    // CORE.10.g.a premise fix: VendorSellUI::UpdateTotalValue @ 004c3750 has
    // ONLY the pyreal branch — the Selling purse never names the alt
    // currency (the old '7 Colosseum Tokens' assertion was invented).
    expect(texts.get(0x100000d1)).toBe('You have 98,765p');
  });
});
