/**
 * FAITHFUL.441 — Drop the "Vivify Colors" Display row.
 *
 *  Double gap pre-fix:
 *  (a) The label was wrong. ACE
 *      `reference/ACE/Source/ACE.Entity/Enum/CharacterOption.cs:57-58`
 *      calls option 0x0E `VividTargetingIndicator` — a target-reticle
 *      brightness flag, NOT a global color setting. The label
 *      "Vivify Colors" was an invention.
 *  (b) No client-side target reticle exists to brighten. The round-
 *      trip-to-ACE persisted a server bit nobody could ever observe
 *      visually.
 *
 *  Per FAITHFUL.437's drop-dead-settings principle: removed. The
 *  vivifyColors key is dropped from DEFAULTS and from
 *  OPTIONS_TO_CHARACTER_OPTION so no SetSingleCharacterOption fires
 *  from this client. If the target indicator visual ever ships, both
 *  the row and the wiring can be re-added together.
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

describe('FAITHFUL.441 — vivifyColors removed (behavioural, real GameUI options panel)', () => {
  let H: GameUIFixture;
  let rows: Map<string, string>;
  beforeAll(async () => { H = await mountGameUI(); rows = renderedOptionRows(H); });
  afterAll(() => H.teardown());

  it('no Options tab renders a vivifyColors / "Vivify Colors" row', () => {
    expect(rows.has('vivifyColors')).toBe(false);
    expect([...rows.values()].some(l => /Vivify/i.test(l))).toBe(false);
  });

  it('OPTIONS_DEFAULTS no longer lists vivifyColors', () => {
    expect('vivifyColors' in H.mod.GameUI.OPTIONS_DEFAULTS).toBe(false);
  });

  it('OPTIONS_TO_CHARACTER_OPTION no longer lists vivifyColors; 0x0E is retail\'s own Vivid Targeting Indicator row', () => {
    expect('vivifyColors' in H.mod.GameUI.OPTIONS_TO_CHARACTER_OPTION).toBe(false);
    // BUG.character-tab-not-retail — 0x0E = VividTargetingIndicator (ACE
    // CharacterOption.cs:57-58) IS a row on retail's Character page
    // (gmCharacterSettingsUI::InitOptions, User Interface Display), so it
    // round-trips again under its real name and default (on).
    expect(H.mod.GameUI.OPTIONS_TO_CHARACTER_OPTION.vividTargetingIndicator).toBe(0x0E);
    expect(H.mod.GameUI.OPTIONS_DEFAULTS.vividTargetingIndicator).toBe(true);
    expect(rows.get('vividTargetingIndicator')).toBe('Vivid Targeting Indicator');
  });

  it('preserves the other Display rows (showHelm, showCloak, disableWeather)', () => {
    expect(rows.get('showHelm')).toContain('Show Your Helm or Head Gear');
    expect(rows.get('showCloak')).toContain('Show Your Cloak');
    expect(rows.get('disableWeather')).toContain('Disable Most Weather Effects');
  });
});
