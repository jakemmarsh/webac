/**
 * CORE.5.c.c — DAT-native page chrome adoption: spellbook footer + options
 * bottom button row.
 *
 * Drives the REAL LayoutRenderer against the real magic panel (0x21000034)
 * and options container (0x2100002b) and asserts the mechanics GameUI's
 * native adoption depends on:
 *
 *  - the spellbook page 0x100002ac (base 0x21000032:0x10000294) renders the
 *    inherited footer 0x10000297 with its slate plate media 0x06002722, the
 *    school/level radio rows with their 13x13 toggle-gem child 0x10000328
 *    in state-1 (Normal/off) art 0x06004d15, and the Delete button
 *    0x100002a5 with its own state-1 art 0x06004cda;
 *  - setText onto a radio row honors the 0x21000044 template's DAT text
 *    justification (p20=2 near-edge + p35=16 left margin — decompiled
 *    client: UIElement_Text::OnSetAttribute maps p20/p21 to
 *    Set{Horizontal,Vertical}Justification; CalcJustification @ 00467260
 *    treats 1 as centered, 3/5 as far, else near + margin), while setText
 *    onto the Delete label 0x100002a6 (p20=1) stays centered;
 *  - the options pane 0x10000211 (base 0x21000028:0x100001f9) contains the
 *    inherited Apply/Reset/Defaults 3-slice buttons 0x100001fc/fd/fe with
 *    the gold-bordered red slice art (state-1: 0x06004c96/99/9c), their
 *    inherited p23 labels suppressed by the ownText gate (GameUI paints
 *    them via the adoption path).
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

const MAGIC_LAYOUT = 0x21000034;
const OPTIONS_LAYOUT = 0x2100002b;

describe.skipIf(!hasLang || !hasPortal)('CORE.5.c.c — spellbook footer + options button row DAT-native adoption (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let renderer: any;
  let hud: HTMLElement;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    if (typeof (g as Record<string, unknown> & { requestAnimationFrame?: unknown }).requestAnimationFrame !== 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (g as any).requestAnimationFrame = () => 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (g as any).cancelAnimationFrame = () => {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (domWindow as any).requestAnimationFrame = (g as any).requestAnimationFrame;
    }

    const datMod = await import('@ac/dat-parser');
    const lrMod = await import('../packages/renderer/src/ui/LayoutRenderer.js');

    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new datMod.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    datMod.setMasterPropertyTypes(datMod.parseMasterProperty(new datMod.DatReader(portalDb.getFileData(0x39000001)!)));

    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new datMod.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    datMod.registerStringTable(datMod.parseStringTable(new datMod.DatReader(langDb.getFileData(0x23000001)!)));

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

  it('spellbook page renders the inherited footer chrome: slate plate, radio gems (off art), Delete button art', () => {
    const handle = renderer.render(MAGIC_LAYOUT, hud, { subtreeElementId: 0x100002a8 });
    expect(handle).not.toBeNull();

    // Footer 0x10000297 carries the slate plate 0x06002722 as its own media.
    const footer: HTMLElement = handle!.elements.get(0x10000297);
    expect(footer, 'footer 0x10000297').toBeTruthy();
    expect(footer.style.backgroundImage).toContain('tex-6002722');

    // Every school + level radio row exists with its 0x10000328 gem child
    // rendering the state-1 Normal (off) art 0x06004d15 — NOT the state-13
    // Disabled art 0x06004d19 the old hand-built overlay used.
    const radioIds = [
      0x10000298, 0x10000299, 0x1000029a, 0x1000029b, 0x100005c0, // schools
      0x1000029c, 0x1000029d, 0x1000029e, 0x1000029f, 0x100002a0, 0x100002a1, 0x100002a2, 0x1000054e, // levels I-VIII
    ];
    for (const id of radioIds) {
      const row: HTMLElement = handle!.elements.get(id);
      expect(row, `radio row 0x${id.toString(16)}`).toBeTruthy();
      const gem = row.querySelector('[data-element-id="0x10000328"]') as HTMLElement | null;
      expect(gem, `gem under 0x${id.toString(16)}`).toBeTruthy();
      expect(gem!.style.backgroundImage).toContain('tex-6004d15');
      // Inherited p23 label must NOT auto-render (ownText gate) — GameUI
      // paints it via setText during adoption.
      expect(row.querySelector('.layout-text')).toBeNull();
    }

    // Delete button renders its own state-1 art.
    const del: HTMLElement = handle!.elements.get(0x100002a5);
    expect(del).toBeTruthy();
    expect(del.style.backgroundImage).toContain('tex-6004cda');

    handle!.destroy();
  });

  it('setText honors DAT justification: radio rows left-justified 16px in (p20=2/p35=16), Delete label centered (p20=1)', () => {
    const handle = renderer.render(MAGIC_LAYOUT, hud, { subtreeElementId: 0x100002a8 });

    handle!.setText(0x10000298, 'Creature');
    const radioText = (handle!.elements.get(0x10000298) as HTMLElement).querySelector('.layout-text') as HTMLElement;
    expect(radioText).toBeTruthy();
    expect(radioText.style.justifyContent).toBe('flex-start');
    expect(radioText.style.padding).toContain('16px');

    handle!.setText(0x100002a6, 'Delete');
    const delText = (handle!.elements.get(0x100002a6) as HTMLElement).querySelector('.layout-text') as HTMLElement;
    expect(delText).toBeTruthy();
    expect(delText.style.justifyContent).toBe('center');

    // Captions are near-justified with no margin (p20=2, p35=0).
    handle!.setText(0x100002a3, 'Schools:');
    const capText = (handle!.elements.get(0x100002a3) as HTMLElement).querySelector('.layout-text') as HTMLElement;
    expect(capText.style.justifyContent).toBe('flex-start');

    handle!.destroy();
  });

  it('options pane 0x10000211 contains the inherited Apply/Reset/Defaults 3-slice buttons with gold-bordered red art, labels ownText-gated', () => {
    const handle = renderer.render(OPTIONS_LAYOUT, hud, { subtreeElementId: 0x10000208 });
    expect(handle).not.toBeNull();

    const pane: HTMLElement = handle!.elements.get(0x10000211);
    expect(pane, 'pane 0x10000211').toBeTruthy();

    const SLICE_TEX: Array<[number, string]> = [
      [0x100002ce, 'tex-6004c96'],
      [0x100002cf, 'tex-6004c99'],
      [0x100002d0, 'tex-6004c9c'],
    ];
    for (const btnId of [0x100001fc, 0x100001fd, 0x100001fe]) {
      // Scoped query — the same element ids recur under the other stacked
      // panes (each inherits its own button set), which is exactly why
      // GameUI's adoption binds scoped DOM nodes, not handle.elements.
      const btn = pane.querySelector(`[data-element-id="0x${btnId.toString(16)}"]`) as HTMLElement | null;
      expect(btn, `button 0x${btnId.toString(16)} under pane 0x10000211`).toBeTruthy();
      for (const [sliceId, tex] of SLICE_TEX) {
        const slice = btn!.querySelector(`[data-element-id="0x${sliceId.toString(16)}"]`) as HTMLElement | null;
        expect(slice, `slice 0x${sliceId.toString(16)} of 0x${btnId.toString(16)}`).toBeTruthy();
        expect(slice!.style.backgroundImage).toContain(tex);
      }
      // Inherited p23 label suppressed (ownText gate).
      expect(btn!.querySelector('.layout-text')).toBeNull();
    }

    handle!.destroy();
  });
});
