/**
 * MaterialType numeric IDs must match ACE.Entity.Enum.MaterialType.cs exactly,
 * because the server sends these IDs over the wire in IdentifyResponse,
 * GameEventSalvageOperationsResult, and ChatMessage embeds.
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/MaterialType.cs
 */
import { describe, it, expect } from 'vitest';
import { MaterialType, MATERIAL_NAMES, getMaterialName } from '@ac/shared';

describe('MaterialType ACE-anchored numeric IDs', () => {
  it('canonical metals match ACE source', () => {
    expect(MaterialType.Brass).toBe(0x39);
    expect(MaterialType.Bronze).toBe(0x3A);
    expect(MaterialType.Copper).toBe(0x3B);
    expect(MaterialType.Gold).toBe(0x3C);
    expect(MaterialType.Iron).toBe(0x3D);
    expect(MaterialType.Pyreal).toBe(0x3E);
    expect(MaterialType.Silver).toBe(0x3F);
    expect(MaterialType.Steel).toBe(0x40);
  });

  it('canonical stones match ACE source', () => {
    expect(MaterialType.Alabaster).toBe(0x42);
    expect(MaterialType.Granite).toBe(0x43);
    expect(MaterialType.Marble).toBe(0x44);
    expect(MaterialType.Obsidian).toBe(0x45);
    expect(MaterialType.Sandstone).toBe(0x46);
    expect(MaterialType.Serpentine).toBe(0x47);
  });

  it('canonical woods match ACE source', () => {
    expect(MaterialType.Ebony).toBe(0x49);
    expect(MaterialType.Mahogany).toBe(0x4A);
    expect(MaterialType.Oak).toBe(0x4B);
    expect(MaterialType.Pine).toBe(0x4C);
    expect(MaterialType.Teak).toBe(0x4D);
  });

  it('canonical category buckets match ACE source', () => {
    // ACE has "Cloth", "Gem", "Metal", "Stone", "Wood" as category buckets,
    // not just individual entries.
    expect(MaterialType.Cloth).toBe(0x03);
    expect(MaterialType.Gem).toBe(0x09);
    expect(MaterialType.Metal).toBe(0x38);
    expect(MaterialType.Stone).toBe(0x41);
    expect(MaterialType.Wood).toBe(0x48);
  });

  it('Azurite (previously missing) is present at correct ID', () => {
    // Regression: the old enum skipped Azurite, shifting all subsequent IDs by 1.
    expect(MaterialType.Azurite).toBe(0x0E);
  });

  it('getMaterialName returns AC display names', () => {
    expect(getMaterialName(MaterialType.Steel)).toBe('Steel');
    expect(getMaterialName(MaterialType.BlackGarnet)).toBe('Black Garnet');
    expect(getMaterialName(MaterialType.WhiteSapphire)).toBe('White Sapphire');
    expect(getMaterialName(MaterialType.Pyreal)).toBe('Pyreal');
    expect(getMaterialName(MaterialType.ReedSharkHide)).toBe('Reed Shark Hide');
    expect(getMaterialName(MaterialType.LavenderJade)).toBe('Lavender Jade');
  });

  it('getMaterialName falls back gracefully for unknown IDs', () => {
    expect(getMaterialName(999)).toBe('Material 999');
    expect(getMaterialName(0)).toBe('Unknown');
  });

  it('every numeric ID in the enum has a name in MATERIAL_NAMES', () => {
    // Iterate over numeric enum values (TypeScript reverse-mapping skipped — only the numeric forward direction).
    for (const k of Object.keys(MaterialType)) {
      const num = Number(k);
      if (!Number.isFinite(num)) continue;
      expect(MATERIAL_NAMES[num]).toBeTruthy();
    }
  });
});

// Pinning the other ACE-anchored enums fixed in FAITHFUL.4. These are not
// MaterialType but live in the same test file because the bug pattern is identical.
import { Gender, WeaponType, ItemType, CreatureType } from '@ac/shared';

describe('Gender enum ACE-anchored', () => {
  // Anchored against reference/ACE/Source/ACE.Entity/Enum/Gender.cs.
  // Before FAITHFUL.4 the client had Female=0 + Male=1 (no Invalid).
  // The server sends 1=Male, 2=Female on the wire in PlayerDescription/chargen.
  it('matches ACE values exactly', () => {
    expect(Gender.Invalid).toBe(0);
    expect(Gender.Male).toBe(1);
    expect(Gender.Female).toBe(2);
  });
});

