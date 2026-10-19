/**
 * The stream players' 2026-10-19 16:52Z segment reports (Claude Arcanist / mage, Claude Bulwark / soldier; build
 * b76eafd05; Mountain Keep 0x01D2):
 *
 *   1. `cast spells="Blade Bane V, Impenetrability VI"` came back "0 landed, 2 didn't … not cast" with no reason: the
 *      casts went out 1 s into a 6 m drop of the walk before (ACE IsJumping → UseDone 0x4EB "You can't do that while in
 *      the air!", twice), and the list kept only each answer's first line. A cast (and a kit, food or gem use) now
 *      waits to land; a list keeps each refusal's reason, uncut.
 *   2. A hand recast after "has expired" read "(refreshed)": the server said "surpassing Invulnerability Self IV", the
 *      IV his routine had cast under the VI at 16:40:09. A list now names refreshed / over X (whose, when) / surpassed.
 *   3. "Melee Defense Other" casts Invulnerability Other (the line named by the skill it raises), single or listed.
 *   4. A chaser held more than a minute with nothing hit stops waking waits until it moves, hits or a way to it opens
 *      (Dread #80002405, "AIMED AT" for 1075 s).
 *   5. A door found locked is forgotten (and said) as soon as it is seen open, and a door that answered locked from its
 *      front is tried from behind (ACE Door.ActOnUse opens a locked door used from behind: Arcanist walked through
 *      #701d2021 at 16:51:05 while Bulwark's walks refused it all session).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, doorFacing, skillLineQuery } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult, AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { RoutineEngine } from '../packages/renderer/src/agent/RoutineEngine.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { AUTO_ENTER_DELAY_MS, createHostAttack } from '../packages/renderer/src/agent/hostAttack.ts';

/** Drives fake timers and the host clock until `p` settles. */
async function settle<T>(host: FakeHost, p: Promise<T>, maxMs = 60_000): Promise<T> {
  let out: { v: T } | undefined;
  void p.then((v) => { out = { v }; });
  for (let t = 0; t < maxMs && !out; t += 100) { host.t += 100; await vi.advanceTimersByTimeAsync(100); }
  if (!out) throw new Error('did not settle');
  return out.v;
}

/** The surface's own call (a hand command: handCalls counted), as the CLI and connector call it. */
const hand = (api: AgentApi) => api.surface() as unknown as { cast: (s: unknown, t: unknown, o?: unknown) => Promise<AgentResult> };

