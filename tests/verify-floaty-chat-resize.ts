/**
 * CORE.3.d — floaty chat window resize: DAT edge-anchor reflow.
 *
 * Drives the REAL LayoutRenderer subtree render of floaty window 1
 * (element 0x10000505 of gameplay layout 0x21000005, inheriting the
 * FloatyChatWindow template 0x100004f7@0x2100005b) and asserts
 * resizeSubtree() reflows every child exactly per the decompiled client's
 * UIElement::UpdateForParentSizeChange @ 00462640 semantics:
 *   leftEdge/topEdge: 1=fixed, 2=follows far edge, 3=centered
 *   rightEdge/bottomEdge: 1=follows far edge, 3=centered, else fixed span
 *
 * Also pins the template's resize contract from the DAT itself: the 8
 * UIElement_Resizebar (class 9) handles with their p42-45 direction flags
 * (UIElement_Resizebar::StartMouseResizing @ 0046b7e0) and the min/max
 * size props p63/p62/p61/p60 (UIElement::MouseResizeElement @ 00461130
 * clamps against attributes 0x3f/0x3e/0x3d/0x3c).
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
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const GAMEPLAY_LAYOUT = 0x21000005;
const FLOATY_WINDOW_1 = 0x10000505;

describe.skipIf(!hasLang || !hasPortal)('CORE.3.d — floaty chat resize (DAT edge-anchor reflow)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let renderer: any;
  let hud: HTMLElement;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let model: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const datMod = await import('@ac/dat-parser');
    const lrMod = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    model = await import('../packages/renderer/src/ui/FloatyChatModel.js');

    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function renderWindow1(): any {
    const handle = renderer.render(GAMEPLAY_LAYOUT, hud, { subtreeElementId: FLOATY_WINDOW_1 });
    expect(handle).not.toBeNull();
    return handle;
  }

  it('the DAT template carries the 8 class-9 resize handles with the retail direction flags', () => {
    const handle = renderWindow1();
    const flagOf = (id: number, pid: number): boolean => {
      const desc = handle.descs.get(id);
      expect(desc, `desc 0x${id.toString(16)}`).toBeTruthy();
      return desc.properties.get(pid)?.valueBool === true;
    };
    for (const expected of model.FLOATY_RESIZE_HANDLES) {
      const id = expected.elementId;
      expect(handle.descs.get(id)?.type, `type of 0x${id.toString(16)}`).toBe(9);
      expect(flagOf(id, 43), `left of 0x${id.toString(16)}`).toBe(expected.left);
      expect(flagOf(id, 44), `right of 0x${id.toString(16)}`).toBe(expected.right);
      expect(flagOf(id, 45), `top of 0x${id.toString(16)}`).toBe(expected.top);
      expect(flagOf(id, 42), `bottom of 0x${id.toString(16)}`).toBe(expected.bottom);
    }
    handle.destroy();
  });

  it('the DAT template pins min 150x76 (p63/p62) and max 1024x928 (p61/p60)', () => {
    const handle = renderWindow1();
    const root = handle.descs.get(FLOATY_WINDOW_1);
    expect(root.properties.get(63)?.valueInt).toBe(model.FLOATY_MIN_WIDTH);
    expect(root.properties.get(62)?.valueInt).toBe(model.FLOATY_MIN_HEIGHT);
    expect(root.properties.get(61)?.valueInt).toBe(model.FLOATY_MAX_WIDTH);
    expect(root.properties.get(60)?.valueInt).toBe(model.FLOATY_MAX_HEIGHT);
    handle.destroy();
  });

  it('resizeSubtree(400,200) reflows children per the DAT edge anchors', () => {
    const handle = renderWindow1();
    expect(handle.resizeSubtree).toBeTypeOf('function');
    handle.resizeSubtree(400, 200); // 250x104 default → dW=150, dH=96

    const rect = (id: number) => {
      const el: HTMLElement = handle.elements.get(id);
      expect(el, `element 0x${id.toString(16)}`).toBeTruthy();
      return {
        x: parseInt(el.style.left), y: parseInt(el.style.top),
        w: parseInt(el.style.width), h: parseInt(el.style.height),
      };
    };
    expect(parseInt(handle.root.style.width)).toBe(400);
    expect(parseInt(handle.root.style.height)).toBe(200);
    // Title bar 0x10000529 (5,5,240,20) L1 T1 R1 B2 — stretches wide, fixed height.
    expect(rect(0x10000529)).toEqual({ x: 5, y: 5, w: 390, h: 20 });
    // Close box 0x1000052a (230,6,14,14) L2 — rides the right edge, keeps size.
    expect(rect(0x1000052a)).toEqual({ x: 380, y: 6, w: 14, h: 14 });
    // CORE.5.c — the window instance 0x10000505 (250x104) incorporates the
    // template root 0x100004f7 (250x108), so the inherited children reflow
    // by dH=-4 at RESOLUTION time (retail sizes an incorporated tree to the
    // incorporating element — see resolveElementDesc): the log/scrollbar
    // are 56 tall in the 104 window (template's 23px bottom band preserved)
    // and the bottom-riding rows sit 4px higher, no longer overhanging.
    // Log backing 0x10000010 (5,25,224,60→56) L1 T1 R1 B1 — stretches both ways.
    expect(rect(0x10000010)).toEqual({ x: 5, y: 25, w: 374, h: 152 });
    // Scrollbar column 0x10000012 (229,25,16,60→56) L2 T1 R1 B1 — rides right, stretches tall.
    expect(rect(0x10000012)).toEqual({ x: 379, y: 25, w: 16, h: 152 });
    // Entry row 0x10000509 (5,85→81,240,18) L1 T2 R1 B1 — pinned to the bottom, stretches wide.
    expect(rect(0x10000509)).toEqual({ x: 5, y: 177, w: 390, h: 18 });
    // Send button 0x10000019 (202,0,38,18) inside the entry row, L2 T2 — rides its right edge.
    expect(rect(0x10000019)).toEqual({ x: 352, y: 0, w: 38, h: 18 });
    // Entry input 0x10000016 (0,0,202,18) L1 T2 R1 B1 — stretches to meet Send.
    expect(rect(0x10000016)).toEqual({ x: 0, y: 0, w: 352, h: 18 });
    // New-text indicator 0x1000048c (0,64→60,16,16) inside log text 0x10000011
    // (dW=150, dH=96): L3 = horizontally centered, T2/B1 = rides the bottom.
    expect(rect(0x1000048c)).toEqual({ x: 179, y: 156, w: 16, h: 16 });
    handle.destroy();
  });

  it('resize back to the default restores the original layout (no drift)', () => {
    const handle = renderWindow1();
    const before = new Map<number, string>();
    for (const id of [0x10000529, 0x1000052a, 0x10000010, 0x10000012, 0x10000509, 0x10000019]) {
      const el: HTMLElement = handle.elements.get(id);
      before.set(id, `${el.style.left}|${el.style.top}|${el.style.width}|${el.style.height}`);
    }
    handle.resizeSubtree(400, 200);
    handle.resizeSubtree(313, 157);
    handle.resizeSubtree(250, 104);
    for (const [id, snapshot] of before) {
      const el: HTMLElement = handle.elements.get(id);
      expect(`${el.style.left}|${el.style.top}|${el.style.width}|${el.style.height}`, `0x${id.toString(16)}`).toBe(snapshot);
    }
    handle.destroy();
  });

  it('resizeSubtree is absent on whole-layout renders', () => {
    const handle = renderer.render(0x21000006, hud);
    expect(handle.resizeSubtree).toBeUndefined();
    handle.destroy();
  });
});
