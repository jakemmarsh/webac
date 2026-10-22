/**
 * BUG.hud-text-blank-font-sheet (2026-10-22, end of retail, local ACE, heavy
 * machine memory load): after login every LayoutRenderer label drew BLANK (the
 * vital numbers, the inventory title, the spell bar tabs, Cast) while chat drew
 * fine, with no error; a reload fixed it. Three gaps let that stand:
 *  - the HUD's UI font (0x40000000) was a second ACFontRenderer built in
 *    main.ts, never rebuilt (GameUI's streamed-miss reload covered only its own);
 *  - ACFontRenderer cached its glyph sheet and tinted sheets without checking
 *    them, so a canvas the browser could not back (memory pressure) stayed blank;
 *  - labels repaint only when their text or state changes.
 *
 * Driven here: ACFontRenderer's readback check, rebuild and heal; the
 * LayoutRenderer's fallback label and its repaint on heal / hand-over; GameUI
 * handing its one 0x40000000 renderer to the LayoutRenderer (and to chat) on
 * every (re)build; and the first_minute fields. A happy-dom canvas with a
 * fake 2D context stands in for the browser (pixels kept per canvas; a
 * "broken backing" switch makes draws into new canvases do nothing).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { ACFont } from '../packages/dat-parser/src/file-types/ACFont.ts';
import { ACFontRenderer } from '../packages/renderer/src/ui/ACFontRenderer.ts';
import { uiCanvasHealth } from '../packages/renderer/src/ui/ContextHealth.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow();
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

/** Draws into a canvas do nothing while set (a canvas the browser could not back). */
const backing = { broken: false };
const ctxOf = new WeakMap<object, FakeCtx>();
/** Canvases whose context reports lost. */
const lost = new WeakSet<object>();

class FakeCtx {
  px: Uint8ClampedArray | null = null;
  /** Glyph blits from a source that has ink there (a label that shows text). */
  inkedDraws = 0;
  globalCompositeOperation = 'source-over';
  fillStyle = '#000';
  constructor(readonly canvas: { width: number; height: number }) {}
  buf(): Uint8ClampedArray {
    const n = this.canvas.width * this.canvas.height * 4;
    if (!this.px || this.px.length !== n) this.px = new Uint8ClampedArray(n);
    return this.px;
  }
  createImageData(w: number, h: number) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
  putImageData(img: { data: Uint8ClampedArray }): void { if (!backing.broken) this.buf().set(img.data); }
  getImageData(x: number, y: number) {
    const i = (y * this.canvas.width + x) * 4;
    return { data: this.buf().slice(i, i + 4) };
  }
  drawImage(src: object, ...a: number[]): void {
    if (backing.broken) return;
    const s = ctxOf.get(src);
    if (!s) return;
    if (a.length === 2) { this.buf().set(s.buf()); return; }   // the tint's whole-sheet copy
    const [sx, sy, sw, sh] = a;
    const b = s.buf();
    for (let y = sy; y < sy + sh; y++) {
      for (let x = sx; x < sx + sw; x++) {
        if (b[(y * s.canvas.width + x) * 4 + 3]) { this.inkedDraws++; return; }
      }
    }
  }
  fillRect(): void { /* 'source-in' keeps each texel's alpha: nothing the readback sees changes */ }
  scale(): void {}
  isContextLost(): boolean { return lost.has(this.canvas); }
}

/** Glyphs A at x 0, B at x 8 (6 x 10) on a 32 x 16 sheet; the sheet has ink inside each glyph. */
function testFont(): ACFont {
  const f = new ACFont();
  f.maxCharHeight = 12;
  f.numHorizontalBorderPixels = 1;
  f.numVerticalBorderPixels = 1;
  const glyph = (ch: string, x: number) => ({ unicode: ch.charCodeAt(0), offsetX: x, offsetY: 0, width: 6, height: 10, horizontalOffsetBefore: 0, horizontalOffsetAfter: 0, verticalOffsetBefore: 0 });
  f.charDescs = [glyph('A', 0), glyph('B', 8)];
  f.numCharacters = 2;
  f.foregroundSurfaceDataId = 0x06005ee5;
  f.backgroundSurfaceDataId = 0;
  return f;
}
function sheetPixels(): Uint8Array {
  const d = new Uint8Array(32 * 16 * 4);
  for (const x0 of [0, 8]) for (let y = 2; y < 8; y++) for (let x = x0 + 1; x < x0 + 5; x++) { const i = (y * 32 + x) * 4; d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 255; }
  return d;
}

