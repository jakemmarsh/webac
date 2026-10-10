/**
 * CORE.18.b.a.a.a — the remaining retail camera-rig edges:
 *   - CameraSet::SetTargetForOffset @ 004576e0's full flag table (align /
 *     look-in-direction / look-at-pivot from the offset's x, y, z);
 *   - CameraSet::Rotate @ 00458310 turns viewer_offset inside the PLAYER's
 *     frame (CameraManager::UpdateCamera @ 00456660 builds the offset frame
 *     from the pivot object's heading), so an orbit ≥ 1 m to the side drops
 *     ALIGN_WITH_PLANE and looks at the pivot;
 *   - UpdateCamera's not-in-contact plane: the averaged velocity with its
 *     vertical × 0.1 becomes a frame heading, whose up column is the plane;
 *   - SmartBox::PlayerPositionUpdated @ 00453870: a blip beyond
 *     GetAutonomyBlipDistance (100 m outside / 25 m inside) calls set_viewer;
 *   - building / dungeon floors give their walkable BSP polygon's plane as
 *     the contact normal (DungeonCollision.getFloorNormal).
 * Behavioral: drives the shipped RetailCamera / RetailCameraRig /
 * CameraController / DungeonCollision code.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makePlane } from '@ac/shared';
import type { PhysicsPolygon } from '@ac/shared';
import { DungeonCollision } from '@ac/renderer/world/DungeonCollision.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { RetailCameraRig, type RigInput } from '../packages/renderer/src/scene/RetailCameraRig.js';
import {
  CAMERA_DEFAULT_PIVOT_Z, DEFAULT_VIEWER_BACK, DEFAULT_VIEWER_UP,
  PLAYER_INSIDE_BLIP_DISTANCE, PLAYER_OUTSIDE_BLIP_DISTANCE,
  SlopeAlignment, airbornePlaneNormal, blipResetsViewer, offsetAlignsWithPlane, targetForOffset,
} from '../packages/renderer/src/scene/RetailCamera.js';

const DEG = Math.PI / 180;

function rigInput(over: Partial<RigInput> = {}): RigInput {
  return {
    pivot: new THREE.Vector3(0, CAMERA_DEFAULT_PIVOT_Z, 0), facing: 0,
    back: DEFAULT_VIEWER_BACK, up: DEFAULT_VIEWER_UP, inHead: false, inHeadAhead: 0.18,
    lookPitch: 0, align: false, velocity: { x: 0, y: 0, z: 0 },
    contactNormal: { x: 0, y: 1, z: 0 }, tStiffness: 0.45, rStiffness: 0.45, dt: 1 / 60,
    ...over,
  };
}

/** A slope rising toward −z (the facing-0 forward) at `deg` degrees. */
function slopeNormal(deg: number): { x: number; y: number; z: number } {
  const a = deg * DEG;
  return { x: 0, y: Math.cos(a), z: Math.sin(a) };
}

const eulerOf = (q: THREE.Quaternion) => new THREE.Euler().setFromQuaternion(q, 'YXZ');

