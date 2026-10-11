import { DatReader } from '../DatReader.js';

export enum MagicSchool {
  WarMagic = 1,
  LifeMagic = 2,
  ItemEnchantment = 3,
  CreatureEnchantment = 4,
  VoidMagic = 5,
}

/**
 * SpellType — per ACE SpellType.cs. Sequential C# enum starting at Undef=0.
 *
 * FAITHFUL.78: This enum had 6 swapped values + 3 missing entries before
 * the audit. PortalSummon was at 12 (correct: 7), PortalSending at 7
 * (correct: 8), Dispel/LifeProjectile/FellowBoost/FellowEnchantment all
 * shifted by 1, and FellowPortalSending/FellowDispel/EnchantmentProjectile
 * were absent. The DAT-parser still byte-read correctly by lucky
 * coincidence (wrong branches happened to read the right byte counts) but
 * symbolic dispatch on PortalSummon would silently never match. Per ACE
 * SpellBase.cs `MetaSpellType = (SpellType)reader.ReadUInt32()` this enum
 * is the authoritative wire-value mapping for DAT spell records.
 */
export enum SpellType {
  Undef = 0,
  Enchantment = 1,
  Projectile = 2,
  Boost = 3,
  Transfer = 4,
  PortalLink = 5,
  PortalRecall = 6,
  PortalSummon = 7,
  PortalSending = 8,
  Dispel = 9,
  LifeProjectile = 10,
  FellowBoost = 11,
  FellowEnchantment = 12,
  FellowPortalSending = 13,
  FellowDispel = 14,
  EnchantmentProjectile = 15,
}

/** A spell that flies to its target as a missile (ACE SpellProjectile: Projectile, LifeProjectile, EnchantmentProjectile). */
export function isProjectileSpellType(t: number): boolean {
  return t === SpellType.Projectile || t === SpellType.LifeProjectile || t === SpellType.EnchantmentProjectile;
}

export interface SpellBase {
  name: string;
  desc: string;
  school: number;
  icon: number;
  category: number;
  bitfield: number;
  baseMana: number;
  baseRangeConstant: number;
  baseRangeMod: number;
  power: number;
  spellEconomyMod: number;
  formulaVersion: number;
  componentLoss: number;
  metaSpellType: number;
  metaSpellId: number;
  duration?: number;
  degradeModifier?: number;
  degradeLimit?: number;
  portalLifetime?: number;
  formula: number[];
  casterEffect: number;
  targetEffect: number;
  fizzleEffect: number;
  recoveryInterval: number;
  recoveryAmount: number;
  displayOrder: number;
  nonComponentTargetType: number;
  manaMod: number;
}

function readSpellBase(reader: DatReader): SpellBase {
  const name = reader.readObfuscatedString();
  reader.align(4);
  const desc = reader.readObfuscatedString();
  reader.align(4);

  const school = reader.readUInt32();
  const icon = reader.readUInt32();
  const category = reader.readUInt32();
  const bitfield = reader.readUInt32();
  const baseMana = reader.readUInt32();
  const baseRangeConstant = reader.readFloat32();
  const baseRangeMod = reader.readFloat32();
  const power = reader.readUInt32();
  const spellEconomyMod = reader.readFloat32();
  const formulaVersion = reader.readUInt32();
  const componentLoss = reader.readFloat32();
  const metaSpellType = reader.readUInt32();
  const metaSpellId = reader.readUInt32();

  const spell: SpellBase = {
    name, desc, school, icon, category, bitfield, baseMana,
    baseRangeConstant, baseRangeMod, power, spellEconomyMod,
    formulaVersion, componentLoss, metaSpellType, metaSpellId,
    formula: [],
    casterEffect: 0, targetEffect: 0, fizzleEffect: 0,
    recoveryInterval: 0, recoveryAmount: 0, displayOrder: 0,
    nonComponentTargetType: 0, manaMod: 0,
  };

  // Type-specific extra data after metaSpellType/metaSpellId — per ACE
  // SpellBase.cs:
  //   Enchantment / FellowEnchantment: 16 bytes (Duration + DegradeModifier + DegradeLimit)
  //   PortalSummon:                    8 bytes  (PortalLifetime as float64)
  //   All other types:                 0 bytes
  if (metaSpellType === SpellType.Enchantment || metaSpellType === SpellType.FellowEnchantment) {
    spell.duration = reader.readFloat64();
    spell.degradeModifier = reader.readFloat32();
    spell.degradeLimit = reader.readFloat32();
  } else if (metaSpellType === SpellType.PortalSummon) {
    spell.portalLifetime = reader.readFloat64();
  }

  // Formula components (always 8 entries) — stored OBFUSCATED in the DAT.
  // ACE SpellBase.cs:91-104 collects the non-zero raw values then decrypts
  // with a key derived from the spell's name + description hashes
  // (DecryptFormula). Pre-GAP.11 the raw encrypted values were kept, so
  // every downstream consumer (windup gestures, component lists) saw
  // garbage like 443924472 instead of component ids 1-198.
  const rawComponents: number[] = [];
  for (let i = 0; i < 8; i++) {
    const c = reader.readUInt32();
    if (c > 0) rawComponents.push(c);
  }
  spell.formula = decryptFormula(rawComponents, name, desc);

  spell.casterEffect = reader.readUInt32();
  spell.targetEffect = reader.readUInt32();
  spell.fizzleEffect = reader.readUInt32();
  spell.recoveryInterval = reader.readFloat64();
  spell.recoveryAmount = reader.readFloat32();
  spell.displayOrder = reader.readUInt32();
  spell.nonComponentTargetType = reader.readUInt32();
  spell.manaMod = reader.readUInt32();

  return spell;
}

