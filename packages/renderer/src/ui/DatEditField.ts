/**
 * RECON.dom-chrome-sweep — an editable UIElement_Text drawn the way retail
 * draws it: the field's DAT font, a 1-px caret in the font colour, the
 * selection as inverted glyph boxes. A browser <input> / <textarea> still
 * owns the keys, IME, clipboard and undo, but its own glyphs and caret are
 * transparent; this layer paints what shows.
 *
 * Retail (decomp, acclient-decompiled.annotated.c):
 *   - UIElement_Text::DrawSelf @ 00467aa0 — glyphs at their font advances;
 *     the cursor is `SurfaceWindow::FillArea(m_curFontColor, x, y, x,
 *     y + lineHeight - 1)` (one pixel wide, the line's height, the font
 *     colour) while the element has focus, is editable (m_bitField & 1)
 *     and the blink bit 0x200 is set; each selected glyph's box is
 *     `NotColorBits` (pixels inverted, no selection colour) whenever
 *     GetSelection @ 00466f20 holds (the selecting bit 0x80) — with no
 *     focus test, so a selection set on an unfocused field shows.
 *   - UIElement_Text::ListenToElementMessage @ 004687c0 — focus loss
 *     (message 0x2f, dwParam1 0) on an editable / selectable field runs
 *     Deselect @ 00467930: the selection goes (the cursor stays).
 *   - UIElement_Text::Global_Loop @ 00469fc0 — the blink: the bit flips
 *     every `GetCaretBlinkTime() * 0.001` s (___real_3a83126f = 0.001;
 *     Windows' default caret blink time is 530 ms), and a cursor move
 *     since the last flip (m_lastCursorMoveTime > m_lastFlashFlipTime)
 *     forces it back on.
 *   - SetCursorPositionFromXY @ 00468cd0 — a click places the cursor by the
 *     DAT glyph advances, so hit-testing here uses the same widths (the
 *     browser's own font would land the caret on the wrong character).
 */

import { calcJustification } from './UIElementTextLayout.js';
import { wheelScrollPixels } from './wheelScroll.js';

/** The font metrics + rasteriser the field needs (ACFontRenderer satisfies it). */
export interface DatEditFont {
  readonly lineHeight: number;
  measureText(text: string): number;
  renderTextToCanvas(text: string, color?: string, scale?: number, outlineColor?: string): HTMLCanvasElement;
  readonly outlinePadding: { x: number; y: number };
  /** The glyph for a code point, if the font has one (ACFontRenderer.getChar). */
  getChar?(codepoint: number): unknown;
}

/**
 * RECON.dom-chrome-sweep.d.a — the mask a masked field draws, one per
 * character: the dot (Jake, 2026-10-10), else the first the font carries.
 * Retail had no in-client password field (the Turbine launcher took it), so
 * no DAT or decomp names one; every end-of-retail edit font has U+25CF, some
 * large fonts and older eras' fonts may not.
 */
export const MASK_GLYPHS = ['\u25CF', '\u2022', '*'] as const;

export function pickMaskGlyph(font: Pick<DatEditFont, 'getChar'>): string {
  for (const g of MASK_GLYPHS) if (!font.getChar || font.getChar(g.charCodeAt(0))) return g;
  return '*';
}

/** Per-field class suffix for the ::selection rule. */
let editFieldSerial = 0;

/** Windows' default GetCaretBlinkTime() (ms), which Global_Loop reads. */
export const CARET_BLINK_MS = 530;

/**
 * Capture determinism (screen-regression, side-by-sides): hold every
 * field's caret lit instead of blinking, so two runs of the same code
 * shoot the same frame. Never set in play.
 */
let caretBlinkPinned = false;
export function pinCaretBlink(pinned: boolean): void { caretBlinkPinned = pinned; }

/** The caret's x within the text: the advance of the glyphs before `pos`. */
export function caretOffset(font: Pick<DatEditFont, 'measureText'>, text: string, pos: number): number {
  return font.measureText(text.slice(0, Math.max(0, Math.min(pos, text.length))));
}

/**
 * The character index a click at `x` (text space) lands on —
 * GlyphList::FindPosFromLineAndPixels @ 004732d0 with its round flag set
 * (DeterminePositionFromXY @ 004688f0): past the line's width is the end
 * (the compare is unsigned, so a press left of the text's origin lands
 * there too); otherwise walk the glyphs, stopping before the first one
 * whose half-width (integer division) the remaining pixels do not pass.
 */
export function indexAtX(font: Pick<DatEditFont, 'measureText'>, text: string, x: number): number {
  let rem = Math.floor(x);
  if (rem < 0 || rem > font.measureText(text)) return text.length;
  for (let i = 0; i < text.length; i++) {
    const w = font.measureText(text[i]);
    if (rem <= Math.trunc(w / 2)) return i;
    rem -= w;
  }
  return text.length;
}

