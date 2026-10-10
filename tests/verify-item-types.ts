/**
 * FAITHFUL.54 — pin ported ACE Entity enums byte-for-byte.
 *
 * The 5 enums in packages/shared/src/item-types.ts are anchored against:
 *   reference/ACE/Source/ACE.Entity/Enum/AmmoType.cs
 *   reference/ACE/Source/ACE.Entity/Enum/ArmorType.cs
 *   reference/ACE/Source/ACE.Entity/Enum/AttackType.cs
 *   reference/ACE/Source/ACE.Entity/Enum/AttunedStatus.cs
 *   reference/ACE/Source/ACE.Entity/Enum/BondedStatus.cs
 *
 * These values appear on the wire in IdentifyResponse (HookProfile.ammoType,
 * WeaponProfile.attackType) and on weenie property tables. Drift = bad
 * tooltip text + miscolored item categories. Tests pin the exact integer
 * values + the aliased flag unions + the AttackTypeExtensions helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  AmmoType, ammoTypeLabel,
  ArmorType, armorTypeLabel,
  AttackType, isMultiStrike, reduceMultiStrike,
  ATTACK_TYPE_UNARMED, ATTACK_TYPE_DOUBLE_STRIKE, ATTACK_TYPE_TRIPLE_STRIKE,
  ATTACK_TYPE_MULTI_STRIKE, ATTACK_TYPE_OFFHAND, ATTACK_TYPE_THRUSTS,
  ATTACK_TYPE_SLASHES, ATTACK_TYPE_PUNCHES,
  AttunedStatus, attunedStatusLabel,
  BondedStatus, bondedStatusLabel,
} from '@ac/shared';

describe('AmmoType (per ACE AmmoType.cs)', () => {
  it('Flags enum on ushort with 9 values', () => {
    expect(AmmoType.None).toBe(0);
    expect(AmmoType.Arrow).toBe(0x001);
    expect(AmmoType.Bolt).toBe(0x002);
    expect(AmmoType.Atlatl).toBe(0x004);
    expect(AmmoType.ArrowCrystal).toBe(0x008);
    expect(AmmoType.BoltCrystal).toBe(0x010);
    expect(AmmoType.AtlatlCrystal).toBe(0x020);
    expect(AmmoType.ArrowChorizite).toBe(0x040);
    expect(AmmoType.BoltChorizite).toBe(0x080);
    expect(AmmoType.AtlatlChorizite).toBe(0x100);
  });

  it('label helper covers all values', () => {
    expect(ammoTypeLabel(AmmoType.Arrow)).toBe('Arrow');
    expect(ammoTypeLabel(AmmoType.BoltCrystal)).toBe('Crystal Bolt');
    expect(ammoTypeLabel(AmmoType.AtlatlChorizite)).toBe('Chorizite Atlatl');
    expect(ammoTypeLabel(AmmoType.None)).toBe('');
  });
});

describe('ArmorType (per ACE ArmorType.cs)', () => {
  it('values 0,1,2,4,8,16,32', () => {
    expect(ArmorType.None).toBe(0);
    expect(ArmorType.Cloth).toBe(1);
    expect(ArmorType.Leather).toBe(2);
    expect(ArmorType.StuddedLeather).toBe(4);
    expect(ArmorType.Scalemail).toBe(8);
    expect(ArmorType.Chainmail).toBe(16);
    expect(ArmorType.Metal).toBe(32);
  });

  it('label helper distinguishes Studded Leather from Leather', () => {
    expect(armorTypeLabel(ArmorType.Leather)).toBe('Leather');
    expect(armorTypeLabel(ArmorType.StuddedLeather)).toBe('Studded Leather');
    expect(armorTypeLabel(ArmorType.Chainmail)).toBe('Chainmail');
  });
});

describe('AttackType (per ACE AttackType.cs)', () => {
  it('base flag values 0x0001 through 0x4000', () => {
    expect(AttackType.Undef).toBe(0x0000);
    expect(AttackType.Punch).toBe(0x0001);
    expect(AttackType.Thrust).toBe(0x0002);
    expect(AttackType.Slash).toBe(0x0004);
    expect(AttackType.Kick).toBe(0x0008);
    expect(AttackType.OffhandPunch).toBe(0x0010);
    expect(AttackType.DoubleSlash).toBe(0x0020);
    expect(AttackType.TripleSlash).toBe(0x0040);
    expect(AttackType.DoubleThrust).toBe(0x0080);
    expect(AttackType.TripleThrust).toBe(0x0100);
    expect(AttackType.OffhandThrust).toBe(0x0200);
    expect(AttackType.OffhandSlash).toBe(0x0400);
    expect(AttackType.OffhandDoubleSlash).toBe(0x0800);
    expect(AttackType.OffhandTripleSlash).toBe(0x1000);
    expect(AttackType.OffhandDoubleThrust).toBe(0x2000);
    expect(AttackType.OffhandTripleThrust).toBe(0x4000);
  });

  it('Unarmed = Punch | Kick | OffhandPunch = 0x0019', () => {
    expect(ATTACK_TYPE_UNARMED).toBe(0x0001 | 0x0008 | 0x0010);
    expect(ATTACK_TYPE_UNARMED).toBe(0x0019);
  });

  it('DoubleStrike = DoubleSlash | DoubleThrust | OffhandDouble{Slash,Thrust}', () => {
    expect(ATTACK_TYPE_DOUBLE_STRIKE).toBe(0x0020 | 0x0080 | 0x0800 | 0x2000);
    expect(ATTACK_TYPE_DOUBLE_STRIKE).toBe(0x28a0);
  });

  it('TripleStrike = TripleSlash | TripleThrust | OffhandTriple{Slash,Thrust}', () => {
    expect(ATTACK_TYPE_TRIPLE_STRIKE).toBe(0x0040 | 0x0100 | 0x1000 | 0x4000);
    expect(ATTACK_TYPE_TRIPLE_STRIKE).toBe(0x5140);
  });

  it('MultiStrike = DoubleStrike | TripleStrike', () => {
    expect(ATTACK_TYPE_MULTI_STRIKE).toBe(ATTACK_TYPE_DOUBLE_STRIKE | ATTACK_TYPE_TRIPLE_STRIKE);
  });

  it('Offhand = all 6 Offhand* flags', () => {
    expect(ATTACK_TYPE_OFFHAND).toBe(
      AttackType.OffhandThrust | AttackType.OffhandSlash |
      AttackType.OffhandDoubleSlash | AttackType.OffhandTripleSlash |
      AttackType.OffhandDoubleThrust | AttackType.OffhandTripleThrust,
    );
  });

  it('Thrusts | Slashes | Punches cover their respective base groups', () => {
    expect(ATTACK_TYPE_THRUSTS).toBe(
      AttackType.Thrust | AttackType.DoubleThrust | AttackType.TripleThrust |
      AttackType.OffhandThrust | AttackType.OffhandDoubleThrust | AttackType.OffhandTripleThrust,
    );
    expect(ATTACK_TYPE_SLASHES).toBe(
      AttackType.Slash | AttackType.DoubleSlash | AttackType.TripleSlash |
      AttackType.OffhandSlash | AttackType.OffhandDoubleSlash | AttackType.OffhandTripleSlash,
    );
    expect(ATTACK_TYPE_PUNCHES).toBe(AttackType.Punch | AttackType.OffhandPunch);
  });

  it('isMultiStrike: matches AttackTypeExtensions.IsMultiStrike', () => {
    expect(isMultiStrike(AttackType.Thrust)).toBe(false);
    expect(isMultiStrike(AttackType.DoubleThrust)).toBe(true);
    expect(isMultiStrike(AttackType.TripleSlash)).toBe(true);
    expect(isMultiStrike(AttackType.OffhandDoubleSlash)).toBe(true);
    expect(isMultiStrike(AttackType.Undef)).toBe(false);
  });

  it('reduceMultiStrike: matches AttackTypeExtensions.ReduceMultiStrike switch', () => {
    expect(reduceMultiStrike(AttackType.DoubleThrust)).toBe(AttackType.Thrust);
    expect(reduceMultiStrike(AttackType.TripleThrust)).toBe(AttackType.Thrust);
    expect(reduceMultiStrike(AttackType.DoubleSlash)).toBe(AttackType.Slash);
    expect(reduceMultiStrike(AttackType.TripleSlash)).toBe(AttackType.Slash);
    expect(reduceMultiStrike(AttackType.OffhandDoubleThrust)).toBe(AttackType.OffhandThrust);
    expect(reduceMultiStrike(AttackType.OffhandTripleThrust)).toBe(AttackType.OffhandThrust);
    expect(reduceMultiStrike(AttackType.OffhandDoubleSlash)).toBe(AttackType.OffhandSlash);
    expect(reduceMultiStrike(AttackType.OffhandTripleSlash)).toBe(AttackType.OffhandSlash);
    expect(reduceMultiStrike(AttackType.Thrust)).toBe(AttackType.Undef);  // not multi-strike → Undef
  });
});

describe('AttunedStatus (per ACE AttunedStatus.cs)', () => {
  it('values 0,1,2', () => {
    expect(AttunedStatus.Normal).toBe(0);
    expect(AttunedStatus.Attuned).toBe(1);
    expect(AttunedStatus.Sticky).toBe(2);
  });

  it('label helper', () => {
    expect(attunedStatusLabel(AttunedStatus.Normal)).toBe('');
    expect(attunedStatusLabel(AttunedStatus.Attuned)).toBe('Attuned');
    expect(attunedStatusLabel(AttunedStatus.Sticky)).toBe('Attuned (Sticky)');
  });
});

describe('BondedStatus (per ACE BondedStatus.cs — signed!)', () => {
  it('values -2,-1,0,1,2', () => {
    expect(BondedStatus.Destroy).toBe(-2);
    expect(BondedStatus.Slippery).toBe(-1);
    expect(BondedStatus.Normal).toBe(0);
    expect(BondedStatus.Bonded).toBe(1);
    expect(BondedStatus.Sticky).toBe(2);
  });

  it('label helper covers negative values', () => {
    expect(bondedStatusLabel(BondedStatus.Destroy)).toBe('Destroyed on Death');
    expect(bondedStatusLabel(BondedStatus.Slippery)).toBe('Drops on Death');
    expect(bondedStatusLabel(BondedStatus.Normal)).toBe('');
    expect(bondedStatusLabel(BondedStatus.Bonded)).toBe('Bonded');
    expect(bondedStatusLabel(BondedStatus.Sticky)).toBe('Bonded (Sticky)');
  });
});
