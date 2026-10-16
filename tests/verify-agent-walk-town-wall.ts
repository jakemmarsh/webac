/**
 * Arwic's town wall (landblock 0xC6A9, end of retail, 2026-10-15 22:41–23:00 UTC). Claude Arcanist walked, followed and
 * used his way toward the Arwic Mines Portal (#7C6A9000 at local (90.56, 140.36), outside the north wall) from the
 * lifestone, and every walk ended in one corner at local (94.4, 97.6), cell 0xC6A9001D: "stuck 43.0 m short (no walkable
 * way from here …)". His page trace: every search "none" (1177–2085 points), then stalls at (38110.4, 32545.6) aiming
 * at (38106.6, 32588.4).
 *
 * Cause (the real DATs, below): the town's north wall is a row of LandblockInfo buildings (0x01002CDE / 0x01002D21 at
 * y 108, 24 m apart) whose face runs at y ≈ 98 from x 23 to x 120, with no gate. Arwic's gates are west (y 70–75 at
 * x 12, the gate posts 0x01002D26 at (19, 70.8) and (19, 73.2)) and south (x 46–50). The walk's searches are boxed to
 * 12 m and then 35 m round start and goal, and the gate is 80 m west, so none found a way; the walk then held W at the
 * portal and slid along the wall into the corner. ac_use did the same through the server's straight MoveTo (the use
 * only walked our planner's way for doorway routes).
 *
 * Fix (AgentApi): outdoors, when the 35 m search was boxed, one far search (A* on a 2 m grid, 80 m margin) before the
 * jumps; ac_use / ac_give / a melee attack walk the planner's way first when a straight line toward the object stops
 * short in the client's own collision; a turn or jump by hand ends a walk or follow; a walk that ends stuck where an
 * earlier one toward the same goal did says so.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { planPath, straightWalk, type NavPoint, type NavProbe } from '../packages/renderer/src/agent/navPlanner.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';
import { DAT_PATHS } from './_harness/dat.ts';

const OXF = ((HOLTBURG >>> 24) & 0xff) * 192, OYF = ((HOLTBURG >>> 16) & 0xff) * 192;
const PORTAL = 0x7c6a9000;

/**
 * Arwic in the fake world: the north wall at y 98–99 from x 20 to x 180 with no gate in it, the west wall at x 20–21
 * with its gate at y 70–75 (the real ones: the wall's face at y ≈ 98, the gate at x ≈ 19, y 70–75), the body in the
 * corner the walks ended in, the portal 43 m north beyond the wall.
 */
function arwic(host: FakeHost): void {
  host.wall = (x, y) => (y >= 98 && y <= 99 && x >= 20 && x <= 180) || (x >= 20 && x <= 21 && y <= 99 && !(y >= 70 && y <= 75));
  host.me.x = 94.4; host.me.y = 97.4; host.me.z = 42;
  host.add({ guid: PORTAL, name: 'Arwic Mines Portal', objectDescFlags: 0x40000, x: 90.56, y: 140.36, z: 42 });
}

