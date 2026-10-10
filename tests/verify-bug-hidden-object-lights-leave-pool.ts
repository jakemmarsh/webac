/**
 * BUG.hidden-object-lights-leave-pool — an object's Setup lights were
 * children of its mesh root, so hiding the mesh (PhysicsState Hidden /
 * NoDraw, a NoDraw hook, the first-person viewer fade) took them out of
 * three's light list and the DAT light pool.
 *
 * Retail keeps a hidden object's LIGHTOBJs in its cell:
 * CPhysicsObj::set_hidden @ 00514c60 / set_nodraw only flip the state bit
 * and the parts' no-draw (CPartArray::SetNoDrawInternal); the lights go
 * only with CPartArray::DestroyLights (LightingOn off — set_lights
 * @ 0050fcf0) or when the object leaves the world.
 *
 * Ours: with a scene light parent (DatLightBudget) the lights hang off an
 * ObjectLightCarrier at the scene root that follows the object's frame and
 * stays lit while the object is merely not drawn (NO_DRAW_KEY); a
 * cell-culled object (not flagged) still loses them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as THREE from 'three';
import { PhysicsState } from '@ac/shared';
import {
  initObjectLights, objectLightsOf, objectLightCarrierOf, setObjectLightSink, setObjectNoDraw,
  destroyObjectLights, NO_DRAW_KEY,
} from '../packages/renderer/src/effects/ObjectLights.js';
import { DatLightBudget } from '../packages/renderer/src/effects/DatLightBudget.js';
import { setCellLighting } from '../packages/renderer/src/models/RetailLighting.js';
import { applyViewerFade } from '../packages/renderer/src/scene/ViewerFade.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import type { LightInfo } from '../packages/dat-parser/src/file-types/SetupModel.js';

function light(): LightInfo {
  return {
    viewerSpaceLocation: { origin: { x: 0.5, y: 1, z: 2 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },
    color: 0xffc89664, intensity: 3, falloff: 8, coneAngle: 0,
  } as LightInfo;
}

/** The point lights three.js would collect this frame (its traversal skips invisible subtrees). */
function renderedObjectLights(scene: THREE.Object3D): THREE.PointLight[] {
  scene.updateMatrixWorld();
  const out: THREE.PointLight[] = [];
  scene.traverseVisible((o) => { if ((o as THREE.PointLight).isPointLight && o.name.startsWith('object-light')) out.push(o as THREE.PointLight); });
  return out;
}

function rig() {
  const scene = new THREE.Scene();
  const budget = new DatLightBudget(scene, { fixedLightCount: true });
  setObjectLightSink(budget);
  const torch = new THREE.Group();
  torch.position.set(4, 1, -2);
  torch.scale.setScalar(2);
  scene.add(torch);
  setCellLighting(torch, true);
  const [pl] = initObjectLights(torch, [light()], false);
  return { scene, budget, torch, pl };
}

afterEach(() => setObjectLightSink(null));

