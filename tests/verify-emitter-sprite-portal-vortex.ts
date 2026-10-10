/**
 * VISUAL.portal-renders-opaque-white — world portals drew as opaque white
 * concentric panes instead of the retail purple vortex.
 *
 * Root cause (two premise corrections against the task's original filing):
 *   1) The filing claimed the vortex emitters were "0x320000CD/0x320000D6,
 *      absent from the EoL portal.dat". The setup 0x020001B3's DefaultScript
 *      0x3300067A actually references 0x320002CD/0x320002D6 — BOTH present
 *      in the EoL DAT. The retail purple swirl is fully DAT-driven.
 *   2) The white panes were NOT the base mesh (its 8x8 clipmap texture is
 *      fully transparent → alpha-tests to invisible). They were the two
 *      emitters' particles rendering as UNTEXTURED WHITE SQUARES:
 *      SpellEffects.spawnParticleEffect never resolved the emitter's sprite
 *      quad (GfxObj 0x010016C8/0x010016C9 → additive purple glow / swirl
 *      textures), so the gl_Points fell back to solid white.
 *
 * Fix under test:
 *   - resolveEmitterSprite (effects/EmitterSprite.ts) loads the emitter's
 *     HW GfxObj quad → first surface → texture + Additive bit + extent
 *     (and, since VISUAL.particles-oriented-quads, the quad geometry and
 *     its degrade chain).
 *   - PhysicsScriptPlayer passes the resolved sprite through
 *     spawnParticleEffect, applies the CreateParticle hook's Frame offset
 *     (AC z-up → THREE y-up), and gives ENDLESS emitters (totalSeconds and
 *     totalParticles both 0 — the portal vortex runs forever) an Infinity
 *     maxAge plus explicit disposal on stopForAnchor().
 *   - SpellEffects.removeParticleSystem disposes one tracked system.
 *
 * References: dat probe in progress.md 2026-08-21 (script 0x3300067A steps,
 * emitter params, surface types 0x00010102/0x00010104 both Additive);
 * ACE ParticleEmitterInfo.cs (GfxObjId/HWGfxObjId).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as fs from 'fs';
import { Object3D, Scene, AdditiveBlending, NormalBlending, MeshLambertMaterial } from 'three';
import { PhysicsScriptPlayer } from '@ac/renderer/effects/PhysicsScriptPlayer.js';
import { SpellEffects } from '@ac/renderer/effects/SpellEffects.js';
import { ParticleSystem } from '@ac/renderer/effects/ParticleSystem.js';
import { resolveEmitterSprite } from '@ac/renderer/effects/EmitterSprite.js';
import { TextureManager } from '@ac/renderer/models/TextureManager.js';
import { AnimationHookType } from '@ac/dat-parser';
import type { PhysicsScript, ParticleEmitterInfo } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

const PORTAL_DAT = 'dat/client_portal.dat';
const hasPortalDat = fs.existsSync(PORTAL_DAT);

/** Minimal structural PhysicsScript for unit tests. */
function makeScript(id: number, steps: Array<{ t: number; hook: object | null }>): PhysicsScript {
  return { id, steps: steps.map(s => ({ startTime: s.t, hook: s.hook as never })) } as never;
}

/** An endless emitter shaped like the portal vortex glow 0x320002CD. */
function endlessEmitterInfo(id = 0x320002CD): Partial<ParticleEmitterInfo> {
  return {
    id, emitterType: 1, particleType: 9,
    gfxObjId: 0, hwGfxObjId: 0x010016C8,
    birthrate: 1 / 6, maxParticles: 12, initialParticles: 0,
    totalParticles: 0, totalSeconds: 0,
    lifespan: 2, lifespanRand: 0,
  };
}

