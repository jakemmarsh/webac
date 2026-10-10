/**
 * CORE.17.h.g.d — the retail UIElement_Text line layout, as the decompiled
 * EoL client (reference/client-eol, build ac1_sep13) lays a text element out
 * inside its rectangle. Pure: takes a glyph-advance measurer and the font's
 * maxCharHeight, returns line strings with their box-relative positions.
 *
 * Ground truth (decomp acclient-decompiled.c + acclient.exe disassembly):
 *
 * - UIElement_Text::UIElement_Text @ 00468570 starts m_bitField at 0x300 —
 *   bit 2 (ONE-LINE) is CLEAR by default; only property 0x20 (p32) via
 *   OnSetAttribute @ 0046a640 → SetOneLine @ 00468170 sets it. A text cell
 *   whose DAT desc carries no p32 is a wrapping, multi-line element.
 * - RecalculateGlyphList @ 00468420 hands GlyphList::Recalculate @ 00473800
 *   the wrap width (x1 − x0 + 1) − margL − margR (= the cell width less the
 *   p35/p37 insets) and the one-line flag. Recalculate walks the glyphs:
 *   LinebreakUtils::CanBreakLineAt marks each word start as a candidate, a
 *   line closes when its width — trailing whitespace excluded — exceeds the
 *   wrap width, at the last candidate; a lone word wider than the width
 *   breaks at the character where it overflows. Every glyph's m_height is
 *   its Font's maxCharHeight (Glyph::SetFont @ 004749a0), so a line is
 *   maxCharHeight tall and a glyph's advance is
 *   Font::GetCharWidthA @ 004433f0 = before + width + after.
 * - The wrapped block is the element's SCROLLABLE AREA: RecalculateGlyphList
 *   → UIElement_Scrollable::ResizeScrollableArea @ 00474730 writes the
 *   widest line + margins to +0x600 and the summed line heights + margins
 *   to +0x604 (the element rectangle itself does not grow — only p41
 *   FitToText / SetFitToText @ 00468540 resizes it).
 * - CalcJustification @ 00467260 (disassembly 004672ba..0046733f):
 *   avail = max(boxExtent, scrollableExtent) − margFar − margNear;
 *   justification 1 (center) → (avail >> 1) − (textSize >> 1);
 *   3 or 5 (far edge) → avail − textSize; anything else → 0;
 *   result + margNear. Because avail is clamped to the CONTENT extent, a
 *   block taller (or a line wider) than the box justifies at offset 0 —
 *   it is never shifted negative to center or end-align an overflow.
 * - DrawSelf @ 00467aa0 locks a SurfaceWindow on the clip box UIRegion::
 *   DrawHere @ 0069fa30 hands it (the element's own rectangle ∩ the parent
 *   clips), so SurfaceWindow::DrawCharacter @ 00442bd0 (CreateCharRectPair
 *   against the window extent) clips every glyph to the element rectangle.
 *   Line 0 sits at CalcJustification(max(maxCharHeight, scrollable height),
 *   vertical) and each further line at + its line height; each line's x is
 *   CalcJustification(lineWidth, horizontal).
 *
 * So a right-justified, vertically centred 130x14 label (options list
 * template label 0x1000038e: p20 = 3, p21 = 1, font 0x40000002, no p32)
 * whose text is wider than 130 wraps to two 14px lines, the two-line block
 * justifies at y = 0 (avail = max(14, 28) = 28 → 14 − 14), line 0 ends
 * flush at x = 130 and line 1 lies at y = 14, entirely outside the 14px
 * window — retail shows the first line alone, right-aligned like every
 * other label, and drops the rest.
 */

/**
 * The text styles of the options list templates, resolved from their base
 * descs (resolveElementTree over 0x2100002b): p26[0] is the Font DID,
 * p27[0] the ARGB colour. The header 0x10000216 → 0x2100003f:0x1000038c
 * draws the UI font 0x40000000 in 0xffffef00; the row labels 0x1000021b /
 * 0x10000223 → 0x1000038e, the checkbox label 0x10000219 →
 * 0x21000044:0x1000032b and the menu value plate 0x10000355 → 0x1000038d
 * draw the smaller 0x40000002 (maxCharHeight 14) in 0xffffffff; the slider
 * captions 0x1000021e / 0x1000021f → 0x1000038f draw the caption font
 * 0x40000025 (maxCharHeight 11) in 0xffe5e5e5 — options-config.jpg's
 * "Soft"/"Hard" are visibly smaller than the labels above them. None of
 * them carries p32 (one-line), so every cell wraps per layoutTextCell.
 */
export const OPTIONS_TEXT_STYLES = {
  header: { font: 0x40000000, colorArgb: 0xffffef00 },
  label: { font: 0x40000002, colorArgb: 0xffffffff },
  caption: { font: 0x40000025, colorArgb: 0xffe5e5e5 },
} as const;

