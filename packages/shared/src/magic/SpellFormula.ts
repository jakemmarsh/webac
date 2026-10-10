/**
 * SpellFormula — spell component system: scarabs, herbs, tapers, foci.
 *
 * Ports ACE SpellFormula.cs and SpellTable.GetSpellFormula() exactly.
 *
 * Component types:
 *   1=Scarab, 2=Herb, 3=Powder, 4=Potion, 5=Talisman, 6=Taper
 *
 * Foci simplify formulas to: scarabs + prismatic tapers (component 188).
 * Player formulas randomize taper slots based on account name hash.
 *
 * Reference:
 *   ACE SpellFormula.cs, SpellTable.cs lines 32-172
 */

// ─── Scarab Enum ────────────────────────────────────────────

/** Scarab component IDs — determines spell power level and windup animation */
export enum Scarab {
  Lead     = 1,
  Iron     = 2,
  Copper   = 3,
  Silver   = 4,
  Gold     = 5,
  Pyreal   = 6,
  Diamond  = 110,
  Platinum = 112,
  Dark     = 192,
  Mana     = 193,
}

/** Component type IDs from SpellComponentsTable */
export enum ComponentType {
  Scarab   = 1,
  Herb     = 2,
  Powder   = 3,
  Potion   = 4,
  Talisman = 5,
  Taper    = 6,
}

/** Minimum spell power threshold per level */
export const MIN_POWER_BY_LEVEL: Record<number, number> = {
  1:   1,
  2:  50,
  3: 100,
  4: 150,
  5: 200,
  6: 250,
  7: 300,
  8: 400,
};

/** Maximum spell level in retail */
export const MAX_SPELL_LEVEL = 8;

/**
 * Compute spell level (I–VIII) from `SpellBase.power`, matching the
 * authoritative server-side formula at
 * `reference/ACE/Source/ACE.Server/Entity/Spell.cs:92-105`:
 *
 *   for (uint spellLevel = MaxSpellLevel; spellLevel > 0; spellLevel--)
 *     if (Power >= MinPower[spellLevel]) return spellLevel;
 *   return 0;
 *
 * The thresholds (`MIN_POWER_BY_LEVEL`) come from
 * `ACE.Server/Entity/SpellFormula.cs:95-105`:
 *   L1=1, L2=50, L3=100, L4=150, L5=200, L6=250, L7=300, L8=400.
 *
 * Pre-FAITHFUL.331 two call sites in `packages/renderer/src/main.ts`
 * (PlayerDescription bulk-learn + onMagicUpdateSpell) used
 * `Math.min(8, Math.max(1, Math.ceil(power / 50)))` which mis-bucketed
 * every Level II–VII spell at its canonical power value:
 *   power=50  → 1 (should be 2)
 *   power=100 → 2 (should be 3)
 *   power=150 → 3 (should be 4)
 *   power=200 → 4 (should be 5)
 *   power=250 → 5 (should be 6)
 *   power=300 → 6 (should be 7)
 * Caused every mid-tier known spell in the spellbook + spell-bar tooltip
 * to display one Roman numeral lower than retail.
 */
export function spellLevelFromPower(power: number): number {
  for (let level = MAX_SPELL_LEVEL; level > 0; level--) {
    if (power >= MIN_POWER_BY_LEVEL[level]) return level;
  }
  return 0;
}

/** Lowest taper ID in the SpellComponentsTable (Red Taper) */
const LOWEST_TAPER_ID = 63;

// ─── All valid scarab IDs ───────────────────────────────────

const SCARAB_IDS = new Set<number>([
  Scarab.Lead, Scarab.Iron, Scarab.Copper, Scarab.Silver,
  Scarab.Gold, Scarab.Pyreal, Scarab.Diamond, Scarab.Platinum,
  Scarab.Dark, Scarab.Mana,
]);

/** Returns true if a component ID is a scarab */
export function isScarab(componentId: number): boolean {
  return SCARAB_IDS.has(componentId);
}

// ─── Account Name Hash ──────────────────────────────────────

/**
 * Compute the account name hash used for spell formula randomization.
 *
 * ACE SpellTable.cs ComputeHash(), lines 32-50
 * Uses Windows-1252 encoding semantics (ASCII subset for typical names).
 */
export function computeAccountHash(accountName: string): number {
  let result = 0;

  for (let i = 0; i < accountName.length; i++) {
    const c = accountName.charCodeAt(i) & 0xFF;
    // Treat as signed byte
    const signed = c > 127 ? c - 256 : c;
    result = signed + ((result << 4) >>> 0);

    const high = result & 0xF0000000;
    if (high !== 0) {
      result = ((result ^ ((high >>> 24))) & 0x0FFFFFFF) >>> 0;
    }
  }

  return result >>> 0; // ensure unsigned
}

// ─── Player Formula Randomization ───────────────────────────

/**
 * Randomize a spell formula based on account name.
 * Replaces taper slots with pseudo-random taper IDs.
 *
 * ACE SpellTable.cs GetSpellFormula(), lines 58-172
 * Three formula versions, each with different randomization logic.
 */
export function getPlayerFormula(
  baseFormula: number[],
  formulaVersion: number,
  accountName: string,
): number[] {
  switch (formulaVersion) {
    case 1: return randomizeVersion1(baseFormula, accountName);
    case 2: return randomizeVersion2(baseFormula, accountName);
    case 3: return randomizeVersion3(baseFormula, accountName);
    default: return [...baseFormula];
  }
}

