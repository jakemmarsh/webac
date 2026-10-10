/**
 * FAITHFUL.356 — Chat Send-button click no longer self-echoes either.
 *
 * FAITHFUL.352 removed the duplicate `addChatMessage('You', msg)` echo
 * from the Enter-key handler, but the Send-button click path was an
 * exception that still emitted it. So players who clicked Send instead
 * of pressing Enter STILL saw the two-line duplicate:
 *   /tell Bob hi → `You: /tell Bob hi` + `You tell Bob, "hi"`
 *
 * This commit applies the same fix to the Send-button click handler so
 * both entry paths agree. Behavioural: the REAL Send-button handler GameUI
 * registers for 0x10000019 on the main chat layout is captured from a stub
 * LayoutRenderer and invoked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('Chat Send-button no local-echo (FAITHFUL.356, behavioural)', () => {
  let H: GameUIFixture;
  const sent: string[] = [];
  const echoed: Array<[string, string]> = [];
  let sendButtonClick: (() => void) | null = null;

  beforeAll(async () => {
    H = await mountGameUI({ callbacks: { onChatSend: (msg: string) => { sent.push(msg); } } });
    const win = H.win;
    H.ui.getTexURL = () => null;
    const makeHandle = (layoutId: number, parent: HTMLElement) => {
      const root = win.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const getOrCreate = (id: number): HTMLElement => {
        let el = elements.get(id);
        if (!el) {
          el = win.document.createElement('div') as HTMLElement;
          root.appendChild(el);
          elements.set(id, el);
        }
        return el;
      };
      return {
        root,
        elements: { get: (id: number) => getOrCreate(id), set: () => {} },
        descs: new Map(),
        setText: () => {}, setFill: () => {}, setPalette: () => {}, setVisible: () => {},
        setState: () => {},
        setInteractive: (id: number, cb?: () => void) => {
          if (layoutId === 0x2100006f && id === 0x10000019 && cb) sendButtonClick = cb;
        },
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
        close: () => root.remove(),
        destroy: () => root.remove(),
      };
    };
    H.ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
    H.ui.renderHUD();
    const realAdd = H.ui.addChatMessage.bind(H.ui);
    H.ui.addChatMessage = (sender: string, text: string, ...rest: unknown[]) => {
      echoed.push([sender, text]);
      return realAdd(sender, text, ...rest);
    };
  });
  afterAll(() => H.teardown());

  function clickSend(text: string): HTMLInputElement {
    expect(sendButtonClick, 'Send button 0x10000019 wired via setInteractive').toBeTypeOf('function');
    const input = H.win.document.getElementById('chat-input') as HTMLInputElement;
    input.value = text;
    sendButtonClick!();
    return input;
  }

  it("Send-button click does NOT echo addChatMessage('You', msg)", () => {
    clickSend('/tell Bob hi');
    clickSend('hello there');
    expect(echoed.filter(([sender]) => sender === 'You')).toEqual([]);
  });

  it('Send-button click still pushes history, invokes onChatSend and clears the input', () => {
    const input = clickSend('history me');
    expect(sent).toContain('history me');
    expect(input.value).toBe('');
    expect(H.ui.chatHistoryState.toArray()).toContain('history me');
  });
});
