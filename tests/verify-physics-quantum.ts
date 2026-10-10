/**
 * BUG.forward-run-speed-exceeds-configured-rate — the filed premise (forward
 * run applies ~2.7x the configured speed) was REFUTED by live measurement on
 * the fixed stack: 6.195 m/s measured vs 6.200 m/s configured, ratio 0.999
 * (verification/playtest/2026-08-19T23-03-50-076Z-run-speed/). The 16.6 m/s
 * reading came from long frames: the game loop fed the RAW wall-clock frame
 * delta into movement integration, so a multi-second hitch (SwiftShader
 * ReadPixels stall, GC pause, backgrounded tab) applied as one enormous
 * unchecked swept step.
 *
 * Retail bounds every physics step instead — acclient
 * CPhysicsObj::update_object (same shape as ACE PhysicsObj.cs:4169-4186):
 *   if (deltaTime > HugeQuantum) { consume the time; simulate nothing }
 *   while (deltaTime > MaxQuantum) { integrate MaxQuantum; deltaTime -= MaxQuantum }
 *   if (deltaTime > MinQuantum)   { integrate the remainder }
 *
 * These tests drive the REAL physicsQuantumSteps + the REAL CameraController
 * to prove the two guarantees that matter: a stall simulates nothing, and a
 * hitch covers the same distance in collision-checkable chunks.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  physicsQuantumSteps, physicsQuantumDelta,
  MIN_QUANTUM, MAX_QUANTUM, HUGE_QUANTUM,
  RUN_ANIM_SPEED as SHARED_RUN_ANIM_SPEED,
} from '@ac/shared';
import * as THREE from 'three';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { RUN_ANIM_SPEED } from '../packages/shared/src/index.js';

describe('PhysicsQuantum constants are the retail client\'s (BUG.max-quantum-server-value)', () => {
  it('MIN_QUANTUM = 1/30, MAX_QUANTUM = 1/MIN_FRAMERATE = 0.2 (not ACE server 0.1), HUGE_QUANTUM = 2.0', () => {
    expect(MIN_QUANTUM).toBeCloseTo(1 / 30, 10);
    expect(MAX_QUANTUM).toBe(0.2);
    expect(HUGE_QUANTUM).toBe(2.0);
  });
});

const GLOBALS_TSV = 'reference/client-eol/symbols/globals.tsv';
describe.skipIf(!existsSync(GLOBALS_TSV))('PhysicsQuantum constants derive from acclient globals.tsv', () => {
  const g = new Map<string, string[]>();
  beforeAll(() => {
    for (const line of readFileSync(GLOBALS_TSV, 'utf8').split('\n')) {
      const cols = line.split('\t');
      g.set(cols[0], cols);
    }
  });
  it('MAX_QUANTUM = 1 / MIN_FRAMERATE and MIN_QUANTUM = 1 / MAX_FRAMERATE, HUGE_QUANTUM = 2', () => {
    expect(g.get('MAX_QUANTUM')?.[6]).toContain('/ MIN_FRAMERATE');
    expect(g.get('MIN_QUANTUM')?.[6]).toContain('/ MAX_FRAMERATE');
    expect(MAX_QUANTUM).toBeCloseTo(1 / Number(g.get('MIN_FRAMERATE')?.[6]), 12);
    expect(MIN_QUANTUM).toBeCloseTo(1 / Number(g.get('MAX_FRAMERATE')?.[6]), 12);
    expect(HUGE_QUANTUM).toBe(Number(g.get('HUGE_QUANTUM')?.[6]));
  });
});

describe('physicsQuantumSteps splits a frame delta the way ACE update_object does', () => {
  it('a normal frame is one unmodified step (no 30Hz quantization of 60fps motion)', () => {
    for (const dt of [1 / 240, 1 / 60, 1 / 30, 0.05, MAX_QUANTUM]) {
      expect(physicsQuantumSteps(dt)).toEqual([dt]);
      expect(physicsQuantumDelta(dt)).toBe(dt);
    }
  });

  it('a hitch above MaxQuantum becomes MaxQuantum chunks plus the remainder', () => {
    const steps = physicsQuantumSteps(0.45);
    expect(steps.length).toBe(3);
    expect(steps[0]).toBe(MAX_QUANTUM);
    expect(steps[1]).toBe(MAX_QUANTUM);
    expect(steps[2]).toBeCloseTo(0.05, 10);
    // No simulated time is lost — the same distance is still covered.
    expect(physicsQuantumDelta(0.45)).toBeCloseTo(0.45, 10);
  });

  it('substep counts follow retail MAX_QUANTUM = 0.2: a 150ms frame is ONE step (ACE server 0.1 would split it)', () => {
    expect(physicsQuantumSteps(0.15)).toEqual([0.15]);
    expect(physicsQuantumSteps(0.2)).toEqual([0.2]);
    expect(physicsQuantumSteps(0.25).length).toBe(2);
    expect(physicsQuantumSteps(0.7).length).toBe(4); // 0.2 x3 + 0.1
    expect(physicsQuantumSteps(0.9).length).toBe(5); // 0.2 x4 + 0.1
    expect(physicsQuantumSteps(1.95).length).toBe(10); // 0.2 x9 + 0.15
  });

  it('no single step ever exceeds MaxQuantum, for any hitch up to HugeQuantum', () => {
    for (const dt of [0.101, 0.3, 0.7, 1.0, 1.9999, HUGE_QUANTUM]) {
      const steps = physicsQuantumSteps(dt);
      expect(steps.length).toBeGreaterThan(0);
      for (const s of steps) expect(s).toBeLessThanOrEqual(MAX_QUANTUM + 1e-12);
      expect(physicsQuantumDelta(dt)).toBeCloseTo(dt, 9);
    }
  });

  it('a stall above HugeQuantum simulates nothing at all (ACE consumes the time)', () => {
    for (const dt of [2.0001, 3, 10, 600]) {
      expect(physicsQuantumSteps(dt)).toEqual([]);
      expect(physicsQuantumDelta(dt)).toBe(0);
    }
  });

  it('degenerate deltas simulate nothing', () => {
    for (const dt of [0, -1, NaN, Infinity, -Infinity]) {
      expect(physicsQuantumSteps(dt)).toEqual([]);
      expect(physicsQuantumDelta(dt)).toBe(0);
    }
  });
});

/** Build a real CameraController with forward-run engaged. */
function runningController(runRate: number): CameraController {
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
  const cc = new CameraController(camera);
  cc.runRate = runRate;
  cc.autoRun = true; // forward + running without synthesizing key events
  return cc;
}

