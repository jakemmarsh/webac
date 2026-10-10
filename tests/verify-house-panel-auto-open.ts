/**
 * BUG.house-panel-and-purchase-unreachable-in-ui — the slumlord dialog
 * was fully wired to real server data via the onHouse* handlers, but
 * nothing ever made it *visible*: setHouseData() only re-renders when the
 * dialog is already open, and toggleSlumlordPanel() requires a caller
 * that already knows to call it. Per ACE `SlumLord.cs:56-67` (`ActOnUse`),
 * `GameEventHouseProfile` has exactly one server-side send site — using a
 * Slumlord NPC — so the client's onHouseProfile handler is the correct
 * (and only legitimate) place to open the dialog automatically. The
 * decompiled retail client's `gmSlumlordUI::RecvNotice_UpdateHouseProfile`
 * confirms this is the real dialog-open trigger.
 *
 * Behavioral: drives the real GameUI.showSlumlordPanel() under happy-dom
 * (same harness as verify-house-profile-panel.ts; tests/_harness/dom.ts). main.ts's one-line onHouseProfile -> showSlumlordPanel() glue
 * call isn't separately covered here — main.ts is never imported in this
 * test tree (side effects at module scope), and per the test-suite
 * hygiene ratchet (tests/verify-test-suite-hygiene.ts) new test files may
 * not fs-read + regex-match packages/ source as a substitute for
 * behavioral coverage. There's no extractable logic on that side (it's a
 * single unconditional call, not a decision), so the real regression
 * surface — showSlumlordPanel()'s open/idempotent/close behavior — is what's
 * covered below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const dwelling = (houseType: number, typeName: string) => ({
  dwellingId: houseType, bitmask: 1, houseType, typeName, ownerName: '', ownerId: 0,
  maintenanceFree: false, slumlordGuid: 0x80000123,
  minLevel: -1, maxLevel: -1, minAllegRank: -1, maxAllegRank: -1, buy: [], rent: [],
});

describe('BUG.house-panel-and-purchase-unreachable-in-ui — showSlumlordPanel', () => {
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

  // CORE.17.k.b.b.c.c.a.a — the dialog is gmSlumlordUI's layout 0x2100000e
  // (`[data-slumlord-panel]`, data-panel 0x2100000e); its texts are the cost
  // lists + "Owner: …", never the dwelling type.
  const panel = (): HTMLElement | null => container.querySelector('[data-slumlord-panel]');
  const ownerText = (): string => (panel()!.querySelector('[data-element-id="0x10000093"]') as HTMLElement).textContent as string;

  it('makes the dialog visible from a closed state, unlike setHouseData alone', () => {
    // Regression case: pre-fix, setHouseData() with the dialog closed left
    // it closed — the data landed in hidden state with no way to see it.
    ui.setHouseData({ profile: { ...dwelling(1, 'Cottage'), ownerName: 'Aerlinthe', ownerId: 0x50000001 } });
    expect(panel()).toBeNull();

    ui.showSlumlordPanel();
    expect(panel()).toBeTruthy();
    expect(panel()!.dataset.panel).toBe('0x2100000e');
    expect(ownerText()).toBe('Owner: Aerlinthe');
    ui.hideSlumlordPanel();
  });

  it('is idempotent — calling it again while already open does not close the dialog', () => {
    ui.setHouseData({ profile: { ...dwelling(2, 'Villa'), ownerName: 'Someone', ownerId: 0x50000002 } });
    ui.showSlumlordPanel();
    expect(ownerText()).toBe('Owner: Someone');
    ui.showSlumlordPanel(); // second call must not toggle it closed
    expect(panel()).toBeTruthy();
    expect(container.querySelectorAll('[data-slumlord-panel]')).toHaveLength(1);
    expect(ownerText()).toBe('Owner: Someone');
    ui.hideSlumlordPanel();
  });

  it('hideSlumlordPanel still closes it after showSlumlordPanel opened it', () => {
    ui.setHouseData({ profile: dwelling(3, 'Mansion') });
    ui.showSlumlordPanel();
    expect(panel()).toBeTruthy();
    expect(ownerText()).toBe('Owner: None');
    ui.hideSlumlordPanel();
    expect(panel()).toBeNull();
  });
});
