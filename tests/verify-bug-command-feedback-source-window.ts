/**
 * BUG.main-chat-shows-error-lines-in-retail — chat-command feedback goes to
 * the window the command was typed in, whatever that window's filter.
 *
 * Retail ground truth (decompiled EoL client):
 * - The command-line handler @ 371399 stores the typing window's id in
 *   `ClientCommunicationSystem::m_idCurrentCommandSource` before dispatch
 *   (main chat = 8, floaty windows 2..5).
 * - Every `Do*` handler reports through `AddTextToScroll(text, type, true,
 *   m_idCurrentCommandSource)` — DoReply @ 363131 "You must specify the text
 *   you wish to say!" at type 0x1a among them.
 * - `ChatInterface::RecvNotice_DisplayFinalStringInfo` @ 004f4640: a line
 *   targeted at the window's own id displays there with NO TypeIsActive
 *   check; any other non-zero target is dropped; target 0 is filtered.
 * - So the 0x1a line lands in the main chat (red) AND the spew strip when
 *   typed in the main chat — the Wine frame
 *   verification/bug-spew-under-vitals/retail-reply-short.png — although the
 *   main window's filter (ctor `&= 0xfbffffff`, no DAT default for option
 *   0x1000007f, Perf Tester's gameplay_Options NULL) has Errors off.
 * - UI call sites (`SendNotice_DisplayStringInfo(0x1a, str)`) stay untargeted:
 *   spew strip only.
 *
 * Drives the real GameUI.renderHUD() with a layout-renderer double (as
 * verify-floaty-chat-windows.ts) and the real ClientNotices dispatcher.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals } from './_harness/dom.js';
import {
  FLOATY_CHAT_WINDOWS, FLOATY_LOG_TEXT_ID, FLOATY_ENTRY_ID, FLOATY_SEND_ID, MAIN_CHAT_WINDOW_ID,
} from '../packages/renderer/src/ui/FloatyChatModel.js';
import { CLIENT_NOTICES, raiseClientNotice } from '../packages/renderer/src/ui/ClientNotices.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = [
  'window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event',
  'MouseEvent', 'KeyboardEvent', 'MutationObserver',
] as const;

const SAY_NO_TEXT = 'You must specify the text you wish to say!';
/** DoConsent @ 368840's type-0 confirmation (chat/commands/DeathTravelHouseCommands.ts). */
const CONSENT_ON = 'You can now accept corpse looting permissions from other players.';

