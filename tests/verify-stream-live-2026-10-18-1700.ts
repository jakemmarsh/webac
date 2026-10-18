/**
 * Live stream, 2026-10-18 (build 4f0d4697): three agent-tool faults seen on Claude Bulwark (profile soldier),
 * soldier.log and the soldier seg1 transcript.
 *
 * 1. 17:00:40–17:04:05Z, the Qalaba'r portal ring (landblock 0x9521, cell 0x95210038): `walk_to target="Qalabar Oasis
 *    Settlement"` stood 3+ minutes 34 m short; "walk leg blocked straight … the probe stops at (28734.3, 6510.0, z 122.0)
 *    ((28731.6, 6509.8, z 122.0) without the portal / NPC disks)", then every search (wide, 80 m, jumps and drops) found
 *    none. A `use` of the same portal went through at once. Cause, proven below: the walk set off 429 m away, with the
 *    portal (#79521003, ACE-World landblock_instance at (123.558, 173.824, 122.005), Setup 0x020001B3: part radius
 *    1.919 m) out of view, so `within` was fixed at the default 2 m (no reach, no portal stand-off), while the planner's
 *    disk round the goal portal itself, once it came into view, was its reach + 0.8 = 2.72 m: (28731.6, 6509.8) is the
 *    portal's middle, the probe stopped 2.75 m from it at that disk's rim, and no point within 2 m of the middle lies
 *    outside it, so no search could ever succeed. The use's walk-in is exempt from its own portal's disk, so it went in.
 *    Now the target's reach and portal stand-off are taken in on every look; in a ring round the walk's own goal portal
 *    the other portals are kept out of at their touch (the sentinel's disk), not the wider clearance; a straight probe
 *    that stops within the goal's reach goes straight.
 * 2. 16:58:09Z: Bulwark at 27% health (no magic school; 18 healing kits and 19 health potions in his pack) was told
 *    "Heal now (ac_cast spell="Heal Self" target=self …)". He used a kit next and died before it took. The hints now
 *    offer what the character has: Heal Self only when known (with the mana), else the best kit and potion carried
 *    (named, with counts), else that nothing is carried; the stamina hints (Revitalize) likewise.
 * 3. 16:27:53Z: the walk from 0x029E01A3 (z −6) to 0x029E0143 (z −12) said its only doorway way "climbs about 6 m above
 *    both ends and comes back down"; it climbed 6 m to z 0 and went down 12 m, by a 6 m one-way drop and the ramps. The
 *    text now says each part: "climbs about 6 m, then goes down about 12 m (one way: a 6 m drop, and 6 m by stairs or
 *    ramps)".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { FakeHost } from './_harness/agentFake.ts';

const LB = 0x95210000;
const CELL = (LB | 0x38) >>> 0;
/** The Qalaba'r portal ring: ACE-World 16PY landblock 0x9521 instances (landblock-local x, y, z). */
const RING: ReadonlyArray<readonly [number, string, number, number, number]> = [
  [0x79521000, 'Brigands Bay Settlement Portal', 130.227, 171.225, 122.005],
  [0x79521001, 'Settlement Portals', 132.788, 179.53, 122.005],
  [0x79521002, 'Villalabar Portal', 139.109, 166.067, 122.488],
  [0x79521003, 'Qalabar Oasis Settlement Portal', 123.558, 173.824, 122.005],
  [0x79521004, "Simda'r Villas Portal", 117.844, 181.054, 122.364],
  [0x79521005, 'Ro-Nan Portal', 147.035, 171.898, 122.005],
  [0x79521006, "Qalaba'r Seaside Villas Portal", 147.506, 180.852, 122.005],
  [0x7952100c, 'Northreach Portal', 146.881, 188.997, 122.005],
  [0x7952100d, 'Azaroth Cottages Portal', 155.876, 171.145, 122.005],
  [0x7952100e, 'Scimitar Lake Cottages Portal', 159.856, 179.379, 122.005],
  [0x7952100f, 'Sand Shallow Cottages Portal', 162.567, 186.881, 122.005],
];
const OASIS = 0x79521003;
/** Setup 0x020001B3's part radius (the reach a Use is measured to), and where a body's sphere meets that. */
const REACH = 1.919;
const TOUCH = REACH + 0.48;
/** Where a walk_to (default within 2) arrives at a portal it was not sent into: within 2 of its reach, plus a look's slack. */
const STAND_OFF = 2 + REACH + 0.5;

