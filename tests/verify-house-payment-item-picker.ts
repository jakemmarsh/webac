/**
 * BUG.house-buy-rent-payment-item-selection-ui — the House panel's Buy/Rent
 * tabs displayed the Purchase Cost / Rent Cost lists (SWEEP.6) but had no
 * way to actually complete a transaction: buyHouse(slumlordGuid,
 * paymentItems)/rentHouse(...) (main.ts) both require the caller to already
 * have assembled the exact list of inventory item guids to offer as payment
 * (ACE GameActionHouseBuyHouse.cs/GameActionHouseRentHouse.cs:
 * slumlordGuid u32 + ReadListUInt32 items), and were reachable only via
 * window.acDebug.
 *
 * Retail's gmSlumlordUI (reference/client-eol/symbols/demangled.txt)
 * accepts payment items via drag-drop onto an item list
 * (ItemListDragHandler::AcceptDragObject -> DragItemAcceptable -> NeedsMore)
 * and commits via a Buy/Rent button once every requirement is met
 * (IsPaymentAllowed: Buy_House iff unowned, Rent_House iff owned — rent can
 * be paid by proxy by any player per the decompiled
 * CloseRentPaymentByProxyConfirmationDialog, not just the owner).
 *
 * This drives the real GameUI.addHousePaymentItem/removeHousePaymentItem/
 * getHousePayment plus the rendered payment tray (drop target, staged rows,
 * Buy/Rent button gating) under happy-dom, mirroring
 * verify-house-panel-auto-open.ts's harness. main.ts's onDropToHousePayment
 * drag callback and setHouseCallbacks wiring aren't separately covered here
 * — main.ts is never imported in this test tree (side effects at module
 * scope) and both are thin one-line forwards with no extractable decision
 * logic (per the test-suite hygiene ratchet's behavioral-only bar for new
 * files); the actual regression surface — wcid/NeedsMore validation and the
 * fully-paid gate — lives entirely in GameUI and is covered below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { ItemType, COINSTACK_WCID } from '../packages/shared/src/game-types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

// Minimal HouseProfile fixture: one non-monetary requirement (a specific
// weenie, wcid 9549 — the retail "deed" wcid per Player_House.cs's
// RemoveDeed) and one monetary requirement (wcid 273 = coinstack, payable
// with either plain pyreal stacks or any trade note denomination).
const PROFILE_FIXTURE = {
  dwellingId: 1, bitmask: 1, minLevel: -1, maxLevel: -1, minAllegRank: -1, maxAllegRank: -1,
  buy: [
    { name: 'Deed', pluralName: 'Deeds', num: 1, paid: 0, weenieId: 9549 },
    { name: 'Trade Note', pluralName: 'Trade Notes', num: 5000, paid: 0, weenieId: COINSTACK_WCID },
  ],
  rent: [
    { name: 'Trade Note', pluralName: 'Trade Notes', num: 1000, paid: 200, weenieId: COINSTACK_WCID },
  ],
};

describe('BUG.house-buy-rent-payment-item-selection-ui — payment picker', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  // CORE.17.k.b.b.c.c.a — the slumlord's dwelling facts (type / owner /
  // slumlord guid) ride the HouseProfile itself; the player's own HouseData
  // is the World panel's House page and never reaches this dialog.
  const openUnowned = (): void => {
    ui.setHouseData({
      profile: {
        ...PROFILE_FIXTURE,
        houseType: 1, typeName: 'Cottage', ownerName: '', ownerId: 0, maintenanceFree: false,
        slumlordGuid: 0x80000123,
      },
    });
    ui.showSlumlordPanel();
  };

  const openOwned = (): void => {
    ui.setHouseData({
      profile: {
        ...PROFILE_FIXTURE,
        houseType: 1, typeName: 'Cottage', ownerName: 'Someone', ownerId: 0x50000001, maintenanceFree: false,
        slumlordGuid: 0x80000123,
      },
    });
    ui.showSlumlordPanel();
  };

  it('exact-wcid match: accepts a non-monetary item matching the required weenieId', () => {
    openUnowned();
    const accepted = ui.addHousePaymentItem('buy', {
      guid: 0x40000001, name: 'Deed', weenieClassId: 9549, itemType: 0, stackSize: 1, value: 0,
    });
    expect(accepted).toBe(true);
    expect(ui.getHousePayment('buy')).toEqual([{ guid: 0x40000001, name: 'Deed', amount: 1, weenieId: 9549 }]);
    ui.hideSlumlordPanel();
  });

  it('rejects an item whose wcid matches nothing required', () => {
    openUnowned();
    const accepted = ui.addHousePaymentItem('buy', {
      guid: 0x40000002, name: 'Iron Key', weenieClassId: 12345, itemType: 0, stackSize: 1, value: 0,
    });
    expect(accepted).toBe(false);
    expect(ui.getHousePayment('buy')).toEqual([]);
    ui.hideSlumlordPanel();
  });

  it('rejects a duplicate guid already staged (ItemList_IsInList)', () => {
    openUnowned();
    expect(ui.addHousePaymentItem('buy', { guid: 0x40000003, name: 'Deed', weenieClassId: 9549, itemType: 0, stackSize: 1, value: 0 })).toBe(true);
    expect(ui.addHousePaymentItem('buy', { guid: 0x40000003, name: 'Deed', weenieClassId: 9549, itemType: 0, stackSize: 1, value: 0 })).toBe(false);
    expect(ui.getHousePayment('buy')).toHaveLength(1);
    ui.hideSlumlordPanel();
  });

  it('monetary requirement (wcid 273): accepts a plain pyreal stack by exact wcid, contributing stackSize', () => {
    openUnowned();
    const accepted = ui.addHousePaymentItem('buy', {
      guid: 0x40000004, name: 'Pyreals', weenieClassId: COINSTACK_WCID, itemType: 0, stackSize: 2000, value: 0,
    });
    expect(accepted).toBe(true);
    expect(ui.getHousePayment('buy')).toEqual([{ guid: 0x40000004, name: 'Pyreals', amount: 2000, weenieId: COINSTACK_WCID }]);
    ui.hideSlumlordPanel();
  });

  it('monetary requirement (wcid 273): also accepts any ItemType.PromissoryNote (trade note), contributing value not stackSize', () => {
    openUnowned();
    // A single trade note is a stack of 1 note worth 5000 pyreals — the
    // ACE HousePayment.cs dual-match (wcid 273 OR ItemType.PromissoryNote).
    const accepted = ui.addHousePaymentItem('buy', {
      guid: 0x40000005, name: 'Trade Note (5000)', weenieClassId: 2624, itemType: ItemType.PromissoryNote, stackSize: 1, value: 5000,
    });
    expect(accepted).toBe(true);
    expect(ui.getHousePayment('buy')).toEqual([{ guid: 0x40000005, name: 'Trade Note (5000)', amount: 5000, weenieId: COINSTACK_WCID }]);
    ui.hideSlumlordPanel();
  });

  it('NeedsMore: rejects further contributions once a requirement is already fully covered', () => {
    openUnowned();
    expect(ui.addHousePaymentItem('buy', { guid: 0x40000006, name: 'Deed', weenieClassId: 9549, itemType: 0, stackSize: 1, value: 0 })).toBe(true);
    // Num required is 1 for the deed — a second one should be rejected.
    expect(ui.addHousePaymentItem('buy', { guid: 0x40000007, name: 'Deed', weenieClassId: 9549, itemType: 0, stackSize: 1, value: 0 })).toBe(false);
    expect(ui.getHousePayment('buy')).toHaveLength(1);
    ui.hideSlumlordPanel();
  });

  it('CORE.17.k.b.b.c.c.a.a.c — the server-sent HousePayment.Paid does not reduce what the list takes: CleanItemLists → HousePaymentList::ClearPayment zeroes it', () => {
    openOwned();
    // Rent fixture: num=1000, paid=200 server-side — retail's ledger starts at paid 0, so the full 1000 is owed.
    expect(ui.addHousePaymentItem('rent', { guid: 0x40000008, name: 'Pyreals', weenieClassId: COINSTACK_WCID, itemType: 0, stackSize: 800, value: 0 })).toBe(true);
    expect(ui.addHousePaymentItem('rent', { guid: 0x40000009, name: 'Pyreals', weenieClassId: COINSTACK_WCID, itemType: 0, stackSize: 200, value: 0 })).toBe(true);
    // 1000 staged covers num -> a further contribution is rejected.
    expect(ui.addHousePaymentItem('rent', { guid: 0x4000000c, name: 'Pyreals', weenieClassId: COINSTACK_WCID, itemType: 0, stackSize: 1, value: 0 })).toBe(false);
    ui.hideSlumlordPanel();
  });

  it('removeHousePaymentItem unstages a payment item', () => {
    openUnowned();
    ui.addHousePaymentItem('buy', { guid: 0x4000000a, name: 'Deed', weenieClassId: 9549, itemType: 0, stackSize: 1, value: 0 });
    expect(ui.getHousePayment('buy')).toHaveLength(1);
    ui.removeHousePaymentItem('buy', 0x4000000a);
    expect(ui.getHousePayment('buy')).toEqual([]);
    ui.hideSlumlordPanel();
  });

  it('a fresh HouseProfile clears previously staged payment items (CleanItemLists)', () => {
    openUnowned();
    ui.addHousePaymentItem('buy', { guid: 0x4000000b, name: 'Deed', weenieClassId: 9549, itemType: 0, stackSize: 1, value: 0 });
    expect(ui.getHousePayment('buy')).toHaveLength(1);
    // A second HouseProfile arrives (e.g. re-using the slumlord).
    ui.setHouseData({ profile: PROFILE_FIXTURE });
    expect(ui.getHousePayment('buy')).toEqual([]);
    ui.hideSlumlordPanel();
  });

  // CORE.17.k.b.b.c.c.a.a — the dialog is gmSlumlordUI's layout 0x2100000e:
  // both pages carry a UIElement_ItemList (0x10000095 / 0x1000009c) and a
  // button (0x10000094 Buy / 0x1000009b Maintenance) whose UIElement_Button
  // state UpdateButtons @ 004c7fe0 sets (1 enabled / 0xd disabled).
  const el = (id: number): HTMLElement => container.querySelector(`[data-slumlord-panel] [data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
  const clickEl = (id: number): void => {
    for (const type of ['mousedown', 'mouseup', 'click']) el(id).dispatchEvent(new domWindow.MouseEvent(type, { bubbles: true }));
  };
  const answerYes = (): void => {
    const btn = [...domWindow.document.body.querySelectorAll('div')].find((d: HTMLElement) => d.textContent === 'Yes' && d.style.cursor === 'pointer');
    expect(btn).toBeTruthy();
    btn.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
  };

  it('IsPaymentAllowed: while unowned the Buy list takes items and the Rent list refuses them', () => {
    openUnowned();
    expect(el(0x10000095)).toBeTruthy();
    expect(el(0x1000009c)).toBeTruthy();
    expect(ui.addHousePaymentItem('rent', { guid: 0x40000011, name: 'Pyreals', weenieClassId: COINSTACK_WCID, itemType: 0, stackSize: 800, value: 0 })).toBe(false);
    expect(ui.addHousePaymentItem('buy', { guid: 0x40000012, name: 'Deed', weenieClassId: 9549, itemType: 0, stackSize: 1, value: 0 })).toBe(true);
    ui.hideSlumlordPanel();
  });

  it('IsPaymentAllowed: while owned the Rent list takes items, the Buy list refuses them; the Maintenance button follows the Rent list', () => {
    openOwned();
    expect(ui.addHousePaymentItem('buy', { guid: 0x40000013, name: 'Deed', weenieClassId: 9549, itemType: 0, stackSize: 1, value: 0 })).toBe(false);
    expect(el(0x1000009b).dataset.acState).toBe('d');
    expect(ui.addHousePaymentItem('rent', { guid: 0x40000014, name: 'Pyreals', weenieClassId: COINSTACK_WCID, itemType: 0, stackSize: 100, value: 0 })).toBe(true);
    expect(el(0x1000009b).dataset.acState).toBe('1');
    ui.hideSlumlordPanel();
  });

  it('the Buy button fires onBuyHouse with the slumlord guid and staged item guids once fully paid (through the 30-day confirmation)', () => {
    openUnowned();
    let received: { slumlordGuid: number; itemGuids: number[] } | null = null;
    ui.setHouseCallbacks({
      onBuyHouse: (slumlordGuid: number, itemGuids: number[]) => { received = { slumlordGuid, itemGuids }; },
    });
    // addHousePaymentItem re-renders the panel each time (setHouseData does
    // too, but the button's click handler reads `this.houseCallbacks` live
    // at click time, so it doesn't matter whether the callback was set
    // before or after the button element was built).
    ui.addHousePaymentItem('buy', { guid: 0x4000000c, name: 'Deed', weenieClassId: 9549, itemType: 0, stackSize: 1, value: 0 });
    expect(el(0x10000094).dataset.acState).toBe('d');
    ui.addHousePaymentItem('buy', { guid: 0x4000000d, name: 'Trade Note (5000)', weenieClassId: 2624, itemType: ItemType.PromissoryNote, stackSize: 1, value: 5000 });
    expect(el(0x10000094).dataset.acState).toBe('1');

    clickEl(0x10000094);
    expect(received).toBeNull(); // MakeBuyHouseConfirmationDialog first
    answerYes();
    expect(received).toEqual({ slumlordGuid: 0x80000123, itemGuids: [0x4000000c, 0x4000000d] });
    expect(ui.getHousePayment('buy')).toEqual([]); // MakePayment's CleanItemLists
    ui.hideSlumlordPanel();
  });

  it('the Buy button in 0xd ignores the click while payment is incomplete', () => {
    openUnowned();
    // Nothing staged — the button renders in state 0xd (0x06002346) and a
    // click on it never reaches onBuyHouse (UIElement_Button ignores input
    // in 0xd).
    let called = false;
    ui.setHouseCallbacks({ onBuyHouse: () => { called = true; } });
    expect(el(0x10000094).dataset.acState).toBe('d');
    clickEl(0x10000094);
    expect(domWindow.document.querySelector('.ac-dialog-text')).toBeNull();
    expect(called).toBe(false);
    ui.hideSlumlordPanel();
  });
});
