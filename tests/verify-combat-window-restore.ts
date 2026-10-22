/**
 * webac#2 — "No combat bar/spell bar ... Enabling/Disabling Advanced combat
 * does not do anything". A long-played character's PlayerModule carries a
 * combat window (WindowID 15) rect saved on a bigger screen; we placed the
 * window at the raw stored x/y, below the bottom of a 1568x560 browser, so
 * neither the melee bar nor the spell bar was anywhere on screen. Retail
 * restores it through gmFloatyCombatPanelUI::UpdateFromPlayerModule @
 * 004d4e10 → MoveTo @ 004d5190, which clamps x into [0, screenW − w] and y
 * into [0, screenH − h], then ResizeTo (the root's 410..3000 x 70..90).
 * And gmCombatUI::RecvNotice_SetCombatMode @ 004cc620 hides the melee page
 * when the Advanced Combat Interface option is on (attacks charge on the
 * floaty power bar instead) — we ignored the option entirely.
 *
 * Real GameUI + real LayoutRenderer over the EoL DATs, fed a real
 * GameplayOptions blob through the @ac/network codec.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMasterProperty, setMasterPropertyTypes, parseStringTable, registerStringTable } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { COMBAT_WINDOW, COMBAT_WINDOW_LIMITS, combatWindowPlacement, combatBarPageVisible } from '../packages/renderer/src/ui/CombatWindow.js';
import { serializeGameplayOptions, parseGameplayOptions, BinaryReader } from '@ac/network';
import type { ChatWindowOptions } from '@ac/network';
import { CombatMode } from '../packages/shared/src/index.js';
import { openDat } from './_harness/dat.js';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle'] as const;

describe('combatWindowPlacement (MoveTo @ 004d5190 / ResizeTo clamps)', () => {
  it('nothing persisted: the authored 610x90 slot stands', () => {
    expect(combatWindowPlacement({}, 1680, 600)).toEqual({ x: null, y: null, w: 610, h: 90, body: { w: 600, h: 80 } });
  });
  it('a 1920x1200 layout lands on a 1680x600 screen', () => {
    expect(combatWindowPlacement({ x: 655, y: 1030 }, 1680, 600)).toMatchObject({ x: 655, y: 510, w: 610, h: 90 });
    expect(combatWindowPlacement({ x: 1500, y: 40 }, 1680, 600)).toMatchObject({ x: 1070, y: 40 });
  });
  it('the low bound wins when the window is wider than the screen', () => {
    expect(combatWindowPlacement({ x: 900, y: 0, w: 2400, h: 90 }, 1680, 600)).toMatchObject({ x: 0, w: 2400 });
  });
  it('size is held to the root limits, the body keeps a 5 px frame', () => {
    expect(combatWindowPlacement({ w: 100, h: 500 }, 1680, 600)).toMatchObject({ x: null, w: 410, h: 90, body: { w: 400, h: 80 } });
    expect(combatWindowPlacement({ x: 0, y: 0, w: 9000, h: 10 }, 4000, 2000)).toMatchObject({ w: 3000, h: 70 });
  });
});

describe('combatBarPageVisible (gmCombatUI::RecvNotice_SetCombatMode @ 004cc620)', () => {
  it('melee and missile show the page only with Advanced Combat off', () => {
    expect(combatBarPageVisible(CombatMode.Melee, false)).toBe(true);
    expect(combatBarPageVisible(CombatMode.Missile, false)).toBe(true);
    expect(combatBarPageVisible(CombatMode.Melee, true)).toBe(false);
    expect(combatBarPageVisible(CombatMode.Missile, true)).toBe(false);
    expect(combatBarPageVisible(CombatMode.Magic, false)).toBe(false);
    expect(combatBarPageVisible(CombatMode.NonCombat, false)).toBe(false);
  });
});

/** A long-played character's PlayerModule window options, saved at 1920x1200 on the retail client. */
function veteranBlob(combat: ChatWindowOptions): Uint8Array {
  const windows = new Map<number, ChatWindowOptions>([
    [2, { x: 1300, y: 700, w: 600, h: 300, visible: true, filter: 0x0000_0000_0010_0400n, title: 'Tells' }],
    [3, { x: 1300, y: 400, w: 600, h: 280, visible: true, filter: 0x0000_0000_0000_0800n }],
    [4, { x: 0, y: 0, w: 150, h: 76, visible: false }],
    [5, { x: 0, y: 0, w: 150, h: 76, visible: false }],
    [8, { x: 0, y: 980, w: 900, h: 220, filter: 0x0000_0000_ffff_ffffn }],
    [10, { x: 1610, y: 1068, w: 310, h: 132 }],
    [11, { x: 880, y: 0, w: 300, h: 58 }],
    [12, { x: 0, y: 0 }],
    [13, { x: 655, y: 950, w: 610, h: 25 }],
    [14, { x: 1800, y: 0 }],
    [15, combat],
    [16, { x: 1300, y: 300, w: 300, h: 600 }],
  ]);
  return serializeGameplayOptions({ defaultOpacity: 0.35, activeOpacity: 0.9, chatWindows: windows });
}

