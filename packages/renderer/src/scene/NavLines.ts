/**
 * VirindiTank's Show Nav Lines (docs/vtank-parity-gaps.md §4.5): the loaded
 * route drawn in the 3D world. Off by default (the ShowNavLines option, the
 * Options tab's switch).
 *
 * What is drawn follows MOSS's facts (MossTankPanel.NavLines): a line through
 * the route's points in order, closing back to the first on a circular route;
 * no line out of a portal, recall or jump point (the character doesn't walk
 * that leg); a 24-segment ring of the arrival radius (Follow/Nav Min, clamped
 * to 0.15–50 m) round each point; the point the macro walks to next in its own
 * colour (0x80FF40), the rest 0xFF40FF; a hair (5 cm) above the ground, the
 * line following the terrain outdoors; at most 2048 points; nothing in portal
 * space. MOSS rebuilds the lines only when something they depend on changes;
 * so does this.
 *
 * Cheap by design: one THREE.LineSegments with a vertex-coloured buffer,
 * rebuilt only when the route, its current point, the radius or the frame
 * (outdoor / dungeon) change. Its own module; main.ts only feeds it.
 */
import * as THREE from 'three';

/** A route point in the render world's frame (x, z on the ground plane; y up; null: height unknown). */
export interface NavLinePoint {
  x: number;
  z: number;
  y: number | null;
  /** A portal, recall or jump point: no line leaves it. */
  noLegOut?: boolean;
}

export interface NavLinesRoute {
  points: NavLinePoint[];
  circular: boolean;
  /** The point walked to next (-1: none). */
  current: number;
  /** The arrival radius, metres (VTank's Follow/Nav Min). */
  radius: number;
  /** Outdoors the line follows the ground between points; in a dungeon it runs straight. */
  outdoor: boolean;
}

export const NAV_LINE_COLOR = 0xff40ff;
export const NAV_CURRENT_COLOR = 0x80ff40;
export const NAV_LINE_MAX_POINTS = 2048;
export const NAV_LINE_LIFT = 0.05;
const RING_SEGMENTS = 24;
/** Outdoors a leg is cut every few metres so it follows the ground. */
const LEG_STEP = 4;

/** The ground height under a point (null when not known), searched from `fromY`. */
export type NavGround = (x: number, z: number, fromY: number | null) => number | null;

/**
 * The line segments for a route: pairs of points (x, y, z) and a colour per
 * vertex. Pure, so the shape is testable without a renderer.
 */
export function navLineSegments(route: NavLinesRoute, ground: NavGround): { positions: number[]; colors: number[] } {
  const positions: number[] = [];
  const colors: number[] = [];
  const pts = route.points.slice(0, NAV_LINE_MAX_POINTS);
  const heightAt = (x: number, z: number, near: number | null): number => {
    const g = ground(x, z, near === null ? null : near + 0.5);
    return (g ?? near ?? 0) + NAV_LINE_LIFT;
  };
  const yOf = pts.map((p) => (p.y !== null ? p.y + NAV_LINE_LIFT : heightAt(p.x, p.z, null)));
  const push = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number) => {
    positions.push(ax, ay, az, bx, by, bz);
    const r = ((color >> 16) & 0xff) / 255, g = ((color >> 8) & 0xff) / 255, b = (color & 0xff) / 255;
    colors.push(r, g, b, r, g, b);
  };
  const radius = Math.max(0.15, Math.min(50, route.radius));
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const color = i === route.current ? NAV_CURRENT_COLOR : NAV_LINE_COLOR;
    // The arrival ring, at the point's own height.
    for (let j = 0; j < RING_SEGMENTS; j++) {
      const a = (j * Math.PI * 2) / RING_SEGMENTS, b = ((j + 1) * Math.PI * 2) / RING_SEGMENTS;
      push(p.x + Math.cos(a) * radius, yOf[i], p.z + Math.sin(a) * radius, p.x + Math.cos(b) * radius, yOf[i], p.z + Math.sin(b) * radius, color);
    }
    let next = i + 1;
    if (next === pts.length && route.circular) next = 0;
    if (next >= pts.length || next === i || p.noLegOut) continue;
    const q = pts[next];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    const n = route.outdoor ? Math.max(1, Math.ceil(len / LEG_STEP)) : 1;
    let px = p.x, py = yOf[i], pz = p.z;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = p.x + (q.x - p.x) * t, z = p.z + (q.z - p.z) * t;
      const y = k === n ? yOf[next] : heightAt(x, z, yOf[i] + (yOf[next] - yOf[i]) * t);
      push(px, py, pz, x, y, z, NAV_LINE_COLOR);
      px = x; py = y; pz = z;
    }
  }
  return { positions, colors };
}

