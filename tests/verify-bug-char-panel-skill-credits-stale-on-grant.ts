/**
 * BUG.char-panel-skill-credits-stale-on-grant — the character panel's "Skill
 * Credits Available" count (and the Train-button afford gating that reads
 * the same value) go stale on a bare AvailableSkillCredits/TotalSkillCredits
 * grant.
 *
 * ACE's AddSkillCredits (Player_Skills.cs:471-481) sends ONLY a bare
 * PrivateUpdatePropertyInt(AvailableSkillCredits) — no paired Level/
 * TotalExperience update — reachable via quest/emote skill-credit rewards
 * (EmoteManager.cs:167). main.ts's onPrivateUpdatePropertyInt wrote
 * playerState.xp.setSkillCredits(...) for the TotalSkillCredits/
 * AvailableSkillCredits keys and returned; it never called
 * gameUI.syncFromPlayerState()/gameUI.refreshCharPanel(), unlike the sibling
 * PropertyInt64 XP handler which does exactly that on TotalExperience/
 * AvailableExperience changes. this.charInfo.skillCredits (both the rendered
 * count in appendCharFooterBlock and the Train button's canAfford gate) is
 * populated ONLY inside syncFromPlayerState.
 *
 * Fix: main.ts's onPrivateUpdatePropertyInt now also calls
 * gameUI.syncFromPlayerState()+gameUI.refreshCharPanel() when the changed key
 * is TotalSkillCredits or AvailableSkillCredits (main.ts is a self-executing
 * bootstrap module that cannot be imported in a test environment, so the
 * glue call site itself isn't directly exercisable here — this test proves
 * the shared, importable half of the fix: that re-running
 * syncFromPlayerState()+refreshCharPanel() after a skill-credits mutation
 * makes the change show up in the rendered panel, behaviorally, with a real
 * PlayerState and a real GameUI instance in happy-dom, per CLAUDE.md "Never
 * Break Tests" — never a source-text pin).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('BUG.char-panel-skill-credits-stale-on-grant — syncFromPlayerState+refreshCharPanel (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PlayerState: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let container: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const gameUiMod = await import('../packages/renderer/src/ui/GameUI.js');
    const playerStateMod = await import('../packages/renderer/src/player/PlayerState.js');
    PlayerState = playerStateMod.PlayerState;

    container = domWindow.document.createElement('div');
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
    // Clear any panel DOM left attached by a prior test. renderCharPanel()
    // appends to `ui.hudContainer` (a persistent child of `container` created
    // once in the GameUI constructor), not `container` itself, so clearing
    // `container.innerHTML` alone would only detach hudContainer from the
    // document while leaving it (and its accumulated children) as the live
    // append target for every subsequent render — clear hudContainer directly.
    ui.hudContainer.innerHTML = '';
    ui.charPanelVisible = false;
    ui.charPanel = null;
    ui.charPanelHandle = null;
    ui.charPanelTab = 'attributes';
  });

  function panelText(): string {
    return (ui.charPanel as HTMLElement)?.textContent ?? '';
  }

  it('a bare AvailableSkillCredits grant updates the open panel via syncFromPlayerState+refreshCharPanel', () => {
    const state = new PlayerState();
    state.xp.setSkillCredits(2, 2);
    ui.syncFromPlayerState(state);
    ui.toggleCharPanel();
    expect(ui.charInfo.skillCredits).toBe(2);
    expect(panelText()).toContain('Skill Credits Available:2');

    // Simulate the quest/emote AddSkillCredits grant: a bare
    // PrivateUpdatePropertyInt(AvailableSkillCredits) with no paired
    // Level/TotalExperience update.
    state.xp.setSkillCredits(state.xp.totalSkillCredits, 5);
    ui.syncFromPlayerState(state);
    ui.refreshCharPanel();

    expect(ui.charInfo.skillCredits).toBe(5);
    expect(panelText()).toContain('Skill Credits Available:5');
    expect(panelText()).not.toContain('Skill Credits Available:2');
  });

  it('without re-syncing, a skill-credits mutation does NOT reach the rendered panel (proves the assertion above exercises the fix, not a tautology)', () => {
    const state = new PlayerState();
    state.xp.setSkillCredits(2, 2);
    ui.syncFromPlayerState(state);
    ui.toggleCharPanel();
    expect(panelText()).toContain('Skill Credits Available:2');

    state.xp.setSkillCredits(state.xp.totalSkillCredits, 5);
    // No syncFromPlayerState/refreshCharPanel call — this is the exact
    // pre-fix behavior (mutate playerState.xp, never re-render).
    expect(panelText()).toContain('Skill Credits Available:2');
    expect(panelText()).not.toContain('Skill Credits Available:5');
  });
});
