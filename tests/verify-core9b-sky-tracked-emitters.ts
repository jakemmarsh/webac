/**
 * CORE.9.b / VISUAL.night-sky-vs-retail.a — where sky-script particle
 * emitters live.
 *
 * Retail puts every sky physics object in GameSky's sky cells
 * (GameSky::MakeObject @ 00506ee0 → AddObjectToSingleCell(before/
 * after_sky_cell)). GameSky::UpdatePosition @ 00506dd0 gives the object the
 * VIEWER's cell id on every set_viewer but keeps its origin at (0, 0, 0) of
 * that landblock (interpolate_origin with t = 0; only weather objects,
 * props&0x4, take the viewer origin). Each particle is stamped with the cell
 * its object was in at emission (AddPartToShadowCells @ 00510e00) and drawn
 * there for life (calc_draw_frame @ 0050dfa0). So the always-on drifters
 * (Setup 0x2000714 → 0x32000455/56/57) sit at the landblock origin + 250 m,
 * and a particle born in one landblock stays there when the viewer leaves.
 * The CORE.9.b bug (drifters stuck at the pre-entry world origin) is the
 * same mechanism: they stay where they were born until they die and
 * re-emit around the viewer.
 *
 * Pins:
 *  1) SkyboxRenderer tags SETUP sky anchors skyTracked with their frame and
 *     sky pass; skyObjectFrame follows UpdatePosition.
 *  2) PhysicsScriptPlayer spawns skyTracked emitters as world-frame systems
 *     on the sky object's frame source (local frame + current landblock).
 *  3) SpellEffects still honours the parent arg for parented systems.
 *  4) End to end: particles stamp their birth landblock, the emitter
 *     follows the viewer's landblock, the sky pass draws before the world
 *     scaled about the viewer, and closing the window removes the system.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { SkyboxRenderer, skyObjectFrame } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { SpellEffects } from '../packages/renderer/src/effects/SpellEffects.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import type { PhysicsScript, ParticleEmitterInfo } from '@ac/dat-parser';

function makeScript(id: number, steps: Array<{ t: number; hook: object | null }>): PhysicsScript {
  return { id, steps: steps.map(s => ({ startTime: s.t, hook: s.hook as never })) } as never;
}

/** Endless emitter shaped like the sky drifters 0x32000455-57. */
function drifterEmitterInfo(id = 0x32000455): ParticleEmitterInfo {
  return {
    id, emitterType: 1, particleType: 9,
    gfxObjId: 0, hwGfxObjId: 0x01002061,
    birthrate: 0.5, maxParticles: 20, initialParticles: 0,
    totalParticles: 0, totalSeconds: 0,
    lifespan: 10, lifespanRand: 0,
    offsetDir: { x: 0, y: 0, z: 1 }, minOffset: 0, maxOffset: 0,
    a: { x: 0, y: 0, z: 0 }, minA: 0, maxA: 0,
    b: { x: 0, y: 0, z: 0 }, minB: 0, maxB: 0,
    c: { x: 0, y: 0, z: 0 }, minC: 0, maxC: 0,
    startScale: 1, finalScale: 1, scaleRand: 0,
    startTrans: 0, finalTrans: 0, transRand: 0,
    isParentLocal: 0, sortingSphereRadius: 1,
  } as never;
}

function createParticleHook(emitterInfoId: number, offsetZ = 250) {
  return {
    hookType: AnimationHookType.CreateParticle, direction: 0,
    emitterInfoId, partIndex: 0,
    offset: { origin: { x: 0, y: 0, z: offsetZ }, orientation: { w: 1, x: 0, y: 0, z: 0 } },
    emitterId: 0,
  };
}

function skyObjectSetup() {
  return {
    beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0,
    texVelocityX: 0, texVelocityY: 0,
    defaultGFXObjectId: 0x02000714, defaultPESObjectId: 0x330007db,
    properties: 0,
  };
}

