/**
 * VISUAL.screen-edge-bevel — the 3D view 0x2100000f:0x10000037 is ringed by
 * eight UIElement_Resizebar children (0x100006ca..0x100006d1, textures
 * 0x06006129..0x0600612d) placed 1 px outside it: retail's gold window bevel.
 * Real LayoutRenderer over the local DAT; signed element x/y (the parser read
 * -1 as 4294967295).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('the 3D view frame from 0x2100000f (happy-dom + real LayoutRenderer)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let W = 1600, H = 900;
  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    ui = fx.ui;
    ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
    ui.hudLogicalWidth = () => W;
    ui.hudLogicalHeight = () => H;
  });
  afterAll(() => fx?.teardown());

  const el = (id: number): HTMLElement => document.querySelector(`.ac-viewport-frame [data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
  const px = (v: string): number => Number.parseFloat(v);

  it('the parser keeps the bars\' -1 offsets signed', async () => {
    const lr = ui.layoutRenderer;
    const view = [...lr.getResolvedLayout(0x2100000f).elements.values()].find((e: { elementId: number }) => e.elementId === 0x10000037);
    const tl = [...view.children.values()].find((c: { elementId: number }) => c.elementId === 0x100006ca);
    expect([tl.x, tl.y]).toEqual([-1, -1]);
  });

  it('renders only the eight bars, behind the HUD, taking no input; corners at (-1,-1), the far bars on the window edges', () => {
    ui.renderViewportFrame();
    const host = document.querySelector('.ac-viewport-frame') as HTMLElement;
    expect(host).toBeTruthy();
    expect(host.style.pointerEvents).toBe('none');
    for (const id of [0x100006ca, 0x100006cb, 0x100006cc, 0x100006cd, 0x100006ce, 0x100006cf, 0x100006d0, 0x100006d1]) expect(el(id), id.toString(16)).toBeTruthy();
    expect(el(0x10000598)).toBeNull(); // the barber smartbox slot is not instantiated
    expect([px(el(0x100006ca).style.left), px(el(0x100006ca).style.top)]).toEqual([-1, -1]);
    // The right bar follows the right edge, the bottom bar the bottom edge.
    expect(px(el(0x100006d1).style.left)).toBe(W - 4);
    expect(px(el(0x100006cf).style.top)).toBe(H - 4);
    expect(px(el(0x100006cb).style.width)).toBe(W - 8);
  });

  it('a window resize reflows the bars to the new size', () => {
    W = 1280; H = 720;
    ui.resizeViewportFrame();
    expect(px(el(0x100006d1).style.left)).toBe(W - 4);
    expect(px(el(0x100006cf).style.top)).toBe(H - 4);
  });
});
