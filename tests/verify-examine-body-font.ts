/**
 * VISUAL.examine-body-font-size — the item appraisal runs draw in the body
 * element 0x1000013c's own font (p26 through its base 0x2100003f:0x10000371)
 * and its p27 colour table (entries 0 / 1 / 2 = AppendTextWithFont's white /
 * green / red), not the default UI font: retail-ab examine-chest's body text
 * is the title-size font.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { EXAMINATION_WINDOW } from '../packages/renderer/src/ui/examine/ExaminationWindow.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('examine item body font (happy-dom + real LayoutRenderer)', () => {
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

  it('each line is the body desc\'s font, coloured by its p27 entry', () => {
    ui.showExaminationWindow({
      guid: 0x80000001, title: 'Chest', page: 'item',
      item: { value: '', burden: '', runs: [], text: '', paragraphs: [], lines: [
        { text: 'Value: 200', color: 0 }, { text: 'Bonus', color: 1 }, { text: 'Penalty', color: 2 },
      ] },
      inscription: { visible: false, text: '', signature: '' },
    });
    const body = document.querySelector('[data-examine-body]') as HTMLElement;
    const runs = [...body.querySelectorAll('[data-ac-desc]')] as HTMLElement[];
    expect(runs).toHaveLength(3);
    const ref = runs[0].dataset.acDesc!;
    expect(ref.toLowerCase()).toContain(EXAMINATION_WINDOW.item.body.toString(16));
    const style = ui.datTextStyleFor(ref);
    expect(runs[0].dataset.acFont).toBe(style.font.toString(16));
    // the body font is not the default UI font 0x40000000
    expect(style.font).not.toBe(0x40000000);
    expect(runs.map((r) => r.dataset.acColorIndex)).toEqual(['0', '1', '2']);
  });
});
