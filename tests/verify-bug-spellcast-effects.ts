/**
 * BUG.spellcast-effects — "the effects look completely wrong, it's like a
 * red/orange explosion when it should be a blue or purple kind of bubble
 * around the player's hands".
 *
 * Ground truth (DAT + decompiled retail client):
 *  - The cast glow is NOT a spell/PlayScript effect. It is the Magic stance's
 *    windup / gesture ANIMATIONS' own CreateParticle hooks, executed on the
 *    caster as its CSequence plays them (CSequence::execute_hooks →
 *    CreateParticleHook::Execute @ 00526ec0 → CPhysicsObj::
 *    create_particle_emitter): windup 0x030005A0 (MagicPowerUp01–10) creates
 *    Swarm emitters 0x3200011E / 0x32000120 / 0x32000122 / 0x32000123
 *    (+ 0x32000127 / 0x32000128) at (0, 0.4, 1.2) in front of the chest,
 *    growing (final scale 2 → 5) as the windup rises, and BirthratePerMeter "Still" emitter 0x32000109 on the HANDS
 *    (parts 12 and 15); the lowering (played backwards) stops the hand ones
 *    (StopParticle, direction Backward). Gesture 0x0300059F keeps the hand
 *    emitters on for the hold. Their HW sprites are additive (surface type
 *    0x10102) BLUE textures 0x06004438 / 0x06004D92.
 *  - Heal Self / Flame Bolt have CasterEffect 0; Heal's TargetEffect 31
 *    resolves through the player table 0x34000004; Flame Bolt draws only
 *    its server projectile object (Launch / Explode via 0x34000005).
 *
 * What we drew instead: an invented school-coloured "casting swirl" at cast
 * send (red/orange for War Magic: points + sphere + PointLight), an invented
 * red sphere projectile fired at our incantation (the START of the windup)
 * with an impact flash, and none of the DAT hooks — animation particle hooks
 * were never executed for any object.
 *
 * The particle engine itself also diverged from retail where it followed
 * ACE's port (Particle::Init @ 0051c930 / Particle::Update @ 0051c290 /
 * ParticleEmitterInfo::ShouldEmitParticle @ 00517420): no parenting to the
 * object's part or its movement, per-metre emitters never emitted, Swarm
 * orbit radius was 1 instead of C, GR types froze, InitEnd burst the wrong
 * count, scale/trans were never randomized, and StopParticle / DestroyParticle
 * only tagged userData.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { ParticleSystem } from '../packages/renderer/src/effects/ParticleSystem.js';
import { PhysicsScriptPlayer, emitterParentNode, makeEmitterFrameSource } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { SpellEffects } from '../packages/renderer/src/effects/SpellEffects.js';
import { AnimationHookType, type AnimationHook } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import type { ParticleEmitterInfo } from '../packages/dat-parser/src/file-types/ParticleEmitterInfo.js';
import { AnimatedEntity } from '../packages/renderer/src/animation/AnimatedEntity.js';

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
const hasDat = fs.existsSync(PORTAL);

function makeInfo(overrides: Partial<ParticleEmitterInfo>): ParticleEmitterInfo {
  return {
    id: 0x32000001, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: 0x01000001,
    birthrate: 0, maxParticles: 50, initialParticles: 0, totalParticles: 0, totalSeconds: 0,
    lifespan: 100, lifespanRand: 0, offsetDir: { x: 0, y: 0, z: 0 }, minOffset: 0, maxOffset: 0,
    a: { x: 0, y: 0, z: 0 }, minA: 1, maxA: 1, b: { x: 0, y: 0, z: 0 }, minB: 1, maxB: 1,
    c: { x: 0, y: 0, z: 0 }, minC: 1, maxC: 1, startScale: 1, finalScale: 1, scaleRand: 0,
    startTrans: 0, finalTrans: 0, transRand: 0, isParentLocal: 0,
    ...overrides,
  } as ParticleEmitterInfo;
}

const positions = (sys: ParticleSystem) => {
  return [...Array(sys.activeCount)].map((_, i) => sys.positionAt(i));
};

describe('ParticleSystem world-frame mode (ParticleEmitter::SetParenting + Particle::Init/Update)', () => {
  it('rotates the hook offset into the parent frame and starts particles there', () => {
    const scene = new THREE.Scene();
    const parent = new THREE.Object3D();
    parent.position.set(10, 0, 20);
    parent.rotation.y = Math.PI / 2; // THREE +90° yaw
    scene.add(parent);
    // AC offset (0, 0.4, 1.2): 0.4 "forward" (AC +y), 1.2 up (AC +z).
    const sys = new ParticleSystem(makeInfo({ initialParticles: 1 }), 0xffffff, undefined,
      makeEmitterFrameSource(parent, { x: 0, y: 0.4, z: 1.2 }));
    sys.update(0);
    const [p] = positions(sys);
    const expected = new THREE.Vector3(0, 1.2, 0.4).applyQuaternion(parent.quaternion).add(parent.position);
    expect(p.distanceTo(expected)).toBeLessThan(1e-5);
    expect(p.y).toBeCloseTo(1.2, 5);
    sys.dispose();
  });

  it('a non-parent-local particle stays where it was emitted; a parent-local one rides the parent', () => {
    const scene = new THREE.Scene();
    const parent = new THREE.Object3D();
    scene.add(parent);
    const world = new ParticleSystem(makeInfo({ initialParticles: 1 }), 0xffffff, undefined, makeEmitterFrameSource(parent, { x: 0, y: 0, z: 0 }));
    const local = new ParticleSystem(makeInfo({ initialParticles: 1, isParentLocal: 1 }), 0xffffff, undefined, makeEmitterFrameSource(parent, { x: 0, y: 0, z: 0 }));
    parent.position.set(5, 0, 0);
    world.update(0.1);
    local.update(0.1);
    expect(positions(world)[0].x).toBeCloseTo(0, 5);
    expect(positions(local)[0].x).toBeCloseTo(5, 5);
    world.dispose();
    local.dispose();
  });

  it('BirthratePerMeter emits one particle per update once the parent moved more than `birthrate` metres (@ 00517420)', () => {
    const scene = new THREE.Scene();
    const hand = new THREE.Object3D();
    scene.add(hand);
    // The cast hand glow 0x32000109: Still, per-metre 0.05, 40 max, 10 s.
    const sys = new ParticleSystem(makeInfo({ emitterType: 2, birthrate: 0.05, maxParticles: 40, totalSeconds: 10, lifespan: 2 }), 0xffffff, undefined,
      makeEmitterFrameSource(hand, { x: 0, y: 0, z: -0.1 }));
    sys.update(1 / 60); // first update: no emission recorded yet → emits
    const first = sys.totalEmittedCount;
    sys.update(1 / 60); // standing still → nothing more
    expect(sys.totalEmittedCount).toBe(first);
    for (let i = 1; i <= 10; i++) { hand.position.x = i * 0.1; sys.update(1 / 60); }
    expect(sys.totalEmittedCount).toBe(first + 10);
    // …and every particle stays on the hand's path (a trail, not a blob).
    const xs = positions(sys).map((p) => p.x).sort((a, b) => a - b);
    expect(xs[xs.length - 1]).toBeCloseTo(1.0, 5);
    sys.dispose();
  });

  it('a stopped emitter makes no new particles and is done once the last dies (StopParticleEmitter @ 0051b7b0)', () => {
    const sys = new ParticleSystem(makeInfo({ birthrate: 0.1, lifespan: 0.5 }));
    sys.update(0.35);
    expect(sys.activeCount).toBeGreaterThan(0);
    sys.stop();
    const emitted = sys.totalEmittedCount;
    sys.update(0.3);
    expect(sys.totalEmittedCount).toBe(emitted);
    expect(sys.isDone).toBe(false);
    sys.update(1);
    expect(sys.isDone).toBe(true);
    sys.dispose();
  });

  it('a world-frame emitter whose parent left the scene stops', () => {
    const scene = new THREE.Scene();
    const parent = new THREE.Object3D();
    scene.add(parent);
    const sys = new ParticleSystem(makeInfo({ birthrate: 0.1 }), 0xffffff, undefined, makeEmitterFrameSource(parent, { x: 0, y: 0, z: 0 }));
    scene.remove(parent);
    sys.update(0.5);
    expect(sys.isStopped).toBe(true);
    sys.dispose();
  });
});

describe('ParticleSystem kinematics per the decompiled client', () => {
  it('Swarm orbits with radius C around the offset (Particle::Update @ 0051c290)', () => {
    const sys = new ParticleSystem(makeInfo({
      initialParticles: 1, particleType: 5, b: { x: 8, y: 8, z: 8 }, c: { x: 0.1, y: 0.1, z: 0.1 },
    }));
    for (const t of [0, 0.3, 0.7]) {
      sys.update(t === 0 ? 0 : 0.35);
      const p = positions(sys)[0];
      // THREE (x, y, z) = AC (x, z, y): every component within C of the origin.
      expect(Math.abs(p.x)).toBeLessThanOrEqual(0.1 + 1e-6);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(0.1 + 1e-6);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(0.1 + 1e-6);
    }
    sys.dispose();
  });

  it('random offsets span [minOffset, maxOffset] (GetRandomOffset @ 005174a0)', () => {
    const sys = new ParticleSystem(makeInfo({
      initialParticles: 50, offsetDir: { x: 0, y: 0, z: 1 }, minOffset: 1, maxOffset: 2,
    }));
    sys.update(0);
    for (const p of positions(sys)) {
      expect(p.length()).toBeGreaterThanOrEqual(1 - 1e-5);
      expect(p.length()).toBeLessThanOrEqual(2 + 1e-5);
    }
    sys.dispose();
  });

  it('start/final scale and trans are randomized per particle and clamped (GetRandomStartScale @ 005170d0 …)', () => {
    const sys = new ParticleSystem(makeInfo({
      initialParticles: 40, startScale: 0.1, finalScale: 0.1, scaleRand: 0.5, startTrans: 0.9, finalTrans: 0.9, transRand: 0.5,
    }));
    sys.update(0);
    const sizes = [...Array(40)].map((_, i) => sys.scaleAt(i));
    const alphas = [...Array(40)].map((_, i) => sys.alphaAt(i));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(0.1 - 1e-6); // MINIMUM_SCALE
    expect(new Set(sizes.map((v) => v.toFixed(4))).size).toBeGreaterThan(1);
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(0); // trans clamped to ≤ 1
    expect(new Set(alphas.map((v) => v.toFixed(4))).size).toBeGreaterThan(1);
    sys.dispose();
  });

  it('particles are world-size quads: the instance scale IS gfxobj_scale (no screen-space point sizing)', () => {
    const sys = new ParticleSystem(makeInfo({ initialParticles: 1, startScale: 2, finalScale: 2 }), 0xffffff, { sizeScale: 0.5 });
    sys.update(0);
    const m = new THREE.Matrix4();
    sys.meshes[0].getMatrixAt(0, m);
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), scl = new THREE.Vector3();
    m.decompose(pos, q, scl);
    expect(scl.x).toBeCloseTo(2, 5);
    // The 0.5 m fallback square drawn at scale 2 spans 1 m in world units.
    const geo = sys.meshes[0].geometry;
    geo.computeBoundingBox();
    expect((geo.boundingBox!.max.x - geo.boundingBox!.min.x) * scl.x).toBeCloseTo(1, 5);
    sys.dispose();
  });
});

describe('PhysicsScriptPlayer — emitters ride their part (CreateParticleHook part_index)', () => {
  it('parents to the owner\'s DIRECT part_N child, the object itself for part 0xFFFFFFFF', () => {
    const owner = new THREE.Group();
    const hand = new THREE.Object3D(); hand.name = 'part_12'; owner.add(hand);
    const item = new THREE.Group(); const itemPart = new THREE.Object3D(); itemPart.name = 'part_15'; item.add(itemPart); hand.add(item);
    expect(emitterParentNode(owner, 12)).toBe(hand);
    expect(emitterParentNode(owner, 0xFFFFFFFF)).toBe(owner);
    // A wielded item's own part_15 is not the owner's part 15.
    expect(emitterParentNode(owner, 15)).toBe(owner);
  });

  it('executeHook spawns a world-frame emitter that follows the hand as it animates', () => {
    const scene = new THREE.Scene();
    const effects = new SpellEffects(scene);
    const player = new PhysicsScriptPlayer({
      spellEffects: effects, soundPlayer: {} as never, getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
      loadEmitterInfo: () => makeInfo({ emitterType: 2, birthrate: 0.05, totalSeconds: 10, lifespan: 2 }),
    });
    const caster = new THREE.Group(); scene.add(caster);
    const hand = new THREE.Object3D(); hand.name = 'part_12'; caster.add(hand);
    hand.position.set(0.3, 1.2, 0.2);
    const hook = {
      hookType: AnimationHookType.CreateParticle, direction: 1, emitterInfoId: 0x32000109, partIndex: 12,
      offset: { origin: { x: 0, y: 0, z: -0.1 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }, emitterId: 20,
    } as AnimationHook;
    player.executeHook(hook, caster);
    const sys = player.emittersFor(caster).get(20)!;
    expect(sys.isWorldSpace).toBe(true);
    effects.update(1 / 60);
    hand.position.x += 0.5; // the hand sweeps
    effects.update(1 / 60);
    const xs = positions(sys).map((p) => p.x);
    expect(Math.max(...xs)).toBeCloseTo(0.8, 5);
    // The lowering's StopParticle (direction Backward) stops it; SpellEffects
    // drops it once its last particle dies.
    player.executeHook({ hookType: AnimationHookType.StopParticle, direction: -1, emitterId: 20 } as AnimationHook, caster);
    expect(sys.isStopped).toBe(true);
    effects.update(3);
    expect(scene.children.includes(sys.object3D)).toBe(false);
  });
});

describe.skipIf(!hasDat)('the real Magic-stance cast animations (human motion table 0x09000001)', () => {
  let portalDb: { getFileData(id: number): ArrayBuffer | null };
  let loadInfo: (id: number) => ParticleEmitterInfo | null;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { ParticleEmitterInfo } = await import('../packages/dat-parser/src/file-types/ParticleEmitterInfo.js');
    const buf = fs.readFileSync(PORTAL);
    portalDb = new DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) as never;
    loadInfo = (id) => { const d = portalDb.getFileData(id); return d ? new ParticleEmitterInfo(new DatReader(d)) : null; };
  });

  function castEvent(guid: number, forward: number, speed: number): { guid: number; movementData: Uint8Array } {
    const MAGIC = 0x80000049;
    const buf = new Uint8Array(6 + 4 + 4 + 2 + 2 + 4);
    const v = new DataView(buf.buffer);
    v.setUint8(4, 0);
    v.setUint8(6, 0);
    v.setUint16(8, MAGIC & 0xffff, true);
    v.setUint32(10, 0x1 | 0x2 | 0x4, true);
    v.setUint16(14, MAGIC & 0xffff, true);
    v.setUint16(16, forward & 0xffff, true);
    v.setFloat32(18, speed, true);
    return { guid, movementData: buf };
  }

  it('a remote caster\'s windup + gesture run the DAT particle hooks on its hands and chest, blue and additive', async () => {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const { resolveEmitterSprite } = await import('../packages/renderer/src/effects/EmitterSprite.js');
    const scene = new THREE.Scene();
    const som = new ServerObjectManager({} as never, {} as never, scene as never);
    som.setPortalDb(portalDb as never);
    const group = new THREE.Group();
    for (let i = 0; i < 34; i++) { const p = new THREE.Object3D(); p.name = `part_${i}`; group.add(p); }
    scene.add(group);
    const GUID = 0x50000077;
    // ServerObjectManager wires every animated server object's hooks (tryInitAnimation).
    (som as unknown as { tryInitAnimation(o: object): void }).tryInitAnimation({ guid: GUID, mesh: group, setupId: 0x02000001, motionTableId: 0x09000001 });
    const animated = som.getAnimated(GUID)!;
    expect(animated).toBeInstanceOf(AnimatedEntity);
    expect(animated.motionManager.setStanceFromId(0x80000049)).toBe(true);

    const effects = new SpellEffects(scene);
    const spawned: Array<{ emitter: number; part: number | undefined; additive: boolean; blue: boolean }> = [];
    const textureManager = { getTexture: (id: number) => ({ id }) } as never;
    const spriteBlue = new Map<number, boolean>();
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { GfxObj } = await import('../packages/dat-parser/src/file-types/GfxObj.js');
    const { Surface } = await import('../packages/dat-parser/src/file-types/Surface.js');
    const { SurfaceTexture } = await import('../packages/dat-parser/src/file-types/SurfaceTexture.js');
    const { Texture } = await import('../packages/dat-parser/src/file-types/Texture.js');
    /** The HW sprite's texel colour: blue channel dominant (the retail cast glow). */
    const isBlue = (info: ParticleEmitterInfo): boolean => {
      const cached = spriteBlue.get(info.hwGfxObjId);
      if (cached !== undefined) return cached;
      const gfx = new GfxObj(new DatReader(portalDb.getFileData(info.hwGfxObjId)!));
      const surf = Surface.read(new DatReader(portalDb.getFileData(gfx.surfaces[0])!));
      const st = SurfaceTexture.read(new DatReader(portalDb.getFileData(surf.origTextureId)!));
      const rgba = Texture.read(new DatReader(portalDb.getFileData(st.textures[0])!)).toRGBA()!;
      let r = 0, b = 0;
      for (let i = 0; i < rgba.data.length; i += 4) { r += rgba.data[i]; b += rgba.data[i + 2]; }
      spriteBlue.set(info.hwGfxObjId, b > r * 2);
      return b > r * 2;
    };
    const orig = effects.spawnParticleEffect.bind(effects);
    effects.spawnParticleEffect = (info, pos, color, sprite, parent, opts) => {
      spawned.push({ emitter: info.id >>> 0, part: opts?.partIndex, additive: !!sprite?.additive, blue: isBlue(info) });
      return orig(info, pos, color, sprite, parent, opts);
    };
    const player = new PhysicsScriptPlayer({
      spellEffects: effects, soundPlayer: { playPositionalSound: vi.fn().mockResolvedValue(undefined) } as never, getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
      loadEmitterInfo: loadInfo,
      resolveEmitterSprite: (info) => resolveEmitterSprite(info, portalDb as never, textureManager),
    });
    const fired: number[] = [];
    som.onAnimationHook = (guid, hook, anchor) => {
      expect(guid).toBe(GUID);
      fired.push(hook.hookType);
      player.executeHook(hook, anchor);
    };
    const tick = (s: number) => { for (let t = 0; t < s - 1e-9; t += 1 / 60) { som.updateAnimations(1 / 60); effects.update(1 / 60); } };
    som.handleMovementEvent(castEvent(GUID, 0x78, 2.0) as never); // MagicPowerUp10
    tick(2.0);
    som.handleMovementEvent(castEvent(GUID, 0x32, 2.0) as never); // MagicThrowMissile hold
    tick(1.0);

    const ids = new Set(spawned.map((s) => s.emitter));
    for (const id of [0x3200011E, 0x32000120, 0x32000122, 0x32000123, 0x32000127, 0x32000128, 0x32000109]) expect(ids.has(id)).toBe(true);
    // Frame 59's 0x32000125 sits on the node's LAST frame, whose hooks
    // CSequence::update_internal @ 005255d0 never runs going forward (the
    // frame number clamps to high_frame before the hook loop).
    expect(ids.has(0x32000125)).toBe(false);
    // The hand glow rides the hands (parts 12 and 15); the swarms sit in front of the chest.
    expect(new Set(spawned.filter((s) => s.emitter === 0x32000109).map((s) => s.part))).toEqual(new Set([12, 15]));
    expect(spawned.filter((s) => s.emitter === 0x3200011E).every((s) => s.part === 0xFFFFFFFF)).toBe(true);
    // Every cast sprite is additive and blue — no red/orange anywhere.
    expect(spawned.every((s) => s.additive && s.blue)).toBe(true);
    // The windup's lowering (played backwards) fired StopParticle for the
    // hand emitters it made (ids 19–22).
    expect(fired).toContain(AnimationHookType.StopParticle);
    const hands = player.emittersFor(group);
    expect(hands.get(19)?.isStopped ?? true).toBe(true);
  });
});