/** A buffed run (11 m/s), a walk at 3.12. */
class FastHost extends FakeHost {
  override physics(dtMs: number): void {
    if (!this.keys.has('KeyW')) return;
    const speed = this.keys.has('ShiftLeft') ? 3.12 : 11;
    const step = (speed * dtMs) / 1000;
    this.me.x += -Math.sin(this.me.yaw) * step;
    this.me.y += -Math.cos(this.me.yaw) * step;
  }
}

function ringHost(at: { x: number; y: number }): { host: FastHost; api: AgentApi; traces: string[]; addRing: () => void } {
  vi.useFakeTimers();
  const host = new FastHost();
  host.wall = () => false;
  host.me = { ...host.me, name: 'Claude Bulwark', cell: CELL, x: at.x, y: at.y, z: 122 };
  const addRing = (): void => { for (const [guid, name, x, y, z] of RING) host.add({ guid, name, itemType: 0x10000, objectDescFlags: 0x40000, cell: CELL, x, y, z }); };
  addRing();
  host.objectReach = (g) => ((g & 0xffff0000) === 0x79520000 && host.objs.has(g) ? REACH : 0);
  const api = new AgentApi(host);
  const traces: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(`${(host.t / 1000).toFixed(1)} ${a.join(' ')}`); });
  return { host, api, traces, addRing };
}

/** Drive a task with a look every `lookMs`; the nearest the body came to each ring portal but `except`. */
async function drive(api: AgentApi, host: FakeHost, p: Promise<AgentResult>, ms: number, lookMs = 300, each?: () => void, except: number[] = []): Promise<{ r: AgentResult | null; closest: number }> {
  let r = null as AgentResult | null;
  void p.then((x) => { r = x; });
  let closest = Infinity;
  for (let t = 0; t < ms && !r; t += lookMs) {
    host.t += lookMs; vi.advanceTimersByTime(lookMs); host.physics(lookMs); api.tick();
    each?.();
    for (const [g, , x, y] of RING) if (!except.includes(g) && host.objs.has(g)) closest = Math.min(closest, Math.hypot(host.me.x - x, host.me.y - y));
    await Promise.resolve(); await Promise.resolve();
  }
  for (let i = 0; i < 5 && !r; i++) await Promise.resolve();
  return { r, closest };
}

const oasisDist = (host: FakeHost): number => Math.hypot(host.me.x - 123.558, host.me.y - 173.824);

