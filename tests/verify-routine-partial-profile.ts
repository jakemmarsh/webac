/**
 * BUG.routine-partial-profile-crash (prod 2026-11-09, Seedsow, build 8f12c6e6c): a running macro whose profile had
 * no `states` threw out of the page's frame loop every tick, `p.states.find` in RoutineEngine.dryRun and then, once
 * the character died, `p.states.some` in usesCondition. Profiles are made complete where they come in
 * (normalizeRoutineProfile: RoutineSync's load / check, the engine's start / update / dryRun / stand-by), and a
 * tick that throws anyway stops its run with a line the player sees, reported once, never leaving the frame step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, isPlaceRecord } from '../packages/renderer/src/agent/AgentApi.ts';
import { exprVarStore } from '../packages/renderer/src/agent/VtankExprHost.ts';
import { MtCombatTracker } from '../packages/shared/src/magtools/combatTracker.ts';
import { RoutineSync } from '../packages/renderer/src/agent/RoutineSync.ts';
import { timedAgentTick } from '../packages/renderer/src/telemetry/MainThreadCost.ts';
import type { RoutineLifecycleEvent } from '../packages/renderer/src/telemetry/AutomationReporter.ts';
import {
  ALL_MODULES_OFF, EXAMPLE_HUNT_PROFILE, normalizeRoutineDoc, normalizeRoutineProfile, validateRoutineDoc, ROUTINE_SCHEMA_VERSION, type RoutineProfile,
} from '../packages/shared/src/routines/index.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const doc = (profiles: unknown[]) => ({ schemaVersion: ROUTINE_SCHEMA_VERSION, account: 'jake', server: 'seedsow', updatedAt: '2026-11-09T00:00:00.000Z', profiles });
/** The prod shape: VirindiTank Macro Settings with no meta lists at all. */
const macroOnly = (): RoutineProfile => ({ name: 'Default', macro: true, settings: { EnableCombat: true } }) as unknown as RoutineProfile;

describe('normalizeRoutineProfile', () => {
  it('hands a complete profile back as the same object (nothing copied)', () => {
    expect(normalizeRoutineProfile(EXAMPLE_HUNT_PROFILE)).toBe(EXAMPLE_HUNT_PROFILE);
    const d = doc([structuredClone(EXAMPLE_HUNT_PROFILE)]);
    const before = d.profiles[0];
    expect(normalizeRoutineDoc(d)).toBe(0);
    expect(d.profiles[0]).toBe(before);
  });

  it('fills every list a profile is missing; the result validates', () => {
    const p = normalizeRoutineProfile(macroOnly());
    expect(p).toMatchObject({ name: 'Default', macro: true, initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], routes: [], buffSets: [], modules: ALL_MODULES_OFF, settings: { EnableCombat: true } });
    expect(validateRoutineDoc(doc([p]))).toEqual([]);
    // Nothing at all: still something the engine can hold.
    expect(validateRoutineDoc(doc([normalizeRoutineProfile(undefined)]))).toEqual([]);
    // initialState naming no state: the first state's.
    expect(normalizeRoutineProfile({ ...EXAMPLE_HUNT_PROFILE, initialState: 'Gone' }).initialState).toBe(EXAMPLE_HUNT_PROFILE.states[0].name);
  });

  it('switches off a rule whose conditions are missing or unreadable, rather than letting it fire every step', () => {
    const p = normalizeRoutineProfile({
      ...structuredClone(EXAMPLE_HUNT_PROFILE), initialState: 'S',
      states: [{ name: 'S', rules: [
        { label: 'no when', do: [{ kind: 'attack-nearest' }] },
        { label: 'empty any', when: [{ kind: 'any' }], do: [{ kind: 'attack-nearest' }] },
        { label: 'bad not', when: [{ kind: 'not' }], do: [] },
        { label: 'no do', when: [{ kind: 'always' }] },
        { label: 'fine', when: [{ kind: 'always' }], do: [{ kind: 'wait', seconds: 1 }] },
      ] }, { name: 'T' }],
    });
    const rules = p.states[0].rules;
    expect(rules.slice(0, 3).map((r) => r.disabled)).toEqual([true, true, true]);
    expect(rules[0].note).toMatch(/switched off/);
    expect(rules[3]).toMatchObject({ when: [{ kind: 'always' }], do: [] });
    expect(rules[3].disabled).toBeUndefined();
    expect(rules[4].disabled).toBeUndefined();
    expect(p.states[1]).toEqual({ name: 'T', rules: [] });
    expect(validateRoutineDoc(doc([p]))).toEqual([]);
  });

  it('fills loot rules, loot sets, routes, buff sets and the VirindiTank tabs', () => {
    const p = normalizeRoutineProfile({
      name: 'X', loot: [{ action: 'keep' }, 'junk'], lootSets: { a: null }, routes: [{ name: 'r' }], buffSets: [{ name: 'b' }], vtank: { items: null },
    });
    expect(p.loot).toEqual([{ action: 'keep', match: {}, disabled: true, note: expect.stringMatching(/switched off/) }]);
    expect(p.lootSets).toEqual({ a: [] });
    expect(p.routes).toEqual([{ name: 'r', mode: 'circular', points: [] }]);
    expect(p.buffSets).toEqual([{ name: 'b', spells: [] }]);
    expect(p.vtank?.monsters[0].name).toBe('<DEFAULT>');
    expect(p.vtank).toMatchObject({ items: [], consumables: [], excludedScarabs: [], extraBuffs: [], blacklistedBuffs: [] });
    expect(validateRoutineDoc(doc([p]))).toEqual([]);
  });

  it('normalizeRoutineDoc makes profiles a list and drops what is not a profile', () => {
    const d = { schemaVersion: 1, account: 'a', server: 's', updatedAt: '' } as Record<string, unknown>;
    expect(normalizeRoutineDoc(d)).toBe(1);
    expect(d.profiles).toEqual([]);
    const e = doc([null, macroOnly()]);
    expect(normalizeRoutineDoc(e)).toBe(2);
    expect((e.profiles as RoutineProfile[]).map((p) => p.states.length)).toEqual([1]);
  });
});

