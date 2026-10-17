/**
 * Attack fixes from the stream players' segment 15:06–16:08Z on 2026-10-17 (end-of-retail local ACE, Tusker Habitat
 * 0x5B47; build 7bddbaec; reports stream/reports/{soldier-2026-10-17T16-07-59-676Z,mage-2026-10-17T16-08-05-128Z}-seg1.md;
 * transcripts stream/sessions/{soldier,mage}-2026-10-17-seg1.jsonl; page traces soldier.log / soldier.chat.log /
 * mage.chat.log):
 *   1. `attack #8000c3b3` → target-died 15:56:39.942Z while it stood 2.2 m off at 80%: the attack task took the kill line
 *      "Tusker Liberator died!" (soldier.chat.log 15:56:39.868Z: #8000c320, bleeding from Bulwark's earlier Dirty
 *      Fighting, never seen again) as its target's. ACE sends the kill line (Creature.OnDeath) before the Dead motion
 *      (Die), so ebf75d89's "a namesake seen dying" check had nothing to go on. Deaths now need evidence tied to the guid.
 *   2. `attack #800007fa far=true` → target-lost "went out of view (fled, or you moved away)" 34 s into a circling run-up
 *      (15:28:22Z, 15:31:39Z): the client had let it go (out of the dungeon cells' sight) and dropped it 25 s later. It
 *      was there all along (19.8 m S at 15:30:54Z, killed 2 m off at 15:37:45Z).
 *   3. `attack #8000c260` → "the run-up … drops 2 m to the floor below" with it 1.7 m off, hitting him (15:30:56Z; the
 *      same for #8000c35d / #8000c37c at 16:05Z, 2.2 m off, 5 hits in 10 s): the drop was the 1.7 m floor opening, said
 *      rounded, and no run-up was needed (ACE swings from within StickyDistance 4 m).
 *   4. fellow-aggro "on your fellow Claude Arcanist" for Liberators "on the floor below": they were on the 1.7 m step-down
 *      and hitting her (mage.chat.log 16:05:07–37Z, 11 hits). Correct; a monster a storey off a fellow is never raised.
 * Each drives the shipped AgentApi on the fake host (tests/_harness/agentFake.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const ARC = 0x50000002;
const LIB = (guid: number, o: Partial<AgentHostObject> = {}): Partial<AgentHostObject> & { guid: number; name: string } =>
  ({ guid, name: 'Tusker Liberator', itemType: 0x10, objectDescFlags: 0x10, level: 60, ...o });
const texts = (api: AgentApi, since = 0): string[] => api.eventsSince(since).map((e) => `${e.type}: ${e.text}`);
const fellowship = (host: FakeHost): void => {
  host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 160, max: 166 }, stamina: { cur: 200, max: 214 }, mana: { cur: 300, max: 306 } }];
};

let host: FakeHost;
let api: AgentApi;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  host = new FakeHost();
  api = new AgentApi(host);
  host.me.combatMode = 'melee';
  host.me.health = { current: 192, max: 192 };
  host.attackPending = () => false;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('1. a death is said only on evidence tied to that guid', () => {
  const C3B3 = 0x8000c3b3, C320 = 0x8000c320;
  beforeEach(() => {
    host.add(LIB(C3B3, { x: 81, y: 21.5 }));
    host.add(LIB(C320, { x: 79, y: 22 }));
    run(api, host, 300, { physics: false });
  });

  it('a namesake\'s kill line before its Dead motion: the target fights on; its own Dead motion is its death', () => {
    const since = api.observe().seq;
    expect(api.attack(C3B3).ok).toBe(true);
    run(api, host, 2000, { physics: false });
    // ACE: OnDeath's line first, then Die's Dead motion a moment later (#c320's bleed, 15:56:39.868Z).
    api.pushChat('Tusker Liberator died!', 0);
    run(api, host, 200, { physics: false });
    expect(texts(api, since).filter((t) => /target-died|task-done/.test(t))).toEqual([]);
    expect(api.hasTask).toBe(true);
    host.dying.add(C320);
    run(api, host, 1000, { physics: false });
    expect(texts(api, since).filter((t) => /target-died|task-done/.test(t))).toEqual([]);
    // The observe the player read 3 s later: alive, the target, not dying.
    const ob = api.observe();
    expect(ob.nearby.find((o) => o.guid === C3B3)?.dying).toBeUndefined();
    expect(formatObservation(ob)).toMatch(/target: #8000c3b3 {2}Tusker Liberator/);
    // Its own death, when it comes.
    host.dying.add(C3B3);
    run(api, host, 200, { physics: false });
    expect(texts(api, since)).toContain('target-died: Tusker Liberator #8000c3b3 died');
    expect(texts(api, since)).toContain('task-done: attacking Tusker Liberator: Tusker Liberator #8000c3b3 is dead');
  });

  it('a kill line alone, no namesake anywhere: still no death while the client shows it alive', () => {
    host.objs.delete(C320);
    run(api, host, 100, { physics: false });
    const since = api.observe().seq;
    expect(api.attack(C3B3).ok).toBe(true);
    run(api, host, 1000, { physics: false });
    api.pushChat('The thunder of crushing Tusker Liberator is followed by the deafening silence of death!', 0);
    run(api, host, 2000, { physics: false });
    expect(texts(api, since).filter((t) => /target-died/.test(t))).toEqual([]);
    expect(api.hasTask).toBe(true);
  });

  it('its health read 0 as your selection is its death, before any Dead motion', () => {
    const since = api.observe().seq;
    expect(api.attack(C3B3).ok).toBe(true);
    run(api, host, 1000, { physics: false });
    host.targetHealth = (() => 0) as unknown as FakeHost["targetHealth"];
    run(api, host, 200, { physics: false });
    expect(texts(api, since)).toContain('target-died: Tusker Liberator #8000c3b3 died');
  });

  it('gone from the world right after a kill line naming it (a server that deletes outright): its death', () => {
    host.objs.delete(C320);
    run(api, host, 100, { physics: false });
    const since = api.observe().seq;
    expect(api.attack(C3B3).ok).toBe(true);
    run(api, host, 1000, { physics: false });
    api.pushChat('You killed Tusker Liberator!', 0);
    host.objs.delete(C3B3);
    run(api, host, 200, { physics: false });
    expect(texts(api, since)).toContain('target-died: Tusker Liberator #8000c3b3 died');
  });

  it('a repeat cast is not stopped by a namesake\'s kill line', async () => {
    host.me.combatMode = 'magic';
    host.target = C3B3;
    const p = api.cast('Flame Bolt I', C3B3, { repeat: true, untilHealth: 0 });
    let out: { message: string } | null = null;
    void p.then((r) => { out = r; });
    run(api, host, 1500, { physics: false });
    api.pushChat('Tusker Liberator died!', 0);
    for (let i = 0; i < 20; i++) { run(api, host, 100, { physics: false }); await Promise.resolve(); }
    expect(out).toBeNull();
    host.dying.add(C3B3);
    for (let i = 0; i < 40 && !out; i++) { run(api, host, 100, { physics: false }); await vi.advanceTimersByTimeAsync(0); }
    expect(out!.message).toMatch(/stopped: Tusker Liberator died/);
  });
});

describe('2. a run-up to a target the client lets go goes on to where it was', () => {
  const C7FA = 0x800007fa;
  let lib: AgentHostObject;
  beforeEach(() => {
    lib = host.add(LIB(C7FA, { x: 80, y: 50 }));
    run(api, host, 300, { physics: false });
  });

  it('let go, then dropped 25 s on: no target-lost; seen again on the way, it is attacked', async () => {
    const since = api.observe().seq;
    const r = api.attack(C7FA, { far: true });
    expect(r.message).toMatch(/^running up to Tusker Liberator \(#800007fa\)/);
    run(api, host, 1000);
    // Out of your cells' sight: let go (frozen at its last place), then dropped by the client.
    lib.lost = true;
    run(api, host, 1000);
    host.objs.delete(C7FA);
    run(api, host, 4000);
    expect(texts(api, since).filter((t) => /target-lost|target-died/.test(t))).toEqual([]);
    // It is there all along: in sight again (the server's CreateObject on coming into your cells' sight).
    const back = host.add(LIB(C7FA, { x: 80, y: 50 }));
    expect(back.lost).toBeUndefined();
    for (let t = 0; t < 30_000 && !host.sent.some((x) => x.startsWith('attack 800007fa')); t += 100) { run(api, host, 100); await Promise.resolve(); }
    expect(host.sent.some((x) => x.startsWith('attack 800007fa'))).toBe(true);
    expect(texts(api, since).filter((t) => /target-lost|target-died/.test(t))).toEqual([]);
  });

  it('not there at its last place: target-lost says it went out of sight on the run-up, not "fled"', async () => {
    const since = api.observe().seq;
    expect(api.attack(C7FA, { far: true }).ok).toBe(true);
    run(api, host, 1000);
    lib.lost = true;
    run(api, host, 500);
    host.objs.delete(C7FA);
    for (let t = 0; t < 40_000 && !texts(api, since).some((x) => x.startsWith('target-lost')); t += 100) { run(api, host, 100); await Promise.resolve(); }
    const lost = texts(api, since).filter((t) => t.startsWith('target-lost'));
    expect(lost).toEqual(['target-lost: Tusker Liberator #800007fa: no attack: it went out of your client\'s sight on the run-up, and it is not in sight at the spot where it was last seen (it moved on, or died out of sight)']);
    expect(Math.hypot(host.me.x - 80, host.me.y - 50)).toBeLessThan(3);
  });

  it('a fight\'s target let go and dropped (no run-up): target-lost says out of sight and where it was, never "fled"', () => {
    lib.x = 81; lib.y = 21;
    run(api, host, 200, { physics: false });
    const since = api.observe().seq;
    expect(api.attack(C7FA).message).toMatch(/^attacking Tusker Liberator/);
    run(api, host, 500, { physics: false });
    lib.lost = true;
    run(api, host, 500, { physics: false });
    host.objs.delete(C7FA);
    run(api, host, 4000, { physics: false });
    const lost = texts(api, since).filter((t) => t.startsWith('target-lost'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/^target-lost: Tusker Liberator #800007fa is out of your client's sight \(your client let it go: too far from you for the server to keep you updated\); last seen 1 m [NSEW]+ of you, \d+ s ago, not fled: ac_attack target=#800007fa goes to where it was$/);
  });

  it('a kill line by name while it is let go is not its death (the server says nothing of a creature you can\'t see)', () => {
    lib.x = 81; lib.y = 21;
    run(api, host, 200, { physics: false });
    const since = api.observe().seq;
    expect(api.attack(C7FA).ok).toBe(true);
    run(api, host, 500, { physics: false });
    lib.lost = true;
    run(api, host, 500, { physics: false });
    api.pushChat('Tusker Liberator died!', 0);
    host.objs.delete(C7FA);
    run(api, host, 4000, { physics: false });
    expect(texts(api, since).filter((t) => t.startsWith('target-died'))).toEqual([]);
    expect(texts(api, since).filter((t) => t.startsWith('target-lost'))).toHaveLength(1);
  });
});

describe('3. a target on a 1.7 m step-down beside you', () => {
  const UPPER = 0xa9b40150, LOWER = 0xa9b40151;
  const C260 = 0x8000c260;
  beforeEach(() => {
    host.me.cell = UPPER; host.me.x = 70; host.me.y = 20; host.me.z = 100;
    fellowship(host);
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 68.6, y: 21.4, z: 100 });
    // The doorway way to its room drops through the 1.7 m floor opening (cellPath: the opening's plane to the floor under it).
    host.routeTo = [{ x: 71, y: 21, z: 100, drop: 1.7, landing: 98.3 } as { x: number; y: number; z: number }];
  });

  it('1.7 m off and hitting you: attacked from where you stand (was: refused "drops 2 m")', () => {
    host.add(LIB(C260, { cell: LOWER, x: 70, y: 21.7, z: 98.3 }));
    run(api, host, 200, { physics: false });
    api.pushChat('Tusker Liberator grazes your upper arm for 6 points of bludgeoning damage!', 0x15);
    run(api, host, 100, { physics: false });
    const r = api.attack(C260);
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^attacking Tusker Liberator \(#8000c260\)/);
    run(api, host, 200, { physics: false });
    expect(host.sent.some((x) => x.startsWith('attack 8000c260'))).toBe(true);
  });

  it('1.7 m off with an open line (not hitting you yet): attacked from where you stand', () => {
    host.add(LIB(C260, { cell: LOWER, x: 70, y: 21.7, z: 98.3 }));
    host.lineOfFire = () => ({ dist: 2.4, blockedAt: null });
    run(api, host, 200, { physics: false });
    expect(api.attack(C260).message).toMatch(/^attacking Tusker Liberator \(#8000c260\)/);
  });

  it('out of reach down there: refused, with the drop as measured (1.7 m, not "2 m") and each height from you', () => {
    host.add(LIB(C260, { cell: LOWER, x: 76, y: 26, z: 98.3 }));
    run(api, host, 200, { physics: false });
    const r = api.attack(C260);
    expect(r.ok).toBe(false);
    expect(r.message).toBe('the run-up to Tusker Liberator #8000c260 (2 m down from you) has a one-way 1.7 m drop on the way, landing 2 m down from your floor, leaving Claude Arcanist (2 m from you) on this floor, so no attack was started. Let it come to you, tell them you\'re dropping and go together, or ac_attack target=#8000c260 far=true drop=true to go anyway');
  });

  it('within 4 m but a wall between and not hitting you: the drop note still holds', () => {
    host.add(LIB(C260, { cell: LOWER, x: 72.5, y: 22, z: 98.3 }));
    host.lineOfFire = () => ({ dist: 3.2, blockedAt: 1.1, blocker: 'a wall' });
    run(api, host, 200, { physics: false });
    expect(api.attack(C260).message).toMatch(/^the run-up to Tusker Liberator #8000c260 \(2 m down from you\) has a one-way 1\.7 m drop on the way/);
  });
});

describe('4. fellow-aggro and floors', () => {
  const ROOM = 0xa9b40150;
  const C35D = 0x8000c35d;
  beforeEach(() => {
    host.me.cell = ROOM; host.me.x = 80; host.me.y = 20; host.me.z = 0;
    host.me.name = 'Claude Bulwark';
    fellowship(host);
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 78, y: 18, z: 0 });
  });

  it('one on the 1.7 m step-down beside her, running at her: raised as on her (it hit her 11 times, 16:05:07–37Z)', () => {
    host.add(LIB(C35D, { cell: ROOM, x: 76.5, y: 17.5, z: -1.7, seeks: { guid: ARC, kind: 'move' } }));
    run(api, host, 300, { physics: false });
    const ev = texts(api).filter((t) => t.startsWith('fellow-aggro'));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatch(/^fellow-aggro: Tusker Liberator #8000c35d \(level 60\) is on your fellow Claude Arcanist \(running at them\); Claude Arcanist is 3 m SW of you/);
  });

  it('a fresh raise for one a storey under her, running at her from beneath: none (not reaching her), as your own aggro reads it', () => {
    host.add(LIB(C35D, { cell: ROOM, x: 77, y: 18, z: -6, seeks: { guid: ARC, kind: 'move' } }));
    run(api, host, 3000, { physics: false });
    expect(texts(api).filter((t) => t.startsWith('fellow-aggro'))).toEqual([]);
    // Your own: said as from another floor, no melee from there.
    const ob = formatObservation(api.observe());
    expect(ob).not.toMatch(/MONSTERS AT THEM/);
  });
});