describe('ObjectLightCarrier — lights independent of NoDraw', () => {
  it('the lights hang off a carrier at the scene root that follows the object (unscaled offset)', () => {
    const { scene, budget, torch, pl } = rig();
    const carrier = objectLightCarrierOf(torch)!;
    expect(carrier.parent).toBe(scene);
    expect(pl.parent).toBe(carrier);
    budget.update(new THREE.Vector3(), 0);
    expect(renderedObjectLights(scene)).toEqual([pl]);
    const wp = pl.getWorldPosition(new THREE.Vector3());
    expect([wp.x, wp.y, wp.z].map((v) => +v.toFixed(6))).toEqual([4.5, 3, -1]); // (4,1,-2) + AC (0.5,1,2) → three (0.5,2,1)
    torch.position.set(10, 0, 0);
    expect(renderedObjectLights(scene)).toEqual([pl]);
    expect(pl.getWorldPosition(new THREE.Vector3()).x).toBeCloseTo(10.5, 6);
  });

  it('a hidden (not drawn) object keeps its lights lit; a cell-culled one does not', () => {
    const { scene, budget, torch, pl } = rig();
    torch.visible = false;
    setObjectNoDraw(torch, true);
    budget.update(new THREE.Vector3(), 10);
    expect(pl.visible).toBe(true);
    expect(renderedObjectLights(scene)).toEqual([pl]);
    setObjectNoDraw(torch, false); // invisible for another reason (its cell is culled)
    expect(torch.userData[NO_DRAW_KEY]).toBeUndefined();
    budget.update(new THREE.Vector3(), 20);
    expect(renderedObjectLights(scene)).toEqual([]);
    expect(pl.visible).toBe(false);
  });

  it('an invisible ancestor still takes them (a hidden landblock), and so does a land cell', () => {
    const { scene, budget, torch, pl } = rig();
    const block = new THREE.Group();
    scene.add(block);
    block.add(torch);
    block.visible = false;
    budget.update(new THREE.Vector3(), 10);
    expect(pl.visible).toBe(false);
    block.visible = true;
    setCellLighting(torch, false);
    budget.update(new THREE.Vector3(), 20);
    expect(pl.visible).toBe(false);
  });

  it('the first-person viewer fade hides the model but not a held torch\'s light', () => {
    const { scene, budget, torch, pl } = rig();
    const player = new THREE.Group();
    scene.add(player);
    player.add(torch);
    applyViewerFade(player, 1);
    expect(player.visible).toBe(false);
    budget.update(new THREE.Vector3(), 10);
    expect(renderedObjectLights(scene)).toEqual([pl]);
  });

  it('DestroyLights removes the carrier; an object that leaves the scene takes its carrier and gets it back on return', () => {
    const { scene, budget, torch, pl } = rig();
    scene.remove(torch);
    budget.invalidate();
    budget.update(new THREE.Vector3(), 10);
    expect(objectLightCarrierOf(torch)!.parent).toBeNull();
    expect(pl.visible).toBe(false);
    scene.add(torch);
    budget.invalidate();
    budget.update(new THREE.Vector3(), 20);
    expect(objectLightCarrierOf(torch)!.parent).toBe(scene);
    expect(pl.visible).toBe(true);
    destroyObjectLights(torch);
    expect(objectLightCarrierOf(torch)).toBeUndefined();
    expect(scene.children.some((c) => c.name === 'object-light-carrier')).toBe(false);
    expect(objectLightsOf(torch)).toHaveLength(0);
  });
});

describe('ServerObjectManager — Hidden keeps the Setup lights (set_hidden)', () => {
  it('a SetState with Hidden hides the mesh but the object\'s light stays in the pool', () => {
    const scene = new THREE.Scene();
    const budget = new DatLightBudget(scene, { fixedLightCount: true });
    setObjectLightSink(budget);
    const smr = { createSetupMeshWithOverrides: () => new THREE.Group(), loadSetupModel: () => ({ lights: new Map([[0, light()]]) }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, scene);
    const obj = som.createObject({
      guid: 0x80000002, name: 'Lamp', weenieClassId: 1, itemType: 0, setupId: 0x02000001,
      position: { landblock: 0x01030105, x: 10, y: 10, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 },
      motionTableId: 0, iconId: 0, physicsState: PhysicsState.LightingOn, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
      basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
      wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
      maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
      velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0,
      defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)!;
    setCellLighting(obj.mesh!, true);
    const [pl] = objectLightsOf(obj.mesh!);
    budget.update(new THREE.Vector3(), 0);
    expect(pl.visible).toBe(true);
    som.setPhysicsState(obj.guid, PhysicsState.LightingOn | PhysicsState.Hidden);
    expect(obj.mesh!.visible).toBe(false);
    budget.update(new THREE.Vector3(), 10);
    expect(pl.visible).toBe(true);
    expect(renderedObjectLights(scene)).toEqual([pl]);
    // Hidden + LightingOff: DestroyLights.
    som.setPhysicsState(obj.guid, PhysicsState.Hidden);
    budget.update(new THREE.Vector3(), 20);
    expect(renderedObjectLights(scene)).toEqual([]);
    expect(objectLightsOf(obj.mesh!)).toHaveLength(0);
  });
});
