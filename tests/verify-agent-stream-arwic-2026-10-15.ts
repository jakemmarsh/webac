/**
 * The stream players' Arwic Mines reports (landblock 0x01E3, 2026-10-15 23:58–00:42 UTC; transcripts
 * stream/sessions/{mage,soldier}-2026-10-15-seg1.jsonl, page logs mage.log / soldier.log):
 *  - Bulwark's "ghost" Silver Rats (#8000b1c9, #8000b3a1, Large #8000b165, cells 0x01E30293–029C) were alive behind shut
 *    doors (#701e3049 / 304a locked, 304c shut). Every attack came back AttackDone ActionCancelled 0x36 (ACE's approach
 *    can't path through the door) while the rats hit him through it (ACE's monster melee checks distance only). The
 *    attack cycled the heights on the cancels and called the rat "a ghost".
 *  - Creatures the client released (world/ObjectMaint.ts now keeps only your cell's visible cells in a dungeon) are not
 *    listed, unless the server placed them a moment ago (a fellow walking beside you through a cell your stab list lacks).
 *  - "hit by, but not placed" says why: the server shows you no monster in a cell yours can't see, yet its melee reaches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import type { AgentEvent } from '../packages/renderer/src/agent/types.ts';
import { FakeHost } from './_harness/agentFake.ts';

const RAT = 0x8000b3a1;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) {
    each?.();
    host.t += 100;
    vi.advanceTimersByTime(100);
    api.tick();
    await Promise.resolve(); await Promise.resolve();
  }
  return out;
}

describe('melee on a creature the server cancels every attack on (a rat behind a shut door)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.combatMode = 'melee';
    // 2.2 m off, a shut door 2.0 m along the line (the observe line Bulwark saw).
    host.add({ guid: RAT, name: 'Silver Rat', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22.2 });
    host.lineOfFire = () => ({ dist: 2.2, blockedAt: 2.0, blocker: 'Door' });
    // ACE: the request stays pending while its MoveTo tries the door, then ends ActionCancelled, no swing, no line.
    host.attack = (g: number, p: number, h: string) => {
      host.sent.push(`attack ${g.toString(16)} ${p} ${h}`);
      host.pending = true;
      setTimeout(() => { host.pending = false; api.pushAttackDone(0x36); }, 5000);
    };
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('stops after two cancels, names the door, and never cycles the attack height', async () => {
    api.attack(RAT);
    const w = api.wait({ types: ['target-died', 'target-lost'] }, 45_000);
    // The rat keeps nicking you through the door meanwhile.
    let n = 0;
    const evs = await settle(api, host, w, 45_000, () => { if (++n % 20 === 0) api.pushChat('Silver Rat nicks your lower leg for 0 points of piercing damage!', 0x15); });
    expect(evs?.map((e: AgentEvent) => e.type)).toEqual(['target-lost']);
    expect(evs?.[0].text).toMatch(/^Silver Rat #8000b3a1: the server cancelled 2 attacks with no swing: a shut door stands between you \(2\.0 m along the line to it\): the server can't bring you to it, though it can hit you through it/);
    expect(evs?.[0].text).not.toMatch(/ghost/);
    expect(host.sent.filter((s) => s.startsWith('height'))).toEqual([]);
    expect(host.sent).toContain('cancel');
  });

  it('a first cancel late (9 s, Bulwark\'s first) costs one height change at most; the next cancel ends it with the door', async () => {
    host.attack = (g: number, p: number, h: string) => {
      host.sent.push(`attack ${g.toString(16)} ${p} ${h}`);
      host.pending = true;
      setTimeout(() => { host.pending = false; api.pushAttackDone(0x36); }, 9000);
    };
    api.attack(RAT);
    const w = api.wait({ types: ['target-died', 'target-lost'] }, 45_000);
    const evs = await settle(api, host, w, 45_000);
    expect(evs?.[0].text).toMatch(/the server cancelled 2 attacks with no swing: a shut door stands between you/);
    expect(host.sent.filter((s) => s.startsWith('height')).length).toBeLessThanOrEqual(1);
  });

  it('with an open line, the cancels end it as before (three, "dead or gone"), with no height changes', async () => {
    host.lineOfFire = () => ({ dist: 2.2, blockedAt: null });
    host.attack = (g: number) => { host.sent.push(`attack ${g.toString(16)}`); host.pending = true; setTimeout(() => { host.pending = false; api.pushAttackDone(0x36); }, 200); };
    api.attack(RAT);
    const w = api.wait({ types: ['target-died', 'target-lost'] }, 20_000);
    const evs = await settle(api, host, w, 20_000);
    expect(evs?.[0].text).toMatch(/the server won't attack it/);
    expect(host.sent.filter((s) => s.startsWith('height'))).toEqual([]);
  });

  it('a swing that reaches it between the cancels keeps the attack going', async () => {
    let k = 0;
    host.attack = (g: number) => {
      host.sent.push(`attack ${g.toString(16)}`);
      host.pending = true;
      const i = ++k;
      setTimeout(() => { host.pending = false; if (i % 2 === 0) api.pushChat(`You hit Silver Rat for ${i} points of bludgeoning damage!`, 0x16); api.pushAttackDone(i % 2 === 0 ? 0 : 0x36); }, 500);
    };
    api.attack(RAT);
    const w = api.wait({ types: ['target-died', 'target-lost'] }, 8000);
    const evs = await settle(api, host, w, 8000);
    expect(evs ?? []).toEqual([]);
  });

  it('an approach the server never answers ends naming the door, not "a ghost"', async () => {
    host.attack = (g: number) => { host.sent.push(`attack ${g.toString(16)}`); host.pending = true; };
    api.attack(RAT);
    const w = api.wait({ types: ['target-died', 'target-lost'] }, 30_000);
    const evs = await settle(api, host, w, 30_000);
    expect(evs?.[0].text).toMatch(/(swings at all three heights reported nothing|no swings either way for 20 s \(): a? ?shut door stands between you|shut door stands between you/);
    expect(evs?.[0].text).not.toMatch(/ghost/);
  });
});

describe('released creatures (ObjectMaint) in the agent\'s view', () => {
  const DUNGEON = 0x01e30000;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.cell = (DUNGEON | 0x029a) >>> 0;
    host.fellows = () => [{ guid: 0x500000a4, name: 'Claude Bulwark', health: { cur: 140, max: 146 }, stamina: { cur: 5, max: 216 }, mana: { cur: 10, max: 10 } }] as never;
  });
  afterEach(() => vi.useRealTimers());

  it('a released Drudge Hoarder (no word from the server) is neither listed nor a target', () => {
    host.t = 100_000;
    host.add({ guid: 0x8000b387, name: 'Drudge Hoarder', itemType: 0x10, objectDescFlags: 0x10, cell: (DUNGEON | 0x01f2) >>> 0, x: 80, y: 40, lost: true, heardAt: 10_000 });
    expect(api.observe().nearby.some((o) => o.guid === 0x8000b387)).toBe(false);
    const r = api.walkTo(0x8000b387);
    return r.then((x) => expect(x.message).toMatch(/out of sight: your client let it go/));
  });

  it('a fellow the server placed a moment ago is where it is, released or not', () => {
    host.t = 100_000;
    host.add({ guid: 0x500000a4, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: (DUNGEON | 0x0296) >>> 0, x: 80, y: 28, lost: true, heardAt: 99_000 });
    expect(api.observe().fellows?.[0]).toMatchObject({ name: 'Claude Bulwark', dist: 8 });
    host.t = 99_000 + AgentApi.HEARD_FRESH_MS + 1;
    expect(api.observe().fellows?.[0].dist).toBeUndefined();
  });
});

describe('"hit by, but not placed" says what the server is doing', () => {
  it('names the unseen-cell rule and the distance-only melee', () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.me.cell = 0x01e3024b;
    api.pushChat('Drudge Slave nicks your chest for 1 point of piercing damage!', 0x15);
    const text = formatObservation(api.observe());
    expect(text).toMatch(/hit by, but not placed: Drudge Slave \(1× in 10 s\) \(none of that name in sight within reach: a monster in a cell yours can't see is not shown to you, yet its melee reaches through a wall or shut door \(the server checks distance only\)/);
    vi.useRealTimers();
  });
});
