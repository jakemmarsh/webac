/**
 * BUG.vendor-icon-overlay-underlay-dropped — the overlay/underlay icon-badge
 * fix (BUG.icon-overlay-underlay-dropped) composited iconOverlayDid/
 * iconUnderlayDid onto item icons everywhere EXCEPT the vendor window:
 * VendorItemData already parses iconOverlayId/iconUnderlayId off the wire
 * (MessageSerializer.ts parseApproachVendor, covered by
 * verify-bug-icon-overlay-underlay-dropped.ts), but the pre-fix vendor
 * renderer drew icons with a raw CSS backgroundImage div instead of calling
 * buildItemIconElement — so a badged item showed plain in a vendor tab and
 * only gained its badge/glow once purchased into inventory.
 *
 * CORE.10.g rebuilt the vendor on the real classic_vendor layout
 * (0x21000012): item lists are now horizontal 710x32 icon strips
 * (UIElement_ItemList). This suite drives the real shipped
 * GameUI.showVendorWindow end to end (happy-dom) to confirm the strip
 * cells composite the same underlay/base/overlay markup as
 * buildItemIconElement's other callers (inventory, paperdoll).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// Element ids of the classic_vendor bar (layout 0x21000012 subtree 0x100000b7).
const VENDOR_ELEMENT_IDS = [
  0x100000b7, 0x100000d6, 0x100000b9, 0x100000ba, 0x100000bb,
  0x100000bc, 0x100000c4, 0x100000cd,
  0x100000bf, 0x1000034d, 0x100000c0, 0x100000c1, 0x100000bd, 0x100000be, 0x100000c2, 0x100000c3,
  0x100000c5, 0x100000c6, 0x100000c7, 0x100000c8, 0x100000c9, 0x100000ca, 0x100000cb, 0x100000cc,
  0x100000ce, 0x100000cf, 0x100000d0, 0x100000d1, 0x100000d2, 0x100000d3, 0x100000d4, 0x100000d5,
];

describe('BUG.vendor-icon-overlay-underlay-dropped — vendor strip cells composite overlay/underlay', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

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
          setText: () => {}, setState: () => {}, setVisible: () => {},
          setFill: () => {}, setPalette: () => {},
          setInteractive: (id: number, fn?: (id: number, el: HTMLElement) => void) => {
            const el = elements.get(id);
            if (el && fn) el.addEventListener('click', () => fn(id, el));
          },
        };
      },
    };
    ui.itemIconCache.set(0x06000501, 'data:image/png;base64,BASE');
    ui.itemIconCache.set(0x06000502, 'data:image/png;base64,BADGE');
    ui.itemIconCache.set(0x06000503, 'data:image/png;base64,GLOW');
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  /** Strip cells of the active tab's item list (Items 0x100000bd, Selling 0x100000ce). */
  function cellsIn(tab: 'items' | 'sell'): HTMLElement[] {
    const listEl = ui.vendorLayoutHandle.elements.get(tab === 'items' ? 0x100000bd : 0x100000ce) as HTMLElement;
    const strip = listEl.children[0] as HTMLElement;
    // CORE.17.k.b.b.c.c.a.a.c.a.a.a.a.a.b — the view is padded with EMPTY tiles; items only.
    return [...strip.querySelectorAll('[data-item-cell]')] as HTMLElement[];
  }

  it('Items tab: a tiered/rare item renders the composited (underlay+base+overlay) icon', () => {
    ui.showVendorWindow('Test Vendor', [
      { guid: 1, weenieClassId: 900, name: 'Rare Aetheria', price: 100, burden: 1, iconDid: 0x06000501, iconOverlayDid: 0x06000502, iconUnderlayDid: 0x06000503 },
    ], [], undefined, undefined, undefined, undefined, 0x70120001);
    const cell = cellsIn('items')[0];
    const composited = cell.children[0] as HTMLElement;
    expect(composited.style.position).toBe('relative');
    expect(composited.children.length).toBe(3);
    const [underlay, base, overlay] = [...composited.children] as HTMLElement[];
    expect(underlay.style.backgroundImage).toContain('data:image/png;base64,GLOW');
    expect(base.style.backgroundImage).toContain('data:image/png;base64,BASE');
    expect(overlay.style.backgroundImage).toContain('data:image/png;base64,BADGE');
  });

  it('Items tab: a plain item (no overlay/underlay) still renders the single-div fallback', () => {
    ui.showVendorWindow('Test Vendor', [
      { guid: 2, weenieClassId: 901, name: 'Plain Dagger', price: 10, burden: 1, iconDid: 0x06000501 },
    ], [], undefined, undefined, undefined, undefined, 0x70120002);
    const cell = cellsIn('items')[0];
    const plain = cell.children[0] as HTMLElement;
    expect(plain.style.backgroundImage).toContain('data:image/png;base64,BASE');
    expect(plain.children.length).toBe(0);
  });

  it('Items tab: an item with no resolvable icon falls back to the letter tile', () => {
    ui.showVendorWindow('Test Vendor', [
      { guid: 3, weenieClassId: 902, name: 'Mystery', price: 5, burden: 1 },
    ], [], undefined, undefined, undefined, undefined, 0x70120003);
    const cell = cellsIn('items')[0];
    const letter = cell.children[0] as HTMLElement;
    expect(letter.style.background).toContain('rgba(20, 18, 30, 0.4)');
    expect(letter.children.length).toBe(1);
  });

  it('Selling tab: a badged inventory item queued for sale also composites the badge', () => {
    ui.showVendorWindow('Test Vendor', [], [
      { guid: 4, weenieClassId: 903, name: 'My Rare', price: 50, burden: 1, iconDid: 0x06000501, iconOverlayDid: 0x06000502, iconUnderlayDid: 0x06000503 },
    ], undefined, undefined, undefined, undefined, 0x70120004);
    ui.addVendorSellListItem(4, 1);
    const cell = cellsIn('sell')[0];
    const composited = cell.children[0] as HTMLElement;
    expect(composited.style.position).toBe('relative');
    expect(composited.children.length).toBe(3);
  });

  it('updateVendorSellItems (live refresh path) also threads overlay/underlay through', () => {
    ui.showVendorWindow('Test Vendor', [], [
      { guid: 5, weenieClassId: 904, name: 'Refreshed Rare', price: 75, burden: 1, iconDid: 0x06000501 },
    ], undefined, undefined, undefined, undefined, 0x70120005);
    ui.addVendorSellListItem(5, 1);
    ui.updateVendorSellItems([
      { guid: 5, weenieClassId: 904, name: 'Refreshed Rare', price: 75, burden: 1, iconDid: 0x06000501, iconOverlayDid: 0x06000502, iconUnderlayDid: 0x06000503 },
    ]);
    const cell = cellsIn('sell')[0];
    const composited = cell.children[0] as HTMLElement;
    expect(composited.style.position).toBe('relative');
    expect(composited.children.length).toBe(3);
  });
});
