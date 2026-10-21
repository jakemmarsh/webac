/**
 * BUG.self-heritage-effects (Levistras, 2026-10-21) — "Shadow/Undead player
 * characters' smoke bodies/flaming heads don't show to yourself, only others."
 *
 * Those effects are the heritage Setup's DefaultScript (portal.dat: Undead
 * male 0x02001A0E → 0x33001280, five CreateParticle hooks on part 16;
 * Umbraen 0x0200196F → 0x33001256; Penumbraen 0x0200196E → 0x33001255;
 * Empyrean 0x02001A16 → 0x33001285). Retail plays it for EVERY object,
 * ours included: CPartArray::SetSetupID → CPhysicsObj::InitDefaults
 * @ 005139d0 → play_script_internal. ACE sends nothing for them ("Shadow
 * crown and Undead flames are handled by client", Player_Character.cs
 * FinishBarber).
 *
 * Our client builds the local player's model apart from
 * ServerObjectManager (createObject returns null for our guid), and that
 * path never played the Setup DefaultScript that onObjectCreated plays for
 * other objects. Both paths now go through world/LocalPlayerObject's
 * initSetupDefaults; these tests build our character and another player
 * from the same CreateObject data and require the same emitters on both.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { LocalPlayerDefaults, initSetupDefaults, type SetupDefaultsDeps } from '../packages/renderer/src/world/LocalPlayerObject.js';
import { SOUND_TABLE_KEY } from '../packages/renderer/src/audio/RetailSound.js';
import { DegradeLod } from '../packages/renderer/src/models/DegradeLod.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import { PhysicsScript, SetupModel, CharacterGenerator, type DatDatabase } from '../packages/dat-parser/src/index.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';

const SELF = 0x50000001;
const OTHER = 0x50000002;

function playerCreate(guid: number, setupId: number, over: Record<string, unknown> = {}) {
  return {
    guid, name: guid === SELF ? 'Me' : 'Them', weenieClassId: 1, itemType: 0x10, setupId,
    position: { landblock: 0xA9B40021, x: 10, y: 10, z: 0, rw: 1, rx: 0, ry: 0, rz: 0 },
    motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0x8, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
    wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
    maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
    velocityZ: 0, soundTableId: 0x20000001, objScale: 1, translucency: 0, defaultScript: 0,
    defaultScriptIntensity: 0, iconOverlayId: 0, iconUnderlayId: 0,
    ...over,
  };
}

interface Loaders {
  setup(id: number): { defaultScript: number; lights: Map<number, unknown>; cylSpheres: unknown[]; spheres: unknown[]; radius: number; height: number } | null;
  script(id: number): PhysicsScript | null;
}

/**
 * main.ts's wiring: the real ServerObjectManager (other objects), the real
 * PhysicsScriptPlayer, and the InitDefaults deps both paths share. Counts
 * the emitters each anchor's scripts create.
 */