function makeDeps(emitters: Record<number, Partial<ParticleEmitterInfo>>, sprite: object | null = null) {
  const spawned: Array<{ info: unknown; pos: { x: number; y: number; z: number }; sprite: unknown; token: object }> = [];
  const removed: object[] = [];
  const spellEffects = {
    spawnParticleEffect: vi.fn((info, pos, _color, spriteArg) => {
      const token = { info };
      spawned.push({ info, pos, sprite: spriteArg, token });
      return token as never;
    }),
    removeParticleSystem: vi.fn((system: object) => { removed.push(system); }),
  } as never;
  const deps = {
    spellEffects,
    soundPlayer: { playPositionalSound: vi.fn().mockResolvedValue(undefined) } as never,
    loadEmitterInfo: vi.fn((id: number) => (emitters[id] ?? null) as never),
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    resolveEmitterSprite: vi.fn(() => sprite as never),
  };
  return { deps, spawned, removed };
}

function createParticleHook(emitterInfoId: number, offsetZ = 0) {
  return {
    hookType: AnimationHookType.CreateParticle, direction: 0,
    emitterInfoId, partIndex: 0,
    offset: { origin: { x: 0, y: 0, z: offsetZ }, orientation: { w: 1, x: 0, y: 0, z: 0 } },
    emitterId: 0,
  };
}

describe('PhysicsScriptPlayer CreateParticle — endless emitters + sprite passthrough', () => {
  it('endless emitters (no time/count bound) spawn with the resolved sprite', () => {
    const spriteOpts = { map: null, additive: true, sizeScale: 1.45 };
    const { deps, spawned } = makeDeps({ 0x320002CD: endlessEmitterInfo() }, spriteOpts);
    const player = new PhysicsScriptPlayer(deps as never);
    const anchor = new Object3D();
    anchor.position.set(100, 50, 200);
    player.play(makeScript(0x3300067A, [{ t: 0, hook: createParticleHook(0x320002CD, 0.15) }]), anchor);

    expect(spawned).toHaveLength(1);
    expect(spawned[0].sprite).toBe(spriteOpts);
    expect(deps.resolveEmitterSprite).toHaveBeenCalledTimes(1);
  });

  it('applies the hook Frame offset with the AC z-up → THREE y-up swap', () => {
    const { deps, spawned } = makeDeps({ 0x320002CD: endlessEmitterInfo() });
    const player = new PhysicsScriptPlayer(deps as never);
    const anchor = new Object3D();
    anchor.position.set(100, 50, 200);
    // AC offset z=0.15 (up) must land on THREE y.
    player.play(makeScript(0x3300067A, [{ t: 0, hook: createParticleHook(0x320002CD, 0.15) }]), anchor);
    expect(spawned[0].pos).toEqual({ x: 100, y: 50.15, z: 200 });
  });

  it('DECOMP.invented-emitter-maxage — no age limit is handed to SpellEffects; a bounded emitter dies with its object', () => {
    const bounded = { ...endlessEmitterInfo(), totalParticles: 24 };
    const { deps, spawned, removed } = makeDeps({ 0x320002CD: bounded });
    const player = new PhysicsScriptPlayer(deps as never);
    const anchor = new Object3D();
    player.play(makeScript(0x33000001, [{ t: 0, hook: createParticleHook(0x320002CD) }]), anchor);

    expect(spawned).toHaveLength(1);
    // spawnParticleEffect(info, pos, color, sprite, parent, opts) — no maxAge slot.
    const call = (deps.spellEffects as unknown as { spawnParticleEffect: { mock: { calls: unknown[][] } } }).spawnParticleEffect.mock.calls[0];
    expect(call).toHaveLength(6);
    // ~CPhysicsObj deletes its ParticleManager: every emitter goes with the object.
    player.stopForAnchor(anchor);
    expect(removed).toEqual([spawned[0].token]);
  });

  it('stopForAnchor() disposes endless systems via SpellEffects.removeParticleSystem', () => {
    const { deps, spawned, removed } = makeDeps({ 0x320002CD: endlessEmitterInfo() });
    const player = new PhysicsScriptPlayer(deps as never);
    const anchor = new Object3D();
    const otherAnchor = new Object3D();
    player.play(makeScript(0x3300067A, [{ t: 0, hook: createParticleHook(0x320002CD) }]), anchor);
    player.play(makeScript(0x3300067A, [{ t: 0, hook: createParticleHook(0x320002CD) }]), otherAnchor);
    expect(spawned).toHaveLength(2);

    player.stopForAnchor(anchor);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toBe(spawned[0].token);

    // Idempotent — a second stop must not double-dispose.
    player.stopForAnchor(anchor);
    expect(removed).toHaveLength(1);
  });
});