describe('1–3. casts: in the air, list reasons and labels, spells named by their skill', () => {
  let host: FakeHost;
  let api: AgentApi;
  const BUL = 0x500000a4;
  const SPELLS: AgentSpell[] = [
    { id: 2101, name: 'Blade Bane V', school: 'Item', level: 5, buff: true, targetType: 0x6 },
    { id: 2102, name: 'Impenetrability VI', school: 'Item', level: 6, buff: true, targetType: 0x6 },
    { id: 2201, name: 'Invulnerability Self IV', school: 'Creature', level: 4, self: true, buff: true, skill: { name: 'Melee Defense', raises: true } },
    { id: 2202, name: 'Invulnerability Self VI', school: 'Creature', level: 6, self: true, buff: true, skill: { name: 'Melee Defense', raises: true } },
    { id: 2203, name: 'Invulnerability Other V', school: 'Creature', level: 5, buff: true, targetType: 0x10, skill: { name: 'Melee Defense', raises: true } },
    { id: 2204, name: 'Acid Protection Self VI', school: 'Life', level: 6, self: true, buff: true },
    { id: 2205, name: 'Blade Protection Self V', school: 'Life', level: 5, self: true, buff: true },
  ];
  /** What the server answers each cast with (spell id → its lines, or a UseDone error code). */
  let reply: Map<number, string[] | number>;
  let inAirUntil: number;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.mana = { current: 300, max: 360 };
    host.spells = () => SPELLS;
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 21 });
    reply = new Map();
    inAirUntil = -1;
    (host as unknown as { bodyInAir: () => boolean }).bodyInAir = () => host.t < inAirUntil;
    host.cast = (id, t) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)} at ${host.t}`);
      // ACE Player_Magic: IsJumping → UseDone YouCantDoThatWhileInTheAir (0x4EB), no words said.
      if (host.t < inAirUntil) { setTimeout(() => api.pushUseDone(0x4eb, 'YouCantDoThatWhileInTheAir', null), 500); return true; }
      const r = reply.get(id) ?? [`You cast ${SPELLS.find((s) => s.id === id)!.name} on ${t === null ? 'yourself' : 'Claude Bulwark'}`];
      setTimeout(() => {
        if (typeof r === 'number') { api.pushUseDone(r, r === 0x4eb ? 'YouCantDoThatWhileInTheAir' : 'YoureTooBusy', null); return; }
        for (const l of r) api.pushChat(l, 0x07);
      }, 1200);
      return true;
    };
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('1. a list sent mid-drop waits to land, then both land (was "0 landed, 2 didn\'t", 16:11:36Z)', async () => {
    inAirUntil = 1500; // 1.5 s still to fall
    const r = await settle(host, hand(api).cast(['Blade Bane V', 'Impenetrability VI'], null));
    expect(host.sent.filter((s) => s.startsWith('cast ')).map((s) => Number(/at (\d+)$/.exec(s)![1]) >= 1500)).toEqual([true, true]);
    expect(r.message).toMatch(/^cast 2 of 2 on yourself: 2 landed\n {2}landed: Blade Bane V, Impenetrability VI/);
  });

  it('1. a single cast still in the air after the wait is not sent, saying why', async () => {
    inAirUntil = 60_000;
    const r = await settle(host, hand(api).cast('Blade Bane V', null));
    expect(host.sent.filter((s) => s.startsWith('cast '))).toEqual([]);
    expect(r).toEqual({ ok: false, message: 'Blade Bane V not cast: you are still in the air after 4.0 s (a jump or a fall): the server refuses a cast in the air ("You can\'t do that while in the air!"). Cast once you land' });
  });

  it('1. a refusal in a list keeps its reason (the lines under "X not cast"), never just "not cast"', async () => {
    reply.set(2101, 0x4eb);
    reply.set(2102, 0x4eb);
    const r = await settle(host, hand(api).cast(['Blade Bane V', 'Impenetrability VI'], null));
    expect(r.ok).toBe(false);
    const didnt = r.message.split('\n').find((l) => l.startsWith("  didn't: "))!;
    const why = 'not cast: the server refused it: YouCantDoThatWhileInTheAir (no message shown); (your body was in the air as it went out, a jump or a drop: the server refuses a cast then. Cast again once you land)';
    expect(didnt).toBe(`  didn't: Blade Bane V: ${why}; Impenetrability VI: ${why}`);
  });

  it('castFailReason joins a reasonless head to its lines and cuts nothing', () => {
    expect(AgentApi.castFailReason('Blade Bane V not cast\n  the server refused it: You can\'t do that while in the air! (YouCantDoThatWhileInTheAir)\n  (your body was in the air as it went out, a jump or a drop: the server refuses a cast then. Cast again once you land)'))
      .toBe("Blade Bane V not cast: the server refused it: You can't do that while in the air! (YouCantDoThatWhileInTheAir); (your body was in the air as it went out, a jump or a drop: the server refuses a cast then. Cast again once you land)");
    const long = `you don't know a spell matching "Melee Defense Other III": Melee Defense spells are called Invulnerability: Invulnerability Other V (the highest of yours; you know no level 3 of it)`;
    expect(AgentApi.castFailReason(long)).toBe(long);
    expect(AgentApi.castFailReason('X not cast (waited 3.2 s for the cast or use already under way to finish: sent sooner, the server answers "You\'re too busy!")\n  the server refused it: Fizzle'))
      .toMatch(/to finish: sent sooner, the server answers "You're too busy!"\): the server refused it: Fizzle$/);
  });

  it('2. "has expired", then a hand recast over the IV the routine put under it: "(over … your routine\'s cast at …)", not "(refreshed)"', async () => {
    host.wallClock = () => Date.UTC(2026, 9, 19, 16, 40, 9) + host.t;
    // The routine's cast (api.cast, not the surface): under the VI still on.
    reply.set(2201, ['You cast Invulnerability Self IV on yourself, but it is surpassed by Invulnerability Self VI']);
    const routine = await settle(host, api.cast('Invulnerability Self IV', 'self'));
    expect(routine.message).toMatch(/surpassed: you already have Invulnerability Self VI/);
    host.t += 150_000;
    api.pushChat('Invulnerability Self VI has expired.', 0x07);
    reply.set(2202, ['You cast Invulnerability Self VI on yourself, surpassing Invulnerability Self IV']);
    reply.set(2205, ['You cast Blade Protection Self V on yourself, refreshing Blade Protection Self V']);
    reply.set(2204, ['You cast Acid Protection Self VI on yourself, but it is surpassed by Incantation of Acid Protection Self']);
    const r = await settle(host, hand(api).cast(['Invulnerability Self VI', 'Blade Protection Self V', 'Acid Protection Self VI'], null));
    expect(r.message.split('\n')[1]).toBe("  landed: Invulnerability Self VI (over Invulnerability Self IV, your routine's cast at 16:40:10Z (2m31s ago)), Blade Protection Self V (refreshed), Acid Protection Self VI (surpassed by Incantation of Acid Protection Self, which stays in effect: kept under it, it takes over when that wears off; its mana was spent all the same)");
    // A single hand cast says the same in its verdict.
    const one = await settle(host, hand(api).cast('Invulnerability Self VI', null));
    expect(one.message).toMatch(/it is now over Invulnerability Self IV, your routine's cast at 16:40:10Z/);
  });

  it('3. "Melee Defense Other" casts Invulnerability Other V on a fellow, listed or alone, saying the line\'s name', async () => {
    expect(skillLineQuery(SPELLS, 'Melee Defense Other')).toEqual({ query: 'Invulnerability Other', skill: 'Melee Defense', line: 'Invulnerability' });
    expect(skillLineQuery(SPELLS, 'Aura of Melee Defense Other V')?.query).toBe('Invulnerability Other V');
    expect(skillLineQuery(SPELLS, 'Invulnerability Other')).toBeNull();
    const r = await settle(host, hand(api).cast(['Blade Bane V', 'Melee Defense Other'], 'Claude Bulwark'));
    expect(host.sent.filter((s) => s.startsWith('cast ')).map((s) => s.split(' at ')[0])).toEqual(['cast 2101 500000a4', 'cast 2203 500000a4']);
    expect(r.message).toMatch(/landed: Blade Bane V, Invulnerability Other V/);
    const one = await settle(host, hand(api).cast('Melee Defense Other', 'Claude Bulwark'));
    expect(one.message.split('\n')[0]).toBe('casting Invulnerability Other V at Claude Bulwark #500000a4 ("Melee Defense Other": Melee Defense spells are called Invulnerability)');
  });

  it('3. a level of it you don\'t know: the hint, whole (was cut at "called Invulnerabili")', async () => {
    const r = await settle(host, hand(api).cast(['Melee Defense Other III'], 'Claude Bulwark'));
    expect(r.message).toMatch(/didn't: Melee Defense Other III: you don't know a spell matching "Melee Defense Other III": Melee Defense spells are called Invulnerability: Invulnerability Other V \(the highest of yours; you know no level 3 of it\)/);
  });

  it('sweep: a routine step\'s refusal note keeps the server\'s reason', () => {
    const lines: string[] = [];
    const engine = (api as unknown as { routine: RoutineEngine }).routine;
    (engine as unknown as { note: (t: string) => void }).note = (t) => { lines.push(t); };
    const step = { label: 'buff', run: async () => ({ ok: false, message: 'Blade Bane V not cast\n  the server refused it: YoureTooBusy (no message shown)' }) };
    return (engine as unknown as { runMacroStep: (s: typeof step) => Promise<void> }).runMacroStep(step).then(() => {
      expect(lines).toEqual(['buff: Blade Bane V not cast: the server refused it: YoureTooBusy (no message shown)']);
    });
  });
});

