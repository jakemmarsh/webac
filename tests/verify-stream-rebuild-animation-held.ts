/**
 * Streamed-DAT rebuilds of server objects (RELEASE.dat-streaming,
 * ServerObjectManager.rebuildMesh):
 *
 * STREAM.cold-creature-never-animates — a creature created before its motion
 * table's cycle animation (or its Setup's DefaultAnimation) was resident got
 * no sequence, and the rebuild on arrival only swapped its parts: it stood in
 * its rest pose for good and dropped every MovementEvent. The rebuild now
 * starts the sequence (CPartArray::InitDefaults @ 00518980 / the motion
 * table's default state) and applies the motion state held meanwhile; the
 * closure walks Setup.defaultAnimation so the rebuild waits for it.
 *
 * STREAM.meshless-rebuild-drops-held-items — an object whose Setup was not
 * resident (no mesh) was re-created from its stale CreateObject on arrival:
 * deleteObject → unparent_children dropped its held items, and the ObjDesc /
 * SetState received since were rolled back. Retail's CPhysicsObj persists;
 * the parts are built for the object already held.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { heldItemsOf } from '../packages/renderer/src/world/WieldAttach.js';
import { PHYSICS_STATE_KEY, TRANSLUCENCY_KEY, TRANSLUCENCY_ORIGINAL_KEY } from '../packages/renderer/src/models/ObjectTranslucency.js';
import { AnimatedEntity } from '../packages/renderer/src/animation/AnimatedEntity.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand, MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import { DatClosure } from '../packages/renderer/src/dat/streaming/DatClosure.js';
import { DatStore, MissScope, fileKey } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { MAX_STREAMED_REBUILDS, rebuildOnArrival } from '../packages/renderer/src/dat/streaming/StreamingDats.js';
import type { CreateObjectData, ParsedMovementData } from '@ac/network';
import { FakeBucket, buildManifest } from './_harness/datSet.js';

const MOTION_TABLE = 0x09000101;
const READY_ANIM = 0x03000101;
const DEAD_ANIM = 0x03000102;
const DEFAULT_ANIM = 0x03000103;
const WALK_ANIM = 0x03000104;

class Bytes {
  private out: number[] = [];
  u8(v: number) { this.out.push(v & 0xff); return this; }
  u32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.out.push(...b); return this; }
  i32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); this.out.push(...b); return this; }
  f32(v: number) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.out.push(...b); return this; }
  pad4() { while (this.out.length % 4) this.out.push(0); return this; }
  done(): Uint8Array { return new Uint8Array(this.out); }
}

/** An Animation: one part, `frames` frames, part 0 at x = frame index. */
function animationBytes(id: number, frames = 4): Uint8Array {
  const b = new Bytes().u32(id).u32(0).u32(1).u32(frames);
  for (let i = 0; i < frames; i++) b.f32(i).f32(0).f32(0).f32(1).f32(0).f32(0).f32(0).u32(0);
  return b.done();
}

/** A MotionTable: NonCombat default style → Ready; cycles Ready, Dead and WalkForward. */
function motionTableBytes(): Uint8Array {
  const style = MotionStance.NonCombat >>> 0;
  const key = (motion: number) => (((style & 0xffff) << 16) | (motion & 0xfffff)) >>> 0;
  const b = new Bytes().u32(MOTION_TABLE).u32(style).u32(1).u32(style).u32(MotionCommand.Ready);
  b.u32(3);
  for (const [motion, anim] of [[MotionCommand.Ready, READY_ANIM], [MotionCommand.Dead, DEAD_ANIM], [MotionCommand.WalkForward, WALK_ANIM]]) {
    b.u32(key(motion)).u8(1).u8(0).u8(0).pad4().u32(anim).i32(0).i32(-1).f32(30);
  }
  b.u32(0); // modifiers
  b.u32(0); // links
  return b.done();
}

