/**
 * UtilityBelt's login switching (setnextlogin / clearnextlogin; `/ub login
 * next`): the character to enter when you are next back at character select.
 * It fits our flow as it is: a logout already lands on character select with
 * the account's CharacterList (ACE Session.SendFinalLogOffMessages), where a
 * deliberate logout otherwise waits for the player. Kept in memory for this
 * tab only; a slot pending deletion is never entered.
 */
export class NextLogin {
  private name: string | null = null;
  set(name: string | null): boolean { this.name = name?.trim() || null; return true; }
  get(): string | null { return this.name; }
  /** The slot to enter now, once (it is forgotten either way). */
  take<T extends { name: string; deleteTime?: number }>(slots: T[]): T | null {
    const want = this.name?.toLowerCase();
    this.name = null;
    if (!want) return null;
    return slots.find((s) => s.name.toLowerCase() === want && !(s.deleteTime && s.deleteTime > 0)) ?? null;
  }
}
