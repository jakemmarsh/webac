/**
 * AGENT.idle-no-agent-work (Jake, 2026-11-04: "we should only be running agent code when an agent is running!!").
 *
 * main.ts starts the agent API for every player the bridge grants automation (on playwebac.com, everyone), and its
 * 10 Hz tick ran the creature sampler (background level looks: webac#20 turned AC1999 players toward monsters), the
 * door / buff / fellow watchers, the object diff and the remembered-places / gear-cast storage writes for players
 * with no Claude paired and no routine running. Now that work runs only while an agent runs (host.agentAttached:
 * Claude on for the tab, the ?agent API; or the API's own work under way: a task, a wait, an attack order, held keys,
 * a routine loaded). Driven through the real AgentApi on the fake host; the plugins' share (routine stand-by upkeep,
 * the death event UtilityBelt reads, UB / Mag-Tools ticks) keeps running.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { relayStateBeat } from '../packages/renderer/src/agent/relayTab.ts';
import { timedAgentTick } from '../packages/renderer/src/telemetry/MainThreadCost.ts';
import { ALL_MODULES_OFF, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const DRUDGE = 0x80001ca1;
const VENDOR = 0x80003001;

const routine = (): RoutineProfile => ({
  name: 'Idle test', modules: { ...ALL_MODULES_OFF }, initialState: 'Default', loot: [], buffSets: [], routes: [],
  states: [{ name: 'Default', rules: [] }],
});

describe('AgentApi with no agent attached', () => {
  let host: FakeHost & { agentAttached?: () => boolean };
  let api: AgentApi;
  let attached: boolean;
  let stored: Map<string, string>;
  let setItem: ReturnType<typeof vi.fn>;
  const monster = (guid: number, name: string, x: number, y: number, extra: Partial<AgentHostObject> = {}): AgentHostObject =>
    host.add({ guid, name, itemType: 0x10, objectDescFlags: 0x10, x, y, ...extra });
  const types = () => api.eventsSince(0).map((e) => e.type);

  beforeEach(() => {
    vi.useFakeTimers();
    stored = new Map();
    setItem = vi.fn((k: string, v: string) => { stored.set(k, v); });
    vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem, removeItem: (k: string) => { stored.delete(k); } });
    host = new FakeHost();
    host.me.level = 20;
    attached = false;
    host.agentAttached = () => attached;
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('a monster spawning and coming at you: no level look, no aggro, no object events, no storage writes', () => {
    expect(api.agentRunning()).toBe(false);
    host.add({ guid: VENDOR, name: 'Shopkeeper Renald', itemType: 0x10, objectDescFlags: 0x200, x: 70, y: 20 });
    run(api, host, 500, { physics: false });
    const drudge = monster(DRUDGE, 'Drudge Skulker', 80, 60);
    drudge.seeks = { guid: host.me.guid, kind: 'move' };
    run(api, host, 3000, { physics: false });
    expect(host.appraiseCalls).toEqual([]);
    expect(types()).not.toContain('aggro');
    expect(types()).not.toContain('object-added');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('chat while idle goes on the event ring (UB game events read it) but is not parsed for the agent', () => {
    api.pushChat('Drudge Skulker hits you for 5 points of bludgeoning damage!', 0x15);
    api.pushChat('You cast Strength Self I on yourself and gain 10 points of strength.', 0x07);
    expect(types()).toEqual(['chat', 'chat']);
    expect(api.attackersOfMe().size).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('your death is still an event (UtilityBelt\'s CharacterDeath), named by the victim line', () => {
    run(api, host, 300, { physics: false });
    api.pushChat('You were killed by Drudge Skulker!', 0x00);
    host.me.dead = true;
    host.me.health.current = 0;
    run(api, host, 200, { physics: false });
    const death = api.eventsSince(0).find((e) => e.type === 'death');
    expect(death?.text).toMatch(/you died/);
    expect(host.appraiseCalls).toEqual([]);
  });

  it('Claude attached mid-fight: the monster already coming is raised and its level asked for; nothing already here "arrives"', () => {
    const drudge = monster(DRUDGE, 'Drudge Skulker', 80, 60);
    run(api, host, 1000, { physics: false });
    drudge.seeks = { guid: host.me.guid, kind: 'move' };
    run(api, host, 1000, { physics: false });
    expect(host.appraiseCalls).toEqual([]);
    attached = true;
    run(api, host, 1500, { physics: false });
    expect(types()).toContain('aggro');
    expect(api.eventsSince(0).find((e) => e.type === 'aggro')?.guid).toBe(DRUDGE);
    expect(host.appraiseCalls).toEqual([{ guid: DRUDGE, quiet: true }]);
    expect(types()).not.toContain('object-added');
    // Detached again: a new monster coming at you is not sampled or looked at.
    attached = false;
    run(api, host, 300, { physics: false });
    const mark = api.currentSeq();
    const second = monster(0x80001ca2, 'Drudge Prowler', 60, 60);
    second.seeks = { guid: host.me.guid, kind: 'move' };
    run(api, host, 3000, { physics: false });
    expect(host.appraiseCalls).toHaveLength(1);
    expect(api.eventsSince(mark).map((e) => e.type)).not.toContain('aggro');
  });

  it('attached, the watchers write what they always did (the remembered places), so the idle test above means something', () => {
    attached = true;
    host.add({ guid: VENDOR, name: 'Shopkeeper Renald', itemType: 0x10, objectDescFlags: 0x200, x: 70, y: 20 });
    run(api, host, 500, { physics: false });
    expect([...stored.keys()].some((k) => k.startsWith('acAgent.places.'))).toBe(true);
  });

  it('a routine the player starts runs the agent\'s work while it is loaded, and stops it when it stops', () => {
    run(api, host, 300, { physics: false });
    expect(api.routine.start(routine(), 'player').ok).toBe(true);
    expect(api.agentRunning()).toBe(true);
    const drudge = monster(DRUDGE, 'Drudge Skulker', 80, 60);
    run(api, host, 500, { physics: false });
    drudge.seeks = { guid: host.me.guid, kind: 'move' };
    run(api, host, 1000, { physics: false });
    expect(types()).toContain('aggro');
    expect(host.appraiseCalls.map((c) => c.guid)).toEqual([DRUDGE]);
    api.routine.stop('stopped', 'player');
    expect(api.agentRunning()).toBe(false);
    const mark = api.currentSeq();
    const second = monster(0x80001ca2, 'Drudge Prowler', 60, 60);
    second.seeks = { guid: host.me.guid, kind: 'move' };
    run(api, host, 3000, { physics: false });
    expect(host.appraiseCalls).toHaveLength(1);
    expect(api.eventsSince(mark).map((e) => e.type)).not.toContain('aggro');
  });

  it('a wait (an agent call in flight) runs the work until it answers', async () => {
    const drudge = monster(DRUDGE, 'Drudge Skulker', 80, 60);
    run(api, host, 500, { physics: false });
    const w = api.wait({ types: ['aggro'] }, 5000);
    expect(api.agentRunning()).toBe(true);
    drudge.seeks = { guid: host.me.guid, kind: 'move' };
    run(api, host, 1000, { physics: false });
    expect((await w)[0]?.guid).toBe(DRUDGE);
    expect(api.agentRunning()).toBe(false);
  });

  it('no stand-in host (tests, tools): always attached, as before', () => {
    const plain = new AgentApi(new FakeHost());
    expect(plain.agentRunning()).toBe(true);
  });

  it('the frame tick still runs UtilityBelt\'s and Mag-Tools\' ticks with the agent idle', () => {
    const ub = { tick: vi.fn() };
    const mag = { tick: vi.fn() };
    const routineTick = vi.spyOn(api.routine, 'tick');
    timedAgentTick({ agent: api, ub, ubOn: true, mag }, () => {});
    expect(ub.tick).toHaveBeenCalledTimes(1);
    expect(mag.tick).toHaveBeenCalledTimes(1);
    // VirindiTank's stand-by upkeep (ManaChargesWhenOff) is the routine engine's tick: it runs idle too.
    expect(routineTick).toHaveBeenCalledTimes(1);
  });
});

describe('relayStateBeat', () => {
  it('Claude off: the 10 s beat sends only a changed frame; explicit sends always go', () => {
    const off = '{"agentState":{"relay":"off","character":"A","screen":"world"}}';
    expect(relayStateBeat(false, false, off, off)).toBe(false);
    expect(relayStateBeat(false, false, off, null)).toBe(true);
    expect(relayStateBeat(false, false, off.replace('world', 'portal-space'), off)).toBe(true);
    expect(relayStateBeat(true, false, off, off)).toBe(true);
  });
  it('Claude on: every beat goes (the bridge\'s view stays fresh)', () => {
    const on = '{"agentState":{"relay":"on","character":"A","screen":"world"}}';
    expect(relayStateBeat(false, true, on, on)).toBe(true);
  });
});