/** A minimal Setup (no parts) naming `defaultAnimation`. */
function setupBytes(id: number, defaultAnimation: number): Uint8Array {
  const b = new Bytes().u32(id).u32(0).u32(0).i32(0).i32(0).i32(0).u32(0).u32(0);
  for (let i = 0; i < 4 + 4 + 4; i++) b.f32(0); // height … stepDown, sorting + selection spheres
  return b.i32(0).u32(defaultAnimation).u32(0).u32(0).u32(0).u32(0).done();
}

/** A portal DAT whose files can be withheld (a streamed file not yet resident). */
function streamedPortal(files: Map<number, Uint8Array>, withheld: Set<number>) {
  return { getFileData: (id: number) => (withheld.has(id) ? null : files.get(id)?.slice().buffer ?? null) };
}

function data(guid: number, overrides: Partial<CreateObjectData> = {}): CreateObjectData {
  return {
    guid, name: 'Drudge', weenieClassId: 1, itemType: 0x10,
    position: { landblock: 0xA9B40102, x: 10, y: 20, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 },
    setupId: 0x02000123, motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0, wielderId: 0,
    currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
    uiEffects: 0, usable: 0, useRadius: 0.6, velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1,
    translucency: 0, defaultScript: 0, defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
    timestamps: [1, 1, 1, 1, 1, 1, 1, 1, 5] as never,
    ...overrides,
  } as CreateObjectData;
}

/** A one-part model (part_0), as SetupModelRenderer names parts. */
function onePartGroup(): THREE.Group {
  const g = new THREE.Group();
  const p = new THREE.Group();
  p.name = 'part_0';
  g.add(p);
  return g;
}

describe('STREAM.cold-creature-never-animates', () => {
  function makeSOM(withheld: Set<number>, setup: { defaultAnimation?: number; defaultMotionTable?: number } = {}) {
    const files = new Map<number, Uint8Array>([
      [MOTION_TABLE, motionTableBytes()],
      [READY_ANIM, animationBytes(READY_ANIM)], [DEAD_ANIM, animationBytes(DEAD_ANIM)], [DEFAULT_ANIM, animationBytes(DEFAULT_ANIM)],
    ]);
    const smr = {
      createSetupMeshWithOverrides: () => onePartGroup(),
      loadSetupModel: () => ({ defaultAnimation: setup.defaultAnimation ?? 0, defaultMotionTable: setup.defaultMotionTable ?? 0, cylSpheres: [], spheres: [], radius: 0, height: 0 }),
    };
    const som = new ServerObjectManager(smr as never, { loadPaletteColors: () => null } as never, new THREE.Scene());
    som.setPortalDb(streamedPortal(files, withheld) as never);
    return som;
  }

  it('a creature whose cycle animation missed animates once the rebuild runs on arrival', () => {
    const withheld = new Set([READY_ANIM]);
    const som = makeSOM(withheld);
    const d = data(0x80001001, { motionTableId: MOTION_TABLE });
    som.createObject(d);
    // The motion table loaded but its Ready cycle animation was not resident: nothing half-registered.
    expect(som.getAnimated(d.guid)).toBeUndefined();
    withheld.clear();
    som.rebuildMesh(d.guid, d);
    const animated = som.getAnimated(d.guid);
    expect(animated).toBeDefined();
    expect(animated!.group).toBe(som.getObject(d.guid)!.mesh);
    som.updateAnimations(2 / 30);
    expect(som.getObject(d.guid)!.mesh!.getObjectByName('part_0')!.position.x).toBeGreaterThan(0);
  });

  it('the motion state the server sent while it waited (create, then a MovementEvent) is applied', () => {
    const withheld = new Set([READY_ANIM]);
    const som = makeSOM(withheld);
    const ready: ParsedMovementData = {
      movementType: 0, autonomous: false, motionFlags: 0, styleIndex: MotionStance.NonCombat & 0xffff,
      forwardCommand: MotionCommand.Ready & 0xffff, sidestepCommand: 0, turnCommand: 0,
      forwardSpeed: 1, sidestepSpeed: 1, turnSpeed: 1, actions: [],
    };
    const d = data(0x80001002, { motionTableId: MOTION_TABLE, initialMotion: ready });
    som.createObject(d);
    expect(som.getAnimated(d.guid)).toBeUndefined();
    // A live MovementEvent (0xF74C, header form): NonCombat, ForwardCommand = Dead.
    const ev = new Uint8Array([
      0, 0, 0, 0, 0, 0, // movement + server-control timestamps, autonomous, pad
      0, 0, ...u16(MotionStance.NonCombat), // movement_type Invalid, flags, style
      ...u32(0x1 | 0x2), ...u16(MotionStance.NonCombat), ...u16(MotionCommand.Dead),
    ]);
    som.handleMovementEvent({ guid: d.guid, movementData: ev } as never);
    withheld.clear();
    som.rebuildMesh(d.guid, d);
    const mm = som.getAnimated(d.guid)?.motionManager;
    expect(mm).toBeDefined();
    expect(mm!.isDead).toBe(true);
  });

  it('a Setup DefaultAnimation that missed starts looping after the rebuild', () => {
    const withheld = new Set([DEFAULT_ANIM]);
    const som = makeSOM(withheld, { defaultAnimation: DEFAULT_ANIM });
    const d = data(0x80001003);
    som.createObject(d);
    expect(som.defaultAnimationFrame(d.guid)).toBeNull();
    withheld.clear();
    som.rebuildMesh(d.guid, d);
    expect(som.defaultAnimationFrame(d.guid)).toBe(0);
    som.updateAnimations(2 / 30);
    expect(som.defaultAnimationFrame(d.guid)!).toBeGreaterThan(0);
  });
});

