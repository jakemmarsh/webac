/**
 * A target the server no longer has (Bulwark, 2026-10-11): the client kept
 * a dead Drudge Skulker, every TargetedMeleeAttack came back AttackDone
 * ActionCancelled with no swing (ACE Player_Melee: target == null →
 * OnAttackDone, silently), and the attack task kept cycling attack heights.
 * Now a few empty attack ends stop it with the reason, and a kill line naming
 * the target is its death even while the client still shows it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

describe('attacking a target the server has finished with', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.combatMode = 'melee';
    host.add({ guid: 0x8000c72a, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21.5 });
  });
  afterEach(() => vi.useRealTimers());

  it('stops after three attack ends with no swing, and says why', async () => {
    // Each attack request: the server ends it at once (AttackDone), no combat line.
    host.attack = (g: number) => { host.sent.push(`attack ${g.toString(16)}`); setTimeout(() => api.pushAttackDone(), 100); };
    host.attackPending = () => false;
    const since = api.observe().seq;
    expect(api.attack('Drudge Skulker').ok).toBe(true);
    run(api, host, 8000, { physics: false });
    const done = api.eventsSince(since).filter((e) => e.type === 'task-done' || e.type === 'target-lost').map((e) => e.text);
    expect(done.some((t) => /server won't attack it/.test(t))).toBe(true);
    expect(done.some((t) => /ended 3 attacks on Drudge Skulker at once, with no swing/.test(t))).toBe(true);
    expect(host.sent).toContain('cancel');
  });

  it('swings in between keep it going', () => {
    let n = 0;
    host.attack = (g: number) => {
      host.sent.push(`attack ${g.toString(16)}`);
      setTimeout(() => { api.pushChat(`You hit Drudge Skulker for ${++n} points of bludgeoning damage!`, 0x16); api.pushAttackDone(); }, 100);
    };
    host.attackPending = () => false;
    const since = api.observe().seq;
    api.attack('Drudge Skulker');
    run(api, host, 8000, { physics: false });
    expect(api.eventsSince(since).some((e) => e.type === 'target-lost')).toBe(false);
  });

  it('a kill line naming it ends the attack as a kill, though the client still shows it', () => {
    host.attack = (g: number) => { host.sent.push(`attack ${g.toString(16)}`); };
    const since = api.observe().seq;
    api.attack('Drudge Skulker');
    run(api, host, 500, { physics: false });
    api.pushChat('You killed the Drudge Skulker!', 0x16);
    run(api, host, 500, { physics: false });
    expect(api.eventsSince(since).filter((e) => e.type === 'target-died').map((e) => e.text)).toEqual(['Drudge Skulker #8000c72a died']);
  });

  it('the kill line of the previous Skulker does not end the attack on the next one', () => {
    host.add({ guid: 0x8000c72b, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 21.5 });
    host.attack = (g: number) => { host.sent.push(`attack ${g.toString(16)}`); };
    api.pushChat('You killed the Drudge Skulker!', 0x16);
    host.objs.delete(0x8000c72a);
    const since = api.observe().seq;
    api.attack(0x8000c72b);
    run(api, host, 2000, { physics: false });
    expect(api.eventsSince(since).some((e) => e.type === 'target-died')).toBe(false);
    expect(host.sent).toContain('attack 8000c72b');
  });
});

describe('a fellow out of sight in a dungeon (Bulwark, 2026-10-11)', () => {
  const DUNGEON = 0x01d90000;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.cell = (DUNGEON | 0x0110) >>> 0;
    // Cell 0x0110 sees 0x0111, not 0x0130 (ACE sends only what's in the PVS).
    (host as unknown as { cellSees: (a: number, b: number) => boolean | null }).cellSees = (a, b) => (a & 0xffff) === (b & 0xffff) || (b & 0xffff) === 0x0111;
    (host as unknown as { fellows: () => unknown[] }).fellows = () => [{ guid: 0x50000002, name: 'Claude Arcanist', health: { cur: 50, max: 50 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
  });
  afterEach(() => vi.useRealTimers());

  it('a fellow in a cell out of sight is out of sight, not at its last position', () => {
    host.add({ guid: 0x50000002, name: 'Claude Arcanist', itemType: 0x10, cell: (DUNGEON | 0x0130) >>> 0, x: 80, y: 40 });
    const obs = api.observe();
    // No distance as if in view; where the client last placed her, said as that (2026-10-16 09:29Z: walk_to goes there).
    expect(obs.fellows).toEqual([{ name: 'Claude Arcanist', healthPct: 100, lastSeen: '20 m N of you' }]);
    expect(obs.nearby.some((o) => o.name === 'Claude Arcanist')).toBe(false);
    host.objs.get(0x50000002)!.cell = (DUNGEON | 0x0111) >>> 0;
    expect(api.observe().fellows?.[0].dist).toBeCloseTo(20, 0);
  });

  it('walk_to a fellow who is not in view says so', async () => {
    const r = await api.walkTo('Claude Arcanist');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Claude Arcanist is in your fellowship but not in view.*ask in \/f where they are/);
  });
});
