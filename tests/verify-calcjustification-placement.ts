/**
 * VISUAL.examine-misc-list-row-sliver.a — LayoutRenderer places a DAT label
 * at UIElement_Text::CalcJustification @ 00467260's integer offsets
 * (margin + (avail >> 1) - (size >> 1) when centred), not at the half pixel
 * CSS flex centring rounded down. Real LayoutRenderer over the local DAT,
 * a fake font whose canvases have odd sizes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { loadDomWindow, installDomGlobals } from './_harness/dom.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

describe.skipIf(!hasDats)('CalcJustification placement of DAT labels', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lr: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const, {});
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000002)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: () => null, getTextureDataURLWithAlpha: () => null };
    // Every glyph 9 px wide, the line 17 px tall: odd sizes, so flex centring would land on half pixels.
    const font = {
      isReady: true, lineHeight: 17, outlinePadding: { x: 1, y: 1 },
      measureText: (t: string) => t.length * 9,
      renderTextToCanvas: (t: string, _c?: string, _s?: number, outline?: string) => {
        const c = document.createElement('canvas');
        c.width = t.length * 9 + (outline ? 2 : 0); c.height = 17 + (outline ? 2 : 0);
        return c;
      },
      renderWrappedTextToCanvas: () => document.createElement('canvas'),
    };
    lr = new LayoutRenderer(local, tex as never, font as never);
  });

  it('the Yes button label (80x32, "Yes" 27x17): x = (80 >> 1) - (27 >> 1) = 27 less the button margins\' share, y = 16 - 8 = 8 — integers', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const h = lr.render(0x2100003c, host, { subtreePath: [0x15, 0x3d] });
    const yes = h.elements.get(0x17) as HTMLElement;
    const canvas = yes.querySelector('.layout-text canvas') as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    const [x, y] = (canvas.dataset.acJustify ?? '').split(',').map(Number);
    expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    expect(y).toBe(8);
    // Centred in the 80 px button whatever its symmetric margins: 40 - 13 = 27.
    expect(x).toBe(27);
    expect(canvas.style.position).toBe('absolute');
  });
});