describe('1. walk_to a portal in the Qalaba\'r portal ring (0x9521, 2026-10-18 17:01Z)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('set off for the remembered portal far off: once it is in view its reach and stand-off count, and the walk arrives beside it (it stood 3+ min 34 m short)', async () => {
    // Bulwark's way in: along the search's last waypoint (28767.9, 6511.7) toward the portal's middle, from 300 m out.
    const { host, api, traces, addRing } = ringHost({ x: 159.9, y: 175.7 });
    api.tick(); host.t += 100; api.tick();
    // Out of range: the client releases the ring, then drops it from its list; the places stay remembered.
    for (const o of host.objs.values()) o.lost = true;
    host.t += 100; api.tick();
    host.objs.clear();
    host.me.x = 159.9 + 299.4; host.me.y = 175.7 + 15.7;
    host.t += 100; api.tick();
    let back = false;
    const { r, closest } = await drive(api, host, api.walkTo('Qalabar Oasis Settlement'), 120_000, 300, () => {
      if (!back && host.me.x < 159.9 + 60) { back = true; addRing(); }
    }, [OASIS]);
    const why = `${JSON.stringify(r)}\n${traces.join('\n')}`;
    expect(r, why).not.toBeNull();
    expect(r!.message, why).toMatch(/^arrived/);
    // Beside it, outside its touch, within the stand-off the walk keeps from a portal it was not sent into.
    expect(oasisDist(host), why).toBeGreaterThan(TOUCH);
    expect(oasisDist(host), why).toBeLessThan(STAND_OFF);
    expect(closest, why).toBeGreaterThan(TOUCH);
    expect(traces.join('\n')).toMatch(/walk: Qalabar Oasis Settlement Portal's reach is known now \(1\.92 m, a portal\): arriving within 3\.9 m of its middle, not 2\.5/);
    // Quick, not minutes of searching: 300 m at 11 m/s, and no search came up empty.
    expect(host.t, why).toBeLessThan(45_000);
    expect(traces.join('\n')).not.toMatch(/walk search none/);
  }, 60_000);

  it('in view, its Setup not loaded yet at the start (reach 0): the reach counts as soon as it is known', async () => {
    const { host, api, traces } = ringHost({ x: 159.9, y: 175.7 });
    let loaded = false;
    host.objectReach = (g) => ((g & 0xffff0000) === 0x79520000 && (loaded || g !== OASIS) ? REACH : 0);
    const { r, closest } = await drive(api, host, api.walkTo('Qalabar Oasis Settlement'), 60_000, 300, () => { if (host.t >= 1200) loaded = true; }, [OASIS]);
    const why = `${JSON.stringify(r)}\n${traces.join('\n')}`;
    expect(r?.message, why).toMatch(/^arrived/);
    expect(oasisDist(host), why).toBeGreaterThan(TOUCH);
    expect(closest, why).toBeGreaterThan(TOUCH);
    expect(traces.join('\n')).not.toMatch(/walk search none/);
  }, 60_000);

  it('from the ring\'s middle, walk_to each of its portals: every one arrives beside its own, none touches another', async () => {
    for (const [g, name, px, py] of RING) {
      const { host, api, traces } = ringHost({ x: 140, y: 176 });
      const { r, closest } = await drive(api, host, api.walkTo(g), 45_000, 300, undefined, [g]);
      const why = `${name}: ${JSON.stringify(r)}\n${traces.join('\n')}`;
      expect(r?.message, why).toMatch(/^arrived/);
      const d = Math.hypot(host.me.x - px, host.me.y - py);
      expect(d, why).toBeGreaterThan(TOUCH);
      expect(d, why).toBeLessThan(STAND_OFF);
      expect(closest, why).toBeGreaterThan(TOUCH);
      vi.useRealTimers(); vi.restoreAllMocks();
    }
  }, 120_000);

  it('use\'s walk-in to the portal: straight into it, and the portal sentinel never stops a body heading into its own goal', async () => {
    const { host, api, traces } = ringHost({ x: 159.9, y: 175.7 });
    const { r, closest } = await drive(api, host, api.walkTo(OASIS, { within: 0.5, enterPortal: true, timeoutMs: 45_000 }), 45_000, 300, undefined, [OASIS]);
    const why = `${JSON.stringify(r)}\n${traces.join('\n')}`;
    expect(r?.message, why).toMatch(/^arrived/);
    expect(oasisDist(host), why).toBeLessThan(TOUCH);
    expect(closest, why).toBeGreaterThan(TOUCH);
    expect(traces.join('\n')).not.toMatch(/portal sentinel: [\d.]+ m from Qalabar Oasis/);
    expect(host.t, why).toBeLessThan(10_000);
  }, 60_000);

  for (const gap of [2, 3, 4]) {
    it(`a walk between two portals ${gap} m apart (the gap between their touch circles), on a line clear of both: neither the planner nor the sentinel stops it`, async () => {
      vi.useFakeTimers();
      const host = new FastHost();
      host.wall = () => false;
      const half = TOUCH + gap / 2;
      host.add({ guid: 0x7a9b3001, name: 'West Portal', itemType: 0x10000, objectDescFlags: 0x40000, x: 80 - half, y: 30 });
      host.add({ guid: 0x7a9b3002, name: 'East Portal', itemType: 0x10000, objectDescFlags: 0x40000, x: 80 + half, y: 30 });
      host.objectReach = () => REACH;
      host.me.x = 80; host.me.y = 15;
      const api = new AgentApi(host);
      const traces: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
      let r = null as AgentResult | null;
      void api.walkTo('30m north').then((x) => { r = x; });
      let closest = Infinity;
      for (let t = 0; t < 20_000 && !r; t += 300) {
        host.t += 300; vi.advanceTimersByTime(300); host.physics(300); api.tick();
        closest = Math.min(closest, Math.hypot(host.me.x - (80 - half), host.me.y - 30), Math.hypot(host.me.x - (80 + half), host.me.y - 30));
        await Promise.resolve(); await Promise.resolve();
      }
      const why = `${JSON.stringify(r)}\n${traces.join('\n')}`;
      expect(r, why).not.toBeNull();
      expect(r!.message, why).toMatch(/^arrived/);
      expect(host.me.y, why).toBeGreaterThan(40);
      expect(closest, why).toBeGreaterThan(TOUCH);
      expect(traces.join('\n')).not.toMatch(/portal sentinel:/);
    }, 30_000);
  }
});

