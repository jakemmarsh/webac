/**
 * FAITHFUL.177 — PhysicsScriptPlayer runtime tests.
 *
 * Pins the lifecycle invariants:
 *   1) t=0 hooks fire synchronously inside play() so the caller can rely on
 *      "immediate" effects (e.g. sound-on-spawn) without an update() tick.
 *   2) Hooks at later startTimes fire when update() advances elapsed time past
 *      their threshold — and never twice.
 *   3) Sound hooks dispatch to SoundPlayer.playPositionalSound with the
 *      anchor's world position.
 *   4) CreateParticle hooks resolve the emitterInfoId via the loader and
 *      dispatch to SpellEffects.spawnParticleEffect.
 *   5) Scripts auto-dispose when elapsed exceeds the duration AND all steps
 *      have fired.
 *   6) stopForAnchor() cancels in-flight scripts targeting that anchor.
 *
 * Reference: packages/renderer/src/effects/PhysicsScriptPlayer.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { PhysicsScriptPlayer } from '@ac/renderer/effects/PhysicsScriptPlayer.js';
import { AnimationHookType } from '@ac/dat-parser';
import type { PhysicsScript } from '@ac/dat-parser';

/** Build a minimal PhysicsScript instance with synthetic steps for unit testing. */
function makeScript(id: number, steps: Array<{ t: number; hook: object | null }>): PhysicsScript {
  // The type is structural — TS class instances are duck-typed by the player.
  return { id, steps: steps.map(s => ({ startTime: s.t, hook: s.hook as never })) } as never;
}

/** Build a stub SpellEffects with spawnParticleEffect tracked via vi.fn(). */
function makeFakeDeps() {
  const spawnParticleEffect = vi.fn();
  const playPositionalSound = vi.fn().mockResolvedValue(undefined);
  const spellEffects = { spawnParticleEffect } as never;
  const soundPlayer = { playPositionalSound } as never;
  const loadEmitterInfo = vi.fn((id: number) => (
    id === 0xDEADBEEF ? null : ({ id, hwGfxObjId: 0x01000001, lifespan: 1, lifespanRand: 0 } as never)
  ));
  const loadScript = vi.fn();
  const getListenerPos = () => ({ x: 0, y: 0, z: 0 });
  const resolveDefaultScript = vi.fn();
  return { spellEffects, soundPlayer, loadEmitterInfo, loadScript, resolveDefaultScript, getListenerPos, spawnParticleEffect, playPositionalSound };
}

describe('PhysicsScriptPlayer.play — synchronous t=0 dispatch', () => {
  it('fires Sound hooks at t=0 synchronously before update() is called', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    anchor.position.set(10, 20, 30);
    const script = makeScript(0x33000001, [
      { t: 0, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0A000042 } },
    ]);
    player.play(script, anchor);
    expect(deps.playPositionalSound).toHaveBeenCalledTimes(1);
    const callArgs = deps.playPositionalSound.mock.calls[0];
    expect(callArgs[0]).toBe(0x0A000042);
    expect(callArgs[1]).toEqual({ x: 10, y: 20, z: 30 });
    expect(player.activeCount).toBe(0); // single-step at t=0 → done immediately
  });

  it('fires CreateParticle hooks at t=0 with resolved emitter info', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    anchor.position.set(5, 5, 5);
    const script = makeScript(0x33000002, [
      {
        t: 0,
        hook: {
          hookType: AnimationHookType.CreateParticle,
          direction: 0,
          emitterInfoId: 0x32000001,
          partIndex: 0,
          offset: { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },
          emitterId: 1,
        },
      },
    ]);
    player.play(script, anchor);
    expect(deps.loadEmitterInfo).toHaveBeenCalledWith(0x32000001);
    expect(deps.spawnParticleEffect).toHaveBeenCalledTimes(1);
    expect(deps.spawnParticleEffect.mock.calls[0][1]).toEqual({ x: 5, y: 5, z: 5 });
  });

  it('skips CreateParticle hooks when the emitter info is missing', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const script = makeScript(0x33000003, [
      {
        t: 0,
        hook: {
          hookType: AnimationHookType.CreateParticle,
          direction: 0,
          emitterInfoId: 0xDEADBEEF,
          partIndex: 0,
          offset: { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },
          emitterId: 1,
        },
      },
    ]);
    player.play(script, anchor);
    expect(deps.spawnParticleEffect).not.toHaveBeenCalled();
  });
});

