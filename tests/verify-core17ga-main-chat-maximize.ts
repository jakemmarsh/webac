/**
 * CORE.17.g.a — "[hud] Main chat window maximize box and drag/resize grips
 * are drawn but inert".
 *
 * Ground truth (decompiled EoL client, cross-checked against the raw
 * disassembly of acclient.exe):
 *
 * - gmMainChatUI::HandleMaximizeButton @ 004cce50 — on maximize the window
 *   grows by HALF THE SCREEN HEIGHT (a `height + screenH/2` stack slot the
 *   Ghidra listing hides behind a `push ebp`), growing downward when it sits
 *   in the top half and fits, upward (y -= screenH/2) otherwise, clamped to
 *   the screen; it saves m_OldY/m_OldHeight and flips 0x1000046f to state
 *   0x10000047. On restore it puts m_OldHeight (clamped to p62/p60) and
 *   m_OldY (clamped to [0, screenH - minH]) back and flips the box to
 *   0x10000048. Width never changes.
 * - gmFloatyMainChatUI::ListenToElementMessage @ 004d23b0 — element
 *   message 1 on 0x1000046f is the trigger.
 * - gmFloatyMainChatUI::MoveTo @ 004d2d10 / ResizeTo @ 004d2c00 persist
 *   x/y/w/h as PlayerModule chat-window options 0x10000086-89 under the
 *   window's id (8); UpdateFromPlayerModule @ 004d2970 replays them via
 *   MoveTo/ResizeTo on login (MoveTo clamps to the screen).
 * - ChatInterface::ResizeTo @ 004f39e0 keeps the log pinned at its end when
 *   it was there before the resize.
 * - The drag bars 0x1000069c/0x100006a0 (type 2) and grips 0x1000069b/9d/
 *   9e/9f/a0/a1/a2 (type 9, p42-45 direction flags) resize within the root's
 *   p63/p62/p61/p60 = 300x100 .. 2000x2000 (UIElement::MouseResizeElement @
 *   00461130), and hide while LockUI is on.
 *
 * Part 1 pins the pure maximize rule. Part 2 pins the DAT facts (button
 * states/art, grip flags; skipped without DATs, loads in beforeAll). Part 3
 * drives the real GameUI.renderHUD() under happy-dom: click the box, drag a
 * bar, pull a grip, lock the UI, replay server options — and asserts the
 * resulting window geometry, button state and persisted chat-window options.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import {
  MAIN_CHAT_WINDOW, MAIN_CHAT_WINDOW_ID, toggleMainChatMaximize,
  MAIN_CHAT_MAXIMIZE_STATE_NORMAL, MAIN_CHAT_MAXIMIZE_STATE_MAXIMIZED,
} from '../packages/renderer/src/ui/FloatyChatModel.js';
import { openDat } from './_harness/dat.js';

// ── Part 1: gmMainChatUI::HandleMaximizeButton as a pure rule ──────────────


describe('CORE.17.g.a — HandleMaximizeButton @ 004cce50 (from the disassembly)', () => {
  const normal = { maximized: false, oldY: 0, oldHeight: 0 };

  it('the button states are 0x10000048 (normal, default) and 0x10000047 (maximized)', () => {
    expect(MAIN_CHAT_MAXIMIZE_STATE_NORMAL).toBe(0x10000048);
    expect(MAIN_CHAT_MAXIMIZE_STATE_MAXIMIZED).toBe(0x10000047);
  });

  it('default window (0,500) 410x100 on 800x600: maximize grows UP by screenH/2 → (0,200) 410x400, restore returns', () => {
    const max = toggleMainChatMaximize({ x: 0, y: 500, w: 410, h: 100 }, 600, normal);
    expect(max.rect).toEqual({ x: 0, y: 200, w: 410, h: 400 });
    expect(max.state).toEqual({ maximized: true, oldY: 500, oldHeight: 100 });
    expect(max.buttonState).toBe(MAIN_CHAT_MAXIMIZE_STATE_MAXIMIZED);
    const back = toggleMainChatMaximize(max.rect, 600, max.state);
    expect(back.rect).toEqual({ x: 0, y: 500, w: 410, h: 100 });
    expect(back.state.maximized).toBe(false);
    expect(back.buttonState).toBe(MAIN_CHAT_MAXIMIZE_STATE_NORMAL);
  });

  it('a window in the top half that fits grows DOWN (y unchanged)', () => {
    const r = toggleMainChatMaximize({ x: 20, y: 35, w: 500, h: 100 }, 600, normal);
    expect(r.rect).toEqual({ x: 20, y: 35, w: 500, h: 400 });
  });

  it('a top-half window whose bottom is already off screen grows UP instead, clamped to y>=0 and the screen', () => {
    // y < screenH/2 but y + h >= screenH → the "else" branch: y - 300 → -50 → 0; h 700 → 600.
    const r = toggleMainChatMaximize({ x: 0, y: 250, w: 410, h: 400 }, 600, normal);
    expect(r.rect).toEqual({ x: 0, y: 0, w: 410, h: 600 });
  });

  it('the grown height is clamped so the window ends at the screen bottom', () => {
    // (0,450) h=200 on 600: y - 300 = 150; h 500 → 600 - 150 = 450.
    const r = toggleMainChatMaximize({ x: 0, y: 450, w: 410, h: 200 }, 600, normal);
    expect(r.rect).toEqual({ x: 0, y: 150, w: 410, h: 450 });
  });

  it('restore clamps the saved height to [p62, p60] and the saved y to [0, screenH - minH]', () => {
    const r = toggleMainChatMaximize(
      { x: 0, y: 0, w: 410, h: 600 }, 600,
      { maximized: true, oldY: 590, oldHeight: 40 },
    );
    expect(r.rect).toEqual({ x: 0, y: 500, w: 410, h: MAIN_CHAT_WINDOW.minHeight });
    const r2 = toggleMainChatMaximize(
      { x: 0, y: 0, w: 410, h: 600 }, 600,
      { maximized: true, oldY: -20, oldHeight: 5000 },
    );
    expect(r2.rect).toEqual({ x: 0, y: 0, w: 410, h: MAIN_CHAT_WINDOW.maxHeight });
  });

  it('width and x are never touched by either branch', () => {
    const max = toggleMainChatMaximize({ x: 77, y: 500, w: 640, h: 100 }, 600, normal);
    expect([max.rect.x, max.rect.w]).toEqual([77, 640]);
    const back = toggleMainChatMaximize(max.rect, 600, max.state);
    expect([back.rect.x, back.rect.w]).toEqual([77, 640]);
  });

  it('screenH/2 truncates like the cdq/sar idiv (odd screen heights)', () => {
    const r = toggleMainChatMaximize({ x: 0, y: 675, w: 410, h: 100 }, 775, normal);
    // half = 387; y 675 - 387 = 288; h 100 + 387 = 487; 288 + 487 = 775 fits exactly.
    expect(r.rect).toEqual({ x: 0, y: 288, w: 410, h: 487 });
  });
});

// ── Part 2: DAT — the maximize box, its states and the grips' flags ──────────

const hasDats = fs.existsSync('dat/client_portal.dat') && fs.existsSync('dat/client_local_English.dat');

describe.skipIf(!hasDats)('CORE.17.g.a — DAT: 0x1000046f states 0x10000047/48 and the grip direction flags', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let root: any;

  beforeAll(async () => {
    const { DatDatabase } = await import('@ac/dat-parser/DatDatabase.js');
    const { DatReader } = await import('@ac/dat-parser/DatReader.js');
    const { parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes } =
      await import('@ac/dat-parser/file-types/LayoutDesc.js');
    const portalDb = openDat('dat/client_portal.dat');
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portalDb.getFileData(0x39000001)!)));
    const langDb = openDat('dat/client_local_English.dat');
    const chat = parseLayoutDesc(new DatReader(langDb.getFileData(MAIN_CHAT_WINDOW.layoutId)!));
    root = chat.elements.get(MAIN_CHAT_WINDOW.rootElementId);
  });

  it('the maximize box 0x1000046f is (368,5) 16x16, default state 0x10000048 (art 0x06005e65), maximized state 0x10000047 (art 0x06005e64)', () => {
    const btn = root.children.get(MAIN_CHAT_WINDOW.maximizeButtonId);
    expect(btn).toBeDefined();
    expect([btn.x, btn.y, btn.width, btn.height]).toEqual([368, 5, 16, 16]);
    expect(btn.defaultState).toBe(MAIN_CHAT_MAXIMIZE_STATE_NORMAL);
    const art = (stateId: number): number[] =>
      [...(btn.states.get(stateId)?.media ?? [])].map((m: { file?: number }) => m.file ?? 0);
    expect(art(MAIN_CHAT_MAXIMIZE_STATE_NORMAL)).toContain(0x06005e65);
    expect(art(MAIN_CHAT_MAXIMIZE_STATE_MAXIMIZED)).toContain(0x06005e64);
    // The box rides the right edge (L2) so it stays top-right after a width resize.
    expect([btn.leftEdge, btn.topEdge]).toEqual([2, 1]);
  });

  it('the type-9 grips carry the MouseResizeElement direction flags (p43 L / p44 R / p45 T / p42 B)', () => {
    const flags = (id: number): string => {
      const el = root.children.get(id);
      expect(el.type).toBe(9);
      const f = (pid: number): boolean => el.properties.get(pid)?.valueBool === true;
      return `${f(43) ? 'L' : ''}${f(44) ? 'R' : ''}${f(45) ? 'T' : ''}${f(42) ? 'B' : ''}`;
    };
    expect(flags(0x1000069b)).toBe('LT');
    expect(flags(0x1000069d)).toBe('RT');
    expect(flags(0x1000069e)).toBe('L');
    expect(flags(0x1000069f)).toBe('LB');
    expect(flags(0x100006a0)).toBe('B');
    expect(flags(0x100006a1)).toBe('RB');
    expect(flags(0x100006a2)).toBe('R');
    expect(root.children.get(0x1000069c).type).toBe(2);
  });

  it('the children reflow by edge flags: message area stretches, input row rides the bottom, scrollbar/Send follow the right edge', () => {
    const area = root.children.get(MAIN_CHAT_WINDOW.messageAreaId);
    expect([area.rightEdge, area.bottomEdge]).toEqual([1, 1]);
    const input = root.children.get(MAIN_CHAT_WINDOW.inputRowId);
    expect([input.topEdge, input.bottomEdge, input.rightEdge]).toEqual([2, 1, 1]);
    expect(area.children.get(0x10000012).leftEdge).toBe(2);
    expect(input.children.get(0x10000019).leftEdge).toBe(2);
  });
});

// ── Part 3: behavioral — GameUI wires the box, bars and grips ───────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const LOCKED_TEXTURES = [0x060074c3, 0x060074bf, 0x060074c4, 0x060074c0, 0x060074c5, 0x060074c1, 0x060074c6, 0x060074c2];
const GRIP_FLAGS: Record<number, { l?: boolean; r?: boolean; t?: boolean; b?: boolean }> = {
  0x1000069b: { l: true, t: true }, 0x1000069d: { r: true, t: true }, 0x1000069e: { l: true },
  0x1000069f: { l: true, b: true }, 0x100006a0: { b: true }, 0x100006a1: { r: true, b: true }, 0x100006a2: { r: true },
};

describe('CORE.17.g.a — GameUI: maximize box, drag bars and resize grips act on the main chat window', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const stateCalls: Array<[number, number]> = [];
  const resizeCalls: Array<[number, number]> = [];
  // 1024x768 viewport → HUD scale 1 → design px = viewport px, screenH 768.

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    domWindow.localStorage.clear();
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);

    const makeHandle = (layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const descs = new Map<number, any>();
      const add = (id: number, type: number, file?: number, props: Record<number, boolean | number> = {}): void => {
        const el = domWindow.document.createElement('div') as HTMLElement;
        el.setAttribute('data-element-id', `0x${id.toString(16)}`);
        root.appendChild(el);
        elements.set(id, el);
        const properties = new Map<number, { valueBool?: boolean; valueInt?: number }>();
        for (const [k, v] of Object.entries(props)) {
          properties.set(Number(k), typeof v === 'boolean' ? { valueBool: v } : { valueInt: v });
        }
        descs.set(id, { type, media: file ? [{ file }] : [], properties, states: new Map() });
      };
      if (layoutId === MAIN_CHAT_WINDOW.layoutId) {
        add(MAIN_CHAT_WINDOW.rootElementId, 0x10000050, undefined, { 63: 300, 62: 100, 61: 2000, 60: 2000 });
        MAIN_CHAT_WINDOW.lockedBorderIds.forEach((id, i) => add(id, 3, LOCKED_TEXTURES[i]));
        for (const id of MAIN_CHAT_WINDOW.interactiveBorderIds) {
          // 0x1000069c is the only type-2 drag bar in the DAT; the other
          // seven (incl. the bottom bar 0x100006a0, p42) are type-9 grips.
          if (id === 0x1000069c) add(id, 2, 0x0600612a);
          else {
            const f = GRIP_FLAGS[id] ?? {};
            add(id, 9, 0x06006129, { 43: !!f.l, 44: !!f.r, 45: !!f.t, 42: !!f.b });
          }
        }
        for (const id of [0x10000010, 0x10000011, 0x10000012, 0x10000013, 0x10000014, 0x10000016, 0x10000019, 0x1000048c, 0x1000046f]) add(id, 0);
      }
      const getOrCreate = (id: number): HTMLElement => {
        let el = elements.get(id);
        if (!el) { add(id, 0); el = elements.get(id)!; }
        return el;
      };
      return {
        root, descs,
        elements: { get: (id: number) => getOrCreate(id), set: () => {}, has: (id: number) => elements.has(id) },
        setText: () => {}, setInteractive: () => {},
        setState: (id: number, st: number) => { stateCalls.push([id, st]); },
        setVisible: (id: number, visible: boolean) => { getOrCreate(id).style.display = visible ? '' : 'none'; },
        setTexture: () => {}, setFill: () => {}, setPalette: () => {},
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
        resizeSubtree: layoutId === MAIN_CHAT_WINDOW.layoutId
          ? (w: number, h: number) => { resizeCalls.push([w, h]); root.style.width = `${w}px`; root.style.height = `${h}px`; }
          : undefined,
        close: () => { root.remove(); }, destroy: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
    ui.optionsSettings.lockUI = false;
    ui.renderHUD();
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const chatEl = (): HTMLElement => domWindow.document.getElementById('hud-chat') as HTMLElement;
  const borderEl = (id: number): HTMLElement => ui.chatHandle.elements.get(id) as HTMLElement;
  const geom = () => {
    const c = chatEl();
    return { left: c.style.left, top: c.style.top, bottom: c.style.bottom, width: c.style.width, height: c.style.height };
  };
  const mouse = (target: EventTarget, type: string, x: number, y: number): void => {
    target.dispatchEvent(new domWindow.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  };
  const dragFrom = (el: HTMLElement, dx: number, dy: number): void => {
    mouse(el, 'mousedown', 100, 100);
    mouse(domWindow.document, 'mousemove', 100 + dx, 100 + dy);
    mouse(domWindow.document, 'mouseup', 100 + dx, 100 + dy);
  };
  const win8 = () => ui.buildChatWindowOptionsData().chatWindows.get(MAIN_CHAT_WINDOW_ID);

  it('renders at the DAT default: 410x100 bottom-left, un-maximized, nothing persisted for WindowID 8 yet', () => {
    expect(geom()).toEqual({ left: '0px', top: '', bottom: '0px', width: '410px', height: '100px' });
    expect(ui.isMainChatMaximized()).toBe(false);
    const w = win8();
    expect(w.filter).toBeDefined();
    expect([w.x, w.y, w.w, w.h]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('the maximize box is clickable and its default state is untouched until clicked', () => {
    const btn = borderEl(MAIN_CHAT_WINDOW.maximizeButtonId);
    expect(btn.style.pointerEvents).toBe('auto');
    expect(stateCalls.filter(([id]) => id === MAIN_CHAT_WINDOW.maximizeButtonId)).toEqual([]);
  });

  it('click → maximized: grows by screenH/2 upward from the bottom edge, box → 0x10000047, children reflow, geometry persists', () => {
    borderEl(MAIN_CHAT_WINDOW.maximizeButtonId).click();
    // y = 768 - 100 = 668; not in the top half → y - 384 = 284; h = 100 + 384 = 484 (ends at 768).
    expect(geom()).toEqual({ left: '0px', top: '284px', bottom: '', width: '410px', height: '484px' });
    expect(ui.isMainChatMaximized()).toBe(true);
    expect(stateCalls.at(-1)).toEqual([MAIN_CHAT_WINDOW.maximizeButtonId, MAIN_CHAT_MAXIMIZE_STATE_MAXIMIZED]);
    expect(resizeCalls.at(-1)).toEqual([410, 484]);
    expect(ui.chatHandle.root.style.height).toBe('484px');
    const w = win8();
    expect([w.x, w.y, w.w, w.h]).toEqual([0, 284, 410, 484]);
    expect(w.filter).toBeDefined();
  });

  it('click again → restored to the saved geometry, box → 0x10000048', () => {
    borderEl(MAIN_CHAT_WINDOW.maximizeButtonId).click();
    expect(geom()).toEqual({ left: '0px', top: '668px', bottom: '', width: '410px', height: '100px' });
    expect(ui.isMainChatMaximized()).toBe(false);
    expect(stateCalls.at(-1)).toEqual([MAIN_CHAT_WINDOW.maximizeButtonId, MAIN_CHAT_MAXIMIZE_STATE_NORMAL]);
    expect(resizeCalls.at(-1)).toEqual([410, 100]);
    const w = win8();
    expect([w.x, w.y, w.w, w.h]).toEqual([0, 668, 410, 100]);
  });

  it('the top drag bar 0x1000069c moves the window (clamped to the screen) and persists x/y', () => {
    const bar = borderEl(0x1000069c);
    expect(bar.style.pointerEvents).toBe('auto');
    expect(bar.style.cursor).toBe('move');
    dragFrom(bar, 50, -100);
    expect(geom()).toEqual({ left: '50px', top: '568px', bottom: '', width: '410px', height: '100px' });
    const w = win8();
    expect([w.x, w.y, w.w, w.h]).toEqual([50, 568, 410, 100]);
    // Off-screen drag clamps at the left/top edge.
    dragFrom(bar, -5000, -5000);
    expect(geom().left).toBe('0px');
    expect(geom().top).toBe('0px');
    dragFrom(bar, 0, 568);
  });

  it('the bottom-right grip 0x100006a1 (p44+p42) resizes width and height, reflowing the subtree', () => {
    const grip = borderEl(0x100006a1);
    expect(grip.style.pointerEvents).toBe('auto');
    // GAP.ui-cursor-global — GameUI sets no CSS cursor: the grip's arrow is its
    // DAT Cursor media, played by LayoutRenderer (verify-ui-cursor-global.ts).
    expect(grip.style.cursor).toBe('');
    dragFrom(grip, 100, 30);
    // y 568 + 130 = 698 fits under 768.
    expect(geom()).toEqual({ left: '0px', top: '568px', bottom: '', width: '510px', height: '130px' });
    expect(resizeCalls.at(-1)).toEqual([510, 130]);
    const w = win8();
    expect([w.w, w.h]).toEqual([510, 130]);
  });

  it('the left grip 0x1000069e (p43) resizes from the left, clamped to the root min width 300 (p63)', () => {
    dragFrom(borderEl(0x1000069e), 400, 0);
    // width 510 - 400 = 110 → clamped to 300; x = 0 + 510 - 300 = 210.
    expect(geom()).toEqual({ left: '210px', top: '568px', bottom: '', width: '300px', height: '130px' });
  });

  it('the top grip 0x1000069b (p43+p45) cannot shrink below the min height 100 (p62)', () => {
    dragFrom(borderEl(0x1000069b), 0, 500);
    expect(geom().height).toBe('100px');
    expect(geom().top).toBe('598px');
    expect(geom().width).toBe('300px');
  });

  it('maximize from a moved/resized window grows from ITS geometry and restores to it', () => {
    borderEl(MAIN_CHAT_WINDOW.maximizeButtonId).click();
    // (210,598) 300x100: bottom 698 < 768 but y 598 >= 384 → grow up: y 214, h 484.
    expect(geom()).toEqual({ left: '210px', top: '214px', bottom: '', width: '300px', height: '484px' });
    borderEl(MAIN_CHAT_WINDOW.maximizeButtonId).click();
    expect(geom()).toEqual({ left: '210px', top: '598px', bottom: '', width: '300px', height: '100px' });
  });

  it('LockUI on: the bars/grips are hidden and ignore the mouse; the maximize box still works', async () => {
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    ui.optionsSettings.lockUI = true;
    LayoutRenderer.setUILocked(true);
    ui.updateRadarLockedStatus();
    for (const id of MAIN_CHAT_WINDOW.interactiveBorderIds) expect(borderEl(id).style.display).toBe('none');
    const before = geom();
    dragFrom(borderEl(0x1000069c), 100, -100);
    expect(geom()).toEqual(before);
    borderEl(MAIN_CHAT_WINDOW.maximizeButtonId).click();
    expect(ui.isMainChatMaximized()).toBe(true);
    borderEl(MAIN_CHAT_WINDOW.maximizeButtonId).click();
    expect(ui.isMainChatMaximized()).toBe(false);
    ui.optionsSettings.lockUI = false;
    LayoutRenderer.setUILocked(false);
    ui.updateRadarLockedStatus();
    for (const id of MAIN_CHAT_WINDOW.interactiveBorderIds) expect(borderEl(id).style.display).toBe('');
  });

  it('server chat-window options for WindowID 8 replay through MoveTo/ResizeTo (UpdateFromPlayerModule), clamped to the screen', () => {
    const chatWindows = new Map<number, Record<string, unknown>>();
    chatWindows.set(MAIN_CHAT_WINDOW_ID, { x: 120, y: 300, w: 600, h: 250, filter: 0xfbffffffn });
    ui.setServerChatWindowOptions({ chatWindows });
    expect(geom()).toEqual({ left: '120px', top: '300px', bottom: '', width: '600px', height: '250px' });
    expect(ui.isMainChatMaximized()).toBe(false);
    expect(stateCalls.at(-1)).toEqual([MAIN_CHAT_WINDOW.maximizeButtonId, MAIN_CHAT_MAXIMIZE_STATE_NORMAL]);
    // Off-screen position → MoveTo clamp; oversize → p60/p61 clamp.
    chatWindows.set(MAIN_CHAT_WINDOW_ID, { x: 5000, y: 5000, w: 50, h: 9000, filter: 0xfbffffffn });
    ui.setServerChatWindowOptions({ chatWindows });
    // w 50 → p63 300; h 9000 → p60 2000; x 5000 → 1024 - 300; y 5000 → max(0, 768 - 2000) = 0.
    expect(geom()).toEqual({ left: `${1024 - 300}px`, top: '0px', bottom: '', width: '300px', height: '2000px' });
    const w = win8();
    expect([w.x, w.y, w.w, w.h]).toEqual([724, 0, 300, 2000]);
  });

  it('a persisted geometry (localStorage stand-in) is applied on a fresh renderHUD, un-maximized', async () => {
    stateCalls.length = 0;
    ui.renderHUD();
    expect(geom()).toEqual({ left: '724px', top: '0px', bottom: '', width: '300px', height: '2000px' });
    expect(ui.isMainChatMaximized()).toBe(false);
    expect(stateCalls.some(([id, st]) => id === MAIN_CHAT_WINDOW.maximizeButtonId && st === MAIN_CHAT_MAXIMIZE_STATE_NORMAL)).toBe(true);
  });
});
