/**
 * VISUAL.chargen-skills-list-rows.b — the chargen listboxes' scrollbars are
 * live, not static chrome.
 *
 * Ground truth (DAT 0x21000048 / 0x2100004b / 0x2100004c + the decomp):
 *  - the Skills list 0x100003f7 carries p114 = 0x100003f8 and the Summary
 *    list 0x10000400 p114 = 0x10000401 (UIElement_Scrollable's vertical
 *    scrollbar id); both bars inherit 0x2100004c:0x100002dc and override
 *    p121 (hideDisabled) to false.
 *  - 0x100002dc: p130 (SetProportional) = false → the 37x39 gem 0x06004d34
 *    keeps its size; track 0x06004d33; one media per arrow button.
 *  - UIElement_Scrollbar::HandleButtonClick → HandleMoveSteps broadcasts
 *    0xd / 0xe; UIElement_Scrollable::HandleScrollbarMessage_ asks
 *    UIElement_ListBox::InqScrollDelta @ 0046dc10: content height / rows,
 *    capped at the viewport height.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import {
  listBoxScrollDelta, textScrollDelta, CHARGEN_SCROLLBAR_SKIN, CHARGEN_FRAME_SCROLLBAR,
  hideNativeScrollbar, NATIVE_SCROLLBAR_HIDDEN_CLASS,
} from '../packages/renderer/src/ui/DatFrame.js';
import { descRef } from '../packages/renderer/src/ui/DatTextStyle.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, openChargen, type GameUIFixture } from './_harness/gameui.js';
import { loadDomWindow } from './_harness/dom.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe('UIElement_ListBox::InqScrollDelta — one arrow step', () => {
  it('is the content height over the row count', () => {
    expect(listBoxScrollDelta(26 * 40, 40, 309)).toBe(26);
    expect(listBoxScrollDelta(1000, 40, 309)).toBe(25);
  });
  it('is capped at the viewport height, and zero with no rows', () => {
    expect(listBoxScrollDelta(900, 2, 309)).toBe(309);
    expect(listBoxScrollDelta(0, 0, 309)).toBe(0);
  });
});

describe('UIElement_Text::InqScrollDelta — one arrow step', () => {
  it('is the glyph-line height, capped at the element region height', () => {
    expect(textScrollDelta(16, 450)).toBe(16);
    expect(textScrollDelta(16, 10)).toBe(10);
    expect(textScrollDelta(0, 450)).toBe(0);
  });
});

describe('the chargen scrollbar skin is the 0x100002dc widget', () => {
  it('37 px wide, 17 px buttons, the 37x39 gem at a fixed size, track 0x06004d33', () => {
    expect(CHARGEN_SCROLLBAR_SKIN.width).toBe(37);
    expect(CHARGEN_SCROLLBAR_SKIN.buttonHeight).toBe(17);
    expect(CHARGEN_SCROLLBAR_SKIN.track).toBe(0x06004d33);
    expect(CHARGEN_SCROLLBAR_SKIN.thumb).toEqual({ tex: 0x06004d34, height: 39 });
    expect(CHARGEN_SCROLLBAR_SKIN.up[0]).toBe(CHARGEN_FRAME_SCROLLBAR.topButton);
    expect(CHARGEN_SCROLLBAR_SKIN.down[0]).toBe(CHARGEN_FRAME_SCROLLBAR.bottomButton);
  });
});

describe('a viewport with a DAT scrollbar hides the native one', () => {
  it('sets scrollbar-width none, tags the WebKit class, and installs the rule once', async () => {
    const win = await loadDomWindow();
    const doc = win.document as Document;
    const a = doc.createElement('div');
    const b = doc.createElement('div');
    hideNativeScrollbar(a);
    hideNativeScrollbar(b);
    for (const el of [a, b]) {
      expect(el.style.getPropertyValue('scrollbar-width')).toBe('none');
      expect(el.classList.contains(NATIVE_SCROLLBAR_HIDDEN_CLASS)).toBe(true);
    }
    const rules = doc.head.querySelectorAll('style#layout-scroll-style');
    expect(rules.length).toBe(1);
    expect(rules[0].textContent).toContain(`.${NATIVE_SCROLLBAR_HIDDEN_CLASS}::-webkit-scrollbar { display: none; }`);
    await win.happyDOM?.close?.();
  });
});

describe.skipIf(!hasDats)('chargen listbox scrollbars (happy-dom)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let skillTable: any; let charGen: any; let layoutRenderer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let portal: any; let lineHeightOf: (did: number) => number;

  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    portal = openDat(DAT_PATHS.portal);
    const { ACFont } = await import('../packages/dat-parser/src/file-types/ACFont.js');
    const { ACFontRenderer } = await import('../packages/renderer/src/ui/ACFontRenderer.js');
    lineHeightOf = (did) => new ACFontRenderer(ACFont.read(portal.getReader(did))).lineHeight;
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000002)));
    skillTable = new dat.SkillTable(portal.getReader(0x0e000004));
    const { CharacterGenerator } = await import('../packages/dat-parser/src/file-types/CharacterGenerator.js');
    charGen = new CharacterGenerator(portal.getReader(0x0e000002));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    layoutRenderer = new LayoutRenderer(local, tex as never, null);
  });
  afterAll(() => fx?.teardown());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function openStep(step: number): { ui: any; container: HTMLElement } {
    const { ui, container } = fx;
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.portalDb = portal;
    ui.layoutRenderer = layoutRenderer;
    ui.skillTable = skillTable;
    ui.charGen = charGen;
    ui.paintChargenShadeDisk = () => {};
    ui.renderChargenPreview = () => {};
    ui.renderChargenSummaryView = () => {};
    openChargen(ui);
    ui.wizard.currentStep = step;
    ui.renderCharacterCreate();
    return { ui, container };
  }
  /** happy-dom lays nothing out: give the column and the list their DAT sizes. */
  const layOut = (bar: HTMLElement, list: HTMLElement, content: number, viewport: number, top = 0): void => {
    Object.defineProperty(bar, 'clientHeight', { value: parseInt(bar.style.height, 10), configurable: true });
    Object.defineProperty(list, 'scrollHeight', { value: content, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: viewport, configurable: true });
    list.scrollTop = top;
    list.dispatchEvent(new Event('scroll'));
  };
  const thumbOf = (bar: HTMLElement): HTMLElement => bar.querySelector('[data-dat-thumb="1"]') as HTMLElement;
  const btn = (bar: HTMLElement, dir: 'up' | 'down'): HTMLElement => bar.querySelector(`[data-dat-scroll-btn="${dir}"]`) as HTMLElement;

  it('Skills: bar 0x100003f8 is the live widget in the chargen art, its gem fixed at 37x39', () => {
    const { container } = openStep(2);
    const bar = container.querySelector('.chargen-skill-scrollbar') as HTMLElement;
    const list = container.querySelector('.chargen-skill-listbox') as HTMLElement;
    expect(bar.style.backgroundImage).toContain('tex:6004d33');
    expect(btn(bar, 'up').style.backgroundImage).toContain('tex:6004d35');
    expect(btn(bar, 'down').style.backgroundImage).toContain('tex:6004d36');
    expect(btn(bar, 'up').style.height).toBe('17px');
    const thumb = thumbOf(bar);
    expect(thumb.querySelector('div')!.style.backgroundImage).toContain('tex:6004d34');
    // Overflowing list: 307 px column → 273 px track, 234 px of gem travel.
    layOut(bar, list, 1200, 309);
    expect(thumb.style.height).toBe('39px');
    expect(thumb.style.top).toBe('17px');
    layOut(bar, list, 1200, 309, (1200 - 309) / 2);
    expect(thumb.style.top).toBe(`${17 + 117}px`);
    layOut(bar, list, 1200, 309, 1200 - 309);
    expect(thumb.style.top).toBe(`${17 + 234}px`);
    expect(bar.style.display).toBe('');
    // The DAT bar is the only one: the browser's native bar is hidden.
    expect(list.style.getPropertyValue('scrollbar-width')).toBe('none');
    expect(list.classList.contains(NATIVE_SCROLLBAR_HIDDEN_CLASS)).toBe(true);
  });

  it('Skills: the arrows step the list one row (content height / rows), down then up', () => {
    const { container } = openStep(2);
    const bar = container.querySelector('.chargen-skill-scrollbar') as HTMLElement;
    const list = container.querySelector('.chargen-skill-listbox') as HTMLElement;
    const rows = list.children.length;
    expect(rows).toBeGreaterThan(12);
    layOut(bar, list, rows * 26, 309);
    let top = 0;
    Object.defineProperty(list, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, v); }, configurable: true });
    btn(bar, 'down').click();
    expect(top).toBe(26);
    btn(bar, 'down').click();
    expect(top).toBe(52);
    btn(bar, 'up').click();
    expect(top).toBe(26);
  });

  it('a list that fits keeps the bar (p121 = false) with the gem parked under the up arrow', () => {
    const { container } = openStep(2);
    const bar = container.querySelector('.chargen-skill-scrollbar') as HTMLElement;
    const list = container.querySelector('.chargen-skill-listbox') as HTMLElement;
    layOut(bar, list, 200, 309);
    expect(bar.style.display).toBe('');
    expect(thumbOf(bar).style.top).toBe('17px');
  });

  // The profession description 0x100003e0, the skills instruction 0x100003fd
  // and the town description 0x10000409 inherit 0x2100004c:0x100002e4, which
  // names no p114 bar: retail clips them. They must not scroll natively.
  it('the bar-less framed texts (0x100002e4) clip like retail, never scroll natively', () => {
    const { container: prof } = openStep(1);
    expect((prof.querySelector('.profession-description') as HTMLElement).style.overflow).toBe('hidden');
    const { container: skills } = openStep(2);
    const instr = skills.querySelector(`[data-frame-desc="${descRef(0x21000048, 0x100003fd)}"]`) as HTMLElement;
    const instrText = Array.from(instr.children).find((c) => !(c as HTMLElement).dataset.framePiece) as HTMLElement;
    expect(instrText.style.overflow).toBe('hidden');
    const { container: town } = openStep(4);
    const desc = town.querySelector('.town-description') as HTMLElement | null;
    expect(desc).toBeTruthy();
    expect(desc!.style.overflow).toBe('hidden');
  });

  it('Summary: bar 0x10000401 is bound to the list 0x10000400 the same way', () => {
    const { container } = openStep(5);
    const bar = container.querySelector('.summary-scrollbar') as HTMLElement;
    const list = container.querySelector('.summary-listbox') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(list).toBeTruthy();
    expect(bar.style.backgroundImage).toContain('tex:6004d33');
    const thumb = thumbOf(bar);
    // 450 px column → 416 px track, 377 px of travel.
    layOut(bar, list, 870, 435, 435);
    expect(thumb.style.height).toBe('39px');
    expect(thumb.style.top).toBe(`${17 + 377}px`);
    expect(list.style.getPropertyValue('scrollbar-width')).toBe('none');
  });
  // VISUAL.chargen-skills-list-rows.b.a — the 0x100002e6 framed texts' own bar
  // 0x100002e7 (p114) inherits 0x100002dc unchanged: p121 = true, so it hides
  // while the text fits; an arrow steps one glyph line of the text's font.
  const framed = (container: HTMLElement, desc: string): { bar: HTMLElement; text: HTMLElement } => {
    const frame = container.querySelector(`[data-frame-desc="${desc}"]`) as HTMLElement;
    const bar = frame.querySelector('.ac-dat-frame-scrollbar') as HTMLElement;
    const text = Array.from(frame.children).find((c) => c !== bar && !(c as HTMLElement).dataset.framePiece) as HTMLElement;
    return { bar, text };
  };
  /** The bar is anchored top/bottom 15 px inside its frame: 450 - 30 = 420 px. */
  const layOutFramed = (bar: HTMLElement, text: HTMLElement, column: number, content: number, viewport: number, top = 0): void => {
    Object.defineProperty(bar, 'clientHeight', { value: column, configurable: true });
    Object.defineProperty(text, 'scrollHeight', { value: content, configurable: true });
    Object.defineProperty(text, 'clientHeight', { value: viewport, configurable: true });
    text.scrollTop = top;
    text.dispatchEvent(new Event('scroll'));
  };

  it('Heritage lore 0x100003c4: the 0x100002e7 bar is live, the gem tracks the lore text', () => {
    const { container } = openStep(0);
    const { bar, text } = framed(container, descRef(0x21000046, 0x100003c4));
    expect(text.classList.contains('heritage-lore')).toBe(true);
    expect(text.style.getPropertyValue('scrollbar-width')).toBe('none');
    expect(bar.style.backgroundImage).toContain('tex:6004d33');
    expect(btn(bar, 'up').style.backgroundImage).toContain('tex:6004d35');
    expect(btn(bar, 'down').style.backgroundImage).toContain('tex:6004d36');
    const thumb = thumbOf(bar);
    expect(thumb.querySelector('div')!.style.backgroundImage).toContain('tex:6004d34');
    // 420 px column → 386 px track, 347 px of gem travel.
    layOutFramed(bar, text, 420, 900, 420);
    expect(bar.style.display).toBe('');
    expect(thumb.style.top).toBe('17px');
    layOutFramed(bar, text, 420, 900, 420, 480);
    expect(thumb.style.top).toBe(`${17 + 347}px`);
  });

  it('Heritage lore: the arrows step one glyph line of font 0x40000008', () => {
    const { container } = openStep(0);
    const { bar, text } = framed(container, descRef(0x21000046, 0x100003c4));
    layOutFramed(bar, text, 420, 900, 420);
    let top = 0;
    Object.defineProperty(text, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, v); }, configurable: true });
    const line = lineHeightOf(0x40000008);
    expect(line).toBeGreaterThan(0);
    btn(bar, 'down').click();
    expect(top).toBe(line);
    btn(bar, 'down').click();
    expect(top).toBe(2 * line);
    btn(bar, 'up').click();
    expect(top).toBe(line);
  });

  it('a framed text that fits hides its whole bar (p121 = true), and shows it again on overflow', () => {
    const { container } = openStep(3);
    const { bar, text } = framed(container, descRef(0x21000049, 0x100003ab));
    layOutFramed(bar, text, 262, 200, 262);
    expect(bar.style.display).toBe('none');
    layOutFramed(bar, text, 262, 600, 262);
    expect(bar.style.display).toBe('');
  });

  it('Summary how-to 0x10000404: bound the same way, stepping a line of font 0x40000009', () => {
    const { container } = openStep(5);
    const { bar, text } = framed(container, descRef(0x2100004b, 0x10000404));
    expect(text.classList.contains('summary-howto')).toBe(true);
    layOutFramed(bar, text, 350, 700, 350);
    let top = 0;
    Object.defineProperty(text, 'scrollTop', { get: () => top, set: (v: number) => { top = Math.max(0, v); }, configurable: true });
    btn(bar, 'down').click();
    expect(top).toBe(lineHeightOf(0x40000009));
  });
});