describe('1. a straight way that stops within the goal\'s reach goes straight (no search for its middle)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('a statue whose collision stops the probe 2.85 m from its middle, inside its 3 m reach but past the reach\'s edge point: straight there, arrived', async () => {
    vi.useFakeTimers();
    const host = new FastHost();
    // Its collision: a 2.85 m disk round its middle (the probe stops there), wider than its 1 m reach + 2 m of `within`
    // less the 0.3 m slack the edge rule aims at (2.7 m).
    host.wall = (x, y) => Math.hypot(x - 80, y - 60) < 2.85;
    host.add({ guid: 0x80000a01, name: 'Statue of Asheron', itemType: 0x200, x: 80, y: 60 });
    host.objectReach = (g) => (g === 0x80000a01 ? 1 : 0);
    host.me.x = 80; host.me.y = 20;
    const api = new AgentApi(host);
    const traces: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
    let r = null as AgentResult | null;
    void api.walkTo('Statue of Asheron').then((x) => { r = x; });
    for (let t = 0; t < 30_000 && !r; t += 100) {
      host.t += 100; vi.advanceTimersByTime(100); host.physics(100); api.tick();
      await Promise.resolve(); await Promise.resolve();
    }
    const why = `${JSON.stringify(r)}\n${traces.join('\n')}`;
    expect(r?.message, why).toMatch(/^arrived/);
    expect(traces.join('\n')).toMatch(/the straight way stops 2\.9 m from its middle, within its reach \(3\.0 m\)/);
    expect(traces.join('\n')).not.toMatch(/walk leg blocked straight/);
    expect(host.t, why).toBeLessThan(8_000);
  }, 30_000);
});

describe('1. in a tight ring, the way in to the goal portal passes its neighbours at their touch', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('two neighbours 5.3 m apart flank the way in from the south: straight between them (at the clearance they walled it off)', async () => {
    vi.useFakeTimers();
    const host = new FastHost();
    host.wall = () => false;
    host.add({ guid: 0x7a9b3010, name: 'Goal Portal', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 40 });
    host.add({ guid: 0x7a9b3011, name: 'West Neighbour Portal', itemType: 0x10000, objectDescFlags: 0x40000, x: 77.35, y: 36.6 });
    host.add({ guid: 0x7a9b3012, name: 'East Neighbour Portal', itemType: 0x10000, objectDescFlags: 0x40000, x: 82.65, y: 36.6 });
    host.objectReach = () => REACH;
    host.me.x = 80; host.me.y = 15;
    const api = new AgentApi(host);
    const traces: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
    let r = null as AgentResult | null;
    void api.walkTo('Goal Portal').then((x) => { r = x; });
    let closest = Infinity;
    for (let t = 0; t < 30_000 && !r; t += 300) {
      host.t += 300; vi.advanceTimersByTime(300); host.physics(300); api.tick();
      closest = Math.min(closest, Math.hypot(host.me.x - 77.35, host.me.y - 36.6), Math.hypot(host.me.x - 82.65, host.me.y - 36.6));
      await Promise.resolve(); await Promise.resolve();
    }
    const why = `${JSON.stringify(r)}\n${traces.join('\n')}`;
    expect(r?.message, why).toMatch(/^arrived/);
    // On the south side, the way it came; never round to the north.
    expect(host.me.y, why).toBeLessThan(40);
    expect(Math.hypot(host.me.x - 80, host.me.y - 40), why).toBeGreaterThan(TOUCH);
    expect(closest, why).toBeGreaterThan(TOUCH);
    expect(traces.join('\n')).not.toMatch(/walk leg blocked straight/);
  }, 30_000);
});