describe('BUG.main-chat-shows-error-lines-in-retail — command feedback targets the source window', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  /** The command system's print (CommandRun.reply → AddTextToScroll(…, m_idCurrentCommandSource)): 0x1a to the spew + window, other types as a chat line. */
  const reply = (text: string, chatType: number) => (chatType === 0x1a ? ui.displayErrorText(text, ui.commandSourceWindowId) : ui.addSystemMessage(text, undefined, chatType, ui.commandSourceWindowId));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handles: any[];
  /** What main.ts's command dispatch does for each typed line in this test. */
  let onSend: (msg: string) => void = () => {};

  const makeHandle = (layoutId: number, parent: HTMLElement, opts?: { subtreeElementId?: number }) => {
    const root = domWindow.document.createElement('div') as HTMLElement;
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const getOrCreate = (id: number): HTMLElement => {
      let el = elements.get(id);
      if (!el) {
        el = domWindow.document.createElement('div') as HTMLElement;
        root.appendChild(el);
        elements.set(id, el);
      }
      return el;
    };
    const handle = {
      root, layoutId, subtreeElementId: opts?.subtreeElementId,
      clickHandlers: new Map<number, () => void>(),
      elements: { get: (id: number) => getOrCreate(id), set: () => {} },
      setText: () => {},
      setInteractive(id: number, cb?: () => void) { if (cb) handle.clickHandlers.set(id, cb); },
      setVisible(id: number, visible: boolean) { getOrCreate(id).style.display = visible ? '' : 'none'; },
      setState: () => {}, setFill: () => {}, setPalette: () => {}, setTexture: () => {},
      setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
      close: () => { root.remove(); },
      destroy: () => { root.remove(); },
    };
    handles.push(handle);
    return handle;
  };

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    handles = [];
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container, { onChatSend: (msg: string) => onSend(msg) });
    ui.getTexURL = () => null;
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement, opts?: { subtreeElementId?: number }) =>
        makeHandle(layoutId, parent, opts),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
    ui.setChatHistoryScope('acct', 'CmdSourceChar');
    ui.renderHUD();
  });

  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) g[key] = saved[key];
  });

  const mainLog = (): HTMLElement => domWindow.document.getElementById('chat-messages')!;
  const spewRows = (): string[] =>
    [...domWindow.document.querySelectorAll('#hud-spew-box .spew-item')].map((r: HTMLElement) => r.textContent ?? '');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const floatyHandle = (index: number): any =>
    handles.filter((h) => h.subtreeElementId === FLOATY_CHAT_WINDOWS[index - 1].elementId).at(-1);
  const floatyLog = (index: number): HTMLElement => floatyHandle(index).elements.get(FLOATY_LOG_TEXT_ID) as HTMLElement;
  const count = (el: HTMLElement, text: string): number =>
    [...el.children].filter((c) => (c.textContent ?? '').includes(text)).length;

  const typeInMainChat = (msg: string): void => {
    const input = domWindow.document.getElementById('chat-input') as HTMLInputElement;
    input.value = msg;
    input.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  };
  const typeInFloaty = (index: number, msg: string): void => {
    const input = (floatyHandle(index).elements.get(FLOATY_ENTRY_ID) as HTMLElement).querySelector('input') as HTMLInputElement;
    input.value = msg;
    floatyHandle(index).clickHandlers.get(FLOATY_SEND_ID)();
  };

  it('Errors is off in the main window by default (the premise: filtered 0x1a stays out)', () => {
    expect(ui.optionsSettings.chatMainWindowErrors).toBe(false);
    ui.displayErrorText('You can\'t put that item there');
    expect(count(mainLog(), 'You can\'t put that item there')).toBe(0);
    expect(spewRows()).toContain('You can\'t put that item there');
  });

  it('"@reply" typed in the main chat: the 0x1a line shows in the main log (red, no stamp) AND the strip', () => {
    ui.optionsSettings.displayTimestamps = true;
    onSend = () => reply(SAY_NO_TEXT, 0x1a);
    typeInMainChat('@reply');
    expect(ui.commandSourceWindowId).toBe(MAIN_CHAT_WINDOW_ID);
    const lines = [...mainLog().children].filter((c) => (c.textContent ?? '').includes(SAY_NO_TEXT)) as HTMLElement[];
    expect(lines.length).toBe(1);
    expect(lines[0].textContent).toBe(SAY_NO_TEXT); // AddTextToScroll skips the stamp for 0x1a
    const red = [lines[0], ...lines[0].querySelectorAll<HTMLElement>('*')].some((el) =>
      /^(#ff0000|rgb\(255,\s*0,\s*0\))$/.test(el.style.color));
    expect(red).toBe(true);
    expect(spewRows()[0]).toBe(SAY_NO_TEXT);
    ui.optionsSettings.displayTimestamps = false;
  });

  it('a line targeted at the main window reaches no floaty window, even one whose filter would pass it', () => {
    ui.optionsSettings.chatWindow1Errors = true; // window 1 would accept an UNTARGETED 0x1a
    const before = count(floatyLog(1), SAY_NO_TEXT);
    typeInMainChat('@reply');
    expect(count(floatyLog(1), SAY_NO_TEXT)).toBe(before);
    ui.displayErrorText('untargeted error');
    expect(count(floatyLog(1), 'untargeted error')).toBe(1); // control: the untargeted copy does arrive
    ui.optionsSettings.chatWindow1Errors = false;
  });

  it('the same command typed in floaty window 3 lands there and NOT in the main chat', () => {
    ui.toggleFloatyChatWindow(3, true);
    const mainBefore = count(mainLog(), SAY_NO_TEXT);
    typeInFloaty(3, '@reply');
    expect(ui.commandSourceWindowId).toBe(FLOATY_CHAT_WINDOWS[2].windowId);
    expect(count(floatyLog(3), SAY_NO_TEXT)).toBe(1);
    expect(count(mainLog(), SAY_NO_TEXT)).toBe(mainBefore);
    expect(spewRows()[0]).toBe(SAY_NO_TEXT);
  });

  it('a type-0 command confirmation (DoConsent @ 368840) follows the source window too', () => {
    onSend = () => reply(CONSENT_ON, 0);
    typeInFloaty(3, '@consent on');
    expect(count(floatyLog(3), CONSENT_ON)).toBe(1);
    expect(count(mainLog(), CONSENT_ON)).toBe(0);
    typeInMainChat('@consent on');
    expect(count(mainLog(), CONSENT_ON)).toBe(1);
    expect(count(floatyLog(3), CONSENT_ON)).toBe(1);
  });

  it('UI-site notices stay untargeted whatever window typed last (castNoTarget @ 350300)', () => {
    typeInFloaty(3, '@reply'); // the command source is now floaty window 3
    raiseClientNotice(ui, CLIENT_NOTICES.castNoTarget);
    expect(count(floatyLog(3), CLIENT_NOTICES.castNoTarget.text)).toBe(0);
    expect(count(mainLog(), CLIENT_NOTICES.castNoTarget.text)).toBe(0);
    expect(spewRows()[0]).toBe(CLIENT_NOTICES.castNoTarget.text);
  });
});