describe('PhysicsScriptPlayer.update — time-based dispatch', () => {
  it('fires later hooks when elapsed time crosses their startTime', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const script = makeScript(0x33000010, [
      { t: 0.5, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0A000001 } },
      { t: 1.5, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0A000002 } },
    ]);
    player.play(script, anchor);
    expect(deps.playPositionalSound).not.toHaveBeenCalled();
    expect(player.activeCount).toBe(1);

    player.update(0.25);
    expect(deps.playPositionalSound).not.toHaveBeenCalled();

    player.update(0.5); // elapsed=0.75, crosses 0.5
    expect(deps.playPositionalSound).toHaveBeenCalledTimes(1);
    expect(deps.playPositionalSound.mock.calls[0][0]).toBe(0x0A000001);

    player.update(1.0); // elapsed=1.75, crosses 1.5
    expect(deps.playPositionalSound).toHaveBeenCalledTimes(2);
    expect(deps.playPositionalSound.mock.calls[1][0]).toBe(0x0A000002);

    // Script duration is 1.5; elapsed past that AND all steps fired → disposed.
    expect(player.activeCount).toBe(0);
  });

  it('does not double-fire hooks across multiple update() ticks', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const script = makeScript(0x33000011, [
      { t: 0.1, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0A000003 } },
    ]);
    player.play(script, anchor);
    player.update(1.0);
    player.update(1.0);
    player.update(1.0);
    expect(deps.playPositionalSound).toHaveBeenCalledTimes(1);
  });
});

describe('PhysicsScriptPlayer.stopForAnchor — cancellation', () => {
  it('removes only the scripts targeting that anchor', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const a = new Object3D();
    const b = new Object3D();
    const longScript = makeScript(0x33000020, [
      { t: 10, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0A000099 } },
    ]);
    player.play(longScript, a);
    player.play(longScript, b);
    expect(player.activeCount).toBe(2);

    player.stopForAnchor(a);
    expect(player.activeCount).toBe(1);

    // The remaining b-anchored script still fires its hook.
    player.update(15);
    expect(deps.playPositionalSound).toHaveBeenCalledTimes(1);
    expect(deps.playPositionalSound.mock.calls[0][1]).toEqual(a === b ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: 0 });
  });
});

describe('PhysicsScriptPlayer — NoDraw hook', () => {
  it('toggles anchor.visible when the NoDraw hook fires', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    expect(anchor.visible).toBe(true);
    const script = makeScript(0x33000030, [
      { t: 0, hook: { hookType: AnimationHookType.NoDraw, direction: 0, noDraw: 1 } },
    ]);
    player.play(script, anchor);
    expect(anchor.visible).toBe(false);
  });
});

