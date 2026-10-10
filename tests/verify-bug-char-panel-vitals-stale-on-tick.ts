/**
 * BUG.char-panel-vitals-stale-on-tick — Character panel Health/Stamina/Mana
 * rows go stale on every damage/heal/regen tick and on vital training.
 *
 * onPrivateUpdateVital (max-vital/training changes) and
 * onPrivateUpdateAttribute2ndLevel (current-vital changes from damage/heal/
 * regen ticks, per ACE Player_Vitals.cs UpdateVital sending
 * GameMessagePrivateUpdateAttribute2ndLevel) both wrote directly to
 * playerState.vitals and returned — neither called
 * gameUI.syncFromPlayerState()/gameUI.refreshCharPanel(), unlike every other
 * model-mutating handler that feeds the character panel
 * (onPrivateUpdateAttribute, onPrivateUpdateSkill). `this.charInfo.vitals` is
 * populated ONLY inside syncFromPlayerState, and renderVitalsOnly (which
 * draws the Attributes-tab Health/Stamina/Mana rows) reads exclusively from
 * charInfo.vitals — so with the panel open, taking damage / healing / mana
 * ticking / vital training updated the HUD (which reads playerState directly
 * every frame) but left the panel's rows frozen.
 *
 * Fix: added `GameUI.refreshVitalsPanel(state, levelXpTable)` — a single
 * named call wrapping syncFromPlayerState()+refreshCharPanel() — and wired
 * it into both main.ts vital-update call sites (main.ts is a self-executing
 * bootstrap module that cannot be imported in a test environment, so the
 * actual glue call sites aren't directly exercisable here; this test proves
 * the extracted, importable half of the fix — that refreshVitalsPanel makes
 * a real vitals mutation show up in the rendered panel — behaviorally, with
 * a real PlayerState and a real GameUI instance in happy-dom, rather than
 * regex-pinning source text per CLAUDE.md "Never Break Tests").
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { VitalId } from '@ac/shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('BUG.char-panel-vitals-stale-on-tick — refreshVitalsPanel (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PlayerState: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const gameUiMod = await import('../packages/renderer/src/ui/GameUI.js');
    const playerStateMod = await import('../packages/renderer/src/player/PlayerState.js');
    PlayerState = playerStateMod.PlayerState;

    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new gameUiMod.GameUI(container);

    // Permissive stub layout handle (GAP.39/GAP.36 recipe) — the self
    // character panel is layout 0x2100002e: tab container 0x10000227, the 3
    // tab buttons + close button, and the 3 tab content areas.
    const IDS = [0x10000227, 0x10000228, 0x10000229, 0x10000538, 0x1000022a, 0x10000539, 0x1000022b, 0x1000022c];
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        const chrome = (parentEl: HTMLElement, id: number, ...kids: HTMLElement[]): HTMLElement => {
          const el = domWindow.document.createElement('div');
          el.setAttribute('data-element-id', `0x${id.toString(16)}`);
          for (const k of kids) el.appendChild(k);
          parentEl.appendChild(el);
          return el;
        };
        for (const id of IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        // CORE.6 — the panes carry inherited DAT chrome ([data-element-id]
        // nodes) that renderStatPaneNative/renderTitlesPaneNative bind into;
        // mirror the chrome ids the renderers touch.
        for (const paneId of [0x1000022b, 0x1000022c]) {
          const pane = elements.get(paneId)!;
          const page = chrome(pane, 0x10000226);
          for (const id of [0x10000231, 0x10000232, 0x10000233, 0x100005c5, 0x100005c6, 0x10000234, 0x10000235]) chrome(page, id);
          const mk = (id: number): HTMLElement => { const d = domWindow.document.createElement('div'); d.setAttribute('data-element-id', `0x${id.toString(16)}`); return d; };
          chrome(page, 0x10000236, mk(0x2), mk(0x10000237), mk(0x10000238));
          for (const id of [0x1000023a, 0x1000023b, 0x1000023d, 0x1000023e, 0x10000247, 0x10000240, 0x10000241]) chrome(page, id);
        }
        const titlesPane = elements.get(0x10000539)!;
        for (const id of [0x1000052e, 0x1000052f, 0x10000531, 0x10000532, 0x10000533, 0x10000535]) chrome(titlesPane, id);
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      render: (_layoutId: number, parent: HTMLElement) => (ui.layoutRenderer.renderPanel(_layoutId, parent)),
    };
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    ui.charPanelVisible = false;
    ui.charPanel = null;
    ui.charPanelHandle = null;
    ui.charPanelTab = 'attributes';
  });

  function panelText(): string {
    return (ui.charPanel as HTMLElement)?.textContent ?? '';
  }

  it('a current-vital tick (damage/heal/regen) updates the open panel via refreshVitalsPanel', () => {
    const state = new PlayerState();
    state.vitals.initToMax(state.attributes); // Endurance=10 -> Health max 5, Stamina max 10; Self=10 -> Mana max 10
    ui.syncFromPlayerState(state);
    ui.toggleCharPanel();
    expect(panelText()).toContain('5/5'); // full health at init

    // Simulate a damage tick: server sends a bare current-value update.
    state.vitals.setCurrent(VitalId.Health, 2, state.attributes);
    ui.refreshVitalsPanel(state);

    expect(panelText()).toContain('2/5');
    expect(panelText()).not.toContain('5/5');
  });

  it('a max-vital update (training/raise) updates the open panel via refreshVitalsPanel', () => {
    const state = new PlayerState();
    state.vitals.initToMax(state.attributes);
    ui.syncFromPlayerState(state);
    ui.toggleCharPanel();
    expect(panelText()).toContain('10/10'); // full stamina at init

    // Simulate a training raise: Stamina raises pushed from 0 to 20.
    state.vitals.setRaises(VitalId.Stamina, 20);
    state.vitals.setCurrent(VitalId.Stamina, 30, state.attributes);
    ui.refreshVitalsPanel(state);

    expect(panelText()).toContain('30/30');
  });

  it('without calling refreshVitalsPanel, a vitals mutation does NOT reach the rendered panel (proves the assertions above exercise the fix, not a tautology)', () => {
    const state = new PlayerState();
    state.vitals.initToMax(state.attributes);
    ui.syncFromPlayerState(state);
    ui.toggleCharPanel();
    expect(panelText()).toContain('5/5');

    state.vitals.setCurrent(VitalId.Health, 1, state.attributes);
    // No refreshVitalsPanel/refreshCharPanel call — this is the exact
    // pre-fix behavior (mutate playerState.vitals, never re-render).
    expect(panelText()).toContain('5/5');
    expect(panelText()).not.toContain('1 / 5');
  });
});