describe('SpellEffects — sprite plumbing + removeParticleSystem', () => {
  const emitterInfo = {
    ...endlessEmitterInfo(),
    offsetDir: { x: 0, y: 1, z: 0 }, minOffset: 0, maxOffset: 0.1,
    a: { x: 0, y: 0, z: 0 }, minA: 0, maxA: 0,
    b: { x: 0, y: 0, z: 0 }, minB: 0, maxB: 0,
    c: { x: 0, y: 0, z: 0 }, minC: 0, maxC: 0,
    startScale: 5, finalScale: 0.1, scaleRand: 0,
    startTrans: 1, finalTrans: 0.4, transRand: 0, isParentLocal: 0,
  } as never as ParticleEmitterInfo;

  it('passes the sprite through to the ParticleSystem shader (map + additive blending)', () => {
    const scene = new Scene();
    const effects = new SpellEffects(scene);
    const fakeMap = { isTexture: true } as never;
    const system = effects.spawnParticleEffect(emitterInfo, { x: 0, y: 0, z: 0 }, undefined, {
      map: fakeMap, additive: true, sizeScale: 1.45,
    });
    const mat = system.meshes[0].material as MeshLambertMaterial;
    expect(mat.map).toBe(fakeMap);
    expect(mat.blending).toBe(AdditiveBlending);
  });

  it('defaults to untextured normal blending without sprite options', () => {
    const scene = new Scene();
    const effects = new SpellEffects(scene);
    const system = effects.spawnParticleEffect(emitterInfo, { x: 0, y: 0, z: 0 });
    const mat = system.meshes[0].material as MeshLambertMaterial;
    expect(mat.map).toBeNull();
    expect(mat.blending).toBe(NormalBlending);
  });

  it('endless systems survive long update() spans until removeParticleSystem', () => {
    const scene = new Scene();
    const effects = new SpellEffects(scene);
    const system = effects.spawnParticleEffect(emitterInfo, { x: 1, y: 2, z: 3 });
    expect(scene.children).toContain(system.object3D);

    // Far past any bounded lifetime — endless system must still be live.
    for (let i = 0; i < 100; i++) effects.update(1.0);
    expect(scene.children).toContain(system.object3D);

    effects.removeParticleSystem(system);
    expect(scene.children).not.toContain(system.object3D);
    // Removing again is a no-op.
    effects.removeParticleSystem(system);
  });
});

