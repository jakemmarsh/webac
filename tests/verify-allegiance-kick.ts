/**
 * GAP.39 — allegiance-panel Kick acts on a SELECTED vassal.
 *
 * DAT ground truth (verification/panel-specs/social-allegiance.md, layout
 * 0x2100002F): Kick button 0x10000265 (str 204926940), confirm string
 * "Are you sure you wish to kick " (157887678), selectable list rows
 * (template 0x10000267: normal 0x06001aaf / selected 0x06001451). Wire:
 * GameActionBreakAllegianceBoot (0x0277, name String16L + accountBoot u32)
 * — distinct from AllegianceChatBoot which only gags allegiance chat.
 * Pre-fix the Kick button printed a usage hint and acted on nothing.
 *
 * Behavioral: real renderSocialPanel in happy-dom; click a vassal row,
 * click Kick, accept the confirm, assert the callback got the name.
 *
 * CORE.5.c.d.a — updated to the DAT-native pane 0x10000291: the Kick button
 * is the pane's inherited 3-slice element 0x10000265 (disabled state 13
 * without a selection, per gmAllegianceUI::ListenToElementMessage @
 * 00493030), rows are 0x10000266-template rows inside list 0x10000260, and
 * the profile carries selfGuid so only DIRECT vassals list (retail
 * GetFirstVassal semantics).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GAP.39 — allegiance Kick on selected vassal (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let kicked: number[] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // Mock the resolved allegiance-pane chrome (CORE.5.c.d.a): container ids
    // + the pane's inherited elements the native render binds.
    const IDS = [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, 0x10000513, 0x10000291, 0x10000292, 0x1000054a];
    const PANE_CHROME = [0x10000250, 0x10000255, 0x1000025a, 0x1000025e, 0x1000025f, 0x10000260, 0x10000261, 0x10000262, 0x10000263, 0x10000264, 0x10000265];
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        const mk = (par: HTMLElement, id: number): HTMLElement => {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          par.appendChild(el);
          return el;
        };
        for (const id of IDS) {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          root.appendChild(el);
          elements.set(id, el);
        }
        const pane = elements.get(0x10000291)!;
        for (const id of PANE_CHROME) mk(pane, id);
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // The mock carries no DialogFactory template (0x2100003C): the
      // confirmation takes its fallback plate.
      render: (layoutId: number, parent: HTMLElement) => (layoutId === 0x2100003c ? null : ui.layoutRenderer.renderPanel(layoutId, parent)),
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    kicked = [];
    // CloseKickConfirmationDialog @ 00490b00: Event_BreakAllegiance(the vassal's id) — the Break callback.
    ui.callbacks.onAllegianceBreak = (guid: number) => { kicked.push(guid); };
    ui.selectedVassalName = null;
    ui.socialTab = 'allegiance';
    ui.setAllegianceData({
      allegianceName: 'Test Alliance', playerRank: 5, totalMembers: 4, totalVassals: 2, isLocked: false,
      selfGuid: 100,
      members: [
        { guid: 1, parentGuid: 0, name: 'Monarch Max', level: 100, rank: 10, isOnline: true },
        { guid: 100, parentGuid: 1, name: 'Self Sam', level: 80, rank: 5, isOnline: true, xpProduced: 5000 },
        { guid: 2, parentGuid: 100, name: 'Vassal Vera', level: 40, rank: 3, isOnline: true, xpProduced: 1234 },
        { guid: 3, parentGuid: 100, name: 'Vassal Vic', level: 30, rank: 2, isOnline: false, xpProduced: 99 },
      ],
    });
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  });

  function panel(): HTMLElement { return ui.socialPanel as HTMLElement; }
  function vassalRows(): HTMLElement[] { return [...panel().querySelectorAll('.vassal-row')] as HTMLElement[]; }
  function kickBtn(): HTMLElement {
    return panel().querySelector('[data-element-id="0x10000265"]') as HTMLElement;
  }
  function clickYes() {
    const dlg = ui.confirmationDialog as HTMLElement;
    expect(dlg).toBeTruthy();
    const yes = ([...dlg.querySelectorAll('div')] as HTMLElement[]).filter(b => b.style.cursor === 'pointer')[0];
    yes.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
  }

  it('monarch/patron/self are not listed as vassal rows; only DIRECT vassals are (GetFirstVassal semantics)', () => {
    expect(vassalRows().length).toBe(2);
  });

  it('kick with no selection warns and fires nothing', () => {
    kickBtn().dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(ui.confirmationDialog).toBeFalsy();
    expect(kicked).toEqual([]);
  });

  it('click row → selected (DAT highlight class); kick → confirm → BreakAllegiance with the vassal\'s id', () => {
    vassalRows()[0].dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    const sel = vassalRows().find(r => r.className.includes('selected'));
    expect(sel).toBeTruthy();
    kickBtn().dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    clickYes();
    expect(kicked).toEqual([2]);
  });

  it('the confirmation is the whole two-part template: "... kick <name> from your allegiance?"', () => {
    vassalRows()[0].dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    kickBtn().dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect((ui.confirmationDialog as HTMLElement).textContent).toContain('Are you sure you wish to kick Vassal Vera from your allegiance?');
  });

  it('declining the confirm fires nothing', () => {
    vassalRows()[1].dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    kickBtn().dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    const dlg = ui.confirmationDialog as HTMLElement;
    const btns = ([...dlg.querySelectorAll('div')] as HTMLElement[]).filter(b => b.style.cursor === 'pointer');
    btns[1].dispatchEvent(new domWindow.Event('click', { bubbles: true })); // No
    expect(kicked).toEqual([]);
  });

  it('clicking the selected row again deselects it', () => {
    vassalRows()[0].dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    vassalRows()[0].dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    expect(vassalRows().some(r => r.className.includes('selected'))).toBe(false);
  });
});
