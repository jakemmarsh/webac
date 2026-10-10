/**
 * CORE.5.c.b — the social panel body rendered near-black because the DAT
 * stacks FOUR page panes at (0,25) 300x575 inside the 0x21000031 tab
 * group, and each pane inherits its tab's base layout root whose body
 * media 0x06004cc2 is a translucent BLACK 48x48 tile (RGBA 0,0,0,175 —
 * verified by decoding the texture from portal.dat below). Four stacked
 * layers composite to ~99% black over any fill beneath. Retail's type-8
 * tab control shows one page at a time, so GameUI hides the three
 * non-hosting panes via handle.setVisible(paneId, false).
 *
 * This drives the REAL dat-parser + LayoutRenderer against the real DATs
 * (no source-text pins): it proves the defect mechanism exists in the DAT
 * data (all four panes resolve to the same translucent-black media) and
 * that the fix contract (setVisible) actually removes the stacked layers
 * from the DOM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasLang = fs.existsSync(LANG_PATH);
const hasPortal = fs.existsSync(PORTAL_PATH);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1920, innerHeight: 1080 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const SOCIAL_LAYOUT = 0x21000031;
const SOCIAL_ROOT = 0x1000028b;
const HOSTING_PANE = 0x10000513;
const HIDDEN_PANES = [0x10000291, 0x10000292, 0x1000054a];
const PAGE_FILL_TEX = 0x06004cc2;

describe.skipIf(!hasLang || !hasPortal)('CORE.5.c.b — social stacked-pane visibility (DAT ground truth)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let datMod: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let renderer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let portalDb: any;
  let hud: HTMLElement;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    datMod = await import('@ac/dat-parser');
    const lrMod = await import('../packages/renderer/src/ui/LayoutRenderer.js');

    const portalBuf = fs.readFileSync(PORTAL_PATH);
    portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new datMod.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));

    const uiTextureLoader = {
      getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`,
      getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}`,
    } as unknown as import('../packages/renderer/src/ui/UITextureLoader.js').UITextureLoader;
    renderer = new lrMod.LayoutRenderer(langDb, uiTextureLoader, null);
    hud = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(hud);
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('texture 0x06004cc2 decodes to a translucent BLACK tile (RGBA 0,0,0,175), not grey or leather', () => {
    const data = portalDb.getFileData(PAGE_FILL_TEX);
    expect(data).toBeTruthy();
    const tex = datMod.Texture.read(new datMod.DatReader(data!));
    const { width, height, data: rgba } = tex.toRGBA();
    expect(width).toBe(48);
    expect(height).toBe(48);
    // Sample corners + center: every sampled pixel is pure black at alpha 175.
    for (const [x, y] of [[0, 0], [47, 0], [0, 47], [47, 47], [24, 24]]) {
      const o = (y * width + x) * 4;
      expect([rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]]).toEqual([0, 0, 0, 175]);
    }
  });

  it('all four stacked panes render with the SAME translucent-black media inherited from their base roots', () => {
    const handle = renderer.renderPanel(SOCIAL_LAYOUT, hud, { subtreeElementId: SOCIAL_ROOT });
    expect(handle).not.toBeNull();
    for (const paneId of [HOSTING_PANE, ...HIDDEN_PANES]) {
      const el = handle.elements.get(paneId) as HTMLElement | undefined;
      expect(el, `pane 0x${paneId.toString(16)}`).toBeTruthy();
      // Each pane resolved its base root's media (0x06004cc2) — the layer
      // that, stacked 4 deep, crushed the body to near-black.
      expect(el!.style.backgroundImage).toContain(`tex-${PAGE_FILL_TEX.toString(16)}`);
      // And all four occupy the same slot (stacked, not side by side).
      expect(el!.style.left).toBe(handle.elements.get(HOSTING_PANE)!.style.left);
      expect(el!.style.top).toBe(handle.elements.get(HOSTING_PANE)!.style.top);
    }
    handle.close();
  });

  it('setVisible(paneId, false) removes the non-hosting panes from the composite; the hosting pane stays', () => {
    const handle = renderer.renderPanel(SOCIAL_LAYOUT, hud, { subtreeElementId: SOCIAL_ROOT });
    expect(handle).not.toBeNull();
    for (const paneId of HIDDEN_PANES) handle.setVisible(paneId, false);
    for (const paneId of HIDDEN_PANES) {
      expect((handle.elements.get(paneId) as HTMLElement).style.display, `pane 0x${paneId.toString(16)}`).toBe('none');
    }
    expect((handle.elements.get(HOSTING_PANE) as HTMLElement).style.display).not.toBe('none');
    handle.close();
  });
});