describe('CORE.18.b.a.a.a — SetTargetForOffset flag table', () => {
  it('the default offset (0, −2.75, 0.825) aligns, looks in direction, and looks at the pivot (z > 0.75)', () => {
    expect(targetForOffset(0, -DEFAULT_VIEWER_BACK, DEFAULT_VIEWER_UP, false))
      .toEqual({ align: true, lookInDirection: true, lookAtPivot: true, lookAtObject: false });
  });

  it('inside the level band (−0.5 ≤ z ≤ 0.75) the camera looks along the player, not at the pivot', () => {
    expect(targetForOffset(0, -2.75, 0.75, false)).toEqual({ align: true, lookInDirection: true, lookAtPivot: false, lookAtObject: false });
    expect(targetForOffset(0, -2.75, -0.5, false)).toEqual({ align: true, lookInDirection: true, lookAtPivot: false, lookAtObject: false });
    expect(targetForOffset(0, -2.75, -0.6, false)).toEqual({ align: true, lookInDirection: false, lookAtPivot: true, lookAtObject: false });
  });

  it('close behind (−0.5 ≤ y < 0) aligns without LOOK_IN_DIRECTION', () => {
    expect(targetForOffset(0, -0.4, 0.3, false)).toEqual({ align: true, lookInDirection: false, lookAtPivot: false, lookAtObject: false });
  });

  it('x outside [−1, 1), or an offset level with / ahead of the pivot, only looks at the pivot', () => {
    const pivotOnly = { align: false, lookInDirection: false, lookAtPivot: true, lookAtObject: false };
    expect(targetForOffset(1, -2.5, 0.5, false)).toEqual(pivotOnly);
    expect(targetForOffset(-1.01, -2.5, 0.5, false)).toEqual(pivotOnly);
    expect(targetForOffset(-1, -2.5, 0.5, false).align).toBe(true); // −1 is inside
    expect(targetForOffset(0, 0, 0.5, false)).toEqual(pivotOnly);
    expect(targetForOffset(0, 2.5, 0.5, false)).toEqual(pivotOnly);
    expect(offsetAlignsWithPlane(-1, -2.75, false)).toBe(true);
    expect(offsetAlignsWithPlane(1, -2.75, false)).toBe(false);
  });

  it('the in-head offset aligns and looks in direction', () => {
    expect(targetForOffset(0, 0.18, 0, true)).toEqual({ align: true, lookInDirection: true, lookAtPivot: false, lookAtObject: false });
  });
});

describe('CORE.18.b.a.a.a — mouse-look orbits viewer_offset inside the player frame', () => {
  it('the orbited viewer sits where the old whole-frame orbit put it', () => {
    const rig = new RetailCameraRig();
    const facing = 0.7, orbit = 0.3;
    rig.update(rigInput({ facing, orbit }));
    const yaw = facing + orbit;
    const expected = new THREE.Vector3(
      Math.sin(yaw) * DEFAULT_VIEWER_BACK, CAMERA_DEFAULT_PIVOT_Z + DEFAULT_VIEWER_UP, Math.cos(yaw) * DEFAULT_VIEWER_BACK);
    expect(rig.targetPosition.distanceTo(expected)).toBeLessThan(1e-9);
    // Looking at the pivot: the view yaw is the boom's, whatever the player faces.
    expect(eulerOf(rig.targetQuaternion).y).toBeCloseTo(yaw, 9);
  });

  it('lowered into the level band with a small orbit, the view looks along the PLAYER, not the boom', () => {
    const rig = new RetailCameraRig();
    rig.update(rigInput({ facing: 0.2, orbit: 0.2, up: 0.5 })); // |x| = 2.75 sin 0.2 = 0.55 < 1
    expect(rig.target).toEqual({ align: true, lookInDirection: true, lookAtPivot: false, lookAtObject: false });
    expect(eulerOf(rig.targetQuaternion).y).toBeCloseTo(0.2, 9);
    expect(eulerOf(rig.targetQuaternion).x).toBeCloseTo(0, 9);
  });

  it('swung ≥ 1 m to the side, the view looks at the pivot and the slope no longer tilts the frame', () => {
    const orbit = Math.asin(1.2 / DEFAULT_VIEWER_BACK);
    const moving = { x: 0.5, y: 0, z: -5 };
    const side = new RetailCameraRig();
    const flat = new RetailCameraRig();
    for (let i = 0; i < 5; i++) {
      side.update(rigInput({ orbit, up: 0.5, align: true, velocity: moving, contactNormal: slopeNormal(20) }));
      flat.update(rigInput({ orbit, up: 0.5, align: false }));
    }
    expect(side.target.align).toBe(false);
    expect(side.target.lookAtPivot).toBe(true);
    expect(side.targetPosition.distanceTo(flat.targetPosition)).toBeLessThan(1e-9);
    expect(side.frameForward.y).toBe(0);
    // A small orbit on the same slope still tilts it.
    const behind = new RetailCameraRig();
    for (let i = 0; i < 5; i++) {
      behind.update(rigInput({ orbit: 0.1, up: 0.5, align: true, velocity: moving, contactNormal: slopeNormal(20) }));
    }
    expect(behind.target.align).toBe(true);
    expect(Math.asin(behind.frameForward.y) / DEG).toBeCloseTo(20, 4);
  });

  it("the controller's looksAtPivot follows the orbit", () => {
    const cc = new CameraController(new THREE.PerspectiveCamera());
    expect(cc.looksAtPivot).toBe(true); // default z 0.825 > 0.75
    cc.pitch = 0.1; // lower the viewer into the level band
    const lowered = cc.thirdPersonBoom();
    expect(lowered.up).toBeLessThanOrEqual(0.75);
    expect(cc.looksAtPivot).toBe(false);
    cc.cameraYawOffset = Math.PI / 2; // swung round to the side
    expect(cc.looksAtPivot).toBe(true);
  });
});