function makeSkyDesc() {
  return {
    tickSize: 30, lightTickSize: 30,
    dayGroups: [{
      chanceOfOccur: 5, dayName: 'Sunny',
      skyObjects: [skyObjectSetup()],
      skyTime: [
        { begin: 0, dirBright: 1, dirHeading: 0, dirPitch: 45, dirColor: 0xffffffff, ambBright: 0.5, ambColor: 0xffffffff, minWorldFog: 0, maxWorldFog: 1000, worldFogColor: 0xffffffff, worldFog: 0, skyObjReplace: [] },
        { begin: 0.5, dirBright: 1, dirHeading: 0, dirPitch: 45, dirColor: 0xffffffff, ambBright: 0.5, ambColor: 0xffffffff, minWorldFog: 0, maxWorldFog: 1000, worldFogColor: 0xffffffff, worldFog: 0, skyObjReplace: [] },
      ],
    }],
  } as never;
}

const stubModelRenderer = () => ({ createMesh: () => new THREE.Group() }) as never;

describe('CORE.9.b: SETUP sky anchors are tagged skyTracked', () => {
  it('initSkyObjects marks every Setup slot anchor userData.skyTracked', () => {
    const sky = new SkyboxRenderer(makeSkyDesc());
    sky.initSkyObjects(stubModelRenderer());
    const group = sky.skyObjectsGroup!;
    const anchor = group.getObjectByName('sky_setup_0_0x02000714');
    expect(anchor).toBeTruthy();
    expect(anchor!.userData.skyTracked).toBe(true);
  });
});

describe('CORE.9.b: PhysicsScriptPlayer spawns skyTracked emitters on the sky object frame', () => {
  function makeDeps(info: ParticleEmitterInfo) {
    const spawnParticleEffect = vi.fn(() => ({}) as never);
    return {
      spawnParticleEffect,
      deps: {
        spellEffects: { spawnParticleEffect, removeParticleSystem: vi.fn() } as never,
        soundPlayer: { playPositionalSound: vi.fn().mockResolvedValue(undefined) } as never,
        loadEmitterInfo: vi.fn(() => info as never),
        getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
      },
    };
  }

  it('skyTracked anchor: a world-frame system on the sky object frame (local + landblock)', () => {
    const { deps, spawnParticleEffect } = makeDeps(drifterEmitterInfo());
    const player = new PhysicsScriptPlayer(deps as never);
    const parent = new THREE.Group();
    const anchor = new THREE.Object3D();
    parent.add(anchor);
    anchor.position.set(1000, 5, 2000); // the anchor's own transform must NOT leak in
    anchor.userData.skyTracked = true;
    anchor.userData.skyFrame = { local: new THREE.Vector3(0, 0, 0), cell: new THREE.Vector3(32448, 0, 34368) };
    player.play(makeScript(0x330007db, [{ t: 0, hook: createParticleHook(0x32000455, 250) }]), anchor);

    expect(spawnParticleEffect).toHaveBeenCalledTimes(1);
    const call = spawnParticleEffect.mock.calls[0] as unknown[];
    expect(call[4]).toBeUndefined(); // not parented: world-frame
    const src = (call[5] as { frameSource: import('../packages/renderer/src/effects/ParticleSystem.js').ParticleFrameSource }).frameSource;
    expect(src.offset).toEqual({ x: 0, y: 0, z: 250 }); // AC axes, the hook offset
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), cell = new THREE.Vector3();
    expect(src.getFrame(pos, quat)).toBe(true);
    expect(pos.toArray()).toEqual([0, 0, 0]);
    src.cellOrigin!(cell);
    expect(cell.toArray()).toEqual([32448, 0, 34368]);
    // The frame ends when the anchor leaves the sky group.
    parent.remove(anchor);
    expect(src.getFrame(pos, quat)).toBe(false);
  });

  it('untagged anchor keeps the world-position scene-root spawn (no parent)', () => {
    const { deps, spawnParticleEffect } = makeDeps(drifterEmitterInfo());
    const player = new PhysicsScriptPlayer(deps as never);
    const anchor = new THREE.Object3D();
    anchor.position.set(100, 50, 200);
    player.play(makeScript(0x330007db, [{ t: 0, hook: createParticleHook(0x32000455, 0.15) }]), anchor);

    const call = spawnParticleEffect.mock.calls[0] as unknown[];
    expect(call[1]).toEqual({ x: 100, y: 50.15, z: 200 });
    expect(call[4]).toBeUndefined();
  });
});

