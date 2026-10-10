/**
 * FAITHFUL.368 — Chat history recall moves the caret to the end of the
 *  recalled message.
 *
 * Pre-fix pressing ArrowUp/ArrowDown to cycle through previous chat
 * messages set `chatInput.value` but left the cursor at position 0,
 * forcing the user to press End before they could edit the recalled
 * message in place. Retail moved the caret to the end automatically.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

/** Real GameUI HUD with a stub layout renderer (every element id resolves), so
 *  the DAT-hosted chat input (0x10000016) and its keydown handler are live. */
async function mountChatHud(callbacks: Record<string, (...a: never[]) => unknown> = {}): Promise<GameUIFixture> {
  const H = await mountGameUI({ callbacks: callbacks as never });
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

function chatInputOf(H: GameUIFixture): HTMLInputElement {
  const input = H.win.document.getElementById('chat-input') as HTMLInputElement | null;
  if (!input) throw new Error('chat-input not rendered');
  return input;
}

/** Dispatch a keydown on the chat input; returns the event for defaultPrevented checks. */
function keydown(H: GameUIFixture, input: HTMLElement, key: string): KeyboardEvent {
  const ev = new H.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }) as KeyboardEvent;
  input.dispatchEvent(ev);
  return ev;
}

describe('Chat history caret-to-end (FAITHFUL.368, behavioural)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountChatHud({ onChatSend: () => {} }); });
  afterAll(() => H.teardown());

  function send(input: HTMLInputElement, text: string): void {
    input.focus();
    input.value = text;
    keydown(H, input, 'Enter');
  }

  it('ArrowUp recalls the previous message with the caret at its end', () => {
    const input = chatInputOf(H);
    send(input, 'first message');
    send(input, 'second');
    input.focus();
    const calls: Array<[number, number]> = [];
    const orig = input.setSelectionRange.bind(input);
    input.setSelectionRange = ((a: number, b: number) => { calls.push([a, b]); orig(a, b); }) as typeof input.setSelectionRange;
    const ev = keydown(H, input, 'ArrowUp');
    expect(ev.defaultPrevented).toBe(true);
    expect(input.value).toBe('second');
    expect(calls).toEqual([['second'.length, 'second'.length]]);
    expect(input.selectionStart).toBe('second'.length);
    keydown(H, input, 'ArrowUp');
    expect(input.value).toBe('first message');
    expect(calls.at(-1)).toEqual(['first message'.length, 'first message'.length]);
    input.setSelectionRange = orig;
  });

  it('ArrowDown recall also puts the caret at the end; past the newest entry clears the input', () => {
    const input = chatInputOf(H);
    const calls: Array<[number, number]> = [];
    const orig = input.setSelectionRange.bind(input);
    input.setSelectionRange = ((a: number, b: number) => { calls.push([a, b]); orig(a, b); }) as typeof input.setSelectionRange;
    // index currently at 'first message' (from the previous test)
    keydown(H, input, 'ArrowDown');
    expect(input.value).toBe('second');
    expect(calls).toEqual([['second'.length, 'second'.length]]);
    keydown(H, input, 'ArrowDown');
    expect(input.value).toBe('');
    expect(calls.length).toBe(1); // no caret move when history is exhausted
    input.setSelectionRange = orig;
  });
});
