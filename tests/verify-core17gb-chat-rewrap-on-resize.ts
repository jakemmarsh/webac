/**
 * CORE.17.g.b — "[chat] Existing chat log lines do not re-wrap when the
 * main chat window is resized/maximized".
 *
 * Ground truth (decompiled EoL client): the chat log is ONE UIElement_Text
 * holding every line, and UIElement_Text::ResizeTo @ 00467a30 — after the
 * UIElement_Scrollable resize — returns early when the width AND height are
 * unchanged, otherwise recomputes the margins, sets dirty bit 0x100 and
 * calls UIRegion::MakeRootDirtyHere, so the whole text is laid out again at
 * the new width on the next draw. ChatInterface::ResizeTo @ 004f39e0 then
 * keeps the log pinned at its end when it was there. Every floaty chat
 * window is a full ChatInterface, so the same applies to its log.
 *
 * Pre-fix each of our lines was one AC-font canvas baked at the wrap width
 * of the moment it was appended: widening the window left "... type" /
 * "@acehelp" split as before, and narrowing it clipped the lines.
 *
 * Part 1 drives the real GameUI under happy-dom with the CORE.17.s stub
 * renderer (log width faked via clientWidth): rewrapChatLog re-lays out the
 * wrapped runs at the new width, leaves unwrapped runs alone, and skips a
 * size-unchanged resize. Part 2 drives the CORE.17.g.a main-chat-window
 * harness: a grip resize and the maximize box both go through the re-wrap.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { MAIN_CHAT_WINDOW } from '../packages/renderer/src/ui/FloatyChatModel.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const WELCOME = "Welcome to Asheron's Call\n  powered by ACEmulator\n\nFor more information on commands supported by this server, type @acehelp\n";

describe('CORE.17.g.b — chat log lines re-wrap at the log\'s new width (happy-dom, real GameUI)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function stubLayoutRenderer(ui: any): void {
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const getOrCreate = (id: number): HTMLElement => {
        let el = elements.get(id);
        if (!el) { el = domWindow.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
        return el;
      };
      return {
        root,
        elements: { get: (id: number) => getOrCreate(id), set: () => {} },
        setText: () => {}, setInteractive: () => {}, setState: () => {},
        setVisible: () => {}, setFill: () => {}, setPalette: () => {},
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
        close: () => { root.remove(); }, destroy: () => { root.remove(); },
      };
    };
    ui.getTexURL = () => null;
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
  }

  function makeUI(logClientWidth: number) {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    stubLayoutRenderer(ui);
    ui.showGame();
    const chat = container.querySelector('#chat-messages') as HTMLElement;
    expect(chat).toBeTruthy();
    const setWidth = (w: number) => Object.defineProperty(chat, 'clientWidth', { value: w, configurable: true });
    setWidth(logClientWidth);
    return { ui, chat, setWidth };
  }

  const wrappedRuns = (line: HTMLElement): HTMLElement[] =>
    [...line.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];

  it('a wrapped run records its source text/colour/scale and the width it was laid out at', () => {
    const { ui, chat } = makeUI(458);
    ui.addSystemMessage('For more information on commands supported by this server, type @acehelp', '#80ff7f', 0);
    const run = wrappedRuns(chat.lastElementChild as HTMLElement)[0];
    expect(run.dataset.acWrapText).toBe('For more information on commands supported by this server, type @acehelp');
    expect(run.dataset.acWrapColor).toBe('#80ff7f');
    expect(run.dataset.acWrapScale).toBe('1');
    expect(run.dataset.acWrapWidth).toBe('454');
    expect(run.style.maxWidth).toBe('454px');
  });

  it('widening the log re-lays out every wrapped run of every line at the new width', () => {
    const { ui, chat, setWidth } = makeUI(458);
    ui.addSystemMessage(WELCOME, '#80ff7f', 0);
    ui.addSystemMessage('You have entered Holtburg.', '#ffffff', 0);
    ui.addChatMessage('Perf Tester', 'a fairly long line of speech that must wrap inside the main log', '#ffffff', 2);
    const before = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    // CORE.17.s.a — the welcome's trailing "\n" is trimmed: one run fewer.
    expect(before.length).toBe(WELCOME.split('\n').length + 1);
    for (const r of before) expect(r.style.maxWidth).toBe('454px');

    // 410 → 570 wide window (the CORE.17.g.a moved+resized scene): the log
    // text element 0x10000011 gains the same 160px.
    setWidth(618);
    expect(ui.rewrapChatLog(chat)).toBe(before.length);

    const after = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    expect(after.length).toBe(before.length);
    after.forEach((r, i) => {
      expect(r).not.toBe(before[i]);                       // laid out afresh
      expect(r.dataset.acWrapText).toBe(before[i].dataset.acWrapText);
      expect(r.dataset.acWrapColor).toBe(before[i].dataset.acWrapColor);
      expect(r.dataset.acWrapWidth).toBe('614');
      expect(r.style.maxWidth).toBe('614px');
      expect(r.style.color).toBe(before[i].style.color);
    });
    // line order and per-line run count survive the in-place replacement
    expect(chat.children.length).toBe(3);
    expect(wrappedRuns(chat.children[0] as HTMLElement).length).toBe(WELCOME.split('\n').length - 1); // trailing "\n" trimmed (CORE.17.s.a)
    expect(wrappedRuns(chat.children[0] as HTMLElement)[3].dataset.acWrapText)
      .toBe('For more information on commands supported by this server, type @acehelp');
  });

  it('narrowing re-wraps too, and the unwrapped runs (sender prefix, timestamp) are left untouched', () => {
    const { ui, chat, setWidth } = makeUI(458);
    ui.optionsSettings.displayTimestamps = true;
    ui.addChatMessage('Perf Tester', 'a fairly long line of speech that must wrap inside the main log', '#ffffff', 2);
    const line = chat.lastElementChild as HTMLElement;
    const spans = [...line.querySelectorAll('span')] as HTMLElement[];
    expect(spans.length).toBe(3);                          // [stamp] sender: body
    const stamp = spans[0], sender = spans[1];
    expect(stamp.dataset.acWrapText).toBeUndefined();
    expect(sender.dataset.acWrapText).toBeUndefined();

    setWidth(308);                                         // 300-wide window (root p63 min)
    expect(ui.rewrapChatLog(chat)).toBe(1);
    const spans2 = [...line.querySelectorAll('span')] as HTMLElement[];
    expect(spans2[0]).toBe(stamp);
    expect(spans2[1]).toBe(sender);
    expect(spans2[2].style.maxWidth).toBe('304px');
    expect(spans2[2].textContent).toBe('a fairly long line of speech that must wrap inside the main log');
  });

  it('a resize that leaves the width unchanged re-lays out nothing (UIElement_Text::ResizeTo early return)', () => {
    const { ui, chat } = makeUI(458);
    ui.addSystemMessage(WELCOME, '#80ff7f', 0);
    const before = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    expect(ui.rewrapChatLog(chat)).toBe(0);
    const after = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    after.forEach((r, i) => expect(r).toBe(before[i]));
  });

  it('a log with no layout (hidden) is left alone rather than wrapped at 0', () => {
    const { ui, chat, setWidth } = makeUI(458);
    ui.addSystemMessage(WELCOME, '#80ff7f', 0);
    setWidth(0);
    expect(ui.rewrapChatLog(chat)).toBe(0);
    expect(ui.rewrapChatLog(null)).toBe(0);
    const runs = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    for (const r of runs) expect(r.style.maxWidth).toBe('454px');
  });

  it('lines appended after a resize wrap at the current width, and a later resize re-wraps old and new alike', () => {
    const { ui, chat, setWidth } = makeUI(458);
    ui.addSystemMessage('first, at 450', '#ffffff', 0);
    setWidth(618);
    ui.rewrapChatLog(chat);
    ui.addSystemMessage('second, at 610', '#ffffff', 0);
    let runs = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    expect(runs.map((r) => r.dataset.acWrapWidth)).toEqual(['614', '614']);
    setWidth(408);
    expect(ui.rewrapChatLog(chat)).toBe(2);
    runs = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    expect(runs.map((r) => r.dataset.acWrapWidth)).toEqual(['404', '404']);
  });
});

// ── Part 2: the main chat window's resize paths run the re-wrap ────────────

const GRIP_FLAGS: Record<number, { l?: boolean; r?: boolean; t?: boolean; b?: boolean }> = {
  0x1000069b: { l: true, t: true }, 0x1000069d: { r: true, t: true }, 0x1000069e: { l: true },
  0x1000069f: { l: true, b: true }, 0x100006a0: { b: true }, 0x100006a1: { r: true, b: true }, 0x100006a2: { r: true },
};

describe('CORE.17.g.b — grip resize and the maximize box re-wrap the main chat log (happy-dom, real GameUI.renderHUD)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let chat: HTMLElement;
  // happy-dom has no layout: the stub resizeSubtree below makes the log's
  // client width TRACK the window width (the message area 0x10000011 has
  // the R1 edge, so in the browser it gains exactly the window's width
  // delta); the fixed 20px stands in for the scrollbar column + margins.
  const logWidthFor = (windowW: number) => windowW - 20;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    domWindow.localStorage.clear();
    domWindow.document.body.innerHTML = '';
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
        MAIN_CHAT_WINDOW.lockedBorderIds.forEach((id) => add(id, 3, 0x060074c3));
        for (const id of MAIN_CHAT_WINDOW.interactiveBorderIds) {
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
        setText: () => {}, setInteractive: () => {}, setState: () => {},
        setVisible: (id: number, visible: boolean) => { getOrCreate(id).style.display = visible ? '' : 'none'; },
        setTexture: () => {}, setFill: () => {}, setPalette: () => {},
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
        resizeSubtree: layoutId === MAIN_CHAT_WINDOW.layoutId
          ? (w: number, h: number) => {
            root.style.width = `${w}px`; root.style.height = `${h}px`;
            // the DAT R1 edge on the message area: the log tracks the window width
            Object.defineProperty(chat, 'clientWidth', { value: logWidthFor(w), configurable: true });
          }
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
    chat = domWindow.document.getElementById('chat-messages') as HTMLElement;
    Object.defineProperty(chat, 'clientWidth', { value: logWidthFor(410), configurable: true });
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const borderEl = (id: number): HTMLElement => ui.chatHandle.elements.get(id) as HTMLElement;
  const mouse = (target: EventTarget, type: string, x: number, y: number): void => {
    target.dispatchEvent(new domWindow.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  };
  const dragFrom = (el: HTMLElement, dx: number, dy: number): void => {
    mouse(el, 'mousedown', 100, 100);
    mouse(domWindow.document, 'mousemove', 100 + dx, 100 + dy);
    mouse(domWindow.document, 'mouseup', 100 + dx, 100 + dy);
  };
  const widths = () => [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')].map((r) => r.dataset.acWrapWidth);

  it('lines appended to the default 410-wide window wrap at its log width', () => {
    ui.addSystemMessage(WELCOME, '#80ff7f', 0);
    ui.addSystemMessage('You have entered Holtburg.', '#ffffff', 0);
    // 390 client - 4 padding (p35/p36 = 2, CORE.17.s.a) = 386; the welcome is 4 rows (trailing "\n" trimmed)
    expect(widths()).toEqual(Array(WELCOME.split('\n').length).fill('386'));
  });

  it('pulling the bottom-right grip 0x100006a1 wider re-wraps every existing line at the new log width', () => {
    dragFrom(borderEl(0x100006a1), 160, 40);
    expect((domWindow.document.getElementById('hud-chat') as HTMLElement).style.width).toBe('570px');
    expect(widths()).toEqual(Array(WELCOME.split('\n').length).fill('546'));
  });

  it('a height-only grip drag (bottom bar 0x100006a0) changes nothing in the log text', () => {
    const before = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    dragFrom(borderEl(0x100006a0), 0, 30);
    const after = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    after.forEach((r, i) => expect(r).toBe(before[i]));
  });

  it('the maximize box keeps the width, so it re-lays out nothing; a narrowing left-grip drag re-wraps again', () => {
    const before = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    borderEl(MAIN_CHAT_WINDOW.maximizeButtonId).click();
    expect(ui.isMainChatMaximized()).toBe(true);
    let after = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    after.forEach((r, i) => expect(r).toBe(before[i]));
    borderEl(MAIN_CHAT_WINDOW.maximizeButtonId).click();

    dragFrom(borderEl(0x1000069e), 200, 0);               // 570 → 370 wide
    expect((domWindow.document.getElementById('hud-chat') as HTMLElement).style.width).toBe('370px');
    after = [...chat.querySelectorAll<HTMLElement>('[data-ac-wrap-text]')];
    after.forEach((r, i) => expect(r).not.toBe(before[i]));
    expect(widths()).toEqual(Array(WELCOME.split('\n').length).fill('346'));
  });
});
