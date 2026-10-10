/**
 * Portals are ethereal, so the movement collision the walk planner probes with walks straight over
 * them, and stepping into one teleports the player (ACE Portal.OnCollideObject). A walk in Banderling
 * Ruin (2026-10-10) planned its first leg over the dungeon's exit portal beside the entry and left the
 * dungeon ("went through a portal on the way"). `avoidDisks` wraps a NavProbe so every portal that is
 * not the walk's own destination stops a probe at its rim, like a wall: the planner then routes round.
 */
import type { NavPoint, NavProbe } from './navPlanner.js';

/** A circle on the floor to keep out of: centre, radius (the body's radius included) and floor height. */
export interface AvoidDisk { x: number; y: number; z: number; r: number }

/** Disks more than this far above or below a probe's path are on another floor. */
const FLOOR_SPAN_M = 3;
/** How far short of the rim a stopped probe ends. */
const STOP_SHORT_M = 0.05;

export function avoidDisks(probe: NavProbe, disks: () => AvoidDisk[]): NavProbe {
  return (from, to) => {
    const got = probe(from, to);
    if (!got) return got;
    const dx = got.x - from.x;
    const dy = got.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return got;
    let tStop = Infinity;
    for (const d of disks()) {
      if (Math.abs(from.z - d.z) > FLOOR_SPAN_M && Math.abs(got.z - d.z) > FLOOR_SPAN_M) continue;
      const fx = from.x - d.x;
      const fy = from.y - d.y;
      const inside = Math.hypot(fx, fy) < d.r;
      if (inside) {
        // Already at the rim (a walk that starts beside a portal): only heading away from its centre.
        if (fx * dx + fy * dy < 0) tStop = 0;
        continue;
      }
      // |f + t·dir·len − c| = r, for t in [0, 1].
      const a = len * len;
      const b = 2 * (fx * dx + fy * dy);
      const c = fx * fx + fy * fy - d.r * d.r;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t >= 0 && t <= 1) tStop = Math.min(tStop, t);
    }
    if (tStop === Infinity) return got;
    const t = Math.max(0, tStop - STOP_SHORT_M / len);
    const p: NavPoint = { x: from.x + dx * t, y: from.y + dy * t, z: from.z + (got.z - from.z) * t };
    return p;
  };
}
