// @vitest-environment happy-dom
/**
 * RECON.dom-chrome-sweep.a — the multi-line DatEditField (journal notes,
 * book page editor, examine inscription): GlyphList::Recalculate @ 00473800
 * line wrapping with each line's character range, the cursor arithmetic of
 * FindCurrentLine @ 004726f0 / FindPixelsFromPos @ 00472b40 /
 * FindPosFromLineAndPixels @ 004732d0, MoveUpDown @ 004682e0,
 * MoveBeginEndLine @ 00466db0, FindLineFromY @ 00472770 and the vertical
 * branch of IsPositionInView / ScrollToPosition @ 004691b0.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  attachDatTextArea, wrapEditLines, lineOfPosition, pixelsFromPosition, positionFromLineAndPixels,
  moveUpDown, lineHomeEnd, lineFromY, scrollForCaretY, type DatEditFont,
} from '../packages/renderer/src/ui/DatEditField.js';

/** Every glyph 6 px wide, except 'i' (3 px) and 'W' (10 px). */
function fakeFont(): DatEditFont & { rendered: string[] } {
  const adv = (c: string): number => (c === 'i' ? 3 : c === 'W' ? 10 : 6);
  const rendered: string[] = [];
  return {
    rendered,
    lineHeight: 12,
    outlinePadding: { x: 1, y: 1 },
    measureText: (t: string) => Array.from(t).reduce((n, c) => n + adv(c), 0),
    renderTextToCanvas: (t: string) => {
      rendered.push(t);
      const c = document.createElement('canvas');
      c.dataset.text = t;
      return c;
    },
  };
}

const font = fakeFont();
const texts = (text: string, wrap: number): string[] => wrapEditLines(font, text, wrap).map((l) => text.slice(l.start, l.end));

describe('wrapEditLines (GlyphList::Recalculate)', () => {
  it('breaks at the last word start, the space staying on the line it follows', () => {
    // 'aaa bbb ccc': each word 18 px, a space 6. Wrap 40: 'aaa bbb' = 42 > 40.
    expect(texts('aaa bbb ccc', 40)).toEqual(['aaa ', 'bbb ', 'ccc']);
    // Wrap 42 fits 'aaa bbb' (trailing space excluded from the width).
    expect(texts('aaa bbb ccc', 42)).toEqual(['aaa bbb ', 'ccc']);
  });

  it('keeps every character: the lines tile the text', () => {
    const text = 'the  quick brown\nfox jumps over\n\nthe lazy dog ';
    const lines = wrapEditLines(font, text, 50);
    expect(lines[0].start).toBe(0);
    for (let i = 1; i < lines.length; i++) expect(lines[i].start).toBe(lines[i - 1].end);
    expect(lines[lines.length - 1].end).toBe(text.length);
  });

  it('closes a line after every newline, and text ending in one has an empty last line', () => {
    expect(texts('ab\ncd', 100)).toEqual(['ab\n', 'cd']);
    expect(texts('ab\n\ncd', 100)).toEqual(['ab\n', '\n', 'cd']);
    expect(texts('ab\n', 100)).toEqual(['ab\n', '']);
    expect(texts('', 100)).toEqual(['']);
  });

  it('breaks a lone word wider than the field where it overflows', () => {
    // 10 × 'a' = 60 px in a 25 px field: 4 glyphs (24) per line.
    expect(texts('aaaaaaaaaa', 25)).toEqual(['aaaa', 'aaaa', 'aa']);
  });

  it('measures a line without its trailing space or newline (m_nLineWidth)', () => {
    const lines = wrapEditLines(font, 'aaa bbb ccc', 40);
    expect(lines.map((l) => l.width)).toEqual([18, 18, 18]);
    expect(wrapEditLines(font, 'Wi\nx', 100)[0].width).toBe(13);
  });
});