describe.skipIf(!hasDats)('the combat window restored from a veteran character (real GameUI, 1568x560 browser)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any; let domWindow: any;
  // The HUD's design size at 1568x560: the scale is min(1, 560/600), so 1680x600 logical px.
  const LOGICAL_W = 1680;
  const LOGICAL_H = 600;
  beforeAll(async () => {
    domWindow = await loadDomWindow({ innerWidth: 1568, innerHeight: 560 });
    installDomGlobals(domWindow, DOM_GLOBALS as never, saved);
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    for (const id of [0x23000001, 0x23000002, 0x23000003, 0x23000005, 0x2300000d]) registerStringTable(parseStringTable(langDb.getReader(id)));
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const layoutRenderer = new LayoutRenderer(langDb, new UITextureLoader(new TextureManager(portalDb)));
    layoutRenderer.getTextureDataURLWithAlpha = () => null;
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container, {}, portalDb, undefined, undefined, undefined, null, layoutRenderer);
    ui.setChatHistoryScope('veteran', 'Veteran');
    ui.showGame();
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS as never, saved); });

  const login = (combat: ChatWindowOptions): void => {
    const parsed = parseGameplayOptions(new BinaryReader(veteranBlob(combat), 0));
    expect(parsed?.chatWindows.get(15)).toMatchObject(combat);
    ui.setServerChatWindowOptions(parsed);
  };
  const top = (el: HTMLElement): number => parseInt(el.style.top, 10);
  const left = (el: HTMLElement): number => parseInt(el.style.left, 10);

  it('the DAT root carries the resize limits the placement uses', () => {
    const host = domWindow.document.createElement('div');
    const h = ui.layoutRenderer.render(COMBAT_WINDOW.layout, host, { subtreeElementId: COMBAT_WINDOW.root });
    const p = h.descs.get(COMBAT_WINDOW.root).properties;
    expect([p.get(63)?.valueInt, p.get(62)?.valueInt, p.get(61)?.valueInt, p.get(60)?.valueInt])
      .toEqual([COMBAT_WINDOW_LIMITS.minW, COMBAT_WINDOW_LIMITS.minH, COMBAT_WINDOW_LIMITS.maxW, COMBAT_WINDOW_LIMITS.maxH]);
  });

  it('melee: the combat bar is on screen, clamped like MoveTo (was top 1030 on a 600-high HUD)', () => {
    login({ x: 655, y: 1030, w: 610, h: 90 });
    ui.hudState.combatMode = CombatMode.Melee;
    ui.renderCombatBar();
    const bar = ui.combatBar as HTMLElement;
    expect(bar.style.display).toBe('block');
    expect(left(bar)).toBe(655);
    expect(top(bar)).toBe(LOGICAL_H - 90);
    // MoveTo writes the clamped position back into the module, so the next save carries it.
    expect(ui.buildChatWindowOptionsData().chatWindows.get(15)).toMatchObject({ x: 655, y: LOGICAL_H - 90 });
  });

  it('magic: the spell bar is on screen too', () => {
    ui.hudState.combatMode = CombatMode.Magic;
    ui.renderSpellBarPanel();
    ui.updateSpellBarVisibility();
    const bar = ui.spellBarPanelEl as HTMLElement;
    expect(bar.style.display).toBe('block');
    expect(top(bar) + 90).toBeLessThanOrEqual(LOGICAL_H);
  });

  it('a persisted width is restored (ResizeTo) and the page reflows to it', () => {
    login({ x: 400, y: 2000, w: 800, h: 90 });
    ui.hudState.combatMode = CombatMode.Melee;
    ui.renderCombatBar();
    const bar = ui.combatBar as HTMLElement;
    expect([bar.style.width, bar.style.height]).toEqual(['800px', '90px']);
    const body = bar.querySelector('[data-combat-window-body]') as HTMLElement;
    expect(body.style.width).toBe('790px');
    // The power track's DAT edges keep its 93 px margins: 707 at 800 → 697 at 790.
    const track = bar.querySelector('[data-element-id="0x1000004f"]') as HTMLElement;
    expect(parseInt(track.style.width, 10)).toBe(697);
    expect(top(bar)).toBe(LOGICAL_H - 90);
  });

  it('a browser window made smaller re-clamps the floaty windows onto it; growing it back returns them', () => {
    login({ x: 1000, y: 300, w: 610, h: 90 });
    ui.hudState.combatMode = CombatMode.Melee;
    ui.renderCombatBar();
    expect(left(ui.combatBar)).toBe(1000);
    // The veteran radar (WindowID 14) restored at x 1800 → clamped to the screen's right edge.
    const radar = ui.radarContainer as HTMLElement;
    const radarW = parseInt(radar.style.width, 10);
    expect(left(radar)).toBe(LOGICAL_W - radarW);
    domWindow.happyDOM.setWindowSize({ width: 1000, height: 560 });
    const narrow = Math.round(1000 / (560 / 600));
    try {
      ui.reclampFloatyWindowsToScreen();
      expect(left(ui.combatBar)).toBe(narrow - 610);
      expect(left(radar)).toBe(narrow - radarW);
    } finally {
      domWindow.happyDOM.setWindowSize({ width: 1568, height: 560 });
    }
    ui.reclampFloatyWindowsToScreen();
    expect(left(ui.combatBar)).toBe(1000);
  });

  it('a veteran spell bar (8 full tabs, more favorites than cells) renders without throwing', () => {
    const spells = Array.from({ length: 240 }, (_, i) => ({
      id: 1 + i, name: `Spell ${i}`, desc: '', school: 1 + (i % 5), level: 1, power: 1, manaCost: 1,
      difficulty: 1, duration: 0, components: [], targetType: 2,
    }));
    const bars = Array.from({ length: 8 }, (_, t) => spells.slice(t * 30, t * 30 + 30));
    ui.setSpellData(spells, bars);
    ui.hudState.combatMode = CombatMode.Magic;
    expect(() => { ui.renderSpellBarPanel(); ui.updateSpellBarVisibility(); }).not.toThrow();
    // BUG.ac1999-spellbar-arrows — every favourite gets a cell (30 + the trailing empty) in the
    // strip the 439-px list clips; the arrow pair scrolls to the rest.
    const shown = [...ui.spellBarPanelEl.querySelectorAll(`[data-spell-slot^="${ui.activeSpellBarTab}-"]`)]
      .filter((c) => (c as HTMLElement).style.display !== 'none');
    expect(shown.length).toBe(31);
    const strip = ui.spellBarPanelEl.querySelector(`[data-spell-strip="${ui.activeSpellBarTab}"]`) as HTMLElement;
    expect(strip.parentElement!.dataset.elementId).toBe('0x100000b6');
    expect(strip.parentElement!.style.overflow).toBe('hidden');
    expect(ui.spellBarPanelEl.style.display).toBe('block');
  });

  it('nothing persisted: the authored centred slot (the fresh-character case that always worked)', () => {
    ui.setChatHistoryScope('fresh', 'Fresh');
    ui.setServerChatWindowOptions(null);
    ui.hudState.combatMode = CombatMode.Melee;
    ui.renderCombatBar();
    const bar = ui.combatBar as HTMLElement;
    expect([bar.style.left, bar.style.bottom, bar.style.marginLeft]).toEqual(['50%', `${COMBAT_WINDOW.bottom}px`, '-305px']);
  });

  it('Advanced Combat Interface on: the melee page hides at the next mode change; off again shows it', () => {
    ui.hudState.combatMode = CombatMode.NonCombat;
    ui.updateHUD();
    ui.optionsSettings.advancedCombatUI = true;
    ui.hudState.combatMode = CombatMode.Melee;
    ui.updateHUD();
    expect(ui.combatBar.style.display).toBe('none');
    // A mid-mode toggle waits for the next mode change (RecvNotice_SetCombatMode).
    ui.optionsSettings.advancedCombatUI = false;
    ui.renderCombatBar();
    expect(ui.combatBar.style.display).toBe('none');
    ui.hudState.combatMode = CombatMode.Missile;
    ui.updateHUD();
    expect(ui.combatBar.style.display).toBe('block');
  });
});
