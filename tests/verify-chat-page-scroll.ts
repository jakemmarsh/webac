/**
 * FAITHFUL.388 — PgUp/PgDn scroll the chat panel backlog.
 *
 * Pre-fix the chat scrollback was only reachable via mouse wheel — no
 * keyboard equivalent. Retail AC bound PgUp/PgDn to scroll chat
 * backlog by one visible page (minus a small overlap to keep the
 * reader's place).
 *
 * `GameUI.scrollChatPanel(direction, fraction = 0.9)` is the public
 * API; main.ts binds PgUp → -1 and PgDn → +1 (the global keydown
 * handler skips when the chat input is focused, so typing PgUp in the
 * input doesn't trigger this binding).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { KeybindRegistry, eventToCode } from '@ac/renderer/input/KeybindRegistry.js';
import { DEFAULT_KEYBINDS, MOVEMENT_CANONICAL } from '@ac/renderer/input/KeybindDefaults.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

// DEBT.test-harness-hygiene: behavioural — the real scrollChatPanel driven
// against a chat log with a known viewport height (was a GameUI.ts pin).
describe('GameUI.scrollChatPanel API (FAITHFUL.388)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H?.teardown());

  const log = (clientHeight: number, scrollTop: number) => {
    const el = { clientHeight, scrollTop };
    H.ui.chatMessages = el;
    return el;
  };

  it('PgDn (+1) scrolls down by round(clientHeight × 0.9) — one page minus overlap', () => {
    const el = log(200, 500);
    H.ui.scrollChatPanel(1);
    expect(el.scrollTop).toBe(680);
  });

  it('PgUp (-1) scrolls up by the same delta; fraction is overridable', () => {
    const el = log(200, 500);
    H.ui.scrollChatPanel(-1);
    expect(el.scrollTop).toBe(320);
    H.ui.scrollChatPanel(-1, 0.5);
    expect(el.scrollTop).toBe(220);
  });

  it('the delta is clamped to at least 1 px (zero-height log still moves)', () => {
    const el = log(0, 10);
    H.ui.scrollChatPanel(1);
    expect(el.scrollTop).toBe(11);
  });

  it('no-ops without a chat log', () => {
    H.ui.chatMessages = null;
    expect(() => H.ui.scrollChatPanel(1)).not.toThrow();
  });
});

// PgUp/PgDn are reserved SYSTEM keys handled directly in main.ts's keydown
// listener (chat-backlog scroll), NOT part of the rebindable AC command set
// (VISUAL.127). The behavioral guarantee is that the keybind registry never
// claims PageUp/PageDown, so they stay free for the chat-scroll handler.
describe('PgUp/PgDn stay reserved for chat scroll (FAITHFUL.388 / VISUAL.127)', () => {
  it('the keybind registry resolves no command for PageUp/PageDown', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(r.resolve(eventToCode({ code: 'PageUp' }))).toBeNull();
    expect(r.resolve(eventToCode({ code: 'PageDown' }))).toBeNull();
  });

  it('no movement command is bound to PageUp/PageDown either', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    for (const code of ['PageUp', 'PageDown']) {
      const id = r.resolve(code);
      expect(id === null || MOVEMENT_CANONICAL[id] === undefined).toBe(true);
    }
  });
});
