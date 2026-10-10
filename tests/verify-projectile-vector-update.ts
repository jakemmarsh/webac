/**
 * ASSESS: server VectorUpdate (opcode 0xF74E) must steer a projectile's
 * velocity AND spin mid-flight. onVectorUpdate was logging-only, so
 * spell/missile projectiles flew on their launch velocity only and never
 * spun (BUG.vector-update-omega-discarded: omega was parsed off the wire but
 * discarded before reaching ServerObjectManager). applyVectorUpdate feeds the
 * server velocity + omega into the projectile-integration map — for MISSILES
 * only (VectorUpdate is also sent for peers' jump arcs, driven via position).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { RemotePhysicsObject } from '../packages/renderer/src/world/RemotePhysics.js';
import { PhysicsState } from '@ac/shared';

function makeSOM(): ServerObjectManager {
  // applyVectorUpdate only touches the objects/projectiles maps — the heavy
  // renderer deps are never exercised, so stub them.
  return new ServerObjectManager(
    {} as never, {} as never, new THREE.Scene(),
  );
}

/** Inject a minimal object into the private objects map. */
function addObject(som: ServerObjectManager, guid: number, physicsState: number): void {
  (som as unknown as { objects: Map<number, unknown> }).objects.set(guid, {
    guid, physicsState, mesh: new THREE.Group(),
    worldX: 0, worldY: 0, worldZ: 0,
  });
}

/** Velocity + omega of the missile body, flattened (AC axes). */
function projectileVel(som: ServerObjectManager, guid: number) {
  const b = som.getMissileBody(guid);
  return b && { vx: b.vel.x, vy: b.vel.y, vz: b.vel.z, ox: b.omega.x, oy: b.omega.y, oz: b.omega.z };
}

function callUpdateProjectiles(som: ServerObjectManager, dt: number): void {
  (som as unknown as { updateProjectiles: (dt: number) => void }).updateProjectiles(dt);
}

describe('ServerObjectManager.applyVectorUpdate', () => {
  it('applies to a missile, keeping AC axes on the body', () => {
    const som = makeSOM();
    addObject(som, 0x500, PhysicsState.Missile);
    const applied = som.applyVectorUpdate(0x500, 1, 2, 3); // AC (x=1, y=2, z=3)
    expect(applied).toBe(true);
    expect(projectileVel(som, 0x500)).toEqual({ vx: 1, vy: 2, vz: 3, ox: 0, oy: 0, oz: 0 });
    expect(som.isProjectile(0x500)).toBe(true);
  });

  it('updates an already-tracked projectile (mid-flight correction)', () => {
    const som = makeSOM();
    addObject(som, 0x501, PhysicsState.Missile);
    som.applyVectorUpdate(0x501, 1, 0, 0);
    som.applyVectorUpdate(0x501, 0, 0, 9); // new velocity
    expect(projectileVel(som, 0x501)).toEqual({ vx: 0, vy: 0, vz: 9, ox: 0, oy: 0, oz: 0 });
  });

  it('a non-missile object (a peer jump arc) takes it on its own physics body, not as a projectile (DoVectorUpdate @ 004521c0)', () => {
    const som = makeSOM();
    addObject(som, 0x502, 0); // no Missile flag
    const obj = (som as unknown as { objects: Map<number, { physics?: RemotePhysicsObject }> }).objects.get(0x502)!;
    obj.physics = new RemotePhysicsObject({ position: null, state: 0 });
    const applied = som.applyVectorUpdate(0x502, 5, 5, 5);
    expect(applied).toBe(true);
    expect(obj.physics.velocity).toEqual({ x: 5, y: 5, z: 5 });
    expect(som.isProjectile(0x502)).toBe(false);
  });

  it('ignores an unknown guid and returns false', () => {
    const som = makeSOM();
    expect(som.applyVectorUpdate(0xdead, 1, 1, 1)).toBe(false);
  });

  it('ignores a meshless missile (would be force-deleted next tick) (review fix)', () => {
    const som = makeSOM();
    (som as unknown as { objects: Map<number, unknown> }).objects.set(0x504, {
      guid: 0x504, physicsState: PhysicsState.Missile, mesh: null,
      worldX: 0, worldY: 0, worldZ: 0,
    });
    expect(som.applyVectorUpdate(0x504, 1, 1, 1)).toBe(false);
    expect(som.isProjectile(0x504)).toBe(false);
  });

  it('still applies when the guid is already a tracked projectile even without the flag', () => {
    const som = makeSOM();
    addObject(som, 0x503, 0);
    // Registered as a projectile at create time (Missile then), flag since cleared.
    som.setPhysicsState(0x503, PhysicsState.Missile);
    som.applyVectorUpdate(0x503, 0, 0, 0);
    som.setPhysicsState(0x503, 0);
    const applied = som.applyVectorUpdate(0x503, 2, 4, 6);
    expect(applied).toBe(true);
    expect(projectileVel(som, 0x503)).toEqual({ vx: 2, vy: 4, vz: 6, ox: 0, oy: 0, oz: 0 });
  });

  it('stores omega alongside velocity (AC axes)', () => {
    const som = makeSOM();
    addObject(som, 0x505, PhysicsState.Missile);
    const applied = som.applyVectorUpdate(0x505, 1, 0, 0, 7, 8, 9); // AC omega (x=7, y=8, z=9)
    expect(applied).toBe(true);
    expect(projectileVel(som, 0x505)).toEqual({ vx: 1, vy: 0, vz: 0, ox: 7, oy: 8, oz: 9 });
  });

  it('a nonzero omega visibly rotates the projectile mesh over a frame (spell/missile spin)', () => {
    const som = makeSOM();
    addObject(som, 0x506, PhysicsState.Missile);
    som.applyVectorUpdate(0x506, 0, 0, 0, 0, 0, 2 * Math.PI); // 1 full AC-Z-axis turn/sec
    const obj = (som as unknown as { objects: Map<number, { mesh: THREE.Group }> }).objects.get(0x506)!;
    const before = obj.mesh.quaternion.clone();
    callUpdateProjectiles(som, 0.25); // quarter turn
    expect(obj.mesh.quaternion.equals(before)).toBe(false);
    // Quarter turn about a single axis: rotation angle should be ~90°.
    const angle = 2 * Math.acos(Math.min(1, Math.abs(obj.mesh.quaternion.dot(before))));
    expect(angle).toBeCloseTo(Math.PI / 2, 2);
  });

  it('zero omega leaves the projectile mesh orientation untouched', () => {
    const som = makeSOM();
    addObject(som, 0x507, PhysicsState.Missile);
    som.applyVectorUpdate(0x507, 0, 0, 0); // no omega args -> defaults to 0
    const obj = (som as unknown as { objects: Map<number, { mesh: THREE.Group }> }).objects.get(0x507)!;
    const before = obj.mesh.quaternion.clone();
    callUpdateProjectiles(som, 0.25);
    expect(obj.mesh.quaternion.equals(before)).toBe(true);
  });
});
