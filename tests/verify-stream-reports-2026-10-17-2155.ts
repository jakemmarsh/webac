/**
 * Stream segment 2026-10-17 20:53–21:55Z (end of retail, local ACE, build 0d4e5b6e), Claude Arcanist (mage) and Claude
 * Bulwark (soldier) in Mountain Keep (0x01D2), plus Arcanist's death at 22:19:08Z in the Tusker Habitat (0x5B47). What
 * each report item turned out to be (transcripts stream/sessions/{mage,soldier}-2026-10-17-seg1.jsonl, page logs
 * mage.log / soldier.log):
 *
 * 1. "no line of fire" beside Bulwark, "a wall 0.4 m from you": real walls, not 8725a9c9's new statics. No CylSphere- or
 *    Sphere-only static stands in 0x01D201EA or 0x01D201AD; the pocket's west wall (x ≈ 65, between them) is what the
 *    eye-to-spawn leg met. ACE's own physics (tools/ace-physics-harness, 102,619 shots round both cells) agrees with our
 *    check on 99.1%, the same with or without the new statics, and every spawn-side refusal (10,245) is an ACE miss.
 *    Refusals: 46% (07:14–08:16Z, without), 36% (19:51–20:52Z, without), 39% (this segment, with). On the upper storey
 *    where the new statics stand (z 18, 0x01D20340) they cut our false clears from 91 to 9 of 33,068 shots.
 * 2. "last seen 32233 m W": Bulwark's stay_with walk on the landscape, Arcanist through the portal into the dungeon.
 *    elsewhereText only covered you in a dungeon and them outside it.
 * 3. walk_to Bulwark within=2 "stopped 0.3 m short: the only doorway route there goes through Door #701d2056" with him
 *    beside her: a refusal checked before arrival.
 * 7. walk_to a moving player ran on through the 700 ms arrival confirm: "arrived (3.5 m away, run past it a little)".
 * 8. Arcanist's corpse spares (Gloves AL 218, Studded Leather Greaves: lower legs) replaced Leather Gauntlets (AL 280)
 *    and Platemail Leggings (upper + lower legs) with no word of it; he found out by ac_gear and appraisals, swapped back
 *    beside Liberators and died mid-swap.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { ItemType } from '@ac/shared';
import { AgentApi, type AgentHost } from '../packages/renderer/src/agent/AgentApi.ts';
import { equipSwapText } from '../packages/renderer/src/agent/gear.ts';
import type { AgentItem, AgentResult } from '../packages/renderer/src/agent/types.ts';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.ts';
import { populateDungeonCollision } from '../packages/renderer/src/world/DungeonCollisionBuild.ts';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const ARC = 0x500000a3;
const BUL = 0x500000a4;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: (t: number) => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(t); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}
const fellow = (host: FakeHost, guid: number, name: string): void => {
  host.fellows = () => [{ guid, name, health: { cur: 180, max: 182 }, stamina: { cur: 200, max: 243 }, mana: { cur: 300, max: 327 } }];
};

let host: FakeHost;
let api: AgentApi;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  host = new FakeHost();
  host.wall = () => false;
  api = new AgentApi(host);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('2. a fellow who went into a dungeon while you are on the landscape', () => {
  const DUNGEON_CELL = 0x01d202f7;
  beforeEach(() => {
    host.cellSealed = (c) => ((c >>> 16) & 0xffff) === 0x01d2;
    host.me.cell = 0xa9b40019; host.me.x = 80; host.me.y = 20; host.me.z = 94;
    fellow(host, ARC, 'Claude Arcanist');
  });

  it('follow: "went through a portal or recalled: … inside a dungeon", not a 32 km distance', async () => {
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: host.me.cell, x: 86, y: 20, z: 94 });
    const p = api.follow('Claude Arcanist', { durationMs: 60_000 });
    run(api, host, 1000);
    // ACE places her in the dungeon (the portal's destination); the client lets her go.
    Object.assign(host.objs.get(ARC)!, { cell: DUNGEON_CELL, x: 50, y: -70, z: 12, lost: true });
    const r = await settle(api, host, p, 30_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^stopped following: Claude Arcanist went through a portal or recalled: the client now places them inside a dungeon/);
    expect(r?.message).not.toMatch(/\d{4,} m/);
  });

  it('walk_to with stay_with: the after-note says where she went (21:32:04Z), not "last seen 32233 m W of you"', async () => {
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: host.me.cell, x: 80, y: 4, z: 94 });
    host.add({ guid: 0x7a8c3000, name: 'Mountain Keep', itemType: 0x10000, objectDescFlags: 0x40000, cell: host.me.cell, x: 80, y: 40, z: 94 });
    const p = api.walkTo(0x7a8c3000, { within: 3, stayWith: 'Claude Arcanist' });
    run(api, host, 600);
    Object.assign(host.objs.get(ARC)!, { cell: DUNGEON_CELL, x: 50, y: -70, z: 12, lost: true });
    const r = await settle(api, host, p, 60_000);
    expect(r?.message).toMatch(/Claude Arcanist is out of sight now \(16 m away when this walk set off; went through a portal or recalled: the client now places them inside a dungeon/);
    expect(r?.message).not.toMatch(/last seen \d{4,} m/);
  });

  it('two landscape cells in different landblocks are one space: no portal note', async () => {
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: host.me.cell, x: 86, y: 20, z: 94 });
    const p = api.follow('Claude Arcanist', { durationMs: 5_000 });
    run(api, host, 600);
    Object.assign(host.objs.get(ARC)!, { cell: 0xa9b50001, x: 90, y: 2, z: 94 });
    const r = await settle(api, host, p, 20_000);
    expect(r?.message ?? '').not.toMatch(/went through a portal/);
  });
});

describe('3. a walk to a fellow already within reach is never refused for the route to their cell', () => {
  const DOOR = 0x701d2056;
  beforeEach(() => {
    host.cellSealed = (c) => ((c >>> 16) & 0xffff) === 0x01d2;
    host.me.cell = 0x01d2029e; host.me.x = 84; host.me.y = -110; host.me.z = 0;
    fellow(host, BUL, 'Claude Bulwark');
    // The door, found locked earlier (the key didn't fit), 1 m SE.
    host.add({ guid: DOOR, name: 'Door', itemType: 0x80, cell: 0x01d2029e, x: 84.7, y: -110.7, z: 0, physicsState: 0 });
    (api as unknown as { noteLockedDoor(g: number, why: string): void }).noteLockedDoor(DOOR, 'The key doesn\'t fit this lock.');
    // The only doorway route to the cell Bulwark is in goes through that door.
    (host as unknown as { route: AgentHost['route'] }).route = (_fc, _f, _tc, to, opts) => ((opts?.closed ?? []).length ? null : [{ x: 84.7 - 192, y: -110.7, z: 0 }, to]);
  });

  it('Bulwark 0.3 m off in the next cell: arrived, not "stopped 0.3 m short: the only doorway route there goes through Door"', async () => {
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: 0x01d202a8, x: 84, y: -110.3, z: 0 });
    const r = await settle(api, host, api.walkTo('Claude Bulwark', { within: 2 }), 20_000);
    expect(r?.ok, r?.message).toBe(true);
    expect(r?.message).toMatch(/^arrived/);
  });

  it('12 m off, the same route: still refused at once, naming the door (the rule of 2026-10-16 stands)', async () => {
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: 0x01d202a8, x: 84, y: -98, z: 0 });
    const r = await settle(api, host, api.walkTo('Claude Bulwark', { within: 2 }), 20_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^stopped 12\.0 m short: the only doorway route there goes through Door #701d2056/);
  });
});

describe('7. walk_to a fellow: a run that went by them is turned back, not "arrived (3.5 m away, run past it a little)"', () => {
  it('slow frames (1.5 s: 6 m a look at a run, a throttled window) past a fellow pacing on the spot (0.4 m): back beside her, within reach', async () => {
    fellow(host, ARC, 'Claude Arcanist');
    const a = host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 29, z: 94, heardAt: 0 });
    const p = api.walkTo('Claude Arcanist', { within: 2 });
    let out: Awaited<typeof p> | null = null;
    void p.then((x) => { out = x; });
    for (let t = 0; t < 30_000 && !out; t += 1500) {
      host.t += 1500; vi.advanceTimersByTime(1500); host.physics(1500); a.x = 80 + ((t / 1500) % 2 ? 0.4 : 0); a.heardAt = host.t; api.tick();
      await Promise.resolve(); await Promise.resolve();
    }
    const r = out as Awaited<typeof p> | null;
    expect(r?.ok, r?.message).toBe(true);
    expect(r?.message).not.toMatch(/run past it/);
    expect(Math.hypot(a.x - host.me.x, a.y - host.me.y)).toBeLessThanOrEqual(2.5);
  });
});

describe('8. equip says what the swap does to your armor; loot from your corpse says what you wore', () => {
  const TROUSERS: AgentItem = { guid: 0x80003273, name: 'Trousers', where: 'equipped', mask: 0x4 | 0x40 | 0x80, coverage: 0x2 | 0x4 | 0x10 };
  const LEGGINGS: AgentItem = { guid: 0x800008b0, name: 'Platemail Leggings', where: 'equipped', mask: 0x2000 | 0x4000, coverage: 0x100 | 0x200, validLocations: 0x2000 | 0x4000 };
  const GREAVES: AgentItem = { guid: 0x80004301, name: 'Studded Leather Greaves', where: 'main pack', validLocations: 0x4000, coverage: 0x200 };
  const GAUNTLETS: AgentItem = { guid: 0x80006735, name: 'Leather Gauntlets', where: 'equipped', mask: 0x20, coverage: 0x8000, validLocations: 0x20, armorLevel: 280, appraised: true };
  const GLOVES: AgentItem = { guid: 0x8000b0f1, name: 'Gloves', where: 'main pack', validLocations: 0x20, coverage: 0x8000, armorLevel: 218, appraised: true };
  // BUG.eor-autowear-priority-pass — a piece whose coverage overlaps comes off by the agent's own move first
  // (AutoWear takes nothing off), then the wear goes on.
  const swapOn = (on: AgentItem, off: AgentItem): void => {
    Object.assign(host, { placeItem: (g: number) => {
      host.sent.push(`off ${g.toString(16)}`);
      setTimeout(() => { host.inv = host.inv.map((i) => (i.guid === g ? { ...i, where: 'main pack', mask: undefined } : i)); }, 200);
      return true;
    } });
    host.wield = (g: number) => {
      host.sent.push(`wield ${g.toString(16)}`);
      setTimeout(() => {
        host.inv = host.inv.map((i) => (i.guid === off.guid ? { ...i, where: 'main pack', mask: undefined } : i.guid === g ? { ...i, where: 'equipped', mask: on.validLocations } : i));
      }, 200);
      return true;
    };
  };

  it('(a)(b) the greaves take off Platemail Leggings and leave the upper legs in Trousers alone (22:18:55Z)', async () => {
    host.inv = [{ ...TROUSERS }, { ...LEGGINGS }, { ...GREAVES }];
    swapOn(GREAVES, LEGGINGS);
    const r = await settle(api, host, api.equip(GREAVES.guid), 10_000);
    expect(r?.ok).toBe(true);
    expect(r?.message).toContain('taking off Platemail Leggings #800008b0 (AL ? (not appraised), covers upper legs + lower legs) for Studded Leather Greaves #80004301 (AL ? (not appraised), covers lower legs)');
    expect(r?.message).toContain('appraise Studded Leather Greaves #80004301 and Platemail Leggings #800008b0 to compare armor levels (ac_appraise)');
    expect(r?.message).toContain('leaves your upper legs (only Trousers) with no armor');
  });

  it('(a) the Gloves take off Leather Gauntlets: armor level 280 → 218, 62 LESS', async () => {
    host.inv = [{ ...GAUNTLETS }, { ...GLOVES }];
    swapOn(GLOVES, GAUNTLETS);
    const r = await settle(api, host, api.equip(GLOVES.guid), 10_000);
    expect(r?.message).toContain('taking off Leather Gauntlets #80006735 (AL 280, covers hands) for Gloves #8000b0f1 (AL 218, covers hands)');
    expect(r?.message).toContain('armor level 280 → 218 where they overlap: 62 LESS');
    expect(r?.message).not.toMatch(/nothing on|no armor/);
  });

  it('(b) a piece off with nothing in its place names the part left bare', () => {
    const before: AgentItem[] = [{ ...GAUNTLETS }, { ...TROUSERS }];
    const after: AgentItem[] = [{ ...GAUNTLETS, where: 'main pack', mask: undefined }, { ...TROUSERS }];
    expect(equipSwapText(0x80000001, before, after)).toBe('leaves your hands with nothing on');
    // A ring or bracelet swap says nothing of armor.
    expect(equipSwapText(0x8000e96c, [{ guid: 0x8000e111, name: 'Heavy Bracelet', where: 'equipped', mask: 0x20000 }],
      [{ guid: 0x8000e111, name: 'Heavy Bracelet', where: 'main pack' }, { guid: 0x8000e96c, name: 'Bracelet', where: 'equipped', mask: 0x20000 }])).toBe('');
  });

  describe('(c) loot from your own corpse', () => {
    const CORPSE = 0x8000d336;
    const corpseWith = (): void => {
      host.me.name = 'Claude Arcanist';
      host.add({ guid: CORPSE, name: 'Corpse of Claude Arcanist', objectDescFlags: 0x2000, x: 81, y: 21 });
      host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); if (g === CORPSE) host.container = { guid: CORPSE, items: [{ guid: GLOVES.guid, name: 'Gloves' }, { guid: GREAVES.guid, name: 'Studded Leather Greaves' }, { guid: 0x80000999, name: 'Leather Boots' }] }; return true; };
      host.pickUp = (g: number) => {
        host.sent.push(`pickup ${g.toString(16)}`);
        const it = host.container?.items.find((i) => i.guid === g);
        if (it) { host.inv.push({ guid: g, name: it.name, where: 'main pack' }); host.container = { guid: CORPSE, items: host.container!.items.filter((i) => i.guid !== g) }; }
        return true;
      };
    };

    it('a death the client recorded: each item worn or a pack spare', async () => {
      corpseWith();
      const a = api as unknown as { myCorpses: Array<Record<string, unknown>>; wallNow(): number };
      a.myCorpses.push({ wall: a.wallNow() - 60_000, cell: host.me.cell, place: 'Holtburg', coords: null, killer: 'Tusker Liberator', items: ['Gloves', 'Studded Leather Greaves', 'Leather Boots'], worn: ['Leather Boots'], rotMs: 3_600_000, guid: CORPSE });
      const p = api.loot(CORPSE, null);
      run(api, host, 15_000);
      const r = await p;
      expect(r.message).toContain('from your own corpse: Gloves: in your pack when you died (a spare, not what you had on); Studded Leather Greaves: in your pack when you died (a spare, not what you had on); Leather Boots: worn when you died');
    });

    it('a corpse older than the record (the 18:48Z death, before 0d4e5b6e): not known, said so', async () => {
      corpseWith();
      const p = api.loot(CORPSE, null);
      run(api, host, 15_000);
      const r = await p;
      expect(r.message).toMatch(/from your own corpse: whether you wore these when you died is not known/);
    });

    it('someone else\'s corpse: no such note', async () => {
      host.add({ guid: 0x80000070, name: 'Corpse of Tusker Liberator', objectDescFlags: 0x2000, x: 82, y: 22 });
      host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); host.container = { guid: 0x80000070, items: [{ guid: 0x80000072, name: 'Tusker Hide' }] }; return true; };
      host.pickUp = (g: number) => { host.inv.push({ guid: g, name: 'Tusker Hide', where: 'main pack' }); host.container = { guid: 0x80000070, items: [] }; return true; };
      const p = api.loot(0x80000070, null);
      run(api, host, 10_000);
      const r = await p;
      expect(r.message).not.toMatch(/your own corpse/);
    });
  });
});

describe('9. a repeat cast with a second attacker on you from the start (Olthoi, 0xA3AA0026, 22:36:51–56Z)', () => {
  const TARGET = 0x80001a75, OTHER = 0x80001d4a;
  let castsSent: number;
  let reply: (n: number) => void;
  async function settleR(p: Promise<AgentResult>, ms = 60_000): Promise<AgentResult> {
    let out: AgentResult | undefined;
    void p.then((r) => { out = r; });
    for (let t = 0; t < ms && out === undefined; t += 200) await vi.advanceTimersByTimeAsync(200);
    if (!out) throw new Error('repeat never answered');
    return out;
  }
  const hit = (n: number, where = 'chest'): void => {
    host.me.health = { ...host.me.health, current: host.me.health.current - n };
    api.pushChat(`Olthoi Worker nicks your ${where} for ${n} points of piercing damage!`, 0x15);
  };
  beforeEach(() => {
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    host.me.level = 49;
    host.me.health = { current: 175, max: 175 };
    host.me.mana = { current: 314, max: 314 };
    host.spells = () => [{ id: 1, name: 'Force Bolt III', school: 'War', level: 3, projectile: true, range: 40 }];
    (host as unknown as { lineOfFire: () => { dist: number; blockedAt: null } }).lineOfFire = () => ({ dist: 18, blockedAt: null });
    // The target, coming at Bulwark 18 m off; the other Worker beside Arcanist, hitting him before the repeat began.
    host.add({ guid: TARGET, name: 'Olthoi Worker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 38 });
    host.add({ guid: OTHER, name: 'Olthoi Worker', itemType: 0x10, objectDescFlags: 0x10, x: 81.3, y: 20 });
    castsSent = 0;
    reply = () => api.pushChat('You impale Olthoi Worker for 53 points with Force Bolt III.', 0x16);
    host.cast = (_id: number, t: number | null) => {
      host.sent.push(`cast ${t?.toString(16)}`);
      const n = ++castsSent;
      setTimeout(() => { host.me.mana.current -= 10; reply(n); }, 600);
      return true;
    };
  });

  it('its hits count after the first cast, by a tenth of the health you have now: it stops before the second cast', async () => {
    hit(11, 'lower arm'); hit(17, 'head'); hit(13);
    run(api, host, 200, { physics: false });
    reply = (n) => { api.pushChat('You impale Olthoi Worker for 53 points with Force Bolt III.', 0x16); if (n === 1) { hit(7, 'upper leg'); hit(8); } };
    const r = await settleR(api.cast('Force Bolt III', TARGET, { repeat: true, untilHealth: 0.55 }));
    expect(castsSent).toBe(1);
    expect(r.message.split('\n')[0]).toMatch(/^cast Force Bolt III at Olthoi Worker 1 time \(repeat\); stopped: Olthoi Worker #80001d4a \(\d+× in 10 s; one hit of its took 17, 1[45]% of the 1[12]\d health you have \(of 175\)\), on you from the start and not your target, is real danger now/);
    expect(r.message).toMatch(/\n {2}hits on you meanwhile: 2 for 15 \(Olthoi Worker 2 for 15\)/);
  });

  it('the summary totals the hits on you whatever ended it', async () => {
    reply = (n) => {
      api.pushChat('You impale Olthoi Worker for 53 points with Force Bolt III.', 0x16);
      if (n === 1) api.pushChat('Critical hit! Olthoi Needler nicks your foot for 4 points of piercing damage!', 0x15);
      if (n === 2) host.dying.add(TARGET);
    };
    host.objs.delete(OTHER);
    host.add({ guid: 0x800019a0, name: 'Olthoi Needler', itemType: 0x10, objectDescFlags: 0x10, x: 79, y: 20 });
    const r = await settleR(api.cast('Force Bolt III', TARGET, { repeat: true }));
    expect(r.message).toContain('hits on you meanwhile: 1 for 4 (Olthoi Needler 1 for 4)');
  });
});

describe('10. a flee walk that arrives with the attackers still on you says so (Olthoi field, 22:42:57Z)', () => {
  it('"arrived" with the run\'s cost and who kept up, not only "you kept going 20 m"', async () => {
    host.me.health = { current: 150, max: 158 };
    const m1 = host.add({ guid: 0x80001225, name: 'Olthoi Needler', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 18.5, level: 50 });
    const m2 = host.add({ guid: 0x80001ca4, name: 'Wild Monouga', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 19, level: 30 });
    const r = await settle(api, host, api.walkTo('20m north', { flee: true }), 30_000, (t) => {
      // They run with you, a step behind, and hit as they go.
      for (const m of [m1, m2]) { m.y = host.me.y - 1.5; m.x = host.me.x + (m === m2 ? 1 : 0); }
      if (t % 2000 === 0) {
        host.me.health = { ...host.me.health, current: host.me.health.current - 4 };
        api.pushChat('Olthoi Needler nicks your chest for 4 points of piercing damage!', 0x15);
        api.pushChat('Wild Monouga grazes your head for 1 point of bludgeoning damage!', 0x15);
      }
    });
    expect(r?.ok, r?.message).toBe(true);
    expect(r?.message).toMatch(/^arrived/);
    expect(r?.message).toMatch(/you kept going 1\d m; on the way: 6 for 15 \(Olthoi Needler 3 for 12, Wild Monouga 3 for 3\), and you did NOT get clear: 2 kept up with you and are on you now \(Olthoi Needler \d\.\d m, Wild Monouga \d\.\d m\), health 138\/158: heal, or run on/);
  });
});

describe('11. fellow events: a fellow far off on the landscape gets coordinates; one in a dungeon gets no distance', () => {
  const low = async (cell: number, x: number, y: number): Promise<string> => {
    host.cellSealed = (c) => ((c >>> 16) & 0xffff) === 0x01d2;
    let hp = 180;
    host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: hp, max: 197 }, stamina: { cur: 200, max: 243 }, mana: { cur: 80, max: 87 } }];
    host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell, x, y, z: 60, heardAt: 0 });
    run(api, host, 1000);
    hp = 89;
    run(api, host, 1000);
    return api.eventsSince(0).filter((e) => e.type === 'fellow-low').map((e) => (e as { text: string }).text).join('\n');
  };
  it('2107 m SW from the Holtburg lifestone to the Olthoi field: said with their map coordinates (22:43:27Z)', async () => {
    // You at Holtburg (0xA9B4), Bulwark in 0xA3AA.
    const t = await low(0xa3aa0026, 120, 110);
    expect(t).toMatch(/Claude Bulwark's health 89\/197 \(45%\), below 60%; they are \d{4} m SW of you \(at \d+\.\dN, \d+\.\dE\)/);
  });
  it('a fellow placed in a dungeon while you are outside: "inside a dungeon", no distance', async () => {
    const t = await low(0x01d202f7, 50, -70);
    expect(t).toMatch(/they are inside a dungeon \(not where you are\)/);
    expect(t).not.toMatch(/\d{4,} m/);
  });
});

const haveDat = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);
describe.skipIf(!haveDat)('1. Mountain Keep 0x01D2: our line of fire against ACE\'s projectile', () => {
  const BX = 0x01 * 192, BY = 0xd2 * 192;
  const T = 0x80000001;
  /** A Dread Mu-miyah (wcid 9255: Setup 0x02000001, scale 1.25, ACE world DB). */
  const SCALE = 1.25;
  let withStatics: ServerObjectManager;
  let without: ServerObjectManager;
  let me = { x: 0, y: 0, z: 0 };
  let dread: { radius: number; height: number };
  const mesh = new THREE.Group();
  mesh.scale.setScalar(SCALE);
  /**
   * ACE's verdicts (tools/ace-physics-harness `grid 01D2 02000001 1.25`, ALL=1 STEP=1; caster and target feet as ACE placed
   * them). The pocket (z −6): from beside its west wall into 0x01D201AD the bolt's spawn point can't see back to the eye
   * ("NOT VISIBLE -> OnCollideEnvironment"), as Arcanist's "a wall 0.4 m from you" said. The upper storey (z 18, cell
   * 0x01D20340): a 0.2 m × 2.2 m CylSphere-only static (Setup 0x020005D9 at (68.48, −3.45)) takes the bolt.
   */
  const ACE: Array<[number, number, number, number, number, number, 'HIT' | 'MISS', boolean]> = [
    // [caster x, y, z, target x, y, z, ACE, the new static decides it]
    [66, -112, -5.995, 59, -112, -5.994, 'MISS', false],
    [66, -112, -5.995, 60, -114, -5.994, 'MISS', false],
    [66, -112, -5.995, 60, -113, -5.994, 'MISS', false],
    [66, -112, -5.995, 65.6, -114, -5.994, 'HIT', false],
    [66, -112, -5.995, 66.102, -113.687, -5.994, 'HIT', false],
    [66.385, -3.778, 18.005, 70, -3, 18.006, 'MISS', true],
    [66.385, -3.778, 18.005, 71, -3.571, 18.006, 'MISS', true],
    [66.385, -2.778, 18.005, 72, -3.9, 18.006, 'MISS', true],
    [66.385, -3.778, 18.005, 65, 1, 18.006, 'HIT', false],
    [66.385, -3.778, 18.005, 66.1, -1.286, 18.006, 'HIT', false],
  ];
  beforeAll(async () => {
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel.js');
    const { LandblockInfo } = await import('../packages/dat-parser/src/file-types/LandblockInfo.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const portal = openDat(DAT_PATHS.portal), cell = openDat(DAT_PATHS.cell);
    const mf = new MaterialFactory(portal, new TextureManager(portal));
    const mr = new ModelRenderer(portal, mf);
    const sr = new SetupModelRenderer(portal, mr);
    const env = new EnvCellRenderer(portal, cell, mf, sr, mr);
    const lbInfo = (lb: number) => { const d = cell.getFileData(((lb & 0xffff0000) | 0xfffe) >>> 0); return d ? new LandblockInfo(new DatReader(d)) : null; };
    const build = (shapes: boolean): DungeonCollision => {
      const dc = new DungeonCollision();
      populateDungeonCollision(dc, 0x01d2ffff, {
        findInteriorCells: (lb) => { const info = lbInfo(lb)!; const out: number[] = []; for (let i = 0; i < info.numCells; i++) { const id = ((lb & 0xffff0000) | (0x100 + i)) >>> 0; if (cell.hasFile(id)) out.push(id); } return out; },
        getCellCollisionData: (id) => env.getCellCollisionData(id),
        loadEnvCell: (id) => env.loadEnvCell(id),
        // Without: as before 8725a9c9, a static with no physics BSP collides with nothing.
        loadSetupModel: (id) => { const s = sr.loadSetupModel(id); return s && !shapes ? { ...s, cylSpheres: [], spheres: [] } : s; },
        loadGfxObj: (id) => mr.loadGfxObj(id),
        loadLandblockInfo: lbInfo,
      });
      return dc;
    };
    const setup = (id: number) => new SetupModel(new DatReader(portal.getFileData(id)!));
    const human = setup(0x02000001);
    dread = human;
    const som = (dc: DungeonCollision): ServerObjectManager => {
      const s = new ServerObjectManager({ loadSetupModel: (id: number) => (id === 0x02000001 ? human : null) } as never, {} as never, new THREE.Scene());
      s.missileEnvironmentSweep = (from, to, r) => {
        const h = dc.sweepSphere({ x: from.x, y: from.z, z: from.y }, { x: to.x, y: to.z, z: to.y }, r);
        return h ? { t: h.t, normal: { x: h.normal.x, y: h.normal.z, z: h.normal.y } } : null;
      };
      s.missileObjectSweep = () => null;
      s.missileLocalPlayer = () => ({ x: BX + me.x, y: BY + me.y, z: me.z, radius: human.radius, height: human.height, physicsRadius: human.spheres[0].radius });
      return s;
    };
    withStatics = som(build(true));
    without = som(build(false));
  }, 180_000);

  const shoot = (s: ServerObjectManager, c: [number, number, number], t: [number, number, number]) => {
    me = { x: c[0], y: c[1], z: c[2] };
    (s as unknown as { objects: Map<number, ServerObject> }).objects.set(T, {
      guid: T, name: 'Dread Mu-miyah', itemType: ItemType.Creature, physicsState: 0, mesh, setupId: 0x02000001,
      worldX: BX + t[0], worldZ: BY + t[1], worldY: t[2], collisionRadius: dread.radius * SCALE, collisionHeight: dread.height * SCALE,
    } as unknown as ServerObject);
    return s.lineOfFire(T)!;
  };

  it('agrees with ACE on every shot, and the pocket refusals are the wall between you and the spawn point', () => {
    const wrong: string[] = [];
    for (const [cx, cy, cz, tx, ty, tz, ace] of ACE) {
      const r = shoot(withStatics, [cx, cy, cz], [tx, ty, tz]);
      if ((r.blockedAt === null) !== (ace === 'HIT')) wrong.push(`c=(${cx}, ${cy}, ${cz}) t=(${tx}, ${ty}) ACE ${ace}, ours ${r.blockedAt === null ? 'clear' : `blocked at ${r.blockedAt}`}`);
    }
    expect(wrong).toEqual([]);
    const pocket = shoot(withStatics, [66, -112, -5.995], [59, -112, -5.994]);
    expect(pocket.beforeSpawn).toBe(true);
    expect(pocket.blocker).toBe('a wall');
    expect(pocket.blockedAt!).toBeLessThan(1.2);
  });

  it('the pocket\'s verdicts are the same without 8725a9c9\'s statics (none stands there); the upper storey\'s need them', () => {
    for (const [cx, cy, cz, tx, ty, tz, ace, byStatic] of ACE) {
      const r = shoot(without, [cx, cy, cz], [tx, ty, tz]);
      expect(r.blockedAt === null, `c=(${cx}, ${cy}) t=(${tx}, ${ty})`).toBe(byStatic ? true : ace === 'HIT');
    }
  });
});