describe('PhysicsScriptPlayer — tween hooks (Scale / Luminous / Diffuse / Transparent)', () => {
  it('Scale hook interpolates anchor.scale from current to end over time', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    anchor.scale.setScalar(1.0);
    const script = makeScript(0x33000060, [
      { t: 0, hook: { hookType: AnimationHookType.Scale, direction: 0, end: 2.0, time: 1.0 } },
    ]);
    player.play(script, anchor);
    // immediately at t=0 — scale unchanged
    expect(anchor.scale.x).toBeCloseTo(1.0);
    player.update(0.5);
    // halfway — should be 1.5
    expect(anchor.scale.x).toBeCloseTo(1.5, 1);
    player.update(0.5);
    // done — should be 2.0
    expect(anchor.scale.x).toBeCloseTo(2.0, 4);
    expect(player.activeCount).toBe(0);
  });

  // CPhysicsPart::SetLuminosity → CMaterial::SetLuminositySimple: the value
  // IS the D3D Emissive grey (VISUAL.lifestone-crystal-glow).
  it('Luminous hook interpolates the emissive grey on the anchor mesh material', async () => {
    const { MeshLambertMaterial, Mesh, BufferGeometry } = await import('three');
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const mat = new MeshLambertMaterial();
    const mesh = new Mesh(new BufferGeometry(), mat);
    anchor.add(mesh);
    const script = makeScript(0x33000061, [
      { t: 0, hook: { hookType: AnimationHookType.Luminous, direction: 0, start: 0, end: 2.0, time: 1.0 } },
    ]);
    player.play(script, anchor);
    expect(mat.emissive.r).toBeCloseTo(0);
    player.update(0.5);
    expect(mat.emissive.r).toBeCloseTo(1.0, 1);
    player.update(0.5);
    expect(mat.emissive.r).toBeCloseTo(2.0, 4);
    expect(mat.emissive.g).toBeCloseTo(2.0, 4);
    expect(mat.emissiveIntensity).toBe(1);
  });

  it('Transparent hook tweens TRANSLUCENCY (SetTranslucency2 @ 00526c30): 1 → 0 fades in', async () => {
    const { MeshBasicMaterial, Mesh, BufferGeometry } = await import('three');
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const mat = new MeshBasicMaterial();
    const mesh = new Mesh(new BufferGeometry(), mat);
    anchor.add(mesh);
    const script = makeScript(0x33000062, [
      { t: 0, hook: { hookType: AnimationHookType.Transparent, direction: 0, start: 1.0, end: 0.0, time: 2.0 } },
    ]);
    player.play(script, anchor);
    // Translucency 1.0 = invisible: CPhysicsPart::SetTranslucency sets the
    // part's no-draw bit (the material itself is untouched — SWEEP1006 part no-draw).
    expect(mesh.visible).toBe(false);
    expect(mat.visible).toBe(true);
    player.update(1.0);
    expect(mesh.visible).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.5, 1);
    expect(mat.transparent).toBe(true);
    player.update(1.0);
    // BUG.transparent-hook-inverted — ends SOLID (the Create fade-in), not invisible.
    expect(mat.opacity).toBeCloseTo(1.0, 4);
    expect(mat.transparent).toBe(false);
  });
});

describe('PhysicsScriptPlayer — SoundTweaked (probability-gated)', () => {
  it('fires the sound when probability is 1.0', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const script = makeScript(0x33000080, [
      {
        t: 0,
        hook: {
          hookType: AnimationHookType.SoundTweaked,
          direction: 0,
          soundId: 0x0A000077,
          priority: 1,
          probability: 1.0,
          volume: 1.0,
        },
      },
    ]);
    player.play(script, anchor);
    expect(deps.playPositionalSound).toHaveBeenCalledTimes(1);
    expect(deps.playPositionalSound.mock.calls[0][0]).toBe(0x0A000077);
  });

  it('skips the sound when probability is 0.0', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const script = makeScript(0x33000081, [
      {
        t: 0,
        hook: {
          hookType: AnimationHookType.SoundTweaked,
          direction: 0,
          soundId: 0x0A000077,
          priority: 1,
          probability: 0.0,
          volume: 1.0,
        },
      },
    ]);
    player.play(script, anchor);
    expect(deps.playPositionalSound).not.toHaveBeenCalled();
  });
});

