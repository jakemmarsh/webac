/**
 * CombatManeuverTableSelection — resolves which portal.dat CombatManeuverTable
 * (0x30xxxxxx) DID governs the local player's melee/missile swing animations.
 *
 * ACE ships this as `PropertyDataId.CombatTable` (=4,
 * `reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyDataId.cs:16`),
 * `[SendOnLogin]` and set once per character by
 * `reference/ACE/Source/ACE.Server/Factories/PlayerFactory.cs:59` from the
 * heritage's `CharacterGenerator.Sex.CombatTable`. The 11 humanoid heritages
 * all use 0x30000000, but Olthoi (0x30000001) and OlthoiAcid (0x30000038)
 * have their own tables (verified via a dat-parser dump of
 * CharacterGenerator). BUG.combat-table-did-login-ignored: the client parsed
 * this DID at login but never looked it up, hardcoding 0x30000000 for every
 * character.
 */

/** The 11 humanoid heritages' shared CombatManeuverTable. */
export const DEFAULT_COMBAT_TABLE_DID = 0x30000000;

/**
 * Resolve the CombatManeuverTable DID to load for the local player, given
 * the server-sourced DID (playerState.combatTableId, seeded from the login
 * PlayerDescription's propertiesDataId map). Falls back to the humanoid
 * default when unset (e.g. before login data has arrived).
 */
export function resolveCombatManeuverTableDid(combatTableId: number | undefined): number {
  return combatTableId ? combatTableId : DEFAULT_COMBAT_TABLE_DID;
}
