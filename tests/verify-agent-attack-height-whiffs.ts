/**
 * BUG.agent-attack-1999-height-whiff (live, AC1999 server, 2026-10-13): a level-1 character, bare-handed, attacked a
 * Desert Rabbit 1.1 m away at medium height. Every swing ended with AttackDone 0 and no line, because the AC1999
 * server's CMeleeAttackEvent::ConeHitHeight (Server/Source/combat/MeleeAttackEventData.cpp) returns
 * UNDEF_ATTACK_HEIGHT for a swing above the target's height and HandlePerformAttack then does nothing. After three such
 * ends the attack task said "the server ended 3 attacks … at once, with no swing: probably dead or gone" before its
 * quiet-swing height cycling (6 s) ever ran, so routine pulls of rabbits failed. A low swing killed it at once.
 *
 * Now finished swings (AttackDone 0) that hit nothing try the other heights first: the first height gets three, each
 * other height one. ACE's gone-target ends (ActionCancelled 0x36) keep the old answer unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { RoutineAction, RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { ALL_MODULES_OFF } from '../packages/shared/src/routines/index.ts';
import { mapCoordsText } from '../packages/renderer/src/agent/RoutineEngine.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';

const RABBIT = 0x80003001;
/** WeenieError None: a swing that finished (both servers send it between repeat swings). */
const SWUNG = 0;
/** ACE Player_Melee.OnAttackDone's code for every end of an attack (WeenieError.ActionCancelled). */
const ACTION_CANCELLED = 0x36;