describe('CORE.9.b: SpellEffects parent-attached particle systems', () => {
  it('attaches under the given parent and the world position follows the parent', () => {
    const scene = new THREE.Scene();
    const effects = new SpellEffects(scene);
    const skyGroup = new THREE.Group();
    scene.add(skyGroup);
    const anchor = new THREE.Group();
    skyGroup.add(anchor);

    const system = effects.spawnParticleEffect(
      drifterEmitterInfo(), { x: 0, y: 250, z: 0 }, undefined, undefined, anchor,
    );
    const obj = system.object3D;
    expect(obj.parent).toBe(anchor);

    // The camera-follow mechanism: SkyboxRenderer copies the camera position
    // onto the sky group each frame — the emitter must ride along.
    skyGroup.position.set(32000, 40, 34000);
    const world = obj.getWorldPosition(new THREE.Vector3());
    expect(world.x).toBe(32000);
    expect(world.y).toBe(290);
    expect(world.z).toBe(34000);
  });

  it('removeParticleSystem detaches a parented system (not a scene.remove no-op)', () => {
    const scene = new THREE.Scene();
    const effects = new SpellEffects(scene);
    const anchor = new THREE.Group();
    scene.add(anchor);
    const system = effects.spawnParticleEffect(
      drifterEmitterInfo(), { x: 0, y: 250, z: 0 }, undefined, undefined, anchor,
    );
    expect(anchor.children).toHaveLength(1);
    effects.removeParticleSystem(system);
    expect(anchor.children).toHaveLength(0);
    expect(system.object3D.parent).toBeNull();
    expect(effects.activeCount).toBe(0);
  });

  it('without a parent the system still lands at the scene root (regression)', () => {
    const scene = new THREE.Scene();
    const effects = new SpellEffects(scene);
    const system = effects.spawnParticleEffect(
      drifterEmitterInfo(), { x: 5, y: 6, z: 7 },
    );
    expect(system.object3D.parent).toBe(scene);
    effects.removeParticleSystem(system);
    expect(system.object3D.parent).toBeNull();
  });
});

/** A drifter with deterministic geometry: Still, no random offset, 3 particles, 400 s. */
function stillDrifter(): ParticleEmitterInfo {
  return {
    ...(drifterEmitterInfo() as object), particleType: 1, isParentLocal: 1,
    birthrate: 10, maxParticles: 3, initialParticles: 3, lifespan: 400,
  } as never;
}

describe('skyObjectFrame (GameSky::UpdatePosition @ 00506dd0)', () => {
  const frame = () => ({ local: new THREE.Vector3(), cell: new THREE.Vector3() });
  it('a non-weather object takes the viewer landblock with origin (0, 0, 0)', () => {
    const f = skyObjectFrame(0, new THREE.Vector3(32532, 40, 34461), frame());
    expect(f.cell.toArray()).toEqual([32448, 0, 34368]);
    expect(f.local.toArray()).toEqual([0, 0, 0]);
  });
  it('a weather object (props&0x4) takes the viewer origin, z −120 unless props&0x8', () => {
    const v = new THREE.Vector3(32532, 40, 34461);
    expect(skyObjectFrame(0x4, v, frame()).local.toArray()).toEqual([84, -120, 93]);
    expect(skyObjectFrame(0xd, v, frame()).local.toArray()).toEqual([84, 40, 93]);
  });
});