async function drive<T>(api: AgentApi, host: FakeHost, p: Promise<T>, maxMs = 600_000): Promise<T> {
  let done: T | undefined;
  void p.then((r) => { done = r; });
  for (let t = 0; t < maxMs && done === undefined; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return done as T;
}

describe('a walk to a goal behind a long wall goes round by its gate (Arwic, 2026-10-15)', () => {
  let farNodes = AgentApi.FAR_MAX_NODES;
  beforeEach(() => { vi.useFakeTimers(); farNodes = AgentApi.FAR_MAX_NODES; vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { AgentApi.FAR_MAX_NODES = farNodes; vi.restoreAllMocks(); vi.useRealTimers(); });

  it('arrives at the portal by the west gate; without the far search every walk ends stuck in the corner', async () => {
    const host = new FakeHost();
    arwic(host);
    const api = new AgentApi(host);
    const lines: string[] = [];
    vi.mocked(console.log).mockImplementation((m: unknown) => { lines.push(String(m)); });
    const r = await drive(api, host, api.walkTo('Arwic Mines Portal'));
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^arrived/);
    expect(Math.hypot(host.me.x - 90.56, host.me.y - 140.36)).toBeLessThan(6);
    expect(lines.some((l) => /searching 80 m round on a 2 m grid/.test(l))).toBe(true);
    expect(lines.some((l) => /the way round is \d+ m/.test(l))).toBe(true);
  }, 120_000);

  it('the old ladder (no far search) ends stuck, and a second walk that ends in the same corner says so', async () => {
    AgentApi.FAR_MAX_NODES = 0;
    const host = new FakeHost();
    arwic(host);
    const api = new AgentApi(host);
    const first = await drive(api, host, api.walkTo('Arwic Mines Portal'));
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(/^stuck /);
    expect(first.message).not.toMatch(/this route keeps ending here/);
    const second = await drive(api, host, api.walkTo('Arwic Mines Portal'));
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/this route keeps ending here \([\d.]+[NS], [\d.]+[EW]\): walk 2 toward there to stop at this spot/);
    expect(second.message).toMatch(/Open ways from here: /);
  }, 120_000);

  it('ac_use walks the planner\'s way first when a straight line to the object stops short (not the server\'s MoveTo into the wall)', async () => {
    const host = new FakeHost();
    arwic(host);
    // An NPC beyond the wall (a portal use runs on into portal space; an NPC answers when used).
    host.add({ guid: 0x7c6a9070, name: 'Monroe', itemType: 0x10, x: 92, y: 120, z: 42 });
    const at: Array<{ x: number; y: number }> = [];
    const use = host.use;
    host.use = (g: number) => { at.push({ x: host.me.x, y: host.me.y }); return use(g); };
    const api = new AgentApi(host);
    await drive(api, host, api.use('Monroe'));
    expect(at.length).toBeGreaterThan(0);
    // The use went to the server from beside Monroe, north of the wall, not from the corner south of it.
    expect(at[0].y).toBeGreaterThan(99);
    expect(Math.hypot(at[0].x - 92, at[0].y - 120)).toBeLessThan(4);
  }, 120_000);

  it('ac_pick_up and a melee attack do the same: the planner\'s way round first, then the server\'s request', async () => {
    const host = new FakeHost();
    arwic(host);
    host.add({ guid: 0x80001111, name: 'Pyreal', itemType: 0x40, x: 92, y: 104, z: 42 });
    const picked: Array<{ x: number; y: number }> = [];
    host.pickUp = (g: number) => { picked.push({ x: host.me.x, y: host.me.y }); host.inv.push({ guid: g, name: 'Pyreal' } as never); return true; };
    const api = new AgentApi(host);
    await drive(api, host, api.pickUp('Pyreal'));
    expect(picked.length).toBe(1);
    expect(picked[0].y).toBeGreaterThan(99);

    // A drudge 7 m off through the wall (inside the 12 m the server's own straight approach would take).
    const h2 = new FakeHost();
    arwic(h2);
    h2.add({ guid: 0x80002222, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 92, y: 104, z: 42 });
    const swung: Array<{ x: number; y: number }> = [];
    const attack = h2.attack;
    h2.attack = (g, p, ht) => { swung.push({ x: h2.me.x, y: h2.me.y }); attack(g, p, ht); };
    const api2 = new AgentApi(h2);
    api2.attack('Drudge Skulker');
    for (let t = 0; t < 300_000 && !swung.length; t += 100) { run(api2, h2, 100); await Promise.resolve(); }
    expect(swung.length).toBeGreaterThan(0);
    expect(swung[0].y).toBeGreaterThan(99);
  }, 120_000);

  it('with a clear straight line the use is the server\'s own walk, as before', async () => {
    const host = new FakeHost();
    host.wall = () => false;
    host.me.x = 80; host.me.y = 20;
    host.add({ guid: 0x7c6a9070, name: 'Monroe', itemType: 0x10, x: 80, y: 40, z: 94 });
    const at: Array<{ x: number; y: number }> = [];
    const use = host.use;
    host.use = (g: number) => { at.push({ x: host.me.x, y: host.me.y }); return use(g); };
    const api = new AgentApi(host);
    await drive(api, host, api.use('Monroe'));
    expect(at[0]).toEqual({ x: 80, y: 20 });
  }, 60_000);
});

