/**
 * VISUAL.map-coord-label — the map page's text draws as its DAT descs describe
 * it (layout 0x21000026), matching retail-ab world-panel:
 *  - the coordinate line 0x100001ef (base 0x2100003f:0x10000392: own font and
 *    ink, no p20 → UIElement_Text's near-edge default) is the large panel font,
 *    left-aligned — not the small centred default font;
 *  - the Date/Time block 0x100001eb (base 0x2100003f:0x10000391, p20 = p21 = 1)
 *    draws in that desc's font, which keeps the ':' and '.' glyphs the 0.9-scaled
 *    default font dropped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('map page text from its DAT descs (happy-dom + real LayoutRenderer)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: () => null, getTextureDataURLWithAlpha: () => null };
    ui = fx.ui;
    ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
  });
  afterAll(() => fx?.teardown());

  it('the coordinate line uses 0x100001ef\'s desc font, near-justified', () => {
    ui.setPlayerMapCell(1000, 1000, true);
    if (!ui.mapPanelVisible) ui.toggleMapPanel();
    const coords = document.querySelector('[data-map-coords]') as HTMLElement;
    expect(coords).toBeTruthy();
    const run = coords.querySelector('[data-ac-desc]') as HTMLElement;
    expect(run, 'coordinate text drawn from its desc').toBeTruthy();
    expect(run.dataset.acDesc!.toLowerCase()).toContain('100001ef');
    const style = ui.datTextStyleFor(run.dataset.acDesc);
    expect(run.dataset.acFont).toBe(style.font.toString(16));
    expect(coords.style.justifyContent).toBe('flex-start');
  });

  it('the Date / Time lines use 0x100001eb\'s desc font', () => {
    const runs = [...document.querySelectorAll('[data-ac-desc]')] as HTMLElement[];
    const dt = runs.filter((r) => r.dataset.acDesc!.toLowerCase().includes('100001eb'));
    expect(dt).toHaveLength(2);
  });
});
