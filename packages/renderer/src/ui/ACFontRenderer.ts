import type { ACFont, FontCharDesc } from '@ac/dat-parser/file-types/ACFont.js';
import { calcJustification } from './UIElementTextLayout.js';

export interface GlyphLayout {
  charDesc: FontCharDesc;
  x: number;  // x position to draw at
  y: number;  // y position to draw at
}

export interface TextLayout {
  glyphs: GlyphLayout[];
  width: number;   // total text width in pixels
  height: number;  // total text height in pixels
}

/**
 * CORE.17.k.b.a — one background-sheet blit of the outline pass: the source
 * rectangle on the font's BACKGROUND surface and where it lands relative to
 * the text origin. `SurfaceWindow::DrawCharacter @ 00442bd0` builds it with
 * `CreateCharRectPair` from the glyph's own rect grown by the font's border
 * pixels on every side (the background sheet holds each glyph's halo at the
 * same offsets, `numHorizontalBorderPixels` / `numVerticalBorderPixels`
 * wider), so the halo draws around the glyph without moving it.
 */
export interface OutlineGlyphRect {
  charDesc: FontCharDesc;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
}

/**
 * The eight neighbour offsets of the fallback outline pass — a font with no
 * background surface draws the glyph itself once per offset in the outline
 * colour (`UIElement_Text::DrawSelf @ 00467aa0`: `for dy in -1..1, dx in
 * -1..1, skipping (0,0)`, mode 0x9000).
 */
export const OUTLINE_NEIGHBOUR_OFFSETS: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
]);

/**
 * The index in `text` where each of `lines` (wrapText's output for `text`)
 * starts. The wrapper consumes exactly one separator between lines — the
 * space it broke at or the hard "\n" — so the lines are walked in order.
 */
export function lineSourceSpans(text: string, lines: ReadonlyArray<string>): number[] {
  const starts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    if (!text.startsWith(line, pos)) {
      const at = text.indexOf(line, pos);
      if (at >= 0) pos = at;
    }
    starts.push(pos);
    pos += line.length;
    if (text[pos] === '\n' || text[pos] === ' ') pos++;
  }
  return starts;
}

/** Pre-tinted glyph sheets kept per renderer (UI text uses a few dozen colours). */
const TINT_CACHE_MAX = 48;

export class ACFontRenderer {
  private font: ACFont;
  private charMap: Map<number, FontCharDesc>;
  private spritesheetCanvas: HTMLCanvasElement | null = null;
  private backgroundCanvas: HTMLCanvasElement | null = null;
  /**
   * PERF.ui-text-canvas-churn — the glyph sheets pre-tinted per colour (an LRU
   * of TINT_CACHE_MAX). Tinted text used to draw its glyphs onto a fresh
   * scratch canvas, fill it 'source-in' and copy it out: one throwaway canvas
   * per label render, about half of all UI canvas churn. A sheet tinted the
   * same way once gives the same pixels, because the tint is a uniform colour
   * over each glyph's own alpha. Overlapping glyphs union their alpha either way.
   */
  private tintedSheets = new Map<string, HTMLCanvasElement>();
  private tintedBackgrounds = new Map<string, HTMLCanvasElement>();

  constructor(font: ACFont) {
    this.font = font;
    // Build lookup map from unicode codepoint to char descriptor
    this.charMap = new Map();
    for (const desc of font.charDescs) {
      this.charMap.set(desc.unicode, desc);
    }
  }

  /** Get the font's spritesheet texture ID */
  get foregroundTextureId(): number { return this.font.foregroundSurfaceDataId; }
  get backgroundTextureId(): number { return this.font.backgroundSurfaceDataId; }
  get lineHeight(): number { return this.font.maxCharHeight; }

  /** Look up a character descriptor */
  getChar(codepoint: number): FontCharDesc | undefined {
    return this.charMap.get(codepoint);
  }