function randomizeVersion1(formula: number[], accountName: string): number[] {
  const comps = [...formula];
  let hasTaper1 = false;
  let hasTaper2 = false;
  let hasTaper3 = false;

  const key = computeAccountHash(accountName);
  const seed = key % 0x13D573;

  const scarab = comps[0];
  let herbIndex = 1;
  if (comps.length > 5) {
    herbIndex = 2;
    hasTaper1 = true;
  }
  const herb = comps[herbIndex];

  let powderIndex = herbIndex + 1;
  if (comps.length > 6) {
    powderIndex++;
    hasTaper2 = true;
  }
  const powder = comps[powderIndex];

  const potionIndex = powderIndex + 1;
  const potion = comps[potionIndex];

  let talismanIndex = potionIndex + 1;
  if (comps.length > 7) {
    talismanIndex++;
    hasTaper3 = true;
  }
  const talisman = comps[talismanIndex];

  if (hasTaper1) {
    comps[1] = (powder + 2 * herb + potion + talisman + scarab) % 0xC + LOWEST_TAPER_ID;
  }

  if (hasTaper2) {
    comps[3] = ((scarab + herb + talisman + 2 * (powder + potion)) *
      Math.floor(seed / (scarab + (powder + potion)))) % 0xC + LOWEST_TAPER_ID;
  }

  if (hasTaper3) {
    comps[6] = ((powder + 2 * talisman + potion + herb + scarab) *
      Math.floor(seed / (talisman + scarab))) % 0xC + LOWEST_TAPER_ID;
  }

  return comps;
}

function randomizeVersion2(formula: number[], accountName: string): number[] {
  const comps = [...formula];

  const key = computeAccountHash(accountName);
  const seed = key % 0x13D573;

  const p1 = comps[0];
  const c = comps[4];
  const x = comps[5];
  const a = comps[7];

  comps[3] = (a + 2 * comps[0] + 2 * c * x + comps[0] + comps[2] + comps[1]) % 0xC + LOWEST_TAPER_ID;
  comps[6] = ((a + 2 * p1 * comps[2] + 2 * x + p1 * comps[2] + c) *
    Math.floor(seed / (comps[1] * a + 2 * c))) % 0xC + LOWEST_TAPER_ID;

  return comps;
}

function randomizeVersion3(formula: number[], accountName: string): number[] {
  const comps = [...formula];

  const key = computeAccountHash(accountName);
  const seed1 = key % 0x13D573;
  const seed2 = key % 0x4AEFD;
  const seed3 = key % 0x96A7F;
  const seed4 = key % 0x100A03;
  const seed5 = key % 0xEB2EF;
  const seed6 = key % 0x121E7D;

  const compHash0 = (seed1 + comps[0]) % 0xC;
  const compHash1 = (seed2 + comps[1]) % 0xC;
  const compHash2 = (seed3 + comps[2]) % 0xC;
  const compHash4 = (seed4 + comps[4]) % 0xC;
  const compHash5 = (seed5 + comps[5]) % 0xC;

  // Some spells don't have full 8 components (e.g., spell 2697 "Aerfalle's Touch")
  const compHash7 = comps.length < 8
    ? (seed6 + 0) % 0xC
    : (seed6 + comps[7]) % 0xC;

  comps[3] = (compHash0 + compHash1 + compHash2 + compHash4 + compHash5 +
    compHash2 * compHash5 + compHash0 * compHash1 +
    compHash7 * (compHash4 + 1)) % 0xC + LOWEST_TAPER_ID;

  comps[6] = (compHash0 + compHash1 + compHash2 + compHash4 +
    key % 0x65039 % 0xC +
    compHash7 * (compHash4 * (compHash0 * compHash1 * compHash2 * compHash5 + 7) + 1) +
    compHash5 + 4 * compHash0 * compHash1 + compHash0 * compHash1 +
    11 * compHash2 * compHash5) % 0xC + LOWEST_TAPER_ID;

  return comps;
}

// ─── Cast Gesture Sequence (GAP.11) ─────────────────────────

/** Minimal shape of a SpellComponentTable entry needed for gestures. */
export interface SpellComponentGestureInfo {
  type: number;
  gesture: number;
}

const MOTION_INVALID = 0x80000000;
const MOTION_READY = 0x41000003;

/**
 * ACE-exact cast choreography from a PLAYER formula (already account-salted
 * via getPlayerFormula): one windup gesture per scarab component
 * (SpellFormula.cs:245 WindupGestures — Lead Scarab's gesture is Invalid and
 * plays as nothing; FastCast spells skip windups, Player_Magic.cs:607),
 * then the talisman's cast gesture from the LAST component
 * (SpellFormula.cs:271 CastGesture — Ready when the last component isn't a
 * talisman, Player_Magic.cs:680 fallback).
 * Returns null for an empty formula (caller falls back to a generic cast).
 */
export function getCastGestureSequence(
  playerFormula: number[],
  components: ReadonlyMap<number, SpellComponentGestureInfo>,
  fastCast: boolean,
): number[] | null {
  if (!playerFormula.length) return null;
  const gestures: number[] = [];
  if (!fastCast) {
    for (const comp of playerFormula) {
      if (!isScarab(comp)) continue;
      const g = components.get(comp)?.gesture ?? MOTION_INVALID;
      if ((g >>> 0) !== MOTION_INVALID) gestures.push(g);
    }
  }
  const talisman = components.get(playerFormula[playerFormula.length - 1]);
  const castGesture = talisman && talisman.type === ComponentType.Talisman && ((talisman.gesture >>> 0) !== MOTION_INVALID)
    ? talisman.gesture
    : MOTION_READY;
  gestures.push(castGesture);
  return gestures;
}