/**
 * ACE SpellTable.cs:32 ComputeHash — Windows-1252 bytes as SIGNED chars,
 * rolling shift-4 hash with high-nibble folding. (Spell names/descriptions
 * are ASCII in practice; charCodeAt & 0xFF matches CP-1252 for them.)
 */
/**
 * Unicode → Windows-1252 byte for the 0x80-0x9F range (ACE hashes the
 * CP-1252 BYTES: Encoding.GetEncoding(1252).GetBytes, SpellTable.cs:39).
 * Spell descriptions use these (e.g. the en dash in "80 – 200" — ACE's own
 * commented test hash is " – 200"); a naive charCodeAt & 0xFF maps U+2013
 * to 0x13 instead of 0x96 and derails the formula decryption key.
 */
const CP1252_MAP: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

export function computeSpellHash(str: string): number {
  let result = 0n;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const c = code <= 0xff ? code : (CP1252_MAP[code] ?? 0x3f /* '?' fallback like .NET */);
    const signed = c > 127 ? c - 256 : c;
    result = BigInt(signed) + (result << 4n);
    if ((result & 0xf0000000n) !== 0n) {
      result = (result ^ ((result & 0xf0000000n) >> 24n)) & 0x0fffffffn;
    }
  }
  return Number(result & 0xffffffffn) >>> 0;
}

/** Highest valid component id — 198 "Essence of Kemeroi" (ACE SpellBase.cs:117). */
const HIGHEST_COMP_ID = 198;

/**
 * ACE SpellBase.cs:121 DecryptFormula — key = (nameHash % 0x12107680) +
 * (descHash % 0xBEADCF45); each component = raw - key, masked to a byte when
 * the subtraction lands outside the valid component range (extended-character
 * correction in ACE).
 */
export function decryptFormula(rawComps: number[], name: string, desc: string): number[] {
  const nameHash = computeSpellHash(name);
  const descHash = computeSpellHash(desc);
  const key = ((nameHash % 0x12107680) + (descHash % 0xbeadcf45)) >>> 0;
  return rawComps.map((raw) => {
    let comp = (raw - key) >>> 0;
    if (comp > HIGHEST_COMP_ID) comp = comp & 0xff;
    return comp;
  });
}

/**
 * SpellTable — all game spells from portal.dat (0x0E00000E)
 * Reference: ACE.DatLoader/FileTypes/SpellTable.cs
 */
/**
 * SpellSet — one equipment set's tiered spell lists.
 * Reference: ACE.DatLoader/Entity/SpellSet.cs + FileTypes/SpellSetTiers.cs.
 * `tiers` is keyed by the total combined item level of the equipped set
 * pieces (retail m_PieceCount); `tiersNoGaps` fills every level 0..highestTier
 * with the nearest lower defined tier, exactly as ACE SpellSet.Unpack does.
 */
export interface SpellSet {
  tiers: Map<number, number[]>;
  highestTier: number;
  tiersNoGaps: Map<number, number[]>;
}

export function readSpellSet(reader: DatReader): SpellSet {
  // SpellSetTiers: PackedHashTable<uint, SpellSetTiers> (a SortedDictionary
  // in ACE) — uint16 count + uint16 bucket size, then uint32 key + value.
  const count = reader.readUInt16();
  reader.readUInt16(); // bucket size (unused)
  const raw = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const key = reader.readUInt32();
    // SpellSetTiers.Spells: List<uint>.Unpack — int32 count + uint32 ids.
    const n = reader.readInt32();
    const spells: number[] = [];
    for (let j = 0; j < n; j++) spells.push(reader.readUInt32());
    raw.set(key, spells);
  }
  const sortedKeys = [...raw.keys()].sort((a, b) => a - b);
  const tiers = new Map<number, number[]>();
  for (const k of sortedKeys) tiers.set(k, raw.get(k)!);
  // HighestTier = SpellSetTiers.Keys.LastOrDefault()
  const highestTier = sortedKeys.length > 0 ? sortedKeys[sortedKeys.length - 1] : 0;
  const tiersNoGaps = new Map<number, number[]>();
  let last: number[] | null = null;
  for (let i = 0; i <= highestTier; i++) {
    const t = tiers.get(i);
    if (t) last = t;
    if (last) tiersNoGaps.set(i, last);
  }
  return { tiers, highestTier, tiersNoGaps };
}

export class SpellTable {
  id: number = 0;
  spells: Map<number, SpellBase> = new Map();
  /** Keyed by SpellSetID (PropertyInt.EquipmentSetId). ACE SpellTable.SpellSet. */
  spellSets: Map<number, SpellSet> = new Map();

  constructor(reader: DatReader) {
    this.id = reader.readUInt32();

    // PackedHashTable<uint, SpellBase>: uint16 count + uint16 bucketSize
    const spellCount = reader.readUInt16();
    reader.readUInt16(); // bucket size (unused)

    for (let i = 0; i < spellCount; i++) {
      const key = reader.readUInt32();
      this.spells.set(key, readSpellBase(reader));
    }

    // ACE SpellTable.cs Unpack: SpellSet.UnpackPackedHashTable(reader) —
    // uint16 count + uint16 bucket size, then uint32 SpellSetID + SpellSet.
    const setCount = reader.readUInt16();
    reader.readUInt16(); // bucket size (unused)
    for (let i = 0; i < setCount; i++) {
      const key = reader.readUInt32();
      this.spellSets.set(key, readSpellSet(reader));
    }
  }
}
