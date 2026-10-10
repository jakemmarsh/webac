/**
 * FAITHFUL.268 — chatHistory (ArrowUp navigation buffer) capped at 50.
 *
 * Pre-fix every Enter or Send appended to chatHistory[] forever — slow
 * memory leak. AC retail's chat-input history was typically capped at
 * around 50 entries. Same fix pattern as FAITHFUL.267 (chat log cap):
 * drop oldest entries when length exceeds the cap.
 *
 * FAITHFUL.465 — consecutive duplicate messages are collapsed so
 * repeatedly sending the same line doesn't burn the entire 50-entry
 * buffer on one message and lose older history.
 *
 * CONVERTED from a source-text pin (regex against raw GameUI.ts,
 * asserting on the CHAT_HISTORY_CAP constant text and call-site
 * discipline via string matching — never executed) to a behavioral
 * test, per CLAUDE.md "Never Break Tests" (source-text pins catch
 * nothing). The cap + push + dedup logic was extracted from GameUI.ts's
 * inline array into `ChatHistoryState` (packages/renderer/src/session/
 * ChatHistoryState.ts, matching the SquelchState/LastOutsideDeathState
 * extraction pattern) so it's importable and directly drivable here.
 * GameUI.ts's `pushChatHistory()` and its ArrowUp/ArrowDown handlers now
 * delegate to this class — there is no separate `chatHistory.push(...)`
 * call site left to drift out of sync, so the old "only one direct push"
 * pin is now a structural guarantee rather than something to re-assert.
 */
import { describe, it, expect } from 'vitest';
import { ChatHistoryState } from '../packages/renderer/src/session/ChatHistoryState.js';

describe('FAITHFUL.268 — ChatHistoryState cap', () => {
  it('CAP is 50', () => {
    expect(ChatHistoryState.CAP).toBe(50);
  });

  it('push appends and length grows up to the cap', () => {
    const h = new ChatHistoryState();
    for (let i = 0; i < 50; i++) h.push(`msg ${i}`);
    expect(h.length).toBe(50);
    expect(h.get(0)).toBe('msg 0');
    expect(h.get(49)).toBe('msg 49');
  });

  it('pushing past the cap drops the oldest entry (shift, not truncate-newest)', () => {
    const h = new ChatHistoryState();
    for (let i = 0; i < 55; i++) h.push(`msg ${i}`);
    expect(h.length).toBe(50);
    // The oldest 5 (msg 0..4) were shifted out; msg 5 is now the oldest.
    expect(h.get(0)).toBe('msg 5');
    expect(h.get(49)).toBe('msg 54');
  });

  it('constructing from an over-cap persisted array clamps to the newest 50', () => {
    const stored = Array.from({ length: 60 }, (_, i) => `stored ${i}`);
    const h = new ChatHistoryState(stored);
    expect(h.length).toBe(50);
    expect(h.get(0)).toBe('stored 10');
    expect(h.get(49)).toBe('stored 59');
  });

  it('a consecutive duplicate message is skipped, not appended', () => {
    const h = new ChatHistoryState();
    expect(h.push('hi')).toBe(true);
    expect(h.push('hi')).toBe(false);
    expect(h.length).toBe(1);
  });

  it('a non-consecutive repeat (different message in between) IS appended', () => {
    const h = new ChatHistoryState();
    h.push('hi');
    h.push('bye');
    expect(h.push('hi')).toBe(true);
    expect(h.length).toBe(3);
    expect(h.toArray()).toEqual(['hi', 'bye', 'hi']);
  });

  it('repeatedly sending the same line does not consume the whole buffer', () => {
    const h = new ChatHistoryState();
    for (let i = 0; i < 100; i++) h.push('/tell Bob hi');
    expect(h.length).toBe(1);
  });

  it('toArray returns a snapshot, not a live reference', () => {
    const h = new ChatHistoryState();
    h.push('one');
    const snap = h.toArray();
    h.push('two');
    expect(snap).toEqual(['one']);
    expect(h.toArray()).toEqual(['one', 'two']);
  });
});
