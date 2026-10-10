/**
 * AGENT — fellowship through the fellowship pane's own actions (GameUI
 * agentFellowship / agentFellowshipAction): create without the name box,
 * recruit the selection, and Leader / Quit / Open-Close / Dismiss / Disband
 * through FellowshipPanelActions under the buttons' gates (UpdateButtons
 * @ 0048e6c0). Agents had reported "agent tools can't type into the
 * Fellowship Name box" (Jake, 2026-10-09).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installDomGlobals, loadDomWindow, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;
const SELF = 0x50000001, OTHER = 0x50000002;
const fellow = (guid: number, name: string) => ({ guid, name, level: 10, healthCurrent: 40, healthMax: 50, staminaCurrent: 60, staminaMax: 60, manaCurrent: 20, manaMax: 30, shareLoot: true });

describe('agent fellowship (real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let created: string[]; let steps: unknown[]; let recruits: number;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));
  beforeEach(() => {
    created = []; steps = []; recruits = 0;
    ui.callbacks.onCreateFellowship = (n: string) => created.push(n);
    ui.callbacks.onFellowshipSteps = (s: unknown[]) => steps.push(...s);
    ui.callbacks.onFellowshipRecruitSelected = () => { recruits++; };
    ui.setFellowshipData(null);
  });
  const lead = (leader: number, open = false) => ui.setFellowshipData({
    fellowshipName: 'Tinkers', leaderGuid: leader, shareXP: true, evenShare: true, open, isLocked: false, selfGuid: SELF,
    fellows: [fellow(SELF, 'Claude Bulwark'), fellow(OTHER, 'Claude Arcanist')],
  });

  it('creates without the name box (the name the box would hold, ≤ 34 characters)', () => {
    expect(ui.agentFellowship()).toMatch(/^no fellowship; .*ac_fellowship action=create/);
    expect(ui.agentFellowshipAction('create', '  Tinkers  ')).toBeNull();
    expect(created).toEqual(['Tinkers']);
    expect(ui.agentFellowshipAction('create', '')).toBe('create needs a name');
    expect(ui.agentFellowshipAction('create', 'x'.repeat(35))).toBe('a fellowship name is at most 34 characters');
    lead(SELF);
    expect(ui.agentFellowshipAction('create', 'Other')).toBe('you are already in the fellowship "Tinkers" (quit first)');
  });

  it('turns the request checkboxes on and off through their CharacterOptions', () => {
    const toggles: Array<[number, boolean]> = [];
    ui.callbacks.onCharacterOptionToggle = (code: number, on: boolean) => toggles.push([code, on]);
    ui.optionsSettings.ignoreFellowshipRequests = true;
    expect(ui.agentFellowship()).toMatch(/ignoring fellowship requests \(action=requests name=accept/);
    expect(ui.agentFellowshipAction('requests', 'accept')).toBeNull();
    expect(ui.optionsSettings.ignoreFellowshipRequests).toBe(false);
    expect(ui.agentFellowshipAction('auto', 'on')).toBeNull();
    expect(ui.agentFellowship()).toMatch(/accepting fellowship requests, automatically/);
    expect(ui.agentFellowshipAction('auto', 'on')).toBeNull(); // already on: nothing sent again
    expect(toggles.map(([, on]) => on)).toEqual([false, true]);
    expect(toggles.every(([code]) => typeof code === 'number')).toBe(true);
    expect(ui.agentFellowshipAction('requests', 'maybe')).toBe('requests takes accept or ignore');
    ui.agentFellowshipAction('auto', 'off');
  });

  it('shows the members, leader and sharing', () => {
    lead(SELF);
    const t = ui.agentFellowship();
    expect(t).toMatch(/^fellowship "Tinkers": 2\/9 fellows, leader you, closed \(only the leader recruits\), XP shared evenly/);
    expect(t).toContain('Claude Bulwark (you) [leader] L10  HP 40/50');
    expect(t).toContain('Claude Arcanist L10');
  });

  it('leader actions go through the panel functions; a member is refused as the disabled buttons refuse', () => {
    lead(SELF);
    expect(ui.agentFellowshipAction('recruit')).toBeNull();
    expect(recruits).toBe(1);
    expect(ui.agentFellowshipAction('open')).toBeNull();
    expect(ui.agentFellowshipAction('leader', 'claude arcanist')).toBeNull();
    expect(ui.agentFellowshipAction('dismiss', 'Nobody')).toMatch(/^no fellow named "Nobody" \(fellows: Claude Bulwark, Claude Arcanist\)/);
    expect(ui.agentFellowshipAction('disband')).toBeNull();
    expect(steps).toEqual([{ kind: 'setOpen', open: true }, { kind: 'assignLeader', guid: OTHER }, { kind: 'quit', disband: true }]);
    lead(OTHER);
    steps = [];
    expect(ui.agentFellowshipAction('recruit')).toBe('only the leader can recruit into a closed fellowship');
    expect(ui.agentFellowshipAction('disband')).toBe('only the leader can disband');
    expect(ui.agentFellowshipAction('dismiss', 'Claude Arcanist')).toBe('only the leader can dismiss a fellow');
    expect(ui.agentFellowshipAction('quit')).toBeNull();
    expect(steps).toEqual([{ kind: 'quit', disband: false }]);
    lead(OTHER, true);
    expect(ui.agentFellowshipAction('recruit')).toBeNull(); // open: any fellow recruits
    expect(ui.agentFellowshipAction('dance')).toMatch(/^unknown fellowship action "dance"/);
  });

  it('active enchantments come from the effects windows\' list (the Magic update events), with seconds left; cooldowns left out', () => {
    ui.clearEnchantments();
    ui.addEnchantment({ spellId: 24, layer: 1, name: 'Armor Self I', iconId: 0, isBeneficial: true, isVitae: false, isCooldown: false, duration: 1800, startTime: -100, casterGuid: SELF });
    ui.addEnchantment({ spellId: 666, layer: 1, name: 'Vitae', iconId: 0, isBeneficial: false, isVitae: true, isCooldown: false, duration: -1, startTime: 0, casterGuid: 0 });
    ui.addEnchantment({ spellId: 0x8000, layer: 1, name: 'Gem cooldown', iconId: 0, isBeneficial: false, isVitae: false, isCooldown: true, duration: 30, startTime: 0, casterGuid: 0 });
    const now = Date.now() / 1000;
    const got = ui.agentActiveEnchantments(now + 10);
    expect(got.map((e: { name: string }) => e.name)).toEqual(['Armor Self I', 'Vitae']);
    expect(got[0].remaining).toBeGreaterThan(1689);
    expect(got[0].remaining).toBeLessThan(1691); // 1800 − 100 already elapsed − 10 since applied
    expect(got[1].remaining).toBe(-1);
    ui.clearEnchantments();
    expect(ui.agentActiveEnchantments()).toEqual([]);
  });

  it('raising a vital reports the rank and cost, not a before/after the current maximum would get wrong under vitae or buffs', () => {
    const vitals: Array<[number, number]> = [];
    ui.setRaiseCallbacks({ onRaiseVital: (id: number, cost: number) => vitals.push([id, cost]) }, { vital: [0, 100, 250, 450] });
    ui.charInfo.unassignedXp = 10_000;
    ui.charInfo.vitals.health = { current: 30, max: 42, raises: 0 }; // 42 under vitae; its unbuffed max is higher
    const r = ui.agentRaise('health');
    expect(r).toMatchObject({ ok: true, message: 'raised Maximum Health one rank (100 XP)', cost: 100 });
    expect(r.from).toBeUndefined();
    expect(vitals).toHaveLength(1);
  });
  it('trains an untrained skill with credits as the panel train button does, and lists each untrained skill\'s cost', () => {
    const trains: Array<[number, number]> = [];
    ui.setRaiseCallbacks({ onTrainSkill: (id: number, credits: number) => trains.push([id, credits]) }, {});
    // SkillTable trainedCost by id (the DAT's 0x0E000004 in the client): Creature Enchantment 31, Life Magic 33.
    (ui as unknown as { skillTable: unknown }).skillTable = { skills: new Map([[31, { trainedCost: 8 }], [33, { trainedCost: 12 }], [34, { trainedCost: 16 }]]) };
    ui.charInfo.skillCredits = 9;
    ui.charInfo.skills = [
      { id: 34, name: 'War Magic', status: 'Specialized', base: 120, effective: 120, raises: 50 },
      { id: 31, name: 'Creature Enchantment', status: 'Unusable', base: 0, effective: 0, raises: 0 },
      { id: 33, name: 'Life Magic', status: 'Unusable', base: 0, effective: 0, raises: 0 },
    ];
    // The Unusable magic schools were missing from the sheet altogether; now each shows its train cost.
    expect(ui.agentCharacterSheet()).toContain('Untrained skills (credits to train): Creature Enchantment [8 cr], Life Magic [12 cr]');
    expect(ui.agentTrainSkill('life magic')).toMatchObject({ ok: false, message: 'training Life Magic costs 12 skill credits; you have 9' });
    expect(ui.agentTrainSkill('War Magic')).toMatchObject({ ok: false });
    expect(trains).toEqual([]);
    expect(ui.agentTrainSkill('creature')).toMatchObject({ ok: true, name: 'Creature Enchantment', cost: 8 });
    expect(trains).toEqual([[31, 8]]);
    expect(ui.charInfo.skillCredits).toBe(1);
    // Now trained, it raises with XP instead of being refused as untrained.
    expect(ui.agentTrainSkill('Creature Enchantment')).toMatchObject({ ok: false, message: 'Creature Enchantment is already trained; raise it with XP (ac_raise)' });
  });
  it('the sheet shows what one more raise of each attribute, vital and trained skill costs, and ac_raise spends exactly that (Bulwark spent 1,802 XP unawares, 2026-10-10)', () => {
    const attrs: Array<[number, number]> = [];
    ui.setRaiseCallbacks({ onRaiseAttribute: (id: number, cost: number) => attrs.push([id, cost]) }, { attribute: [0, 110, 277, 501, 784, 1126, 1527, 2000, 3802], vital: [0, 100, 250], trainedSkill: [0, 5, 15, 30], specializedSkill: [0, 50] });
    ui.charInfo.unassignedXp = 5000;
    ui.charInfo.attributes.endurance = { base: 84, buffed: 84, raises: 7 };
    ui.charInfo.vitals.health = { current: 50, max: 50, raises: 1 };
    ui.charInfo.skills = [{ id: 6, name: 'Melee Defense', status: 'Trained', base: 40, effective: 40, raises: 2, pp: 5 }];
    const sheet = ui.agentCharacterSheet();
    expect(sheet).toMatch(/Endurance 84 \[\+1: 1,802 xp\]/);
    expect(sheet).toMatch(/health 50\/50 \[\+1: 150 xp\]/);
    expect(sheet).toMatch(/Melee Defense 40 \[\+1: 25 xp\]/);
    expect(ui.agentRaise('endurance')).toMatchObject({ ok: true, cost: 1802 });
    expect(attrs).toEqual([[expect.any(Number), 1802]]);
  });
});