describe('PhysicsScriptPlayer — Ethereal/ReplaceObject/CallPES/SetOmega', () => {
  it('Ethereal hook sets userData.ethereal flag on anchor', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const script = makeScript(0x33000070, [
      { t: 0, hook: { hookType: AnimationHookType.Ethereal, direction: 0, ethereal: 1 } },
    ]);
    player.play(script, anchor);
    expect(anchor.userData.ethereal).toBe(true);
  });

  it('Ethereal hook with ethereal=0 sets flag to false', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const script = makeScript(0x33000071, [
      { t: 0, hook: { hookType: AnimationHookType.Ethereal, direction: 0, ethereal: 0 } },
    ]);
    player.play(script, anchor);
    expect(anchor.userData.ethereal).toBe(false);
  });

  it('ReplaceObject hook tags a named part with replacePartId', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const part = new Object3D();
    part.name = 'part_3';
    anchor.add(part);
    const script = makeScript(0x33000072, [
      { t: 0, hook: { hookType: AnimationHookType.ReplaceObject, direction: 0, partIndex: 3, partId: 0x01000abc } },
    ]);
    player.play(script, anchor);
    expect(part.userData.replacePartId).toBe(0x01000abc);
  });

  it('CallPES with pause=0 invokes the nested script synchronously', () => {
    const deps = makeFakeDeps();
    const nestedSound = vi.fn();
    deps.loadScript = vi.fn(() => makeScript(0x33000099, [
      {
        t: 0,
        hook: {
          hookType: AnimationHookType.Sound,
          direction: 0,
          soundId: 0x0A0000aa,
        },
      },
    ]));
    deps.playPositionalSound = nestedSound as never;
    const player = new PhysicsScriptPlayer({ ...deps, soundPlayer: { playPositionalSound: nestedSound.mockResolvedValue(undefined) } as never });
    const anchor = new Object3D();
    const script = makeScript(0x33000073, [
      { t: 0, hook: { hookType: AnimationHookType.CallPES, direction: 0, pes: 0x33000099, pause: 0 } },
    ]);
    player.play(script, anchor);
    expect(deps.loadScript).toHaveBeenCalledWith(0x33000099);
    expect(nestedSound).toHaveBeenCalled();
  });

  it('SetOmega hook stashes axis on anchor.userData.omega', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const script = makeScript(0x33000074, [
      { t: 0, hook: { hookType: AnimationHookType.SetOmega, direction: 0, axis: { x: 0, y: 1, z: 0 } } },
    ]);
    player.play(script, anchor);
    expect(anchor.userData.omega).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('CallPES with pause>0 plays the nested script after RollDice(0, pause) on the object clock (CallPES @ 00511af0)', () => {
    const deps = makeFakeDeps();
    const nestedSound = vi.fn().mockResolvedValue(undefined);
    deps.loadScript = vi.fn(() => makeScript(0x330000a0, [
      { t: 0, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0A0000ab } },
    ]));
    const rollDice = vi.fn((_min: number, max: number) => max * 0.5);
    const player = new PhysicsScriptPlayer({ ...deps, rollDice, soundPlayer: { playPositionalSound: nestedSound } as never });
    const anchor = new Object3D();
    const script = makeScript(0x33000075, [
      { t: 0, hook: { hookType: AnimationHookType.CallPES, direction: 0, pes: 0x330000a0, pause: 2 } },
    ]);
    player.play(script, anchor);
    expect(rollDice).toHaveBeenCalledWith(0, 2);
    expect(nestedSound).not.toHaveBeenCalled();
    player.update(0.9);
    expect(nestedSound).not.toHaveBeenCalled();
    player.update(0.1); // the rolled 1.0 s has passed
    expect(nestedSound).toHaveBeenCalledTimes(1);
  });

  it('stopForAnchor cancels a pending CallPES so the nested script never fires', () => {
    const deps = makeFakeDeps();
    const nestedSound = vi.fn().mockResolvedValue(undefined);
    deps.loadScript = vi.fn(() => makeScript(0x330000a1, [
      { t: 0, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0A0000ac } },
    ]));
    const player = new PhysicsScriptPlayer({ ...deps, rollDice: (_a, max) => max, soundPlayer: { playPositionalSound: nestedSound } as never });
    const anchor = new Object3D();
    const script = makeScript(0x33000076, [
      { t: 0, hook: { hookType: AnimationHookType.CallPES, direction: 0, pes: 0x330000a1, pause: 2 } },
    ]);
    player.play(script, anchor);
    player.stopForAnchor(anchor);
    player.update(5);
    expect(nestedSound).not.toHaveBeenCalled();
  });
});

