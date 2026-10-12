/**
 * AGENT.play-reports-2026-10-11-evening — what Claude Arcanist (a mage) and Claude Bulwark (a soldier) hit
 * playing together through the agent tools on end-of-retail local ACE (19:40–21:06 EDT), each driven through
 * the real AgentApi on the fake host (tests/_harness/agentFake.ts), the real tool table, the real range check
 * and jump planner, and the daemon's real shutdown: stack values squared, Nanto's upstairs scriveners' shops
 * closing at once, a use reporting the previous vendor's window, a give from a stack too small reported as
 * given, your own name as a use_on target, a use "done" from 25 m away and a portal "no reply", far walks
 * that gave up at a lake or on a tower's upper floor, no way to run away, a landing on a pylon's lip, ac_look
 * without its text, fellows left behind, monster levels unknown until appraised, and a daemon that never exited.
 */
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatInventory } from '../packages/renderer/src/agent/format.ts';
import { objectsInRange } from '../packages/renderer/src/world/ObjectRangeChecks.ts';
import { TOOLS, TOOL_CALLER, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { cliOutput } from '../tools/ac-agent/cli.ts';
import { createShutdown, killTree } from '../tools/ac-agent/shutdown.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';

describe('agent play reports 2026-10-11 (evening)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a stack\'s value is the stack\'s own (ACE Value = StackUnitValue × StackSize), never multiplied again', () => {
    const text = formatInventory([
      { guid: 0x80000101, name: 'Pyreal', where: 'main pack', stack: 6586, value: 6586 },
      { guid: 0x80000102, name: 'Arrow', where: 'main pack', stack: 250, value: 250 },
    ]);
    expect(text).toContain('Pyreal  (x6586, value 6,586)');
    expect(text).toContain('Arrow  (x250, value 250)');
    expect(text).not.toContain('43,375,396');
  });

  it('a vendor on an upper floor is in range from the floor you stand on, not from the terrain under the building', () => {
    // Nanto's Journeyman Scrivener of Life Magic (ACE world DB 0x7E63D03B): floor z 99 over terrain 94, UseRadius 3.
    // Renderer axes: y is up. The vendor bar closed the moment it opened when the player body sat on the terrain.
    const vendor = { x: 135.2, y: 99.005, z: 113.0, radius: 0.48, height: 1.835 };
    const onFloor = { x: 136.4, y: 99.0, z: 114.6, radius: 0.48, height: 1.835 };
    expect(objectsInRange(vendor, onFloor, 3, true, false)).toBe(true);
    expect(objectsInRange(vendor, { ...onFloor, y: 94 }, 3, true, false)).toBe(false);
  });

  it('a use on a vendor answers with that vendor\'s window, not one still open from the vendor before', async () => {
    host.add({ guid: 0x7e63d038, name: 'Journeyman Scrivener of War Magic', itemType: 0x10, objectDescFlags: 0x200, x: 81, y: 21 });
    host.add({ guid: 0x7e63d039, name: 'Journeyman Scrivener of Item Magic', itemType: 0x10, objectDescFlags: 0x200, x: 79, y: 21 });
    host.vendorOpen = { name: 'Journeyman Scrivener of War Magic', guid: 0x7e63d038, currency: 'Pyreals', items: [] };
    const p = api.use('Journeyman Scrivener of Item Magic');
    await vi.advanceTimersByTimeAsync(2000);
    host.vendorOpen = { name: 'Journeyman Scrivener of Item Magic', guid: 0x7e63d039, currency: 'Pyreals', items: [{ guid: 0x80009001, name: 'Scroll of Blood Drinker', price: 1000 }] };
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.message).toMatch(/vendor window open/);
    expect(api.vendorView().message).toMatch(/^Journeyman Scrivener of Item Magic sells/);

    // One that greets and opens nothing says so.
    host.vendorOpen = null;
    const q = api.use('Journeyman Scrivener of War Magic');
    await vi.advanceTimersByTimeAsync(300);
    api.pushChat('Journeyman Scrivener of War Magic tells you, "Isn\'t it wonderful what Asheron and the Arcanum were able to accomplish for us?"', 0x03);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await q).message).toMatch(/no shop window opened for Journeyman Scrivener of War Magic/);
  });

  it('give takes an amount from a stack that holds it, says when none does, and reports the server\'s refusal as a failure', async () => {
    host.add({ guid: 0x50000002, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 20 });
    host.inv = [
      { guid: 0x80000201, name: 'Pyreal', where: 'main pack', stack: 3000 },
      { guid: 0x80000202, name: 'Pyreal', where: 'main pack', stack: 6586 },
    ];
    // The server takes 5000 off the stack it was asked for.
    host.give = (t, i, n) => {
      host.sent.push(`give ${i.toString(16)} to ${t.toString(16)} x${n}`);
      const it = host.inv.find((x) => x.guid === i)!;
      if ((it.stack ?? 1) >= n) it.stack = (it.stack ?? 1) - n;
      else api.pushChat('Give amount not valid! The Pyreals can\'t be given.', 0x00);
      return true;
    };
    let p = api.give('Pyreal', 'Claude Arcanist', 5000);
    await vi.advanceTimersByTimeAsync(3000);
    let r = await p;
    expect(host.sent).toContain('give 80000202 to 50000002 x5000');
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toMatch(/^gave 5000 Pyreal to Claude Arcanist/);

    // No single stack holds 9000: said, nothing sent.
    host.sent = [];
    r = await api.give('Pyreal', 'Claude Arcanist', 9000);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no single Pyreal stack holds 9000 \(yours: 3000, 1586\)/);
    expect(host.sent).toEqual([]);

    // Asked by id for more than that stack holds: the server's refusal is the result.
    p = api.give(0x80000201, 'Claude Arcanist', 4000);
    await vi.advanceTimersByTimeAsync(3000);
    r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Claude Arcanist did not get your Pyreal; the server said:\n {2}Give amount not valid!/);
  });

  it('your own name means you (use_on target="Claude Test")', () => {
    expect(api.resolve('Claude Test', 'world')).toBe(host.me.guid);
    expect(api.resolve('claude test', 'any')).toBe(host.me.guid);
    expect(api.resolve('myself', 'world')).toBe(host.me.guid);
  });

  it('a use far off waits on the server\'s walk while you close in (a portal), and never reads as done from 25 m away', async () => {
    host.add({ guid: 0x7a9b3050, name: 'Portal to Holtburg', objectDescFlags: 0x40000, x: 80, y: 60 });
    const p = api.use('Portal to Holtburg');
    // The server walks you there (its MoveTo) at 3 m/s; the portal takes you once you arrive, after the first 10 s.
    for (let i = 0; i < 140; i++) {
      host.t += 100;
      if (host.me.y < 59) host.me.y += 0.3;
      if (i === 135) api.push('portal', 'entered portal space');
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(r.message).toMatch(/portal: entered portal space/);

    // A healer 25 m off: the walk there never got going and nothing answered.
    host.me.y = 20;
    host.add({ guid: 0x7db6001d, name: 'Aun Taguauri the Healer', itemType: 0x10, x: 80, y: 45 });
    const q = api.use('Aun Taguauri the Healer');
    await vi.advanceTimersByTimeAsync(13_000);
    const u = await q;
    expect(u.ok).toBe(false);
    expect(u.message).toMatch(/you are still 25\.0 m from Aun Taguauri the Healer: the walk there didn't arrive/);
  });

  it('a far walk whose straight stretch ends in a lake goes as far as it can and round it, not "stuck" with no step taken', async () => {
    // The Timaru lake (42N 78-79W): water 60 m round a point 80 m north, the goal 200 m north. Before, every
    // search aimed into the water and the walk gave up "stuck 180.0 m short (no walkable way …)" from the shore.
    host.wall = (x, y) => Math.hypot(x - 80, y - 100) < 60;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let r: Awaited<ReturnType<AgentApi['walkTo']>> | null = null;
    void api.walkTo('200m north', { within: 2, timeoutMs: 300_000 }).then((x) => { r = x; });
    for (let i = 0; i < 2400 && !r; i++) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
    expect(r).toMatchObject({ ok: true });
    expect(host.me.y).toBeGreaterThan(215);
    expect(log.mock.calls.some(([t]) => /turned 90° (left|right)/.test(String(t)))).toBe(true);
    log.mockRestore();
  });

  it('inside a building, a target inside a building of another landblock is reached out through ours first', () => {
    host.me.cell = 0xa9b30107; host.me.x = 176; host.me.y = 83; host.me.z = 119; // the Holtburg scrivener tower's upper floor
    host.add({ guid: 0x50000003, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: 0xa9b40150, x: 78, y: 37, z: 94 });
    const calls: Array<{ fromCell: number; toCell: number }> = [];
    host.routeTo = [{ x: 170, y: 90, z: 116 }];
    const route = host.route;
    host.route = (fc: number, f: unknown, tc: number, to: { x: number; y: number; z: number }) => { calls.push({ fromCell: fc >>> 0, toCell: tc >>> 0 }); return route(fc, f, tc, to); };
    void api.walkTo('Claude Bulwark', { timeoutMs: 5000 });
    expect(calls[0]).toEqual({ fromCell: 0xa9b30107, toCell: 0xa9b30001 });
    api.stopMoving();
  });

  describe('running away (Bulwark: "Couldn\'t walk away with them on me")', () => {
    const skulker = (y: number): void => { host.add({ guid: 0x80004001, name: 'Mudlurk Mosswart', itemType: 0x10, objectDescFlags: 0x10, x: 80, y }); };
    const hit = (): void => api.pushChat('The Mudlurk Mosswart hits your chest for 12 points of bludgeoning damage!', 0x15);
    it('a walk away from everything hitting you keeps going, and says you were hit on the way', async () => {
      skulker(17); // just south of you
      const p = api.walkTo('30m north', { within: 1, onAwayKeepGoing: true });
      run(api, host, 500);
      hit();
      run(api, host, 10_000);
      const r = await p;
      expect(r).toMatchObject({ ok: true });
      expect(r.message).toMatch(/hit on the way \(The Mudlurk Mosswart hits your chest/);
      expect(host.me.y).toBeGreaterThan(48);
    });
    it('a routine\'s walk (not the player\'s ac_walk_to) still stops when hit from behind, to fight', async () => {
      skulker(17);
      const p = api.walkTo('30m north', { within: 1 });
      run(api, host, 500);
      hit();
      run(api, host, 500);
      expect(await p).toMatchObject({ ok: false, attacked: true });
    });
    it('a walk toward the attacker stops (fight or turn away), unless flee=true', async () => {
      skulker(40); // north, where the walk goes
      let p = api.walkTo('30m north', { within: 1, onAwayKeepGoing: true });
      run(api, host, 500);
      hit();
      run(api, host, 500);
      let r = await p;
      expect(r).toMatchObject({ ok: false, attacked: true });
      expect(r.message).toMatch(/flee=true keeps going while hit/);
      p = api.walkTo('10m north', { within: 1, flee: true });
      run(api, host, 500);
      hit();
      run(api, host, 5000);
      r = await p;
      expect(r).toMatchObject({ ok: true });
    });
    it('the tool passes flee and stay_with through', async () => {
      const seen: unknown[][] = [];
      const caller: ToolCaller = { notice: null, call: async <T,>(m: string, a?: unknown[]) => { seen.push([m, ...(a ?? [])]); return { ok: true, message: 'arrived' } as T; } };
      const tool = TOOLS.find((t) => t.name === 'ac_walk_to')!;
      await TOOL_CALLER.run(caller, () => tool.run({ target: '42.1N, 33.6E', flee: true, stay_with: 'Claude Bulwark', stay_within: 20 }));
      expect(seen[0]).toEqual(['walkTo', '42.1N, 33.6E', { within: undefined, flee: true, stayWith: 'Claude Bulwark', stayWithin: 20 }]);
    });
  });

  describe('keeping together', () => {
    const fellow = (y: number): void => {
      host.add({ guid: 0x50000004, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y });
      (host as unknown as { fellows: AgentHostFellows }).fellows = () => [{ guid: 0x50000004, name: 'Claude Bulwark', health: { cur: 50, max: 50 }, stamina: { cur: 50, max: 50 }, mana: { cur: 10, max: 10 } }];
    };
    type AgentHostFellows = () => Array<{ guid: number; name: string; health: { cur: number; max: number }; stamina: { cur: number; max: number }; mana: { cur: number; max: number } }>;
    it('a walk names a fellow it left far behind', async () => {
      fellow(18);
      const p = api.walkTo('40m north', { within: 1 });
      run(api, host, 15_000);
      expect((await p).message).toMatch(/Claude Bulwark is 4\d m away now \(was 2 m\): they fell behind \(stay_with=Claude Bulwark walks at their pace\)/);
    });
    it('stay_with waits while the fellow is farther behind than stay_within, then goes on', async () => {
      fellow(18);
      const p = api.walkTo('40m north', { within: 1, stayWith: 'Claude Bulwark', stayWithin: 10 });
      run(api, host, 6000);
      // Waited where the fellow fell 10 m behind.
      expect(host.me.y).toBeLessThan(31);
      expect(host.me.y).toBeGreaterThan(26);
      // They catch up and keep close.
      for (let t = 0; t < 15_000; t += 100) { host.objs.get(0x50000004)!.y = host.me.y - 3; run(api, host, 100); }
      const r = await p;
      expect(r).toMatchObject({ ok: true });
      expect(r.message).toMatch(/waited \d+ s for Claude Bulwark/);
    });
  });

  it('observe examines the nearest monsters with no level once each, quietly; routines\' own looks don\'t', async () => {
    for (let i = 0; i < 5; i++) host.add({ guid: 0x80005000 + i, name: `Drudge Skulker ${i}`, itemType: 0x10, objectDescFlags: 0x10, x: 80 + i * 5, y: 30 });
    host.add({ guid: 0x80005010, name: 'Known Lugian', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 25, level: 30 });
    api.observe();
    expect(host.appraiseCalls).toEqual([]);
    const dispatch = api.surface() as Record<string, (...a: unknown[]) => unknown>;
    dispatch.observe({});
    expect(host.appraiseCalls).toEqual([0x80005000, 0x80005001, 0x80005002].map((guid) => ({ guid, quiet: true })));
    dispatch.observe({});
    expect(host.appraiseCalls.map((c) => c.guid)).toEqual([0x80005000, 0x80005001, 0x80005002, 0x80005003, 0x80005004]);
  });
});

it('the CLI prints a screenshot\'s path and the text beside it (ac_look\'s observation)', () => {
  expect(cliOutput({ text: 'Claude Bulwark (L12) …', jpegBase64: 'AAAA' }, () => '/tmp/s.jpg')).toBe('/tmp/s.jpg\nClaude Bulwark (L12) …');
  expect(cliOutput({ text: 'screenshot', jpegBase64: 'AAAA' }, () => '/tmp/s.jpg')).toBe('/tmp/s.jpg');
  expect(cliOutput({ text: 'arrived' }, () => { throw new Error('no screenshot'); })).toBe('arrived');
});

describe('the daemon\'s shutdown ends the process (2026-10-12: up 20 minutes after stop, deaf to SIGTERM)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  /** A child that exits on SIGTERM (or only on SIGKILL when stubborn). */
  const child = (pid: number, stubborn = false): ChildProcess & { signals: string[] } => {
    const c = Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null as string | null, signals: [] as string[] });
    return c as unknown as ChildProcess & { signals: string[] };
  };
  const killer = (kids: Array<ChildProcess & { signals: string[] }>, stubborn = new Set<number>()) => (pid: number, s: NodeJS.Signals): void => {
    const k = kids.find((c) => c.pid === Math.abs(pid))!;
    k.signals.push(`${pid < 0 ? 'group ' : ''}${s}`);
    if (s === 'SIGKILL' || !stubborn.has(k.pid!)) setTimeout(() => { (k as unknown as { signalCode: string }).signalCode = s; k.emit('exit', null, s); }, 10);
  };

  it('runs the steps, ends each child\'s process group, then exits 0', async () => {
    const bridge = child(101), vite = child(102);
    const exits: number[] = [];
    const steps = vi.fn(async () => { await new Promise((r) => setTimeout(r, 500)); });
    const shutdown = createShutdown({ say: () => {}, steps, children: () => [bridge, vite, null], exit: (c) => exits.push(c), kill: killer([bridge, vite]) });
    const done = shutdown('requested');
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(steps).toHaveBeenCalledOnce();
    expect(bridge.signals).toEqual(['group SIGTERM']);
    expect(vite.signals).toEqual(['group SIGTERM']);
    expect(exits).toEqual([0]);
  });

  it('a step that hangs (browser.close) is cut off by the deadline; a stubborn child gets SIGKILL', async () => {
    const bridge = child(201);
    const exits: number[] = [];
    const shutdown = createShutdown({
      say: () => {}, steps: () => new Promise<void>(() => {}), children: () => [bridge], exit: (c) => exits.push(c),
      deadlineMs: 30_000, killGraceMs: 2000, kill: killer([bridge], new Set([201])),
    });
    void shutdown('requested');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(bridge.signals).toEqual(['group SIGTERM', 'group SIGKILL']);
    expect(exits).toEqual([1]);
  });

  it('a second SIGTERM during the shutdown ends it at once', async () => {
    const vite = child(301);
    const exits: number[] = [];
    const shutdown = createShutdown({ say: () => {}, steps: () => new Promise<void>(() => {}), children: () => [vite], exit: (c) => exits.push(c), kill: killer([vite]) });
    void shutdown('requested');
    await vi.advanceTimersByTimeAsync(1000);
    const second = shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    await second;
    expect(exits).toEqual([1]);
    expect(vite.signals).toEqual(['group SIGTERM']);
  });

  it('a child already gone is left alone; a pid with no group is signalled itself', async () => {
    const gone = Object.assign(child(401), { exitCode: 0 });
    const sent: string[] = [];
    await killTree(gone, 100, () => { sent.push('x'); });
    expect(sent).toEqual([]);
    const solo = child(402);
    const p = killTree(solo, 100, (pid, s) => { if (pid < 0) throw new Error('ESRCH'); sent.push(`${pid} ${s}`); setTimeout(() => solo.emit('exit'), 5); });
    await vi.advanceTimersByTimeAsync(50);
    await p;
    expect(sent).toEqual(['402 SIGTERM']);
  });
});