describe('multi-line cursor arithmetic', () => {
  const text = 'aaa bbb ccc';
  const lines = wrapEditLines(font, text, 40); // 'aaa ' | 'bbb ' | 'ccc'

  it('puts a position on the last line starting at or before it (FindCurrentLine)', () => {
    expect(lineOfPosition(lines, 0)).toBe(0);
    expect(lineOfPosition(lines, 3)).toBe(0);
    // A soft-wrap boundary belongs to the line it starts.
    expect(lineOfPosition(lines, 4)).toBe(1);
    expect(lineOfPosition(lines, 11)).toBe(2);
  });

  it('measures the cursor from its line start (FindPixelsFromPos)', () => {
    expect(pixelsFromPosition(font, text, lines, 4)).toBe(0);
    expect(pixelsFromPosition(font, text, lines, 6)).toBe(12);
    expect(pixelsFromPosition(font, text, lines, 11)).toBe(18);
  });

  it('finds a position from a line and pixels, past the width one before the next line', () => {
    // Line 1 'bbb ': x 7 → past b(0..6)'s half 3 → index 5.
    expect(positionFromLineAndPixels(font, text, lines, 1, 7)).toBe(5);
    expect(positionFromLineAndPixels(font, text, lines, 1, 3)).toBe(4);
    // Past the 18 px width: ahead of the trailing space (next start − 1).
    expect(positionFromLineAndPixels(font, text, lines, 1, 30)).toBe(7);
    // On the last line: the text's end.
    expect(positionFromLineAndPixels(font, text, lines, 2, 30)).toBe(11);
  });

  it('stops ahead of a line\'s closing newline', () => {
    const t = 'ab\ncd';
    const l = wrapEditLines(font, t, 100);
    expect(positionFromLineAndPixels(font, t, l, 0, 11)).toBe(2);
  });

  it('moves up and down at the same pixel offset, staying put at the first / last line', () => {
    expect(moveUpDown(font, text, lines, 5, false)).toBe(9); // b|bb → c|cc
    expect(moveUpDown(font, text, lines, 9, true)).toBe(5);
    expect(moveUpDown(font, text, lines, 1, true)).toBe(1);
    expect(moveUpDown(font, text, lines, 10, false)).toBe(10);
    // From the end of a long line onto a shorter one: one before the next start.
    const t = 'aaaaaa\nbb\ncc';
    const l = wrapEditLines(font, t, 100);
    expect(moveUpDown(font, t, l, 6, false)).toBe(9);
  });

  it('carries the offset through both lines\' justification (centred text)', () => {
    // Centre in a 40 px view: offset = 20 − (width >> 1).
    const t = 'aaaaa\na';
    const l = wrapEditLines(font, t, 40);
    const centre = (w: number): number => 20 - (w >> 1);
    // Cursor at 3 on line 0 (x 18 + offset 5 = 23); line 1 offset 17 → px 6 → end.
    expect(moveUpDown(font, t, l, 3, false, centre)).toBe(7);
    expect(moveUpDown(font, t, l, 1, false, centre)).toBe(6);
  });

  it('goes to the line\'s start / end (MoveBeginEndLine)', () => {
    expect(lineHomeEnd(text, lines, 6, true)).toBe(4);
    expect(lineHomeEnd(text, lines, 6, false)).toBe(7);
    expect(lineHomeEnd(text, lines, 9, false)).toBe(11);
  });

  it('finds the line from y (FindLineFromY)', () => {
    expect(lineFromY(3, 12, -5)).toBe(0);
    expect(lineFromY(3, 12, 0)).toBe(0);
    expect(lineFromY(3, 12, 12)).toBe(0);
    expect(lineFromY(3, 12, 13)).toBe(1);
    expect(lineFromY(3, 12, 500)).toBe(2);
  });

  it('scrolls the cursor\'s line into view only when it leaves it', () => {
    expect(scrollForCaretY(0, 24, 12, 48)).toBe(0);
    expect(scrollForCaretY(0, 48, 12, 48)).toBe(12);
    expect(scrollForCaretY(36, 12, 12, 48)).toBe(12);
    // A view shorter than a line keeps the line's top in view.
    expect(scrollForCaretY(0, 24, 12, 8)).toBe(24);
  });
});