describe('PhysicsScriptPlayer — per-part tween hooks (LuminousPart / DiffusePart / TransparentPart)', () => {
  it('LuminousPart interpolates the emissive grey only on the named part subtree', async () => {
    const { MeshLambertMaterial, Mesh, BufferGeometry } = await import('three');
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    // Part 0 — should NOT be affected
    const mat0 = new MeshLambertMaterial();
    const part0 = new Object3D();
    part0.name = 'part_0';
    part0.add(new Mesh(new BufferGeometry(), mat0));
    anchor.add(part0);
    // Part 2 — target of the LuminousPart hook
    const mat2 = new MeshLambertMaterial();
    const part2 = new Object3D();
    part2.name = 'part_2';
    part2.add(new Mesh(new BufferGeometry(), mat2));
    anchor.add(part2);

    const script = makeScript(0x33000095, [
      { t: 0, hook: { hookType: AnimationHookType.LuminousPart, direction: 0, part: 2, start: 0, end: 2.0, time: 1.0 } },
    ]);
    player.play(script, anchor);
    expect(mat0.emissive.r).toBeCloseTo(0);
    expect(mat2.emissive.r).toBeCloseTo(0);
    player.update(0.5);
    expect(mat0.emissive.r).toBeCloseTo(0); // unaffected
    expect(mat2.emissive.r).toBeCloseTo(1.0, 1);
    player.update(0.5);
    expect(mat2.emissive.r).toBeCloseTo(2.0, 4);
  });

  it('DiffusePart scales color on the named part subtree only', async () => {
    const { MeshBasicMaterial, Mesh, BufferGeometry } = await import('three');
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const mat0 = new MeshBasicMaterial({ color: 0xffffff });
    const part0 = new Object3D();
    part0.name = 'part_0';
    part0.add(new Mesh(new BufferGeometry(), mat0));
    anchor.add(part0);
    const mat1 = new MeshBasicMaterial({ color: 0xffffff });
    const part1 = new Object3D();
    part1.name = 'part_1';
    part1.add(new Mesh(new BufferGeometry(), mat1));
    anchor.add(part1);

    const script = makeScript(0x33000096, [
      { t: 0, hook: { hookType: AnimationHookType.DiffusePart, direction: 0, part: 1, start: 1.0, end: 0.5, time: 1.0 } },
    ]);
    player.play(script, anchor);
    expect(mat0.color.r).toBeCloseTo(1.0);
    expect(mat1.color.r).toBeCloseTo(1.0);
    player.update(1.0);
    expect(mat0.color.r).toBeCloseTo(1.0); // unaffected
    expect(mat1.color.r).toBeCloseTo(0.5, 4);
  });

  it('TransparentPart tweens translucency on the named part subtree only', async () => {
    const { MeshBasicMaterial, Mesh, BufferGeometry } = await import('three');
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const mat0 = new MeshBasicMaterial();
    const part0 = new Object3D();
    part0.name = 'part_5';
    part0.add(new Mesh(new BufferGeometry(), mat0));
    anchor.add(part0);
    const matOther = new MeshBasicMaterial();
    const otherPart = new Object3D();
    otherPart.name = 'part_0';
    otherPart.add(new Mesh(new BufferGeometry(), matOther));
    anchor.add(otherPart);

    const script = makeScript(0x33000097, [
      { t: 0, hook: { hookType: AnimationHookType.TransparentPart, direction: 0, part: 5, start: 1.0, end: 0.0, time: 1.0 } },
    ]);
    player.play(script, anchor);
    // Translucency 1 → 0: the named part fades in from invisible; others untouched.
    expect(part0.children[0].visible).toBe(false);
    expect(mat0.visible).toBe(true);
    expect(otherPart.children[0].visible).toBe(true);
    expect(matOther.opacity).toBeCloseTo(1.0);
    player.update(0.5);
    expect(part0.children[0].visible).toBe(true);
    expect(mat0.opacity).toBeCloseTo(0.5, 4);
    player.update(0.5);
    expect(mat0.opacity).toBeCloseTo(1.0, 4);
    expect(matOther.opacity).toBeCloseTo(1.0);
  });
});

describe('PhysicsScriptPlayer — DefaultScript / DefaultScriptPart', () => {
  it('DefaultScript plays the object\'s play_default_script (resolveDefaultScript: PhysicsDesc script via its table)', () => {
    const deps = makeFakeDeps();
    const nestedSound = vi.fn().mockResolvedValue(undefined);
    deps.resolveDefaultScript = vi.fn(() => makeScript(0x33000abc, [
      { t: 0, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0A000123 } },
    ]));
    const player = new PhysicsScriptPlayer({
      ...deps,
      soundPlayer: { playPositionalSound: nestedSound } as never,
    });
    const anchor = new Object3D();
    anchor.userData.setupId = 0x02000081;
    const script = makeScript(0x33000200, [
      { t: 0, hook: { hookType: AnimationHookType.DefaultScript, direction: 0 } },
    ]);
    player.play(script, anchor);
    expect(deps.resolveDefaultScript).toHaveBeenCalledWith(anchor);
    expect(nestedSound).toHaveBeenCalled();
  });

  it('DefaultScript no-ops when the object has no default script', () => {
    const deps = makeFakeDeps();
    deps.resolveDefaultScript = vi.fn(() => null);
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const script = makeScript(0x33000201, [
      { t: 0, hook: { hookType: AnimationHookType.DefaultScript, direction: 0 } },
    ]);
    expect(() => player.play(script, anchor)).not.toThrow();
  });
});

