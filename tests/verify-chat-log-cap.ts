/**
 * FAITHFUL.267 — addSystemMessage caps the chat log at 100 entries.
 *
 * Pre-fix addSystemMessage appended to chatMessages without a cap, so
 * server combat/spell/recall lines accumulated without bound. addChatMessage
 * already had the 100-entry cap; this brings them into parity.
 *
 * DEBT.test-harness-hygiene: converted from a GameUI.ts source pin — the real
 * addSystemMessage / addChatMessage append into a live chat-log element.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('FAITHFUL.267 — chat log cap (behavioural)', () => {
  let H: GameUIFixture;
  let log: HTMLDivElement;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());
  beforeEach(() => {
    log = H.win.document.createElement('div');
    H.container.appendChild(log);
    H.ui.chatMessages = log;
  });

  it('addSystemMessage caps the log at 100 entries, dropping the OLDEST', () => {
    for (let i = 0; i < 130; i++) H.ui.addSystemMessage(`line ${i}`);
    expect(log.children.length).toBe(100);
    expect(log.children[0].textContent).toContain('line 30');
    expect(log.children[99].textContent).toContain('line 129');
  });

  it('addChatMessage has the same cap (regression)', () => {
    for (let i = 0; i < 105; i++) H.ui.addChatMessage('Bob', `msg ${i}`);
    expect(log.children.length).toBe(100);
    expect(log.children[0].textContent).toContain('msg 5');
  });

  it('addSystemMessage still scrolls to the bottom when the reader was at the bottom (FAITHFUL.351 sticky-bottom)', () => {
    let scrollTop = 0;
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 20 * log.children.length });
    Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = v; } });
    for (let i = 0; i < 20; i++) H.ui.addSystemMessage(`line ${i}`);
    expect(scrollTop).toBe(400);
  });
});