describe('CORE.18.b.a.a.a — the airborne plane', () => {
  it('horizontal (or no) velocity gives the world-up plane', () => {
    for (const v of [{ x: 1, y: 0, z: -4 }, { x: 0, y: 0, z: 0 }]) {
      const n = airbornePlaneNormal(v);
      expect(n.x).toBeCloseTo(0, 12);
      expect(n.y).toBe(1);
      expect(n.z).toBeCloseTo(0, 12);
    }
  });

  it('the plane is perpendicular to the velocity with its vertical damped ×0.1', () => {
    const v = { x: 0.3, y: 4, z: -5 };
    const n = airbornePlaneNormal(v);
    const len = Math.hypot(v.x, v.y, v.z);
    const d = { x: v.x / len, y: v.y / len * 0.1, z: v.z / len };
    expect(n.x * d.x + n.y * d.y + n.z * d.z).toBeCloseTo(0, 9);
    expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 9);
    expect(n.y).toBeGreaterThan(0);
  });

  it('rising tilts the frame up by the damped climb angle, falling tilts it down', () => {
    const fwd = { x: 0, y: 0, z: -1 };
    const up = SlopeAlignment.alignedForward(fwd, { x: 0.01, y: 5, z: -5 }, null)!;
    const damped = Math.atan2(5 / Math.hypot(0.01, 5, 5) * 0.1, Math.hypot(0.01, 5) / Math.hypot(0.01, 5, 5));
    expect(Math.asin(up.y)).toBeCloseTo(damped, 3);
    const down = SlopeAlignment.alignedForward(fwd, { x: 0.01, y: -5, z: -5 }, null)!;
    expect(down.y).toBeCloseTo(-up.y, 9);
  });

  it('a jumping player with Align on raises the view along the damped arc', () => {
    const rig = new RetailCameraRig();
    for (let i = 0; i < 5; i++) {
      rig.update(rigInput({ up: 0.5, align: true, velocity: { x: 0.3, y: 6, z: -5 }, contactNormal: null }));
    }
    expect(eulerOf(rig.targetQuaternion).x).toBeGreaterThan(3 * DEG);
    const off = new RetailCameraRig();
    off.update(rigInput({ up: 0.5, align: false, velocity: { x: 0.3, y: 6, z: -5 }, contactNormal: null }));
    expect(eulerOf(off.targetQuaternion).x).toBeCloseTo(0, 9);
  });
});

describe('CORE.18.b.a.a.a — set_viewer on a blip', () => {
  const at = (x: number, y = 0, z = 0) => ({ x, y, z });
  it('only a blip farther than the autonomy blip distance resets the viewer', () => {
    expect(PLAYER_OUTSIDE_BLIP_DISTANCE).toBe(100);
    expect(PLAYER_INSIDE_BLIP_DISTANCE).toBe(25);
    expect(blipResetsViewer(at(0), at(100), false)).toBe(false); // param_2 <= blip skips set_viewer
    expect(blipResetsViewer(at(0), at(100.5), false)).toBe(true);
    expect(blipResetsViewer(at(0), at(25), true)).toBe(false);
    expect(blipResetsViewer(at(0), at(30), true)).toBe(true);
    expect(blipResetsViewer(at(0), at(30), false)).toBe(false);
  });

  it('the distance is Position::distance — the vertical drop counts', () => {
    // 90 m across and 50 m down: 102.96 m > 100 — a horizontal-only measure would skip set_viewer.
    expect(blipResetsViewer(at(0, 50, 0), at(90, 0, 0), false)).toBe(true);
    expect(blipResetsViewer(at(0, 0, 0), at(0, 26, 0), true)).toBe(true);
  });
});

