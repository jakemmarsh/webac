/**
 * FAITHFUL.442 — Drop dead "Sidestep Auto" + "Show Names" rows.
 *
 * Pre-fix both were toggles with no consumer anywhere in the
 * renderer:
 *
 *  - "Sidestep Auto" — our A/D inputs always strafe; there's no
 *    alternate-mode key check that reads this flag. The toggle did
 *    literally nothing.
 *  - "Show Names" — retail draws no name text in the 3D view at all
 *    (CORE.17.k.b.b.a.g.a/.b: the hovered object's name is the
 *    UIElementManager tooltip, the selected object's name is the
 *    toolbar's 0x1000019f field). Retail had no "show all names"
 *    mode; a toggle here would force-show every name in a WoW-style
 *    way that isn't retail-faithful.
 *
 * Per FAITHFUL.437's drop-dead-settings principle: removed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

/** Render every Options tab of the real renderOptionsPanel (DAT 0x2100002b,
 *  here with an auto-creating LayoutRenderer stand-in) and collect each
 *  toggle row by its data-option-key hook → its rendered label text. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderedOptionRows(H: GameUIFixture): Map<string, string> {
  const win = H.win;
  const renderPanel = (_layoutId: number, parent: HTMLElement) => {
    const wrapper = win.document.createElement('div');
    parent.appendChild(wrapper);
    const root = win.document.createElement('div');
    wrapper.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const get = elements.get.bind(elements);
    elements.get = (id: number) => {
      let el = get(id);
      if (!el) {
        el = win.document.createElement('div') as HTMLElement;
        el.dataset.elementId = `0x${id.toString(16)}`;
        root.appendChild(el);
        elements.set(id, el);
      }
      return el;
    };
    return {
      root, elements,
      setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
      setTexture: () => {}, onClick: () => {}, close: () => { wrapper.remove(); },
    };
  };
  H.ui.layoutRenderer = { renderPanel, render: renderPanel, setFontResolver: () => {} };
  const rows = new Map<string, string>();
  for (const tab of ['gameplay', 'character', 'chat', 'config']) {
    H.ui.optionsTab = tab;
    if (!H.ui.optionsPanelVisible) H.ui.toggleOptionsPanel();
    else H.ui.renderOptionsPanel();
    for (const row of H.ui.optionsPanel.querySelectorAll('.option-toggle-row') as NodeListOf<HTMLElement>) {
      rows.set(row.dataset.optionKey!, (row.textContent ?? '').trim());
    }
  }
  return rows;
}

describe('FAITHFUL.442 — dead Gameplay toggles removed (behavioural, real GameUI options panel)', () => {
  let H: GameUIFixture;
  let rows: Map<string, string>;
  beforeAll(async () => { H = await mountGameUI(); rows = renderedOptionRows(H); });
  afterAll(() => H.teardown());

  it('the options panel renders toggle rows', () => {
    expect(rows.size).toBeGreaterThan(10);
  });

  it('no longer renders a Sidestep Auto row', () => {
    expect(rows.has('sidestepAuto')).toBe(false);
    expect([...rows.values()].some(l => /Sidestep Auto/i.test(l))).toBe(false);
  });

  it('no longer renders a Show Names row', () => {
    expect(rows.has('showNames')).toBe(false);
    expect([...rows.values()].some(l => /^Show Names$/i.test(l))).toBe(false);
  });

  it('preserves the live wired toggles (Auto Target, Run as Default Movement, Display 3D Tooltips)', () => {
    expect(rows.get('autoTarget')).toContain('Auto Target');
    expect(rows.get('runAsDefault')).toContain('Run as Default Movement');
    expect(rows.get('showTooltips')).toContain('Display 3D Tooltips');
  });

  it('OPTIONS_DEFAULTS no longer lists sidestepAuto / showNames', () => {
    expect('sidestepAuto' in H.mod.GameUI.OPTIONS_DEFAULTS).toBe(false);
    expect('showNames' in H.mod.GameUI.OPTIONS_DEFAULTS).toBe(false);
  });
});
