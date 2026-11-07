import type * as THREE from 'three';

/**
 * TOOL.playthrough-regression-steps (shield-relog) — what a held item's copy DRAWS, for comparing two attaches
 * of the same item (right after equipping vs after a relog). The requested placement id is not the pose: a
 * Setup without the requested frame falls back to frame 0 (CPartArray::SetPlacementFrame @ 0x005193d0,
 * placementFrameOf), so the 1999 shield's placement 6 (ParentEvent) and 0 (login CreateObject) draw the same
 * pose (webac#26). This compares the transforms instead: the copy's own frame on the holder part (the holding
 * location) and every part's frame inside the copy (the placement frame actually applied).
 *
 * No runtime imports: the play-through tool (tools/lib/playthrough-regressions.ts) uses it in Node.
 */

/** A local transform: position [x, y, z] and quaternion [x, y, z, w]. */
export interface PoseTransform { p: [number, number, number]; q: [number, number, number, number] }

export interface HeldPose {
  /** The placement the copy was built with (WIELDED_PLACEMENT_KEY), for the report. */
  placement: number | null;
  /** The placement frame the Setup actually used after the fallback (WIELDED_FRAME_KEY), for the report. */
  frame: number | null;
  /** The copy relative to the holder part (the holding location's frame). */
  holding: PoseTransform;
  /** Each part relative to the copy (the applied placement frame), by part name. */
  parts: Array<{ name: string } & PoseTransform>;
}

/** Tolerances: metres and degrees. */
export interface PoseTolerance { pos: number; angleDeg: number }
export const HELD_POSE_TOLERANCE: PoseTolerance = { pos: 0.005, angleDeg: 0.5 };

type Obj = Pick<THREE.Object3D, 'name' | 'children'> & {
  position: { x: number; y: number; z: number };
  quaternion: { x: number; y: number; z: number; w: number };
  userData: Record<string, unknown>;
};

const tr = (o: Obj): PoseTransform => ({ p: [o.position.x, o.position.y, o.position.z], q: [o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w] });

/**
 * The pose a held copy (a `wielded_*` group built by buildWieldedItemMesh) draws. `placementKey` / `frameKey`
 * are the userData keys stamped on it (WieldedItemVisual's WIELDED_PLACEMENT_KEY / WIELDED_FRAME_KEY).
 */
export function heldPoseOf(copy: Obj, placementKey = 'acWieldedPlacement', frameKey = 'acWieldedFrame'): HeldPose {
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const parts = (copy.children as unknown as Obj[])
    .filter((c) => /^part_\d+$/.test(c.name))
    .map((c) => ({ name: c.name, ...tr(c) }))
    .sort((a, b) => Number(a.name.slice(5)) - Number(b.name.slice(5)));
  return { placement: num(copy.userData[placementKey]), frame: num(copy.userData[frameKey]), holding: tr(copy), parts };
}

/** The angle between two rotations, in degrees (q and -q are the same rotation). */
export function quatAngleDeg(a: PoseTransform['q'], b: PoseTransform['q']): number {
  const la = Math.hypot(...a) || 1, lb = Math.hypot(...b) || 1;
  const dot = Math.abs((a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (la * lb));
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

function transformDiffs(label: string, a: PoseTransform, b: PoseTransform, tol: PoseTolerance): string[] {
  const out: string[] = [];
  const d = Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
  if (d > tol.pos) out.push(`${label} moved ${d.toFixed(3)} m`);
  const ang = quatAngleDeg(a.q, b.q);
  if (ang > tol.angleDeg) out.push(`${label} turned ${ang.toFixed(1)}°`);
  return out;
}

/** How pose `b` differs from pose `a` (empty: they draw the same, within the tolerance). */
export function heldPoseDifferences(a: HeldPose, b: HeldPose, tol: PoseTolerance = HELD_POSE_TOLERANCE): string[] {
  const out = transformDiffs('the copy on the holder part', a.holding, b.holding, tol);
  const names = new Set([...a.parts.map((p) => p.name), ...b.parts.map((p) => p.name)]);
  for (const name of names) {
    const pa = a.parts.find((p) => p.name === name), pb = b.parts.find((p) => p.name === name);
    if (!pa || !pb) { out.push(`${name} drawn only ${pa ? 'before' : 'after'}`); continue; }
    out.push(...transformDiffs(name, pa, pb, tol));
  }
  return out;
}

/** "placement 6 → frame 0" for a report line. */
export function describeHeldPose(p: HeldPose): string {
  const pl = p.placement === null ? '?' : `${p.placement}`;
  return p.frame === null ? `placement ${pl}` : p.frame === p.placement ? `placement ${pl}` : `placement ${pl} → frame ${p.frame}`;
}
