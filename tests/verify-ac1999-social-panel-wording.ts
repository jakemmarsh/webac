/**
 * BUG.ac1999-fellowship-refusal-wording — an AC1999 production player got end of retail's
 * "That person is already in your fellowship" (ID_Fellowship_Error_PlayerAlreadyInFellowship). The
 * 1999 client.exe words the fellowship panel's refusals its own way and runs Recruit / Dismiss as a
 * click-a-character target mode; its allegiance panel has no confirmation dialogs and no Kick (its slot holds Show XP / Show Titles), and
 * its Break is a click mode too:
 *  - FellowPanel_RecruitObject @ 0x00535670: "<name> is already in your Fellowship" / "You can't
 *    recruit yourself."; FellowPanel_DismissObject @ 0x00535570: "<name> isn't in your Fellowship" /
 *    "You can't dismiss yourself." (eraClientRules().fellowshipText, ui/FellowshipPanelActions.ts)
 *  - FellowPanel_ListenToMessage @ 0x00535770: "Click a character to recruit." (Recruit with no known
 *    player selected) / "Click a character to dismiss." (every Dismiss), SetTargetMode(7 / 8)
 *  - AllegPanel_ListenToMessage @ 0x00530a70: Swear sends at once; Break prints "Click your Patron or a
 *    Vassal to break Allegiance. Click anywhere to abort." (and the patron-only / vassal-only forms),
 *    the next click breaks with the row's character or prints "Break Allegiance cancelled" (0x0052db90)
 * End of retail and Dark Majesty (the same exe) keep the string-table tokens, dialogs and Kick.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import {
  recruitFellow, recruitPress, dismissFellow, dismissPress,
  AC1999_FELLOWSHIP_TEXT, EOR_FELLOWSHIP_TEXT, type FellowshipView,
} from '../packages/renderer/src/ui/FellowshipPanelActions.js';
import {
  AC1999_ALLEGIANCE_BREAK_TEXT, breakClick1999, breakPrompt1999,
} from '../packages/renderer/src/ui/AllegiancePanelFlow.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { WorldTargetModeController } from '../packages/renderer/src/input/WorldTargetMode.js';
import { matchClientTemplate, isTargetPromptNotice, isSpewStatusNotice } from '../packages/renderer/src/telemetry/RefusalTemplates.js';

const SELF = 0x50000001;
const OTHER = 0x50000002;
const STRANGER = 0x50000009;
const fellowship: FellowshipView = {
  leaderGuid: SELF, open: false,
  fellows: [{ guid: SELF, name: 'Self Test' }, { guid: OTHER, name: 'Aerlinthe Rider' }],
};
const names = { nameOf: (g: number) => (g === STRANGER ? 'Drudge Stranger' : undefined) };

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const REOR = eraClientRules(eraProfile('eor'));
const RDM = eraClientRules(eraProfile('classicace-customdm'));

describe('era data: which wording each era uses', () => {
  it('1999 takes the 1999 client.exe text and flow; end of retail and Dark Majesty keep retail\'s', () => {
    expect(R1999.fellowshipText).toBe(AC1999_FELLOWSHIP_TEXT);
    expect(REOR.fellowshipText).toBe(EOR_FELLOWSHIP_TEXT);
    expect(RDM.fellowshipText).toBe(EOR_FELLOWSHIP_TEXT);
    expect(R1999.allegianceFlow).toEqual({ confirmDialogs: false, kickButton: false, breakMode: AC1999_ALLEGIANCE_BREAK_TEXT, pane1999: true, breakCursor: 0x0600144f });
    for (const r of [REOR, RDM]) expect(r.allegianceFlow).toEqual({ confirmDialogs: true, kickButton: true, breakMode: null, pane1999: false, breakCursor: null });
  });
});

describe('Recruit (1999 FellowPanel_RecruitObject @ 0x00535670 / end of retail RecruitFellow @ 0048e530)', () => {
  it('1999: a fellow is "<name> is already in your Fellowship" (capital F, no full stop)', () => {
    expect(recruitFellow(fellowship, SELF, OTHER, true, R1999.fellowshipText, names))
      .toEqual([{ kind: 'refuse', text: 'Aerlinthe Rider is already in your Fellowship' }]);
  });
  it('1999: yourself is "You can\'t recruit yourself."', () => {
    expect(recruitFellow(fellowship, SELF, SELF, true, R1999.fellowshipText, names))
      .toEqual([{ kind: 'refuse', text: "You can't recruit yourself." }]);
  });
  it('1999: a non-fellow player is recruited', () => {
    expect(recruitFellow(fellowship, SELF, STRANGER, true, R1999.fellowshipText, names)).toEqual([{ kind: 'recruit', guid: STRANGER }]);
  });
  it('1999: Recruit with no known player selected arms the click mode with its prompt', () => {
    expect(recruitPress(fellowship, SELF, 0, null, R1999.fellowshipText, names))
      .toEqual([{ kind: 'targetMode', mode: 'recruit', text: 'Click a character to recruit.' }]);
    expect(recruitPress(fellowship, SELF, STRANGER, false, R1999.fellowshipText, names))
      .toEqual([{ kind: 'targetMode', mode: 'recruit', text: 'Click a character to recruit.' }]);
    // A known player is handled at once, as RecruitObject's non-zero return skips the mode.
    expect(recruitPress(fellowship, SELF, OTHER, true, R1999.fellowshipText, names))
      .toEqual([{ kind: 'refuse', text: 'Aerlinthe Rider is already in your Fellowship' }]);
  });
  it('end of retail and Dark Majesty: the string-table tokens, unchanged, and no click mode', () => {
    for (const r of [REOR, RDM]) {
      expect(recruitFellow(fellowship, SELF, OTHER, true, r.fellowshipText, names))
        .toEqual([{ kind: 'refuse', token: 'ID_Fellowship_Error_PlayerAlreadyInFellowship' }]);
      expect(recruitFellow(fellowship, SELF, SELF, true, r.fellowshipText, names))
        .toEqual([{ kind: 'refuse', token: 'ID_Fellowship_Error_CantRecruitSelf' }]);
      expect(recruitPress(fellowship, SELF, 0, null, r.fellowshipText, names)).toEqual([]);
    }
    // The defaults are end of retail's.
    expect(recruitFellow(fellowship, SELF, OTHER, true)).toEqual([{ kind: 'refuse', token: 'ID_Fellowship_Error_PlayerAlreadyInFellowship' }]);
  });
});

describe('Dismiss (1999 FellowPanel_DismissObject @ 0x00535570 / end of retail DismissFellow @ 0048e470)', () => {
  it('1999: a non-fellow is "<name> isn\'t in your Fellowship", named from the world object', () => {
    expect(dismissFellow(fellowship, SELF, STRANGER, R1999.fellowshipText, names))
      .toEqual([{ kind: 'refuse', text: "Drudge Stranger isn't in your Fellowship" }]);
  });
  it('1999: yourself is "You can\'t dismiss yourself."; a fellow is dismissed; a non-player is silent', () => {
    expect(dismissFellow(fellowship, SELF, SELF, R1999.fellowshipText, names)).toEqual([{ kind: 'refuse', text: "You can't dismiss yourself." }]);
    expect(dismissFellow(fellowship, SELF, OTHER, R1999.fellowshipText, names)).toEqual([{ kind: 'dismiss', guid: OTHER }]);
    expect(dismissFellow(fellowship, SELF, STRANGER, R1999.fellowshipText, names, false)).toEqual([]);
  });
  it('1999: the Dismiss button arms the click mode whatever is selected', () => {
    for (const sel of [null, OTHER]) {
      expect(dismissPress(fellowship, SELF, sel, R1999.fellowshipText, names))
        .toEqual([{ kind: 'targetMode', mode: 'dismiss', text: 'Click a character to dismiss.' }]);
    }
  });
  it('end of retail and Dark Majesty: the selected fellow at once, tokens unchanged', () => {
    for (const r of [REOR, RDM]) {
      expect(dismissPress(fellowship, SELF, OTHER, r.fellowshipText, names)).toEqual([{ kind: 'dismiss', guid: OTHER }]);
      expect(dismissPress(fellowship, SELF, null, r.fellowshipText, names)).toEqual([]);
      expect(dismissFellow(fellowship, SELF, STRANGER, r.fellowshipText, names)).toEqual([{ kind: 'refuse', token: 'ID_Fellowship_Error_DismisseeNotInFellowship' }]);
      expect(dismissFellow(fellowship, SELF, SELF, r.fellowshipText, names)).toEqual([{ kind: 'refuse', token: 'ID_Fellowship_Error_CantDismissSelf' }]);
    }
  });
});

describe('the 1999 recruit / dismiss modes ride the world target-mode controller (SetTargetMode 7 / 8)', () => {
  it('arm, then the next click on an object executes that mode and disarms', () => {
    const c = new WorldTargetModeController();
    c.arm('dismiss');
    expect(c.current).toBe('dismiss');
    expect(c.consumeClick(OTHER)).toEqual({ kind: 'executed', mode: 'dismiss', targetGuid: OTHER });
    expect(c.current).toBe('none');
    c.arm('recruit');
    expect(c.disarm()).toBe(true);
  });

  it('BUG.ac1999-fellow-recruit-silent: an armed recruit runs once; a refusal leaves nothing armed to repeat it', () => {
    const c = new WorldTargetModeController(true);
    c.arm('recruit');
    expect(c.consumeClick(STRANGER)).toEqual({ kind: 'executed', mode: 'recruit', targetGuid: STRANGER });
    // Further clicks on the same character (held, repeated, or after the server's refusal) run nothing.
    for (let i = 0; i < 5; i++) expect(c.consumeClick(STRANGER)).toEqual({ kind: 'not-armed' });
  });
});

describe('1999 Break (AllegPanel_ListenToMessage @ 0x00530a70, 0x0052db90)', () => {
  const t = AC1999_ALLEGIANCE_BREAK_TEXT;
  it('the prompt names what can be broken; nothing to break is silent', () => {
    expect(breakPrompt1999(t, true, 2)).toBe('Click your Patron or a Vassal to break Allegiance. Click anywhere to abort.');
    expect(breakPrompt1999(t, true, 0)).toBe('Click your Patron to break Allegiance. Click anywhere to abort.');
    expect(breakPrompt1999(t, false, 1)).toBe('Click a Vassal to break Allegiance. Click anywhere to abort.');
    expect(breakPrompt1999(t, false, 0)).toBeNull();
  });
  it('the next click breaks with the patron or a vassal, anything else cancels', () => {
    expect(breakClick1999(t, 5, 5, [2, 3])).toEqual({ kind: 'break', guid: 5 });
    expect(breakClick1999(t, 3, 5, [2, 3])).toEqual({ kind: 'break', guid: 3 });
    expect(breakClick1999(t, 1, 5, [2, 3])).toEqual({ kind: 'cancelled', text: 'Break Allegiance cancelled' });
    expect(breakClick1999(t, null, 5, [2, 3])).toEqual({ kind: 'cancelled', text: 'Break Allegiance cancelled' });
  });
});

describe('refusal telemetry keys the 1999 lines by template and leaves the prompts out', () => {
  it('a 1999 name line keys without the name; prompts and the cancel are not refusals', () => {
    expect(matchClientTemplate('Aerlinthe Rider is already in your Fellowship')).toBe('_ is already in your Fellowship');
    expect(matchClientTemplate("Drudge Stranger isn't in your Fellowship")).toBe("_ isn't in your Fellowship");
    expect(isTargetPromptNotice('Click a character to recruit.')).toBe(true);
    expect(isTargetPromptNotice('Click a character to dismiss.')).toBe(true);
    expect(isTargetPromptNotice('Click your Patron or a Vassal to break Allegiance. Click anywhere to abort.')).toBe(true);
    expect(isSpewStatusNotice('Break Allegiance cancelled')).toBe(true);
  });
});

// ── The panes themselves (real GameUI against a mock LayoutRenderer) ─────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const BTN_SLICES = [0x100002ce, 0x100002cf, 0x100002d0];
const ALLEG_PANE = 0x10000291;
const FELLOW_PANE = 0x10000292;
const FELLOW_BTNS = [0x1000027b, 0x1000027c, 0x1000027d, 0x1000027e, 0x1000027f, 0x10000280];
const ALLEG_BTNS = { swear: 0x10000263, break: 0x10000264, kick: 0x10000265 } as const;

describe('the social panes run each era\'s flow', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let steps: any[] = [];
  let spew: string[] = [];
  let swears: number[] = [];
  let breaks: number[] = [];
  let dialogs: string[] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'animationFrame');
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const mk = (parent: HTMLElement, id: number): HTMLElement => {
      const el = domWindow.document.createElement('div');
      el.dataset.elementId = `0x${id.toString(16)}`;
      parent.appendChild(el);
      return el;
    };
    const TOP_IDS = [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, 0x10000513, ALLEG_PANE, FELLOW_PANE, 0x1000054a];
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of TOP_IDS) elements.set(id, mk(root, id));
        // Fellowship pane.
        const fpane = elements.get(FELLOW_PANE)!;
        const inFrame = mk(fpane, 0x10000275);
        for (const id of [0x10000276, 0x10000277, 0x10000278]) mk(inFrame, id);
        mk(inFrame, 0x10000279).style.height = '487px';
        mk(inFrame, 0x1000027a);
        for (const id of FELLOW_BTNS) { const b = mk(inFrame, id); for (const s of BTN_SLICES) mk(b, s); }
        const emptyFrame = mk(fpane, 0x1000026b);
        for (const id of [0x1000026c, 0x1000026d, 0x1000026e, 0x1000026f]) mk(emptyFrame, id);
        // Allegiance pane.
        const apane = elements.get(ALLEG_PANE)!;
        const header = mk(apane, 0x10000250);
        for (const id of [0x10000251, 0x10000252, 0x10000253, 0x10000254]) mk(header, id);
        const monarchField = mk(apane, 0x10000255);
        for (const id of [0x10000256, 0x10000257, 0x10000258, 0x10000259]) mk(monarchField, id);
        const monXp = mk(monarchField, 0x10000490); mk(monXp, 0x10000491); mk(monXp, 0x10000492);
        const patronField = mk(apane, 0x1000025a);
        for (const id of [0x1000025b, 0x1000025c, 0x1000025d]) mk(patronField, id);
        const patXp = mk(patronField, 0x10000490); mk(patXp, 0x10000491); mk(patXp, 0x10000492);
        mk(apane, 0x1000025e); mk(apane, 0x1000025f);
        mk(apane, 0x10000260).style.height = '350px';
        mk(apane, 0x10000261); mk(apane, 0x10000262);
        for (const id of Object.values(ALLEG_BTNS)) { const b = mk(apane, id); for (const s of BTN_SLICES) mk(b, s); }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {},
          setVisible: (id: number, on: boolean) => { const el = elements.get(id); if (el) el.style.display = on ? '' : 'none'; },
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (layoutId: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(layoutId, parent),
    };
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });

  beforeEach(() => {
    steps = []; spew = []; swears = []; breaks = []; dialogs = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ui.callbacks.onFellowshipSteps = (s: any[]) => { steps.push(...s); };
    ui.callbacks.onAllegianceSwear = (g: number) => { swears.push(g); };
    ui.callbacks.onAllegianceBreak = (g: number) => { breaks.push(g); };
    ui.displayErrorText = (t: string) => { spew.push(t); };
    ui.showConfirmationDialog = (msg: string, cb: (ok: boolean) => void) => { dialogs.push(msg); cb(true); };
    if (ui.uiManager.currentScreen !== 'game') ui.uiManager.setScreen('game');
    ui.selectedFellowGuid = null;
    ui.selectedVassalName = null;
    ui.hudState.target = null;
    ui.setFellowshipData({
      fellowshipName: 'Test Fellowship', leaderGuid: 100, shareXP: false, evenShare: false, open: false, isLocked: false, selfGuid: 100,
      fellows: [
        { guid: 100, name: 'Self Test', level: 50, shareLoot: true },
        { guid: 2, name: 'Other Fellow', level: 40, shareLoot: true },
      ],
    });
    ui.setAllegianceData({
      allegianceName: 'Test Allegiance', playerRank: 3, totalMembers: 5, totalVassals: 2, isLocked: false, selfGuid: 100,
      members: [
        { guid: 1, parentGuid: 0, name: 'Monarch Test', level: 275, rank: 10, isOnline: true, xpProduced: 1 },
        { guid: 5, parentGuid: 1, name: 'Patron Test', level: 180, rank: 7, isOnline: true, xpProduced: 1 },
        { guid: 100, parentGuid: 5, name: 'Self Test', level: 120, rank: 3, isOnline: true, xpProduced: 1 },
        { guid: 2, parentGuid: 100, name: 'Vassal Alpha', level: 150, rank: 5, isOnline: true, xpProduced: 1 },
        { guid: 3, parentGuid: 100, name: 'Vassal Beta', level: 96, rank: 4, isOnline: false, xpProduced: 1 },
      ],
    });
  });

  function show(tab: 'fellowship' | 'allegiance'): void {
    ui.socialTab = tab;
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  }
  function el(id: number): HTMLElement { return ui.socialPanel.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement; }
  function click(e: HTMLElement): void { e.dispatchEvent(new domWindow.Event('click', { bubbles: true })); }
  function mousedown(e: HTMLElement): void { e.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, button: 0 })); }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('BUG.ac1999-fellow-recruit-silent: Recruit sends once per click, however often the pane re-renders', () => {
    ui.setClientRules(R1999);
    let presses = 0;
    ui.callbacks.onFellowshipRecruitSelected = () => { presses++; return [{ kind: 'recruit', guid: 7 }]; };
    try {
      show('fellowship');
      // Fellowship updates and row clicks rebuild the pane; its buttons must not gather listeners.
      for (let i = 0; i < 4; i++) show('fellowship');
      click(el(0x1000027e));
      expect(presses).toBe(1);
      for (let i = 0; i < 4; i++) click(el(0x1000027e));
      expect(presses).toBe(5);
      // A held press (mousedown with no click) sends nothing.
      mousedown(el(0x1000027e));
      expect(presses).toBe(5);
    } finally {
      ui.callbacks.onFellowshipRecruitSelected = undefined;
    }
  });

  it('1999 fellowship: Dismiss is live for the leader with nothing selected and arms the click mode', () => {
    ui.setClientRules(R1999);
    show('fellowship');
    click(el(0x1000027f));
    expect(steps).toEqual([{ kind: 'targetMode', mode: 'dismiss', text: 'Click a character to dismiss.' }]);
  });

  it('end of retail fellowship: Dismiss stays off without a selected fellow, then dismisses the selection', () => {
    ui.setClientRules(REOR);
    show('fellowship');
    click(el(0x1000027f));
    expect(steps).toEqual([]);
    ui.selectedFellowGuid = 2;
    show('fellowship');
    click(el(0x1000027f));
    expect(steps).toEqual([{ kind: 'dismiss', guid: 2 }]);
  });

  it('1999 allegiance: Swear sends at once with no dialog; the Kick slot is Show XP', async () => {
    ui.setClientRules(R1999);
    ui.hudState.target = { id: 77, name: 'Lord Test', type: 'player', isPlayer: true };
    // The 1999 swear button shows once the swear cost (at least 100) is met.
    ui.charInfo.unassignedXp = 1000;
    // The Swear gate needs no patron: drop ours.
    ui.setAllegianceData({ allegianceName: '', playerRank: 0, totalMembers: 0, totalVassals: 0, isLocked: false, selfGuid: 100,
      members: [{ guid: 100, parentGuid: 0, name: 'Self Test', level: 120, rank: 1, isOnline: true, xpProduced: 0 }] });
    show('allegiance');
    click(el(ALLEG_BTNS.swear));
    expect(dialogs).toEqual([]);
    expect(swears).toEqual([77]);
    // Kick's slot is the 1999 Show XP / Show Titles toggle (verify-ac1999-allegpanel-and-target-modes.ts).
    expect(el(ALLEG_BTNS.kick).textContent).toContain('Show XP');
  });

  it('1999 allegiance Break: prompt, a vassal row breaks with that vassal; elsewhere cancels', async () => {
    ui.setClientRules(R1999);
    show('allegiance');
    click(el(ALLEG_BTNS.break));
    expect(dialogs).toEqual([]);
    expect(spew).toEqual(['Click your Patron or a Vassal to break Allegiance. Click anywhere to abort.']);
    await tick();
    const vassalRow = ui.socialPanel.querySelector('.vassal-row[data-allegiance-guid="3"]') as HTMLElement;
    mousedown(vassalRow); click(vassalRow);
    expect(breaks).toEqual([3]);
    // Again, then a click off every row.
    click(el(ALLEG_BTNS.break));
    await tick();
    mousedown(el(0x10000250)); click(el(0x10000250));
    expect(breaks).toEqual([3]);
    expect(spew.at(-1)).toBe('Break Allegiance cancelled');
    // The patron's field is a row too.
    click(el(ALLEG_BTNS.break));
    await tick();
    mousedown(el(0x1000025c)); click(el(0x1000025c));
    expect(breaks).toEqual([3, 5]);
  });

  it('end of retail allegiance: Break confirms in a dialog and breaks with the patron; Kick stays', () => {
    ui.setClientRules(REOR);
    show('allegiance');
    click(el(ALLEG_BTNS.break));
    expect(dialogs).toEqual(['Are you sure you wish to break from Patron Test?']);
    expect(breaks).toEqual([5]);
    expect(spew).toEqual([]);
    expect(el(ALLEG_BTNS.kick).style.display).not.toBe('none');
  });
});