void HOLTBURG;

describe('a long walk with no time limit given gets one long enough for its distance (live, 2026-10-11)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a 400 m walk at 4 m/s arrives (the old fixed 60 s ran out at ~240 m)', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.add({ guid: 0x80000500, name: 'Far Marker', itemType: 0x80, x: 80, y: 20 + 400 });
    const r = api.walkTo(0x80000500);
    run(api, host, 130_000);
    const res = await r;
    expect(res.ok).toBe(true);
  });

  it('a time limit given is kept, and running out says the walk was still on the way', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.add({ guid: 0x80000501, name: 'Far Marker', itemType: 0x80, x: 80, y: 20 + 400 });
    const r = api.walkTo(0x80000501, { timeoutMs: 20_000 });
    run(api, host, 25_000);
    const res = await r;
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/timed out [\d.]+ m short after 20 s, still on the way \(walk_to again to carry on, or give timeout_s\)/);
  });
});

describe('a portal the server walks you to: a regen tick is no answer (live, Holtburg Town Network portal 81 m off)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits through a stamina tick and reports the portal, not "didn\'t arrive"', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.add({ guid: 0x7a9b4080, name: 'Portal to Town Network', itemType: 0x10000, x: 80, y: 20 + 30 });
    host.me.stamina = { current: 87, max: 105 };
    host.use = () => {
      // The server's MoveTo: stamina ticks up on the way (+6, over the 5-point floor), the portal fires at 8 s.
      setTimeout(() => { host.me.stamina = { current: 93, max: 105 }; }, 1500);
      setTimeout(() => { api.pushChat('In Portal Space - Please Wait...', 0x00); host.screenName = 'portal-space'; }, 8000);
      return true;
    };
    const r = api.use(0x7a9b4080);
    await vi.advanceTimersByTimeAsync(20_000);
    const res = await r;
    expect(res.message).toContain('In Portal Space - Please Wait...');
    expect(res.message).not.toMatch(/didn't arrive/);
  });
});
