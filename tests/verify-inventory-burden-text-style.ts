/**
 * VISUAL.inventory-burden-label-dim — the inventory strip's "Burden" label
 * and load % draw in their DAT text desc's style at every load (behavioural —
 * drives the real GameUI renderInventoryPanel / setInventoryData in
 * happy-dom and reads the rendered text).
 *
 * Retail ground truth:
 *  - gmBackpackUI::SetLoadLevel @ 004a6ea0: text = floor(clamp(load/3,0,1)
 *    * 300) + '%' and the meter fill — it only SetText()s m_burdenText
 *    (0x100001d8, found in gmBackpackUI::PostInit @ 004a6f70). No colour is
 *    ever set, so the text keeps its desc's p27 at any load. (FAITHFUL.479's
 *    dim / warn-at-1.0 / error-at-2.0 text ramp — replaced here — had no
 *    retail analog; the ≥1.0 load cue is the strip's burden ICON,
 *    gmUIElement_BurdenIndicator, CORE.5.b.)
 *  - 0x21000023 els 0x100001d7 ("Burden", p23 string 0x074464be) and
 *    0x100001d8 inherit the 0x2100003f:0x10000376 text base: font
 *    0x40000000, p27 [0xffffffff], p20 3 (far — CalcJustification @
 *    00467260), p21 1; only the ghosted state 0xd carries 0xff4c4c4c.
 *  - Retail capture verification/retail-client/ab/retail-inventory-vendor.png:
 *    "Burden" / "40%" bright white, right edges aligned (ours drew both in
 *    the dim AC_COLORS.textDim, centred).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const BURDEN_STRIP = 0x100001ce;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubPanelRenderer(win: any, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    renderPanel: (_layoutId: number, parent: HTMLElement) => {
      const root = win.document.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      for (const id of [0x100001cd, BURDEN_STRIP, 0x100001cf, 0x100001d0]) {
        const el = win.document.createElement('div');
        root.appendChild(el);
        elements.set(id, el);
      }
      return { root, elements, setText: () => {}, close: () => { root.remove(); } };
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openAt(ui: any, load: number): { label: HTMLElement; pct: HTMLElement; labelBox: HTMLElement; pctBox: HTMLElement } {
  ui.setInventoryData([], [], Math.round(load * 10000), 10000);
  const strip = ui.inventoryPanelHandle.elements.get(BURDEN_STRIP) as HTMLElement;
  const texts = [...strip.querySelectorAll('[data-ac-desc]')] as HTMLElement[];
  const label = texts.find((t) => t.dataset.acDesc === '21000023:100001d7');
  const pct = texts.find((t) => t.dataset.acDesc === '21000023:100001d8');
  if (!label || !pct) throw new Error('burden label / % text not found');
  return { label, pct, labelBox: label.parentElement as HTMLElement, pctBox: pct.parentElement as HTMLElement };
}

describe('VISUAL.inventory-burden-label-dim — no DATs: the text element default (white) at every load', () => {
  let H: GameUIFixture;
  beforeAll(async () => {
    H = await mountGameUI({ size: { innerWidth: 1600, innerHeight: 900 } });
    H.ui.layoutRenderer = stubPanelRenderer(H.win);
    H.ui.setSidePackGuids([0x50000001]);
    if (!H.ui.inventoryVisible) H.ui.toggleInventory();
  });
  afterAll(() => H.teardown());

  it('SetLoadLevel only sets text: the % keeps one colour across the old dim / warn / error loads', () => {
    for (const [load, text] of [[0.4, '40%'], [0.99, '99%'], [1.0, '100%'], [2.0, '200%'], [4.5, '300%']] as const) {
      const { label, pct } = openAt(H.ui, load);
      expect(pct.textContent).toBe(text);
      expect(pct.style.color).toBe('#ffffff');
      expect(label.textContent).toBe('Burden');
      expect(label.style.color).toBe('#ffffff');
      // Never the dim tertiary tone the label used to draw in.
      expect(pct.style.color).not.toBe(H.mod.AC_COLORS.textDim);
    }
  });

  it('setBurden re-fills the % in place in the same colour', () => {
    openAt(H.ui, 0.3);
    H.ui.setBurden(25000, 10000); // load 2.5 — formerly the "error" red
    const pct = H.ui.inventoryBurdenReadout.text.querySelector('[data-ac-desc]') as HTMLElement;
    expect(pct.textContent).toBe('250%');
    expect(pct.style.color).toBe('#ffffff');
  });
});

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');

describe.skipIf(!fs.existsSync(LANG_PATH) || !fs.existsSync(PORTAL_PATH))(
  'VISUAL.inventory-burden-label-dim — the real 0x21000023 descs drive the strip text',
  () => {
    let H: GameUIFixture;
    beforeAll(async () => {
      const dat = await import('@ac/dat-parser');
      const open = (p: string) => {
        const b = fs.readFileSync(p);
        return new dat.DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      };
      const portal = open(PORTAL_PATH);
      dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portal.getFileData(0x39000001)!)));
      const lang = open(LANG_PATH);
      H = await mountGameUI({ size: { innerWidth: 1600, innerHeight: 900 } });
      const lrMod = await import('../packages/renderer/src/ui/LayoutRenderer.js');
      const tex = { getTextureDataURL: () => '', getTextureDataURLWithAlpha: () => '' };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const real = new lrMod.LayoutRenderer(lang as any, tex as any, null);
      // Panel chrome stubbed (no textures); desc resolution is the real
      // LayoutRenderer's base-chain-resolved layout.
      H.ui.layoutRenderer = stubPanelRenderer(H.win, { getResolvedLayout: (id: number) => real.getResolvedLayout(id) });
      H.ui.setSidePackGuids([0x50000001]);
      if (!H.ui.inventoryVisible) H.ui.toggleInventory();
    });
    afterAll(() => H?.teardown());

    it('both texts draw in the desc p27 entry 0 (white), font 0x40000000, at under- and over-capacity loads', () => {
      for (const load of [0.4, 1.5, 2.5]) {
        const { label, pct } = openAt(H.ui, load);
        for (const t of [label, pct]) {
          expect(t.style.color).toBe('#ffffff');
          expect(t.dataset.acFont).toBe('40000000');
        }
      }
    });

    it('both are far-justified (p20 3): right-aligned in their 36px boxes, like retail', () => {
      const { labelBox, pctBox } = openAt(H.ui, 0.4);
      expect(labelBox.style.justifyContent).toBe('flex-end');
      expect(pctBox.style.justifyContent).toBe('flex-end');
    });

    it('VISUAL.inventory-contents-label-colour — "Contents of Backpack" draws from its own desc (0x21000021:0x100001c5), white like retail', () => {
      openAt(H.ui, 0.4);
      const grid = H.ui.inventoryPanelHandle.elements.get(0x100001cf) as HTMLElement;
      const label = grid.querySelector('[data-ac-desc="21000021:100001c5"]') as HTMLElement | null;
      expect(label).not.toBeNull();
      expect(label!.textContent ?? label!.getAttribute('aria-label') ?? '').toBeDefined();
      expect(label!.style.color).toBe('#ffffff');
    });
  },
);
