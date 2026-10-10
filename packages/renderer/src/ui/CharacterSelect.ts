/**
 * CharacterSelectScreen — manages the character selection screen state.
 *
 * Pure logic layer: no DOM manipulation. Tracks a list of character
 * slots, the currently selected character, and retail's display order.
 */

export interface CharacterSlot {
  /** Unique character identifier. */
  id: string;
  /** Character display name. */
  name: string;
  /** Character level. */
  level: number;
  /** Heritage group ID. */
  heritage: number;
  /** Gender ID. */
  gender: number;
  /** Last known location description (e.g., "Holtburg"). */
  location: string;
  /** Timestamp (ms since epoch) when this character was last played. */
  lastPlayed: number;
  /**
   * FAITHFUL.598 — non-zero when the character is queued for deletion.
   * ACE GameMessageCharacterList.cs:28 writes
   * `DeleteTime != 0 ? max(1, now - DeleteTime) : 0` (elapsed seconds since
   * the delete was requested; the restore window is char_delete_time=3600s).
   * Retail greys these slots and marks them pending deletion.
   */
  deleteTime?: number;
}

export class CharacterSelectScreen {
  private characters: CharacterSlot[] = [];
  /** The slots in the order the CharacterSet delivered them (server order). */
  private arrivalOrder: CharacterSlot[] = [];
  private _selectedIndex = -1;
  /**
   * BUG.character-select-create-button-not-capped — the account's allowed
   * character-slot count (CharacterList.SlotCount off the wire; ACE
   * GameMessageCharacterList.cs:32-33 sets it from max_chars_per_account).
   * `undefined` means unknown (no cap enforced) rather than zero slots.
   */
  slotCount: number | undefined = undefined;

  /** Get a read-only view of all character slots. */
  get slots(): ReadonlyArray<CharacterSlot> {
    return this.characters;
  }

  /**
   * Whether the account is at (or over) its character-slot cap. Mirrors the
   * decompiled retail gmCharacterManagementUI::UpdateButtons comparison of
   * numAllowedCharacters_ against the current character count.
   */
  get atSlotCap(): boolean {
    return this.slotCount != null && this.characters.length >= this.slotCount;
  }

  /** Get the index of the currently selected character (-1 if none). */
  get selectedIndex(): number {
    return this._selectedIndex;
  }

  /** Get the currently selected character slot, or undefined if none selected. */
  get selectedCharacter(): CharacterSlot | undefined {
    if (this._selectedIndex >= 0 && this._selectedIndex < this.characters.length) {
      return this.characters[this._selectedIndex];
    }
    return undefined;
  }

  /** Whether there are any characters in the list. */
  get hasCharacters(): boolean {
    return this.characters.length > 0;
  }

  /** Number of characters in the list. */
  get characterCount(): number {
    return this.characters.length;
  }

  /** Add a character slot to the list. */
  addCharacter(slot: CharacterSlot): void {
    this.characters.push(slot);
    this.arrivalOrder.push(slot);
  }

  /**
   * Remove a character by its unique ID.
   * If the removed character was selected, the selection is cleared.
   * @returns true if a character was found and removed
   */
  removeCharacter(id: string): boolean {
    const index = this.characters.findIndex(c => c.id === id);
    if (index === -1) return false;

    const [removed] = this.characters.splice(index, 1);
    this.arrivalOrder = this.arrivalOrder.filter(c => c !== removed);

    // Adjust selection
    if (this._selectedIndex === index) {
      this._selectedIndex = -1;
    } else if (this._selectedIndex > index) {
      this._selectedIndex--;
    }

    return true;
  }

  /**
   * Select a character by index.
   * The index must be in range [0, characterCount).
   */
  selectCharacter(index: number): void {
    if (index >= 0 && index < this.characters.length) {
      this._selectedIndex = index;
    }
  }

  /**
   * BUG.charsel-no-default-selection — the selection retail's
   * gmCharacterManagementUI::RebuildCharacterList @ 004ec3a0 always makes
   * (UIElement_ListBox::SetSelectedItem, then UpdateButtons), in its order:
   *   1. the row at the ClientCharGenState slot (+0x208, CharGenState::SetSlot)
   *      — the character just created; our host enters the world straight
   *      after CharacterCreate, so the list never rebuilds with one pending;
   *   2. the row whose iid is m_iidSelectedCharacter (the previous selection,
   *      kept even when that character is now pending deletion);
   *   3. the first row, in CharacterSet (server) order, that
   *      CharacterSet::GetGreyedOutFor reports 0 — not pending deletion;
   *   4. otherwise list item 0, captured before the sort (server order).
   * An empty set selects nothing.
   */
  selectDefault(previousId?: string): void {
    this._selectedIndex = -1;
    if (this.characters.length === 0) return;
    const pick =
      (previousId !== undefined ? this.characters.find(c => c.id === previousId) : undefined)
      ?? this.arrivalOrder.find(c => !c.deleteTime)
      ?? this.arrivalOrder[0];
    this._selectedIndex = this.characters.indexOf(pick);
  }

  /** Clear the current selection. */
  clearSelection(): void {
    this._selectedIndex = -1;
  }

  /**
   * BUG.charsel-list-order — the display order retail's
   * gmCharacterManagementUI::RebuildCharacterList @ 004ec3a0 gives the list
   * after filling it in CharacterSet order:
   *   1. a bubble sort that swaps adjacent rows while
   *      wcscmp(text[i], text[i+1]) > 0 — ascending by name, compared by
   *      UTF-16 code unit (case-sensitive; JS `<` on strings is the same);
   *   2. a pass that RemoveItem/InsertItem-at-end every row whose
   *      CharacterSet::GetGreyedOutFor is non-zero (pending deletion) — a
   *      stable partition, so greyed rows stay name-sorted after the rest.
   * The selection follows its character.
   */
  sortRetailOrder(): void {
    const selectedId = this.selectedCharacter?.id;
    const byName = (a: CharacterSlot, b: CharacterSlot): number =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    const sorted = [...this.characters].sort(byName);
    this.characters = [...sorted.filter(c => !c.deleteTime), ...sorted.filter(c => !!c.deleteTime)];
    if (selectedId !== undefined) {
      this._selectedIndex = this.characters.findIndex(c => c.id === selectedId);
    }
  }
}
