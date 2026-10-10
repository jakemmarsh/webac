/**
 * CORE.17.k — the spew box (gmSpewBoxUI): retail's transient notice strip
 * over the 3D view, and the reason "In Portal Space - Please Wait..." is
 * not a chat line.
 *
 * Decompiled EoL client (reference/client-eol/decomp/acclient-decompiled.c):
 *  - ECM_UI::SendNotice_DisplayStringInfo(0x1a, ...) (96 call sites incl.
 *    BeginTeleportAnimation @ 207505) → RecvNotice_DisplayStringInfo
 *    @ 0056e890 → ClientSystem::AddTextToScroll @ 00563c50 (type 0x1a: no
 *    timestamp, no log file) → SendNotice_DisplayFinalStringInfo(0x1a).
 *  - ChatInterface::ChatInterface @ 004f4550: filter = ~0 & 0xfbffffff — bit
 *    0x1a cleared in EVERY chat window; RecvNotice_DisplayFinalStringInfo
 *    @ 004f4640 shows untargeted text only when TypeIsActive @ 004f2f10.
 *  - gmSpewBoxUI::RecvNotice_DisplayFinalStringInfo @ 004d60a0 accepts
 *    exactly type 0x1a; Update @ 004d5df0 right-trims, replaces an identical
 *    top item, inserts at index 0, drops the tail past m_maxConcurrentItems
 *    (list property 0x10000028); ListenToElementMessage @ 004d57c0 deletes
 *    an item on element message 0x10000003.
 *
 * DAT (client_local_English.dat): layout 0x21000011 — box 0x10000048 type
 * 0x10000016 450x72 L3/T1/R3/B2; list 0x10000049 prop 0x10000028 = 4; item
 * 0x1000004a 450x18, props 0x14/0x15 = 1 (centred), state 0x10000002 colour
 * 0x1b = 0xFFFF0000, media Pause 5 s then Message 0x10000003. Host: layout
 * 0x2100000f pane 0x10000046 (0,20) 450x72 L3/T1/R3/B2.
 *
 * Constants from the binary and the DAT are asserted against the shipped
 * module; the DAT-gated suite re-derives them from the real LayoutDesc.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDomWindow, installDomGlobals } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SpewBoxModel, spewBoxLeft, normalizeSpewText, argbToCssHex,
  SPEW_BOX_LAYOUT, SPEW_BOX_ELEMENT, SPEW_BOX_ELEMENT_TYPE, SPEW_BOX_LIST, SPEW_ITEM_TEMPLATE,
  SPEW_HOST_LAYOUT, SPEW_HOST_PANE, SPEW_BOX_WIDTH, SPEW_BOX_HEIGHT, SPEW_BOX_TOP, SPEW_ITEM_HEIGHT,
  SPEW_MAX_ITEMS, SPEW_ITEM_LIFETIME_MS, SPEW_TEXT_COLOR, SPEW_TEXT_COLOR_ARGB, ERROR_TEXT_TYPE,
  SPEW_TEXT_COLOR_EOR_ARGB, ERROR_TEXT_CHAT_COLOR,
  SPEW_ITEM_EXPIRE_MESSAGE, SPEW_TEXT_FONT_DID,
} from '../packages/renderer/src/ui/SpewBoxModel.js';
import {
  MAIN_CHAT_DEFAULT_FILTER, CHAT_FILTER_CHANNELS, computeChatWindowFilter, floatyTypeIsActive,
} from '../packages/renderer/src/ui/FloatyChatModel.js';

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');
const LOCAL_DAT = resolve(REPO, 'dat/client_local_English.dat');
const HAS_DAT = existsSync(PORTAL_DAT) && existsSync(LOCAL_DAT);

/* ── Pure model ───────────────────────────────────────────────────────── */