describe('RoutineSync hands out complete profiles', () => {
  it('a stored document with a profile missing its states loads complete', async () => {
    const grant = { token: '', server: 'seedsow', account: 'jake', local: true as const };
    const store = new Map<string, string>([['acjs.routines.v1.seedsow.jake', JSON.stringify(doc([macroOnly()]))]]);
    const sync: RoutineSync = new RoutineSync(
      () => ({ bridgeUrl: 'wss://bridge.example/', requestRoutinesGrant: () => queueMicrotask(() => sync.onGrant(grant)) }),
      undefined,
      () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } }),
    );
    const r = await sync.load();
    expect(r.ok).toBe(true);
    const loaded = (r as { doc: { profiles: RoutineProfile[] } }).doc.profiles[0];
    expect(loaded.states).toEqual([{ name: 'Default', rules: [] }]);
    const c = await sync.check('older');
    expect((c as { doc: { profiles: RoutineProfile[] } }).doc.profiles[0].states).toHaveLength(1);
  });
});

describe('RoutineEngine with a partial profile', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => vi.useRealTimers());

  it('runs a macro profile with no states: no throw, the macro acts, death stops it as StopMacroOnDeath says', () => {
    const events: RoutineLifecycleEvent[] = [];
    api.routine.onLifecycle = (e) => events.push(e);
    expect(api.routine.start(macroOnly()).ok).toBe(true);
    expect(() => run(api, host, 1500)).not.toThrow();
    expect(api.routine.status()).toMatchObject({ running: true, state: 'Default' });
    expect(api.routine.dryRun()).toEqual([]);
    // The prod trace's second error: usesCondition(p, 'died') on a dead character.
    host.me.dead = true;
    expect(() => run(api, host, 1000)).not.toThrow();
    expect(api.routine.status().running).toBe(false);
    expect(events.filter((e) => e.type === 'stop')).toEqual([{ type: 'stop', reason: 'died' }]);
  });

  it('a rule stored without conditions never fires', () => {
    host.add({ guid: 0x80001003, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 24 });
    api.routine.start({ ...macroOnly(), macro: false, modules: { ...ALL_MODULES_OFF, combat: true }, initialState: 'Hunt', states: [{ name: 'Hunt', rules: [{ label: 'Fight', do: [{ kind: 'attack-nearest', meters: 40 }] }] }] } as unknown as RoutineProfile);
    expect(() => run(api, host, 1500)).not.toThrow();
    expect(host.sent.some((x) => x.startsWith('attack'))).toBe(false);
    expect(api.routine.dryRun()[0]).toMatchObject({ rule: 'Fight', fires: false, off: true });
  });

  it('dry-runs, updates to and stands by with partial profiles without throwing', () => {
    expect(api.routine.dryRun(macroOnly())).toEqual([]);
    api.routine.standby = () => ({ name: 'Default', settings: { ManaChargesWhenOff: true }, vtank: {} }) as unknown as RoutineProfile;
    expect(() => run(api, host, 1500)).not.toThrow();
    api.routine.start(structuredClone(EXAMPLE_HUNT_PROFILE));
    expect(api.routine.update({ name: EXAMPLE_HUNT_PROFILE.name } as unknown as RoutineProfile).ok).toBe(true);
    expect(() => run(api, host, 1500)).not.toThrow();
    expect(api.routine.status().running).toBe(true);
  });
});

