/**
 * CORE.5.b.d — the EoL bottom-right toolbar is the FLOATY family, not the
 * bare classic 300x122 bar.
 *
 * DAT ground truth (all verified against real DATs below):
 * - Root HUD 0x21000005 authors toolbar window 0x10000603 at (490,500)
 *   310x100 (bottom-right flush in the 800x600 design), WindowID attr
 *   0x1000007e = 10, base layout 0x21000070 root 0x10000602.
 * - Layout 0x21000070 (gmFloatyToolbarUI class 0x10000051): fixed width
 *   (p63 minW = p61 maxW = 310), height resizable 100..132 (p62 minH=100,
 *   p60 maxH=132); 5px floaty border chrome — 8 locked-art pieces (type 3,
 *   the shared textures 0x060074bf-c6), 5 drag borders (type 2) and 3
 *   bottom resize handles (type 9, p42=bottom); content child 0x1000001b
 *   at (5,5) 300x122 inheriting the WHOLE classic toolbar
 *   0x21000016:0x10000191.
 * - The classic content carries TWO shortcut rows (row 1 0x100001a7-af at
 *   y=58, row 2 0x100006b7-bf at y=90 — both bound into one 18-slot array
 *   by gmToolbarUI::InitShortcutArray @ 004bdd50). At the default window
 *   height 100 the inner viewport is 90px (top section 58 + one 32px row);
 *   the 132 max reveals row 2 (58+32+32 = 122).
 *
 * Behavioral: drives the REAL dat-parser + LayoutRenderer (happy-dom) to
 * prove the chrome renders with interactive/locked border pairs and the
 * resolved classic content subtree.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { resolve } from 'node:path';
import {
  TOOLBAR_WINDOW_ID,
  FLOATY_LOCKED_BORDER_TEXTURES,
} from '../packages/renderer/src/ui/FloatyWindowModel';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasLang = fs.existsSync(LANG_PATH);
const hasPortal = fs.existsSync(PORTAL_PATH);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1920, innerHeight: 1080 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const HUD_LAYOUT = 0x21000005;
const HUD_ROOT = 0x10000495;
const TOOLBAR_AUTHOR = 0x10000603;
const TOOLBAR_LAYOUT = 0x21000070;
const TOOLBAR_ROOT = 0x10000602;
const CONTENT_CHILD = 0x1000001b;
const CLASSIC_LAYOUT = 0x21000016;
const CLASSIC_ROOT = 0x10000191;
const WINDOW_ID_ATTR = 268435582; // 0x1000007e

it('TOOLBAR_WINDOW_ID is 10 (DAT attr 0x1000007e on 0x10000603)', () => {
  expect(TOOLBAR_WINDOW_ID).toBe(10);
});

describe.skipIf(!hasLang || !hasPortal)('CORE.5.b.d — EoL toolbar DAT ground truth', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let datMod: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let langDb: any;

  beforeAll(async () => {
    datMod = await import('@ac/dat-parser');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    langDb = new datMod.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parseLayout = (id: number): any =>
    datMod.parseLayoutDesc(new datMod.DatReader(langDb.getFileData(id)!));

  it('root HUD 0x21000005 authors 0x10000603 at (490,500) 310x100, base 0x21000070:0x10000602, WindowID 10', () => {
    const hudLayout = parseLayout(HUD_LAYOUT);
    const author = hudLayout.elements.get(HUD_ROOT)!.children.get(TOOLBAR_AUTHOR);
    expect(author).toBeDefined();
    expect([author.x, author.y, author.width, author.height]).toEqual([490, 500, 310, 100]);
    expect(author.baseLayout >>> 0).toBe(TOOLBAR_LAYOUT);
    expect(author.baseElement >>> 0).toBe(TOOLBAR_ROOT);
    expect(author.properties.get(WINDOW_ID_ATTR)?.valueEnum).toBe(TOOLBAR_WINDOW_ID);
    // Edges L2/T2/R1/B1 — right+bottom anchored → bottom-right flush
    // (490+310 = 800, 500+100 = 600 in the 800x600 design).
    expect([author.leftEdge, author.topEdge, author.rightEdge, author.bottomEdge]).toEqual([2, 2, 1, 1]);
  });

  it('layout 0x21000070 root: fixed width 310 (p63=p61), height 100..132 (p62/p60)', () => {
    const tb = parseLayout(TOOLBAR_LAYOUT);
    const root = tb.elements.get(TOOLBAR_ROOT);
    expect(root).toBeDefined();
    expect([root.width, root.height]).toEqual([310, 100]);
    expect(root.properties.get(63)?.valueInt).toBe(310); // minW
    expect(root.properties.get(61)?.valueInt).toBe(310); // maxW
    expect(root.properties.get(62)?.valueInt).toBe(100); // minH
    expect(root.properties.get(60)?.valueInt).toBe(132); // maxH
  });

  it('layout 0x21000070 chrome: 8 locked-art pieces on the shared floaty border textures, drag + bottom-resize borders, content child (5,5) 300x122 inheriting the classic toolbar', () => {
    const tb = parseLayout(TOOLBAR_LAYOUT);
    const root = tb.elements.get(TOOLBAR_ROOT);
    const lockedArt: number[] = [];
    let dragCount = 0;
    const resizeBottom: number[] = [];
    for (const [id, child] of root.children) {
      if (id === CONTENT_CHILD) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const media = (child.media ?? []).find((m: any) => typeof m.file === 'number')?.file ?? 0;
      if (child.type === 3 && FLOATY_LOCKED_BORDER_TEXTURES.has(media)) lockedArt.push(id);
      if (child.type === 2) dragCount++;
      if (child.type === 9) {
        const p42 = child.properties.get(42)?.valueBool === true
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          || [...child.states.values()].some((s: any) => s.properties?.get(42)?.valueBool === true);
        if (p42) resizeBottom.push(id);
      }
    }
    expect(lockedArt.length).toBe(8);   // 4 borders + 4 corners
    expect(dragCount).toBe(5);          // top/left/right borders + top corners
    expect(resizeBottom.length).toBe(3); // bottom corners + bottom border, all p42=bottom

    const content = root.children.get(CONTENT_CHILD);
    expect(content).toBeDefined();
    expect([content.x, content.y, content.width, content.height]).toEqual([5, 5, 300, 122]);
    expect(content.baseLayout >>> 0).toBe(CLASSIC_LAYOUT);
    expect(content.baseElement >>> 0).toBe(CLASSIC_ROOT);
    // Edges L1/T1/R1/B2 — pinned to the window top, cropped at the bottom
    // while the window is shorter than 132.
    expect([content.leftEdge, content.topEdge, content.rightEdge, content.bottomEdge]).toEqual([1, 1, 1, 2]);
  });

  it('classic toolbar carries a SECOND shortcut row 0x100006b7-bf at y=90 (18 slots total)', () => {
    const classic = parseLayout(CLASSIC_LAYOUT);
    const root = classic.elements.get(CLASSIC_ROOT);
    const xs = [6, 38, 70, 102, 134, 166, 198, 230, 262];
    for (let i = 0; i < 9; i++) {
      const row1 = root.children.get(0x100001a7 + i);
      expect(row1, `row1 slot ${i}`).toBeDefined();
      expect([row1.x, row1.y, row1.width, row1.height]).toEqual([xs[i], 58, 32, 32]);
      const row2 = root.children.get(0x100006b7 + i);
      expect(row2, `row2 slot ${i}`).toBeDefined();
      expect([row2.x, row2.y, row2.width, row2.height]).toEqual([xs[i], 90, 32, 32]);
    }
    // Row-2 edge borders 0x100006b6 (0,90) 6x32 and 0x100006c0 (294,90) 8x32.
    const edgeL = root.children.get(0x100006b6);
    const edgeR = root.children.get(0x100006c0);
    expect([edgeL.x, edgeL.y, edgeL.width, edgeL.height]).toEqual([0, 90, 6, 32]);
    expect([edgeR.x, edgeR.y, edgeR.width, edgeR.height]).toEqual([294, 90, 8, 32]);
  });
});

describe.skipIf(!hasLang || !hasPortal)('CORE.5.b.d — floaty toolbar chrome renders (LayoutRenderer)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let handle: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const datMod: any = await import('@ac/dat-parser');
    const lrMod = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new datMod.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    const uiTextureLoader = {
      getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`,
      getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}`,
    } as unknown as import('../packages/renderer/src/ui/UITextureLoader.js').UITextureLoader;
    const renderer = new lrMod.LayoutRenderer(langDb, uiTextureLoader, null);
    const hud = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(hud);
    handle = renderer.render(TOOLBAR_LAYOUT, hud, { subtreeElementId: TOOLBAR_ROOT });
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('renders the subtree with every border piece and the resolved content child present', () => {
    expect(handle).toBeTruthy();
    // Locked art corners/borders 0x10000623-2a, interactive 0x1000062b-32.
    for (let id = 0x10000623; id <= 0x10000632; id++) {
      expect(handle.elements.get(id), `chrome 0x${id.toString(16)}`).toBeTruthy();
    }
    expect(handle.elements.get(CONTENT_CHILD)).toBeTruthy();
  });

  it('the content child resolves the inherited classic subtree (combat-mode column 0x10000192 renders inside it)', () => {
    const content = handle.elements.get(CONTENT_CHILD) as HTMLElement;
    // Inheritance resolution grafts the classic toolbar children under the
    // content element — spot-check the combat-mode column (0x10000192) and
    // a row-2 shortcut slot (0x100006b7).
    expect(content.querySelector('[data-element-id="0x10000192"]')).toBeTruthy();
    expect(content.querySelector('[data-element-id="0x100006b7"]')).toBeTruthy();
  });
});