function u16(n: number): number[] { return [n & 0xff, (n >>> 8) & 0xff]; }
function u32(n: number): number[] { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

describe('DatClosure walks Setup.defaultAnimation', () => {
  it('making a Setup resident makes its DefaultAnimation resident', async () => {
    const SETUP = 0x02000201;
    const bucket = new FakeBucket();
    const setupLeaf = { id: SETUP, ...bucket.put(setupBytes(SETUP, DEFAULT_ANIM)) };
    const animLeaf = { id: DEFAULT_ANIM, ...bucket.put(animationBytes(DEFAULT_ANIM)) };
    const manifest = bucket.put(buildManifest({ leaves: { portal: [setupLeaf, animLeaf] } }));
    const store = await DatStore.open({
      pointerUrl: 'https://d.test/v1/sets/s.json',
      fetchPointer: async () => ({
        format: 1, set: 's', iterations: { portal: 1, cell: 1, local: 1, highres: 0 },
        manifest: { key: `v1/o/${manifest.hash}`, size: manifest.size, gzSize: manifest.gzSize }, packs: {},
      }),
      fetchObject: bucket.fetch, cache: new MemoryObjectCache(), packs: [], retries: 0, onError: () => {},
    });
    const closure = new DatClosure(store);
    await closure.ensure([fileKey('portal', SETUP)]);
    expect(store.isResident('portal', DEFAULT_ANIM)).toBe(true);
    expect(closure.isClosed(fileKey('portal', SETUP))).toBe(true);
  });
});

describe('STREAM.meshless-rebuild-drops-held-items', () => {
  it('the parts are built for the object already held: held items, latest ObjDesc and SetState kept', () => {
    let resident = false;
    const partChangesSeen: Array<Map<number, number> | undefined> = [];
    const smr = {
      createSetupMeshWithOverrides: (_s: number, _p: number, parts?: Map<number, number>) => {
        partChangesSeen.push(parts);
        return resident ? onePartGroup() : null;
      },
      loadSetupModel: () => null,
    };
    const scene = new THREE.Scene();
    const som = new ServerObjectManager(smr as never, { loadPaletteColors: () => null } as never, scene);
    const created: number[] = [];
    som.onObjectCreated = (o) => { created.push(o.guid); };
    const holder = data(0x80002001);
    som.createObject(holder);
    const record = som.getObject(holder.guid)!;
    expect(record.mesh).toBeNull();
    // The sword it holds (created after it, parented to it).
    som.createObject(data(0x80002002, { name: 'Sword', itemType: 0x1, wielderId: holder.guid, parentLocation: 1, physicsParentId: holder.guid }));
    // Since the create: a new ObjDesc and a SetState.
    som.updateAppearance({
      guid: holder.guid, basePalette: 0, subPalettes: [], textureChanges: [],
      animPartChanges: [{ partIndex: 0, partId: 0x01000777 }], instanceSequence: 5, visualDescSequence: 2,
    });
    som.setPhysicsState(holder.guid, 0x800, 2);

    resident = true;
    expect(som.rebuildMesh(holder.guid, holder)).toBe('built');
    const obj = som.getObject(holder.guid)!;
    expect(obj).toBe(record); // the same object, not a re-create
    expect(obj.mesh).toBeTruthy();
    expect(scene.children).toContain(obj.mesh);
    // The held item is still parented: the owner re-attaches its copy.
    expect(som.getObject(0x80002002)!.wielderId).toBe(holder.guid);
    expect(heldItemsOf(holder.guid, som.getAllObjects().values())).toEqual([{ item: 0x80002002, location: 1 }]);
    // Built from the latest ObjDesc and state, not the stale CreateObject.
    expect(partChangesSeen[partChangesSeen.length - 1]?.get(0)).toBe(0x01000777);
    expect(obj.mesh!.userData[PHYSICS_STATE_KEY]).toBe(0x800);
    expect(obj.physicsState).toBe(0x800);
    expect(created).toEqual([holder.guid]);
  });
});

describe('STREAM.initial-motion-not-retried', () => {
  function makeSOM(withheld: Set<number>) {
    const files = new Map<number, Uint8Array>([
      [MOTION_TABLE, motionTableBytes()], [READY_ANIM, animationBytes(READY_ANIM)], [DEAD_ANIM, animationBytes(DEAD_ANIM)],
    ]);
    const smr = {
      createSetupMeshWithOverrides: () => onePartGroup(),
      loadSetupModel: () => ({ defaultAnimation: 0, defaultMotionTable: 0, cylSpheres: [], spheres: [], radius: 0, height: 0 }),
    };
    const som = new ServerObjectManager(smr as never, { loadPaletteColors: () => null } as never, new THREE.Scene());
    som.setPortalDb(streamedPortal(files, withheld) as never);
    return som;
  }
  const dead: ParsedMovementData = {
    movementType: 0, autonomous: false, motionFlags: 0, styleIndex: MotionStance.NonCombat & 0xffff,
    forwardCommand: MotionCommand.Dead & 0xffff, sidestepCommand: 0, turnCommand: 0,
    forwardSpeed: 1, sidestepSpeed: 1, turnSpeed: 1, actions: [],
  };

  it('a corpse whose Dead cycle missed at create lies dead after the streamed rebuild', () => {
    const withheld = new Set([DEAD_ANIM]);
    const som = makeSOM(withheld);
    const d = data(0x80003001, { motionTableId: MOTION_TABLE, initialMotion: dead });
    som.createObject(d);
    const mm = som.getAnimated(d.guid)!.motionManager;
    // The state is committed (dead) but the Ready cycle kept looping.
    expect(mm.isDead).toBe(true);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(READY_ANIM);
    withheld.clear();
    som.rebuildMesh(d.guid, d);
    expect(som.getAnimated(d.guid)!.motionManager.animationPlayer.currentAnimation?.id).toBe(DEAD_ANIM);
    expect(som.getAnimated(d.guid)!.motionManager.animationMissed).toBe(false);
  });

  it('a MovementEvent whose cycle missed is drawn once the file lands (retryMissedAnimation)', () => {
    const withheld = new Set([DEAD_ANIM]);
    const som = makeSOM(withheld);
    const d = data(0x80003002, { motionTableId: MOTION_TABLE });
    som.createObject(d);
    som.handleMovementEvent({ guid: d.guid, movementData: new Uint8Array([
      0, 0, 0, 0, 0, 0, // header: timestamps, autonomous, pad
      0, 0, ...u16(MotionStance.NonCombat), // movement_type Invalid, flags, style
      ...u32(0x1 | 0x2), ...u16(MotionStance.NonCombat), ...u16(MotionCommand.Dead),
    ]) } as never);
    const mm = som.getAnimated(d.guid)!.motionManager;
    expect(mm.animationMissed).toBe(true);
    expect(som.retryMissedAnimation(d.guid)).toBe(false); // still not resident
    withheld.clear();
    expect(som.retryMissedAnimation(d.guid)).toBe(true);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(DEAD_ANIM);
    expect(som.retryMissedAnimation(d.guid)).toBe(false); // nothing behind any more
  });
});

describe('STREAM.rebuild-resets-placement', () => {
  it('a Resting (101) ground item keeps its placement frame through ObjDesc, streamed and meshless rebuilds', () => {
    let resident = true;
    const placements: number[] = [];
    const smr = {
      createSetupMeshWithOverrides: (_s: number, placement: number) => { placements.push(placement); return resident ? onePartGroup() : null; },
      loadSetupModel: () => null,
    };
    const som = new ServerObjectManager(smr as never, { loadPaletteColors: () => null } as never, new THREE.Scene());
    const item = data(0x80004001, { name: 'Pyreal', itemType: 0x40, placement: 101 });
    som.createObject(item);
    som.rebuildMesh(item.guid, item); // streamed rebuild of a built mesh
    som.updateAppearance({
      guid: item.guid, basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
      instanceSequence: 5, visualDescSequence: 9,
    });
    resident = false;
    const meshless = data(0x80004002, { name: 'Pyreal', itemType: 0x40, placement: 101 });
    som.createObject(meshless);
    resident = true;
    som.rebuildMesh(meshless.guid, { ...meshless, placement: undefined }); // the record's placement, not the caller's
    expect(placements).toEqual([101, 101, 101, 101, 101]);
  });
});

describe('STREAM.object-rebuild-not-rescoped', () => {
  function fakeStore(missesLeft: { n: number }) {
    return {
      ensure: async () => {},
      scoped<T>(fn: () => T) {
        const scope = new MissScope();
        const result = fn();
        if (missesLeft.n > 0) { missesLeft.n--; scope.keys.add(fileKey('portal', 0x01000001)); }
        return { result, scope };
      },
    };
  }
  const closure = { ensure: async () => ({}) as never };
  function missed(): MissScope { const s = new MissScope(); s.keys.add(fileKey('portal', 0x02000001)); return s; }

  it('a rebuild that misses in turn is redone once those files land', async () => {
    let rebuilds = 0;
    await rebuildOnArrival(fakeStore({ n: 2 }) as never, closure as never, missed(), () => { rebuilds++; });
    expect(rebuilds).toBe(3);
  });

  it('a file absent from the set cannot loop: at most MAX_STREAMED_REBUILDS rebuilds', async () => {
    let rebuilds = 0;
    await rebuildOnArrival(fakeStore({ n: Infinity }) as never, closure as never, missed(), () => { rebuilds++; });
    expect(rebuilds).toBe(MAX_STREAMED_REBUILDS);
  });
});

describe('STREAM.initial-motion-not-retried — our own character', () => {
  it('a locomotion cycle that missed (CharacterAnimController committed it) plays once missed files land', () => {
    const withheld = new Set([WALK_ANIM]);
    const files = new Map<number, Uint8Array>([
      [MOTION_TABLE, motionTableBytes()], [READY_ANIM, animationBytes(READY_ANIM)], [WALK_ANIM, animationBytes(WALK_ANIM)],
    ]);
    const db = streamedPortal(files, withheld);
    const som = new ServerObjectManager({ loadSetupModel: () => null } as never, {} as never, new THREE.Scene());
    const player = new AnimatedEntity(onePartGroup(), db as never);
    expect(player.initFromMotionTable(MOTION_TABLE)).toBe(true);
    som.registerAnimatedEntity(0x50000001, player, true);
    const mm = player.motionManager;
    mm.setForwardMotion(MotionManager.compositeKey(mm.styleKey, MotionCommand.WalkForward & 0xfffff), 1);
    expect(mm.animationPlayer.currentAnimation?.id).toBe(READY_ANIM); // still idling
    expect(som.retryMissedAnimations()).toBe(0);
    withheld.clear();
    expect(som.retryMissedAnimations()).toBe(1); // main.ts runs this from onDatMissResolved
    expect(mm.animationPlayer.currentAnimation?.id).toBe(WALK_ANIM);
  });

  it('an action queued after the miss plays out, its callback fires, and it ends on the now-resident cycle', () => {
    const withheld = new Set([WALK_ANIM]);
    const files = new Map<number, Uint8Array>([
      [MOTION_TABLE, motionTableBytes()], [READY_ANIM, animationBytes(READY_ANIM)], [WALK_ANIM, animationBytes(WALK_ANIM)],
    ]);
    const mm = new MotionManager(streamedPortal(files, withheld) as never);
    mm.loadMotionTable(MOTION_TABLE);
    mm.setDefaultStance();
    mm.setForwardMotion(MotionManager.compositeKey(mm.styleKey, MotionCommand.WalkForward & 0xfffff), 1);
    expect(mm.animationMissed).toBe(true);
    // An action that resolves to a cycle playing as a one-shot (playingAction).
    let done = 0;
    mm.queueAction(MotionManager.compositeKey(mm.styleKey, MotionCommand.Ready & 0xfffff), 1, () => { done++; });
    expect(mm.isPlayingAction).toBe(true);
    withheld.clear();
    expect(mm.retryMissedAnimation()).toBe(false);
    for (let i = 0; i < 10; i++) mm.update(0.1);
    expect(done).toBe(1);
    // …and the chain ended on the committed cycle, resident now.
    expect(mm.animationPlayer.currentAnimation?.id).toBe(WALK_ANIM);
  });
});

describe('STREAM.meshless-translucency-lost', () => {
  it('Translucency and DefaultScale received while an object had no parts are used when they are built', () => {
    let resident = false;
    const smr = { createSetupMeshWithOverrides: () => (resident ? onePartGroup() : null), loadSetupModel: () => null };
    const som = new ServerObjectManager(smr as never, { loadPaletteColors: () => null } as never, new THREE.Scene());
    const d = data(0x80005001, { translucency: 0.2 });
    som.createObject(d);
    expect(som.getObject(d.guid)!.mesh).toBeNull();
    som.setServerTranslucency(d.guid, 0.6); // PublicUpdatePropertyFloat Translucency
    som.setObjectScale(d.guid, 2);          // PublicUpdatePropertyFloat DefaultScale
    resident = true;
    expect(som.rebuildMesh(d.guid, d)).toBe('built');
    const mesh = som.getObject(d.guid)!.mesh!;
    expect(mesh.userData[TRANSLUCENCY_ORIGINAL_KEY]).toBeCloseTo(0.6, 6);
    expect(mesh.userData[TRANSLUCENCY_KEY]).toBeCloseTo(0.6, 6);
    expect(mesh.scale.x).toBe(2);
  });

  it('a built object takes a live Translucency at once', () => {
    const smr = { createSetupMeshWithOverrides: () => onePartGroup(), loadSetupModel: () => null };
    const som = new ServerObjectManager(smr as never, { loadPaletteColors: () => null } as never, new THREE.Scene());
    const d = data(0x80005002);
    som.createObject(d);
    som.setServerTranslucency(d.guid, 0.5);
    expect(som.getObject(d.guid)!.mesh!.userData[TRANSLUCENCY_ORIGINAL_KEY]).toBeCloseTo(0.5, 6);
    som.setServerTranslucency(d.guid, 2); // out of range: ignored
    expect(som.getObject(d.guid)!.translucency).toBeCloseTo(0.5, 6);
  });
});
