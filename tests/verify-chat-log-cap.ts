/**
 * The chat log's cap, as end of retail kept it: ChatInterface::RecvNotice_DisplayFinalStringInfo
 * @ 004f4640 truncates the log once it holds more than 10000 glyphs (TruncateChatLog(7500)
 * @ 004f4290, beheading at a line break), so about the last 7500 glyphs remain. Every
 * ChatInterface does it: the main chat and each floaty window (FAITHFUL.267 first capped it,
 * at an invented 100 lines).
 *
 * Drives the real addSystemMessage / addChatMessage into a live chat-log element (happy-dom).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { chatLineGlyphs, trimChatLog, EOR_WORLD_RULES, AC1999_WORLD_RULES } from '../packages/renderer/src/era/EraWorldRules.js';

const glyphs = (log: Element): number => Array.from(log.children).reduce((a, c) => a + chatLineGlyphs(c), 0);

describe('chat log cap: end of retail counts glyphs (10000 → 7500)', () => {
  let H: GameUIFixture;
  let log: HTMLDivElement;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());
  beforeEach(() => {
    log = H.win.document.createElement('div');
    H.container.appendChild(log);
    H.ui.chatMessages = log;
  });

  it('addSystemMessage keeps every message until the log passes 10000 glyphs', () => {
    // "line NNNN" = 9 glyphs + the joining "\n" = 10 per message: 1000 messages = 10000 glyphs, no trim.
    for (let i = 0; i < 1000; i++) H.ui.addSystemMessage(`line ${String(i).padStart(4, '0')}`);
    expect(log.children.length).toBe(1000);
    expect(glyphs(log)).toBe(10000);
  });

  it('past 10000 glyphs the OLDEST messages go until at most 7500 remain; the newest stay in order', () => {
    for (let i = 0; i < 1001; i++) H.ui.addSystemMessage(`line ${String(i).padStart(4, '0')}`);
    expect(glyphs(log)).toBeLessThanOrEqual(7500);
    expect(log.children.length).toBe(750);
    expect((log.children[0] as HTMLElement).dataset.chatText).toBe('line 0251');
    expect((log.children[749] as HTMLElement).dataset.chatText).toBe('line 1000');
  });

  it('a long session stays bounded: 50k lines leave the log under the cap', () => {
    for (let i = 0; i < 50_000; i++) H.ui.addSystemMessage(`You hit the Drudge Skulker for ${i % 97} points of slashing damage!`);
    expect(glyphs(log)).toBeLessThanOrEqual(10000);
    expect(log.children.length).toBeLessThan(200);
  });

  it('addChatMessage lines count their sender and body the same way', () => {
    for (let i = 0; i < 2000; i++) H.ui.addChatMessage('Bob', `msg ${i}`);
    expect(glyphs(log)).toBeLessThanOrEqual(10000);
    const last = log.children[log.children.length - 1];
    expect(last.textContent).toContain('msg 1999');
  });

  it('one message longer than the whole cap is kept (the newest is never trimmed away)', () => {
    H.ui.addSystemMessage('x'.repeat(12000));
    expect(log.children.length).toBe(1);
  });

  it('addSystemMessage still scrolls to the bottom when the reader was at the bottom (FAITHFUL.351 sticky-bottom)', () => {
    let scrollTop = 0;
    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: () => 20 * log.children.length });
    Object.defineProperty(log, 'scrollTop', { configurable: true, get: () => scrollTop, set: (v: number) => { scrollTop = v; } });
    for (let i = 0; i < 20; i++) H.ui.addSystemMessage(`line ${i}`);
    expect(scrollTop).toBe(400);
  });

  it('1999 still counts lines: past 300 the first 100 go', () => {
    const d = H.win.document.createElement('div');
    for (let i = 0; i < 301; i++) { const c = H.win.document.createElement('div'); c.textContent = `l${i}`; d.appendChild(c); }
    trimChatLog(d, AC1999_WORLD_RULES.chatHistory);
    expect(d.children.length).toBe(200);
    expect(d.children[0].textContent).toBe('l101');
    expect(EOR_WORLD_RULES.chatHistory.unit).toBe('glyphs');
  });
});
