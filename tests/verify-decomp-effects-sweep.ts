/**
 * Decomp-diff sweep 2026-09-30, effects group (docs/decomp-diff-sweep-2026-09-30.md
 * E1–E10) — behavioral tests against the real PhysicsScriptPlayer,
 * ParticleSystem, SpellEffects, ObjectTranslucency and ServerObjectManager.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { ParticleSystem } from '../packages/renderer/src/effects/ParticleSystem.js';
import { fallbackParticleGfx } from '../packages/renderer/src/effects/ParticleGfx.js';
import { SpellEffects } from '../packages/renderer/src/effects/SpellEffects.js';
import { applyTranslucency, ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import type { ParticleEmitterInfo } from '../packages/dat-parser/src/file-types/ParticleEmitterInfo.js';

type Step = { t: number; hook: Record<string, unknown> };
const script = (id: number, steps: Step[]) =>
  ({ id, steps: steps.map((s) => ({ startTime: s.t, hook: { direction: 0, ...s.hook } })) }) as never;
const sound = (soundId: number) => ({ hookType: AnimationHookType.Sound, soundId });

function makePlayer(over: Record<string, unknown> = {}) {
  const sounds: number[] = [];
  const spawned: Array<{ object3D: THREE.Object3D; isDone: boolean; isDisposed: boolean; stop(): void }> = [];
  const player = new PhysicsScriptPlayer({
    spellEffects: {
      spawnParticleEffect: () => {
        const s = { object3D: new THREE.Object3D(), isDone: false, isDisposed: false, stop() { /* */ } };
        spawned.push(s);
        return s;
      },
      removeParticleSystem: (s: { isDisposed: boolean }) => { s.isDisposed = true; },
    } as never,
    soundPlayer: { playPositionalSound: vi.fn(async (id: number) => { sounds.push(id); }) } as never,
    loadEmitterInfo: (id: number) => ({ id, hwGfxObjId: 0x01000001, lifespan: 1, lifespanRand: 0, totalSeconds: 0, totalParticles: 0 } as never),
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    ...over,
  });
  return { player, sounds, spawned };
}

function emitterInfo(over: Partial<ParticleEmitterInfo>): ParticleEmitterInfo {
  return {
    id: 0x32000001, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: 0x01000001,
    birthrate: 0.1, maxParticles: 50, initialParticles: 0, totalParticles: 0, totalSeconds: 0,
    lifespan: 1, lifespanRand: 0, offsetDir: { x: 0, y: 0, z: 0 }, minOffset: 0, maxOffset: 0,
    a: { x: 0, y: 0, z: 0 }, minA: 0, maxA: 0, b: { x: 0, y: 0, z: 0 }, minB: 0, maxB: 0,
    c: { x: 0, y: 0, z: 0 }, minC: 0, maxC: 0, startScale: 1, finalScale: 1, scaleRand: 0,
    startTrans: 0, finalTrans: 0, transRand: 0, isParentLocal: 0,
    ...over,
  } as ParticleEmitterInfo;
}

describe('E2 DECOMP.scripts-not-queued — ScriptManager plays an object\'s scripts back to back', () => {
  it('a second script starts when the first one\'s length has run (AddScriptInternal @ 0051b310)', () => {
    const { player, sounds } = makePlayer();
    const obj = new THREE.Object3D();
    player.play(script(1, [{ t: 0, hook: sound(1) }, { t: 2, hook: sound(2) }]), obj);
    player.play(script(2, [{ t: 0, hook: sound(3) }, { t: 0.5, hook: sound(4) }]), obj);
    // Only the first script's t=0 hook has fired; the second waits.
    expect(sounds).toEqual([1]);
    expect(player.queuedScripts(obj)).toHaveLength(2);
    player.update(1.9);
    expect(sounds).toEqual([1]);
    player.update(0.1); // t = 2: the first ends, the second starts
    expect(sounds).toEqual([1, 2, 3]);
    player.update(0.5);
    expect(sounds).toEqual([1, 2, 3, 4]);
    expect(player.queuedScripts(obj)).toHaveLength(0);
  });

  it('a third script queues after the second (start = prev.start + prev.length), not after "now"', () => {
    const { player, sounds } = makePlayer();
    const obj = new THREE.Object3D();
    player.play(script(1, [{ t: 1, hook: sound(1) }]), obj);
    player.update(0.5);
    player.play(script(2, [{ t: 1, hook: sound(2) }]), obj); // starts at 1
    player.play(script(3, [{ t: 1, hook: sound(3) }]), obj); // starts at 2
    player.update(0.5); // t = 1
    expect(sounds).toEqual([1]);
    player.update(1.0); // t = 2
    expect(sounds).toEqual([1, 2]);
    player.update(1.0); // t = 3
    expect(sounds).toEqual([1, 2, 3]);
  });

  it('different objects run their scripts independently', () => {
    const { player, sounds } = makePlayer();
    const a = new THREE.Object3D();
    const b = new THREE.Object3D();
    player.play(script(1, [{ t: 1, hook: sound(1) }]), a);
    player.play(script(2, [{ t: 1, hook: sound(2) }]), b);
    player.update(1);
    expect(sounds.sort()).toEqual([1, 2]);
  });

  it('an idle object starts a new script now', () => {
    const { player, sounds } = makePlayer();
    const obj = new THREE.Object3D();
    player.play(script(1, [{ t: 0.5, hook: sound(1) }]), obj);
    player.update(10);
    player.play(script(2, [{ t: 0, hook: sound(2) }]), obj);
    expect(sounds).toEqual([1, 2]);
  });
});