/**
 * The horizontal scroll of a single-line field after the cursor moves —
 * SetCursorPosition @ 00468b90 → IsPositionInView @ 00468aa0 /
 * ScrollToPosition @ 004691b0 (the m_bitField & 2 branch): the cursor is
 * in view while `scroll <= x && x + 2 <= scroll + width` (width = the
 * element less its p35 / p36 margins) and the scroll stays put; otherwise
 * it becomes `x + 2 - width` when the cursor ran off the right, else `x`.
 * Nothing pulls the scroll back when text is deleted.
 */
export function scrollForCaret(scroll: number, caretX: number, viewWidth: number): number {
  if (scroll <= caretX && caretX + 2 <= scroll + viewWidth) return scroll;
  return scroll + viewWidth < caretX + 2 ? caretX + 2 - viewWidth : caretX;
}

/** The selected run's box in text space, or null when nothing is selected. */
export function selectionSpan(
  font: Pick<DatEditFont, 'measureText'>, text: string, start: number, end: number,
): { x: number; width: number } | null {
  const a = Math.max(0, Math.min(start, end, text.length));
  const b = Math.min(text.length, Math.max(start, end));
  if (b <= a) return null;
  const x = caretOffset(font, text, a);
  return { x, width: caretOffset(font, text, b) - x };
}

/**
 * The blink state of Global_Loop: on at focus, flipped every
 * CARET_BLINK_MS, and forced back on by a cursor move.
 */
export class CaretBlink {
  private on = true;
  private lastFlip = 0;
  constructor(private readonly periodMs = CARET_BLINK_MS) {}
  /** A cursor move (or focus): the caret shows from `now`. */
  reset(now: number): void { this.on = true; this.lastFlip = now; }
  /** Advance to `now`; returns whether the caret is lit. */
  tick(now: number): boolean {
    if (caretBlinkPinned) return true;
    if (now - this.lastFlip >= this.periodMs) {
      const flips = Math.floor((now - this.lastFlip) / this.periodMs);
      if (flips % 2 === 1) this.on = !this.on;
      this.lastFlip += flips * this.periodMs;
    }
    return this.on;
  }
}

export interface DatEditFieldOptions {
  /** The field's DAT font; null keeps the browser's own glyphs (no DAT loaded). */
  font: DatEditFont | null;
  /** p27 entry 0 as CSS. */
  color: string;
  /** p33/p34 outline as CSS, when the desc outlines its text. */
  outlineColor?: string;
  /** p35 / p36 — the text's left / right margins inside the field. */
  marginLeft?: number;
  marginRight?: number;
  /**
   * p20 horizontal justification (CalcJustification: 1 centre, 3 / 5 the
   * far edge, else the near edge). The cursor scroll stays in glyph space
   * (IsPositionInView reads FindXYFromPosition, which knows no
   * justification); DrawSelf adds the offset, which is 0 once the text
   * outgrows the field (the scrollable width is then the text's).
   */
  hJustify?: number;
  /** p21 vertical justification + p37 / p38 margins (CalcJustification). */
  vJustify?: number;
  marginTop?: number;
  marginBottom?: number;
  /** The clock (tests). */
  now?: () => number;
  /**
   * Draw one mask glyph (pickMaskGlyph) per character instead of the text —
   * the launcher password. The caret, selection and clicks use the mask's
   * advances; the real value never reaches the canvas.
   */
  masked?: boolean;
}

export interface DatEditFieldHandle {
  /** Repaint from the input's value / selection (call after a programmatic value change). */
  refresh(): void;
  /** The painted layer (tests, probes). */
  readonly layer: HTMLElement;
  destroy(): void;
}

/**
 * Paint `input` (a single-line <input> already placed over its DAT field
 * `host`) in the DAT font. Without a font it leaves the input as it is.
 */
