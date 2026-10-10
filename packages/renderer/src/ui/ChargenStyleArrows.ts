/**
 * VISUAL.chargen-swatch-colours.a — the chargen Appearance page's style
 * arrows (decompiled EoL client,
 * reference/client-eol/decomp/acclient-decompiled.annotated.c).
 *
 * Retail picks a style ONLY with the two arrows inside each category row:
 * every row (0x100003af–b3 Face, 0x100003b5–b8 Clothes, bound as
 * m_p*Spin in gmCGAppearancePage::InitializePage @ 0047fdd0) is an instance
 * of template 0x2100004c:0x10000309 (175x44), whose children 0x1000030a
 * (80,0) 47x44 and 0x1000030b (127,0) 47x44 carry no media — the arrow art
 * is part of the panel fill 0x06004cca behind the rows. InitializePage
 * switches the Skin row's two arrows off (SetAttribute_Bool(0xd, true)).
 * There is no style-name list and no style-icon grid anywhere on the page:
 * the page's element-message switch (ListenToElementMessage @ 0047ef30,
 * :129239) handles the arrows, the row buttons, the colour wheel and the
 * view buttons, and Update (:129027) only writes the row labels.
 *
 * ListenToElementMessage, message 1 on 0x1000030a (−1) / 0x1000030b (+1),
 * switching on the row the arrow belongs to:
 *   - hair / eyes / nose / mouth / shirt / trousers / footwear: wrap over
 *     [0, n) (≥ n → 0, < 0 → n − 1);
 *   - headgear: wrap over [−1, n) — −1 is "no headgear" (≥ n → −1, < −1 →
 *     n − 1);
 * then CharGenState::Set*Style (clothing: SetHeadgearStyle @ 005c5350 clamps
 * the colour index into the new item's list) and SetSelection(part), which
 * makes that row the current selection — the preview updates through
 * gmCG3DView::Update.
 */
import type { LayoutDescData } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { findElementByPath } from './DatTextStyle.js';

/** The template's arrow hit regions inside a 175x44 row. */
export const STYLE_ARROW_PREV = { elementId: 0x1000030a, x: 80, y: 0, width: 47, height: 44 } as const;
export const STYLE_ARROW_NEXT = { elementId: 0x1000030b, x: 127, y: 0, width: 47, height: 44 } as const;

/** The next style index for an arrow press (`allowNone`: headgear's −1 slot). */
export function stepChargenStyle(current: number, count: number, dir: -1 | 1, allowNone = false): number {
  const next = current + dir;
  if (next >= count) return allowNone ? -1 : 0;
  if (next < 0 && !(allowNone && next === -1)) return count - 1;
  return next;
}

/** CharGenState::Set*Style's colour clamp: into [0, numColors − 1] (−1 when the item has none). */
export function clampChargenColor(color: number, numColors: number): number {
  let c = color < 0 ? 0 : color;
  if (numColors <= c) c = numColors - 1;
  return c;
}

/**
 * A chargen appearance category row's rect inside the 0x21000049 stack
 * 0x100003ad: the row element's own DAT geometry (face group 0x100003ae
 * rows 0x100003af..b3, clothes group 0x100003b4 rows 0x100003b5..b8 — 200×44
 * at a 45-px pitch). Without a layout, the same DAT values by index.
 */
export function chargenCategoryRowRect(
  layout: LayoutDescData | null, group: number, rowId: number, index: number,
): { y: number; width: number; height: number } {
  const d = findElementByPath(layout, [0x100003ad, group, rowId]);
  return { y: d?.y ?? index * 45, width: d?.width ?? 200, height: d?.height ?? 44 };
}
