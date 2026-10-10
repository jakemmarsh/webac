/**
 * BUG.spellbar-classic-clip — "the spellcasting bar looks pretty wrong". The
 * EoL spell bar is a PAGE of the floaty combat window (root HUD slot
 * 0x100006b5 → 0x21000073:0x100006a4, 610x90, centred 110 px above the
 * bottom): slot 0x10000061 → 0x21000010:0x1000009f reflowed by its DAT edges
 * into a 600x80 body, the shortcut list shrinking 639 → 439 px. The list
 * pads its visible width with plain recesses (UIElement_ItemList::
 * UpdateEmptySlots @ 004e3700, attributes 0x10000015 = 0x5f = −1): an empty
 * tab is the engraved "1" + twelve recesses (reddit-shutdown.jpg). We used to
 * clip the whole 800-wide classic layout and show a single cell. The melee
 * bar is the window's other page (0x1000005c → 0x21000007:0x1000004b).
 * Real GameUI + real LayoutRenderer over the EoL DATs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { parseMasterProperty, setMasterPropertyTypes, parseStringTable, registerStringTable } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { spellListPaddedCells } from '../packages/renderer/src/ui/SpellShortcutBar.js';
import { COMBAT_WINDOW } from '../packages/renderer/src/ui/CombatWindow.js';
import { ZLayer } from '../packages/renderer/src/ui/ZIndexRegistry.js';
import { openDat } from './_harness/dat.js';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle'] as const;

describe('spellListPaddedCells (UpdateEmptySlots)', () => {
  it('pads the visible width with 32-px cells; the numbered cells win when they overflow', () => {
    expect(spellListPaddedCells(439)).toBe(13);
    expect(spellListPaddedCells(639)).toBe(19);
    expect(spellListPaddedCells(439, 15)).toBe(15);
  });
});

describe.skipIf(!hasDats)('the spell bar in the EoL combat window (real GameUI + LayoutRenderer)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any; let domWindow: any;
  beforeAll(async () => {
    domWindow = await loadDomWindow();
    installDomGlobals(domWindow, DOM_GLOBALS as never, saved);
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    for (const id of [0x23000001, 0x23000002, 0x23000003, 0x23000005, 0x2300000d]) registerStringTable(parseStringTable(langDb.getReader(id)));
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const { CombatMode } = await import('../packages/shared/src/index.js');
    const layoutRenderer = new LayoutRenderer(langDb, new UITextureLoader(new TextureManager(portalDb)));
    layoutRenderer.getTextureDataURLWithAlpha = () => null;
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container, {}, portalDb, undefined, undefined, undefined, null, layoutRenderer);
    ui.showGame();
    ui.hudState.combatMode = CombatMode.Magic;
    ui.renderSpellBarPanel();
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS as never, saved); });

  it('the window is the 610x90 combat window, its body 600x80 at (5,5)', () => {
    const w = ui.spellBarPanelEl as HTMLElement;
    expect(w.dataset.combatWindow).toBe('1');
    expect([w.style.width, w.style.height]).toEqual([`${COMBAT_WINDOW.width}px`, `${COMBAT_WINDOW.height}px`]);
    const body = w.querySelector('[data-combat-window-body]') as HTMLElement;
    expect([body.style.left, body.style.top, body.style.width, body.style.height]).toEqual(['5px', '5px', '600px', '80px']);
    // VISUAL.melee-bar-under-transaction-dock — the spell page shares the
    // melee page's floaty tier (over the dock, under the panels window).
    expect(w.style.zIndex).toBe(String(ZLayer.HUD_COMBAT_BAR));
  });
  it('the classic subtree is reflowed: the shortcut list is 439 px, the Cast button follows the right edge', () => {
    const list = ui.spellBarPanelEl.querySelector('[data-element-id="0x100000b6"]') as HTMLElement;
    expect(parseInt(list.style.width, 10)).toBe(439);
    const cast = ui.spellBarPanelEl.querySelector('[data-element-id="0x100000b2"]') as HTMLElement;
    expect(parseInt(cast.style.left, 10)).toBe(525);
  });
  it('an empty tab: 13 cells — the engraved "1", then twelve plain recesses', () => {
    const cells = [...ui.spellBarPanelEl.querySelectorAll('[data-spell-slot^="0-"]')].filter((c: HTMLElement) => c.style.display !== 'none') as HTMLElement[];
    expect(cells.length).toBe(13);
    expect(cells[0].querySelector('[data-shortcut-num]')).toBeTruthy();
    for (const c of cells.slice(1)) expect(c.querySelector('[data-shortcut-num]')).toBeNull();
  });
});