describe('CORE.18.b.a.a.a — building / dungeon floors give their BSP plane', () => {
  const T = Math.tan(20 * DEG);
  /** A 4×4 m ramp rising 20° toward +y (AC axes), counter-clockwise from above. */
  function ramp(): PhysicsPolygon {
    const vertices = [
      { x: -2, y: -2, z: -2 * T }, { x: 2, y: -2, z: -2 * T },
      { x: 2, y: 2, z: 2 * T }, { x: -2, y: 2, z: 2 * T },
    ];
    return { vertices, plane: makePlane(vertices), numPts: 4 };
  }
  function mockGfx(poly: PhysicsPolygon) {
    const vertices = new Map<number, unknown>();
    poly.vertices.forEach((v, i) => vertices.set(i, { origin: v, normal: { x: 0, y: 0, z: 1 }, uvs: [] }));
    return {
      physicsBSP: { rootNode: { type: 'LEAF', solid: 0, sphere: { origin: { x: 0, y: 0, z: 0 }, radius: 100 }, inPolys: [0] } },
      physicsPolygons: new Map([[0, { vertexIndices: [0, 1, 2, 3], numVertices: 4, stippling: 0, sidesType: 0, portalIndex: -1, polyId: 0 }]]),
      vertexArray: { vertices },
    } as never;
  }

  it('a ramp tilts the contact normal back from its rise (renderer axes)', () => {
    const dc = new DungeonCollision();
    dc.addGfxObjCollision(1, mockGfx(ramp()), { x: 10, y: 10, z: 5 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);
    const floorY = dc.getFloorHeight(10, 11, 5 + T)!;
    expect(floorY).toBeCloseTo(5 + T, 6);
    const n = dc.getFloorNormal(10, 11, floorY)!;
    expect(n.x).toBeCloseTo(0, 6);
    expect(n.y).toBeCloseTo(Math.cos(20 * DEG), 6);
    expect(n.z).toBeCloseTo(-Math.sin(20 * DEG), 6);
    // The frame aligned on it climbs at the ramp's angle.
    const f = SlopeAlignment.alignedForward({ x: 0, y: 0, z: 1 }, { x: 0.3, y: 0, z: 4 }, n)!;
    expect(Math.asin(f.y) / DEG).toBeCloseTo(20, 4);
  });

  it("the cell's rotation carries into the normal", () => {
    const dc = new DungeonCollision();
    const q = { w: Math.cos(Math.PI / 4), x: 0, y: 0, z: Math.sin(Math.PI / 4) }; // +90° about z
    dc.addGfxObjCollision(2, mockGfx(ramp()), { x: 10, y: 10, z: 5 }, q, 0, 0);
    // Local (0, 1) → global (−1, 0).
    const n = dc.getFloorNormal(9, 10, 5 + T)!;
    expect(n.x).toBeCloseTo(Math.sin(20 * DEG), 6);
    expect(n.y).toBeCloseTo(Math.cos(20 * DEG), 6);
    expect(n.z).toBeCloseTo(0, 6);
  });

  it('no floor at that height (or no cells) → null', () => {
    const dc = new DungeonCollision();
    expect(dc.getFloorNormal(0, 0, 0)).toBeNull();
    dc.addGfxObjCollision(3, mockGfx(ramp()), { x: 10, y: 10, z: 5 }, { w: 1, x: 0, y: 0, z: 0 }, 0, 0);
    expect(dc.getFloorNormal(10, 11, 5 + T + 1)).toBeNull();
  });
});
