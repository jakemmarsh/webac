/**
 * VISUAL.options-panel-eol-window — the Options panel opens in the EoL panels
 * window, and its Gameplay page is gmGameplayOptionsUI's own layout.
 *
 * Retail (verification/retail-client/ab/retail-options-gameplay.png, the EoL
 * client under Wine at 1600x900) shows the Options tabs in the 310x372 panels
 * window over the toolbar, the inventory's spot, on one alpha-175 black scrim,
 * with seven blue gold-edged buttons in three groups. The DAT chain:
 * 0x2100006e:0x10000180 slot 0x1000018d is based on 0x2100002b:0x10000208;
 * the Gameplay page 0x2100002a:0x10000202 authors seven 240x32 buttons at
 * x = 26, y = 20/60 | 110/150/190 | 240/280 (NO-DEAD-ENDS: we hide the last
 * three, Help Files / Urgent Assistance / Report Abuse), each based on
 * 0x21000040:0x10000618, whose 3-slice 0x100002ce/cf/d0 states carry
 * 0x060074a7-af.
 *
 * Drives the real GameUI with the real LayoutRenderer over the DATs (skipped
 * without them); textures resolve to `tex:<id>` so the painted art is
 * observable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasDats = fs.existsSync(LANG_PATH) && fs.existsSync(PORTAL_PATH);

const hex = (id: number): string => `0x${id.toString(16).padStart(8, '0')}`;
const BUTTONS: Array<[number, number]> = [
  [0x10000203, 20], [0x10000617, 60], [0x10000204, 110], [0x100005cc, 150],
];
/** NO-DEAD-ENDS — Help Files / Urgent Assistance / Report Abuse (190 / 240 / 280) are hidden. */
const DEAD_END_BUTTONS = [0x10000205, 0x10000206, 0x10000207];
// State 1 (normal) art of the three slices, from 0x21000040:0x10000618.
const NORMAL_SLICES: Array<[number, number]> = [[0x100002ce, 0x060074a9], [0x100002cf, 0x060074ac], [0x100002d0, 0x060074af]];

describe.skipIf(!hasDats)('VISUAL.options-panel-eol-window — Options in the panels window (real LayoutRenderer + DATs)', () => {
  let H: GameUIFixture;

  beforeAll(async () => {
    H = await mountGameUI({ size: { innerWidth: 1600, innerHeight: 900 } });
    const dat = await import('@ac/dat-parser');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new dat.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new dat.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    dat.registerStringTable(dat.parseStringTable(new dat.DatReader(langDb.getFileData(0x23000001)!)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const loader = { getTextureDataURL: (id: number) => `tex:${hex(id)}`, getTextureDataURLWithAlpha: (id: number) => `tex:${hex(id)}` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    H.ui.layoutRenderer = new LayoutRenderer(langDb as any, loader as any, null);
    H.ui.getTexURL = (id: number) => `tex:${hex(id)}`;
    H.ui.optionsTab = 'gameplay';
    H.ui.toggleOptionsPanel();
  }, 120_000);
  afterAll(() => H?.teardown());

  const wrapper = (): HTMLElement => (H.ui.optionsPanel as HTMLElement).parentElement as HTMLElement;

  it('opens as the panels window: 310x372 at its placement, in the window frame, the panel at the body (5,5)', () => {
    expect(H.ui.optionsPanelVisible).toBe(true);
    const w = wrapper();
    expect([w.style.width, w.style.height]).toEqual(['310px', '372px']);
    expect(w.querySelector('[data-panels-window-frame="0x2100006e"]')).not.toBeNull();
    const root = H.ui.optionsPanel as HTMLElement;
    expect([root.style.left, root.style.top]).toEqual(['5px', '5px']);
  });

  it('draws ONE scrim: the frame root 0x100005fe carries 0x06004cc2, the wrapper and page paint nothing', () => {
    const w = wrapper();
    expect(w.style.backgroundImage === '' || w.style.backgroundImage === 'none').toBe(true);
    const frameRoot = w.querySelector('[data-panels-window-frame] [data-element-id="0x100005fe"]') as HTMLElement | null;
    const frameArt = frameRoot ? frameRoot.outerHTML : '';
    expect(frameArt).toContain('tex:0x06004cc2');
    const page = (H.ui.optionsPanel as HTMLElement).querySelector('[data-element-id="0x10000211"]') as HTMLElement;
    expect(page.style.backgroundImage).toBe('none');
    expect(page.outerHTML).not.toContain('tex:0x0600114d');
  });

  it('the Gameplay page is 0x2100002a: its four live buttons at the DAT offsets; the three dead ends hidden', () => {
    const gp = (H.ui.optionsPanel as HTMLElement).querySelector('.options-gameplay-page [data-layout-id="0x2100002a"]') as HTMLElement;
    expect(gp).not.toBeNull();
    for (const [id, y] of BUTTONS) {
      const btn = gp.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
      expect(btn, hex(id)).not.toBeNull();
      expect([btn.style.left, btn.style.top, btn.style.width, btn.style.height]).toEqual(['26px', `${y}px`, '240px', '32px']);
    }
    expect([...gp.querySelectorAll('.options-action-btn')].map((b) => (b as HTMLElement).dataset.optionsAction)).toEqual([
      'Exit to Character Selection', 'Exit Game', 'Configure Keyboard', 'Use Mouse Turning Settings',
    ]);
    for (const id of DEAD_END_BUTTONS) {
      const btn = gp.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
      expect(btn.style.display, hex(id)).toBe('none');
    }
  });

  it('each button paints the EoL blue gold-edged 3-slice (0x060074a9 / ac / af at rest), not the red 0x06004cda family', () => {
    const gp = (H.ui.optionsPanel as HTMLElement).querySelector('.options-gameplay-page') as HTMLElement;
    for (const [id] of BUTTONS) {
      const btn = gp.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
      for (const [slice, tex] of NORMAL_SLICES) {
        const s = btn.querySelector(`[data-element-id="0x${slice.toString(16)}"]`) as HTMLElement;
        expect(s.getAttribute('data-tex'), `${hex(id)}/${hex(slice)}`).toBe(hex(tex));
      }
      expect(btn.outerHTML).not.toContain('tex:0x06004cda');
    }
  });

  it('showing the inventory displaces the options panel from the window (one panel at a time)', () => {
    H.ui.toggleInventory();
    expect(H.ui.inventoryVisible).toBe(true);
    expect(H.ui.optionsPanelVisible).toBe(false);
    expect(H.ui.optionsPanel).toBeNull();
  });
});
