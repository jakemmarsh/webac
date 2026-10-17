/**
 * AGENT navigation (packages/renderer/src/agent/navPlanner.ts): paths found
 * with a movement probe go through door gaps and around obstacles instead of
 * into walls, and the text floor plan shows walls, gaps and you. The probe
 * here is a small fake world: a wall along x = 5 with a 1.6 m doorway at
 * y 2..3.6, and a 2 m square pillar; the body has a 0.4 m radius and stops
 * where it would touch either (the real probe is the client's own collision).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getJumpVelocity } from '@ac/shared';
import { PathSearch, floorPlan, planPath, type NavPoint } from '../packages/renderer/src/agent/navPlanner.ts';
import type { JumpKit } from '../packages/renderer/src/agent/jumpPlan.ts';
import { findRouteViaOutside, loadCellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { ac1999Dats, dungeonNav, type DungeonNav } from './_harness/dungeonNav.js';
import { DungeonHost } from './_harness/dungeonWalk.js';
import { ac1999Fixtures, ac1999WorldPresent } from './_harness/ac1999Fixtures.js';

const R = 0.4;
let probes = 0;
function blocked(x: number, y: number): boolean {
  const wall = Math.abs(x - 5) < R && !(y > 2 + R && y < 3.6 - R);
  const pillar = x > -3 - R && x < -1 + R && y > 4 - R && y < 6 + R;
  return wall || pillar;
}
function probe(from: NavPoint, to: { x: number; y: number }): NavPoint | null {
  probes++;
  const d = Math.hypot(to.x - from.x, to.y - from.y);
  const n = Math.max(1, Math.ceil(d / 0.05));
  let last = from;
  for (let s = 1; s <= n; s++) {
    const p = { x: from.x + ((to.x - from.x) * s) / n, y: from.y + ((to.y - from.y) * s) / n, z: 0 };
    if (blocked(p.x, p.y)) return last;
    last = p;
  }
  return last;
}
/** Walk the path with the probe: every leg must arrive. */
function walkable(start: NavPoint, path: NavPoint[]): boolean {
  let p = start;
  for (const w of path) {
    const got = probe(p, w)!;
    if (Math.hypot(got.x - w.x, got.y - w.y) > 0.15) return false;
    p = got;
  }
  return true;
}

