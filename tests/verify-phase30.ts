/**
 * Phase 30 — Allegiance display tests
 *
 * Tests the heritage rank titles the allegiance panel renders. The
 * allegiance tree, XP passup and fellowship XP sharing are
 * server-authoritative (ACE AllegianceNode.cs / Fellowship.cs); the local
 * simulations of them were never reachable from shipped code and were
 * deleted (DEBT.shared-dead-server-logic).
 */
import { describe, it, expect } from 'vitest';
import {
  HeritageGroup, MAX_RANK, HERITAGE_RANK_TITLES, getAllegianceRankTitle,
} from '@ac/shared';

// ═════════════════════════════════════════════════════════════
// ALLEGIANCE SYSTEM
// ═════════════════════════════════════════════════════════════

describe('Allegiance — Constants', () => {
  it('MAX_RANK = 10', () => expect(MAX_RANK).toBe(10));
});

describe('Allegiance — Heritage Rank Titles', () => {
  it('has all core heritages', () => {
    expect(HERITAGE_RANK_TITLES[HeritageGroup.Aluvian]).toBeDefined();
    expect(HERITAGE_RANK_TITLES[HeritageGroup.Gharundim]).toBeDefined();
    expect(HERITAGE_RANK_TITLES[HeritageGroup.Sho]).toBeDefined();
    expect(HERITAGE_RANK_TITLES[HeritageGroup.Viamontian]).toBeDefined();
  });

  it('each heritage has 10 male and 10 female titles', () => {
    for (const [, titles] of Object.entries(HERITAGE_RANK_TITLES)) {
      expect(titles.male.length).toBe(10);
      expect(titles.female.length).toBe(10);
    }
  });

  it('Aluvian male rank 1 = Yeoman, rank 10 = High King', () => {
    expect(HERITAGE_RANK_TITLES[HeritageGroup.Aluvian].male[0]).toBe('Yeoman');
    expect(HERITAGE_RANK_TITLES[HeritageGroup.Aluvian].male[9]).toBe('High King');
  });

  it('Aluvian female rank 9 = Queen', () => {
    expect(HERITAGE_RANK_TITLES[HeritageGroup.Aluvian].female[8]).toBe('Queen');
  });

  it('Gharundim male rank 10 = Sultan', () => {
    expect(HERITAGE_RANK_TITLES[HeritageGroup.Gharundim].male[9]).toBe('Sultan');
  });

  it('Sho male rank 10 = Koutei', () => {
    expect(HERITAGE_RANK_TITLES[HeritageGroup.Sho].male[9]).toBe('Koutei');
  });

  it('Viamontian female rank 1 = Dame', () => {
    expect(HERITAGE_RANK_TITLES[HeritageGroup.Viamontian].female[0]).toBe('Dame');
  });
});

describe('Allegiance — Heritage Rank Titles vs ACE AllegianceRank.cs (anti-fabrication)', () => {
  // Pins the FULL ranks-1..10 tables against
  // reference/ACE/Source/ACE.Server/Entity/AllegianceRank.cs. The pre-fix
  // table had FABRICATED titles for 7 heritages (Shadowbound/Penumbraen
  // "Penumbral/Umbral/Obsidian…", Gearknight "Apprent./Journeym.…", Tumerok
  // "Xik/Xire/Xar…", Lugian "Raetus…Titan/Tharax", Empyrean NPC-names
  // "Aerfalle/Aerbax/Asheron…", Undead rank≥5 "Lictor/Praetor/Consul…").
  const ACE_TITLES: Record<number, { male: string[]; female: string[] }> = {
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

  for (const [hg, exp] of Object.entries(ACE_TITLES)) {
    const heritage = Number(hg);
    it(`heritage ${heritage}: all 10 male + 10 female titles match AllegianceRank.cs`, () => {
      expect(HERITAGE_RANK_TITLES[heritage].male).toEqual(exp.male);
      expect(HERITAGE_RANK_TITLES[heritage].female).toEqual(exp.female);
    });
  }

  it('guards against re-introducing the fabricated Empyrean NPC-name titles', () => {
    const m = HERITAGE_RANK_TITLES[HeritageGroup.Empyrean].male;
    expect(m).not.toContain('Aerfalle');
    expect(m).not.toContain('Asheron');
    expect(m[0]).toBe('Ensign');
  });
});

describe('getAllegianceRankTitle — ACE AllegianceTitle.GetTitle port', () => {
  const Male = 1, Female = 2;
  it('Viamontian male rank 1 = Squire (the VISUAL3.43 example)', () => {
    expect(getAllegianceRankTitle(HeritageGroup.Viamontian, Male, 1)).toBe('Squire');
  });
  it('routes gender correctly (Viamontian female rank 1 = Dame)', () => {
    expect(getAllegianceRankTitle(HeritageGroup.Viamontian, Female, 1)).toBe('Dame');
  });
  it('Shadowbound female rank 6 = Void Lady (gender-specific)', () => {
    expect(getAllegianceRankTitle(HeritageGroup.Shadowbound, Female, 6)).toBe('Void Lady');
    expect(getAllegianceRankTitle(HeritageGroup.Shadowbound, Male, 6)).toBe('Void Lord');
  });
  it('Empyrean female rank 9/10 = Ipharsia/Aulia (gender-specific tail)', () => {
    expect(getAllegianceRankTitle(HeritageGroup.Empyrean, Female, 9)).toBe('Ipharsia');
    expect(getAllegianceRankTitle(HeritageGroup.Empyrean, Female, 10)).toBe('Aulia');
    expect(getAllegianceRankTitle(HeritageGroup.Empyrean, Male, 9)).toBe('Ipharsin');
  });
  it('returns "" for rank 0 (no allegiance) — matches ACE default case', () => {
    expect(getAllegianceRankTitle(HeritageGroup.Aluvian, Male, 0)).toBe('');
  });
  it('returns "" for out-of-range rank (11+)', () => {
    expect(getAllegianceRankTitle(HeritageGroup.Aluvian, Male, 11)).toBe('');
  });
  it('returns "" for an unmapped heritage (Olthoi) and invalid gender', () => {
    expect(getAllegianceRankTitle(HeritageGroup.Olthoi, Male, 5)).toBe('');
    expect(getAllegianceRankTitle(HeritageGroup.Aluvian, 0, 5)).toBe('');
  });
});

describe('Allegiance — HeritageGroup Enum', () => {
  it('has correct heritage values', () => {
    expect(HeritageGroup.Aluvian).toBe(1);
    expect(HeritageGroup.Gharundim).toBe(2);
    expect(HeritageGroup.Sho).toBe(3);
    expect(HeritageGroup.Viamontian).toBe(4);
  });
});
