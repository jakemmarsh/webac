/**
 * VISUAL.info-panel-text-justify + RECON.vitae-panel-dat — the Link Status
 * body (0x2100001d:0x10000169) and the Vitae body (0x21000020:0x100001c3) are
 * UIElement_Text elements: drawn with their own desc's font, colour and
 * justification at their DAT size, not left-justified rows in an invented
 * 6x8-padded div. Retail link-status.jpg centres every line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('info-panel body text from its DAT element (happy-dom + real LayoutRenderer)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: () => null, getTextureDataURLWithAlpha: () => null };
    ui = fx.ui;
    ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
    ui.loadFontRenderer = () => ({
      isReady: true, lineHeight: 16, outlinePadding: { x: 1, y: 1 },
      measureText: (t: string) => t.length * 10,
      renderTextToCanvas: () => document.createElement('canvas'),
      renderWrappedTextToCanvas: () => document.createElement('canvas'),
    });
  });
  afterAll(() => fx?.teardown());

  for (const [name, layout, id] of [['Link Status', 0x2100001d, 0x10000169], ['Vitae', 0x21000020, 0x100001c3]] as const) {
    it(`${name}: every line centred in the element (CalcJustification), one line per paragraph, no padding wrapper`, () => {
      const host = document.createElement('div');
      const cell = ui.fillDatTextElement(host, layout, id, 'Packet Loss: 0.00%\nServer: 42 ms');
      const desc = ui.datDescFor(`${layout.toString(16)}:${id.toString(16)}`);
      expect(desc.width).toBe(284);
      expect(cell.dataset.acLines).toBe('2');
      const lines = [...cell.querySelectorAll('[data-ac-line]')] as HTMLElement[];
      // 'Packet Loss: 0.00%' = 180 px → (284 >> 1) - (180 >> 1) = 52; 'Server: 42 ms' = 130 → 142 - 65 = 77.
      expect(lines.map((l) => Number.parseFloat(l.style.left))).toEqual([52, 77]);
      expect(host.querySelector('[style*="padding: 6px 8px"]')).toBeNull();
    });
  }
});
