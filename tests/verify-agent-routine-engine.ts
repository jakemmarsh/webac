/**
 * AGENT.routine-engine — RoutineEngine runs a RoutineProfile on the agent
 * API: first matching rule of the current state, actions in order, module
 * switches, dry runs, loot-rule matching, routes (docs/agent-play.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, MAP_COORD_ORIGIN } from '../packages/renderer/src/agent/AgentApi.ts';
import { appraisalFacts, lootRuleFor, ruleModules } from '../packages/renderer/src/agent/RoutineEngine.ts';
import { ALL_MODULES_OFF, EXAMPLE_HUNT_PROFILE, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';

const profile = (over: Partial<RoutineProfile> = {}): RoutineProfile => ({
  name: 'Test', modules: { ...ALL_MODULES_OFF, vitals: true, combat: true, looting: true, navigation: true, buffs: true, inventory: true },
  initialState: 'Hunt', loot: [], buffSets: [], routes: [],
  states: [
    { name: 'Hunt', rules: [
      { label: 'Low health', when: [{ kind: 'vital-below', vital: 'health', percent: 40 }], do: [{ kind: 'set-state', state: 'Recover' }] },
      { label: 'Fight', when: [{ kind: 'monster-within', meters: 40 }], do: [{ kind: 'attack-nearest', meters: 40 }] },
    ] },
    { name: 'Recover', rules: [
      { label: 'Healed', when: [{ kind: 'vital-above', vital: 'health', percent: 90 }], do: [{ kind: 'set-state', state: 'Hunt' }] },
      { label: 'Kit', when: [{ kind: 'always' }], do: [{ kind: 'use-item', item: 'Healing Kit', on: 'self' }, { kind: 'wait', seconds: 1 }] },
    ] },
  ],
  ...over,
});

describe('routine helpers', () => {
  it('maps rules to the module that gates them', () => {
    expect(ruleModules({ when: [{ kind: 'always' }], do: [{ kind: 'attack-nearest' }] })).toEqual(['combat']);
    expect(ruleModules({ when: [{ kind: 'vital-below', vital: 'health', percent: 40 }], do: [{ kind: 'use-item', item: 'Healing Kit' }] })).toEqual(['vitals']);
    expect(ruleModules({ when: [{ kind: 'always' }], do: [{ kind: 'set-state', state: 'X' }] })).toEqual([]);
  });
  it('first loot rule that matches wins; unknown facts never match a rule that needs them', () => {
    const rules = EXAMPLE_HUNT_PROFILE.loot;
    expect(lootRuleFor(rules, { name: 'Pyreals' })?.label).toBe('Money');
    expect(lootRuleFor(rules, { name: 'Healing Kit' })?.action).toBe('keep-up-to');
    expect(lootRuleFor(rules, { name: 'Rusty Sword', value: 80 })?.action).toBe('sell');
    expect(lootRuleFor(rules, { name: 'Rusty Sword' })?.action).toBe('ignore');
  });
});

describe('RoutineEngine', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => vi.useRealTimers());

  it('dry-runs the current state: which rule fires and why', () => {
    api.routine.start(profile());
    host.add({ guid: 0x80001001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40 });
    const v = api.routine.dryRun();
    expect(v.map((r) => [r.rule, r.fires])).toEqual([['Low health', false], ['Fight', true]]);
    expect(v[0].why).toEqual(['✗ health 100%']);
    expect(v[1].why).toEqual(['✓ Drudge Skulker at 20 m']);
  });

  it('fights the nearest monster, then switches state on low health and heals until healed', async () => {
    host.inv.push({ guid: 0x80001010, name: 'Healing Kit', where: 'main pack', stack: 3 });
    host.add({ guid: 0x80001002, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 24 });
    api.routine.start(profile());
    run(api, host, 600);
    expect(host.sent.some((x) => x.startsWith('attack 80001002'))).toBe(true);
    // It dies; then we're hurt.
    host.dying.add(0x80001002);
    run(api, host, 300);
    await vi.advanceTimersByTimeAsync(0);
    host.objs.delete(0x80001002);
    host.me.health.current = 10;
    run(api, host, 1200); await vi.advanceTimersByTimeAsync(0);
    expect(api.routine.status().state).toBe('Recover');
    run(api, host, 1200); await vi.advanceTimersByTimeAsync(1500); run(api, host, 600);
    expect(host.sent).toContain('usewith 80001010 50000001');
    host.me.health.current = 50;
    run(api, host, 1200); await vi.advanceTimersByTimeAsync(1500); run(api, host, 600);
    expect(api.routine.status().state).toBe('Hunt');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.routine.status().last.join('\n')).toContain('use-item: using Healing Kit on yourself');
    expect(api.routine.status().last.join('\n')).toMatch(/→ "Recover"[\s\S]*→ "Hunt"/);
  });

  it('a disabled module\'s rules never fire', () => {
    host.add({ guid: 0x80001003, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 24 });
    api.routine.start(profile({ modules: { ...ALL_MODULES_OFF, vitals: true } }));
    run(api, host, 1500);
    expect(host.sent.some((x) => x.startsWith('attack'))).toBe(false);
    expect(api.routine.dryRun()[1]).toMatchObject({ rule: 'Fight', enabled: false, fires: false });
  });

  it('pause holds everything until resume; module switches change this run only', async () => {
    const reports: string[] = [];
    api.routine.onReport = (r) => reports.push(r);
    const prof = profile();
    host.add({ guid: 0x80001004, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 24 });
    api.routine.start(prof);
    expect(api.routine.pause().ok).toBe(true);
    expect(api.routine.status()).toMatchObject({ running: true, paused: true });
    run(api, host, 1500);
    expect(host.sent.some((x) => x.startsWith('attack'))).toBe(false);
    api.routine.setModule('combat', false);
    expect(prof.modules.combat).toBe(true); // the stored profile is untouched
    api.routine.resume();
    run(api, host, 1500);
    expect(host.sent.some((x) => x.startsWith('attack'))).toBe(false);
    api.routine.setModule('combat', true);
    run(api, host, 600);
    expect(host.sent.some((x) => x.startsWith('attack 80001004'))).toBe(true);
    // A kill is counted; state time accrues only while running.
    host.dying.add(0x80001004);
    run(api, host, 300); await vi.advanceTimersByTimeAsync(0);
    const st = api.routine.statsNow();
    expect(st.kills).toBe(1);
    expect(st.stateTime.Hunt).toBeGreaterThan(0);
    expect(st.stateTime.Hunt).toBeLessThan(5000);
    api.routine.resetStats();
    expect(api.routine.statsNow().kills).toBe(0);
  });

  it('a death is counted and reported', () => {
    const reports: string[] = [];
    api.routine.onReport = (r) => reports.push(r);
    api.routine.start(profile());
    host.me.dead = true;
    run(api, host, 600);
    expect(reports).toEqual([`You died: stopped "${profile().name}"`]);
  });

  it('a check the engine can\'t make never holds, not even under Not', () => {
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [
      { label: 'Imported', when: [{ kind: 'not', condition: { kind: 'unsupported', what: 'Character death' } }], do: [{ kind: 'stop' }] },
    ] }] }));
    expect(api.routine.dryRun()[0]).toMatchObject({ fires: false, why: ["✗ can't run: not (Character death)"] });
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [{ disabled: true, when: [{ kind: 'always' }], do: [{ kind: 'stop' }] }] }] }));
    expect(api.routine.dryRun()[0]).toMatchObject({ fires: false, enabled: false, off: true });
    // A kind from a newer client neither holds nor throws.
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [{ when: [{ kind: 'from-the-future' } as never], do: [{ kind: 'stop' }] }] }] }));
    expect(api.routine.dryRun()[0]).toMatchObject({ fires: false, why: ['✗ unknown condition "from-the-future"'] });
  });

  it('stops on death and on request', () => {
    api.routine.start(profile());
    host.me.dead = true;
    run(api, host, 600);
    expect(api.routine.status()).toMatchObject({ running: false });
    expect(api.routine.stop().ok).toBe(false);
  });

  it('buff-missing reads the active enchantments', () => {
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [{ when: [{ kind: 'buff-missing', spell: 'Strength Self I' }], do: [{ kind: 'stop' }] }] }] }));
    host.buffs = [{ name: 'Strength Self I', remaining: 600 }];
    expect(api.routine.dryRun()[0]).toMatchObject({ fires: false, why: ['✗ Strength Self I on (600 s left)'] });
    host.buffs = [];
    expect(api.routine.dryRun()[0].fires).toBe(true);
  });

  it('a routine reads chat without taking it from the player\'s own observe', () => {
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [{ when: [{ kind: 'chat-matches', pattern: 'tells you' }], do: [{ kind: 'say', text: 'brb' }] }] }] }));
    api.pushChat('Jake tells you, "hi"', 0x03);
    run(api, host, 600);
    expect(host.chats).toContain('brb');
    expect(api.observe().chat.map((c) => c.text)).toContain('Jake tells you, "hi"');
  });
});

describe('looting after a kill', () => {
  it('loots only the corpse of what it killed, never a stranger\'s or a player\'s', async () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.add({ guid: 0x80002001, name: 'Corpse of +Fxprobe Three', objectDescFlags: 0x2000, x: 81, y: 21 });
    host.add({ guid: 0x80002002, name: 'Pumpkin Buffer', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [
      { label: 'Fight', when: [{ kind: 'monster-within', meters: 40 }], do: [{ kind: 'attack-nearest', meters: 40 }, { kind: 'loot-nearby', meters: 20 }] },
    ] }] }));
    run(api, host, 600);
    host.dying.add(0x80002002);
    run(api, host, 200); await vi.advanceTimersByTimeAsync(0);
    host.objs.delete(0x80002002);
    await vi.advanceTimersByTimeAsync(700); // the corpse comes a moment later
    host.add({ guid: 0x80002003, name: 'Corpse of Pumpkin Buffer', objectDescFlags: 0x2000, x: 80, y: 23 });
    for (let i = 0; i < 30 && !host.sent.includes('use 80002003'); i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent).toContain('use 80002003');
    expect(host.sent).not.toContain('use 80002001');
    expect(api.routine.status().last.join('\n')).toContain('attack-nearest: killed Pumpkin Buffer');
    api.routine.stop();
    vi.useRealTimers();
  });
});

describe('training: spending unassigned XP by a plan', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('raises the plan round-robin up to each target, and stops when XP runs out', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.stats = new Map([['Strength', 10], ['Endurance', 10], ['Sword', 20]]);
    host.xp = 140; // seven raises at 20
    host.me.xpTotal = 1000; host.me.xpUnassigned = 140;
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [
      { label: 'Train', when: [{ kind: 'unassigned-xp-above', xp: 100 }], do: [{ kind: 'train', plan: [{ stat: 'Strength', upTo: 12 }, { stat: 'Sword', upTo: 50 }, { stat: 'Endurance', upTo: 11 }] }, { kind: 'stop' }] },
    ] }] }));
    expect(api.routine.dryRun()[0]).toMatchObject({ rule: 'Train', fires: true, why: ['✓ 140 unassigned XP'] });
    for (let i = 0; i < 20 && api.routine.status().running; i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    // One each per pass: Strength and Endurance reach their targets, the rest goes to Sword.
    expect(Object.fromEntries(host.stats)).toEqual({ Strength: 12, Endurance: 11, Sword: 24 });
    expect(api.routine.status().last.join('\n')).toContain('train: Strength 10 → 12, Sword 20 → 24, Endurance 10 → 11 (140 XP); raising Sword costs 20 XP; you have 0 unassigned');
  });

  it('a rule that finds nothing to do rests, so the rules below it get their turn', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.stats = new Map([['Strength', 50]]);
    host.xp = 3000;
    host.me.xpTotal = 9000; host.me.xpUnassigned = 3000;
    host.add({ guid: 0x80001109, name: 'Mite Scion', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 24 });
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [
      { label: 'Spend XP', when: [{ kind: 'unassigned-xp-above', xp: 2000 }], do: [{ kind: 'train', plan: [{ stat: 'Strength', upTo: 50 }] }] },
      { label: 'Fight', when: [{ kind: 'monster-within', meters: 40 }], do: [{ kind: 'attack-nearest', meters: 40 }] },
    ] }] }));
    for (let i = 0; i < 10; i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent.some((x) => x.startsWith('attack 80001109'))).toBe(true);
    expect(api.routine.status().last.join('\n')).toContain('resting "Spend XP" 30 s (nothing to do)');
    expect(api.routine.dryRun()[0].why.join(' ')).toMatch(/found nothing to do last time; again in \d+ s/);
  });

  it('a met plan spends nothing', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.stats = new Map([['Strength', 50]]);
    host.xp = 1000;
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [
      { when: [{ kind: 'always' }], do: [{ kind: 'train', plan: [{ stat: 'Strength', upTo: 50 }] }, { kind: 'stop' }] },
    ] }] }));
    for (let i = 0; i < 20 && api.routine.status().running; i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.xp).toBe(1000);
    expect(api.routine.status().last.join('\n')).toContain('train: nothing to raise: the plan is met');
  });
});

describe('looting by the loot rules', () => {
  it('reads value and burden from an examination', () => {
    expect(appraisalFacts('Training Dirk\nValue: 1,025\nBurden: 50\n\nSkill: Dagger')).toMatchObject({ value: 1025, burden: 50 });
    expect(appraisalFacts('Value: 7   75 Burden Units')).toMatchObject({ value: 7, burden: 75 });
    expect(appraisalFacts('Value: ???')).toMatchObject({ value: undefined, burden: undefined });
  });

  it('matches a type by ACE\'s enum name or the appraisal\'s label', () => {
    const rules = [{ action: 'keep' as const, match: { types: ['MeleeWeapon'] } }];
    expect(lootRuleFor(rules, { name: 'Dirk', type: 'Melee Weapon' })).not.toBeNull();
    expect(lootRuleFor(rules, { name: 'Bow', type: 'Missile Weapon' })).toBeNull();
  });

  it('examines items a value rule needs, then takes only what the rules keep', async () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.inv = [{ guid: 0x50000001, name: 'Healing Kit', where: 'main pack', stack: 5 }];
    host.add({ guid: 0x80002102, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    const items = [
      { guid: 0x80003001, name: 'Pyreals', itemType: 0x40 },
      { guid: 0x80003002, name: 'Amber', itemType: 0x800 },
      { guid: 0x80003003, name: 'Rusty Sword', itemType: 0x1 },
      { guid: 0x80003004, name: 'Old Rag', itemType: 0x4 },
      { guid: 0x80003005, name: 'Healing Kit', itemType: 0x80 },
    ];
    for (const it of items) host.add({ ...it, cell: 0 });
    const reports: string[] = [];
    api.routine.onReport = (r) => reports.push(r);
    host.appraisals.set(0x80003003, 'Rusty Sword\nValue: 80\nBurden: 200');
    host.appraisals.set(0x80003004, 'Old Rag\nValue: 5\nBurden: 10');
    api.routine.start(profile({
      loot: EXAMPLE_HUNT_PROFILE.loot,
      states: [{ name: 'Hunt', rules: [
        { label: 'Fight', when: [{ kind: 'monster-within', meters: 40 }], do: [{ kind: 'attack-nearest', meters: 40 }, { kind: 'loot-nearby', meters: 20 }] },
      ] }],
    }));
    run(api, host, 600);
    host.dying.add(0x80002102);
    run(api, host, 200); await vi.advanceTimersByTimeAsync(0);
    host.objs.delete(0x80002102);
    host.add({ guid: 0x80002103, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 80, y: 23 });
    for (let i = 0; i < 40 && !host.sent.includes('use 80002103'); i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    host.container = { guid: 0x80002103, items: items.map(({ guid, name }) => ({ guid, name })) };
    for (let i = 0; i < 200 && !api.routine.status().last.some((l) => l.startsWith('loot-nearby')); i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    const picked = host.sent.filter((x) => x.startsWith('pickup')).map((x) => Number.parseInt(x.slice(7), 16));
    // Money and gems by name/type, the sword because it's worth 50+ (sell); the rag is worth too little,
    // and five Healing Kits are already held.
    expect(picked).toEqual([0x80003001, 0x80003002, 0x80003003]);
    // Only the items whose rule needed it were examined.
    expect(host.appraised).toEqual([0x80003003, 0x80003004]);
    expect(api.routine.status().last.join('\n')).toMatch(/left 2: Old Rag, Healing Kit/);
    expect(api.routine.statsNow()).toMatchObject({ kills: 1, kept: 3, left: 2 });
    expect(reports).toEqual(['Kept Pyreals (rule: Money)', 'Kept Amber (rule: Gems)', 'Took to sell Rusty Sword (rule: Valuable junk)']);
    api.routine.stop();
    vi.useRealTimers();
  });
});

describe('dry run of a profile that is not running', () => {
  it('evaluates its initial state and acts on nothing', () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.add({ guid: 0x80001004, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    const v = api.routine.dryRun(profile());
    expect(v.find((x) => x.fires)?.rule).toBe('Fight');
    expect(api.routine.status().running).toBe(false);
    expect(host.sent).toEqual([]);
    vi.useRealTimers();
  });
});

describe('VirindiTank meta features (AGENT.vtank-engine-support)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };

  it('Any holds on any branch, All on every one; an unsupported Any branch just never holds', () => {
    host.add({ guid: 0x80001003, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    const rule = (when: RoutineProfile['states'][number]['rules'][number]['when']) => profile({ states: [{ name: 'Hunt', rules: [{ label: 'R', when, do: [{ kind: 'stop' }] }] }] });
    api.routine.start(rule([{ kind: 'any', conditions: [{ kind: 'unsupported', what: 'a view' }, { kind: 'monster-within', meters: 40 }] }]));
    expect(api.routine.dryRun()[0]).toMatchObject({ fires: true, why: ['✓ Drudge Skulker at 10 m'] });
    api.routine.start(rule([{ kind: 'any', conditions: [{ kind: 'unsupported', what: 'a view' }, { kind: 'vital-below', vital: 'health', percent: 50 }] }]));
    expect(api.routine.dryRun()[0]).toMatchObject({ fires: false, why: ["✗ none of (can't run: a view; health 100%)"] });
    api.routine.start(rule([{ kind: 'all', conditions: [{ kind: 'monster-within', meters: 40 }, { kind: 'vital-above', vital: 'health', percent: 50 }] }]));
    expect(api.routine.dryRun()[0]).toMatchObject({ fires: true });
    api.routine.start(rule([{ kind: 'not', condition: { kind: 'all', conditions: [{ kind: 'monster-within', meters: 40 }, { kind: 'vital-below', vital: 'health', percent: 50 }] } }]));
    expect(api.routine.dryRun()[0]).toMatchObject({ fires: true, why: ['✓ not (health 100%)'] });
    api.routine.start(rule([{ kind: 'any', conditions: [] }]));
    expect(api.routine.dryRun()[0]).toMatchObject({ fires: false });
  });

  it('call-state remembers where to return; return goes back', async () => {
    api.routine.start(profile({ initialState: 'Hunt', states: [
      { name: 'Hunt', rules: [{ label: 'Call', when: [{ kind: 'always' }], do: [{ kind: 'call-state', state: 'Rebuff', returnTo: 'Hunt' }] }] },
      { name: 'Rebuff', rules: [{ label: 'Back', when: [{ kind: 'seconds-in-state', seconds: 1 }], do: [{ kind: 'return' }] }] },
    ] }));
    await step(600);
    expect(api.routine.status().state).toBe('Rebuff');
    await step(1500);
    // (Hunt's Always rule calls Rebuff again straight after, so read the return from the log.)
    expect(api.routine.history().join('\n')).toMatch(/call-state: → "Rebuff"[\s\S]*return: → "Hunt"/);
  });

  it('load-route + the macro walk the route point to point; a once route ends in route-done', async () => {
    api.routine.start(profile({
      macro: true, settings: { EnableCombat: false },
      routes: [{ name: 'Loop', mode: 'once', points: [M(80, 30), M(80, 40)] }],
      states: [{ name: 'Hunt', rules: [
        { label: 'Load', when: [{ kind: 'not', condition: { kind: 'seconds-in-state', seconds: 0 } }], do: [{ kind: 'stop' }] },
        { label: 'Done', when: [{ kind: 'route-done' }, { kind: 'seconds-in-state', seconds: 1 }], do: [{ kind: 'set-state', state: 'Home' }] },
      ] }, { name: 'Home', rules: [] }],
    }));
    // No route loaded: route-done holds (VTank: navroute empty).
    expect(api.routine.dryRun()[1].why[0]).toBe('✓ no route loaded');
    api.routine.stop();
    api.routine.start(profile({
      macro: true, settings: { EnableCombat: false, EnableNav: true },
      routes: [{ name: 'Loop', mode: 'once', points: [M(80, 30), M(80, 40)] }],
      states: [{ name: 'Hunt', rules: [
        { label: 'Load', when: [{ kind: 'route-done' }, { kind: 'not', condition: { kind: 'seconds-in-state', seconds: 1 } }], do: [{ kind: 'load-route', route: 'Loop' }] },
        { label: 'Done', when: [{ kind: 'route-done' }, { kind: 'seconds-in-state', seconds: 1 }], do: [{ kind: 'set-state', state: 'Home' }] },
      ] }, { name: 'Home', rules: [] }],
    }));
    await step(20_000);
    expect(host.me.y).toBeGreaterThan(37);
    expect(api.routine.status().state).toBe('Home');
    expect(api.routine.history().join('\n')).toMatch(/route "Loop" point 1[\s\S]*route "Loop" point 2/);
  });

  it('the macro fights when combat is on, and a setting switches it off', async () => {
    host.add({ guid: 0x80003101, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    api.routine.start(profile({ macro: true, settings: { EnableCombat: false, AttackDistance: 20 }, states: [{ name: 'Hunt', rules: [
      { label: 'Fight on', when: [{ kind: 'seconds-in-state', seconds: 2 }], do: [{ kind: 'set-setting', name: 'EnableCombat', value: true }, { kind: 'set-state', state: 'Hunting' }] },
    ] }, { name: 'Hunting', rules: [] }] }));
    await step(1000);
    expect(host.sent.some((x) => x.startsWith('attack 80003101'))).toBe(false);
    await step(2000);
    expect(api.routine.setting('EnableCombat')).toBe(true);
    expect(host.sent.some((x) => x.startsWith('attack 80003101'))).toBe(true);
  });

  it('landblock / landcell, vendor open, monster count', () => {
    host.vendorOpen = { name: 'Shopkeeper', guid: 1, currency: 'Pyreal', items: [] };
    host.add({ guid: 0x80003201, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 25 });
    host.add({ guid: 0x80003202, name: 'Drudge Slinker', itemType: 0x10, objectDescFlags: 0x10, x: 82, y: 25 });
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [
      { when: [{ kind: 'landblock', landblock: (HOLTBURG & 0xffff0000) >>> 0 }, { kind: 'landcell', cell: HOLTBURG }], do: [{ kind: 'stop' }] },
      { when: [{ kind: 'vendor-open' }, { kind: 'not', condition: { kind: 'vendor-closed' } }], do: [{ kind: 'stop' }] },
      { when: [{ kind: 'monster-count', pattern: '^Drudge', count: 2, meters: 20 }], do: [{ kind: 'stop' }] },
      { when: [{ kind: 'monster-count', pattern: '^Drudge', count: 3, meters: 20 }], do: [{ kind: 'stop' }] },
    ] }] }));
    expect(api.routine.dryRun().map((v) => v.fires)).toEqual([true, true, true, false]);
  });

  it('portal and death checks see what happened since the state began; a death rule keeps the routine running', async () => {
    api.routine.start(profile({ states: [
      { name: 'Hunt', rules: [
        { label: 'Ported', when: [{ kind: 'portal-exited' }], do: [{ kind: 'set-state', state: 'Arrived' }] },
        { label: 'Dead', when: [{ kind: 'died' }], do: [{ kind: 'set-state', state: 'Recover' }] },
      ] },
      { name: 'Arrived', rules: [{ label: 'Dead', when: [{ kind: 'died' }], do: [{ kind: 'set-state', state: 'Recover' }] }] },
      { name: 'Recover', rules: [] },
    ] }));
    await step(600);
    host.screenName = 'portal-space';
    await step(300);
    host.screenName = 'world';
    await step(900);
    expect(api.routine.status().state).toBe('Arrived');
    host.me.dead = true;
    await step(900);
    expect(api.routine.status()).toMatchObject({ running: true, state: 'Recover' });
  });

  it('the watchdog fires when you haven\'t moved', async () => {
    api.routine.start(profile({ states: [
      { name: 'Hunt', rules: [{ label: 'Watch', when: [{ kind: 'not', condition: { kind: 'seconds-in-state', seconds: 1 } }], do: [{ kind: 'set-watchdog', state: 'Stuck', meters: 5, seconds: 3 }, { kind: 'wait', seconds: 1 }] }] },
      { name: 'Stuck', rules: [] },
    ] }));
    await step(6000);
    expect(api.routine.status().state).toBe('Stuck');
    expect(api.routine.history().join('\n')).toContain('watchdog: no 5 m in 3 s → "Stuck"');
  });

  it('ruleFiring once (VirindiTank): an Always rule above others fires once, then the rules below it and the macro run', async () => {
    api.routine.start(profile({
      ruleFiring: 'once', macro: true, settings: { EnableCombat: false, EnableNav: true },
      routes: [{ name: 'Loop', mode: 'circular', points: [M(80, 30), M(80, 40)] }],
      states: [{ name: 'Hunt', rules: [
        { label: 'Load', when: [{ kind: 'always' }], do: [{ kind: 'load-route', route: 'Loop' }] },
        { label: 'Later', when: [{ kind: 'seconds-in-state', seconds: 30 }], do: [{ kind: 'set-state', state: 'Done' }] },
      ] }, { name: 'Done', rules: [] }],
    }));
    await step(10_000);
    const log = api.routine.history().join('\n');
    expect(log.match(/load-route: loaded route "Loop"/g)).toHaveLength(1); // not reloaded every step
    expect(log).toMatch(/route "Loop" point 1[\s\S]*route "Loop" point 2/); // the macro walks it
    expect(api.routine.dryRun()[0].why).toEqual(['✓ always', '… fired; waits for its conditions to turn false']);
  });

  it('ruleFiring repeat (ours): a rule fires every step its conditions hold', async () => {
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [{ label: 'Say', when: [{ kind: 'always' }], do: [{ kind: 'say', text: 'hi' }] }] }] }));
    await step(3000);
    expect(host.chats.filter((c) => c === 'hi').length).toBeGreaterThan(1);
  });

  it('meta expressions run: variables, settings, meta state, echo', async () => {
    const echoes: string[] = [];
    api.routine.onReport = (r) => echoes.push(r);
    api.routine.start(profile({ ruleFiring: 'once', settings: { AttackDistance: 20 }, states: [
      { name: 'Hunt', rules: [
        // VTank's own units: a range is map units (yards / 240), 0.125 = 30 yards.
        { label: 'Init', when: [{ kind: 'expression', expr: 'testvar[n]==0' }], do: [{ kind: 'expression', expr: 'setvar[n,1];vtsetsetting[attackdistance,0.125]' }] },
        { label: 'Then', when: [{ kind: 'expression', expr: 'getvar[n]==1 && vtgetsetting[AttackDistance]==0.125' }], do: [{ kind: 'expression', expr: 'echo[ready]' }, { kind: 'expression', expr: 'vtsetmetastate[Go]' }] },
      ] },
      { name: 'Go', rules: [] },
    ] }));
    await step(3000);
    expect(api.routine.setting('AttackDistance')).toBe(30);
    expect(echoes).toContain('ready');
    expect(api.routine.status().state).toBe('Go');
  });

  it('a bad expression says why instead of throwing', () => {
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [{ when: [{ kind: 'expression', expr: 'notafunction[1]' }], do: [{ kind: 'stop' }] }] }] }));
    expect(api.routine.dryRun()[0].fires).toBe(false);
    expect(api.routine.dryRun()[0].why[0]).toMatch(/^✗ expression failed: unknown function notafunction/);
  });

  it('load-loot switches the active loot rules; combat-mode, give and selling to the open vendor', async () => {
    host.inv = [{ guid: 0x50000020, name: 'Pyreal', where: 'main pack', stack: 10 }];
    host.add({ guid: 0x80003301, name: 'Arbiter', itemType: 0x10, x: 81, y: 21 });
    api.routine.start(profile({
      loot: [{ action: 'keep', match: { name: 'A' } }],
      lootSets: { Other: [{ action: 'sell', match: { name: 'B' } }] },
      states: [{ name: 'Hunt', rules: [{ when: [{ kind: 'always' }], do: [
        { kind: 'load-loot', set: 'Other' }, { kind: 'combat-mode', mode: 'magic' }, { kind: 'give', item: 'Pyreal', to: 'Arbiter', count: 3 },
        { kind: 'sell-by-loot-rules', vendor: '' }, { kind: 'stop' },
      ] }] }],
    }));
    await step(8000);
    expect(api.routine.history().join('\n')).toContain('load-loot: loot set "Other" (1 rules)');
    expect(host.sent).toContain('mode magic');
    expect(host.sent.some((x) => x.startsWith('give 50000020 to 80003301 x3'))).toBe(true);
    expect(api.routine.history().join('\n')).toContain('sell-by-loot-rules: no vendor window is open');
  });

  it('a route point\'s stops run on arrival (an imported pause / recall)', async () => {
    api.routine.start(profile({
      macro: true, ruleFiring: 'once', settings: { EnableCombat: false, EnableNav: true },
      routes: [{ name: 'R', mode: 'once', points: [M(80, 30), M(80, 40)], stops: [{ at: 0, do: [{ kind: 'say', text: 'at the first point' }] }] }],
      states: [{ name: 'Hunt', rules: [{ when: [{ kind: 'always' }], do: [{ kind: 'load-route', route: 'R' }] }] }],
    }));
    await step(12_000);
    expect(host.chats).toContain('at the first point');
    expect(api.routine.history().join('\n')).toMatch(/route "R" point 1: say: /);
  });
});

describe('VirindiTank window options in the engine (AGENT.vtank-window)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  const say = (text: string) => profile({ states: [{ name: 'Hunt', rules: [{ label: 'Say', when: [{ kind: 'always' }], do: [{ kind: 'say', text }] }] }] });

  it('the macro starts from VirindiTank\'s defaults; option names are case-insensitive', () => {
    api.routine.start(profile({ macro: true, settings: { enablenav: true } }));
    expect(api.routine.setting('EnableNav')).toBe(true);
    expect(api.routine.setting('attackdistance')).toBe(5);
    expect(api.routine.setting('NavCloseStopRange')).toBe(2);
    expect(api.routine.setting('EnableLooting')).toBe(false);
    // Ours: rules run unless Enable Meta is switched off (saved routines predate the setting).
    expect(api.routine.setting('EnableMeta')).toBe(true);
  });

  it('Enable Meta off: the rules don\'t run (the macro still does)', async () => {
    api.routine.start({ ...say('rule ran'), settings: { EnableMeta: false } });
    await step(1500);
    expect(host.chats).not.toContain('rule ran');
    api.routine.setSetting('EnableMeta', true);
    await step(1000);
    expect(host.chats).toContain('rule ran');
  });

  it('StopMacroOnDeath: on stops the routine at a death; off holds still until you are back', async () => {
    api.routine.start(say('x'));
    host.me.dead = true;
    await step(600);
    expect(api.routine.status().running).toBe(false);
    host.me.dead = false;
    api.routine.start({ ...say('alive again'), settings: { StopMacroOnDeath: false } });
    host.me.dead = true;
    await step(1500);
    expect(api.routine.status().running).toBe(true);
    expect(host.chats).not.toContain('alive again');
    expect(api.routine.statsNow().deaths).toBe(1);
    host.me.dead = false;
    await step(1000);
    expect(host.chats).toContain('alive again');
  });

  it('Approach: with navigation on, the macro runs at a monster inside Approach until it is inside Monster Range', async () => {
    host.add({ guid: 0x80004001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40 });
    api.routine.start(profile({ macro: true, states: [{ name: 'Hunt', rules: [] }], settings: { EnableNav: true, AttackDistance: 5, ApproachDistance: 30 } }));
    await step(8000);
    expect(api.routine.history().join('\n')).toMatch(/approach Drudge Skulker/);
    expect(host.sent.some((x) => x.startsWith('attack 80004001'))).toBe(true);
  });

  it('without Approach (VTank\'s default 0) a monster outside Monster Range is left alone', async () => {
    host.add({ guid: 0x80004002, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40 });
    api.routine.start(profile({ macro: true, states: [{ name: 'Hunt', rules: [] }], settings: { EnableNav: true, AttackDistance: 5 } }));
    await step(3000);
    expect(host.sent.some((x) => x.startsWith('attack 80004002'))).toBe(false);
    expect(host.me.y).toBe(20);
  });

  it('Follow/Nav Min is how near a waypoint counts as reached', async () => {
    const calls: Array<{ within?: number }> = [];
    const walk = api.walkTo.bind(api);
    api.walkTo = (t, o = {}) => { calls.push(o); return walk(t, o); };
    api.routine.start(profile({ macro: true, settings: { EnableCombat: false, EnableNav: true, NavCloseStopRange: 4 }, navRoute: 'R', routes: [{ name: 'R', mode: 'once', points: [M(80, 30)] }], states: [{ name: 'Hunt', rules: [] }] }));
    await step(3000);
    expect(calls[0]?.within).toBe(4);
  });

  it('the Auto-Navigation profile (navRoute) is the route the macro starts with', async () => {
    api.routine.start(profile({ macro: true, settings: { EnableCombat: false, EnableNav: true }, navRoute: 'R', routes: [{ name: 'R', mode: 'once', points: [M(80, 30)] }], states: [{ name: 'Hunt', rules: [] }] }));
    await step(8000);
    expect(api.routine.history().join('\n')).toMatch(/route "R" point 1/);
  });

  it('Peace Mode When Idle drops out of combat mode when there is nothing to do', async () => {
    host.me.combatMode = 'melee';
    api.routine.start(profile({ macro: true, states: [{ name: 'Hunt', rules: [] }], settings: { IdlePeaceMode: true } }));
    await step(1500);
    expect(host.sent).toContain('mode peace');
  });

  it('setState puts the run in a state by hand; update takes edited rules and keeps the state and settings', async () => {
    const p = profile();
    api.routine.start(p);
    expect(api.routine.setState('Recover').ok).toBe(true);
    expect(api.routine.status().state).toBe('Recover');
    expect(api.routine.setState('Nowhere').ok).toBe(false);
    api.routine.setSetting('AttackDistance', 40);
    const edited = structuredClone(p);
    edited.states[1].rules = [{ label: 'New', when: [{ kind: 'always' }], do: [{ kind: 'say', text: 'edited' }] }];
    expect(api.routine.update(edited).ok).toBe(true);
    expect(api.routine.status().state).toBe('Recover');
    expect(api.routine.setting('AttackDistance')).toBe(40);
    await step(1000);
    expect(host.chats).toContain('edited');
    expect(api.routine.update({ ...edited, name: 'Other' }).ok).toBe(false);
  });

  it('a rule that fired is listed (VTank shows it red) until its state is entered again', async () => {
    api.routine.start({ ...say('once'), ruleFiring: 'once' });
    await step(1000);
    expect(api.routine.status().spent).toEqual(['Hunt#0']);
  });
});

/** Map coordinates of a landblock-local point in HOLTBURG. */
function M(x: number, y: number): string {
  const gx = ((HOLTBURG >>> 24) & 0xff) * 192 + x;
  const gy = ((HOLTBURG >>> 16) & 0xff) * 192 + y;
  const ew = gx / 240 - MAP_COORD_ORIGIN; const ns = gy / 240 - MAP_COORD_ORIGIN;
  return `${Math.abs(ns).toFixed(4)}${ns >= 0 ? 'N' : 'S'}, ${Math.abs(ew).toFixed(4)}${ew >= 0 ? 'E' : 'W'}`;
}

