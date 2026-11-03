/**
 * VISUAL.ac1999-allegpanel-swear-label + BUG.ac1999-fellowship-target-mode-clicks + BUG.agent-recruit-claims-refused.
 *
 * The 1999 allegiance pane (AllegPanel @ 0x0052bf80):
 *  - the swear area (AllegPanel_SetXPChange @ 0x0052ddd0, AllegPanel_HandleSelection @ 0x0052fcd0): with no
 *    patron, the swear cost (AllegianceSystem_SwearAllegianceCost @ 0x005ee070: the XP to the next level
 *    × 0.05, clamped 100…5000, × (breaks / 4 + 1), +0.5 truncated); short of it, "xp available / xp
 *    needed" and "You don't have enough available xp to swear Allegiance." (or the at-your-level pair);
 *    met, "Swear Allegiance To <name>" on the button with a valid selection, else "SELECT A CHARACTER TO
 *    SWEAR ALLEGIANCE TO.", and "xp cost: N" either way;
 *  - Show XP / Show Titles (ListenToMessage @ 0x00530a70): titles mode by default (names prefixed by the
 *    rank title, no XP), Show XP mode shows the XP produced; "Break Allegiance" on its button.
 * The 1999 target modes (SetTargetMode @ 0x004d0220, the mouse dispatch 0x00414030): recruit / dismiss
 * show the use cursor, end on the next left press anywhere, never select, and a fellow's row does nothing
 * in recruit mode; Break's next left press anywhere (the world too) ends it and does nothing else.
 * The agent's recruit reports the client's refusal instead of claiming a request went out.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import {
  swearAllegianceCost1999, swearArea1999, titledName1999, AC1999_ALLEGIANCE_PANE_TEXT,
} from '../packages/renderer/src/ui/AllegiancePanelFlow.js';
import {
  WorldTargetModeController, isOneClickMode, oneClickPressRoute, swallowPress, fellowRowPress,
} from '../packages/renderer/src/input/WorldTargetMode.js';
import { resolveWorldCursorName } from '../packages/renderer/src/ui/CursorManager.js';
import { CombatMode } from '@ac/shared';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost } from './_harness/agentFake.ts';

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const REOR = eraClientRules(eraProfile('eor'));

// table[n] = the XP to reach level n.
const TABLE: bigint[] = [0n, 0n, 1000n, 3000n, 6000n, 50000n, 2_000_000n, 2_400_000n];

describe('the 1999 swear cost (AllegianceSystem_SwearAllegianceCost @ 0x005ee070)', () => {
  it('0.05 × the XP to the next level, clamped to 100 … 5000, × (breaks / 4 + 1), rounded half up', () => {
    expect(swearAllegianceCost1999(1, TABLE, 0)).toBe(100); // 1000 × 0.05 = 50 → 100
    expect(swearAllegianceCost1999(4, TABLE, 0)).toBe(2200); // 44000 × 0.05
    expect(swearAllegianceCost1999(5, TABLE, 0)).toBe(5000); // 1,950,000 × 0.05 → 5000
    expect(swearAllegianceCost1999(4, TABLE, 1)).toBe(2750); // × 1.25
    expect(swearAllegianceCost1999(4, TABLE, 2)).toBe(3300); // × 1.5
    expect(swearAllegianceCost1999(1, [0n, 0n, 2345n], 1)).toBe(147); // 117.25 × 1.25 + 0.5 → 147
    expect(swearAllegianceCost1999(9, TABLE, 0)).toBe(100); // past the table: 0 → 100
  });
});

describe('the 1999 swear area (SetXPChange @ 0x0052ddd0 / HandleSelection @ 0x0052fcd0)', () => {
  const base = { hasPatron: false, level: 4, totalXp: 6000, unassignedXp: 5000, table: TABLE, breaks: 0, eligibleTarget: null as string | null };
  it('with a patron there is none', () => {
    expect(swearArea1999({ ...base, hasPatron: true })).toEqual({ kind: 'hidden' });
  });
  it('cost met: the button for a valid selection, else the select prompt; the cost either way', () => {
    expect(swearArea1999({ ...base, eligibleTarget: 'Lord Test' })).toEqual({ kind: 'swear', cost: 2200, name: 'Lord Test' });
    expect(swearArea1999(base)).toEqual({ kind: 'select', cost: 2200 });
  });
  it('short, more XP to the next level than the cost: available / needed (the cost)', () => {
    expect(swearArea1999({ ...base, unassignedXp: 300 })).toEqual({ kind: 'short', available: 300, needed: 2200 });
  });
  it('short, and the cost is at least the XP to the next level: the at-your-level message', () => {
    expect(swearArea1999({ ...base, unassignedXp: 300, totalXp: 49000 })).toEqual({ kind: 'level' });
  });
  it('a titled name is the title, a space, the name (the name alone without one)', () => {
    expect(titledName1999('Bob', 'Baronet')).toBe('Baronet Bob');
    expect(titledName1999('Bob', '')).toBe('Bob');
  });
});

describe('the 1999 recruit / dismiss target modes', () => {
  it('a miss ends a one-click mode; use / examine stay armed on a miss (end of retail)', () => {
    const c = new WorldTargetModeController();
    c.arm('recruit');
    expect(c.consumeClick(null)).toEqual({ kind: 'miss' });
    expect(c.current).toBe('none');
    c.trigger('use', null);
    expect(c.consumeClick(null)).toEqual({ kind: 'miss' });
    expect(c.current).toBe('use');
    expect(isOneClickMode('dismiss')).toBe(true);
    expect(isOneClickMode('use')).toBe(false);
  });
  it('they show the use cursor (SetTargetMode arms 1, 7 and 8 all load the UI +0x35c cursor)', () => {
    for (const m of ['recruit', 'dismiss'] as const) {
      expect(resolveWorldCursorName(CombatMode.NonCombat, false, m)).toBe('Use');
      expect(resolveWorldCursorName(CombatMode.NonCombat, true, m)).toBe('Use_OverObject');
    }
  });
  it('a fellow row: dismiss runs on that fellow, recruit only ends the mode; no mode → the row\'s own click', () => {
    const c = new WorldTargetModeController();
    expect(fellowRowPress(c, 5)).toBeNull();
    c.arm('dismiss');
    expect(fellowRowPress(c, 5)).toEqual({ run: 'dismiss', guid: 5 });
    expect(c.current).toBe('none');
    c.arm('recruit');
    expect(fellowRowPress(c, 5)).toEqual({ run: null, guid: 5 });
    expect(c.current).toBe('none');
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const BTN_SLICES = [0x100002ce, 0x100002cf, 0x100002d0];
const ALLEG_PANE = 0x10000291;
const FELLOW_PANE = 0x10000292;
const ALLEG_BTNS = { swear: 0x10000263, break: 0x10000264, kick: 0x10000265 } as const;

describe('DOM: the press routing and the panes', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let spew: string[] = [];
  let swears: number[] = [];
  let breaks: number[] = [];

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
        const rects: Record<number, [number, number, number, number]> = { [ALLEG_BTNS.swear]: [9, 562, 88, 33], [ALLEG_BTNS.break]: [106, 562, 88, 33], [ALLEG_BTNS.kick]: [203, 562, 88, 32] };
        for (const id of Object.values(ALLEG_BTNS)) {
          const b = mk(apane, id);
          const [x, y, w, h] = rects[id];
          Object.assign(b.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
          for (const s of BTN_SLICES) mk(b, s);
        }
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

  const withPatron = () => ui.setAllegianceData({
    allegianceName: 'Test Allegiance', playerRank: 3, totalMembers: 5, totalVassals: 2, isLocked: false, selfGuid: 100,
    members: [
      { guid: 1, parentGuid: 0, name: 'Monarch Test', level: 275, rank: 10, isOnline: true, xpProduced: 1, heritage: 1, gender: 1 },
      { guid: 5, parentGuid: 1, name: 'Patron Test', level: 180, rank: 7, isOnline: true, xpProduced: 1, heritage: 2, gender: 2 },
      { guid: 100, parentGuid: 5, name: 'Self Test', level: 120, rank: 3, isOnline: true, xpProduced: 4321, heritage: 1, gender: 1 },
      { guid: 2, parentGuid: 100, name: 'Vassal Alpha', level: 150, rank: 2, isOnline: true, xpProduced: 12500, heritage: 1, gender: 1 },
      { guid: 3, parentGuid: 100, name: 'Vassal Beta', level: 96, rank: 1, isOnline: false, xpProduced: 3400, heritage: 3, gender: 2 },
    ],
  });
  const noPatron = () => ui.setAllegianceData({
    allegianceName: '', playerRank: 0, totalMembers: 0, totalVassals: 0, isLocked: false, selfGuid: 100,
    members: [{ guid: 100, parentGuid: 0, name: 'Self Test', level: 4, rank: 1, isOnline: true, xpProduced: 0 }],
  });

  beforeEach(() => {
    spew = []; swears = []; breaks = [];
    ui.callbacks.onAllegianceSwear = (g: number) => { swears.push(g); };
    ui.callbacks.onAllegianceBreak = (g: number) => { breaks.push(g); };
    ui.displayErrorText = (t: string) => { spew.push(t); };
    ui.showConfirmationDialog = (_m: string, cb: (ok: boolean) => void) => cb(true);
    if (ui.uiManager.currentScreen !== 'game') ui.uiManager.setScreen('game');
    ui.hudState.target = null;
    ui.allegianceShowXp1999 = false;
    ui.levelXpTable = TABLE;
    ui.charInfo.level = 4; ui.charInfo.totalXp = 6000; ui.charInfo.unassignedXp = 5000;
    ui.allegianceBreaks = 0;
    ui.socialTab = 'allegiance';
  });
  function show(): void { if (!ui.socialPanelVisible) ui.toggleSocialPanel(); else ui.renderSocialPanel(); }
  function el(id: number): HTMLElement { return ui.socialPanel.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement; }
  function click(e: HTMLElement): void { e.dispatchEvent(new domWindow.Event('click', { bubbles: true })); }
  const line = (role: string): string | null => (ui.socialPanel.querySelector(`#alleg-swear-1999 [data-swear-line="${role}"]`) as HTMLElement | null)?.textContent ?? null;
  const rows = (): string[] => [...ui.socialPanel.querySelectorAll('.vassal-row')].map((r: Element) => r.textContent ?? '');

  it('oneClickPressRoute: the world canvas, the radar and a fellow\'s row take the press; any other control ends the mode', () => {
    const doc = domWindow.document as Document;
    const canvas = doc.createElement('canvas');
    const radar = doc.createElement('canvas'); radar.id = 'radar-canvas';
    const row = doc.createElement('div'); row.dataset.fellowGuid = '5';
    const strip = doc.createElement('span'); row.appendChild(strip);
    const button = doc.createElement('div');
    for (const n of [canvas, radar, row, button]) doc.body.appendChild(n);
    expect(oneClickPressRoute(canvas, canvas)).toBe('pass');
    expect(oneClickPressRoute(radar, canvas)).toBe('pass');
    expect(oneClickPressRoute(strip, canvas)).toBe('pass');
    expect(oneClickPressRoute(button, canvas)).toBe('end');
    expect(oneClickPressRoute(null, canvas)).toBe('end');
  });

  it('swallowPress eats the press and the click after it, and no later click', () => {
    const doc = domWindow.document as Document;
    const b = doc.createElement('div'); doc.body.appendChild(b);
    let clicks = 0;
    b.addEventListener('click', () => { clicks++; });
    const md = new domWindow.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    swallowPress(md, doc);
    expect(md.defaultPrevented).toBe(true);
    b.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(clicks).toBe(0);
    b.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(clicks).toBe(1);
  });

  it('1999 titles mode (the default): rank titles before names, no XP; Show XP flips to names and XP', () => {
    ui.setClientRules(R1999);
    withPatron();
    show();
    expect(el(0x10000257).textContent).toContain('High King Monarch Test');
    expect(el(0x1000025c).textContent).toContain('Mushira Patron Test');
    expect(rows()[0]).toContain('Baronet Vassal Alpha');
    expect(rows()[1]).toContain('Jinin Vassal Beta');
    expect(rows()[0]).not.toContain('12,500');
    expect(el(0x1000025f).style.display).toBe('none');
    expect(el(ALLEG_BTNS.kick).textContent).toContain(AC1999_ALLEGIANCE_PANE_TEXT.showXp);
    expect(el(ALLEG_BTNS.break).textContent).toContain('Break Allegiance');
    // The 1999 bottom row: Show XP at x 0x19, Break Allegiance at x 0x96, 0x78 wide each.
    expect(el(ALLEG_BTNS.kick).style.left).toBe('25px');
    expect(el(ALLEG_BTNS.break).style.left).toBe('150px');
    expect(el(ALLEG_BTNS.break).style.width).toBe('120px');
    // With a patron there is no swear area and the button is hidden.
    expect(ui.socialPanel.querySelector('#alleg-swear-1999')).toBeNull();
    expect(el(ALLEG_BTNS.swear).style.display).toBe('none');
    click(el(ALLEG_BTNS.kick));
    expect(el(ALLEG_BTNS.kick).textContent).toContain(AC1999_ALLEGIANCE_PANE_TEXT.showTitles);
    expect(rows()[0]).toContain('Vassal Alpha');
    expect(rows()[0]).not.toContain('Baronet');
    expect(rows()[0]).toContain('12,500');
    expect(el(0x1000025c).textContent).not.toContain('Mushira');
    expect(el(0x1000025f).style.display).not.toBe('none');
  });

  it('1999 swear area: select prompt + cost, then "Swear Allegiance To <name>" for a valid selection, and it swears', () => {
    ui.setClientRules(R1999);
    noPatron();
    show();
    expect(line('message')).toBe(AC1999_ALLEGIANCE_PANE_TEXT.selectPrompt);
    expect(line('cost')).toBe('xp cost: 2,200');
    expect(el(ALLEG_BTNS.swear).style.display).toBe('none');
    ui.hudState.target = { id: 77, name: 'Lord Test', type: 'player', isPlayer: true };
    ui.updateAllegianceSwearButton(); // the per-frame check sees the selection change and redraws
    expect(line('message')).toBeNull();
    expect(line('cost')).toBe('xp cost: 2,200');
    const swear = el(ALLEG_BTNS.swear);
    expect(swear.style.display).not.toBe('none');
    expect(swear.textContent).toContain('Swear Allegiance To Lord Test');
    expect(swear.style.top).toBe('58px');
    expect(swear.style.width).toBe('292px');
    click(swear);
    expect(swears).toEqual([77]);
  });

  it('1999 swear area short of the cost: available / needed and the message; at your level: the other pair', () => {
    ui.setClientRules(R1999);
    noPatron();
    ui.charInfo.unassignedXp = 300;
    show();
    expect(line('available')).toBe('xp available: 300');
    expect(line('needed')).toBe('xp needed: 2,200');
    expect(line('message')).toBe(AC1999_ALLEGIANCE_PANE_TEXT.notEnough);
    ui.charInfo.totalXp = 49000;
    show();
    expect(line('message')).toBe(AC1999_ALLEGIANCE_PANE_TEXT.notAtLevel);
    expect(line('note')).toBe(AC1999_ALLEGIANCE_PANE_TEXT.checkAgain);
    // The agent's Swear says why instead of sending.
    ui.hudState.target = { id: 77, name: 'Lord Test', type: 'player', isPlayer: true };
    expect(ui.agentSwearAllegiance()).toBe(AC1999_ALLEGIANCE_PANE_TEXT.notAtLevel);
    expect(swears).toEqual([]);
  });

  it('1999 Break: a left press in the world cancels it and does nothing else; a right press leaves it armed', async () => {
    ui.setClientRules(R1999);
    withPatron();
    show();
    click(el(ALLEG_BTNS.break));
    await new Promise((r) => setTimeout(r, 0));
    const world = domWindow.document.createElement('canvas');
    domWindow.document.body.appendChild(world);
    let worldPresses = 0;
    world.addEventListener('mousedown', () => { worldPresses++; });
    world.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, button: 2 }));
    expect(spew.at(-1)).not.toBe('Break Allegiance cancelled');
    world.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(spew.at(-1)).toBe('Break Allegiance cancelled');
    expect(worldPresses).toBe(1); // only the right press reached the world
    expect(breaks).toEqual([]);
  });

  it('1999 bottom row: 0x78-wide buttons, art re-laid to the width, the label centred in it (live: "reak Allegiance")', () => {
    ui.setClientRules(R1999);
    noPatron();
    // A 110 px label, as "Break Allegiance" is: centred in 120 px it starts at 5, in the old 88 px at -11.
    const real = ui.renderDatText;
    ui.renderDatText = (t: string, ref: string, st: number, o: { color?: string }) => {
      const e = domWindow.document.createElement('div');
      e.textContent = t;
      Object.assign(e.style, { width: '110px', height: '14px', color: o?.color ?? '' });
      return e;
    };
    try {
      show();
      for (const id of [ALLEG_BTNS.kick, ALLEG_BTNS.break]) {
        const b = el(id);
        expect(b.style.width).toBe('120px');
        const [l, m, r] = [0x100002ce, 0x100002cf, 0x100002d0].map((sid) => b.querySelector(`[data-element-id="0x${sid.toString(16)}"]`) as HTMLElement);
        const px = (v: string): number => parseFloat(v) || 0;
        expect([px(l.style.left), px(l.style.width)]).toEqual([0, 32]);
        expect([px(m.style.left), px(m.style.width)]).toEqual([32, 56]);
        expect([px(r.style.left), px(r.style.width)]).toEqual([88, 32]);
        const label = b.querySelector('.layout-text > div') as HTMLElement;
        expect(label.style.left).toBe('5px');
      }
      expect(el(ALLEG_BTNS.kick).style.left).toBe('25px');
      expect(el(ALLEG_BTNS.break).style.left).toBe('150px');
    } finally {
      ui.renderDatText = real;
    }
  });

  it('1999 disabled look (no patron, no vassal): normal body art, the label in RGB 100, 100, 100; enabled: 210, 210, 200', () => {
    ui.setClientRules(R1999);
    noPatron();
    const real = ui.renderDatText;
    ui.renderDatText = (t: string, _ref: string, _st: number, o: { color?: string }) => {
      const e = domWindow.document.createElement('div');
      e.textContent = t;
      e.style.color = o?.color ?? '';
      return e;
    };
    try {
      show();
      for (const id of [ALLEG_BTNS.kick, ALLEG_BTNS.break]) {
        const b = el(id);
        expect(b.dataset.acState).toBe('d');
        expect([...b.querySelectorAll('[data-tex]')].map((n) => n.getAttribute('data-tex'))).toEqual(['0x06004c96', '0x06004c99', '0x06004c9c']);
        expect((b.querySelector('.layout-text > div') as HTMLElement).style.color).toBe('rgb(100, 100, 100)');
      }
      withPatron();
      show();
      for (const id of [ALLEG_BTNS.kick, ALLEG_BTNS.break]) {
        const b = el(id);
        expect(b.dataset.acState).not.toBe('d');
        expect((b.querySelector('.layout-text > div') as HTMLElement).style.color).toBe('rgb(210, 210, 200)');
      }
    } finally {
      ui.renderDatText = real;
    }
  });

  it('end of retail keeps its pane: no swear area, no titles, Kick and "Break" in place', () => {
    ui.setClientRules(REOR);
    withPatron();
    show();
    expect(ui.socialPanel.querySelector('#alleg-swear-1999')).toBeNull();
    expect(rows()[0]).not.toContain('Baronet');
    expect(rows()[0]).toContain('12,500');
    expect(el(0x10000257).textContent).not.toContain('High King');
    expect(el(ALLEG_BTNS.kick).style.left).toBe('203px');
    expect(el(ALLEG_BTNS.kick).textContent).not.toContain('Show XP');
  });

  it('the agent\'s recruit reports the client\'s refusal or nothing sent, and a real recruit as sent', () => {
    ui.setClientRules(R1999);
    ui.setFellowshipData({
      fellowshipName: 'F', leaderGuid: 100, shareXP: false, evenShare: false, open: false, isLocked: false, selfGuid: 100,
      fellows: [{ guid: 100, name: 'Self Test', level: 50, shareLoot: true }],
    });
    ui.callbacks.onFellowshipRecruitSelected = () => [{ kind: 'refuse', text: "You can't recruit yourself." }];
    expect(ui.agentFellowshipAction('recruit')).toBe("refused: You can't recruit yourself.");
    ui.callbacks.onFellowshipRecruitSelected = () => [{ kind: 'refuse', token: 'ID_Not_A_Real_Token' }];
    expect(ui.agentFellowshipAction('recruit')).toBe('refused: ID_Not_A_Real_Token');
    ui.callbacks.onFellowshipRecruitSelected = () => [];
    expect(ui.agentFellowshipAction('recruit')).toMatch(/^nothing sent/);
    let opts: unknown;
    ui.callbacks.onFellowshipRecruitSelected = (o: unknown) => { opts = o; return [{ kind: 'recruit', guid: 9 }]; };
    expect(ui.agentFellowshipAction('recruit')).toBeNull();
    expect(opts).toEqual({ agent: true });
  });
});

describe('AgentApi: a refused recruit is not reported as asked', () => {
  it('returns the refusal, not "asked … to join"', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      host.fellowshipText = 'fellowship "Tinkers": 1/9 fellows';
      (host as unknown as { fellowshipAction: () => string | null }).fellowshipAction = () => "refused: You can't recruit yourself.";
      const api = new AgentApi(host);
      host.add({ guid: 0x5000000a, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8 | 0x10, x: 81, y: 21 });
      const r = await api.fellowship('recruit', 'Claude Arcanist');
      expect(r).toEqual({ ok: false, message: "refused: You can't recruit yourself." });
      expect(r.message).not.toMatch(/asked/);
    } finally {
      vi.useRealTimers();
    }
  });
});
