/**
 * FAITHFUL.358 — Chat input suppresses browser autofill/spellcheck/
 *  autocapitalize/autocorrect.
 *
 * The retail AC client's chat input was a native Win32 Edit2 control
 * with NO browser-style assistance. Pre-fix our HTML `<input>` element
 * inherited the browser defaults:
 *   - autocomplete=on   → browser suggests the user's prior chat
 *     history as a popup, which intercepts ArrowUp/ArrowDown before
 *     the in-game history-cycler can fire (FAITHFUL.268)
 *   - spellcheck=true   → red squiggles on AC-specific terms (Olthoi,
 *     Pyreal, Aerlinthe, etc.)
 *   - autocapitalize=on (mobile default) → first letter of every
 *     sentence auto-capitalized, mangling lowercase /commands
 *   - autocorrect=on   (mobile/iOS) → Same — substitutes AC names
 *     with dictionary words
 *
 * Setting all four to off matches retail behavior.
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

describe('Chat input suppresses browser interference (FAITHFUL.358, behavioural)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountChatHud(); });
  afterAll(() => H.teardown());

  it('autocomplete is off', () => {
    expect(chatInputOf(H).autocomplete).toBe('off');
    expect(chatInputOf(H).getAttribute('autocomplete')).toBe('off');
  });

  it('spellcheck is false', () => {
    expect(chatInputOf(H).spellcheck).toBe(false);
  });

  it('autocapitalize is off', () => {
    expect((chatInputOf(H) as HTMLInputElement & { autocapitalize: string }).autocapitalize).toBe('off');
  });

  it('autocorrect="off" attribute (Safari/iOS; no DOM property)', () => {
    expect(chatInputOf(H).getAttribute('autocorrect')).toBe('off');
  });
});
