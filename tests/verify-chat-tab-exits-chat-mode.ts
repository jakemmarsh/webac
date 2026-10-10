/**
 * BUG.tab-toggles-combat — Tab in the chat bar exits chat mode; it does NOT
 * toggle combat mode.
 *
 * Retail defaults (portal.dat KeyMap 0x14000002 "DefaultMap", generated into
 * KeybindDefaults.generated.ts): Tab → Enter/Exit Chat Mode 0x10000024 (input
 * map 0x1000000d), ` (Backquote) → Toggle Combat Mode 0x1000005a (input map
 * 0x10000002). While typing, the key reaches ChatInterface::OnAction case
 * 0x10000024 → OnToggleChatEntry @ 004f3b30, which drops the chat entry's
 * focus and sends ToggleChatEntry(false) — nothing about combat.
 *
 * FAITHFUL.266 had wired Tab-in-chat to toggleCombatMode, so pressing Tab
 * (router: enter chat) then Tab again (chat bar: "toggle combat") flipped
 * combat mode — the user report "double tab enters/exits combat mode".
 *
 * Behavioural: key events are dispatched on the real GameUI chat input in
 * happy-dom, with and without the real KeybindRegistry wired.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CombatMode } from '@ac/shared';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';
import { ACT, DEFAULT_KEYBINDS, activeInputMaps } from '../packages/renderer/src/input/KeybindDefaults.js';

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

describe('BUG.tab-toggles-combat — retail default bindings', () => {
  it('Tab is Enter/Exit Chat Mode and Backquote is Toggle Combat Mode, in every combat mode', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    for (const mode of [CombatMode.NonCombat, CombatMode.Melee, CombatMode.Missile, CombatMode.Magic]) {
      r.setActiveInputMaps(activeInputMaps(mode));
      expect(r.resolve('Tab')).toBe(ACT.EnterExitChatMode);
      expect(r.resolve('Backquote')).toBe(ACT.ToggleCombatMode);
    }
    expect(r.getMappings(ACT.ToggleCombatMode).filter(Boolean)).toEqual(['Backquote']);
    expect(r.getMappings(ACT.EnterExitChatMode).filter(Boolean)).toEqual(['Tab']);
  });
});

describe('BUG.tab-toggles-combat — Tab in the chat bar (behavioural)', () => {
  let H: GameUIFixture;
  const modes: number[] = [];

  beforeAll(async () => {
    H = await mountGameUI({ callbacks: { onCombatModeChange: (m: number) => { modes.push(m); } } });
    stubLayoutRenderer(H.ui, H.win);
    H.ui.renderHUD();
  }, 60_000);
  afterAll(() => H.teardown());

  function input(): HTMLInputElement {
    const el = H.win.document.getElementById('chat-input') as HTMLInputElement;
    expect(el).toBeTruthy();
    return el;
  }

  function press(key: string, code: string): { ev: KeyboardEvent; bubbled: boolean } {
    const el = input();
    el.focus();
    let bubbled = false;
    const docListener = () => { bubbled = true; };
    H.win.document.addEventListener('keydown', docListener);
    const ev = new H.win.KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    H.win.document.removeEventListener('keydown', docListener);
    return { ev, bubbled };
  }

  it('without a registry: Tab exits chat mode and leaves combat mode alone', () => {
    H.ui.keybindRegistry = null;
    const { ev, bubbled } = press('Tab', 'Tab');
    expect(H.win.document.activeElement).not.toBe(input());
    expect(H.ui.uiManager.inputFocused).toBe(false);
    expect(ev.defaultPrevented).toBe(true);
    expect(bubbled).toBe(false);
    expect(H.ui.hud.combatMode).toBe(CombatMode.NonCombat);
    expect(modes).toEqual([]);
  });

  it('with the retail registry: repeated Tab presses in chat never toggle combat', () => {
    H.ui.keybindRegistry = new KeybindRegistry(DEFAULT_KEYBINDS);
    for (let i = 0; i < 4; i++) {
      const { ev, bubbled } = press('Tab', 'Tab');
      expect(ev.defaultPrevented).toBe(true);
      expect(bubbled).toBe(false);
      expect(H.win.document.activeElement).not.toBe(input());
    }
    expect(H.ui.hud.combatMode).toBe(CombatMode.NonCombat);
    expect(modes).toEqual([]);
  });

  it('Backquote typed in chat is text, not a combat toggle', () => {
    H.ui.keybindRegistry = new KeybindRegistry(DEFAULT_KEYBINDS);
    const { ev } = press('`', 'Backquote');
    expect(ev.defaultPrevented).toBe(false);
    expect(H.win.document.activeElement).toBe(input());
    expect(H.ui.hud.combatMode).toBe(CombatMode.NonCombat);
    expect(modes).toEqual([]);
    input().blur();
  });

  it('follows a rebind: the new Enter/Exit Chat Mode key exits chat; an unbound Tab stays in the chat bar', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    r.setMapping(ACT.EnterExitChatMode, 0, 'F9');
    H.ui.keybindRegistry = r;

    const tab = press('Tab', 'Tab');
    expect(tab.ev.defaultPrevented).toBe(true); // no browser focus walk to the Send button
    expect(H.win.document.activeElement).toBe(input());

    const f9 = press('F9', 'F9');
    expect(f9.ev.defaultPrevented).toBe(true);
    expect(f9.bubbled).toBe(false);
    expect(H.win.document.activeElement).not.toBe(input());
    expect(H.ui.hud.combatMode).toBe(CombatMode.NonCombat);
    expect(modes).toEqual([]);
  });
});