describe('4. a chaser stuck a minute and more wakes no wait until something changes', () => {
  let host: FakeHost;
  let api: AgentApi;
  const DREAD = 0x80002405;
  let seen = 0;
  const aggros = (): string[] => {
    const evs = api.eventsSince(seen);
    if (evs.length) seen = evs[evs.length - 1].seq;
    return evs.filter((e) => e.type === 'aggro' || e.type === 'fellow-aggro').map((e) => e.text);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.level = 51;
    host.lineOfFire = () => ({ dist: 16, blockedAt: 4, blocker: 'a wall' });
    api = new AgentApi(host);
    seen = 0;
    host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 36, z: 94, level: 60, seeks: { guid: host.me.guid, kind: 'move' } });
    run(api, host, 22_000, { physics: false }); // raised, then held: no closer in 20 s
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** Out of your sight long enough that its 20 s hold is forgotten (AGGRO_STALL_KEEP_MS), then back where it was. */
  const awayAndBack = (): void => {
    host.objs.get(DREAD)!.lost = true;
    run(api, host, 35_000, { physics: false });
    host.objs.get(DREAD)!.lost = false;
    run(api, host, 25_000, { physics: false });
  };

  it('held under a minute: the hold is forgotten out of sight and it is said again (as before)', () => {
    expect(aggros().map((t) => t.replace(/,.*/, ''))).toEqual(['Dread Mu-miyah #80002405 (level 60) is coming at you', 'Dread Mu-miyah #80002405 (level 60) keeps facing you']);
    awayAndBack();
    expect(aggros().length).toBe(2);
  });

  it('held over a minute: out of sight and back where it stood, no aggro again (was raise + "keeps facing" again at 16:50Z)', () => {
    run(api, host, 45_000, { physics: false }); // 65 s held
    aggros();
    awayAndBack();
    expect(aggros()).toEqual([]);
  });

  it('…until it moves off its spot, or hits you', () => {
    run(api, host, 45_000, { physics: false });
    aggros();
    host.objs.get(DREAD)!.y = 30; // 6 m nearer you by its own going: it got loose
    run(api, host, 12_000, { physics: false });
    expect(aggros().some((t) => /is coming at you/.test(t))).toBe(true);
    run(api, host, 70_000, { physics: false }); // long stuck again at its new spot
    aggros();
    host.objs.get(DREAD)!.x = 80.5; host.objs.get(DREAD)!.y = 21;
    api.pushChat('Dread Mu-miyah grazes your foot for 2 points of bludgeoning damage!', 0x15);
    run(api, host, 500, { physics: false });
    expect((api as unknown as { longStuck: Map<number, unknown> }).longStuck.has(DREAD)).toBe(false);
  });
});

