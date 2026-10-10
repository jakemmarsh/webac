/**
 * Streamed-DAT regressions Jake hit on playwebac.com right after streaming
 * went live (2026-10-06):
 *  - the login / logout "purple bubbles" and other players' buff effects drew
 *    as white squares: an emitter created while its HW GfxObj / textures were
 *    still streaming got the untextured fallback quad. Now the emitter waits
 *    for its files (PhysicsScriptPlayer `emitterPending`) and is created on
 *    arrival, ~1 RTT late, never white.
 *  - a panel label drew in the wrong font: a Font whose glyph surface had not
 *    landed was cached without its spritesheet. Fonts are now layout art (the
 *    UI prefetch walks Font → glyph + halo surfaces).
 */
import { describe, it, expect, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { PhysicsScriptPlayer } from '@ac/renderer/effects/PhysicsScriptPlayer.js';
import { AnimationHookType } from '@ac/dat-parser';
import type { PhysicsScript, ParticleEmitterInfo } from '@ac/dat-parser';

function makeScript(id: number, steps: Array<{ t: number; hook: object | null }>): PhysicsScript {
  return { id, steps: steps.map((s) => ({ startTime: s.t, hook: s.hook as never })) } as never;
}
const EMITTER: Partial<ParticleEmitterInfo> = {
  id: 0x3200028C, emitterType: 1, particleType: 9, gfxObjId: 0, hwGfxObjId: 0x0100162D,
  birthrate: 0.1, maxParticles: 8, initialParticles: 4, totalParticles: 8, totalSeconds: 1, lifespan: 1, lifespanRand: 0,
};
const hook = {
  hookType: AnimationHookType.CreateParticle, direction: 0, emitterInfoId: 0x3200028C, partIndex: 0xffffffff,
  offset: { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }, emitterId: 0,
};

function setup(pending: () => Promise<void> | null) {
  const spawned: unknown[] = [];
  const deps = {
    spellEffects: {
      spawnParticleEffect: vi.fn((info: unknown, _pos: unknown, _c: unknown, sprite: unknown) => { spawned.push(sprite); return { info } as never; }),
      removeParticleSystem: vi.fn(),
    } as never,
    soundPlayer: { playPositionalSound: vi.fn().mockResolvedValue(undefined) } as never,
    loadEmitterInfo: () => EMITTER as never,
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    resolveEmitterSprite: vi.fn(() => ({ map: { isTexture: true }, additive: true, sizeScale: 1 }) as never),
    emitterPending: vi.fn((_id: number) => pending()),
  };
  const player = new PhysicsScriptPlayer(deps as never);
  const scene = new Scene();
  const anchor = new Object3D();
  scene.add(anchor);
  return { deps, player, anchor, spawned, scene };
}

describe('a streamed emitter waits for its files instead of drawing white (2026-10-06)', () => {
  it('files resident: created at once with its sprite', () => {
    const { player, anchor, spawned, deps } = setup(() => null);
    player.play(makeScript(0x33000331, [{ t: 0, hook }]), anchor);
    expect(spawned).toHaveLength(1);
    expect(deps.emitterPending).toHaveBeenCalledWith(0x3200028C);
  });

  it('files streaming: nothing drawn now; created with its sprite once they land', async () => {
    let land!: () => void;
    const arrival = new Promise<void>((r) => { land = r; });
    const { player, anchor, spawned, deps } = setup(() => arrival);
    player.play(makeScript(0x33000331, [{ t: 0, hook }]), anchor);
    expect(spawned).toHaveLength(0);
    land();
    await arrival; await Promise.resolve();
    expect(spawned).toHaveLength(1);
    expect(deps.resolveEmitterSprite).toHaveBeenCalledTimes(1);
    // The retry does not ask again (a fetch that still misses cannot loop).
    expect(deps.emitterPending).toHaveBeenCalledTimes(1);
  });

  it('the object left before the files landed: no emitter', async () => {
    let land!: () => void;
    const arrival = new Promise<void>((r) => { land = r; });
    const { player, anchor, spawned, scene } = setup(() => arrival);
    player.play(makeScript(0x33000331, [{ t: 0, hook }]), anchor);
    scene.remove(anchor);
    land();
    await arrival; await Promise.resolve();
    expect(spawned).toHaveLength(0);
  });

  it('a failed fetch skips the effect', async () => {
    const failed = Promise.reject(new Error('net'));
    failed.catch(() => {});
    const { player, anchor, spawned } = setup(() => failed);
    player.play(makeScript(0x33000331, [{ t: 0, hook }]), anchor);
    await Promise.resolve(); await Promise.resolve();
    expect(spawned).toHaveLength(0);
  });
});

describe('ParticleSystem counts white-fallback systems for the streaming A/B gate', () => {
  it('a system with no sprite (untextured fallback quad) counts; a textured one does not', async () => {
    const { ParticleSystem, particleStats } = await import('@ac/renderer/effects/ParticleSystem.js');
    const { Texture } = await import('three');
    const before = particleStats.whiteFallback;
    const info = { ...EMITTER, initialParticles: 0 };
    new ParticleSystem(info as never, 0xffffff, undefined);
    expect(particleStats.whiteFallback).toBe(before + 1);
    new ParticleSystem(info as never, 0xffffff, { map: new Texture(), additive: true, sizeScale: 1 } as never);
    expect(particleStats.whiteFallback).toBe(before + 1);
    expect((globalThis as { __acParticleStats?: unknown }).__acParticleStats).toBe(particleStats);
  });
});
