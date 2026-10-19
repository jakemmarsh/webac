/**
 * The 18:46–18:47Z stream reports (2026-10-19, end of retail, local ACE, build ffbc7308f; Claude Arcanist = mage,
 * Claude Bulwark = soldier; Stonehold, then Mountain Keep 0x01D2). Reports stream/reports/{soldier-2026-10-19T18-46-39-941Z,
 * mage-2026-10-19T18-47-30-115Z}-seg1.md; transcripts stream/sessions/{soldier,mage}-2026-10-19-seg1.jsonl; page logs
 * soldier.log / mage.log. Each block drives the shipped AgentApi / RoutineEngine over the fake host:
 *   1. walk_to a Dread walled off "arrived (2.0 m)": the arrival now says it can't be hit from here, bolt nor sword.
 *   2. attack on a Dread out of sight (seen 10 s before, not a foe): goes to where it was last seen first.
 *   3. use on the Pumpkin Buffer (a monster whose spells are all buffs): walks beside it, says what gives the buffs.
 *   4. a corpse of yours looted empty kept listing its items: observe's corpses line says what is still on it.
 *   5. the routine's Follow stood still once its leader left the client's range on the landscape: goes after them.
 *   6. walk_to stopped for Sufut Zefirs that had hit 14 times for 0: a kind seen hitting only for 0 doesn't stop it.
 *   7. (verify-stream-shops.ts) `sells "<item>" near <coords>`.
 *   8. a self-cast surpassed by a stronger one on you: retail spends the mana (ACE DoCastSpell_Inner); the reply says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, parseMapCoords } from '../packages/renderer/src/agent/AgentApi.ts';
import { FOLLOW_LANDSCAPE_ON_M } from '../packages/renderer/src/agent/RoutineEngine.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { ALL_MODULES_OFF, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';

const DREAD = 0x80004c7b;
const ME = 0x50000001;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

let host: FakeHost;
let api: AgentApi;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  host = new FakeHost();
  api = new AgentApi(host);
});
afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

const dread = (): void => { host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40, level: 60 }); run(api, host, 300, { physics: false }); };

describe('1. walk_to a monster behind a wall: the arrival says it can\'t be hit from here', () => {
  it('a wall all the way: "arrived …, but it can\'t be hit from here", the bolt\'s line and a sword\'s reach both said', async () => {
    host.me.level = 51;
    dread();
    host.lineOfFire = () => ({ dist: Math.hypot(host.me.x - 80, host.me.y - 40), blockedAt: 1.2, blocker: 'a wall' });
    const r = await settle(api, host, api.walkTo(DREAD, { within: 3, stopOnAggro: false, avoidMonsters: false }), 20_000);
    expect(r?.ok).toBe(true);
    expect(r?.message).toMatch(/^arrived \(\d\.\d m from [^)]+\), but it can't be hit from here; no open line to it from here \(a wall 1\.2 m along the line would take a bolt or arrow\)/);
    expect(r?.message).toMatch(/; nor a sword from here \(the server swings at once only within 0\.6 m, or 4 m with nothing between; past that it walks you to it, and a wall it can't go round ends the attack\)/);
    expect(r?.message).toMatch(/\(walk_to … line=true keeps going until the line is open\)/);
  });

  it('an open line: a plain "arrived", nothing of a sword', async () => {
    dread();
    host.lineOfFire = () => ({ dist: Math.hypot(host.me.x - 80, host.me.y - 40), blockedAt: null });
    const r = await settle(api, host, api.walkTo(DREAD, { within: 3, stopOnAggro: false, avoidMonsters: false }), 20_000);
    expect(r?.message).toMatch(/^arrived \(\d\.\d m from [^)]+\)/);
    expect(r?.message).not.toMatch(/can't be hit|sword/);
  });

  it('not a monster (a chest behind a wall): no word of hitting it', async () => {
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 80, y: 40 });
    host.lineOfFire = () => ({ dist: 1, blockedAt: 0.5, blocker: 'a wall' });
    const r = await settle(api, host, api.walkTo(0x80000042, { within: 3, stopOnAggro: false, avoidMonsters: false }), 20_000);
    expect(r?.message).not.toMatch(/can't be hit|sword/);
  });
});

describe('2. attack on a monster out of sight: to where it was last seen first', () => {
  it('seen 10 s ago, not a foe: going to its last spot, then attacking it once in sight (Bulwark 18:20:35Z)', () => {
    dread();
    host.object(DREAD)!.lost = true;
    run(api, host, 10_000, { physics: false });
    const r = api.attack(DREAD, { far: true });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^Dread Mu-miyah #80004c7b is out of your client's sight \(it let it go\): going to where it was last seen \(20 m N of you, \d+ s ago\), then attacking it once it is in sight/);
    expect(r.message).not.toMatch(/it attacked/);
  });

  it('never seen in sight: refused with why, as before', () => {
    host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40, level: 60, lost: true });
    const r = api.attack(DREAD, { far: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/is out of sight: your client let it go/);
  });

  it('seen over a minute ago: too stale to go after, refused', () => {
    dread();
    host.object(DREAD)!.lost = true;
    run(api, host, 61_000, { physics: false });
    const r = api.attack(DREAD, { far: true });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/is out of sight/);
  });
});

describe('3. use on the Pumpkin Buffer: beside it, and what gives its buffs', () => {
  const PB = 0x80003d39;
  const buffer = (): void => {
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: new Map([[4324, { name: 'Incantation of Strength Other', desc: '', category: 1, school: 4, bitfield: 0x4, power: 400 }]]) });
    host.add({ guid: PB, name: 'Pumpkin Buffer', itemType: 0x10, objectDescFlags: 0x10, cell: HOLTBURG, x: 80, y: 40, z: 94, useability: 1 });
  };

  it('seen buffing you: walks beside it, sends no Use, and says to wait there (both players, 17:53Z)', async () => {
    buffer();
    api.pushChat('Pumpkin Buffer cast Incantation of Strength Other on you', 0x11);
    expect(api.harmlessKind('Pumpkin Buffer')).toBe(true);
    const r = await settle(api, host, api.use('Pumpkin Buffer'), 30_000);
    expect(r?.ok).toBe(true);
    expect(r?.message).toMatch(/^beside Pumpkin Buffer #80003d39 \(\d\.\d m\); no Use was sent: the server marks it unusable \(a creature with no use, as in retail\)\. It is a buffer: a monster whose spells are all buffs \(casts Incantation of Strength Other\)/);
    expect(r?.message).toMatch(/Stay here in its sight and wait for them \(ac_wait\)/);
    expect(Math.hypot(host.me.x - 80, host.me.y - 40)).toBeLessThanOrEqual(3.5);
    expect(host.sent.filter((s) => s.startsWith('use '))).toEqual([]);
  });

  it('never seen buffing: refused at once, naming what a buffer does', async () => {
    buffer();
    const r = await settle(api, host, api.use('Pumpkin Buffer'), 20_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/can't be used: the server marks it unusable/);
    expect(r?.message).toMatch(/gives them by standing near it in its sight/);
    expect(Math.hypot(host.me.x - 80, host.me.y - 20)).toBeLessThan(0.5);
  });
});

describe('4. a corpse of yours you looted: what is still on it', () => {
  const CORPSE = 0x8000d336;
  const items = [{ guid: 0x80000b01, name: 'Mana Stone' }, { guid: 0x80000b02, name: 'Platemail Leggings' }, { guid: 0x80000b03, name: 'Ring' }];
  const corpse = (take: number): void => {
    host.me.name = 'Claude Arcanist';
    host.add({ guid: CORPSE, name: 'Corpse of Claude Arcanist', objectDescFlags: 0x2000, x: 81, y: 21 });
    const a = api as unknown as { myCorpses: Array<Record<string, unknown>>; wallNow(): number };
    a.myCorpses.push({ wall: a.wallNow() - 60_000, cell: host.me.cell, place: 'Stonehold', coords: '68.4N, 21.0W', killer: 'Gold Golem', items: ['Ring', 'Platemail Leggings', 'Mana Stone'], worn: ['Ring', 'Platemail Leggings'], rotMs: 3_600_000 * 4, guid: CORPSE });
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); if (g === CORPSE) host.container = { guid: CORPSE, items: [...items] }; return true; };
    let n = 0;
    host.pickUp = (g: number) => {
      host.sent.push(`pickup ${g.toString(16)}`);
      const it = host.container?.items.find((i) => i.guid === g);
      if (it && n++ < take) { host.inv.push({ guid: g, name: it.name, where: 'main pack' }); host.container = { guid: CORPSE, items: host.container!.items.filter((i) => i.guid !== g) }; }
      return true;
    };
  };

  it('all three taken: "nothing left on it", not the death\'s list (Arcanist 17:48:51Z)', async () => {
    corpse(3);
    const p = api.loot(CORPSE, null);
    run(api, host, 15_000);
    const r = await p;
    expect(r.message).toMatch(/^took 3/);
    const line = api.corpsesLine()!;
    expect(line).toMatch(/nothing left on it \(you took .*Mana Stone.* \d+ min ago\); nothing to fetch/);
    expect(line).not.toMatch(/worn when you died: Ring/);
    expect(api.corpsesLine(true)).toMatch(/\(opened \d+ min ago, 0 of 3 items left\)/);
    // Gone from view once empty (ACE: an empty corpse rots in 15 s): said as your own loot, not "looted empty, or rotted".
    host.objs.delete(CORPSE);
    run(api, host, 1000, { physics: false });
    expect(api.corpsesLine()).toMatch(/GONE \d+ min ago \(you looted it empty: an empty corpse rots in 15 s\)/);
  });

  it('one taken (the rest not tried in time or refused): what is left is listed, with the count', async () => {
    corpse(1);
    const p = api.loot(CORPSE, null, undefined, { itemTries: 1 });
    run(api, host, 30_000);
    const r = await p;
    const line = api.corpsesLine()!;
    expect(r.message, line).toMatch(/^took 1: Mana Stone/);
    expect(line).toMatch(/you opened it \d+ min ago and took Mana Stone, 2 items left on it/);
    expect(line).toMatch(/: (Ring, Platemail Leggings|Platemail Leggings, Ring|.*Ring.*Platemail Leggings.*) \(worn when you died/);
    expect(line).not.toMatch(/Mana Stone \(/);
  });
});

describe('5. the routine\'s Follow: a leader who left the client\'s range on the landscape is gone after', () => {
  const LEAD = 0x500000a4;
  const followProfile = (): RoutineProfile => ({
    name: 'Arcanist fights', modules: { ...ALL_MODULES_OFF, navigation: true }, initialState: 'Hunt', loot: [], buffSets: [],
    macro: true, settings: { EnableCombat: false, EnableNav: true, NavCloseStopRange: 8 }, navRoute: 'F',
    routes: [{ name: 'F', mode: 'follow', points: [], follow: 'Claude Bulwark' }], states: [{ name: 'Hunt', rules: [] }],
  } as RoutineProfile);
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  const spyWalks = () => {
    const calls: Array<number | string> = [];
    const walk = api.walkTo.bind(api);
    api.walkTo = (t, o = {}) => { calls.push(t as number | string); return walk(t, o); };
    return calls;
  };
  const G = (x: number, y: number) => ({ x: ((HOLTBURG >>> 24) & 0xff) * 192 + x, y: ((HOLTBURG >>> 16) & 0xff) * 192 + y });

  it('out of range 120 m off, running north: to their last spot, then on the way they went (Arcanist 18:02:56Z)', async () => {
    const lead = host.add({ guid: LEAD, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 30 });
    const calls = spyWalks();
    const reports: string[] = [];
    api.routine.onReport = (r) => reports.push(r);
    api.routine.start(followProfile());
    await step(500);
    // He runs north far faster than the fake body: 120 m off, then out of the client's range.
    host.wall = (x: number, y: number) => y > host.me.y + 0.01 && y > 25 ? true : false; // you stand still while he runs
    for (let y = 40; y <= 140; y += 10) { lead.y = y; await step(300); }
    host.objs.delete(LEAD);
    host.wall = null;
    await step(1500);
    expect(api.routine.history().some((l) => /Follow: Claude Bulwark went out of your client's range .*going after them to where they were last seen, 1[12]\d m N .*then on 60 m the way they were heading/.test(l)), api.routine.history().join('\n')).toBe(true);
    expect(reports.some((r) => /standing still/.test(r))).toBe(false);
    const coords = calls.filter((c): c is string => typeof c === 'string').map((c) => parseMapCoords(c)!).filter(Boolean);
    const last = G(80, 140);
    expect(coords.some((c) => Math.hypot(c.x - last.x, c.y - last.y) < 2), JSON.stringify(calls)).toBe(true);
    expect(FOLLOW_LANDSCAPE_ON_M).toBe(60);
  });

  it('gone from beside you (a portal, a recall, a logout): standing still, as before', async () => {
    host.add({ guid: LEAD, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 30 });
    const reports: string[] = [];
    api.routine.onReport = (r) => reports.push(r);
    api.routine.start(followProfile());
    await step(800);
    host.objs.delete(LEAD);
    await step(800);
    expect(reports).toContain('Follow: Claude Bulwark is out of sight; standing still');
  });

  it('plain follow\'s lost-fellow spot: on the landscape a fresh, far-off last place counts; one beside you or stale doesn\'t', () => {
    host.fellows = () => [{ guid: LEAD, name: 'Claude Bulwark', health: { cur: 180, max: 182 }, stamina: { cur: 200, max: 243 }, mana: { cur: 50, max: 52 } }];
    const spot = (api as unknown as { lostFellowSpot(g: number, p: { cell: number; x: number; y: number; z: number; heardAt?: number }): unknown }).lostFellowSpot.bind(api);
    expect(spot(LEAD, { cell: HOLTBURG, x: 80, y: 170, z: 94, heardAt: host.now() - 5000 })).toMatchObject({ name: 'Claude Bulwark', agoS: 5 });
    expect(spot(LEAD, { cell: HOLTBURG, x: 80, y: 30, z: 94, heardAt: host.now() - 5000 })).toBeNull();
    host.t += 120_000;
    expect(spot(LEAD, { cell: HOLTBURG, x: 80, y: 170, z: 94, heardAt: host.now() - 70_000 })).toBeNull();
  });
});

describe('6. a kind seen hitting you only for 0 doesn\'t stop a walk', () => {
  const zefir = (n: number): void => { for (let i = 0; i < n; i++) api.pushChat('Sufut Zefir hits your chest for 0 points of bludgeoning damage!', 0x15); };

  it('three blows for 0 or more: zeroDamageKind; fewer, one that hurt, or one far above you: not', () => {
    host.me.level = 54; host.me.health = { current: 186, max: 186 };
    zefir(2);
    expect(api.zeroDamageKind({ guid: 1, name: 'Sufut Zefir', level: 50 })).toBe(false);
    zefir(12);
    expect(api.zeroDamageKind({ guid: 1, name: 'Sufut Zefir', level: 50 })).toBe(true);
    expect(api.zeroDamageKind({ guid: 2, name: 'Sufut Zefir' })).toBe(true); // level not known yet (18:06:58Z)
    expect(api.zeroDamageKind({ guid: 3, name: 'Sufut Zefir', level: 80 })).toBe(false);
    api.pushChat('Sufut Zefir hits your chest for 5 points of bludgeoning damage!', 0x15);
    expect(api.zeroDamageKind({ guid: 1, name: 'Sufut Zefir', level: 50 })).toBe(false);
    // The same count reaches the kind's seen text and the nick rule: hit for 0 is not "never seen hitting".
    expect(api.seenText('Sufut Zefir')).toMatch(/hits up to 5/);
  });

  it('a Zefir L50 (you L54) coming at you, its kind seen hitting 14 times for 0: walked on past (18:05:56Z)', async () => {
    host.me.level = 54; host.me.health = { current: 186, max: 186 };
    zefir(14);
    expect(api.seenText('Sufut Zefir')).toBe('hit you 14 times, for 0 each');
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 20, y: 20 });
    host.add({ guid: 0x80004300, name: 'Sufut Zefir', itemType: 0x10, objectDescFlags: 0x10, x: 100, y: 20, level: 50, seeks: { guid: ME, kind: 'move' } });
    const chase = (): void => { const o = host.objs.get(0x80004300)!; const dx = host.me.x - o.x, dy = host.me.y - o.y, d = Math.hypot(dx, dy); if (d > 3) { o.x += (dx / d) * 0.3; o.y += (dy / d) * 0.3; } };
    const r = await settle(api, host, (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('Chest', {}), 40_000, chase);
    expect(r?.message).toMatch(/^arrived/);
  });

  it('…the same Zefir with nothing seen of its kind still stops the walk, as before', async () => {
    host.me.level = 54; host.me.health = { current: 186, max: 186 };
    host.add({ guid: 0x80000042, name: 'Chest', itemType: 0x200, x: 20, y: 20 });
    host.add({ guid: 0x80004300, name: 'Sufut Zefir', itemType: 0x10, objectDescFlags: 0x10, x: 100, y: 20, level: 50, seeks: { guid: ME, kind: 'move' } });
    const chase = (): void => { const o = host.objs.get(0x80004300)!; const dx = host.me.x - o.x, dy = host.me.y - o.y, d = Math.hypot(dx, dy); if (d > 3) { o.x += (dx / d) * 0.3; o.y += (dy / d) * 0.3; } };
    const r = await settle(api, host, (api.surface() as { walkTo: (t: string, o?: object) => Promise<AgentResult> }).walkTo('Chest', {}), 15_000, chase);
    expect(r?.message).toMatch(/^stopped [\d.]+ m short: Sufut Zefir #80004300 \(level 50\) is coming at you/);
  });
});

describe('8. a self-cast surpassed by a stronger one on you: the mana was spent (retail), said so', () => {
  it('the cast reply says the stronger one stays and the mana was spent', () => {
    const note = (api as unknown as { surpassedNote(s: string, t: string, by: string, onYou: boolean): string }).surpassedNote.bind(api);
    host.buffs = [{ name: 'Incantation of Acid Protection Self', remaining: 4000, beneficial: true }];
    expect(note('Acid Protection Self VI', 'you', 'Incantation of Acid Protection Self', true)).toMatch(/^surpassed: you already have Incantation of Acid Protection Self \(66m40s left\), the stronger, which stays in effect; the cast still cost its mana \(the server spends it as the spell goes off, before it finds the stronger one: as in retail\)\. Acid Protection Self VI is kept under it and takes over when it wears off, so casting it again before then spends mana for nothing$/);
    expect(note('Strength Other V', 'Claude Bulwark', 'Incantation of Strength Other', false)).toMatch(/the cast still cost its mana/);
  });
});