describe.skipIf(!hasPortalDat)('portal vortex DAT ground truth (EoL portal.dat)', () => {
  let db: import('@ac/dat-parser').DatDatabase;
  let textureManager: TextureManager;
  let script: PhysicsScript;
  let emitterCD: ParticleEmitterInfo;
  let emitterD6: ParticleEmitterInfo;

  beforeAll(async () => {
    // All DAT reads live in beforeAll — describe.skipIf does NOT skip the
    // callback body at collection time (CLAUDE.md landmine, 2026-07-21).
    const { DatDatabase, DatReader, PhysicsScript: PS, ParticleEmitterInfo: PEI } = await import('@ac/dat-parser');
    db = openDat(PORTAL_DAT);
    textureManager = new TextureManager(db);
    script = PS.read(new DatReader(db.getFileData(0x3300067A)!));
    emitterCD = new PEI(new DatReader(db.getFileData(0x320002CD)!));
    emitterD6 = new PEI(new DatReader(db.getFileData(0x320002D6)!));
  });

  it('setup 0x020001B3 DefaultScript 0x3300067A fires emitters 0x320002CD + 0x320002D6 (premise correction: NOT 0x320000CD/D6)', () => {
    const particleHooks = script.steps
      .map(s => s.hook as { hookType: number; emitterInfoId?: number } | null)
      .filter(h => h?.hookType === AnimationHookType.CreateParticle);
    expect(particleHooks.map(h => h!.emitterInfoId).sort()).toEqual([0x320002CD, 0x320002D6]);
    // The wrongly-accused IDs are genuinely absent — the census gap was a
    // misread of the third byte (02 → 00), not missing content.
    expect(db.getFileData(0x320000CD)).toBeNull();
  });

  it('both vortex emitters are ENDLESS (no time bound, no count bound)', () => {
    for (const e of [emitterCD, emitterD6]) {
      expect(e.totalSeconds).toBe(0);
      expect(e.totalParticles).toBe(0);
      expect(e.birthrate).toBeGreaterThan(0);
    }
  });

  it('resolveEmitterSprite returns the additive textured HW quad for 0x320002CD; 0x320002D6 has no HW GfxObj', () => {
    const sprite = resolveEmitterSprite(emitterCD, db, textureManager);
    expect(sprite).not.toBeNull();
    expect(sprite!.map).not.toBeNull();
    expect(sprite!.additive).toBe(true);
    // The HW quad 0x010016C8 is 1.45 × 1.40 m.
    expect(sprite!.sizeScale).toBeGreaterThan(1.3);
    expect(sprite!.sizeScale).toBeLessThan(1.6);
    // VISUAL.particles-oriented-quads — ParticleEmitter::SetInfo @ 0051ce90
    // builds particles from hw_gfxobj_id ONLY (INVALID → the emitter is
    // destroyed; PhysicsScriptPlayer never creates it). 0x320002D6 names
    // only a software GfxObj (0x010016C9), so retail draws nothing for it.
    expect(emitterD6.hwGfxObjId).toBe(0);
    expect(resolveEmitterSprite(emitterD6, db, textureManager)).toBeNull();
  });

  it('the glow sprite texture is purple-dominant (blue+red over green) — the retail vortex tint', () => {
    // Emitter 0x320002CD → hw GfxObj 0x010016C8 → surface 0x08000498 →
    // texture avg ≈ (60,7,77): red+blue with almost no green.
    const rgba = textureManager.getRGBA(0x050016E7)!;
    expect(rgba).not.toBeNull();
    let r = 0, g = 0, b = 0;
    const n = rgba.width * rgba.height;
    for (let i = 0; i < n; i++) {
      r += rgba.data[i * 4]; g += rgba.data[i * 4 + 1]; b += rgba.data[i * 4 + 2];
    }
    expect(b / n).toBeGreaterThan(g / n + 30);
    expect(r / n).toBeGreaterThan(g / n + 20);
  });

  it('a full ParticleSystem built from the real emitter + sprite renders additive textured quads', () => {
    const sprite = resolveEmitterSprite(emitterCD, db, textureManager)!;
    const system = new ParticleSystem(emitterCD, 0xffffff, sprite);
    const mat = system.meshes[0].material as MeshLambertMaterial;
    expect(mat.map).not.toBeNull();
    expect(mat.blending).toBe(AdditiveBlending);
    // Endless emitter: after a few seconds of updates particles exist and
    // keep existing (birthrate-driven, never stopped).
    for (let i = 0; i < 60; i++) system.update(0.1);
    expect(system.activeCount).toBeGreaterThan(0);
    expect(system.activeCount).toBeLessThanOrEqual(emitterCD.maxParticles);
  });
});
