/**
 * cast repeat=true and a higher-level newcomer (Claude Arcanist's report, 2026-10-18 01:35Z, item 4): a level-49 mage
 * hunting level-60 Dread Mu-miyahs that hit for 1–4 had every repeat stopped by each new one "above your level", and
 * recast for nearly every target in a pack. Now one above you stops it only while its danger is unknown (none of its
 * kind has hit you yet) or when it is CAST_REPEAT_FAR_ABOVE_LEVELS (15) or more above; once its hits stayed under a
 * tenth of your health it is cast on through and named mild. Casters and hard hitters stop it as before.
 * Drives the real AgentApi against the fake host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const TARGET = 0x80000301;
const NEWCOMER = 0x80000302;

describe('cast repeat: a higher-level newcomer whose hits are mild is cast on through', () => {
  let host: FakeHost;
  let api: AgentApi;
  let reply: (n: number) => void;
  let castsSent: number;

  const creature = (guid: number, name: string, x: number, y: number, level: number): void => {
    host.add({ guid, name, itemType: 0x10, objectDescFlags: 0x10, x, y, level });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    api = new AgentApi(host);
    host.me.level = 49;
    host.me.health = { current: 300, max: 300 };
    host.me.mana = { current: 600, max: 600 };
    host.spells = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1, projectile: true, range: 20 }];
    (host as unknown as { lineOfFire: () => { dist: number; blockedAt: null } }).lineOfFire = () => ({ dist: 8, blockedAt: null });
    creature(TARGET, 'Dread Mu-miyah', 80, 28, 60);
    castsSent = 0;
    reply = () => api.pushChat('You scorch Dread Mu-miyah for 40 points with Flame Bolt I.', 0x16);
    host.cast = (id: number, t: number | null) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      const n = ++castsSent;
      setTimeout(() => { host.me.mana.current -= 10; reply(n); }, 600);
      return true;
    };
  });
  afterEach(() => vi.useRealTimers());

  async function settle(p: Promise<AgentResult>, ms = 60_000): Promise<AgentResult> {
    let out: AgentResult | undefined;
    void p.then((r) => { out = r; });
    for (let t = 0; t < ms && out === undefined; t += 200) await vi.advanceTimersByTimeAsync(200);
    if (!out) throw new Error('repeat never answered');
    return out;
  }

  it('an L60 newcomer hitting for 2 does not stop it after its first hit; the summary names it mild and lists its hits', async () => {
    creature(NEWCOMER, 'Withered Mu-miyah', 83, 20, 60);
    reply = (n) => {
      api.pushChat('You scorch Dread Mu-miyah for 40 points with Flame Bolt I.', 0x16);
      if (n === 1) api.pushChat('The Withered Mu-miyah hits your leg for 2 points of slashing damage!', 0x15);
      if (n === 2) api.pushChat('The Withered Mu-miyah hits your arm for 1 point of slashing damage!', 0x15);
      if (n === 4) host.dying.add(TARGET);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Dread Mu-miyah', { repeat: true }));
    expect(castsSent).toBe(4);
    expect(r.message.split('\n')[0]).toBe('cast Flame Bolt I at Dread Mu-miyah 4 times (repeat); stopped: Dread Mu-miyah died');
    expect(r.message).toContain('joined in meanwhile: Withered Mu-miyah #80000302 (hits up to 2; level 60, above your 49: mild, its hits so far under 10% of your health)');
    expect(r.message).toContain('hits on you meanwhile: 2 for 3 (Withered Mu-miyah 2 for 3)');
  });

  it('an L60 newcomer that has not hit you yet still stops it', async () => {
    creature(NEWCOMER, 'Withered Mu-miyah', 83, 20, 60);
    reply = (n) => {
      api.pushChat('You scorch Dread Mu-miyah for 40 points with Flame Bolt I.', 0x16);
      if (n === 1) api.pushChat('The Withered Mu-miyah misses you!', 0x15);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Dread Mu-miyah', { repeat: true }));
    expect(castsSent).toBe(1);
    expect(r.message.split('\n')[0]).toBe("cast Flame Bolt I at Dread Mu-miyah 1 time (repeat); stopped: Withered Mu-miyah #80000302 (1× in 10 s; level 60, above your 49, and it hasn't hit you yet) started attacking you, and isn't your target");
  });

  it('an L75 newcomer stops it however light its hit', async () => {
    creature(NEWCOMER, 'Mu-miyah Grave Lord', 83, 20, 75);
    reply = (n) => {
      api.pushChat('You scorch Dread Mu-miyah for 40 points with Flame Bolt I.', 0x16);
      if (n === 1) api.pushChat('The Mu-miyah Grave Lord hits your leg for 2 points of slashing damage!', 0x15);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Dread Mu-miyah', { repeat: true }));
    expect(castsSent).toBe(1);
    expect(r.message.split('\n')[0]).toMatch(/stopped: Mu-miyah Grave Lord #80000302 \(1× in 10 s; level 75, 26 above your 49 \(15\+ above stops it whatever its hits\)\) started attacking you/);
  });

  it('an L63 newcomer at 14 above whose hits are light carries on (the margin is 15)', async () => {
    expect(AgentApi.CAST_REPEAT_FAR_ABOVE_LEVELS).toBe(15);
    creature(NEWCOMER, 'Withered Mu-miyah', 83, 20, 63);
    reply = (n) => {
      api.pushChat('You scorch Dread Mu-miyah for 40 points with Flame Bolt I.', 0x16);
      if (n === 1) api.pushChat('The Withered Mu-miyah hits your leg for 4 points of slashing damage!', 0x15);
      if (n === 3) host.dying.add(TARGET);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Dread Mu-miyah', { repeat: true }));
    expect(castsSent).toBe(3);
    expect(r.message.split('\n')[0]).toBe('cast Flame Bolt I at Dread Mu-miyah 3 times (repeat); stopped: Dread Mu-miyah died');
  });

  it('a higher-level newcomer that hits for a tenth of your health stops it as before', async () => {
    creature(NEWCOMER, 'Withered Mu-miyah', 83, 20, 60);
    reply = (n) => {
      api.pushChat('You scorch Dread Mu-miyah for 40 points with Flame Bolt I.', 0x16);
      if (n === 1) api.pushChat('The Withered Mu-miyah hits your chest for 35 points of slashing damage!', 0x15);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Dread Mu-miyah', { repeat: true }));
    expect(castsSent).toBe(1);
    expect(r.message.split('\n')[0]).toMatch(/stopped: Withered Mu-miyah #80000302 \(1× in 10 s; one hit of its took 35, 12% of the 300 health you have\)/);
  });

  it('a caster newcomer stops it, even one below your level', async () => {
    creature(NEWCOMER, 'Mu-miyah Shaman', 83, 20, 40);
    api.pushChat('Mu-miyah Shaman casts Drain Health Other I and drains 2 points of your health.', 0x07);
    reply = (n) => {
      api.pushChat('You scorch Dread Mu-miyah for 40 points with Flame Bolt I.', 0x16);
      if (n === 1) api.pushChat('The Mu-miyah Shaman misses you!', 0x15);
    };
    const r = await settle(api.cast('Flame Bolt I', 'Dread Mu-miyah', { repeat: true }));
    expect(castsSent).toBe(1);
    expect(r.message.split('\n')[0]).toMatch(/stopped: Mu-miyah Shaman #80000302 \(1× in 10 s; it casts Drain Health Other I\) started attacking you/);
  });
});

/**
 * walk_to a monster a storey up indoors (Bulwark's report, 2026-10-18 01:37Z, item 2): walk_to #80004738, a Dread
 * stuck on a ledge 6 m over him in Mountain Keep, answered "arrived (2.2 m from Dread Mu-miyah)" mid-route up, and the
 * attack 4 s later found it 15 m E, 6 m up. A monster goal seen a storey (OTHER_FLOOR_M) off during the walk counts as
 * reached only once it has stayed within reach on your floor for PLAYER_ARRIVE_CONFIRM_MS, not on one look.
 */
