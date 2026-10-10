/**
 * FAITHFUL.189 / DECOMP.anim-hooks-filtered — every AnimationHookType runs.
 *
 * Retail executes every hook an animation frame (or a PhysicsScript step)
 * carries: CSequence::execute_hooks @ 00524830 → CPhysicsObj::add_anim_hook
 * → process_hooks @ 00511550 → CAnimHook::Execute. Our main.ts used to filter
 * animation hooks through `isObjectAnimHook` (sound + particle only), so a
 * gromnie's breath (DefaultScript), the PK/NPK statues' and virindi dolls'
 * TransparentPart, SetOmega and Transparent never ran from animations.
 *
 * Behavioral (was a source-text pin of the dispatch switch): drive EVERY enum
 * member through the real PhysicsScriptPlayer.executeHook on an object and
 * observe its effect. Attack (CPhysicsObj::attack — the server's hit volume)
 * and AnimationDone (CPartArray::AnimationDone — the motion system's own) and
 * NoOp draw and play nothing here.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { AnimationHookType } from '@ac/dat-parser';

function rig() {
  const playPositionalSound = vi.fn().mockResolvedValue(undefined);
  const playSoundTableSound = vi.fn((_a: THREE.Object3D, _t: number, _p: unknown) => {});
  const setLights = vi.fn((_a: THREE.Object3D, _on: boolean) => {});
  const setNoDraw = vi.fn((_a: THREE.Object3D, _on: boolean) => true);
  const removed: unknown[] = [];
  const stopped: unknown[] = [];
  const spawnParticleEffect = vi.fn(() => {
    const sys = { object3D: new THREE.Object3D(), isDone: false, isDisposed: false, stop: () => { stopped.push(sys); } };
    return sys;
  });
  const nested = { id: 0x33000077, steps: [{ startTime: 0, hook: { hookType: AnimationHookType.NoOp, direction: 0 } }] };
  const loadScript = vi.fn((_id: number) => nested as never);
  const resolveDefaultScript = vi.fn((_a: THREE.Object3D) => nested as never);
  const player = new PhysicsScriptPlayer({
    spellEffects: { spawnParticleEffect, removeParticleSystem: (s: unknown) => { removed.push(s); } } as never,
    soundPlayer: { playPositionalSound } as never,
    loadEmitterInfo: (id: number) => ({ id, hwGfxObjId: 0x01000001, lifespan: 1, lifespanRand: 0, totalSeconds: 1, totalParticles: 0 } as never),
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    loadScript,
    resolveDefaultScript,
    playSoundTableSound,
    setLights,
    setNoDraw,
    rollDice: () => 0,
  });
  // An object: a setup group with a direct part_0 that draws a textured mesh
  // and holds a wielded item (a CHILDLIST object on that part).
  const anchor = new THREE.Group();
  const part = new THREE.Group();
  part.name = 'part_0';
  part.userData.gfxObjId = 0x01000123;
  const mat = new THREE.MeshLambertMaterial({ map: new THREE.Texture() });
  part.add(new THREE.Mesh(new THREE.BufferGeometry(), mat));
  anchor.add(part);
  const held = new THREE.Group();
  held.userData.wieldedGuid = 0x80001234;
  part.add(held);
  return {
    player, anchor, part, held, mat, nested, playPositionalSound, playSoundTableSound, setLights, setNoDraw,
    spawnParticleEffect, removed, stopped, loadScript, resolveDefaultScript,
  };
}

const EMITTER = { emitterInfoId: 0x32000001, partIndex: 0xFFFFFFFF, offset: { origin: { x: 0, y: 0, z: 0 } }, emitterId: 5 };

/** A hook of `type` with the fields every hook kind reads. */
function hookOf(type: number): never {
  return {
    hookType: type, direction: 0, soundId: 0x0a000001, soundType: 0x39, probability: 1, volume: 1, priority: 0,
    ...EMITTER, part: 0, start: 0.25, end: 0.5, time: 0, noDraw: 1, lightsOn: 1, ethereal: 1, partId: 0x01000999,
    pes: 0x33000077, pause: 0, axis: { x: 0, y: 0, z: 1 }, uSpeed: 0.5, vSpeed: 0,
    // The part hooks (ReplaceObject, DefaultScriptPart, TextureVelocityPart)
    // address part 0; the particle hooks the object itself.
    ...(type === AnimationHookType.CreateParticle || type === AnimationHookType.CreateBlockingParticle ? {} : { partIndex: 0 }),
  } as never;
}

