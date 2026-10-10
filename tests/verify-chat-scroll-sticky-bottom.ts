/**
 * FAITHFUL.351 — Chat panel auto-scrolls to bottom ONLY when the user
 *  was already there.
 *
 * Pre-fix `addChatMessage` and `addSystemMessage` both unconditionally
 * yanked `chatMessages.scrollTop = chatMessages.scrollHeight` on every
 * new line. Result: when the user scrolled up to read history, ANY
 * server-emitted message (heartbeat, combat, spell echo, allegiance
 * chat) yanked them back to the bottom, breaking the read.
 *
 * Retail behavior: auto-scroll if you're already at the bottom;
 * preserve scroll position if you've scrolled up. Standard 20px
 * threshold is the canonical "user was reading the latest few lines,
 * keep them anchored" cutoff used by most modern chat UIs.
 *
 * DEBT.test-harness-hygiene: converted from a GameUI.ts source pin. The real
 * addChatMessage / addSystemMessage run against a chat-log element whose
 * scroll metrics are modelled (happy-dom has no layout): 20px per line, a
 * 100px viewport.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const LINE_PX = 20;
const VIEW_PX = 100;

describe('Chat panel preserves user scroll position (FAITHFUL.351)', () => {
  let H: GameUIFixture;
  let log: HTMLDivElement;
  let scrollTop = 0;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());
  beforeEach(() => {
    log = H.win.document.createElement('div');
    H.container.appendChild(log);
    scrollTop = 0;
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => VIEW_PX });
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => LINE_PX * log.children.length });
    Object.defineProperty(log, 'scrollTop', {
      configurable: true, get: () => scrollTop,
      set: (v: number) => { scrollTop = Math.max(0, Math.min(v, LINE_PX * log.children.length - VIEW_PX)); },
    });
    H.ui.chatMessages = log;
    for (let i = 0; i < 10; i++) H.ui.addSystemMessage(`seed ${i}`);
  });

  const bottom = (): number => LINE_PX * log.children.length - VIEW_PX;

  for (const [name, add] of [
    ['addChatMessage', (ui: { addChatMessage(s: string, t: string): void }) => ui.addChatMessage('Bob', 'hi')],
    ['addSystemMessage', (ui: { addSystemMessage(t: string): void }) => ui.addSystemMessage('You feel better.')],
  ] as const) {
    it(`${name}: a reader at the bottom stays anchored to the newest line`, () => {
      expect(scrollTop).toBe(bottom());
      add(H.ui);
      expect(scrollTop).toBe(bottom());
    });

    it(`${name}: a reader within the 20px threshold counts as "at the bottom"`, () => {
      scrollTop = bottom() - 19;
      add(H.ui);
      expect(scrollTop).toBe(bottom());
    });

    it(`${name}: a reader scrolled up (≥ 20px) keeps their position — no unconditional yank`, () => {
      scrollTop = bottom() - 20;
      const before = scrollTop;
      add(H.ui);
      expect(scrollTop).toBe(before);
      scrollTop = 0;
      add(H.ui);
      expect(scrollTop).toBe(0);
    });
  }
});
