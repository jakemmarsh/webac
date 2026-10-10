/**
 * GAP.ui-cursor-global — retail's cursor is window-wide.
 *
 * ClientUISystem::UpdateCursorState @ 00564630 → UIElementManager::SetCursor
 * (…, true) @ 0045a800 sets the DEFAULT cursor of the whole UI; CheckCursor
 * @ 0045abf0 shows an element's own cursor only when its layout's Cursor
 * media set one (MediaMachine::Update_Cursor @ 00465a80 → UIElement::
 * SetCursor). Ours: a CSS variable on <html> applied with !important to every
 * element (so no browser hand over panels), and `data-ac-cursor` elements
 * (the DAT window borders) carry their own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat } from './_harness/dat.js';
import {
  setGlobalCursor, currentGlobalCursor, setElementCursor, cursorCSS,
  GLOBAL_CURSOR_VAR, ELEMENT_CURSOR_VAR, ELEMENT_CURSOR_ATTR,
} from '../packages/renderer/src/ui/GlobalCursor.js';
import { LayoutRenderer } from '../packages/renderer/src/ui/LayoutRenderer.js';
import {
  MediaType, parseMasterProperty, setMasterPropertyTypes, type MediaDesc,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'getComputedStyle'] as const;
const saved: Record<string, unknown> = {};
beforeAll(() => installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions'));
afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

const PORTAL_DAT = 'dat/client_portal.dat';
const LANG_DAT = 'dat/client_local_English.dat';
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

function fakeRenderer(): LayoutRenderer {
  const tex = { getTextureDataURL: (id: number) => `data:image/png;base64,TEX${id.toString(16)}` };
  return new LayoutRenderer({ getFileData: () => null } as unknown as DatDatabase, tex as never);
}

describe('GAP.ui-cursor-global — the window-wide default cursor', () => {
  it('sets one variable on <html>, applied to every element with !important', () => {
    setGlobalCursor(cursorCSS('data:image/png;base64,DEF', 0, 0));
    expect(currentGlobalCursor()).toBe('url(data:image/png;base64,DEF) 0 0, auto');
    const style = document.getElementById('ac-global-cursor')!;
    expect(style.textContent).toContain(`html, html * { cursor: var(${GLOBAL_CURSOR_VAR}, auto) !important; }`);
    // A panel button's stray inline 'pointer' cannot beat the !important rule.
    const btn = document.createElement('div');
    btn.style.cursor = 'pointer';
    document.body.appendChild(btn);
    const rule = [...(style as HTMLStyleElement).sheet!.cssRules]
      .find((r) => (r as CSSStyleRule).selectorText === 'html, html *') as CSSStyleRule;
    expect(rule.style.getPropertyPriority('cursor')).toBe('important');
  });

  it('a later state replaces the default; the same value is a no-op; null falls back to auto', () => {
    setGlobalCursor('url(data:a) 0 0, auto');
    setGlobalCursor('url(data:b) 0 0, auto');
    expect(currentGlobalCursor()).toBe('url(data:b) 0 0, auto');
    setGlobalCursor(null);
    expect(currentGlobalCursor()).toBe('auto');
    expect(document.querySelectorAll('#ac-global-cursor')).toHaveLength(1);
  });

  it('an element cursor sets data-ac-cursor + its own variable; UnSetCursor clears both', () => {
    const el = document.createElement('div');
    setElementCursor(el, 'url(data:x) 16 16, auto');
    expect(el.hasAttribute(ELEMENT_CURSOR_ATTR)).toBe(true);
    expect(el.style.getPropertyValue(ELEMENT_CURSOR_VAR)).toBe('url(data:x) 16 16, auto');
    setElementCursor(el, null);
    expect(el.hasAttribute(ELEMENT_CURSOR_ATTR)).toBe(false);
    expect(el.style.getPropertyValue(ELEMENT_CURSOR_VAR)).toBe('');
  });
});

describe('GAP.ui-cursor-global — LayoutRenderer plays Cursor media (MediaMachine::Update_Cursor)', () => {
  it('Cursor media with a file sets the element cursor with its hotspot', () => {
    const r = fakeRenderer();
    const el = document.createElement('div');
    const media: MediaDesc[] = [{ type: MediaType.Cursor, file: 0x06006126, xHotspot: 16, yHotspot: 16 }];
    r.applyMediaToElement(el, media, 1);
    expect(el.hasAttribute(ELEMENT_CURSOR_ATTR)).toBe(true);
    expect(el.style.getPropertyValue(ELEMENT_CURSOR_VAR)).toBe('url(data:image/png;base64,TEX6006126) 16 16, auto');
  });

  it('Cursor media with file 0 clears it; other media leaves the cursor alone', () => {
    const r = fakeRenderer();
    const el = document.createElement('div');
    r.applyMediaToElement(el, [{ type: MediaType.Cursor, file: 0x06005e66, xHotspot: 16, yHotspot: 16 }], 1);
    r.applyMediaToElement(el, [{ type: MediaType.Image, file: 0x06001234 }], 1);
    expect(el.hasAttribute(ELEMENT_CURSOR_ATTR)).toBe(true);
    r.applyMediaToElement(el, [{ type: MediaType.Cursor, file: 0 }], 1);
    expect(el.hasAttribute(ELEMENT_CURSOR_ATTR)).toBe(false);
  });
});

describe.skipIf(!hasDats)('GAP.ui-cursor-global — the EoL floaty chat borders carry DAT resize cursors', () => {
  let handle: { elements: Map<number, HTMLElement> } | null = null;
  beforeAll(async () => {
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const loader = new UITextureLoader(new TextureManager(portalDb));
    // Node has no canvas encoder: stand in a data URL per texture id.
    loader.getTextureDataURL = (id: number) => `data:image/png;base64,T${id.toString(16)}`;
    const r = new LayoutRenderer(langDb, loader);
    r.getTextureDataURLWithAlpha = () => null;
    const host = document.createElement('div');
    document.body.appendChild(host);
    handle = r.render(0x2100005b, host) as unknown as { elements: Map<number, HTMLElement> };
  });

  it.each([
    [0x100004fc, 0x06006126], [0x1000000f, 0x06005e66], [0x100004fe, 0x06006127], [0x100004d2, 0x06006128],
    [0x100004d3, 0x06006128], [0x10000501, 0x06006127], [0x100004d4, 0x06005e66], [0x10000503, 0x06006126],
  ])('border element 0x%s draws cursor 0x%s at hotspot 16,16', (elementId, did) => {
    const el = handle!.elements.get(elementId)!;
    expect(el).toBeTruthy();
    expect(el.style.getPropertyValue(ELEMENT_CURSOR_VAR)).toBe(`url(data:image/png;base64,T${did.toString(16)}) 16 16, auto`);
  });
});
