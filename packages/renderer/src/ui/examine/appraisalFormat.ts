/**
 * Retail appraisal string helpers — faithful ports of the small formatting
 * routines the EoL item-examine page (ItemExamineUI) calls while building its
 * body text. Every routine cites the decompiled retail client
 * (reference/client-eol, build ac1_sep13): function name, address, and the
 * annotated-decomp line it starts on. Format strings and numeric constants
 * were read out of acclient.exe .rdata (the decomp loses many sprintf args);
 * see docs/retail-client-symbols.md for the workflow.
 *
 * Pure + DOM-free: no DAT loads here.
 */

// ─── C printf-style number formatting ────────────────────────────────────

/**
 * `%.<digits>f` — the CRT rounds the exact binary value. JS `toFixed` does
 * the same except on exact decimal ties, where it rounds up; C rounds a tie
 * to even. Ties only occur for values exactly representable in binary
 * (x.5, x.25 …), so handle those explicitly.
 */
export function cFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return String(x);
  const scale = Math.pow(10, digits);
  const scaled = x * scale;
  const floor = Math.floor(scaled);
  if (scaled - floor === 0.5 && Number.isInteger(scaled * 2)) {
    const even = floor % 2 === 0 ? floor : floor + 1;
    const neg = even < 0 || Object.is(even, -0) || (even === 0 && x < 0);
    const abs = Math.abs(even);
    const s = digits > 0
      ? `${Math.floor(abs / scale)}.${String(abs % scale).padStart(digits, '0')}`
      : String(abs);
    return (neg ? '-' : '') + s;
  }
  return x.toFixed(digits);
}