describe('loot rules on item properties, spells and you (VTClassic parity)', () => {
  const data = (o: Partial<{ int: Record<number, number>; float: Record<number, number>; string: Record<number, string>; did: Record<number, number>; spells: string[] }>) =>
    ({ int: {}, float: {}, string: {}, bool: {}, did: {}, spells: [], ...o });
  const me = (o: Partial<{ freeSlots: number; level: number; skills: Record<number, { base: number; buffed: number }> }> = {}) =>
    ({ freeSlots: o.freeSlots ?? 10, level: o.level ?? 20, skill: (id: number) => o.skills?.[id] ?? null });

  it('property tests: a missing number reads 0, a did compares its low 24 bits, string matches are regexes', () => {
    const rules = [
      { label: 'Good armor', action: 'keep' as const, match: { props: [{ kind: 'int' as const, key: 28, op: 'ge' as const, value: 200 }] } },
      { label: 'Icon', action: 'sell' as const, match: { props: [{ kind: 'did' as const, key: 8, op: 'eq' as const, value: 0x1234 }] } },
      { label: 'Inscribed', action: 'keep' as const, match: { props: [{ kind: 'string' as const, key: 7, op: 'match' as const, value: 'jake' }] } },
    ];
    expect(lootRuleFor(rules, { name: 'Cap', props: data({ int: { 28: 250 } }) })?.label).toBe('Good armor');
    expect(lootRuleFor(rules, { name: 'Cap', props: data({ int: { 28: 150 } }) })).toBeNull();
    expect(lootRuleFor(rules, { name: 'Gem', props: data({ did: { 8: 0x06001234 } }) })?.label).toBe('Icon');
    expect(lootRuleFor(rules, { name: 'Book', props: data({ string: { 7: 'Made by Jake' } }) })?.label).toBe('Inscribed');
  });

  it('spell tests: count matching, excluding a pattern; total spells', () => {
    const rules = [
      { label: 'Two majors', action: 'keep' as const, match: { spells: { match: '^Major', notMatch: 'Ward', count: 2 } } },
      { label: 'Loaded', action: 'sell' as const, match: { spellCountAtLeast: 3 } },
    ];
    expect(lootRuleFor(rules, { name: 'Ring', props: data({ spells: ['Major Strength', 'Major Endurance'] }) })?.label).toBe('Two majors');
    expect(lootRuleFor(rules, { name: 'Ring', props: data({ spells: ['Major Strength', 'Major Acid Ward', 'Minor Focus'] }) })?.label).toBe('Loaded');
    expect(lootRuleFor(rules, { name: 'Ring', props: data({ spells: ['Major Strength'] }) })).toBeNull();
  });

  it('minimum damage is damage − damage × variance (VTClassic MinDamageGE)', () => {
    const rules = [{ label: 'Hits hard', action: 'keep' as const, match: { minDamageAtLeast: 20 } }];
    expect(lootRuleFor(rules, { name: 'Axe', props: data({ int: { 44: 40 }, float: { 22: 0.5 } }) })?.label).toBe('Hits hard');
    expect(lootRuleFor(rules, { name: 'Axe', props: data({ int: { 44: 30 }, float: { 22: 0.5 } }) })).toBeNull();
    expect(lootRuleFor(rules, { name: 'Axe' })).toBeNull();
  });

  it('character requirements: free slots, level range, buffed and base skill', () => {
    const rules = [
      { label: 'Room', action: 'keep' as const, match: { name: 'Gem', freeSlotsAtLeast: 5 } },
      { label: 'Low level', action: 'keep' as const, match: { name: 'Gem', characterLevelAtLeast: 5, characterLevelAtMost: 15 } },
      { label: 'Salvager', action: 'salvage' as const, match: { name: 'Gem', characterSkills: [{ skill: 34, atLeast: 100 }, { skill: 6, baseMin: 50, baseMax: 200 }] } },
    ];
    expect(lootRuleFor(rules, { name: 'Gem' }, me())?.label).toBe('Room');
    expect(lootRuleFor(rules, { name: 'Gem' }, me({ freeSlots: 2, level: 10 }))?.label).toBe('Low level');
    expect(lootRuleFor(rules, { name: 'Gem' }, me({ freeSlots: 2, skills: { 34: { base: 80, buffed: 120 }, 6: { base: 60, buffed: 60 } } }))?.label).toBe('Salvager');
    // One of the two skills off: no match. Untrained (unknown) skill: no match. No character: no match.
    expect(lootRuleFor(rules, { name: 'Gem' }, me({ freeSlots: 2, skills: { 34: { base: 80, buffed: 120 }, 6: { base: 250, buffed: 250 } } }))).toBeNull();
    expect(lootRuleFor(rules, { name: 'Gem' }, me({ freeSlots: 2, skills: { 34: { base: 80, buffed: 120 } } }))).toBeNull();
    expect(lootRuleFor(rules, { name: 'Gem' })).toBeNull();
  });

  it('looting examines an item for property rules and decides from the identify data and your skills', async () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.skills.set(34, { base: 50, buffed: 150 });
    host.add({ guid: 0x80004001, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 80, y: 23 });
    host.appraisals.set(0x80004002, 'Value: 10');
    host.appraisalDatas.set(0x80004002, data({ int: { 28: 300 } }));
    host.appraisals.set(0x80004003, 'Value: 10');
    host.appraisalDatas.set(0x80004003, data({ int: { 28: 50 } }));
    const r = await api.appraise(0x80004002);
    expect(r.ok).toBe(true);
    expect((r as { data?: { int: Record<number, number> } }).data?.int[28]).toBe(300);
    vi.useRealTimers();
    // The engine's decide: props from the identify data, the skill from the host.
    const rules = [{ label: 'Armor', action: 'keep' as const, match: { props: [{ kind: 'int' as const, key: 28, op: 'ge' as const, value: 200 }], characterSkills: [{ skill: 34, atLeast: 100 }] } }];
    expect(lootRuleFor(rules, { name: 'Cap', props: host.appraisalData(0x80004002)! }, { freeSlots: 1, level: 1, skill: host.skill })?.label).toBe('Armor');
    expect(lootRuleFor(rules, { name: 'Cap', props: data({ int: { 28: 50 } }) }, { freeSlots: 1, level: 1, skill: host.skill })).toBeNull();
  });

  it('an item\'s subpalettes carry the colour at the middle of each range (what colour rules compare)', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    const pal = new Array(2048).fill(0x000000);
    pal[608] = 0xffc32e;
    host.palettes.set(0x04000450, pal);
    host.add({ guid: 0x80005001, name: 'Amuli Coat', objectDescFlags: 0, x: 80, y: 21, palettes: [{ id: 0x04000450, offset: 576, length: 64 }, { id: 0x04000999, offset: 0, length: 64 }] });
    expect(api.itemPalettes(0x80005001)).toEqual([{ id: 0x04000450, example: 0xffc32e }, { id: 0x04000999, example: null }]);
    // An item in your own pack isn't a world object; its CreateObject's palettes still count.
    host.carried.set(0x80005002, [{ id: 0x04000450, offset: 0, length: 64 }]);
    expect(api.itemPalettes(0x80005002)).toEqual([{ id: 0x04000450, example: 0x000000 }]);
    const rules = [{ label: 'Gold', action: 'keep' as const, match: { colours: [{ rgb: [255, 195, 46] as [number, number, number], maxHue: 10, maxSV: 0.1 }] } }];
    expect(lootRuleFor(rules, { name: 'Coat', palettes: api.itemPalettes(0x80005001) })?.label).toBe('Gold');
    expect(lootRuleFor(rules, { name: 'Coat', palettes: api.itemPalettes(0x80005002) })).toBeNull();
  });

  it('"need to buff" holds while the macro buff set has a spell down', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    api.routine.start(profile({
      settings: { BuffSet: 'Self' },
      buffSets: [{ name: 'Self', spells: [{ spell: 'Strength Self I' }], rebuffBelowSeconds: 60 }],
      states: [{ name: 'Hunt', rules: [{ label: 'Buff', when: [{ kind: 'need-buff' }], do: [{ kind: 'wait', seconds: 1 }] }] }],
    }));
    expect(api.routine.dryRun()[0].why[0]).toBe('✓ Strength Self I needs a rebuff');
    host.buffs = [{ name: 'Strength Self I', remaining: 600 }];
    expect(api.routine.dryRun()[0].why[0]).toBe('✗ buffs all up');
    api.routine.stop();
    // A dry run of a profile that isn't running reads its own BuffSet.
    host.buffs = [];
    const other = profile({
      settings: { BuffSet: 'Other' }, buffSets: [{ name: 'Other', spells: [{ spell: 'Focus Self I' }] }],
      states: [{ name: 'Hunt', rules: [{ label: 'Buff', when: [{ kind: 'need-buff' }], do: [{ kind: 'wait', seconds: 1 }] }] }],
    });
    expect(api.routine.dryRun(other)[0].why[0]).toBe('✓ Focus Self I needs a rebuff');
  });
});
