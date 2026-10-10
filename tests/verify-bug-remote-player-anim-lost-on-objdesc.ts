/**
 * BUG.remote-player-anim-lost-on-objdesc — "other players aren't animated at
 * all: TestPartner casts and moves but just slides around". An ObjDescEvent
 * (a wield, a clothing change — players get them constantly) rebuilds a
 * remote object's mesh into a NEW Group; the AnimatedEntity kept posing the
 * discarded group, so the visible character stood in its rest pose while its
 * position moved. Retail DoObjDescChanges @ 0050fa30 swaps only the parts —
 * the motion state carries on. Drives the real ServerObjectManager +
 * AnimatedEntity.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { AnimatedEntity } from '../packages/renderer/src/animation/AnimatedEntity.js';

const GUID = 0x50000003;
function baseData() {
  return {
    guid: GUID, name: 'TestPartner', weenieClassId: 1, itemType: 0x10, position: { landblock: 0x00000001, x: 0, y: 0, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 } /* a world object has a cell (HandleCreateObject enter_world) */, setupId: 0x02000001,
    motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
    wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
    maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
    velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0,
    defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}
const twoParts = () => {
  const g = new THREE.Group();
  for (let i = 0; i < 2; i++) { const p = new THREE.Group(); p.name = `part_${i}`; g.add(p); }
  return g;
};
/** A posed frame: part i lifted to y = 1 + i (AC z → three y). */
const frames = [0, 1].map((i) => ({ origin: { x: 0, y: 0, z: 1 + i }, orientation: { w: 1, x: 0, y: 0, z: 0 } }));

function setup() {
  const smr = { createSetupMeshWithOverrides: twoParts, loadSetupModel: () => null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, new THREE.Scene());
  const obj = som.createObject(baseData())!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const animated = new AnimatedEntity(obj.mesh as THREE.Group, {} as any);
  animated.motionManager.update = () => {};
  animated.motionManager.getPartTransforms = () => frames as never;
  som.registerAnimatedEntity(GUID, animated);
  return { som, obj, animated };
}
const desc = (seq: number) => ({ guid: GUID, basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], visualDescSequence: seq } as never);

describe('BUG.remote-player-anim-lost-on-objdesc', () => {
  it('after an appearance rebuild the animation poses the NEW mesh\'s parts', () => {
    const { som, obj, animated } = setup();
    const old = obj.mesh!;
    som.updateAppearance(desc(1));
    expect(obj.mesh).not.toBe(old);
    expect(animated.group).toBe(obj.mesh);
    som.updateAnimations(0.016);
    const parts = obj.mesh!.children.filter((c) => /^part_\d$/.test(c.name));
    expect(parts.map((p) => p.position.y)).toEqual([1, 2]);
  });
  it('the same MotionManager carries on (no reset of the motion state)', () => {
    const { som, animated } = setup();
    const mm = animated.motionManager;
    som.updateAppearance(desc(1));
    expect(som.getAnimated(GUID)).toBe(animated);
    expect(animated.motionManager).toBe(mm);
  });
});
