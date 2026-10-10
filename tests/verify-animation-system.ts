/**
 * Animation System Regression Tests
 *
 * These tests prevent the specific regressions we've hit:
 * 1. Player animation updated twice (2x speed)
 * 2. Server movement events interrupting local player run cycle
 * 3. Combat stance not persisting after toggle
 * 4. Creature MoveToObject not triggering walk animation
 * 5. Negative framerate (door close) not playing in reverse
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Minimal mocks for the animation system ──

class MockAnimationPlayer {
  playing = false;
  speed = 1;
  framerate = 30;
  currentTime = 0;
  looping = false;
  animation: any = null;
  lowFrame = 0;
  highFrame = 0;

  play(anim: any, low: number, high: number, framerate: number, speed: number, looping: boolean, onComplete?: () => void) {
    this.animation = anim;
    this.lowFrame = low;
    this.highFrame = high < 0 ? (anim?.numFrames ?? 1) - 1 : high;
    this.framerate = framerate;
    this.speed = speed;
    this.looping = looping;
    this.playing = true;
    this.currentTime = speed < 0 ? (this.highFrame - this.lowFrame) / framerate : 0;
  }

  get isPlaying() { return this.playing; }

  update(dt: number) {
    if (!this.playing || !this.animation) return;
    this.currentTime += dt * this.speed;
    const frameCount = this.highFrame - this.lowFrame + 1;
    if (frameCount <= 1) return;
    const totalDuration = (frameCount - 1) / this.framerate;
    if (this.currentTime >= totalDuration) {
      if (this.looping) {
        this.currentTime = this.currentTime % totalDuration;
      } else {
        this.currentTime = totalDuration;
        this.playing = false;
      }
    }
    if (this.currentTime < 0) {
      if (this.looping) {
        this.currentTime = totalDuration + (this.currentTime % totalDuration);
      } else {
        this.currentTime = 0;
        this.playing = false;
      }
    }
  }
}

/** Minimal mock of MotionData from DAT */
interface MockMotionData {
  anims: Array<{ animId: number; lowFrame: number; highFrame: number; framerate: number }>;
  velocity?: any;
  omega?: any;
}

/** Minimal mock of MotionTable */
class MockMotionTable {
  cycles = new Map<number, MockMotionData>();
  links = new Map<number, Map<number, MockMotionData>>();
  modifiers = new Map<number, MockMotionData>();
  styleDefaults = new Map<number, number>();
  defaultStyle = 0x8000003d;
}

// ── Test Suites ──