describe('a turn or jump by hand ends a walk or follow under way (Arcanist, Arwic, 2026-10-15)', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  for (const how of ['jump', 'turn'] as const) {
    it(`${how}: the walk answers "interrupted (replaced by ${how})" and steers no more`, async () => {
      const host = new FakeHost();
      host.wall = () => false;
      host.add({ guid: 0x7c6a9070, name: 'Monroe', itemType: 0x10, x: 80, y: 120, z: 94 });
      const api = new AgentApi(host);
      let done: { ok: boolean; message: string } | null = null;
      void api.walkTo('Monroe').then((r) => { done = r; });
      run(api, host, 1000);
      expect(done).toBeNull();
      const r = how === 'jump' ? api.jump({ holdMs: 300, forward: true }) : api.turn('east');
      expect(r.ok).toBe(true);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(done).not.toBeNull();
      expect(done!.message).toBe(`walking to Monroe: interrupted (replaced by ${how})`);
      // Nothing turns the body back toward Monroe now.
      const yaw = host.me.yaw;
      run(api, host, 1000);
      expect(host.me.yaw).toBe(yaw);
    });
  }

  it('turn takes compass words and left / right / back (toward=east answered "object has no position")', () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    expect(api.turn('east').message).toBe('facing 90°');
    expect(api.turn('NW').message).toBe('facing 315°');
    expect(api.turn('right').message).toBe('facing 45°');
    expect(api.turn('back').message).toBe('facing 225°');
  });

  it('a cast repeat is not a walk: a turn leaves it running', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.add({ guid: 0x80001234, name: 'Drudge', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30, z: 94 });
    let done: { message: string } | null = null;
    void api.cast('Flame Bolt I', 0x80001234, { repeat: true }).then((r) => { done = r; });
    run(api, host, 300);
    api.turn(90);
    await Promise.resolve();
    expect(done === null || !/replaced by turn/.test((done as { message: string }).message)).toBe(true);
    api.stopMoving();
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

describe.skipIf(!haveDat)('the real Arwic (0xC6A9): the north wall, its gates, and the far search', () => {
  const BX = 0xc6, BY = 0xa9, OX = BX * 192, OY = BY * 192;
  let probe: NavProbe;
  let at: (x: number, y: number) => NavPoint;
  let step: (x: number, y: number, z: number, dx: number, dy: number, slide: { slidingNormal: { x: number; z: number } | null }) => NavPoint;
  const CORNER = { x: 94.4, y: 97.6 }; // the walks' dead end, cell 0xC6A9001D (page trace: (38110.4, 32545.6))
  const LIFESTONE = { x: 82, y: 86 }; // beside the Life Stone #7C6A9045 at (80.46, 81.63)
  const PORTAL_AT = { x: OX + 90.56, y: OY + 140.36 }; // the Arwic Mines Portal (ACE world, landblock_instance 0x7C6A9000)

  beforeAll(async () => {
    const { buildLandblockWorld } = await import('./_harness/a9b4-world.ts');
    const { DungeonCollision } = await import('../packages/renderer/src/world/DungeonCollision.ts');
    const { outdoorGroundY } = await import('../packages/renderer/src/world/outdoorGround.ts');
    const { stepPlayerMovement } = await import('../packages/renderer/src/player/OutdoorMovement.ts');
    const base = (await buildLandblockWorld(BX, BY, { interiors: true }))({ slidingNormal: null });
    const dc = base.outdoorCollision as InstanceType<typeof DungeonCollision>;
    const groundAt = (x: number, z: number, y: number) => outdoorGroundY({ terrainHeight: (a, b) => base.terrain.getHeightAt(a, b), floorHeight: (a, b, f) => dc.getFloorHeight(a, b, f), cellAt: (a, b, f) => dc.findCellContaining(a, b, f + dc.lowerSphereHeight) }, x, z, y);
    // main.ts navProbe: a fresh sliding normal per probe (agentNav), so one probe's wall contact never steers the next.
    probe = (from, to) => {
      const services = { ...base, groundAt, slide: { slidingNormal: null } };
      const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 0.15));
      let x = from.x, z = from.y, floorY = from.z;
      for (let i = 1; i <= n; i++) {
        const tx = from.x + ((to.x - from.x) * i) / n, tz = from.y + ((to.y - from.y) * i) / n;
        const step = stepPlayerMovement({ x, z, floorY, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null }, tx - x, tz - z, 1 / 30, services);
        const g = groundAt(step.x, step.z, floorY + 0.6);
        if (g === null || g === undefined || floorY - g > services.stepDownHeight + 0.05) break;
        const moved = Math.hypot(step.x - x, step.z - z);
        x = step.x; z = step.z; floorY = g;
        if (moved < 0.01) break;
      }
      return { x, y: z, z: floorY };
    };
    at = (x, y) => ({ x: OX + x, y: OY + y, z: groundAt(OX + x, OY + y, 60)! });
    // One 1/30 s substep of the player's own movement (global metres), with the player's sliding normal kept between
    // steps as main.ts keeps it.
    step = (x, y, z, dx, dy, slide) => {
      const st = stepPlayerMovement({ x, z: y, floorY: z, inDungeon: false, airborne: false, jumpVelocityX: 0, jumpVelocityZ: 0, slideVelocity: null }, dx, dy, 1 / 30, { ...base, groundAt, slide });
      const g = groundAt(st.x, st.z, z + 0.6);
      return g === null || g === undefined || z - g > 0.65 ? { x, y, z } : { x: st.x, y: st.z, z: g };
    };
  }, 120_000);

  // The whole walk, the real AgentApi over the real collision (the body moved by stepPlayerMovement). With the far search
  // off (AgentApi.FAR_MAX_NODES = 0) this same walk answers the live one's "stuck 43.0 m short (no walkable way from
  // here: …)" (checked 2026-10-15).
  it('the real AgentApi walks from the corner to the portal: out by the west gate, round the wall, there', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const CELL = 0xc6a9001d;
      class ArwicHost extends FakeHost {
        slide = { slidingNormal: null as { x: number; z: number } | null };
        override physics(dtMs: number): void {
          const dirs: Array<[string, number]> = [['KeyW', 0], ['KeyS', Math.PI], ['KeyZ', Math.PI / 2], ['KeyC', -Math.PI / 2]];
          const held = dirs.filter(([k]) => this.keys.has(k));
          if (!held.length) return;
          const speed = this.keys.has('ShiftLeft') ? 3.12 : 4;
          for (let t = 0; t < dtMs / 1000 - 1e-9; t += 1 / 30) {
            for (const [, turn] of held) {
              const yaw = this.me.yaw + turn;
              const p = step(OX + this.me.x, OY + this.me.y, this.me.z, -Math.sin(yaw) * speed / 30, -Math.cos(yaw) * speed / 30, this.slide);
              this.me.x = p.x - OX; this.me.y = p.y - OY; this.me.z = p.z;
            }
          }
        }
        override get navProbe(): NavProbe { return probe; }
      }
      const host = new ArwicHost();
      host.wall = null;
      host.me.cell = CELL; host.me.x = CORNER.x; host.me.y = CORNER.y; host.me.z = 42;
      host.add({ guid: PORTAL, name: 'Arwic Mines Portal', objectDescFlags: 0x40000, cell: 0xc6a9001e, x: 90.56, y: 140.36, z: 41.937 });
      const api = new AgentApi(host);
      const r = await drive(api, host, api.walkTo('Arwic Mines Portal'), 900_000);
      expect(r.ok, r.message).toBe(true);
      expect(Math.hypot(host.me.x - 90.56, host.me.y - 140.36)).toBeLessThan(6);
    } finally {
      log.mockRestore();
      vi.useRealTimers();
    }
  }, 300_000);

  it('the north wall: no way through it anywhere from x 24 to x 120 (it is no line of cells: the terrain is level 42 m)', () => {
    const crossed: number[] = [];
    for (let x = 24; x <= 120; x += 2) {
      const e = probe(at(x, 92), { x: OX + x, y: OY + 125 })!;
      if (e.y - OY > 100) crossed.push(x);
    }
    expect(crossed).toEqual([]);
    // The corner: north is a wall a metre off.
    const e = probe(at(CORNER.x, CORNER.y), { x: OX + CORNER.x, y: OY + 110 })!;
    expect(e.y - OY).toBeLessThan(98.5);
  });

  it('the west gate (y 70–75) and the south gate (x 46–50) are the ways out', () => {
    const west: number[] = [], south: number[] = [];
    for (let y = 30; y <= 96; y++) if (probe(at(28, y), { x: OX + 2, y: OY + y })!.x - OX < 10) west.push(y);
    for (let x = 30; x <= 116; x++) if (probe(at(x, 28), { x: OX + x, y: OY + 2 })!.y - OY < 6) south.push(x);
    expect(west.length).toBeGreaterThan(2);
    expect(west.every((y) => y >= 69 && y <= 76)).toBe(true);
    expect(south.length).toBeGreaterThan(2);
    expect(south.every((x) => x >= 45 && x <= 51)).toBe(true);
  });

  it('from the corner: the 35 m search is boxed with no way; the far search goes out by the west gate to the portal', () => {
    const start = at(CORNER.x, CORNER.y);
    const wide = planPath(probe, start, PORTAL_AT, { spacing: 1, margin: 35, maxNodes: 6000, within: 4.8 });
    expect(wide.status).toBe('none');
    expect(wide.status === 'none' && wide.boxed).toBe(true);
    const far = planPath(probe, start, PORTAL_AT, { spacing: AgentApi.FAR_SPACING_M, margin: AgentApi.FAR_MARGIN_M, maxNodes: AgentApi.FAR_MAX_NODES, within: 4.8 });
    expect(far.status).toBe('found');
    if (far.status !== 'found') return;
    expect(far.expanded).toBeLessThan(AgentApi.FAR_MAX_NODES);
    // Out through the west gate…
    expect(far.path.some((p) => p.x - OX < 20 && p.y - OY > 68 && p.y - OY < 77)).toBe(true);
    // …to the portal, every leg a straight walk in the client's collision.
    const last = far.path[far.path.length - 1];
    expect(Math.hypot(last.x - PORTAL_AT.x, last.y - PORTAL_AT.y)).toBeLessThan(4.8);
    let p: NavPoint = start;
    // …every leg one the probe walks, as the search took it: a straight walk in grid-sized pieces, or (between grid
    // neighbours) one probe that arrives, sliding past a gate post as the body does.
    for (const q of far.path) {
      const one = probe(p, q)!;
      expect(straightWalk(probe, p, q, AgentApi.FAR_SPACING_M) || Math.hypot(one.x - q.x, one.y - q.y) <= 0.15).toBe(true);
      p = q;
    }
  }, 120_000);

  it('from the lifestone, too', () => {
    const far = planPath(probe, at(LIFESTONE.x, LIFESTONE.y), PORTAL_AT, { spacing: AgentApi.FAR_SPACING_M, margin: AgentApi.FAR_MARGIN_M, maxNodes: AgentApi.FAR_MAX_NODES, within: 4.8 });
    expect(far.status).toBe('found');
  }, 120_000);
});
