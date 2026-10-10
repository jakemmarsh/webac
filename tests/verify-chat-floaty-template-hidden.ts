/**
 * CORE.3 → CORE.17.g — the main chat never draws the FloatyChatWindow
 * template, and (since CORE.17.g) is the EoL main chat window itself.
 *
 * History: CORE.3 ("[chat] Chat area has weird overlapping boxes", Jake's
 * live play-test 2026-08-23) found the FloatyChatWindow template that
 * classic_chat 0x21000006 carries as top-level elements (frame 0x1000001c,
 * title bar 0x1000001e, close box 0x10000526) stacked over the chat log.
 * The fix then hid those ids inside the 0x21000006 render.
 *
 * CORE.17.g removed the root cause: the EoL root HUD 0x21000005 authors the
 * main chat as 0x10000601 → layout 0x2100006f (410x100, gmFloatyMainChatUI)
 * and never references 0x21000006 at all — that layout is only the floaty
 * template source (gmFloatyChatUI instances, ID_ChatOption_FloatyChatWindow
 * 1..4). So the main chat must (a) render layout 0x2100006f, not 0x21000006,
 * (b) be sized to the DAT window (410x100, no dead strip), and (c) contain
 * none of the template ids.
 *
 * Behavioral: drives the real GameUI.renderHUD() with a layoutRenderer
 * test-double that records which layout the chat container asked for and
 * materializes the 0x2100006f main-window ids.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { MAIN_CHAT_WINDOW } from '../packages/renderer/src/ui/FloatyChatModel.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// FloatyChatWindow template elements (top-level in classic_chat 0x21000006).
const FLOATY_TEMPLATE_IDS = [0x1000001c, 0x1000001e, 0x10000526];
// Main-window chrome of 0x2100006f that must be present and visible.
const MAIN_WINDOW_IDS = [0x10000600, 0x10000010, 0x10000011, 0x10000013, 0x10000014, 0x10000016, 0x10000019, 0x1000046f];

describe('CORE.3/CORE.17.g — main chat is the 0x2100006f window, never the floaty template', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const rendered: Array<{ layoutId: number; parentId: string }> = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);

    const makeHandle = (layoutId: number, parent: HTMLElement) => {
      rendered.push({ layoutId, parentId: parent.id });
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const ids = layoutId === MAIN_CHAT_WINDOW.layoutId
        ? MAIN_WINDOW_IDS
        : layoutId === 0x21000006 ? [...FLOATY_TEMPLATE_IDS, 0x1000000e] : [];
      for (const id of ids) {
        const el = domWindow.document.createElement('div');
        el.setAttribute('data-element-id', `0x${id.toString(16)}`);
        root.appendChild(el);
        elements.set(id, el);
      }
      return {
        root, elements, descs: new Map(),
        setText: () => {}, setInteractive: () => {},
        setVisible: (elementId: number, visible: boolean) => {
          const el = elements.get(elementId);
          if (el) el.style.display = visible ? '' : 'none';
        },
        setState: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
    ui.renderHUD();
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('renders the EoL main chat window layout 0x2100006f into #hud-chat', () => {
    const chatRenders = rendered.filter((r) => r.parentId === 'hud-chat');
    expect(chatRenders.map((r) => r.layoutId)).toEqual([0x2100006f]);
    expect(ui.chatHandle.root.parentElement.id).toBe('hud-chat');
  });

  it('never renders classic_chat 0x21000006 into the main chat container', () => {
    expect(rendered.some((r) => r.parentId === 'hud-chat' && r.layoutId === 0x21000006)).toBe(false);
  });

  it('the main chat handle carries no FloatyChatWindow template ids', () => {
    for (const id of FLOATY_TEMPLATE_IDS) {
      expect(ui.chatHandle.elements.get(id), `0x${id.toString(16)} must not exist in the main chat`).toBeUndefined();
    }
  });

  it('leaves the main-window chrome (log area, input row, buttons) visible', () => {
    for (const id of MAIN_WINDOW_IDS) {
      const el = ui.chatHandle.elements.get(id) as HTMLElement;
      expect(el, `0x${id.toString(16)} present`).toBeTruthy();
      expect(el.style.display, `0x${id.toString(16)} should stay visible`).not.toBe('none');
    }
  });

  it('sizes the chat container to the DAT window (410x100) — no dead strip, no 490px classic column', () => {
    const chatContainer = ui.chatHandle.root.parentElement as HTMLElement;
    expect(chatContainer.style.width).toBe('410px');
    expect(chatContainer.style.height).toBe('100px');
    expect(chatContainer.style.left).toBe('0px');
    expect(chatContainer.style.bottom).toBe('0px');
    expect(MAIN_CHAT_WINDOW.width).toBe(410);
    expect(MAIN_CHAT_WINDOW.height).toBe(100);
  });
});
