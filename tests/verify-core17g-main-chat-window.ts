/**
 * CORE.17.g — "[hud] Chat dock is a third of the screen wide, leaving a bare
 * gap across the bottom" (gestalt scene audit 2026-09-07).
 *
 * Premise correction (recorded in the task notes): the audit anchored the
 * chat to the two 610-wide windows the root HUD authors at (0,400) —
 * 0x100005fd → 0x2100006d and 0x100006b5 → 0x21000073. Those are the
 * bottom panel dock (Trade/Examine-style panels) and the combat bar
 * window; neither is chat. The main chat is 0x10000601 → 0x2100006f, a
 * 410x100 window (root 0x10000600, type 0x10000050 = gmFloatyMainChatUI,
 * GetUIElementType @ 004d2370) pinned bottom-left at native size. Both
 * retail references — the EoL client under Wine at 1024x768 and the
 * 1920x1080 shutdown capture — show exactly that 410-wide window with bare
 * screen between it and the toolbar; retail never scales chat with the
 * viewport.
 *
 * The real defect was the layout: we rendered classic_chat 0x21000006 (the
 * pre-floaty 800x100 bar, gmMainChatUI) clipped to 490px — 80px too wide,
 * no side frame, text flush at x=0. 0x21000006 is not referenced by the
 * EoL root HUD 0x21000005 at all.
 *
 * Part 1 pins the DAT facts above (skipped without DATs; loads happen in
 * beforeAll so the collection-time body is safe on CI). Part 2 drives the
 * real GameUI.renderHUD() and asserts the LockUI border-set rule
 * (gmFloatyMainChatUI::UpdateLockedStatus @ 004d23d0): unlocked shows the
 * drag/resize bars (types 2/9) and hides the locked art (type 3,
 * 0x060074bf-c6); locked flips both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { MAIN_CHAT_WINDOW } from '../packages/renderer/src/ui/FloatyChatModel.js';
import { openDat } from './_harness/dat.js';

const hasDats = fs.existsSync('dat/client_portal.dat') && fs.existsSync('dat/client_local_English.dat');

describe.skipIf(!hasDats)('CORE.17.g — DAT: the EoL main chat is 0x10000601 → 0x2100006f, 410x100', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rootHud: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chat: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dock: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let combatWin: any;

  beforeAll(async () => {
    const { DatDatabase } = await import('@ac/dat-parser/DatDatabase.js');
    const { DatReader } = await import('@ac/dat-parser/DatReader.js');
    const { parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes } =
      await import('@ac/dat-parser/file-types/LayoutDesc.js');
    const portalDb = openDat('dat/client_portal.dat');
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portalDb.getFileData(0x39000001)!)));
    const langDb = openDat('dat/client_local_English.dat');
    const load = (id: number) => parseLayoutDesc(new DatReader(langDb.getFileData(id)!));
    rootHud = load(0x21000005);
    chat = load(MAIN_CHAT_WINDOW.layoutId);
    dock = load(0x2100006d);
    combatWin = load(0x21000073);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function hudChild(id: number): any {
    const root = rootHud.elements.get(0x10000495);
    return root?.children.get(id) ?? rootHud.elements.get(id);
  }

  it('root HUD 0x21000005 authors the main chat 0x10000601 at (0,500) 410x100, edges L1/T2/R2/B1 → 0x2100006f', () => {
    const el = hudChild(MAIN_CHAT_WINDOW.hudElementId);
    expect(el).toBeDefined();
    expect([el.x, el.y, el.width, el.height]).toEqual([0, 500, 410, 100]);
    expect([el.leftEdge, el.topEdge, el.rightEdge, el.bottomEdge]).toEqual([1, 2, 2, 1]);
    expect(el.baseLayout).toBe(0x2100006f);
  });

  it('the root HUD never references classic_chat 0x21000006', () => {
    const root = rootHud.elements.get(0x10000495);
    const layouts = new Set<number>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (e: any): void => { layouts.add(e.baseLayout); for (const [, c] of e.children) walk(c); };
    walk(root);
    expect(layouts.has(0x21000006)).toBe(false);
    expect(layouts.has(0x2100006f)).toBe(true);
  });

  it('layout 0x2100006f root 0x10000600 is the 410x100 gmFloatyMainChatUI window (type 0x10000050, min 300x100, max 2000x2000)', () => {
    const root = chat.elements.get(MAIN_CHAT_WINDOW.rootElementId);
    expect(root).toBeDefined();
    expect([root.width, root.height]).toEqual([MAIN_CHAT_WINDOW.width, MAIN_CHAT_WINDOW.height]);
    expect(root.type).toBe(0x10000050);
    expect(root.zLevel).toBe(600);
    const p = (n: number) => root.properties.get(n)?.valueInt;
    expect([p(0x3f), p(0x3e), p(0x3d), p(0x3c)]).toEqual([
      MAIN_CHAT_WINDOW.minWidth, MAIN_CHAT_WINDOW.minHeight, MAIN_CHAT_WINDOW.maxWidth, MAIN_CHAT_WINDOW.maxHeight,
    ]);
  });

  it('the message area 0x10000010 is (5,5) 400x73 on tile 0x06004cc2 with text at x=16 and the scrollbar at x=384', () => {
    const root = chat.elements.get(MAIN_CHAT_WINDOW.rootElementId);
    const area = root.children.get(MAIN_CHAT_WINDOW.messageAreaId);
    expect(area).toBeDefined();
    expect([area.x, area.y, area.width, area.height]).toEqual([5, 5, 400, 73]);
    expect(area.media.some((m: { file?: number }) => m.file === 0x06004cc2)).toBe(true);
    const text = area.children.get(0x10000011);
    const scroll = area.children.get(0x10000012);
    expect([text.x, text.width]).toEqual([16, 368]);
    expect([scroll.x, scroll.width]).toEqual([384, 16]);
    const input = root.children.get(MAIN_CHAT_WINDOW.inputRowId);
    expect([input.x, input.y, input.width, input.height]).toEqual([5, 78, 400, 17]);
    expect(input.media.some((m: { file?: number }) => m.file === 0x0600113a)).toBe(true);
  });

  it('carries both border sets: locked art (type 3, 0x060074bf-c6) and drag/resize bars (types 2/9)', () => {
    const root = chat.elements.get(MAIN_CHAT_WINDOW.rootElementId);
    const lockedTex = new Set([0x060074bf, 0x060074c0, 0x060074c1, 0x060074c2, 0x060074c3, 0x060074c4, 0x060074c5, 0x060074c6]);
    for (const id of MAIN_CHAT_WINDOW.lockedBorderIds) {
      const el = root.children.get(id);
      expect(el, `0x${id.toString(16)}`).toBeDefined();
      expect(el.type).toBe(3);
      expect(el.media.some((m: { file?: number }) => lockedTex.has(m.file ?? 0))).toBe(true);
    }
    for (const id of MAIN_CHAT_WINDOW.interactiveBorderIds) {
      const el = root.children.get(id);
      expect(el, `0x${id.toString(16)}`).toBeDefined();
      expect([2, 9]).toContain(el.type);
    }
  });

  it('premise correction: the 610-wide (0,400) windows are the panel dock 0x2100006d and combat window 0x21000073, not chat', () => {
    const dockEl = hudChild(0x100005fd);
    const combatEl = hudChild(0x100006b5);
    expect([dockEl.width, dockEl.baseLayout]).toEqual([610, 0x2100006d]);
    expect([combatEl.width, combatEl.baseLayout]).toEqual([610, 0x21000073]);
    // 0x2100006d hosts the bottom panel layouts (0x21000012/08/0c/0d/0e);
    // 0x21000073 hosts the combat/magic bars (0x21000010/0x21000007).
    const dockRoot = dock.elements.get(0x100005fb);
    const dockLayouts = new Set<number>([...dockRoot.children.values()].map((c: { baseLayout: number }) => c.baseLayout));
    expect(dockLayouts.has(0x21000012)).toBe(true);
    expect(dockLayouts.has(0x2100006f)).toBe(false);
    const cwRoot = combatWin.elements.get(0x100006a4);
    const cwLayouts = new Set<number>([...cwRoot.children.values()].map((c: { baseLayout: number }) => c.baseLayout));
    expect(cwLayouts.has(0x21000010)).toBe(true);
    expect(cwLayouts.has(0x21000007)).toBe(true);
  });
});

// ── Part 2: behavioral — LockUI border swap on the main chat ───────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const LOCKED_TEXTURES = [0x060074c3, 0x060074bf, 0x060074c4, 0x060074c0, 0x060074c5, 0x060074c1, 0x060074c6, 0x060074c2];

describe('CORE.17.g — GameUI renders the main chat window with the LockUI border rule', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const renderedLayouts: number[] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);

    const makeHandle = (layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const descs = new Map<number, { type: number; media: Array<{ file?: number }> }>();
      const add = (id: number, type: number, file?: number): void => {
        const el = domWindow.document.createElement('div') as HTMLElement;
        el.setAttribute('data-element-id', `0x${id.toString(16)}`);
        root.appendChild(el);
        elements.set(id, el);
        descs.set(id, { type, media: file ? [{ file }] : [] });
      };
      if (layoutId === MAIN_CHAT_WINDOW.layoutId) {
        if (parent.id === 'hud-chat') renderedLayouts.push(layoutId);
        add(MAIN_CHAT_WINDOW.rootElementId, 0x10000050);
        MAIN_CHAT_WINDOW.lockedBorderIds.forEach((id, i) => add(id, 3, LOCKED_TEXTURES[i]));
        // 0x1000069c / 0x100006a0 are the type-2 drag bars, the rest type-9 resize grips
        for (const id of MAIN_CHAT_WINDOW.interactiveBorderIds) add(id, id === 0x1000069c || id === 0x100006a0 ? 2 : 9, 0x0600612a);
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
        setText: () => {}, setInteractive: () => {}, setState: () => {},
        setVisible: (id: number, visible: boolean) => { getOrCreate(id).style.display = visible ? '' : 'none'; },
        setTexture: () => {}, setFill: () => {}, setPalette: () => {},
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
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

  const display = (id: number): string => (ui.chatHandle.elements.get(id) as HTMLElement).style.display;

  it('#hud-chat hosts layout 0x2100006f at the DAT window size, bottom-left', () => {
    expect(renderedLayouts).toEqual([0x2100006f]);
    const chat = domWindow.document.getElementById('hud-chat') as HTMLElement;
    expect(chat.style.width).toBe('410px');
    expect(chat.style.height).toBe('100px');
    expect(chat.style.left).toBe('0px');
    expect(chat.style.bottom).toBe('0px');
    expect(ui.chatHandle.root.style.height).toBe('100px');
  });

  it('LockUI off (retail default): drag/resize borders visible, locked art hidden', () => {
    for (const id of MAIN_CHAT_WINDOW.interactiveBorderIds) expect(display(id), `0x${id.toString(16)}`).toBe('');
    for (const id of MAIN_CHAT_WINDOW.lockedBorderIds) expect(display(id), `0x${id.toString(16)}`).toBe('none');
  });

  it('LockUI on: locked art visible, drag/resize borders hidden (UpdateLockedStatus @ 004d23d0)', () => {
    ui.optionsSettings.lockUI = true;
    ui.updateRadarLockedStatus();
    for (const id of MAIN_CHAT_WINDOW.lockedBorderIds) expect(display(id), `0x${id.toString(16)}`).toBe('');
    for (const id of MAIN_CHAT_WINDOW.interactiveBorderIds) expect(display(id), `0x${id.toString(16)}`).toBe('none');
    ui.optionsSettings.lockUI = false;
    ui.updateRadarLockedStatus();
    for (const id of MAIN_CHAT_WINDOW.lockedBorderIds) expect(display(id)).toBe('none');
  });

  it('the window content (message area, input row, buttons, maximize box) is never hidden by the border rule', () => {
    for (const id of [0x10000010, 0x10000011, 0x10000013, 0x10000014, 0x10000016, 0x10000019, 0x1000046f]) {
      expect(display(id), `0x${id.toString(16)}`).toBe('');
    }
  });
});