/** The serialized ACFont (ACFont.read's layout), for a fake portal DAT. */
function fontBytes(f: ACFont): ArrayBuffer {
  const buf = new ArrayBuffer(16 + f.charDescs.length * 11 + 20);
  const v = new DataView(buf);
  let o = 0;
  const u32 = (n: number) => { v.setUint32(o, n, true); o += 4; };
  u32(0x40000000); u32(f.maxCharHeight); u32(8); u32(f.charDescs.length);
  for (const c of f.charDescs) {
    v.setUint16(o, c.unicode, true); v.setUint16(o + 2, c.offsetX, true); v.setUint16(o + 4, c.offsetY, true);
    v.setUint8(o + 6, c.width); v.setUint8(o + 7, c.height); o += 11;
  }
  u32(f.numHorizontalBorderPixels); u32(f.numVerticalBorderPixels); u32(0); u32(f.foregroundSurfaceDataId); u32(f.backgroundSurfaceDataId);
  return buf;
}

const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
let savedGetContext: unknown;
const savedInterval = ACFontRenderer.rebuildIntervalMs;

beforeAll(() => {
  installDomGlobals(domWindow, DOM_GLOBALS, saved);
  const g = globalThis as Record<string, unknown>;
  if (typeof g.requestAnimationFrame !== 'function') { g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {}; }
  const proto = domWindow.HTMLCanvasElement.prototype;
  savedGetContext = proto.getContext;
  proto.getContext = function (this: object, id: string) {
    if (id !== '2d') return null;
    let c = ctxOf.get(this);
    if (!c) { c = new FakeCtx(this as never); ctxOf.set(this, c); }
    return c;
  };
});
afterAll(() => {
  domWindow.HTMLCanvasElement.prototype.getContext = savedGetContext;
  restoreDomGlobals(DOM_GLOBALS, saved);
});
beforeEach(() => { backing.broken = false; ACFontRenderer.rebuildIntervalMs = 0; });
afterEach(() => { ACFontRenderer.rebuildIntervalMs = savedInterval; });

const bad = (): number => uiCanvasHealth().fontSheetBad;
const inked = (c: HTMLCanvasElement): number => ctxOf.get(c)?.inkedDraws ?? 0;

