/**
 * The automation's record of an examined object: one property table per kind, keyed by ACE property id, as
 * Decal's WorldObject gave plugins (VTank, Mag-Tools, UB). The examination's tables carry only what the server
 * puts in them (ACE: [AssessmentProperty] ids, @ac/shared aceDeliveredProperties.ts); main.ts folds the
 * Weapon / ArmorProfile numbers in (foldAppraisalProfiles), and this adds the object's public description
 * (CreateObject weenie header, kept current by the server's updates) where the tables have nothing:
 * ItemType 1, ClothingPriority 4, ValidLocations 9, CurrentWieldedLocation 10, StackSize 12, ItemUseable 16,
 * AmmoType 50, Spell data id 28, Icon 8 / IconOverlay 50 / IconUnderlay 52 …
 *
 * Before 2026-11-17 the record was the bare tables, so on ACE every reader of those ids saw nothing: the loot
 * rules' Decal keys Type / Coverage / EquipableSlots / StackCount / Icon* read 0, kits and wielded-use items
 * never read ItemUseable (mustWield), and casters, gems and potions had no Spell id (BUG.agent-undelivered-
 * property-reads). The tables win where they have a value (GDLE-family servers send most of these there).
 */

/** One examined object as the automation reads it. */
export interface AgentAppraisal {
  int: Record<number, number>;
  float: Record<number, number>;
  string: Record<number, string>;
  bool: Record<number, boolean>;
  did: Record<number, number>;
  /** Its spells' names. */
  spells: string[];
  /** The item's own spells (its spell book), by id. */
  spellIds: number[];
  /** The enchantments on it now (sent with 0x80000000, AppraiseInfo.EnchantmentMask). */
  activeSpellIds: number[];
  /** When it arrived (performance.now()). */
  at?: number;
  /** A weapon's WeaponProfile MaxVelocity (a launcher's MaximumVelocity, a thrown weapon's from your Strength): its range. */
  maxVelocity?: number;
}

/**
 * An object's public description (its CreateObject weenie header and the server's later updates of it), as the
 * client keeps it for a carried item (InventoryItem) or a world object (ServerObject). A field the header did not
 * carry is undefined or 0.
 */
export interface PublicDescription {
  itemType?: number; usable?: number; validLocations?: number; currentWieldedLocation?: number; clothingPriority?: number;
  stackSize?: number; maxStackSize?: number; itemsCapacity?: number; containersCapacity?: number; ammoType?: number;
  uiEffects?: number; combatUse?: number; targetType?: number; value?: number; burden?: number; structure?: number;
  maxStructure?: number; materialType?: number; cooldownId?: number; cooldownDuration?: number; spellDid?: number;
  iconDid?: number; iconOverlayDid?: number; iconUnderlayDid?: number;
}

/** Header field → PropertyInt (ACE WorldObject_Networking.cs SerializeCreateObject; written only when the object has it). */
const PUBLIC_INTS: Array<[keyof PublicDescription, number]> = [
  ['itemType', 1], ['clothingPriority', 4], ['burden', 5], ['itemsCapacity', 6], ['containersCapacity', 7], ['validLocations', 9],
  ['currentWieldedLocation', 10], ['maxStackSize', 11], ['stackSize', 12], ['usable', 16], ['uiEffects', 18], ['value', 19],
  ['ammoType', 50], ['combatUse', 51], ['maxStructure', 91], ['targetType', 94], ['materialType', 131], ['cooldownId', 280],
];
/** Header field → PropertyDataId (Spell is the header's ushort; the icons its packed DataIDs). */
const PUBLIC_DIDS: Array<[keyof PublicDescription, number]> = [['iconDid', 8], ['spellDid', 28], ['iconOverlayDid', 50], ['iconUnderlayDid', 52]];

/**
 * The record with the public description's fields where the examination's tables have none. A 0 is a field the
 * header left out, except Structure 0 of a MaxStructure (an essence or kit with no uses left).
 */
export function withPublicDescription(rec: AgentAppraisal, pub: PublicDescription | null | undefined): AgentAppraisal {
  if (!pub) return rec;
  const int = { ...rec.int };
  const did = { ...rec.did };
  const float = { ...rec.float };
  for (const [k, id] of PUBLIC_INTS) { const v = pub[k]; if (v) int[id] ??= v; }
  if (pub.structure !== undefined && (pub.structure || pub.maxStructure)) int[92] ??= pub.structure;
  for (const [k, id] of PUBLIC_DIDS) { const v = pub[k]; if (v) did[id] ??= v; }
  if (pub.cooldownDuration) float[167] ??= pub.cooldownDuration;
  return { ...rec, int, did, float };
}
