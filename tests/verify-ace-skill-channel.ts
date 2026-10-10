/**
 * FAITHFUL.55 — pin Skill + Channel + AccessLevel ports byte-for-byte.
 *
 * Anchored to:
 *   reference/ACE/Source/ACE.Entity/Enum/Skill.cs
 *   reference/ACE/Source/ACE.Entity/Enum/Channel.cs
 *   reference/ACE/Source/ACE.Entity/Enum/AccessLevel.cs
 *
 * ACE Skill.cs starts the enum at "None" with implicit value 0 and increments
 * by 1. The enum is SEQUENTIAL and the comment is unusually emphatic:
 * "even though these are unnumbered, order is very important. values of
 * 'none' or commented as retired or unused --ABSOLUTELY CANNOT-- be removed."
 * So we test specific boundary values (None=0, MeleeDefense=6, ArcaneLore=14,
 * WarMagic=34, Summoning=54) to guarantee any future insertion that shifts
 * the table will trip these assertions.
 */
import { describe, it, expect } from 'vitest';
import {
  SkillId, skillIdLabel,
  RETIRED_MELEE_SKILLS, RETIRED_MISSILE_SKILLS, RETIRED_WEAPON_SKILLS,
  UNIMPLEMENTED_SKILLS,
  Channel, CHANNEL_ALL_CHANS,
  AccessLevel, accessLevelLabel,
} from '@ac/shared';

describe('SkillId (per ACE Skill.cs sequential layout)', () => {
  it('None is 0 (load-bearing)', () => {
    expect(SkillId.None).toBe(0);
  });

  it('Retired melee block: Axe=1, Bow=2, Crossbow=3, Dagger=4, Mace=5', () => {
    expect(SkillId.Axe).toBe(1);
    expect(SkillId.Bow).toBe(2);
    expect(SkillId.Crossbow).toBe(3);
    expect(SkillId.Dagger).toBe(4);
    expect(SkillId.Mace).toBe(5);
  });

  it('Active defense block: MeleeDefense=6, MissileDefense=7', () => {
    expect(SkillId.MeleeDefense).toBe(6);
    expect(SkillId.MissileDefense).toBe(7);
  });

  it('Active casting: ArcaneLore=14, MagicDefense=15, ManaConversion=16', () => {
    expect(SkillId.ArcaneLore).toBe(14);
    expect(SkillId.MagicDefense).toBe(15);
    expect(SkillId.ManaConversion).toBe(16);
  });

  it('Late entries: WarMagic=34, VoidMagic=43, Summoning=54 (the tail of the enum)', () => {
    expect(SkillId.WarMagic).toBe(34);
    expect(SkillId.VoidMagic).toBe(43);
    expect(SkillId.Summoning).toBe(54);
  });

  it('Modern weapon skills: HeavyWeapons=44, LightWeapons=45, FinesseWeapons=46, MissileWeapons=47', () => {
    expect(SkillId.HeavyWeapons).toBe(44);
    expect(SkillId.LightWeapons).toBe(45);
    expect(SkillId.FinesseWeapons).toBe(46);
    expect(SkillId.MissileWeapons).toBe(47);
  });

  it('RetiredMelee matches SkillExtensions.RetiredMelee', () => {
    expect([...RETIRED_MELEE_SKILLS]).toEqual([
      SkillId.Axe, SkillId.Dagger, SkillId.Mace, SkillId.Spear, SkillId.Staff,
      SkillId.Sword, SkillId.UnarmedCombat,
    ]);
  });

  it('RetiredMissile matches SkillExtensions.RetiredMissile', () => {
    expect([...RETIRED_MISSILE_SKILLS]).toEqual([
      SkillId.Bow, SkillId.Crossbow, SkillId.Sling, SkillId.ThrownWeapon,
    ]);
  });

  it('RetiredWeapons = RetiredMelee ∪ RetiredMissile', () => {
    expect(RETIRED_WEAPON_SKILLS.length).toBe(RETIRED_MELEE_SKILLS.length + RETIRED_MISSILE_SKILLS.length);
    for (const s of RETIRED_MELEE_SKILLS) expect(RETIRED_WEAPON_SKILLS).toContain(s);
    for (const s of RETIRED_MISSILE_SKILLS) expect(RETIRED_WEAPON_SKILLS).toContain(s);
  });

  it('Unimplemented skills list matches ACE /* Unimplemented */ comments', () => {
    expect([...UNIMPLEMENTED_SKILLS]).toEqual([
      SkillId.Spellcraft, SkillId.Awareness,
      SkillId.ArmsAndArmorRepair, SkillId.Challenge,
    ]);
  });

  it('label helper inserts AC-style spaces (MeleeDefense → "Melee Defense")', () => {
    expect(skillIdLabel(SkillId.MeleeDefense)).toBe('Melee Defense');
    expect(skillIdLabel(SkillId.MissileDefense)).toBe('Missile Defense');
    expect(skillIdLabel(SkillId.ManaConversion)).toBe('Mana Conversion');
    expect(skillIdLabel(SkillId.WarMagic)).toBe('War Magic');
    expect(skillIdLabel(SkillId.LifeMagic)).toBe('Life Magic');
    expect(skillIdLabel(SkillId.FinesseWeapons)).toBe('Finesse Weapons');
    expect(skillIdLabel(SkillId.DualWield)).toBe('Dual Wield');
  });

  it('label helper handles single-word skills', () => {
    expect(skillIdLabel(SkillId.Healing)).toBe('Healing');
    expect(skillIdLabel(SkillId.Jump)).toBe('Jump');
    expect(skillIdLabel(SkillId.Run)).toBe('Run');
    expect(skillIdLabel(SkillId.Alchemy)).toBe('Alchemy');
  });
});