describe('ACFontRenderer — a glyph sheet that reads back blank is not kept', () => {
  it('blank at init: not ready, counted; once canvases are backed again the next use rebuilds it and heals', () => {
    const r = new ACFontRenderer(testFont());
    const heals: number[] = [];
    r.onHeal(() => heals.push(1));
    const before = bad();
    backing.broken = true;
    r.initSpritesheet(32, 16, sheetPixels());
    expect(r.isReady).toBe(false);               // the retry is blank too
    expect(r.needsRebuild).toBe(true);
    expect(bad()).toBeGreaterThanOrEqual(before + 2);
    expect(inked(r.renderTextToCanvas('AB'))).toBe(0);
    backing.broken = false;
    expect(r.isReady).toBe(true);                // rebuilt from the kept pixels
    expect(r.needsRebuild).toBe(false);
    expect(heals).toHaveLength(1);
    expect(inked(r.renderTextToCanvas('AB'))).toBe(2);
    expect(inked(r.renderTextToCanvas('AB', '#ff0000'))).toBe(2);
  });

  it('a caller that draws without asking isReady (DatEditField) rebuilds the sheet too', () => {
    const r = new ACFontRenderer(testFont());
    const heals: number[] = [];
    r.onHeal(() => heals.push(1));
    backing.broken = true;
    r.initSpritesheet(32, 16, sheetPixels());
    backing.broken = false;
    expect(inked(r.renderTextToCanvas('AB', '#ffffff'))).toBe(2);
    expect(heals).toHaveLength(1);
    expect(inked(r.renderWrappedTextToCanvas('A B', 40, '#ffffff'))).toBe(2);
  });

  it('rebuilds at most once per rebuildIntervalMs; a later good initSpritesheet makes it ready at once', () => {
    ACFontRenderer.rebuildIntervalMs = 60_000;
    const r = new ACFontRenderer(testFont());
    backing.broken = true;
    r.initSpritesheet(32, 16, sheetPixels());
    expect(r.isReady).toBe(false);
    const after = bad();
    backing.broken = false;
    expect(r.isReady).toBe(false);               // throttled: no new canvas this soon
    expect(bad()).toBe(after);
    r.initSpritesheet(32, 16, sheetPixels());
    expect(r.isReady).toBe(true);
    expect(r.needsRebuild).toBe(false);
  });

  it('a blank tinted sheet is used once but not cached (counted); the next use tints again and keeps a good one', () => {
    const r = new ACFontRenderer(testFont());
    r.initSpritesheet(32, 16, sheetPixels());
    expect(r.isReady).toBe(true);
    const before = bad();
    backing.broken = true;
    expect(inked(r.renderTextToCanvas('A', '#00ff00'))).toBe(0);
    expect(bad()).toBe(before + 1);
    expect(r.isReady).toBe(true);                // the sheet itself still has its ink
    backing.broken = false;
    expect(inked(r.renderTextToCanvas('A', '#00ff00'))).toBe(1);
    // Cached now: a third label makes only its own canvas.
    const created: string[] = [];
    const orig = document.createElement.bind(document);
    (document as { createElement: unknown }).createElement = (t: string) => { created.push(t); return orig(t); };
    try {
      r.renderTextToCanvas('B', '#00ff00');
    } finally {
      (document as { createElement: unknown }).createElement = orig;
    }
    expect(created).toEqual(['canvas']);
  });

  it('a tint that reads blank because the sheet itself went blank drops the sheet; the next use rebuilds it', () => {
    const r = new ACFontRenderer(testFont());
    const made: HTMLCanvasElement[] = [];
    const orig = document.createElement.bind(document);
    (document as { createElement: unknown }).createElement = (t: string) => { const el = orig(t); if (t === 'canvas') made.push(el as HTMLCanvasElement); return el; };
    try {
      r.initSpritesheet(32, 16, sheetPixels());
    } finally {
      (document as { createElement: unknown }).createElement = orig;
    }
    const sheet = made[0];
    ctxOf.get(sheet)!.buf().fill(0);             // its backing went away
    r.renderTextToCanvas('A', '#123456');
    expect(r.needsRebuild).toBe(true);
    expect(r.isReady).toBe(true);                // rebuilt here
    expect(r.needsRebuild).toBe(false);
    expect(inked(r.renderTextToCanvas('A', '#123456'))).toBe(1);
  });

  it('a sheet whose 2D context reports lost is not kept, and a contextlost event drops the cached sheets', () => {
    const r = new ACFontRenderer(testFont());
    const made: HTMLCanvasElement[] = [];
    const orig = document.createElement.bind(document);
    (document as { createElement: unknown }).createElement = (t: string) => { const el = orig(t); if (t === 'canvas') made.push(el as HTMLCanvasElement); return el; };
    try {
      r.initSpritesheet(32, 16, sheetPixels());
      expect(r.isReady).toBe(true);
      made[0].dispatchEvent(new domWindow.Event('contextlost'));
      expect(r.needsRebuild).toBe(true);
      expect(r.isReady).toBe(true);              // rebuilt on this use
      expect(made).toHaveLength(2);
      lost.add(made[1]);
      made[1].dispatchEvent(new domWindow.Event('contextlost'));
      ACFontRenderer.rebuildIntervalMs = 60_000;
      // 'contextrestored' rebuilds at once, throttle or not.
      made[1].dispatchEvent(new domWindow.Event('contextrestored'));
      expect(r.needsRebuild).toBe(false);
      expect(r.isReady).toBe(true);
    } finally {
      (document as { createElement: unknown }).createElement = orig;
    }
  });
});

