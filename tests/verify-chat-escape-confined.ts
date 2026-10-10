/**
 * FAITHFUL.360 — Escape from chat input is confined to dismissing
 *  the input only.
 *
 * Pre-fix the chat-input keydown handler treated Escape as just
 * `chatInput.blur()` with no `preventDefault` or `stopPropagation`.
 * The Escape keydown event continued bubbling to the document-level
 * keydown handler at `main.ts:9566` which runs:
 *   - `gameUI.closeAllPanels()`
 *   - clears `currentTargetGuid` + the selected-target binding
 *
 * Result: pressing Escape to abort a half-typed chat message ALSO
 * collapsed any open inventory / character / map panels AND dropped
 * the player's selected target. Highly disruptive for combat
 * scenarios where the player started typing a message mid-fight.
 *
 * Retail behavior: Escape from chat input only dismissed the input
 * (panels + target stay).
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

describe('Chat Escape stays confined to the input (FAITHFUL.360, behavioural)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountChatHud(); });
  afterAll(() => H.teardown());

  it('Escape in the chat input blurs it, prevents default, and never reaches the document handler (closeAllPanels)', () => {
    const input = chatInputOf(H);
    let docSaw = 0;
    const onDoc = (e: KeyboardEvent) => { if (e.key === 'Escape') docSaw++; };
    H.win.document.addEventListener('keydown', onDoc);
    input.focus();
    input.value = 'half-typed';
    expect(H.win.document.activeElement).toBe(input);
    const ev = keydown(H, input, 'Escape');
    H.win.document.removeEventListener('keydown', onDoc);
    expect(ev.defaultPrevented).toBe(true);
    expect(docSaw).toBe(0);
    expect(H.win.document.activeElement).not.toBe(input);
  });

  it('control: a key the input does not consume still bubbles to the document', () => {
    const input = chatInputOf(H);
    let docSaw = 0;
    const onDoc = () => { docSaw++; };
    H.win.document.addEventListener('keydown', onDoc);
    keydown(H, input, 'a');
    H.win.document.removeEventListener('keydown', onDoc);
    expect(docSaw).toBe(1);
  });
});