describe('the routine tick never throws out of the frame', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => vi.useRealTimers());

  it('a fault in a running routine\'s step stops it, says why in chat, and is reported once', () => {
    const reports: string[] = [];
    const faults: unknown[] = [];
    const events: RoutineLifecycleEvent[] = [];
    api.routine.onReport = (t) => reports.push(t);
    api.routine.onFault = (e) => faults.push(e);
    api.routine.onLifecycle = (e) => events.push(e);
    api.routine.start(structuredClone(EXAMPLE_HUNT_PROFILE));
    const look = api.look.bind(api);
    api.look = (() => { throw new Error('boom'); }) as typeof api.look;
    expect(() => run(api, host, 3000)).not.toThrow();
    expect(api.routine.status().running).toBe(false);
    expect(reports.some((r) => /^Stopped ".+": it hit an error \(boom\)/.test(r))).toBe(true);
    expect(events.filter((e) => e.type !== 'start')).toEqual([{ type: 'error', where: 'tick' }, { type: 'stop', reason: 'fault' }]);
    expect(faults).toHaveLength(1);
    // Started again with the same fault: stopped again, but the page's report isn't repeated.
    api.routine.start(structuredClone(EXAMPLE_HUNT_PROFILE));
    run(api, host, 1000);
    expect(api.routine.status().running).toBe(false);
    expect(faults).toHaveLength(1);
    api.look = look;
  });

  it('a stand-by profile that throws is reported once and the tick carries on', () => {
    const faults: unknown[] = [];
    api.routine.onFault = (e) => faults.push(e);
    let asks = 0;
    api.routine.standby = () => { asks++; throw new Error('window gone'); };
    expect(() => run(api, host, 3000)).not.toThrow();
    expect(asks).toBeGreaterThan(3);
    expect(faults).toHaveLength(1);
  });

  it('timedAgentTick: a part that throws goes to fault and the other parts still run', () => {
    const ran: string[] = [];
    const faults: Array<[string, string]> = [];
    const marks: number[] = [];
    expect(() => timedAgentTick({
      agent: { tick: () => { throw new Error('agent broke'); } },
      ub: { tick: () => { ran.push('ub'); throw new Error('ub broke'); } },
      ubOn: true,
      mag: { tick: () => ran.push('mag') },
    }, (p) => marks.push(p), (part, e) => faults.push([part, (e as Error).message]))).not.toThrow();
    expect(ran).toEqual(['ub', 'mag']);
    expect(faults).toEqual([['agent', 'agent broke'], ['ub', 'ub broke']]);
    expect(marks).toHaveLength(3);
    // A reporter that throws is its own fault too.
    expect(() => timedAgentTick({ agent: { tick: () => { throw new Error('x'); } }, ubOn: false }, () => {}, () => { throw new Error('reporter'); })).not.toThrow();
  });
});

describe('sweep: other stored automation data read on the per-tick path', () => {
  it('remembered places keep only well-formed records', () => {
    expect(isPlaceRecord({ name: 'Holtburg Lifestone', kind: 'lifestone', cell: 0xa9b40021, x: 1, y: 2, z: 3 })).toBe(true);
    for (const bad of [null, 'x', [], { name: 'A', kind: 'npc', cell: 1, x: 1, y: 2 }, { kind: 'npc', cell: 1, x: 1, y: 2, z: 0 }, { name: 'A', kind: 'npc', cell: 1, x: NaN, y: 2, z: 0 }]) {
      expect(isPlaceRecord(bad)).toBe(false);
    }
  });

  it('expression variables stored as null or a list read as none, not as null', () => {
    const mem = new Map<string, string>();
    const prev = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } };
    try {
      for (const raw of ['null', '[1,2]', '"x"', '{not json']) {
        mem.set('k', raw);
        expect(exprVarStore('k').get()).toEqual({});
      }
      mem.set('k', '{"n":{"kind":"number","value":3}}');
      expect(exprVarStore('k').get()).toEqual({ n: { kind: 'number', value: 3 } });
    } finally { (globalThis as { localStorage?: unknown }).localStorage = prev; }
  });

  it('Mag-Tools persistent combat stats take only a whole, well-formed snapshot', () => {
    const t = new MtCombatTracker(() => 'Me', () => 0);
    expect(() => t.restore({ infos: [{ source: 'Me', target: 'Drudge' }] } as never)).not.toThrow();
    expect(t.snapshot()).toEqual({ infos: [], order: [] });
    t.restore({ infos: [null, { source: 'Me', target: 'Drudge', killingBlows: 1 }], order: ['Drudge', 7] } as never);
    expect(t.snapshot().order).toEqual(['Drudge']);
    expect(t.snapshot().infos).toHaveLength(1);
  });
});