describe('E3 DECOMP.callpes-random-pause — CallPES waits RollDice(0, pause) on the object clock', () => {
  it('uses Random::RollDice(0, pause), not the full pause, and no wall-clock timer', () => {
    vi.useFakeTimers();
    try {
      const nested = script(9, [{ t: 0, hook: sound(9) }]);
      const rollDice = vi.fn(() => 0.25);
      const { player, sounds } = makePlayer({ loadScript: () => nested, rollDice });
      const obj = new THREE.Object3D();
      player.play(script(1, [{ t: 0, hook: { hookType: AnimationHookType.CallPES, pes: 9, pause: 2.7 } }]), obj);
      expect(rollDice).toHaveBeenCalledWith(0, 2.7);
      vi.advanceTimersByTime(10_000); // wall-clock time does nothing
      expect(sounds).toEqual([]);
      player.update(0.25);
      expect(sounds).toEqual([9]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pending CallPES freezes while the object is out of the world, and plays nothing there', () => {
    const nested = script(9, [{ t: 0, hook: sound(9) }]);
    const { player, sounds } = makePlayer({ loadScript: () => nested, rollDice: (_a: number, m: number) => m });
    const obj = new THREE.Object3D();
    player.play(script(1, [{ t: 0, hook: { hookType: AnimationHookType.CallPES, pes: 9, pause: 1 } }]), obj);
    player.update(0.5);
    player.setAnchorSuspended(obj, true);
    player.update(5);
    expect(sounds).toEqual([]);
    player.setAnchorSuspended(obj, false);
    player.update(0.4);
    expect(sounds).toEqual([]);
    player.update(0.1);
    expect(sounds).toEqual([9]);
  });
});

describe('E4 DECOMP.transparent-tween-clobbers — translucency keeps each material\'s own alpha and the server floor', () => {
  function object(opacity: number, transparent: boolean) {
    const root = new THREE.Group();
    const part = new THREE.Group();
    part.name = 'part_0';
    const mat = new THREE.MeshBasicMaterial({ opacity, transparent });
    part.add(new THREE.Mesh(new THREE.BufferGeometry(), mat));
    root.add(part);
    return { root, part, mat: () => (part.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial };
  }

  it('an UnHide fade (1 → 0) leaves a translucent surface translucent (RestoreMaterial at the default)', () => {
    const { player } = makePlayer();
    const { root, mat } = object(0.5, true);
    player.play(script(1, [{ t: 0, hook: { hookType: AnimationHookType.Transparent, start: 1, end: 0, time: 1 } }]), root);
    // SWEEP1006 part no-draw — the part's mesh is not drawn; the material stays visible (it may be shared).
    expect((root.children[0].children[0] as THREE.Mesh).visible).toBe(false);
    expect(mat().visible).toBe(true);
    player.update(0.5);
    // SetTranslucencySimple writes the material alpha (1 − t) over the surface's own.
    expect(mat().opacity).toBeCloseTo(0.25, 6);
    player.update(0.5);
    expect(mat().visible).toBe(true);
    expect(mat().opacity).toBe(0.5);
    expect(mat().transparent).toBe(true);
  });

  it('an opaque surface ends opaque and not transparent', () => {
    const { player } = makePlayer();
    const { root, mat } = object(1, false);
    player.play(script(1, [{ t: 0, hook: { hookType: AnimationHookType.Transparent, start: 1, end: 0, time: 1 } }]), root);
    player.update(1);
    expect(mat().opacity).toBe(1);
    expect(mat().transparent).toBe(false);
  });

  it('a fade never goes below the server\'s translucency (SetTranslucencyInternal clamps to translucencyOriginal)', () => {
    const { player } = makePlayer();
    const { root, mat } = object(1, false);
    applyTranslucency(root, 0.4); // the PhysicsDesc Translucency
    expect(mat().opacity).toBeCloseTo(0.6, 6);
    player.play(script(1, [{ t: 0, hook: { hookType: AnimationHookType.Transparent, start: 1, end: 0, time: 1 } }]), root);
    player.update(1);
    expect(mat().opacity).toBeCloseTo(0.6, 6);
    expect(mat().transparent).toBe(true);
  });

  it('object translucency reaches the object\'s own parts only, never a wielded item', () => {
    const { player } = makePlayer();
    const { root, part, mat } = object(1, false);
    const held = new THREE.Group();
    held.userData.wieldedGuid = 0x80000001;
    const heldMat = new THREE.MeshBasicMaterial();
    held.add(new THREE.Mesh(new THREE.BufferGeometry(), heldMat));
    part.add(held);
    player.executeHook({ hookType: AnimationHookType.Transparent, direction: 0, start: 0.5, end: 0.5, time: 0 } as never, root);
    expect(mat().opacity).toBeCloseTo(0.5, 6);
    expect(heldMat.opacity).toBe(1);
  });
});

describe('E5 DECOMP.texture-velocity-shared — texture velocity is per GfxObj, set once', () => {
  it('N objects drawing one GfxObj scroll at the velocity, not N× (AddGfxVelocity @ 00509b60 sets)', () => {
    const { player } = makePlayer();
    const tex = new THREE.Texture();
    const objs = [0, 1, 2].map(() => {
      const root = new THREE.Group();
      const part = new THREE.Group();
      part.name = 'part_0';
      part.userData.gfxObjId = 0x01000777;
      part.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: tex })));
      root.add(part);
      return { root, part };
    });
    for (const o of objs) {
      player.play(script(1, [{ t: 0, hook: { hookType: AnimationHookType.TextureVelocity, uSpeed: 0.2, vSpeed: 0 } }]), o.root);
    }
    player.update(1);
    for (const o of objs) {
      const map = ((o.part.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).map!;
      expect(map.offset.x).toBeCloseTo(0.2, 6);
    }
    expect(tex.offset.x).toBe(0);
    expect(player.gfxVelocityOf(objs[0].part)).toMatchObject({ u: 0.2, totalU: 0.2 });
  });

  it('velocity (0, 0) removes the GfxObj\'s entry', () => {
    const { player } = makePlayer();
    const root = new THREE.Group();
    const part = new THREE.Group();
    part.name = 'part_0';
    part.userData.gfxObjId = 0x01000778;
    root.add(part);
    player.executeHook({ hookType: AnimationHookType.TextureVelocity, direction: 0, uSpeed: 1, vSpeed: 0 } as never, root);
    expect(player.gfxVelocityOf(part)).not.toBeNull();
    player.executeHook({ hookType: AnimationHookType.TextureVelocity, direction: 0, uSpeed: 0, vSpeed: 0 } as never, root);
    expect(player.gfxVelocityOf(part)).toBeNull();
  });
});

