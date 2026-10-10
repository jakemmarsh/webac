/**
 * ChatHistoryState — the chat-input ArrowUp/ArrowDown recall buffer.
 * (ASSESS: extracted from GameUI.ts's `chatHistory` field so the cap +
 * push + persistence discipline is importable + unit-testable, matching
 * the SquelchState/LastOutsideDeathState extraction pattern.)
 *
 * FAITHFUL.268 — capped at 50 entries (oldest dropped) so the buffer
 * doesn't grow unboundedly across a session. FAITHFUL.465 — consecutive
 * duplicate messages are collapsed (pressing Up repeatedly after sending
 * the same line N times in a row shouldn't burn N buffer slots on one
 * message and lose older history). FAITHFUL.451 — persisted to
 * localStorage (retail AC saved chat-input history per-character in the
 * .cfg file; localStorage is the browser-equivalent).
 *
 * BUG.chat-history-leaks-across-characters — retail scoped this per
 * character (it lived in the per-character .cfg file), but GameUI is
 * constructed once per page session and can outlive a character switch
 * (character-select -> enter-world -> logout -> character-select ->
 * enter-world), so a bare global storage key let one character's recall
 * buffer leak into another's. `keyFor()` derives a per-account+character
 * key; callers re-`loadFrom` with that scoped key on enter-world instead
 * of relying on the constructor-time load.
 */

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export class ChatHistoryState {
  static readonly CAP = 50;
  static readonly STORAGE_KEY = 'ac_chat_history_v1';

  private entries: string[];
  private readonly storageKey: string;

  constructor(initial: string[] = [], storageKey: string = ChatHistoryState.STORAGE_KEY) {
    this.entries = initial.slice();
    while (this.entries.length > ChatHistoryState.CAP) this.entries.shift();
    this.storageKey = storageKey;
  }

  /** Per-account+character storage key, so switching characters within
   *  the same GameUI session (no page reload) doesn't share one
   *  character's chat recall buffer with another's. */
  static keyFor(accountName: string, characterName: string): string {
    return `${ChatHistoryState.STORAGE_KEY}:${accountName}:${characterName}`;
  }

  /** Parse a raw localStorage value into a clean string array: drops
   *  non-array/corrupted JSON and non-string/empty entries. Does not
   *  clamp to CAP — the constructor does that. */
  static parseStored(raw: string | null): string[] {
    try {
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const result: string[] = [];
      for (const v of parsed) {
        if (typeof v === 'string' && v.length > 0) result.push(v);
      }
      return result;
    } catch { return []; }
  }

  /** Restore from a Storage-like object (localStorage in the browser).
   *  `storageKey` defaults to the bare global key (used before a
   *  character identity is known); pass `keyFor(account, character)` to
   *  scope the recall buffer per character. Any access failure (quota /
   *  disabled / private-browsing) yields an empty history rather than
   *  throwing. */
  static loadFrom(storage: StorageLike, storageKey: string = ChatHistoryState.STORAGE_KEY): ChatHistoryState {
    try {
      return new ChatHistoryState(ChatHistoryState.parseStored(storage.getItem(storageKey)), storageKey);
    } catch {
      return new ChatHistoryState([], storageKey);
    }
  }

  /** Persist the current entries under this instance's storage key
   *  (the one it was loaded with). Drops silently on quota / disabled
   *  storage, matching loadFrom's failure handling. */
  saveTo(storage: StorageLike): void {
    try {
      storage.setItem(this.storageKey, JSON.stringify(this.entries));
    } catch { /* quota / disabled — drop silently */ }
  }

  get length(): number {
    return this.entries.length;
  }

  get(index: number): string | undefined {
    return this.entries[index];
  }

  /** Push a sent message, capping to oldest-drop. Skips consecutive
   *  duplicates (FAITHFUL.465). Returns true if the message was added. */
  push(msg: string): boolean {
    if (this.entries.length > 0 && this.entries[this.entries.length - 1] === msg) {
      return false;
    }
    this.entries.push(msg);
    while (this.entries.length > ChatHistoryState.CAP) this.entries.shift();
    return true;
  }

  toArray(): string[] {
    return this.entries.slice();
  }
}
