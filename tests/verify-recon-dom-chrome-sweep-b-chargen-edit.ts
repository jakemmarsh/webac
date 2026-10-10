// @vitest-environment node
/**
 * RECON.dom-chrome-sweep.b — the chargen edit fields (the profession page's
 * attribute value boxes 0x100002ef, the summary page's name field
 * 0x10000402) draw through DatEditField: the DAT glyphs, a 1-px caret in the
 * font colour, the selection and a click all on the DAT advances, not the
 * browser <input>'s font (which drifted off the glyphs as the name grew).
 *
 * The value box is right-justified (p20 = 3): DrawSelf offsets the glyph
 * line by CalcJustification and DeterminePositionFromXY @ 004688f0 takes
 * that offset back off a click (`FindPosFromLineAndPixels(scroll + x -
 * CalcJustification(width))`), so DatEditField now honours p20.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import { mountGameUI, openChargen, type GameUIFixture } from './_harness/gameui.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { CreateStep } from '../packages/renderer/src/ui/CharacterCreate.js';
import { attachDatEditField, type DatEditFont } from '../packages/renderer/src/ui/DatEditField.js';

const hasDats = fs.existsSync(DAT_PATHS.portal) && fs.existsSync(DAT_PATHS.local);

/** 6-px glyphs, 'W' 10 px. */
function fakeFont(): DatEditFont {
  return {
    lineHeight: 12,
    outlinePadding: { x: 1, y: 1 },
    measureText: (t: string) => Array.from(t).reduce((n, c) => n + (c === 'W' ? 10 : 6), 0),
    renderTextToCanvas: (t: string) => { const c = document.createElement('canvas'); c.dataset.text = t; return c; },
  };
}

describe('DatEditField horizontal justification (p20, CalcJustification)', () => {
  let fx: GameUIFixture;
  beforeAll(async () => { fx = await mountGameUI(); });
  afterAll(() => fx?.teardown());
  let cleanup: (() => void) | null = null;
  afterEach(() => { cleanup?.(); cleanup = null; });

  const mount = (hJustify: number, width: number) => {
    const host = document.createElement('div');
    host.style.position = 'absolute';
    Object.defineProperty(host, 'clientWidth', { value: width, configurable: true });
    fx.container.appendChild(host);
    const input = document.createElement('input');
    host.appendChild(input);
    const handle = attachDatEditField(input, host, { font: fakeFont(), color: 'rgb(255, 255, 255)', hJustify, now: () => 0 })!;
    cleanup = () => { handle.destroy(); host.remove(); };
    const strip = handle.layer.firstElementChild as HTMLElement;
    return { input, handle, strip };
  };

  it('p20 = 3 lays the line against the far edge; the caret follows the glyphs', () => {
    const { input, handle, strip } = mount(3, 47);
    input.value = '10';
    expect(strip.style.left).toBe('35px'); // 47 - 12
    input.focus();
    input.setSelectionRange(1, 1);
    handle.refresh();
    expect((handle.layer.querySelector('.ac-dat-edit-caret') as HTMLElement).style.left).toBe('6px');
  });

  it('p20 = 1 centres the line (an empty one too); the near edge stays at 0', () => {
    expect(mount(1, 47).strip.style.left).toBe('23px'); // empty: the caret sits at the centre
    cleanup?.();
    const c = mount(1, 47);
    c.input.value = 'aaa';
    expect(c.strip.style.left).toBe('14px'); // (47 >> 1) - (18 >> 1)
    cleanup?.();
    const n = mount(2, 47);
    n.input.value = 'aaa';
    expect(n.strip.style.left).toBe('0px');
  });

  it('a click takes the justification back off before the glyph hit-test (DeterminePositionFromXY)', () => {
    const { input, handle } = mount(3, 47);
    input.value = 'aW'; // 16 px wide → offset 31; a = 31..37, W = 37..47
    input.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 33, bubbles: true }));
    expect(input.selectionStart).toBe(0);
    input.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 35, bubbles: true }));
    expect(input.selectionStart).toBe(1);
    input.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: 43, bubbles: true }));
    expect(input.selectionStart).toBe(2);
    expect(handle.layer.dataset.acCaret).toBe('2');
  });

  it('text wider than the field drops the offset (the scrollable width is the text\'s)', () => {
    const { input, strip } = mount(3, 20);
    input.value = 'aaaaa'; // 30 px
    expect(strip.style.left).toBe('-12px'); // offset 0, scrolled to keep the end caret in view: 30 + 2 - 20
  });
});