describe('agent path planner (movement-probe A*)', () => {
  it('goes through the doorway instead of into the wall, and every leg is walkable', () => {
    const start = { x: 0, y: -4, z: 0 };
    const goal = { x: 9, y: -4 };
    // A straight walk stops at the wall.
    expect(probe(start, goal)!.x).toBeLessThan(5);
    const r = planPath(probe, start, goal);
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(walkable(start, r.path)).toBe(true);
    const crossing = r.path.find((p) => p.x > 5)!;
    expect(crossing).toBeDefined();
    // It crossed x = 5 inside the gap.
    const before = r.path[r.path.indexOf(crossing) - 1] ?? start;
    const t = (5 - before.x) / (crossing.x - before.x);
    const yAt = before.y + (crossing.y - before.y) * t;
    expect(yAt).toBeGreaterThan(2 + R - 0.01);
    expect(yAt).toBeLessThan(3.6 - R + 0.01);
    expect(Math.hypot(r.path.at(-1)!.x - goal.x, r.path.at(-1)!.y - goal.y)).toBeLessThanOrEqual(0.6);
    // Smoothed into a few long legs, not one point per grid step.
    expect(r.path.length).toBeLessThan(6);
  });

  it('steps around a pillar', () => {
    const start = { x: -2, y: 1, z: 0 };
    const r = planPath(probe, start, { x: -2, y: 9 });
    expect(r.status).toBe('found');
    if (r.status === 'found') expect(walkable(start, r.path)).toBe(true);
  });

  it('reports no path (and the nearest point it reached) when the goal is sealed off, within its node budget', () => {
    const start = { x: 0, y: 0, z: 0 };
    const r = planPath(probe, start, { x: -2, y: 5 }, { maxNodes: 400 }); // inside the pillar
    expect(r.status).toBe('none');
    if (r.status === 'none') {
      expect(r.expanded).toBeLessThanOrEqual(401);
      expect(r.nearest).not.toBeNull();
    }
  });

  it('runs incrementally: a step with no budget returns nothing yet, later steps finish', () => {
    const s = new PathSearch(probe, { x: 0, y: -4, z: 0 }, { x: 9, y: -4 });
    let t = 0;
    expect(s.step(0, () => (t += 1))).toBeNull();
    let r = null;
    for (let i = 0; i < 10_000 && !r; i++) r = s.step(50, () => (t += 1));
    expect(r?.status).toBe('found');
  });

  it('a floor plan shows the wall, its doorway, the pillar, you and named objects', () => {
    const plan = floorPlan(probe, { x: 0, y: 3, z: 0 }, [{ x: 8, y: 3, ch: 'A', label: 'Academy Token chest' }], { radius: 9, spacing: 1 });
    expect(plan.lines).toHaveLength(19);
    const rowOf = (y: number): string => plan.lines[9 - (y - 3)];
    const colOf = (x: number): number => x + 9;
    expect(rowOf(3)[colOf(0)]).toBe('@');
    expect(rowOf(3)[colOf(8)]).toBe('A');
    expect(rowOf(-2)[colOf(5)]).toBe('#'); // the wall
    expect(rowOf(3)[colOf(5)]).toBe('.'); // the doorway (y 3 lies in 2.4..3.2)
    expect(rowOf(5)[colOf(-2)]).toBe('#'); // the pillar
    expect(rowOf(-2)[colOf(7)]).toBe('.'); // reached the far side through the doorway
    expect(plan.legend).toEqual(['A Academy Token chest']);
  });

  it('two floors: from a walkway to the hall right below it goes down the ramp, not "arrives" overhead (Holtburg Redoubt)', () => {
    // Walkway z 0 over x 0..10, y 0..2; ramp x 10..16 down to z −6; hall z −6 over x −2..20, y −10..10.
    const floors = (x: number, y: number): number[] => {
      const out: number[] = [];
      if (x >= 0 && x <= 10 && y >= 0 && y <= 2) out.push(0);
      if (x > 10 && x <= 16 && y >= 0 && y <= 2) out.push(-(x - 10));
      if (x >= -2 && x <= 20 && y >= -10 && y <= 10) out.push(-6);
      return out;
    };
    const probe2 = (from: NavPoint, to: { x: number; y: number }): NavPoint | null => {
      const d = Math.hypot(to.x - from.x, to.y - from.y);
      const n = Math.max(1, Math.ceil(d / 0.05));
      let last = from;
      for (let k = 1; k <= n; k++) {
        const x = from.x + ((to.x - from.x) * k) / n, y = from.y + ((to.y - from.y) * k) / n;
        // The floor the body stays on: within a step of where it is (a drop off the walkway is no step).
        const f = floors(x, y).filter((z) => Math.abs(z - last.z) <= 0.6).sort((a, b) => Math.abs(a - last.z) - Math.abs(b - last.z))[0];
        if (f === undefined) return last;
        last = { x, y, z: f };
      }
      return last;
    };
    const start = { x: 5, y: 1, z: 0 };
    const r = planPath(probe2, start, { x: 5, y: 1, z: -6 }, { margin: 14 });
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    const end = r.path.at(-1)!;
    expect(Math.abs(end.z - -6)).toBeLessThanOrEqual(1.5);
    expect(Math.hypot(end.x - 5, end.y - 1)).toBeLessThanOrEqual(0.6);
    expect(r.path.some((p) => p.x > 10)).toBe(true); // by way of the ramp
    // Every leg walks with the probe, on the floors it says.
    let at: NavPoint = start;
    for (const w of r.path) { const got = probe2(at, w)!; expect(Math.hypot(got.x - w.x, got.y - w.y)).toBeLessThan(0.16); at = got; }
  });
});

