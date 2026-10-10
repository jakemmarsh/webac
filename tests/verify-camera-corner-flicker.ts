/**
 * BUG.camera-corner-zoom-flicker — the indoor camera clip must give the same
 * answer when fed its own output. Retail sweeps the 0.3 m viewer sphere from
 * the pivot (SmartBox::update_viewer @ 00453ce0) and stops at first contact,
 * so a wall at w caps every request at w − 0.3. The old ray test passed any
 * request between w − 0.3 and w untouched, so the rig (easing outward from
 * last frame's clip) crept out and snapped back 0.3 m every few frames.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DungeonCollision } from '@ac/renderer/world/DungeonCollision.js';

/** A wall plane facing the player, `w` m behind it (along +z from the pivot at the origin). */
function withWall(w: number): DungeonCollision {
  const c = new DungeonCollision();
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial());
  wall.position.set(0, 1, w);
  c.setMeshes([wall]);
  return c;
}

const pivot = new THREE.Vector3(0, 1, 0);

describe('BUG.camera-corner-zoom-flicker — DungeonCollision.getCameraDistance', () => {
  it('caps every request past the contact at wall − 0.3, including requests just short of the wall', () => {
    const c = withWall(1.5);
    for (const d of [1.21, 1.3, 1.45, 1.5, 2, 2.75]) expect(c.getCameraDistance(pivot, 0, 1, d)).toBeCloseTo(1.2, 5);
  });

  it('leaves a request clear of the sphere alone', () => {
    const c = withWall(1.5);
    expect(c.getCameraDistance(pivot, 0, 1, 1.1)).toBeCloseTo(1.1, 5);
    expect(c.getCameraDistance(pivot, 0, 1, 1.2)).toBeCloseTo(1.2, 5);
  });

  it('settles: easing out from last frame\'s clip converges instead of sawtoothing', () => {
    const c = withWall(1.5);
    const target = 2.75;
    const step = 0.45 * (1 / 60) * 10; // RetailCamera stiffnessBlend at 60 fps
    let d = 1.0;
    const seen: number[] = [];
    for (let frame = 0; frame < 60; frame++) {
      const sought = d + (target - d) * step;
      d = c.getCameraDistance(pivot, 0, 1, sought);
      seen.push(d);
    }
    const tail = seen.slice(-30);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(1e-9);
    expect(tail[0]).toBeCloseTo(1.2, 5);
  });

  it('does the same for a cylinder obstacle', () => {
    const c = new DungeonCollision();
    c.addCylinderObstacle(1, 0, 3, 1); // entry along +z at 3 − (1 + 0.25) = 1.75
    const out = [1.5, 1.6, 1.7, 1.75, 3].map((d) => c.getCameraDistance(pivot, 0, 1, d));
    expect(out[0]).toBeCloseTo(1.45, 5);
    for (const d of out.slice(1)) expect(d).toBeCloseTo(1.45, 5);
  });
});
