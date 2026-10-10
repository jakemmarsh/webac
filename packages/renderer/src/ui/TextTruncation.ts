/**
 * CORE.17.k.b.b.a.g.a — UIElement_Text's truncation (the "..." trailer) and
 * the tooltip that comes with it.
 *
 * Ground truth (the decompiled EoL client, docs/retail-client-symbols.md
 * CORE.17.k.b.b.a.g.a):
 *  - UIElement_Text::OnSetAttribute case 199 (p199, a StringInfo): a valid
 *    string → SetTruncateTextToFit(true) and the trailer glyph list
 *    (m_glTruncate); 31 EoL layout elements carry it, always "..."
 *    (str#58579907) — the toolbar's selected-item name 0x21000016:0x1000019f,
 *    the character panel's row texts 0x2100001b:0x1000012a / 0x2100001c:
 *    0x1000012b, the stat pane header 0x21000045:0x10000231, the current
 *    title 0x2100005e:0x1000052f, the spell bar's spell name 0x1000048b …
 *  - UIElement_Text::RecalculateGlyphList @ 00468420 / DrawStart @ 00468890:
 *    with the bit (0x800) set → RecalculateTruncation @ 00466f80: when the
 *    element is narrower than the laid-out text (horizontal mode, bit 0x2),
 *    the text is cut at GlyphList::FindPosFromLineAndPixels(width − margins −
 *    the trailer's width) and the trailer follows; the same for the height in
 *    vertical (wrapped) mode.
 *  - p208 (0xd0, a Bool) on the same element → the FULL text becomes the
 *    element's tooltip (UIElement::SetTooltip + the SetTooltipOn bit) — every
 *    clipped label shows its whole text on hover. All 31 p199 carriers set it.
 */

/** p199 — the truncation trailer StringInfo (its presence turns truncation on). */
export const TRUNCATION_TRAILER_PROPERTY = 199;
/** p208 — the truncated text's full string becomes its tooltip. */
export const TRUNCATION_TOOLTIP_PROPERTY = 208;
/** str#58579907 in table 0x23000001 — the trailer every EoL carrier names. */
export const TRUNCATION_TRAILER_STRING = 58579907;
export const TRUNCATION_TRAILER_TEXT = '...';

export interface TruncationResult {
  /** What is drawn: the text itself, or its longest fitting prefix + the trailer. */
  text: string;
  /** Whether the trailer was applied (RecalculateTruncation's `width < needed` branch). */
  truncated: boolean;
}

/**
 * RecalculateTruncation @ 00466f80 for a single-line (horizontal) text: when
 * `measure(text)` exceeds `innerWidth` (the element width less its margins),
 * the text is cut at the last position whose pixels fit in
 * innerWidth − measure(trailer) and the trailer is appended.
 */
export function truncateTextToFit(
  text: string,
  innerWidth: number,
  measure: (s: string) => number,
  trailer = TRUNCATION_TRAILER_TEXT,
): TruncationResult {
  if (!(innerWidth > 0) || measure(text) <= innerWidth) return { text, truncated: false };
  const room = innerWidth - measure(trailer);
  let keep = 0;
  // FindPosFromLineAndPixels: the last glyph whose right edge is inside the room.
  for (let i = 1; i <= text.length; i++) {
    if (measure(text.slice(0, i)) <= room) keep = i; else break;
  }
  return { text: text.slice(0, keep) + trailer, truncated: true };
}

/** Whether a resolved element desc carries the p199 trailer (truncation on) and p208 (the tooltip). */
export function truncationSpec(
  props: ReadonlyMap<number, { valueString?: { stringId: number } | null; valueBool?: boolean }> | undefined,
  resolveString: (id: number) => string | null,
): { trailer: string; tooltip: boolean } | null {
  const p199 = props?.get(TRUNCATION_TRAILER_PROPERTY);
  const stringId = p199?.valueString?.stringId;
  if (!stringId) return null;
  const trailer = resolveString(stringId) ?? TRUNCATION_TRAILER_TEXT;
  const p208 = props?.get(TRUNCATION_TOOLTIP_PROPERTY);
  return { trailer, tooltip: p208?.valueBool === true };
}
