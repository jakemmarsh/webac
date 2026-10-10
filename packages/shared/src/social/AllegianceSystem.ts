/**
 * AllegianceSystem — allegiance rank titles for display.
 *
 * The hierarchy and XP passup are server-authoritative (ACE.Server/Entity/
 * AllegianceNode.cs, Managers/AllegianceManager.cs); the client renders
 * the AllegianceUpdate ACE ships.
 */

// ─── Constants ──────────────────────────────────────────────

export const MAX_RANK = 10;

// ─── Heritage Rank Titles ──────────────────────────────────

// HeritageGroup is the canonical ACE-anchored enum (Invalid=0..OlthoiAcid=13).
// Previously a duplicate enum was declared here missing Invalid, Olthoi, OlthoiAcid.
import { Heritage as HeritageGroup } from '../character/Heritage.js';
export { HeritageGroup };

export interface RankTitles {
  male: string[];
  female: string[];
}

/**
 * Heritage-specific allegiance rank titles (ranks 1-10).
 *
 * Ported 1:1 from reference/ACE/Source/ACE.Server/Entity/AllegianceRank.cs
 * (static class `AllegianceTitle` — GetAluvianMaleTitle … GetUndeadFemaleTitle).
 * Penumbraen reuses the Shadowbound tables (ACE routes both through
 * GetShadowbound{Male,Female}Title). Gearknight/Tumerok/Lugian are
 * gender-neutral in ACE (single GetXTitle) — male/female are identical here.
 *
 * FAITHFUL: the pre-fix table had FABRICATED titles for 7 heritages —
 * Shadowbound/Penumbraen ("Penumbral/Umbral/Obsidian…"), Gearknight
 * ("Apprent./Journeym./Craftsman…"), Tumerok ("Xik/Xire/Xar…"), Lugian
 * ("Raetus…Kolos/Titan/Tharax"), Empyrean (NPC names "Aerfalle/Aerbax/
 * Asheron…"), and Undead (rank ≥5 "Lictor/Praetor/Consul…"). Several also
 * dropped the per-gender variants ACE defines (Shadowbound Void Lord/Lady,
 * Empyrean Ipharsin/Ipharsia + Aulin/Aulia, Undead Count/Countess +
 * Viscount/Viscountess). All corrected against AllegianceRank.cs.
 */