describe('Channel (per ACE Channel.cs Flags enum)', () => {
  it('admin tier: Undef=0, Abuse=1, Admin=2, Audit=4', () => {
    expect(Channel.Undef).toBe(0x00000000);
    expect(Channel.Abuse).toBe(0x00000001);
    expect(Channel.Admin).toBe(0x00000002);
    expect(Channel.Audit).toBe(0x00000004);
  });

  it('Advocate1/2/3 = 8/16/32; QA1/QA2 = 64/128; Debug=256; Sentinel=512; Help=1024', () => {
    expect(Channel.Advocate1).toBe(0x00000008);
    expect(Channel.Advocate2).toBe(0x00000010);
    expect(Channel.Advocate3).toBe(0x00000020);
    expect(Channel.QA1).toBe(0x00000040);
    expect(Channel.QA2).toBe(0x00000080);
    expect(Channel.Debug).toBe(0x00000100);
    expect(Channel.Sentinel).toBe(0x00000200);
    expect(Channel.Help).toBe(0x00000400);
  });

  it('player social: Fellow=2048, Vassals=4096, Patron=8192, Monarch=16384', () => {
    expect(Channel.Fellow).toBe(0x00000800);
    expect(Channel.Vassals).toBe(0x00001000);
    expect(Channel.Patron).toBe(0x00002000);
    expect(Channel.Monarch).toBe(0x00004000);
  });

  it('town channels: 9 distinct towns at 0x8000–0x800000', () => {
    expect(Channel.AlArqas).toBe(0x00008000);
    expect(Channel.Holtburg).toBe(0x00010000);
    expect(Channel.Lytelthorpe).toBe(0x00020000);
    expect(Channel.Nanto).toBe(0x00040000);
    expect(Channel.Rithwic).toBe(0x00080000);
    expect(Channel.Samsur).toBe(0x00100000);
    expect(Channel.Shoushi).toBe(0x00200000);
    expect(Channel.Yanshi).toBe(0x00400000);
    expect(Channel.Yaraq).toBe(0x00800000);
  });

  it('TownChans aggregate = 0x00FF8000 (union of 9 town flags)', () => {
    expect(Channel.TownChans).toBe(0x00FF8000);
    // Verify it really is the union of the 9 town flags:
    const computed =
      Channel.AlArqas | Channel.Holtburg | Channel.Lytelthorpe | Channel.Nanto |
      Channel.Rithwic | Channel.Samsur | Channel.Shoushi | Channel.Yanshi | Channel.Yaraq;
    expect(computed).toBe(Channel.TownChans);
  });

  it('high-bit channels: CoVassals=0x01000000 … Olthoi=0x40000000', () => {
    expect(Channel.CoVassals).toBe(0x01000000);
    expect(Channel.AllegianceBroadcast).toBe(0x02000000);
    expect(Channel.FellowBroadcast).toBe(0x04000000);
    expect(Channel.SocietyCelHanBroadcast).toBe(0x08000000);
    expect(Channel.SocietyEldWebBroadcast).toBe(0x10000000);
    expect(Channel.SocietyRadBloBroadcast).toBe(0x20000000);
    expect(Channel.Olthoi).toBe(0x40000000);
  });

  it('GhostChans + AllChans aggregates', () => {
    expect(Channel.GhostChans).toBe(0x7F007800);
    expect(CHANNEL_ALL_CHANS).toBe(0x7F007F3F);
  });

  it('AllBroadcast=0x00000401 = Help | Abuse', () => {
    expect(Channel.AllBroadcast).toBe(Channel.Help | Channel.Abuse);
  });

  it('ValidChans=0x0000073F covers admin tier + advocate + QA + Debug + Sentinel + Help', () => {
    expect(Channel.ValidChans).toBe(0x0000073F);
  });
});

describe('AccessLevel (per ACE AccessLevel.cs)', () => {
  it('sequential 0-5', () => {
    expect(AccessLevel.Player).toBe(0);
    expect(AccessLevel.Advocate).toBe(1);
    expect(AccessLevel.Sentinel).toBe(2);
    expect(AccessLevel.Envoy).toBe(3);
    expect(AccessLevel.Developer).toBe(4);
    expect(AccessLevel.Admin).toBe(5);
  });

  it('label helper returns the enum-key name', () => {
    expect(accessLevelLabel(AccessLevel.Player)).toBe('Player');
    expect(accessLevelLabel(AccessLevel.Admin)).toBe('Admin');
    expect(accessLevelLabel(AccessLevel.Sentinel)).toBe('Sentinel');
  });
});