describe('PhysicsScriptPlayer — SetLight (SetLightHook::Execute → CPhysicsObj::set_lights)', () => {
  // BUG.setlight-hook-emissive-only — the hook switches the OBJECT's lights
  // (LightingOn + InitLights / DestroyLights), never its materials.
  it('SetLight lightsOn=1 asks the object to build its lights and leaves emissive alone', async () => {
    const { MeshStandardMaterial, Mesh, BufferGeometry } = await import('three');
    const setLights = vi.fn();
    const player = new PhysicsScriptPlayer({ ...makeFakeDeps(), setLights });
    const anchor = new Object3D();
    const mat = new MeshStandardMaterial({ emissive: 0xff8000 });
    mat.emissiveIntensity = 0;
    anchor.add(new Mesh(new BufferGeometry(), mat));
    const script = makeScript(0x33000500, [
      { t: 0, hook: { hookType: AnimationHookType.SetLight, direction: 0, lightsOn: 1 } },
    ]);
    player.play(script, anchor);
    expect(anchor.userData.lit).toBe(true);
    expect(setLights).toHaveBeenCalledWith(anchor, true);
    expect(mat.emissiveIntensity).toBe(0);
  });

  it('SetLight lightsOn=0 asks the object to destroy its lights', async () => {
    const { MeshStandardMaterial, Mesh, BufferGeometry } = await import('three');
    const setLights = vi.fn();
    const player = new PhysicsScriptPlayer({ ...makeFakeDeps(), setLights });
    const anchor = new Object3D();
    const mat = new MeshStandardMaterial({ emissive: 0xff8000 });
    mat.emissiveIntensity = 1.0;
    anchor.add(new Mesh(new BufferGeometry(), mat));
    const script = makeScript(0x33000501, [
      { t: 0, hook: { hookType: AnimationHookType.SetLight, direction: 0, lightsOn: 0 } },
    ]);
    player.play(script, anchor);
    expect(anchor.userData.lit).toBe(false);
    expect(setLights).toHaveBeenCalledWith(anchor, false);
    expect(mat.emissiveIntensity).toBe(1.0);
  });
});

