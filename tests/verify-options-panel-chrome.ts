/**
 * VISUAL.options-panel-chrome — the Options list pages against retail
 * (options-character / -chat / -config A/B, 2026-10-04):
 *  - the rows are the DAT list box 0x100001fa's items (PlayerOptionPage::
 *    m_pOptionBox), packed from its top with no inset;
 *  - the column 0x100001fb beside it is the retail UIElement_Scrollbar
 *    (bindDatScrollbarWidget — blue thumb), not the hand-built green one;
 *  - PlayerOptionPage::OnOptionChanged @ 004f27d0: Apply 0x100001fc and
 *    Reset 0x100001fd are state 1 while OptionPage::Changed @ 004f2d60 holds
 *    (a page option differs from its saved value), else 0xd ghosted;
 *    Defaults 0x100001fe is never gated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('Options list page chrome (happy-dom + real LayoutRenderer)', () => {
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
  });
  afterAll(() => fx?.teardown());

  const el = (id: number): HTMLElement | null => {
    const page = document.querySelector('[data-element-id="0x10000211"]') as HTMLElement | null;
    return page?.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement | null;
  };
  const state = (id: number): string | undefined => el(id)?.dataset.acState;
  function openTab(tab: string): void {
    ui.optionsTab = tab;
    if (!ui.optionsPanelVisible) ui.toggleOptionsPanel(); else ui.renderOptionsPanel();
  }

  it('rows live in the DAT list box from its top; the DAT scrollbar widget fills 0x100001fb', () => {
    openTab('config');
    const list = el(0x100001fa)!;
    expect(list).toBeTruthy();
    const paper = list.firstElementChild as HTMLElement;
    expect(paper.children.length).toBeGreaterThan(5);
    expect(paper.style.padding === '' || paper.style.padding === '0px').toBe(true);
    const col = el(0x100001fb)!;
    // (visibility follows p121 hideDisabled — happy-dom has no layout, so
    // the page "fits"; live it shows on the overflowing pages)
    expect(col.children.length).toBeGreaterThan(0);
    // the retail track art, not the hand-built bar
    expect(col.style.backgroundImage).toContain('tex-6004c5f');
  });

  it('Apply / Reset ghost until a page option changes; Defaults stays live', () => {
    openTab('character');
    expect(state(0x100001fc)).toBe('d');
    expect(state(0x100001fd)).toBe('d');
    expect(state(0x100001fe)).toBe('1');
    const key = [...ui.optionsPageKeys].find((k: string) => typeof ui.optionsSettings[k] === 'boolean') as string;
    ui.optionsSettings[key] = !ui.optionsSettings[key];
    ui.saveOptionsSettings();
    expect(state(0x100001fc)).toBe('1');
    expect(state(0x100001fd)).toBe('1');
    // Reset restores the saved value → both ghost again
    el(0x100001fd)!.click();
    expect(state(0x100001fc)).toBe('d');
    expect(state(0x100001fd)).toBe('d');
    // a change, then Apply: the new value is the saved one → ghosted
    ui.optionsSettings[key] = !ui.optionsSettings[key];
    ui.saveOptionsSettings();
    expect(state(0x100001fc)).toBe('1');
    el(0x100001fc)!.click();
    expect(state(0x100001fc)).toBe('d');
    expect(state(0x100001fd)).toBe('d');
  });
});
