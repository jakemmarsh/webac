/**
 * CORE.5.c.d.b — the social panel's Fellowship tab is DAT-NATIVE: hosted in
 * its OWN pane 0x10000292 (base 0x21000030:0x1000026a) with the pane's
 * inherited chrome bound in place instead of hidden + hand-rebuilt.
 *
 * Drives the REAL GameUI renderSocialPanel/renderFellowshipPaneNative
 * against a mock LayoutRenderer mirroring the resolved pane chrome,
 * asserting the retail behavior from the decompiled client (gmFellowshipUI):
 *   - TWO stacked state sub-panes, exactly one shown per fellowship state
 *     (Update @ 0048f440: 0x10000275 in-fellowship / 0x1000026b empty)
 *   - empty state: paragraph 0x1000026c, name entry 0x1000026f (maxLength
 *     34), the four option checkboxes 0x10000270-73 bound to the retail
 *     PlayerOptions (PostInit @ 0048fd40 SetPlayerOption order), Create
 *     0x10000274 disabled while the name box is empty (DAT defaultState 13
 *     + ListenToElementMessage cases 0x12/0x44)
 *   - in-fellowship: name into 0x10000276, 32px template rows (navy strip
 *     + three 93x16 vitals bars with centred Cur/Max readouts per
 *     UpdateFellowVitals @ 0048ed60), LVL/XP% column per UpdateFellowStats
 *   - row click = select (case 4/0x43), gating Leader/Dismiss
 *   - button gating per UpdateButtons @ 0048e6c0: Quit always; Leader +
 *     Dismiss leader-only with ANOTHER fellow selected; Open/Close +
 *     Disband leader-only (Open label flips per the openness flag);
 *     Recruit leader-always / member-only-while-open, disabled at
 *     MaxFellows = 9 (ACE Fellowship.cs:26)
 *   - button wires (gmFellowshipUI::ListenToElementMessage @ 004901c0):
 *     each button runs its panel function directly — no chat command, no
 *     confirmation dialog (ui/FellowshipPanelActions.ts) — and GameUI hands
 *     the resulting steps to callbacks.onFellowshipSteps; Recruit asks
 *     callbacks.onFellowshipRecruitSelected (RecruitFellow on the world
 *     selection)
 *   - VISUAL.117 — right-click on a row opens the fellow context menu
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

const FELLOW_PANE = 0x10000292;
const IN_FRAME = 0x10000275;
const EMPTY_FRAME = 0x1000026b;
const BTN_SLICES = [0x100002ce, 0x100002cf, 0x100002d0];
const ACTION_BTNS = {
  leader: 0x1000027b, quit: 0x1000027c, open: 0x1000027d,
  recruit: 0x1000027e, dismiss: 0x1000027f, disband: 0x10000280,
} as const;

const SELF_GUID = 100;
const OTHER_GUID = 2;

function fellow(guid: number, name: string, level = 50) {
  return { guid, name, level, healthCurrent: 80, healthMax: 100, staminaCurrent: 90, staminaMax: 120, manaCurrent: 40, manaMax: 60, shareLoot: true };
}

describe('CORE.5.c.d.b — fellowship tab, DAT-native pane (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let chatSent: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let steps: any[] = [];
  let recruitClicks = 0;
  let optionToggles: Array<{ option: number; value: boolean }> = [];


  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'animationFrame');
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const TOP_IDS = [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, 0x10000513, 0x10000291, FELLOW_PANE, 0x1000054a];
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
        for (const id of TOP_IDS) elements.set(id, mk(root, id));
        const pane = elements.get(FELLOW_PANE)!;
        // In-fellowship sub-pane 0x10000275 (resolved from 0x21000030).
        const inFrame = mk(pane, IN_FRAME);
        mk(inFrame, 0x10000276); mk(inFrame, 0x10000277); mk(inFrame, 0x10000278);
        const list = mk(inFrame, 0x10000279);
        list.style.height = '487px';
        mk(inFrame, 0x1000027a);
        for (const id of Object.values(ACTION_BTNS)) {
          const btn = mk(inFrame, id);
          for (const sid of BTN_SLICES) mk(btn, sid);
        }
        // Empty-state sub-pane 0x1000026b.
        const emptyFrame = mk(pane, EMPTY_FRAME);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (layoutId: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(layoutId, parent),
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function setFellowship(opts: { leader?: boolean; open?: boolean; count?: number } = {}): void {
    const leaderGuid = opts.leader === false ? OTHER_GUID : SELF_GUID;
    const fellows = [fellow(SELF_GUID, 'Self Test', 120), fellow(OTHER_GUID, 'Other Fellow', 80)];
    for (let i = 2; i < (opts.count ?? 2); i++) fellows.push(fellow(1000 + i, `Filler ${i}`, 30));
    ui.setFellowshipData({
      fellowshipName: 'Test Fellowship', leaderGuid, shareXP: false, evenShare: false,
      open: opts.open ?? false, isLocked: false, selfGuid: SELF_GUID, fellows,
    });
  }

  beforeEach(() => {
    chatSent = []; optionToggles = []; steps = []; recruitClicks = 0;
    ui.callbacks.onChatSend = (line: string) => { chatSent.push(line); };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ui.callbacks.onFellowshipSteps = (s: any[]) => { steps.push(...s); };
    ui.callbacks.onFellowshipRecruitSelected = () => { recruitClicks++; };
    ui.callbacks.onCharacterOptionToggle = (option: number, value: boolean) => { optionToggles.push({ option, value }); };
    ui.selectedFellowGuid = null;
    ui.socialTab = 'fellowship';
    setFellowship({ leader: true });
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  });

  function pane(): HTMLElement { return ui.socialPanel.querySelector(`[data-element-id="0x${FELLOW_PANE.toString(16)}"]`) as HTMLElement; }
  function node(id: number): HTMLElement { return pane().querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement; }
  function rows(): HTMLElement[] { return [...pane().querySelectorAll('.fellow-row')] as HTMLElement[]; }
  function click(el: HTMLElement): void { el.dispatchEvent(new domWindow.Event('click', { bubbles: true })); }
  /** A bound 3-slice button is disabled when a click does not fire its action;
   *  the binding also flips cursor: pointer (enabled) / default (disabled). */
  function btnEnabled(id: number): boolean { return node(id).style.cursor === 'pointer'; }

  it('hosts the fellowship tab in its OWN pane 0x10000292 with the other three panes hidden', () => {
    expect(pane().style.display).not.toBe('none');
    for (const other of [0x10000513, 0x10000291, 0x1000054a]) {
      const el = ui.socialPanel.querySelector(`[data-element-id="0x${other.toString(16)}"]`) as HTMLElement;
      expect(el.style.display).toBe('none');
    }
  });

  it('state machine: in-fellowship shows 0x10000275 and hides 0x1000026b; no fellowship flips both (Update @ 0048f440)', () => {
    expect(node(IN_FRAME).style.display).not.toBe('none');
    expect(node(EMPTY_FRAME).style.display).toBe('none');
    ui.setFellowshipData(null);
    expect(node(IN_FRAME).style.display).toBe('none');
    expect(node(EMPTY_FRAME).style.display).not.toBe('none');
  });

  it('fellowship name renders into 0x10000276; one 32px row per fellow with name + vitals Cur/Max readouts', () => {
    expect(node(0x10000276).textContent).toContain('Test Fellowship');
    const r = rows();
    expect(r.length).toBe(2);
    expect(r[0].textContent).toContain('Self Test');
    expect(r[1].textContent).toContain('Other Fellow');
    // UpdateFellowVitals: centred Cur/Max on each of the three bars.
    expect(r[0].textContent).toContain('80/100');
    expect(r[0].textContent).toContain('90/120');
    expect(r[0].textContent).toContain('40/60');
  });

  it('LVL/XP% column: share-XP off still formats ID_Fellowship_FellowStats with a 0 share (UpdateFellowStats @ 0048eb20)', () => {
    expect(rows()[1].textContent).toContain('80/0%');
    expect(rows()[1].textContent).not.toContain('Lv 80');
  });

  it('row click selects the fellow (case 4/0x43) and marks the row selected', () => {
    click(rows()[1]);
    expect(ui.selectedFellowGuid).toBe(OTHER_GUID);
    expect(rows()[1].className).toContain('selected');
    expect(rows()[0].className).not.toContain('selected');
  });

  it('leader gating (UpdateButtons): Quit always; Open/Disband + Recruit enabled; Leader/Dismiss need ANOTHER fellow selected', () => {
    expect(btnEnabled(ACTION_BTNS.quit)).toBe(true);
    expect(btnEnabled(ACTION_BTNS.open)).toBe(true);
    expect(btnEnabled(ACTION_BTNS.disband)).toBe(true);
    expect(btnEnabled(ACTION_BTNS.recruit)).toBe(true);
    expect(btnEnabled(ACTION_BTNS.leader)).toBe(false);
    expect(btnEnabled(ACTION_BTNS.dismiss)).toBe(false);
    click(rows()[1]); // select the other fellow
    expect(btnEnabled(ACTION_BTNS.leader)).toBe(true);
    expect(btnEnabled(ACTION_BTNS.dismiss)).toBe(true);
    click(rows()[0]); // select self — retail disables both again
    expect(btnEnabled(ACTION_BTNS.leader)).toBe(false);
    expect(btnEnabled(ACTION_BTNS.dismiss)).toBe(false);
  });

  it('non-leader gating: Leader/Open/Dismiss/Disband disabled; Recruit disabled while closed, enabled while open', () => {
    setFellowship({ leader: false, open: false });
    expect(btnEnabled(ACTION_BTNS.quit)).toBe(true);
    expect(btnEnabled(ACTION_BTNS.leader)).toBe(false);
    expect(btnEnabled(ACTION_BTNS.open)).toBe(false);
    expect(btnEnabled(ACTION_BTNS.dismiss)).toBe(false);
    expect(btnEnabled(ACTION_BTNS.disband)).toBe(false);
    expect(btnEnabled(ACTION_BTNS.recruit)).toBe(false);
    setFellowship({ leader: false, open: true });
    expect(btnEnabled(ACTION_BTNS.recruit)).toBe(true);
  });

  it('Recruit disables at MaxFellows = 9 (ACE Fellowship.cs:26), even for the leader', () => {
    setFellowship({ leader: true, count: 9 });
    expect(rows().length).toBe(9);
    expect(btnEnabled(ACTION_BTNS.recruit)).toBe(false);
  });

  it('button wires run the panel functions directly: Quit (leader hands off first), Disband, Recruit, Leader/Dismiss on the selected fellow', () => {
    click(node(ACTION_BTNS.quit));
    click(node(ACTION_BTNS.disband));
    click(node(ACTION_BTNS.recruit));
    click(rows()[1]);
    click(node(ACTION_BTNS.leader));
    click(node(ACTION_BTNS.dismiss));
    expect(steps).toEqual([
      // Quit as leader: AssignLeadershipToFellow(GetNonLeaderFellowID) then Event_Quit(0).
      { kind: 'assignLeader', guid: OTHER_GUID }, { kind: 'quit', disband: false },
      { kind: 'quit', disband: true },
      { kind: 'assignLeader', guid: OTHER_GUID },
      { kind: 'dismiss', guid: OTHER_GUID },
    ]);
    expect(recruitClicks).toBe(1);
    expect(chatSent).toEqual([]);
  });

  it('a disabled button swallows the click (state-13 gating): non-leader Disband sends nothing', () => {
    setFellowship({ leader: false });
    click(node(ACTION_BTNS.disband));
    expect(steps).toEqual([]);
    expect(chatSent).toEqual([]);
  });

  it('Open button label flips per the openness flag (ID_Fellowship_Open/CloseFellowshipButtonText) and flips the openness', () => {
    expect(node(ACTION_BTNS.open).textContent).toContain('Open'); // closed → "Open"
    click(node(ACTION_BTNS.open));
    expect(steps).toEqual([{ kind: 'setOpen', open: true }]);
    setFellowship({ leader: true, open: true });
    expect(node(ACTION_BTNS.open).textContent).toContain('Close');
    click(node(ACTION_BTNS.open));
    expect(steps).toEqual([{ kind: 'setOpen', open: true }, { kind: 'setOpen', open: false }]);
    expect(chatSent).toEqual([]);
  });

  it('RECON.dom-chrome-sweep — right-click on a member row opens no menu (0x10000283\'s p72 0x21000041 is its tooltip; gmFellowshipUI has no context menu)', () => {
    const before = domWindow.document.body.querySelectorAll('*').length;
    const ev = new domWindow.Event('contextmenu', { bubbles: true, cancelable: true });
    rows()[1].dispatchEvent(ev);
    expect(domWindow.document.body.querySelectorAll('*').length).toBe(before);
    expect(chatSent).toEqual([]);
  });

  it('empty state: paragraph 0x1000026c renders, input maxLength 34, Create disabled until text is typed (cases 0x12/0x44)', () => {
    ui.setFellowshipData(null);
    expect(node(0x1000026c).textContent).toContain('fellowship');
    const input = pane().querySelector('.fellowship-name-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.maxLength).toBe(34);
    expect(btnEnabled(0x10000274)).toBe(false);
    input.value = 'New Fellows';
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true }));
    expect(btnEnabled(0x10000274)).toBe(true);
  });

  it('empty state: the four checkboxes bind the retail PlayerOptions in PostInit order and ship the CharacterOption on toggle', () => {
    ui.setFellowshipData(null);
    const expected: Array<[number, string, number]> = [
      [0x10000270, 'ignoreFellowshipRequests', 0x02],
      [0x10000271, 'autoAcceptFellowshipRequests', 0x12],
      [0x10000272, 'shareFellowshipXP', 0x0F],
      [0x10000273, 'shareFellowshipLoot', 0x11],
    ];
    for (const [id, key] of expected) {
      expect(node(id).dataset.optionKey).toBe(key);
    }
    const before = !!ui.optionsSettings.ignoreFellowshipRequests;
    click(node(0x10000270));
    expect(!!ui.optionsSettings.ignoreFellowshipRequests).toBe(!before);
    expect(optionToggles).toEqual([{ option: 0x02, value: !before }]);
  });

  it('stale selection drops when the selected fellow leaves (retail UpdateFellowSelection re-resolve)', () => {
    click(rows()[1]);
    expect(ui.selectedFellowGuid).toBe(OTHER_GUID);
    ui.removeFellowshipMember(OTHER_GUID);
    expect(ui.selectedFellowGuid).toBeNull();
    expect(btnEnabled(ACTION_BTNS.dismiss)).toBe(false);
  });
});