function horizontalDistance(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

describe('forward run integrates at exactly the configured rate (the refuted premise)', () => {
  it('steady-state speed is RUN_ANIM_SPEED x runRate, not a multiple of it', () => {
    // The live probe measured runRate 1.55 -> 6.2 m/s; assert the code path
    // the probe measured produces exactly that, at several frame rates.
    const runRate = 1.55;
    for (const dt of [1 / 60, 1 / 30, 1 / 7]) {
      const cc = runningController(runRate);
      const start = cc.camera.position.clone();
      let simulated = 0;
      for (let i = 0; i < 60; i++) {
        for (const step of physicsQuantumSteps(dt)) {
          cc.update(step);
          simulated += step;
        }
      }
      const speed = horizontalDistance(cc.camera.position, start) / simulated;
      expect(speed).toBeCloseTo(RUN_ANIM_SPEED * runRate, 6);
      expect(speed).toBeCloseTo(6.2, 6);
    }
  });

  it('RUN_ANIM_SPEED is the shared ACE MotionInterp constant, not a renderer-local guess', () => {
    expect(RUN_ANIM_SPEED).toBe(SHARED_RUN_ANIM_SPEED);
  });
});

describe('quantum stepping bounds per-step travel (the real defect)', () => {
  it('a 700ms hitch covers the same distance but in collision-checkable chunks', () => {
    const runRate = 1.55;
    const speed = RUN_ANIM_SPEED * runRate;
    const hitch = 0.7;

    // Raw (pre-fix) integration: one step, one swept leap of 4.3m.
    const raw = runningController(runRate);
    const rawStart = raw.camera.position.clone();
    raw.update(hitch);
    const rawLeap = horizontalDistance(raw.camera.position, rawStart);
    expect(rawLeap).toBeCloseTo(speed * hitch, 6);
    expect(rawLeap).toBeGreaterThan(4); // far enough to tunnel through a wall

    // Quantum-stepped: same total, but no single step exceeds 0.2s of travel.
    const q = runningController(runRate);
    const qStart = q.camera.position.clone();
    let maxStepDistance = 0;
    let prev = qStart.clone();
    for (const step of physicsQuantumSteps(hitch)) {
      q.update(step);
      maxStepDistance = Math.max(maxStepDistance, horizontalDistance(q.camera.position, prev));
      prev = q.camera.position.clone();
    }
    expect(horizontalDistance(q.camera.position, qStart)).toBeCloseTo(rawLeap, 6);
    expect(maxStepDistance).toBeCloseTo(speed * MAX_QUANTUM, 6);
    expect(maxStepDistance).toBeLessThan(rawLeap / 3);
  });

  it('a multi-second stall moves the player zero metres', () => {
    const cc = runningController(1.55);
    const start = cc.camera.position.clone();
    for (const step of physicsQuantumSteps(5.0)) cc.update(step);
    expect(horizontalDistance(cc.camera.position, start)).toBe(0);
  });

  it('the stall that produced the 16.6 m/s reading no longer inflates measured speed', () => {
    // Reproduce the discovery-run shape: a 4s hold (28 frames at the cloud's
    // ~7fps) interrupted by one 6.5s stall, measured against the 4s the
    // harness believes elapsed. Raw integration reports ~2.6x the configured
    // speed — the filed 16.6-vs-6.2 artifact; the quantum rules report the
    // configured speed.
    const runRate = 1.55;
    const configured = RUN_ANIM_SPEED * runRate;
    const nominalHold = 4.0;
    const frames = [...Array(14).fill(1 / 7), 6.5, ...Array(14).fill(1 / 7)];

    const raw = runningController(runRate);
    const rawStart = raw.camera.position.clone();
    for (const f of frames) raw.update(f);
    const rawSpeed = horizontalDistance(raw.camera.position, rawStart) / nominalHold;
    expect(rawSpeed).toBeGreaterThan(16); // the filed 16.6 m/s reading
    expect(rawSpeed / configured).toBeGreaterThan(2.5); // the filed ~2.7x

    const q = runningController(runRate);
    const qStart = q.camera.position.clone();
    let simulated = 0;
    for (const f of frames) {
      for (const step of physicsQuantumSteps(f)) {
        q.update(step);
        simulated += step;
      }
    }
    const qSpeed = horizontalDistance(q.camera.position, qStart) / simulated;
    expect(qSpeed).toBeCloseTo(configured, 6);
  });
});
