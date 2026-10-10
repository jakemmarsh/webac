/**
 * FAITHFUL.486 — StayInChatModeAfterSendingMessage CharacterOption
 *  (0x0B) wired client-side.
 *
 *  Per ACE `CharacterOption.cs:48-49` StayInChatModeAfterSendingMessage
 *  = 0x0B (CharacterOptions1.StayInChatMode). Retail's "Stay in chat
 *  mode after sending a message" toggle controlled whether the chat
 *  input retained focus after pressing Enter. Default OFF (FAITHFUL.265
 *  pre-existing behavior). ACE persists the bit; the focus behavior
 *  is purely client-side.
 *
 *  Pre-fix the chat input unconditionally blurred after Enter — no
 *  way to keep it focused without manually re-clicking the input.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, stubLayoutRender, type GameUIFixture } from './_harness/gameui.js';

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
/** Render the real options panel page `tab` through a stub layout renderer
 *  (every element id resolves) and return option key → row text. */
function renderOptionsPage(H: GameUIFixture, tab: string): Map<string, string> {
  H.ui.getTexURL = () => null;
  H.ui.layoutRenderer = {
    renderPanel: (_id: number, parent: HTMLElement) => {
      const root = H.win.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      return {
        root,
        elements: {
          get: (id: number) => {
            let el = elements.get(id);
            if (!el) { el = H.win.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
            return el;
          },
          set: () => {},
        },
        setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
      };
    },
    render: stubLayoutRender(H.win.document),
  };
  H.ui.optionsTab = tab;
  H.ui.renderOptionsPanel();
  const out = new Map<string, string>();
  for (const row of H.ui.optionsPanel.querySelectorAll('[data-option-key]') as NodeListOf<HTMLElement>) {
    out.set(row.dataset.optionKey!, (row.textContent ?? '').trim());
  }
  return out;
}

describe('FAITHFUL.486 — stayInChatMode (behavioural)', () => {
  let H: GameUIFixture;
  let sent: string[];
  beforeAll(async () => { sent = []; H = await mountChatHud({ onChatSend: (m: string) => { sent.push(m); } }); });
  afterAll(() => H.teardown());

  it('OPTIONS_DEFAULTS.stayInChatMode is false (retail default)', () => {
    expect(H.mod.GameUI.OPTIONS_DEFAULTS.stayInChatMode).toBe(false);
  });

  it('OPTIONS_TO_CHARACTER_OPTION maps stayInChatMode to CharacterOption 0x0B', () => {
    expect((H.mod.GameUI as unknown as { OPTIONS_TO_CHARACTER_OPTION: Record<string, number> })
      .OPTIONS_TO_CHARACTER_OPTION.stayInChatMode).toBe(0x0B);
  });

  it('Enter blurs the chat input by default and keeps focus when stayInChatMode is on', () => {
    const input = chatInputOf(H);
    H.ui.optionsSettings.stayInChatMode = false;
    input.focus(); input.value = 'one';
    keydown(H, input, 'Enter');
    expect(sent).toContain('one');
    expect(H.win.document.activeElement).not.toBe(input);
    H.ui.optionsSettings.stayInChatMode = true;
    input.focus(); input.value = 'two';
    keydown(H, input, 'Enter');
    expect(sent).toContain('two');
    expect(H.win.document.activeElement).toBe(input);
    H.ui.optionsSettings.stayInChatMode = false;
  });

  it("the options panel renders retail's 'Stay in Chat Mode After Sending a Message' row bound to stayInChatMode (Character tab)", () => {
    const rows = renderOptionsPage(H, 'character');
    expect(rows.get('stayInChatMode')).toBe('Stay in Chat Mode After Sending a Message');
  });
});
