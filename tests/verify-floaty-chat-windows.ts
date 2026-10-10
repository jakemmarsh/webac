/**
 * CORE.3.c — "[chat] Floating chat windows (gmFloatyChatUI) + 1-4 button
 * toggle wiring" (follow-up to Jake's live play-test CORE.3, 2026-08-23).
 *
 * Retail ground truth (decompiled EoL client + DAT):
 * - Four floaty windows = elements 0x10000505 / 0x1000050e / 0x1000050f /
 *   0x10000510 of gameplay layout 0x21000005 (gmGamePlayUI::SetupChildren @
 *   004e9ec0), each inheriting the FloatyChatWindow template
 *   0x100004f7@0x2100005b: title bar 0x10000529 (drag), title text
 *   0x100004d9, close box 0x1000052a, log 0x10000011, scrollbar 0x10000012,
 *   entry 0x10000016, Send 0x10000019. Raw descs: 250x104 at (0,35)/(0,145)/
 *   (0,255)/(0,365); p59=true → off by default; p87 = toggle command
 *   0x10000114-117; attribute 0x1000007e = window id 2-5.
 * - ChatInterface::PostInit @ 004f3dd0 seeds default text-type filters by
 *   window id: 2→0x101c (Speech|Tell|OutgoingTell|Emote), 3→0x40c00
 *   (Social|SocialSend|Allegiance), 4→0x80000 (Fellowship), 5→0x78000000
 *   (types 0x1B-0x1E, the Turbine global channels).
 * - ChatInterface::RecvNotice_DisplayFinalStringInfo @ 004f4640: untargeted
 *   messages display in every window whose filter passes TypeIsActive.
 * - gmMainChatUI::RecvNotice_SetPanelVisibility @ 004ccd80: buttons
 *   0x10000522-525 flip to state 6 (lit) while their window is open,
 *   state 1 otherwise.
 * - Default titles: string table 0x23000001 entries 0x997af25/0x997aab5/
 *   0x997aa45/0x997aa55 — "Chat Window 1: Speech" … "Chat Window 4:
 *   Channels" (keys ID_Chat_ChatN_DefaultTitle via compute_str_hash).
 *
 * Behavioral: drives the real GameUI.renderHUD() with a layoutRenderer
 * double (recording render/subtree/setState calls) and asserts the windows
 * build from the DAT subtree, toggle + flip button states, route messages by
 * type filter, and persist open/position per character scope.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals } from './_harness/dom.js';
import {
  FLOATY_CHAT_WINDOWS, floatyTypeIsActive, floatyChatStorageKey,
  loadFloatyChatStates, saveFloatyChatState,
  MAIN_CHAT_DEFAULT_FILTER, FLOATY_MIN_WIDTH, FLOATY_MIN_HEIGHT,
  GAMEPLAY_LAYOUT_ID, FLOATY_TITLE_TEXT_ID, FLOATY_CLOSE_BOX_ID,
  FLOATY_LOG_TEXT_ID, FLOATY_ENTRY_ID, FLOATY_SEND_ID,
} from '../packages/renderer/src/ui/FloatyChatModel.js';
import { ChatMessageType } from '../packages/shared/src/enums/ChatMessageType.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = [
  'window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event',
  'MouseEvent', 'MutationObserver',
] as const;

describe('CORE.3.c — floaty chat model matches decompiled-client ground truth', () => {
  it('window defs carry the retail element/button/command/window ids', () => {
    expect(FLOATY_CHAT_WINDOWS.map((d) => d.elementId))
      .toEqual([0x10000505, 0x1000050e, 0x1000050f, 0x10000510]);
    expect(FLOATY_CHAT_WINDOWS.map((d) => d.buttonElementId))
      .toEqual([0x10000522, 0x10000523, 0x10000524, 0x10000525]);
    expect(FLOATY_CHAT_WINDOWS.map((d) => d.commandId))
      .toEqual([0x10000114, 0x10000115, 0x10000116, 0x10000117]);
    expect(FLOATY_CHAT_WINDOWS.map((d) => d.windowId)).toEqual([2, 3, 4, 5]);
  });

  it('default filters match ChatInterface::PostInit @ 004f3dd0', () => {
    expect(FLOATY_CHAT_WINDOWS.map((d) => d.defaultFilter))
      .toEqual([0x101c, 0x40c00, 0x80000, 0x78000000]);
    // Main chat: everything except type 0x1A (constructor + case 1/8).
    expect(MAIN_CHAT_DEFAULT_FILTER).toBe(0xfbffffff);
    expect(floatyTypeIsActive(MAIN_CHAT_DEFAULT_FILTER, 0x1a)).toBe(false);
    expect(floatyTypeIsActive(MAIN_CHAT_DEFAULT_FILTER, ChatMessageType.Speech)).toBe(true);
  });

  it('default rects/titles/min-size match the DAT descs', () => {
    expect(FLOATY_CHAT_WINDOWS.map((d) => d.defaultRect))
      .toEqual([
        { x: 0, y: 35, w: 250, h: 104 },
        { x: 0, y: 145, w: 250, h: 104 },
        { x: 0, y: 255, w: 250, h: 104 },
        { x: 0, y: 365, w: 250, h: 104 },
      ]);
    expect(FLOATY_CHAT_WINDOWS.map((d) => d.defaultTitle)).toEqual([
      'Chat Window 1: Speech',
      'Chat Window 2: Allegiance',
      'Chat Window 3: Fellowship',
      'Chat Window 4: Channels',
    ]);
    expect(FLOATY_MIN_WIDTH).toBe(150); // template p63
    expect(FLOATY_MIN_HEIGHT).toBe(76); // template p62
  });

  it('floatyTypeIsActive is a plain bit test incl. bit 30 (type 0x1E)', () => {
    const w1 = FLOATY_CHAT_WINDOWS[0].defaultFilter;
    expect(floatyTypeIsActive(w1, ChatMessageType.Speech)).toBe(true);
    expect(floatyTypeIsActive(w1, ChatMessageType.Tell)).toBe(true);
    expect(floatyTypeIsActive(w1, ChatMessageType.OutgoingTell)).toBe(true);
    expect(floatyTypeIsActive(w1, ChatMessageType.Emote)).toBe(true);
    expect(floatyTypeIsActive(w1, ChatMessageType.Fellowship)).toBe(false);
    const w4 = FLOATY_CHAT_WINDOWS[3].defaultFilter;
    expect(floatyTypeIsActive(w4, ChatMessageType.X1B)).toBe(true);
    expect(floatyTypeIsActive(w4, ChatMessageType.X1E)).toBe(true);
    expect(floatyTypeIsActive(w4, ChatMessageType.Speech)).toBe(false);
    expect(floatyTypeIsActive(w4, -1)).toBe(false);
    expect(floatyTypeIsActive(w4, 32)).toBe(false);
  });
});

describe('CORE.3.c — floaty chat windows in the real GameUI', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let setStateCalls: Array<{ id: number; state: number }>;
  let subtreeRenders: Array<{ layoutId: number; elementId: number }>;
  let sent: string[];
  // Per-render-handle element maps so each floaty window gets its own DOM.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handles: any[];

  const makeHandle = (layoutId: number, parent: HTMLElement, opts?: { subtreeElementId?: number }) => {
    const root = domWindow.document.createElement('div') as HTMLElement;
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const getOrCreate = (id: number): HTMLElement => {
      let el = elements.get(id);
      if (!el) {
        el = domWindow.document.createElement('div') as HTMLElement;
        el.setAttribute('data-element-id', `0x${id.toString(16)}`);
        root.appendChild(el);
        elements.set(id, el);
      }
      return el;
    };
    const handle = {
      root,
      layoutId,
      subtreeElementId: opts?.subtreeElementId,
      texts: new Map<number, string>(),
      clickHandlers: new Map<number, () => void>(),
      elements: { get: (id: number) => getOrCreate(id), set: () => {} },
      setText(id: number, text: string) { handle.texts.set(id, text); },
      setInteractive(id: number, cb?: () => void) { if (cb) handle.clickHandlers.set(id, cb); },
      setVisible(id: number, visible: boolean) { getOrCreate(id).style.display = visible ? '' : 'none'; },
      setState(id: number, state: number) { setStateCalls.push({ id, state }); },
      setFill: () => {}, setPalette: () => {}, setTexture: () => {},
      setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
      close: () => { root.remove(); },
      destroy: () => { root.remove(); },
    };
    handles.push(handle);
    if (opts?.subtreeElementId !== undefined) {
      subtreeRenders.push({ layoutId, elementId: opts.subtreeElementId });
    }
    return handle;
  };

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    setStateCalls = [];
    subtreeRenders = [];
    handles = [];
    sent = [];
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container, { onChatSend: (msg: string) => sent.push(msg) });
    ui.getTexURL = (id: number) => `tex:0x${id.toString(16)}`;
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement, opts?: { subtreeElementId?: number }) =>
        makeHandle(layoutId, parent, opts),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
    ui.setChatHistoryScope('acct', 'TestChar');
    ui.renderHUD();
  });

  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) g[key] = saved[key];
  });

  const floatyPanel = (index: number): HTMLElement | null =>
    domWindow.document.querySelector(`[data-floaty-chat="${index}"]`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const floatyHandle = (index: number): any =>
    handles.find((h) => h.subtreeElementId === FLOATY_CHAT_WINDOWS[index - 1].elementId);

  it('builds all four windows as 0x21000005 element subtrees, hidden by default', () => {
    // CORE.5.b.c also subtree-renders the vitals cluster (its own layout
    // 0x2100006c/0x21000075) — scope the assertion to the gameplay layout.
    expect(subtreeRenders.filter((r) => r.layoutId === GAMEPLAY_LAYOUT_ID)).toEqual(FLOATY_CHAT_WINDOWS.map((d) => ({
      layoutId: GAMEPLAY_LAYOUT_ID, elementId: d.elementId,
    })));
    for (const def of FLOATY_CHAT_WINDOWS) {
      const panel = floatyPanel(def.index)!;
      expect(panel).toBeTruthy();
      expect(panel.style.display).toBe('none'); // template p59=true — off by default
      expect(panel.style.left).toBe(`${def.defaultRect.x}px`);
      expect(panel.style.top).toBe(`${def.defaultRect.y}px`);
      expect(ui.isFloatyChatWindowOpen(def.index)).toBe(false);
    }
  });

  it('sets the retail default title into the title text element', () => {
    for (const def of FLOATY_CHAT_WINDOWS) {
      expect(floatyHandle(def.index).texts.get(FLOATY_TITLE_TEXT_ID)).toBe(def.defaultTitle);
    }
  });

  it('toggle opens the window and lights its 1-4 button (state 6)', () => {
    setStateCalls.length = 0;
    ui.toggleFloatyChatWindow(1);
    expect(ui.isFloatyChatWindowOpen(1)).toBe(true);
    expect(floatyPanel(1)!.style.display).not.toBe('none');
    expect(setStateCalls).toContainEqual({ id: 0x10000522, state: 6 });
  });

  it('routes an untargeted Speech line into window 1 and the main log', () => {
    ui.addSystemMessage('Bob says, "hello"', '#ffffff', ChatMessageType.Speech);
    const mainLog = domWindow.document.getElementById('chat-messages')!;
    expect(mainLog.textContent).toContain('Bob says');
    const log1 = floatyHandle(1).elements.get(FLOATY_LOG_TEXT_ID) as HTMLElement;
    expect(log1.textContent).toContain('Bob says');
    // Fellowship-only window 3 must NOT receive it.
    const log3 = floatyHandle(3).elements.get(FLOATY_LOG_TEXT_ID) as HTMLElement;
    expect(log3.textContent ?? '').not.toContain('Bob says');
  });

  it('routes Fellowship to window 3 and X1B channel text to window 4 — even while hidden', () => {
    ui.addSystemMessage('Fellow line', '#ffff00', ChatMessageType.Fellowship);
    ui.addSystemMessage('[General] Bob: hi', '#00ffff', ChatMessageType.X1B);
    const log3 = floatyHandle(3).elements.get(FLOATY_LOG_TEXT_ID) as HTMLElement;
    const log4 = floatyHandle(4).elements.get(FLOATY_LOG_TEXT_ID) as HTMLElement;
    expect(log3.textContent).toContain('Fellow line');
    expect(log4.textContent).toContain('[General] Bob: hi');
    expect(log3.textContent).not.toContain('[General]');
    expect(log4.textContent).not.toContain('Fellow line');
  });

  it('Broadcast (untyped) lines stay out of every floaty window', () => {
    ui.addSystemMessage('plain broadcast', '#ffffff');
    for (const def of FLOATY_CHAT_WINDOWS) {
      const log = floatyHandle(def.index).elements.get(FLOATY_LOG_TEXT_ID) as HTMLElement;
      expect(log.textContent ?? '').not.toContain('plain broadcast');
    }
    expect(domWindow.document.getElementById('chat-messages')!.textContent).toContain('plain broadcast');
  });

  it('close box hides the window and reverts its button to state 1', () => {
    setStateCalls.length = 0;
    const close = floatyHandle(1).clickHandlers.get(FLOATY_CLOSE_BOX_ID);
    expect(close).toBeTypeOf('function');
    close();
    expect(ui.isFloatyChatWindowOpen(1)).toBe(false);
    expect(floatyPanel(1)!.style.display).toBe('none');
    expect(setStateCalls).toContainEqual({ id: 0x10000522, state: 1 });
  });

  it('persists open state + position per character scope and restores on re-render', () => {
    ui.toggleFloatyChatWindow(2, true);
    const key = floatyChatStorageKey('acct:TestChar');
    const stored = JSON.parse(domWindow.localStorage.getItem(key)!);
    expect(stored[2].open).toBe(true);
    expect(stored[2].x).toBe(0);
    expect(stored[2].y).toBe(145);

    // Simulate a dragged position, then re-render the HUD — the window
    // must come back open at the saved spot (retail PlayerModule
    // chat-window options 0x10000086/87 round-trip).
    // (A relog with nothing stored server-side, so the localStorage stand-in
    // decides — the live PlayerModule copy would otherwise hold the toggle.)
    ui.setServerChatWindowOptions(null);
    saveFloatyChatState(domWindow.localStorage, 'acct:TestChar', 2, { open: true, x: 123, y: 77 });
    subtreeRenders.length = 0;
    ui.renderHUD();
    const panel = floatyPanel(2)!;
    expect(panel.style.display).not.toBe('none');
    expect(panel.style.left).toBe('123px');
    expect(panel.style.top).toBe('77px');
    expect(ui.isFloatyChatWindowOpen(2)).toBe(true);
  });

  it('floaty entry row sends through the same onChatSend path', () => {
    const entryArea = floatyHandle(2).elements.get(FLOATY_ENTRY_ID) as HTMLElement;
    const input = entryArea.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    // RECON.chat-entry-maxchars: the cap is the entry desc's p30; this stub has no desc, so GlyphList's 0xffff default.
    expect(input.maxLength).toBe(0xffff);
    input.value = 'hello from floaty';
    const sendCb = floatyHandle(2).clickHandlers.get(FLOATY_SEND_ID);
    expect(sendCb).toBeTypeOf('function');
    sendCb();
    expect(sent).toContain('hello from floaty');
    expect(input.value).toBe('');
  });

  it('loadFloatyChatStates survives corrupt storage', () => {
    domWindow.localStorage.setItem(floatyChatStorageKey('bad'), '{not json');
    expect(loadFloatyChatStates(domWindow.localStorage, 'bad')).toEqual({});
  });

  // CORE.3.e — retail dims the WHOLE floaty window while unfocused:
  // ChatInterface::SetOpacity @ 004f3120 sets opacity on the window's render
  // object (UIRegion::GetObject → UIObject vtbl+0x48), so title text, log
  // lines, scrollbar art and chrome all blend together — the zoomed
  // reference/images/hud/chat-panel.jpg shows the WHITE base-p27 title
  // reading gray purely from that blending. (State 13 is the framework
  // Disabled state — every decomp setter is an explicit control disable —
  // NOT focus styling.) Active opacity applies while the entry has focus
  // (SetActiveOpacity's focus-descendant gate), default otherwise.
  // CORE.17.h — the values are the ChatInterface constructor's
  // (ChatInterface::ChatInterface @ 004f4550: default 0.5, active 1.0);
  // gmFloatyChatUI::Create @ 004ce2c0 adds nothing on top.
  it('CORE.3.e — whole-window opacity: default (50%) unfocused, active (100%) while the entry has focus', () => {
    // Query the LIVE panel (earlier tests re-render, so the first handle in
    // `handles` is stale — its input drives a detached panelEl).
    const panel = floatyPanel(1)!;
    const input = panel.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    // Rendered unfocused → ChatInterface ctor default 0.5.
    expect(parseFloat(panel.style.opacity)).toBeCloseTo(0.5, 5);
    input.dispatchEvent(new domWindow.Event('focus'));
    expect(parseFloat(panel.style.opacity)).toBeCloseTo(1.0, 5);
    input.dispatchEvent(new domWindow.Event('blur'));
    expect(parseFloat(panel.style.opacity)).toBeCloseTo(0.5, 5);
    // CORE.17.h — the 20-tick fade of ChatInterface::ListenToGlobalMessage
    // @ 004f3840 as a transition.
    expect(panel.style.transition).toBe('opacity 333ms linear');
    // The whole window dims — no per-element texture-alpha override left on
    // the title text element (its white base p27 must blend, not be
    // repainted with a pre-darkened backing).
    const title = panel.querySelector('[data-element-id="0x100004d9"]') as HTMLElement;
    expect(title == null || !title.style.backgroundImage.includes('0x6004cc2')).toBe(true);
  });
});

// ── DAT ground truth — the model constants trace back to the real files ──
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDat } from './_harness/dat.js';
const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const ENGLISH_DAT = resolve(REPO, 'dat/client_local_English.dat');
const HAVE_DATS = existsSync(PORTAL_DAT) && existsSync(ENGLISH_DAT);

describe.skipIf(!HAVE_DATS)('CORE.3.c — FloatyChatWindow template resolves from the DAT', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resolved: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any;
  let titles: string[];

  beforeAll(async () => {
    // All DAT reads live here — describe.skipIf does NOT skip the callback
    // body at collection time (see CLAUDE.md testing rules).
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, resolveElementTree, parseStringTable } =
      await import('../packages/dat-parser/src/index.js');
    const open = (path: string) => {
      return openDat(path);
    };
    const portal = open(PORTAL_DAT);
    const english = open(ENGLISH_DAT);
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portal.getFileData(0x39000001)!)));
    const getLayout = (id: number) => {
      const data = english.getFileData(id) ?? portal.getFileData(id);
      return data ? parseLayoutDesc(new DatReader(data)) : null;
    };
    const layout = getLayout(GAMEPLAY_LAYOUT_ID)!;
    raw = layout.elements.get(0x10000495)!.children.get(0x10000505)!;
    resolved = resolveElementTree(raw, getLayout);
    const table = parseStringTable(new DatReader(english.getFileData(0x23000001)!));
    const byId = new Map(table.entries.map((e: { id: number; strings: string[] }) => [e.id, e.strings[0]]));
    titles = [0x0997af25, 0x0997aab5, 0x0997aa45, 0x0997aa55].map((id) => byId.get(id) ?? '');
  });

  it('raw desc: base 0x100004f7@0x2100005b, off by default, toggle command p87', () => {
    expect(raw.baseElement).toBe(0x100004f7);
    expect(raw.baseLayout).toBe(0x2100005b);
    expect(raw.properties.get(59)?.valueBool).toBe(true); // start hidden
    expect(raw.properties.get(87)?.valueEnum).toBe(0x10000114); // toggle command
    expect(raw.properties.get(0x1000007e)?.valueEnum).toBe(2); // window id
    expect({ x: raw.x, y: raw.y, w: raw.width, h: raw.height })
      .toEqual(FLOATY_CHAT_WINDOWS[0].defaultRect);
  });

  it('resolved template carries the full ChatInterface subtree + min size', () => {
    const childIds = new Set<number>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (el: any) => {
      childIds.add(el.elementId);
      for (const [, c] of el.children) walk(c);
    };
    walk(resolved);
    for (const id of [
      0x10000529, FLOATY_TITLE_TEXT_ID, FLOATY_CLOSE_BOX_ID,
      FLOATY_LOG_TEXT_ID, 0x10000012, FLOATY_ENTRY_ID, FLOATY_SEND_ID,
      0x1000048c,
    ]) {
      expect(childIds.has(id), `missing 0x${id.toString(16)}`).toBe(true);
    }
    expect(resolved.properties.get(62)?.valueInt).toBe(FLOATY_MIN_HEIGHT);
    expect(resolved.properties.get(63)?.valueInt).toBe(FLOATY_MIN_WIDTH);
  });

  it('default titles in string table 0x23000001 match the model fallbacks', () => {
    expect(titles).toEqual(FLOATY_CHAT_WINDOWS.map((d) => d.defaultTitle));
  });
});
