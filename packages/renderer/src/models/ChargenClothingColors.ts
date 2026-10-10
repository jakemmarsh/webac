import type { CloSubPalEffect } from '@ac/dat-parser/file-types/ClothingTable.js';

/**
 * BUG.cap-palette-template-0-black — the chargen clothing colour choices.
 *
 * Retail keeps, per clothing slot, the list of palette TEMPLATE ids the
 * chosen item can wear (CharGenState::StoreColorInformation @ 005c44d0,
 * called by SetHeadgearStyle @ 005c5350 / SetShirtStyle / SetTrousersStyle /
 * SetFootwearStyle): it walks the item's ClothingTable CloPaletteTemplate
 * hash table and keeps every key that is also in Sex_CG.mClothingColorsList,
 * storing the key in `xPaletteTemplateIDs[n]` and the template's first
 * CloSubpalEffect.palSet (offset 0x10 of the 0x14-byte CloSubpalEffect) in
 * `xPalSetIDs[n]`. The colour spot the player picks is an INDEX into that
 * list; CharGenState::GetCharGenResult @ 005c4030 converts it to the
 * template id for the wire (`0 <= idx < num ? ids[idx] : 0`).
 *
 * ACE uses the wire value directly as the item's PaletteTemplate
 * (PlayerFactory.cs GetClothingObject → SetProperties(palette, shade)) and
 * later looks it up in ClothingSubPalEffects (Creature_Networking.cs
 * CalculateObjDesc). Sending the raw index made every starter item
 * PaletteTemplate 0..8 — 0 is never a key, so ACE fell back to the table's
 * first template (a Cap's is template 1, PaletteSet 0x0F000001, whose shade-0
 * palette 0x040005F3 is near-black over the cap's 2000..2047 range).
 *
 * The hash iteration order is the DAT's serialized order (PackableHashTable
 * packs by bucket walk), which our ClothingTable Map preserves.
 */
export interface ClothingColorChoices {
  /** Palette template ids, in retail's spot order. */
  readonly templateIds: readonly number[];
  /** Each template's first CloSubPalette palette set (the spot / shade-disk set). */
  readonly palSetIds: readonly number[];
}

export const NO_CLOTHING_COLORS: ClothingColorChoices = { templateIds: [], palSetIds: [] };

/** CharGenState::StoreColorInformation @ 005c44d0. */
export function storeColorInformation(
  table: { clothingSubPalEffects: ReadonlyMap<number, CloSubPalEffect> } | null | undefined,
  sexClothingColors: readonly number[],
): ClothingColorChoices {
  if (!table) return NO_CLOTHING_COLORS;
  const templateIds: number[] = [];
  const palSetIds: number[] = [];
  for (const [key, template] of table.clothingSubPalEffects) {
    if (!sexClothingColors.includes(key)) continue;
    templateIds.push(key);
    palSetIds.push(template.cloSubPalettes[0]?.paletteSet ?? 0);
  }
  return { templateIds, palSetIds };
}

/** CharGenState::GetCharGenResult @ 005c4030 — the colour index → the wire's palette template id. */
export function paletteTemplateIdFor(choices: ClothingColorChoices, colorIndex: number): number {
  return colorIndex >= 0 && colorIndex < choices.templateIds.length ? choices.templateIds[colorIndex] : 0;
}

/** The four clothing slots' colour choices for the current chargen appearance. */
export interface ChargenClothingColors {
  readonly headgear: ClothingColorChoices;
  readonly shirt: ClothingColorChoices;
  readonly pants: ClothingColorChoices;
  readonly footwear: ClothingColorChoices;
}

/**
 * The sub-palette overlay ACE builds for one worn item (Creature_Networking.cs
 * CalculateObjDesc): the item's template (or the table's first one when the
 * template is not a key), and per CloSubPalette the palette
 * PaletteSet.GetPaletteID(shade) picks, over each range. Offsets/lengths are
 * in palette entries (ACE divides by 8 for the wire; the client multiplies back).
 */
export function clothingSubPaletteRanges(
  table: { clothingSubPalEffects: ReadonlyMap<number, CloSubPalEffect> } | null | undefined,
  paletteTemplate: number,
  resolvePaletteSet: (paletteSetId: number) => number,
): { paletteId: number; offset: number; length: number }[] {
  if (!table || table.clothingSubPalEffects.size === 0) return [];
  const effect = table.clothingSubPalEffects.get(paletteTemplate)
    ?? table.clothingSubPalEffects.values().next().value!;
  const out: { paletteId: number; offset: number; length: number }[] = [];
  for (const sub of effect.cloSubPalettes) {
    const paletteId = resolvePaletteSet(sub.paletteSet);
    for (const r of sub.ranges) out.push({ paletteId, offset: r.offset, length: r.numColors });
  }
  return out;
}