describe('AGENT.walk-drops-jumps — the planner jumps and drops where walking can\'t', () => {
  // A world of floors: heights at (x, y). The body walks a step of 0.6 m up or down at most (a ledge
  // stops it, as the client's edge slide does) and is blocked by a floor top between its feet and head.
  const world = (floors: (x: number, y: number) => number[]) => {
    const below = (x: number, y: number, z: number): number | null => {
      const fs = floors(x, y).filter((f) => f <= z + 0.05);
      return fs.length ? Math.max(...fs) : null;
    };
    const blocks = (x: number, y: number, z: number, rise: number) => floors(x, y).some((f) => f > z + rise && f < z + 1.8);
    const probe = (from: NavPoint, to: { x: number; y: number }): NavPoint | null => {
      const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 0.05));
      let last = from;
      for (let k = 1; k <= n; k++) {
        const x = from.x + ((to.x - from.x) * k) / n, y = from.y + ((to.y - from.y) * k) / n;
        if (blocks(x, y, last.z, 0.6)) return last;
        const f = below(x, y, last.z + 0.6);
        if (f === null || last.z - f > 0.6) return last;
        last = { x, y, z: f };
      }
      return last;
    };
    const kit: JumpKit = {
      floor: below,
      airStep: (from, dx, dy) => {
        const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.05));
        let p = { x: from.x, y: from.y };
        for (let k = 1; k <= n; k++) {
          const t = { x: from.x + (dx * k) / n, y: from.y + (dy * k) / n };
          if (blocks(t.x, t.y, from.z, 0.05)) break;
          p = t;
        }
        return p;
      },
      launch: (power, walk) => ({ forward: walk ? 3.12 : 8, up: getJumpVelocity(0, 100, power) }),
      chargeSeconds: 1,
    };
    return { probe, kit };
  };
  const box = (x: number, y: number) => x > -10 && x < 10 && y > -10 && y < 30;

  it('a ledge drop: walks to the edge, then one drop to the floor 6 m down', () => {
    const { probe: p, kit } = world((x, y) => (box(x, y) ? (y < 5 ? [0, -6] : [-6]) : []));
    const start = { x: 0, y: 0, z: 0 };
    expect(planPath(p, start, { x: 0, y: 15, z: -6 }).status).toBe('none'); // on foot: no way down
    const r = planPath(p, start, { x: 0, y: 15, z: -6 }, { jumps: { kit, maxDamage: 20 } });
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.jumps).toBe(1);
    const j = r.path.findIndex((q) => q.jump);
    const jump = r.path[j].jump!;
    expect(jump.to.z).toBe(-6);
    expect(jump.from.z).toBe(0);
    // The take-off is the point before the landing, kept through the smoothing.
    expect(r.path[j - 1] ?? start).toMatchObject({ x: jump.from.x, y: jump.from.y });
    expect(r.path.at(-1)!.z).toBe(-6);
  });

  it('a lethal drop is refused: a 40 m fall is more than the damage allowed', () => {
    const { probe: p, kit } = world((x, y) => (box(x, y) ? (y < 5 ? [0, -40] : [-40]) : []));
    const r = planPath(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 15, z: -40 }, { jumps: { kit, maxDamage: 20 } });
    expect(r.status).toBe('none');
    // With the damage allowed (a full-health 300-point character's budget), it drops.
    expect(planPath(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 15, z: -40 }, { jumps: { kit, maxDamage: 120 } }).status).toBe('found');
  });

  it('a gap jump: across 2.5 m of pit to the far ledge, on its floor', () => {
    const { probe: p, kit } = world((x, y) => (box(x, y) ? (y > 5 && y < 7.5 ? [-30] : [0, -30]) : []));
    const r = planPath(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 15, z: 0 }, { jumps: { kit, maxDamage: 20 } });
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.jumps).toBe(1);
    const jump = r.path.find((q) => q.jump)!.jump!;
    expect(jump.to.z).toBe(0);
    expect(jump.to.y).toBeGreaterThan(7.5);
    expect(r.path.every((q) => q.z === 0)).toBe(true);
  });

  it('a platform jump: up 1.2 m, more than a step', () => {
    const { probe: p, kit } = world((x, y) => (box(x, y) ? (y > 5 && y < 12 ? [0, 1.2] : [0]) : []));
    const r = planPath(p, { x: 0, y: 0, z: 0 }, { x: 0, y: 9, z: 1.2 }, { jumps: { kit, maxDamage: 20 } });
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    const jump = r.path.find((q) => q.jump)!.jump!;
    expect(jump.to.z).toBe(1.2);
    expect(jump.power).toBeGreaterThan(0.5);
  });

  it('a search that ran into the edge of its box says so (a wider one may find a way)', () => {
    const r = planPath(probe, { x: 0, y: -4, z: 0 }, { x: -2, y: 5 }, { margin: 2, maxNodes: 400 });
    expect(r).toMatchObject({ status: 'none', boxed: true });
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Banderling Ruin (dungeon 0x01E0), the live stall of 2026-10-10', () => {
  // The ground rooms (floor z 0) sit under an atrium; the walkway rooms above (z 6) are reached by the corner ramps.
  let nav: DungeonNav;
  const BX = 0x01 * 192, BY = 0xe0 * 192;
  beforeAll(async () => { nav = await dungeonNav(0x01e00000); }, 120_000);

  it('from the doorway at (202, 42983) to the walkway at (202, 42993, z 6): none in a 12 m box (it ran into the box), found by a wider search up the north ramp', () => {
    const start = { x: BX + 10, y: BY - 25, z: 0 };
    const goal = { x: BX + 10, y: BY - 15, z: 6 };
    const narrow = planPath(nav.probe, start, goal, { margin: 12, maxNodes: 4000 });
    expect(narrow).toMatchObject({ status: 'none', boxed: true }); // live: "walk search none after 1606 points"
    const wide = planPath(nav.probe, start, goal, { spacing: 1, margin: 35, maxNodes: 6000 });
    expect(wide.status).toBe('found');
    if (wide.status !== 'found') return;
    // Up the ramp past the north end of the hall (local y > −3), where the 12 m box stopped.
    expect(wide.path.some((p) => p.y - BY > -3)).toBe(true);
    expect(wide.path.at(-1)!.z).toBeCloseTo(6, 1);
  });

  it('from the walkway landing 0x01E00121 (z 6) down to the hall (z 0): one drop off the edge, no damage', () => {
    const r = planPath(nav.probe, { x: BX + 8.5, y: BY - 28, z: 6 }, { x: BX + 10, y: BY - 20, z: 0 }, { within: 2.5, jumps: { kit: nav.kit, maxDamage: 20 } });
    expect(r.status).toBe('found');
    if (r.status !== 'found') return;
    expect(r.jumps).toBe(1);
    const jump = r.path.find((p) => p.jump)!.jump!;
    expect(jump.from.z).toBeCloseTo(6, 1);
    expect(jump.to.z).toBeCloseTo(0, 1);
    expect(jump.damage).toBe(0);
  });
});

