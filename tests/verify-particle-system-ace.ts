/**
 * FAITHFUL.604 — ParticleSystem matches ACE's particle physics exactly.
 *
 * Anchored against reference/ACE/Source/ACE.Server/Physics/Particles/:
 *  - birthrate is the emission INTERVAL in seconds (ShouldEmitParticle:
 *    `now - lastEmitTime > Birthrate`), at most one emission per update
 *  - spawn offsets are random directions PERPENDICULAR to offsetDir
 *    (GetRandomOffset), magnitude maxOffset * rand
 *  - startTrans/finalTrans are TRANSLUCENCY (1 = invisible), so alpha
 *    = 1 - trans (PhysicsPart.SetTranslucency semantics)
 *  - positions are closed-form by lifetime (Particle.Update) — exact at
 *    any frame rate
 *
 * BUG.spellcast-effects re-anchored the kinematics on the decompiled retail
 * client where ACE's port diverges (Particle::Init @ 0051c930 /
 * Particle::Update @ 0051c290 / ParticleEmitter::InitEnd @ 0051d400):
 *  - GR parabolic types keep A and B (Init's case fall-throughs) and move
 *    like their parabolic bases; C only spins the frame
 *  - Swarm orbits with radius C: A·t + (cos(B.x t)·C.x, sin(B.y t)·C.y,
 *    cos(B.z t)·C.z) + offset
 *  - InitEnd bursts initial_particles (not total_particles)
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ParticleSystem } from '@ac/renderer/effects/ParticleSystem.js';
import type { ParticleEmitterInfo } from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';

/** Live particle positions (three.js axes) read through the system's accessors. */
const posOf = (s: ParticleSystem) => ({
  getX: (i: number) => s.positionAt(i).x,
  getY: (i: number) => s.positionAt(i).y,
  getZ: (i: number) => s.positionAt(i).z,
});

function makeInfo(overrides: Partial<ParticleEmitterInfo>): ParticleEmitterInfo {
  return {
    id: 0,
    emitterType: 1, // BirthratePerSec
    particleType: 2, // LocalVelocity
    gfxObjId: 0,
    hwGfxObjId: 0,
    birthrate: 0,
    maxParticles: 100,
    initialParticles: 0,
    totalParticles: 0,
    totalSeconds: 0,
    lifespan: 100,
    lifespanRand: 0,
    offsetDir: { x: 0, y: 0, z: 0 },
    minOffset: 0,
    maxOffset: 0,
    a: { x: 0, y: 0, z: 0 },
    minA: 0,
    maxA: 0,
    b: { x: 0, y: 0, z: 0 },
    minB: 0,
    maxB: 0,
    c: { x: 0, y: 0, z: 0 },
    minC: 0,
    maxC: 0,
    startScale: 1,
    finalScale: 1,
    scaleRand: 0,
    startTrans: 0,
    finalTrans: 0,
    transRand: 0,
    isParentLocal: 0,
    ...overrides,
  } as ParticleEmitterInfo;
}

