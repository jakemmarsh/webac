/**
 * STREAM.rebuild-kills-part-emitters — on playwebac.com (DAT streaming) the
 * Training Academy portal outside Holtburg West Outpost had no swirl: its
 * Setup 0x020001B3 plays 0x3300067A at creation, whose CreateParticle hook
 * starts the endless emitter 0x320002CD on part 0. With streaming the portal's
 * GfxObj 0x0100168B arrives after the first build, ServerObjectManager.
 * rebuildMesh swaps the mesh, and transferAnchor moved the emitter to the new
 * mesh but left its frame source on the OLD part_0 — out of the scene, so the
 * emitter read its parent as gone and stopped (done + disposed, 0 particles).
 * Whole-DAT loads build once and never showed it.
 *
 * Retail keeps the CPhysicsObj across an ObjDesc change (DoObjDescChanges
 * @ 0050fa30 swaps only the part array's parts), so the emitter follows its
 * part on the new parts. Drives the real ServerObjectManager rebuild path,
 * PhysicsScriptPlayer and ParticleSystem.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { PhysicsScriptPlayer, makeEmitterFrameSource } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { ParticleSystem, type ParticleFrameSource } from '../packages/renderer/src/effects/ParticleSystem.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import type { ParticleEmitterInfo } from '../packages/dat-parser/src/file-types/ParticleEmitterInfo.js';

/** 0x320002CD's shape: endless (no total time / count), 1 particle per 1/6 s, 2 s lifespan. */
const PORTAL_SWIRL = {
  id: 0x320002cd, emitterType: 1, particleType: 9, gfxObjId: 0, hwGfxObjId: 0x010016c8,
  birthrate: 1 / 6, maxParticles: 12, initialParticles: 0, totalParticles: 0, totalSeconds: 0,
  lifespan: 2, lifespanRand: 0, offsetDir: { x: 0, y: -1, z: 0 }, minOffset: 0.1, maxOffset: 0.1,
  a: { x: 0, y: 0.2, z: 0 }, minA: 1, maxA: 1, b: { x: 0, y: 0, z: 0 }, minB: 1, maxB: 1,
  c: { x: 0, y: -0.5, z: 0 }, minC: 1, maxC: 1, startScale: 5, finalScale: 0.1, scaleRand: 0,
  startTrans: 1, finalTrans: 0.4, transRand: 0, isParentLocal: 0,
} as unknown as ParticleEmitterInfo;

const CREATION_SCRIPT = {
  id: 0x3300067a,
  steps: [{ startTime: 0, hook: { hookType: AnimationHookType.CreateParticle, direction: 0, emitterInfoId: 0x320002cd, partIndex: 0, offset: { origin: { x: 0, y: 0, z: 0.15 } }, emitterId: 0 } }],
};

/** A one-part portal mesh with its part 0 at `x` metres along THREE x. */
function portalMesh(x: number): THREE.Group {
  const g = new THREE.Group();
  const part = new THREE.Group(); part.name = 'part_0'; part.position.set(x, 0, 0);
  part.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial()));
  g.add(part);
  return g;
}