describe('5. doors found locked: forgotten (and said) when seen open; tried from behind', () => {
  let host: FakeHost;
  let api: AgentApi;
  const UPPER = 0xa9b40150, OTHER = 0xa9b40152, DOOR = 0x701d2021, DREAD = 0x800042a2;
  let door: AgentHostObject;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.level = 51;
    api = new AgentApi(host);
    host.me.cell = UPPER; host.me.x = 80; host.me.y = 20; host.me.z = 0;
    host.cellSealed = () => true;
    // The door faces south (its +Y at −Y): ACE's Front is the south side, where you stand.
    door = host.add({ guid: DOOR, name: 'Door', itemType: 0x80, objectDescFlags: 0x1000, cell: UPPER, x: 80, y: 30, z: 0, physicsState: 0, facing: { x: 0, y: -1 } });
    host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: OTHER, x: 80, y: 40, z: 0, level: 60 });
    run(api, host, 500);
    host.objs.get(DREAD)!.lost = true; // out of sight in the far room: attack answers from the route
    const route = (_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }, opts?: { closed?: Array<{ x: number; y: number }> }) =>
      ((opts?.closed ?? []).some((c) => Math.hypot(c.x - 80, c.y - 30) < 2.5) ? null : [{ x: 80, y: 30, z: 0 }, to]);
    (host as unknown as { route: typeof route }).route = route;
    host.me.y = 28;
    api.pushChat('The door is locked!');
    host.me.y = 20;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('doorFacing is the frame\'s +Y: the Mountain Keep door (w 0.707, z −0.707) faces east', () => {
    const f = doorFacing({ rw: 0.707107, rx: 0, ry: 0, rz: -0.707107 });
    expect(f.x).toBeCloseTo(1, 5);
    expect(f.y).toBeCloseTo(0, 5);
    expect(doorFacing({ rw: 1, rx: 0, ry: 0, rz: 0 })).toEqual({ x: 0, y: 1 });
  });

  it('from the side it answered locked: still the only way, refused at once', () => {
    const r = api.attack(DREAD, { far: true }) as { ok: boolean; message: string };
    expect(r.message).toMatch(/only doorway route goes through Door #701d2021 \(10 m N; locked\), found locked this session/);
  });

  it('seen open: forgotten at once and said in the chat; the route goes through it again', () => {
    door.physicsState = 0x4;
    run(api, host, 1500);
    const said = api.eventsSince().filter((e) => e.type === 'chat' && /\[Agent\] Door #701d2021/.test(e.text)).map((e) => e.text);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^\(system\) \[Agent\] Door #701d2021, found locked \d+s ago, stands open now .*walks and attacks go through it again while it is open$/);
    door.physicsState = 0; // shut again (its reset): not known locked any more, so tried again
    const r = api.attack(DREAD, { far: true }) as { message: string };
    expect(r.message).not.toMatch(/found locked this session/);
  });

  it('from behind it (the far side): not taken for locked, tried (ACE opens a locked door used from behind)', () => {
    host.me.cell = OTHER; host.me.y = 45; // north of the door: its Back
    const locked = (api as unknown as { lockedClosed: (f?: { x: number; y: number }) => Array<{ guid: number }> }).lockedClosed.bind(api);
    const g = (y: number) => ({ x: 0xa9 * 192 + 80, y: 0xb4 * 192 + y });
    expect(locked(g(45)).map((d) => d.guid)).toEqual([]);
    expect(locked(g(20)).map((d) => d.guid)).toEqual([DOOR]);
    // Refused from behind too (another server, or it was locked after all): locked from both sides now.
    host.me.y = 32;
    host.t += 20_000;
    api.pushChat('The door is locked!');
    expect(locked(g(45)).map((d) => d.guid)).toEqual([DOOR]);
  });
});