describe('LayoutRenderer — labels drawn while the font is missing or blank are repainted', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let LayoutRenderer: any;
  beforeAll(async () => { ({ LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.ts')); });

  const host = (): HTMLElement => { const el = document.createElement('div'); document.body.appendChild(el); return el; };
  const drawn = (el: HTMLElement): Element | null => el.querySelector('.layout-text > *');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paint = (lr: any, el: HTMLElement, text: string): void => lr['renderTextInto'](el, text, '#ffffff', null);

  it('a label painted while the sheet is blank takes the fallback; the heal repaints it with glyphs', () => {
    const font = new ACFontRenderer(testFont());
    backing.broken = true;
    font.initSpritesheet(32, 16, sheetPixels());
    const lr = new LayoutRenderer({} as never, {} as never, font);
    const health = host();
    const title = host();
    paint(lr, health, 'AB');
    paint(lr, title, 'BA');
    expect(drawn(health)?.tagName).toBe('SPAN');
    expect(drawn(title)?.tagName).toBe('SPAN');
    backing.broken = false;
    expect(font.isReady).toBe(true);             // any later use rebuilds → heal → repaintAllLabels
    for (const el of [health, title]) {
      const c = drawn(el) as HTMLCanvasElement;
      expect(c.tagName).toBe('CANVAS');
      expect(inked(c)).toBe(2);
      expect(el.querySelectorAll('.layout-text')).toHaveLength(1);
    }
  });

  it('with nothing else painting, the fallback label schedules the retry that heals it', async () => {
    const font = new ACFontRenderer(testFont());
    backing.broken = true;
    font.initSpritesheet(32, 16, sheetPixels());
    const lr = new LayoutRenderer({} as never, {} as never, font);
    const el = host();
    paint(lr, el, 'A');
    expect(drawn(el)?.tagName).toBe('SPAN');
    backing.broken = false;
    await new Promise((r) => setTimeout(r, 150));
    expect(drawn(el)?.tagName).toBe('CANVAS');
    expect(inked(drawn(el) as HTMLCanvasElement)).toBe(1);
  });

  it('labels painted before the UI font is handed over are repainted by setFontRenderer, latest text and state kept', () => {
    const lr = new LayoutRenderer({} as never, {} as never, null);
    const el = host();
    paint(lr, el, 'A');
    paint(lr, el, 'AB');
    expect(drawn(el)?.tagName).toBe('SPAN');
    const font = new ACFontRenderer(testFont());
    font.initSpritesheet(32, 16, sheetPixels());
    expect(lr.repaintAllLabels()).toBeGreaterThanOrEqual(1);
    lr.setFontRenderer(font);
    expect(lr.uiFontRenderer).toBe(font);
    expect(inked(drawn(el) as HTMLCanvasElement)).toBe(2);   // 'AB', not 'A'
  });
});

describe('GameUI — one 0x40000000 renderer for the HUD and chat', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lr: any;
  let iconReads = 0;

  beforeAll(async () => {
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.ts');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.ts');
    const font = testFont();
    const portalDb = { getFileData: (id: number) => (id === 0x40000000 ? fontBytes(font) : null) };
    const textureManager = {
      getIconRGBA: (id: number) => { if (id !== font.foregroundSurfaceDataId) return null; iconReads++; return { width: 32, height: 16, data: sheetPixels() }; },
      getIconDataURL: () => null,
    };
    lr = new LayoutRenderer({} as never, {} as never);
    const container = document.createElement('div');
    document.body.appendChild(container);
    ui = new GameUI(container, {}, portalDb as never, textureManager as never, undefined, undefined, null, lr);
  });

  it('the LayoutRenderer draws with GameUI\'s own UI font instance (no second copy)', () => {
    expect(iconReads).toBe(1);                   // one glyph sheet decoded for the whole UI
    expect(ui.acFont).not.toBeNull();
    expect(lr.uiFontRenderer).toBe(ui.acFont);
    expect(ui.acFont.isReady).toBe(true);
    expect(ui['chatRenderer']()).toBe(ui.acFont);
  });

  it('a rebuild of the UI font (the streamed-miss reload) reaches the HUD labels and chat', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    lr['renderTextInto'](el, 'BA', '#ffffff', null);
    const first = drawnCanvas(el);
    const old = ui.acFont;
    ui['loadUiFontAsset']();
    expect(ui.acFont).not.toBe(old);
    expect(lr.uiFontRenderer).toBe(ui.acFont);
    expect(ui['chatRenderer']()).toBe(ui.acFont);
    expect(drawnCanvas(el)).not.toBe(first);     // repainted with the new instance
    expect(inked(drawnCanvas(el))).toBe(2);
  });

  const drawnCanvas = (el: HTMLElement): HTMLCanvasElement => el.querySelector('.layout-text > canvas') as HTMLCanvasElement;
});