describe('DECOMP.anim-hooks-filtered — executeHook runs every hook type (CAnimHook::Execute)', () => {
  const names = Object.entries(AnimationHookType)
    .filter(([k, v]) => typeof v === 'number' && isNaN(Number(k))) as [string, number][];

  it('the enum still has its 27 retail hook types', () => {
    expect(names.length).toBe(27);
  });

  /** What each hook type observably does on the object. */
  const effects: Record<string, (r: ReturnType<typeof rig>) => boolean> = {
    Sound: (r) => r.playPositionalSound.mock.calls.length === 1,
    SoundTweaked: (r) => r.playPositionalSound.mock.calls.length === 1,
    SoundTable: (r) => r.playSoundTableSound.mock.calls[0]?.[1] === 0x39,
    CreateParticle: (r) => r.spawnParticleEffect.mock.calls.length === 1,
    CreateBlockingParticle: (r) => r.spawnParticleEffect.mock.calls.length === 1,
    NoDraw: (r) => r.setNoDraw.mock.calls[0]?.[1] === true,
    SetLight: (r) => r.setLights.mock.calls[0]?.[1] === true,
    Scale: (r) => r.anchor.scale.x === 0.5,
    Luminous: (r) => r.mat.emissive.r === 0.5,
    LuminousPart: (r) => r.mat.emissive.r === 0.5,
    Diffuse: (r) => r.mat.color.r === 0.5,
    DiffusePart: (r) => r.mat.color.r === 0.5,
    Transparent: (r) => (r.part.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material.opacity === 0.5,
    TransparentPart: (r) => (r.part.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material.opacity === 0.5,
    Ethereal: (r) => r.anchor.userData.ethereal === true,
    ReplaceObject: (r) => r.part.userData.replacePartId === 0x01000999,
    DefaultScript: (r) => r.resolveDefaultScript.mock.calls[0]?.[0] === r.anchor,
    DefaultScriptPart: (r) => r.resolveDefaultScript.mock.calls[0]?.[0] === r.held,
    CallPES: (r) => r.loadScript.mock.calls[0]?.[0] === 0x33000077,
    SetOmega: (r) => { r.player.update(0.5); return Math.abs(r.anchor.quaternion.y) > 0.1; },
    TextureVelocity: (r) => r.player.gfxVelocityOf(r.part)?.u === 0.5,
    TextureVelocityPart: (r) => r.player.gfxVelocityOf(r.part)?.u === 0.5,
    DestroyParticle: (r) => r.removed.length === 1,
    StopParticle: (r) => r.stopped.length === 1,
  };

  for (const [name, type] of Object.entries(AnimationHookType)) {
    if (typeof type !== 'number') continue;
    if (name === 'NoOp' || name === 'Attack' || name === 'AnimationDone') continue;
    it(`${name} executes on the object`, () => {
      const r = rig();
      // Destroy / Stop address an emitter the object already owns under the hook's id.
      if (name === 'DestroyParticle' || name === 'StopParticle') {
        r.player.executeHook(hookOf(AnimationHookType.CreateParticle), r.anchor);
      }
      r.player.executeHook(hookOf(type), r.anchor);
      expect(effects[name]?.(r)).toBe(true);
    });
  }

  it('NoOp, Attack and AnimationDone draw and play nothing', () => {
    for (const type of [AnimationHookType.NoOp, AnimationHookType.Attack, AnimationHookType.AnimationDone]) {
      const r = rig();
      r.player.executeHook(hookOf(type), r.anchor);
      expect(r.playPositionalSound).not.toHaveBeenCalled();
      expect(r.playSoundTableSound).not.toHaveBeenCalled();
      expect(r.spawnParticleEffect).not.toHaveBeenCalled();
      expect(r.player.activeCount).toBe(0);
    }
  });

  it('every type but NoOp / Attack / AnimationDone has an effect entry (no hook left unexecuted)', () => {
    const covered = new Set(Object.keys(effects));
    for (const [name] of names) {
      if (name === 'NoOp' || name === 'Attack' || name === 'AnimationDone') continue;
      expect(covered.has(name), name).toBe(true);
    }
  });
});