describe('CORE.9.b / VISUAL.night-sky-vs-retail.a: end to end', () => {
  function world() {
    const scene = new THREE.Scene();
    const effects = new SpellEffects(scene);
    const player = new PhysicsScriptPlayer({
      spellEffects: effects,
      soundPlayer: { playPositionalSound: vi.fn().mockResolvedValue(undefined) } as never,
      loadEmitterInfo: () => stillDrifter() as never,
      getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    } as never);
    const sky = new SkyboxRenderer(makeSkyDesc());
    sky.initSkyObjects(stubModelRenderer());
    scene.add(sky.skyObjectsGroup!);
    const script = makeScript(0x330007db, [{ t: 0, hook: createParticleHook(0x32000455, 250) }]);
    return { scene, effects, player, sky, script };
  }

  it('particles sit at the viewer landblock origin + 250 m and keep their birth landblock', () => {
    const { effects, player, sky, script } = world();
    // The viewer is in Holtburg's landblock 0xA9B4 when the window opens.
    sky.updateSkyObjectPositions(new THREE.Vector3(32532, 94, 34461));
    sky.setSetupScriptEngine({
      start: (anchor) => player.play(script, anchor),
      stop: (anchor) => player.stopForAnchor(anchor),
    });
    const system = [...player.skyEmitters][0];
    expect(system).toBeTruthy();
    expect(system.isWorldSpace).toBe(true);
    expect(system.activeCount).toBe(3);
    // Not on the camera: (0, 0, 250) of landblock 0xA9B4 (three: y up).
    expect(system.positionAt(0).toArray()).toEqual([32448, 250, 34368]);

    // The viewer walks into the next landblock east: the live particles stay
    // in the landblock they were born in…
    sky.updateSkyObjectPositions(new THREE.Vector3(32700, 94, 34461));
    effects.update(1);
    expect(system.positionAt(0).toArray()).toEqual([32448, 250, 34368]);
    // …and once they die, the re-emitted ones are born in the new one.
    for (let t = 0; t < 420; t += 10) effects.update(10);
    expect(system.activeCount).toBeGreaterThan(0);
    for (let i = 0; i < system.activeCount; i++) {
      expect(system.positionAt(i).toArray()).toEqual([32640, 250, 34368]);
    }
  });

  it('draws in the sky pass: before the world, no depth test, scaled about the viewer', () => {
    const { player, sky, script } = world();
    sky.updateSkyObjectPositions(new THREE.Vector3(32532, 94, 34461));
    sky.setSetupScriptEngine({ start: (a) => player.play(script, a), stop: (a) => player.stopForAnchor(a) });
    const system = [...player.skyEmitters][0];
    expect(system.skyPassState).toEqual({ renderOrder: -50, afterWorld: false, viewScale: 0.25 });
    for (const mesh of system.meshes) {
      const mat = mesh.material as THREE.MeshLambertMaterial;
      expect(mesh.renderOrder).toBe(-50);
      expect(mat.depthTest).toBe(false);
      expect(mat.depthWrite).toBe(false);
      expect(mat.transparent).toBe(false); // opaque list → drawn before the world
      expect(mat.blending).toBe(THREE.CustomBlending);
    }
    // The draw node maps a world point p to viewer + (p − viewer) / 4.
    system.setView({ viewer: new THREE.Vector3(32532, 94, 34461) });
    const node = system.drawNode;
    node.updateMatrixWorld(true);
    const p = new THREE.Vector3(32448, 250, 34368).applyMatrix4(node.matrixWorld);
    expect(p.x).toBeCloseTo(32532 + (32448 - 32532) / 4, 6);
    expect(p.y).toBeCloseTo(94 + (250 - 94) / 4, 6);
    expect(p.z).toBeCloseTo(34461 + (34368 - 34461) / 4, 6);
  });

  it('closing the window removes the endless system', () => {
    const { scene, effects, player, sky, script } = world();
    sky.setSetupScriptEngine({ start: (a) => player.play(script, a), stop: (a) => player.stopForAnchor(a) });
    expect(scene.getObjectByName('particles_32000455')).toBeTruthy();
    sky.setSetupScriptEngine(null);
    expect(scene.getObjectByName('particles_32000455')).toBeUndefined();
    expect(effects.activeCount).toBe(0);
  });
});
