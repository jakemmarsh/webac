/**
 * Stream report, 2026-10-18 19:26–20:30Z (build 902389a3): Claude Arcanist (mage, L53, "Arcanist fights") with Claude
 * Bulwark lapping Aerbax Laboratory 0x029E. Report: the wrap-up segment's bug list; transcript
 * mage-2026-10-18-seg2.jsonl; page trace mage.log; feed.jsonl.
 *
 * 1. "Routine follow stalls after portals and after Bulwark dropped down a ledge". The drops did not stall: every one of
 *    her 14 hand walk_to "Claude Bulwark" after his "dropping 6 m, hop after me" arrived without a drop of its own (the
 *    Follow had taken it: 19:54:32–39Z "walk drop 6.0 m", her walk_to at 19:54:46Z "arrived (0.4 m)"); each followed a
 *    10–15 s wait that answered "(nothing within 10 s)". A wait that finds nothing now says what the Follow did meanwhile.
 *    The portal did stall once: at 19:59:14Z Bulwark took Surface #7029e005 while the Follow's walk at him was under way;
 *    the walk re-aimed at his landing spot 27 km off and ran 14 s ("toward a goal 27080 m away", "no doorway route …")
 *    until her own walk_to; the three other surfacings that day were followed through within 7 s. A walk at a creature
 *    the server places in another space now ends at once, naming the portal beside where they were, and the Follow ends
 *    its walk the moment it finds the portal they took.
 * 2. Buff upkeep by hand: 78 of her 86 hand casts were on Bulwark (23 of them Revitalize Other). VTank keeps only your
 *    own buffs (her routine logged 21 rebuffs, the banes and Impenetrability among them; her eight hand self casts were
 *    all "surpassed" by Pumpkin Buffer incantations). Its Helper restores a fellow's stamina below Recharge-Helper-Stam,
 *    whose default is 1 %, and mage.json never set it. A hand cast now says what the routine covers (once per kind a run).
 * 3. "Aura of Swift Killer Other at 50 m failed for range with no hint": the hint was there (25 m, walk 27 m closer), but
 *    said "longer as your Item ranks grow" of a fixed reach (every Aura Other: BaseRangeConstant 25, BaseRangeMod 0). ACE
 *    checks the range before AND after the windup (VerifySpellRange); a target within reach at the send that ran off is
 *    now said so, and a cast that waited on a busy client is checked again before it goes.
 * 4. "Parallel casts fizzle": they don't go out together. Each waits for the last one's end (19:29:23.2Z Swift Killer
 *    fizzled, the next went out 19:29:26.98Z after its UseDone); ACE rolls the fizzle at the cast's start
 *    (GetCastingPreCheckStatus: skill vs power, 98–99 % here; 53 of her 3,956 casts that day fizzled, 1.3 %). The
 *    fizzle's answer now says the casts were queued.
 * 5. "You have been teleported too recently" on a cast after a portal: checked, retail/ACE (Portal.CheckUseRequirements,
 *    minTimeSinceLastPortal 3.5 s). She arrived on Bulwark's spot beside the Aerbax Laboratory portal (19:59:42.5Z) and
 *    her body touched it 0.7 s later (0x4A7, 19:59:43.2Z); her Strength Other IV, sent then, carried the line. The line is
 *    now said as the portal's refusal, not the cast's.
 */
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { ALL_MODULES_OFF, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import type { AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { formatEvents } from '../packages/renderer/src/agent/format.ts';
import { routineFromFile } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const REPO = resolve(__dirname, '..');
const ARC = 0x500000a3, BUL = 0x500000a4;
const SURFACE = 0x7029e005, LAB = 0x78972000;
const LB = 0x029e0000;
const C = (n: number): number => (LB | n) >>> 0;
const LAND = 0x89720026;

const mage = (): RoutineProfile => {
  const r = routineFromFile(join(REPO, 'tools', 'stream', 'routines', 'mage.json'));
  if ('text' in r) throw new Error(r.text);
  return r.profile;
};
/** mage.json's "With Bulwark" Follow alone (navigation on, the rest off). */
const followOnly = (): RoutineProfile => ({ ...mage(), modules: { ...ALL_MODULES_OFF, navigation: true } });
const fellowsOf = (stam = 200): FakeHost['fellows'] => () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 190, max: 193 }, stamina: { cur: stam, max: 278 }, mana: { cur: 100, max: 103 } }];

