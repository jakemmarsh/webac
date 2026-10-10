/**
 * SpellApplication — the PropertyAttribute ids enchantment stat keys carry.
 *
 * Building enchantments from spells is server-authoritative (ACE
 * EnchantmentManager.BuildEntry, WorldObject_Magic.cs); the client only
 * decodes the registry ACE ships.
 */

// ─── Property Keys ──────────────────────────────────────────

/** ACE PropertyAttribute — primary attributes */
export enum PropertyAttribute {
  Strength     = 1,
  Endurance    = 2,
  Quickness    = 3,
  Coordination = 4,
  Focus        = 5,
  Self         = 6,
}
