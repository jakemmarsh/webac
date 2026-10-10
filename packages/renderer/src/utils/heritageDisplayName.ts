/**
 * FAITHFUL.285 follow-up — heritage display-name table used everywhere the
 * UI shows a heritage name (character panel, item-level/heritage-lock rows,
 * wield requirements).
 *
 * `HeritageGroupCG.name` (from portal.dat's CharacterGenerator, 0x0E000002)
 * is a short *internal* string, not retail wording — for 4 of 13 heritages
 * it's outright truncated/enum-like: Gearknight -> "Gear", Tumerok ->
 * "Tumerok", Olthoi -> "Olthoi", OlthoiAcid -> "OlthoiAcid". A 5th,
 * Shadowbound, is internally correct-looking ("Shadowbound") but not the
 * retail-displayed name either. This table holds the canonical retail
 * wording for all 13 heritages, verified against
 * `client_local_English.dat` StringTable 0x23000002 (see
 * tests/verify-heritage-display-name.ts's DAT-verification block) and
 * upstream ACE's `HeritageGroupExtensions.ToSentence()`.
 *
 * `resolveHeritageDisplayName()` therefore prefers this table over the raw
 * DAT name for every known heritage id, and only falls back to the raw DAT
 * name for an id this table doesn't recognize.
 */

import { Heritage } from '@ac/shared';

export const HERITAGE_DISPLAY_NAME_FALLBACK: Record<number, string> = {
  [Heritage.Aluvian]: 'Aluvian',
  [Heritage.Gharundim]: "Gharu'ndim",
  [Heritage.Sho]: 'Sho',
  [Heritage.Viamontian]: 'Viamontian',
  [Heritage.Shadowbound]: 'Umbraen',
  [Heritage.Gearknight]: 'Gear Knight',
  [Heritage.Tumerok]: 'Aun Tumerok',
  [Heritage.Lugian]: 'Lugian',
  [Heritage.Empyrean]: 'Empyrean',
  [Heritage.Penumbraen]: 'Penumbraen',
  [Heritage.Undead]: 'Undead',
  [Heritage.Olthoi]: 'Olthoi Soldier',
  [Heritage.OlthoiAcid]: 'Olthoi Spitter',
};

/**
 * Prefers the retail-wording table above; falls back to the DAT-loaded name
 * only for a heritage id the table doesn't recognize, and to "Unknown" if
 * neither is available.
 */
export function resolveHeritageDisplayName(heritage: number, datHeritageName: string | undefined): string {
  return HERITAGE_DISPLAY_NAME_FALLBACK[heritage] ?? datHeritageName ?? 'Unknown';
}