let host: FakeHost;
let api: AgentApi;
let traces: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  traces = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.map(String).join(' ')); });
  host = new FakeHost();
  host.wall = () => false;
  host.me = { ...host.me, guid: ARC, name: 'Claude Arcanist', level: 53, cell: C(0x121), x: 50, y: -650, z: -18, health: { current: 199, max: 199 } };
  host.fellows = fellowsOf();
  // Dungeon cells are sealed (no SeenOutside), the landscape's are not: as the client's cell data says.
  host.cellSealed = (c: number) => (c & 0xffff) >= 0x100;
  api = new AgentApi(host);
});
afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

/** Bulwark at Surface's edge in 0x029E0122 (as at 19:59:13Z), then placed on the landscape at 10.2S 8.1E. */
const surfaceScene = (): void => {
  host.add({ guid: SURFACE, name: 'Surface', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x122), x: 50, y: -690, z: -17.995 });
  host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x122), x: 50, y: -687, z: -18, heardAt: host.t });
};
const throughSurface = (): void => {
  const b = host.objs.get(BUL)!;
  b.cell = LAND; b.x = 120; b.y = 130; b.z = 0; b.heardAt = host.t;
};

describe('1. a walk at a creature the server moves into another space ends there, and the Follow takes the portal', () => {
  it('walk_to Bulwark as he takes Surface: stopped at once, the portal beside him named, not 14 s at his landing 27 km off', async () => {
    surfaceScene();
    run(api, host, 300, { physics: false });
    let res: { ok: boolean; message: string } | null = null;
    void api.walkTo(BUL, { within: 2, timeoutMs: 15_000 }).then((r) => { res = r; });
    run(api, host, 600);
    await vi.advanceTimersByTimeAsync(0);
    expect(res).toBeNull();
    throughSurface();
    const t0 = host.t;
    for (let i = 0; i < 40 && !res; i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(res, JSON.stringify(res)).not.toBeNull();
    expect(host.t - t0).toBeLessThan(1500);
    expect(res!.ok).toBe(false);
    // Gone through a portal is no "they fell behind" (the fellow note under a walk's answer).
    expect(res!.message).not.toMatch(/fell behind/);
    expect(res!.message).toMatch(/^stopped: Claude Bulwark went through a portal or recalled: the client now places them outside this dungeon \(at [\d.]+[NS], [\d.]+[EW]\), from beside Surface #7029e005 \(\d+ m [NSEW]+ of you\): ac_use it to follow/);
    expect(traces.join('\n')).not.toMatch(/toward a goal \d{4,} m away/);
  });

  it('a walk at a creature already elsewhere when it starts, or the walk taking you through a portal, is not this stop', async () => {
    // Bulwark placed on the landscape from the start: the walk's own "went through a portal or recalled" path, unchanged.
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: LAND, x: 120, y: 130, z: 0, heardAt: host.t });
    run(api, host, 300, { physics: false });
    const r = await Promise.race([api.walkTo(BUL, { within: 2, timeoutMs: 3000 }), (async () => { for (let i = 0; i < 60; i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); } return null; })()]);
    expect(r?.message ?? '').not.toMatch(/^stopped: Claude Bulwark went through/);
  });

  it('the routine Follow, walking at him when he goes through: ends that walk and uses Surface after him; a quiet wait says so', async () => {
    surfaceScene();
    host.objs.get(BUL)!.y = -672; // 22 m south of her: the Follow (8 m) walks at him
    const used: number[] = [];
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); used.push(g); host.screenName = 'portal-space'; return true; };
    // The Follow's walk at him runs its whole 15 s unless stopped, as the live one did (searching toward his landing
    // spot): only a stop ends it early.
    let release: (() => void) | null = null;
    const stopMoving = api.stopMoving.bind(api);
    api.stopMoving = () => { release?.(); return stopMoving(); };
    api.walkTo = ((_t: unknown, o?: { timeoutMs?: number }) => new Promise((res) => {
      release = () => res({ ok: false, message: 'stopped' });
      setTimeout(() => res({ ok: false, message: 'stopped 27080.0 m short: the walk took longer than 15 s' }), o?.timeoutMs ?? 15_000);
    })) as AgentApi['walkTo'];
    api.routine.start(followOnly());
    const waited = api.wait({ types: ['death'], chatMatch: '] Claude Bulwark says' }, 12_000);
    for (let i = 0; i < 12; i++) { const b = host.objs.get(BUL)!; b.y = Math.max(-687, b.y - 1.2); b.heardAt = host.t; run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(api.routine.status().acting).toMatch(/route "With Bulwark"/);
    throughSurface();
    // As live (the page notes the portal trip after the routine's own step in a tick, and the Follow samples every
    // 250 ms): the Follow's first look after his move already finds the portal he took, not first "out of sight".
    const step = api.routine.tick.bind(api.routine);
    api.routine.tick = () => {};
    run(api, host, 100);
    api.routine.tick = step;
    expect(api.fellowPortal('Claude Bulwark')).toMatchObject({ guid: SURFACE });
    const t0 = host.t;
    for (let i = 0; i < 80 && !used.length; i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    const hist = api.routine.history().join('\n');
    expect(used, `${hist}\n${traces.slice(-30).join('\n')}`).toEqual([SURFACE]);
    expect(host.t - t0, hist).toBeLessThan(4000);
    expect(traces.join('\n')).not.toMatch(/toward a goal \d{4,} m away/);
    expect(hist).toMatch(/Follow: Claude Bulwark went through Surface #7029e005 \(they went through it \d+ s ago\); following through it/);
    // The wait asked only for his /f lines: it answers "nothing", with what the routine did meanwhile.
    for (let i = 0; i < 130; i++) { run(api, host, 100, { physics: false }); await vi.advanceTimersByTimeAsync(0); }
    const evs = await waited;
    expect(evs).toHaveLength(1);
    expect(formatEvents(evs)).toMatch(/^ {2}NOW: nothing you waited for came within 1\d s; meanwhile your routine "Arcanist fights" went through Surface after Claude Bulwark on its own/);
  });

  it('a quiet wait with the Follow doing nothing new is still empty ("(nothing within …)")', async () => {
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x121), x: 52, y: -650, z: -18, heardAt: host.t });
    api.routine.start(followOnly());
    const waited = api.wait({ types: ['death'] }, 3000);
    for (let i = 0; i < 40; i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(await waited).toEqual([]);
  });

  it('a Follow walk that dropped off a ledge after him is logged and said by the next quiet wait', async () => {
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x121), x: 50, y: -630, z: -18, heardAt: host.t });
    const walk = api.walkTo.bind(api);
    // The walk's own answer as the live one read ("arrived (1.0 m from Claude Bulwark); on the way you dropped off a ledge (6.0 m)").
    api.walkTo = (async (t: Parameters<AgentApi['walkTo']>[0], o?: Parameters<AgentApi['walkTo']>[1]) => {
      const r = await walk(t, { ...o, timeoutMs: 1000 });
      return { ...r, ok: true, message: 'arrived (1.0 m from Claude Bulwark); on the way you dropped off a ledge (6.0 m)' };
    }) as AgentApi['walkTo'];
    const waited = api.wait({ types: ['death'] }, 5000);
    api.routine.start(followOnly());
    for (let i = 0; i < 60; i++) { run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
    expect(api.routine.history().join('\n')).toMatch(/Follow: dropped off a ledge \(6\.0 m\) after Claude Bulwark/);
    expect(formatEvents(await waited)).toMatch(/meanwhile your routine "Arcanist fights" dropped off a ledge \(6\.0 m\) after Claude Bulwark( \(\d+ times\))? on its own; Claude Bulwark is [\d.]+ m [NSEW]+ of you now$/);
  });
});

