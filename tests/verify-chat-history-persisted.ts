/**
 * FAITHFUL.451 — chatHistory (ArrowUp navigation buffer) persists.
 *
 *  Pre-fix the chat-input up-arrow history reset to empty every login,
 *  so returning players couldn't recall recent commands or messages.
 *  Retail AC saved this per-character in the .cfg file (alongside UI
 *  layout, options, squelches, etc.); we use localStorage as the
 *  browser-equivalent — same persistence pattern as FAITHFUL.430-432.
 *
 *  Closed by:
 *    - `ChatHistoryState.STORAGE_KEY = 'ac_chat_history_v1'`.
 *    - `ChatHistoryState.loadFrom(storage)` reads + type-checks the
 *      stored array, drops corrupted entries silently, clamps to CAP
 *      (50).
 *    - `saveTo(storage)` writes the updated array after every push so
 *      every send-and-recall round trip is durable.
 *
 * CONVERTED from a source-text pin (regex against raw GameUI.ts's field
 * initializer and pushChatHistory body) to a behavioral test, per
 * CLAUDE.md "Never Break Tests". The persistence logic now lives in
 * `ChatHistoryState` (packages/renderer/src/session/ChatHistoryState.ts)
 * — driven directly here against a fake Storage-like object, no DOM
 * needed.
 */
import { describe, it, expect } from 'vitest';
import { ChatHistoryState } from '../packages/renderer/src/session/ChatHistoryState.js';

class FakeStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

describe('FAITHFUL.451 — ChatHistoryState persistence', () => {
  it('uses the ac_chat_history_v1 storage key', () => {
    expect(ChatHistoryState.STORAGE_KEY).toBe('ac_chat_history_v1');
  });

  it('loadFrom an empty/missing key restores an empty history', () => {
    const storage = new FakeStorage();
    const h = ChatHistoryState.loadFrom(storage);
    expect(h.length).toBe(0);
  });

  it('a full send-then-reload round trip restores the same entries in order', () => {
    const storage = new FakeStorage();
    const h1 = new ChatHistoryState();
    h1.push('hello');
    h1.push('/tell Bob hi');
    h1.saveTo(storage);

    const h2 = ChatHistoryState.loadFrom(storage);
    expect(h2.toArray()).toEqual(['hello', '/tell Bob hi']);
  });

  it('malformed JSON in storage restores an empty history instead of throwing', () => {
    const storage = new FakeStorage();
    storage.setItem(ChatHistoryState.STORAGE_KEY, '{not valid json');
    const h = ChatHistoryState.loadFrom(storage);
    expect(h.length).toBe(0);
  });

  it('a non-array stored value restores an empty history', () => {
    const storage = new FakeStorage();
    storage.setItem(ChatHistoryState.STORAGE_KEY, JSON.stringify({ not: 'an array' }));
    const h = ChatHistoryState.loadFrom(storage);
    expect(h.length).toBe(0);
  });

  it('non-string and empty-string entries are dropped, valid strings kept', () => {
    const storage = new FakeStorage();
    storage.setItem(ChatHistoryState.STORAGE_KEY, JSON.stringify(['ok', '', 42, null, 'also ok']));
    const h = ChatHistoryState.loadFrom(storage);
    expect(h.toArray()).toEqual(['ok', 'also ok']);
  });

  it('a stored array longer than CAP (50) is clamped to the newest entries on load', () => {
    const storage = new FakeStorage();
    const stored = Array.from({ length: 60 }, (_, i) => `stored ${i}`);
    storage.setItem(ChatHistoryState.STORAGE_KEY, JSON.stringify(stored));
    const h = ChatHistoryState.loadFrom(storage);
    expect(h.length).toBe(50);
    expect(h.get(0)).toBe('stored 10');
    expect(h.get(49)).toBe('stored 59');
  });

  it('a getItem that throws (quota / disabled storage) restores an empty history instead of throwing', () => {
    const storage = {
      getItem(): string { throw new Error('access denied'); },
      setItem(): void { /* unused */ },
    };
    expect(() => ChatHistoryState.loadFrom(storage)).not.toThrow();
    expect(ChatHistoryState.loadFrom(storage).length).toBe(0);
  });

  it('saveTo swallows a setItem failure (quota / disabled storage) instead of throwing', () => {
    const storage = {
      getItem(): string | null { return null; },
      setItem(): void { throw new Error('quota exceeded'); },
    };
    const h = new ChatHistoryState();
    h.push('hi');
    expect(() => h.saveTo(storage)).not.toThrow();
  });
});