describe('melee attacks whose swings pass over the target (AC1999 cone height)', () => {
  let host: FakeHost;
  let api: AgentApi;
  /** The heights the server swung at, in order. */
  let swings: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    AgentApi.reachHeights.clear();
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.combatMode = 'melee';
    host.add({ guid: RABBIT, name: 'Desert Rabbit', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21.1 });
    swings = [];
    host.attackPending = () => false;
  });
  afterEach(() => { vi.useRealTimers(); AgentApi.reachHeights.clear(); });

  /** The AC1999 server: each attack request is one swing ending in AttackDone 0; only `reaches` heights land. */
  const server1999 = (reaches: (h: string) => boolean, onHit?: () => void): void => {
    host.attack = (g: number, p: number, h: string) => {
      host.sent.push(`attack ${g.toString(16)} ${p} ${h}`);
      api.noteMeleeSent(h); // main.ts's TargetedMeleeAttack send
      setTimeout(() => {
        swings.push(h);
        if (reaches(h)) { api.pushChat('You hit Desert Rabbit for 5 points of bludgeoning damage!', 0x16); onHit?.(); }
        api.pushAttackDone(SWUNG);
      }, 600);
    };
  };

  it('medium swings that hit nothing switch to low, which kills it; low is remembered for rabbits', () => {
    server1999((h) => h === 'low', () => host.dying.add(RABBIT));
    const since = api.observe().seq;
    expect(api.attack('Desert Rabbit').ok).toBe(true);
    run(api, host, 15_000, { physics: false });
    const evs = api.eventsSince(since);
    expect(evs.some((e) => e.type === 'target-lost')).toBe(false);
    expect(evs.filter((e) => e.type === 'target-died').map((e) => e.text)).toEqual([`Desert Rabbit #${RABBIT.toString(16)} died`]);
    expect(swings.slice(0, 3)).toEqual(['medium', 'medium', 'medium']);
    expect(swings[3]).toBe('low');
    expect(host.sent).toContain('height low');
    expect(evs.some((e) => e.type === 'chat' && /swings at Desert Rabbit hit nothing at medium height: attacking low instead/.test(e.text))).toBe(true);
    expect(AgentApi.reachHeights.get('desert rabbit')).toBe('low');
  });

  it('a creature only a high swing reaches: medium, then low, then high (the first end after a switch can be the old swing\'s, so two at each)', () => {
    server1999((h) => h === 'high', () => host.dying.add(RABBIT));
    api.attack('Desert Rabbit');
    run(api, host, 15_000, { physics: false });
    expect(swings).toEqual(['medium', 'medium', 'medium', 'low', 'low', 'high']);
    expect(host.sent.filter((s) => s.startsWith('height'))).toEqual(['height low', 'height high']);
    expect(AgentApi.reachHeights.get('desert rabbit')).toBe('high');
  });

  it('every height hitting nothing gives the old answer, after two swings at each other height', () => {
    server1999(() => false);
    const since = api.observe().seq;
    api.attack('Desert Rabbit');
    run(api, host, 15_000, { physics: false });
    const evs = api.eventsSince(since);
    expect(swings).toEqual(['medium', 'medium', 'medium', 'low', 'low', 'high', 'high']);
    expect(evs.filter((e) => e.type === 'target-lost').map((e) => e.text)).toEqual([`Desert Rabbit #${RABBIT.toString(16)}: the server won't attack it at any height`]);
    expect(evs.some((e) => e.type === 'task-done' && /ended 7 attacks on Desert Rabbit at all three heights at once, with no swing: it is probably dead or gone/.test(e.text))).toBe(true);
    expect(AgentApi.reachHeights.has('desert rabbit')).toBe(false);
  });

  it('the AC1999 server repeating swings on its own: ends at the old height after the switch do not count for the new one (live: low was skipped)', () => {
    // Live log (2026-10-13): one request at medium, then AttackDone 0 after AttackDone 0 as the server kept swinging; after the
    // bar moved, more of them arrived before any low request went out, and counted as low's misses (medium → high → gone).
    let chain: ReturnType<typeof setInterval> | null = null;
    const stop = (): void => { if (chain) { const c = chain; chain = null; setTimeout(() => { clearInterval(c); api.pushAttackDone(SWUNG); }, 300); } };
    host.attack = (g: number, p: number, h: string) => {
      host.sent.push(`attack ${g.toString(16)} ${p} ${h}`);
      api.noteMeleeSent(h);
      stop();
      chain = setInterval(() => {
        swings.push(h);
        if (h === 'low') { api.pushChat('You hit Desert Rabbit for 5 points of bludgeoning damage!', 0x16); host.dying.add(RABBIT); }
        api.pushAttackDone(SWUNG);
      }, 700);
    };
    const cancel = host.cancelAttack.bind(host);
    host.cancelAttack = () => { cancel(); stop(); };
    const since = api.observe().seq;
    api.attack('Desert Rabbit');
    run(api, host, 20_000, { physics: false });
    if (chain) clearInterval(chain);
    const evs = api.eventsSince(since);
    expect(swings).toContain('low');
    expect(evs.some((e) => e.type === 'target-died')).toBe(true);
    expect(evs.some((e) => e.type === 'target-lost')).toBe(false);
  });

  it('end of retail (ACE): a target gone on the server ends with ActionCancelled and stops after three, no height changes', () => {
    host.attack = (g: number, p: number, h: string) => { host.sent.push(`attack ${g.toString(16)} ${p} ${h}`); setTimeout(() => api.pushAttackDone(ACTION_CANCELLED), 100); };
    const since = api.observe().seq;
    api.attack('Desert Rabbit');
    run(api, host, 8000, { physics: false });
    const done = api.eventsSince(since).filter((e) => e.type === 'task-done').map((e) => e.text);
    expect(done.some((t) => /the server ended 3 attacks on Desert Rabbit at once, with no swing: it is probably dead or gone/.test(t))).toBe(true);
    expect(host.sent.filter((s) => s.startsWith('height'))).toEqual([]);
    expect(host.sent.filter((s) => s.startsWith('attack'))).toHaveLength(3);
  });

  it('end of retail (ACE): repeat swings that land (AttackDone 0 after each hit line) never change height', () => {
    let n = 0;
    host.attack = (g: number, p: number, h: string) => {
      host.sent.push(`attack ${g.toString(16)} ${p} ${h}`);
      setTimeout(() => { api.pushChat(`You hit Desert Rabbit for ${++n} points of bludgeoning damage!`, 0x16); api.pushAttackDone(SWUNG); }, 600);
    };
    const since = api.observe().seq;
    api.attack('Desert Rabbit');
    run(api, host, 12_000, { physics: false });
    expect(api.eventsSince(since).some((e) => e.type === 'target-lost' || e.type === 'task-done')).toBe(false);
    expect(host.sent.filter((s) => s.startsWith('height'))).toEqual([]);
    expect(AgentApi.reachHeights.get('desert rabbit')).toBe('medium');
  });

  it('a routine pull of a rabbit on the AC1999 server lands once the attack drops to low', async () => {
    server1999((h) => h === 'low');
    const walk = vi.spyOn(api, 'walkTo').mockResolvedValue({ ok: true, message: 'arrived' });
    const OX = ((HOLTBURG >>> 24) & 0xff) * 192;
    const OY = ((HOLTBURG >>> 16) & 0xff) * 192;
    const back = mapCoordsText({ x: OX + 80, y: OY + 5 });
    const p: RoutineProfile = {
      name: 'Pull', modules: { ...ALL_MODULES_OFF, combat: true, navigation: true },
      initialState: 'Default', loot: [], buffSets: [], routes: [],
      states: [{ name: 'Default', rules: [] }],
    };
    api.routine.start(p);
    const act = (api.routine as unknown as { act(a: RoutineAction, p: RoutineProfile): Promise<{ ok: boolean; message: string } | null> }).act.bind(api.routine);
    const pulled = act({ kind: 'pull', pattern: 'Rabbit', back }, p);
    for (let i = 0; i < 100; i++) { run(api, host, 200, { physics: false }); await vi.advanceTimersByTimeAsync(0); }
    const r = await pulled;
    expect(r?.message).toMatch(/^pulled Desert Rabbit \(You hit Desert Rabbit/);
    expect(swings).toContain('low');
    expect(walk).toHaveBeenCalled();
  });
});
