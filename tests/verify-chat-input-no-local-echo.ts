/**
 * FAITHFUL.352 — Chat input no longer emits a duplicate local "You: ${msg}"
 *  echo for every typed message.
 *
 * Pre-fix every Enter-press in the chat input called
 *   this.addChatMessage('You', msg)
 * BEFORE handing the message to the onChatSend callback. Result:
 *   - `/tell Bob hi` produced TWO chat lines:
 *       1. `You: /tell Bob hi`     (raw local echo)
 *       2. `You tell Bob, "hi"`    (proper retail format from the tell handler)
 *   - `/say hello` ALSO produced two lines:
 *       1. `You: hello`
 *       2. `Bob says, "hello"`     (from the HearSpeech server-echo)
 *   - `/me waves` similarly: `You: /me waves` then `Bob waves`
 *
 * Retail showed ONLY the properly-formatted line in each case.
 *
 * Fix: the chat input no longer self-echoes. Plain text relies on the
 * server's HearSpeech round-trip (ACE `Player.cs:796` broadcasts to all
 * nearby players INCLUDING the sender). Commands rely on their per-
 * handler emit (`/tell`, `/me`, `/squelch`, `/friends`, etc. all emit
 * their own retail-format feedback in main.ts).
 *
 * DEBT.test-harness-hygiene: behavioural — the real GameUI chat input is
 * driven with Enter keydowns in happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

/** Minimal LayoutRenderer stand-in so renderHUD builds the chat window (+ #chat-input). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubLayoutRenderer(ui: any, win: any): void {
  const makeHandle = (_layoutId: number, parent: HTMLElement) => {
    const root = win.document.createElement('div') as HTMLElement;
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const getOrCreate = (id: number): HTMLElement => {
      let el = elements.get(id);
      if (!el) { el = win.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
      return el;
    };
    return {
      root, elements: { get: (id: number) => getOrCreate(id), set: () => {} }, descs: new Map(),
      setText: () => {}, setFill: () => {}, setPalette: () => {}, setVisible: () => {}, setState: () => {},
      setInteractive: () => {},
      setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
      close: () => root.remove(), destroy: () => root.remove(),
    };
  };
  ui.getTexURL = () => null;
  ui.layoutRenderer = { render: makeHandle, renderPanel: makeHandle, getTextureDataURLWithAlpha: () => null };
}

describe('Chat input has no local-echo addChatMessage call (FAITHFUL.352, behavioural)', () => {
  let H: GameUIFixture;
  const sent: string[] = [];
  const echoed: Array<[string, string]> = [];

  beforeAll(async () => {
    H = await mountGameUI({ callbacks: { onChatSend: (msg: string) => { sent.push(msg); } } });
    stubLayoutRenderer(H.ui, H.win);
    H.ui.renderHUD();
    const real = H.ui.addChatMessage.bind(H.ui);
    H.ui.addChatMessage = (sender: string, text: string, ...rest: unknown[]) => {
      echoed.push([sender, text]);
      return real(sender, text, ...rest);
    };
  }, 60_000);
  afterAll(() => H.teardown());

  function input(): HTMLInputElement {
    const el = H.win.document.getElementById('chat-input') as HTMLInputElement;
    expect(el).toBeTruthy();
    return el;
  }
  function type(msg: string): void {
    const el = input();
    el.value = msg;
    el.dispatchEvent(new H.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }

  it("Enter does NOT add a local 'You: msg' chat line — for talk or for commands", () => {
    type('hello there');
    type('/tell Bob hi');
    type('/me waves');
    expect(echoed).toEqual([]);
    const log = H.win.document.getElementById('chat-messages')?.textContent ?? '';
    expect(log).not.toContain('You: hello there');
    expect(log).not.toContain('You: /tell Bob hi');
  });

  it('Enter still invokes onChatSend with the trimmed text, pushes history and clears the input', () => {
    sent.length = 0;
    type('  howdy  ');
    expect(sent).toEqual(['howdy']);
    expect(input().value).toBe('');
    // History recall (ArrowUp) returns the message that was just pushed.
    input().dispatchEvent(new H.win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    expect(input().value).toBe('howdy');
  });
});
