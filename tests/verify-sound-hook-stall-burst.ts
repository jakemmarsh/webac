/**
 * SOUND.hook-stall-burst — a frame longer than HUGE_QUANTUM (2 s: a
 * backgrounded tab, a long load) replayed every animation frame it spanned,
 * so every footstep / swing sound hook in it played at once on return.
 *
 * Retail (reference/client-eol decomp):
 *  - CPhysicsObj::update_object @ 00515d10: a delta over HUGE_QUANTUM (2)
 *    only resets update_time — no UpdateObjectInternal, so no
 *    CPartArray::Update (sequence frames, their hooks), no
 *    UpdatePhysicsInternal (omega), no MovementManager / PositionManager.
 *  - ScriptManager::UpdateScripts and FPHook::Execute run on absolute time
 *    (Timer::cur_time / PhysicsTimer::curr_time), so overdue SCRIPT hooks
 *    still run once update_object resumes; CPhysics::UseTime's
 *    UpdateTexVelocity takes the raw delta.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { HUGE_QUANTUM } from '@ac/shared';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import type { PhysicsScript } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

const hasDat = fs.existsSync(resolve(__dirname, '..', 'dat/client_portal.dat'));

function makeScript(id: number, steps: Array<{ t: number; hook: object }>): PhysicsScript {
  return { id, steps: steps.map((s) => ({ startTime: s.t, hook: s.hook as never })) } as never;
}

function scriptPlayer() {
  const playPositionalSound = vi.fn().mockResolvedValue(undefined);
  const player = new PhysicsScriptPlayer({
    spellEffects: { spawnParticleEffect: vi.fn() } as never,
    soundPlayer: { playPositionalSound } as never,
    loadEmitterInfo: () => null,
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
  });
  return { player, playPositionalSound };
}

describe('ServerObjectManager.updateAnimations — update_object\'s HUGE_QUANTUM skip', () => {
  it('a step over 2 s advances no sequence; a 2 s step and a normal frame do', () => {
    const som = new ServerObjectManager({} as never, {} as never, { add: () => {}, remove: () => {} } as never);
    const update = vi.fn();
    som.registerAnimatedEntity(0x50000001, { update } as never);
    expect(HUGE_QUANTUM).toBe(2);
    som.updateAnimations(5);
    som.updateAnimations(2.0001);
    expect(update).not.toHaveBeenCalled();
    som.updateAnimations(2);
    som.updateAnimations(1 / 60);
    expect(update.mock.calls.map((c) => c[0])).toEqual([2, 1 / 60]);
  });
});

describe('PhysicsScriptPlayer — what a stall skips and what it does not', () => {
  it('SetOmega spin (UpdatePhysicsInternal) does not jump by the stall', () => {
    const { player } = scriptPlayer();
    const anchor = new THREE.Object3D();
    player.play(makeScript(0x33000901, [
      { t: 0, hook: { hookType: AnimationHookType.SetOmega, direction: 0, axis: { x: 0, y: 0, z: 1 } } },
    ]), anchor);
    player.update(10);
    expect(anchor.quaternion.y).toBe(0);
    player.update(0.5);
    expect(Math.abs(anchor.quaternion.y)).toBeCloseTo(Math.sin(0.25), 6);
  });

  it('a script\'s overdue hooks still run after a stall (ScriptManager reads absolute time)', () => {
    const { player, playPositionalSound } = scriptPlayer();
    const anchor = new THREE.Object3D();
    player.play(makeScript(0x33000902, [
      { t: 0, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0a000001 } },
      { t: 3, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0a000002 } },
    ]), anchor);
    expect(playPositionalSound).toHaveBeenCalledTimes(1);
    player.update(5);
    expect(playPositionalSound).toHaveBeenCalledTimes(2);
    expect(playPositionalSound.mock.calls[1][0]).toBe(0x0a000002);
  });
});

describe.skipIf(!hasDat)('a remote drudge running through a stall plays no burst of footsteps (needs DAT)', () => {
  let portalDb: ReturnType<typeof openDat>;
  beforeAll(() => { portalDb = openDat('dat/client_portal.dat'); });

  function moveEvent(guid: number, forward: number, speed: number): { guid: number; movementData: Uint8Array } {
    const STANCE = 0x8000003d;
    const buf = new Uint8Array(6 + 4 + 4 + 2 + 2 + 4);
    const v = new DataView(buf.buffer);
    v.setUint16(8, STANCE & 0xffff, true);
    v.setUint32(10, 0x1 | 0x2 | 0x4, true);
    v.setUint16(14, STANCE & 0xffff, true);
    v.setUint16(16, forward & 0xffff, true);
    v.setFloat32(18, speed, true);
    return { guid, movementData: buf };
  }

  it('Drudge (setup 0x020007DD, motion 0x09000008): a 6 s frame fires no run-cycle hook; 1.5 s of frames does', () => {
    const scene = new THREE.Scene();
    const som = new ServerObjectManager({} as never, {} as never, scene as never);
    som.setPortalDb(portalDb as never);
    const group = new THREE.Group();
    for (let i = 0; i < 34; i++) { const p = new THREE.Object3D(); p.name = `part_${i}`; group.add(p); }
    scene.add(group);
    const GUID = 0x50000098;
    (som as unknown as { tryInitAnimation(o: object): void }).tryInitAnimation({ guid: GUID, mesh: group, setupId: 0x020007DD, motionTableId: 0x09000008 });
    expect(som.getAnimated(GUID)).toBeTruthy();
    const hooks: number[] = [];
    som.onAnimationHook = (_g, hook) => { hooks.push(hook.hookType); };
    som.handleMovementEvent(moveEvent(GUID, 0x0007 /* RunForward */, 1.0) as never);
    // Settle into the cycle, then clear.
    for (let t = 0; t < 1; t += 1 / 60) som.updateAnimations(1 / 60);
    hooks.length = 0;

    som.updateAnimations(6);
    expect(hooks).toEqual([]);

    for (let t = 0; t < 1.5; t += 1 / 60) som.updateAnimations(1 / 60);
    expect(hooks.length).toBeGreaterThan(0);
  });
});
