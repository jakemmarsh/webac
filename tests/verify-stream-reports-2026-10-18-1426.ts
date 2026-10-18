/**
 * Stream reports, 2026-10-18 13:25–14:27Z (build 6c3b2188): Claude Arcanist (mage) and Claude Bulwark (soldier) in
 * Aerbax Laboratory 0x029E / Aerbax Haven 0x029F. Reports stream/reports/{mage-2026-10-18T14-26-56-864Z,
 * soldier-2026-10-18T14-26-41-500Z}-seg1.md; page traces mage.log / soldier.log; transcripts *-2026-10-18-seg1.jsonl.
 *
 * 1. "The routine pulls me away from Bulwark ... chasing a bolt line": no routine step moved him for a line. The hour
 *    has no "closing in on" line and the routine log only turns and bolts. What happened is that his routine bolted a
 *    mild Dark Marionette chasing Bulwark from where he stood while Bulwark walked on. soldier.log 14:17:27Z and 14:17:31Z
 *    say "Claude Arcanist is casting; waiting on" at 16–17 m, then he was 28 m back ("Where you off to?"). It followed only
 *    between bolts. Now the macro has FollowLeash (beyond VTank; 7 m in mage.json): a Follow leader past Follow distance +
 *    leash is followed before buffs and fights, unless something is hitting you. A caster's close-in for range or a line
 *    (AgentApi.castAttack, the only line-of-fire move a routine or `attack` makes) keeps to the fellow leash, and to the
 *    Follow leash for a routine.
 * 2. stay_with stopped waiting at a single nick: "didn't stop to wait ... you were being hit" five times (13:36:02Z,
 *    13:44:01Z, 14:03:49Z, ...), each a mild chaser (a Pristine Doll's hit for 0, Marionettes). With a routine covering the
 *    walk, only real danger now walks on without the fellow: a pack, a caster whose spells hurt, a heavy hitter, or health
 *    under 60%.
 * 3. A hand Heal Other got "You're too busy!". The routine's own Heal Other went out at 14:21:43.28Z and its UseDone came
 *    at 47.74Z. The hand cast waited out the old 4 s busy cap and was sent at 47.32Z. A cast or use now waits up to 10 s
 *    for one already under way.
 * 4. `walk_to "Surface"` took the remembered Surface #7029e033 (484 m, across a one-way drop) over Surface #7029e005 (206
 *    m, on his side). reachableNamesake weighed only namesakes in view. Remembered places count now, and the answer says
 *    which one was taken.
 * 5. The rare's corpse #8000b356, out of sight 57 m back, was refused by loot and walk_to by id. Both now go to where it
 *    lies, and loot takes it once it is in view.
 * 6. Kit timing: the routine's 55% kit went out 0.75 s after the 61-point hit (AttackDone 14:21:41.72Z) and failed its
 *    roll (44.12Z: "You fail to heal yourself"). It was retried and healed 100 at 47.17Z. The hand kit, sent at 46.9Z, was
 *    "too busy" against that retry, and the retry's heal line was read as the hand kit's. The use now waits (item 3).
 * 7. Checked, no fault: max health 183 was Frailty Other III, which observe names (soldier 13:53:16Z). The wall-stuck
 *    Marionettes are the held-chaser flag's case (AIMED AT YOU BUT NOT REACHING YOU).
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { ALL_MODULES_OFF, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import type { MonsterTableRow } from '../packages/renderer/src/agent/macro/combatPlan.ts';
import EOL from '../packages/renderer/src/agent/macro/monsters/eol.ts';
import { routineFromFile } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const REPO = resolve(__dirname, '..');
const ready = (profile: 'mage' | 'soldier'): RoutineProfile => {
  const r = routineFromFile(join(REPO, 'tools', 'stream', 'routines', `${profile}.json`));
  if ('text' in r) throw new Error(r.text);
  return r.profile;
};
const step = async (api: AgentApi, host: FakeHost, ms: number, each?: () => void): Promise<void> => {
  for (let t = 0; t < ms; t += 100) { each?.(); run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
};
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: (t: number) => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(t); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}
type Surface = { walkTo: (t: string | number, o?: object) => Promise<AgentResult>; cast: (s: string | number, t: unknown) => Promise<AgentResult>; useOn: (i: unknown, t: unknown) => Promise<AgentResult>; loot: (t: unknown) => Promise<AgentResult> };
const surface = (api: AgentApi): Surface => api.surface() as unknown as Surface;

type Table = { spells: Map<number, { name: string; category: number; school: number; bitfield: number; power: number; duration?: number; nonComponentTargetType?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };

const ARC = 0x500000a3, BUL = 0x500000a4;

describe.skipIf(!existsSync(DAT_PATHS.portal))('1. Arcanist keeps within the leash of Bulwark (FollowLeash; the real spell table and mage.json)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!)) as unknown as Table;
  });
  let host: FakeHost;
  let api: AgentApi;
  const MARIONETTE = 0x8000b40a;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, guid: ARC, name: 'Claude Arcanist', level: 52, combatMode: 'magic', health: { current: 184, max: 184 }, mana: { current: 330, max: 330 }, stamina: { current: 250, max: 250 } };
    const ids = ['Flame Bolt V'].map(id);
    host.spells = () => ids.map((k) => { const s = table.spells.get(k)!; return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 5, category: s.category, power: s.power, duration: s.duration ?? 0 }; });
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 34, name: 'War Magic', training: 'specialized', base: 260, buffed: 260 }, { id: 33, name: 'Life Magic', training: 'specialized', base: 256, buffed: 256 }];
    (host as unknown as { monsterTable: () => Promise<MonsterTableRow[]> }).monsterTable = async () => JSON.parse(EOL) as MonsterTableRow[];
    host.inv = [{ guid: 0x50000093, name: 'Fire Wand', where: 'equipped', type: 'Caster', slot: 'Held', itemType: 0x8000 }] as never;
    host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 193, max: 193 }, stamina: { cur: 200, max: 278 }, mana: { cur: 103, max: 103 } }];
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
  /**
   * 14:17:23–37Z: Bulwark sets off north from beside Arcanist (6 m) at a walk, 3 m/s, with a mild Dark Marionette on him
   * the whole way, and stops 40 m on. Each bolt's distance to him when it goes out.
   */
  const walkOff = async (ms: number): Promise<number[]> => {
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 26 });
    host.add({ guid: MARIONETTE, name: 'Dark Marionette', itemType: 0x10, objectDescFlags: 0x10, level: 35, x: 81.5, y: 27.5, seeks: { guid: BUL, kind: 'stick' } });
    const at: number[] = [];
    const send = host.cast;
    host.cast = (sid, t) => { at.push(Math.hypot(host.me.x - 80, host.me.y - host.objs.get(BUL)!.y)); return send(sid, t); };
    await step(api, host, ms, () => {
      const b = host.objs.get(BUL)!, m = host.objs.get(MARIONETTE)!;
      if (host.t >= 3000 && b.y < 66) b.y += 0.3;
      m.y = b.y + 1.5;
    });
    return at;
  };

  it('Bulwark walks on 40 m with a Marionette on him: every bolt goes out within the 15 m leash, the Follow first past it', async () => {
    api.routine.start(ready('mage'));
    const at = await walkOff(30_000);
    const hist = api.routine.history().join('\n');
    expect(at.length, `${host.sent.join('\n')}\n${hist}`).toBeGreaterThan(2);
    expect(Math.max(...at), `${at.map((d) => d.toFixed(1)).join(', ')}\n${hist}`).toBeLessThanOrEqual(15.5);
    expect(hist).toMatch(/Follow: Claude Bulwark is \d+ m off, past the 15 m leash \(Follow distance 8 m \+ FollowLeash 7 m\): following before buffing or fighting \(unless something is hitting you\)/);
    // And he ends beside Bulwark, not 28 m back.
    expect(Math.hypot(host.me.x - 80, host.me.y - host.objs.get(BUL)!.y)).toBeLessThanOrEqual(15.5);
  });

  it('VTank\'s order (FollowLeash 0), as live: bolts go out with Bulwark well past the leash', async () => {
    const p = ready('mage');
    api.routine.start({ ...p, settings: { ...p.settings, FollowLeash: 0 } });
    const at = await walkOff(30_000);
    expect(Math.max(...at), at.map((d) => d.toFixed(1)).join(', ')).toBeGreaterThan(17);
  });

  it('something hitting you is fought where you stand, the leader past the leash or not', async () => {
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 45 });
    const MINE = 0x8000b428;
    host.add({ guid: MINE, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, level: 26, x: 81, y: 21, seeks: { guid: ARC, kind: 'stick' } });
    api.routine.start(ready('mage'));
    const from = { x: host.me.x, y: host.me.y };
    await step(api, host, 5000, () => { if (host.t % 1000 === 0) api.pushChat('Marionette grazes your foot for 1 point of bludgeoning damage!', 0x15); });
    expect(host.sent.some((x) => x === `cast ${id('Flame Bolt V')} ${MINE.toString(16)}`), host.sent.join('\n')).toBe(true);
    expect(Math.hypot(host.me.x - from.x, host.me.y - from.y)).toBeLessThan(3);
  });

  describe('a caster\'s close-in for a line (castAttack: ac_attack, a rules routine\'s attack) keeps to the leash', () => {
    const DOLL = 0x8000abe2;
    beforeEach(() => {
      host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 18 });
      // An Innocent Doll 39 m west behind a wall (13:31:04Z): no line from here, an open one from 25 m.
      host.add({ guid: DOLL, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, level: 50, x: 41, y: 20 });
      host.lineOfFire = (g) => (g === DOLL ? { dist: Math.hypot(host.me.x - 41, host.me.y - 20), blockedAt: host.me.x > 66 ? 6.5 : null, blocker: 'a wall' } : null);
    });
    const lostText = (): string => api.eventsSince(0).filter((e) => e.type === 'target-lost').map((e) => e.text).join('\n');

    it('by hand: no run-up that leaves Bulwark 37 m behind; the target-lost says the leash and far=true', async () => {
      const r = api.attack(DOLL);
      expect(r.ok, r.message).toBe(true);
      await step(api, host, 3000);
      expect(lostText()).toMatch(/no cast from here \(a wall 6\.5 m along the line would take the bolt\), and closing in on it is barred: Innocent Doll #8000abe2 is 39 m W: running up to it leaves Claude Bulwark \(2 m from you now\) 39 m behind, so it was not closed in on \(the fellow leash/);
      expect(Math.hypot(host.me.x - 80, host.me.y - 20)).toBeLessThan(1);
    });

    it('far=true closes in anyway, to the open line', async () => {
      api.attack(DOLL, { far: true });
      await step(api, host, 8000);
      expect(api.eventsSince(0).some((e) => e.type === 'chat' && /closing in on Innocent Doll/.test(e.text))).toBe(true);
      expect(host.me.x).toBeLessThan(67);
    });

    it('a routine\'s attack (far=true) with its Follow leash stops the close-in there', async () => {
      host.lineOfFire = (g) => (g === DOLL ? { dist: Math.hypot(host.me.x - 41, host.me.y - 20), blockedAt: 6.5, blocker: 'a wall' } : null);
      api.attack(DOLL, { far: true, stayNear: { name: 'Claude Bulwark', within: 15 } });
      await step(api, host, 10_000);
      expect(lostText()).toMatch(/Claude Bulwark is 1\d m off now, past your routine's Follow leash \(15 m\)/);
      expect(Math.hypot(host.me.x - 80, host.me.y - 18)).toBeLessThan(19);
    });
  });
});


