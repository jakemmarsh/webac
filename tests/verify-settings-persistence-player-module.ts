/**
 * Per-player settings persistence — the PlayerModule window options must
 * reach the server and come back whole (live audit:
 * tools/probe-settings-persistence.ts → verification/settings-persistence/).
 *
 * Retail ground truth (decompiled EoL client):
 *  - CPlayerSystem::LogOffCharacter @ 00563520 calls
 *    CPlayerModule::SaveToServer(false) @ 0059a660 BEFORE the logoff
 *    request, so a change made just before logging out is saved without
 *    waiting out CPlayerModule::UseTime's 480 s.
 *  - PlayerModule::SetChatWindowOption @ 005d5570 writes ONE window's option
 *    into the in-memory module; CM_Character::Event_CharacterOptionsEvent
 *    serializes the WHOLE module, so a save after moving one window keeps
 *    every other stored window (the panels window 9, the toolbar 10, ids we
 *    do not draw at all).
 *  - UIElement::MouseMoveElement @ 0045fe30 clamps every drag to
 *    x ∈ [0, parentW − w], y ∈ [0, parentH − h].
 *
 * Live failures these pin (before the fix): logging out right after a change
 * dropped the whole blob (another browser came back at defaults); a tab close
 * lost the pending save (the beforeunload handler disconnected before the
 * pagehide flush ran); the login-time server copy beat an in-session move on
 * re-render; a floaty chat window could be dragged above the screen.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMasterProperty, setMasterPropertyTypes } from '@ac/dat-parser';
import { parseGameplayOptions, serializeGameplayOptions, BinaryReader } from '@ac/network';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat } from './_harness/dat.js';
import {
  setLiveWindowOptions, windowsFromLiveModule, clampWindowPosition,
} from '../packages/renderer/src/ui/FloatyWindowModel.js';
import { logOffCharacter, closeSessionOnUnload } from '../packages/renderer/src/session/PlayerModuleSave.js';
import { FLOATY_TITLE_BAR_ID } from '../packages/renderer/src/ui/FloatyChatModel.js';

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const LANG_DAT = resolve(REPO, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

// ─── Pure model (runs everywhere) ───────────────────────────────────────

describe('live PlayerModule window collection (SetChatWindowOption)', () => {
  it('merges one option set into one window, keeping its other options and other windows', () => {
    const module = { chatWindows: new Map([[9, { x: 10, y: 20, h: 500 }], [8, { filter: 5n }]]) };
    const out = setLiveWindowOptions(module, 9, { x: 300, y: 40 });
    expect(out).toBe(module);
    expect(out.chatWindows.get(9)).toEqual({ x: 300, y: 40, h: 500 });
    expect(out.chatWindows.get(8)).toEqual({ filter: 5n });
  });

  it('creates the module for a character with nothing stored yet', () => {
    const out = setLiveWindowOptions(null, 14, { x: 1, y: 2 });
    expect([...out.chatWindows]).toEqual([[14, { x: 1, y: 2 }]]);
  });

  it('a save starts from a copy of every stored window (mutating it leaves the module alone)', () => {
    const module = { chatWindows: new Map([[9, { x: 10, y: 20 }], [99, { visible: true }]]) };
    const seed = windowsFromLiveModule(module);
    expect([...seed.keys()].sort((a, b) => a - b)).toEqual([9, 99]);
    seed.get(9)!.x = 77;
    expect(module.chatWindows.get(9)!.x).toBe(10);
    expect(windowsFromLiveModule(null).size).toBe(0);
  });

  it('clamps a position on screen like MouseMoveElement / MoveTo', () => {
    expect(clampWindowPosition(-30, -55, 250, 104, 1024, 768)).toEqual({ x: 0, y: 0 });
    expect(clampWindowPosition(1400, 700, 310, 372, 1024, 768)).toEqual({ x: 714, y: 396 });
    expect(clampWindowPosition(100.4, 50.6, 250, 104, 1024, 768)).toEqual({ x: 100, y: 51 });
    // Larger than the screen: the low clamp wins (x = y = 0).
    expect(clampWindowPosition(50, 50, 2000, 1000, 1024, 768)).toEqual({ x: 0, y: 0 });
  });
});

describe('session end saves the PlayerModule first (LogOffCharacter → SaveToServer)', () => {
  it('logout: flush, then CharacterLogOff', () => {
    const calls: string[] = [];
    logOffCharacter({ flushChatOptionsSave: () => calls.push('save') }, { sendCharacterLogOff: () => calls.push('logoff') });
    expect(calls).toEqual(['save', 'logoff']);
  });

  it('tab close: flush, then disconnect (the socket is gone afterwards)', () => {
    const calls: string[] = [];
    closeSessionOnUnload({ flushChatOptionsSave: () => calls.push('save') }, { disconnect: () => calls.push('disconnect') });
    expect(calls).toEqual(['save', 'disconnect']);
  });
});

// ─── GameUI behavior (needs the DAT layouts) ────────────────────────────

const domWindow = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe.skipIf(!hasDats)('GameUI keeps one live PlayerModule per character', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const saves: Array<ReturnType<typeof parseGameplayOptions>> = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const layoutRenderer = new LayoutRenderer(langDb, new UITextureLoader(new TextureManager(portalDb)));
    layoutRenderer.getTextureDataURLWithAlpha = () => null;
    domWindow.document.body.innerHTML = '';
    domWindow.localStorage.clear();
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container, {
      // What main.ts does with it: serialize the blob for SetCharacterOptions.
      onSaveChatWindowOptions: (data) => saves.push(parseGameplayOptions(new BinaryReader(serializeGameplayOptions(data)))),
    }, portalDb, undefined, undefined, undefined, null, layoutRenderer);
    ui.setChatHistoryScope('persistprobe1', 'Alpha');
    ui.showGame();
  });

  afterAll(() => {
    vi.useRealTimers();
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const mouse = (type: string, x: number, y: number) => new domWindow.MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc = () => domWindow.document as any;
  const drag = (el: HTMLElement, from: [number, number], to: [number, number]) => {
    el.dispatchEvent(mouse('mousedown', from[0], from[1]));
    doc().dispatchEvent(mouse('mousemove', to[0], to[1]));
    doc().dispatchEvent(mouse('mouseup', to[0], to[1]));
  };
  const floaty1 = () => ui.floatyChatInstances.find((i: { def: { index: number } }) => i.def.index === 1);
  const floaty1Bar = () => floaty1().handle?.elements?.get(FLOATY_TITLE_BAR_ID)
    ?? floaty1().panelEl.querySelector(`[data-element-id="0x${FLOATY_TITLE_BAR_ID.toString(16)}"]`);

  it('a save after moving one window still carries every stored window (whole-module save)', () => {
    // Login: the server blob holds the panels window (9) and a window id we never draw (15).
    ui.setServerChatWindowOptions({
      chatWindows: new Map([[9, { x: 120, y: 60, h: 500 }], [15, { x: 3, y: 4, visible: true }]]),
    });
    // This session moves only the indicator strip (12).
    const bar = ui.indicatorsHandle.elements.get(0x10000650) as HTMLElement;
    drag(bar, [70, 27], [100, 227]);
    const data = ui.buildChatWindowOptionsData();
    expect(data.chatWindows.get(12)).toMatchObject({ x: 30, y: 200 });
    expect(data.chatWindows.get(9)).toEqual({ x: 120, y: 60, h: 500 });
    expect(data.chatWindows.get(15)).toEqual({ x: 3, y: 4, visible: true });
  });

  it('an in-session move beats the login-time copy when the window is drawn again', () => {
    ui.setServerChatWindowOptions({ chatWindows: new Map([[2, { x: 50, y: 50, visible: true }]]) });
    expect(floaty1().panelEl.style.left).toBe('50px');
    drag(floaty1Bar(), [100, 60], [400, 260]);
    expect(floaty1().panelEl.style.left).toBe('350px');
    expect(floaty1().panelEl.style.top).toBe('250px');
    ui.renderFloatyChatWindows(); // any redraw (resize, options change)
    expect(floaty1().panelEl.style.left).toBe('350px');
    expect(floaty1().panelEl.style.top).toBe('250px');
    expect(ui.buildChatWindowOptionsData().chatWindows.get(2)).toMatchObject({ x: 350, y: 250, visible: true });
  });

  it('a floaty chat window cannot be dragged off the screen (MouseMoveElement clamp)', () => {
    drag(floaty1Bar(), [400, 260], [100, -400]);
    expect(floaty1().panelEl.style.left).toBe('50px');
    expect(floaty1().panelEl.style.top).toBe('0px');
    drag(floaty1Bar(), [100, 10], [5000, 5000]);
    const w = parseInt(floaty1().panelEl.style.width), h = parseInt(floaty1().panelEl.style.height);
    expect(floaty1().panelEl.style.left).toBe(`${1024 - w}px`);
    expect(floaty1().panelEl.style.top).toBe(`${768 - h}px`);
  });

  it('a stored position from a bigger screen restores on screen (browser window smaller)', () => {
    ui.setServerChatWindowOptions({ chatWindows: new Map([[2, { x: 1800, y: 1000, visible: true }]]) });
    const w = parseInt(floaty1().panelEl.style.width), h = parseInt(floaty1().panelEl.style.height);
    expect(floaty1().panelEl.style.left).toBe(`${1024 - w}px`);
    expect(floaty1().panelEl.style.top).toBe(`${768 - h}px`);
  });

  it('logout right after a change saves at once, not 480 s later', () => {
    vi.useFakeTimers();
    saves.length = 0;
    drag(floaty1Bar(), [900, 700], [400, 300]);
    expect(saves).toHaveLength(0); // debounced (CPlayerModule::UseTime)
    const order: string[] = [];
    logOffCharacter(
      { flushChatOptionsSave: () => { order.push('save'); ui.flushChatOptionsSave(); } },
      { sendCharacterLogOff: () => order.push('logoff') },
    );
    expect(order).toEqual(['save', 'logoff']);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.chatWindows.get(2)).toMatchObject({ visible: true });
    expect(saves[0]!.chatWindows.has(9)).toBe(false); // that blob was replaced by the later login above
    // Nothing dirty → the 480 s timer never fires a second save.
    vi.advanceTimersByTime(480_000);
    expect(saves).toHaveLength(1);
    vi.useRealTimers();
  });

  it('switching character empties the module: nothing of the previous character rides along', () => {
    ui.setServerChatWindowOptions({ chatWindows: new Map([[9, { x: 120, y: 60 }]]) });
    drag(floaty1Bar(), [400, 300], [420, 320]); // dirty, then switch before the timer
    ui.setChatHistoryScope('persistprobe1', 'Beta');
    saves.length = 0;
    ui.flushChatOptionsSave();
    expect(saves).toHaveLength(0); // the dirty flag belonged to Alpha's module
    const data = ui.buildChatWindowOptionsData();
    expect(data.chatWindows.has(9)).toBe(false);
    expect(data.chatWindows.has(12)).toBe(false);
  });
});