describe('CORE.17.k — SpewBoxModel (gmSpewBoxUI::Update semantics)', () => {
  it('inserts the newest notice at the top', () => {
    const m = new SpewBoxModel();
    m.push('first', 1000);
    m.push('second', 1500);
    expect(m.items.map((i) => i.text)).toEqual(['second', 'first']);
  });

  it('an identical top item is replaced, not stacked (the "duplicated portal-space line")', () => {
    const m = new SpewBoxModel();
    m.push('In Portal Space - Please Wait...', 1000);
    const r = m.push('In Portal Space - Please Wait...', 2000);
    expect(m.items.length).toBe(1);
    expect(r.removed.length).toBe(1);
    expect(m.items[0].expiresAt).toBe(2000 + SPEW_ITEM_LIFETIME_MS);
  });

  it('only the TOP item is compared — the same text below a different one stacks', () => {
    const m = new SpewBoxModel();
    m.push('a', 0); m.push('b', 0); m.push('a', 0);
    expect(m.items.map((i) => i.text)).toEqual(['a', 'b', 'a']);
  });

  it('caps the list at m_maxConcurrentItems = 4 by dropping the oldest', () => {
    const m = new SpewBoxModel();
    for (const t of ['1', '2', '3', '4']) m.push(t, 0);
    const r = m.push('5', 0);
    expect(m.items.map((i) => i.text)).toEqual(['5', '4', '3', '2']);
    expect(r.removed.map((i) => i.text)).toEqual(['1']);
  });

  it('each item lives exactly the template timer (5 s) from its insertion', () => {
    const m = new SpewBoxModel();
    m.push('a', 1000);
    m.push('b', 3000);
    expect(m.expire(5999)).toEqual([]);
    expect(m.expire(6000).map((i) => i.text)).toEqual(['a']);
    expect(m.nextExpiry()).toBe(8000);
    expect(m.expire(8000).map((i) => i.text)).toEqual(['b']);
    expect(m.nextExpiry()).toBeNull();
  });

  it('right-trims the notice like PStringBase::trim(false, true)', () => {
    expect(normalizeSpewText('hello   \n')).toBe('hello');
    expect(normalizeSpewText('  keep leading')).toBe('  keep leading');
    const m = new SpewBoxModel();
    m.push('same ', 0); m.push('same', 0);
    expect(m.items.length).toBe(1);
  });

  it('centres the 450px box like a leftEdge=3 child (floor(W/2) - floor(w/2))', () => {
    expect(spewBoxLeft(800)).toBe(175);
    expect(spewBoxLeft(1024)).toBe(287);
    expect(spewBoxLeft(1568)).toBe(559);
  });

  it('DAT colour property 0x1b is ARGB 0xFFFF0000 red, but the EoR exe draws the rows yellow', () => {
    // BUG.spew-text-color-yellow-in-retail: Wine A/B on the same DATs — the
    // ac1_sep13 build draws ff0000 (and follows a patched p27), EoR 6096
    // draws ffff00 regardless of p27. Chat copies of the line stay red.
    expect(SPEW_TEXT_COLOR_ARGB).toBe(0xffff0000);
    expect(SPEW_TEXT_COLOR_EOR_ARGB).toBe(0xffffff00);
    expect(SPEW_TEXT_COLOR).toBe('#ffff00');
    expect(ERROR_TEXT_CHAT_COLOR).toBe('#ff0000');
    expect(argbToCssHex(0xff123456)).toBe('#123456');
  });

  it('shipped geometry/ids match the DAT pins in the module header', () => {
    expect([SPEW_BOX_WIDTH, SPEW_BOX_HEIGHT, SPEW_BOX_TOP, SPEW_ITEM_HEIGHT]).toEqual([450, 72, 20, 18]);
    expect(SPEW_MAX_ITEMS).toBe(4);
    expect(SPEW_ITEM_LIFETIME_MS).toBe(5000);
    expect(ERROR_TEXT_TYPE).toBe(0x1a);
    expect(SPEW_ITEM_EXPIRE_MESSAGE).toBe(0x10000003);
  });
});

/* ── Chat filter: type 0x1a is the one bit every ChatInterface clears ─── */

describe('CORE.17.k — text type 0x1a is off in every chat window by default (ChatInterface ctor &= 0xfbffffff)', () => {
  it('0xfbffffff clears exactly bit 0x1a', () => {
    expect(MAIN_CHAT_DEFAULT_FILTER >>> 0).toBe((0xffffffff & ~(1 << ERROR_TEXT_TYPE)) >>> 0);
    expect(floatyTypeIsActive(MAIN_CHAT_DEFAULT_FILTER, ERROR_TEXT_TYPE)).toBe(false);
    expect(floatyTypeIsActive(MAIN_CHAT_DEFAULT_FILTER, 0x19)).toBe(true);
    expect(floatyTypeIsActive(MAIN_CHAT_DEFAULT_FILTER, 0x1b)).toBe(true);
  });

  it('the Chat Options "Errors" checkbox is that same bit — ticking it lets 0x1a into a window', () => {
    const errors = CHAT_FILTER_CHANNELS.find((c) => c.suffix === 'Errors')!;
    expect(errors.mask).toBe(1n << BigInt(ERROR_TEXT_TYPE));
    const off = computeChatWindowFilter(() => undefined, 'main');
    expect(floatyTypeIsActive(off, ERROR_TEXT_TYPE)).toBe(false);
    const on = computeChatWindowFilter((k) => (k === 'chatMainWindowErrors' ? true : undefined), 'main');
    expect(floatyTypeIsActive(on, ERROR_TEXT_TYPE)).toBe(true);
    for (const w of [1, 2, 3, 4] as const) {
      expect(floatyTypeIsActive(computeChatWindowFilter(() => undefined, w), ERROR_TEXT_TYPE)).toBe(false);
    }
  });
});

