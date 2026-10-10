/**
 * VISUAL.charselect-enter-disc-tint — the char-select buttons draw their art
 * once, and their labels sit where UIElement_Text::DrawSelf puts them.
 *
 * Ground truth:
 *  - The ENTER face 0x06004cb2 (0x21000040:0x100002d9 state 1, drawMode 3)
 *    is a 211x211 A8R8G8B8 disc whose fill is alpha 107 over the 0x06007576
 *    background. One source-over draw gives (30,38,75) under the label, the
 *    retail Wine/Metal frame (verification/retail-ab/char-select/retail.png)
 *    samples (31,38,75); two draws give the (26,25,57) we drew while the
 *    layout node 0x100003a2 painted its Normal media under GameUI's overlay
 *    button. The plates 0x100003a0 / 0x1000039e / 0x1000039f / 0x100003a3 /
 *    0x100003a4 doubled the same way (tripled at the RESTORE/DELETE slot).
 *  - UIElement_Text::CalcJustification @ 00467260, centred (1):
 *    margin + (avail >> 1) - (size >> 1) on each axis. CSS flex centring
 *    rounds an odd remainder up, which put the ENTER and Create Character
 *    glyphs 1 px right of and below retail's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { calcJustification } from '../packages/renderer/src/ui/UIElementTextLayout.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
const BUTTON_IDS = [0x1000039e, 0x1000039f, 0x100003a0, 0x100003a2, 0x100003a3, 0x100003a4];

describe('CalcJustification — the centred case truncates each half', () => {
  it('ENTER in the 211 px disc: (211 >> 1) - (w >> 1), not round((211 - w) / 2)', () => {
    expect(calcJustification(110, 211, 110, 1)).toBe(50);
    expect(calcJustification(111, 211, 111, 1)).toBe(50);
    expect(Math.round((211 - 110) / 2)).toBe(51);
  });
});

describe.skipIf(!hasDats)('char select (happy-dom + real LayoutRenderer)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layoutRenderer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let realLoadFont: any;

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
    realLoadFont = fx.ui.loadFontRenderer;
  });
  afterAll(() => fx?.teardown());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function showSelect(font?: { measure: (t: string) => number; lineHeight: number }): { ui: any; container: HTMLElement } {
    const { ui, container } = fx;
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.layoutRenderer = layoutRenderer;
    ui.loadFontRenderer = realLoadFont;
    if (font) {
      ui.loadFontRenderer = () => ({
        isReady: true, lineHeight: font.lineHeight, outlinePadding: { x: 1, y: 1 },
        measureText: font.measure,
        renderTextToCanvas: () => document.createElement('canvas'),
        renderWrappedTextToCanvas: () => document.createElement('canvas'),
      });
    }
    ui.showCharacterSelect([{ id: 1, name: 'Perf Tester' }]);
    return { ui, container };
  }

  it('the layout nodes behind the overlay buttons carry no media; the buttons draw it once', () => {
    const { container } = showSelect();
    for (const id of BUTTON_IDS) {
      const nodes = Array.from(container.querySelectorAll(`[data-element-id="0x${id.toString(16)}"]`)) as HTMLElement[];
      expect(nodes.length, id.toString(16)).toBeGreaterThan(0);
      for (const n of nodes) expect(n.style.backgroundImage, id.toString(16)).toBe('');
    }
    // With a character selected, the ENTER button is the only node painting the disc.
    const discs = (Array.from(container.querySelectorAll('*')) as HTMLElement[])
      .filter((el) => /6004cb[1-5]/.test(el.style.backgroundImage));
    expect(discs.length).toBe(1);
    expect(discs[0].tagName).toBe('BUTTON');
    expect(discs[0].style.backgroundImage).toContain('6004cb2');
    // Elements the caller does not overlay keep their media (the world box frame).
    const world = container.querySelector('[data-element-id="0x1000039b"]') as HTMLElement;
    expect(world.style.backgroundImage).toContain('6004d64');
  });

  it('labels are placed by CalcJustification with the DAT font metrics, not flex-centred', () => {
    // Even remainders are the case flex centring got wrong: (211 - 50) / 2 = 80.5.
    const { container } = showSelect({ measure: (t) => t.length * 10, lineHeight: 26 });
    const at = (id: number): string[] => {
      const el = container.querySelector(`button > [data-ac-desc="21000004:${id.toString(16)}"]`) as HTMLElement;
      expect(el.style.position).toBe('absolute');
      return [el.style.left, el.style.top];
    };
    // 'ENTER' = 50 x 26 in the 211x211 disc (no p35-p38 margins): 105 - 25, 105 - 13.
    expect(at(0x100003a2)).toEqual(['80px', '92px']);
    // 'Create Character' = 160 in the 254x113 plate: 127 - 80, 56 - 13.
    expect(at(0x100003a0)).toEqual(['47px', '43px']);
    // 'EXIT' = 40 and 'CREDITS' = 70 in the 170x99 plates: 85 - 20 / 85 - 35, 49 - 13.
    expect(at(0x100003a4)).toEqual(['65px', '36px']);
    expect(at(0x100003a3)).toEqual(['50px', '36px']);
    // 'DELETE' = 60 on the RESTORE/DELETE slot.
    expect(at(0x1000039f)).toEqual(['55px', '36px']);
  });

  it('without the DAT font the labels stay flex-centred spans', () => {
    const { ui, container } = showSelect();
    expect(ui.loadFontRenderer(0x40000012)?.isReady ?? false).toBe(false);
    const enter = container.querySelector(`button > [data-ac-desc="21000004:100003a2"]`) as HTMLElement;
    expect(enter.textContent).toBe('ENTER');
    expect(enter.style.position).toBe('');
  });
});
