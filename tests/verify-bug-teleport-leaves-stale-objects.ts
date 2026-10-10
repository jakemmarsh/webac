/**
 * BUG.teleport-leaves-stale-objects — after a teleport the objects of the
 * previous area stayed in the ServerObjectManager with their scripts, sounds
 * and lights running (Holtburg portal hums were recorded inside a dungeon).
 *
 * Retail (see packages/renderer/src/world/ObjectMaint.ts): an object whose
 * cell is released leaves visibility (CPhysicsObj::leave_visibility
 * @ 00514220) — not drawn, lights out of the cells, `update_object`
 * @ 00515d10 frozen — and is queued for destruction
 * NONVISIBLE_OBJECT_DESTRUCTION_TIME (25 s) later
 * (CObjectMaint::AddObjectToBeDestroyed @ 00508f70 / UseTime @ 005089b0 →
 * DeleteObject @ 00508460). Back in a loaded cell it leaves the queue
 * (prepare_to_enter_world @ 00511fa0). Which cells are loaded:
 * CellManager::ChangePosition @ 004559b0 (landscape grid of mid_radius
 * around an outdoor / SeenOutside viewer; a sealed env-cell viewer releases
 * the landscape).
 *
 * BUG.default-script-80-cap — every object plays its Setup DefaultScript
 * (no 80-script cap).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as THREE from 'three';
import { PhysicsState } from '@ac/shared';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { isCellLoaded, NONVISIBLE_OBJECT_DESTRUCTION_TIME, type ViewerLoadPoint } from '../packages/renderer/src/world/ObjectMaint.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { DatLightBudget } from '../packages/renderer/src/effects/DatLightBudget.js';
import { objectLightsOf, setObjectLightSink } from '../packages/renderer/src/effects/ObjectLights.js';
import { playCreationDefaultScript } from '../packages/renderer/src/effects/PlayScriptResolve.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import type { PhysicsScript } from '../packages/dat-parser/src/index.js';
import type { LightInfo } from '../packages/dat-parser/src/file-types/SetupModel.js';

afterEach(() => setObjectLightSink(null));

const HOLTBURG = 0xA9B4FFFF >>> 0;

function viewer(over: Partial<ViewerLoadPoint> = {}): ViewerLoadPoint {
  return { viewerCellId: HOLTBURG, sealed: false, midRadius: 8, isSeenOutside: () => true, ...over };
}

describe('ObjectMaint.isCellLoaded — CellManager::ChangePosition', () => {
  it('outdoors: the LScape grid of mid_radius blocks around the viewer (Chebyshev), land and SeenOutside cells', () => {
    const v = viewer();
    expect(isCellLoaded(0xA9B40021, v)).toBe(true);
    expect(isCellLoaded(0xB1B4FFFF, v)).toBe(true); // 8 blocks east
    expect(isCellLoaded(0xB2B4FFFF, v)).toBe(false); // 9 blocks east
    expect(isCellLoaded(0xA1ACFFFF, v)).toBe(true); // 8 west, 8 south
    expect(isCellLoaded(0xA9BD0001, v)).toBe(false); // 9 north
    expect(isCellLoaded(0xA9B40105, v)).toBe(true); // a building interior
    expect(isCellLoaded(0xA9B40105, viewer({ isSeenOutside: () => false }))).toBe(false); // a dungeon under the town
    expect(isCellLoaded(0, v)).toBe(false);
    expect(isCellLoaded(0xB2B4FFFF, viewer({ midRadius: 25 }))).toBe(true);
  });

  it('a sealed dungeon viewer releases the landscape: only its landblock\'s env cells stay', () => {
    const v = viewer({ viewerCellId: 0x01D90108, sealed: true });
    expect(isCellLoaded(0x01D9011A, v)).toBe(true);
    expect(isCellLoaded(0x01D9FFFF, v)).toBe(false);
    expect(isCellLoaded(HOLTBURG, v)).toBe(false);
    expect(isCellLoaded(0x01DA0108, v)).toBe(false);
  });

  it('the destruction delay is the retail NONVISIBLE_OBJECT_DESTRUCTION_TIME', () => {
    expect(NONVISIBLE_OBJECT_DESTRUCTION_TIME).toBe(25);
  });
});

function light(): LightInfo {
  return {
    viewerSpaceLocation: { origin: { x: 0, y: 0, z: 1 }, orientation: { w: 1, x: 0, y: 0, z: 0 } },
    color: 0xffc89664, intensity: 3, falloff: 8, coneAngle: 0,
  } as LightInfo;
}

function createData(guid: number, landblock: number, over: Record<string, unknown> = {}) {
  return {
    guid, name: `Portal ${guid.toString(16)}`, weenieClassId: 1, itemType: 0x10000, setupId: 0x020001B3,
    position: { landblock, x: 10, y: 10, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 },
    motionTableId: 0, iconId: 0, physicsState: PhysicsState.LightingOn, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
    wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
    maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
    velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0,
    defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0,
    ...over,
  };
}

/** A portal-like DefaultScript: an endless emitter + a hum that CallPES-loops every 2.7 s. */
function humScript(): PhysicsScript {
  const s = {
    id: 0x3300067A,
    steps: [
      { startTime: 0, hook: { hookType: AnimationHookType.CreateParticle, direction: 0, emitterInfoId: 0x320009D9, partIndex: 0xFFFFFFFF, offset: { origin: { x: 0, y: 0, z: 0 } }, emitterId: 7 } },
      { startTime: 0, hook: { hookType: AnimationHookType.SoundTweaked, direction: 0, soundId: 0x0A00038E, probability: 1, priority: 0, volume: 0.05 } },
      { startTime: 2.7, hook: { hookType: AnimationHookType.Sound, direction: 0, soundId: 0x0A00038E } },
    ],
  };
  return s as unknown as PhysicsScript;
}

