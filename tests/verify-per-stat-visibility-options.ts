/**
 * FAITHFUL.488 — Per-stat visibility CharacterOptions.
 *
 *  Per ACE `reference/ACE/Source/ACE.Entity/Enum/CharacterOption.cs`:
 *    AllowOthersToSeeYourDateOfBirth      = 0x1C
 *    AllowOthersToSeeYourAge              = 0x1D
 *    AllowOthersToSeeYourChessRank        = 0x1E
 *    AllowOthersToSeeYourFishingSkill     = 0x1F
 *    AllowOthersToSeeYourNumberOfDeaths   = 0x20
 *    AllowOthersToSeeYourNumberOfTitles   = 0x28
 *
 *  ACE @finger / inspect handlers check each bit before revealing
 *  the corresponding field. Server-enforced; pure round-trip via
 *  FAITHFUL.372's setSingleCharacterOption.
 *
 *  DEBT.test-harness-hygiene: behavioural — the real GameUI statics plus the
 *  real renderOptionsPanel (happy-dom, stub layoutRenderer) Character tab.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const VISIBILITY: Array<[string, string, number]> = [
  ['Allow Others to See Your Date of Birth', 'allowSeeDateOfBirth', 0x1C],
  ['Allow Others to See Your Age', 'allowSeeAge', 0x1D],
  ['Allow Others to See Your Chess Rank', 'allowSeeChessRank', 0x1E],
  ['Allow Others to See Your Fishing Skill', 'allowSeeFishingSkill', 0x1F],
  ['Allow Others to See Your Number of Deaths', 'allowSeeNumberOfDeaths', 0x20],
  ['Allow Others to See Your Number of Titles', 'allowSeeNumberOfTitles', 0x28],
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

describe('FAITHFUL.488 — per-stat visibility options (behavioural)', () => {
  let H: GameUIFixture;
  const toggles: Array<{ code: number; on: boolean }> = [];
  beforeAll(async () => {
    H = await mountGameUI({ callbacks: { onCharacterOptionToggle: (code: number, on: boolean) => { toggles.push({ code, on }); } } });
    stubOptionsLayout(H.ui, H.win);
  }, 60_000);
  afterAll(() => H.teardown());

  // BUG.character-tab-not-retail — every Display* bit is clear in the
  // PlayerModule constructor's options2_ 0x00948700 (= ACE
  // CharacterOptions2.Default): a fresh character shares none of these.
  it.each(VISIBILITY)('%s key %s defaults to false', (_label, key) => {
    expect(H.mod.GameUI.OPTIONS_DEFAULTS[key as keyof typeof H.mod.GameUI.OPTIONS_DEFAULTS]).toBe(false);
  });

  it.each(VISIBILITY)('%s maps to CharacterOption 0x%s', (_label, key, opt) => {
    expect((H.mod.GameUI.OPTIONS_TO_CHARACTER_OPTION as Record<string, number>)[key]).toBe(opt);
  });

  it.each(VISIBILITY)('the Character tab renders a "%s" toggle row that round-trips its CharacterOption', (label, key, opt) => {
    const row = renderOptionsTab(H.ui, 'character').get(key);
    expect(row, key).toBeTruthy();
    expect(row!.textContent).toContain(label);
    expect(row!.dataset.optionOn).toBe('0'); // default false
    toggles.length = 0;
    row!.dispatchEvent(new H.win.Event('click', { bubbles: true }));
    expect(toggles).toEqual([{ code: opt, on: true }]);
  });
});
