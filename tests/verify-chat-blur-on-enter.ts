/**
 * FAITHFUL.265 — Chat input blurs after Enter/Send so movement keys re-enable.
 *
 * Pre-fix the chat-input Enter handler cleared the input but didn't blur it.
 * Focus stayed, so the document hotkey listener (main.ts — it returns while
 * uiManager.inputFocused is set or a text field holds focus, isKeyboardField)
 * kept ignoring keys, and the player was stranded without WASD until Escape.
 *
 * BEHAVIORAL (was a source-text pin): the real GameUI HUD in happy-dom with a
 * stub layout renderer, the DAT-hosted chat input driven by real keydowns.
 * The Send button's blur is covered by verify-send-button-stay-in-chat-mode.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { isKeyboardField } from '../packages/renderer/src/input/BrowserDefaults.js';

async function mountChatHud(onChatSend: (m: string) => void): Promise<GameUIFixture> {
  const H = await mountGameUI({ callbacks: { onChatSend } as never });
  H.ui.getTexURL = () => null;
  const makeHandle = (_layoutId: number, parent: HTMLElement) => {
    const root = H.win.document.createElement('div') as HTMLElement;
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const getOrCreate = (id: number): HTMLElement => {
      let el = elements.get(id);
      if (!el) { el = H.win.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
      return el;
    };
    return {
      root, elements: { get: (id: number) => getOrCreate(id), set: () => {} }, descs: new Map(),
      setText: () => {}, setFill: () => {}, setPalette: () => {}, setVisible: () => {}, setState: () => {},
      setInteractive: () => {}, onClick: () => {}, setTexture: () => {},
      setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
      close: () => root.remove(), destroy: () => root.remove(),
    };
  };
  H.ui.layoutRenderer = {
    render: (id: number, parent: HTMLElement) => makeHandle(id, parent),
    renderPanel: (id: number, parent: HTMLElement) => makeHandle(id, parent),
    getTextureDataURLWithAlpha: () => null,
  };
  H.ui.renderHUD();
  return H;
}

describe('FAITHFUL.265 — chat input blur after Enter', () => {
  let H: GameUIFixture;
  const sent: string[] = [];
  beforeAll(async () => { H = await mountChatHud((m) => { sent.push(m); }); H.ui.optionsSettings.stayInChatMode = false; });
  afterAll(() => H?.teardown());

  const chatInput = (): HTMLInputElement => H.win.document.getElementById('chat-input') as HTMLInputElement;
  const enter = (input: HTMLElement): KeyboardEvent => {
    const ev = new H.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }) as KeyboardEvent;
    input.dispatchEvent(ev);
    return ev;
  };

  it('Enter with a message sends it, clears and blurs the input, and the hotkeys take keys again', () => {
    const input = chatInput();
    input.focus();
    input.value = 'hello';
    expect(isKeyboardField(H.win.document.activeElement as Element)).toBe(true);
    enter(input);
    expect(sent).toContain('hello');
    expect(input.value).toBe('');
    expect(H.win.document.activeElement).not.toBe(input);
    expect(H.ui.ui.inputFocused).toBe(false);
    expect(isKeyboardField(H.win.document.activeElement as Element)).toBe(false);
  });

  it("the send's Enter stops at the input (the document's Enter = Begin Chat would refocus it)", () => {
    const input = chatInput();
    let reachedDocument = false;
    const spy = (): void => { reachedDocument = true; };
    H.win.document.addEventListener('keydown', spy);
    input.focus();
    input.value = 'again';
    const ev = enter(input);
    H.win.document.removeEventListener('keydown', spy);
    expect(ev.defaultPrevented).toBe(true);
    expect(reachedDocument).toBe(false);
  });

  it('an empty Enter sends nothing', () => {
    const input = chatInput();
    const before = sent.length;
    input.focus();
    input.value = '   ';
    enter(input);
    expect(sent.length).toBe(before);
  });
});
