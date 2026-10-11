/**
 * Decal's ObjectClass for an object, from what the client holds: its
 * ObjectDescriptionFlags (ACE ObjectDescriptionFlag) and its ItemType bits.
 * VirindiTank metas and loot rules name objects by it (wobjectgetobjectclass,
 * wobjectfindnearestbyobjectclass, Use Object waypoints). The class numbers
 * are Decal's ObjectClass enum (the same numbers vtank.ts OBJECT_CLASS_TYPES
 * and the .nav files use): 1 MeleeWeapon … 5 Monster, 10 Container, 14
 * Portal, 24 Player, 25 Vendor, 26 Door, 27 Corpse, 28 Lifestone, 29
 * HealingKit, 30 Lockpick, 31 WandStaffOrb, 33 Book, 37 Npc, 38 Foci, 39
 * Salvage, 40 Ust, 41 Services.
 */

/** ObjectDescriptionFlag bits (ACE ObjectDescriptionFlag.cs) that decide a class on their own. */
const FLAG_CLASSES: Array<[number, number]> = [
  [0x8, 24], // Player
  [0x2000, 27], // Corpse
  [0x4000, 28], // LifeStone
  [0x1000, 26], // Door
  [0x40000, 14], // Portal
  [0x200, 25], // Vendor
  [0x10000, 29], // Healer (healing kits)
  [0x20000, 30], // Lockpick
  [0x100, 33], // Book
];

/** ItemType bits (ACE ItemType.cs) → class, first match wins. */
const TYPE_CLASSES: Array<[number, number]> = [
  [0x1, 1], // MeleeWeapon
  [0x2, 2], // Armor
  [0x4, 3], // Clothing
  [0x8, 4], // Jewelry
  [0x20, 6], // Food
  [0x40, 7], // Money
  [0x100, 9], // MissileWeapon
  [0x200, 10], // Container
  [0x800, 11], // Gem
  [0x1000, 12], // SpellComponents
  [0x2000, 33], // Writable (books, notes)
  [0x4000, 13], // Key
  [0x8000, 31], // Caster
  [0x10000, 14], // Portal
  [0x40000, 15], // PromissoryNote
  [0x80000, 16], // ManaStone
  [0x100000, 41], // Service
  [0x400000, 18], // CraftCookingBase
  [0x800000, 19], // CraftAlchemyBase
  [0x2000000, 20], // CraftFletchingBase
  [0x4000000, 22], // CraftAlchemyIntermediate
  [0x8000000, 23], // CraftFletchingIntermediate
  [0x10000000, 28], // LifeStone
  [0x20000000, 40], // TinkeringTool (the Ust)
  [0x40000000, 39], // TinkeringMaterial (salvage)
  [0x80, 8], // Misc
  [0x400, 8], // Useless
];

/** Decal ObjectClass for an object's ItemType and ObjectDescriptionFlags (0 Unknown when neither says). */
export function decalObjectClass(itemType: number, flags: number): number {
  for (const [bit, cls] of FLAG_CLASSES) if ((flags & bit) !== 0) return cls;
  // A creature: a monster when it can be attacked, else an NPC.
  if ((itemType & 0x10) !== 0) return (flags & 0x10) !== 0 ? 5 : 37;
  // A focus: not a container, but it needs a pack slot (RequiresPackSlot 0x800000).
  if ((flags & 0x800000) !== 0 && (itemType & 0x200) === 0) return 38;
  for (const [bit, cls] of TYPE_CLASSES) if ((itemType & bit) !== 0) return cls;
  return 0;
}
