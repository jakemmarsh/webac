/**
 * SWEEP.6 → CORE.17.k.b.b.c.c.a.a — a HouseProfile's cost lists reach the
 * slumlord dialog the way gmSlumlordUI::RefreshHouse @ 004c8b20 writes them.
 *
 * ServerMessageHandler fully parses GameEventHouseProfile (ACE
 * Network/Structure/HouseProfile.cs Write order) including the Buy/Rent
 * HousePayment lists; pre-fix main.ts onHouseProfile forwarded only the
 * summary — the panel could never show what a dwelling costs.
 *
 * Retail's dialog (layout 0x2100000e) shows exactly two texts per page: the
 * requirements text — HouseProfile::ComposeText(Buy_House) ("num name, …")
 * on the Buy page, ComposeText2(Rent_House) ("paid/num name, …") on the
 * Maintenance page — and "Owner: " + name / "None". The level / allegiance
 * rank / monarch requirements are server-enforced (Player_House.cs's
 * WeenieErrors) and never drawn; the dwelling type is not drawn either.
 *
 * Behavioral: drives the real GameUI under happy-dom (same harness as
 * verify-gameui-dom-smoke.ts; tests/_harness/dom.ts). Without DATs
 * the dialog is the no-DAT fallback surface with the same element ids.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { SLUMLORD_EL } from '../packages/renderer/src/ui/SlumlordPanel.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const dwelling = (over: Record<string, unknown> = {}) => ({
  dwellingId: 0x7200016e, bitmask: 1, houseType: 1, typeName: 'Cottage', ownerName: '', ownerId: 0,
  maintenanceFree: false, slumlordGuid: 0x80000123,
  minLevel: -1, maxLevel: -1, minAllegRank: -1, maxAllegRank: -1, buy: [], rent: [],
  ...over,
});

describe('SWEEP.6 — the slumlord dialog shows the HouseProfile cost lists (RefreshHouse)', () => {
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

  const textOf = (id: number): string => {
    const el = container.querySelector(`[data-slumlord-panel] [data-element-id="0x${id.toString(16)}"]`) as HTMLElement | null;
    expect(el, `0x${id.toString(16)}`).toBeTruthy();
    return el!.textContent as string;
  };

  it('renders the buy list as ComposeText and the rent list as ComposeText2 from a HouseProfile', () => {
    ui.setHouseData({
      profile: dwelling({
        minLevel: 20,
        buy: [
          { name: 'Pyreal', pluralName: 'Pyreals', num: 38000, paid: 0, weenieId: 273 },
          { name: 'Writ of Refuge', pluralName: 'Writs of Refuge', num: 5, paid: 2, weenieId: 15269 },
        ],
        rent: [
          { name: 'Pyreal', pluralName: 'Pyreals', num: 1000, paid: 0, weenieId: 273 },
        ],
      }),
    });
    ui.toggleSlumlordPanel();
    expect(textOf(SLUMLORD_EL.buyRequirements)).toBe('38000 Pyreals, 5 Writs of Refuge');
    expect(textOf(SLUMLORD_EL.rentRequirements)).toBe('0/1000 Pyreals');
    expect(textOf(SLUMLORD_EL.buyOwner)).toBe('Owner: None');
    // The level requirement is server-enforced — retail draws no requirement rows.
    const text = container.textContent as string;
    expect(text).not.toContain('Min level');
    expect(text).not.toContain('20');
    expect(text).not.toContain('Purchase Requirements');
    expect(text).not.toContain('Purchase Cost');
    ui.toggleSlumlordPanel(); // close again
  });

  it('singular payment uses the singular noun (HousePayment::GetName)', () => {
    ui.setHouseData({
      profile: dwelling({
        dwellingId: 1,
        buy: [{ name: 'Writ of Refuge', pluralName: 'Writs of Refuge', num: 1, paid: 0, weenieId: 15269 }],
      }),
    });
    ui.toggleSlumlordPanel();
    expect(textOf(SLUMLORD_EL.buyRequirements)).toBe('1 Writ of Refuge');
    ui.toggleSlumlordPanel();
  });

  it('a monarch-only dwelling (HouseBitfield.RequiresMonarch) draws no requirement row — Player_House.cs enforces it with YouMustBeMonarchToPurchaseDwelling', () => {
    ui.setHouseData({ profile: dwelling({ dwellingId: 2, bitmask: 0x2, houseType: 3, typeName: 'Mansion' }) });
    ui.toggleSlumlordPanel();
    const text = container.textContent as string;
    expect(text).not.toContain('Requires Monarch');
    expect(text).not.toContain('Mansion');
    expect(textOf(SLUMLORD_EL.buyRequirements)).toBe('');
    ui.toggleSlumlordPanel();
  });

  it('an owned dwelling shows "Owner: <name>" on both pages; the dialog without a profile mounts with empty texts', () => {
    ui.setHouseData({ profile: dwelling({ houseType: 2, typeName: 'Villa', ownerName: 'Someone', ownerId: 0x50000001, maintenanceFree: true }) });
    ui.toggleSlumlordPanel();
    expect(textOf(SLUMLORD_EL.buyOwner)).toBe('Owner: Someone');
    expect(textOf(SLUMLORD_EL.rentOwner)).toBe('Owner: Someone');
    expect(container.textContent).not.toContain('Villa');
    expect(container.textContent).not.toContain('Free');
    ui.toggleSlumlordPanel();
    ui.setHouseData({ profile: null });
    ui.toggleSlumlordPanel();
    expect(container.querySelector('[data-slumlord-panel]')).toBeTruthy();
    expect(textOf(SLUMLORD_EL.buyOwner)).toBe('');
    expect(textOf(SLUMLORD_EL.buyRequirements)).toBe('');
    ui.toggleSlumlordPanel();
  });
});
