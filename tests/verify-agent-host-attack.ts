/**
 * The agent host's attack (packages/renderer/src/agent/hostAttack.ts) driven by the real
 * AgentApi.attack loop. Claude Bulwark (2026-10-10) stood among rats swinging about once: from
 * peace mode the host switched stance and sent the swing a second later outside the attack
 * request state, so attackPending read false, the loop re-sent every 1.5 s, and ACE cancelled
 * each approach / swing in flight (AttackDone ActionCancelled 0x36).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { AUTO_ENTER_DELAY_MS, createHostAttack } from '../packages/renderer/src/agent/hostAttack.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const RAT = 0x80001175;

describe('agent host attack: stance auto-enter, then the attack key', () => {
  let host: FakeHost;
  let api: AgentApi;
  let stance: 'peace' | 'melee';
  let modes: number[];
  let swings: number;
  let requestPending: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    stance = 'peace';
    modes = [];
    swings = 0;
    requestPending = false;
    const hostAttack = createHostAttack({
      inAttackStance: () => stance === 'melee',
      autoEnterPlan: () => ({ sendAttack: true, mode: 2 }),
      changeCombatMode: (m) => { modes.push(m); setTimeout(() => { stance = 'melee'; }, 400); },
      // The attack key: the request waits on the server's approach and swings (AttackDone ends it).
      swing: (g) => { if (stance !== 'melee') return; swings++; requestPending = true; host.sent.push(`attack ${g.toString(16)}`); },
      requestPending: () => requestPending,
      now: () => host.t,
      schedule: (fn, ms) => { setTimeout(fn, ms); },
    });
    host.attack = (g, p, h) => hostAttack.attack(g, p, h as 'high' | 'medium' | 'low');
    host.attackPending = () => hostAttack.pending();
    api = new AgentApi(host);
    host.add({ guid: RAT, name: 'Rat', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 21 });
  });
  afterEach(() => vi.useRealTimers());

  it('from peace: one stance change, one swing, and no re-send while the server runs the attack', () => {
    expect(api.attack('Rat').ok).toBe(true);
    run(api, host, AUTO_ENTER_DELAY_MS + 100);
    expect(modes).toEqual([2]);
    expect(swings).toBe(1); // the delayed swing, through the attack key
    // The server's approach and repeating swings: the loop must not re-send (each re-send was a 0x36 cancel).
    for (let i = 0; i < 10; i++) { run(api, host, 500); api.pushChat('You hit Rat for 3 points!', 0x16); }
    expect(swings).toBe(1);
    expect(modes).toEqual([2]);
  });

  it('still counts as pending between the stance change and the delayed swing', () => {
    api.attack('Rat');
    run(api, host, 100);
    expect(swings).toBe(0);
    expect(host.attackPending()).toBe(true);
    run(api, host, AUTO_ENTER_DELAY_MS);
    expect(swings).toBe(1);
  });

  it('re-sends once the chain ends (AttackDone), now from the combat stance', () => {
    api.attack('Rat');
    run(api, host, AUTO_ENTER_DELAY_MS + 2500);
    expect(swings).toBe(1);
    requestPending = false; // AttackDone
    run(api, host, 1700);
    expect(swings).toBe(2);
    expect(modes).toEqual([2]); // already in stance: no second auto-enter
  });

  it('in a combat stance already: the attack key at once', () => {
    stance = 'melee';
    api.attack('Rat');
    run(api, host, 100);
    expect(swings).toBe(1);
    expect(modes).toEqual([]);
  });
});
