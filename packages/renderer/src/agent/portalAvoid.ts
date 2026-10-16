/**
 * Portals are ethereal, so the movement collision the walk planner probes with walks straight over
 * them, and stepping into one teleports the player (ACE Portal.OnCollideObject). A walk in Banderling
 * Ruin (2026-10-10) planned its first leg over the dungeon's exit portal beside the entry and left the
 * dungeon ("went through a portal on the way"). `avoidDisks` wraps a NavProbe so every portal that is
 * not the walk's own destination stops a probe at its rim, like a wall: the planner then routes round.
 */
import type { NavPoint, NavProbe } from './navPlanner.js';

/** A circle on the floor to keep out of: centre, radius (the body's radius included) and floor height. */
export interface AvoidDisk { x: number; y: number; z: number; r: number;
  /** How far above or below a probe's path the disk still counts (default FLOOR_SPAN_M): a standing body's height. */
  span?: number }

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
      const span = d.span ?? FLOOR_SPAN_M;
      if (Math.abs(from.z - d.z) > span && Math.abs(got.z - d.z) > span) continue;
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

/** How far ahead of the body (along its heading) a portal's disk slows the run to a walk. */
export const PORTAL_SLOW_LOOKAHEAD_M = 4;

/**
 * The planner's disks keep the planned way out of every portal, but the body runs metres between two looks of the walk
 * (a slow frame at run speed) and carries on past a waypoint in the direction it was heading. A waypoint the search put
 * 2.8 m from a portal's centre (0.9 m outside its touch) was overrun into it: Bulwark, standing in the ring of seven
 * housing portals SE of Holtburg (landblock 0xABB1), set off north, ran 2 m east to the search's first point and went
 * through the Holtburg Wilderness Settlement Portal (2026-10-16 21:18:33Z, WeenieError ITeleported). So each tick:
 * - `inside`: the body is already within a disk and its heading takes it nearer the portal: let go of forward now.
 * - `near`: the next PORTAL_SLOW_LOOKAHEAD_M along the heading cross a disk: walk, don't run (a walk moves 0.3 m a look).
 * `aim` is where the walk is heading; disks on another floor (span) are ignored, as avoidDisks does.
 */
export function portalGuard<D extends AvoidDisk>(me: NavPoint, aim: { x: number; y: number }, disks: readonly D[], lookahead = PORTAL_SLOW_LOOKAHEAD_M): { kind: 'inside' | 'near'; disk: D } | null {
  const dx = aim.x - me.x;
  const dy = aim.y - me.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const ux = dx / len, uy = dy / len;
  let near: D | null = null;
  for (const d of disks) {
    if (Math.abs(me.z - d.z) > (d.span ?? FLOOR_SPAN_M)) continue;
    const fx = me.x - d.x, fy = me.y - d.y;
    const dist = Math.hypot(fx, fy);
    // Heading nearer its centre: the component of the heading toward it.
    const inward = fx * ux + fy * uy < 0;
    if (dist < d.r) { if (inward) return { kind: 'inside', disk: d }; continue; }
    if (!inward || near) continue;
    // Closest approach of the heading's next `lookahead` metres to the centre.
    const t = Math.min(lookahead, Math.max(0, -(fx * ux + fy * uy)));
    if (Math.hypot(fx + ux * t, fy + uy * t) < d.r) near = d;
  }
  return near ? { kind: 'near', disk: near } : null;
}