function portalData() {
  return {
    guid: 0x7a5b400b, name: 'Holtburg West Training Academy Portal', weenieClassId: 4618, itemType: 0x10000, position: null,
    setupId: 0x020001b3, motionTableId: 0, iconId: 0, physicsState: 0x0c0c, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0, wielderId: 0,
    currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
    uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0,
    defaultScript: 0, defaultScriptIntensity: 0, iconOverlayId: 0, iconUnderlayId: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('a streamed GfxObj rebuild keeps the object\'s part emitters running', () => {
  it('the Training Academy portal swirl survives rebuildMesh and follows the new part_0', () => {
    const scene = new THREE.Scene();
    // First build: the GfxObj not resident yet (part at x=0); the rebuild has it (part at x=3).
    const builds = [portalMesh(0), portalMesh(3)];
    const som = new ServerObjectManager(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { createSetupMeshWithOverrides: () => builds.shift() ?? portalMesh(3), loadSetupModel: () => null } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { loadPaletteColors: () => null } as any, scene);
    const systems: ParticleSystem[] = [];
    const player = new PhysicsScriptPlayer({
      spellEffects: {
        spawnParticleEffect: (info: ParticleEmitterInfo, _pos: unknown, _c: unknown, _s: unknown, _l: unknown, opts: { frameSource?: ParticleFrameSource }) => {
          const sys = new ParticleSystem(info, 0xffffff, undefined, opts.frameSource);
          systems.push(sys);
          return sys;
        },
        removeParticleSystem: (s: ParticleSystem) => s.dispose(),
      },
      soundPlayer: { playPositionalSound: () => Promise.resolve() },
      loadEmitterInfo: () => PORTAL_SWIRL,
      getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    som.onMeshReplaced = (obj, oldMesh) => {
      if (obj.mesh) player.transferAnchor(oldMesh, obj.mesh);
      else player.stopForAnchor(oldMesh);
    };

    const obj = som.createObject(portalData())!;
    expect(obj.mesh!.parent).toBe(scene);
    player.play(CREATION_SCRIPT as never, obj.mesh!);
    expect(systems).toHaveLength(1);
    const swirl = systems[0];
    swirl.update(0.5);
    expect(swirl.activeCount).toBeGreaterThan(0);

    // The streamed GfxObj arrives: the mesh is rebuilt with real parts.
    const oldMesh = obj.mesh!;
    som.rebuildMesh(obj.guid);
    expect(obj.mesh).not.toBe(oldMesh);
    expect(oldMesh.parent).toBeNull();

    for (let i = 0; i < 30; i++) swirl.update(0.1);
    expect(swirl.isStopped).toBe(false);
    expect(swirl.isDone).toBe(false);
    expect(swirl.activeCount).toBeGreaterThan(0);
    // New particles are born on the rebuilt part_0 (x = 3), not the disposed one.
    const xs = [...Array(swirl.activeCount)].map((_, i) => swirl.positionAt(i).x);
    expect(Math.max(...xs)).toBeGreaterThan(2);
    swirl.dispose();
  });

  it('rebind re-resolves the hook\'s part on the new mesh, even when the first build fell back to the object root', () => {
    const scene = new THREE.Scene();
    const first = new THREE.Group(); // no part_2 yet → emitterParentNode fell back to the root
    scene.add(first);
    const src = makeEmitterFrameSource(first, { x: 0, y: 0, z: 0 }, 2);
    const sys = new ParticleSystem({ ...PORTAL_SWIRL, initialParticles: 1 } as ParticleEmitterInfo, 0xffffff, undefined, src);
    const rebuilt = new THREE.Group();
    const part2 = new THREE.Group(); part2.name = 'part_2'; part2.position.set(0, 0, 7); rebuilt.add(part2);
    scene.remove(first); scene.add(rebuilt);
    sys.rebindParent(first, rebuilt);
    sys.update(0.2);
    expect(sys.isStopped).toBe(false);
    const pos = new THREE.Vector3(); const quat = new THREE.Quaternion();
    expect(src.getFrame(pos, quat)).toBe(true);
    expect(pos.z).toBeCloseTo(7, 5);
    sys.dispose();
  });

  it('a parent that really despawned (no rebuild) still stops its emitter', () => {
    const scene = new THREE.Scene();
    const mesh = portalMesh(0); scene.add(mesh);
    const sys = new ParticleSystem(PORTAL_SWIRL, 0xffffff, undefined, makeEmitterFrameSource(mesh.children[0], { x: 0, y: 0, z: 0 }, 0));
    sys.update(0.5);
    scene.remove(mesh);
    sys.update(0.1);
    expect(sys.isStopped).toBe(true);
    sys.dispose();
  });
});
