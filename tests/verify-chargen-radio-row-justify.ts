/**
 * RECON.dom-chrome-sweep.b.a.a — the chargen radio rows (template
 * 0x2100004c:0x100002e8: the Profession page's Custom … Swashbuckler rows and
 * the Appearance page's Face / Clothes rows) place their label where
 * UIElement_Text::DrawSelf @ 00467aa0 puts it.
 *
 * Ground truth: the rows are 54 px tall, p21 = 1 (centred), p37 = 7, p38 = 0,
 * p35 = 60, p20 = 2. DrawSelf justifies line 0 by
 * CalcJustification(max(maxCharHeight, scrollable height), vertical) @
 * 00467260, and the scrollable height (+0x604, ResizeScrollableArea) is the
 * line height PLUS the margins — so the centred block is lineHeight + 7:
 * 7 + (47 >> 1) - ((lh + 7) >> 1). CSS flex centring under a 7 px padding
 * centred just the line, 7 + (47 - lh) / 2, about 4 px lower: the retail A/B
 * (verification/retail-ab/chargen-profession) had Bow Hunter at y 221-241
 * against our 225-244.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
const LINE_HEIGHT = 25;
// 7 + (47 >> 1) - (32 >> 1) = 14; flex centring gave 7 + 11 = 18.
const RETAIL_TOP = `${7 + (47 >> 1) - ((LINE_HEIGHT + 7) >> 1)}px`;

describe.skipIf(!hasDats)('chargen radio rows (happy-dom + real LayoutRenderer, stub DAT font)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layoutRenderer: any;

  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000002)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    layoutRenderer = new LayoutRenderer(local, tex as never, null);
  });
  afterAll(() => fx?.teardown());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function showCreate(step: number): any {
    const { ui } = fx;
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.layoutRenderer = layoutRenderer;
    ui.loadFontRenderer = () => ({
      isReady: true, lineHeight: LINE_HEIGHT, outlinePadding: { x: 1, y: 1 },
      measureText: (t: string) => t.length * 10,
      renderTextToCanvas: () => document.createElement('canvas'),
      renderWrappedTextToCanvas: () => document.createElement('canvas'),
      renderWrappedRunsToCanvas: () => document.createElement('canvas'),
    });
    ui.showCharacterCreate();
    ui.wizard.setHeritage(1);
    ui.wizard.setProgressState(step);
    ui.renderCharacterCreate();
    return ui;
  }
  const root = (): HTMLElement => fx.container as HTMLElement;
  const labelOf = (btn: Element): HTMLElement => btn.querySelector(':scope > [data-ac-desc]') as HTMLElement;

  it('Profession rows: every label at CalcJustification of the lineHeight + p37 block, 60 px in', () => {
    showCreate(1 /* Profession */);
    const rows = (Array.from(root().querySelectorAll('.template-btn')) as HTMLElement[]);
    expect(rows.length).toBe(7);
    for (const row of rows) {
      const label = labelOf(row);
      expect(label.style.position, (row as HTMLElement).dataset.label).toBe('absolute');
      expect([label.style.left, label.style.top], (row as HTMLElement).dataset.label).toEqual(['60px', RETAIL_TOP]);
    }
  });

  it('a row re-lit by UpdateProfession keeps the justified position', () => {
    const ui = showCreate(1 /* Profession */);
    const before = ui.wizard.templateIndex;
    const other = (Array.from(root().querySelectorAll('.template-btn')) as HTMLElement[])
      .map((b) => parseInt((b as HTMLElement).dataset.template || '0'))
      .find((t) => t !== before)!;
    ui.wizard.setTemplate(other);
    ui.refreshProfessionSelection();
    for (const t of [before, other]) {
      const row = root().querySelector(`.template-btn[data-template="${t}"]`)!;
      const label = labelOf(row);
      expect([label.style.position, label.style.left, label.style.top]).toEqual(['absolute', '60px', RETAIL_TOP]);
    }
  });

  it('Appearance Face / Clothes rows (same template) sit at the same offset', () => {
    showCreate(3 /* Appearance */);
    const rows = (Array.from(root().querySelectorAll('.appear-mode-btn')) as HTMLElement[]);
    expect(rows.length).toBe(2);
    for (const row of rows) expect([labelOf(row).style.left, labelOf(row).style.top]).toEqual(['60px', RETAIL_TOP]);
  });
});