describe('PhysicsScriptPlayer — continuous effects (SetOmega rotation + TextureVelocity scroll)', () => {
  it('SetOmega rotates the anchor over time on update(dt)', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    // omega.z = π/2 rad/sec around AC Z (= our Y) → 90° per second.
    const script = makeScript(0x33000400, [
      { t: 0, hook: { hookType: AnimationHookType.SetOmega, direction: 0, axis: { x: 0, y: 0, z: Math.PI / 2 } } },
    ]);
    const startQuatY = anchor.quaternion.y;
    player.play(script, anchor);
    expect(startQuatY).toBe(0);
    // Tick 1 second — anchor should have rotated ~90°.
    player.update(1.0);
    // sin(π/4) for half-angle → quat.y ≈ 0.707
    expect(Math.abs(anchor.quaternion.y)).toBeGreaterThan(0.5);
  });

  it('SetOmega with zero axis stops an existing rotation', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    player.play(makeScript(0x33000401, [
      { t: 0, hook: { hookType: AnimationHookType.SetOmega, direction: 0, axis: { x: 0, y: 0, z: 1 } } },
    ]), anchor);
    player.update(0.5);
    const snapY = anchor.quaternion.y;
    expect(snapY).not.toBe(0);
    // Now stop with zero axis.
    player.play(makeScript(0x33000402, [
      { t: 0, hook: { hookType: AnimationHookType.SetOmega, direction: 0, axis: { x: 0, y: 0, z: 0 } } },
    ]), anchor);
    player.update(0.5);
    // After stopping, the quaternion should be unchanged (no further rotation).
    expect(anchor.quaternion.y).toBeCloseTo(snapY, 4);
  });

  it('TextureVelocity scrolls the part\'s own copy of its map (the shared texture never moves)', async () => {
    const { MeshBasicMaterial, Mesh, BufferGeometry, DataTexture } = await import('three');
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const tex = new DataTexture(new Uint8Array(4), 1, 1);
    const mat = new MeshBasicMaterial({ map: tex });
    const mesh = new Mesh(new BufferGeometry(), mat);
    anchor.add(mesh);
    const script = makeScript(0x33000410, [
      { t: 0, hook: { hookType: AnimationHookType.TextureVelocity, direction: 0, uSpeed: 1.0, vSpeed: 0.5 } },
    ]);
    player.play(script, anchor);
    player.update(0.5);
    const own = (mesh.material as InstanceType<typeof MeshBasicMaterial>).map!;
    expect(own).not.toBe(tex);
    expect(own.image).toBe(tex.image);
    expect(tex.offset.x).toBe(0);
    expect(own.offset.x).toBeCloseTo(0.5, 4);
    expect(own.offset.y).toBeCloseTo(0.25, 4);
    player.update(0.5);
    expect(own.offset.x).toBeCloseTo(1.0, 4);
    expect(own.offset.y).toBeCloseTo(0.5, 4);
    // UpdateTexVelocity @ 00509820: an offset that has reached 1 wraps back by 1.
    player.update(0.5);
    expect(own.offset.x).toBeCloseTo(0.5, 4);
  });

  it('stopForAnchor clears continuous omega + texture-velocity', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    player.play(makeScript(0x33000420, [
      { t: 0, hook: { hookType: AnimationHookType.SetOmega, direction: 0, axis: { x: 0, y: 0, z: 1 } } },
      { t: 0, hook: { hookType: AnimationHookType.TextureVelocity, direction: 0, uSpeed: 1.0, vSpeed: 0.0 } },
    ]), anchor);
    player.update(0.5);
    const beforeY = anchor.quaternion.y;
    player.stopForAnchor(anchor);
    player.update(1.0);
    // After stopForAnchor, no further rotation
    expect(anchor.quaternion.y).toBeCloseTo(beforeY, 4);
  });
});

describe('PhysicsScriptPlayer — TextureVelocity / TextureVelocityPart', () => {
  it('TextureVelocity sets every part\'s GfxObj velocity', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const part = new Object3D();
    part.name = 'part_0';
    part.userData.gfxObjId = 0x01000aaa;
    anchor.add(part);
    const script = makeScript(0x33000300, [
      { t: 0, hook: { hookType: AnimationHookType.TextureVelocity, direction: 0, uSpeed: 0.5, vSpeed: 0.0 } },
    ]);
    player.play(script, anchor);
    expect(player.gfxVelocityOf(part)).toMatchObject({ u: 0.5, v: 0 });
  });

  it('TextureVelocityPart sets only that direct part\'s GfxObj', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const part = new Object3D();
    part.name = 'part_2';
    part.userData.gfxObjId = 0x01000bbb;
    const other = new Object3D();
    other.name = 'part_0';
    other.userData.gfxObjId = 0x01000ccc;
    anchor.add(part, other);
    const script = makeScript(0x33000301, [
      { t: 0, hook: { hookType: AnimationHookType.TextureVelocityPart, direction: 0, partIndex: 2, uSpeed: 1.0, vSpeed: 0.5 } },
    ]);
    player.play(script, anchor);
    expect(player.gfxVelocityOf(part)).toMatchObject({ u: 1.0, v: 0.5 });
    expect(player.gfxVelocityOf(other)).toBeNull();
  });
});

