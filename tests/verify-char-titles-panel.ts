/**
 * The Titles page and the character header's title (VISUAL.titles-list-vs-retail,
 * VISUAL.char-panel-title-and-skill-rows), against gmCharacterTitleUI and
 * gmStatManagementUI::UpdateCharacterInfo @ 004f0770:
 *  - rows come from the list template 0x2100005e:0x10000536 (dark tile
 *    0x06004cca, text 0x10000537), sorted by name (FindSortedInsertPosition);
 *  - Refresh @ 0049abc0 leaves nothing selected; UpdateButtons @ 0049a500
 *    enables "Set as Display Title" only for a selected row that is not the
 *    display title; an unknown display title reads "Unknown";
 *  - the header's heritage line is the gender + heritage, then " " + the
 *    display title ("Male Aluvian Adventurer").
 * (Wording/selection wiring also in verify-char-titles-behavioral.ts.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('titles page + header title (happy-dom + real LayoutRenderer)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    ui = fx.ui;
    ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
    ui.charInfo = { ...ui.charInfo, name: 'Probe', gender: 'Male', heritage: 'Aluvian' };
  });
  afterAll(() => fx?.teardown());

  const rows = (): HTMLElement[] => [...document.querySelectorAll('.ac-title-row')] as HTMLElement[];
  const btnState = (): string | undefined => (document.querySelector('[data-element-id="0x10000535"]') as HTMLElement)?.dataset.acState;
  function openTitles(): void {
    ui.charPanelTab = 'titles';
    if (!ui.charPanelVisible) ui.toggleCharPanel(); else ui.renderCharPanel();
  }

  it('rows from the DAT template, sorted; nothing pre-selected; Set ghosted', () => {
    ui.setTitlesData([{ id: 3, name: 'Wanderer' }, { id: 1, name: 'Adventurer' }, { id: 2, name: 'Sentinel' }], 1);
    openTitles();
    expect(rows().map((r) => r.dataset.titleId)).toEqual(['1', '2', '3']);
    expect(rows()[0].querySelector('[data-element-id="0x10000536"]')).toBeTruthy();
    expect(rows().some((r) => r.dataset.selected === '1')).toBe(false);
    expect(btnState()).toBe('d');
    // the list box keeps its own DAT media (retail's darker box)
    const list = document.querySelector('[data-element-id="0x10000532"]') as HTMLElement;
    expect(list.style.backgroundImage).toContain('tex-6004cc2');
    // the headings take their own p35 = 6 left margin (CalcJustification)
    const heading = document.querySelector('[data-element-id="0x1000052e"] > .layout-text') as HTMLElement;
    expect(heading.style.padding).toBe('0px 0px 0px 6px');
  });

  it('selecting the current display title keeps Set ghosted; another title enables it', () => {
    openTitles();
    rows()[0].click(); // Adventurer = the display title
    expect(btnState()).toBe('d');
    rows()[1].click();
    expect(btnState()).toBe('1');
  });

  it('the header line carries the display title (UpdateCharacterInfo); "Unknown" when it does not resolve', () => {
    expect(ui.charHeritageLine()).toBe('Male Aluvian Adventurer');
    ui.setTitlesData([{ id: 2, name: 'Sentinel' }], 99);
    expect(ui.charHeritageLine()).toBe('Male Aluvian');
    openTitles();
    const shown = [...document.querySelectorAll('[data-element-id="0x1000052f"] [data-ac-run-text], [data-element-id="0x1000052f"] [data-ac-text]')] as HTMLElement[];
    expect(shown.map((e) => e.dataset.acRunText ?? e.dataset.acText ?? e.textContent).join('')).toContain('Unknown');
  });

  it('stat rows draw their name / value as the row template 0x21000045:0x10000248 descs draw them (font + p27 table)', async () => {
    const { descRef } = await import('../packages/renderer/src/ui/DatTextStyle.js');
    ui.charInfo = { ...ui.charInfo, attributes: { ...ui.charInfo.attributes, strength: { base: 50, buffed: 60, ranks: 0, xpSpent: 0 } } };
    ui.charPanelTab = 'attributes';
    if (!ui.charPanelVisible) ui.toggleCharPanel(); else ui.renderCharPanel();
    const named = [...document.querySelectorAll('[data-ac-desc]')] as HTMLElement[];
    const name = named.find((e) => e.dataset.acDesc === descRef(0x21000045, 0x10000248, 0x1000012a));
    const value = named.find((e) => e.dataset.acDesc === descRef(0x21000045, 0x10000248, 0x1000012b));
    expect(name).toBeTruthy();
    expect(value).toBeTruthy();
    // The template label font (the 0x2100003f:0x10000377 base), not the smaller UI default.
    expect(name!.dataset.acFont).toBe(value!.dataset.acFont);
    expect(name!.dataset.acFont).not.toBe('40000000');
  });
});
