/**
 * BUG.house-data-buytime-position-dropped — HouseData.BuyTime and
 * HouseData.Position are fully parsed off the wire (ServerMessageHandler.ts,
 * per reference/ACE/Source/ACE.Server/Network/Structure/HouseData.cs:17-23,
 * where House.cs:84-116's GetHouseData() documents both as meaningful,
 * populated fields feeding the House info panel) but pre-fix main.ts's
 * onHouseData handler forwarded only houseType/maintenanceFree/rentTime/
 * rent — GameUI's houseData.summary type had no buyTime/position slot to
 * receive them even if forwarded, so both were silently dropped.
 *
 * Fix: GameUI.houseData.summary gained buyTimeUnix + position fields;
 * main.ts's onHouseData now passes data.buyTime/data.position through.
 * CORE.17.k.b.b.c.c.a — both draw on the World panel's House page the way
 * gmHouseUI does: "Bought: " + HouseSystem::ConvertTime(buy_time) (strftime
 * "%c" via formatAcTime — BUG.locale-date-formatting-browser-dependent — or
 * "N/A" for 0) and "Location: <ns>, <ew>" from the position's outdoor cell.
 *
 * Behavioral: drives the real GameUI under happy-dom, same harness as
 * verify-house-profile-panel.ts (SWEEP.6).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { formatAcTime } from '../packages/renderer/src/utils/formatAcTime.js';
import { HOUSE_PANEL_STRINGS } from '../packages/renderer/src/ui/HousePanelText.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

describe('BUG.house-data-buytime-position-dropped — Bought row + Location row retained', () => {
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

  const rows = (): string[] => ui.housePageRows(1_800_000_000).map((r: { text: string }) => r.text);

  it('renders the Bought row from buyTimeUnix, formatted via formatAcTime', () => {
    const buyTimeUnix = Math.floor(new Date('2026-01-15T10:00:00Z').getTime() / 1000);
    ui.setHouseData({
      summary: {
        houseType: 1, typeName: 'Cottage',
        maintenanceFree: false, buyTimeUnix, rentTimeUnix: buyTimeUnix,
        position: { cell: 0xA9B40001, x: 45.2, y: 88.7, z: 12.0, rw: 1, rx: 0, ry: 0, rz: 0 },
      },
      buyPayments: [], rentPayments: [],
    });
    expect(rows()).toContain(HOUSE_PANEL_STRINGS.bought + formatAcTime(buyTimeUnix));
  });

  it('a 0 buyTimeUnix prints "N/A" (HouseSystem::ConvertTime), never a 1970 date', () => {
    ui.setHouseData({
      summary: {
        houseType: 1, typeName: 'Cottage',
        maintenanceFree: false, buyTimeUnix: 0, rentTimeUnix: 0, position: null,
      },
      buyPayments: [], rentPayments: [],
    });
    const bought = rows().find((r) => r.startsWith(HOUSE_PANEL_STRINGS.bought));
    expect(bought).toBe(HOUSE_PANEL_STRINGS.bought + HOUSE_PANEL_STRINGS.timeNA);
  });

  it('retains the parsed Position on houseData.summary and draws it as the Location row (none for an Apartment)', () => {
    const position = { cell: 0xA9B40001, x: 1.5, y: 2.25, z: 6.0, rw: 0.707, rx: 0, ry: 0, rz: 0.707 };
    ui.setHouseData({
      summary: {
        houseType: 2, typeName: 'Villa',
        maintenanceFree: true, buyTimeUnix: 1000, rentTimeUnix: 1000,
        position,
      },
      buyPayments: [], rentPayments: [],
    });
    // eslint-disable-next-line dot-notation
    expect(ui['houseData'].summary.position).toEqual(position);
    expect(rows().some((r) => r.startsWith(HOUSE_PANEL_STRINGS.location))).toBe(true);
    ui.setHouseData({ summary: { houseType: 4, typeName: 'Apartment', maintenanceFree: false, buyTimeUnix: 1000, rentTimeUnix: 1000, position } });
    expect(rows().some((r) => r.startsWith(HOUSE_PANEL_STRINGS.location))).toBe(false);
  });
});
