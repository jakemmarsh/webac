/**
 * PERF.ui-text-canvas-churn — tinted / outlined text draws from glyph sheets
 * pre-tinted once per colour, not through a fresh scratch canvas per label
 * (half of all UI canvas churn in the 2026-10-03 churn probe, and the source
 * of the many small GPU canvases behind BUG.ui-text-blank-iosurface-exhaustion).
 * The test environment has no 2D canvas, so a recording stub stands in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ACFontRenderer } from '../packages/renderer/src/ui/ACFontRenderer.ts';
import { ACFont, type FontCharDesc } from '../packages/dat-parser/src/file-types/ACFont.ts';

interface Op { op: string; args: unknown[] }
interface FakeCanvas { width: number; height: number; ops: Op[]; getContext(): unknown }

let created: FakeCanvas[] = [];
const saved = (globalThis as { document?: unknown }).document;

function fakeCanvas(): FakeCanvas {
  const c: FakeCanvas = {
    width: 0, height: 0, ops: [],
    getContext() {
      const rec = (op: string) => (...args: unknown[]) => { c.ops.push({ op, args }); };
      return {
        drawImage: rec('drawImage'), fillRect: rec('fillRect'), scale: rec('scale'),
        putImageData: rec('putImageData'), createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        set globalCompositeOperation(v: string) { c.ops.push({ op: 'gco', args: [v] }); },
        set fillStyle(v: string) { c.ops.push({ op: 'fillStyle', args: [v] }); },
      };
    },
  };
  created.push(c);
  return c;
}

function font(withBackground: boolean): ACFont {
  const f = new ACFont();
  f.maxCharHeight = 12;
  f.numHorizontalBorderPixels = 1;
  f.numVerticalBorderPixels = 1;
  const glyph = (ch: string, x: number): FontCharDesc => ({ unicode: ch.charCodeAt(0), offsetX: x, offsetY: 0, width: 6, height: 10, horizontalOffsetBefore: 0, horizontalOffsetAfter: 0, verticalOffsetBefore: 0 });
  f.charDescs = [glyph('A', 0), glyph('B', 8), glyph('C', 16)];
  f.backgroundSurfaceDataId = withBackground ? 1 : 0;
  return f;
}

function renderer(withBackground = false): ACFontRenderer {
  const r = new ACFontRenderer(font(withBackground));
  r.initSpritesheet(32, 16, new Uint8Array(32 * 16 * 4));
  if (withBackground) r.initBackgroundSpritesheet(32, 16, new Uint8Array(32 * 16 * 4));
  created = [];
  return r;
}

beforeEach(() => { (globalThis as { document?: unknown }).document = { createElement: () => fakeCanvas() }; created = []; });
afterEach(() => { (globalThis as { document?: unknown }).document = saved; });

describe('ACFontRenderer tinted text', () => {
  it('makes exactly one canvas per label once the colour is cached', () => {
    const r = renderer();
    r.renderTextToCanvas('ABC', '#ff0000');
    expect(created).toHaveLength(2);           // the label + the red sheet (first use)
    created = [];
    for (let i = 0; i < 20; i++) r.renderTextToCanvas(i % 2 ? 'AB' : 'CAB', '#ff0000');
    expect(created).toHaveLength(20);          // labels only
  });

  it("tints the cached sheet the old way: copy, then 'source-in' fill with the colour", () => {
    const r = renderer();
    r.renderTextToCanvas('A', '#00ff00');
    const sheet = created[1];
    expect(sheet.ops.map((o) => o.op)).toEqual(['drawImage', 'gco', 'fillStyle', 'fillRect']);
    expect(sheet.ops[1].args).toEqual(['source-in']);
    expect(sheet.ops[2].args).toEqual(['#00ff00']);
    // The label draws each glyph straight from that sheet at its layout position.
    const label = created[0];
    const draws = label.ops.filter((o) => o.op === 'drawImage');
    expect(draws).toHaveLength(1);
    expect(draws[0].args[0]).toBe(sheet);
    expect(draws[0].args.slice(1, 5)).toEqual([0, 0, 6, 10]);
  });

  it('outlines draw pre-tinted halos (background sheet) or the 8 neighbour glyphs, no scratch canvas', () => {
    const withBg = renderer(true);
    withBg.renderTextToCanvas('AB', '#ffffff', 1, '#000000');
    expect(created).toHaveLength(3);           // label + black halo sheet + white glyph sheet
    created = [];
    withBg.renderTextToCanvas('AB', '#ffffff', 1, '#000000');
    expect(created).toHaveLength(1);
    expect(created[0].ops.filter((o) => o.op === 'drawImage')).toHaveLength(4);   // 2 halos + 2 glyphs

    const noBg = renderer(false);
    noBg.renderTextToCanvas('AB', '#ffffff', 1, '#000000');
    created = [];
    noBg.renderTextToCanvas('AB', '#ffffff', 1, '#000000');
    expect(created).toHaveLength(1);
    expect(created[0].ops.filter((o) => o.op === 'drawImage')).toHaveLength(8 * 2 + 2);
  });

  it('keeps a bounded number of tinted sheets', () => {
    const r = renderer();
    for (let i = 0; i < 200; i++) r.renderTextToCanvas('A', `rgb(${i},0,0)`);
    const sheets = created.filter((c) => c.width === 32);
    expect(sheets.length).toBe(200);           // each new colour tints once…
    created = [];
    r.renderTextToCanvas('A', 'rgb(199,0,0)');  // …a recent one is still cached
    expect(created).toHaveLength(1);
    r.renderTextToCanvas('A', 'rgb(0,0,0)');    // …the oldest was evicted
    expect(created).toHaveLength(3);
  });
});