describe.skipIf(!hasDats)('chargen edit fields through DatEditField (happy-dom, DAT fonts)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let skillTable: any; let charGen: any; let layoutRenderer: any; let portal: any;

  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    portal = openDat(DAT_PATHS.portal);
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
  const canvasText = (box: HTMLElement): string | undefined =>
    (box.querySelector('.ac-dat-edit-layer canvas') as HTMLCanvasElement | null) ? (box.querySelector('input') as HTMLInputElement).value : undefined;

  it('every attribute value box is a DatEditField: no browser caret, one painted layer, no SetText span or selection overlay', () => {
    const { container } = openStep(CreateStep.Profession);
    const boxes = Array.from(container.querySelectorAll('.attr-value')) as HTMLElement[];
    expect(boxes.length).toBe(6);
    for (const box of boxes) {
      const input = box.querySelector('.attr-value-input') as HTMLInputElement;
      expect(input.dataset.acDatEdit).toBe('1');
      expect(input.style.caretColor).toBe('transparent');
      expect(box.querySelectorAll('.ac-dat-edit-layer').length).toBe(1);
      expect(box.querySelector('.attr-value-selection')).toBeNull();
      expect(box.querySelector(':scope > [data-ac-text]')).toBeNull();
      expect(canvasText(box)).toBe(box.dataset.acValue);
    }
  });

  it('the value box paints the typed text, and a slider-driven SetText (refreshAttributeRows) repaints the field, not a span', () => {
    const { ui, container } = openStep(CreateStep.Profession);
    const box = container.querySelector('.attr-value[data-attr="strength"]') as HTMLElement;
    const input = box.querySelector('input') as HTMLInputElement;
    input.focus();
    input.value = '55';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(box.dataset.acValue).toBe('55');
    input.blur();
    expect(ui.wizard.attributes.strength).toBe(55);
    ui.wizard.setAttributeFromSlider('strength', 40);
    ui.refreshAttributeRows();
    expect(input.value).toBe('40');
    expect(box.dataset.acValue).toBe('40');
    expect(box.querySelector(':scope > [data-ac-text]')).toBeNull();
  });

  it('focus selects the value whole; the selection is the field\'s inverted box and data-ac-selected still tracks it', () => {
    const { container } = openStep(CreateStep.Profession);
    const box = container.querySelector('.attr-value[data-attr="focus"]') as HTMLElement;
    const input = box.querySelector('input') as HTMLInputElement;
    input.focus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, input.value.length]);
    expect(box.dataset.acSelected).toBe('1');
    expect((box.querySelector('.ac-dat-edit-selection') as HTMLElement).style.display).toBe('block');
    input.blur();
  });

  it('re-rendering the page releases the old fields (no listener / timer build-up)', () => {
    const { ui } = openStep(CreateStep.Profession);
    const first = [...ui.chargenEditFields];
    expect(first.length).toBe(6);
    ui.renderCharacterCreate();
    expect(ui.chargenEditFields.length).toBe(6);
    for (const h of first) expect(h.layer.isConnected).toBe(false);
  });

  it('the summary name field 0x10000402 is a DatEditField over its inset box: the prompt painted, the caret 1 px in the field colour', () => {
    const { ui, container } = openStep(CreateStep.Summary);
    const input = container.querySelector('#char-name-input') as HTMLInputElement;
    const box = input.parentElement as HTMLElement;
    expect(input.dataset.acDatEdit).toBe('1');
    expect(input.style.caretColor).toBe('transparent');
    expect(box.querySelector(':scope > [data-ac-text]')).toBeNull();
    expect(box.querySelector('.attr-value-selection')).toBeNull();
    const layer = box.querySelector('.ac-dat-edit-layer') as HTMLElement;
    // The box already carries the p35 / p36 margins and the line top.
    expect([layer.style.left, layer.style.right]).toEqual(['0px', '0px']);
    expect(input.value).toBe('[ Name ]');
    input.focus();
    input.value = 'Asheron';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.setSelectionRange(7, 7);
    ui.chargenEditFields.at(-1).refresh();
    expect(ui.wizard.name).toBe('Asheron');
    expect(box.dataset.acValue).toBe('Asheron');
    const caret = box.querySelector('.ac-dat-edit-caret') as HTMLElement;
    expect(caret.style.width).toBe('1px');
    expect(caret.style.display).toBe('block');
    // The caret sits at the DAT advance of "Asheron", not a browser font's.
    const style = ui.datTextStyleFor('0x2100004b:0x10000402') ?? ui.datTextStyleFor(input.dataset.acDesc);
    const font = ui.loadFontRenderer(style.font);
    expect(caret.style.left).toBe(`${font.measureText('Asheron')}px`);
    input.blur();
  });

  // RECON.dom-chrome-sweep.b.a — gmCGSummaryPage::Update: TakeFocus, then
  // SelectAll on the ID_CharGen_NamePrompt (retail-ab chargen-summary draws
  // "[ Name ]" inverted); DrawSelf inverts the whole prompt's glyph boxes.
  it('the summary opens with the name field focused and the prompt drawn selected whole; a focus loss drops it', () => {
    const { ui, container } = openStep(CreateStep.Summary);
    const input = container.querySelector('#char-name-input') as HTMLInputElement;
    const box = input.parentElement as HTMLElement;
    expect(document.activeElement).toBe(input);
    expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['[ Name ]', 0, 8]);
    const sel = box.querySelector('.ac-dat-edit-selection') as HTMLElement;
    const style = ui.datTextStyleFor(input.dataset.acDesc);
    const font = ui.loadFontRenderer(style.font);
    expect(sel.style.display).toBe('block');
    expect([sel.style.left, sel.style.width]).toEqual(['0px', `${font.measureText('[ Name ]')}px`]);
    expect(box.dataset.acSelected).toBe('1');
    input.blur();
    expect(sel.style.display).toBe('none');
    expect(box.dataset.acSelected).toBe('0');
  });
});