describe('first_minute reports blank font sheets and lost 2D contexts', () => {
  async function firstMinute(src: { uiCanvasHealth?: () => { fontSheetBad: number; canvas2dLost: number } | null }) {
    const { WorldReporter } = await import('../packages/renderer/src/telemetry/WorldReporter.ts');
    const events: Array<Record<string, unknown>> = [];
    const clock = { t: 0 };
    const r = new WorldReporter({
      endpoint: 'http://x/client-preworld', build: 'b', trace: 'feedc0de12345678', era: () => 'eor', server: () => null,
      now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b)); },
    });
    r.setSources({ screen: () => 'world', ...src });
    r.enteredWorld();
    for (let i = 0; i < 70; i++) { clock.t += 1000; r.frame(clock.t, true, 5); r.tick(); }
    return events.find((e) => e.outcome === 'first_minute')!;
  }

  it('WorldReporter sends the page totals (null without a source); the bridge keeps them, bounded', async () => {
    const { sanitizeClientWorld } = await import('../services/ws-tcp-bridge/src/clientWorld.ts');
    const ev = await firstMinute({ uiCanvasHealth: () => ({ fontSheetBad: 3, canvas2dLost: 1 }) });
    expect(ev).toMatchObject({ fontSheetBad: 3, canvas2dLost: 1 });
    expect(sanitizeClientWorld(ev)).toMatchObject({ fontSheetBad: 3, canvas2dLost: 1 });
    expect(sanitizeClientWorld({ ...ev, fontSheetBad: -2, canvas2dLost: 'x' })).toMatchObject({ fontSheetBad: null, canvas2dLost: null });
    expect(await firstMinute({})).toMatchObject({ fontSheetBad: null, canvas2dLost: null });
  });

  it('uiCanvasHealth reads the font-sheet count and __acHealth\'s 2D losses', async () => {
    const { installContextHealth, noteFontSheetBad } = await import('../packages/renderer/src/ui/ContextHealth.ts');
    const listeners: string[] = [];
    const win = { addEventListener: (t: string) => { listeners.push(t); } } as unknown as Window & { __acHealth?: import('../packages/renderer/src/ui/ContextHealth.ts').ContextHealth };
    const savedWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = win;
    try {
      const h = installContextHealth(win)!;
      const before = uiCanvasHealth().fontSheetBad;
      noteFontSheetBad();
      h.canvas2dLost = 2;
      expect(uiCanvasHealth()).toEqual({ fontSheetBad: before + 1, canvas2dLost: 2 });
      expect(win.__acHealth!.fontSheetBad).toBe(before + 1);
    } finally {
      (globalThis as { window?: unknown }).window = savedWindow;
    }
  });
});
