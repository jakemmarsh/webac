/**
 * CORE.7 — the character panel's retail select-to-raise flow
 * (gmStatManagementUI family, decompiled EoL client):
 *
 *  - Rows are whole-row click targets that SELECT (UpdateSelection sets the
 *    row's media state 6 — gold bar 0x06000f93 — and swaps the footer page
 *    state to 0x10000012). The old per-row '+'/'Train' affordances (tiny,
 *    and rendered only when affordable) were Jake's "cannot always select
 *    for improving" bug.
 *  - Selection footer 0x10000241 per DisplaySelectionFooter_Attribute /
 *    _Vital / _Trained (@ 0049d280 / 0049d6b0 / 0049b860): title = name +
 *    value, "Experience To Raise:" + cost (str 175085980; "Infinity!"
 *    206482569 when maxed), "Unassigned Experience:" + pool (249332076),
 *    raise button 0x10000246 + raise-10 button 0x100005eb gated on
 *    affordability (state 1/13).
 *  - Untrained/Unusable skills per DisplaySelectionFooter_Untrained
 *    (@ 0049b350): "Skill Credits To Train" (218797164) + "Skill Credits
 *    Available:" (230538876), raise-10 HIDDEN (SetVisible(0)), the raise
 *    button trains.
 *  - Raise sends ONE action with the XP for the whole step
 *    (CM_Train::Event_TrainAttribute(statId, xp) — the +10 button passes
 *    GetCostToRaise10's clamped min(10, max-current) total), then sets
 *    m_bAwaitingRaise until the server ack (statRaiseAwaiting here,
 *    cleared when syncFromPlayerState sees the spendable pools change).
 *
 * Behavioral: drives the real GameUI renderers in happy-dom — no source
 * text pins.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

// ── Pure cost seam ─────────────────────────────────────────────────────

describe('CORE.7 — GameUI.statRaiseCosts (GetCostToRaise/GetCostToRaise10)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  beforeAll(async () => {
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });

  // Cumulative table: level 0 → 0, 1 → 100, 2 → 300, ... like the XpTable lists.
  const table = [0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500, 5500, 6600, 7800];

  it('cost1 is the cumulative diff to the next level', () => {
    expect(GameUICtor.statRaiseCosts(table, 0)).toMatchObject({ cost1: 100 });
    expect(GameUICtor.statRaiseCosts(table, 3)).toMatchObject({ cost1: 400 });
  });

  it('cost10 covers ten levels in one step', () => {
    // 0 → 10: 5500 - 0
    expect(GameUICtor.statRaiseCosts(table, 0).cost10).toBe(5500);
    // 2 → 12: 7800 - 300
    expect(GameUICtor.statRaiseCosts(table, 2).cost10).toBe(7500);
  });

  it('cost10 clamps to the remaining levels (min(10, max-current))', () => {
    // 8 → 12 (only 4 remain): 7800 - 3600
    expect(GameUICtor.statRaiseCosts(table, 8).cost10).toBe(4200);
  });

  it('maxed stat costs 0 for both (→ disabled / Infinity display)', () => {
    expect(GameUICtor.statRaiseCosts(table, 12)).toEqual({ cost1: 0, cost10: 0 });
  });

  it('missing table or out-of-range raises cost 0', () => {
    expect(GameUICtor.statRaiseCosts(undefined, 0)).toEqual({ cost1: 0, cost10: 0 });
    expect(GameUICtor.statRaiseCosts(table, 99)).toEqual({ cost1: 0, cost10: 0 });
    expect(GameUICtor.statRaiseCosts(table, -1)).toEqual({ cost1: 0, cost10: 0 });
  });
});

// ── Behavioral: select → footer → raise ────────────────────────────────

describe('CORE.7 — select-to-raise footer (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.getTexURL = (id: number): string => `tex:0x${id.toString(16)}`;
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function el(id: number, ...children: HTMLElement[]): HTMLElement {
    const d = domWindow.document.createElement('div');
    d.setAttribute('data-element-id', `0x${id.toString(16)}`);
    for (const c of children) d.appendChild(c);
    return d;
  }

  function statPaneScaffold(): HTMLElement {
    const meter = el(0x10000236, el(0x2), el(0x10000237), el(0x10000238));
    const footer247 = el(0x10000247);
    const footer240 = el(0x10000240, el(0x1000024e), el(0x10000242), el(0x10000243), el(0x10000244), el(0x10000245));
    const footer241 = el(0x10000241);
    const body = el(0x1000022b,
      el(0x10000226,
        el(0x10000231), el(0x10000232), el(0x10000233),
        el(0x100005c5), el(0x100005c6),
        el(0x10000234), el(0x10000235), meter,
        el(0x1000023a), el(0x1000023b),
        el(0x1000023d), el(0x1000023e),
        footer247, footer240, footer241,
      ),
    );
    domWindow.document.body.appendChild(body);
    return body;
  }

  const byId = (root: HTMLElement, id: number): HTMLElement | null =>
    root.querySelector(`[data-element-id="0x${id.toString(16)}"]`);
  const raiseBtn = (root: HTMLElement, id: number): HTMLElement | null =>
    root.querySelector(`[data-raise-button="0x${id.toString(16)}"]`);
  const rowByText = (root: HTMLElement, text: string): HTMLElement | null => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (Array.from(root.querySelectorAll('div')).find((d: any) =>
      d.style.cursor === 'pointer' && d.style.height === '20px' && d.textContent?.includes(text)) ?? null) as HTMLElement | null;
  };

  // Cumulative attribute/vital cost tables (small fakes shaped like XpTable lists).
  const ATTR_TABLE = [0, 100, 300, 600, 1000];
  const VITAL_TABLE = [0, 50, 150, 300];
  const TRAINED_TABLE = [0, 10, 30, 60, 100];

  beforeEach(() => {
    ui.selectedStatRow = null;
    ui.selectedSkillId = null;
    ui.statRaiseAwaiting = false;
    ui.raiseCallbacks = {};
    ui.xpCostTables = { attribute: ATTR_TABLE, vital: VITAL_TABLE, trainedSkill: TRAINED_TABLE, specializedSkill: TRAINED_TABLE };
    ui.charInfo.unassignedXp = 500;
    ui.charInfo.skillCredits = 2;
    ui.charInfo.skills = [];
    for (const a of Object.keys(ui.charInfo.attributes)) {
      ui.charInfo.attributes[a] = { base: 10, buffed: 10, raises: 0 };
    }
    for (const v of Object.keys(ui.charInfo.vitals)) {
      ui.charInfo.vitals[v] = { current: 100, max: 100, raises: 0 };
    }
  });

  it('idle: prompt footer 0x10000240 shows, button footer 0x10000241 hidden', () => {
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'attributes');
    expect(byId(body, 0x10000240)!.style.display).toBe('block');
    expect(byId(body, 0x10000241)!.style.display).toBe('none');
    expect(byId(body, 0x1000024e)!.textContent).toBe('Select an Attribute to Improve');
    body.remove();
  });

  it('clicking an attribute row selects it (media state 6 = gold bar 0x06000f93) and swaps to the button footer', () => {
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'attributes');
    const row = rowByText(body, 'Strength')!;
    expect(row).toBeTruthy();
    row.click();
    expect(ui.selectedStatRow).toEqual({ kind: 'attribute', id: 1 });

    ui.renderStatPaneNative(body, 'attributes');
    // selected row carries the state-6 media. The others' state-1 media is
    // the window's own 0x06004cc2 scrim, which does not compound
    // (VISUAL.char-panel-body-too-bright.d), so they draw nothing.
    expect(rowByText(body, 'Strength')!.style.backgroundImage).toContain('tex:0x6000f93');
    expect(rowByText(body, 'Endurance')!.style.backgroundImage).toBe('');
    expect(rowByText(body, 'Endurance')!.style.background).toBe('');
    // footer swap (page state 0x10000012)
    expect(byId(body, 0x10000240)!.style.display).toBe('none');
    const footer = byId(body, 0x10000241)!;
    expect(footer.style.display).toBe('block');
    expect(footer.textContent).toContain('Strength');
    expect(footer.textContent).toContain('Experience To Raise:');
    expect(footer.textContent).toContain('100'); // cost at raises=0
    expect(footer.textContent).toContain('Unassigned Experience:');
    body.remove();
  });

  it('raise button sends the wire id + single-step cost, then debounces until the pools change', () => {
    const sent: Array<[number, number]> = [];
    ui.raiseCallbacks = { onRaiseAttribute: (id: number, xp: number): void => { sent.push([id, xp]); } };
    ui.selectedStatRow = { kind: 'attribute', id: 3 }; // Quickness (FAITHFUL.601 wire id)
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'attributes');
    const btn = raiseBtn(body, 0x10000246)!;
    expect(btn).toBeTruthy();
    expect(btn.style.backgroundImage).toContain('tex:0x6004cb6'); // lit up-arrow
    btn.click();
    expect(sent).toEqual([[3, 100]]);
    expect(ui.statRaiseAwaiting).toBe(true);

    // While awaiting, the re-rendered buttons are dim and inert (m_bAwaitingRaise).
    ui.renderStatPaneNative(body, 'attributes');
    const btn2 = raiseBtn(body, 0x10000246)!;
    expect(btn2.style.backgroundImage).toContain('tex:0x6004cb7');
    btn2.click();
    expect(sent.length).toBe(1);

    // Server ack: pools change in syncFromPlayerState clears the guard.
    ui.syncFromPlayerState({
      name: 'T', heritage: 1, gender: 1, level: 5, totalBurden: 0,
      xp: { totalXp: 1000n, availableXp: 400n, availableSkillCredits: 2 },
      health: { current: 100, max: 100 }, stamina: { current: 100, max: 100 }, mana: { current: 100, max: 100 },
      attributes: { getCurrent: () => 10 },
      skills: { getAllSkillIds: () => [], getAdvancementClass: () => 0, getRaises: () => 0 },
    });
    expect(ui.statRaiseAwaiting).toBe(false);
    body.remove();
  });

  it('raise-10 sends ONE action with the clamped ten-step cost', () => {
    const sent: Array<[number, number]> = [];
    ui.raiseCallbacks = { onRaiseAttribute: (id: number, xp: number): void => { sent.push([id, xp]); } };
    ui.charInfo.unassignedXp = 10000;
    ui.charInfo.attributes.strength.raises = 1;
    ui.selectedStatRow = { kind: 'attribute', id: 1 };
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'attributes');
    const btn10 = raiseBtn(body, 0x100005eb)!;
    expect(btn10).toBeTruthy();
    expect(btn10.style.backgroundImage).toContain('tex:0x600712b'); // lit +10
    btn10.click();
    // raises=1, table len 5 → clamp to 3 steps: 1000 - 100 = 900, one send.
    expect(sent).toEqual([[1, 900]]);
    body.remove();
  });

  it('vital rows select and raise via PropertyAttribute2nd wire ids (MaxHealth=1/MaxStamina=3/MaxMana=5)', () => {
    const sent: Array<[number, number]> = [];
    ui.raiseCallbacks = { onRaiseVital: (id: number, xp: number): void => { sent.push([id, xp]); } };
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'attributes');
    rowByText(body, 'Mana')!.click();
    expect(ui.selectedStatRow).toEqual({ kind: 'vital', id: 5 });
    ui.charInfo.vitals.mana.raises = 1;
    ui.renderStatPaneNative(body, 'attributes');
    const footer = byId(body, 0x10000241)!;
    expect(footer.textContent).toContain('Mana');
    expect(footer.textContent).toContain('Experience To Raise:');
    raiseBtn(body, 0x10000246)!.click();
    expect(sent).toEqual([[5, 100]]); // VITAL_TABLE 1→2: 150-50
    body.remove();
  });

  it('maxed attribute shows Infinity! and a disabled raise button', () => {
    ui.charInfo.attributes.self.raises = 4; // table len 5 → maxed
    ui.selectedStatRow = { kind: 'attribute', id: 6 };
    const sent: number[] = [];
    ui.raiseCallbacks = { onRaiseAttribute: (): void => { sent.push(1); } };
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'attributes');
    const footer = byId(body, 0x10000241)!;
    expect(footer.textContent).toContain('Infinity!');
    const btn = raiseBtn(body, 0x10000246)!;
    expect(btn.style.backgroundImage).toContain('tex:0x6004cb7'); // dim
    btn.click();
    expect(sent.length).toBe(0);
    body.remove();
  });

  it('unaffordable cost renders the dim button and ignores clicks', () => {
    ui.charInfo.unassignedXp = 50; // cost1 = 100
    ui.selectedStatRow = { kind: 'attribute', id: 1 };
    const sent: number[] = [];
    ui.raiseCallbacks = { onRaiseAttribute: (): void => { sent.push(1); } };
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'attributes');
    const btn = raiseBtn(body, 0x10000246)!;
    expect(btn.style.backgroundImage).toContain('tex:0x6004cb7');
    btn.click();
    expect(sent.length).toBe(0);
    body.remove();
  });

  it('trained skill: select → XP footer, raise sends the skill id + cost', () => {
    const sent: Array<[number, number]> = [];
    ui.raiseCallbacks = { onRaiseSkill: (id: number, xp: number): void => { sent.push([id, xp]); } };
    ui.charInfo.skills = [
      { id: 24, name: 'Run', status: 'Trained', base: 60, effective: 60, raises: 2 },
    ];
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'skills');
    rowByText(body, 'Run')!.click();
    expect(ui.selectedSkillId).toBe(24);
    ui.renderStatPaneNative(body, 'skills');
    const footer = byId(body, 0x10000241)!;
    expect(footer.style.display).toBe('block');
    expect(footer.textContent).toContain('Run');
    expect(footer.textContent).toContain('Experience To Raise:');
    // raise-10 visible for trained skills
    expect(raiseBtn(body, 0x100005eb)).toBeTruthy();
    raiseBtn(body, 0x10000246)!.click();
    expect(sent).toEqual([[24, 30]]); // TRAINED_TABLE 2→3: 60-30
    body.remove();
  });

  it('RECON.skill-raise-ignores-pp — a trained skill with partial progress (_pp) costs table[level+1] - _pp, and the raise sends that (GetCostToRaise @ 0049b680)', () => {
    const sent: Array<[number, number]> = [];
    ui.raiseCallbacks = { onRaiseSkill: (id: number, xp: number): void => { sent.push([id, xp]); } };
    // TRAINED_TABLE [0, 10, 30, 60, 100]: level 2, 45 XP spent (15 into level 3's step of 30).
    ui.charInfo.skills = [
      { id: 24, name: 'Run', status: 'Trained', base: 60, effective: 60, raises: 2, pp: 45 },
    ];
    ui.selectedSkillId = 24;
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'skills');
    raiseBtn(body, 0x10000246)!.click();
    expect(sent).toEqual([[24, 15]]); // 60 - 45, not the full step 30
    raiseBtn(body, 0x100005eb)!.click();
    expect(sent.at(-1)).toEqual([24, 55]); // to the max level 4: 100 - 45
    body.remove();
  });

  it('untrained skill: credits footer, raise-10 hidden, raise trains (DisplaySelectionFooter_Untrained)', () => {
    const sent: Array<[number, number]> = [];
    ui.raiseCallbacks = { onTrainSkill: (id: number, credits: number): void => { sent.push([id, credits]); } };
    ui.skillTable = { skills: new Map([[34, { trainedCost: 2 }]]) };
    ui.charInfo.skills = [
      { id: 34, name: 'War Magic', status: 'Unusable', base: 0, effective: 0, raises: 0 },
    ];
    ui.selectedSkillId = 34;
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'skills');
    const footer = byId(body, 0x10000241)!;
    expect(footer.textContent).toContain('War Magic');
    expect(footer.textContent).toContain('Skill Credits To Train');
    expect(footer.textContent).toContain('Skill Credits Available:');
    expect(raiseBtn(body, 0x100005eb)).toBeNull(); // SetVisible(0)
    // RECON.train-skill-confirm — gmSkillUI::TrainSkill asks first; only Yes trains.
    const prompts: string[] = [];
    let answer = false;
    const realConfirm = ui.showConfirmationDialog;
    ui.showConfirmationDialog = (msg: string, cb: (ok: boolean) => void) => { prompts.push(msg); cb(answer); };
    raiseBtn(body, 0x10000246)!.click();
    expect(prompts).toEqual(['Are you sure you want to spend 2 credits to train War Magic?']);
    expect(sent).toEqual([]);
    answer = true;
    raiseBtn(body, 0x10000246)!.click();
    expect(sent).toEqual([[34, 2]]);
    ui.showConfirmationDialog = realConfirm;
    ui.skillTable = null;
    body.remove();
  });

  it('untrained usable skill: the footer title is the skill name alone — no value, no "+" (InqSkillName only)', () => {
    ui.skillTable = { skills: new Map([[40, { trainedCost: 4 }]]) };
    // An untrained-but-usable skill whose effective (attribute formula) exceeds its base.
    ui.charInfo.skills = [
      { id: 40, name: 'Loyalty', status: 'Untrained', base: 0, effective: 5, raises: 0 },
    ];
    ui.selectedSkillId = 40;
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'skills');
    const footer = byId(body, 0x10000241)!;
    const title = footer.firstElementChild as HTMLElement; // title box 0x1000024e (0,0) 300x20
    expect((title.textContent ?? '').trim()).toBe('Loyalty');
    expect(footer.textContent).not.toContain('5+');
    ui.skillTable = null;
    body.remove();
  });

  it('selection with no matching row falls back to the prompt footer', () => {
    ui.selectedSkillId = 999;
    const body = statPaneScaffold();
    ui.renderStatPaneNative(body, 'skills');
    expect(byId(body, 0x10000240)!.style.display).toBe('block');
    expect(byId(body, 0x10000241)!.style.display).toBe('none');
    body.remove();
  });

  it('syncFromPlayerState carries the VitalSystem raise counts into charInfo', () => {
    ui.syncFromPlayerState({
      name: 'T', heritage: 1, gender: 1, level: 5, totalBurden: 0,
      xp: { totalXp: 0n, availableXp: 0n, availableSkillCredits: 0 },
      health: { current: 100, max: 100 }, stamina: { current: 100, max: 100 }, mana: { current: 100, max: 100 },
      vitals: { getRaises: (id: number) => id * 10 },
      attributes: { getCurrent: () => 10 },
      skills: { getAllSkillIds: () => [], getAdvancementClass: () => 0, getRaises: () => 0 },
    });
    expect(ui.charInfo.vitals.health.raises).toBe(10);
    expect(ui.charInfo.vitals.stamina.raises).toBe(20);
    expect(ui.charInfo.vitals.mana.raises).toBe(30);
  });
});

describe('RECON.skill-raise-ignores-pp — GameUI.skillRaiseCosts + SkillSystem experienceSpent', () => {
  it('cost1 / cost10 subtract the spent XP; without pp the spent XP is table[level]; at the max level both are 0', async () => {
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const T = [0, 10, 30, 60, 100];
    expect(GameUI.skillRaiseCosts(T, 2, 45)).toEqual({ cost1: 15, cost10: 55 });
    expect(GameUI.skillRaiseCosts(T, 2)).toEqual({ cost1: 30, cost10: 70 });
    expect(GameUI.skillRaiseCosts(T, 4, 100)).toEqual({ cost1: 0, cost10: 0 });
    expect(GameUI.skillRaiseCosts(undefined, 1, 5)).toEqual({ cost1: 0, cost10: 0 });
  });

  it('SkillSystem keeps the ExperienceSpent the wire sends, and an update without it keeps the old value', async () => {
    const { SkillSystem } = await import('../packages/shared/src/character/SkillSystem.js');
    const s = new SkillSystem(new Map());
    s.setSkill(24, 2, 2, 0, 45);
    expect(s.getExperienceSpent(24)).toBe(45);
    s.setSkill(24, 2, 3, 0, 61);
    expect(s.getExperienceSpent(24)).toBe(61);
    s.setSkill(24, 2, 3, 0);
    expect(s.getExperienceSpent(24)).toBe(61);
    expect(s.getExperienceSpent(99)).toBeUndefined();
  });
});
