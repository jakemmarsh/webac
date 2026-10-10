/**
 * RECON.dom-chrome-sweep.c — the toolbar split-stack entry 0x100001a3 draws
 * its digits in its DAT desc's style, not a 10 px browser font; the
 * selected-object name 0x1000019f above it draws in its desc font
 * (0x40000002) and per-state justification; the slider thumb has no fill
 * under its transparent corners.
 *
 * Ground truth: the entry's desc (layout 0x21000016, base
 * 0x2100003f:0x10000376) resolves to font 0x40000000, white, p20 = 3
 * (right-justified) with p36 = 2; gmToolbarUI's setup @ 185181 (annotated
 * decomp) only adds NumberInputFilter. Retail
 * verification/retail-client/ab/retail-stack-selected.png draws "5000"
 * against the box's right edge in the plain UI font.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { findElementByPath, textStyleFromDesc } from '../packages/renderer/src/ui/DatTextStyle.js';

const hasDats = fs.existsSync(DAT_PATHS.portal) && fs.existsSync(DAT_PATHS.local);

const TOOLBAR_LAYOUT = 0x21000016;
const EL_STACK_ENTRY = 0x100001a3;

describe.skipIf(!hasDats)('the stack entry desc 0x21000016:0x100001a3', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let desc: any;
  beforeAll(async () => {
    const dat = await import('@ac/dat-parser');
    dat.setMasterPropertyTypes(dat.parseMasterProperty(openDat(DAT_PATHS.portal).getReader(0x39000001)));
    const local = openDat(DAT_PATHS.local);
    const get = (id: number) => { try { return dat.parseLayoutDesc(local.getReader(id)); } catch { return null; } };
    desc = findElementByPath(dat.resolveLayoutDesc(get(TOOLBAR_LAYOUT)!, get), [EL_STACK_ENTRY]);
  });

  it('font 0x40000000, white, right-justified 2 px in from the right edge', () => {
    const s = textStyleFromDesc(desc);
    expect(s.font).toBe(0x40000000);
    expect(s.colorArgb >>> 0).toBe(0xffffffff);
    expect(s.hJustify).toBe(3);
    expect([s.marginLeft, s.marginRight]).toEqual([0, 2]);
  });
});

describe.skipIf(!hasDats)('the toolbar stack entry through DatEditField (happy-dom, DAT font)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    fx = await mountGameUI();
    ui = fx.ui;
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    ui.portalDb = portal;
    ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
    ui.uiManager.setScreen('game');
    ui.renderHUD();
  });
  afterAll(() => fx?.teardown());

  const select = (stackSize: number, id: number): void => {
    ui.hud.setTarget({
      id, name: 'Arrowhead', pluralName: 'Arrowheads', level: 0, healthFraction: 0,
      distance: 1, type: 'item', stackSize, isCoin: false,
    });
    ui.updateHUD();
  };
  const clear = (): void => { ui.hud.setTarget(null); ui.updateHUD(); };

  it('the entry is painted by one DatEditField layer: the <input> glyphs and caret are transparent', () => {
    const wrap = ui.targetStackEntryWrap as HTMLElement;
    const input = ui.targetStackEntry as HTMLInputElement;
    expect(wrap.querySelectorAll('.ac-dat-edit-layer').length).toBe(1);
    expect(input.dataset.acDatEdit).toBe('1');
    expect(input.style.color).toBe('transparent');
    expect(input.style.caretColor).toBe('transparent');
    const layer = wrap.querySelector('.ac-dat-edit-layer') as HTMLElement;
    expect([layer.style.left, layer.style.right]).toEqual(['0px', '2px']);
  });

  it('showing a stack lays the seeded count against the right edge (the hidden box had no width)', () => {
    clear();
    const wrap = ui.targetStackEntryWrap as HTMLElement;
    // happy-dom has no layout: give the box its 50 px.
    Object.defineProperty(wrap, 'clientWidth', { value: 50, configurable: true });
    select(5000, 0x80001234);
    const layer = wrap.querySelector('.ac-dat-edit-layer') as HTMLElement;
    const strip = layer.firstElementChild as HTMLElement;
    expect(strip.querySelector('canvas')).toBeTruthy();
    const width = ui.loadFontRenderer(0x40000000).measureText('5000');
    expect(width).toBeGreaterThan(0);
    expect(strip.style.left).toBe(`${48 - width}px`);
  });

  it('a commit that clamps the amount repaints the new digits right-justified', () => {
    const wrap = ui.targetStackEntryWrap as HTMLElement;
    const input = ui.targetStackEntry as HTMLInputElement;
    input.value = '0';
    input.dispatchEvent(new fx.win.Event('change', { bubbles: true }));
    expect(input.value).toBe('1');
    const strip = (wrap.querySelector('.ac-dat-edit-layer') as HTMLElement).firstElementChild as HTMLElement;
    expect(strip.style.left).toBe(`${48 - ui.loadFontRenderer(0x40000000).measureText('1')}px`);
  });

  it('the name 0x1000019f draws in its desc font 0x40000002: left-justified for a stack (state 0x1000000c), centred for one object (0x1000000b)', () => {
    clear();
    select(5000, 0x80001235);
    const host = ui.targetNameHost as HTMLElement;
    const label = host.firstElementChild as HTMLElement;
    expect(label.dataset.acFont).toBe('40000002');
    expect(label.dataset.acState).toBe('1000000c');
    expect(host.style.justifyContent).toBe('flex-start');
    expect(host.style.top).toBe('0px');
    select(1, 0x80001236);
    const single = host.firstElementChild as HTMLElement;
    expect(single.dataset.acFont).toBe('40000002');
    expect(single.dataset.acState).toBe('1000000b');
    expect(host.style.justifyContent).toBe('center');
  });

  it('the slider thumb 0x06005dc3 draws with no fill under its transparent corners', () => {
    ui.uiTextures.set(0x06005dc3, 'data:tex-thumb');
    ui.renderHUD();
    const thumb = ui.targetStackThumb as HTMLElement;
    expect(thumb.style.backgroundImage).toContain('data:tex-thumb');
    expect(['', 'transparent']).toContain(thumb.style.backgroundColor);
  });

  it('rebuilding the HUD releases the old field (one layer, not two)', () => {
    ui.renderHUD();
    const wrap = ui.targetStackEntryWrap as HTMLElement;
    expect(wrap.querySelectorAll('.ac-dat-edit-layer').length).toBe(1);
  });
});
