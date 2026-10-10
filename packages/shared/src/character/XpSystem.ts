/**
 * XpSystem — XP tracking, leveling, and skill credit grants.
 *
 * Tracks total XP earned, available (unspent) XP, and current level.
 * Level determined by XP thresholds from XpTable.
 * Skill credits granted at specific levels from XpTable.
 *
 * Reference: ACE.Server/WorldObjects/Player_Xp.cs
 */

export class XpSystem {
  private _totalXp: bigint = 0n;
  private _availableXp: bigint = 0n;
  private _level: number = 1;
  private _totalSkillCredits: number;
  private _availableSkillCredits: number;

  constructor(initialSkillCredits: number) {
    this._totalSkillCredits = initialSkillCredits;
    this._availableSkillCredits = initialSkillCredits;
  }

  get totalXp(): bigint { return this._totalXp; }
  get availableXp(): bigint { return this._availableXp; }
  get level(): number { return this._level; }
  get totalSkillCredits(): number { return this._totalSkillCredits; }
  get availableSkillCredits(): number { return this._availableSkillCredits; }

  /**
   * Grant XP and check for level-ups.
   * @returns array of new levels reached (may be multiple for large XP grants)
   */
  grantXp(
    amount: bigint,
    levelXpTable: bigint[],
    levelSkillCreditTable: number[],
  ): number[] {
    // Match ACE Player_Xp.cs UpdateXpAndLevel (line ~97): clamp the added XP so total
    // (and the spendable pool) never grow past the max-level XP ceiling — the last entry
    // of CharacterLevelXPList — and add nothing once already at/above it.
    const maxLevelXp = levelXpTable[levelXpTable.length - 1];
    const amountLeftToEnd = maxLevelXp - this._totalXp;
    const addAmount = amountLeftToEnd <= 0n
      ? 0n
      : (amount > amountLeftToEnd ? amountLeftToEnd : amount);
    this._totalXp += addAmount;
    this._availableXp += addAmount;

    const newLevels: number[] = [];

    // Check for level-ups
    while (this._level + 1 < levelXpTable.length) {
      const nextLevelXp = levelXpTable[this._level + 1];
      if (this._totalXp >= nextLevelXp) {
        this._level++;
        newLevels.push(this._level);

        // Grant skill credits for this level
        if (this._level < levelSkillCreditTable.length) {
          const credits = levelSkillCreditTable[this._level];
          if (credits > 0) {
            this._totalSkillCredits += credits;
            this._availableSkillCredits += credits;
          }
        }
      } else {
        break;
      }
    }

    return newLevels;
  }

  /**
   * Spend available XP (for raising attributes, skills, vitals).
   * @returns true if XP was successfully spent
   */
  spendXp(amount: number): boolean {
    if (BigInt(amount) > this._availableXp) return false;
    this._availableXp -= BigInt(amount);
    return true;
  }

  /**
   * Spend skill credits (for training/specializing skills).
   * @returns true if credits were successfully spent
   */
  spendSkillCredits(amount: number): boolean {
    if (amount > this._availableSkillCredits) return false;
    this._availableSkillCredits -= amount;
    return true;
  }

  /**
   * Get XP progress to next level as a fraction [0, 1].
   */
  getProgressToNextLevel(levelXpTable: bigint[]): number {
    if (this._level + 1 >= levelXpTable.length) return 1.0; // max level
    const currentThreshold = levelXpTable[this._level];
    const nextThreshold = levelXpTable[this._level + 1];
    const range = nextThreshold - currentThreshold;
    if (range <= 0n) return 1.0;
    const progress = this._totalXp - currentThreshold;
    return Number(progress) / Number(range);
  }

  /**
   * Get XP needed for next level.
   */
  xpToNextLevel(levelXpTable: bigint[]): bigint {
    if (this._level + 1 >= levelXpTable.length) return 0n;
    const needed = levelXpTable[this._level + 1] - this._totalXp;
    return needed > 0n ? needed : 0n;
  }

  /**
   * Set level directly (for loading saved state).
   */
  setLevel(level: number): void {
    this._level = level;
  }

  /**
   * Set XP values directly (for loading saved state).
   */
  setXp(total: bigint, available: bigint): void {
    this._totalXp = total;
    this._availableXp = available;
  }

  /**
   * Set skill credits directly (for loading saved state).
   */
  setSkillCredits(total: number, available: number): void {
    this._totalSkillCredits = total;
    this._availableSkillCredits = available;
  }
}