/** `%.<p>g` (C semantics: significant digits, trailing zeros stripped). */
export function cG(x: number, precision: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  const p = precision === 0 ? 1 : precision;
  const exp = Number(x.toExponential(p - 1).split('e')[1]);
  if (exp < -4 || exp >= p) {
    let [mant, e] = x.toExponential(p - 1).split('e');
    if (mant.includes('.')) mant = mant.replace(/0+$/, '').replace(/\.$/, '');
    const en = Number(e);
    return `${mant}e${en < 0 ? '-' : '+'}${String(Math.abs(en)).padStart(2, '0')}`;
  }
  let s = cFixed(x, Math.max(0, p - 1 - exp));
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

/** MSVC `_ftol2` — truncation toward zero. */
export function ftol(x: number): number {
  // x87 FISTP of a NaN / ±Inf / out-of-int32 value stores the "integer
  // indefinite" 0x80000000 — what retail prints for, e.g., a ManaRate of 0
  // (1/0) in "Mana Cost: 1 point per %d seconds.".
  if (!Number.isFinite(x) || x >= 2147483648 || x < -2147483648) return -2147483648;
  return Math.trunc(x);
}

/**
 * AC1Legacy::PStringBase<char>::InsertCommas — thousands grouping with ",".
 * Also the output shape of ExperienceSystem::XPToString @ 005c82d0
 * (GetNumberFormatA, Grouping 3, "," separator, 0 decimals).
 */
export function insertCommas(n: number | bigint): string {
  const neg = typeof n === 'bigint' ? n < 0n : n < 0;
  const digits = (typeof n === 'bigint' ? (neg ? -n : n) : Math.abs(Math.trunc(n))).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${grouped}` : grouped;
}

// ─── Modifier strings ─────────────────────────────────────────────────────

/**
 * ModifierToString @ 004ab1d0 (decomp line ~169795):
 *   sign = x < 1.0 ? '-' : '+';  sprintf("%c%d%%", sign, (int)(|1 − x| × 100 + 0.5))
 * (constants 1.0 @0x7928c0, 100.0 @0x7aeef0, 0.5 @0x798088 from the disassembly).
 */
export function modifierToString(x: number): string {
  const sign = x < 1.0 ? '-' : '+';
  return `${sign}${ftol(Math.abs(1.0 - x) * 100.0 + 0.5)}%`;
}

/**
 * SmallModifierToString @ 004ab240:
 *   sprintf("%c%.1lf%%", x < 1.0 ? '-' : '+', |1 − x| × 100)
 */
export function smallModifierToString(x: number): string {
  const sign = x < 1.0 ? '-' : '+';
  return `${sign}${cFixed(Math.abs(1.0 - x) * 100.0, 1)}%`;
}

// ─── AppraisalSystem enum → text ─────────────────────────────────────────

/** DAMAGE_TYPE bits (ACE DamageType.cs; decomp annotations). */
export const DAMAGE_TYPE = {
  Slash: 0x1, Pierce: 0x2, Bludgeon: 0x4, Cold: 0x8, Fire: 0x10, Acid: 0x20,
  Electric: 0x40, Nether: 0x400, Base: 0x10000000,
} as const;

/**
 * AppraisalSystem::DamageTypeToString @ 005b4200 — every set bit in this
 * fixed order, "/"-joined: Slashing, Piercing, Bludgeoning, Cold, Fire, Acid,
 * Electrical, Nether, Prismatic (BASE_DAMAGE_TYPE). Empty for none.
 */
export function damageTypeToString(type: number): string {
  const parts: string[] = [];
  if (type & DAMAGE_TYPE.Slash) parts.push('Slashing');
  if (type & DAMAGE_TYPE.Pierce) parts.push('Piercing');
  if (type & DAMAGE_TYPE.Bludgeon) parts.push('Bludgeoning');
  if (type & DAMAGE_TYPE.Cold) parts.push('Cold');
  if (type & DAMAGE_TYPE.Fire) parts.push('Fire');
  if (type & DAMAGE_TYPE.Acid) parts.push('Acid');
  if (type & DAMAGE_TYPE.Electric) parts.push('Electrical');
  if (type & DAMAGE_TYPE.Nether) parts.push('Nether');
  if (type & DAMAGE_TYPE.Base) parts.push('Prismatic');
  return parts.join('/');
}

/** rgWorkmanshipStrings (globals.tsv, 0x8215fc) — index 0 is "". */
export const WORKMANSHIP_STRINGS: readonly string[] = [
  '', 'Poorly ', 'Well-', 'Finely ', 'Exquisitely ', 'Magnificent', 'Nearly flawless',
  'Flawless', 'Utterly flawless', 'Incomparable', 'Priceless',
];

/**
 * AppraisalSystem::InqWorkmanshipAdjective @ 005b48e0: index clamped to 10;
 * below 5 the word "crafted" (or "cut" when `cut` is set) is appended.
 */
export function workmanshipAdjective(workmanship: number, cut = false): string {
  const i = Math.min(Math.max(0, workmanship >>> 0), 10);
  let s = WORKMANSHIP_STRINGS[i] ?? '';
  if (i < 5) s += cut ? 'cut' : 'crafted';
  return s;
}

/**
 * AppraisalSystem::WeaponTimeToString @ 005b4970:
 *   < 11 Very Fast, < 31 Fast, ≤ 49 Average, < 80 Slow, else Very Slow.
 */
export function weaponTimeToString(t: number): string {
  if (t < 0xb) return 'Very Fast';
  if (t < 0x1f) return 'Fast';
  if (t <= 0x31) return 'Average';
  if (t < 0x50) return 'Slow';
  return 'Very Slow';
}

/**
 * AppraisalSystem::SkillToString @ 005b4a30 — the hardcoded skill names the
 * weapon "Skill: " line uses (NOT the SkillTable; ids 48 Shield and ≥ 55 are
 * absent from the retail switch).
 */
export const APPRAISAL_SKILL_NAMES: Readonly<Record<number, string>> = {
  1: 'Axe', 2: 'Bow', 3: 'Crossbow', 4: 'Dagger', 5: 'Mace', 6: 'Melee Defense',
  7: 'Missile Defense', 8: 'Sling', 9: 'Spear', 10: 'Staff', 11: 'Sword',
  12: 'Thrown Weapon', 13: 'Unarmed Combat', 14: 'Arcane Lore', 15: 'Magic Defense',
  16: 'Mana Conversion', 17: 'Spellcraft', 18: 'Item Tinkering', 19: 'Person Appraisal',
  20: 'Deception', 21: 'Healing', 22: 'Jump', 23: 'Lockpick', 24: 'Run', 25: 'Awareness',
  26: 'Armor Repair', 27: 'Creature Appraisal', 28: 'Weapon Tinkering', 29: 'Armor Tinkering',
  30: 'Magic Item Tinkering', 31: 'Creature Enchantment', 32: 'Item Enchantment',
  33: 'Life Magic', 34: 'War Magic', 35: 'Leadership', 36: 'Loyalty', 37: 'Fletching',
  38: 'Alchemy', 39: 'Cooking', 40: 'Salvaging', 41: 'Two Handed Combat', 42: 'Gearcraft',
  43: 'Void Magic', 44: 'Heavy Weapons', 45: 'Light Weapons', 46: 'Finesse Weapons',
  47: 'Missile Weapons', 49: 'Dual Wield', 50: 'Recklessness', 51: 'Sneak Attack',
  52: 'Dirty Fighting', 53: 'Challenge', 54: 'Summoning',
};

/**
 * AppraisalSystem::ClothingPriorityToString @ 005b4f30 — "Covers " + the
 * covered parts ", "-joined in retail's fixed order. Returns null when no
 * bit matched (retail returns 0 and the line is skipped).
 */
export function clothingPriorityToString(priority: number): string | null {
  const parts: string[] = [];
  if (priority & 0x4000) parts.push('Head');
  if (priority & (0x8 | 0x400)) parts.push('Chest');
  if (priority & (0x10 | 0x800)) parts.push('Abdomen');
  if (priority & (0x20 | 0x1000)) parts.push('Upper Arms');
  if (priority & (0x40 | 0x2000)) parts.push('Lower Arms');
  if (priority & 0x8000) parts.push('Hands');
  if (priority & (0x2 | 0x100)) parts.push('Upper Legs');
  if (priority & (0x4 | 0x200)) parts.push('Lower Legs');
  if (priority & 0x10000) parts.push('Feet');
  return parts.length ? `Covers ${parts.join(', ')}` : null;
}

/** Armor resistance label (DamageResistanceToString's per-type prefix). */
const RESIST_LABEL: Readonly<Record<number, string>> = {
  [DAMAGE_TYPE.Slash]: 'Slashing: ', [DAMAGE_TYPE.Pierce]: 'Piercing: ',
  [DAMAGE_TYPE.Bludgeon]: 'Bludgeoning: ', [DAMAGE_TYPE.Cold]: 'Cold: ',
  [DAMAGE_TYPE.Fire]: 'Fire: ', [DAMAGE_TYPE.Acid]: 'Acid: ',
  [DAMAGE_TYPE.Electric]: 'Electric: ', [DAMAGE_TYPE.Nether]: 'Nether: ',
};

/** DamageResistanceToString's negative-mod replacement sentences. */
const RESIST_NEGATIVE: Readonly<Record<number, string>> = {
  [DAMAGE_TYPE.Slash]: 'Your armor will rend and slash you if hit.',
  [DAMAGE_TYPE.Pierce]: 'Your armor will cave in and pierce you if hit.',
  [DAMAGE_TYPE.Bludgeon]: 'Your armor will shatter and bruise you if hit.',
  [DAMAGE_TYPE.Cold]: 'Your armor is unnaturally cold.',
  [DAMAGE_TYPE.Fire]: 'Your armor is flammable.',
  [DAMAGE_TYPE.Acid]: 'Your armor itches and burns your skin.',
  [DAMAGE_TYPE.Electric]: 'Your armor is extremely conductive.',
  [DAMAGE_TYPE.Nether]: 'Your armor is infused with shadow.',
};

/** F_EPSILON (float @0x7e65bc = 0.0002f). */
const F_EPSILON = Math.fround(0.0002);

/**
 * AppraisalSystem::DamageResistanceToString @ 005b5490 (logic read from the
 * disassembly — the decomp mangles the x87 compares). `mod` is the float
 * ArmorProfile mod; thresholds are the doubles 0.4/0.8/1.2/1.6/2.0:
 *   mod < −ε           → "<Type>: " then REPLACED by "Your armor … if hit."
 *   |mod| ≤ ε          → "No"
 *   ε < mod ≤ 0.4      → Poor
 *   0.4 < mod ≤ 0.8    → Below Average
 *   0.8 < mod < 1.2    → Average
 *   1.2 ≤ mod < 1.6    → Above Average
 *   1.6 ≤ mod < 2.0    → Excellent
 *   mod ≥ 2.0          → Unparalleled (and mod clamped to 2.0)
 * then always appends sprintf("  (%.0f)", armorLevel × mod).
 */
export function damageResistanceToString(type: number, armorLevel: number, modIn: number): string | null {
  const label = RESIST_LABEL[type];
  if (label === undefined) return null;
  let mod = Math.fround(modIn);
  let s = label;
  if (-F_EPSILON <= mod) {
    if (!(F_EPSILON < Math.abs(mod))) s += 'No';
    else if (mod > 0 && mod <= 0.4) s += 'Poor';
    else if (mod > 0.4 && mod <= 0.8) s += 'Below Average';
    else if (mod > 0.8 && mod < 1.2) s += 'Average';
    else if (mod >= 1.2 && mod < 1.6) s += 'Above Average';
    else if (mod >= 1.6 && mod < 2.0) s += 'Excellent';
    else if (mod >= 2.0) { mod = 2.0; s += 'Unparalleled'; }
  }
  if (mod < -F_EPSILON) s = RESIST_NEGATIVE[type];
  return `${s}  (${cFixed(armorLevel * mod, 0)})`;
}

/**
 * AppraisalSystem::LockpickSuccessPercentToString @ 005b4600.
 */
export function lockpickSuccessPercentToString(pct: number): string | null {
  if (pct < 0) return null;
  if (pct === 0) return 'impossible';
  if (pct < 5) return 'ridiculously difficult';
  if (pct < 15) return 'extremely difficult';
  if (pct < 35) return 'quite difficult';
  if (pct < 50) return 'difficult';
  if (pct < 70) return 'challenging';
  if (pct < 85) return 'mildly challenging';
  if (pct < 95) return 'easy';
  return 'trivial';
}

/** AppraisalSystem::BondedStatusToString @ 005b4880. */
export function bondedStatusToString(v: number): string | null {
  if (v === -2) return 'Destroyed on Death';
  if (v === -1) return 'Dropped on Death';
  if (v === 1) return 'Bonded';
  return null;
}

/** AppraisalSystem::AttunedStatusToString @ 005b4850 (1..2 → Attuned). */
export function attunedStatusToString(v: number): string | null {
  return v > 0 && v < 3 ? 'Attuned' : null;
}

/** SkillSystem::InqAttributeName @ 005c8800. */
export const ATTRIBUTE_NAMES: Readonly<Record<number, string>> = {
  1: 'Strength', 2: 'Endurance', 3: 'Quickness', 4: 'Coordination', 5: 'Focus', 6: 'Self',
};

/** SkillSystem::InqAttribute2ndName @ 005c88a0. */
export const VITAL_NAMES: Readonly<Record<number, string>> = {
  1: 'Maximum Health', 2: 'Health', 3: 'Maximum Stamina', 4: 'Stamina', 5: 'Maximum Mana', 6: 'Mana',
};

/**
 * ClientUISystem::DeltaTimeToString @ 00565e10 — "%dmo %dd %dh %dm %ds"
 * (month = 2 592 000 s), leading zero units skipped, seconds always
 * printed, trailing space dropped.
 */
export function deltaTimeToString(seconds: number): string {
  let t = ftol(seconds) >>> 0;
  const mo = Math.floor(t / 2592000); t %= 2592000;
  const d = Math.floor(t / 86400); t %= 86400;
  const h = Math.floor(t / 3600); t %= 3600;
  const m = Math.floor(t / 60); const s = t % 60;
  let out = '';
  if (mo) out += `${mo}mo `;
  if (d) out += `${d}d `;
  if (h) out += `${h}h `;
  if (m) out += `${m}m `;
  out += `${s}s `;
  return out.slice(0, -1);
}

// ─── Levelable items (ExperienceSystem) ──────────────────────────────────

/**
 * ExperienceSystem::ItemTotalXPToLevel @ 005c81b0 (style 1 fixed, 2 doubling,
 * 3 arithmetic steps base, 2·base, 3·base …), clamped to maxLevel.
 */
export function itemTotalXpToLevel(totalXp: bigint, baseXp: bigint, maxLevel: number, style: number): number {
  let level = 0;
  if (style === 1) {
    level = baseXp > 0n ? Number(totalXp / baseXp) : 0;
  } else if (style === 2) {
    let remain = totalXp; let step = baseXp;
    if (step > 0n) while (step <= remain) { level++; remain -= step; step *= 2n; }
  } else if (style === 3) {
    let remain = totalXp; let step = baseXp;
    if (step > 0n) while (step <= remain) { level++; remain -= step; step += baseXp; }
  }
  return Math.min(level, maxLevel);
}

/** ExperienceSystem::ItemLevelToTotalXP @ 005c8100 (inverse of the above). */
export function itemLevelToTotalXp(level: number, baseXp: bigint, maxLevel: number, style: number): bigint {
  if (level < 1) return 0n;
  const lv = Math.min(level, maxLevel);
  if (style === 1) return BigInt(lv) * baseXp;
  let total = baseXp; let step = baseXp;
  for (let i = 1; i < lv; i++) {
    if (style === 2) step *= 2n; else if (style === 3) step += baseXp; else return 0n;
    total += step;
  }
  return style === 2 || style === 3 ? total : 0n;
}
