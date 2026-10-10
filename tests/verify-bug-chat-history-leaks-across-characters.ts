/**
 * BUG.chat-history-leaks-across-characters — the chat-input ArrowUp/Down
 * recall buffer was persisted under a single bare global storage key
 * (`ChatHistoryState.STORAGE_KEY`, no account/character component).
 *
 * GameUI is constructed exactly once per page session (packages/renderer/
 * src/main.ts:4940) and outlives a character switch within that session
 * (character-select -> enter-world -> logout -> character-select ->
 * enter-world), but `chatHistoryState` was only ever loaded once, at
 * GameUI's field-initializer time. Result: character B's ArrowUp/Down
 * recall buffer showed character A's chat lines from earlier in the same
 * browser session, which real AC never did (per-character history only).
 *
 * Fix: `ChatHistoryState.keyFor(accountName, characterName)` derives a
 * scoped storage key, and `GameUI.setChatHistoryScope()` re-loads
 * `chatHistoryState` under that key. main.ts's ACE `onEnterWorld` handler
 * calls it with (aceAccount, slot.name) before any chat can be sent for
 * that character.
 *
 * This suite drives the shipped `ChatHistoryState` class directly for the
 * storage-key-scoping unit behavior, and the real `GameUI` (happy-dom) for
 * the end-to-end character-switch scenario.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
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

describe('BUG.chat-history-leaks-across-characters — ChatHistoryState scoping', () => {
  it('keyFor derives distinct keys per account+character, prefixed by the base STORAGE_KEY', () => {
    const a = ChatHistoryState.keyFor('acct1', 'Alice');
    const b = ChatHistoryState.keyFor('acct1', 'Bob');
    const c = ChatHistoryState.keyFor('acct2', 'Alice');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith(ChatHistoryState.STORAGE_KEY)).toBe(true);
  });

  it('two characters on the same account get isolated history under a shared storage', () => {
    const storage = new FakeStorage();

    const alice = ChatHistoryState.loadFrom(storage, ChatHistoryState.keyFor('acct1', 'Alice'));
    alice.push('hi from Alice');
    alice.saveTo(storage);

    const bob = ChatHistoryState.loadFrom(storage, ChatHistoryState.keyFor('acct1', 'Bob'));
    expect(bob.length).toBe(0); // does NOT see Alice's history

    bob.push('hi from Bob');
    bob.saveTo(storage);

    // Reloading Alice's scope still gets her own history back, untouched.
    const aliceAgain = ChatHistoryState.loadFrom(storage, ChatHistoryState.keyFor('acct1', 'Alice'));
    expect(aliceAgain.toArray()).toEqual(['hi from Alice']);

    const bobAgain = ChatHistoryState.loadFrom(storage, ChatHistoryState.keyFor('acct1', 'Bob'));
    expect(bobAgain.toArray()).toEqual(['hi from Bob']);
  });

  it('the same character name on two different accounts does not share history', () => {
    const storage = new FakeStorage();
    const acct1Shared = ChatHistoryState.loadFrom(storage, ChatHistoryState.keyFor('acct1', 'Shared'));
    acct1Shared.push('acct1 line');
    acct1Shared.saveTo(storage);

    const acct2Shared = ChatHistoryState.loadFrom(storage, ChatHistoryState.keyFor('acct2', 'Shared'));
    expect(acct2Shared.length).toBe(0);
  });

  it('saveTo persists under the scoped key it was loaded with, not the bare global key', () => {
    const storage = new FakeStorage();
    const scoped = ChatHistoryState.loadFrom(storage, ChatHistoryState.keyFor('acct1', 'Alice'));
    scoped.push('scoped entry');
    scoped.saveTo(storage);

    expect(storage.getItem(ChatHistoryState.STORAGE_KEY)).toBeNull();
    expect(storage.getItem(ChatHistoryState.keyFor('acct1', 'Alice'))).not.toBeNull();
  });

  it('loadFrom with no storageKey argument falls back to the bare global key (pre-character-select placeholder)', () => {
    const storage = new FakeStorage();
    storage.setItem(ChatHistoryState.STORAGE_KEY, JSON.stringify(['legacy entry']));
    const h = ChatHistoryState.loadFrom(storage);
    expect(h.toArray()).toEqual(['legacy entry']);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('BUG.chat-history-leaks-across-characters — GameUI.setChatHistoryScope end-to-end', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('entering world as character A then character B does not leak A\'s chat history into B\'s recall buffer', () => {
    ui.setChatHistoryScope('testacjs', 'CharA');
    ui.pushChatHistory('hello from A');
    expect(ui.chatHistoryState.toArray()).toEqual(['hello from A']);

    // Simulate logout -> character-select -> enter-world as a different
    // character, WITHOUT reconstructing GameUI (matches main.ts: one
    // GameUI instance for the whole page session).
    ui.setChatHistoryScope('testacjs', 'CharB');
    expect(ui.chatHistoryState.toArray()).toEqual([]);

    ui.pushChatHistory('hello from B');
    expect(ui.chatHistoryState.toArray()).toEqual(['hello from B']);
  });

  it('switching back to character A restores A\'s own persisted history', () => {
    ui.setChatHistoryScope('testacjs', 'CharA');
    expect(ui.chatHistoryState.toArray()).toEqual(['hello from A']);
  });

  it('setChatHistoryScope resets chatHistoryIndex so ArrowUp starts from the newly-scoped history', () => {
    ui.chatHistoryIndex = 3; // simulate mid-recall on the previous character
    ui.setChatHistoryScope('testacjs', 'CharB');
    expect(ui.chatHistoryIndex).toBe(-1);
  });
});
