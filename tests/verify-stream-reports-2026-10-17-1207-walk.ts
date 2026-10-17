/**
 * The 12:07Z stream reports (2026-10-17, end of retail, local ACE; Claude Arcanist = mage, Claude Bulwark = soldier;
 * the pages ran 7cfeb418-era code, loaded 09:10Z): the items, movement and use bugs. Each block drives the real
 * AgentApi over the fake host; the DAT block replays Monty's Den (0xA9B2) through the real cell DAT.
 *
 * 1. Arcanist's "walk_to failed on the first ledge drop unless drop=true" (0x5779, 11:27:37–11:29:42Z): the drop=true
 *    rule (dfa53b46) never fired (a plain walk_to; drop= matters only with stay_with or a melee run-up). The first walk
 *    stopped for "monsters not awake yet" that were beating on Bulwark (block 5), the second's two drops came down on
 *    their take-off and it gave up; the third (drop=true by chance) left from 0.3 m further along and went down.
 *    Now the next leap takes off elsewhere (JumpSearch.skipFrom; verify-agent-api.ts pins three spots).
 * 2. The Pumpkin Buffer (wcid 32205, ItemUseable 1 in the ACE world DB): retail's client sends no Use for it, so the
 *    use waited, took Bulwark's /f line for its reply and said "the walk there didn't arrive". 1efb7163 (not loaded
 *    on the stream yet) didn't cause it.
 * 3. Monty's Den (0xA9B20113): the body stood still under W by the room's east wall, the probe clear and nobody beside.
 *    On the cell DAT a body 2.5–4 cm closer to the wall than (88.0, 89.0) has its 0.05–0.13 m frame steps south refused
 *    while the probe's 0.15 m steps pass; stall 3's sidestep west freed him live. The first stall now steps off the wall.
 * 4. "Holtburg lifestone" names the Life Stone: a town in the name, and "lifestone" for "Life Stone".
 * 5. Monsters in a combat stance are awake (ACE Monster.Sleep sets NonCombat); a lower-level kind seen only nicking
 *    you is no pack worth stopping for.
 * 6. A walk to a portal remembered out of view that went through it said "not sent to … a fault to report".
 * 7. Dryreach: a stuck walk in building 0xDA750108 blamed Mountain Keep's locked door #701d2021 (another landblock,
 *    the day before), and a far walk's stretch that led into a building never planned the doorways out.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, nameMatchScore } from '../packages/renderer/src/agent/AgentApi.ts';
import { nearestTownOf, townInName } from '../packages/renderer/src/agent/towns.ts';
import { mapCoordsOfCell } from '../packages/renderer/src/ui/MapMarkers.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { FakeHost, HOLTBURG } from './_harness/agentFake.ts';
import { DAT_PATHS } from './_harness/dat.ts';

const BUL = 0x500000a4;

/** Run the page's ticks every `tick` ms until the promise settles (or `ms` pass); `each` runs before every tick. */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, opts: { tick?: number; each?: () => void } = {}): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  const tick = opts.tick ?? 100;
  for (let t = 0; t < ms && !done; t += tick) {
    opts.each?.();
    host.t += tick;
    vi.advanceTimersByTime(tick);
    host.physics(tick);
    api.tick();
    await Promise.resolve(); await Promise.resolve();
  }
  return out;
}