function rig(load: Loaders) {
  const scene = new THREE.Scene();
  const smr = {
    createSetupMeshWithOverrides: () => new THREE.Group(),
    loadSetupModel: (id: number) => load.setup(id),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager(smr as any, { loadPaletteColors: () => null } as any, scene);
  som.setPlayerGuid(SELF);
  let spawned = 0;
  const player = new PhysicsScriptPlayer({
    spellEffects: {
      spawnParticleEffect: () => { spawned++; return { object3D: new THREE.Object3D(), stop() {}, isDone: false, isDisposed: false }; },
      removeParticleSystem: () => {},
    } as never,
    soundPlayer: { playPositionalSound: async () => {} } as never,
    loadEmitterInfo: (id: number) => ({ id, hwGfxObjId: 0x01000001, lifespan: 1, lifespanRand: 0, totalSeconds: 0, totalParticles: 0 } as never),
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
  });
  const deps: SetupDefaultsDeps = {
    setupDefaultScript: (id) => load.setup(id)?.defaultScript,
    loadScript: (id) => load.script(id),
    play: (script, anchor) => player.play(script, anchor),
  };
  som.onObjectCreated = (obj) => { if (obj.mesh) initSetupDefaults(obj.mesh, obj.setupId, deps); };
  /** Emitters created by building `build`'s object. */
  const emittersOf = (build: () => void): number => { const before = spawned; build(); return spawned - before; };
  const selfDefaults = new LocalPlayerDefaults(() => deps);
  /**
   * Our own CreateObject, as main.ts takes it: ServerObjectManager leaves it
   * alone, the objectCreate handler builds the model (built), the frame
   * loop positions it (placed).
   */
  const buildSelf = (setupId: number, over: Record<string, unknown> = {}): THREE.Group => {
    const data = playerCreate(SELF, setupId, over);
    expect(som.createObject(data as never)).toBeNull();
    const model = smr.createSetupMeshWithOverrides();
    selfDefaults.built(model, data as never);
    scene.add(model);
    model.position.set(10, 0, 10);
    selfDefaults.placed(model);
    return model;
  };
  const buildOther = (setupId: number) => som.createObject(playerCreate(OTHER, setupId) as never)!;
  return { som, player, emittersOf, buildSelf, buildOther, selfDefaults, deps };
}

/** A heritage-like DefaultScript: endless emitters on the head (part 16) and body. */
function smokeScript(id: number, emitters: number): PhysicsScript {
  const s = new PhysicsScript();
  s.id = id;
  for (let i = 0; i < emitters; i++) {
    s.steps.push({ startTime: 0, hook: { hookType: AnimationHookType.CreateParticle, direction: 0, emitterInfoId: 0x320009CF + i, partIndex: i === emitters - 1 ? 0 : 16, offset: { origin: { x: 0, y: 0, z: 0 } }, emitterId: 0 } as never });
  }
  return s;
}

describe('BUG.self-heritage-effects — our own character plays its Setup DefaultScript (no DATs)', () => {
  const SCRIPTED = 0x0200196F;
  const PLAIN = 0x02000001;
  const fake: Loaders = {
    setup: (id) => ({ defaultScript: id === SCRIPTED ? 0x33001256 : 0, lights: new Map(), cylSpheres: [], spheres: [], radius: 0.5, height: 1.8 }),
    script: (id) => (id === 0x33001256 ? smokeScript(id, 5) : null),
  };

  it('self and another player built from the same CreateObject get the same emitters', () => {
    const r = rig(fake);
    let self: THREE.Group | null = null;
    const selfEmitters = r.emittersOf(() => { self = r.buildSelf(SCRIPTED); });
    const otherEmitters = r.emittersOf(() => { r.buildOther(SCRIPTED); });
    expect(otherEmitters).toBe(5);
    expect(selfEmitters).toBe(otherEmitters);
    expect(self!.userData.setupId).toBe(SCRIPTED);
  });

  it('our script starts once the frame loop has placed the model, once per built model', () => {
    const r = rig(fake);
    const model = new THREE.Group();
    expect(r.emittersOf(() => r.selfDefaults.built(model, playerCreate(SELF, SCRIPTED) as never))).toBe(0);
    expect(r.emittersOf(() => r.selfDefaults.placed(null))).toBe(0);
    expect(r.emittersOf(() => r.selfDefaults.placed(new THREE.Group()))).toBe(0); // not the built model
    expect(r.emittersOf(() => r.selfDefaults.placed(model))).toBe(5);
    expect(r.emittersOf(() => r.selfDefaults.placed(model))).toBe(0); // every later frame
    // A re-sent own CreateObject builds a new model: it plays again.
    const rebuilt = new THREE.Group();
    r.selfDefaults.built(rebuilt, playerCreate(SELF, SCRIPTED) as never);
    expect(r.emittersOf(() => r.selfDefaults.placed(rebuilt))).toBe(5);
    // A session that ends before the model is placed plays nothing.
    const dropped = new THREE.Group();
    r.selfDefaults.built(dropped, playerCreate(SELF, SCRIPTED) as never);
    r.selfDefaults.reset();
    expect(r.emittersOf(() => r.selfDefaults.placed(dropped))).toBe(0);
  });

  it('a Setup without a DefaultScript (every human, every era) plays nothing on either', () => {
    const r = rig(fake);
    expect(r.emittersOf(() => r.buildSelf(PLAIN))).toBe(0);
    expect(r.emittersOf(() => r.buildOther(PLAIN))).toBe(0);
  });

  it('the rest of our object is made as before: name, never degraded, wire sound table, ObjScale', () => {
    const r = rig(fake);
    const plain = r.buildSelf(PLAIN);
    expect(plain.name).toBe('player_Me');
    expect(plain.userData[DegradeLod.NO_DEGRADE_KEY]).toBe(true);
    expect(plain.userData[SOUND_TABLE_KEY]).toBe(0x20000001);
    expect(plain.scale.x).toBe(1);
    expect(plain.userData.setupId).toBe(PLAIN);
    const big = r.buildSelf(PLAIN, { objScale: 1.5, soundTableId: 0 });
    expect(big.scale.toArray()).toEqual([1.5, 1.5, 1.5]);
    expect(big.userData[SOUND_TABLE_KEY]).toBe(0);
  });
});

/** Every CharGen heritage/sex Setup (plus hair-style alternates) of a portal DAT. */
function chargenSetups(db: DatDatabase): Map<number, string> {
  const cg = new CharacterGenerator(db.getReader(0x0E000002));
  const out = new Map<number, string>();
  for (const h of cg.heritageGroups.values()) {
    for (const s of h.genders.values()) {
      out.set(s.setupId, h.name);
      for (const hs of s.hairStyleList) if (hs.alternateSetup) out.set(hs.alternateSetup, h.name);
    }
  }
  return out;
}

function datLoaders(db: DatDatabase): Loaders {
  return {
    setup: (id) => { try { return new SetupModel(db.getReader(id)) as never; } catch { return null; } },
    script: (id) => { try { return PhysicsScript.read(db.getReader(id)); } catch { return null; } },
  };
}

describe.skipIf(!existsSync(DAT_PATHS.portal))('BUG.self-heritage-effects — real heritage Setups (end of retail portal.dat)', () => {
  let db: DatDatabase;
  let setups: Map<number, string>;
  beforeAll(() => { db = openDat(DAT_PATHS.portal); setups = chargenSetups(db); });

  it('Undead, Umbraen, Penumbraen and Empyrean draw their DefaultScript emitters on our own character as on others', () => {
    const r = rig(datLoaders(db));
    const scripted = new Set<string>();
    for (const [setupId, heritage] of setups) {
      const other = r.emittersOf(() => r.buildOther(setupId));
      const self = r.emittersOf(() => r.buildSelf(setupId));
      expect(self, `${heritage} 0x${setupId.toString(16)}`).toBe(other);
      if (self > 0) scripted.add(heritage);
    }
    expect([...scripted].sort()).toEqual(['Empyrean', 'Penumbraen', 'Umbraen', 'Undead']);
  });

  it('the Undead male flaming skull: 0x02001A0E → 0x33001280, five emitters', () => {
    const r = rig(datLoaders(db));
    expect(new SetupModel(db.getReader(0x02001A0E)).defaultScript).toBe(0x33001280);
    expect(r.emittersOf(() => r.buildSelf(0x02001A0E))).toBe(5);
  });
});

const DM_PORTAL = 'dat-sets/classic-dereth-1.1/client_portal.dat';
const AC1999_PORTAL = 'dat-sets/ac1999-retail/portal.dat';

describe.skipIf(!existsSync(DM_PORTAL) || !existsSync(AC1999_PORTAL))('BUG.self-heritage-effects — other eras: self rendering unchanged', () => {
  let dm: DatDatabase;
  let ac1999: DatDatabase;
  beforeAll(() => { dm = openDat(DM_PORTAL); ac1999 = openDat(AC1999_PORTAL); });

  it('AC1999: the human Setups have no DefaultScript, so our character gets no emitters (as before)', () => {
    const r = rig(datLoaders(ac1999));
    for (const id of [0x02000001, 0x0200004E]) {
      expect(new SetupModel(ac1999.getReader(id)).defaultScript).toBe(0);
      expect(r.emittersOf(() => r.buildSelf(id))).toBe(0);
    }
  });

  it('Dark Majesty: the classic human Setups play nothing; any heritage its DAT carries matches others', () => {
    const r = rig(datLoaders(dm));
    for (const id of [0x02000001, 0x0200004E]) expect(r.emittersOf(() => r.buildSelf(id))).toBe(0);
    for (const id of chargenSetups(dm).keys()) {
      expect(r.emittersOf(() => r.buildSelf(id))).toBe(r.emittersOf(() => r.buildOther(id)));
    }
  });
});
