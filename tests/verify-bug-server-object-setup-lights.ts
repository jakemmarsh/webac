/**
 * BUG.server-object-setup-lights — server objects' Setup LightInfo lights
 * (the Flame Bolt projectile setup 0x0200040D's white light, torches, glowing
 * items) were never created; only env-cell statics got DAT lights.
 *
 * Retail (decompiled acclient, reference/client-eol):
 *  - CPartArray::InitLights @ 00518c00 builds one LIGHTOBJ per Setup
 *    LightInfo; the owner's PhysicsState Static bit marks it static.
 *  - The lights exist while PhysicsState LightingOn (0x800) is set:
 *    CPhysicsObj::set_state @ 00514dd0 → InitLights / DestroyLights on the
 *    bit's edge (constructor default state 0x00400c08 includes 0x800).
 *  - Position = Frame::combine(object frame, LightInfo offset) — unscaled
 *    (Render::insert_light @ 0054d1b0); the list follows the object frame
 *    (LIGHTLIST::set_frame @ 00517c60).
 *  - Only lights in visible ENV cells feed Render::world_lights
 *    (CObjCell::add_dynamic_lights @ 0052ad80 walks
 *    CEnvCell::visible_cell_table), capped at max_dynamic_lights (7 at
 *    deg_mul 0), nearest to the player first.
 * Ours: a PointLight per LightInfo registered with DatLightBudget on
 * creation, the scene's point-light COUNT held constant (a filler gives up
 * its slot), so no lit program recompiles when the light appears.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { PhysicsState } from '@ac/shared';
import {
  initObjectLights, syncObjectLights, destroyObjectLights, objectLightsOf, releaseObjectLightsIn,
  stripClonedObjectLights, setObjectLightSink, hasLightingOn,
} from '../packages/renderer/src/effects/ObjectLights.js';
import { DatLightBudget, RETAIL_STARTUP_LIGHT_CAPS, inLandCell } from '../packages/renderer/src/effects/DatLightBudget.js';
import { RETAIL_LIGHT_RANGE_ADJUST, setCellLighting } from '../packages/renderer/src/models/RetailLighting.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import type { LightInfo } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
const hasDat = existsSync(PORTAL);

function light(over: Partial<LightInfo> = {}): LightInfo {
  return {
    viewerSpaceLocation: { origin: { x: 0.5, y: 1, z: 2 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },
    color: 0xffc89664, intensity: 3, falloff: 8, coneAngle: 0, ...over,
  } as LightInfo;
}

function visiblePointLights(root: THREE.Object3D): number {
  let n = 0;
  root.traverseVisible((o) => { if ((o as THREE.PointLight).isPointLight) n++; });
  return n;
}

afterEach(() => setObjectLightSink(null));

describe('ObjectLights — CPartArray::InitLights / DestroyLights', () => {
  it('builds one disabled PointLight per LightInfo: raw colour bytes, Range = falloff × 1.5, 1/d, unscaled offset', () => {
    const root = new THREE.Group();
    root.scale.setScalar(2); // ObjScale — the light offset must not scale
    const tracked: THREE.Object3D[] = [];
    const made = initObjectLights(root, [light()], false, { track: (l) => tracked.push(l), untrack: () => {} });
    expect(made).toHaveLength(1);
    const pl = made[0];
    expect(pl.visible).toBe(false); // the pool enables it
    expect(pl.parent).toBe(root);
    expect(tracked).toEqual([pl]);
    expect(pl.intensity).toBe(3);
    expect(pl.distance).toBeCloseTo(8 * RETAIL_LIGHT_RANGE_ADJUST, 6);
    expect(pl.decay).toBe(1); // hardware light
    expect(pl.color.r).toBeCloseTo(0xc8 / 255, 6);
    expect(pl.color.g).toBeCloseTo(0x96 / 255, 6);
    expect(pl.color.b).toBeCloseTo(0x64 / 255, 6);
    root.updateMatrixWorld(true);
    const wp = pl.getWorldPosition(new THREE.Vector3());
    // AC (0.5, 1, 2) → three (0.5, 2, 1), unscaled by the object's scale 2.
    expect(wp.x).toBeCloseTo(0.5, 6);
    expect(wp.y).toBeCloseTo(2, 6);
    expect(wp.z).toBeCloseTo(1, 6);
    expect(pl.userData.datLightDynamic).toBe(true);
  });

  it('a Static owner makes static lights (the −intensity class tag the env-cell shader reads)', () => {
    const [pl] = initObjectLights(new THREE.Group(), [light({ intensity: 2.5 })], true, null);
    expect(pl.decay).toBe(-2.5);
    expect(pl.userData.datLightDynamic).toBe(false);
  });

  it('exist exactly while PhysicsState has LightingOn (set_state edge), and are released from the pool', () => {
    const root = new THREE.Group();
    const lights = new Map([[0, light()], [1, light({ color: 0xffffffff })]]);
    const live = new Set<THREE.Object3D>();
    const sink = { track: (l: THREE.Object3D) => live.add(l), untrack: (l: THREE.Object3D) => live.delete(l) };
    syncObjectLights(root, lights, PhysicsState.Missile, sink);
    expect(objectLightsOf(root)).toHaveLength(0);
    syncObjectLights(root, lights, PhysicsState.Missile | PhysicsState.LightingOn, sink);
    expect(objectLightsOf(root)).toHaveLength(2);
    expect(live.size).toBe(2);
    const first = objectLightsOf(root)[0];
    // Idempotent: a repeat with the bit still on keeps the same lights.
    syncObjectLights(root, lights, PhysicsState.LightingOn | PhysicsState.Gravity, sink);
    expect(objectLightsOf(root)[0]).toBe(first);
    syncObjectLights(root, lights, PhysicsState.Gravity, sink);
    expect(objectLightsOf(root)).toHaveLength(0);
    expect(live.size).toBe(0);
    expect(root.children.filter((c) => (c as THREE.PointLight).isPointLight)).toHaveLength(0);
    expect(hasLightingOn(0x00400c08)).toBe(true); // CPhysicsObj ctor default state
  });

  it('releaseObjectLightsIn frees a subtree\'s lights (a wielded torch); a clone never carries them', () => {
    const wielder = new THREE.Group();
    const torch = new THREE.Group();
    wielder.add(torch);
    const live = new Set<THREE.Object3D>();
    const sink = { track: (l: THREE.Object3D) => live.add(l), untrack: (l: THREE.Object3D) => live.delete(l) };
    initObjectLights(torch, [light()], false, sink);
    const clone = wielder.clone(true);
    stripClonedObjectLights(clone);
    let clonedLights = 0;
    clone.traverse((o) => { if ((o as THREE.PointLight).isPointLight) clonedLights++; });
    expect(clonedLights).toBe(0);
    expect(objectLightsOf(torch)).toHaveLength(1); // the live torch keeps its light
    releaseObjectLightsIn(wielder, sink);
    expect(live.size).toBe(0);
    expect(objectLightsOf(torch)).toHaveLength(0);
    destroyObjectLights(torch, sink); // no-op on a light-less root
  });
});

describe('DatLightBudget — tracked object lights', () => {
  function sceneWithBudget() {
    const scene = new THREE.Scene();
    const budget = new DatLightBudget(scene, { fixedLightCount: true });
    return { scene, budget };
  }

  it('an object light joins the dynamic list on the next update (no 2 s gather wait) and the point-light count stays constant', () => {
    const { scene, budget } = sceneWithBudget();
    setObjectLightSink(budget);
    const origin = new THREE.Vector3(0, 0, 0);
    budget.update(origin, 0);
    const before = visiblePointLights(scene);
    expect(before).toBeGreaterThan(0); // caps + reserve worth of fillers
    // A Flame Bolt appears 10 ms later, inside an env cell.
    const bolt = new THREE.Group();
    bolt.position.set(3, 1, 0);
    scene.add(bolt);
    setCellLighting(bolt, true);
    const [pl] = initObjectLights(bolt, [light()], false);
    expect(pl.visible).toBe(false);
    budget.update(origin, 10);
    expect(pl.visible).toBe(true);
    expect(budget.census().dynamicActive).toBe(1);
    expect(visiblePointLights(scene)).toBe(before); // a filler gave up its slot
    // It leaves: the slot returns to a filler, the count is unchanged.
    releaseObjectLightsIn(bolt);
    scene.remove(bolt);
    budget.update(origin, 20);
    expect(budget.census().dynamicActive).toBe(0);
    expect(visiblePointLights(scene)).toBe(before);
  });

  it('an object standing in a LAND cell lights nothing (only env cells feed the lists)', () => {
    const { scene, budget } = sceneWithBudget();
    setObjectLightSink(budget);
    const torchBearer = new THREE.Group();
    scene.add(torchBearer);
    setCellLighting(torchBearer, false); // outdoor: landscape pass
    const [pl] = initObjectLights(torchBearer, [light()], false);
    expect(inLandCell(pl)).toBe(true);
    budget.update(new THREE.Vector3(), 0);
    expect(pl.visible).toBe(false);
    setCellLighting(torchBearer, true); // walks into a building / dungeon cell
    budget.update(new THREE.Vector3(), 10);
    expect(pl.visible).toBe(true);
  });

  it('keeps the nearest max_dynamic_lights (7) object lights to the player (Render::insert_light)', () => {
    const { scene, budget } = sceneWithBudget();
    setObjectLightSink(budget);
    const lights: THREE.PointLight[] = [];
    for (let i = 0; i < 10; i++) {
      const o = new THREE.Group();
      o.position.set(i * 2 + 1, 0, 0);
      scene.add(o);
      setCellLighting(o, true);
      lights.push(initObjectLights(o, [light({ viewerSpaceLocation: { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } } as never })], false)[0]);
    }
    scene.updateMatrixWorld(true);
    budget.update(new THREE.Vector3(0, 0, 0), 0);
    expect(RETAIL_STARTUP_LIGHT_CAPS.maxDynamicLights).toBe(7);
    expect(lights.map((l) => l.visible)).toEqual([true, true, true, true, true, true, true, false, false, false]);
  });

  it('adopts an object light built before the budget became the sink (gather)', () => {
    const { scene, budget } = sceneWithBudget();
    const o = new THREE.Group();
    scene.add(o);
    setCellLighting(o, true);
    const [pl] = initObjectLights(o, [light()], false, null);
    budget.update(new THREE.Vector3(), 0); // first update gathers
    expect(pl.visible).toBe(true);
  });
});

describe('ServerObjectManager — Setup lights on server objects', () => {
  function makeSom(setup: { lights: Map<number, LightInfo> }) {
    const smr = {
      createSetupMeshWithOverrides: () => new THREE.Group(),
      loadSetupModel: () => setup,
    };
    const scene = new THREE.Scene();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { som: new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, scene), scene };
  }
  const base = (over: Record<string, unknown> = {}) => ({
    guid: 0x80000001, name: 'Torch', weenieClassId: 1, itemType: 0, setupId: 0x02000001,
    position: { landblock: 0x01030105, x: 10, y: 10, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 },
    motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
    wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
    maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
    velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0,
    defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0, ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  it('creates the lights with LightingOn, drops them on a SetState without it, restores them on the next edge', () => {
    const live = new Set<THREE.Object3D>();
    setObjectLightSink({ track: (l) => live.add(l), untrack: (l) => live.delete(l) });
    const { som } = makeSom({ lights: new Map([[0, light()]]) });
    const obj = som.createObject(base({ physicsState: PhysicsState.LightingOn }))!;
    expect(objectLightsOf(obj.mesh!)).toHaveLength(1);
    expect(live.size).toBe(1);
    som.setPhysicsState(obj.guid, PhysicsState.Gravity);
    expect(objectLightsOf(obj.mesh!)).toHaveLength(0);
    expect(live.size).toBe(0);
    som.setPhysicsState(obj.guid, PhysicsState.Gravity | PhysicsState.LightingOn);
    expect(objectLightsOf(obj.mesh!)).toHaveLength(1);
    som.deleteObject(obj.guid);
    expect(live.size).toBe(0);
  });

  it('an object without LightingOn never gets its Setup lights', () => {
    setObjectLightSink(null);
    const { som } = makeSom({ lights: new Map([[0, light()]]) });
    const obj = som.createObject(base({ physicsState: PhysicsState.Gravity }))!;
    expect(objectLightsOf(obj.mesh!)).toHaveLength(0);
  });

  it('an appearance rebuild keeps the lights (on the new mesh) and the object scale', () => {
    setObjectLightSink(null);
    const { som } = makeSom({ lights: new Map([[0, light()]]) });
    const obj = som.createObject(base({ physicsState: PhysicsState.LightingOn, objScale: 1.5 }))!;
    const old = obj.mesh!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    som.updateAppearance({ guid: obj.guid, basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], visualDescSequence: 1 } as any);
    expect(obj.mesh).not.toBe(old);
    expect(objectLightsOf(old)).toHaveLength(0);
    expect(objectLightsOf(obj.mesh!)).toHaveLength(1);
    expect(obj.mesh!.scale.x).toBeCloseTo(1.5, 6);
  });
});

describe.skipIf(!hasDat)('DAT ground truth — the Flame Bolt projectile setup 0x0200040D (needs DAT)', () => {
  let setup: { lights: Map<number, LightInfo> };
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel.js');
    const db = openDat(PORTAL);
    setup = new SetupModel(new DatReader(db.getFileData(0x0200040D)!)) as never;
  });

  it('has one white light (intensity 100, falloff 8) at the object origin, and a LightingOn missile gets it', () => {
    expect(setup.lights.size).toBe(1);
    const info = [...setup.lights.values()][0];
    expect(info.color >>> 0).toBe(0xffffffff);
    expect(info.intensity).toBe(100);
    expect(info.falloff).toBe(8);
    const root = new THREE.Group();
    syncObjectLights(root, setup.lights, PhysicsState.Missile | PhysicsState.LightingOn | PhysicsState.Gravity, null);
    const [pl] = objectLightsOf(root);
    expect(pl.color.getHex(THREE.LinearSRGBColorSpace)).toBe(0xffffff);
    expect(pl.intensity).toBe(100);
    expect(pl.distance).toBeCloseTo(12, 6);
    expect(pl.position.length()).toBe(0);
  });
});
