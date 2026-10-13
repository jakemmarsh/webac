/**
 * Jake's prod session (2026-10-12): `ac_use <portal>` while being hit answered "couldn't reach … stopped 11.9 m short:
 * you're under attack"; the character stood, the pack closed in and body-blocked him, and Jake took over to reach the
 * portal. Using a portal is asking to get there: the walk keeps going through the hits (walk_to flee=true's rule), and
 * `ac_use flee=true` asks the same for anything else. Creatures blocking the body are walked round (the open direction
 * nearest the way on that none stands in) before a walk says it is hemmed in. Driven through the real AgentApi on the
 * fake host, and the real tool table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { TOOLS, TOOL_CALLER, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { HOSTED_GUIDE } from '../tools/ac-agent/hostedGuide.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('ac_use under attack', () => {
  let host: FakeHost;
  let api: AgentApi;
  const PORTAL = 0x7adb5036;
  const DOOR = 0x7adb5037;
  const DRUDGE = 0x80004101;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.wall = () => false;
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const drudge = (x: number, y: number, guid = DRUDGE): void => { host.add({ guid, name: 'Drudge Servant', itemType: 0x10, objectDescFlags: 0x10, x, y }); };
  const hit = (): void => api.pushChat('The Drudge Servant nicks your lower leg for 6 points of piercing damage!', 0x15);
  // Through the portal once within a metre of it.
  const portalSpace = (): void => {
    if (host.screenName === 'world' && Math.hypot(host.me.x - 80, host.me.y - 32) < 1) { host.screenName = 'portal-space'; host.me.x = 10; host.me.y = 170; }
  };

  it('a portal 12 m off with a drudge chewing on you: walks there through the hits and goes through', async () => {
    host.add({ guid: PORTAL, name: 'Dungeon Fern', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 32 });
    drudge(80.5, 18.8);
    hit();
    let n = 0;
    const r = (await settle(api, host, api.use(PORTAL), 40_000, () => { portalSpace(); if (++n % 10 === 0 && host.screenName === 'world') hit(); }))!;
    expect(r).toMatchObject({ ok: true });
    expect(r.message).toMatch(/^used Dungeon Fern: walked into it through the hits and through/);
    expect(host.screenName).toBe('portal-space');
  });

  it('a door: being hit stops the walk by default; flee=true keeps going', async () => {
    // Inside a building, a doorway between (a cell route): the use walks there itself.
    host.me.cell = 0xa9b40150;
    host.routeTo = [{ x: 80, y: 26, z: 94 }];
    host.add({ guid: DOOR, name: 'Door', itemType: 0x80, objectDescFlags: 0x1000, cell: 0xa9b40151, x: 80, y: 32 });
    drudge(80.5, 18.8);
    const p = api.use(DOOR);
    run(api, host, 300);
    hit();
    const r = (await settle(api, host, p, 20_000))!;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/couldn't reach Door: stopped [\d.]+ m short: you're under attack/);
    host.me.y = 20;
    const q = api.use(DOOR, { flee: true });
    run(api, host, 300);
    hit();
    await settle(api, host, q, 20_000);
    expect(Math.hypot(host.me.x - 80, host.me.y - 32)).toBeLessThan(3.5);
  });

  it('the ac_use tool passes flee=true through, and leaves it off by default', async () => {
    const seen: unknown[][] = [];
    const caller: ToolCaller = { notice: null, call: async <T,>(m: string, a?: unknown[]) => { seen.push([m, ...(a ?? [])]); return { ok: true, message: 'used' } as T; } };
    const tool = TOOLS.find((t) => t.name === 'ac_use')!;
    await TOOL_CALLER.run(caller, () => tool.run({ target: 'Door', flee: true }));
    await TOOL_CALLER.run(caller, () => tool.run({ target: 'Door' }));
    expect(seen).toEqual([['use', 'Door', { flee: true }], ['use', 'Door']]);
  });

  it('monsters body-blocking the way: steps round them toward the open side, saying who, then goes on', async () => {
    // Two drudges abreast across the way north; their bodies stop yours (the walk's probe leaves creatures out).
    drudge(80, 22);
    drudge(81.2, 22, 0x80004102);
    const blocked = (x: number, y: number): boolean => y > 21.2 && y < 22.8 && x > 79 && x < 82.2;
    const physics = host.physics.bind(host);
    host.physics = (dt: number) => { const { x, y } = host.me; physics(dt); if (blocked(host.me.x, host.me.y)) { host.me.x = x; host.me.y = y; } };
    const p = api.walkTo('20m north', { within: 1, flee: true });
    hit();
    const r = (await settle(api, host, p, 30_000))!;
    expect(r.ok).toBe(true);
    expect(host.me.y).toBeGreaterThan(38);
    expect(api.eventsSince(0).some((e) => /\[Agent\] hemmed in by Drudge Servant [\d.]+ m N.*: stepping (W|NW|WNW|WSW|SW) to get round them/.test(e.text))).toBe(true);
  });

  it('the hosted guide says to commit to an exit before you are surrounded', () => {
    expect(HOSTED_GUIDE).toMatch(/Monsters body-block: commit to an exit \(a portal, a door\) early, before you're surrounded/);
  });
});