  /**
   * Initialize the spritesheet canvas from RGBA pixel data.
   * Must be called before renderToCanvas() can work.
   */
  initSpritesheet(width: number, height: number, rgbaData: Uint8Array): void {
    this.spritesheetCanvas = document.createElement('canvas');
    this.spritesheetCanvas.width = width;
    this.spritesheetCanvas.height = height;
    const ctx = this.spritesheetCanvas.getContext('2d')!;
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(rgbaData);
    ctx.putImageData(imageData, 0, 0);
    this.tintedSheets.clear();
  }

  /** `sheet` with every texel's colour replaced by `color` and its alpha kept (the old per-label 'source-in' tint), cached. */
  private tinted(cache: Map<string, HTMLCanvasElement>, sheet: HTMLCanvasElement, color: string): HTMLCanvasElement {
    let t = cache.get(color);
    if (t) { cache.delete(color); cache.set(color, t); return t; }   // LRU touch
    t = document.createElement('canvas');
    t.width = sheet.width;
    t.height = sheet.height;
    const ctx = t.getContext('2d')!;
    ctx.drawImage(sheet, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, t.width, t.height);
    cache.set(color, t);
    if (cache.size > TINT_CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return t;
  }

  /** Whether the spritesheet is loaded and rendering is possible. */
  get isReady(): boolean { return this.spritesheetCanvas !== null; }

  /**
   * CORE.17.k.b.a — the font's BACKGROUND surface (`Font::GetSubObjects @
   * 004435e0` loads `m_BackgroundSurfaceDataID` next to the foreground): the
   * same glyph grid with every glyph's soft halo, `numHorizontalBorderPixels`
   * / `numVerticalBorderPixels` wider on each side. It is what the outline
   * pass tints with the outline colour.
   */
  initBackgroundSpritesheet(width: number, height: number, rgbaData: Uint8Array): void {
    this.backgroundCanvas = document.createElement('canvas');
    this.backgroundCanvas.width = width;
    this.backgroundCanvas.height = height;
    const ctx = this.backgroundCanvas.getContext('2d')!;
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(rgbaData);
    ctx.putImageData(imageData, 0, 0);
    this.tintedBackgrounds.clear();
  }

  /** Whether the background (halo) sheet is loaded — the outline pass uses it when it is. */
  get hasBackgroundSpritesheet(): boolean { return this.backgroundCanvas !== null; }

  /**
   * How far the outline pass reaches outside the glyph rectangles: the font's
   * border pixels when it has a background surface (`CreateCharRectPair @
   * 00441480` grows the rects by them), else the 1px neighbour ring.
   */
  get outlinePadding(): { x: number; y: number } {
    if (this.font.backgroundSurfaceDataId) {
      return { x: this.font.numHorizontalBorderPixels, y: this.font.numVerticalBorderPixels };
    }
    return { x: 1, y: 1 };
  }

  /**
   * The background-sheet blits of the outline pass for `text` (pure layout:
   * `layoutText` positions grown by the border pixels on every side).
   */
  outlineGlyphRects(text: string): OutlineGlyphRect[] {
    const { x: bx, y: by } = { x: this.font.numHorizontalBorderPixels, y: this.font.numVerticalBorderPixels };
    return this.layoutText(text).glyphs.map(({ charDesc, x, y }) => ({
      charDesc,
      sx: charDesc.offsetX - bx,
      sy: charDesc.offsetY - by,
      sw: charDesc.width + 2 * bx,
      sh: charDesc.height + 2 * by,
      dx: x - bx,
      dy: y - by,
    }));
  }

  /**
   * CORE.17.k.b.a — `UIElement_Text::DrawSelf @ 00467aa0` pass 0 for an
   * outlined element (bitfield 0x10, property p33): with a background surface,
   * `DrawCharacter(..., mode 0x7000, m_curOutlineColor)` draws each glyph's
   * halo from that sheet tinted with the outline colour; without one, the
   * glyph itself is drawn at the eight ±1px neighbour offsets in the outline
   * colour (mode 0x9000). Pass 1 (the normal glyph draw) follows on top.
   */
  private renderOutlineToCanvas(ctx: CanvasRenderingContext2D, layout: TextLayout, x: number, y: number, outlineColor: string): void {
    if (!this.spritesheetCanvas || layout.glyphs.length === 0) return;
    if (this.backgroundCanvas) {
      const halo = this.tinted(this.tintedBackgrounds, this.backgroundCanvas, outlineColor);
      const bx = this.font.numHorizontalBorderPixels;
      const by = this.font.numVerticalBorderPixels;
      for (const glyph of layout.glyphs) {
        const { charDesc } = glyph;
        // The halo rect starts bx/by left/above the glyph.
        ctx.drawImage(
          halo,
          charDesc.offsetX - bx, charDesc.offsetY - by,
          charDesc.width + 2 * bx, charDesc.height + 2 * by,
          x + glyph.x - bx, y + glyph.y - by,
          charDesc.width + 2 * bx, charDesc.height + 2 * by,
        );
      }
    } else {
      const sheet = this.tinted(this.tintedSheets, this.spritesheetCanvas, outlineColor);
      for (const [ox, oy] of OUTLINE_NEIGHBOUR_OFFSETS) {
        for (const glyph of layout.glyphs) {
          const { charDesc } = glyph;
          ctx.drawImage(
            sheet,
            charDesc.offsetX, charDesc.offsetY,
            charDesc.width, charDesc.height,
            x + glyph.x + ox, y + glyph.y + oy,
            charDesc.width, charDesc.height,
          );
        }
      }
    }
  }

  /**
   * Render text onto a canvas context at the given position.
   * The spritesheet must be initialized first via initSpritesheet().
   * @param color Optional tint color (CSS color string). If provided,
   *   draws glyphs then applies color via globalCompositeOperation.
   * @param outlineColor CORE.17.k.b.a — when given, the outline pass (p33 /
   *   p34) is drawn first, reaching `outlinePadding` outside the glyphs.
   */
  renderToCanvas(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color?: string,
    outlineColor?: string,
  ): TextLayout {
    const layout = this.layoutText(text);
    if (!this.spritesheetCanvas || layout.glyphs.length === 0) return layout;

    if (outlineColor) this.renderOutlineToCanvas(ctx, layout, x, y, outlineColor);

    // A tinted run draws from the colour's pre-tinted sheet; an untinted one from the sheet itself.
    const sheet = color ? this.tinted(this.tintedSheets, this.spritesheetCanvas, color) : this.spritesheetCanvas;
    for (const glyph of layout.glyphs) {
      const { charDesc } = glyph;
      ctx.drawImage(
        sheet,
        charDesc.offsetX, charDesc.offsetY,
        charDesc.width, charDesc.height,
        x + glyph.x, y + glyph.y,
        charDesc.width, charDesc.height,
      );
    }

    return layout;
  }

  /**
   * Render text to a standalone canvas element (for embedding in DOM).
   * Returns the canvas element. With `outlineColor` the canvas is grown by
   * `outlinePadding` on every side and the text drawn at that inset, so the
   * caller keeps the glyphs where they were by pulling the canvas back with
   * negative margins (`GameUI.renderACText`).
   */
  renderTextToCanvas(text: string, color?: string, scale = 1, outlineColor?: string): HTMLCanvasElement {
    const layout = this.layoutText(text);
    const pad = outlineColor ? this.outlinePadding : { x: 0, y: 0 };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil((layout.width + 2 * pad.x) * scale));
    canvas.height = Math.max(1, Math.ceil((layout.height + 2 * pad.y) * scale));
    const ctx = canvas.getContext('2d')!;

    if (scale !== 1) {
      ctx.scale(scale, scale);
    }

    if (this.spritesheetCanvas && layout.glyphs.length > 0) {
      this.renderToCanvas(ctx, text, pad.x, pad.y, color, outlineColor);
    }

    return canvas;
  }

