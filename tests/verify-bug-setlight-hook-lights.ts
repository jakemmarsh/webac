/**
 * BUG.setlight-hook-emissive-only — the SetLight hook only toggled material
 * emissive intensity. Retail: SetLightHook::Execute @ 00526fd0 is
 * `CPhysicsObj::set_lights(obj, lights_on, 0)` @ 0050fcf0 — LightingOn
 * (0x800) set / cleared and CPartArray::InitLights / DestroyLights: the
 * object's Setup LIGHTS, nothing about its materials.
 *
 * The one EoL script carrying the hook is 0x33000109 (NoDraw + lights off),
 * the ProjectileCollision (0x5A) entry of 42 spell-projectile
 * PhysicsScriptTables (Flame Bolt's 0x34000005 among them): a bolt vanishes
 * and its light goes out when it hits.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as THREE from 'three';
import { PhysicsState } from '@ac/shared';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { DatLightBudget } from '../packages/renderer/src/effects/DatLightBudget.js';
import { objectLightsOf, setObjectLightSink } from '../packages/renderer/src/effects/ObjectLights.js';
import { setCellLighting } from '../packages/renderer/src/models/RetailLighting.js';
import { resolvePlayScript } from '../packages/renderer/src/effects/PlayScriptResolve.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { PhysicsScript, PhysicsScriptTable } from '../packages/dat-parser/src/file-types/PhysicsScript.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import type { LightInfo } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { openDat } from './_harness/dat.js';

afterEach(() => setObjectLightSink(null));

function light(): LightInfo {
  return {
    viewerSpaceLocation: { origin: { x: 0, y: 0, z: 0 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },
    color: 0xffffffff, intensity: 100, falloff: 8, coneAngle: 0,
  } as LightInfo;
}

function rig(physicsState: number) {
  const scene = new THREE.Scene();
  const budget = new DatLightBudget(scene, { fixedLightCount: true });
  setObjectLightSink(budget);
  const mat = new THREE.MeshStandardMaterial({ emissive: 0xff8000 });
  mat.emissiveIntensity = 0.5;
  const smr = {
    createSetupMeshWithOverrides: () => { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BufferGeometry(), mat)); return g; },
    loadSetupModel: () => ({ lights: new Map([[0, light()]]) }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, scene);
  const obj = som.createObject({
    guid: 0x80000040, name: 'Flame Bolt', weenieClassId: 1, itemType: 0, setupId: 0x0200040D,
    position: { landblock: 0x01D90108, x: 10, y: 10, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 },
    motionTableId: 0, iconId: 0, physicsState, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
    wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
    maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
    velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0,
    defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)!;
  setCellLighting(obj.mesh!, true);
  const player = new PhysicsScriptPlayer({
    spellEffects: { spawnParticleEffect: () => undefined, removeParticleSystem: () => {} } as never,
    soundPlayer: { playPositionalSound: async () => {} } as never,
    loadEmitterInfo: () => null,
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    // main.ts's wiring: the hook's anchor → its server object → set_lights.
    setLights: (anchor, on) => { const o = som.objectForMesh(anchor); if (o) som.setLights(o.guid, on); },
    setNoDraw: (anchor, on) => { const o = som.objectForMesh(anchor); return o ? som.setNoDraw(o.guid, on) : false; },
  });
  return { scene, budget, som, obj, player, mat };
}

const hookScript = (on: number) => ({
  id: 0x33000109, steps: [{ startTime: 0, hook: { hookType: AnimationHookType.SetLight, direction: 0, lightsOn: on } }],
}) as unknown as PhysicsScript;

describe('SetLight hook → CPhysicsObj::set_lights on the server object', () => {
  it('lights off: LightingOn cleared, the Setup lights destroyed and out of the pool; the material is untouched', () => {
    const { budget, obj, player, mat } = rig(PhysicsState.LightingOn | PhysicsState.Missile);
    budget.update(new THREE.Vector3(), 0);
    const [pl] = objectLightsOf(obj.mesh!);
    expect(pl.visible).toBe(true);
    player.play(hookScript(0), obj.mesh!);
    expect(obj.physicsState & PhysicsState.LightingOn).toBe(0);
    expect(obj.physicsState & PhysicsState.Missile).toBe(PhysicsState.Missile);
    expect(objectLightsOf(obj.mesh!)).toHaveLength(0);
    expect(pl.parent).toBeNull();
    expect(mat.emissiveIntensity).toBe(0.5);
  });

  it('lights on: LightingOn set and the lights built (InitLights)', () => {
    const { budget, obj, player } = rig(0);
    expect(objectLightsOf(obj.mesh!)).toHaveLength(0);
    player.play(hookScript(1), obj.mesh!);
    expect(obj.physicsState & PhysicsState.LightingOn).toBe(PhysicsState.LightingOn);
    const [pl] = objectLightsOf(obj.mesh!);
    budget.update(new THREE.Vector3(), 0);
    expect(pl.visible).toBe(true);
  });

  it('a later server SetState still decides (the hook is a local state change)', () => {
    const { som, obj, player } = rig(PhysicsState.LightingOn);
    player.play(hookScript(0), obj.mesh!);
    som.setPhysicsState(obj.guid, PhysicsState.LightingOn);
    expect(objectLightsOf(obj.mesh!)).toHaveLength(1);
  });

  it('an anchor that is not a server object is left alone', () => {
    const { som } = rig(PhysicsState.LightingOn);
    expect(som.objectForMesh(new THREE.Group())).toBeUndefined();
    expect(som.setLights(0x12345678, false)).toBe(false);
  });
});

const PORTAL_DAT = 'dat/client_portal.dat';
describe.skipIf(!fs.existsSync(PORTAL_DAT))('DAT: ProjectileCollision → 0x33000109 turns the bolt\'s light off', () => {
  let portal: DatDatabase;
  beforeAll(() => { portal = openDat(PORTAL_DAT); });

  it('0x33000109 is NoDraw + SetLight(off), the ProjectileCollision entry of the Flame Bolt table 0x34000005', () => {
    const script = PhysicsScript.read(new DatReader(portal.getFileData(0x33000109)!));
    const hooks = script.steps.map((st) => st.hook as unknown as { hookType: number; lightsOn?: number; noDraw?: number });
    expect(hooks.map((h) => h.hookType)).toEqual([AnimationHookType.NoDraw, AnimationHookType.SetLight]);
    expect(hooks[1].lightsOn).toBe(0);
    const loadTable = (id: number) => {
      const d = portal.getFileData(id);
      return d ? PhysicsScriptTable.read(new DatReader(d)) : null;
    };
    // ProjectileCollision (0x5A) through the Flame Bolt's table by intensity 1.
    const r = resolvePlayScript({ peTableId: 0x34000005, setupId: 0 }, 0x5A, 1, loadTable, () => 0);
    expect(r?.scriptId).toBe(0x33000109);
  });

  it('played on a lit bolt, the real script hides it and destroys its light', () => {
    const script = PhysicsScript.read(new DatReader(portal.getFileData(0x33000109)!));
    const { obj, player } = rig(PhysicsState.LightingOn | PhysicsState.Missile);
    expect(objectLightsOf(obj.mesh!)).toHaveLength(1);
    player.play(script, obj.mesh!);
    expect(obj.mesh!.visible).toBe(false);
    expect(objectLightsOf(obj.mesh!)).toHaveLength(0);
  });
});

// BUG.nodraw-hook-overwritten — NoDrawHook::Execute @ 00526be0 →
// CPhysicsObj::set_nodraw @ 0050fca0 sets PhysicsState NoDraw (0x20); the
// per-frame visibility pass reads that bit, so the hook must write the state.
const noDrawScript = (on: number) => ({
  id: 0x33000109, steps: [{ startTime: 0, hook: { hookType: AnimationHookType.NoDraw, direction: 0, noDraw: on } }],
}) as unknown as PhysicsScript;

describe('NoDraw hook → CPhysicsObj::set_nodraw on the server object', () => {
  it('sets the NoDraw state bit, so the next per-frame visibility pass keeps the object hidden', () => {
    const { som, obj, player } = rig(PhysicsState.Missile);
    player.play(noDrawScript(1), obj.mesh!);
    expect(obj.physicsState & PhysicsState.NoDraw).toBe(PhysicsState.NoDraw);
    expect(obj.mesh!.visible).toBe(false);
    som.updateInteriorVisibility(() => true); // main.ts runs this every frame (the rig's env cell 0x0108 is drawn, so only the state decides)
    expect(obj.mesh!.visible).toBe(false);
  });

  it('NoDraw off clears the bit and the object draws again', () => {
    const { som, obj, player } = rig(PhysicsState.NoDraw);
    som.updateInteriorVisibility(() => true);
    expect(obj.mesh!.visible).toBe(false);
    player.play(noDrawScript(0), obj.mesh!);
    expect(obj.physicsState & PhysicsState.NoDraw).toBe(0);
    som.updateInteriorVisibility(() => true);
    expect(obj.mesh!.visible).toBe(true);
  });

  it('an anchor that is not a server object is hidden directly', () => {
    const { player } = rig(0);
    const g = new THREE.Group();
    player.play(noDrawScript(1), g);
    expect(g.visible).toBe(false);
  });
});
