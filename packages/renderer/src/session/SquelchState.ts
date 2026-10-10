import { SquelchMask } from '@ac/shared';

/**
 * SquelchState — client-side mirror of a character's server-persisted
 * squelch list. (ASSESS: extracted from main.ts's closure-scoped
 * `squelchedNames` Map so the per-character-lifetime clear behavior is
 * importable + unit-testable; main.ts keeps the exact Map<lowercase,
 * originalCase> call shape — `.set(key, value)`, `.delete(key)`,
 * `.has(key)`, `.values()` — callers still pass pre-lowercased keys
 * themselves, same as the raw Map it replaces.)
 *
 * ACE server behavior this models:
 *   • Squelches are per-character server state — SquelchManager.cs:283-288
 *     (UpdateSquelchDB) rebuilds `Squelches` fresh from
 *     `Player.Character.GetSquelches(...)` for whichever character is
 *     currently active.
 *   • Player_Networking.cs:116-119 (SendSquelchDB) only ships
 *     GameEventSetSquelchDB when SquelchManager.HasSquelches is true for
 *     that character, so a newly-entered character with no persisted
 *     squelches of its own receives no restore event at all.
 *   • BUG.squelch-list-stale-char-switch — pre-fix, main.ts's closure Map
 *     was populated only additively and never cleared on logoff/character
 *     switch, so a character with zero squelches of its own inherited
 *     the previous character's entries on the same account (no page
 *     reload). teardownWorldState() must clear() this on every
 *     logoff/character-logoff/disconnect boundary so a re-entry starts
 *     empty and, if the new character has its own persisted squelches,
 *     gets correctly repopulated by the next SetSquelchDB.
 *   • BUG.squelch-mask-per-channel-discarded — each name entry carries a
 *     SquelchMask (SquelchDB.cs:144 `Filters[0].HasFlag(squelchMask)`),
 *     and `globalMask` mirrors `Player.SquelchGlobal` (the `/filter`
 *     command's account-wide channel squelch, SquelchManager.cs:255-274).
 *     `has()`/`.values()` stay presence/display-only for call sites that
 *     don't discriminate by channel (matching pre-fix behavior); use
 *     `blocksChannel()` at sites that check a specific ChatMessageType,
 *     mirroring SquelchDB.Contains()'s two-tier per-name + global check.
 *   • BUG.squelch-db-snapshot-treated-as-merge — every
 *     GameEventSetSquelchDB is a full, freshly-rebuilt snapshot, never a
 *     delta: SquelchManager.cs:285-296 (UpdateSquelchDB then
 *     SendSquelchDB) runs unconditionally after every add/remove/global
 *     change, including down to zero characters. `replaceAll()` mirrors
 *     that — the caller must feed it the complete entry list from each
 *     received event so a name dropped server-side (e.g. via
 *     UnsquelchCharacter's TryRemoveSquelch) is dropped here too, instead
 *     of lingering until the next full clear() on logoff.
 */

export class SquelchState {
  private readonly entries = new Map<string, { name: string; mask: number; account: boolean }>();

  /** Player.SquelchGlobal mirror — the account-wide `/filter` mask. */
  globalMask = 0;

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, value: string, mask: number = SquelchMask.AllChannels, account = false): void {
    this.entries.set(key, { name: value, mask, account });
  }

  /** Full-replace the character-squelch entries from a fresh SetSquelchDB
   *  snapshot — a name present before this call but absent from `entries`
   *  is no longer squelched server-side and is dropped, not merely left
   *  un-updated. Does not touch `globalMask` — callers assign that
   *  separately from the same event's Globals block. */
  replaceAll(entries: { name: string; mask: number; account?: boolean }[]): void {
    this.entries.clear();
    for (const e of entries) {
      this.entries.set(e.name.toLowerCase(), { name: e.name, mask: e.mask, account: e.account ?? false });
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  values(): IterableIterator<string> {
    return Array.from(this.entries.values(), (e) => e.name)[Symbol.iterator]();
  }

  /** Display entries for the squelch panel — name + Account flag (the
   *  Type column). CORE.5.c.d — the retail pane distinguishes
   *  Character/Account squelches per SquelchInfo.Account. */
  displayEntries(): Array<{ name: string; account: boolean }> {
    return Array.from(this.entries.values(), (e) => ({ name: e.name, account: e.account }));
  }

  /** True if `key` is squelched for `channelMask` — either its own
   *  per-name SquelchMask or the account-wide global mask cover the
   *  channel bit. Mirrors SquelchDB.Contains(). */
  blocksChannel(key: string, channelMask: number): boolean {
    const nameMask = this.entries.get(key)?.mask ?? 0;
    return (nameMask & channelMask) !== 0 || (this.globalMask & channelMask) !== 0;
  }

  /** Drop all entries — called on logoff/character-logoff/disconnect so a
   *  different character on the same account never inherits a prior
   *  character's squelches. */
  clear(): void {
    this.entries.clear();
    this.globalMask = 0;
  }
}
