/**
 * Runtime audit: PhysicsState, ObjectDescriptionFlag, PhysicsDescriptionFlag.
 *
 * Each entry in the ACE source must exist in our TS port at the same value.
 * Mirrors FAITHFUL.65/66/69 pattern — walks ACE source at test time,
 * drift-proof against future ACE changes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PhysicsState,
  ObjectDescriptionFlag,
  PhysicsDescriptionFlag,
  PositionFlags,
  UiEffects,
  CombatStyle,
  COMBAT_STYLE_MELEE,
  COMBAT_STYLE_MISSILE,
  IdentifyResponseFlags,
  RawMotionFlags,
  HoldKey,
  AttributeCache,
  ATTRIBUTE_CACHE_FULL,
  DescriptionPropertyFlag,
  DescriptionVectorFlag,
  AllegianceIndex,
  CreatureProfileFlags,
  MovementStateFlag,
  StipplingType,
  CharacterOptions1,
  CharacterOptions2,
  CHARACTER_OPTIONS1_DEFAULT,
  CHARACTER_OPTIONS2_DEFAULT,
  Channel,
  CHANNEL_ALL_CHANS,
  SkillId,
  AccessLevel,
  ContainerType,
  PortalFlags,
  FactionBits,
  MotionFlags,
  BasePropertyType,
  ChatNetworkBlobType,
} from '../packages/shared/src/ace-enums.js';

const REPO = resolve(__dirname, '..');
const PS_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/PhysicsState.cs');
const ODF_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ObjectDescriptionFlag.cs');
const PDF_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/PhysicsDescriptionFlag.cs');
const POSF_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/PositionFlags.cs');
const UIE_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/UiEffects.cs');
const CS_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CombatStyle.cs');
const IRF_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/IdentifyResponseFlags.cs');
const RMF_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Enum/RawMotionFlags.cs');
const HK_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/HoldKey.cs');
const AC_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/AttributeCache.cs');
const PD_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventPlayerDescription.cs');
const SF_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/SetupFlags.cs');
const GF_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/GfxObjFlags.cs');
const AI_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Enum/AllegianceIndex.cs');
const ST_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/SpellType.cs');
const DT_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/DamageType.cs');
const IT_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ItemType.cs');
const CPF_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Structure/CreatureProfile.cs');
const MSF_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MovementStateFlag.cs');
const STP_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/StipplingType.cs');
const CO1_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CharacterOptions1.cs');
const CO2_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CharacterOptions2.cs');
const CH_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/Channel.cs');
const SK_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/Skill.cs');
const AL_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/AccessLevel.cs');
const CT_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ContainerType.cs');
const PF_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/PortalFlags.cs');
const FB_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/FactionBits.cs');
const MF_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MotionFlags.cs');
const BPT_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/BasePropertyType.cs');
const CNB_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ChatNetworkBlobType.cs');

interface AceEntry { name: string; value: number; }

function parseAce(path: string, enumName: string): AceEntry[] {
  const src = readFileSync(path, 'utf8');
  const lines = src.split('\n');
  const out: AceEntry[] = [];
  let inside = false;
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|-?\d+)\s*,?\s*(\/\/.*)?$/;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inside) { if (open.test(line)) inside = true; continue; }
    if (/^\s*}/.test(line)) break;
    const m = re.exec(line);
    if (m) {
      const value = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
      out.push({ name: m[1], value });
    }
  }
  return out;
}

function tsNamesOf(enumObj: Record<string, unknown>): string[] {
  return Object.keys(enumObj).filter((k) => Number.isNaN(Number(k)));
}

describe('ACE PhysicsState coverage (runtime audit)', () => {
  const aceEntries = parseAce(PS_PATH, 'PhysicsState');

  it('parses ACE source successfully', () => {
    expect(existsSync(PS_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(20);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'PhysicsState.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (PhysicsState as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(PhysicsState as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE ObjectDescriptionFlag coverage (runtime audit)', () => {
  const aceEntries = parseAce(ODF_PATH, 'ObjectDescriptionFlag');

  it('parses ACE source successfully', () => {
    expect(existsSync(ODF_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(28);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'ObjectDescriptionFlag.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (ObjectDescriptionFlag as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(ObjectDescriptionFlag as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE PhysicsDescriptionFlag coverage (runtime audit)', () => {
  const aceEntries = parseAce(PDF_PATH, 'PhysicsDescriptionFlag');

  it('parses ACE source successfully', () => {
    expect(existsSync(PDF_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(19);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'PhysicsDescriptionFlag.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (PhysicsDescriptionFlag as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  // Note: TS port intentionally includes 'Timestamps' as an extra slot per
  // ACE source (it's a reserved bit, not a conditional wire field), so the
  // "no extras" check is omitted for this enum.
});

describe('ACE PositionFlags coverage (runtime audit)', () => {
  const aceEntries = parseAce(POSF_PATH, 'PositionFlags');

  it('parses ACE source successfully', () => {
    expect(existsSync(POSF_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(8);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'PositionFlags.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (PositionFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(PositionFlags as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE UiEffects coverage (runtime audit)', () => {
  const aceEntries = parseAce(UIE_PATH, 'UiEffects');

  it('parses ACE source successfully', () => {
    expect(existsSync(UIE_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(14);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'UiEffects.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (UiEffects as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(UiEffects as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE CombatStyle coverage (runtime audit)', () => {
  // Only audit the raw bit-value entries (not the Melee/Missile composites,
  // which are exported as separate const expressions in our port).
  const aceEntries = parseAce(CS_PATH, 'CombatStyle');

  it('parses ACE source successfully', () => {
    expect(existsSync(CS_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(22);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'CombatStyle.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (CombatStyle as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('Melee composite matches ACE union (Unarmed|OneHanded|OneHandedAndShield|TwoHanded|DualWield)', () => {
    expect(COMBAT_STYLE_MELEE).toBe(0x0010F);
    // Same as ACE source line 32.
  });

  it('Missile composite matches ACE union (Bow|Crossbow|Sling|ThrownWeapon|Atlatl|ThrownShield)', () => {
    expect(COMBAT_STYLE_MISSILE).toBe(0x00CF0);
    // Same as ACE source line 33.
  });
});

describe('ACE IdentifyResponseFlags coverage (runtime audit)', () => {
  const aceEntries = parseAce(IRF_PATH, 'IdentifyResponseFlags');

  it('parses ACE source successfully', () => {
    expect(existsSync(IRF_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(15);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'IdentifyResponseFlags.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (IdentifyResponseFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(IdentifyResponseFlags as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE RawMotionFlags coverage (runtime audit)', () => {
  const aceEntries = parseAce(RMF_PATH, 'RawMotionFlags');

  it('parses ACE source successfully', () => {
    expect(existsSync(RMF_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(11);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'RawMotionFlags.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (RawMotionFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(RawMotionFlags as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE HoldKey coverage (runtime audit)', () => {
  const aceEntries = parseAce(HK_PATH, 'HoldKey');

  it('parses ACE source successfully', () => {
    expect(existsSync(HK_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(3);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'HoldKey.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (HoldKey as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(HoldKey as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE AttributeCache coverage (runtime audit)', () => {
  // Excludes the `Full` composite (filtered out by parser since RHS is a
  // union expression, not a numeric literal).
  const aceEntries = parseAce(AC_PATH, 'AttributeCache');

  it('parses ACE source successfully', () => {
    expect(existsSync(AC_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(10);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'AttributeCache.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (AttributeCache as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('Full composite matches ACE union (all 9 attribute/vital bits)', () => {
    expect(ATTRIBUTE_CACHE_FULL).toBe(0x1FF);
  });
});

describe('ACE DescriptionPropertyFlag coverage (runtime audit)', () => {
  const aceEntries = parseAce(PD_PATH, 'DescriptionPropertyFlag');

  it('parses ACE source successfully', () => {
    expect(existsSync(PD_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(9);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'DescriptionPropertyFlag.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (DescriptionPropertyFlag as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(DescriptionPropertyFlag as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE DescriptionVectorFlag coverage (runtime audit)', () => {
  const aceEntries = parseAce(PD_PATH, 'DescriptionVectorFlag');

  it('parses ACE source successfully', () => {
    expect(aceEntries.length).toBeGreaterThanOrEqual(5);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'DescriptionVectorFlag.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (DescriptionVectorFlag as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(DescriptionVectorFlag as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE SetupFlags coverage (runtime audit)', async () => {
  const { SetupFlags } = await import('../packages/dat-parser/src/file-types/SetupModel.js');
  const aceEntries = parseAce(SF_PATH, 'SetupFlags');

  it('parses ACE source successfully', () => {
    expect(existsSync(SF_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(4);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'SetupFlags.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (SetupFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(SetupFlags as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });

  // FAITHFUL.76 fixed a latent wire-format bug:
  //   The earlier port had AllowFreeHeading=0x200, HasPhysicsBSP=0x400 (made
  //   up values), plus 6 invented constants (HasHoldingLocations,
  //   HasConnectionPoints, HasPlacementFrames, HasCollisionSpheres,
  //   HasBoundingSphere, HasCylinderSphere) that don't exist in ACE source.
  //   Result: allowFreeHeading + hasPhysicsBSP booleans on parsed SetupModel
  //   instances always read false. Per ACE.Entity.Enum.SetupFlags, the
  //   correct values are 0x4 and 0x8.
  it('AllowFreeHeading = 0x4 (was 0x200; latent bug fix)', () => {
    expect(SetupFlags.AllowFreeHeading).toBe(0x4);
  });
  it('HasPhysicsBSP = 0x8 (was 0x400; latent bug fix)', () => {
    expect(SetupFlags.HasPhysicsBSP).toBe(0x8);
  });
});

describe('ACE GfxObjFlags coverage (runtime audit)', async () => {
  const { GfxObjFlags } = await import('../packages/dat-parser/src/file-types/GfxObj.js');
  const aceEntries = parseAce(GF_PATH, 'GfxObjFlags');

  it('parses ACE source successfully', () => {
    expect(existsSync(GF_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(4);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'GfxObjFlags.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (GfxObjFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(GfxObjFlags as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE AllegianceIndex coverage (runtime audit)', () => {
  const aceEntries = parseAce(AI_PATH, 'AllegianceIndex');

  it('parses ACE source successfully', () => {
    expect(existsSync(AI_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(6);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'AllegianceIndex.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (AllegianceIndex as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(AllegianceIndex as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE SpellType coverage (runtime audit)', async () => {
  // ACE source uses C# auto-numbering (Undef implicit 0, then auto-increment).
  // Walk source AND synthesize numeric assignments so the audit can verify.
  const { SpellType } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
  const { MetaSpellType } = await import('../packages/shared/src/magic/SpellEngine.js');

  // Parse auto-numbered C# enum from ACE source.
  const src = readFileSync(ST_PATH, 'utf8');
  const inside = src.slice(src.indexOf('enum SpellType')).split('}')[0];
  const lines = inside.split('\n').map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').trim());
  const names = lines
    .filter((l) => /^[A-Z][A-Za-z0-9_]*\s*,?$/.test(l))
    .map((l) => l.replace(/,\s*$/, ''));
  const aceEntries = names.map((name, i) => ({ name, value: i }));

  it('parses ACE source successfully', () => {
    expect(existsSync(ST_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(15);
    expect(aceEntries[0].name).toBe('Undef');
    expect(aceEntries[15].name).toBe('EnchantmentProjectile');
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'SpellType.%s = %s exists in DAT-parser TS port at same value',
    (name, value) => {
      const tsVal = (SpellType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'MetaSpellType.%s = %s exists in shared/magic TS port at same value',
    (name, value) => {
      const tsVal = (MetaSpellType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  // FAITHFUL.78 bug-fix pins — anchor the key values that were wrong.
  it('PortalSummon = 7 (was 12; latent enum bug fix)', () => {
    expect(SpellType.PortalSummon).toBe(7);
    expect(MetaSpellType.PortalSummon).toBe(7);
  });
  it('PortalSending = 8 (was 7; latent enum bug fix)', () => {
    expect(SpellType.PortalSending).toBe(8);
    expect(MetaSpellType.PortalSending).toBe(8);
  });
  it('FellowEnchantment = 12 (was 11/10; latent enum bug fix)', () => {
    expect(SpellType.FellowEnchantment).toBe(12);
    expect(MetaSpellType.FellowEnchantment).toBe(12);
  });
});

describe('ACE DamageType coverage (runtime audit)', async () => {
  // DamageType has Physical and Elemental as union aliases that the parser
  // skips (RHS is `Slash | Pierce | Bludgeon` not a numeric literal). Audit
  // only the bit-value entries.
  const { DamageType } = await import('../packages/shared/src/game-types.js');
  const aceEntries = parseAce(DT_PATH, 'DamageType');

  it('parses ACE source successfully', () => {
    expect(existsSync(DT_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(12);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'DamageType.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (DamageType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

describe('ACE ItemType coverage (runtime audit)', async () => {
  const { ItemType } = await import('../packages/shared/src/game-types.js');
  const aceEntries = parseAce(IT_PATH, 'ItemType');

  it('parses ACE source successfully', () => {
    expect(existsSync(IT_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(28);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'ItemType.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (ItemType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(ItemType as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE CreatureProfileFlags coverage (runtime audit)', () => {
  const aceEntries = parseAce(CPF_PATH, 'CreatureProfileFlags');

  it('parses ACE source successfully', () => {
    expect(existsSync(CPF_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(4);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'CreatureProfileFlags.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (CreatureProfileFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(CreatureProfileFlags as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

describe('ACE MovementStateFlag coverage (runtime audit)', () => {
  const aceEntries = parseAce(MSF_PATH, 'MovementStateFlag');

  it('parses ACE source successfully', () => {
    expect(existsSync(MSF_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(8);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'MovementStateFlag.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (MovementStateFlag as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(MovementStateFlag as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });

  it('distinct from RawMotionFlags (the outbound equivalent)', () => {
    // RawMotionFlags.ForwardCommand = 0x004; MovementStateFlag.ForwardSpeed = 0x4
    // — different semantics at the same bit position. The two enums share
    // numeric values for unrelated fields, so callers MUST keep them separate.
    expect(MovementStateFlag.ForwardSpeed).toBe(0x4);
  });
});

describe('ACE StipplingType coverage (runtime audit)', () => {
  const aceEntries = parseAce(STP_PATH, 'StipplingType');

  it('parses ACE source successfully', () => {
    expect(existsSync(STP_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(7);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'StipplingType.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (StipplingType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(StipplingType as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });

  it('NoPos = 0x4 (used by EnvCellRenderer to filter portal openings)', () => {
    expect(StipplingType.NoPos).toBe(0x4);
  });
});

describe('ACE CharacterOptions1 coverage (runtime audit)', () => {
  const aceEntries = parseAce(CO1_PATH, 'CharacterOptions1');

  it('parses ACE source successfully', () => {
    expect(existsSync(CO1_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(32);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'CharacterOptions1.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (CharacterOptions1 as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(CharacterOptions1 as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });

  it('Default value matches ACE source comment (1355064650)', () => {
    expect(CHARACTER_OPTIONS1_DEFAULT).toBe(1355064650);
  });
});

describe('ACE CharacterOptions2 coverage (runtime audit)', () => {
  const aceEntries = parseAce(CO2_PATH, 'CharacterOptions2');

  it('parses ACE source successfully', () => {
    expect(existsSync(CO2_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(26);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'CharacterOptions2.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (CharacterOptions2 as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(CharacterOptions2 as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });

  it('Default value matches ACE source comment (9733888)', () => {
    expect(CHARACTER_OPTIONS2_DEFAULT).toBe(9733888);
  });
});

describe('ACE Channel coverage (runtime audit)', () => {
  const aceEntries = parseAce(CH_PATH, 'Channel');

  it('parses ACE source successfully', () => {
    expect(existsSync(CH_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(36);
  });

  // AllChans = 0x7F007F3F is exported as a separate const (TS numeric edge
  // case combining with the sign-extended Olthoi=0x40000000), so the enum
  // proper has 36 entries while ACE has 37. The const carries the missing value.
  it.each(aceEntries.filter((e) => e.name !== 'AllChans').map((e) => [e.name, e.value] as const))(
    'Channel.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (Channel as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('AllChans (0x7F007F3F) is carried by the CHANNEL_ALL_CHANS const', () => {
    expect(CHANNEL_ALL_CHANS).toBe(0x7F007F3F);
  });

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(Channel as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

/**
 * Parse a C# auto-numbered enum (no explicit `= NN` assignments). ACE's
 * `Skill` enum uses this style. Returns synthetic (name, index) entries.
 * Handles `/* Retired *\/` etc. trailing comments and implicit-0 first entry.
 */
