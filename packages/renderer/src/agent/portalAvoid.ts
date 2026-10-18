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

/** Beyond this far past a portal's disk (m), no straight line the server sweeps between two reports can reach it. */
export const PORTAL_REPORT_NEAR_M = 6;

/**
 * The server moves the player only from the positions the client reports: ACE Player.UpdatePlayerPosition →
 * PhysicsObj.update_object_server sweeps ONE straight transition from the last reported spot to the new one, and a portal
 * teleports whoever that line touches (Portal.OnCollideObject). The client reports when its cell changes and otherwise at
 * most once a second (CommandInterpreter's time_between_position_events, MovementSync.shouldSendPositionEvent), so at a
 * run (~11 m/s) the server's line is a chord across metres of the body's real path. A walk that went round a portal's disk
 * in a corridor never entered the disk itself, and the server's chord from before the detour to after it ran 0.5 m from
 * the portal's middle: Bulwark's walk to 0x029E0122 went round Aerbax Haven #7029e002 in 0x029E0119 and through it
 * (2026-10-18 04:36:02Z, WeenieError ITeleported; reproduced on the cell DAT). So near a portal the walk reports the
 * body's place itself, at each bend: whenever the straight line from the last spot it reported to where the body is about
 * to run (`ahead`) would cross a disk. Returns whether to report now. `reported` null: nothing reported near these disks
 * yet (report on coming near, so the line starts outside them).
 */
export function chordNeedsReport(reported: { x: number; y: number } | null, me: NavPoint, ahead: { x: number; y: number }, disks: readonly AvoidDisk[], margin = 0.3): boolean {
  const near = disks.filter((d) => Math.abs(me.z - d.z) <= (d.span ?? FLOOR_SPAN_M) && Math.hypot(d.x - me.x, d.y - me.y) < d.r + PORTAL_REPORT_NEAR_M);
  if (!near.length) return false;
  if (!reported) return true;
  return near.some((d) => segDist(d, reported, ahead) < d.r + margin || segDist(d, reported, me) < d.r + margin);
}

function segDist(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

/** The player's own sphere (ACE: 0.48 m): a portal teleports whoever's sphere touches its own (Portal.OnCollideObject). */
export const BODY_RADIUS_M = 0.48;
/** How far past that touch the agent's body is kept from a portal it wasn't sent into (portalStepThreat). */
export const STEP_CLEAR_M = 0.15;

/**
 * The one guard every agent movement goes through (AgentApi.enforcePortalSentinel), whatever moves the body: a walk, a
 * follow, a routine's Follow or nav point, a flee, a stay_with, a stall's sidestep, a hand `move` / `jump`, a held motion.
 * The walk steers only at its ticks, and between two of them the body runs on along its heading: a follow's leg ending
 * 4.9 m north of Aerbax Haven #7029e002, run at ~11 m/s, carried the body past its end and into the portal before the next
 * look (Arcanist, 0x029E0119, 2026-10-18 13:11:11Z, 1.4 m from its middle; reproduced on the cell DAT with any look
 * ≥ 0.3 s apart). So the next stride (`stride` m along `dir` from `me`: the pace times the longest recent gap between two
 * looks, with slack) is checked against each disk (`r`: where the body's sphere would touch the portal's, plus
 * STEP_CLEAR_M): the first disk it would come into, nearer than the body stands now, is returned. Moving out of or along
 * a disk the body already stands in is no threat (an arrival beside the exit portal can always leave it).
 */
export function portalStepThreat<D extends AvoidDisk>(me: NavPoint, dir: { x: number; y: number }, stride: number, disks: readonly D[]): { disk: D; dist: number; closest: number } | null {
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-6 || stride <= 0) return null;
  const end = { x: me.x + (dir.x / len) * stride, y: me.y + (dir.y / len) * stride };
  let best: { disk: D; dist: number; closest: number } | null = null;
  for (const d of disks) {
    if (Math.abs(me.z - d.z) > (d.span ?? FLOOR_SPAN_M)) continue;
    const dist = Math.hypot(d.x - me.x, d.y - me.y);
    const closest = segDist(d, me, end);
    if (closest >= d.r || closest >= dist - 0.05) continue;
    if (!best || closest - d.r < best.closest - best.disk.r) best = { disk: d, dist, closest };
  }
  return best;
}
