/**
 * FAITHFUL.465 — chatHistory collapses consecutive duplicates.
 *
 *  Pre-fix pushChatHistory unconditionally appended every sent line.
 *  A player who used a repeated command (e.g. `/tell Bob hi` 50
 *  times during a coordination session) would fill the entire 50-
 *  entry buffer with one identical line — pushing all older history
 *  off the end. Pressing Up to recall a prior /squelch or /filter
 *  command would no longer reach it.
 *
 *  Retail AC collapsed consecutive duplicates so Up arrow always
 *  stepped through distinct prior commands. The fix matches that
 *  by skipping the push when the new message equals the most-recent
 *  entry.
 *
 * CONVERTED from a source-text pin (regex against raw GameUI.ts's
 * `pushChatHistory` body) to a behavioral test, per CLAUDE.md "Never
 * Break Tests". The dedup + cap-trim logic now lives in
 * `ChatHistoryState` (packages/renderer/src/session/ChatHistoryState.ts)
 * — driven directly here, same as verify-chat-history-cap.ts.
 */
import { describe, it, expect } from 'vitest';
import { ChatHistoryState } from '../packages/renderer/src/session/ChatHistoryState.js';

describe('FAITHFUL.465 — ChatHistoryState.push dedup', () => {
  it('a consecutive duplicate is not appended', () => {
    const h = new ChatHistoryState();
    h.push('/tell Bob hi');
    expect(h.push('/tell Bob hi')).toBe(false);
    expect(h.length).toBe(1);
  });

  it('a run of 50 identical sends leaves exactly one entry, never overflowing the cap', () => {
    const h = new ChatHistoryState();
    for (let i = 0; i < 50; i++) h.push('/tell Bob hi');
    expect(h.length).toBe(1);
    expect(h.get(0)).toBe('/tell Bob hi');
  });

  it('older distinct history survives a later run of duplicates (the bug this fixes)', () => {
    const h = new ChatHistoryState();
    h.push('/squelch add Griefer');
    h.push('/filter add spam');
    for (let i = 0; i < 20; i++) h.push('/tell Bob hi'); // repeated coordination spam
    // Up-arrow recall must still be able to reach the earlier distinct commands.
    expect(h.toArray()).toEqual(['/squelch add Griefer', '/filter add spam', '/tell Bob hi']);
  });

  it('a duplicate that is not the immediately-preceding entry IS appended (non-consecutive)', () => {
    const h = new ChatHistoryState();
    h.push('hi');
    h.push('bye');
    expect(h.push('hi')).toBe(true);
    expect(h.toArray()).toEqual(['hi', 'bye', 'hi']);
  });

  it('cap trim still applies after a successful (non-duplicate) push', () => {
    const h = new ChatHistoryState();
    for (let i = 0; i < 55; i++) h.push(`msg ${i}`); // all distinct — no dedup skips
    expect(h.length).toBe(ChatHistoryState.CAP);
    expect(h.get(0)).toBe('msg 5');
  });
});