describe('E6 DECOMP.blocking-emitter-restarts — CreateBlockingParticle does nothing while its emitter lives', () => {
  const hook = (type: number) => ({
    hookType: type, direction: 0, emitterInfoId: 0x32000001, partIndex: 0xFFFFFFFF,
    offset: { origin: { x: 0, y: 0, z: 0 } }, emitterId: 7,
  }) as never;

  it('a live emitter holding the id blocks it; a done one does not (CreateBlockingParticleEmitter @ 0051b8a0)', () => {
    const { player, spawned } = makePlayer();
    const obj = new THREE.Object3D();
    player.executeHook(hook(AnimationHookType.CreateBlockingParticle), obj);
    expect(spawned).toHaveLength(1);
    player.executeHook(hook(AnimationHookType.CreateBlockingParticle), obj);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].isDisposed).toBe(false); // not restarted
    spawned[0].isDone = true;
    player.executeHook(hook(AnimationHookType.CreateBlockingParticle), obj);
    expect(spawned).toHaveLength(2);
  });

  it('a plain CreateParticle still replaces the emitter holding its id', () => {
    const { player, spawned } = makePlayer();
    const obj = new THREE.Object3D();
    player.executeHook(hook(AnimationHookType.CreateParticle), obj);
    player.executeHook(hook(AnimationHookType.CreateParticle), obj);
    expect(spawned).toHaveLength(2);
    expect(spawned[0].isDisposed).toBe(true);
  });
});