export const HERITAGE_RANK_TITLES: Record<number, RankTitles> = {
  [HeritageGroup.Aluvian]: {
    male:   ['Yeoman', 'Baronet', 'Baron', 'Reeve', 'Thane', 'Ealdor', 'Duke', 'Aetheling', 'King', 'High King'],
    female: ['Yeoman', 'Baronet', 'Baroness', 'Reeve', 'Thane', 'Ealdor', 'Duchess', 'Aetheling', 'Queen', 'High Queen'],
  },
  [HeritageGroup.Gharundim]: {
    male:   ['Sayyid', 'Shayk', 'Maulan', "Mu'allim", 'Naquib', 'Qadi', 'Mushir', 'Amir', 'Malik', 'Sultan'],
    female: ['Sayyida', 'Shayka', 'Maulana', "Mu'allima", 'Naquiba', 'Qadiya', 'Mushira', 'Amira', 'Malika', 'Sultana'],
  },
  [HeritageGroup.Sho]: {
    male:   ['Jinin', 'Jo-chueh', 'Nan-chueh', 'Shi-chueh', 'Ta-chueh', 'Kun-chueh', 'Kou', 'Taikou', 'Ou', 'Koutei'],
    female: ['Jinin', 'Jo-chueh', 'Nan-chueh', 'Shi-chueh', 'Ta-chueh', 'Kun-chueh', 'Kou', 'Taikou', 'Jo-ou', 'Koutei'],
  },
  [HeritageGroup.Viamontian]: {
    male:   ['Squire', 'Banner', 'Baron', 'Viscount', 'Count', 'Marquis', 'Duke', 'Grand Duke', 'King', 'High King'],
    female: ['Dame', 'Banner', 'Baroness', 'Viscountess', 'Countess', 'Marquise', 'Duchess', 'Grand Duchess', 'Queen', 'High Queen'],
  },
  [HeritageGroup.Shadowbound]: {
    male:   ['Tenebrous', 'Shade', 'Squire', 'Knight', 'Void Knight', 'Void Lord', 'Duke', 'Archduke', 'Highborn', 'King'],
    female: ['Tenebrous', 'Shade', 'Squire', 'Knight', 'Void Knight', 'Void Lady', 'Duchess', 'Archduchess', 'Highborn', 'Queen'],
  },
  [HeritageGroup.Penumbraen]: {
    male:   ['Tenebrous', 'Shade', 'Squire', 'Knight', 'Void Knight', 'Void Lord', 'Duke', 'Archduke', 'Highborn', 'King'],
    female: ['Tenebrous', 'Shade', 'Squire', 'Knight', 'Void Knight', 'Void Lady', 'Duchess', 'Archduchess', 'Highborn', 'Queen'],
  },
  [HeritageGroup.Gearknight]: {
    male:   ['Tribunus', 'Praefectus', 'Optio', 'Centurion', 'Principes', 'Legatus', 'Consul', 'Dux', 'Secondus', 'Primus'],
    female: ['Tribunus', 'Praefectus', 'Optio', 'Centurion', 'Principes', 'Legatus', 'Consul', 'Dux', 'Secondus', 'Primus'],
  },
  [HeritageGroup.Tumerok]: {
    male:   ['Xutua', 'Tuona', 'Ona', 'Nuona', 'Turea', 'Rea', 'Nurea', 'Kauh', 'Sutah', 'Tah'],
    female: ['Xutua', 'Tuona', 'Ona', 'Nuona', 'Turea', 'Rea', 'Nurea', 'Kauh', 'Sutah', 'Tah'],
  },
  [HeritageGroup.Lugian]: {
    male:   ['Laigus', 'Raigus', 'Amploth', 'Arintoth', 'Obeloth', 'Lithos', 'Kantos', 'Gigas', 'Extas', 'Tiatus'],
    female: ['Laigus', 'Raigus', 'Amploth', 'Arintoth', 'Obeloth', 'Lithos', 'Kantos', 'Gigas', 'Extas', 'Tiatus'],
  },
  [HeritageGroup.Empyrean]: {
    male:   ['Ensign', 'Corporal', 'Lieutenant', 'Commander', 'Captain', 'Commodore', 'Admiral', 'Warlord', 'Ipharsin', 'Aulin'],
    female: ['Ensign', 'Corporal', 'Lieutenant', 'Commander', 'Captain', 'Commodore', 'Admiral', 'Warlord', 'Ipharsia', 'Aulia'],
  },
  [HeritageGroup.Undead]: {
    male:   ['Neophyte', 'Acolyte', 'Adept', 'Esquire', 'Squire', 'Knight', 'Count', 'Viscount', 'Highness', 'Annointed'],
    female: ['Neophyte', 'Acolyte', 'Adept', 'Esquire', 'Squire', 'Knight', 'Countess', 'Viscountess', 'Highness', 'Annointed'],
  },
};

/**
 * Resolve the allegiance rank title word for a heritage + gender + rank,
 * matching ACE `AllegianceTitle.GetTitle(HeritageGroup, Gender, uint rank)`.
 *
 * Returns '' (empty) for rank 0 / out-of-range ranks and for heritages
 * without an allegiance title table (e.g. Olthoi) — exactly as the ACE
 * per-heritage switches return "" for their default case. The UI suppresses
 * the title prefix when this is empty.
 *
 * @param heritage HeritageGroup enum value (1=Aluvian … 11=Undead)
 * @param gender   Gender enum value (1=Male, 2=Female)
 * @param rank     allegiance rank (1-10)
 */
export function getAllegianceRankTitle(heritage: number, gender: number, rank: number): string {
  const titles = HERITAGE_RANK_TITLES[heritage];
  if (!titles || rank < 1 || rank > MAX_RANK) return '';
  // ACE Gender: 1=Male, 2=Female; anything else returns "" in GetTitle.
  if (gender !== 1 && gender !== 2) return '';
  const list = gender === 2 ? titles.female : titles.male;
  return list[rank - 1] ?? '';
}
