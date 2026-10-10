/**
 * FAITHFUL.514 — Send-button click honors `stayInChatMode`, same as the
 * Enter-key path (FAITHFUL.486).
 *
 * ACE `CharacterOption.StayInChatModeAfterSendingMessage` (0x0B /
 * CharacterOptions1.StayInChatMode), when enabled, keeps the chat input
 * focused after sending so the player can keep typing without
 * re-focusing; when disabled (retail default) the input blurs so WASD
 * movement re-enables.
 *
 * CORE.3.d — converted from a source-text pin (regex over GameUI.ts) to a
 * behavioral test: drives the REAL GameUI's chat input + Send button in
 * happy-dom and asserts focus behavior, per the never-source-pin testing
 * rule in CLAUDE.md.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const;

describe('FAITHFUL.514 — stayInChatMode gates chat-input blur (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let sent: string[];
  let sendButtonClick: (() => void) | null = null;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    sent = [];
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container, { onChatSend: (msg: string) => sent.push(msg) });
    ui.getTexURL = () => null;
    // Stub renderer: record setInteractive callbacks so the test can invoke
    // the REAL Send-button handler GameUI registers for 0x10000019 on the
    // main chat layout (0x2100006f, the EoL main chat window — CORE.17.g).
    const makeHandle = (layoutId: number, parent: HTMLElement) => {
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

  function chatInput(): HTMLInputElement {
    const input = domWindow.document.getElementById('chat-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    return input;
  }
  function pressEnter(input: HTMLInputElement): void {
    input.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  }

  it('Enter path: default (stayInChatMode off) sends and blurs the input', () => {
    ui.optionsSettings.stayInChatMode = false;
    const input = chatInput();
    input.focus();
    input.value = 'hello enter';
    pressEnter(input);
    expect(sent).toContain('hello enter');
    expect(input.value).toBe('');
    expect(domWindow.document.activeElement).not.toBe(input);
  });

  it('Enter path: stayInChatMode keeps the input focused after sending', () => {
    ui.optionsSettings.stayInChatMode = true;
    const input = chatInput();
    input.focus();
    input.value = 'still typing';
    pressEnter(input);
    expect(sent).toContain('still typing');
    expect(input.value).toBe('');
    expect(domWindow.document.activeElement).toBe(input);
    ui.optionsSettings.stayInChatMode = false;
  });

  it('Send-button path: default blurs; stayInChatMode keeps focus (FAITHFUL.514)', () => {
    expect(sendButtonClick, 'Send button 0x10000019 wired via setInteractive').toBeTypeOf('function');
    const input = chatInput();
    ui.optionsSettings.stayInChatMode = false;
    input.focus();
    input.value = 'via button';
    sendButtonClick!();
    expect(sent).toContain('via button');
    expect(domWindow.document.activeElement).not.toBe(input);
    ui.optionsSettings.stayInChatMode = true;
    input.focus();
    input.value = 'via button 2';
    sendButtonClick!();
    expect(sent).toContain('via button 2');
    expect(domWindow.document.activeElement).toBe(input);
    ui.optionsSettings.stayInChatMode = false;
  });

  it('CORE.3.d — @title from the main input goes to the command system on both paths (no GameUI pre-check)', () => {
    // Retail OnChatCommand hands every line to DoCommand; DoTitle @ 0057a640
    // itself refuses command sources 1/8 (the main chat) — that refusal is
    // driven in verify-retail-commands-allegiance-social.ts (@title). GameUI
    // just forwards the line and prints nothing of its own.
    const input = chatInput();
    const mainLog = domWindow.document.getElementById('chat-messages') as HTMLElement;
    const before = mainLog.children.length;
    input.focus();
    input.value = '@title nope';
    pressEnter(input);
    expect(sent).toContain('@title nope');
    input.value = '@title nope again';
    sendButtonClick!();
    expect(sent).toContain('@title nope again');
    expect(mainLog.children.length).toBe(before);
  });
});
