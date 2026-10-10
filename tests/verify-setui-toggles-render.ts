/**
 * FAITHFUL.446 — setUIState uses toggle methods so restore actually
 *  renders saved-state-open panels.
 *
 *  Pre-fix bug: setUIState (called by /loadui AND by FAITHFUL.444's
 *  startup restoreUIState) flipped the visibility boolean and then
 *  tried to manipulate `panelEl.style.display`. But the panel
 *  references are lazily created — they're null until first toggle.
 *  Result: when restoring a "panel was open" saved state, the boolean
 *  was set to true but the panel handle was null, so the display-style
 *  branch was a no-op and the panel stayed CLOSED until the player
 *  manually toggled it.
 *
 *  The toggle* methods each handle their own DOM (create-or-destroy +
 *  render). Calling them when current-state differs from desired-
 *  state correctly drives the panel to the right state regardless of
 *  whether the underlying handle exists.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

// state key (== visibility field) → the toggle method setUIState must route through.
const PAIRS: Array<[string, string]> = [
  ['inventoryVisible', 'toggleInventory'],
  ['magicVisible', 'toggleMagicPanel'],
  ['charPanelVisible', 'toggleCharPanel'],
  ['mapPanelVisible', 'toggleMapPanel'],
  ['socialPanelVisible', 'toggleSocialPanel'],
  ['optionsPanelVisible', 'toggleOptionsPanel'],
];

describe('FAITHFUL.446 — setUIState drives via toggle methods (behavioural, real GameUI.setUIState)', () => {
  let H: GameUIFixture;
  let calls: string[];
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());
  beforeEach(() => {
    calls = [];
    // Instance-level spies stand in for the toggles: each records the call and
    // flips its flag exactly like the real toggle's first line does.
    for (const [field, method] of PAIRS) {
      H.ui[field] = false;
      H.ui[method] = () => { calls.push(method); H.ui[field] = !H.ui[field]; };
    }
  });

  it.each(PAIRS)('%s: true on a closed panel → %s()', (field, method) => {
    H.ui.setUIState({ [field]: true });
    expect(calls).toEqual([method]);
    expect(H.ui[field]).toBe(true);
  });

  it('a state that already matches calls no toggle (no double-toggle)', () => {
    H.ui.setUIState(Object.fromEntries(PAIRS.map(([k]) => [k, false])));
    expect(calls).toEqual([]);
  });

  it('closing an open panel also routes through its toggle', () => {
    H.ui.inventoryVisible = true;
    H.ui.setUIState({ inventoryVisible: false, magicVisible: true });
    expect(calls).toEqual(['toggleInventory', 'toggleMagicPanel']);
  });

  it('keys absent from the saved state are left alone', () => {
    H.ui.setUIState({});
    expect(calls).toEqual([]);
  });
});

describe('FAITHFUL.446 — restore opens a never-opened panel through the real toggle', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  it('setUIState({ optionsPanelVisible: true }) with no panel handle yet leaves it open', () => {
    expect(H.ui.optionsPanelVisible).toBe(false);
    const real = H.ui.toggleOptionsPanel.bind(H.ui);
    let n = 0;
    H.ui.toggleOptionsPanel = () => { n++; real(); };
    H.ui.setUIState({ optionsPanelVisible: true });
    expect(n).toBe(1);
    expect(H.ui.optionsPanelVisible).toBe(true);
  });
});