/* ── Real GameUI in happy-dom ──────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.17.k — GameUI spew box (happy-dom, real renderHUD)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  /** Permissive layout stub (as tests/verify-multiline-system-chat.ts) so renderHUD builds #chat-messages. */
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

  function makeUI() {
    // One UI per document: GameUI resolves #chat-messages via document.getElementById.
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    stubLayoutRenderer(ui);
    ui.showGame();
    const box = () => container.querySelector('#hud-spew-box') as HTMLElement;
    const rows = () => [...container.querySelectorAll('#hud-spew-box .spew-item')] as HTMLElement[];
    const chat = () => container.querySelector('#chat-messages') as HTMLElement;
    return { ui, container, box, rows, chat };
  }

  it('renderHUD mounts #hud-spew-box at (centred, 20) 450x72 — layout 0x2100000f pane 0x10000046', () => {
    const { ui, box } = makeUI();
    expect(box()).toBeTruthy();
    expect(box().style.top).toBe('20px');
    expect(box().style.width).toBe('450px');
    expect(box().style.height).toBe('72px');
    expect(box().style.left).toBe(`${spewBoxLeft(ui.hudLogicalWidth())}px`);
    expect(box().getAttribute('data-element-id')).toBe('0x10000048');
    expect(box().style.pointerEvents).toBe('none');
  });

  it('displayErrorText shows a centred yellow 450x18 row in the box and nothing in the chat log', () => {
    const { ui, rows, chat } = makeUI();
    ui.displayErrorText('You must wait to use this item.');
    expect(rows().length).toBe(1);
    const row = rows()[0];
    expect(row.style.width).toBe('450px');
    expect(row.style.minHeight).toBe('18px');
    expect(row.style.justifyContent).toBe('center');
    expect(row.style.alignItems).toBe('center');
    expect(row.textContent).toBe('You must wait to use this item.');
    const text = row.firstElementChild as HTMLElement;
    expect(text.style.color).toMatch(/^(#ffff00|rgb\(255,\s*255,\s*0\))$/);
    expect(chat()).toBeTruthy();
    expect(chat().textContent ?? '').not.toContain('You must wait');
  });

  it('the row text is drawn by the 0x40000001 font (the template base 0x2100003f:0x10000377 p26), not the UI font', () => {
    const { ui, rows } = makeUI();
    const requested: number[] = [];
    const drawn: string[] = [];
    const fake = {
      isReady: true,
      outlinePadding: { x: 1, y: 1 },
      renderTextToCanvas: (text: string) => {
        drawn.push(text);
        const c = domWindow.document.createElement('canvas') as HTMLCanvasElement;
        c.width = 186; c.height = 20;
        c.dataset.fakeFont = 'spew';
        return c;
      },
      // Spew rows wrap at the box width (gmSpewBoxUI::Update), so the wrapped draw is used.
      renderWrappedTextToCanvas: (text: string) => {
        drawn.push(text);
        const c = domWindow.document.createElement('canvas') as HTMLCanvasElement;
        c.width = 186; c.height = 20;
        c.dataset.fakeFont = 'spew';
        return c;
      },
    };
    ui.loadFontRenderer = (did: number) => { requested.push(did); return did === SPEW_TEXT_FONT_DID ? fake : null; };
    ui.displayErrorText('In Portal Space - Please Wait...');
    expect(SPEW_TEXT_FONT_DID).toBe(0x40000001);
    expect(requested).toContain(0x40000001);
    expect(drawn).toEqual(['In Portal Space - Please Wait...']);
    const text = rows()[0].firstElementChild as HTMLElement;
    expect(text.dataset.fakeFont).toBe('spew');
    expect(text.dataset.acOutline).toBe('#000000');
    // The halo padding is pulled back so the glyphs keep the centred position.
    expect(text.style.marginLeft).toBe('-1px');
  });

  it('a long notice wraps at the box width instead of clipping (gmSpewBoxUI::Update resizes to the wrapped height)', () => {
    const { ui, rows } = makeUI();
    const long = 'You must be at least level 10 and have played for 2 hours before you can talk on the General chat channel. Keep playing!';
    ui.displayErrorText(long);
    const text = rows()[0].firstElementChild as HTMLElement;
    expect(text.dataset.acWrapWidth).toBe('450');
    expect(text.dataset.acWrapJustify).toBe('1');
    expect(text.dataset.acRunText).toBe(long);
    expect(rows()[0].style.whiteSpace).not.toBe('nowrap');
  });

  it('newest on top, identical top replaced, capped at 4', () => {
    const { ui, rows } = makeUI();
    ui.displayErrorText('a'); ui.displayErrorText('a'); ui.displayErrorText('b');
    ui.displayErrorText('c'); ui.displayErrorText('d'); ui.displayErrorText('e');
    expect(rows().map((r) => r.textContent)).toEqual(['e', 'd', 'c', 'b']);
  });

  it('a notice raised before the HUD exists is shown once renderHUD runs (first world entry)', () => {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    stubLayoutRenderer(ui);
    ui.displayErrorText('In Portal Space - Please Wait...');
    expect(container.querySelector('#hud-spew-box')).toBeNull();
    ui.showGame();
    const rows = [...container.querySelectorAll('#hud-spew-box .spew-item')] as HTMLElement[];
    expect(rows.map((r) => r.textContent)).toEqual(['In Portal Space - Please Wait...']);
  });

  it('items expire after the 5 s timer (element message 0x10000003 → DeleteItem)', async () => {
    const { ui, rows } = makeUI();
    // Drive the model clock directly so the test does not wait 5 s.
    ui.displayErrorText('gone soon');
    expect(rows().length).toBe(1);
    ui.spewBox.expire(Date.now() + SPEW_ITEM_LIFETIME_MS + 1);
    ui.refreshSpewBox();
    expect(rows().length).toBe(0);
  });

  it('with Chat Options > Errors ticked the notice also lands in the main chat, WITHOUT a timestamp', () => {
    const { ui, chat } = makeUI();
    ui.optionsSettings.displayTimestamps = true;
    ui.optionsSettings.chatMainWindowErrors = true;
    ui.addSystemMessage('ordinary line', '#ffffff');
    ui.displayErrorText('error line');
    const lines = [...chat().children] as HTMLElement[];
    const ordinary = lines.find((l) => l.textContent?.includes('ordinary line'))!;
    const error = lines.find((l) => l.textContent?.includes('error line'))!;
    expect(ordinary.textContent).toMatch(/^\[\d\d:\d\d:\d\d\] /);
    expect(error.textContent).toBe('error line');
    // The chat copy stays red (retail chat colour) while the strip row is yellow.
    const redInk = [error, ...error.querySelectorAll<HTMLElement>('*')].some((el) =>
      /^(#ff0000|rgb\(255,\s*0,\s*0\))$/.test(el.style.color));
    expect(redInk).toBe(true);
  });
});

/* ── DAT ground truth (skipped in CI — no dat/) ───────────────────────── */

describe.skipIf(!HAS_DAT)('CORE.17.k — DAT ground truth for layouts 0x21000011 / 0x2100000f', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spew: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let host: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MediaTypeEnum: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let baseText: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fontFor: (did: number) => any;

  beforeAll(async () => {
    const dp = await import('../packages/dat-parser/src/index.js');
    const { ACFontRenderer } = await import('../packages/renderer/src/ui/ACFontRenderer.js');
    const { ACFont } = await import('../packages/dat-parser/src/file-types/ACFont.js');
    MediaTypeEnum = dp.MediaType;
    const open = (p: string) => {
      const buf = readFileSync(p);
      return new dp.DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    };
    const portal = open(PORTAL_DAT);
    const local = open(LOCAL_DAT);
    dp.setMasterPropertyTypes(dp.parseMasterProperty(new dp.DatReader(portal.getFileData(0x39000001)!)));
    spew = dp.parseLayoutDesc(new dp.DatReader(local.getFileData(SPEW_BOX_LAYOUT)!));
    host = dp.parseLayoutDesc(new dp.DatReader(local.getFileData(SPEW_HOST_LAYOUT)!));
    baseText = dp.parseLayoutDesc(new dp.DatReader(local.getFileData(0x2100003f)!));
    fontFor = (did: number) => new ACFontRenderer(ACFont.read(new dp.DatReader(portal.getFileData(did)!)));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function find(layout: any, id: number): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (m: Map<number, any>): any => {
      for (const e of m.values()) {
        if (e.elementId === id) return e;
        const c = e.children && walk(e.children);
        if (c) return c;
      }
      return null;
    };
    return walk(layout.elements);
  }

  it('box 0x10000048 is the gmSpewBoxUI class (0x10000016), 450x72, edges L3/T1/R3/B2', () => {
    const box = find(spew, SPEW_BOX_ELEMENT);
    expect(box.type).toBe(SPEW_BOX_ELEMENT_TYPE);
    expect([box.width, box.height]).toEqual([SPEW_BOX_WIDTH, SPEW_BOX_HEIGHT]);
    expect([box.leftEdge, box.topEdge, box.rightEdge, box.bottomEdge]).toEqual([3, 1, 3, 2]);
  });

  it('list 0x10000049 is a ListBox (type 5) with property 0x10000028 = 4 concurrent items', () => {
    const list = find(spew, SPEW_BOX_LIST);
    expect(list.type).toBe(5);
    expect(list.properties.get(0x10000028)?.valueInt).toBe(SPEW_MAX_ITEMS);
  });

  it('item template 0x1000004a: 450x18, centred (props 0x14/0x15 = 1), red, 5 s Pause then Message 0x10000003', () => {
    const item = find(spew, SPEW_ITEM_TEMPLATE);
    expect([item.width, item.height]).toEqual([SPEW_BOX_WIDTH, SPEW_ITEM_HEIGHT]);
    expect(item.properties.get(0x14)?.valueEnum).toBe(1);
    expect(item.properties.get(0x15)?.valueEnum).toBe(1);
    const st = item.states.get(item.defaultState);
    expect(item.defaultState).toBe(0x10000002);
    const colour = st.properties.get(0x1b);
    expect(colour.valueArray[0].valueColor >>> 0).toBe(SPEW_TEXT_COLOR_ARGB);
    expect(st.media.map((m: { type: number }) => m.type)).toEqual([MediaTypeEnum.Pause, MediaTypeEnum.Message]);
    expect(st.media[0].minDuration).toBe(SPEW_ITEM_LIFETIME_MS / 1000);
    expect(st.media[0].maxDuration).toBe(SPEW_ITEM_LIFETIME_MS / 1000);
    expect(st.media[1].messageId).toBe(SPEW_ITEM_EXPIRE_MESSAGE);
  });

  it('item template 0x1000004a inherits font 0x40000001 (Palatino_Linotype_18) from base 0x2100003f:0x10000377 p26', () => {
    const item = find(spew, SPEW_ITEM_TEMPLATE);
    expect(item.baseLayout).toBe(0x2100003f);
    expect(item.baseElement).toBe(0x10000377);
    // No font of its own, in the desc or the default state.
    expect(item.properties.get(0x1a)).toBeUndefined();
    expect(item.states.get(item.defaultState).properties.get(0x1a)).toBeUndefined();
    const base = find(baseText, 0x10000377);
    expect(base.properties.get(0x1a).valueArray[0].valueDataFile).toBe(SPEW_TEXT_FONT_DID);
  });

  it('0x40000001 reproduces the EoR frames: "Use comma after the name for targeted chat." spans 270 px, "In" 12 px (0x40000000 gave 222 / 9)', () => {
    const w = (did: number, s: string) => fontFor(did).measureText(s);
    // verification/bug-spew-under-vitals/retail-two-lines.png: x 661..931.
    expect(w(SPEW_TEXT_FONT_DID, 'Use comma after the name for targeted chat.')).toBe(270);
    // retail-portal-2.png: "In" at x 704..716, wider than the 160 px vitals plate.
    expect(w(SPEW_TEXT_FONT_DID, 'In')).toBe(12);
    expect(w(SPEW_TEXT_FONT_DID, 'In Portal Space - Please Wait...')).toBe(184);
    expect(w(0x40000000, 'Use comma after the name for targeted chat.')).toBe(222);
  });

  it('the 3D-view layout hosts the box in pane 0x10000046 at (0,20) 450x72 L3/T1/R3/B2', () => {
    const pane = find(host, SPEW_HOST_PANE);
    expect([pane.x, pane.y, pane.width, pane.height]).toEqual([0, SPEW_BOX_TOP, SPEW_BOX_WIDTH, SPEW_BOX_HEIGHT]);
    expect([pane.leftEdge, pane.topEdge, pane.rightEdge, pane.bottomEdge]).toEqual([3, 1, 3, 2]);
  });
});
