/**
 * AGENT navigation (packages/renderer/src/agent/navPlanner.ts): paths found
 * with a movement probe go through door gaps and around obstacles instead of
 * into walls, and the text floor plan shows walls, gaps and you. The probe
 * here is a small fake world: a wall along x = 5 with a 1.6 m doorway at
 * y 2..3.6, and a 2 m square pillar; the body has a 0.4 m radius and stops
 * where it would touch either (the real probe is the client's own collision).
 */
import { describe, expect, it } from 'vitest';
import { PathSearch, floorPlan, planPath, type NavPoint } from '../packages/renderer/src/agent/navPlanner.ts';

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