export function attachDatEditField(
  input: HTMLInputElement, host: HTMLElement, opts: DatEditFieldOptions,
): DatEditFieldHandle | null {
  const font = opts.font;
  if (!font) return null;
  const now = opts.now ?? (() => performance.now());
  const marginLeft = opts.marginLeft ?? 0;
  const marginRight = opts.marginRight ?? 0;
  const mask = opts.masked ? pickMaskGlyph(font) : null;
  /** What the field draws: the value, or one mask glyph per UTF-16 unit (so indices line up). */
  const shown = (): string => (mask ? mask.repeat(input.value.length) : input.value);

  input.style.color = 'transparent';
  input.style.caretColor = 'transparent';
  input.dataset.acDatEdit = '1';
  // The native selection highlight would show through the transparent glyphs.
  const ownStyle = input.ownerDocument.createElement('style');
  const cls = `ac-dat-edit-${++editFieldSerial}`;
  input.classList.add(cls);
  ownStyle.textContent = `.${cls}::selection{background:transparent;color:transparent;}`;
  host.appendChild(ownStyle);

  // No z-index: a stacking context would isolate the selection's
  // difference blend from the field's backdrop, inverting the glyphs over
  // transparency (a white box) instead of NotColorBits over the box art.
  // The <input> (z-index 5) still lies over it for the mouse.
  const layer = input.ownerDocument.createElement('div');
  layer.className = 'ac-dat-edit-layer';
  Object.assign(layer.style, {
    position: 'absolute', left: `${marginLeft}px`, top: '0', right: `${marginRight}px`, bottom: '0',
    overflow: 'hidden', pointerEvents: 'none',
  });
  const strip = input.ownerDocument.createElement('div');
  Object.assign(strip.style, { position: 'absolute', left: '0', top: '0', height: `${font.lineHeight}px` });
  const selection = input.ownerDocument.createElement('div');
  selection.className = 'ac-dat-edit-selection';
  Object.assign(selection.style, {
    position: 'absolute', top: '0', height: `${font.lineHeight}px`, display: 'none',
    background: '#fff', mixBlendMode: 'difference',
  });
  const caret = input.ownerDocument.createElement('div');
  caret.className = 'ac-dat-edit-caret';
  Object.assign(caret.style, {
    position: 'absolute', top: '0', width: '1px', height: `${font.lineHeight}px`,
    background: opts.color, display: 'none',
  });
  strip.append(selection, caret);
  layer.appendChild(strip);
  host.appendChild(layer);

  const blink = new CaretBlink();
  let scroll = 0;
  let justX = 0;
  let painted: string | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const focused = (): boolean => input.ownerDocument.activeElement === input;

  const paint = (): void => {
    const text = shown();
    if (text !== painted) {
      painted = text;
      canvas?.remove();
      canvas = text ? font.renderTextToCanvas(text, opts.color, 1, opts.outlineColor) : null;
      if (canvas) {
        const pad = opts.outlineColor ? font.outlinePadding : { x: 0, y: 0 };
        Object.assign(canvas.style, { position: 'absolute', left: `${-pad.x}px`, top: `${-pad.y}px`, display: 'block' });
        strip.insertBefore(canvas, selection);
      }
    }
    const viewWidth = layer.clientWidth || Math.max(0, host.clientWidth - marginLeft - marginRight);
    const top = calcJustification(font.lineHeight, layer.clientHeight || host.clientHeight, 0,
      opts.vJustify ?? 0, opts.marginTop ?? 0, opts.marginBottom ?? 0);
    const start = input.selectionStart ?? text.length;
    const end = input.selectionEnd ?? start;
    const cursor = input.selectionDirection === 'backward' ? start : end;
    const caretX = caretOffset(font, text, cursor);
    if (viewWidth > 0) scroll = Math.max(0, scrollForCaret(scroll, caretX, viewWidth));
    const textWidth = font.measureText(text);
    justX = Math.max(0, calcJustification(textWidth, viewWidth, textWidth, opts.hJustify ?? 0));
    strip.style.left = `${justX - scroll}px`;
    strip.style.top = `${Math.max(0, top)}px`;
    const span = selectionSpan(font, text, start, end);
    selection.style.display = span ? 'block' : 'none';
    if (span) { selection.style.left = `${span.x}px`; selection.style.width = `${span.width}px`; }
    caret.style.left = `${caretX}px`;
    caret.style.display = focused() && blink.tick(now()) ? 'block' : 'none';
    layer.dataset.acCaret = String(cursor);
    layer.dataset.acScroll = String(scroll);
  };

  const moved = (): void => { blink.reset(now()); paint(); };
  const onSelectionChange = (): void => { if (focused()) moved(); };
  // Document listeners live only while they can act — selectionchange
  // while focused, mousemove / mouseup during a press — so a field whose
  // panel was rebuilt holds no document reference: a document listener
  // kept the old <input> and its whole panel reachable (every fellowship /
  // friends / squelch pane render leaked one, PERF soak 2026-10-07).
  const blinkTick = (): void => { if (input.isConnected) paint(); else stopBlink(); };
  const startBlink = (): void => {
    moved();
    if (timer === null) timer = setInterval(blinkTick, Math.max(16, Math.floor(CARET_BLINK_MS / 4)));
    input.ownerDocument.addEventListener('selectionchange', onSelectionChange);
  };
  // Focus loss: Deselect — the selection collapses onto the cursor (the
  // browser would otherwise keep it, and DrawSelf paints any selection).
  function stopBlink(): void {
    if (timer !== null) { clearInterval(timer); timer = null; }
    input.ownerDocument.removeEventListener('selectionchange', onSelectionChange);
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start !== null && end !== null && start !== end) {
      const cursor = input.selectionDirection === 'backward' ? start : end;
      input.setSelectionRange(cursor, cursor);
    }
    paint();
  }

  // SetCursorPositionFromXY: a press places the cursor by DAT advances;
  // a drag extends the selection from there.
  let anchor: number | null = null;
  const indexAt = (clientX: number): number => {
    const rect = layer.getBoundingClientRect();
    const scale = layer.offsetWidth > 0 ? rect.width / layer.offsetWidth : 1;
    return indexAtX(font, shown(), (clientX - rect.left) / (scale || 1) - justX + scroll);
  };
  const onDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    input.focus();
    const i = indexAt(e.clientX);
    anchor = e.shiftKey ? (input.selectionStart ?? i) : i;
    input.setSelectionRange(Math.min(anchor, i), Math.max(anchor, i), i < anchor ? 'backward' : 'forward');
    input.ownerDocument.addEventListener('mousemove', onMove);
    input.ownerDocument.addEventListener('mouseup', onUp);
    moved();
  };
  const onMove = (e: MouseEvent): void => {
    if (anchor === null) return;
    const i = indexAt(e.clientX);
    input.setSelectionRange(Math.min(anchor, i), Math.max(anchor, i), i < anchor ? 'backward' : 'forward');
    moved();
  };
  function onUp(): void {
    anchor = null;
    input.ownerDocument.removeEventListener('mousemove', onMove);
    input.ownerDocument.removeEventListener('mouseup', onUp);
  }

  // Callers clear / recall the text by assigning .value (no input event):
  // repaint on every write.
  let proto: object | null = Object.getPrototypeOf(input);
  let valueDesc: PropertyDescriptor | undefined;
  while (proto && !(valueDesc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
  if (valueDesc?.get && valueDesc.set) {
    const { get, set } = valueDesc;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get(this: HTMLInputElement) { return get.call(this); },
      set(this: HTMLInputElement, v: string) { set.call(this, v); moved(); },
    });
  }

  input.addEventListener('mousedown', onDown);
  input.addEventListener('input', moved);
  input.addEventListener('keydown', moved);
  input.addEventListener('keyup', moved);
  input.addEventListener('select', moved);
  input.addEventListener('focus', startBlink);
  input.addEventListener('blur', stopBlink);
  if (focused()) startBlink(); else paint();

  return {
    layer,
    refresh: moved,
    destroy(): void {
      if (timer !== null) clearInterval(timer);
      input.removeEventListener('mousedown', onDown);
      input.ownerDocument.removeEventListener('mousemove', onMove);
      input.ownerDocument.removeEventListener('mouseup', onUp);
      input.removeEventListener('input', moved);
      input.removeEventListener('keydown', moved);
      input.removeEventListener('keyup', moved);
      input.removeEventListener('select', moved);
      input.ownerDocument.removeEventListener('selectionchange', onSelectionChange);
      input.removeEventListener('focus', startBlink);
      input.removeEventListener('blur', stopBlink);
      delete (input as { value?: string }).value;
      layer.remove();
      ownStyle.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// RECON.dom-chrome-sweep.a — the multi-line edit field (no p32 one-line bit):
// the journal notes, the book page editor, the examine inscription.
// ---------------------------------------------------------------------------

/** One glyph line: text[start, end) (its trailing space / newline included). */
export interface EditLine {
  start: number;
  end: number;
  /** m_nLineWidth — the line's advance less a trailing whitespace / newline glyph. */
  width: number;
}

const isEditWhiteSpace = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\r';

/** A glyph's advance (Font::GetCharWidthA); the newline glyph draws nothing. */
function glyphWidth(font: Pick<DatEditFont, 'measureText'>, ch: string): number {
  return ch === '\n' ? 0 : font.measureText(ch);
}

/**
 * GlyphList::Recalculate @ 00473800 over an edit field's text, keeping each
 * line's character range (the cursor arithmetic needs the indices):
 *   - LinebreakUtils::CanBreakLineAt @ 00472610 makes each glyph after a
 *     whitespace / newline a break candidate, and after a newline the line
 *     closes there unconditionally;
 *   - a non-space glyph that would carry the run since the last candidate
 *     past the wrap width becomes a candidate too (a lone word wider than
 *     the field breaks where it overflows);
 *   - the line closes at the candidate once its width, less the current
 *     glyph when that is whitespace, exceeds the wrap width.
 * Whitespace therefore stays at the end of the line it follows. Text that
 * ends in a newline has an empty last line (where its cursor sits).
 */
export function wrapEditLines(font: Pick<DatEditFont, 'measureText'>, text: string, wrapWidth: number): EditLine[] {
  const lines: EditLine[] = [];
  const close = (start: number, end: number): void => {
    let width = 0;
    for (let i = start; i < end; i++) width += glyphWidth(font, text[i]);
    const last = text[end - 1];
    if (end > start && (last === '\n' || isEditWhiteSpace(last))) width -= glyphWidth(font, last);
    lines.push({ start, end, width });
  };
  let start = 0;
  let lineWidth = 0;
  let candidate = -1;
  let sinceCandidate = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const w = glyphWidth(font, ch);
    if (i > start) {
      const prev = text[i - 1];
      if (prev === '\n') {
        close(start, i);
        start = i; lineWidth = 0; candidate = -1; sinceCandidate = 0;
      } else if (isEditWhiteSpace(prev) && !isEditWhiteSpace(ch)) {
        candidate = i; sinceCandidate = 0;
      } else if (!isEditWhiteSpace(ch) && ch !== '\n' && sinceCandidate + w > wrapWidth) {
        candidate = i; sinceCandidate = 0;
      }
    }
    lineWidth += w;
    sinceCandidate += w;
    const visible = isEditWhiteSpace(ch) || ch === '\n' ? lineWidth - w : lineWidth;
    if (candidate > start && visible > wrapWidth) {
      close(start, candidate);
      lineWidth = sinceCandidate;
      start = candidate;
      candidate = -1;
    }
  }
  close(start, text.length);
  if (text.length > 0 && text[text.length - 1] === '\n') lines.push({ start: text.length, end: text.length, width: 0 });
  return lines;
}

/** GlyphList::FindCurrentLine @ 004726f0 — the last line starting at or before `pos`. */
export function lineOfPosition(lines: readonly EditLine[], pos: number): number {
  let k = 0;
  while (k + 1 < lines.length && lines[k + 1].start <= pos) k++;
  return k;
}

/** GlyphList::FindPixelsFromPos @ 00472b40 — the advance from the line's start to `pos`. */
export function pixelsFromPosition(
  font: Pick<DatEditFont, 'measureText'>, text: string, lines: readonly EditLine[], pos: number,
): number {
  const line = lines[lineOfPosition(lines, pos)];
  let x = 0;
  for (let i = line?.start ?? 0; i < pos && i < text.length; i++) x += glyphWidth(font, text[i]);
  return x;
}

/**
 * GlyphList::FindPosFromLineAndPixels @ 004732d0 (round flag set): past the
 * line's width lands on the text's end on the last line, else one before the
 * next line's start (ahead of its trailing space / newline); otherwise walk
 * the glyphs and stop before the first whose half-width the remaining
 * pixels do not pass, or before the line's closing newline.
 */
export function positionFromLineAndPixels(
  font: Pick<DatEditFont, 'measureText'>, text: string, lines: readonly EditLine[], line: number, px: number,
): number {
  const k = Math.max(0, Math.min(line, lines.length - 1));
  const l = lines[k];
  if (!l) return 0;
  const last = k === lines.length - 1;
  const lineEnd = last ? text.length : lines[k + 1].start;
  if (px > l.width) return last ? text.length : lineEnd - 1;
  let rem = Math.floor(px);
  for (let i = l.start; i < lineEnd; i++) {
    const w = glyphWidth(font, text[i]);
    if (rem <= Math.trunc(w / 2)) return i;
    if (text[i] === '\n' && i + 1 === lineEnd) return i;
    rem -= w;
  }
  return lineEnd;
}

/**
 * UIElement_Text::MoveUpDown @ 004682e0 — the cursor's pixel offset on its
 * line, carried to the line above / below through both lines'
 * justification (`justify(lineWidth)` = CalcJustification's offset); the
 * first / last line keeps the cursor where it is.
 */
export function moveUpDown(
  font: Pick<DatEditFont, 'measureText'>, text: string, lines: readonly EditLine[], pos: number, up: boolean,
  justify: (lineWidth: number) => number = () => 0,
): number {
  const k = lineOfPosition(lines, pos);
  const target = up ? k - 1 : k + 1;
  if (target < 0 || target >= lines.length) return pos;
  const px = pixelsFromPosition(font, text, lines, pos) + justify(lines[k].width) - justify(lines[target].width);
  return positionFromLineAndPixels(font, text, lines, target, px);
}

/**
 * UIElement_Text::MoveBeginEndLine @ 00466db0 — LINE_HOME: the line's
 * start; LINE_END: the text's end on the last line, else one before the
 * next line's start.
 */
export function lineHomeEnd(text: string, lines: readonly EditLine[], pos: number, home: boolean): number {
  const k = lineOfPosition(lines, pos);
  if (home) return lines[k]?.start ?? 0;
  return k >= lines.length - 1 ? text.length : lines[k + 1].start - 1;
}

/** GlyphList::FindLineFromY @ 00472770 — y < 1 is line 0; past the last line, the last. */
export function lineFromY(lineCount: number, lineHeight: number, y: number): number {
  if (y < 1 || lineHeight <= 0) return 0;
  return Math.max(0, Math.min(lineCount - 1, Math.ceil(y / lineHeight) - 1));
}

/**
 * The vertical branch of IsPositionInView @ 00468aa0 / ScrollToPosition @
 * 004691b0 (m_bitField & 2 clear): the cursor's line is in view while
 * `scroll <= y && y + h <= scroll + viewHeight`, h = min(lineHeight,
 * viewHeight); otherwise the scroll becomes `y + h - viewHeight` when the
 * line ran off the bottom, else `y`.
 */
export function scrollForCaretY(scroll: number, caretY: number, lineHeight: number, viewHeight: number): number {
  const h = Math.min(lineHeight, viewHeight);
  if (scroll <= caretY && caretY + h <= scroll + viewHeight) return scroll;
  return scroll + viewHeight < caretY + h ? caretY + h - viewHeight : caretY;
}

export interface DatTextAreaHandle extends DatEditFieldHandle {
  /** The current glyph lines (tests, probes). */
  lines(): readonly EditLine[];
  /** The font's maxCharHeight — one line, the scrollbar's step. */
  readonly lineHeight: number;
}

/**
 * Paint a multi-line `area` (a <textarea> placed over its DAT field `host`)
 * in the DAT font, wrapped per GlyphList::Recalculate. The layer is the
 * field's scroll viewport (scrollTop = UIElement_Scrollable's y), so a DAT
 * scrollbar binds to it. Without a font it leaves the textarea as it is.
 */
export function attachDatTextArea(
  area: HTMLTextAreaElement, host: HTMLElement, opts: DatEditFieldOptions,
): DatTextAreaHandle | null {
  const font = opts.font;
  if (!font) return null;
  const doc = area.ownerDocument;
  const now = opts.now ?? (() => performance.now());
  const marginLeft = opts.marginLeft ?? 0;
  const marginRight = opts.marginRight ?? 0;
  const marginTop = opts.marginTop ?? 0;
  const marginBottom = opts.marginBottom ?? 0;
  const lh = font.lineHeight;

  area.style.color = 'transparent';
  area.style.caretColor = 'transparent';
  area.dataset.acDatEdit = '1';
  const ownStyle = doc.createElement('style');
  const cls = `ac-dat-edit-${++editFieldSerial}`;
  area.classList.add(cls);
  ownStyle.textContent = `.${cls}::selection{background:transparent;color:transparent;}`;
  host.appendChild(ownStyle);

  // No z-index, as attachDatEditField: the selection inverts the backdrop.
  const layer = doc.createElement('div');
  layer.className = 'ac-dat-edit-layer';
  Object.assign(layer.style, {
    position: 'absolute', left: `${marginLeft}px`, top: `${marginTop}px`,
    right: `${marginRight}px`, bottom: `${marginBottom}px`,
    overflow: 'hidden', pointerEvents: 'none',
  });
  const content = doc.createElement('div');
  Object.assign(content.style, { position: 'relative', left: '0', top: '0', width: '100%' });
  const glyphs = doc.createElement('div');
  const selections = doc.createElement('div');
  const caret = doc.createElement('div');
  caret.className = 'ac-dat-edit-caret';
  Object.assign(caret.style, {
    position: 'absolute', width: '1px', height: `${lh}px`, background: opts.color, display: 'none',
  });
  content.append(glyphs, selections, caret);
  layer.appendChild(content);
  host.appendChild(layer);

  const blink = new CaretBlink();
  let lines: EditLine[] = [{ start: 0, end: 0, width: 0 }];
  let painted: string | null = null;
  let paintedWidth = -1;
  let blockTop = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const focused = (): boolean => doc.activeElement === area;
  const viewWidth = (): number => layer.clientWidth || Math.max(0, host.clientWidth - marginLeft - marginRight);
  const viewHeight = (): number => layer.clientHeight || Math.max(0, host.clientHeight - marginTop - marginBottom);
  const scrollableWidth = (): number => Math.max(0, ...lines.map((l) => l.width));
  const lineX = (width: number): number =>
    Math.max(0, calcJustification(width, viewWidth(), scrollableWidth(), opts.hJustify ?? 0));

  const relayout = (): void => {
    const text = area.value;
    const width = viewWidth();
    if (text === painted && width === paintedWidth) return;
    painted = text;
    paintedWidth = width;
    lines = wrapEditLines(font, text, width);
    glyphs.replaceChildren();
    const pad = opts.outlineColor ? font.outlinePadding : { x: 0, y: 0 };
    lines.forEach((l, i) => {
      const s = text.slice(l.start, l.end).replace(/\n$/, '');
      if (!s) return;
      const c = font.renderTextToCanvas(s, opts.color, 1, opts.outlineColor);
      Object.assign(c.style, {
        position: 'absolute', left: `${lineX(l.width) - pad.x}px`, top: `${i * lh - pad.y}px`, display: 'block',
      });
      glyphs.appendChild(c);
    });
    const blockHeight = lines.length * lh;
    // DrawSelf: line 0 at CalcJustification(max(maxCharHeight, scrollable height)).
    blockTop = Math.max(0, calcJustification(Math.max(lh, blockHeight), viewHeight(), blockHeight, opts.vJustify ?? 0));
    content.style.top = `${blockTop}px`;
    content.style.height = `${blockHeight}px`;
  };

  const cursorOf = (): number => {
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? start;
    return area.selectionDirection === 'backward' ? start : end;
  };

  /** Repaint; `follow` scrolls the cursor's line into view (SetCursorPosition). */
  const paint = (follow = false): void => {
    relayout();
    const text = area.value;
    const start = area.selectionStart ?? text.length;
    const end = area.selectionEnd ?? start;
    const cursor = cursorOf();
    const k = lineOfPosition(lines, cursor);
    const caretX = lineX(lines[k].width) + pixelsFromPosition(font, text, lines, cursor);
    const caretY = k * lh;
    if (follow && viewHeight() > 0) {
      layer.scrollTop = Math.max(0, scrollForCaretY(layer.scrollTop - blockTop, caretY, lh, viewHeight()) + blockTop);
    }
    selections.replaceChildren();
    const a = Math.min(start, end);
    const b = Math.max(start, end);
    if (b > a) {
      lines.forEach((l, i) => {
        const s = Math.max(a, l.start);
        const e = Math.min(b, l.end);
        if (e <= s) return;
        const x0 = pixelsFromPosition(font, text, [l], s);
        const x1 = pixelsFromPosition(font, text, [l], e);
        if (x1 <= x0) return;
        const box = doc.createElement('div');
        box.className = 'ac-dat-edit-selection';
        Object.assign(box.style, {
          position: 'absolute', left: `${lineX(l.width) + x0}px`, top: `${i * lh}px`,
          width: `${x1 - x0}px`, height: `${lh}px`, background: '#fff', mixBlendMode: 'difference',
        });
        selections.appendChild(box);
      });
    }
    caret.style.left = `${caretX}px`;
    caret.style.top = `${caretY}px`;
    caret.style.display = focused() && blink.tick(now()) ? 'block' : 'none';
    layer.dataset.acCaret = String(cursor);
    layer.dataset.acLine = String(k);
  };

  // SetCursorPosition scrolls to the cursor only when it moves (or the text
  // changes under it): a scrollbar drag followed by a stray key keeps its view.
  let lastCursor = -1;
  let lastValue: string | null = null;
  const moved = (): void => {
    blink.reset(now());
    const cursor = cursorOf();
    const follow = cursor !== lastCursor || area.value !== lastValue;
    lastCursor = cursor;
    lastValue = area.value;
    paint(follow);
  };
  const onSelectionChange = (): void => { if (focused()) moved(); };
  const blinkTick = (): void => { if (area.isConnected) paint(); else stopBlink(); };
  const startBlink = (): void => {
    moved();
    if (timer === null) timer = setInterval(blinkTick, Math.max(16, Math.floor(CARET_BLINK_MS / 4)));
    doc.addEventListener('selectionchange', onSelectionChange);
  };
  function stopBlink(): void {
    if (timer !== null) { clearInterval(timer); timer = null; }
    doc.removeEventListener('selectionchange', onSelectionChange);
    const start = area.selectionStart;
    const end = area.selectionEnd;
    if (start !== null && end !== null && start !== end) {
      const cursor = area.selectionDirection === 'backward' ? start : end;
      area.setSelectionRange(cursor, cursor);
    }
    paint();
  }

  /** Move the cursor to `to` (extending the selection from its anchor when `extend`). */
  const setCursor = (to: number, extend: boolean): void => {
    const start = area.selectionStart ?? 0;
    const end = area.selectionEnd ?? start;
    const anchorPos = area.selectionDirection === 'backward' ? end : start;
    if (extend) area.setSelectionRange(Math.min(anchorPos, to), Math.max(anchorPos, to), to < anchorPos ? 'backward' : 'forward');
    else area.setSelectionRange(to, to);
    moved();
  };

  // The browser's own Up / Down / Home / End / PageUp / PageDown follow its
  // font's wrapping, not the glyph lines: UIElement_Text::OnAction @
  // 0046a260 → MoveCursor @ 00468d00 takes them.
  const onKeyDown = (e: KeyboardEvent): void => {
    relayout();
    const text = area.value;
    const cursor = cursorOf();
    let to: number | null = null;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      to = moveUpDown(font, text, lines, cursor, e.key === 'ArrowUp', lineX);
    } else if ((e.key === 'Home' || e.key === 'End') && !e.ctrlKey && !e.metaKey) {
      to = lineHomeEnd(text, lines, cursor, e.key === 'Home');
    } else if (e.key === 'PageUp' || e.key === 'PageDown') {
      // ScrollPage @ 00466440, then DeterminePositionFromXY(0, 0): the
      // cursor goes to the view's top-left glyph.
      const max = Math.max(0, layer.scrollHeight - layer.clientHeight);
      layer.scrollTop = Math.max(0, Math.min(max, layer.scrollTop + (e.key === 'PageUp' ? -1 : 1) * viewHeight()));
      const line = lineFromY(lines.length, lh, layer.scrollTop - blockTop);
      to = positionFromLineAndPixels(font, text, lines, line, -lineX(lines[line].width));
      e.preventDefault();
      area.setSelectionRange(to, to);
      blink.reset(now());
      paint();
      return;
    }
    if (to === null) { moved(); return; }
    e.preventDefault();
    setCursor(to, e.shiftKey);
  };

  // SetCursorPositionFromXY @ 00468cd0 → DeterminePositionFromXY: the line
  // from y (FindLineFromY), then the glyph from x on it.
  let anchor: number | null = null;
  const indexAt = (clientX: number, clientY: number): number => {
    relayout();
    const rect = layer.getBoundingClientRect();
    const scale = layer.offsetWidth > 0 ? rect.width / layer.offsetWidth : 1;
    const x = (clientX - rect.left) / (scale || 1);
    const y = (clientY - rect.top) / (scale || 1) + layer.scrollTop - blockTop;
    const line = lineFromY(lines.length, lh, y);
    const px = x - lineX(lines[line].width);
    return px < 0 ? lines[line].start : positionFromLineAndPixels(font, area.value, lines, line, px);
  };
  const onDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    area.focus();
    const i = indexAt(e.clientX, e.clientY);
    anchor = e.shiftKey ? (area.selectionStart ?? i) : i;
    area.setSelectionRange(Math.min(anchor, i), Math.max(anchor, i), i < anchor ? 'backward' : 'forward');
    doc.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', onUp);
    moved();
  };
  const onMove = (e: MouseEvent): void => {
    if (anchor === null) return;
    const i = indexAt(e.clientX, e.clientY);
    area.setSelectionRange(Math.min(anchor, i), Math.max(anchor, i), i < anchor ? 'backward' : 'forward');
    moved();
  };
  function onUp(): void {
    anchor = null;
    doc.removeEventListener('mousemove', onMove);
    doc.removeEventListener('mouseup', onUp);
  }
  // The wheel over the text scrolls the glyph lines (the textarea's own
  // scroll follows the browser font and shows nothing).
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    layer.scrollTop += wheelScrollPixels(e, lh, viewHeight());
  };

  let proto: object | null = Object.getPrototypeOf(area);
  let valueDesc: PropertyDescriptor | undefined;
  while (proto && !(valueDesc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
  if (valueDesc?.get && valueDesc.set) {
    const { get, set } = valueDesc;
    Object.defineProperty(area, 'value', {
      configurable: true,
      get(this: HTMLTextAreaElement) { return get.call(this); },
      set(this: HTMLTextAreaElement, v: string) { set.call(this, v); moved(); },
    });
  }

  const onInput = (): void => moved();
  area.addEventListener('mousedown', onDown);
  area.addEventListener('wheel', onWheel, { passive: false });
  area.addEventListener('input', onInput);
  area.addEventListener('keydown', onKeyDown);
  area.addEventListener('keyup', onInput);
  area.addEventListener('select', onInput);
  area.addEventListener('focus', startBlink);
  area.addEventListener('blur', stopBlink);
  if (focused()) startBlink(); else paint();

  return {
    layer,
    lineHeight: lh,
    lines: () => { relayout(); return lines; },
    refresh: moved,
    destroy(): void {
      if (timer !== null) clearInterval(timer);
      area.removeEventListener('mousedown', onDown);
      area.removeEventListener('wheel', onWheel);
      doc.removeEventListener('mousemove', onMove);
      doc.removeEventListener('mouseup', onUp);
      area.removeEventListener('input', onInput);
      area.removeEventListener('keydown', onKeyDown);
      area.removeEventListener('keyup', onInput);
      area.removeEventListener('select', onInput);
      doc.removeEventListener('selectionchange', onSelectionChange);
      area.removeEventListener('focus', startBlink);
      area.removeEventListener('blur', stopBlink);
      delete (area as { value?: string }).value;
      layer.remove();
      ownStyle.remove();
    },
  };
}
