/**
 * BUG.fellowship-quit-leaves-stale-panel — quitting (or being dismissed
 * from) a fellowship must return the panel to the you-do-not-belong create
 * state, not leave it rendering the member view.
 *
 * The server sends FellowshipQuit/Dismiss to the removed player too, with
 * that player's own guid (ACE Fellowship.cs:213,324,356). Pre-fix, the
 * client unconditionally called removeFellowshipMember(playerId), which
 * only filters the fellows[] list — fellowshipData stayed set, so the
 * panel kept the fellowship name, openness line, and all six member-state
 * buttons (live proof 2026-08-21: verification/playtest/
 * 2026-08-21T10-08-57-726Z-npc-fellowship f05 vs f06).
 *
 * Retail branches on the guid: ClientFellowshipSystem::
 * Handle_Fellowship__Quit / __Dismiss (acclient 0x569e90 / 0x569f10) —
 * guid == SmartBox::player_id → DeleteFellowship, else
 * Fellowship::RemoveFellow. GameUI.handleFellowshipQuitOrDismiss now
 * mirrors that; both main.ts handlers route through it with aceCharGuid.
 *
 * Behavioral: real GameUI + renderSocialPanel in happy-dom (recipe:
 * verify-fellowship-create-button.ts); drive the real handler and assert
 * the rendered panel state.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

// requestAnimationFrame/cancelAnimationFrame included: the member-state
// panel's vitals-bar sync loop (renderSocialPanel) schedules through them.
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

const OWN_GUID = 0x50000001;
const OTHER_GUID = 0x50000002;

function fellow(guid: number, name: string) {
  return { guid, name, level: 20, healthCurrent: 50, healthMax: 50, staminaCurrent: 60, staminaMax: 60, manaCurrent: 40, manaMax: 40, shareLoot: true };
}

describe('BUG.fellowship-quit-leaves-stale-panel — self quit/dismiss clears the panel (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'animationFrame');
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // Stub layout handle mirroring the resolved social container 0x21000031
    // with the fellowship pane's DAT-native chrome (CORE.5.c.d.b — the two
    // state sub-panes 0x10000275 / 0x1000026b under pane 0x10000292).
    const IDS = [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, 0x10000513, 0x10000291, 0x10000292, 0x1000054a];
    const BTN_SLICES = [0x100002ce, 0x100002cf, 0x100002d0];
    const mk = (parent: HTMLElement, id: number): HTMLElement => {
      const el = domWindow.document.createElement('div');
      el.dataset.elementId = `0x${id.toString(16)}`;
      parent.appendChild(el);
      return el;
    };
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of IDS) elements.set(id, mk(root, id));
        const pane = elements.get(0x10000292)!;
        const inFrame = mk(pane, 0x10000275);
        mk(inFrame, 0x10000276); mk(inFrame, 0x10000277); mk(inFrame, 0x10000278);
        const list = mk(inFrame, 0x10000279);
        list.style.height = '487px';
        mk(inFrame, 0x1000027a);
        for (const id of [0x1000027b, 0x1000027c, 0x1000027d, 0x1000027e, 0x1000027f, 0x10000280]) {
          const btn = mk(inFrame, id);
          for (const sid of BTN_SLICES) mk(btn, sid);
        }
        const emptyFrame = mk(pane, 0x1000026b);
        mk(emptyFrame, 0x1000026c); mk(emptyFrame, 0x1000026d); mk(emptyFrame, 0x1000026e); mk(emptyFrame, 0x1000026f);
        for (const id of [0x10000270, 0x10000271, 0x10000272, 0x10000273]) mk(mk(emptyFrame, id), 0x10000328);
        const createBtn = mk(emptyFrame, 0x10000274);
        for (const sid of BTN_SLICES) mk(createBtn, sid);
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {},
          setVisible: (id: number, on: boolean) => {
            const el = elements.get(id);
            if (el) el.style.display = on ? '' : 'none';
          },
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
    ui.setFellowshipData({
      fellowshipName: 'Playtest Fellows', leaderGuid: OWN_GUID, shareXP: true, evenShare: true,
      open: true, isLocked: false,
      fellows: [fellow(OWN_GUID, 'Perf Tester'), fellow(OTHER_GUID, 'Other Fellow')],
    });
    ui.socialTab = 'fellowship';
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  });

  function panel(): HTMLElement { return ui.socialPanel as HTMLElement; }

  it('another fellow quitting only removes them from the member list', () => {
    ui.handleFellowshipQuitOrDismiss(OTHER_GUID, OWN_GUID, 'quit');
    expect(ui.fellowship).not.toBeNull();
    expect(ui.fellowship.fellows.map((f: { guid: number }) => f.guid)).toEqual([OWN_GUID]);
    // still the member view — the empty-state pane stays hidden
    const emptyFrame = panel().querySelector('[data-element-id="0x1000026b"]') as HTMLElement;
    expect(emptyFrame.style.display).toBe('none');
    expect(panel().querySelector('.fellowship-name-input')).toBeFalsy();
  });

  it('own guid in FellowshipQuit clears the fellowship and re-renders the create state', () => {
    ui.handleFellowshipQuitOrDismiss(OWN_GUID, OWN_GUID, 'quit');
    expect(ui.fellowship).toBeNull();
    // retail DeleteFellowship path → you-do-not-belong create state: the
    // empty-state pane 0x1000026b shows with its live name input bound
    const emptyFrame = panel().querySelector('[data-element-id="0x1000026b"]') as HTMLElement;
    expect(emptyFrame.style.display).not.toBe('none');
    expect(panel().querySelector('.fellowship-name-input')).toBeTruthy();
  });

  it('own guid in FellowshipDismiss (same handler) also clears the fellowship', () => {
    // Retail Handle_Fellowship__Dismiss is byte-for-byte the same branch;
    // main.ts routes both events through handleFellowshipQuitOrDismiss.
    ui.handleFellowshipQuitOrDismiss(OWN_GUID, OWN_GUID, 'dismiss');
    expect(ui.fellowship).toBeNull();
  });

  it('unknown own guid (null) falls back to member removal, never clears', () => {
    ui.handleFellowshipQuitOrDismiss(OWN_GUID, null, 'quit');
    expect(ui.fellowship).not.toBeNull();
    expect(ui.fellowship.fellows.map((f: { guid: number }) => f.guid)).toEqual([OTHER_GUID]);
  });
});