describe('walk_to a monster on another floor indoors: arrived only on its storey', () => {
  const CELL = 0xa9b40150;
  const DREAD = 0x80004738;
  let host: FakeHost;
  let api: AgentApi;

  async function settle<T>(p: Promise<T>, ms: number, each?: (t: number) => void): Promise<T | null> {
    let out: T | null = null;
    let done = false;
    void p.then((x) => { out = x; done = true; });
    for (let t = 0; t < ms && !done; t += 100) { each?.(t); run(api, host, 100, { physics: true }); await Promise.resolve(); await Promise.resolve(); }
    return out;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.cell = CELL; host.me.x = 50; host.me.y = 20; host.me.z = 94;
    // A ledge at 100 over x 70–90 (no way up to it from the hall at 94).
    host.floors = (x, y) => (x < 30 || x > 110 || y < 0 || y > 40 ? [] : x >= 70 && x <= 90 ? [94, 100] : [94]);
    host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, level: 60, cell: CELL, x: 80, y: 20, z: 100 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('a one-look blip of it beside you on your floor is not "arrived"', async () => {
    const o = host.objs.get(DREAD)!;
    const r = await settle(api.walkTo(DREAD), 90_000, (t) => {
      // At 1 s the client shows it beside you for one look (a stale or interpolated position), then back on its ledge.
      if (t === 1000) { o.x = host.me.x + 1.5; o.y = host.me.y; o.z = host.me.z; }
      if (t === 1100) { o.x = 80; o.y = 20; o.z = 100; }
    });
    expect(r?.message ?? '').not.toMatch(/^arrived/);
    // The walk's own storey answer: no way up from the hall.
    expect(r?.message).toMatch(/it is 6 m above you, on another floor, and no way up to that floor was found from here/);
  });

  it('one that comes down and stays beside you on your floor is arrived at', async () => {
    const o = host.objs.get(DREAD)!;
    const r = await settle(api.walkTo(DREAD), 20_000, (t) => {
      if (t === 1000) { o.x = 60; o.y = 20; o.z = 94; }
    });
    expect(r?.message).toMatch(/^arrived \(\d+\.\d m from Dread Mu-miyah\)/);
  });

  it('one on your floor all along is arrived at as before', async () => {
    const o = host.objs.get(DREAD)!;
    o.x = 60; o.z = 94;
    const r = await settle(api.walkTo(DREAD), 20_000);
    expect(r?.message).toMatch(/^arrived \(\d+\.\d m from Dread Mu-miyah\)/);
  });
});
