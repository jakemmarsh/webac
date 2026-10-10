/**
 * FAITHFUL.487 — Combat-flow CharacterOptions in Options panel.
 *
 *  Per ACE `reference/ACE/Source/ACE.Entity/Enum/CharacterOption.cs`:
 *    KeepCombatTargetsInView = 0x07 (ViewCombatTarget) — camera tracks
 *      the current target during combat.
 *    UseChargeAttack         = 0x19 (UseChargeAttack) — enables the
 *      charge-attack mechanic on melee swings.
 *    LeadMissileTargets      = 0x2A (LeadMissileTargets) — auto-leads
 *      moving targets when firing bows/crossbows.
 *    UseFastMissiles         = 0x2B (UseFastMissiles) — increased
 *      projectile speed setting.
 *
 *  All four are server-enforced — ACE Player_Missile.cs / Player_
 *  Combat.cs check the bits at action time. Pure round-trip via
 *  FAITHFUL.372's setSingleCharacterOption.
 *
 *  The DEFAULTS and OPTIONS_TO_CHARACTER_OPTION checks below are
 *  real behavioral assertions against `GameUI.OPTIONS_DEFAULTS` /
 *  `GameUI.OPTIONS_TO_CHARACTER_OPTION` — both public `static
 *  readonly` fields, so no instance is needed (only the happy-dom
 *  shim to make the module importable, same as every other
 *  GameUI-import test in this suite). The Options-panel-rows check
 *  stays a source citation: `renderOptionsPanel` early-returns
 *  without a DAT-parsed `layoutRenderer`, so the actual `addToggleRow`
 *  DOM calls have no exported test seam in this DAT-free suite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { mountGameUI, stubLayoutRender, type GameUIFixture } from './_harness/gameui.js';


const COMBAT: Array<[string, string, number, boolean]> = [
  ['Keep Combat Targets in View', 'keepCombatTargetsInView', 0x07, false],
  ['Use Charge Attack', 'useChargeAttack', 0x19, true],
  ['Lead Missile Targets', 'leadMissileTargets', 0x2A, true],
  ['Use Fast Missiles', 'useFastMissiles', 0x2B, false],
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.487 — DEFAULTS + OPTIONS_TO_CHARACTER_OPTION (behavioral, requires happy-dom devDep)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it.each(COMBAT)('OPTIONS_DEFAULTS.%s (%s) defaults to %s', (_label, key, _opt, def) => {
    expect(GameUICtor.OPTIONS_DEFAULTS[key]).toBe(def);
  });

  it.each(COMBAT)('OPTIONS_TO_CHARACTER_OPTION.%s (%s) maps to CharacterOption 0x%s', (_label, key, opt) => {
    expect(GameUICtor.OPTIONS_TO_CHARACTER_OPTION[key]).toBe(opt);
  });
});

/** Render the real options panel page `tab` through a stub layout renderer
 *  (every element id resolves) and return option key → row text. */
function renderOptionsPage(H: GameUIFixture, tab: string): Map<string, string> {
  H.ui.getTexURL = () => null;
  H.ui.layoutRenderer = {
    renderPanel: (_id: number, parent: HTMLElement) => {
      const root = H.win.document.createElement('div') as HTMLElement;
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      return {
        root,
        elements: {
          get: (id: number) => {
            let el = elements.get(id);
            if (!el) { el = H.win.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
            return el;
          },
          set: () => {},
        },
        setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
      };
    },
    render: stubLayoutRender(H.win.document),
  };
  H.ui.optionsTab = tab;
  H.ui.renderOptionsPanel();
  const out = new Map<string, string>();
  for (const row of H.ui.optionsPanel.querySelectorAll('[data-option-key]') as NodeListOf<HTMLElement>) {
    out.set(row.dataset.optionKey!, (row.textContent ?? '').trim());
  }
  return out;
}

describe('FAITHFUL.487 — Options-panel rows (behavioural, real renderOptionsPanel)', () => {
  let H: GameUIFixture;
  const rows = new Map<string, string>();
  beforeAll(async () => {
    H = await mountGameUI();
    for (const tab of ['gameplay', 'character', 'chat', 'config']) {
      for (const [k, v] of renderOptionsPage(H, tab)) rows.set(k, v);
    }
  });
  afterAll(() => H.teardown());

  it.each(COMBAT)('a toggle row labelled %s is bound to optionsSettings.%s', (label, key) => {
    expect(rows.get(key)).toBe(label);
  });
});