export type OptionsTextStyle = (typeof OPTIONS_TEXT_STYLES)[keyof typeof OPTIONS_TEXT_STYLES];

/** Glyph-advance measurer: the summed Font::GetCharWidthA over a string. */
export type TextMeasurer = (text: string) => number;

/** UIElement_Text p20 / p21 values: 1 = center, 2 = near edge, 3 = far edge. */
export type TextJustification = 1 | 2 | 3;

export interface TextCellSpec {
  /** Element rectangle extent (x1 − x0 + 1 / y1 − y0 + 1). */
  width: number;
  height: number;
  /** Property 0x14 (p20) / 0x15 (p21). */
  hJustify: TextJustification;
  vJustify: TextJustification;
  /** Property 0x20 (p32) — absent on the DAT desc = false. */
  oneLine?: boolean;
  /** p35 (left) / p37 (top) insets and their far-side counterparts. */
  marginLeft?: number;
  marginRight?: number;
  marginTop?: number;
  marginBottom?: number;
  /** Font::maxCharHeight — every glyph's m_height. */
  lineHeight: number;
}

export interface TextCellLine {
  text: string;
  /** Box-relative origin of the line's first glyph. */
  x: number;
  y: number;
  width: number;
  /** Whether any of the line's [y, y + lineHeight) rows lie inside the box. */
  visible: boolean;
}

export interface TextCellLayout {
  lines: TextCellLine[];
  /** UIElement_Scrollable +0x600 / +0x604 after RecalculateGlyphList. */
  scrollableWidth: number;
  scrollableHeight: number;
  /** The wrap width handed to GlyphList::Recalculate. */
  wrapWidth: number;
}

/**
 * GlyphList::Recalculate @ 00473800 — break a string into lines no wider
 * than `wrapWidth` (trailing whitespace excluded from a line's width), at
 * word starts when possible and inside a word only when the word alone
 * overflows. `oneLine` (m_bOneLine) suppresses every break.
 */
export function wrapGlyphLines(text: string, wrapWidth: number, measure: TextMeasurer, oneLine = false): string[] {
  if (oneLine) return [text];
  const lines: string[] = [];
  // Hard newlines (Glyph::IsNewLine) always close a line.
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ').filter((w) => w.length > 0);
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (measure(candidate) <= wrapWidth) {
        current = candidate;
        continue;
      }
      if (current) {
        lines.push(current);
        current = '';
      }
      // The word alone: fits on its own line, or breaks per character where
      // its accumulated width first exceeds the wrap width.
      let run = '';
      for (const ch of word) {
        const next = run + ch;
        if (run && measure(next) > wrapWidth) {
          lines.push(run);
          run = ch;
        } else {
          run = next;
        }
      }
      current = run;
    }
    lines.push(current);
  }
  return lines;
}

/**
 * UIElement_Text::CalcJustification @ 00467260 for one axis — the offset of
 * a `textSize` run inside a box of `boxExtent` whose scrollable content is
 * `scrollableExtent` wide/tall, including the near margin.
 */
export function calcJustification(
  textSize: number, boxExtent: number, scrollableExtent: number,
  justify: number, marginNear = 0, marginFar = 0,
): number {
  const avail = Math.max(boxExtent, scrollableExtent) - marginFar - marginNear;
  let offset = 0;
  if (justify === 1) offset = (avail >> 1) - (textSize >> 1);
  else if (justify === 3 || justify === 5) offset = avail - textSize;
  return marginNear + offset;
}

/** Lay `text` out in a UIElement_Text cell (RecalculateGlyphList + DrawSelf). */
export function layoutTextCell(text: string, spec: TextCellSpec, measure: TextMeasurer): TextCellLayout {
  const mL = spec.marginLeft ?? 0;
  const mR = spec.marginRight ?? 0;
  const mT = spec.marginTop ?? 0;
  const mB = spec.marginBottom ?? 0;
  const lh = spec.lineHeight;
  const wrapWidth = spec.width - mL - mR;
  const texts = wrapGlyphLines(text, wrapWidth, measure, spec.oneLine ?? false);
  const widths = texts.map((t) => measure(t));
  const scrollableWidth = Math.max(0, ...widths) + mL + mR;
  const scrollableHeight = texts.length * lh + mT + mB;
  // DrawSelf: the block's vertical size is max(maxCharHeight, +0x604).
  const blockHeight = Math.max(lh, scrollableHeight);
  let y = calcJustification(blockHeight, spec.height, scrollableHeight, spec.vJustify, mT, mB);
  const lines: TextCellLine[] = texts.map((t, i) => {
    const x = calcJustification(widths[i], spec.width, scrollableWidth, spec.hJustify, mL, mR);
    const line = { text: t, x, y, width: widths[i], visible: y < spec.height && y + lh > 0 };
    y += lh;
    return line;
  });
  return { lines, scrollableWidth, scrollableHeight, wrapWidth };
}
