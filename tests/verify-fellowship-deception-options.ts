/**
 * FAITHFUL.491 — 4 pure server-side CharacterOptions (deception +
 *  fellowship XP/loot/auto-accept).
 *
 *  Per ACE `reference/ACE/Source/ACE.Entity/Enum/CharacterOption.cs`:
 *    AttemptToDeceiveOtherPlayers          = 0x09 (UseDeception)
 *    ShareFellowshipExpAndLuminance        = 0x0F (FellowshipShareXP)
 *    ShareFellowshipLoot                   = 0x11 (FellowshipShareLoot)
 *    AutomaticallyAcceptFellowshipRequests = 0x12
 *
 *  All four are server-enforced (deception is a skill check on
 *  Inspect; fellowship XP/loot share happen in
 *  Fellowship.CalculateXPSharing / loot-roll routines; auto-accept
 *  fires on the request-arrival event). Pure round-trip via
 *  FAITHFUL.372.
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

const OPTS: Array<[string, string, number, boolean]> = [
  ['Attempt to Deceive Other Players', 'attemptToDeceiveOthers', 0x09, false],
  ['Share Fellowship Experience and Luminance', 'shareFellowshipXP', 0x0F, true],
  ['Share Fellowship Loot', 'shareFellowshipLoot', 0x11, false],
  ['Automatically Accept Fellowship Requests', 'autoAcceptFellowshipRequests', 0x12, false],
];

describe('FAITHFUL.491 — fellowship + deception options (behavioural, real GameUI)', () => {
  let H: GameUIFixture;
  let rows: Map<string, string>;
  beforeAll(async () => { H = await mountGameUI(); rows = renderedOptionRows(H); });
  afterAll(() => H.teardown());

  it.each(OPTS)('%s key %s: OPTIONS_DEFAULTS default', (_label, key, _opt, def) => {
    expect(H.mod.GameUI.OPTIONS_DEFAULTS[key]).toBe(def);
  });

  it.each(OPTS)('%s key %s maps to its ACE CharacterOption', (_label, key, opt) => {
    expect(H.mod.GameUI.OPTIONS_TO_CHARACTER_OPTION[key]).toBe(opt);
  });

  it.each(OPTS)('the Options panel renders a "%s" toggle row for %s', (label, key) => {
    expect(rows.get(key)).toContain(label);
  });
});