  /**
   * Compute layout positions for a string of text.
   * Returns glyph positions and total dimensions.
   */
  layoutText(text: string): TextLayout {
    const glyphs: GlyphLayout[] = [];
    let cursorX = 0;
    let maxHeight = 0;

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const desc = this.charMap.get(code);
      if (!desc) continue;

      cursorX += desc.horizontalOffsetBefore;

      glyphs.push({
        charDesc: desc,
        x: cursorX,
        y: desc.verticalOffsetBefore,
      });

      cursorX += desc.width + desc.horizontalOffsetAfter;
      const charBottom = desc.verticalOffsetBefore + desc.height;
      if (charBottom > maxHeight) maxHeight = charBottom;
    }

    // VISUAL.examine-misc-list-row-sliver — the line is maxCharHeight tall
    // whatever its ink: Glyph::SetFont @ 004749a0 gives every glyph m_height
    // = Font::maxCharHeight, and UIElement_Text::DrawSelf @ 00467aa0 hands
    // max(maxCharHeight, text height) to CalcJustification @ 00467260. An
    // ink-tall canvas centred "Endurance" 2 px below "Strength" in a 20 px row.
    return {
      glyphs,
      width: cursorX,
      height: Math.max(maxHeight, this.font.maxCharHeight),
    };
  }

  /**
   * Measure the width of a text string without computing full layout.
   */
  measureText(text: string): number {
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      const desc = this.charMap.get(text.charCodeAt(i));
      if (!desc) continue;
      width += desc.horizontalOffsetBefore + desc.width + desc.horizontalOffsetAfter;
    }
    return width;
  }

  /**
   * Render text to a data URL (for use in <img> tags or CSS backgrounds).
   * Returns a data:image/png URL string.
   */
  renderTextToDataURL(text: string, color?: string, scale = 1): string {
    const canvas = this.renderTextToCanvas(text, color, scale);
    return canvas.toDataURL('image/png');
  }

  /**
   * Render word-wrapped text to a canvas element.
   * Breaks text at word boundaries to fit within maxWidth pixels.
   */
  /**
   * CORE.17.k.b.b.a.d — GlyphList::Recalculate's answer for a wrapped run: the
   * widest line's ink width and the lines' total height at `maxWidth`
   * (UIElement_Text::InqSizewMargins sizes a tooltip to THIS, not to the
   * wrap width — renderWrappedTextToCanvas pads its canvas out to maxWidth).
   */
  measureWrappedText(text: string, maxWidth: number): { width: number; height: number; lines: number } {
    const lineHeight = this.lineHeight;
    const lines = this.wrapText(text, maxWidth);
    let width = 0;
    for (const line of lines) width = Math.max(width, this.layoutText(line).width);
    return { width: Math.ceil(width), height: lines.length * lineHeight, lines: lines.length };
  }

  /**
   * `hJustify` — CORE.17.k.b.b.c.c.a: the element's p20, applied per line as
   * UIElement_Text::DrawSelf does (each line's x is CalcJustification of its
   * width against the box: 1 centred, 3 far edge, else the near edge — the
   * house-page rows 0x21000025:0x100001e7 centre every wrapped line).
   */
  renderWrappedTextToCanvas(text: string, maxWidth: number, color?: string, scale = 1, outlineColor?: string, hJustify: number = 2): HTMLCanvasElement {
    return this.renderWrappedRunsToCanvas([{ text, color }], maxWidth, scale, outlineColor, hJustify);
  }

  /**
   * VISUAL.chargen-heritage-lore-spacing — renderWrappedTextToCanvas for ONE
   * text built from several coloured runs, the way UIElement_Text::
   * SetStringInfoWithFont + AppendStringInfoWithFont build one: the runs are
   * concatenated and laid out as a single glyph list (so a run's own "\n"
   * ends its line and the next run starts on the following one — no blank
   * line between separately-laid-out blocks), and each glyph keeps its run's
   * colour.
   */
  renderWrappedRunsToCanvas(runs: ReadonlyArray<{ text: string; color?: string }>, maxWidth: number, scale = 1, outlineColor?: string, hJustify: number = 2): HTMLCanvasElement {
    const text = runs.map(r => r.text).join('');
    // CORE.17.s.a — the row pitch is the font's maxCharHeight and nothing
    // more: Glyph::SetFont @ 004749a0 gives every glyph m_height =
    // Font::maxCharHeight, GlyphList::Recalculate @ 00473800 closes each
    // line with m_nLineHeight = its tallest glyph, and UIElement_Text::
    // DrawSelf @ 00467aa0 advances y by that line height (no leading — the
    // former "+2px line spacing" made 16px chat rows 18px, 4 rows in the
    // 73px log where retail fits 4 full + a clipped fifth).
    const lineHeight = this.lineHeight;
    const effectiveMax = maxWidth / scale;
    const lines = this.wrapText(text, effectiveMax);
    const pad = outlineColor ? this.outlinePadding : { x: 0, y: 0 };

    // Calculate total dimensions using layoutText for accuracy
    const totalHeight = lines.length * lineHeight;
    let totalWidth = 0;
    const lineWidths: number[] = [];
    for (const line of lines) {
      const layout = this.layoutText(line);
      lineWidths.push(layout.width);
      if (layout.width > totalWidth) totalWidth = layout.width;
    }
    const avail = Math.max(totalWidth, effectiveMax);

    // Use maxWidth as minimum canvas width to prevent clipping
    const canvasWidth = Math.max(1, Math.ceil((Math.max(totalWidth, effectiveMax) + 2 * pad.x) * scale));

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = Math.max(1, Math.ceil((totalHeight + 2 * pad.y) * scale));
    const ctx = canvas.getContext('2d')!;

    if (scale !== 1) {
      ctx.scale(scale, scale);
    }

    if (this.spritesheetCanvas) {
      const spans = lineSourceSpans(text, lines);
      // Run boundaries in the concatenated text: runs[k] covers [ends[k-1], ends[k]).
      const ends: number[] = [];
      let acc = 0;
      for (const r of runs) { acc += r.text.length; ends.push(acc); }
      let y = pad.y;
      lines.forEach((line, i) => {
        const x0 = pad.x + calcJustification(Math.floor(lineWidths[i]), avail, avail, hJustify);
        const start = spans[i];
        let k = 0;
        let off = 0;
        while (off < line.length) {
          while (k < ends.length - 1 && start + off >= ends[k]) k++;
          const segEnd = Math.min(line.length, ends[k] - start);
          const seg = line.slice(off, segEnd > off ? segEnd : line.length);
          this.renderToCanvas(ctx, seg, x0 + this.measureText(line.slice(0, off)), y, runs[k].color, outlineColor);
          off += seg.length;
        }
        y += lineHeight;
      });
    }

    return canvas;
  }

  /**
   * Break text into lines that fit within maxWidth pixels.
   *
   * FAITHFUL.513 — Hard "\n" line breaks are honored. Pre-fix wrapText
   *  split only on " ", so embedded "\n" stayed inside a word; the
   *  newline glyph (0x0A) has no entry in the AC bitmap font, so
   *  measureText silently skipped it and layoutText collapsed every
   *  paragraph onto one row. Callers that use renderWrappedTextToCanvas
   *  with multi-paragraph content (e.g. spell descriptions with
   *  multi-line `desc` strings) saw their paragraph breaks erased.
   *
   *  Fix: pre-split on "\n" and run the word-wrap pass on each
   *  paragraph independently. Consecutive "\n\n" produces an empty
   *  line in the output so vertical paragraph spacing is preserved.
   */
  private wrapText(text: string, maxWidth: number): string[] {
    const lines: string[] = [];
    const paragraphs = text.split('\n');

    for (let p = 0; p < paragraphs.length; p++) {
      const paragraph = paragraphs[p];
      // Empty paragraphs (from "\n\n") preserve a blank line of vertical space.
      if (paragraph === '') {
        lines.push('');
        continue;
      }
      const words = paragraph.split(' ');
      let currentLine = '';
      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        // CORE.17.s.a — leading spaces are glyphs too: GlyphList::Recalculate
        // @ 00473800 lays every whitespace glyph out at its width (only a
        // line's TRAILING whitespace is left out of m_nLineWidth), so ACE's
        // "  powered by ACEmulator" keeps its two-space indent in the Wine
        // frame. Joining on `currentLine ?` dropped them (an empty first
        // word left currentLine empty).
        const testLine = i === 0 ? word : currentLine + ' ' + word;
        const testWidth = this.measureText(testLine);
        if (testWidth > maxWidth && currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [''];
  }

  /** Get the number of characters in this font */
  get characterCount(): number { return this.charMap.size; }
}
