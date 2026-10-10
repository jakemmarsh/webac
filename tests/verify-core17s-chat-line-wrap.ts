/**
 * CORE.17.s — chat lines wrap inside the hosting log, as retail's
 * UIElement_Text does (the EoL client under Wine breaks ACE's login welcome
 * at "type" / "@acehelp" — docs/images/retail-client-wine-inworld-holtburg.png).
 * Pre-fix each line was one unwrapped AC-font canvas that the log clipped at
 * the scrollbar column ("... this server, type @ace").
 *
 * Drives the real GameUI in happy-dom (font renderer not ready → the span
 * fallback of renderACText, which carries the wrap width as max-width).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { loadDomWindow } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.17.s — chat lines wrap at the log width (happy-dom, real GameUI)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) g[key] = key === 'window' ? domWindow : domWindow[key];
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
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
    // happy-dom has no layout; give the log the width the DAT text element
    // 0x10000011 (458x74) gets in the docked window.
    Object.defineProperty(chat, 'clientWidth', { value: logClientWidth, configurable: true });
    return { ui, chat };
  }

  const WELCOME = "Welcome to Asheron's Call\n  powered by ACEmulator\n\nFor more information on commands supported by this server, type @acehelp\n";

  it('chatLogWrapWidth is the client width minus horizontal padding, undefined without layout', () => {
    const { chat } = makeUI(458);
    // #chat-messages carries the desc's p35/p36 = 2 as its side padding (CORE.17.s.a).
    expect(GameUICtor.chatLogWrapWidth(chat)).toBe(454);
    Object.defineProperty(chat, 'clientWidth', { value: 0, configurable: true });
    expect(GameUICtor.chatLogWrapWidth(chat)).toBeUndefined();
    expect(GameUICtor.chatLogWrapWidth(null)).toBeUndefined();
  });

  it('addSystemMessage wraps every text line of the welcome at the log width', () => {
    const { ui, chat } = makeUI(458);
    ui.addSystemMessage(WELCOME, '#80ff7f', 0);
    const line = chat.lastElementChild as HTMLElement;
    expect(line).toBeTruthy();
    const spans = [...line.querySelectorAll('span')] as HTMLElement[];
    // four text rows: \n-split, the trailing "\n" trimmed like
    // ClientSystem::AddTextToScroll @ 00563c50 (CORE.17.s.a)
    expect(spans.length).toBe(WELCOME.split('\n').length - 1);
    for (const s of spans) {
      expect(s.style.maxWidth).toBe('454px');
      expect(s.style.wordWrap).toBe('break-word');
    }
    expect(spans[3].textContent).toBe('For more information on commands supported by this server, type @acehelp');
  });

  it('a log without layout yet leaves the line unwrapped instead of wrapping at 0', () => {
    const { ui, chat } = makeUI(0);
    ui.addSystemMessage('Short line', '#ffffff', 0);
    const span = (chat.lastElementChild as HTMLElement).querySelector('span') as HTMLElement;
    expect(span.style.maxWidth).toBe('');
  });

  it('addChatMessage wraps the body but not the sender prefix', () => {
    const { ui, chat } = makeUI(458);
    ui.addChatMessage('Perf Tester', 'a fairly long line of speech that must wrap inside the main log', '#ffffff', 2);
    const spans = [...(chat.lastElementChild as HTMLElement).querySelectorAll('span')] as HTMLElement[];
    expect(spans.length).toBe(2);
    expect(spans[0].textContent).toBe('Perf Tester:');
    expect(spans[0].style.maxWidth).toBe('');
    expect(spans[1].style.maxWidth).toBe('454px');
  });
});