describe('the 12:07Z stream reports: walks and uses', () => {
  let host: FakeHost;
  let api: AgentApi;
  let traces: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    traces = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const dungeon = (): void => {
    host.me.cell = 0xa9b40105;
    host.cellSealed = () => true;
  };
  const monster = (guid: number, name: string, x: number, y: number, z: number, level: number, extra: Record<string, unknown> = {}) =>
    host.add({ guid, name, itemType: 0x10, objectDescFlags: 0x10, cell: host.me.cell, x, y, z, level, ...extra });

  describe('5 (and 1). the pack stop: awake monsters and nick-only kinds are no pack', () => {
    const bulwarkAt = (): void => {
      host.me.level = 46; host.me.health = { current: 165, max: 165 };
      host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 90, max: 181 }, stamina: { cur: 200, max: 276 }, mana: { cur: 52, max: 52 } }];
      host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: host.me.cell, x: 80, y: 60, z: 94 });
    };

    it('a Commander and a Major in a combat stance beside the fellow you walk to are awake: the walk goes on to him', async () => {
      dungeon();
      bulwarkAt();
      // Swinging at him in place: no MoveTo for comingAt to read (its aim memory long gone), only the drawn stance.
      monster(0x80007662, 'Tumerok Commander', 79, 61.5, 94, 50, { combatStance: true });
      monster(0x80007206, 'Tumerok Major', 81.5, 62, 94, 50, { combatStance: true });
      const r = await settle(api, host, api.walkTo('Claude Bulwark', { within: 3, avoidMonsters: true, stopOnAggro: false }), 40_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(r!.message).not.toMatch(/not awake yet/);
      expect(Math.hypot(host.me.x - 80, host.me.y - 60)).toBeLessThan(3.5);
    });

    it('the same two standing in peace beside him (asleep, as ACE leaves an idle monster) still stop the walk short', async () => {
      dungeon();
      bulwarkAt();
      monster(0x80007662, 'Tumerok Commander', 79, 61.5, 94, 50);
      monster(0x80007206, 'Tumerok Major', 81.5, 62, 94, 50);
      const r = await settle(api, host, api.walkTo('Claude Bulwark', { within: 3, avoidMonsters: true, stopOnAggro: false }), 40_000);
      expect(r).toMatchObject({ ok: false });
      expect(r!.message).toMatch(/going on brings you within 18 m of 2 monsters not awake yet: Tumerok Commander L50/);
    });

    it('Standard Bearers (L30) seen hitting for 2 at most are no pack for a level 43; a kind that hit for 40 is', async () => {
      dungeon();
      host.me.level = 43; host.me.health = { current: 181, max: 181 };
      api.pushChat('Tumerok Standard Bearer stabs your upper leg for 2 points of piercing damage!', 0x15);
      api.pushChat('Tumerok Major slashes your chest for 40 points of slashing damage!', 0x15);
      host.t += 30_000;
      monster(0x80008b45, 'Tumerok Standard Bearer', 79, 50, 94, 30);
      monster(0x8000851d, 'Tumerok Standard Bearer', 81, 52, 94, 30);
      const past = await settle(api, host, api.walkTo('45m north', { avoidMonsters: true, stopOnAggro: true }), 40_000);
      expect(past, traces.join('\n')).toMatchObject({ ok: true });
      expect(api.nickOnlyKind({ guid: 0x80008b45, name: 'Tumerok Standard Bearer', level: 30 })).toBe(true);
      // Above your level, or hitting harder than a nick: still a threat.
      expect(api.nickOnlyKind({ guid: 1, name: 'Tumerok Standard Bearer', level: 50 })).toBe(false);
      expect(api.nickOnlyKind({ guid: 2, name: 'Tumerok Major', level: 30 })).toBe(false);
      expect(api.nickOnlyKind({ guid: 3, name: 'Never Seen', level: 10 })).toBe(false);
    });
  });

  describe('2. a use of something the server marks unusable', () => {
    it('the Pumpkin Buffer (ItemUseable 1, a creature) is not used and not waited on: what it does instead is said', async () => {
      host.me.combatMode = 'magic';
      host.add({ guid: 0x80008caa, name: 'Pumpkin Buffer', itemType: 0x10, objectDescFlags: 0x10, cell: HOLTBURG, x: 80, y: 32.6, z: 94, useability: 1 });
      const r = await settle(api, host, api.use('Pumpkin Buffer'), 20_000);
      expect(r).toMatchObject({ ok: false });
      expect(r!.message).toMatch(/^Pumpkin Buffer #80008caa can't be used: the server marks it unusable \(a creature with no use\), so the client sends no Use for it and no walk there is made \(retail answers "To attack Pumpkin Buffer, click on the dove icon first" in peace mode and nothing in a combat stance\)/);
      expect(r!.message).not.toMatch(/didn't arrive/);
      expect(host.sent.filter((s) => s.startsWith('use '))).toEqual([]);
    });

    it('a fellow\'s /f line while a use waits is no reply to it (the NPC\'s own tell is)', async () => {
      host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 180, max: 181 }, stamina: { cur: 276, max: 276 }, mana: { cur: 52, max: 52 } }];
      host.add({ guid: 0x80007e54, name: 'Town Crier', itemType: 0x10, objectDescFlags: 0, cell: HOLTBURG, x: 80, y: 21.5, z: 94, useability: 0x20 });
      let said = false;
      const r = await settle(api, host, api.use('Town Crier'), 20_000, {
        each: () => {
          if (said || host.t < 500) return;
          said = true;
          api.pushChat('[Fellowship] Claude Bulwark says, "Thanks, auras landed."', 0x12);
          api.pushChat('Claude Bulwark tells you, "on my way"', 0x03);
        },
      });
      expect(r!.message).not.toMatch(/Fellowship|on my way/);
      expect(r!.message).toMatch(/no reply within 10 s/);
      // An NPC's tell is the use's answer, as before.
      const r2 = await settle(api, host, api.use('Town Crier'), 20_000, { each: () => { if (host.t % 1000 === 0) api.pushChat('Town Crier tells you, "Hear ye!"', 0x03); } });
      expect(r2!.message).toMatch(/Town Crier tells you, "Hear ye!"/);
    });
  });

  describe('4. places named with their town', () => {
    it('"Holtburg lifestone" and "lifestone" find Holtburg\'s Life Stone; "Arwic lifestone" does not', () => {
      // The Holtburg Life Stone, ACE landblock_instance 0x7A9B404F at A9B4 (81.33, 11.8).
      host.add({ guid: 0x7a9b404f, name: 'Life Stone', itemType: 0, objectDescFlags: 0x4000, cell: HOLTBURG, x: 81.33, y: 11.8, z: 94 });
      expect(nameMatchScore('lifestone', 'Life Stone')).toBe(4);
      expect(api.resolve('lifestone', 'world')).toBe(0x7a9b404f);
      expect(api.resolve('Holtburg lifestone', 'world')).toBe(0x7a9b404f);
      expect(api.resolve('the Life Stone in Holtburg', 'world')).toBe(0x7a9b404f);
      expect(api.resolve("Holtburg's lifestone", 'world')).toBe(0x7a9b404f);
      expect(api.resolve('Arwic lifestone', 'world')).toBeNull();
      expect(townInName('Holtburg lifestone')).toEqual({ town: 'Holtburg', rest: 'lifestone' });
      expect(townInName('Holtburg')).toBeNull();
      // The Life Stone stands in Holtburg on the retail map's notes.
      const at = mapCoordsOfCell(Math.floor((0xa9 * 192 + 81.33) / 24), Math.floor((0xb4 * 192 + 11.8) / 24));
      expect(nearestTownOf(at)?.text).toBe('Holtburg');
    });

    it('a remembered Life Stone out of view is walked to by its town\'s name', async () => {
      const ls = host.add({ guid: 0x7a9b404f, name: 'Life Stone', itemType: 0, objectDescFlags: 0x4000, cell: HOLTBURG, x: 81.33, y: 11.8, z: 94 });
      api.tick();
      // Out of the server's range: the client lets it go (BUG.ghost-objects), then deletes it; it stays a remembered place.
      ls.lost = true; api.tick();
      host.objs.delete(0x7a9b404f); api.tick();
      host.me.y = 40;
      const r = await settle(api, host, api.walkTo('Holtburg lifestone'), 30_000);
      expect(r, `${r?.message}\n${traces.join('\n')}`).toMatchObject({ ok: true });
      expect(Math.hypot(host.me.x - 81.33, host.me.y - 11.8)).toBeLessThan(3);
    });
  });

  describe('6. a walk to a portal remembered out of view', () => {
    it('going through it is the walk\'s own portal, not "a fault to report"', async () => {
      const PORTAL = 0x7a9b4080;
      const portal = { guid: PORTAL, name: 'Portal to Town Network', itemType: 0x10000, objectDescFlags: 0x40000, cell: HOLTBURG, x: 80, y: 120, z: 94 };
      const seen = host.add({ ...portal });
      api.tick();
      seen.lost = true; api.tick();
      host.objs.delete(PORTAL); api.tick();
      let ported = false;
      const r = await settle(api, host, api.walkTo(PORTAL), 60_000, {
        each: () => {
          // In view once near; the body steps into its disk and the server ports it to the Town Network hub.
          if (!host.objs.has(PORTAL) && host.me.y > 60) host.add(portal);
          // The landblock it stood in leaves the client with the port: no object to name it by any more.
          if (!ported && host.me.y > 115) { ported = true; host.objs.delete(PORTAL); host.me.cell = 0x00070143; host.me.x = 70; host.me.y = 1289 - 0x07 * 192; }
        },
      });
      expect(ported, `${r?.message}\n${traces.join('\n')}`).toBe(true);
      expect(r).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/^went through Portal to Town Network #7a9b4080, the portal this walk went to/);
      expect(r!.message).not.toMatch(/fault to report/);
    });
  });

  describe('7. locked doors of other landblocks, and a far walk led into a building', () => {
    it('a stuck walk names no locked door of another landblock', async () => {
      // Mountain Keep, the day before: Door #701d2021 answered "The Door is locked!".
      host.me.cell = 0x01d20123; host.cellSealed = () => true; host.me.x = 80; host.me.y = 20;
      host.add({ guid: 0x701d2021, name: 'Door', itemType: 0, objectDescFlags: 0x1000, cell: 0x01d20123, x: 80, y: 22, z: 94, physicsState: 0x10008 });
      api.pushChat('The Door is locked!', 0x00);
      // Then a town building with a wall across the way on (as the Dryreach building's shut door left it): another landblock.
      host.objs.delete(0x701d2021);
      host.cellSealed = undefined;
      host.me.cell = 0xa9b40108; host.me.x = 80; host.me.y = 20;
      host.wall = (_x, y) => y > 30 && y < 31;
      host.add({ guid: 0x7a9b401a, name: 'Sordan Edelson the Smithy', itemType: 0x10, objectDescFlags: 0x200, cell: 0xa9b40108, x: 80, y: 50, z: 94 });
      const r = await settle(api, host, api.walkTo('Sordan Edelson the Smithy'), 900_000, { tick: 200 });
      expect(r, traces.slice(-30).join('\n')).toMatchObject({ ok: false });
      // Live (and here without the landblock filter): "…; tried the door #701d2021, which stayed shut: locked, or it needs a key".
      expect(r!.message).toMatch(/^stuck [\d.]+ m short \(no walkable way from here/);
      expect(r!.message).not.toMatch(/701d2021|stayed shut/);
    }, 120_000);

    it('a far walk whose stretch leads into a building\'s rooms plans the way out by its doorways', async () => {
      host.wall = () => false;
      const asked: number[] = [];
      host.route = (fc, _f, _tc, to) => { asked.push(fc >>> 0); return (fc & 0xffff) >= 0x100 ? [{ x: 80, y: 45, z: 95.25, feet: 94 }, to] : null; };
      let inside = false;
      const r = await settle(api, host, api.walkTo('400m north', { timeoutMs: 15_000 }), 16_000, {
        each: () => {
          // Through a door standing open into a building of this landblock (a SeenOutside interior cell).
          if (!inside && host.me.y > 40) { inside = true; host.me.cell = 0xa9b40108; }
          if (inside && host.me.y > 46) host.me.cell = HOLTBURG;
        },
      });
      expect(r).not.toBeNull();
      expect(traces.some((l) => /walk: into a building's rooms \(cell 0xa9b40108\) off the doorway route; the way on by its doorways is 1 doorway\(s\)/.test(l)), traces.join('\n')).toBe(true);
      expect(asked).toContain(0xa9b40108);
    });
  });

  describe('3. a stall with the way clear: pressed on a wall by a hair', () => {
    it('the body\'s step is refused where the probe\'s passes: the first stall steps off the wall, to the open side', async () => {
      // A wall east (x > 80.5); 2–5 cm from it, a north step ending in y 30–31 is refused outright (the body's frame step
      // at Monty's Den's east wall, 0xA9B20113, block 8 below), while the probe, walking the wall() world, passes.
      class HairHost extends FakeHost {
        override physics(dtMs: number): void {
          const x0 = this.me.x, y0 = this.me.y;
          super.physics(dtMs);
          if (x0 > 80.02 && this.me.y >= 30 && this.me.y <= 31 && this.keys.has('KeyW')) { this.me.x = x0; this.me.y = y0; }
          // Sidesteps: Z left, C right of the facing (CameraController.sidestepHead: A's sidestep is Z). With the fake's
          // forward (−sin yaw, −cos yaw), left is yaw − π/2.
          for (const [k, turn] of [['KeyZ', -Math.PI / 2], ['KeyC', Math.PI / 2]] as const) {
            if (!this.keys.has(k)) continue;
            const yaw = this.me.yaw + turn, step = (3 * dtMs) / 1000;
            const nx = this.me.x - Math.sin(yaw) * step, ny = this.me.y - Math.cos(yaw) * step;
            if (!this.wall?.(nx, ny)) { this.me.x = nx; this.me.y = ny; }
          }
        }
      }
      const h = new HairHost();
      h.wall = (x) => x > 80.5;
      h.me.x = 80.03;
      const a = new AgentApi(h);
      const r = await settle(a, h, a.walkTo('30m north'), 60_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(h.me.y).toBeGreaterThan(47);
      const stall = traces.findIndex((l) => /walk stall 1 /.test(l));
      expect(stall).toBeGreaterThan(-1);
      // Off the wall at the first stall (left, west: the east is the wall), with no replan before it.
      expect(traces[stall + 1]).toMatch(/walk: the probe walks on from here but the body stood still \(pressed on a wall by a hair\); stepping left off it/);
      expect(traces.some((l) => /walk stall 3 /.test(l)), traces.join('\n')).toBe(false);
    });
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

describe.skipIf(!haveDat)('8. Monty\'s Den (0xA9B2) on the real cell DAT: where Bulwark stood still', () => {
  it('the step from (88.0, 89.0) to the aim (88.0, 87.8) in 0xA9B20113 goes through, doors open or shut', async () => {
    const { buildLandblockWorld } = await import('./_harness/a9b4-world.ts');
    const { outdoorGroundY } = await import('../packages/renderer/src/world/outdoorGround.ts');
    const { stepPlayerMovement } = await import('../packages/renderer/src/player/OutdoorMovement.ts');
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.ts');
    const BX = 0xa9, BY = 0xb2, OX = BX * 192, OY = BY * 192;
    // ACE world landblock_instance: the Holtburg doors (weenie 412, Setup 0x020019FF) of the building.
    const door = (guid: number, x: number, y: number, w: number, z: number, open: boolean) => ({ guid, worldX: OX + x, worldY: 94, worldZ: OY + y, collisionRadius: 0, setupId: 0x020019ff, quat: { w, x: 0, y: 0, z }, scale: 1, physicsState: open ? 0x1000c : 0x10008 });
    for (const open of [true, false]) {
      const blockers = [door(0x7a9b2003, 89.01, 87.435, 0.707107, 0.707107, open), door(0x7a9b2004, 88.485, 84.01, 0.707107, -0.707107, false), door(0x7a9b2006, 84, 95.01, 0, -1, true)];
      const base = (await buildLandblockWorld(BX, BY, { interiors: true, blockers }))({ slidingNormal: null });
      const dc = base.outdoorCollision as InstanceType<typeof DungeonCollision>;
      const groundAt = (x: number, z: number, y: number) => outdoorGroundY({ terrainHeight: (a, b) => base.terrain.getHeightAt(a, b), floorHeight: (a, b, f) => dc.getFloorHeight(a, b, f), cellAt: (a, b, f) => dc.findCellContaining(a, b, f + dc.lowerSphereHeight) }, x, z, y);
      let x = OX + 88, z = OY + 89, floorY = 94;
      const slide = { slidingNormal: null };
      for (let i = 0; i < 30; i++) {
        const dz = OY + 87.8 - z;
        if (Math.abs(dz) < 0.02) break;
        const st = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null }, 0, Math.sign(dz) * Math.min(Math.abs(dz), 4 / 30), 1 / 30, { ...base, groundAt, slide });
        x = st.x; z = st.z; floorY = groundAt(x, z, floorY + 0.6) ?? floorY;
      }
      expect(z - OY, `door 2003 ${open ? 'open' : 'shut'}`).toBeCloseTo(87.8, 1);
      expect(x - OX).toBeCloseTo(88, 1);
      // Pressed on the wall by a hair (x 88.03: a body 0.48 m round against the wall plane at 88.5), the walk's answer, a
      // sidestep west off the wall, moves the body, and the way south then goes on.
      const one = (fx: number, fz: number, dx: number, dz: number) => stepPlayerMovement({ x: fx, z: fz, floorY: 94, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null }, dx, dz, 1 / 30, { ...base, groundAt, slide: { slidingNormal: null } });
      let w = { x: OX + 88.03, z: OY + 89 };
      for (let i = 0; i < 5; i++) { const st = one(w.x, w.z, -0.1, 0); w = { x: st.x, z: st.z }; }
      expect(OX + 88.03 - w.x).toBeGreaterThan(0.4);
      for (let i = 0; i < 9; i++) { const st = one(w.x, w.z, 0, -4 / 30); w = { x: st.x, z: st.z }; }
      expect(w.z - OY).toBeLessThan(88);
    }
  }, 120_000);
});