describe('attachDatTextArea', () => {
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; document.body.innerHTML = ''; });

  const mount = (width = 40, height = 24) => {
    const host = document.createElement('div');
    host.style.position = 'relative';
    Object.defineProperty(host, 'clientWidth', { value: width });
    Object.defineProperty(host, 'clientHeight', { value: height });
    document.body.appendChild(host);
    const area = document.createElement('textarea');
    host.appendChild(area);
    const f = fakeFont();
    const handle = attachDatTextArea(area, host, { font: f, color: 'rgb(0, 0, 0)', now: () => 0 })!;
    cleanup = () => handle.destroy();
    return { host, area, font: f, handle };
  };

  it('hides the browser glyphs and paints one DAT line per glyph line', () => {
    const { area, handle } = mount();
    expect(area.style.color).toBe('transparent');
    area.value = 'aaa bbb ccc';
    const canvases = Array.from(handle.layer.querySelectorAll('canvas')) as HTMLCanvasElement[];
    expect(canvases.map((c) => c.dataset.text)).toEqual(['aaa ', 'bbb ', 'ccc']);
    expect(canvases.map((c) => c.style.top)).toEqual(['0px', '12px', '24px']);
    expect(handle.lines().length).toBe(3);
  });

  it('draws no glyphs for a newline', () => {
    const { area, handle } = mount(100);
    area.value = 'ab\ncd';
    const canvases = Array.from(handle.layer.querySelectorAll('canvas')) as HTMLCanvasElement[];
    expect(canvases.map((c) => c.dataset.text)).toEqual(['ab', 'cd']);
  });

  it('moves the cursor along the glyph lines on ArrowDown / ArrowUp / Home / End', () => {
    const { area, handle } = mount();
    area.value = 'aaa bbb ccc';
    area.focus();
    area.setSelectionRange(1, 1);
    handle.refresh();
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(area.selectionStart).toBe(5);
    expect(handle.layer.dataset.acLine).toBe('1');
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(area.selectionStart).toBe(7);
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(area.selectionStart).toBe(4);
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true, cancelable: true }));
    expect([area.selectionStart, area.selectionEnd]).toEqual([0, 4]);
  });

  it('draws the caret on its glyph line and scrolls that line into view', () => {
    const { area, handle } = mount(40, 24);
    area.value = 'aaa bbb ccc';
    area.focus();
    area.setSelectionRange(10, 10);
    handle.refresh();
    const caret = handle.layer.querySelector('.ac-dat-edit-caret') as HTMLElement;
    expect(caret.style.top).toBe('24px');
    expect(caret.style.left).toBe('12px');
    expect(caret.style.display).toBe('block');
    // Line 2 (y 24..36) in a 24 px view: scroll 12.
    expect(handle.layer.scrollTop).toBe(12);
  });

  it('inverts the selected glyphs line by line', () => {
    const { area, handle } = mount();
    area.value = 'aaa bbb ccc';
    area.setSelectionRange(2, 6);
    handle.refresh();
    const boxes = Array.from(handle.layer.querySelectorAll('.ac-dat-edit-selection')) as HTMLElement[];
    // NotColorBits: a difference blend against the field's art, so the layer
    // must not open a stacking context (a z-index isolates the blend: a white box).
    expect(boxes[0].style.mixBlendMode).toBe('difference');
    expect(handle.layer.style.zIndex).toBe('');
    expect(boxes.map((b) => [b.style.left, b.style.top, b.style.width])).toEqual([
      ['12px', '0px', '12px'], ['0px', '12px', '12px'],
    ]);
  });

  it('places the cursor from a click on the line under it', () => {
    const { area, handle } = mount();
    area.value = 'aaa bbb ccc';
    // Setting the value left the cursor at the end, scrolled to line 2.
    expect(handle.layer.scrollTop).toBe(12);
    area.setSelectionRange(0, 0);
    handle.refresh();
    expect(handle.layer.scrollTop).toBe(0);
    // happy-dom reports zero rects: client coordinates are text space.
    area.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 7, clientY: 14, bubbles: true }));
    expect(area.selectionStart).toBe(5);
  });

  it('restores the native value property on destroy', () => {
    const { area, handle } = mount();
    handle.destroy();
    cleanup = null;
    area.value = 'x';
    expect(area.value).toBe('x');
    expect(handle.layer.isConnected).toBe(false);
  });
});