/**
 * The AC1999 tutorial dungeon (landblock 0x017E; 0x0179 is the same dungeon), §0.12 of docs/vtank-parity-gaps.md:
 * you arrive upstairs (z −6: the Life Stone, the QUESTS sign) on a balcony whose fence (statics 0x020003B3/B4 in
 * 0x017E012E) looks over the training pit 6 m down (0x017E0109–0x0117), and the Tutorial Exit Portal (0x017E014F)
 * is on the far side of the pit. Without the dungeon's key the way down is over the fence. The doorway route's
 * point for the balcony's doorway into the air over the pit (0x017E012D) lay in the fence line, so the walk
 * never got there and never tried the drop: "stuck 10–34 m short (no walkable way …)" live on 2026-10-11.
 * Object positions: the AC1999 server's landblock_instance (reference/ac1999 …/LandBlockExtendedData/SQL/017E.sql).
 */
const AC1999_PORTAL = resolve(__dirname, '..', 'dat-sets/ac1999-retail/portal.dat');
const AC1999_CELL = resolve(__dirname, '..', 'dat-sets/ac1999-retail/cell.dat');
describe.skipIf(!existsSync(AC1999_PORTAL) || !existsSync(AC1999_CELL))('AC1999 tutorial dungeon (0x017E): from the balcony down into the training pit and on to the exit', () => {
  const LB = 0x017e0000;
  let nav: DungeonNav;
  let dats: NonNullable<ReturnType<typeof ac1999Dats>>;
  const EXIT = { cell: LB | 0x14f, x: 59.94109, y: -60.7415, z: -6.063, name: 'Tutorial Exit Portal', itemType: 0x10000000 };
  const DRUDGE = { cell: LB | 0x10d, x: 26.7907, y: -35.33574, z: -12, name: 'Straw Drudge', itemType: 0x10 };
  beforeAll(async () => {
    dats = ac1999Dats()!;
    nav = await dungeonNav(LB, { dats, statics: true });
  }, 120_000);
  afterEach(() => vi.useRealTimers());

  it('the doorway route from the Life Stone drops through the air over the pit, with no stop in the fenced doorway first', () => {
    const g = loadCellGraph(dats.cell, dats.portal, LB);
    expect(g.airCells!.has(LB | 0x12d)).toBe(true);
    const r = findRouteViaOutside(g, LB | 0x139, { x: 37, y: -51, z: -6 }, EXIT.cell, EXIT, { maxDrop: 12 })!;
    expect(r).not.toBeNull();
    const drop = r.findIndex((p) => p.drop !== undefined);
    expect(r[drop]).toMatchObject({ x: 30, y: -40, drop: 6, landing: -12 });
    // The doorway before the drop is the Life Stone room's into the balcony (35, −50), not the fenced one (30, −45).
    expect(r.slice(0, drop).map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([[35, -50]]);
    // The body can't stand at the fenced doorway's point: it stops at the fence.
    const at = nav.probe({ x: 0x01 * 192 + 30, y: 0x7e * 192 - 48, z: -6 }, { x: 0x01 * 192 + 30, y: 0x7e * 192 - 45 })!;
    expect(0x7e * 192 - 45 - at.y).toBeGreaterThan(0.3);
  });

  it('walks from the Life Stone to the Tutorial Exit Portal: over the fence, through the pit and up its ramp', async () => {
    vi.useFakeTimers();
    const host = new DungeonHost(nav, dats, LB);
    const r = await host.walk(LB | 0x139, { x: 37, y: -51, z: -6 }, EXIT);
    expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
    expect(r.message).toMatch(/^arrived .*dropped off a ledge \(6\.0 m\)/);
    expect(host.me.cell >>> 0).toBe(EXIT.cell >>> 0);
  }, 120_000);

  it('walks from the balcony (0x017E012E) to the exit, and from 0x017E0138 to a Straw Drudge in the pit', async () => {
    vi.useFakeTimers();
    const a = new DungeonHost(nav, dats, LB);
    const r1 = await a.walk(LB | 0x12e, { x: 28, y: -50, z: -6 }, EXIT);
    expect(r1, a.traces.join('\n')).toMatchObject({ ok: true });
    const b = new DungeonHost(nav, dats, LB);
    const r2 = await b.walk(LB | 0x138, { x: 42, y: -50, z: -6 }, DRUDGE);
    expect(r2, b.traces.join('\n')).toMatchObject({ ok: true });
    expect(b.me.z).toBeCloseTo(-12, 1);
  }, 180_000);
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Banderling Ruin (0x01E0), end of retail: the whole walk from the walkway to the hall', () => {
  // The walkway landing 0x01E00121 (z 6) opens onto the air over the hall (0x01E00120 → 0x01E00105), as the
  // AC1999 balcony does; here the corner ramps are a walk round shorter than a fall's route penalty, so the
  // walk goes down them on foot and arrives (end of retail unchanged by the AC1999 fix).
  it('walks from the walkway landing down to the hall by the ramps', async () => {
    const LB = 0x01e00000;
    const nav = await dungeonNav(LB, { statics: true });
    vi.useFakeTimers();
    try {
      const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB);
      const start = { x: 8.5, y: -28, z: 6 };
      const cell = nav.col.findCellContaining(0x01 * 192 + start.x, 0xe0 * 192 + start.y, start.z + 0.5);
      expect(cell >>> 0).toBe((LB | 0x121) >>> 0);
      const r = await host.walk(cell, start, { cell: LB | 0x105, x: 10, y: -20, z: 0, name: 'Hall Chest' });
      expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
      expect(r.message).toMatch(/^arrived \([0-9.]+ m from [^)]+\)$/);
      expect(host.launches).toHaveLength(0);
      expect(host.me.z).toBeCloseTo(0, 1);
    } finally { vi.useRealTimers(); }
  }, 180_000);
});