/** Arcanist's spells as the page lists them (main.ts spells(): range from the spell table, rangeFixed for a fixed reach). */
const SPELLS: AgentSpell[] = [
  { id: 6028, name: 'Aura of Swift Killer Other V', school: 'Item', level: 5, range: 25, rangeFixed: true },
  { id: 1335, name: 'Strength Other IV', school: 'Creature', level: 4, range: 75, rangeFixed: true, buff: true },
  { id: 1186, name: 'Revitalize Other IV', school: 'Life', level: 4, range: 66.4 },
  { id: 1165, name: 'Heal Other V', school: 'Life', level: 5, range: 66.4 },
  { id: 1328, name: 'Focus Self V', school: 'Creature', level: 5, self: true, buff: true },
];

describe('3–5. a hand cast\'s answer: reach, a target that moved off in the windup, the queue, the portal line, the Helper', () => {
  beforeEach(() => {
    host.spells = () => SPELLS;
    host.me = { ...host.me, combatMode: 'magic' };
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x121), x: 50, y: -628, z: -18, heardAt: host.t });
  });

  /** Send a cast; `reply` answers it (chat lines, as the server's) once it is out, and `during` runs during its windup. */
  /** As the player's own ac_cast sends it: through the agent surface (a routine's casts call api.cast and get no routine notes). */
  const handCast = (spell: string, target: string | null): Promise<{ ok: boolean; message: string }> =>
    (api.surface().cast as (s: string, t: string | null) => Promise<{ ok: boolean; message: string }>)(spell, target);
  const castWith = async (spell: string, target: string | null, reply: (h: FakeHost) => void, during?: () => void): Promise<{ ok: boolean; message: string }> => {
    const cast = new FakeHost().cast;
    let busy = false;
    host.busy = () => busy;
    host.cast = (id: number, tg: number | null) => {
      const ok = cast(id, tg);
      busy = true;
      setTimeout(() => { during?.(); reply(host); busy = false; }, 2000);
      return ok;
    };
    const p = handCast(spell, target);
    for (let i = 0; i < 60; i++) { run(api, host, 100, { physics: false }); await vi.advanceTimersByTimeAsync(100); }
    return p;
  };

  it('an aura out of reach: its 25 m is fixed, not "longer as your Item ranks grow"', async () => {
    host.objs.get(BUL)!.y = -600; // 50 m
    const r = await api.cast('Aura of Swift Killer Other V', 'Claude Bulwark');
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Aura of Swift Killer Other V not cast: out of range: Aura of Swift Killer Other V reaches 25 m for you (a fixed reach: no rank lengthens it); Claude Bulwark is 50.0 m away: walk 26 m closer (ac_walk_to target=#500000a4 within=23)');
  });

  it('within reach at the send, 50 m off when it goes off: "Out of Range!" said with the distance at the send', async () => {
    const r = await castWith('Aura of Swift Killer Other V', 'Claude Bulwark', (h) => {
      h.objs.get(BUL)!.y = -600;
      api.pushUseDone(0x3d, 'MissileOutOfRange', 'Out of Range!');
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/\(Aura of Swift Killer Other V reaches 25 m for you \(a fixed reach: no rank lengthens it\); Claude Bulwark is 50\.0 m away: walk 26 m closer .*; when it went out they were 22\.0 m away, within reach: they moved off during the windup, and the server checks the range again as the spell goes off\)/);
  });

  it('a cast that waited on one under way is checked again before it goes: out of reach, or behind a wall, by then', async () => {
    // The routine's cast under way for 2 s; meanwhile Bulwark runs from 22 m to 50 m.
    let busy = true;
    host.busy = () => busy;
    setTimeout(() => { host.objs.get(BUL)!.y = -600; busy = false; }, 2000);
    const p = api.cast('Aura of Swift Killer Other V', 'Claude Bulwark');
    for (let i = 0; i < 40; i++) { run(api, host, 100, { physics: false }); await vi.advanceTimersByTimeAsync(100); }
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Aura of Swift Killer Other V not cast \(waited \d\.\d s for the cast or use already under way to finish: .*\): out of range by the time it could go out: Aura of Swift Killer Other V reaches 25 m for you \(a fixed reach: no rank lengthens it\); Claude Bulwark is 50\.0 m away/);
    expect(host.sent.filter((x) => x.startsWith('cast '))).toEqual([]);
    // A bolt: open at the ask, a wall in the way once the client is free.
    host.spells = () => [...SPELLS, { id: 2128, name: 'Flame Bolt V', school: 'War', level: 5, range: 75, rangeFixed: true, projectile: true }];
    host.add({ guid: 0x8000d423, name: 'Marionette', itemType: 0x10, objectDescFlags: 0, cell: C(0x121), x: 50, y: -640, z: -18, heardAt: host.t });
    host.isAttackable = () => true;
    let blocked: number | null = null;
    host.lineOfFire = () => ({ dist: 10, blockedAt: blocked, blocker: 'a wall' });
    busy = true;
    setTimeout(() => { blocked = 4; busy = false; }, 1500);
    const q = api.cast('Flame Bolt V', 0x8000d423);
    for (let i = 0; i < 30; i++) { run(api, host, 100, { physics: false }); await vi.advanceTimersByTimeAsync(100); }
    const b = await q;
    expect(b.ok).toBe(false);
    expect(b.message).toMatch(/Flame Bolt V not cast(?: \(waited \d\.\d s .*\))?: no line of fire to Marionette by the time it could go out \(10\.0 m away\): a wall 4\.0 m along the line would take the bolt/);
    expect(host.sent.filter((x) => x.startsWith('cast '))).toEqual([]);
  });

  it('"You have been teleported too recently!" in a cast\'s reply is said as the portal\'s refusal, naming the portal', async () => {
    host.add({ guid: LAB, name: 'Aerbax Laboratory', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x121), x: 51, y: -651, z: -18 });
    const r = await castWith('Strength Other IV', 'Claude Bulwark', () => {
      api.pushChat('You have been teleported too recently!', 0x07);
      api.pushChat('You cast Strength Other IV on Claude Bulwark, refreshing Strength Other IV', 0x07);
    });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('You have been teleported too recently! (not this cast: the server refusing Aerbax Laboratory #78972000, 1.4 m from you, which your body touched: no portal takes you within 3.5 s of your last arrival, and this one didn\'t)');
  });

  it('a fizzle with another cast queued behind it says they went out one at a time', async () => {
    host.objs.get(BUL)!.y = -640;
    let n = 0;
    const replies = ['Your spell fizzled.', 'You cast Strength Other IV on Claude Bulwark, refreshing Strength Other IV'];
    const cast = new FakeHost().cast;
    let busy = false;
    host.busy = () => busy;
    const order: string[] = [];
    host.cast = (id: number, tg: number | null) => {
      const ok = cast(id, tg);
      busy = true; order.push(`send ${id} @${host.t}`);
      const line = replies[n++];
      setTimeout(() => { api.pushChat(line, 0x07); busy = false; order.push(`done @${host.t}`); }, 2000);
      return ok;
    };
    const a = api.cast('Aura of Swift Killer Other V', 'Claude Bulwark');
    const b = api.cast('Strength Other IV', 'Claude Bulwark');
    for (let i = 0; i < 80; i++) { run(api, host, 100, { physics: false }); await vi.advanceTimersByTimeAsync(100); }
    const [ra, rb] = await Promise.all([a, b]);
    // Never two in flight: the second went out after the first's end.
    expect(order[0]).toMatch(/^send 6028/);
    expect(order[1]).toMatch(/^done/);
    expect(order[2]).toMatch(/^send 1335/);
    expect(ra.message).toMatch(/Your spell fizzled\./);
    expect(ra.message).toMatch(/the casts you sent together went out one at a time here, each once the last had ended, so none cut this one short: a fizzle is the server's skill roll for that one cast, made as it starts/);
    expect(rb.ok).toBe(true);
  });

  it('a lone fizzle says nothing of a queue', async () => {
    host.objs.get(BUL)!.y = -640;
    const r = await castWith('Aura of Swift Killer Other V', 'Claude Bulwark', () => api.pushChat('Your spell fizzled.', 0x07));
    expect(r.message).not.toMatch(/one at a time/);
  });

  it('Revitalize Other on a fellow with the routine running at Recharge-Helper-Stam 1: said once that the Helper is off in effect', async () => {
    api.routine.start({ ...mage(), modules: { ...ALL_MODULES_OFF } });
    const one = await castWith('Revitalize Other IV', 'Claude Bulwark', () => api.pushChat('With Revitalize Other IV you restore 73 points of stamina to Claude Bulwark.', 0x07));
    expect(one.message).toContain('your routine "Arcanist fights" restores a fellow\'s stamina itself only below Recharge-Helper-Stam 1% (VTank\'s default: in effect never); a run with set="Recharge-Helper-Stam=<percent>" has it cast Revitalize Other on a fellow below that');
    const two = await castWith('Revitalize Other IV', 'Claude Bulwark', () => api.pushChat('With Revitalize Other IV you restore 60 points of stamina to Claude Bulwark.', 0x07));
    expect(two.message).not.toMatch(/Recharge-Helper/);
    // Heal Other: mage.json's Helper heals Bulwark below 60 %.
    const heal = await castWith('Heal Other V', 'Claude Bulwark', () => api.pushChat('With Heal Other V you restore 61 points of health to Claude Bulwark.', 0x07));
    expect(heal.message).toContain('your routine "Arcanist fights" also restores a fellow\'s health itself, below 60% (DoHelp, Recharge-Helper-HitP)');
  });

  it('a self buff by hand with the routine buffing: says the routine keeps your own buffs up; nothing with no routine, nor on the routine\'s own casts', async () => {
    api.routine.start({ ...mage(), modules: { ...ALL_MODULES_OFF, buffs: true } });
    // The routine's own cast (api.cast, not the surface): no note, and the once-a-run note is still to come.
    const cast0 = new FakeHost().cast;
    host.cast = (id: number, tg: number | null) => { setTimeout(() => api.pushChat('You cast Focus Self V on yourself, refreshing Focus Self V', 0x07), 500); return cast0(id, tg); };
    const own = api.cast('Focus Self V', null);
    for (let i = 0; i < 30; i++) { run(api, host, 100, { physics: false }); await vi.advanceTimersByTimeAsync(100); }
    expect((await own).message).not.toMatch(/your routine/);
    api.routine.stop();
    const none = await castWith('Focus Self V', null, () => api.pushChat('You cast Focus Self V on yourself, refreshing Focus Self V', 0x07));
    expect(none.message).not.toMatch(/your routine/);
    api.routine.start({ ...mage(), modules: { ...ALL_MODULES_OFF, buffs: true } });
    const r = await castWith('Focus Self V', null, () => api.pushChat('You cast Focus Self V on yourself, refreshing Focus Self V', 0x07));
    expect(r.message).toContain('your routine "Arcanist fights" keeps your own buffs up itself (EnableBuffing: every trained skill\'s, the protections and banes, and its Extra Buff Spells), recasting each under 120 s left');
  });
});