/** The wiring main.ts does: SOM + the real script player + the real light pool. */
function rig() {
  const scene = new THREE.Scene();
  const budget = new DatLightBudget(scene, { fixedLightCount: true });
  setObjectLightSink(budget);
  const smr = { createSetupMeshWithOverrides: () => new THREE.Group(), loadSetupModel: () => ({ lights: new Map([[0, light()]]), defaultScript: 0x3300067A }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, scene);
  const systems = new Set<{ object3D: THREE.Object3D }>();
  const sounds: number[] = [];
  const player = new PhysicsScriptPlayer({
    spellEffects: {
      spawnParticleEffect: () => { const s = { object3D: new THREE.Object3D(), stop() {} }; systems.add(s); return s; },
      removeParticleSystem: (s: { object3D: THREE.Object3D }) => { systems.delete(s); },
    } as never,
    soundPlayer: { playPositionalSound: vi.fn(async (id: number) => { sounds.push(id); }) } as never,
    loadEmitterInfo: (id: number) => ({ id, hwGfxObjId: 0x01000001, lifespan: 1, lifespanRand: 0, totalSeconds: 0, totalParticles: 0 } as never),
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    setLights: (anchor, on) => { const o = som.objectForMesh(anchor); if (o) som.setLights(o.guid, on); },
  });
  som.onObjectCreated = (obj) => {
    playCreationDefaultScript(obj.mesh!, 0x3300067A, () => humScript(), (script, anchor) => player.play(script, anchor));
  };
  som.onObjectLeftWorld = (obj) => { if (obj.mesh) player.setAnchorSuspended(obj.mesh, true); };
  som.onObjectReenteredWorld = (obj) => { if (obj.mesh) player.setAnchorSuspended(obj.mesh, false); };
  som.onObjectDeleted = (obj) => { if (obj.mesh) player.stopForAnchor(obj.mesh); };
  return { scene, budget, som, player, systems, sounds };
}

describe('ServerObjectManager.updateObjectMaint — leave visibility, freeze, destroy after 25 s', () => {
  it('a teleport away hides + freezes the old area (no hum, no lights, no emitters) and deletes it 25 s later', () => {
    const { scene, budget, som, player, systems, sounds } = rig();
    const portal = som.createObject(createData(0x7A9B4001, 0xA9B40021) as never)!;
    const mesh = portal.mesh!;
    let v = viewer();
    const loaded = (id: number) => isCellLoaded(id, v);
    som.updateObjectMaint(loaded, 100);
    expect(mesh.visible).toBe(true);
    expect(systems.size).toBe(1);
    expect(sounds.length).toBe(1);
    expect(objectLightsOf(mesh)).toHaveLength(1);
    budget.update(new THREE.Vector3(), 0);

    // Teleport into a dungeon (sealed): the landscape is released.
    v = viewer({ viewerCellId: 0x01D90108, sealed: true });
    som.updateObjectMaint(loaded, 101);
    expect(portal.lostCell).toBe(true);
    expect(som.lostObjectCount).toBe(1);
    expect(mesh.visible).toBe(false);
    expect([...systems].every((s) => s.object3D.visible === false)).toBe(true);
    budget.update(new THREE.Vector3(), 10);
    expect(objectLightsOf(mesh)[0].visible).toBe(false);
    // Frozen: 10 s pass, the 2.7 s hum never fires.
    player.update(10);
    expect(sounds.length).toBe(1);
    expect(player.isAnchorSuspended(mesh)).toBe(true);

    // 24.9 s after leaving it is still known…
    som.updateObjectMaint(loaded, 101 + 24.9);
    expect(som.getObject(portal.guid)).toBeDefined();
    // …at 25 s it is gone, with everything anchored on it.
    som.updateObjectMaint(loaded, 101 + NONVISIBLE_OBJECT_DESTRUCTION_TIME);
    expect(som.getObject(portal.guid)).toBeUndefined();
    expect(som.lostObjectCount).toBe(0);
    expect(systems.size).toBe(0);
    expect(player.activeCount).toBe(0);
    expect(mesh.parent).toBeNull();
    expect(scene.children.filter((c) => c.name === 'object-light-carrier')).toHaveLength(0);
  });

  it('coming back within 25 s: the object reappears and its scripts carry on', () => {
    const { som, player, systems, sounds } = rig();
    const portal = som.createObject(createData(0x7A9B4002, 0xA9B40021) as never)!;
    let v = viewer();
    const loaded = (id: number) => isCellLoaded(id, v);
    som.updateObjectMaint(loaded, 0);
    player.update(1.0);
    v = viewer({ viewerCellId: 0x01D90108, sealed: true });
    som.updateObjectMaint(loaded, 1);
    player.update(20);
    expect(sounds.length).toBe(1);
    v = viewer();
    som.updateObjectMaint(loaded, 20);
    expect(portal.lostCell).toBe(false);
    expect(portal.mesh!.visible).toBe(true);
    expect([...systems].every((s) => s.object3D.visible)).toBe(true);
    // The script resumes at 1.0 s: the 2.7 s hum is 1.7 s away, not 20 s late.
    player.update(1.6);
    expect(sounds.length).toBe(1);
    player.update(0.2);
    expect(sounds.length).toBe(2);
    // No longer queued: long after the old deadline it is still there.
    som.updateObjectMaint(loaded, 100);
    expect(som.getObject(portal.guid)).toBeDefined();
  });

  it('a server position update into a loaded cell brings a lost object back; a wielded item follows its wielder; carried items are never queued', () => {
    const { som } = rig();
    const creature = som.createObject(createData(0x80000010, 0x01D90108) as never)!; // dungeon, seen from Holtburg
    const sword = som.createObject(createData(0x80000011, 0, { position: null, wielderId: 0x80000010 }) as never)!;
    const pack = som.createObject(createData(0x80000012, 0, { position: null }) as never)!;
    const v = viewer();
    const loaded = (id: number) => isCellLoaded(id, v);
    som.updateObjectMaint(loaded, 0);
    expect(creature.lostCell).toBe(true);
    expect(sword.lostCell).toBe(true);
    expect(pack.lostCell).toBeFalsy();
    som.updatePosition({ guid: creature.guid, flags: 0x4, landblock: 0xA9B40022, x: 5, y: 5, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 } as never);
    som.updateObjectMaint(loaded, 1);
    expect(creature.lostCell).toBe(false);
    expect(sword.lostCell).toBe(false);
    som.updateObjectMaint(loaded, 60);
    expect(som.getObject(pack.guid)).toBeDefined();
    expect(som.getObject(creature.guid)).toBeDefined();
  });

  it('a lost object does not animate or interpolate (update_object returns at once)', () => {
    const { som } = rig();
    const obj = som.createObject(createData(0x80000020, 0xA9B40021) as never)!;
    som.updatePosition({ guid: obj.guid, flags: 0x4, landblock: 0x01D90108, x: 50, y: 50, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 } as never);
    const v = viewer();
    som.updateObjectMaint((id) => isCellLoaded(id, v), 0);
    expect(obj.lostCell).toBe(true);
    const before = obj.mesh!.position.clone();
    som.updateAnimations(1);
    expect(obj.mesh!.position.equals(before)).toBe(true);
  });

  it('ten teleports: nothing accumulates — objects, scripts, emitters, lights and scene nodes return to the baseline', () => {
    const { scene, som, player, systems } = rig();
    const baselineChildren = scene.children.length;
    let v = viewer();
    const loaded = (id: number) => isCellLoaded(id, v);
    let t = 0;
    let guid = 0x7A000000;
    for (let i = 0; i < 10; i++) {
      // Arrive in a town: the server sends its 30 portals / lamps.
      const block = (((0x10 + i * 0x10) << 24) | (0x20 << 16) | 0xFFFF) >>> 0;
      v = viewer({ viewerCellId: block });
      for (let k = 0; k < 30; k++) som.createObject(createData(guid++, (block & 0xFFFF0000 | 0x0021) >>> 0) as never);
      som.updateObjectMaint(loaded, t);
      player.update(1);
      t += 30; // …and stay past the 25 s destruction delay before the next hop.
    }
    v = viewer({ viewerCellId: 0x01D90108, sealed: true });
    som.updateObjectMaint(loaded, t);
    som.updateObjectMaint(loaded, t + NONVISIBLE_OBJECT_DESTRUCTION_TIME);
    expect(som.getAllObjects().size).toBe(0);
    expect(player.activeCount).toBe(0);
    expect(systems.size).toBe(0);
    expect(scene.children.length).toBe(baselineChildren);
  });
});

describe('BUG.default-script-80-cap — no cap on DefaultScripts', () => {
  it('the 200th object still plays its Setup DefaultScript', () => {
    const { som, player, systems } = rig();
    for (let i = 0; i < 200; i++) som.createObject(createData(0x7B000000 + i, 0xA9B40021) as never);
    expect(player.activeCount).toBe(200);
    expect(systems.size).toBe(200);
  });

  it('playCreationDefaultScript plays whatever else is running, and nothing without a DefaultScript', () => {
    const play = vi.fn();
    const script = { id: 1, steps: [] } as unknown as PhysicsScript;
    expect(playCreationDefaultScript('a', 0x3300067A, () => script, play)).toBe(0x3300067A);
    expect(play).toHaveBeenCalledWith(script, 'a');
    expect(playCreationDefaultScript('a', 0, () => script, play)).toBeUndefined();
    expect(playCreationDefaultScript('a', 0x33000001, () => null, play)).toBeUndefined();
    expect(play).toHaveBeenCalledTimes(1);
  });
});

// BUG.ac1999-world-objects-missing-after-login diagnostic — each pass that
// changed something reports who left (guid + cell) and who was destroyed;
// quiet passes report nothing.
describe('ServerObjectManager.onObjectMaintReport', () => {
  it('reports the leave, stays quiet while waiting, then reports the destroy', () => {
    const { som } = rig();
    const portal = som.createObject(createData(0x7A9B4001, 0xA9B40021) as never)!;
    const reports: Array<{ left: Array<{ guid: number; cell: number }>; destroyed: number[] }> = [];
    som.onObjectMaintReport = (r) => { reports.push(r); };
    let v = viewer();
    const loaded = (id: number) => isCellLoaded(id, v);
    som.updateObjectMaint(loaded, 100);
    expect(reports).toEqual([]);
    v = viewer({ viewerCellId: 0x01D90108, sealed: true });
    som.updateObjectMaint(loaded, 101);
    expect(reports).toEqual([{ left: [{ guid: portal.guid, cell: 0xA9B40021 }], destroyed: [] }]);
    som.updateObjectMaint(loaded, 110);
    expect(reports).toHaveLength(1);
    som.updateObjectMaint(loaded, 101 + NONVISIBLE_OBJECT_DESTRUCTION_TIME);
    expect(reports[1]).toEqual({ left: [], destroyed: [portal.guid] });
  });
});

// BUG.ac1999-world-objects-missing-after-login diagnostic — the removal
// journal: a pass that took BULK_REMOVAL_REPORT or more objects out of the
// table reports each with its path; fewer, or a teardown, report nothing.
describe('ServerObjectManager.onBulkRemoval', () => {
  const statics = (som: ServerObjectManager, n: number) =>
    Array.from({ length: n }, (_, i) => som.createObject(createData(0x7017e000 + i, 0x017e0104) as never)!.guid);

  it('five server deletes in one pass are reported with their reason; four are not', () => {
    const { som } = rig();
    const reports: Array<Array<{ guid: number; reason: string }>> = [];
    som.onBulkRemoval = (r) => { reports.push(r); };
    const loaded = () => true;
    const guids = statics(som, 9);
    for (const g of guids.slice(0, 4)) som.deleteObject(g);
    som.updateObjectMaint(loaded, 1);
    expect(reports).toEqual([]);
    som.deleteObject(guids[4], 'pickup');
    for (const g of guids.slice(5)) som.deleteObject(g);
    som.updateObjectMaint(loaded, 2);
    expect(reports).toEqual([[
      { guid: guids[4], reason: 'pickup' },
      ...guids.slice(5).map((guid) => ({ guid, reason: 'server' })),
    ]]);
    som.updateObjectMaint(loaded, 3);
    expect(reports).toHaveLength(1);
  });

  it('CObjectMaint destroys are journaled as maint', () => {
    const { som } = rig();
    const reports: Array<Array<{ guid: number; reason: string }>> = [];
    som.onBulkRemoval = (r) => { reports.push(r); };
    const guids = statics(som, 5);
    const sealedElsewhere = (id: number) => isCellLoaded(id, viewer({ viewerCellId: 0x01D90108, sealed: true }));
    som.updateObjectMaint(sealedElsewhere, 10);
    som.updateObjectMaint(sealedElsewhere, 10 + NONVISIBLE_OBJECT_DESTRUCTION_TIME);
    expect(reports).toEqual([guids.map((guid) => ({ guid, reason: 'maint' }))]);
  });

  it('clear() (the world teardown) is not reported', () => {
    const { som } = rig();
    const reports: unknown[] = [];
    som.onBulkRemoval = (r) => { reports.push(r); };
    statics(som, 8);
    som.clear();
    som.updateObjectMaint(() => true, 1);
    expect(reports).toEqual([]);
    expect(som.getAllObjects().size).toBe(0);
  });
});