/**
 * The live sighting in the second tutorial copy (landblock 0x0179), 2026-10-11: standing at the balcony fence
 * (cell 0x0179012E, global (225.9, 23186.5), z −6), walk_to the Straw Drudge 10.3 m away and 6 m down. The
 * fence is 2 m tall (posts 0x020003B4 stacked twice, rails 0x020003B3 at 0.75 and 1.75 m): below Jump 65 no
 * jump clears it, and the other way down (the ramp, the key room) is behind the locked Door 0x7017900C
 * (LockCode keytutorial). With the server's placed objects in the collision (signs, doors, the Life Stone)
 * and Jump 50 the old walk searched 640 points twice and stood at the fence ("no walkable way"), as live.
 * Now it routes round the fall it can't make, opens the door with the Tutorial Dungeon Key from the pack,
 * and, with no key, says where the key lies.
 */
describe.skipIf(!existsSync(AC1999_PORTAL) || !existsSync(AC1999_CELL) || !ac1999WorldPresent())('AC1999 tutorial (0x0179): from the fence down to a Straw Drudge, with the server\'s objects and the character\'s Jump', () => {
  const LB = 0x01790000, BX = 0x01 * 192, BY = 0x79 * 192;
  const AT = { x: 225.9 - BX, y: 23186.5 - BY, z: -6 };
  const DRUDGE = { cell: LB | 0x10d, x: 33.86359, y: -35.19238, z: -11.99668, name: 'Straw Drudge', itemType: 0x10 };
  let dats: NonNullable<ReturnType<typeof ac1999Dats>>;
  let fixtures: ReturnType<typeof ac1999Fixtures>;
  beforeAll(() => { dats = ac1999Dats()!; fixtures = ac1999Fixtures(LB); });
  afterEach(() => vi.useRealTimers());

  const walk = async (jumpSkill: number, key: boolean) => {
    const nav = await dungeonNav(LB, { dats, statics: true, jumpSkill });
    vi.useFakeTimers();
    const host = new DungeonHost(nav, dats, LB, { fixtures });
    if (key) host.inv.push({ guid: 0x7017900b, name: 'Tutorial Dungeon Key', where: 'pack' });
    try { return { host, r: await host.walk(LB | 0x12e, AT, DRUDGE, { maxMs: 200_000 }) }; } finally { host.dispose(); }
  };

  it('reads the placed objects: the locked key-room Door, the key, the signs', () => {
    expect(fixtures.find((f) => f.guid === 0x7017900c)).toMatchObject({ name: 'Door', door: true, locked: true });
    expect(fixtures.find((f) => f.guid === 0x7017900b)?.name).toBe('Tutorial Dungeon Key');
    expect(fixtures.filter((f) => f.itemType === 8192).length).toBeGreaterThan(10);
  });

  it('Jump 100: over the fence and down', async () => {
    const { host, r } = await walk(100, false);
    expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
    expect(r.message).toMatch(/dropped off a ledge \(6\.0 m\)/);
  }, 120_000);

  it('Jump 50 with the key in the pack: round by the ramp, the key on the locked door, and on to the drudge', async () => {
    const { host, r } = await walk(50, true);
    expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
    expect(host.traces.some((l) => /no drop or jump gets down through the opening/.test(l))).toBe(true);
    expect(host.sent).toEqual(['use 7017900c', 'usewith 7017900b 7017900c', 'use 7017900c']);
    expect(host.me.z).toBeCloseTo(-12, 1);
  }, 120_000);

  it('Jump 50 and no key: stops at the locked door and says the key lies in the room', async () => {
    const { host, r } = await walk(50, false);
    expect(r.ok).toBe(false);
    expect(r.message, host.traces.join('\n')).toMatch(/locked, or it needs a key; the way down through the floor opening is past a rail higher than your jump clears\)\. A Tutorial Dungeon Key lies \d+ m away/);
  }, 120_000);
});