describe('FAITHFUL.604: ParticleSystem ACE-exact physics', () => {
  it('treats birthrate as the interval in seconds', () => {
    // birthrate = 0.25s. Under the old 1/birthrate reading this emitted
    // one per 4s instead of one per 0.25s.
    const sys = new ParticleSystem(makeInfo({ birthrate: 0.25 }));
    expect(sys.activeCount).toBe(0);
    // 3.0 seconds of 0.3 s updates: every update is > 0.25 s after the
    // last emission, and ParticleEmitter::UpdateParticles @ 0051d180 emits
    // at most one per update → 10 (not a drained 0.25 s backlog of 11).
    for (let i = 0; i < 10; i++) sys.update(0.3);
    expect(sys.totalEmittedCount).toBe(10);
    // updates faster than the interval do NOT emit every tick
    const sys2 = new ParticleSystem(makeInfo({ birthrate: 1.0 }));
    for (let i = 0; i < 10; i++) sys2.update(0.1); // t=1.0, no `> 1.0` crossing yet
    expect(sys2.totalEmittedCount).toBe(0);
    sys2.update(0.1); // t=1.1 > 1.0 → first emission
    expect(sys2.totalEmittedCount).toBe(1);
    sys.dispose();
    sys2.dispose();
  });

  it('spawns offsets perpendicular to offsetDir with magnitude <= maxOffset', () => {
    const sys = new ParticleSystem(makeInfo({
      initialParticles: 50,
      maxParticles: 50,
      offsetDir: { x: 0, y: 0, z: 1 },
      minOffset: 2,
      maxOffset: 2,
      particleType: 1, // Still — position IS the offset
    }));
    sys.update(0.01);
    const pos = posOf(sys);
    let checked = 0;
    for (let i = 0; i < sys.activeCount; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      // Perpendicular to AC (0,0,1) = AC up → offsets lie in the AC x-y
      // ground plane. The buffer is THREE space (y-up), so the AC z
      // component lands on buffer Y and must be ~0.
      expect(Math.abs(y)).toBeLessThan(1e-5);
      const mag = Math.hypot(x, y, z);
      expect(mag).toBeLessThanOrEqual(2.000001); // maxOffset * rand(0,1)
      checked++;
    }
    expect(checked).toBe(50);
    sys.dispose();
  });

  it('reads startTrans/finalTrans as translucency: alpha = 1 - trans', () => {
    // trans 1 -> 0.5 (the portal-space glow emitters): starts INVISIBLE,
    // fades IN to half opacity
    const sys = new ParticleSystem(makeInfo({
      initialParticles: 1,
      maxParticles: 1,
      lifespan: 2,
      startTrans: 1,
      finalTrans: 0.5,
      particleType: 1,
    }));
    sys.update(0); // age 0
    const alpha = { getX: (i: number) => sys.alphaAt(i) };
    expect(alpha.getX(0)).toBeCloseTo(0, 5); // trans=1 → invisible
    sys.update(1); // age 1 of 2 → trans 0.75 → alpha 0.25
    expect(alpha.getX(0)).toBeCloseTo(0.25, 5);
    sys.dispose();
  });

  it('LocalVelocity positions are closed-form: frame-rate independent', () => {
    const mk = () => new ParticleSystem(makeInfo({
      initialParticles: 1,
      maxParticles: 1,
      particleType: 2, // LocalVelocity: pos = A·t + offset
      a: { x: 1, y: 0, z: 0 },
      minA: 3,
      maxA: 3,
      lifespan: 100,
    }));
    const coarse = mk();
    coarse.update(1.0);
    const fine = mk();
    for (let i = 0; i < 100; i++) fine.update(0.01);
    const px = (s: ParticleSystem) =>
      posOf(s).getX(0);
    // Both at t=1.0 with v=3: x = 3 exactly, regardless of step size
    expect(px(coarse)).toBeCloseTo(3, 5);
    expect(px(fine)).toBeCloseTo(3, 5);
    coarse.dispose();
    fine.dispose();
  });

  it('GR parabolic types (4/9/11) move like their parabolic base (Init falls through to A and B)', () => {
    // Particle::Init @ 0051c930: case ParabolicGVGAGR copies C then falls
    // into GVGA (B) and GlobalVelocity (A); Update adds A·t + B·t²/2 before
    // rotating the frame by C·t. (ACE's port keeps only C, freezing them.)
    for (const particleType of [4, 9, 11]) {
      const sys = new ParticleSystem(makeInfo({
        initialParticles: 1,
        maxParticles: 1,
        particleType,
        a: { x: 0, y: 0, z: 2 },
        minA: 1,
        maxA: 1,
        b: { x: 1, y: 0, z: 0 },
        minB: 1,
        maxB: 1,
        c: { x: 0, y: 0, z: 2 },
        minC: 1,
        maxC: 1,
        lifespan: 10,
      }));
      sys.update(2.0);
      const pos = posOf(sys);
      // t=2: AC z = 2·2 = 4 (→ THREE y), AC x = 1·4/2 = 2
      expect(pos.getY(0)).toBeCloseTo(4, 5);
      expect(pos.getX(0)).toBeCloseTo(2, 5);
      sys.dispose();
    }
  });

  it('parabolic types follow offset + A·t + B·t²/2', () => {
    const sys = new ParticleSystem(makeInfo({
      initialParticles: 1,
      maxParticles: 1,
      particleType: 8, // ParabolicLVLA: Init keeps A and B
      a: { x: 2, y: 0, z: 0 },
      minA: 1,
      maxA: 1,
      b: { x: 0, y: -1, z: 0 },
      minB: 4,
      maxB: 4,
      lifespan: 100,
    }));
    sys.update(2.0); // t=2 (AC space): x = 2*2 = 4, AC-y = -4 * 4/2 = -8
    const pos = posOf(sys);
    expect(pos.getX(0)).toBeCloseTo(4, 5);
    // AC y (north) lands on buffer Z after the AC z-up → THREE y-up swap.
    expect(pos.getZ(0)).toBeCloseTo(-8, 5);
    sys.dispose();
  });

  it('converts AC z-up kinematics to THREE y-up at buffer-write (portal vortex orbit is horizontal)', () => {
    // Swarm (type 5, the live portal vortex emitters 0x320009D9/DA):
    // Particle::Update @ 0051c290: x = A.x·t + cos(B.x·t)·C.x, y = A.y·t +
    // sin(B.y·t)·C.y, z = A.z·t + cos(B.z·t)·C.z (+ offset) in AC space — the
    // cos/sin pair orbits with radius C in the AC x-y GROUND plane while
    // AC z carries the vertical sink. Rendered in THREE space, the orbit
    // must lie in the x-z plane and the sink must land on buffer Y.
    const sys = new ParticleSystem(makeInfo({
      initialParticles: 1,
      maxParticles: 1,
      particleType: 5, // Swarm
      a: { x: 0, y: 0, z: -1 }, // sink: AC straight down
      minA: 1, maxA: 1,
      b: { x: 4, y: 4, z: 0 },  // orbit freq in the AC ground plane
      minB: 1, maxB: 1,
      c: { x: 0.5, y: 0.5, z: 0 },
      minC: 1, maxC: 1,
      maxOffset: 0,
      minOffset: 0,
      lifespan: 100,
    }));
    sys.update(2.0);
    const pos = posOf(sys);
    // t=2: AC x = cos(2·4)·0.5, AC y = sin(8)·0.5,
    // AC z = (-1)·2 + cos(0)·0 = -2.
    expect(pos.getX(0)).toBeCloseTo(Math.cos(8) * 0.5, 5);
    expect(pos.getY(0)).toBeCloseTo(-2, 5);        // AC z (vertical) → THREE y
    expect(pos.getZ(0)).toBeCloseTo(Math.sin(8) * 0.5, 5); // AC y (north) → THREE z
    sys.dispose();
  });

  it('expires particles at their lifespan and respects maxParticles', () => {
    const sys = new ParticleSystem(makeInfo({
      initialParticles: 5,
      maxParticles: 5,
      lifespan: 1,
      particleType: 1,
    }));
    expect(sys.activeCount).toBe(5);
    sys.update(1.5);
    // All five die (KillParticle), then the same update emits one
    // (birthrate 0: every update is past the interval).
    expect(sys.activeCount).toBe(1);
    sys.dispose();
  });

  it('DECOMP.emitter-backlog — at most ONE emission per update, however short the interval', () => {
    // 186 EoL emitters have intervals under 1/30 s; retail's UpdateParticles
    // emits once per call (ShouldEmitParticle → EmitParticle), and the next
    // interval counts from that emission (last_emit_time = now).
    const sys = new ParticleSystem(makeInfo({ birthrate: 0.01, maxParticles: 100 }));
    sys.update(0.1);
    expect(sys.totalEmittedCount).toBe(1);
    sys.update(0.1);
    expect(sys.totalEmittedCount).toBe(2);
    // Within the interval of the last emission: nothing.
    const slow = new ParticleSystem(makeInfo({ birthrate: 0.25 }));
    slow.update(0.3); // emits, last = 0.3
    slow.update(0.2); // 0.2 since → no
    expect(slow.totalEmittedCount).toBe(1);
    slow.update(0.1); // 0.3 since → yes
    expect(slow.totalEmittedCount).toBe(2);
    sys.dispose();
    slow.dispose();
  });

  it('InitEnd bursts initialParticles; a bounded emitter stops at totalParticles', () => {
    // ParticleEmitter::InitEnd @ 0051d400 loops initial_particles.
    const sys = new ParticleSystem(makeInfo({
      totalParticles: 8,
      maxParticles: 20,
      initialParticles: 3,
      birthrate: 0.1,
      lifespan: 50,
      particleType: 1,
    }));
    expect(sys.activeCount).toBe(3); // InitEnd burst
    for (let i = 0; i < 10; i++) sys.update(0.3);
    expect(sys.totalEmittedCount).toBe(8); // stopped at the total cap
    expect(sys.isStopped).toBe(true);
    sys.dispose();
  });

  it('supports sprite textures with additive blending', () => {
    const tex = new THREE.DataTexture(new Uint8Array([255, 0, 255, 255]), 1, 1);
    const sys = new ParticleSystem(makeInfo({ initialParticles: 1, maxParticles: 1 }), 0xffffff, {
      map: tex,
      additive: true,
    });
    const mat = sys.meshes[0].material as THREE.MeshLambertMaterial;
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.map).toBe(tex);
    // VISUAL.particle-surfaces-unlit — additive surfaces are never fogged (SetSurface @ 0059c4d0).
    expect(mat.fog).toBe(false);
    expect(mat.depthWrite).toBe(false);
    sys.dispose();
    tex.dispose();
  });
});
