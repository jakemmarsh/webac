/**
 * Attack / walk fixes from the stream players' segment 07:14–08:16Z on 2026-10-17 (end-of-retail local ACE, Mountain Keep
 * 0x01D2; build e9b3ff28; reports stream/reports/{soldier-2026-10-17T08-15-18-119Z,mage-2026-10-17T08-15-29-604Z}-seg1.md;
 * transcripts stream/sessions/{soldier,mage}-2026-10-17-seg1.jsonl from 07:14:45Z; page traces soldier.log / mage.log):
 *   1. `ac_attack #80005cdb` answered (task-done) "Dread Mu-miyah is dead" while it went on hitting Bulwark: the wait after
 *      the attack handed him the previous attack's task-done (on #8000fef1, another Dread Mu-miyah, ended on its kill 3 s
 *      before; its fight ran 15.5 s, past the 15 s quick-answer rule). Kill lines name no id either.
 *   2. `ac_attack` at an already-dead target answered "is dead" and nothing more: it names who is on you.
 *   3. `walk_to … stay_with=… drop=true` refused the drop: the surface's walkTo dropped the drop option.
 *   4. A run-up at a Dread on the −6 ledge re-planned to Bulwark's own hall and stalled "stuck 4.4 m short … walls all
 *      round": a goal a storey away with no floor near its height is placed on the floor under it, the give-up plans
 *      the way to its floor once more, and says "on another floor". On the cell DAT both Dreads were reachable.
 *   5. A Dread at 5% 1 m away: "out of your client's sight (it let it go)" then target-lost; Arcanist had killed it and
 *      its corpse lay there. A corpse at its last spot is its death.
 *   6. walk_to a fellow arrived across floors: a player is reached on their floor whatever the range.
 *   7. A target-died "X is on you (16×) …" read late says when, and who is on you now.
 * Each drives the shipped AgentApi (fake host: tests/_harness/agentFake.ts); the DAT checks read the real cell DAT.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { cellStandPoint, findRoute, loadCellGraph, routeCutOff, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const ARC = 0x50000002;
const MU = (g: number, o: Record<string, unknown> = {}) => ({ guid: g, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, level: 60, ...o });

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void, physics = true): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100, { physics }); await Promise.resolve(); await Promise.resolve(); }
  return out;
}
const texts = (api: AgentApi, since: number): string[] => api.eventsSince(since).map((e) => `${e.type}: ${e.text}`);

let host: FakeHost;
let api: AgentApi;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  host = new FakeHost();
  api = new AgentApi(host);
  host.me.combatMode = 'melee';
  host.attackPending = () => false;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('1. no death reported before it happens', () => {
  const A = 0x8000fef1, B = 0x80005cdb;
  beforeEach(() => {
    host.add(MU(A, { x: 80, y: 21.5 }));
    host.add(MU(B, { x: 81, y: 21.5 }));
  });

  it('the wait after a new attack never hands over the last attack\'s task-done (a fight of 15.5 s, a same-named target)', async () => {
    expect(api.attack(A).ok).toBe(true);
    run(api, host, 15_500, { physics: false });
    host.dying.add(A);
    api.pushChat('Dread Mu-miyah died!', 0);
    run(api, host, 300, { physics: false });
    const all = texts(api, 0);
    expect(all).toContain('task-done: attacking Dread Mu-miyah: Dread Mu-miyah #8000fef1 is dead');
    // 3 s later, the attack on #5cdb; its wait (types incl. task-done) hears nothing of #fef1's end.
    run(api, host, 3000, { physics: false });
    // The player had the kill (target-died); the task-done after it came in the same tick.
    const seq = api.eventsSince(0).find((e) => e.type === 'target-died' && e.guid === A)!.seq;
    host.objs.delete(A);
    run(api, host, 100, { physics: false });
    expect(api.attack(B).ok).toBe(true);
    const w = api.waitFor({ types: ['task-done', 'target-died', 'target-lost'], sinceSeq: seq }, 2000);
    run(api, host, 2100, { physics: false });
    const evs = await w;
    expect(evs.map((e) => e.text)).toEqual([]);
    // Its own end is heard when it comes, naming its id.
    const w2 = api.waitFor({ types: ['task-done'] }, 5000);
    host.dying.add(B);
    run(api, host, 300, { physics: false });
    expect((await w2).map((e) => e.text)).toEqual(['attacking Dread Mu-miyah: Dread Mu-miyah #80005cdb is dead']);
  });

  it('a kill line for another of its name (seen starting to die) is not the target\'s death', () => {
    const since = api.observe().seq;
    expect(api.attack(B).ok).toBe(true);
    run(api, host, 1000, { physics: false });
    host.dying.add(A); // Arcanist's bolt killed #fef1
    run(api, host, 100, { physics: false });
    api.pushChat('Dread Mu-miyah died!', 0);
    run(api, host, 1000, { physics: false });
    expect(texts(api, since).filter((t) => /target-died|task-done/.test(t))).toEqual([]);
    expect(api.hasTask).toBe(true);
    // A kill line alone is never a shown creature's death (it names no id: ACE sends a namesake's before its Dead motion,
    // 2026-10-17 15:56:39Z); its own death start is, and its leaving the world right after the line (stream 16:07 test).
    api.pushChat('You killed Dread Mu-miyah!', 0);
    host.dying.delete(A);
    (api as unknown as { sawDying: Map<number, unknown> }).sawDying.clear();
    run(api, host, 200, { physics: false });
    expect(texts(api, since).filter((t) => /target-died/.test(t))).toEqual([]);
    host.dying.add(B);
    run(api, host, 200, { physics: false });
    expect(texts(api, since)).toContain('target-died: Dread Mu-miyah #80005cdb died');
  });

  it('a replaced task\'s "interrupted" still reaches the wait after the order that replaced it', async () => {
    void api.walkTo('120m north');
    run(api, host, 20_000);
    void api.walkTo('5m south');
    const evs = await api.waitFor({ types: ['task-done'], sinceSeq: 0 }, 1000);
    expect(evs.map((e) => e.text)).toEqual([expect.stringMatching(/^walking 120 m N: interrupted \(replaced by walking 5 m S\)/)]);
  });
});

describe('2. attack at a target already dead names who is on you', () => {
  const DEAD = 0x8000561c, ON = 0x80005586;
  beforeEach(() => {
    host.add(MU(DEAD, { x: 80, y: 21.5 }));
    host.add(MU(ON, { x: 79, y: 21 }));
    host.dying.add(DEAD);
    run(api, host, 300, { physics: false });
  });

  it('the one hitting you', () => {
    api.pushChat('Dread Mu-miyah grazes your foot for 1 point of bludgeoning damage!', 0x15);
    api.pushChat('You evaded Dread Mu-miyah!', 0x15);
    const r = api.attack(DEAD);
    expect(r).toMatchObject({ ok: false, targetGone: true });
    expect(r.message).toMatch(/^Dread Mu-miyah is dead \(loot its corpse, or pick another target\); Dread Mu-miyah #80005586 is on you \(2× in 10 s\), but you are not attacking it: ac_attack target=#80005586 to fight it$/);
  });

  it('else one coming at you on your floor', () => {
    host.objs.get(ON)!.seeks = { guid: host.me.guid, kind: 'move' };
    Object.assign(host.objs.get(ON)!, { x: 70, y: 20 });
    run(api, host, 300, { physics: false });
    expect(api.attack(DEAD).message).toMatch(/is dead \(loot its corpse, or pick another target\); Dread Mu-miyah #80005586 is coming at you \(running at you, 10 m W\): ac_attack target=#80005586 to fight it$/);
  });

  it('nothing on you: as before', () => {
    host.objs.delete(ON);
    expect(api.attack(DEAD).message).toBe('Dread Mu-miyah is dead (loot its corpse, or pick another target)');
  });
});

describe('3. walk_to drop=true reaches the walk (the surface\'s option list)', () => {
  const UPPER = 0xa9b40150;
  const world = (x: number, y: number): number[] => {
    if (x < 50 || x > 110 || y < 0 || y > 40) return [];
    return x >= 60 && x <= 80 ? [94, 100] : [94];
  };
  beforeEach(() => {
    host.me.cell = UPPER; host.me.x = 70; host.me.y = 20; host.me.z = 100;
    host.floors = world;
    host.me.health = { current: 200, max: 200 };
    host.me.combatMode = 'peace';
    host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 160, max: 166 }, stamina: { cur: 200, max: 214 }, mana: { cur: 300, max: 306 } }];
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 70, y: 21, z: 100 });
    host.add({ guid: 0x7f000003, name: 'Fountain', cell: UPPER, x: 92, y: 20, z: 94 });
  });
  const surface = (): { walkTo: (t: number | string, o: Record<string, unknown>) => Promise<{ ok: boolean; message: string }> } => api.surface() as never;
  const beside = (): void => { const a = host.objs.get(ARC)!; a.x = host.me.x; a.y = host.me.y + 1; a.z = host.me.z; };

  it('stay_with, the fellow beside you, drop=true: goes down (was the same "stay_with doesn\'t go down" refusal)', async () => {
    const r = await settle(api, host, surface().walkTo(0x7f000003, { within: 2, stayWith: 'Claude Arcanist', drop: true }), 40_000, beside);
    expect(host.launches.length).toBeGreaterThanOrEqual(1);
    expect(host.me.z).toBeCloseTo(94, 1);
    expect(r?.message ?? '').not.toMatch(/doesn't go down without them/);
  });

  it('without drop=true: stops at the edge as before', async () => {
    const r = await settle(api, host, surface().walkTo(0x7f000003, { within: 2, stayWith: 'Claude Arcanist' }), 40_000, beside);
    expect(r?.message).toMatch(/so stay_with doesn't go down without them/);
    expect(host.me.z).toBeCloseTo(100, 1);
  });
});

describe('4. a target a storey up whose named room is your own hall', () => {
  const HALL = 0x01d20128, LEDGE = 0x01d201fd;
  beforeEach(() => {
    host.me.cell = HALL; host.me.x = 85.5; host.me.y = -74.5; host.me.z = -12;
    host.cellSealed = () => true;
    // Under the Dread's spot: the −6 ledge and the −12 hall 0x0114 (the cell DAT's floors at (79.4, −78.4)).
    host.floorsAt = (_lb, x, y) => (Math.hypot(x - 79.4, y + 78.4) < 2 ? [{ cell: LEDGE, z: -6 }, { cell: 0x01d20114, z: -12 }] : [{ cell: HALL, z: -12 }]);
  });

  it('mid-step at the ledge (z −8.5, the server naming 0x0128): the route goes to the ledge\'s floor, not "same room"', () => {
    const asked: number[] = [];
    host.route = (_fc, _f, tc, to) => { asked.push(tc >>> 0); return [{ x: 90, y: -72, z: -12 }, { x: 105, y: -50, z: -6 }, to]; };
    host.add(MU(0x800033fd, { cell: HALL, x: 79.4, y: -78.4, z: -8.5 }));
    const r = api.attack(0x800033fd, { far: true });
    expect(r.ok, r.message).toBe(true);
    expect(asked).toContain(LEDGE);
    expect(asked).not.toContain(HALL);
  });

  it('no way to its floor found: the give-up says it is on another floor, not "walls all round"', async () => {
    host.route = () => null;
    // The fake body walks on one level: under the ledge, never onto it.
    host.add(MU(0x800033fd, { cell: LEDGE, x: 79.4, y: -78.4, z: -6 }));
    const r = await settle(api, host, api.walkTo(0x800033fd, { within: 2.5 }), 120_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^stuck [\d.]+ m short \(it is 6 m above you, on another floor, and no way up to that floor was found from here/);
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);
const LB = 0x01d20000;
const C = (n: number): number => (LB | n) >>> 0;
describe.skipIf(!haveDat)('4. the real Mountain Keep (0x01D2): the Dreads overhead were reachable on foot', () => {
  let g: CellGraph;
  beforeAll(() => { g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), LB); });

  it('#80001a58, 12 m over 0x01D2011F (the fountain room 0x02A6, z 0): the ramps climb to it, not cut off', () => {
    expect(cellStandPoint(g, C(0x11f))!.z).toBeCloseTo(-12, 0);
    const to = { x: 90, y: -60, z: 0 };
    expect(routeCutOff(g, C(0x11f), cellStandPoint(g, C(0x11f))!, C(0x2a6), to, { maxDrop: 12, jumpAcross: 7.5 })).toBeNull();
    const r = findRoute(g, C(0x11f), cellStandPoint(g, C(0x11f))!, C(0x2a6), to, [], { maxDrop: 12 })!;
    expect(r).not.toBeNull();
    expect(Math.max(...r.map((p) => p.feet ?? p.z))).toBeGreaterThan(-1);
    expect(r.some((p) => p.drop !== undefined)).toBe(false);
  });

  it('#800033fd on the −6 ledge 0x01FD over 0x0128: up the ramps to 0 and a 6 m drop back down to it', () => {
    const r = findRoute(g, C(0x128), { x: 85.5, y: -74.5, z: -12 }, C(0x1fd), { x: 79.4, y: -78.4, z: -6 }, [], { maxDrop: 12 })!;
    expect(r).not.toBeNull();
    expect(r.filter((p) => p.drop !== undefined).map((p) => Math.round(p.drop!))).toEqual([6]);
    // The route to 0x0128 itself (what the re-plan took) ends in that hall, under the ledge.
    expect(findRoute(g, C(0x11f), cellStandPoint(g, C(0x11f))!, C(0x128), { x: 79.4, y: -78.4, z: -12 }, [], { maxDrop: 12 })!.every((p) => (p.feet ?? p.z) < -10)).toBe(true);
  });
});

describe('5. a target the client let go that died out of its sight', () => {
  const T = 0x800033fe;
  beforeEach(() => {
    host.add(MU(T, { x: 79.5, y: 19.5 }));
    run(api, host, 600, { physics: false });
    // It hit you a moment ago (a recent foe), then the client let it go.
    api.pushChat('Dread Mu-miyah grazes your hand for 1 point of bludgeoning damage!', 0x15);
    run(api, host, 300, { physics: false });
    host.objs.get(T)!.lost = true;
    run(api, host, 6000, { physics: false });
  });

  it('its corpse at its last spot: "died out of your client\'s sight", not a walk to where it was', () => {
    host.add({ guid: 0x800055f3, name: 'Corpse of Dread Mu-miyah', itemType: 0x200, x: 79.4, y: 19.3 });
    run(api, host, 200, { physics: false });
    const r = api.attack(T);
    expect(r).toMatchObject({ ok: false, targetGone: true });
    expect(r.message).toMatch(/^Dread Mu-miyah #800033fe died out of your client's sight: its corpse is #800055f3, 1 m [NSEW]+, where it was last seen \(loot it, or pick another target\)/);
  });

  it('a corpse an old one (lying there before it was last seen): not its death', () => {
    host.add({ guid: 0x800055f3, name: 'Corpse of Dread Mu-miyah', itemType: 0x200, x: 79.4, y: 19.3 });
    (api as unknown as { corpseSeenAt: Map<number, number> }).corpseSeenAt.set(0x800055f3, -60_000);
    expect(api.attack(T).message).toMatch(/is out of your client's sight \(it let it go\)/);
  });

  it('no corpse yet: the walk to its spot, then the corpse the server makes there is target-died, not target-lost', async () => {
    const since = api.observe().seq;
    const r = api.attack(T);
    expect(r.message).toMatch(/is out of your client's sight \(it let it go\)/);
    for (let t = 0; t < 3000; t += 100) { run(api, host, 100, { physics: false }); await Promise.resolve(); }
    host.add({ guid: 0x800055f3, name: 'Corpse of Dread Mu-miyah', itemType: 0x200, x: 79.4, y: 19.3 });
    for (let t = 0; t < 1000; t += 100) { run(api, host, 100, { physics: false }); await Promise.resolve(); }
    const ends = texts(api, since).filter((x) => /^target-(died|lost)/.test(x));
    expect(ends).toEqual([expect.stringMatching(/^target-died: Dread Mu-miyah #800033fe died: its corpse #800055f3 lies where it was last seen/)]);
  });

  it('no corpse at all: target-lost as before', async () => {
    const since = api.observe().seq;
    api.attack(T);
    for (let t = 0; t < 8000; t += 100) { run(api, host, 100, { physics: false }); await Promise.resolve(); }
    expect(texts(api, since).filter((x) => /^target-(died|lost)/.test(x))).toEqual([expect.stringMatching(/^target-lost: Dread Mu-miyah #800033fe: no attack: it is not in sight at the spot where it was last seen/)]);
  });
});

describe('6. walk_to a fellow at range: reached on their floor', () => {
  const UPPER = 0xa9b40150;
  beforeEach(() => {
    host.me.cell = UPPER; host.me.x = 70; host.me.y = 20; host.me.z = 100;
    host.floors = (x, y) => (x < 50 || x > 110 || y < 0 || y > 40 ? [] : x >= 60 && x <= 80 ? [94, 100] : [94]);
    host.fellows = () => [{ guid: 0x500000a4, name: 'Claude Bulwark', health: { cur: 188, max: 188 }, stamina: { cur: 200, max: 290 }, mana: { cur: 55, max: 55 } }];
  });

  it('within=8 of Bulwark 6 m down, 3 m across: not "arrived" from the floor above, but beside him on his', async () => {
    host.add({ guid: 0x500000a4, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: UPPER, x: 73, y: 20, z: 94 });
    host.wall = (x) => x > 80.5 || x < 59.5;
    const r = await settle(api, host, api.walkTo(0x500000a4, { within: 8 }), 30_000);
    // Was "arrived" at once from the floor above (6.7 m straight); now only on his floor, down the drop.
    expect(r?.message).toMatch(/^arrived/);
    expect(host.me.z).toBeCloseTo(94, 1);
  });

  it('a monster at range is still the straight distance (stand 8 m off it, floors and all)', async () => {
    host.add(MU(0x80004761, { cell: UPPER, x: 73, y: 20, z: 94 }));
    const r = await settle(api, host, api.walkTo(0x80004761, { within: 8 }), 5000);
    expect(r?.message).toMatch(/^arrived/);
  });
});

describe('7. a target-died "X is on you" read late', () => {
  const A = 0x800033fa, B = 0x80005585, C2 = 0x80005586;
  beforeEach(() => {
    host.add(MU(A, { x: 80, y: 21.5 }));
    host.add(MU(B, { x: 79, y: 21 }));
  });

  it('says how long ago, and who is on you now', async () => {
    const since = api.observe().seq;
    expect(api.attack(A).ok).toBe(true);
    run(api, host, 1000, { physics: false });
    for (let i = 0; i < 16; i++) api.pushChat('You evaded Dread Mu-miyah!', 0x15);
    // The evades credited to the nearest live one of the name: #5585 (1 m) over #33fa (1.5 m).
    host.dying.add(A);
    run(api, host, 300, { physics: false });
    const raw = api.eventsSince(since).find((e) => e.type === 'target-died')!;
    expect(raw.text).toMatch(/is on you \(\d+× in 10 s\), but you are not attacking it/);
    // Read at once: as it came.
    expect((await api.waitFor({ types: ['target-died'], sinceSeq: since }, 10)).map((e) => e.text)).toEqual([raw.text]);
    // 12 s later #5585 is dead and gone, and #5586 is on you.
    host.objs.delete(B);
    host.add(MU(C2, { x: 79, y: 20 }));
    run(api, host, 12_000, { physics: false });
    api.pushChat('Dread Mu-miyah grazes your foot for 1 point of bludgeoning damage!', 0x15);
    const late = await api.waitFor({ types: ['target-died'], sinceSeq: since }, 10);
    expect(late[0].text).toMatch(/^Dread Mu-miyah #800033fa died; Dread Mu-miyah #80005585 was on you 1[23] s ago, when it died \(\d+× in 10 s then\); now Dread Mu-miyah #80005586 is on you \(1× in 10 s\), but you are not attacking it: ac_attack target=#80005586 to fight it$/);
    host.objs.delete(C2);
    run(api, host, 11_000, { physics: false });
    const later = await api.waitFor({ types: ['target-died'], sinceSeq: since }, 10);
    expect(later[0].text).toMatch(/was on you 2\d s ago, when it died \(\d+× in 10 s then\); nothing is on you now$/);
  });
});
