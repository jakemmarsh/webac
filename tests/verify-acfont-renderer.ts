/**
 * GAP.82 — ACFontRenderer had no dedicated behavioral unit test; the only
 * existing coverage (verify-wrap-text-honors-newlines.ts, FAITHFUL.513) was
 * a readFileSync + regex source-text pin, forbidden by CLAUDE.md ("Never
 * add a new test that readFileSync's a .ts source file and regex-matches
 * it — source-text pins catch nothing"). This file drives the real,
 * shipped ACFontRenderer class instead: its glyph-layout engine
 * (layoutText/measureText, used by every DAT-bitmap-font caller in the
 * renderer) and its private wrapText paragraph/word-wrap logic (called via
 * the instance, not regex on source), replacing the pin's coverage with
 * assertions on actual return values.
 *
 * Canvas-drawing paths (initSpritesheet/renderToCanvas/renderTextToCanvas)
 * are NOT covered here: this repo's test environment (vitest + optional
 * happy-dom) has no real <canvas> 2D context — HTMLCanvasElement.getContext
 * returns null under happy-dom, and plain node has no `document` at all —
 * so pixel-level rendering can't be exercised without a native canvas
 * dependency. The layout math tested here is what actually determines
 * glyph positions/wrapping; the drawImage calls are a thin, un-testable-
 * without-a-native-dep pass-through on top of it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACFontRenderer } from '../packages/renderer/src/ui/ACFontRenderer.js';
import { ACFont, type FontCharDesc } from '../packages/dat-parser/src/file-types/ACFont.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';

// Access the private wrapText method the same way its caller
// (renderWrappedTextToCanvas) does at runtime — TS privacy is
// compile-time only, so this still drives the real shipped method.
type WithWrapText = { wrapText(text: string, maxWidth: number): string[] };

function makeFont(descs: FontCharDesc[], maxCharHeight = 12): ACFont {
  const font = new ACFont();
  font.id = 0x40000000;
  font.maxCharHeight = maxCharHeight;
  font.maxCharWidth = Math.max(...descs.map(d => d.width), 0);
  font.numCharacters = descs.length;
  font.charDescs = descs;
  font.foregroundSurfaceDataId = 0x06000001;
  font.backgroundSurfaceDataId = 0;
  return font;
}

function char(unicode: number, overrides: Partial<FontCharDesc> = {}): FontCharDesc {
  return {
    unicode,
    offsetX: 0,
    offsetY: 0,
    width: 5,
    height: 8,
    horizontalOffsetBefore: 0,
    horizontalOffsetAfter: 0,
    verticalOffsetBefore: 0,
    ...overrides,
  };
}

describe('ACFontRenderer.layoutText/measureText — glyph-layout engine', () => {
  const font = makeFont([
    char(65, { horizontalOffsetBefore: 1, horizontalOffsetAfter: 1, width: 5, verticalOffsetBefore: 2, height: 8 }), // 'A'
    char(66, { horizontalOffsetBefore: 2, horizontalOffsetAfter: 1, width: 6, verticalOffsetBefore: 0, height: 9 }), // 'B'
  ]);
  const renderer = new ACFontRenderer(font);

  it('positions each glyph after accumulating horizontalOffsetBefore, and advances the cursor by width + horizontalOffsetAfter', () => {
    const layout = renderer.layoutText('AB');
    expect(layout.glyphs).toHaveLength(2);
    expect(layout.glyphs[0].x).toBe(1); // A: 0 + hBefore(1)
    expect(layout.glyphs[0].y).toBe(2); // A: verticalOffsetBefore
    expect(layout.glyphs[1].x).toBe(9); // 1 + width(5) + hAfter(1) + hBefore(2)
    expect(layout.glyphs[1].y).toBe(0); // B: verticalOffsetBefore
  });

  it('total width is the final cursor position; height is the font\'s maxCharHeight (Glyph::SetFont m_height)', () => {
    const layout = renderer.layoutText('AB');
    expect(layout.width).toBe(16); // (1+5+1) + (2+6+1)
    expect(layout.height).toBe(12); // maxCharHeight, not the ink bottom max(2+8, 0+9) = 10
  });

  it('VISUAL.examine-misc-list-row-sliver: every one-line text is equally tall, so centred labels share a baseline', () => {
    // 'A' has no descender (ink bottom 10), 'B' reaches 9; a descender glyph reaches 12.
    const f = makeFont([
      char(65, { width: 5, verticalOffsetBefore: 2, height: 8 }),
      char(103, { width: 5, verticalOffsetBefore: 4, height: 8 }), // 'g' (ink bottom 12)
    ]);
    const r = new ACFontRenderer(f);
    expect(r.layoutText('A').height).toBe(12);
    expect(r.layoutText('Ag').height).toBe(12);
    // CalcJustification centring in a 20 px row: (20 >> 1) - (h >> 1) is the same for both.
    const top = (h: number): number => (20 >> 1) - (h >> 1);
    expect(top(r.layoutText('A').height)).toBe(top(r.layoutText('Ag').height));
    // A glyph reaching below maxCharHeight still fits its canvas.
    const tall = new ACFontRenderer(makeFont([char(65, { width: 5, verticalOffsetBefore: 6, height: 9 })]));
    expect(tall.layoutText('A').height).toBe(15);
  });

  it('skips codepoints with no glyph in the font, without breaking layout of surrounding characters', () => {
    const withUnknown = renderer.layoutText('AZB'); // 'Z' (0x5A) has no entry
    const known = renderer.layoutText('AB');
    expect(withUnknown.glyphs).toHaveLength(2);
    expect(withUnknown.width).toBe(known.width);
    expect(withUnknown.glyphs).toEqual(known.glyphs);
  });

  it('empty string has no glyphs, zero width, and falls back to font.maxCharHeight', () => {
    const layout = renderer.layoutText('');
    expect(layout.glyphs).toEqual([]);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(12); // font.maxCharHeight
  });

  it('measureText agrees with layoutText.width for the same string (both sum horizontalOffsetBefore + width + horizontalOffsetAfter)', () => {
    for (const text of ['A', 'B', 'AB', 'BA', 'AAB', '']) {
      expect(renderer.measureText(text)).toBe(renderer.layoutText(text).width);
    }
  });

  it('exposes lineHeight/texture ids from the underlying ACFont', () => {
    expect(renderer.lineHeight).toBe(12);
    expect(renderer.foregroundTextureId).toBe(0x06000001);
    expect(renderer.characterCount).toBe(2);
  });
});

describe('ACFontRenderer.wrapText (private, driven directly) — FAITHFUL.513 hard-newline handling', () => {
  // Uniform lowercase-letter + space metrics so word-wrap width math is
  // simple to reason about via measureText rather than hardcoded pixels.
  const LOWERCASE = Array.from({ length: 26 }, (_, i) => char(97 + i, { width: 4 }));
  const SPACE = char(32, { width: 4 });
  const font = makeFont([...LOWERCASE, SPACE]);
  const renderer = new ACFontRenderer(font);
  const wrapText = (renderer as unknown as WithWrapText).wrapText.bind(renderer);

  it('pre-splits on hard "\\n" so each paragraph wraps independently', () => {
    // maxWidth large enough that neither paragraph needs internal wrapping.
    const huge = renderer.measureText('hello world') + 100;
    expect(wrapText('hello world\nfoo bar baz', huge)).toEqual(['hello world', 'foo bar baz']);
  });

  it('consecutive "\\n\\n" preserves a blank line for vertical paragraph spacing', () => {
    const huge = renderer.measureText('hello world') + 100;
    expect(wrapText('hello world\n\nfoo bar', huge)).toEqual(['hello world', '', 'foo bar']);
  });

  it('word-wraps within a paragraph once a line exceeds maxWidth', () => {
    // maxWidth fits "hello" exactly but not "hello world".
    const maxWidth = renderer.measureText('hello');
    expect(wrapText('hello world', maxWidth)).toEqual(['hello', 'world']);
  });

  it('a lone empty string still returns a single (empty) line, never zero lines', () => {
    expect(wrapText('', 1000)).toEqual(['']);
  });
});

// ── real DAT font (0x40000000, the primary UI font GameUI loads) ──
const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const hasPortalDat = existsSync(PORTAL_DAT);

describe.skipIf(!hasPortalDat)('ACFontRenderer against the real primary UI font (0x40000000)', () => {
  // Load lazily in beforeAll: vitest executes this describe callback at
  // collection time even when skipIf skips the suite, so an eager
  // readFileSync here throws ENOENT on CI (no dat/).
  let font: ACFont;
  let renderer: ACFontRenderer;

  beforeAll(() => {
    const buf = readFileSync(PORTAL_DAT).buffer;
    const portalDb = new DatDatabase(buf as ArrayBuffer);
    const fontData = portalDb.getFileData(0x40000000);
    if (!fontData) throw new Error('0x40000000 (primary UI font) missing from client_portal.dat');
    font = ACFont.read(new DatReader(fontData));
    renderer = new ACFontRenderer(font);
  });

  it('parses a non-trivial glyph set including printable ASCII', () => {
    expect(font.charDescs.length).toBeGreaterThan(20);
    for (const code of 'AZaz09 .,!?'.split('').map(c => c.charCodeAt(0))) {
      expect(renderer.getChar(code), `missing glyph for codepoint ${code}`).toBeDefined();
    }
  });

  it('lays out real text with monotonically non-decreasing glyph x-positions', () => {
    const layout = renderer.layoutText('Hello, World!');
    expect(layout.glyphs.length).toBeGreaterThan(0);
    for (let i = 1; i < layout.glyphs.length; i++) {
      expect(layout.glyphs[i].x).toBeGreaterThanOrEqual(layout.glyphs[i - 1].x);
    }
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('measureText agrees with layoutText.width using real glyph metrics', () => {
    for (const text of ['Hello', 'World', 'The quick brown fox', '']) {
      expect(renderer.measureText(text)).toBe(renderer.layoutText(text).width);
    }
  });

  it('lineHeight matches the font\'s real maxCharHeight and is positive', () => {
    expect(renderer.lineHeight).toBe(font.maxCharHeight);
    expect(renderer.lineHeight).toBeGreaterThan(0);
  });

  it('has a real (non-zero) foreground spritesheet texture id to initSpritesheet from', () => {
    expect(renderer.foregroundTextureId).not.toBe(0);
  });
});

// ── CORE.17.k.b.a — the p33/p34 outline pass geometry ──
// UIElement_Text::DrawSelf @ 00467aa0 draws an outlined element (SetOutline
// @ 00466630, bitfield 0x10) in two passes: pass 0 blits each glyph's halo
// from the font's BACKGROUND surface (SurfaceWindow::DrawCharacter mode
// 0x7000 → CreateCharRectPair grows the glyph rect by the border pixels),
// or, for a font without one, the glyph itself at the eight ±1px neighbour
// offsets (mode 0x9000); pass 1 is the normal glyph. The canvas draws are
// not testable here (no 2D context) — the rect/offset geometry that feeds
// them is.
import { OUTLINE_NEIGHBOUR_OFFSETS } from '../packages/renderer/src/ui/ACFontRenderer.js';

describe('ACFontRenderer outline pass (CORE.17.k.b.a) — halo rects and neighbour ring', () => {
  const descs = [
    char(0x41, { offsetX: 10, offsetY: 20, width: 6, height: 8, horizontalOffsetAfter: 1, verticalOffsetBefore: 3 }),
    char(0x42, { offsetX: 40, offsetY: 20, width: 5, height: 8, horizontalOffsetBefore: 1 }),
  ];

  it('a font with a background surface pads by its border pixels and grows every glyph rect by them on all four sides, keeping the glyph in place', () => {
    const font = makeFont(descs, 12);
    font.backgroundSurfaceDataId = 0x06000002;
    font.numHorizontalBorderPixels = 4;
    font.numVerticalBorderPixels = 3;
    const r = new ACFontRenderer(font);
    expect(r.hasBackgroundSpritesheet).toBe(false);
    expect(r.outlinePadding).toEqual({ x: 4, y: 3 });
    const rects = r.outlineGlyphRects('AB');
    const layout = r.layoutText('AB');
    expect(rects.length).toBe(2);
    rects.forEach((rect, i) => {
      const g = layout.glyphs[i];
      expect(rect.charDesc).toBe(g.charDesc);
      expect([rect.sx, rect.sy]).toEqual([g.charDesc.offsetX - 4, g.charDesc.offsetY - 3]);
      expect([rect.sw, rect.sh]).toEqual([g.charDesc.width + 8, g.charDesc.height + 6]);
      // the halo lands border pixels left/above the glyph's own position
      expect([rect.dx, rect.dy]).toEqual([g.x - 4, g.y - 3]);
    });
    // A: x 0, y 3 → halo at (−4, 0); B: after A's 6+1 advance and its own 1 before → x 8, y 0 → halo at (4, −3).
    expect(rects.map((x) => [x.dx, x.dy])).toEqual([[-4, 0], [4, -3]]);
  });

  it('a font without a background surface pads by the 1px neighbour ring', () => {
    const r = new ACFontRenderer(makeFont(descs));
    expect(r.outlinePadding).toEqual({ x: 1, y: 1 });
    expect(r.hasBackgroundSpritesheet).toBe(false);
  });

  it('the neighbour ring is the 3x3 block minus the centre, in DrawSelf\'s row-major order', () => {
    expect(OUTLINE_NEIGHBOUR_OFFSETS.length).toBe(8);
    expect(OUTLINE_NEIGHBOUR_OFFSETS.some(([x, y]) => x === 0 && y === 0)).toBe(false);
    const set = new Set(OUTLINE_NEIGHBOUR_OFFSETS.map(([x, y]) => `${x},${y}`));
    for (const y of [-1, 0, 1]) for (const x of [-1, 0, 1]) if (x || y) expect(set.has(`${x},${y}`), `${x},${y}`).toBe(true);
    expect(OUTLINE_NEIGHBOUR_OFFSETS[0]).toEqual([-1, -1]);
    expect(OUTLINE_NEIGHBOUR_OFFSETS[7]).toEqual([1, 1]);
  });

  it('glyphs the font lacks contribute no halo rect, like layoutText', () => {
    const r = new ACFontRenderer(makeFont(descs));
    expect(r.outlineGlyphRects('A?B').length).toBe(2);
    expect(r.outlineGlyphRects('').length).toBe(0);
  });
});