function parseAceAutoNumbered(path: string, enumName: string): AceEntry[] {
  const src = readFileSync(path, 'utf8');
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  const lines = src.split('\n');
  const out: AceEntry[] = [];
  let inside = false;
  let index = 0;
  // Strip C-style block comments and end-of-line comments before matching.
  const ID_RE = /^\s*([A-Z][A-Za-z0-9_]*)\s*,?\s*$/;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').trimEnd();
    if (!inside) { if (open.test(line)) inside = true; continue; }
    if (/^\s*}/.test(line)) break;
    const m = ID_RE.exec(line);
    if (m) {
      out.push({ name: m[1], value: index });
      index++;
    }
  }
  return out;
}

describe('ACE Skill (SkillId) coverage (runtime audit)', () => {
  // ACE source uses C# auto-numbering (None=0, Axe=1, ...).
  const aceEntries = parseAceAutoNumbered(SK_PATH, 'Skill');

  it('parses ACE source successfully', () => {
    expect(existsSync(SK_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(55);
    expect(aceEntries[0].name).toBe('None');
    // Last entry per ACE.
    expect(aceEntries[aceEntries.length - 1].name).toBe('Summoning');
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'Skill.%s = %s exists in TS SkillId port at same value',
    (name, value) => {
      const tsVal = (SkillId as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

describe('ACE AccessLevel coverage (runtime audit)', () => {
  const aceEntries = parseAce(AL_PATH, 'AccessLevel');

  it('parses ACE source successfully', () => {
    expect(existsSync(AL_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(6);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'AccessLevel.%s = %s exists in TS port at same value',
    (name, value) => {
      const tsVal = (AccessLevel as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

describe('ACE ContainerType coverage (runtime audit)', () => {
  const aceEntries = parseAce(CT_PATH, 'ContainerType');

  it('parses ACE source successfully', () => {
    expect(existsSync(CT_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(3);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'ContainerType.%s = %s exists in TS port at same value',
    (name, value) => {
      const tsVal = (ContainerType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

describe('ACE PortalFlags coverage (runtime audit)', () => {
  const aceEntries = parseAce(PF_PATH, 'PortalFlags');

  it('parses ACE source successfully', () => {
    expect(existsSync(PF_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(2);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'PortalFlags.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (PortalFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

describe('ACE FactionBits coverage (runtime audit)', () => {
  const aceEntries = parseAce(FB_PATH, 'FactionBits');

  it('parses ACE source successfully', () => {
    expect(existsSync(FB_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(4);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'FactionBits.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (FactionBits as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

describe('ACE MotionFlags coverage (runtime audit)', () => {
  const aceEntries = parseAce(MF_PATH, 'MotionFlags');

  it('parses ACE source successfully', () => {
    expect(existsSync(MF_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(3);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'MotionFlags.%s = 0x%s exists in TS port at same value',
    (name, value) => {
      const tsVal = (MotionFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

describe('ACE BasePropertyType coverage (runtime audit)', () => {
  // BasePropertyType uses explicit numeric assignments.
  const aceEntries = parseAce(BPT_PATH, 'BasePropertyType');

  it('parses ACE source successfully', () => {
    expect(existsSync(BPT_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(22);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'BasePropertyType.%s = %s exists in TS port at same value',
    (name, value) => {
      const tsVal = (BasePropertyType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

describe('ACE ChatNetworkBlobType coverage (runtime audit)', () => {
  const aceEntries = parseAce(CNB_PATH, 'ChatNetworkBlobType');

  it('parses ACE source successfully', () => {
    expect(existsSync(CNB_PATH)).toBe(true);
    expect(aceEntries.length).toBeGreaterThanOrEqual(7);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'ChatNetworkBlobType.%s = %s exists in TS port at same value',
    (name, value) => {
      const tsVal = (ChatNetworkBlobType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

describe('PhysicsState bug-fix pins', () => {
  // FAITHFUL.70 found and fixed a real wire-format bug:
  //   ServerObjectManager was masking against 0x0001 thinking that was
  //   PhysicsState.Hidden, but ACE has Static = 0x0001 and Hidden = 0x4000.
  // These assertions pin the correct constants so the bug can't silently
  // regress.
  it('Static = 0x00000001 (the original mis-attributed value)', () => {
    expect(PhysicsState.Static).toBe(0x00000001);
  });
  it('Hidden = 0x00004000 (the actual hidden-flag bit)', () => {
    expect(PhysicsState.Hidden).toBe(0x00004000);
  });
  it('Gravity = 0x00000400 (used for projectile gravity dispatch)', () => {
    expect(PhysicsState.Gravity).toBe(0x00000400);
  });
  it('AlignPath = 0x00000100 (used for projectile orientation)', () => {
    expect(PhysicsState.AlignPath).toBe(0x00000100);
  });
  it('Missile = 0x00000040 (used for projectile classification)', () => {
    expect(PhysicsState.Missile).toBe(0x00000040);
  });
});
