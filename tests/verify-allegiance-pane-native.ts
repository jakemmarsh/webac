/**
 * CORE.5.c.d.a — the social panel's Allegiance tab is DAT-NATIVE: hosted in
 * its OWN pane 0x10000291 (base 0x2100002F:0x1000024f) with the pane's
 * inherited chrome bound in place instead of hidden + hand-rebuilt.
 *
 * Drives the REAL GameUI renderSocialPanel/renderAllegiancePaneNative
 * against a mock LayoutRenderer mirroring the resolved pane chrome
 * (data-element-id nodes + 3-slice button children), asserting the retail
 * behavior from the decompiled client (gmAllegianceUI):
 *   - MONARCH section 0x10000255 hidden when the player IS the monarch;
 *     label flips to PATRON/MONARCH and the monarch-side XP group
 *     0x10000490 shows only when the patron IS the monarch
 *     (UpdateMonarchData @ 00491b40)
 *   - PATRON section 0x1000025a hidden when no patron or patron==monarch
 *     (UpdatePatronData @ 004917c0); its XP value = the player's own XP
 *     passed up
 *   - vassal list 0x10000260 lists ONLY the player's direct vassals
 *     (UpdateVassalsData @ 00492340 iterates GetFirstVassal/GetNextVassal
 *     (player_id)); "(Offline)" renders only for logged-out vassals
 *   - button gating: Swear enabled only with no patron (UpdateSwearButton
 *     @ 004908e0), Break only with a patron (UpdateBreakButton @ 004909d0),
 *     Kick only with a selected vassal (ListenToElementMessage @ 00493030)
 *   - Break confirms then ships the PATRON guid (CloseBreakConfirmationDialog
 *     @ 00490a90 → Event_BreakAllegiance(GetPatron())) — no world target
 *   - Kick confirms then boots the selected vassal by name (GAP.39 wire)
 *   - Swear re-gates on selection change (a selected non-self player with
 *     no allegiance record) before confirming and sending /allegiance swear
 *   - the checkbox 0x10000262 toggles ignoreAllegianceRequests and ships
 *     CharacterOption 0x01 (PostInit @ 00490e90 SetPlayerOption)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

const ALLEG_PANE = 0x10000291;
// Resolved pane chrome per tools/dump-layout.mjs 2100002f: header block
// 0x10000250 (children 251/252/253/254), MONARCH 0x10000255 (256/257/258/259
// + XP group 490→491/492), PATRON 0x1000025a (25b/25c/25d + XP group
// 490→491/492 — the group id REPEATS across sections), headers 25e/25f,
// list 260, scrollbar 261, checkbox 262, buttons 263/264/265.
const BTN_IDS = [0x10000263, 0x10000264, 0x10000265];
const BTN_SLICES = [0x100002ce, 0x100002cf, 0x100002d0];
const PANE_IDS = [0x10000513, ALLEG_PANE, 0x10000292, 0x1000054a];

describe('CORE.5.c.d.a — allegiance tab, DAT-native pane (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let chatSent: string[] = [];
  let optionToggles: Array<{ option: number; value: boolean }> = [];
  let breaks: number[] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const TOP_IDS = [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, ...PANE_IDS];
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
        const pane = elements.get(ALLEG_PANE)!;
        // Header block
        const header = mk(pane, 0x10000250);
        for (const id of [0x10000251, 0x10000252, 0x10000253, 0x10000254]) mk(header, id);
        // MONARCH section with its scoped XP group
        const monarchField = mk(pane, 0x10000255);
        for (const id of [0x10000256, 0x10000257, 0x10000258, 0x10000259]) mk(monarchField, id);
        const monXp = mk(monarchField, 0x10000490);
        mk(monXp, 0x10000491); mk(monXp, 0x10000492);
        // PATRON section with its own copy of the XP group ids
        const patronField = mk(pane, 0x1000025a);
        for (const id of [0x1000025b, 0x1000025c, 0x1000025d]) mk(patronField, id);
        const patXp = mk(patronField, 0x10000490);
        mk(patXp, 0x10000491); mk(patXp, 0x10000492);
        // Headers, list (350px like the resolved DAT region), scrollbar, checkbox
        mk(pane, 0x1000025e); mk(pane, 0x1000025f);
        const list = mk(pane, 0x10000260);
        list.style.height = '350px';
        mk(pane, 0x10000261);
        mk(pane, 0x10000262);
        for (const id of BTN_IDS) {
          const btn = mk(pane, id);
          for (const sid of BTN_SLICES) mk(btn, sid);
        }
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

  /** ACE wire shape (AllegianceHierarchy.cs:117-136): monarch + patron +
   *  self + direct vassals. selfGuid 100; patron guid 5 under monarch 1. */
  function allegianceWithPatron(): void {
    ui.setAllegianceData({
      allegianceName: 'Test Allegiance', playerRank: 3, totalMembers: 2538, totalVassals: 3, isLocked: false,
      selfGuid: 100,
      members: [
        { guid: 1, parentGuid: 0, name: 'Monarch Test', level: 275, rank: 10, isOnline: true, xpProduced: 152000000 },
        { guid: 5, parentGuid: 1, name: 'Patron Test', level: 180, rank: 7, isOnline: false, xpProduced: 48200000 },
        { guid: 100, parentGuid: 5, name: 'Self Test', level: 120, rank: 3, isOnline: true, xpProduced: 1727923540 },
        { guid: 2, parentGuid: 100, name: 'Vassal Alpha', level: 150, rank: 5, isOnline: true, xpProduced: 12500000 },
        { guid: 3, parentGuid: 100, name: 'Vassal Beta', level: 96, rank: 4, isOnline: false, xpProduced: 3400000 },
      ],
    });
  }

  beforeEach(() => {
    chatSent = []; optionToggles = []; breaks = [];
    ui.callbacks.onChatSend = (line: string) => { chatSent.push(line); };
    ui.callbacks.onCharacterOptionToggle = (option: number, value: boolean) => { optionToggles.push({ option, value }); };
    ui.callbacks.onAllegianceBreak = (guid: number) => { breaks.push(guid); };
    // Auto-accept confirmation dialogs (retail Make*ConfirmationDialog flow).
    ui.showConfirmationDialog = (_msg: string, cb: (accepted: boolean) => void) => cb(true);
    ui.selectedVassalName = null;
    ui.hudState.target = null;
    if (ui.uiManager.currentScreen !== 'game') ui.uiManager.setScreen('game');
    ui.optionsSettings.ignoreAllegianceRequests = false;
    ui.socialTab = 'allegiance';
    allegianceWithPatron();
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  });

  function pane(): HTMLElement { return ui.socialPanel.querySelector(`[data-element-id="0x${ALLEG_PANE.toString(16)}"]`) as HTMLElement; }
  function node(id: number): HTMLElement { return pane().querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement; }
  function scoped(sectionId: number, id: number): HTMLElement {
    return node(sectionId).querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
  }
  function rows(): HTMLElement[] { return [...pane().querySelectorAll('.vassal-row')] as HTMLElement[]; }
  function click(el: HTMLElement): void { el.dispatchEvent(new domWindow.Event('click', { bubbles: true })); }

  it('hosts the allegiance tab in its OWN pane 0x10000291 with the other three panes hidden', () => {
    expect(pane().style.display).not.toBe('none');
    for (const other of [0x10000513, 0x10000292, 0x1000054a]) {
      const el = ui.socialPanel.querySelector(`[data-element-id="0x${other.toString(16)}"]`) as HTMLElement;
      expect(el.style.display).toBe('none');
    }
  });

  it('header block: allegiance name into 0x10000251, "Followers: <totalVassals>" into 0x10000252, rank into 0x10000253', () => {
    expect(node(0x10000251).textContent).toContain('Test Allegiance');
    // The player's OWN vassal count (BUG.allegiance-total-vassals-dropped:
    // totalVassals, never the whole-allegiance totalMembers).
    expect(node(0x10000252).textContent).toContain('Followers: 3');
    expect(node(0x10000252).textContent).not.toContain('2538');
    expect(node(0x10000253).textContent).toContain('[3]');
  });

  it('VASSALS / XP Produced column headers render into 0x1000025e / 0x1000025f (VISUAL.19)', () => {
    expect(node(0x1000025e).textContent).toContain('VASSALS');
    expect(node(0x1000025f).textContent).toContain('XP Produced');
  });

  it('MONARCH section: plain MONARCH label when patron != monarch, monarch-side XP group hidden (UpdateMonarchData else-branch)', () => {
    expect(node(0x10000255).style.display).not.toBe('none');
    expect(scoped(0x10000255, 0x10000256).textContent).toContain('MONARCH');
    expect(scoped(0x10000255, 0x10000256).textContent).not.toContain('PATRON');
    expect(scoped(0x10000255, 0x10000257).textContent).toContain('Monarch Test');
    // Monarch followers = allegiance size minus the monarch (2,537).
    expect(scoped(0x10000255, 0x10000258).textContent?.replace(/[,.\s]/g, '')).toContain('2537');
    expect(scoped(0x10000255, 0x10000490).style.display).toBe('none');
  });

  it('PATRON section: shown with name + own XP passed up in the section-scoped 0x10000492 (UpdatePatronData)', () => {
    expect(node(0x1000025a).style.display).not.toBe('none');
    expect(scoped(0x1000025a, 0x1000025c).textContent).toContain('Patron Test');
    expect(scoped(0x1000025a, 0x10000492).textContent?.replace(/[,.\s]/g, '')).toContain('1727923540');
  });

  it('patron == monarch: PATRON/MONARCH combined label, monarch XP group shown, patron section hidden', () => {
    ui.setAllegianceData({
      allegianceName: 'Direct Sworn', playerRank: 1, totalMembers: 3, totalVassals: 1, isLocked: false,
      selfGuid: 100,
      members: [
        { guid: 1, parentGuid: 0, name: 'Monarch Test', level: 275, rank: 10, isOnline: true, xpProduced: 152000000 },
        { guid: 100, parentGuid: 1, name: 'Self Test', level: 120, rank: 1, isOnline: true, xpProduced: 777 },
        { guid: 2, parentGuid: 100, name: 'Vassal Alpha', level: 150, rank: 5, isOnline: true, xpProduced: 12500000 },
      ],
    });
    expect(scoped(0x10000255, 0x10000256).textContent).toContain('PATRON/MONARCH');
    expect(scoped(0x10000255, 0x10000490).style.display).not.toBe('none');
    expect(scoped(0x10000255, 0x10000492).textContent).toContain('777');
    expect(node(0x1000025a).style.display).toBe('none');
  });

  it('self is monarch: MONARCH and PATRON sections both hidden (UpdateMonarchData self-check)', () => {
    ui.setAllegianceData({
      allegianceName: 'My Own Crown', playerRank: 10, totalMembers: 2, totalVassals: 1, isLocked: false,
      selfGuid: 1,
      members: [
        { guid: 1, parentGuid: 0, name: 'Self Monarch', level: 275, rank: 10, isOnline: true, xpProduced: 0 },
        { guid: 2, parentGuid: 1, name: 'Vassal Alpha', level: 150, rank: 5, isOnline: true, xpProduced: 12500000 },
      ],
    });
    expect(node(0x10000255).style.display).toBe('none');
    expect(node(0x1000025a).style.display).toBe('none');
  });

  it('vassal list 0x10000260 renders ONLY direct vassals — monarch/patron/self never appear (GetFirstVassal semantics)', () => {
    const r = rows();
    expect(r.map(x => x.dataset.rowName)).toEqual(['Vassal Alpha', 'Vassal Beta']);
    for (const row of r) expect(row.closest('[data-element-id="0x10000260"]')).toBe(node(0x10000260));
    // "(Offline)" only on the logged-out vassal's second line.
    expect(r[0].textContent).not.toContain('Offline');
    expect(r[1].textContent).toContain('Offline');
    // Second line carries XP Produced, never "Lv N" (VISUAL.113).
    expect(r[0].textContent?.replace(/[,.\s]/g, '')).toContain('12500000');
    expect(r[0].textContent).not.toContain('Lv ');
  });

  it('Kick is disabled without a selection; selecting a vassal row enables it and Kick confirms + breaks with that vassal (CloseKickConfirmationDialog @ 00490b00)', () => {
    expect(node(0x10000265).style.cursor).toBe('default');
    click(rows()[0]);
    expect(node(0x10000265).style.cursor).toBe('pointer');
    click(node(0x10000265));
    expect(breaks).toEqual([2]);
  });

  it('Break is enabled with a patron and ships the PATRON guid after confirm (CloseBreakConfirmationDialog @ 00490a90)', () => {
    expect(node(0x10000264).style.cursor).toBe('pointer');
    click(node(0x10000264));
    expect(breaks).toEqual([5]);
  });

  it('Swear is disabled while sworn (UpdateSwearButton: patron != 0 → state 13)', () => {
    expect(node(0x10000263).style.cursor).toBe('default');
    click(node(0x10000263));
    expect(chatSent).toEqual([]);
  });

  it('unsworn with nothing selected: Swear is disabled (UpdateSwearButton selectedID == 0 → state 13)', () => {
    ui.setAllegianceData(null);
    expect(node(0x10000263).style.cursor).toBe('default');
    expect(node(0x10000263).dataset.acState).toBe('d');
    click(node(0x10000263));
    expect(chatSent).toEqual([]);
  });

  it('unsworn: Swear follows the selection live (RecvNotice_SelectionChanged) and sends the panel Swear (onAllegianceSwear) after confirm', () => {
    const swears: number[] = [];
    ui.callbacks.onAllegianceSwear = (guid: number) => { swears.push(guid); };
    ui.setAllegianceData(null);
    ui.playerGuid = 0x5000_00aa;
    // Creature selected → still disabled.
    ui.hudState.target = { id: 0x7000_0001, name: 'Drudge', level: 5, healthFraction: 1, distance: 0, type: 'creature' };
    ui.updateHUD();
    expect(node(0x10000263).style.cursor).toBe('default');
    // Self selected → disabled.
    ui.hudState.target = { id: 0x5000_00aa, name: 'Me', level: 20, healthFraction: 1, distance: 0, type: 'player' };
    ui.updateHUD();
    expect(node(0x10000263).style.cursor).toBe('default');
    // Another player selected → enabled without re-rendering the pane.
    ui.hudState.target = { id: 0x5000_0001, name: 'Future Patron', level: 200, healthFraction: 1, distance: 0, type: 'player' };
    ui.updateHUD();
    expect(node(0x10000263).style.cursor).toBe('pointer');
    expect(node(0x10000263).dataset.acState).not.toBe('d');
    click(node(0x10000263));
    // MakeSwearConfirmationDialog captures the selection's id when it opens.
    expect(swears).toEqual([0x5000_0001]);
    expect(chatSent).toEqual([]);
    // Selection cleared → disabled again.
    ui.hudState.target = null;
    ui.updateHUD();
    expect(node(0x10000263).style.cursor).toBe('default');
    // Break disabled with no patron.
    expect(node(0x10000264).style.cursor).toBe('default');
    ui.playerGuid = 0;
  });

  it('a monarch selecting a player already in its allegiance keeps Swear disabled (AllegianceProfile::GetData != 0)', () => {
    ui.setAllegianceData({
      allegianceName: 'Test Allegiance', playerRank: 5, totalMembers: 2, totalVassals: 1, isLocked: false,
      selfGuid: 100,
      members: [
        { guid: 100, parentGuid: 0, name: 'Self Test', level: 120, rank: 5, isOnline: true, xpProduced: 0 },
        { guid: 2, parentGuid: 100, name: 'Vassal Alpha', level: 150, rank: 1, isOnline: true, xpProduced: 0 },
      ],
    });
    ui.hudState.target = { id: 2, name: 'Vassal Alpha', level: 150, healthFraction: 1, distance: 0, type: 'player' };
    ui.updateHUD();
    expect(node(0x10000263).style.cursor).toBe('default');
    ui.hudState.target = { id: 0x5000_0002, name: 'Outsider', level: 90, healthFraction: 1, distance: 0, type: 'player' };
    ui.updateHUD();
    expect(node(0x10000263).style.cursor).toBe('pointer');
  });

  it('a NON-PK player (no PK radar colour, so typed creature) still enables Swear: the gate is IsPlayer, the Player description flag', () => {
    const swears: number[] = [];
    ui.callbacks.onAllegianceSwear = (guid: number) => { swears.push(guid); };
    ui.setAllegianceData(null);
    ui.hudState.target = { id: 0x5000_00a2, name: 'Patron Claude', level: 1, healthFraction: 1, distance: 0, type: 'creature', isPlayer: true };
    ui.updateHUD();
    expect(node(0x10000263).style.cursor).toBe('pointer');
    click(node(0x10000263));
    expect(swears).toEqual([0x5000_00a2]);
    // A creature that is no player stays disabled even with a player-ish radar type missing.
    ui.hudState.target = { id: 0x8000_0001, name: 'Drudge', level: 5, healthFraction: 1, distance: 0, type: 'creature', isPlayer: false };
    ui.updateHUD();
    expect(node(0x10000263).style.cursor).toBe('default');
  });

  it('the fellowship pane tells the server when it is shown and hidden (gmFellowshipUI::OnVisibilityChanged → Event_UpdateRequest)', async () => {
    const sent: boolean[] = [];
    ui.callbacks.onFellowshipPaneVisibility = (v: boolean) => sent.push(v);
    if (ui.socialPanelVisible) ui.toggleSocialPanel();
    await Promise.resolve();
    sent.length = 0;
    ui.socialTab = 'fellowship';
    ui.toggleSocialPanel(); // shown on the fellowship tab
    await Promise.resolve();
    ui.toggleSocialPanel(); // hidden
    await Promise.resolve();
    ui.socialTab = 'allegiance';
    ui.toggleSocialPanel(); // shown on another tab: nothing
    await Promise.resolve();
    expect(sent).toEqual([true, false]);
  });

  it('AGENT: the open Social panel is listed by tab and closes through its own toggle; unknown names list what is open', () => {
    expect(ui.agentOpenWindows()).toContain('Social (allegiance)');
    expect(ui.agentCloseWindow('trade')).toMatch(/^no open window "trade" \(open: .*Social \(allegiance\)/);
    expect(ui.agentCloseWindow('social')).toBeNull();
    expect(ui.socialPanelVisible).toBe(false);
    expect(ui.agentOpenWindows()).not.toContain('Social (allegiance)');
    ui.toggleSocialPanel();
    expect(ui.agentCloseWindow('all')).toBeNull();
    expect(ui.socialPanelVisible).toBe(false);
    ui.toggleSocialPanel();
  });

  it('AGENT: agentAllegiance reads the pane as text; Break/Kick by name ship the same guids as the buttons', () => {
    ui.playerGuid = 100;
    const text = ui.agentAllegiance();
    expect(text).toContain('Test Allegiance: 2538 members, your rank 3');
    expect(text).toContain('monarch: Monarch Test (L275, online)');
    expect(text).toContain('patron: Patron Test (L180)');
    expect(text).toContain('vassals: Vassal Alpha (L150, online), Vassal Beta (L96)');
    expect(ui.agentBreakAllegiance()).toBeNull();
    expect(ui.agentBreakAllegiance('vassal beta')).toBeNull();
    expect(ui.agentBreakAllegiance('Monarch Test')).toBe('Monarch Test is neither your patron nor your vassal');
    expect(breaks).toEqual([5, 3]);
    ui.playerGuid = 0;
  });

  it('AGENT: agentSwearAllegiance keeps the Swear button\'s gate and says why it is closed', () => {
    const swears: number[] = [];
    ui.callbacks.onAllegianceSwear = (guid: number) => { swears.push(guid); };
    ui.hudState.target = { id: 0x5000_0003, name: 'Other', level: 90, healthFraction: 1, distance: 0, type: 'player' };
    expect(ui.agentSwearAllegiance()).toBe('you already have a patron (break from them first)');
    ui.setAllegianceData(null);
    expect(ui.agentAllegiance()).toBe('no allegiance (no patron, no vassals)');
    expect(ui.agentBreakAllegiance()).toBe('you have no patron');
    ui.hudState.target = null;
    expect(ui.agentSwearAllegiance()).toBe('select the player to swear to first');
    ui.hudState.target = { id: 0x7000_0001, name: 'Drudge', level: 5, healthFraction: 1, distance: 0, type: 'creature' };
    expect(ui.agentSwearAllegiance()).toBe('Drudge is not a player');
    ui.hudState.target = { id: 0x5000_0001, name: 'Main', level: 200, healthFraction: 1, distance: 0, type: 'player' };
    expect(ui.agentSwearAllegiance()).toBeNull();
    expect(swears).toEqual([0x5000_0001]);
  });

  it('sworn: selecting another player leaves Swear disabled (GetPatron != 0)', () => {
    ui.hudState.target = { id: 0x5000_0003, name: 'Other', level: 90, healthFraction: 1, distance: 0, type: 'player' };
    ui.updateHUD();
    expect(node(0x10000263).style.cursor).toBe('default');
  });

  it('checkbox 0x10000262 off draws the base gem\'s Normal art 0x06004d15, on draws 0x06004d17 — never the state-13 0x06004d19', () => {
    ui.uiTextures.set(0x06004d15, 'data:gem-off');
    ui.uiTextures.set(0x06004d17, 'data:gem-on');
    ui.uiTextures.set(0x06004d19, 'data:gem-disabled');
    ui.renderSocialPanel();
    const bg = (): string => (node(0x10000262).querySelector('.layout-text > div') as HTMLElement).style.backgroundImage;
    expect(bg()).toContain('data:gem-off');
    click(node(0x10000262));
    ui.renderSocialPanel();
    expect(bg()).toContain('data:gem-on');
    ui.uiTextures.delete(0x06004d15); ui.uiTextures.delete(0x06004d17); ui.uiTextures.delete(0x06004d19);
  });

  it('checkbox 0x10000262 toggles ignoreAllegianceRequests and ships CharacterOption 0x01', () => {
    click(node(0x10000262));
    expect(ui.optionsSettings.ignoreAllegianceRequests).toBe(true);
    expect(optionToggles).toEqual([{ option: 0x01, value: true }]);
    expect(node(0x10000262).dataset.optionOn).toBe('1');
  });

  it('a stale vassal selection is dropped when the update no longer lists that direct vassal (retail Flush)', () => {
    click(rows()[0]); // select Vassal Alpha
    expect(ui.selectedVassalName).toBe('Vassal Alpha');
    ui.setAllegianceData({
      allegianceName: 'Test Allegiance', playerRank: 3, totalMembers: 2538, totalVassals: 1, isLocked: false,
      selfGuid: 100,
      members: [
        { guid: 1, parentGuid: 0, name: 'Monarch Test', level: 275, rank: 10, isOnline: true, xpProduced: 152000000 },
        { guid: 100, parentGuid: 1, name: 'Self Test', level: 120, rank: 3, isOnline: true, xpProduced: 777 },
        { guid: 3, parentGuid: 100, name: 'Vassal Beta', level: 96, rank: 4, isOnline: false, xpProduced: 3400000 },
      ],
    });
    expect(ui.selectedVassalName).toBe(null);
  });

  it('no allegiance: sections hidden, headers still render, vassal list empty (allegiance-panel.jpg empty state)', () => {
    ui.setAllegianceData(null);
    expect(node(0x10000255).style.display).toBe('none');
    expect(node(0x1000025a).style.display).toBe('none');
    expect(node(0x10000252).textContent).toContain('0');
    expect(rows().length).toBe(0);
  });
});
