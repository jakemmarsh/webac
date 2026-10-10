/**
 * FAITHFUL.203 → CORE.17.k.b.b.c.c.a — the housing UI surface.
 *
 * The HouseProfile / HouseData / HouseUpdateHAR / HouseUpdateRentPayment /
 * HouseUpdateRestrictions events feed two retail surfaces: the player's OWN
 * house is the World panel's House page (gmHouseUI — a text listbox, see
 * verify-core17kbbcca-house-page.ts for the page itself), and a slumlord's
 * dwelling is the slumlord dialog (gmSlumlordUI). The former 3-tab
 * Profile / Access / Rent panel had no retail counterpart and is gone.
 *
 * Behavioural (this file used to source-grep GameUI.ts / main.ts): the
 * real GameUI under happy-dom — setHouseData's routing (HouseData → the
 * page rows, HouseProfile → the slumlord dialog), clearHouseData (the 0x226
 * HouseStatus), and the retired tabs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { HOUSE_PANEL_STRINGS } from '../packages/renderer/src/ui/HousePanelText.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const OWN_HOUSE = {
  houseType: 1, typeName: 'Cottage', maintenanceFree: false,
  buyTimeUnix: 1_700_000_000, rentTimeUnix: 1_700_000_000,
  position: { cell: 0xA9B40001, x: 12, y: 12, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 },
};
const PROFILE = {
  dwellingId: 0x7200016e, bitmask: 1, houseType: 2, typeName: 'Villa', ownerName: 'Someone', ownerId: 0x50000001,
  maintenanceFree: false, slumlordGuid: 0x80000123,
  minLevel: -1, maxLevel: -1, minAllegRank: -1, maxAllegRank: -1,
  buy: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 38000, paid: 0, weenieId: 273 }],
  rent: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 1000, paid: 0, weenieId: 273 }],
};

describe('CORE.17.k.b.b.c.c.a — housing state routing (behavioural, happy-dom)', () => {
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

  it('a HouseData patch (summary + buy / rent lists) becomes the House page rows in gmHouseUI::DisplayHouseData\'s order', () => {
    ui.setHousePurchaseTimestamp(0);
    ui.setHouseData({
      summary: OWN_HOUSE,
      buyPayments: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 38000, paid: 0, weenieId: 273 }],
      rentPayments: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 1000, paid: 1000, weenieId: 273 }],
    });
    const rows = ui.housePageRows(1_700_000_100).map((r: { text: string }) => r.text);
    expect(rows[0]).toBe(HOUSE_PANEL_STRINGS.purchasePrice + '38000 Pyreals');
    expect(rows[1]).toBe(HOUSE_PANEL_STRINGS.rent + '1000/1000 Pyreals');
    expect(rows[2].startsWith(HOUSE_PANEL_STRINGS.bought)).toBe(true);
    expect(rows[3].startsWith(HOUSE_PANEL_STRINGS.periodEnds)).toBe(true);
    expect(rows[4].startsWith(HOUSE_PANEL_STRINGS.nextDue)).toBe(true);
    expect(rows[5].startsWith(HOUSE_PANEL_STRINGS.location)).toBe(true);
    expect(rows[6]).toBe(HOUSE_PANEL_STRINGS.rentPaid);
    expect(rows[7]).toBe(HOUSE_PANEL_STRINGS.buyAnotherAfterAbandon);
    expect(rows).toHaveLength(8);
  });

  it('a HouseUpdateRentPayment patch replaces the rent list only — the warning row flips to RentNotPaid (yellow, entry 2)', () => {
    ui.setHouseData({ rentPayments: [{ name: 'Pyreal', pluralName: 'Pyreals', num: 1000, paid: 200, weenieId: 273 }] });
    const rows = ui.housePageRows(1_700_000_100);
    expect(rows[1].text).toBe(HOUSE_PANEL_STRINGS.rent + '200/1000 Pyreals');
    expect(rows[6].colorIndex).toBe(2);
    expect(rows[6].text.startsWith(HOUSE_PANEL_STRINGS.warningHead)).toBe(true);
    expect(rows[0].text).toBe(HOUSE_PANEL_STRINGS.purchasePrice + '38000 Pyreals'); // the buy list survives
  });

  it('clearHouseData (the 0x226 HouseStatus — gmHouseUI::Update(ulong)) drops the HouseData: the no-house rows', () => {
    ui.clearHouseData();
    expect(ui.getHouseData().summary).toBeNull();
    expect(ui.getHouseData().rentPayments).toEqual([]);
    expect(ui.housePageRows(1_700_000_100).map((r: { text: string }) => r.text))
      .toEqual([HOUSE_PANEL_STRINGS.noHouse, HOUSE_PANEL_STRINGS.buyAnotherNow]);
  });

  it('a HouseProfile patch feeds the slumlord dialog and never the House page (the slumlord\'s dwelling is not the player\'s house)', () => {
    ui.setHouseData({ profile: PROFILE });
    expect(ui.getHouseData().summary).toBeNull();
    expect(ui.housePageRows(1_700_000_100)[0].text).toBe(HOUSE_PANEL_STRINGS.noHouse);
    ui.showSlumlordPanel();
    const panel = container.querySelector('[data-slumlord-panel]') as HTMLElement;
    expect(panel).toBeTruthy();
    // CORE.17.k.b.b.c.c.a.a — gmSlumlordUI::RefreshHouse: ComposeText(Buy_House)
    // in the Buy requirements text, ComposeText2(Rent_House) in the
    // Maintenance one, "Owner: " + name in the owner texts; no dwelling type.
    const textOf = (id: number): string => (panel.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement).textContent as string;
    expect(textOf(0x10000091)).toBe('38000 Pyreals');
    expect(textOf(0x10000098)).toBe('0/1000 Pyreals');
    expect(textOf(0x10000093)).toBe('Owner: Someone');
    expect(panel.textContent).not.toContain('Villa');
    ui.hideSlumlordPanel();
    expect(container.querySelector('[data-slumlord-panel]')).toBeNull();
  });

  it('the retired Profile / Access / Rent tabs are gone from the slumlord dialog — the pair is Buy / Maintenance', () => {
    ui.setHouseData({
      profile: PROFILE,
      access: { monarchId: 0, guests: [{ guid: 1, name: 'Aerlinthe', storageAccess: true }], roommates: [], openStatus: false },
    });
    ui.showSlumlordPanel();
    const panel = container.querySelector('[data-slumlord-panel]') as HTMLElement;
    const text = panel.textContent as string;
    expect(panel.querySelector('[data-element-id="0x1000008e"]')).toBeTruthy(); // the Buy tab
    expect(panel.querySelector('[data-element-id="0x1000008f"]')).toBeTruthy(); // the Maintenance tab
    expect(text).not.toContain('Rent Cost');
    expect(text).not.toContain('Access');
    expect(text).not.toContain('Profile');
    expect(text).not.toContain('Aerlinthe');
    expect(text).not.toContain('guests');
    ui.hideSlumlordPanel();
  });

  it('toggleSlumlordPanel opens and closes; showSlumlordPanel is idempotent', () => {
    ui.toggleSlumlordPanel();
    expect(container.querySelector('[data-slumlord-panel]')).toBeTruthy();
    ui.showSlumlordPanel();
    expect(container.querySelectorAll('[data-slumlord-panel]')).toHaveLength(1);
    ui.toggleSlumlordPanel();
    expect(container.querySelector('[data-slumlord-panel]')).toBeNull();
  });
});