describe('Animation System Regressions', () => {

  describe('Player animation double-update prevention', () => {
    it('playerAnimated.update() should NOT be called directly when registered with SOM', () => {
      // The player's AnimatedEntity is registered in SOM.animatedObjects.
      // SOM.updateAnimations() iterates all animatedObjects and calls update().
      // If main.ts ALSO calls playerAnimated.update(dt), the animation runs at 2x speed.
      //
      // This test verifies the pattern: search main.ts for playerAnimated.update(dt)
      // and ensure it's commented out or removed.
      const fs = require('fs');
      const mainSource = fs.readFileSync('packages/renderer/src/main.ts', 'utf8');

      // Should NOT have an active playerAnimated.update(dt) call
      // (it should be commented out since SOM handles it)
      const activeUpdateCalls = mainSource
        .split('\n')
        .filter((line: string) =>
          line.includes('playerAnimated.update(dt)') &&
          !line.trim().startsWith('//') &&
          !line.trim().startsWith('*')
        );

      expect(activeUpdateCalls).toHaveLength(0);
    });
  });

  describe('Server movement events skip local player stance/forward', () => {
    it('handleMovementEvent should not call setStanceFromId for localPlayerGuid', async () => {
      // When the server echoes back the local player's movement events,
      // the SOM should NOT apply stance or forward motion changes — those
      // are managed by CharacterAnimController. Only action nodes (attacks)
      // should be processed. (Behavioral: drives the real SOM with a
      // 0xF74C body — 6-byte header, Invalid type, style + forward.)
      const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
      const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
      const calls: string[] = [];
      const mm = {
        queueAction: () => calls.push('action'),
        setForwardMotion: () => { calls.push('forward'); return true; },
        setStanceFromId: () => calls.push('stance'),
        playDeath: () => false,
        isPlayingAction: false,
        currentStyleId: 0,
      };
      som.registerAnimatedEntity(0x50000001, { motionManager: mm } as any, true);
      const buf = new Uint8Array(6 + 4 + 4 + 4);
      const view = new DataView(buf.buffer);
      view.setUint16(8, 0x3c, true);           // outer style: HandCombat
      view.setUint32(10, 0x1 | 0x2, true);     // CurrentStyle | ForwardCommand
      view.setUint16(14, 0x3c, true);          // CurrentStyle
      view.setUint16(16, 0x07, true);          // ForwardCommand RunForward
      som.handleMovementEvent({ guid: 0x50000001, movementData: buf } as never);
      expect(calls).toEqual([]);
    });

    it('drops the autonomous echo of our own MoveToState, so an emote plays once (BUG.own-emote-echo-plays-twice)', async () => {
      // ACE Player_Networking BroadcastMovement sends our MoveToState back
      // with IsAutonomous = true; CPhysics::SetObjectMovement @ 00509690
      // ignores autonomous movement for the player. The commands list
      // carries the Wave the emote key already played locally.
      const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
      const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
      const queued: number[] = [];
      const mm = {
        queueAction: (k: number) => queued.push(k),
        setForwardMotion: () => true, setStanceFromId: () => true, playDeath: () => false,
        isPlayingAction: false, currentStyleId: 0,
      };
      som.registerAnimatedEntity(0x50000001, { motionManager: mm } as any, true);
      const body = (autonomous: number): Uint8Array => {
        const buf = new Uint8Array(6 + 4 + 4 + 8);
        const view = new DataView(buf.buffer);
        buf[4] = autonomous;
        view.setUint16(8, 0x3d, true);           // outer style: NonCombat
        view.setUint32(10, 1 << 7, true);        // one command, no state fields
        view.setUint16(14, 0x87, true);          // Wave
        view.setUint16(16, (autonomous ? 0x8000 : 0) | 1, true); // sequence 1; ACE sets bit 15 only when autonomous (MotionItem.Write)
        view.setFloat32(18, 1, true);
        return buf;
      };
      som.handleMovementEvent({ guid: 0x50000001, movementData: body(1) } as never);
      expect(queued).toEqual([]);
      // A server-initiated (non-autonomous) command list still plays.
      som.handleMovementEvent({ guid: 0x50000001, movementData: body(0) } as never);
      expect(queued.map((k) => k & 0xffff)).toEqual([0x87]);
    });
  });

  describe('Creature MoveToObject is run, not dropped', () => {
    it('a MoveToObject (6) / MoveToPosition (7) for a creature starts its MoveToManager (DECOMP.remote-moveto-walk-seed)', async () => {
      const THREE = await import('three');
      const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
      const som = new ServerObjectManager({ loadSetupModel: () => null } as any, {} as any, { add: () => {}, remove: () => {} } as any);
      (som as any).buildMesh = () => new THREE.Group();
      const obj = som.createObject({
        guid: 0x80000001, name: 'Drudge', itemType: 0x10, setupId: 0x02000001, physicsState: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
        position: { landblock: 0xA9B40017, x: 10, y: 10, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 },
      } as any)!;
      const played: number[] = [];
      som.registerAnimatedEntity(obj.guid, { motionManager: {
        activeMotionTable: null, currentStyleId: 0x8000003d, isPlayingAction: false, isChangingStyle: false,
        setForwardMotion: (k: number) => { played.push(k & 0xffff); return true; }, setStanceFromId: () => true, changeStyle: () => true,
      }, update: () => {} } as any);
      for (const type of [6, 7]) {
        const buf = new Uint8Array(6 + 4 + (type === 6 ? 4 : 0) + 16 + 28 + 4);
        const v = new DataView(buf.buffer);
        let o = 6;
        v.setUint8(o, type); o += 2; v.setUint16(o, 0x3d, true); o += 2;
        if (type === 6) { v.setUint32(o, 0x12345678, true); o += 4; } // unknown target → walks to the origin
        v.setUint32(o, 0xA9B40017, true); o += 4;
        v.setFloat32(o, 40, true); v.setFloat32(o + 4, 10, true); o += 12;
        v.setUint32(o, 0x1ee0f, true); o += 4;
        for (const f of [0.6, 0, 1e30, 1, 15, 0]) { v.setFloat32(o, f, true); o += 4; }
        v.setFloat32(o, 1.5, true);
        som.handleMovementEvent({ guid: obj.guid, movementData: buf } as never);
        expect(obj.moveTo!.isMovingTo()).toBe(true);
      }
      // The first move is the turn-in-place node (the target is due east).
      expect(played).toContain(0x000d);
    });
  });

  describe('Negative framerate plays animation in reverse', () => {
    it('playMotionData should preserve negative framerate as reverse speed', () => {
      const fs = require('fs');
      const mmSource = fs.readFileSync(
        'packages/renderer/src/animation/MotionManager.ts', 'utf8'
      );

      // Should use Math.abs for framerate and multiply speed by direction
      expect(mmSource).toContain('Math.abs(animData.framerate)');
      expect(mmSource).toContain('speed * direction');
    });

    it('negative framerate animation should play backwards', () => {
      const player = new MockAnimationPlayer();
      const anim = { numFrames: 30, id: 0x3000001 };

      // Simulate what playMotionData does with negative framerate
      const framerate = -30;
      const absFramerate = Math.abs(framerate) || 30;
      const direction = framerate < 0 ? -1 : 1;
      const speed = 1.0 * direction; // speed * direction = -1

      player.play(anim, 0, -1, absFramerate, speed, false);

      expect(player.speed).toBe(-1);
      expect(player.framerate).toBe(30);
      // Should start at end of animation for reverse playback
      expect(player.currentTime).toBeGreaterThan(0);
    });
  });

  describe('Combat stance toggle', () => {
    it('CharacterAnimController should not have per-frame stance enforcement', () => {
      // The old approach of enforcing stance every frame in update() caused
      // run animations to restart. The fix is to block server events at the
      // SOM level instead.
      const fs = require('fs');
      const ctrlSource = fs.readFileSync(
        'packages/renderer/src/animation/CharacterAnimController.ts', 'utf8'
      );

      // Should NOT have the old enforcement pattern
      expect(ctrlSource).not.toContain('overrideStyleId');
      // Should NOT re-apply stance every frame
      const lines = ctrlSource.split('\n');
      const enforceLines = lines.filter((l: string) =>
        l.includes('currentStyleId') &&
        l.includes('currentStanceId') &&
        !l.trim().startsWith('//') &&
        !l.trim().startsWith('*')
      );
      expect(enforceLines).toHaveLength(0);
    });
  });

  describe('AnimationPlayer reverse playback', () => {
    it('should advance backwards with negative speed', () => {
      const player = new MockAnimationPlayer();
      const anim = { numFrames: 30, id: 1 };

      player.play(anim, 0, 29, 30, -1, false);

      // Should start at end
      const startTime = player.currentTime;
      expect(startTime).toBeCloseTo(29 / 30, 2);

      // After update, should move backwards
      player.update(0.1); // 100ms
      expect(player.currentTime).toBeLessThan(startTime);
    });

    it('should stop at frame 0 when playing in reverse (non-looping)', () => {
      const player = new MockAnimationPlayer();
      const anim = { numFrames: 10, id: 1 };

      player.play(anim, 0, 9, 30, -1, false);

      // Run until completion
      for (let i = 0; i < 100; i++) player.update(0.016);

      expect(player.playing).toBe(false);
      expect(player.currentTime).toBe(0);
    });
  });

  describe('registerAnimatedEntity', () => {
    it('SOM source should accept isLocalPlayer parameter', () => {
      const fs = require('fs');
      const somSource = fs.readFileSync(
        'packages/renderer/src/world/ServerObjectManager.ts', 'utf8'
      );

      // registerAnimatedEntity should accept isLocalPlayer flag
      expect(somSource).toContain('isLocalPlayer');
      expect(somSource).toContain('registerAnimatedEntity');
    });
  });

  describe('playNextAction diagnostics (UI.52)', () => {
    it('warns and fires onComplete when no animation matches the queued action', () => {
      const fs = require('fs');
      const mmSource = fs.readFileSync(
        'packages/renderer/src/animation/MotionManager.ts', 'utf8'
      );

      // The fallback at the end of playNextAction must (a) warn so the dropped
      // action is visible in console diagnostics instead of silent, and (b)
      // invoke onComplete so callers awaiting cast finish (e.g. spell-casting
      // gesture in playCastSpell) don't hang forever.
      expect(mmSource).toContain('No animation found for action');
      expect(mmSource).toMatch(/action\.onComplete\?\.\(\)/);
    });
  });

  describe('Combat target interaction', () => {
    it('double-click on attackable creature in combat mode neither attacks nor uses', async () => {
      // The dblclick dispatch is ItemHolder::UseObject @ 0x00588a80
      // (input/UseObject.ts): an attackable Stuck monster (ItemUseable No) in
      // a combat mode is neither used nor attacked; in peace mode it gets the
      // dove-icon line, never an auto-entered combat mode. Full matrix: verify-phase35.ts.
      const { decideUseObject } = await import('../packages/renderer/src/input/UseObject.js');
      const s = { guid: 1, name: 'Drudge', containerId: 0, wielderId: 0, bitfield: 0x14, itemsCapacity: 0, containersCapacity: 0,
        itemType: 0x10, combatUse: 0, validLocations: 0, location: 0, useability: 1, ownedByPlayer: false, isPlayer: false };
      const c = { playerGuid: 2, groundObject: 0, allowSelection: false, skipDetermine: false, selectedGuid: 0,
        attackable: true, confirmVolatileRare: false, selectionCompatible: false };
      expect(decideUseObject(s, { ...c, peaceMode: false }).kind).toBe('silent');
      expect(decideUseObject(s, { ...c, peaceMode: true }).kind).toBe('message');
    });
  });
});
