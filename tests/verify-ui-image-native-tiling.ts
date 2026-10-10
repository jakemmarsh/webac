/**
 * Retail UI images are never scaled (behavioural — drives the real
 * LayoutRenderer.applyMediaToElement in happy-dom).
 *
 * UIRegion::DrawSelf @ 0069f1a0 → Graphic::Draw @ 00693b20: a region's image
 * is PutImage()d at native size when the box fits (cropped), and otherwise
 * tiled from the region origin (+ m_ptTilingOffset). MediaDescImage.drawMode
 * only selects the blit mode (UIRegion::SetImageByDID @ 0069f960). Found
 * live on the chess board: layout 0x2100001e list box 0x10000174 is 256×256,
 * and its media 0x06001fd5 is a 64×64 two-by-two checker. Tiled, that makes
 * the 8×8 board; stretched, it drew four giant squares.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const win: any = await loadDomWindow({ innerWidth: 800, innerHeight: 600 });
const GLOBALS = ['window', 'document', 'HTMLElement'] as const;

describe('UI image media blit at native size and tile (Graphic::Draw)', () => {
  const saved: Partial<Record<(typeof GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lr: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MediaType: any;
  beforeAll(async () => {
    installDomGlobals(win, GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    MediaType = (await import('@ac/dat-parser/file-types/LayoutDesc.js')).MediaType;
    const tex = { getTextureDataURL: (id: number) => `fake://${id.toString(16)}`, getTextureDataURLWithAlpha: () => '' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lr = new mod.LayoutRenderer({ getFileData: () => null } as any, tex as any, null);
  });
  afterAll(() => restoreDomGlobals(GLOBALS, saved));

  it('an image medium is drawn at its own size, repeating from the element origin', () => {
    const el = win.document.createElement('div');
    el.style.width = '256px';
    el.style.height = '256px';
    lr.applyMediaToElement(el, [{ type: MediaType.Image, file: 0x06001fd5, drawMode: 1 }], 1);
    expect(el.style.backgroundImage).toContain('6001fd5');
    expect(el.style.backgroundSize).toBe('auto');
    expect(el.style.backgroundRepeat).toBe('repeat');
    expect(el.style.backgroundPosition).toMatch(/^0(px)? 0(px)?$/);
  });

  it('an animation medium’s first frame follows the same blit', () => {
    const el = win.document.createElement('div');
    lr.applyMediaToElement(el, [{ type: MediaType.Animation, frames: [0x06004d09, 0x06004d0a] }], 1);
    expect(el.style.backgroundImage).toContain('6004d09');
    expect(el.style.backgroundSize).toBe('auto');
    expect(el.style.backgroundRepeat).toBe('repeat');
  });
});
