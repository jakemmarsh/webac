/**
 * Phase 15 — Animation Playback
 *
 * Tests:
 *  - AnimationPlayer interpolates between keyframes (position lerp, orientation slerp)
 *  - MotionManager transitions between stances using MotionTable data
 *  - Hook callbacks fire at correct frame indices
 *  - Animation loops correctly back to frame 0
 *  - SkeletonSystem forward kinematics (parent-child hierarchy)
 *  - Speed modulation affects playback rate
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { Animation } from '@ac/dat-parser/file-types/Animation.js';
import { MotionTable } from '@ac/dat-parser/file-types/MotionTable.js';
import { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import type { Frame } from '@ac/dat-parser/file-types/Frame.js';
import { AnimationHookType, type AnimationHook } from '@ac/dat-parser/file-types/AnimationHook.js';
import {
  AnimationPlayer,
  interpolateFrames,
  slerp,
} from '@ac/renderer/animation/AnimationPlayer.js';
import { MotionManager } from '@ac/renderer/animation/MotionManager.js';
import {
  SkeletonSystem,
  combineFrames,
  multiplyQuaternions,
  IDENTITY_FRAME,
} from '@ac/renderer/animation/SkeletonSystem.js';
import { openDat } from './_harness/dat.js';

const hasPortalDat = fs.existsSync('dat/client_portal.dat');

let portalDb: DatDatabase;

beforeAll(() => {
  if (!hasPortalDat) return;
  portalDb = openDat('dat/client_portal.dat');
});

describe.skipIf(!hasPortalDat)('Phase 15 — Animation Playback', () => {
  // ============================================================
  // Interpolation tests (pure math, no DAT required)
  // ============================================================
  describe('Frame Interpolation', () => {
    it('should lerp position between two frames', () => {
      const a: Frame = {
        origin: { x: 0, y: 0, z: 0 },
        orientation: { w: 1, x: 0, y: 0, z: 0 },
      };
      const b: Frame = {
        origin: { x: 10, y: 20, z: 30 },
        orientation: { w: 1, x: 0, y: 0, z: 0 },
      };

      const mid = interpolateFrames(a, b, 0.5);
      expect(mid.origin.x).toBeCloseTo(5, 5);
      expect(mid.origin.y).toBeCloseTo(10, 5);
      expect(mid.origin.z).toBeCloseTo(15, 5);

      const quarter = interpolateFrames(a, b, 0.25);
      expect(quarter.origin.x).toBeCloseTo(2.5, 5);
      expect(quarter.origin.y).toBeCloseTo(5, 5);
      expect(quarter.origin.z).toBeCloseTo(7.5, 5);
    });

    it('should slerp quaternion between two orientations', () => {
      // Identity to 90-degree rotation around Z
      const a = { w: 1, x: 0, y: 0, z: 0 };
      const b = { w: Math.cos(Math.PI / 4), x: 0, y: 0, z: Math.sin(Math.PI / 4) };

      const mid = slerp(a, b, 0.5);
      // Should be a 45-degree rotation around Z
      const expected45 = { w: Math.cos(Math.PI / 8), x: 0, y: 0, z: Math.sin(Math.PI / 8) };
      expect(mid.w).toBeCloseTo(expected45.w, 3);
      expect(mid.x).toBeCloseTo(expected45.x, 3);
      expect(mid.y).toBeCloseTo(expected45.y, 3);
      expect(mid.z).toBeCloseTo(expected45.z, 3);
    });

    it('should handle identity slerp (t=0 and t=1)', () => {
      const a = { w: 1, x: 0, y: 0, z: 0 };
      const b = { w: 0.707, x: 0, y: 0.707, z: 0 };

      const at0 = slerp(a, b, 0);
      expect(at0.w).toBeCloseTo(1, 3);
      expect(at0.x).toBeCloseTo(0, 3);

      const at1 = slerp(a, b, 1);
      expect(at1.w).toBeCloseTo(0.707, 2);
      expect(at1.y).toBeCloseTo(0.707, 2);
    });

    it('should handle nearly identical quaternions (dot > 0.9995)', () => {
      const a = { w: 1, x: 0, y: 0, z: 0 };
      const b = { w: 0.99999, x: 0, y: 0, z: 0.00447 };

      const mid = slerp(a, b, 0.5);
      const len = Math.sqrt(mid.w * mid.w + mid.x * mid.x + mid.y * mid.y + mid.z * mid.z);
      expect(len).toBeCloseTo(1, 3); // normalized
    });
  });

  // ============================================================
  // AnimationPlayer tests
  // ============================================================
  describe('AnimationPlayer', () => {
    it('should parse real animations and play them', () => {
      const animIds = portalDb.listFileIds(0x03);
      expect(animIds.length).toBeGreaterThan(0);

      let tested = 0;
      for (const id of animIds.slice(0, 20)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const anim = new Animation(new DatReader(data));
        if (anim.numFrames < 2 || anim.numParts === 0) continue;

        const player = new AnimationPlayer();
        player.play(anim);

        // At t=0, should be at frame 0
        const transforms0 = player.getPartTransforms();
        expect(transforms0.length).toBe(anim.numParts);

        // Advance half a frame
        player.update(1 / 60);
        const transforms1 = player.getPartTransforms();
        expect(transforms1.length).toBe(anim.numParts);

        // Check all transforms are finite
        for (const frame of transforms1) {
          expect(Number.isFinite(frame.origin.x)).toBe(true);
          expect(Number.isFinite(frame.origin.y)).toBe(true);
          expect(Number.isFinite(frame.origin.z)).toBe(true);
          expect(Number.isFinite(frame.orientation.w)).toBe(true);
        }

        tested++;
        if (tested >= 10) break;
      }
      expect(tested).toBeGreaterThanOrEqual(10);
    });

    it('steps whole keyframes like retail CSequence (get_curr_animframe → UpdateParts, no interpolation): halfway through frame 0 the parts are frame 0, at 1/30 s frame 1', () => {
      const animIds = portalDb.listFileIds(0x03);
      let verified = 0;

      for (const id of animIds.slice(0, 50)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const anim = new Animation(new DatReader(data));
        if (anim.numFrames < 2 || anim.numParts === 0) continue;

        const f0 = anim.partFrames[0].frames;
        const f1 = anim.partFrames[1].frames;
        let differs = false;
        for (let p = 0; p < f0.length; p++) {
          if (Math.abs(f0[p].origin.x - f1[p].origin.x) > 0.001) { differs = true; break; }
        }
        if (!differs) continue;

        const player = new AnimationPlayer();
        player.play(anim, 0, -1, 30);
        player.update(0.5 / 30);
        const tMid = player.getPartTransforms();
        for (let p = 0; p < f0.length; p++) expect(tMid[p]).toEqual(f0[p]);
        player.update(0.5 / 30 + 1e-6);
        const t1 = player.getPartTransforms();
        for (let p = 0; p < f1.length; p++) expect(t1[p]).toEqual(f1[p]);
        if (++verified >= 5) break;
      }
      expect(verified).toBeGreaterThanOrEqual(3);
    });

    it('should loop animation back to start', () => {
      const animIds = portalDb.listFileIds(0x03);

      for (const id of animIds.slice(0, 20)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const anim = new Animation(new DatReader(data));
        if (anim.numFrames < 3) continue;

        const player = new AnimationPlayer();
        player.play(anim, 0, -1, 30, 1.0, true);

        // Record start position
        const start = player.getPartTransforms();

        // The last keyframe is shown for a full 1/30 s: (N-1)/30 + 0.01 s is still on it
        player.update((anim.numFrames - 1) / 30 + 0.01);
        expect(player.isPlaying).toBe(true);
        expect(player.currentFrameIndex).toBe(anim.numFrames - 1);
        // The period is N/30: past it the loop is back on frame 0 with the overshoot carried
        player.update(1 / 30);
        expect(player.isPlaying).toBe(true);
        expect(player.currentFrameIndex).toBe(0);
        expect(player.currentFrame).toBeCloseTo(0.3, 5);
        expect(player.getPartTransforms()).toEqual(start);
        break;
      }
    });

    it('should stop at end when not looping', () => {
      const animIds = portalDb.listFileIds(0x03);

      for (const id of animIds.slice(0, 20)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const anim = new Animation(new DatReader(data));
        if (anim.numFrames < 3) continue;

        const player = new AnimationPlayer();
        player.play(anim, 0, -1, 30, 1.0, false);

        const totalDuration = (anim.numFrames - 1) / 30;
        player.update(totalDuration + 1.0);

        // Should have stopped
        expect(player.isPlaying).toBe(false);
        break;
      }
    });

    it('should respect speed modulation', () => {
      const animIds = portalDb.listFileIds(0x03);

      for (const id of animIds.slice(0, 20)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const anim = new Animation(new DatReader(data));
        if (anim.numFrames < 5) continue;

        // Normal speed
        const player1 = new AnimationPlayer();
        player1.play(anim, 0, -1, 30, 1.0);
        player1.update(0.1);
        const frame1 = player1.currentFrame;

        // Double speed
        const player2 = new AnimationPlayer();
        player2.play(anim, 0, -1, 30, 2.0);
        player2.update(0.1);
        const frame2 = player2.currentFrame;

        // Double speed should be at approximately twice the frame position
        expect(frame2).toBeCloseTo(frame1 * 2, 1);
        break;
      }
    });

    it('should fire hook callbacks at correct frames', () => {
      const animIds = portalDb.listFileIds(0x03);
      let tested = false;

      for (const id of animIds.slice(0, 100)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const anim = new Animation(new DatReader(data));
        if (anim.numFrames < 2) continue;

        // Find an animation with hooks
        let hasHooks = false;
        for (const pf of anim.partFrames) {
          if (pf.hooks.length > 0) {
            hasHooks = true;
            break;
          }
        }
        if (!hasHooks) continue;

        const firedHooks: { hook: AnimationHook; frameIndex: number }[] = [];
        const player = new AnimationPlayer();
        player.onHook((hook, frameIndex) => {
          firedHooks.push({ hook, frameIndex });
        });
        player.play(anim, 0, -1, 30, 1.0, false);

        // Step through all frames
        const totalDuration = (anim.numFrames - 1) / 30;
        const step = 1 / 30;
        for (let t = 0; t < totalDuration + step; t += step) {
          player.update(step);
        }

        // Should have fired at least one hook
        expect(firedHooks.length).toBeGreaterThan(0);

        // Verify hooks fire at valid frame indices
        for (const { frameIndex } of firedHooks) {
          expect(frameIndex).toBeGreaterThanOrEqual(0);
          expect(frameIndex).toBeLessThan(anim.numFrames);
        }

        tested = true;
        break;
      }
      expect(tested).toBe(true);
    });
  });

  // ============================================================
  // MotionManager tests
  // ============================================================
  describe('MotionManager', () => {
    it('should load MotionTable files from portal.dat', () => {
      const mtIds = portalDb.listFileIds(0x09);
      expect(mtIds.length).toBeGreaterThan(0);

      let loaded = 0;
      for (const id of mtIds.slice(0, 20)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const mt = new MotionTable(new DatReader(data));
        if (mt.cycles.size > 0) loaded++;
      }
      expect(loaded).toBeGreaterThanOrEqual(10);
    });

    it('should set stance and play cycle animation', () => {
      const mtIds = portalDb.listFileIds(0x09);
      let tested = 0;

      for (const id of mtIds.slice(0, 30)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const mt = new MotionTable(new DatReader(data));
        if (mt.cycles.size === 0) continue;

        const manager = new MotionManager(portalDb);
        manager.setMotionTable(mt);

        // Get first cycle key
        const firstCycleKey = mt.cycles.keys().next().value as number;
        const result = manager.setStance(firstCycleKey);
        expect(result).toBe(true);
        expect(manager.stance).toBe(firstCycleKey);
        expect(manager.animationPlayer.isPlaying).toBe(true);

        // Update should not crash
        manager.update(1 / 30);
        const transforms = manager.getPartTransforms();
        // May or may not have transforms depending on animation
        expect(transforms).toBeDefined();

        tested++;
        if (tested >= 5) break;
      }
      expect(tested).toBeGreaterThanOrEqual(3);
    });

    it('should transition between different stances', () => {
      const mtIds = portalDb.listFileIds(0x09);

      for (const id of mtIds.slice(0, 30)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const mt = new MotionTable(new DatReader(data));
        if (mt.cycles.size < 2) continue;

        const manager = new MotionManager(portalDb);
        manager.setMotionTable(mt);

        const cycleKeys = Array.from(mt.cycles.keys());

        // Set first stance
        const r1 = manager.setStance(cycleKeys[0]);
        if (!r1) continue;
        expect(manager.stance).toBe(cycleKeys[0]);

        // Transition to second stance
        const r2 = manager.setStance(cycleKeys[1]);
        if (!r2) continue;
        expect(manager.stance).toBe(cycleKeys[1]);

        // Update should play correctly
        manager.update(0.1);
        expect(manager.animationPlayer.isPlaying).toBe(true);
        break;
      }
    });

    it('should load MotionTable by ID and resolve animations', () => {
      // Find a SetupModel with a defaultMotionTable
      const setupIds = portalDb.listFileIds(0x02);
      let tested = 0;

      for (const id of setupIds) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        let setup: SetupModel;
        try {
          setup = new SetupModel(new DatReader(data));
        } catch { continue; }
        if (setup.defaultMotionTable === 0) continue;

        const manager = new MotionManager(portalDb);
        const mt = manager.loadMotionTable(setup.defaultMotionTable);
        if (!mt || mt.cycles.size === 0) continue;

        // Use setDefaultStance which handles composite key
        const ok = manager.setDefaultStance();
        if (ok) {
          manager.update(0.05);
          const transforms = manager.getPartTransforms();
          if (transforms.length > 0) {
            // Verify transforms have finite values
            for (const f of transforms) {
              expect(Number.isFinite(f.origin.x)).toBe(true);
              expect(Number.isFinite(f.orientation.w)).toBe(true);
            }
            tested++;
          }
        }
        if (tested >= 5) break;
      }
      expect(tested).toBeGreaterThanOrEqual(3);
    });

    it('should request motion from links', () => {
      const mtIds = portalDb.listFileIds(0x09);
      let tested = false;

      for (const id of mtIds.slice(0, 50)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const mt = new MotionTable(new DatReader(data));
        if (mt.cycles.size === 0 || mt.links.size === 0) continue;

        const manager = new MotionManager(portalDb);
        manager.setMotionTable(mt);

        // Set a stance that has links
        for (const [stanceKey] of mt.links) {
          const cycleData = mt.cycles.get(stanceKey);
          if (!cycleData) continue;

          manager.setStance(stanceKey);
          const linksMap = mt.links.get(stanceKey)!;
          for (const [motionKey] of linksMap) {
            const ok = manager.requestMotion(motionKey);
            if (ok) {
              expect(manager.motion).toBe(motionKey);
              tested = true;
              break;
            }
          }
          if (tested) break;
        }
        if (tested) break;
      }
      expect(tested).toBe(true);
    });
  });

  // ============================================================
  // SkeletonSystem tests
  // ============================================================
  describe('SkeletonSystem', () => {
    it('should initialize from SetupModel', () => {
      const setupIds = portalDb.listFileIds(0x02);
      let tested = 0;

      for (const id of setupIds.slice(0, 20)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const setup = new SetupModel(new DatReader(data));
        if (setup.parts.length === 0) continue;

        const skeleton = new SkeletonSystem();
        skeleton.initFromSetupModel(setup);

        expect(skeleton.numBones).toBe(setup.parts.length);
        expect(skeleton.parts.length).toBe(setup.parts.length);

        tested++;
        if (tested >= 5) break;
      }
      expect(tested).toBeGreaterThanOrEqual(5);
    });

    it('should compute world transforms with forward kinematics', () => {
      // Create a simple 3-bone chain: root → child1 → child2
      const skeleton = new SkeletonSystem();
      skeleton.setBones([1, 2, 3], [0xFF, 0, 1]); // root, child of root, child of bone 1
      // parentIndex 0xFF or >= i means root

      // Set local transforms
      const frames: Frame[] = [
        { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },  // root at origin
        { origin: { x: 5, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },  // child1 at +5x from parent
        { origin: { x: 3, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },  // child2 at +3x from parent
      ];
      skeleton.applyFrame(frames);

      const world = skeleton.computeWorldTransforms();

      // Root should be at origin
      expect(world[0].origin.x).toBeCloseTo(0, 5);
      // Child1 should be at x=5
      expect(world[1].origin.x).toBeCloseTo(5, 5);
      expect(world[1].origin.y).toBeCloseTo(0, 5);
      // Child2 should be at x=5+3=8
      expect(world[2].origin.x).toBeCloseTo(8, 5);
    });

    it('should propagate rotations through hierarchy', () => {
      const skeleton = new SkeletonSystem();
      skeleton.setBones([1, 2], [0xFF, 0]);

      // Root rotated 90 degrees around Z
      const cos45 = Math.cos(Math.PI / 4);
      const sin45 = Math.sin(Math.PI / 4);
      const frames: Frame[] = [
        { origin: { x: 0, y: 0, z: 0 }, orientation: { w: cos45, x: 0, y: 0, z: sin45 } },
        { origin: { x: 5, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },
      ];
      skeleton.applyFrame(frames);

      const world = skeleton.computeWorldTransforms();

      // Child local position (5,0,0) rotated 90° around Z should be approx (0,5,0)
      expect(world[1].origin.x).toBeCloseTo(0, 1);
      expect(world[1].origin.y).toBeCloseTo(5, 1);
      expect(world[1].origin.z).toBeCloseTo(0, 1);
    });

    it('should work with real SetupModel + Animation data', () => {
      const setupIds = portalDb.listFileIds(0x02);
      let tested = 0;

      for (const id of setupIds) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        let setup: SetupModel;
        try {
          setup = new SetupModel(new DatReader(data));
        } catch { continue; }
        if (setup.parts.length < 2 || setup.defaultMotionTable === 0) continue;

        // Load motion table
        const mtData = portalDb.getFileData(setup.defaultMotionTable);
        if (!mtData) continue;
        let mt: MotionTable;
        try {
          mt = new MotionTable(new DatReader(mtData));
        } catch { continue; }
        if (mt.cycles.size === 0) continue;

        // Get first cycle animation
        const firstCycle = mt.cycles.values().next().value as { anims: { animId: number }[] };
        if (!firstCycle || firstCycle.anims.length === 0) continue;

        const animRawData = portalDb.getFileData(firstCycle.anims[0].animId);
        if (!animRawData) continue;
        let anim: Animation;
        try {
          anim = new Animation(new DatReader(animRawData));
        } catch { continue; }
        if (anim.numFrames === 0) continue;

        // Animation numParts should match setup parts; if not, skip
        const partCount = Math.min(anim.numParts, setup.parts.length);
        if (partCount < 2) continue;

        // Create skeleton and apply first frame
        const skeleton = new SkeletonSystem();
        skeleton.initFromSetupModel(setup);
        // Apply only the parts that match
        skeleton.applyFrame(anim.partFrames[0].frames.slice(0, partCount));

        const world = skeleton.computeWorldTransforms();
        expect(world.length).toBe(setup.parts.length);

        // All world transforms should be finite
        let allFinite = true;
        for (const f of world) {
          if (!Number.isFinite(f.origin.x) || !Number.isFinite(f.origin.y) ||
              !Number.isFinite(f.origin.z) || !Number.isFinite(f.orientation.w)) {
            allFinite = false;
            break;
          }
        }
        if (!allFinite) continue;

        tested++;
        if (tested >= 5) break;
      }
      expect(tested).toBeGreaterThanOrEqual(3);
    });

    it('should dispatch hooks to registered listeners', () => {
      const skeleton = new SkeletonSystem();
      skeleton.setBones([1], [0xFF]);

      const received: { type: AnimationHookType; frame: number }[] = [];

      skeleton.registerHookListener(AnimationHookType.Sound, (hook, frameIndex) => {
        received.push({ type: hook.hookType, frame: frameIndex });
      });

      // Dispatch a Sound hook
      skeleton.dispatchHook({ hookType: AnimationHookType.Sound, direction: 0 }, 5);
      expect(received.length).toBe(1);
      expect(received[0].type).toBe(AnimationHookType.Sound);
      expect(received[0].frame).toBe(5);

      // Dispatch an Attack hook — should NOT trigger Sound listener
      skeleton.dispatchHook({ hookType: AnimationHookType.Attack, direction: 0 } as AnimationHook, 6);
      expect(received.length).toBe(1); // still 1
    });

    it('should dispatch hooks to global listeners for all types', () => {
      const skeleton = new SkeletonSystem();
      skeleton.setBones([1], [0xFF]);

      const received: AnimationHookType[] = [];
      skeleton.registerGlobalHookListener((hook) => {
        received.push(hook.hookType);
      });

      skeleton.dispatchHook({ hookType: AnimationHookType.Sound, direction: 0 }, 0);
      skeleton.dispatchHook({ hookType: AnimationHookType.Attack, direction: 0 } as AnimationHook, 1);
      skeleton.dispatchHook({ hookType: AnimationHookType.CreateParticle, direction: 0 } as AnimationHook, 2);

      expect(received.length).toBe(3);
      expect(received).toContain(AnimationHookType.Sound);
      expect(received).toContain(AnimationHookType.Attack);
      expect(received).toContain(AnimationHookType.CreateParticle);
    });
  });

  // ============================================================
  // Quaternion math tests
  // ============================================================
  describe('Quaternion Math', () => {
    it('should combine identity with any quaternion correctly', () => {
      const identity = IDENTITY_FRAME;
      const child: Frame = {
        origin: { x: 3, y: 4, z: 5 },
        orientation: { w: 0.707, x: 0, y: 0.707, z: 0 },
      };

      const result = combineFrames(identity, child);
      expect(result.origin.x).toBeCloseTo(3, 3);
      expect(result.origin.y).toBeCloseTo(4, 3);
      expect(result.origin.z).toBeCloseTo(5, 3);
      expect(result.orientation.w).toBeCloseTo(0.707, 2);
      expect(result.orientation.y).toBeCloseTo(0.707, 2);
    });

    it('should multiply identity quaternion correctly', () => {
      const identity = { w: 1, x: 0, y: 0, z: 0 };
      const q = { w: 0.5, x: 0.5, y: 0.5, z: 0.5 };

      const result = multiplyQuaternions(identity, q);
      expect(result.w).toBeCloseTo(0.5, 5);
      expect(result.x).toBeCloseTo(0.5, 5);
      expect(result.y).toBeCloseTo(0.5, 5);
      expect(result.z).toBeCloseTo(0.5, 5);
    });

    it('should compose two 90-degree rotations correctly', () => {
      // 90° around Z
      const cos45 = Math.cos(Math.PI / 4);
      const sin45 = Math.sin(Math.PI / 4);
      const rot90z = { w: cos45, x: 0, y: 0, z: sin45 };

      // Two 90° rotations = 180° rotation
      const rot180z = multiplyQuaternions(rot90z, rot90z);
      // 180° around Z: w ≈ 0, z ≈ 1
      expect(rot180z.w).toBeCloseTo(0, 3);
      expect(Math.abs(rot180z.z)).toBeCloseTo(1, 3);
    });
  });

  // ============================================================
  // Integration: Player + Skeleton
  // ============================================================
  describe('Integration: AnimationPlayer + SkeletonSystem', () => {
    it('should connect player hooks to skeleton dispatch', () => {
      const animIds = portalDb.listFileIds(0x03);
      let tested = false;

      for (const id of animIds.slice(0, 100)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const anim = new Animation(new DatReader(data));
        if (anim.numFrames < 2) continue;

        // Check for hooks
        let hasHooks = false;
        for (const pf of anim.partFrames) {
          if (pf.hooks.length > 0) { hasHooks = true; break; }
        }
        if (!hasHooks) continue;

        const skeleton = new SkeletonSystem();
        skeleton.setBones(Array.from({ length: anim.numParts }, (_, i) => i),
                         Array.from({ length: anim.numParts }, () => 0xFF));

        const receivedHooks: AnimationHook[] = [];
        skeleton.registerGlobalHookListener((hook) => {
          receivedHooks.push(hook);
        });

        const player = new AnimationPlayer();
        player.onHook((hook, frameIndex) => {
          skeleton.dispatchHook(hook, frameIndex);
        });
        player.play(anim, 0, -1, 30, 1.0, false);

        // Step through all frames
        const totalDuration = (anim.numFrames - 1) / 30;
        const step = 1 / 30;
        for (let t = 0; t <= totalDuration + step; t += step) {
          player.update(step);
        }

        expect(receivedHooks.length).toBeGreaterThan(0);
        tested = true;
        break;
      }
      expect(tested).toBe(true);
    });

    it('should apply animation frames to skeleton and produce valid world transforms', () => {
      const setupIds = portalDb.listFileIds(0x02);
      let tested = 0;

      for (const id of setupIds) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        let setup: SetupModel;
        try {
          setup = new SetupModel(new DatReader(data));
        } catch { continue; }
        if (setup.parts.length < 2 || setup.defaultMotionTable === 0) continue;

        const mtData = portalDb.getFileData(setup.defaultMotionTable);
        if (!mtData) continue;
        let mt: MotionTable;
        try {
          mt = new MotionTable(new DatReader(mtData));
        } catch { continue; }
        if (mt.cycles.size === 0) continue;

        const firstCycle = mt.cycles.values().next().value as { anims: { animId: number; framerate: number }[] };
        if (!firstCycle || firstCycle.anims.length === 0) continue;

        const animRawData = portalDb.getFileData(firstCycle.anims[0].animId);
        if (!animRawData) continue;
        let anim: Animation;
        try {
          anim = new Animation(new DatReader(animRawData));
        } catch { continue; }
        if (anim.numFrames === 0) continue;

        const skeleton = new SkeletonSystem();
        skeleton.initFromSetupModel(setup);

        const player = new AnimationPlayer();
        player.play(anim, 0, -1, firstCycle.anims[0].framerate || 30);
        player.update(0.05);

        const partTransforms = player.getPartTransforms();
        if (partTransforms.length === 0) continue;

        // Apply matching parts
        skeleton.applyFrame(partTransforms.slice(0, setup.parts.length));
        const world = skeleton.computeWorldTransforms();

        // All world transforms should be finite
        let allFinite = true;
        for (const f of world) {
          if (!Number.isFinite(f.origin.x) || !Number.isFinite(f.orientation.w)) {
            allFinite = false;
            break;
          }
        }
        if (allFinite) tested++;
        if (tested >= 5) break;
      }
      expect(tested).toBeGreaterThanOrEqual(3);
    });
  });
});