describe('E7 DECOMP.scripts-replayed-on-reentry — play_script drops scripts on an object out of the world', () => {
  it('a script played while suspended never plays, not even on re-entry', () => {
    const { player, sounds } = makePlayer();
    const obj = new THREE.Object3D();
    player.setAnchorSuspended(obj, true);
    player.play(script(1, [{ t: 0, hook: sound(1) }]), obj);
    player.setAnchorSuspended(obj, false);
    player.update(1);
    expect(sounds).toEqual([]);
    expect(player.queuedScripts(obj)).toHaveLength(0);
  });

  it('a script already running stays frozen while suspended and carries on after', () => {
    const { player, sounds } = makePlayer();
    const obj = new THREE.Object3D();
    player.play(script(1, [{ t: 1, hook: sound(1) }]), obj);
    player.setAnchorSuspended(obj, true);
    player.update(5);
    expect(sounds).toEqual([]);
    player.setAnchorSuspended(obj, false);
    player.update(1);
    expect(sounds).toEqual([1]);
  });
});

describe('E9 DECOMP.degraded-emitters-simulate — the degraded-out branch of UpdateParticles', () => {
  const far = { viewer: new THREE.Vector3(1000, 0, 0) }; // beyond the 100 m no-chain degrade distance
  const near = { viewer: new THREE.Vector3(1, 0, 0) };
  // A HW GfxObj without a degrade chain: degrade_distance 100 m (GetMaxDegradeDistance).
  const sprite = () => ({ gfx: { ...fallbackParticleGfx(1), degrades: [] } });

  it('a persistent emitter freezes: its particles stop ageing and it emits nothing', () => {
    const sys = new ParticleSystem(emitterInfo({ initialParticles: 3, lifespan: 1, birthrate: 0.01 }), 0xffffff, sprite());
    sys.setView(near);
    sys.update(0.5); // the burst ages 0.5 s; one emission
    expect(sys.activeCount).toBe(4);
    sys.setView(far);
    // Five lifespans pass out of range: nothing dies, nothing is born.
    for (let i = 0; i < 50; i++) sys.update(0.1);
    expect(sys.isDegradedOut).toBe(true);
    expect(sys.drawnCount).toBe(0);
    expect(sys.activeCount).toBe(4);
    expect(sys.totalEmittedCount).toBe(4);
    // Back in range they resume at their age: the burst has 0.5 s left.
    sys.setView(near);
    sys.update(0.4);
    expect(sys.isDegradedOut).toBe(false);
    expect(sys.activeCount).toBe(5); // four survivors + this update's emission
    sys.update(0.2); // the burst reaches 1.1 s of age and dies
    expect(sys.totalEmittedCount).toBe(6);
    expect(sys.activeCount).toBe(3);
    sys.dispose();
  });

  it('a bounded emitter keeps ageing and records the emissions it would make (RecordParticleEmission @ 0051c870)', () => {
    const sys = new ParticleSystem(emitterInfo({ initialParticles: 1, lifespan: 0.5, birthrate: 0.1, totalParticles: 4 }), 0xffffff, sprite());
    sys.setView(far);
    for (let i = 0; i < 10; i++) sys.update(0.2);
    // The live particle died; three emissions were counted but never made.
    expect(sys.activeCount).toBe(0);
    expect(sys.totalEmittedCount).toBe(4);
    expect(sys.isStopped).toBe(true);
    expect(sys.numParticles).toBe(3);
    // num_particles never drops for recorded emissions: the manager keeps it.
    expect(sys.isDone).toBe(false);
    sys.dispose();
  });
});

describe('E10 DECOMP.invented-emitter-maxage — an emitter is deleted only when UpdateParticles says it is done', () => {
  it('a stationary per-metre trail waits for its owner instead of expiring', () => {
    const scene = new THREE.Scene();
    const effects = new SpellEffects(scene);
    const sys = effects.spawnParticleEffect(
      emitterInfo({ emitterType: 2, birthrate: 0.5, totalParticles: 10, lifespan: 1 }), { x: 0, y: 0, z: 0 },
    );
    for (let i = 0; i < 100; i++) effects.update(0.1);
    expect(effects.activeCount).toBe(1);
    expect(scene.children).toContain(sys.object3D);
    effects.removeParticleSystem(sys);
    expect(effects.activeCount).toBe(0);
  });

  it('a done emitter is removed the tick it is done', () => {
    const scene = new THREE.Scene();
    const effects = new SpellEffects(scene);
    effects.spawnParticleEffect(emitterInfo({ initialParticles: 1, totalParticles: 1, lifespan: 0.2 }), { x: 0, y: 0, z: 0 });
    effects.update(0.1);
    expect(effects.activeCount).toBe(1);
    effects.update(0.15);
    expect(effects.activeCount).toBe(0);
  });
});

