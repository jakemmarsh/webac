/**
 * Stream segment 2026-10-17 19:50–20:53Z (end of retail, local ACE, build 114eb24b), Claude Arcanist (mage) and Claude
 * Bulwark (soldier): the Al-Jalima drop, then Mountain Keep (landblock 0x01D2). What each report item turned out to be,
 * from the transcripts (stream/sessions/{mage,soldier}-2026-10-17-seg2.jsonl), the page logs and ace_shard:
 *
 * 1. "Bought 12 Stamina Elixirs, inventory showed 1": the buy went through whole. 8,433 → 4,062 pyreals (2,790 + 1,581)
 *    and ace_shard still holds #8000E175 Stamina Elixir x12 in his main pack (container 0x500000A4). ACE's buy makes a
 *    new stack (Vendor.ItemProfileToWorldObjects → Player.TryCreateInInventoryWithNetworking, no merge), as retail's
 *    pack shows a second icon, and the client had it (the buy's own wait returned on the stack arriving, 0.26 s after
 *    the Buy). He never listed his inventory after; each `use "Stamina Elixir"` took the old 3-stack #8000cd92, whose
 *    "3 → 2", "2 → 1" and "gone from your pack" he read as all he had. Now the buy says where it landed and the total,
 *    and a use's stack line names the other stacks of that item.
 * 2. The first `vendor` at Sedor Wystan (19:54:02Z) ended on "You're no longer protected by the Lifestone's magic!" (his
 *    own status line, taken for the Use's answer) and said "no shop window opened"; ACE opens the shop after the vendor
 *    turns to you (Vendor.ActOnUse: ApproachVendor after Rotate's time; UseDone at once, 19:54:03.644Z). Self-status lines
 *    are no answer now, and a vendor's use waits for its window.
 * 3. The flee walk from the Al-Jalima drop (19:53:02Z): two L110/L160 undead on him at 40 HP; he died 1.06 s in. The
 *    straight 49 m to the Portal to Town Network stopped 2.8 m short at that portal's own disk (the trace: "the probe
 *    stops at (25627.3, 26250.8) … (25627.6, 26253.6) without the portal / NPC disks"), so the last leg searched instead
 *    of running. 0d4e5b6e's stop_on_aggro / flee changes don't touch it. A last leg is straight when the line reaches the
 *    goal's reach; the answer says how long after the first hit, and that the walk hadn't set off.
 * 4. "closing, 8 m nearer in 3 s" for Dread #8000f75b 11 m below (20:36:00Z): comingAt measured closing across floors.
 * 5. walk_to line=true "arrived (1.7 m away); the line of fire to it is open", then the bolt hit nothing and the next
 *    check found Dread #8000f372 12.9 m off and 6 m up (20:32:06–17Z; observe at 20:32:48Z: 13.2 m E, up 6 m). Both the
 *    walk and the cast call the same lineOfFire (same eye, same statics); the difference was the target point: the
 *    client played its MoveTo down to her while the server held it upstairs. The line is now checked to the server's
 *    spot too when the two have split by a storey or 6 m.
 * 6. `raise attribute="Stamina"` raised Maximum Stamina (20:23:25Z) with no word that Stamina is a vital.
 * 7. "arrived (0.1 m away)" at where Dread #8000f2b7 was last seen, with it 5 m W (20:41:40Z): arrivals say what the
 *    distance is from.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ItemType } from '@ac/shared';
import { AgentApi, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { RAISE_WORD, TOOL_BY_NAME, TOOL_CALLER, raiseWord, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: (t: number) => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(t); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

let host: FakeHost;
let api: AgentApi;
let traces: string[];
beforeEach(() => {
  vi.useFakeTimers();
  host = new FakeHost();
  host.wall = () => false;
  api = new AgentApi(host);
  traces = [];
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => { traces.push(String(m)); });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('1. a bought stack beside one you carry (Bulwark, 12 Stamina Elixirs at the Al-Jalima Healer, 19:59:33Z)', () => {
  const OLD = 0x8000cd92, NEW = 0x8000e175, ITEM = 0x8000e1ab;

  it('the buy says where the 12 went (a new stack) and that 15 are carried in 2 stacks', async () => {
    host.me = { ...host.me, pyreals: 8433 };
    host.inv = [{ guid: OLD, name: 'Stamina Elixir', where: 'pack', stack: 3 }];
    host.vendorOpen = { name: 'Healer', guid: 0x7a7b4002, currency: 'Pyreals', items: [{ guid: ITEM, name: 'Stamina Elixir', price: 233 }] };
    host.vendorBuy = (g, n) => {
      host.sent.push(`buy ${g.toString(16)} x${n}`);
      setTimeout(() => { host.me = { ...host.me, pyreals: 8433 - 2790 }; host.inv = [...host.inv, { guid: NEW, name: 'Stamina Elixir', where: 'pack', stack: 12 }]; }, 250);
      return true;
    };
    const r = (await settle(api, host, api.buyReported('Stamina Elixir', 12), 8000))!;
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^bought 12 Stamina Elixir for 2790 pyreals; in your main pack: #8000e175 x12 \(a new stack\); you carry 15 Stamina Elixir in all, in 2 stacks \(#8000cd92 x3, #8000e175 x12\)/);
  });

  it('a use of the old stack names the 12 still carried, down to its last ("gone from your pack" read as none left)', async () => {
    host.inv = [{ guid: OLD, name: 'Stamina Elixir', where: 'pack', stack: 1 }, { guid: NEW, name: 'Stamina Elixir', where: 'pack', stack: 12 }];
    host.add({ guid: OLD, name: 'Stamina Elixir', cell: null, x: 0, y: 0 });
    host.use = (g) => {
      host.sent.push(`use ${g.toString(16)}`);
      setTimeout(() => { api.pushChat('The Stamina Elixir restores 65 points of your Stamina.', 0x05); host.inv = host.inv.filter((i) => i.guid !== OLD); }, 600);
      return true;
    };
    const r = (await settle(api, host, api.use(OLD), 8000))!;
    expect(r.message).toContain('gone from your pack: Stamina Elixir #8000cd92 (and 12 more in another stack: #8000e175 x12)');
  });

  it('one stack alone reads as before: no other-stacks note', async () => {
    host.inv = [{ guid: OLD, name: 'Stamina Elixir', where: 'pack', stack: 3 }];
    host.add({ guid: OLD, name: 'Stamina Elixir', cell: null, x: 0, y: 0 });
    host.use = () => { setTimeout(() => { host.inv = [{ guid: OLD, name: 'Stamina Elixir', where: 'pack', stack: 2 }]; api.pushChat('The Stamina Elixir restores 65 points of your Stamina.', 0x05); }, 600); return true; };
    const r = (await settle(api, host, api.use(OLD), 8000))!;
    expect(r.message).toMatch(/Stamina Elixir: 3 → 2$/m);
  });
});

describe('2. vendor: the shop opens after the vendor turns to you; your own status lines are no answer (19:54:02Z)', () => {
  const SEDOR = 0x7a9b4026;
  const open = { name: 'Sedor Wystan the Blacksmith', guid: SEDOR, currency: 'Pyreals', items: [{ guid: 0x8000d971, name: 'Chainmail Basinet', price: 1750 }] };

  it('a Lifestone-protection line before the window does not end the wait: the first call opens it', async () => {
    host.add({ guid: SEDOR, name: 'Sedor Wystan the Blacksmith', itemType: 0x10, objectDescFlags: 0x200, x: 80.8, y: 20.5 });
    host.use = (g) => {
      host.sent.push(`use ${g.toString(16)}`);
      setTimeout(() => api.pushChat("You're no longer protected by the Lifestone's magic!", 0x11), 200);
      // ACE: UseDone at once, the ApproachVendor after the vendor's Rotate (here 2.4 s).
      setTimeout(() => { host.vendorOpen = open; }, 2400);
      return true;
    };
    const r = (await settle(api, host, api.vendorAt('Sedor Wystan the Blacksmith'), 20_000))!;
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^\(used Sedor Wystan the Blacksmith to open its window\)\nSedor Wystan the Blacksmith sells/);
    expect(host.sent.filter((s) => s.startsWith('use '))).toHaveLength(1);
  });

  it('a vendor that never opens still says so (the wait is bounded)', async () => {
    host.add({ guid: SEDOR, name: 'Sedor Wystan the Blacksmith', itemType: 0x10, objectDescFlags: 0x200, x: 80.8, y: 20.5 });
    host.use = () => { setTimeout(() => api.pushChat('Sedor Wystan the Blacksmith tells you, "Not now."', 0x03), 200); return true; };
    const r = (await settle(api, host, api.vendorAt('Sedor Wystan the Blacksmith'), 30_000))!;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/vendor window did not open/);
    expect(r.message).toMatch(/no shop window opened for Sedor Wystan the Blacksmith/);
  });

  it('a spell expiring is no answer to an item used on a target either', async () => {
    host.inv = [{ guid: 0x80000101, name: 'Healing Kit', where: 'pack', stack: 1 }];
    host.add({ guid: 0x50000002, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 21 });
    host.useWithTarget = () => {
      setTimeout(() => api.pushChat('Incantation of Strength Other has expired.', 0x11), 100);
      setTimeout(() => api.pushChat('You heal Claude Arcanist for 40 points.', 0x05), 2500);
      return true;
    };
    const r = (await settle(api, host, api.useOnReported('Healing Kit', 'Claude Arcanist'), 15_000))!;
    expect(r.message).toContain('You heal Claude Arcanist for 40 points.');
  });
});

describe('3. a last leg to a portal runs straight to its reach, not a search (the Al-Jalima flee walk, 19:53:02Z)', () => {
  const PORTAL = 0x8588f001;

  it('walk_to the portal 40 m off over open ground: straight to its edge, never "blocked straight; searching"', async () => {
    host.objectReach = (g) => (g === PORTAL ? 2 : 0);
    host.add({ guid: PORTAL, name: 'Portal to Town Network', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 60, z: 94 });
    const r = (await settle(api, host, api.walkTo('Portal to Town Network', { flee: true }), 30_000))!;
    expect(r.ok, r.message).toBe(true);
    expect(traces.some((l) => /walk leg straight 40\.0 m to .*\(to its reach, \d\.\d m from its middle\)/.test(l)), traces.join('\n')).toBe(true);
    expect(traces.some((l) => /leg blocked straight; searching/.test(l))).toBe(false);
    expect(r.message).toMatch(/^arrived \(\d\.\d m from Portal to Town Network\)/);
  });

  it('a wall on the way still searches round it', async () => {
    host.objectReach = (g) => (g === PORTAL ? 2 : 0);
    host.add({ guid: PORTAL, name: 'Portal to Town Network', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 60, z: 94 });
    host.wall = (x, y) => y > 39.5 && y < 40.5 && x > 70 && x < 90;
    void api.walkTo('Portal to Town Network', { flee: true });
    run(api, host, 1000);
    expect(traces.some((l) => /leg blocked straight; searching/.test(l)), traces.join('\n')).toBe(true);
  });

  it('a flee walk hit while it stands searching says how soon after the hit it ended, and that it had not set off', async () => {
    host.objectReach = (g) => (g === PORTAL ? 2 : 0);
    host.add({ guid: PORTAL, name: 'Portal to Town Network', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 60, z: 94 });
    // A wall makes the leg a search (seconds, as on the stream machine): hit, then dead, before any step.
    // A long wall 2 m ahead, its end far off: the walk stands searching for the way round when the hits come.
    host.wall = (x, y) => y > 21.5 && y < 22.5 && x > -60 && x < 140;
    host.me.health = { current: 150, max: 162 };
    host.add({ guid: 0x8000d89d, name: 'Old Zombie', itemType: 0x10, objectDescFlags: 0x10, level: 110, x: 80, y: 18, seeks: { guid: host.me.guid, kind: 'stick' } });
    const p = api.walkTo('Portal to Town Network', { flee: true });
    const r = (await settle(api, host, p, 5000, (t) => {
      if (t === 100) { host.me.health = { current: 133, max: 162 }; api.pushChat('Old Zombie bashes your head for 17 points of bludgeoning damage!', 0x15); }
      if (t === 300) { host.me.health = { current: 0, max: 162 }; host.me.dead = true; }
    }))!;
    expect(r.message).toMatch(/you did NOT get away: you moved 0\.\d m in the 0\.\d s after the first hit \(the walk had not set off yet: it was still searching for a way, the straight line being blocked\)/);
  });
});

describe('4. "closing" counts only on your floor (Dread #8000f75b 11 m below, 20:36:00Z)', () => {
  const CELL = 0x01d20200, DREAD = 0x8000f75b;
  const dread = (z: number): AgentHostObject => host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, level: 60, cell: CELL, x: 20, y: 36, z });
  beforeEach(() => { host.me.cell = CELL; host.me.x = 20; host.me.y = 10; host.me.z = 0; });

  it('a Dread walking toward you on the floor 11 m below raises no "closing" aggro', async () => {
    const d = dread(-11);
    const w = api.wait({ types: ['aggro'] }, 5000);
    for (let i = 0; i < 40; i++) { d.y -= 0.25; run(api, host, 100, { physics: false }); }
    run(api, host, 1500, { physics: false });
    expect(await w).toHaveLength(0);
    expect(formatObservation(api.observe())).not.toMatch(/closing/);
  });

  it('the same walk on your own floor is closing in', async () => {
    const d = dread(0);
    const w = api.wait({ types: ['aggro'] }, 5000);
    for (let i = 0; i < 40; i++) { d.y -= 0.25; run(api, host, 100, { physics: false }); }
    const evs = await w;
    expect(evs).toHaveLength(1);
    expect(evs[0].text).toMatch(/^Dread Mu-miyah #8000f75b \(level 60\) is coming at you, 2\d m N \(closing, \d m nearer in [23] s\)$/);
  });

  it('a MoveTo at you from another floor (the server\'s own aim) is still reported, as before', async () => {
    dread(-11).seeks = { guid: host.me.guid, kind: 'move' };
    const w = api.wait({ types: ['aggro'] }, 3000);
    run(api, host, 500, { physics: false });
    const evs = await w;
    expect(evs[0]?.text).toMatch(/running at you\), 11 m down: another floor/);
  });
});

describe('5. the line of fire goes to where the server has the target (Dread #8000f372, 20:32:06–17Z)', () => {
  const makeSOM = (): ServerObjectManager => {
    const som = new ServerObjectManager({ loadSetupModel: () => null } as never, {} as never, new THREE.Scene());
    som.missileLocalPlayer = () => ({ x: 100, y: 100, z: 0, radius: 0.5, height: 1.8 });
    return som;
  };
  const put = (som: ServerObjectManager, over: Partial<ServerObject>): void => {
    const o = { guid: 0x8000f372, name: 'Dread Mu-miyah', itemType: ItemType.Creature, physicsState: 0, mesh: new THREE.Group(), worldX: 100, worldZ: 102, worldY: 0, collisionRadius: 0.5, collisionHeight: 1.6, ...over } as unknown as ServerObject;
    (som as unknown as { objects: Map<number, ServerObject> }).objects.set(o.guid, o);
  };
  // The floor of the room above, 4 m up: a bolt climbing through it dies there.
  const ceiling = (from: { z: number }, to: { z: number }) => (to.z > 4 && from.z < 4 ? { t: (4 - from.z) / (to.z - from.z), normal: { x: 0, y: 0, z: -1 } } : null);

  it('our copy 2 m off on our floor, the server\'s 12.9 m off and 6 m up: blocked, at the server\'s spot', () => {
    const som = makeSOM();
    som.missileEnvironmentSweep = ceiling;
    put(som, { serverPlace: { cell: 0x01d20210, worldX: 100, worldY: 6, worldZ: 112.9 } });
    const r = som.lineOfFire(0x8000f372)!;
    expect(r.blockedAt).not.toBeNull();
    expect(r.serverSpot).toEqual({ dist: 12.9, dz: 6 });
    expect(r.dist).toBeCloseTo(12.9, 1);
  });

  it('our copy and the server\'s together (a run between two updates): our copy\'s line, as before', () => {
    const som = makeSOM();
    som.missileEnvironmentSweep = ceiling;
    put(som, { serverPlace: { cell: 0x01d20200, worldX: 100, worldY: 0, worldZ: 104 } });
    expect(som.lineOfFire(0x8000f372)).toEqual({ dist: 2, blockedAt: null });
  });

  it('the cast refusal says the server has it elsewhere', async () => {
    host.me.combatMode = 'magic';
    host.spells = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1, projectile: true }];
    host.add({ guid: 0x8000f372, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, level: 60, x: 80, y: 22 });
    host.lineOfFire = () => ({ dist: 12.9, blockedAt: 8.3, blocker: 'the floor or ground', serverSpot: { dist: 12.9, dz: 6 } });
    const r = (await settle(api, host, api.cast('Flame Bolt I', 0x8000f372), 3000)) as AgentResult;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no line of fire to Dread Mu-miyah \(12\.9 m away, where the server has it: 12\.9 m off, 6 m up; your view shows it elsewhere, and a bolt flies at where the server has it\)/);
  });
});

describe('6. raise names the kind it raised when the word named the other (attribute="Stamina", 20:23:25Z)', () => {
  beforeEach(() => {
    host.stats = new Map([['Maximum Stamina', 0], ['Endurance', 100], ['Self', 199], ['Strength', 132], ['Run', 211]]);
    host.xp = 10_000;
    host.vitalAttributes = () => ({ health: [2], stamina: [2], mana: [6] });
  });

  it('attribute= naming a vital: raised Maximum Stamina, the attribute that feeds it is Endurance', () => {
    const r = api.raise('Maximum Stamina', 1, 'attribute');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/\n {2}\(raised Maximum Stamina: a vital, not an attribute; the attribute that feeds it is Endurance \(raise attribute="Endurance" for that\)\)$/);
  });

  it('vital= naming an attribute: says which vitals it feeds', () => {
    expect(api.raise('Endurance', 1, 'vital').message).toMatch(/\(raised Endurance: an attribute, not a vital; it feeds Maximum Health and Maximum Stamina \(raise vital="Health" for one of those\)\)$/);
    expect(api.raise('Strength', 1, 'vital').message).toMatch(/\(raised Strength: an attribute, not a vital; the vitals are Health, Stamina and Mana\)$/);
  });

  it('the kind and the word agreeing (or no word): no note', () => {
    expect(api.raise('Self', 1, 'attribute').message).not.toMatch(/\n/);
    expect(api.raise('Maximum Stamina', 1, 'vital').message).not.toMatch(/\n/);
    expect(api.raise('Run', 1).message).not.toMatch(/\n/);
  });

  it('the tool hands the page the word the player used', async () => {
    expect(raiseWord({ attribute: 'Stamina' })).toBe('attribute');
    expect(raiseWord({ vital: 'Endurance' })).toBe('vital');
    expect(raiseWord({ stat: 'Stamina', attribute: 'x' })).toBeNull();
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const caller: ToolCaller = { notice: null, call: async <T,>(method: string, args?: unknown[]) => { calls.push({ method, args: args ?? [] }); return { ok: true, message: 'ok' } as T; } };
    await TOOL_CALLER.run(caller, () => TOOL_BY_NAME.get('ac_raise')!.run({ attribute: 'Stamina' }));
    await TOOL_CALLER.run(caller, () => TOOL_BY_NAME.get('ac_raise')!.run({ stat: 'Self', times: 2 }));
    expect(calls).toEqual([{ method: 'raise', args: ['Stamina', 1, 'attribute'] }, { method: 'raise', args: ['Self', 2] }]);
    expect(RAISE_WORD in (TOOL_BY_NAME.get('ac_raise')!.props)).toBe(false);
  });
});

describe('7. an arrival says what its distance is from', () => {
  it('a spot ("5m north"): from the spot', async () => {
    const r = (await settle(api, host, api.walkTo('5m north'), 10_000))!;
    expect(r.message).toMatch(/^arrived \(\d\.\d m from the spot\)$/);
  });

  it('an object: from it, by name', async () => {
    host.add({ guid: 0x80000e01, name: 'Pumpkin Buffer', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40 });
    const r = (await settle(api, host, api.walkTo('Pumpkin Buffer'), 15_000))!;
    expect(r.message).toMatch(/^arrived \(\d\.\d m from Pumpkin Buffer\)$/);
  });

  it('a fellow out of sight: from where they were last seen, not as if beside them', async () => {
    const r = (await settle(api, host, api.walkTo('Claude Bulwark', { lastSeenAt: { name: 'Claude Bulwark', cell: host.me.cell, x: 80, y: 30, z: 94 } } as never), 15_000))!;
    expect(r.message).toMatch(/^arrived \(\d\.\d m from where Claude Bulwark was last seen\)/);
  });
});
