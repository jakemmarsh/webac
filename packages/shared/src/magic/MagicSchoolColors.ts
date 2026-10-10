/**
 * MagicSchoolColors — canonical chat / tooltip / icon-tint colors for the
 * five AC magic schools.
 *
 * Sources of truth:
 * - reference/ACE/Source/ACE.Entity/Enum/MagicSchool.cs (the enum values).
 * - Original AC client: each school is rendered in a distinct color across
 *   the spellbook tabs, spell tooltips, enchantment buff/debuff lists, and
 *   spell-projectile particle tints. The values below match the colors
 *   that have been used throughout this codebase since the spellbook /
 *   tooltip work and align with the well-documented school identities
 *   (War=red, Life=green, Item=orange, Creature=blue, Void=purple).
 *
 * Centralized here so combat log, target-enchantment list, spell tooltips,
 * and any future school-aware UI all pick the same value — same pattern as
 * `chatColorFor` for ChatMessageType.
 */

import { MagicSchool } from './SpellEngine.js';

/** Default color for unrecognized / None — neutral light grey. */
const SCHOOL_FALLBACK = '#706850';
const SCHOOL_FALLBACK_NUM = 0x706850;

const COLOR: Record<number, string> = {
  [MagicSchool.WarMagic]: '#e04040',            // red
  [MagicSchool.LifeMagic]: '#40c040',           // green
  [MagicSchool.ItemEnchantment]: '#e0a040',     // orange
  [MagicSchool.CreatureEnchantment]: '#4080e0', // blue
  [MagicSchool.VoidMagic]: '#a040e0',           // purple
};

const COLOR_NUM: Record<number, number> = {
  [MagicSchool.WarMagic]: 0xe04040,
  [MagicSchool.LifeMagic]: 0x40c040,
  [MagicSchool.ItemEnchantment]: 0xe0a040,
  [MagicSchool.CreatureEnchantment]: 0x4080e0,
  [MagicSchool.VoidMagic]: 0xa040e0,
};

/**
 * Slightly brighter "emissive glow" sibling colors used by 3D projectile /
 * aura particles to drive `MeshStandardMaterial.emissive`. They are the
 * same hue family as `COLOR_NUM` but desaturated and shifted brighter so
 * the emissive halo reads as a glow rather than a solid disc.
 */
const EMISSIVE_NUM: Record<number, number> = {
  [MagicSchool.WarMagic]: 0xff6633,
  [MagicSchool.LifeMagic]: 0x66e066,
  [MagicSchool.ItemEnchantment]: 0xffd066,
  [MagicSchool.CreatureEnchantment]: 0x66a0ff,
  [MagicSchool.VoidMagic]: 0xc066ff,
};

/** CSS hex color string for a magic school. Returns the fallback for None / unknown. */
export function magicSchoolColor(school: number): string {
  return COLOR[school] ?? SCHOOL_FALLBACK;
}

/** Numeric (0xRRGGBB) color for a magic school — same hue as `magicSchoolColor`, for 3D rendering. */
export function magicSchoolColorNum(school: number): number {
  return COLOR_NUM[school] ?? SCHOOL_FALLBACK_NUM;
}

/** Numeric emissive-glow color for a magic school — slightly brighter than the base color. */
export function magicSchoolEmissiveNum(school: number): number {
  return EMISSIVE_NUM[school] ?? SCHOOL_FALLBACK_NUM;
}

/**
 * Display name for a MagicSchool enum value — the canonical retail labels
 * used across spell tooltips, the foci panel, character info, and any
 * other UI that surfaces a school name.
 *
 * Values match the long-standing AC community/retail strings ("War Magic",
 * "Life Magic", "Item Enchantment", "Creature Enchantment", "Void Magic").
 * Returns "None" for MagicSchool.None (0) and "Unknown" for any future
 * additions to ACE's MagicSchool enum.
 *
 * FAITHFUL.288 — replaces two inline duplications in GameUI.ts (an
 * ordinal-indexed array at the spell-bar tooltip and an enum-keyed array
 * at the foci panel). Same pattern as `magicSchoolColor` / `…ColorRGBA`
 * (FAITHFUL.49 / .286) — single source-of-truth helper avoids drift.
 */
export function magicSchoolName(school: number): string {
  switch (school) {
    case 0: return 'None';
    case 1: return 'War Magic';
    case 2: return 'Life Magic';
    case 3: return 'Item Enchantment';
    case 4: return 'Creature Enchantment';
    case 5: return 'Void Magic';
    default: return 'Unknown';
  }
}

/**
 * CSS rgba(r,g,b,a) string for a magic school — same hue as
 * `magicSchoolColor` / `magicSchoolColorNum`, with a caller-supplied
 * alpha. Used by the spell-bar slot background tint where the school
 * color shows through behind the spell icon.
 *
 * FAITHFUL.286 — pre-port the spell bar had its own inline RGBA map
 * with slightly different hues (`rgba(204,68,68,0.6)` vs this module's
 * canonical War=#e04040) and a hardcoded 0.6 alpha. Now both the chat
 * tooltip path and the spell-bar tint path render from the same
 * canonical RGB triples — any future palette tweak only happens here.
 */
export function magicSchoolColorRGBA(school: number, alpha: number): string {
  const num = COLOR_NUM[school] ?? SCHOOL_FALLBACK_NUM;
  const r = (num >> 16) & 0xff;
  const g = (num >> 8)  & 0xff;
  const b =  num        & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
