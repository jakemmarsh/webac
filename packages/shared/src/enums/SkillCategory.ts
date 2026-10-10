/**
 * SkillCategory — high-level category of a skill in the DAT SkillTable.
 *
 * Source: `reference/ACViewer/ACViewer/Entity/SkillBase.cs` declares the
 * enum exactly:
 *
 *   public enum SkillCategory
 *   {
 *       Undef  = 0,
 *       Combat = 1,
 *       Other  = 2,
 *       Magic  = 3
 *   };
 *
 * Used to group skills in the character-creation wizard and skills panel
 * — Combat (Heavy Weapons, Light Weapons, Missile Weapons, …), Magic
 * (Creature Enchantment, Item Enchantment, Life Magic, War Magic, Void
 * Magic), Other (Run, Jump, Lockpick, Salvaging, …).
 *
 * Wire format: the SkillBase DAT struct carries `category` as a uint32 in
 * the same enum encoding.
 *
 * FAITHFUL.282 — replaces a hardcoded `{ 1: 'Combat', 2: 'Other', 3:
 * 'Magic' }` map in GameUI.ts (which silently labeled the undocumented
 * Undef=0 case as 'Other' via the fallback). With the symbolic enum we
 * make the Undef case explicit + future-proof against any future
 * additional SkillBase.Category values.
 */
export enum SkillCategory {
  Undef  = 0,
  Combat = 1,
  Other  = 2,
  Magic  = 3,
}

/**
 * Render a SkillCategory enum value as a display label for the
 * character-creation skills list section headers.
 *
 * Falls back to 'Other' for Undef (0) and any unknown future values —
 * matches the retail behavior of grouping uncategorized skills under
 * the catch-all "Other" header.
 */
export function skillCategoryLabel(category: number): string {
  switch (category) {
    case SkillCategory.Combat: return 'Combat';
    case SkillCategory.Magic:  return 'Magic';
    case SkillCategory.Other:
    case SkillCategory.Undef:
    default:
      return 'Other';
  }
}

/**
 * Render a SkillAdvancementClass enum value as a display label for the
 * character panel's per-skill status column.
 *
 * Wording sourced from `dat/client_local_English.dat` StringTable
 * 0x23000001 — id=117264604 "Unusable Skills", id=81815804 "Untrained
 * Skills", id=78881532 "Specialized Skills" — preserving the retail
 * AC client labels.
 *
 * Note the asymmetry between the ACE enum identifier and the retail
 * label: ACE source uses `Inactive = 0` (the technical name); the
 * retail client displayed "Unusable" (the user-facing label per the
 * DAT StringTable). The previous hardcoded map already used "Unusable"
 * — this just promotes it to a single canonical helper.
 */
export function skillAdvancementClassLabel(advClass: number): string {
  switch (advClass) {
    case 1:  return 'Untrained';
    case 2:  return 'Trained';
    case 3:  return 'Specialized';
    case 0:
    default:
      return 'Unusable';  // SkillAdvancementClass.Inactive — retail label per DAT
  }
}
