/**
 * SpellBar -- spell bar with hotkey slots and casting state.
 *
 * Pure logic layer: no DOM manipulation. Manages spell slot assignment,
 * casting progress, and per-slot cooldown tracking.
 */

export interface SpellSlot {
  index: number;
  spellId: number | null;
  spellName: string;
  cooldownRemaining: number;
  isCasting: boolean;
}

export class SpellBar {
  private slots: SpellSlot[] = [];
  private _casting = false;
  private _castProgress = 0;
  private _castDuration = 0;
  private _castSpellId = 0;

  constructor(slotCount = 10) {
    for (let i = 0; i < slotCount; i++) {
      this.slots.push({
        index: i,
        spellId: null,
        spellName: '',
        cooldownRemaining: 0,
        isCasting: false,
      });
    }
  }

  // ── Slot management ──────────────────────────────────────────

  /**
   * Get a spell slot by index, or null if out of range.
   */
  getSlot(index: number): SpellSlot | null {
    if (index < 0 || index >= this.slots.length) return null;
    return this.slots[index];
  }

  /**
   * Assign a spell to a slot.
   * @returns true if the slot was successfully set
   */
  setSlot(index: number, spellId: number, name: string): boolean {
    if (index < 0 || index >= this.slots.length) return false;
    this.slots[index].spellId = spellId;
    this.slots[index].spellName = name;
    return true;
  }

  /**
   * Clear a spell slot, removing any assigned spell.
   */
  clearSlot(index: number): void {
    if (index < 0 || index >= this.slots.length) return;
    this.slots[index].spellId = null;
    this.slots[index].spellName = '';
    this.slots[index].cooldownRemaining = 0;
    this.slots[index].isCasting = false;
  }

  /**
   * Get the total number of slots.
   */
  get slotCount(): number {
    return this.slots.length;
  }

  /**
   * Get all slots that have a spell assigned.
   */
  getFilledSlots(): SpellSlot[] {
    return this.slots.filter((s) => s.spellId !== null);
  }

  // ── Casting ──────────────────────────────────────────────────

  /**
   * Whether a spell is currently being cast.
   */
  get isCasting(): boolean {
    return this._casting;
  }

  /**
   * Current cast progress as a fraction from 0 to 1.
   */
  get castProgress(): number {
    return this._castProgress;
  }

  /**
   * The spell ID currently being cast, or 0 if not casting.
   */
  get castSpellId(): number {
    return this._castSpellId;
  }

  /**
   * Begin casting a spell.
   * @param spellId - the spell being cast
   * @param duration - total cast time in seconds
   */
  startCast(spellId: number, duration: number): void {
    this._casting = true;
    this._castProgress = 0;
    this._castDuration = duration;
    this._castSpellId = spellId;

    // Mark the slot containing this spell as casting
    for (const slot of this.slots) {
      if (slot.spellId === spellId) {
        slot.isCasting = true;
        break;
      }
    }
  }

  /**
   * Advance the cast timer.
   * @param dt - elapsed time in seconds
   * @returns true when the cast completes
   */
  updateCast(dt: number): boolean {
    if (!this._casting) return false;

    if (this._castDuration <= 0) {
      this._finishCast();
      return true;
    }

    this._castProgress += dt / this._castDuration;

    if (this._castProgress >= 1) {
      this._castProgress = 1;
      this._finishCast();
      return true;
    }

    return false;
  }

  /**
   * Cancel the current cast.
   */
  cancelCast(): void {
    if (!this._casting) return;
    this._clearCastingFlags();
    this._casting = false;
    this._castProgress = 0;
    this._castDuration = 0;
    this._castSpellId = 0;
  }

  private _finishCast(): void {
    this._clearCastingFlags();
    this._casting = false;
    this._castProgress = 0;
    this._castDuration = 0;
    this._castSpellId = 0;
  }

  private _clearCastingFlags(): void {
    for (const slot of this.slots) {
      slot.isCasting = false;
    }
  }

  // ── Cooldowns ────────────────────────────────────────────────

  /**
   * Tick down all cooldowns by elapsed time.
   * @param dt - elapsed time in seconds
   */
  updateCooldowns(dt: number): void {
    for (const slot of this.slots) {
      if (slot.cooldownRemaining > 0) {
        slot.cooldownRemaining = Math.max(0, slot.cooldownRemaining - dt);
      }
    }
  }

  /**
   * Set a cooldown on all slots containing the given spell.
   * @param spellId - the spell to put on cooldown
   * @param duration - cooldown time in seconds
   */
  setCooldown(spellId: number, duration: number): void {
    for (const slot of this.slots) {
      if (slot.spellId === spellId) {
        slot.cooldownRemaining = duration;
      }
    }
  }
}
