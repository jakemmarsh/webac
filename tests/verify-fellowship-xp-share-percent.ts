/**
 * VISUAL3.47 — fellowship member rows show retail's "LVL/XP%" value
 * (e.g. "1/55%"), not a bare "Lv N".
 *
 * ACE's cpCached/lumCached wire fields are hardcoded to 0 server-side
 * (GameEventFellowshipFullUpdate.cs:49, GameEventFellowshipUpdateFellow.cs:16),
 * so the percentage can't come from the wire. The decompiled retail client
 * computes it client-side instead (gmFellowshipUI::UpdateFellowStats,
 * acclient-decompiled.c:144764) from data already on the wire: each fellow's
 * level, the shareXP/evenShare flags, and fellow count — via
 * Fellowship::CalculateExperienceProportionSum / FellowshipSystem::Get
 * ExperienceProportion (proportional split, acclient-decompiled.c:426778,
 * 427465) or FellowshipSystem::GetEvenSplitXPPctg (even split, a literal
 * party-size lookup table, acclient-decompiled.c:427477).
 *
 * Two layers of coverage: pure-function tests for the shared formula module,
 * and a behavioral GameUI test driving the real renderSocialPanel in
 * happy-dom (see verify-allegiance-kick.ts for the established recipe).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import {
  getEvenSplitXpPctg, getExperienceProportion, getFellowshipXpSharePercent, getFellowshipXpShareDisplayPercent,
} from '../packages/shared/src/character/FellowshipXpShare.js';

describe('getEvenSplitXpPctg — FellowshipSystem::GetEvenSplitXPPctg literal table', () => {
  it('matches the decompiled float32 switch table for 1..10 members', () => {
    expect(getEvenSplitXpPctg(1)).toBeCloseTo(1.0, 5);
    expect(getEvenSplitXpPctg(2)).toBeCloseTo(0.75, 5);
    expect(getEvenSplitXpPctg(3)).toBeCloseTo(0.6, 5);
    expect(getEvenSplitXpPctg(4)).toBeCloseTo(0.55, 5);
    expect(getEvenSplitXpPctg(5)).toBeCloseTo(0.5, 5);
    expect(getEvenSplitXpPctg(6)).toBeCloseTo(0.45, 5);
    expect(getEvenSplitXpPctg(7)).toBeCloseTo(0.4, 5);
    expect(getEvenSplitXpPctg(8)).toBeCloseTo(0.35, 5);
    expect(getEvenSplitXpPctg(9)).toBeCloseTo(0.311111, 5);
    expect(getEvenSplitXpPctg(10)).toBeCloseTo(0.28, 5);
  });

  it('falls back to the retail default (0) past 10 members', () => {
    expect(getEvenSplitXpPctg(11)).toBe(0);
    expect(getEvenSplitXpPctg(0)).toBe(0);
  });
});

describe('getExperienceProportion — ExperienceToRaiseLevel(level, level+1) weight', () => {
  const levelXpTable = [0n, 0n, 1000n, 2500n, 5000n]; // level 0..4 cumulative thresholds

  it('is the delta between consecutive level thresholds', () => {
    expect(getExperienceProportion(1, levelXpTable)).toBe(1000n);
    expect(getExperienceProportion(2, levelXpTable)).toBe(1500n);
    expect(getExperienceProportion(3, levelXpTable)).toBe(2500n);
  });

  it('is 0 at/past the table ceiling (no next-level threshold to diff against)', () => {
    expect(getExperienceProportion(4, levelXpTable)).toBe(0n);
    expect(getExperienceProportion(99, levelXpTable)).toBe(0n);
  });
});

describe('getFellowshipXpSharePercent', () => {
  const levelXpTable = [0n, 0n, 1000n, 2500n, 5000n];

  it('even split: every fellow gets the same party-size lookup percentage', () => {
    const levels = [1, 3]; // 2-member fellowship
    expect(getFellowshipXpSharePercent(1, levels, true, levelXpTable)).toBeCloseTo(75, 3);
    expect(getFellowshipXpSharePercent(3, levels, true, levelXpTable)).toBeCloseTo(75, 3);
  });

  it('proportional split: each fellow gets weight/sum, summing to ~100%', () => {
    const levels = [1, 3]; // weights 1000 and 2500 -> sum 3500
    const pctLow = getFellowshipXpSharePercent(1, levels, false, levelXpTable);
    const pctHigh = getFellowshipXpSharePercent(3, levels, false, levelXpTable);
    expect(pctLow).toBeCloseTo((1000 / 3500) * 100, 3);
    expect(pctHigh).toBeCloseTo((2500 / 3500) * 100, 3);
    expect(pctLow + pctHigh).toBeCloseTo(100, 3);
  });

  it('a maxed-out fellow (no next-level weight) shares nothing proportionally', () => {
    expect(getFellowshipXpSharePercent(4, [4, 1], false, levelXpTable)).toBe(0);
  });
});

describe('getFellowshipXpShareDisplayPercent — the EXPERIENCE integer UpdateFellowStats @ 0048eb20 formats', () => {
  const levelXpTable = [0n, 0n, 1000n, 2500n, 5000n];

  it('is 0 when the fellowship shares no XP (the float starts at 0 @ 0048ec17)', () => {
    expect(getFellowshipXpShareDisplayPercent(1, [1, 3], false, false, levelXpTable)).toBe(0);
    expect(getFellowshipXpShareDisplayPercent(1, [1, 3], false, true, levelXpTable)).toBe(0);
  });

  it('truncates (_ftol2), never rounds: 1000/3500 = 28.57% reads 28', () => {
    expect(getFellowshipXpShareDisplayPercent(1, [1, 3], true, false, levelXpTable)).toBe(28);
    expect(getFellowshipXpShareDisplayPercent(3, [1, 3], true, false, levelXpTable)).toBe(71);
  });

  it('multiplies the float32-stored fraction: 0.45f and 0.35f even splits read 44 and 34', () => {
    const party = (n: number) => Array.from({ length: n }, () => 10);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => getFellowshipXpShareDisplayPercent(10, party(n), true, true, null)))
      .toEqual([100, 75, 60, 55, 50, 44, 40, 34, 31, 28]);
  });

  it('a proportional split with no XP table yet reads 0; the even split needs none', () => {
    expect(getFellowshipXpShareDisplayPercent(1, [1, 3], true, false, null)).toBe(0);
    expect(getFellowshipXpShareDisplayPercent(1, [1, 3], true, true, null)).toBe(75);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('VISUAL3.47 — fellowship row LVL/XP% render (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const levelXpTable = [0n, 0n, 1000n, 2500n, 5000n];

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    if (typeof g.requestAnimationFrame !== 'function') {
      g.requestAnimationFrame = (cb: (t: number) => void) => { cb(0); return 0; };
    }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // Stub layout handle mirroring the resolved social container 0x21000031
    // with the fellowship pane's DAT-native chrome (CORE.5.c.d.b): the rows
    // render into the real list region 0x10000279 under sub-pane 0x10000275.
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

  function panel(): HTMLElement { return ui.socialPanel as HTMLElement; }
  function fellowRow(name: string): HTMLElement {
    return panel().querySelector(`[data-fellow-name="${name}"]`) as HTMLElement;
  }

  function seed(fellowshipOverrides: Record<string, unknown>) {
    ui.socialTab = 'fellowship';
    ui.setFellowshipData({
      fellowshipName: 'Test Fellowship', leaderGuid: 1, open: false, isLocked: false,
      shareXP: true, evenShare: true,
      fellows: [
        { guid: 1, name: 'Leader Test', level: 1, healthCurrent: 10, healthMax: 10, staminaCurrent: 10, staminaMax: 10, manaCurrent: 10, manaMax: 10, shareLoot: true },
        { guid: 2, name: 'Member Two', level: 3, healthCurrent: 10, healthMax: 10, staminaCurrent: 10, staminaMax: 10, manaCurrent: 10, manaMax: 10, shareLoot: true },
      ],
      ...fellowshipOverrides,
    });
    ui.levelXpTable = levelXpTable;
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  }

  beforeEach(() => {
    ui.socialPanelVisible = false;
    ui.socialPanel = null;
  });

  it('even split: both fellows show the same party-size percentage', () => {
    seed({ shareXP: true, evenShare: true }); // 2 members -> GetEvenSplitXPPctg(2) = 75%
    expect(fellowRow('Leader Test').textContent).toContain('1/75%');
    expect(fellowRow('Member Two').textContent).toContain('3/75%');
  });

  it('proportional split: each fellow shows its own weight/sum percentage', () => {
    // level 1 weight=1000, level 3 weight=2500, sum=3500 -> 28%/71% (_ftol2 truncates)
    seed({ shareXP: true, evenShare: false });
    expect(fellowRow('Leader Test').textContent).toContain('1/28%');
    expect(fellowRow('Member Two').textContent).toContain('3/71%');
  });

  it('no XP share: still the LEVEL/EXPERIENCE% template, with 0% (no invented "Lv N")', () => {
    seed({ shareXP: false, evenShare: false });
    expect(fellowRow('Leader Test').textContent).toContain('1/0%');
    expect(fellowRow('Member Two').textContent).toContain('3/0%');
    expect(fellowRow('Leader Test').textContent).not.toContain('Lv');
  });

  it('levelXpTable not yet loaded: the even split still shows its lookup, a proportional split 0%', () => {
    seed({ shareXP: true, evenShare: true });
    ui.levelXpTable = null;
    ui.renderSocialPanel();
    expect(fellowRow('Leader Test').textContent).toContain('1/75%');
    seed({ shareXP: true, evenShare: false });
    ui.levelXpTable = null;
    ui.renderSocialPanel();
    expect(fellowRow('Leader Test').textContent).toContain('1/0%');
  });
});
