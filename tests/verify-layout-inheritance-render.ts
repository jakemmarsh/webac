/**
 * CORE.3.a — LayoutRenderer consumes resolved element inheritance.
 *
 * Drives the REAL LayoutRenderer against the real classic_chat layout
 * (0x21000006) and asserts the numbered chat-window buttons 0x10000522-525
 * render their retail gold box art (state-1 texture 0x06006218, inherited
 * via 0x10000526 → 0x100002b9@0x21000040 → 0x1000047f) with their own digit
 * text on top — the exact chrome Jake's follow-up reported missing.
 *
 * Also pins the auto-text gate: inheritance resolution surfaces every
 * label that lives in a base desc (paperdoll "Slots" 0x100005be, backpack
 * "Burden" 0x100001d7, options "Apply"/"Reset", char-panel Titles-tab
 * headers …). GameUI still overlays its own text for those, and tab logic
 * never had to hide elements that used to render chrome-less — so
 * auto-text must stay restricted to elements whose OWN raw desc carries
 * p23. (Panels adopt DAT-native labels deliberately, task by task.)
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

const CHAT_LAYOUT = 0x21000006;
const INVENTORY_LAYOUT = 0x21000023;
const CHAT_WINDOW_BUTTONS = [0x10000522, 0x10000523, 0x10000524, 0x10000525];
const GOLD_BOX_NORMAL_TEX = 0x06006218;

describe.skipIf(!hasLang || !hasPortal)('CORE.3.a — LayoutRenderer renders inherited chrome (behavioral)', () => {
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
    // Register the English string table so p23 digits resolve.
    datMod.registerStringTable(datMod.parseStringTable(new datMod.DatReader(langDb.getFileData(0x23000001)!)));

    // Texture stub that encodes the requested id in the URL, so assertions
    // can verify WHICH DAT texture an element rendered.
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

  it('numbered chat-window buttons render the inherited gold box (state-1 tex 0x06006218) with their digit', () => {
    const handle = renderer.render(CHAT_LAYOUT, hud);
    expect(handle).not.toBeNull();
    for (const id of CHAT_WINDOW_BUTTONS) {
      const el: HTMLElement = handle!.elements.get(id);
      expect(el, `button 0x${id.toString(16)}`).toBeTruthy();
      // Gold box art applied via the state-1 (Normal) fallback
      expect(el.style.backgroundImage).toContain(`tex-${GOLD_BOX_NORMAL_TEX.toString(16)}`);
      // Digit from the element's OWN p23 still auto-renders on top
      const label = el.querySelector('.layout-text');
      expect(label, `digit on 0x${id.toString(16)}`).toBeTruthy();
    }
    // The four buttons carry the digits 1-4 in layout order of their ids
    const digits = CHAT_WINDOW_BUTTONS.map((id) =>
      (handle!.elements.get(id) as HTMLElement).querySelector('.layout-text')!.textContent!.trim());
    expect(digits).toEqual(['1', '2', '3', '4']);
    handle!.destroy();
  });

  it('setState(id, 6) swaps a button to the lit gold box (0x06006219) — the retail floaty-window-open state', () => {
    const handle = renderer.render(CHAT_LAYOUT, hud);
    const btn: HTMLElement = handle!.elements.get(0x10000522);
    handle!.setState(0x10000522, 6);
    expect(btn.style.backgroundImage).toContain('tex-6006219');
    handle!.setState(0x10000522, 1);
    expect(btn.style.backgroundImage).toContain('tex-6006218');
    handle!.destroy();
  });

  it('inherited scrollbar subtrees render hidden (runtime widget pending, CORE.3.b) but raw type-11 sliders keep rendering', () => {
    // Chat log scrollbar 0x10000012: type 11 only via inheritance
    // (raw desc is type 0) — static render mis-assembles it, so hidden.
    const chat = renderer.render(CHAT_LAYOUT, hud);
    const scrollbar: HTMLElement = chat!.elements.get(0x10000012);
    expect(scrollbar).toBeTruthy();
    expect(scrollbar.style.display).toBe('none');
    chat!.destroy();
    // Combat-bar power slider 0x1000004f: type 11 in its own raw desc
    // (baseElement 0) — must keep rendering exactly as before.
    const combat = renderer.render(0x21000007, hud);
    const slider: HTMLElement = combat!.elements.get(0x1000004f);
    expect(slider).toBeTruthy();
    expect(slider.style.display).not.toBe('none');
    combat!.destroy();
  });

  it('skipAutoTextIds suppresses even OWN p23 text (converted from the 2026-06-09 source pin)', () => {
    // Chat Send button 0x10000019 carries its own p23 ("Send").
    const withText = renderer.render(CHAT_LAYOUT, hud);
    expect((withText!.elements.get(0x10000019) as HTMLElement).querySelector('.layout-text')).toBeTruthy();
    withText!.destroy();
    const suppressed = renderer.render(CHAT_LAYOUT, hud, { skipAutoTextIds: [0x10000019] });
    expect((suppressed!.elements.get(0x10000019) as HTMLElement).querySelector('.layout-text')).toBeNull();
    suppressed!.destroy();
  });

  it('auto-text stays gated to own p23: inherited labels (paperdoll "Slots"/"Burden") do NOT auto-render', () => {
    const handle = renderer.render(INVENTORY_LAYOUT, hud);
    expect(handle).not.toBeNull();
    for (const id of [0x100005be /* "Slots" */, 0x100001d7 /* "Burden" */]) {
      const el: HTMLElement | undefined = handle!.elements.get(id);
      expect(el, `element 0x${id.toString(16)}`).toBeTruthy();
      expect(el!.querySelector('.layout-text'), `inherited label 0x${id.toString(16)} must not auto-render`).toBeNull();
    }
    handle!.destroy();
  });
});
