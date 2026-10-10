/**
 * FAITHFUL.485 — Privacy + request-handling CharacterOptions in the
 *  Options panel.
 *
 *  Per ACE `reference/ACE/Source/ACE.Entity/Enum/CharacterOption.cs`:
 *    IgnoreAllegianceRequests = 0x01
 *    IgnoreFellowshipRequests = 0x02
 *    IgnoreAllTradeRequests   = 0x03
 *    LetOtherPlayersGiveYouItems = 0x06
 *    AppearOffline            = 0x27
 *
 *  All five are server-enforced — ACE checks the bit before
 *  delivering allegiance/fellowship/trade requests, gifts, or
 *  login-status broadcasts. The client just provides the toggle UI
 *  and round-trips via FAITHFUL.372's setSingleCharacterOption.
 *
 *  Closes more of the "CharacterOption toggles not exposed in UI"
 *  gap discovered across FAITHFUL.482-484.
 *
 *  The DEFAULTS and OPTIONS_TO_CHARACTER_OPTION checks below are
 *  real behavioral assertions against `GameUI.OPTIONS_DEFAULTS` /
 *  `GameUI.OPTIONS_TO_CHARACTER_OPTION` — both public `static
 *  readonly` fields, so no instance is needed (only the happy-dom
 *  shim to make the module importable, same as every other
 *  GameUI-import test in this suite).
 *
 *  DEBT.test-harness-hygiene: the Options-panel rows are behavioural too — a
 *  stub layoutRenderer (as in verify-options-panel-behavioral.ts) lets the
 *  real renderOptionsPanel build the Character tab, where these rows live.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const PRIVACY: Array<[string, string, number, boolean]> = [
  // [label, optionsKey, characterOption, default]
  ['Ignore Allegiance Requests', 'ignoreAllegianceRequests', 0x01, false],
  ['Ignore Fellowship Requests', 'ignoreFellowshipRequests', 0x02, true],
  ['Ignore All Trade Requests', 'ignoreTradeRequests', 0x03, false],
  ['Let Other Players Give You Items', 'allowGive', 0x06, true],
  ['Appear Offline', 'appearOffline', 0x27, false],
];

// Options panel 0x2100002b element ids renderOptionsPanel touches (mirrors
// verify-options-panel-behavioral.ts's stub layoutRenderer).
const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];

/** Stub LayoutRenderer so the real renderOptionsPanel builds its tab content in happy-dom. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubOptionsLayout(ui: any, win: any): void {
  const doc = win.document;
  if (typeof win.requestAnimationFrame !== 'function') win.requestAnimationFrame = () => 0;
  ui.layoutRenderer = {
    renderPanel: (_layoutId: number, parent: HTMLElement) => {
      const root = doc.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      for (const id of OPT_IDS) {
        const el = doc.createElement('div');
        root.appendChild(el);
        elements.set(id, el);
        if (id === 0x10000211) {
          for (const bid of [0x100001fc, 0x100001fd, 0x100001fe]) {
            const btn = doc.createElement('div');
            btn.dataset.elementId = `0x${bid.toString(16)}`;
            for (const sid of [0x100002ce, 0x100002cf, 0x100002d0]) {
              const slice = doc.createElement('div');
              slice.dataset.elementId = `0x${sid.toString(16)}`;
              btn.appendChild(slice);
            }
            el.appendChild(btn);
          }
        }
      }
      return {
        root, elements,
        setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render: (id: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(id, parent),
  };
}

/** Render one Options tab and return its toggle rows keyed by option key. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderOptionsTab(ui: any, tab: string): Map<string, HTMLElement> {
  ui.optionsTab = tab;
  if (!ui.optionsPanelVisible) ui.toggleOptionsPanel();
  else ui.renderOptionsPanel();
  const rows = new Map<string, HTMLElement>();
  for (const row of ui.optionsPanel.querySelectorAll('.option-toggle-row') as NodeListOf<HTMLElement>) {
    rows.set(row.dataset.optionKey!, row);
  }
  return rows;
}

describe('FAITHFUL.485 — privacy + request-handling options (behavioural)', () => {
  let H: GameUIFixture;
  const toggles: Array<{ code: number; on: boolean }> = [];
  beforeAll(async () => {
    H = await mountGameUI({ callbacks: { onCharacterOptionToggle: (code: number, on: boolean) => { toggles.push({ code, on }); } } });
    stubOptionsLayout(H.ui, H.win);
  }, 60_000);
  afterAll(() => H.teardown());

  it.each(PRIVACY)('OPTIONS_DEFAULTS.%s (%s) defaults to %s', (_label, key, _opt, def) => {
    expect((H.mod.GameUI.OPTIONS_DEFAULTS as Record<string, unknown>)[key]).toBe(def);
  });

  it.each(PRIVACY)('OPTIONS_TO_CHARACTER_OPTION.%s (%s) maps to CharacterOption 0x%s', (_label, key, opt) => {
    expect((H.mod.GameUI.OPTIONS_TO_CHARACTER_OPTION as Record<string, number>)[key]).toBe(opt);
  });

  // BUG.character-tab-not-retail — retail's Character page has no "Privacy &
  // Requests" section: the request toggles sit under Grouping / Other
  // Players (gmCharacterSettingsUI::InitOptions), and Appear Offline is the
  // Friends panel's checkbox, not a Character-page row.
  it('the request rows sit under their retail section headers; Appear Offline is not on the page', () => {
    const rows = renderOptionsTab(H.ui, 'character');
    const text = H.ui.optionsPanel.textContent as string;
    expect(text).not.toContain('Privacy & Requests');
    const grouping = text.indexOf('Grouping');
    const other = text.indexOf('Other Players');
    expect(grouping).toBeGreaterThanOrEqual(0);
    expect(other).toBeGreaterThan(grouping);
    for (const label of ['Ignore Allegiance Requests', 'Ignore Fellowship Requests']) {
      expect(text.indexOf(label)).toBeGreaterThan(grouping);
      expect(text.indexOf(label)).toBeLessThan(other);
    }
    for (const label of ['Let Other Players Give You Items', 'Ignore All Trade Requests']) {
      expect(text.indexOf(label)).toBeGreaterThan(other);
    }
    expect(rows.has('appearOffline')).toBe(false);
  });

  it.each(PRIVACY.filter(([, key]) => key !== 'appearOffline'))('the Character tab renders a "%s" toggle row that round-trips its CharacterOption', (label, key, opt, def) => {
    const row = renderOptionsTab(H.ui, 'character').get(key);
    expect(row, key).toBeTruthy();
    expect(row!.textContent).toContain(label);
    expect(row!.dataset.optionOn).toBe(def ? '1' : '0');
    toggles.length = 0;
    row!.dispatchEvent(new H.win.Event('click', { bubbles: true }));
    expect(toggles).toEqual([{ code: opt, on: !def }]);
  });
});