describe('2. the heal hints offer what the character can do (Bulwark, no magic, 2026-10-18 16:58:09Z)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const GRIEVVER = 0x80004201;
  const KITS = { guid: 0x80001001, name: 'Excellent Healing Kit', where: 'pack', stack: 1, value: 1000 };
  const setup = (spells: Array<{ id: number; name: string; school: string; level?: number; self?: boolean }>, inv: Array<{ guid: number; name: string; where: string; stack?: number; value?: number }>): { host: FakeHost; api: AgentApi } => {
    vi.useFakeTimers();
    const host = new FakeHost();
    host.spells = () => spells;
    host.inv = inv;
    host.wall = () => false;
    host.me.health = { current: 205, max: 205 };
    host.add({ guid: GRIEVVER, name: 'Scorching Flame', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 16 });
    const api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (let t = 0; t < 200; t += 100) { host.t += 100; api.tick(); }
    return { host, api };
  };
  const fleeToCritical = async (host: FakeHost, api: AgentApi): Promise<AgentResult> => {
    let r = null as AgentResult | null;
    void api.walkTo('200m north', { within: 1, flee: true, onAwayKeepGoing: true }).then((x) => { r = x; });
    for (let t = 0; t < 30_000 && !r; t += 100) {
      if (t % 1000 === 0) {
        host.me.health = { ...host.me.health, current: Math.max(0, host.me.health.current - 22) };
        api.pushChat('Reckless! Scorching Flame scorches your lower leg for 22 points of fire damage!', 0x15);
      }
      host.t += 100; vi.advanceTimersByTime(100); host.physics(100); api.tick();
      await Promise.resolve(); await Promise.resolve();
    }
    return r!;
  };

  it('no magic, kits and potions in the pack: the critical stop names the best kit and the potion with their counts, not Heal Self', async () => {
    // Bulwark's pack at 16:58: 18 Excellent Healing Kits (single items) and a stack of 19 Potions of Healing.
    const kits = Array.from({ length: 18 }, (_, i) => ({ ...KITS, guid: 0x80001001 + i }));
    const { host, api } = setup([], [...kits, { guid: 0x80002001, name: 'Healing Kit', where: 'pack', stack: 3, value: 60 }, { guid: 0x80003001, name: 'Potion of Healing', where: 'Pack', stack: 19, value: 170 * 19 }]);
    const r = await fleeToCritical(host, api);
    expect(r.critical, r.message).toBe(true);
    expect(r.message).toMatch(/Heal or keep running\? Heal now \(a kit: ac_use item="Excellent Healing Kit" \(you carry 18; also Healing Kit ×3\), or a potion: ac_use item="Potion of Healing" \(you carry 19\)\), or run on/);
    expect(r.message).not.toMatch(/Heal Self/);
  }, 30_000);

  it('Heal Self known and the mana for it: offered first, with the kit after it', async () => {
    const { host, api } = setup([{ id: 1162, name: 'Heal Self V', school: 'Life Magic', level: 5, self: true }], [KITS]);
    Object.assign(host, { spellTableData: () => ({ spells: new Map([[1162, { name: 'Heal Self V', desc: '', category: 67, school: 4, bitfield: 0, power: 200, baseMana: 30 }]]) }) });
    host.me.mana = { current: 60, max: 98 };
    expect(api.restoreOptions('health').text).toBe('ac_cast spell="Heal Self" target=self (Heal Self V; you\'re standing, as a cast needs); or a kit: ac_use item="Excellent Healing Kit" (you carry 1)');
    // Without the mana for a cast: the kit, and why not the spell.
    host.me.mana = { current: 12, max: 98 };
    expect(api.restoreOptions('health').text).toBe('a kit: ac_use item="Excellent Healing Kit" (you carry 1) (you know Heal Self V but have 12 mana, and it costs up to 30)');
  });

  it('nothing to heal with and no heal spell: said so (no suggestion it cannot follow)', async () => {
    const { host, api } = setup([], [{ guid: 0x80004001, name: 'Lugian Hammer', where: 'equipped' }]);
    const r = await fleeToCritical(host, api);
    expect(r.message).toMatch(/Heal now \(you carry nothing to heal with and know no spell for it\), or run on/);
  }, 30_000);

  it('exhausted with no Revitalize: the stamina hint names the stamina potion carried, not a Revitalize', async () => {
    const { host, api } = setup([], [{ guid: 0x80005001, name: 'Stamina Tincture', where: 'pack', stack: 10, value: 500 }]);
    host.me.stamina = { current: 0, max: 291 };
    host.t += 100; api.tick();
    const evs = await api.wait({ types: ['vitals-low'] }, 10);
    const text = evs.map((e) => e.text).join('\n');
    expect(text).toMatch(/stamina 0\/291: EXHAUSTED.*Bring it back: a potion: ac_use item="Stamina Tincture" \(you carry 10\); out of a combat stance/s);
    expect(text).not.toMatch(/Revitalize/);
  });
});