describe('2. stay_with with your routine covering the walk waits through a mild chaser\'s nicks', () => {
  let host: FakeHost;
  let api: AgentApi;
  let lines: string[];
  const hunt = (): RoutineProfile => ({
    name: 'Bulwark fights', modules: { ...ALL_MODULES_OFF, combat: true },
    initialState: 'Hunt', loot: [], buffSets: [], routes: [],
    states: [{ name: 'Hunt', rules: [{ label: 'Fight', when: [{ kind: 'monster-within', meters: 40 }], do: [{ kind: 'attack-nearest', meters: 40 }] }] }],
  });
  const MAR = 0x8000aab3;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.me = { ...host.me, guid: BUL, name: 'Claude Bulwark', level: 49, health: { current: 193, max: 193 }, stamina: { current: 250, max: 278 } };
    host.wall = () => false;
    host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 184, max: 184 }, stamina: { cur: 250, max: 250 }, mana: { cur: 330, max: 330 } }];
    // Arcanist 20 m behind (east of a walk going west), standing: she comes along once 3 s have passed.
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 100, y: 20 });
    api = new AgentApi(host);
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { lines.push(String(m)); });
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
  /** A Marionette L26 at your heels, nicking you for 1 every 2 s; Arcanist coming after 3 s, at a run. */
  const nicks = (dmg = 1) => (t: number): void => {
    const m = host.objs.get(MAR);
    if (m) { m.x = host.me.x + 1; m.y = host.me.y; }
    if (t > 0 && t % 2000 === 0) { host.me.health = { ...host.me.health, current: Math.max(1, host.me.health.current - dmg) }; api.pushChat(`Marionette grazes your foot for ${dmg} point${dmg === 1 ? '' : 's'} of bludgeoning damage!`, 0x15); }
    const a = host.objs.get(ARC)!;
    if (t >= 3000) { const dx = host.me.x - a.x, dy = host.me.y - a.y, d = Math.hypot(dx, dy); if (d > 2) { a.x += (dx / d) * 0.45; a.y += (dy / d) * 0.45; } }
  };
  const marionette = (): void => { host.add({ guid: MAR, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, level: 26, x: 81, y: 20, seeks: { guid: BUL, kind: 'stick' } }); };

  it('routine running: the walk waits for Arcanist through the nicks, and says it did', async () => {
    api.routine.start(hunt());
    marionette();
    run(api, host, 300, { physics: false });
    const r = (await settle(api, host, surface(api).walkTo('40m west', { stayWith: 'Claude Arcanist' }), 40_000, nicks()))!;
    const trace = lines.join('\n');
    expect(trace, trace).toMatch(/walk: waiting for Claude Arcanist, \d+ m behind/);
    expect(trace).not.toMatch(/under attack while waiting for Claude Arcanist/);
    expect(r.message, r.message).not.toMatch(/didn't stop to wait/);
    expect(r.message).toMatch(/waited for Claude Arcanist through mild hits your routine takes once the walk is done \(Marionette L26: no pack, no hurting spells, no heavy hits, health not under 60%\)/);
  });

  // 2026-10-18 15:29Z reports (verify-stream-reports-2026-10-18-1529.ts): under danger with the fellow past the leash the
  // walk now holds there to fight, never on without them; flee=true still runs on.
  it('no routine: a hit with them past the leash holds the walk there (2026-10-18 15:29Z: never on without them)', async () => {
    marionette();
    run(api, host, 300, { physics: false });
    const r = (await settle(api, host, surface(api).walkTo('40m west', { stayWith: 'Claude Arcanist', stopOnAggro: false }), 40_000, nicks()))!;
    expect(r.message, r.message).toMatch(/^stopped [\d.]+ m short to hold with Claude Arcanist: real danger on you \(being hit\) and they are \d+ m E of you, past the 15 m leash/);
    expect(r.message).not.toMatch(/didn't stop to wait/);
  });

  it('no routine, flee=true: running away walks on without them, naming them (unchanged)', async () => {
    marionette();
    run(api, host, 300, { physics: false });
    const r = (await settle(api, host, surface(api).walkTo('40m west', { stayWith: 'Claude Arcanist', flee: true }), 40_000, nicks()))!;
    expect(r.message, r.message).toMatch(/didn't stop to wait for Claude Arcanist: you were being hit, and a walk under attack never stands still for a fellow/);
  });

  it('routine running, but health under 60%: real danger, so the walk holds for them, saying why', async () => {
    host.me.health = { current: 110, max: 193 };
    api.routine.start(hunt());
    marionette();
    run(api, host, 300, { physics: false });
    const r = (await settle(api, host, surface(api).walkTo('40m west', { stayWith: 'Claude Arcanist' }), 40_000, nicks()))!;
    expect(r.message, `${r.message}\n${lines.join('\n')}`).toMatch(/^stopped [\d.]+ m short to hold with Claude Arcanist: real danger on you \(health 1\d\d\/193, under 60%\)/);
    expect(r.message).toMatch(/your routine "Bulwark fights" takes what is on you/);
  });

  it('routine running, three near your level on you: a pack, so the walk holds for them', async () => {
    api.routine.start(hunt());
    const pack = [0x8000b5c8, 0x8000b642, 0x80000fb0];
    for (const g of pack) host.add({ guid: g, name: 'Innocent Doll', itemType: 0x10, objectDescFlags: 0x10, level: 50, x: 81, y: 20, seeks: { guid: BUL, kind: 'stick' } });
    run(api, host, 300, { physics: false });
    const r = (await settle(api, host, surface(api).walkTo('40m west', { stayWith: 'Claude Arcanist', stopOnAggro: false }), 40_000, (t) => {
      for (const g of pack) { const m = host.objs.get(g)!; m.x = host.me.x + 1; m.y = host.me.y; }
      if (t > 0 && t % 1000 === 0) api.pushChat('Innocent Doll scratches your foot for 2 points of slashing damage!', 0x15);
    }))!;
    expect(r.message, r.message).toMatch(/^stopped [\d.]+ m short to hold with Claude Arcanist: real danger on you \(3 on you at once \(a pack\)\)/);
  });
});

describe('3 and 6. a hand cast or use waits for the cast or use already under way (the routine\'s)', () => {
  let host: FakeHost;
  let api: AgentApi;
  let busyUntil = 0;
  const KIT = 0x80005dd1;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, combatMode: 'magic', mana: { current: 300, max: 330 } };
    busyUntil = 0;
    host.busy = () => host.t < busyUntil;
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  // Each 100 ms tick flushes the promise chain, so a send's time is the fake clock's own.
  const settleT = async <T>(p: Promise<T>, ms: number, each?: (t: number) => void): Promise<T | null> => {
    let out: T | null = null;
    void p.then((x) => { out = x; });
    for (let t = 0; t < ms && out === null; t += 100) { each?.(t); run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    return out;
  };

  it('a Heal sent while the routine\'s Heal Other runs 4.5 s more goes out after its UseDone, not at the old 4 s cap', async () => {
    busyUntil = host.t + 4500;
    let sentAt: number | null = null;
    const send = host.cast;
    host.cast = (s, t) => { sentAt = host.t; const r = send(s, t); api.pushChat('You cast Heal Self I on yourself and restore 10 points of your health.', 7); return r; };
    const r = (await settleT(surface(api).cast('Heal Self I', 'self'), 20_000))!;
    expect(sentAt, r.message).not.toBeNull();
    expect(sentAt!).toBeGreaterThanOrEqual(4500);
    expect(r.message).toMatch(/^casting Heal Self I on yourself \(waited 4\.\d s for the cast or use already under way to finish: sent sooner, the server answers "You're too busy!"\)/);
  });

  it('use_on of a kit waits out the routine\'s kit in flight, and its answer is its own line, not the routine kit\'s heal', async () => {
    host.inv = [{ guid: KIT, name: 'Excellent Healing Kit', where: 'pack', objectDescFlags: 0x40000000 }] as never;
    busyUntil = host.t + 2500;
    let sentAt: number | null = null;
    host.useWithTarget = (s, t) => { sentAt = host.t; host.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`); queueMicrotask(() => api.pushChat('You expertly heal yourself for 30 Health points. Your Excellent Healing Kit has 11 uses left.', 0)); return true; };
    const p = surface(api).useOn('Excellent Healing Kit', 'self');
    const r = (await settleT(p, 20_000, (t) => { if (t === 2000) api.pushChat('You expertly heal yourself for 100 Health points. Your Excellent Healing Kit has 12 uses left.', 0); }))!;
    expect(sentAt).toBeGreaterThanOrEqual(2500);
    expect(r.message, r.message).toMatch(/heal yourself for 30 Health points/);
    expect(r.message).not.toMatch(/for 100 Health points/);
    expect(r.message).toMatch(/waited 2\.\d s for the cast or use already under way/);
  });

  it('nothing under way: sent at once, nothing said of a wait', async () => {
    let sentAt: number | null = null;
    const send = host.cast;
    host.cast = (s, t) => { sentAt = host.t; const r = send(s, t); api.pushChat('You cast Heal Self I on yourself and restore 10 points of your health.', 7); return r; };
    const r = (await settleT(surface(api).cast('Heal Self I', 'self'), 20_000))!;
    expect(sentAt).toBeLessThan(300);
    expect(r.message).not.toMatch(/waited/);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('4. walk_to "Surface" in Aerbax Laboratory (0x029E) takes the Surface a walk reaches', () => {
  const LB = 0x029e0000;
  const C = (n: number): number => (LB | n) >>> 0;
  // ACE-World 029E.sql: Surface #7029E005 in 0x029E0122 at (50, −690, −17.995); Surface #7029E033 in 0x029E0268 at
  // (50, 0, 6.005), on the far side of a one-way drop; Bulwark in 0x029E0159 at (60, −495) (soldier.log 13:27:53Z,
  // global (444, 29841) − (384, 30336)).
  const NEAR = 0x7029e005, FAR = 0x7029e033;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true });
  }, 180_000);
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('both remembered and out of view: the 206 m one on his side, named in the answer, not the 484 m one across the drop', async () => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    try {
      host.me = { ...host.me, name: 'Claude Bulwark', level: 49 };
      const z = -12;
      const cell = nav.col.findCellContaining(384 + 60, 30336 - 495, z + 0.5, C(0x159));
      expect(cell).toBe(C(0x159));
      // Seen earlier this session (remembered places), FAR first, as the live list had it; both then out of view.
      host.add({ guid: FAR, name: 'Surface', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x268), x: 50, y: 0, z: 6.005 });
      host.add({ guid: NEAR, name: 'Surface', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x122), x: 50, y: -690, z: -17.995 });
      await host.run(cell!, { x: 60, y: -495, z }, async () => ({ ok: true, message: 'seen' }), { maxMs: 300 });
      host.objs.delete(FAR); host.objs.delete(NEAR);
      const api = (host as unknown as { api: AgentApi }).api;
      const traces = (host as unknown as { traces: string[] }).traces;
      const r = await host.run(cell!, { x: 60, y: -495, z }, (a) => a.walkTo('Surface', { within: 2, timeoutMs: 4000 }), { maxMs: 8000, sameApi: true });
      expect(traces.join('\n'), r.message).toMatch(/walk: Surface #7029e033 is out of reach on foot \(no doorway route\); taking #7029e005 of that name, a \d+ m way/);
      expect(r.message).toMatch(/of 2 named "Surface", took #7029e005 \(cell 0x029E0122\), a \d+ m way on foot; #7029e033 is out of reach on foot \(no doorway route\)/);
      expect(r.message).not.toMatch(/no way on foot from this part of the dungeon/);
      expect(api).toBeTruthy();
    } finally { host.dispose(); }
  }, 300_000);
});

describe('5. a corpse out of sight is looted, and walked to, by its id at where it lies', () => {
  let host: FakeHost;
  let api: AgentApi;
  const CORPSE = 0x8000b356;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.wall = () => false;
    api = new AgentApi(host);
    // The Pristine Doll's corpse, seen 30 m south, then let go by the client (its room out of sight of yours).
    host.add({ guid: CORPSE, name: 'Corpse of Pristine Doll', itemType: 0x200, objectDescFlags: 0x2000, x: 80, y: -10 });
    run(api, host, 300, { physics: false });
    host.objs.get(CORPSE)!.lost = true;
    run(api, host, 300, { physics: false });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  /** Back in view once you're within 15 m of it. */
  const inView = (): void => { const o = host.objs.get(CORPSE)!; if (o.lost && Math.hypot(host.me.x - o.x, host.me.y - o.y) < 15) o.lost = false; };

  it('loot #id walks there, then opens it once it is in view (it was "out of sight": go back and look)', async () => {
    const p = surface(api).loot(CORPSE);
    await settle(api, host, p, 30_000, () => inView());
    expect(Math.hypot(host.me.x - 80, host.me.y + 10)).toBeLessThan(4);
    expect(host.sent).toContain(`use ${CORPSE.toString(16)}`);
  });

  it('walk_to #id goes to where it lies', async () => {
    const r = (await settle(api, host, surface(api).walkTo(CORPSE, { within: 2 }), 30_000))!;
    expect(r.ok, r.message).toBe(true);
    expect(Math.hypot(host.me.x - 80, host.me.y + 10)).toBeLessThan(4);
  });

  it('there and it isn\'t in view: said so (rotted, looted, or in a room near there)', async () => {
    const r = (await settle(api, host, surface(api).loot(CORPSE), 30_000))!;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^walked to where it was last seen \(30 m off when you set off\), and Corpse of Pristine Doll #8000b356 isn't in view there/);
  });

  it('a use of it (no walk of its own for the out of sight) names loot / walk_to by its id', async () => {
    const use = await (api.surface() as unknown as { use: (t: unknown) => Promise<AgentResult> }).use(CORPSE);
    expect(use.message).toMatch(/a corpse lies where it was last seen, 30 m S: ac_loot target=#8000b356 \(or ac_walk_to it\) goes there and loots it once it is in view/);
  });
});