describe('E1 DECOMP.anim-hooks-filtered — the part hooks target the object\'s own parts; DefaultScript[Part] use play_default_script', () => {
  /** An owner with part_0 holding a wielded item that has its own part_1, and the owner's part_1. */
  function owner() {
    const root = new THREE.Group();
    const p0 = new THREE.Group(); p0.name = 'part_0';
    const held = new THREE.Group(); held.userData.wieldedGuid = 0x80000002;
    const heldP1 = new THREE.Group(); heldP1.name = 'part_1';
    const heldMat = new THREE.MeshBasicMaterial();
    heldP1.add(new THREE.Mesh(new THREE.BufferGeometry(), heldMat));
    held.add(heldP1); p0.add(held);
    const p1 = new THREE.Group(); p1.name = 'part_1';
    const ownMat = new THREE.MeshBasicMaterial();
    p1.add(new THREE.Mesh(new THREE.BufferGeometry(), ownMat));
    root.add(p0, p1);
    return { root, held, heldMat, ownMat: () => (p1.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial };
  }

  it('TransparentPart 1 fades the owner\'s part_1, not the wielded item\'s part_1 (found first depth-first)', () => {
    const { player } = makePlayer();
    const o = owner();
    player.executeHook({ hookType: AnimationHookType.TransparentPart, direction: 0, part: 1, start: 0.5, end: 0.5, time: 0 } as never, o.root);
    expect(o.ownMat().opacity).toBeCloseTo(0.5, 6);
    expect(o.heldMat.opacity).toBe(1);
  });

  it('DefaultScript plays the object\'s own play_default_script; DefaultScriptPart plays the held child\'s, on the child', () => {
    const o = owner();
    const ownScript = script(0x33000001, [{ t: 0, hook: sound(1) }]);
    const childScript = script(0x33000002, [{ t: 0, hook: sound(2) }]);
    const resolveDefaultScript = vi.fn((a: THREE.Object3D) => (a === o.root ? ownScript : a === o.held ? childScript : null));
    const { player, sounds } = makePlayer({ resolveDefaultScript });
    player.executeHook({ hookType: AnimationHookType.DefaultScript, direction: 0 } as never, o.root);
    player.executeHook({ hookType: AnimationHookType.DefaultScriptPart, direction: 0, partIndex: 0 } as never, o.root);
    expect(sounds).toEqual([1, 2]);
    expect(player.queuedScripts(o.held)).toHaveLength(0);
    // A part with nothing held plays nothing.
    player.executeHook({ hookType: AnimationHookType.DefaultScriptPart, direction: 0, partIndex: 1 } as never, o.root);
    expect(resolveDefaultScript).toHaveBeenCalledTimes(2);
  });
});

describe('ServerObjectManager.objectForAnchor — the object behind a hook anchor', () => {
  it('resolves an object mesh, an animated group and a wielded item\'s held copy', () => {
    const scene = new THREE.Scene();
    const smr = { createSetupMeshWithOverrides: () => new THREE.Group(), loadSetupModel: () => null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, scene);
    const data = (guid: number) => ({
      guid, name: 'x', weenieClassId: 1, itemType: 0, position: null, setupId: 0x02000001,
      motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
      basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
      wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
      maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
      velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0,
      defaultScriptIntensity: 0, iconOverlayId: 0, iconUnderlayId: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const a = som.createObject(data(0x50000011))!;
    const item = som.createObject(data(0x50000012))!;
    expect(som.objectForAnchor(a.mesh!)).toBe(a);
    const group = new THREE.Group();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    som.registerAnimatedEntity(0x50000011, { group } as any);
    expect(som.objectForAnchor(group)).toBe(a);
    const heldCopy = new THREE.Group();
    heldCopy.userData.wieldedGuid = 0x50000012;
    expect(som.objectForAnchor(heldCopy)).toBe(item);
    expect(som.objectForAnchor(new THREE.Group())).toBeUndefined();
  });
});