describe('3. a doorway way up and over says what it does, drops included (0x029E01A3 → 0x029E0143, 2026-10-18 16:27:53Z)', () => {
  it('climbs 6 m from z −6 to 0, then down 12 m to z −12 by a 6 m drop and the ramps', () => {
    expect(AgentApi.routeClimbText({ up: 6, down: 12, drops: 1, dropM: 6 })).toBe('climbs about 6 m, then goes down about 12 m (one way: a 6 m drop, and 6 m by stairs or ramps)');
  });
  it('all of the way down by drops, and a way down by stairs alone', () => {
    expect(AgentApi.routeClimbText({ up: 6, down: 12, drops: 2, dropM: 12 })).toBe('climbs about 6 m, then goes down about 12 m (one way: 2 drops, 12 m in all)');
    expect(AgentApi.routeClimbText({ up: 14, down: 14, drops: 0, dropM: 0 })).toBe('climbs about 14 m, then goes down about 14 m');
  });
  it('a walk whose route climbs from −6 to 0 and drops to −12: its answer says so', async () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const UPPER = 0x029e01a3, LOWER = 0x029e0143;
      host.wall = () => false;
      host.me.cell = UPPER; host.me.x = 80; host.me.y = 20; host.me.z = -6;
      host.routeTo = [{ x: 85, y: 20, z: 0 }, { x: 90, y: 20, z: 0 }, { x: 95, y: 20, z: -12 }];
      host.add({ guid: 0x80000077, name: 'Chest', itemType: 0x200, cell: LOWER, x: 100, y: 20, z: -12 });
      const api = new AgentApi(host);
      let r = null as AgentResult | null;
      void api.walkTo(0x80000077, { timeoutMs: 10_000 }).then((x) => { r = x; });
      for (let t = 0; t < 120_000 && !r; t += 100) {
        host.t += 100; vi.advanceTimersByTime(100); host.physics(100); api.tick();
        await Promise.resolve(); await Promise.resolve();
      }
      expect(r?.message).toMatch(/the only doorway way there climbs about 6 m, then goes down about 12 m: no doorway, stair or ramp on your floor joins your room to it/);
      expect(r?.message).not.toMatch(/above both ends/);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  }, 60_000);
});