describe('WeaponType enum ACE-anchored', () => {
  // Anchored against reference/ACE/Source/ACE.Entity/Enum/WeaponType.cs.
  // Before FAITHFUL.4 the client had Mace=3 / Axe=4 (swapped) and Spear=12 (vs ACE 5).
  // Server sends WeaponType in PropertyInt.WeaponType for damage/mastery checks.
  it('matches ACE order: Undef, Unarmed, Sword, Axe, Mace, Spear, Dagger, …', () => {
    expect(WeaponType.Undef).toBe(0);
    expect(WeaponType.Unarmed).toBe(1);
    expect(WeaponType.Sword).toBe(2);
    expect(WeaponType.Axe).toBe(3);
    expect(WeaponType.Mace).toBe(4);
    expect(WeaponType.Spear).toBe(5);
    expect(WeaponType.Dagger).toBe(6);
    expect(WeaponType.Staff).toBe(7);
    expect(WeaponType.Bow).toBe(8);
    expect(WeaponType.Crossbow).toBe(9);
    expect(WeaponType.Thrown).toBe(10);
    expect(WeaponType.TwoHanded).toBe(11);
    expect(WeaponType.Magic).toBe(12);
  });
});

describe('ItemType enum ACE-anchored', () => {
  // Before FAITHFUL.4 Gameboard was missing. ACE has it at the high bit.
  it('Gameboard is at 0x80000000', () => {
    expect(ItemType.Gameboard).toBe(0x80000000);
  });

  it('flag bits are byte-identical to ACE Flags enum', () => {
    expect(ItemType.MeleeWeapon).toBe(0x00000001);
    expect(ItemType.Container).toBe(0x00000200);
    expect(ItemType.LifeStone).toBe(0x10000000);
    expect(ItemType.TinkeringTool).toBe(0x20000000);
    expect(ItemType.TinkeringMaterial).toBe(0x40000000);
    expect(ItemType.Gameboard).toBe(0x80000000);
  });
});

describe('CombatMode enum ACE-anchored', () => {
  // Before FAITHFUL.5 the client was missing Undef=0 (the explicit "no mode set").
  it('matches ACE flag values exactly', async () => {
    const { CombatMode } = await import('@ac/shared');
    expect(CombatMode.Undef).toBe(0x00);
    expect(CombatMode.NonCombat).toBe(0x01);
    expect(CombatMode.Melee).toBe(0x02);
    expect(CombatMode.Missile).toBe(0x04);
    expect(CombatMode.Magic).toBe(0x08);
  });
});

describe('HeritageGroup (re-exported from Heritage) ACE-anchored', () => {
  // Before FAITHFUL.5 AllegianceSystem.ts had a duplicate HeritageGroup enum
  // missing Invalid=0, Olthoi=12, OlthoiAcid=13.
  it('matches Heritage enum exactly', async () => {
    const { HeritageGroup, Heritage } = await import('@ac/shared');
    expect(HeritageGroup).toBe(Heritage);
    expect(HeritageGroup.Invalid).toBe(0);
    expect(HeritageGroup.Olthoi).toBe(12);
    expect(HeritageGroup.OlthoiAcid).toBe(13);
  });
});

describe('CreatureType enum ACE-anchored', () => {
  // Before FAITHFUL.4 Rockslide (43) was missing and 20+ later additions
  // (Elemental, Statue, Wall, AlteredHuman, Device, Harbinger, DarkSarcophagus,
  // Chicken, Margul, BleachedRabbit, NastyRabbit, GrimacingRabbit, Target,
  // Ghost, Fiun, Eater, Ruschk, Thrungus, ViamontianKnight, Sleech, Food,
  // Harvest, Energy, Apparition, Aerbax, Touched, BlightedMoarsman, GearKnight,
  // Anekshay) were absent. Every ID ≥ 43 was off by 1+.
  it('Rockslide is at 43 (formerly missing)', () => {
    expect(CreatureType.Rockslide).toBe(43);
  });

  it('Anekshay is at 101 (final entry per ACE source)', () => {
    expect(CreatureType.Anekshay).toBe(101);
  });

  it('key spot-checks match ACE positions', () => {
    expect(CreatureType.Olthoi).toBe(1);
    expect(CreatureType.Human).toBe(31);
    expect(CreatureType.LightningElemental).toBe(42);
    expect(CreatureType.Chicken).toBe(69);
    expect(CreatureType.Sleech).toBe(88);  // ACE name (was 'SleechClaw' before fix)
    expect(CreatureType.Food).toBe(91);    // ACE name (was 'FoodStuff' before fix)
    expect(CreatureType.GearKnight).toBe(99);
  });
});
