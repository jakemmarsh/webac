/**
 * REND.appearance-rebuild-orphans-emitters — an ObjDescEvent rebuild swaps
 * obj.mesh. Retail keeps the same CPhysicsObj (CPhysicsObj::DoObjDescChanges
 * @ 0050fa30 only swaps the part array's parts and re-applies translucency),
 * so running scripts / endless emitters / spin / pending CallPES follow the
 * object to its new mesh (PhysicsScriptPlayer.transferAnchor); a failed
 * rebuild stops them and says so on the console (rate-limited, never chat).
 * Drives the real ServerObjectManager + PhysicsScriptPlayer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { ServerObjectManager, TRANSLUCENCY_KEY } from '../packages/renderer/src/world/ServerObjectManager.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    guid: 0x50000001, name: 'Lich', weenieClassId: 1, itemType: 0, position: null, setupId: 0x02000abc,
    motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
    wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
    maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
    velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0,
    defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
const descEvent = (seq: number) => ({
  guid: 0x50000001, basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], visualDescSequence: seq,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any);

function makeSom(build: () => THREE.Group) {
  const setupModelRenderer = { createSetupMeshWithOverrides: build, loadSetupModel: () => null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ServerObjectManager(setupModelRenderer as any, { loadPaletteColors: () => null } as any, new THREE.Scene());
}

function makePlayer() {
  const removed: unknown[] = [];
  const player = new PhysicsScriptPlayer({
    spellEffects: {
      spawnParticleEffect: () => ({ id: Math.random() }),
      removeParticleSystem: (s: unknown) => removed.push(s),
    },
    soundPlayer: { playPositionalSound: () => Promise.resolve() },
    loadEmitterInfo: () => ({ totalSeconds: 0, totalParticles: 0, lifespan: 1, lifespanRand: 0 }),
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  return { player, removed };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('ServerObjectManager.updateAppearance → onMeshReplaced', () => {
  it('hands the old + new mesh to the owner, and re-applies the object\'s translucency to the new parts', () => {
    const som = makeSom(() => new THREE.Group().add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial())));
    const obj = som.createObject(baseData({ translucency: 0.4 }))!;
    const old = obj.mesh!;
    expect(old.userData[TRANSLUCENCY_KEY]).toBe(0.4);
    const calls: [THREE.Object3D | null, THREE.Object3D][] = [];
    som.onMeshReplaced = (o, prev) => calls.push([o.mesh, prev]);
    som.updateAppearance(descEvent(1));
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(old);
    expect(calls[0][0]).toBe(obj.mesh);
    expect(obj.mesh).not.toBe(old);
    const mat = (obj.mesh!.children[0] as THREE.Mesh).material as THREE.Material;
    expect(mat.opacity).toBeCloseTo(0.6, 6);
  });

  it('a failed rebuild leaves no mesh, warns on the console with guid + setup id, and still notifies the owner', () => {
    let n = 0;
    const som = makeSom(() => { if (n++ > 0) throw new Error('bad part'); return new THREE.Group(); });
    const obj = som.createObject(baseData())!;
    const old = obj.mesh!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: (THREE.Object3D | null)[] = [];
    som.onMeshReplaced = (o, prev) => { seen.push(o.mesh); expect(prev).toBe(old); };
    som.updateAppearance(descEvent(1));
    expect(obj.mesh).toBeNull();
    expect(seen).toEqual([null]);
    expect(warn).toHaveBeenCalled();
    const line = String(warn.mock.calls[warn.mock.calls.length - 1][0]);
    expect(line).toContain('0x50000001');
    expect(line).toContain('0x2000abc');
    expect(line).toContain('bad part');
  });
});

describe('PhysicsScriptPlayer.transferAnchor', () => {
  it('moves running scripts, spin, UV scroll, the object\'s emitters and pending CallPES to the new mesh', () => {
    const sounds: THREE.Vector3[] = [];
    const removed: unknown[] = [];
    const system = { object3D: new THREE.Object3D(), isDone: false, isDisposed: false, stop() {}, rebindParent() {} };
    const nested = { id: 0x33000001, steps: [{ startTime: 0, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0a000002 } }] };
    const player = new PhysicsScriptPlayer({
      spellEffects: { spawnParticleEffect: () => system, removeParticleSystem: (s: unknown) => removed.push(s) },
      soundPlayer: { playPositionalSound: (_id: number, pos: THREE.Vector3) => { sounds.push(new THREE.Vector3(pos.x, pos.y, pos.z)); return Promise.resolve(); } },
      loadEmitterInfo: () => ({ hwGfxObjId: 0x01000001, totalSeconds: 0, totalParticles: 0, lifespan: 1, lifespanRand: 0 }),
      getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
      loadScript: () => nested,
      rollDice: (_min: number, max: number) => max,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const oldMesh = new THREE.Group();
    const part = new THREE.Group(); part.name = 'part_1'; part.userData.gfxObjId = 0x01000555; oldMesh.add(part);
    const newMesh = new THREE.Group(); newMesh.position.set(50, 0, 0); newMesh.updateMatrixWorld(true);
    const newPart = new THREE.Group(); newPart.name = 'part_1'; newPart.userData.gfxObjId = 0x01000555; newMesh.add(newPart);
    oldMesh.userData.setupId = 0x02000abc;
    // A script with a pending step at 2 s, spin, UV scroll on a part, an
    // endless emitter, and a CallPES waiting 1 s.
    player.play({
      id: 0x33000100,
      steps: [
        { startTime: 0, hook: { hookType: AnimationHookType.SetOmega, direction: 0, axis: { x: 0, y: 0, z: 1 } } },
        { startTime: 0, hook: { hookType: AnimationHookType.TextureVelocityPart, direction: 0, partIndex: 1, uSpeed: 1, vSpeed: 0 } },
        { startTime: 0, hook: { hookType: AnimationHookType.CreateParticle, direction: 0, emitterInfoId: 0x32000001, partIndex: 0xFFFFFFFF, offset: { origin: { x: 0, y: 0, z: 0 } }, emitterId: 3 } },
        { startTime: 0, hook: { hookType: AnimationHookType.CallPES, direction: 0, pes: 0x33000001, pause: 1 } },
        { startTime: 2, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0a000001 } },
      ],
    } as never, oldMesh);

    player.transferAnchor(oldMesh, newMesh);

    expect(newMesh.userData.setupId).toBe(0x02000abc);
    expect(player.queuedScripts(newMesh)).toHaveLength(1);
    expect(player.queuedScripts(oldMesh)).toHaveLength(0);
    expect(player.emittersFor(newMesh).get(3)).toBe(system);
    expect(player.gfxVelocityOf(newPart)).toMatchObject({ u: 1 });
    player.update(1.0);
    // The CallPES fired at 1 s and queued its script behind the running one
    // (ScriptManager FIFO); the spin carried over.
    expect(player.queuedScripts(newMesh)).toHaveLength(2);
    expect(sounds).toHaveLength(0);
    expect(Math.abs(newMesh.quaternion.y)).toBeGreaterThan(0.1);
    expect(oldMesh.quaternion.y).toBe(0);
    player.update(1.0);
    // At 2 s the script's own step, then the CallPES'd script, at the NEW mesh.
    expect(sounds).toHaveLength(2);
    expect(sounds.every((p) => p.x === 50)).toBe(true);
    // The object despawning later stops the transferred emitter.
    player.stopForAnchor(newMesh);
    expect(removed).toContain(system);
  });
});