describe('the cast path draws nothing of its own', () => {
  it('SpellEffects no longer offers the invented casting swirl', () => {
    const effects = new SpellEffects(new THREE.Scene()) as unknown as Record<string, unknown>;
    expect(effects.createCastingSwirl).toBeUndefined();
  });

  it('a done emitter leaves SpellEffects the tick it is done', () => {
    const scene = new THREE.Scene();
    const effects = new SpellEffects(scene);
    const sys = effects.spawnParticleEffect(makeInfo({ initialParticles: 2, totalParticles: 2, lifespan: 0.2 }), { x: 0, y: 0, z: 0 });
    effects.update(0.1);
    expect(scene.children.includes(sys.object3D)).toBe(true);
    effects.update(0.3);
    expect(scene.children.includes(sys.object3D)).toBe(false);
  });

  it('SpellEffects hands the particle view to every live system and to new ones', () => {
    const effects = new SpellEffects(new THREE.Scene());
    const sys = effects.spawnParticleEffect(makeInfo({}), { x: 0, y: 0, z: 0 });
    const setView = vi.spyOn(sys, 'setView');
    const view = { viewer: new THREE.Vector3(0, 0, 10) };
    effects.setParticleView(view);
    expect(setView).toHaveBeenCalledWith(view);
    effects.setParticleView(view); // same object: no re-lay
    expect(setView).toHaveBeenCalledTimes(1);
    const born = effects.spawnParticleEffect(makeInfo({}), { x: 0, y: 0, z: 0 });
    const spy2 = vi.spyOn(born, 'setView');
    effects.setParticleView({ viewer: new THREE.Vector3() });
    expect(spy2).toHaveBeenCalledTimes(1);
  });
});