describe('1b (sweep). an attack sent mid-fall waits to land too (ACE Player_Melee / Player_Missile refuse it in the air)', () => {
  const MAR = 0x8000ec15;
  let host: FakeHost;
  let api: AgentApi;
  let inAirUntil: number;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    inAirUntil = -1;
    (host as unknown as { bodyInAir: () => boolean }).bodyInAir = () => host.t < inAirUntil;
    host.me.combatMode = 'melee';
    host.add({ guid: MAR, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 21, level: 26 });
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const attacks = (): string[] => host.sent.filter((x) => x.startsWith('attack '));
  const said = (): string[] => api.eventsSince().filter((e) => e.type === 'chat' && /\[Agent\] the attack on Marionette/.test(e.text)).map((e) => e.text);

  it('held while in the air, sent on landing, and said (the routine\'s attacks run the same loop)', () => {
    inAirUntil = 1500;
    expect(api.attack('Marionette').ok).toBe(true);
    run(api, host, 1000, { physics: false });
    expect(attacks()).toEqual([]);
    run(api, host, 1000, { physics: false });
    expect(attacks()).toHaveLength(1);
    expect(said()).toEqual(['(system) [Agent] the attack on Marionette #8000ec15 waited 1.4 s to land before it went out: sent in the air, the server answers "You can\'t do that while in the air!"']);
  });

  it('on the ground: sent at once, nothing said', () => {
    expect(api.attack('Marionette').ok).toBe(true);
    run(api, host, 300, { physics: false });
    expect(attacks()).toHaveLength(1);
    expect(said()).toEqual([]);
  });

  it('still falling after LAND_WAIT_MS: sent anyway, saying so', () => {
    inAirUntil = 60_000;
    api.attack('Marionette');
    run(api, host, AgentApi.LAND_WAIT_MS - 200, { physics: false });
    expect(attacks()).toEqual([]);
    run(api, host, 600, { physics: false });
    expect(attacks()).toHaveLength(1);
    expect(said()[0]).toMatch(/waited 4\.\d s in the air and goes out anyway/);
  });

  it('the stance switch\'s delayed swing doesn\'t go out in the air either', () => {
    let swings = 0;
    let air = true;
    const ha = createHostAttack({
      inAttackStance: () => false,
      autoEnterPlan: () => ({ sendAttack: true, mode: 2 }),
      changeCombatMode: () => {},
      swing: () => { swings++; },
      requestPending: () => false,
      now: () => host.t,
      schedule: (fn, ms) => { setTimeout(fn, ms); },
      inAir: () => air,
    });
    ha.attack(MAR, 0.5, 'medium');
    vi.advanceTimersByTime(AUTO_ENTER_DELAY_MS + 10);
    expect(swings).toBe(0);
    air = false;
    ha.attack(MAR, 0.5, 'medium');
    vi.advanceTimersByTime(AUTO_ENTER_DELAY_MS + 10);
    expect(swings).toBe(1);
  });
});