/** A stable key for what the lines depend on: unchanged, nothing is rebuilt. */
export function navLinesKey(route: NavLinesRoute | null): string {
  if (!route) return '';
  const r = (v: number | null) => (v === null ? 'n' : v.toFixed(2));
  return `${route.circular ? 'c' : 'l'}|${route.current}|${route.radius}|${route.outdoor ? 'o' : 'd'}|${route.points.map((p) => `${r(p.x)},${r(p.z)},${r(p.y)}${p.noLegOut ? '!' : ''}`).join(';')}`;
}

/** The one line object in the scene. `update(null)` hides it. */
export class NavLinesOverlay {
  readonly object: THREE.LineSegments;
  private key = '';

  constructor(private readonly scene: THREE.Object3D) {
    const geom = new THREE.BufferGeometry();
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true, transparent: false });
    this.object = new THREE.LineSegments(geom, mat);
    this.object.name = 'vtank-nav-lines';
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.renderOrder = 10;
  }

  /** Whether the last update rebuilt the buffer (for tests: an unchanged route costs nothing). */
  rebuilt = false;

  update(route: NavLinesRoute | null, ground: NavGround): void {
    this.rebuilt = false;
    const key = navLinesKey(route && route.points.length ? route : null);
    if (!key) {
      if (this.object.visible) { this.object.visible = false; this.object.removeFromParent(); }
      this.key = '';
      return;
    }
    if (!this.object.parent) this.scene.add(this.object);
    this.object.visible = true;
    if (key === this.key) return;
    this.key = key;
    const { positions, colors } = navLineSegments(route!, ground);
    const geom = this.object.geometry;
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geom.computeBoundingSphere();
    this.rebuilt = true;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

/**
 * A route's points in the render world: each point's map coordinates as
 * global metres (`parse`, AgentApi parseMapCoords), moved into the world's
 * frame (`toWorld`: outdoors the same, in a dungeon its stream-offset frame),
 * its recorded height (VTank's map units × 240) when it has one, and whether
 * a leg leaves it (not from a recall, a portal or a jump).
 */
export function routeNavPoints(
  route: { points: string[]; z?: Array<number | null>; stops?: Array<{ at: number; do: Array<{ kind: string; vt?: { objectClass?: number } }> }> },
  parse: (coords: string) => { x: number; y: number } | null,
  toWorld: (gx: number, gy: number) => { x: number; z: number },
): NavLinePoint[] {
  const z = route.z?.length === route.points.length ? route.z : null;
  const out: NavLinePoint[] = [];
  route.points.forEach((c, i) => {
    const g = parse(c);
    if (!g) return;
    const w = toWorld(g.x, g.y);
    const steps = route.stops?.find((s) => s.at === i)?.do ?? [];
    const noLegOut = steps.some((a) => a.kind === 'cast' || a.kind === 'use-portal' || a.kind === 'jump' || (a.kind === 'use-object' && a.vt?.objectClass === 14));
    const h = z?.[i];
    out.push({ x: w.x, z: w.z, y: typeof h === 'number' ? h * 240 : null, ...(noLegOut ? { noLegOut: true } : {}) });
  });
  return out;
}