describe('PhysicsScriptPlayer — DestroyParticle / StopParticle address the emitter by hook id', () => {
  /** Deps whose spawnParticleEffect hands back a stoppable fake system. */
  function depsWithSystems() {
    const deps = makeFakeDeps();
    const systems: Array<{ stop: ReturnType<typeof vi.fn>; object3D: Object3D }> = [];
    deps.spawnParticleEffect.mockImplementation(() => {
      const sys = { stop: vi.fn(), object3D: new Object3D() };
      systems.push(sys);
      return sys;
    });
    const removeParticleSystem = vi.fn();
    (deps.spellEffects as unknown as { removeParticleSystem: typeof removeParticleSystem }).removeParticleSystem = removeParticleSystem;
    return { deps, systems, removeParticleSystem };
  }
  const create = (emitterId: number) => ({
    hookType: AnimationHookType.CreateParticle, direction: 0, emitterInfoId: 0x32000109, partIndex: 0xFFFFFFFF,
    offset: { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }, emitterId,
  });

  it('StopParticle stops only the emitter holding that id (StopParticleEmitter @ 0051b7b0)', () => {
    const { deps, systems } = depsWithSystems();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    player.executeHook(create(19) as never, anchor);
    player.executeHook(create(20) as never, anchor);
    player.executeHook({ hookType: AnimationHookType.StopParticle, direction: 0, emitterId: 19 } as never, anchor);
    expect(systems[0].stop).toHaveBeenCalledTimes(1);
    expect(systems[1].stop).not.toHaveBeenCalled();
    // An unknown id is a no-op.
    player.executeHook({ hookType: AnimationHookType.StopParticle, direction: 0, emitterId: 99 } as never, anchor);
  });

  it('DestroyParticle removes the emitter and its particles at once (DestroyParticleEmitter @ 0051b770)', () => {
    const { deps, systems, removeParticleSystem } = depsWithSystems();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    player.executeHook(create(7) as never, anchor);
    player.executeHook({ hookType: AnimationHookType.DestroyParticle, direction: 0, emitterId: 7 } as never, anchor);
    expect(removeParticleSystem).toHaveBeenCalledWith(systems[0]);
    expect(player.emittersFor(anchor).size).toBe(0);
  });

  it('a CreateParticle reusing a live id replaces that emitter (CreateParticleEmitter @ 0051b6c0)', () => {
    const { deps, systems, removeParticleSystem } = depsWithSystems();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    player.executeHook(create(1) as never, anchor);
    player.executeHook(create(1) as never, anchor);
    expect(removeParticleSystem).toHaveBeenCalledWith(systems[0]);
    expect(player.emittersFor(anchor).get(1)).toBe(systems[1]);
  });

  it('an emitter without a hardware GfxObj is never created (ParticleEmitter::SetInfo @ 0051ce90)', () => {
    const { deps } = depsWithSystems();
    deps.loadEmitterInfo.mockImplementation((id: number) => ({ id, hwGfxObjId: 0, gfxObjId: 0x01000001, lifespan: 1, lifespanRand: 0 }) as never);
    const player = new PhysicsScriptPlayer(deps);
    player.executeHook(create(3) as never, new Object3D());
    expect(deps.spawnParticleEffect).not.toHaveBeenCalled();
  });
});

describe('PhysicsScriptPlayer.play — empty / single-step scripts', () => {
  it('no-ops for scripts with zero steps', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    const anchor = new Object3D();
    const script = makeScript(0x33000040, []);
    player.play(script, anchor);
    expect(player.activeCount).toBe(0);
    expect(deps.playPositionalSound).not.toHaveBeenCalled();
  });

  it('uses the anchor world position (not local) for sound + particle dispatch', () => {
    const deps = makeFakeDeps();
    const player = new PhysicsScriptPlayer(deps);
    // Build a parent-child chain so anchor's worldPosition != localPosition.
    const parent = new Object3D();
    parent.position.set(100, 200, 300);
    const anchor = new Object3D();
    anchor.position.set(1, 2, 3);
    parent.add(anchor);
    // Crucial: invoke updateMatrixWorld so getWorldPosition returns the composed value.
    parent.updateMatrixWorld(true);
    expect(anchor.getWorldPosition(new Vector3())).toEqual(new Vector3(101, 202, 303));
    const script = makeScript(0x33000050, [
      { t: 0, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0A000050 } },
    ]);
    player.play(script, anchor);
    expect(deps.playPositionalSound.mock.calls[0][1]).toEqual({ x: 101, y: 202, z: 303 });
  });
});
