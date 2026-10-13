/**
 * ac_cast repeat=true (2026-10-12): a caster keeps casting one spell at one target, as a melee player's ac_attack
 * keeps swinging. Each cast goes through the single cast's own path; the repeat stops, saying why, when the target
 * dies, mana runs short, a cast is refused, health falls below until_health, a new monster starts attacking, after
 * max_casts, or when another task replaces it. Arcanist (war mage) got 3 bolts off in 7 minutes to Bulwark's 6 kills,
 * one bolt per tool call. docs/agent-play.md "Repeat casting".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { TOOLS, TOOL_CALLER, castRepeatArgs, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { FakeHost } from './_harness/agentFake.ts';

const SKULKER = 0x80000080;
const MOSSWART = 0x80000082;

describe('ac_cast repeat', () => {
  let host: FakeHost;
  let api: AgentApi;
  /** What the server answers each cast with (by cast number, from 1): chat lines, or a side effect. */
  let reply: (n: number) => void;
  let castsSent: number;
  let blocked: number | null;

  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    api = new AgentApi(host);
    blocked = null;
    host.spells = () => [
      { id: 27, name: 'Flame Bolt I', school: 'War', level: 1, projectile: true, range: 20 },
      { id: 6, name: 'Heal Self I', school: 'Life', level: 1, self: true },
    ];
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({
      spells: new Map([[27, { name: 'Flame Bolt I', desc: '', category: 0, school: 1, bitfield: 0, power: 1, baseMana: 10 }]]),
    });
    (host as unknown as { lineOfFire: (g: number) => { dist: number; blockedAt: number | null } }).lineOfFire = () => ({ dist: 8, blockedAt: blocked });
    host.add({ guid: SKULKER, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 28 });
    host.add({ guid: MOSSWART, name: 'Mosswart', itemType: 0x10, objectDescFlags: 0x10, x: 90, y: 20 });
    host.me.mana = { current: 60, max: 60 };
    castsSent = 0;
    // Default server: each bolt lands for 12, costs 10 mana, and the answer comes 600 ms after the cast.
    reply = () => {
      host.me.mana.current -= 10;
      api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
    };
    host.cast = (id: number, t: number | null) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      const n = ++castsSent;
      setTimeout(() => reply(n), 600);
      return true;
    };
  });
  afterEach(() => vi.useRealTimers());

  /** Run the fake clock until the repeat answers (at most `ms`). */
  async function settle(p: Promise<AgentResult>, ms = 60_000): Promise<AgentResult> {
    let out: AgentResult | undefined;
    void p.then((r) => { out = r; });
    for (let t = 0; t < ms && out === undefined; t += 200) await vi.advanceTimersByTimeAsync(200);
    if (!out) throw new Error('repeat never answered');
    return out;
  }

  it('keeps casting until the target dies, then sums up what each cast did and your vitals', async () => {
    reply = (n) => {
      host.me.mana.current -= 10;
      if (n < 3) { api.pushChat(`You scorch Drudge Skulker for ${10 + n} points with Flame Bolt I.`, 0x16); return; }
      // A killing bolt has no damage line, only a death message.
      host.dying.add(SKULKER);
      api.pushChat('Your flames consume Drudge Skulker\'s mortal remains!', 0x16);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(host.sent.filter((s) => s === 'cast 27 80000080')).toHaveLength(3);
    expect(r.ok).toBe(true);
    const lines = r.message.split('\n');
    expect(lines[0]).toBe('cast Flame Bolt I at Drudge Skulker 3 times (repeat); stopped: Drudge Skulker died');
    expect(lines[1]).toBe('  1: You scorch Drudge Skulker for 11 points with Flame Bolt I.');
    expect(lines[2]).toBe('  2: You scorch Drudge Skulker for 12 points with Flame Bolt I.');
    expect(lines[3]).toMatch(/^ {2}3: Your flames consume Drudge Skulker's mortal remains!/);
    expect(r.message).toContain('23 damage in 2 hits');
    expect(r.message).toContain('limits: health below 50% (until_health), 20 casts, 120 s');
    expect(r.message).toContain('you: health 50/50, stamina 80/80, mana 30/60');
    // The summary also reaches ac_wait types=task-done, and the task is over.
    const done = api.eventsSince().filter((e) => e.type === 'task-done');
    expect(done.at(-1)?.text).toMatch(/^casting Flame Bolt I at Drudge Skulker \(repeat\): cast Flame Bolt I at Drudge Skulker 3 times/);
    expect(api.snapshot({ max: 0 }).me?.task).toBeNull();
  });

  it('a partner saying the target is dead, or the agent\'s own note, is not a kill: only the game\'s kill line is', async () => {
    reply = (n) => {
      host.me.mana.current -= 5;
      if (n === 1) {
        api.pushChat('[Fellowship] Claude Bulwark says, "Drudge Skulker is dead, next!"', 0x12);
        api.pushChat('(system) [Agent] Drudge Skulker died? checking', 0x1f);
        api.pushChat('You scorch Drudge Skulker for 9 points with Flame Bolt I.', 0x16);
        return;
      }
      host.dying.add(SKULKER);
      api.pushChat('You killed Drudge Skulker!', 0x16);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(castsSent).toBe(2);
    expect(r.message).toMatch(/2 times \(repeat\); stopped: Drudge Skulker died/);
  });

  it('hits YOU take meanwhile are not the bolt\'s damage, nor its line (live: "27 damage in 5 hits" was the drudges\' damage to the mage)', async () => {
    reply = (n) => {
      host.me.mana.current -= 10;
      api.pushChat('Critical hit! Drudge Servant stabs your lower arm for 11 points of piercing damage!', 0x15);
      api.pushChat('You evaded Drudge Servant!', 0x15);
      api.pushChat('Lich scorches you for 30 points with Flame Bolt II.', 0x15);
      if (n === 1) { api.pushChat('Critical hit! You incinerate Drudge Skulker for 50 points with Flame Bolt I.', 0x16); return; }
      host.dying.add(SKULKER);
      api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true, untilHealth: 0 }));
    expect(r.message).toContain('62 damage in 2 hits');
    const lines = r.message.split('\n');
    expect(lines[1]).toBe('  1: Critical hit! You incinerate Drudge Skulker for 50 points with Flame Bolt I.');
    expect(r.message).not.toMatch(/stabs your|You evaded|scorches you/);
  });

  it('a resist or a fizzle is a cast that went out: it keeps going and counts them', async () => {
    reply = (n) => {
      host.me.mana.current -= 5;
      if (n === 1) api.pushChat('Drudge Skulker resists your spell', 0x16);
      else if (n === 2) api.pushChat('Your spell fizzled.', 0x16);
      else { host.dying.add(SKULKER); api.pushChat('You scorch Drudge Skulker for 30 points with Flame Bolt I.', 0x16); }
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(castsSent).toBe(3);
    expect(r.message).toMatch(/3 times \(repeat\); stopped: Drudge Skulker died/);
    expect(r.message).toContain('30 damage in 1 hit, 1 resisted, 1 fizzled');
  });

  it('stops when your mana will not pay for another cast (the spell table\'s cost), before sending it', async () => {
    host.me.mana = { current: 25, max: 60 };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    // 25 → 15 → 5: two casts, then 5 < 10.
    expect(castsSent).toBe(2);
    expect(r.message).toMatch(/2 times \(repeat\); stopped: out of mana: 5 left, and a cast of Flame Bolt I costs up to 10/);
    expect(r.message).toContain('mana 5/60');
  });

  it('stops on the server\'s "not enough Mana" refusal', async () => {
    (host as unknown as { spellTableData?: unknown }).spellTableData = undefined;
    reply = (n) => {
      if (n === 1) { host.me.mana.current -= 10; api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16); return; }
      api.pushUseDone(0x401, 'YouDontHaveEnoughManaToCast', 'You don\'t have enough Mana to cast this spell.');
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(castsSent).toBe(2);
    expect(r.message).toMatch(/1 time \(repeat\); stopped: out of mana \(the server: You don't have enough Mana/);
  });

  it('stops when a monster other than the target starts attacking you, and names it', async () => {
    host.objs.get(MOSSWART)!.x = 83; // within a swing's reach (8 m): a melee line is credited only to a creature there
    reply = (n) => {
      host.me.mana.current -= 10;
      api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
      if (n === 2) api.pushChat('The Mosswart hits your chest for 4 points of bludgeoning damage!', 0x15);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(castsSent).toBe(2);
    expect(r.message).toMatch(/2 times \(repeat\); stopped: Mosswart #80000082 \(1× in 10 s\) started attacking you, and isn't your target/);
  });

  it('a monster already attacking you when it started, or the target itself hitting you, does not stop it', async () => {
    host.objs.get(MOSSWART)!.x = 83; // within a swing's reach (8 m): a melee line is credited only to a creature there
    api.pushChat('The Mosswart hits your leg for 3 points of bludgeoning damage!', 0x15);
    reply = (n) => {
      host.me.mana.current -= 5;
      api.pushChat('The Drudge Skulker hits your arm for 2 points of slashing damage!', 0x15);
      api.pushChat('The Mosswart hits your leg for 3 points of bludgeoning damage!', 0x15);
      api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
      if (n === 4) host.dying.add(SKULKER);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(castsSent).toBe(4);
    expect(r.message).toMatch(/stopped: Drudge Skulker died/);
  });

  it('stops when your health falls below until_health, and says the threshold', async () => {
    reply = (n) => {
      host.me.mana.current -= 5;
      api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
      if (n === 2) host.me.health.current = 14; // 28%
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true, untilHealth: 0.3 }));
    expect(castsSent).toBe(2);
    expect(r.message).toMatch(/stopped: your health is 14\/50 \(28%\), below the 30% you set \(until_health\)/);
    expect(r.message).toContain('limits: health below 30% (until_health)');
  });

  it('stops at max_casts', async () => {
    host.me.mana = { current: 600, max: 600 };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true, maxCasts: 3 }));
    expect(castsSent).toBe(3);
    expect(r.message).toMatch(/^cast Flame Bolt I at Drudge Skulker 3 times \(repeat\); stopped: 3 casts made \(max_casts\)/);
    expect(r.message).toContain('36 damage in 3 hits');
  });

  it('stops at its time budget', async () => {
    host.me.mana = { current: 6000, max: 6000 };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true, maxCasts: 100, maxMs: 3000 }));
    expect(r.message).toMatch(/stopped: 3 s passed \(max_s\)/);
    expect(castsSent).toBeGreaterThan(0);
    expect(castsSent).toBeLessThan(10);
  });

  it('a refusal stops it: no line of fire after the target stepped behind a wall', async () => {
    reply = (n) => {
      host.me.mana.current -= 5;
      api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
      if (n === 1) blocked = 3.1;
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(castsSent).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/1 time \(repeat\); stopped: the cast was refused: Flame Bolt I not cast: no line of fire to Drudge Skulker/);
  });

  it('a refusal stops it: "Out of Range!" says how far the spell reaches', async () => {
    reply = (n) => {
      if (n === 1) { host.me.mana.current -= 5; api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16); return; }
      api.pushChat('Out of Range!', 0x16);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(castsSent).toBe(2);
    expect(r.message).toMatch(/1 time \(repeat\); stopped: Out of Range! \(Flame Bolt I reaches 20 m for you/);
  });

  it('"You\'re too busy!" once is waited out; twice running stops it', async () => {
    reply = (n) => {
      if (n === 2 || n === 4 || n === 5) { api.pushChat('You\'re too busy!', 0x16); return; }
      host.me.mana.current -= 5;
      api.pushChat('You scorch Drudge Skulker for 12 points with Flame Bolt I.', 0x16);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }));
    expect(castsSent).toBe(5);
    expect(r.message).toMatch(/2 times \(repeat\); stopped: "You're too busy!" 2 times running/);
  });

  it('another task (a walk, ac_stop_moving) ends it with the summary so far, and nothing more is cast', async () => {
    const p = api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(castsSent).toBeGreaterThanOrEqual(2);
    // While it runs, observe shows it as your task.
    expect(api.snapshot({ max: 0 }).me?.task).toBe('casting Flame Bolt I at Drudge Skulker (repeat)');
    void api.walkTo('10m north');
    const r = await settle(p, 1000);
    expect(r.message).toMatch(/^cast Flame Bolt I at Drudge Skulker \d time(s)? \(repeat\); stopped: interrupted \(replaced by walking 10 m N\)/);
    const sent = castsSent;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(castsSent).toBe(sent);
    api.stopMoving();

    const q = api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true });
    await vi.advanceTimersByTimeAsync(700);
    api.stopMoving();
    const r2 = await settle(q, 1000);
    expect(r2.message).toMatch(/stopped: interrupted \(stopped\)/);
    const sent2 = castsSent;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(castsSent).toBe(sent2);
  });

  it('a single cast replaces a running repeat; your death ends it', async () => {
    const p = api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true });
    await vi.advanceTimersByTimeAsync(700);
    void api.cast('Flame Bolt I', 'Drudge Skulker');
    expect((await settle(p, 1000)).message).toMatch(/stopped: interrupted \(replaced by a single cast\)/);
    await vi.advanceTimersByTimeAsync(5000);

    const q = api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true });
    await vi.advanceTimersByTimeAsync(700);
    host.me.dead = true;
    api.tick();
    expect((await settle(q, 1000)).message).toMatch(/stopped: interrupted \(you died\)/);
  });

  it('refuses a repeat on yourself and a spell you do not know', async () => {
    expect((await api.cast('Heal Self I', null, { repeat: true })).message).toMatch(/repeat casts at a target, not at yourself/);
    expect((await api.cast('Ring of Fire', 'Drudge Skulker', { repeat: true })).message).toMatch(/you don't know a spell matching "Ring of Fire"/);
    expect(castsSent).toBe(0);
  });

  it('a single cast is unchanged: one cast, its own reply, no task', async () => {
    const p = api.cast('Flame Bolt I', 'Drudge Skulker');
    const r = await settle(p, 10_000);
    expect(castsSent).toBe(1);
    expect(r).toEqual({ ok: true, message: 'casting Flame Bolt I at Drudge Skulker #80000080\n  You scorch Drudge Skulker for 12 points with Flame Bolt I.' });
    expect(api.snapshot({ max: 0 }).me?.task).toBeNull();
    await vi.advanceTimersByTimeAsync(5000);
    expect(castsSent).toBe(1);
  });

  it('ac_cast passes repeat, until_health (percent), max_casts and max_s to the page', async () => {
    expect(castRepeatArgs({})).toBeNull();
    expect(castRepeatArgs({ repeat: 'true', until_health: '30', max_casts: '5', max_s: 90 })).toEqual({ repeat: true, untilHealth: 0.3, maxCasts: 5, maxMs: 90_000 });
    const seen: unknown[][] = [];
    const caller: ToolCaller = { notice: null, call: async <T,>(m: string, a?: unknown[]) => { seen.push([m, ...(a ?? [])]); return { ok: true, message: 'ok' } as T; } };
    const tool = TOOLS.find((t) => t.name === 'ac_cast')!;
    await TOOL_CALLER.run(caller, () => tool.run({ spell: 'Flame Bolt I', target: 'Drudge Skulker', repeat: true }));
    await TOOL_CALLER.run(caller, () => tool.run({ spell: 'Flame Bolt I' }));
    expect(seen).toEqual([['cast', 'Flame Bolt I', 'Drudge Skulker', { repeat: true }], ['cast', 'Flame Bolt I', null, null]]);
  });

  it('an interrupted task names itself once in task-done (not "walking …: walking …: interrupted")', async () => {
    const walk = api.walkTo('10m north');
    await vi.advanceTimersByTimeAsync(200);
    api.stopMoving();
    const r = await walk;
    expect(r.message).toMatch(/interrupted \(stopped\)/);
    const done = api.eventsSince().filter((e) => e.type === 'task-done').map((e) => e.text);
    expect(done.length).toBe(1);
    const label = done[0].slice(0, done[0].indexOf(': '));
    expect(done[0].startsWith(`${label}: ${label}: `)).toBe(false);
    expect(done[0]).toMatch(/: interrupted \(stopped\)$/);
  });
});
