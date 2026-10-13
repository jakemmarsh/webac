/**
 * Text as Virindi Views (VVS) draws it: Times New Roman.
 *
 * VVS draws its windows' text with a Windows font (its theme's
 * DefaultTextFontFace, which UtilityBelt reads for its map labels), not with
 * the game's DAT fonts. Matched against the virindi.net wiki's VTank
 * screenshots (docs/automation-vtank-window.md "Text"): labels, buttons and
 * text boxes are Times New Roman at 11 px, the tab labels a size smaller (the
 * tab row and "Force" match Windows' 1-bit rendering pixel for pixel). Every
 * DAT font scored worse (best 0x4000002a, 0.54–0.67 of the ink shared).
 *
 * Layout is Windows': each letter at a whole pixel, its advance rounded up,
 * no kerning, and a space half the font's size (the screenshots' word gaps,
 * "Monster  Range:", are about twice Times New Roman's own). With that the
 * labels' widths come out within a pixel or two ("Monster Range:" 77, "Summon
 * Pets" 64 vs 67), where the browser's own layout ran 10% narrow and tight.
 *
 * Windows drew these unsmoothed and hinted. A browser draws unhinted outlines,
 * and thresholding them gave strokes either doubled or broken; the smoothed
 * text is the closest match at a glance, so it stays smoothed.
 *
 * The colours are the screenshots' own: white text, the open tab goldenrod
 * (218, 165, 32), the others grey (128, 128, 128), lines tan (143, 120, 84).
 * Tinos and Liberation Serif stand in, metric for metric, where Times New
 * Roman isn't installed.
 */

export const VVS_FONT_FACE = '"Times New Roman", Tinos, "Liberation Serif", serif';
/** Labels, buttons, text boxes, list rows, titles. */
export const VVS_TEXT_PX = 11;
/** The notebook's tab labels (the screenshots' 7 px capitals). */
export const VVS_TAB_PX = 9;

export const VVS_COLORS = {
  text: 'rgb(255, 255, 255)',
  tabOn: 'rgb(218, 165, 32)',
  tabOff: 'rgb(128, 128, 128)',
  line: 'rgb(143, 120, 84)',
} as const;

/** The CSS font for `px`; bold and italic as a Decal view's `fontstyle` asks (GoArrow's headings). */
export function vvsFont(px: number = VVS_TEXT_PX, style: { bold?: boolean; italic?: boolean } = {}): string {
  return `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${px}px ${VVS_FONT_FACE}`;
}

/** Each letter's x in a line, Windows-style (see above). The last entry is the line's width. */
export function vvsGlyphXs(text: string, advance: (ch: string) => number, px: number = VVS_TEXT_PX): number[] {
  const xs = [0];
  for (const ch of text) xs.push(xs[xs.length - 1]! + (ch === ' ' ? Math.ceil(px / 2) : Math.ceil(advance(ch) - 1e-6)));
  return xs;
}

/** Word-wrap `text` to `maxWidth` with `measure` (a word wider than the line stays whole on its own line). */
export function vvsWrap(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > maxWidth) { out.push(line); line = word; } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** A line's height for `px`: Times New Roman's ascent + descent (0.891 + 0.216 em), rounded up. */
export function vvsLineHeight(px: number): number {
  return Math.ceil(px * 1.107);
}

/**
 * `text` drawn as VVS draws it, on a canvas sized to the text (wrapped to
 * `maxWidth` when given; with `shadow`, a 1 px drop shadow in that colour, as
 * DxTexture.BeginText's shadowSize 1 for UB's map labels). The canvas carries
 * the run in data-ac-run-text, as the DAT-font runs do, for tests and the
 * capture tools.
 */
export function renderVvsText(text: string, color: string = VVS_COLORS.text, opts: { px?: number; maxWidth?: number; shadow?: string; bold?: boolean; italic?: boolean } = {}): HTMLCanvasElement {
  const px = opts.px ?? VVS_TEXT_PX;
  const font = vvsFont(px, opts);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const lineH = vvsLineHeight(px);
  const ascent = Math.round(px * 0.891);
  if (ctx) ctx.font = font;
  const adv = new Map<string, number>();
  const advance = (ch: string) => { let a = adv.get(ch); if (a === undefined) { a = ctx ? ctx.measureText(ch).width : px / 2; adv.set(ch, a); } return a; };
  const measure = (s: string) => vvsGlyphXs(s, advance, px).at(-1)!;
  const lines = opts.maxWidth ? vvsWrap(text, opts.maxWidth, measure) : [text];
  const pad = opts.shadow ? 1 : 0;
  canvas.width = Math.max(1, ...lines.map((l) => measure(l) + 1)) + pad;
  canvas.height = Math.max(1, lineH * lines.length) + pad;
  if (ctx) {
    // Resizing the canvas reset its state.
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    const draw = (fill: string, d: number) => {
      ctx.fillStyle = fill;
      lines.forEach((l, i) => {
        const xs = vvsGlyphXs(l, advance, px);
        [...l].forEach((ch, k) => { if (ch !== ' ') ctx.fillText(ch, xs[k]! + d, ascent + i * lineH + d); });
      });
    };
    if (opts.shadow) draw(opts.shadow, 1);
    draw(color, 0);
  }
  Object.assign(canvas.style, { display: 'block', width: `${canvas.width}px`, height: `${canvas.height}px` });
  canvas.dataset.acRunText = text;
  canvas.dataset.vvsText = String(px);
  if (opts.bold) canvas.dataset.vvsBold = '1';
  if (opts.italic) canvas.dataset.vvsItalic = '1';
  return canvas;
}

/** A native text box styled as VVS's: the same font and colour. */
export function vvsFieldStyle(px: number = VVS_TEXT_PX): Record<string, string> {
  return { font: vvsFont(px), color: VVS_COLORS.text };
}
