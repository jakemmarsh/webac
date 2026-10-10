/**
 * CORE.9.a — SETUP (0x02) sky objects are script carriers, not domes.
 *
 * Ground truth (EoL portal.dat, decompiled client GameSky/SkyDesc):
 *  - Every day group's timeline carries SETUP sky objects whose single part
 *    (0x10001ec, a 3-vertex placeholder tri) exists to host the Setup's
 *    DefaultScript: the Rainy groups' ambient rain-sound loops
 *    (0x2000588/0x2000589 → PES 0x33000428/0x3300042c — 2.8s CallPES
 *    ping-pong pairs playing wave 0x0A00038B at volume 0.35/0.10), the 30s
 *    self-looping thunder + lightning cycle (0x2000ba6 → 0x33000453,
 *    SoundTweaked thunder claps + a CreateParticle lightning flash +
 *    self-CallPES pause=30), and the always-on sky particle spawner
 *    (0x2000714 → 0x330007db) present in EVERY day group.
 *  - SkyDesc::GetSky window semantics: begin==end → always active;
 *    otherwise strictly begin < t < end. Outside the window the physics
 *    object is destroyed (GameSky::CreateDeletePhysicsObjects).
 *  - GameSky::MakeObject: props&0x4 objects are never created while
 *    LScape::weather_enabled is false.
 *  - Script playback comes from the retail creation path itself:
 *    CPhysicsObj::makeObject → InitDefaults → play_script_internal
 *    (ACE PhysicsObj.cs:662 plays setup.DefaultScript on creation).
 *  - GameSky::Draw: before-sky objects with props&0x2 (cloud banks) are
 *    skipped while LScape::m_override_enabled (the server EnvironChange
 *    fog override) is active.
 *
 * Under test (behavioral, against the shipped SkyboxRenderer /
 * PhysicsScriptPlayer / real portal.dat):
 *  1. Window transitions call the wired engine's start/stop.
 *  2. begin==end slots run always; strict-inequality edges hold.
 *  3. Weather-flagged slots stop on setWeatherEnabled(false).
 *  4. An engine wired late starts already-open windows; rebuild stops all.
 *  5. props&0x2 cloud banks hide under setFogOverrideActive(true).
 *  6. SoundTweaked hooks pass their DAT volume to playPositionalSound.
 *  7. The real DAT carries the documented Setup→script chains.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import * as THREE from 'three';
import { SkyboxRenderer, type SkySetupScriptEngine } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';

/** Retail Handle_Admin__Environs RedFog (DECOMP.environs-*). */
const RED_FOG = { fogColor: 0x960000, fogMin: 0, fogMax: 50, ambientColor: 0x960000, ambientLevel: 0.4 };
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { PhysicsScript } from '../packages/dat-parser/src/file-types/PhysicsScript.js';
import { AnimationHookType, type SoundTweakedHookData, type CallPESHookData } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';

const PORTAL_DAT = 'dat/client_portal.dat';
const hasPortalDat = existsSync(PORTAL_DAT);

function timeEntry(begin: number) {
  return {
    begin, dirBright: 1, dirHeading: 0, dirPitch: 45, dirColor: 0xffffffff,
    ambBright: 0.5, ambColor: 0xffffffff, minWorldFog: 0, maxWorldFog: 1000,
    worldFogColor: 0xffffffff, worldFog: 0, skyObjReplace: [],
  };
}

function skyObject(over: Partial<Record<string, number>> = {}) {
  return {
    beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0,
    texVelocityX: 0, texVelocityY: 0,
    defaultGFXObjectId: 0x02000ba6, defaultPESObjectId: 0x33000453,
    properties: 0xd,
    ...over,
  };
}

function makeSkyDesc(skyObjects: ReturnType<typeof skyObject>[]) {
  return {
    tickSize: 30, lightTickSize: 30,
    dayGroups: [{
      chanceOfOccur: 5, dayName: 'Rainy',
      skyObjects,
      skyTime: [timeEntry(0), timeEntry(0.5)],
    }],
  } as never;
}

/** Minimal ModelRenderer stub for GfxObj sky objects. */
function stubModelRenderer() {
  return {
    createMesh: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()));
      return g;
    },
  } as never;
}

/** Records start/stop calls per slot anchor name. */
function recordingEngine() {
  const events: string[] = [];
  const engine: SkySetupScriptEngine = {
    start: (anchor, setupId) => events.push(`start:${anchor.name}:0x${setupId.toString(16)}`),
    stop: (anchor) => events.push(`stop:${anchor.name}`),
  };
  return { events, engine };
}

describe('CORE.9.a: SETUP sky object timeline windows', () => {
  it('starts the script when the window opens and stops it when it closes', () => {
    const sky = new SkyboxRenderer(makeSkyDesc([
      skyObject({ beginTime: 0.2, endTime: 0.4 }),
    ]));
    sky.initSkyObjects(stubModelRenderer());
    const { events, engine } = recordingEngine();
    sky.updateTimeOfDay(0.1);       // before window
    sky.setSetupScriptEngine(engine);
    expect(events).toHaveLength(0);

    sky.updateTimeOfDay(0.3);       // inside window
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/^start:sky_setup_0_0x02000ba6:0x2000ba6$/);

    sky.updateTimeOfDay(0.35);      // still inside — no duplicate start
    expect(events).toHaveLength(1);

    sky.updateTimeOfDay(0.45);      // past window
    expect(events).toHaveLength(2);
    expect(events[1]).toBe('stop:sky_setup_0_0x02000ba6');
  });

  it('window edges are strict (begin < t < end, per SkyDesc::GetSky)', () => {
    // 0.25/0.5 survive updateTimeOfDay's ((t%1)+1)%1 normalization exactly
    // (binary-representable), so the edge comparison itself is under test.
    const sky = new SkyboxRenderer(makeSkyDesc([
      skyObject({ beginTime: 0.25, endTime: 0.5 }),
    ]));
    sky.initSkyObjects(stubModelRenderer());
    const { events, engine } = recordingEngine();
    sky.updateTimeOfDay(0.75);      // outside — engine wiring must not start it
    sky.setSetupScriptEngine(engine);
    sky.updateTimeOfDay(0.25);      // exactly begin — NOT active
    expect(events).toHaveLength(0);
    sky.updateTimeOfDay(0.5);       // exactly end — NOT active
    expect(events).toHaveLength(0);
  });

  it('begin==end slots are always-on and start as soon as the engine is wired', () => {
    const sky = new SkyboxRenderer(makeSkyDesc([
      skyObject({ beginTime: 0, endTime: 0, defaultGFXObjectId: 0x02000714, properties: 0 }),
    ]));
    sky.initSkyObjects(stubModelRenderer());
    const { events, engine } = recordingEngine();
    sky.setSetupScriptEngine(engine);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('start:');
    expect(events[0]).toContain('0x2000714');
  });

  it('weather-flagged (props&0x4) slots stop while weather is disabled and resume on enable', () => {
    const sky = new SkyboxRenderer(makeSkyDesc([
      skyObject({ beginTime: 0, endTime: 0, properties: 0xd }),
    ]));
    sky.initSkyObjects(stubModelRenderer());
    const { events, engine } = recordingEngine();
    sky.setSetupScriptEngine(engine);
    expect(events).toHaveLength(1); // started

    sky.setWeatherEnabled(false);
    expect(events).toHaveLength(2);
    expect(events[1]).toContain('stop:');

    sky.setWeatherEnabled(true);
    expect(events).toHaveLength(3);
    expect(events[2]).toContain('start:');
  });

  it('rebuildSkyObjects stops all active playbacks (retail CreateDeletePhysicsObjects)', () => {
    const sky = new SkyboxRenderer(makeSkyDesc([
      skyObject({ beginTime: 0, endTime: 0 }),
    ]));
    sky.initSkyObjects(stubModelRenderer());
    const { events, engine } = recordingEngine();
    sky.setSetupScriptEngine(engine);
    expect(events.filter(e => e.startsWith('start:'))).toHaveLength(1);

    sky.rebuildSkyObjects(stubModelRenderer());
    const stops = events.filter(e => e.startsWith('stop:'));
    expect(stops).toHaveLength(1);
    // The rebuilt (always-on) slot starts again on the fresh entry set.
    expect(events.filter(e => e.startsWith('start:'))).toHaveLength(2);
  });
});

describe('CORE.9.a: fog-override hide bit (props&0x2)', () => {
  function cloudBankSky() {
    // A scrolling before-sky cloud bank with the fog-hide bit, like the
    // Sunny groups' 0x1004c36 (props=0x2, texVel != 0).
    const sky = new SkyboxRenderer(makeSkyDesc([
      skyObject({ defaultGFXObjectId: 0x01004c36, properties: 0x2, texVelocityX: -0.013, texVelocityY: 0.013 }),
    ]));
    sky.initSkyObjects(stubModelRenderer());
    sky.updateTimeOfDay(0.3);
    const pivot = sky.skyObjectsGroup!.children[0] as THREE.Group;
    return { sky, pivot };
  }

  it('hides the cloud bank while the EnvironChange fog override is active', () => {
    const { sky, pivot } = cloudBankSky();
    expect(pivot.visible).toBe(true);
    sky.setEnvironOverride(RED_FOG);
    expect(pivot.visible).toBe(false);
    sky.setEnvironOverride(null);
    expect(pivot.visible).toBe(true);
  });

  it('does not hide objects without the 0x2 bit', () => {
    const sky = new SkyboxRenderer(makeSkyDesc([
      skyObject({ defaultGFXObjectId: 0x01004c42, properties: 0x4, texVelocityX: 0.02, texVelocityY: -2 }),
    ]));
    sky.initSkyObjects(stubModelRenderer());
    sky.updateTimeOfDay(0.3);
    const pivot = sky.skyObjectsGroup!.children[0] as THREE.Group;
    expect(pivot.visible).toBe(true);
    sky.setEnvironOverride(RED_FOG);
    expect(pivot.visible).toBe(true);
  });
});

describe('CORE.9.a: SoundTweaked hook volume reaches the sound player', () => {
  it('passes the hook volume as playPositionalSound volumeScale', () => {
    const calls: unknown[][] = [];
    const player = new PhysicsScriptPlayer({
      spellEffects: {} as never,
      soundPlayer: {
        playPositionalSound: (...args: unknown[]) => { calls.push(args); return Promise.resolve(); },
      } as never,
      loadEmitterInfo: () => null,
      getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
    });
    const hook: SoundTweakedHookData = {
      hookType: AnimationHookType.SoundTweaked, direction: 0,
      soundId: 0x0a00038b, priority: 1, probability: 1, volume: 0.35,
    };
    const script = { id: 0x33000428, steps: [{ startTime: 0, hook }] } as never;
    player.play(script, new THREE.Object3D());
    expect(calls).toHaveLength(1);
    // (waveId, pos, listener, category, volume)
    expect(calls[0][0]).toBe(0x0a00038b);
    expect(calls[0][4]).toBe(0.35);
  });
});

describe.skipIf(!hasPortalDat)('CORE.9.a: DAT ground truth — weather Setup script chains', () => {
  let db: DatDatabase;
  const setup = (id: number) => new SetupModel(new DatReader(db.getFileData(id)!));
  const script = (id: number) => PhysicsScript.read(new DatReader(db.getFileData(id)!));

  beforeAll(() => {
    const buf = readFileSync(PORTAL_DAT).buffer;
    db = new DatDatabase(buf as ArrayBuffer);
  });

  it('the Rainy day group timeline carries the documented Setup slots', () => {
    const rd = new RegionDesc(new DatReader(db.getFileData(0x13000000)!));
    expect(rd.skyInfo).not.toBeNull();
    const rainy = rd.skyInfo!.dayGroups.find(g => /rain/i.test(g.dayName)
      && g.skyObjects.some(o => o.defaultGFXObjectId === 0x02000ba6));
    expect(rainy).toBeDefined();
    const setups = rainy!.skyObjects.filter(o => ((o.defaultGFXObjectId >> 24) & 0xff) === 0x02);
    // 11 Setup slots: 3 thunder windows + 7 rain-loop crossfades + always-on.
    expect(setups.length).toBeGreaterThanOrEqual(11);
    // Thunder slots carry props 0xd and bounded windows.
    const thunder = setups.filter(o => o.defaultGFXObjectId === 0x02000ba6);
    expect(thunder.length).toBeGreaterThanOrEqual(3);
    for (const t of thunder) {
      expect(t.properties).toBe(0xd);
      expect(t.beginTime).not.toBe(t.endTime);
      expect(t.defaultPESObjectId).toBe(0x33000453);
    }
    // The always-on spawner is present with an unbounded window.
    const alwaysOn = setups.find(o => o.defaultGFXObjectId === 0x02000714);
    expect(alwaysOn).toBeDefined();
    expect(alwaysOn!.beginTime).toBe(alwaysOn!.endTime);
  });

  it('each weather Setup’s DefaultScript matches its timeline pes (the retail playback path)', () => {
    // pes_id is written but never read in the EoL client (SkyDesc::GetSky
    // fills CelestialPosition.pes_id; no consumer) — playback comes from
    // CPhysicsObj::makeObject → InitDefaults playing Setup.DefaultScript,
    // and the DAT keeps the two in sync.
    expect(setup(0x02000588).defaultScript).toBe(0x33000428);
    expect(setup(0x02000589).defaultScript).toBe(0x3300042c);
    expect(setup(0x02000ba6).defaultScript).toBe(0x33000453);
    expect(setup(0x02000714).defaultScript).toBe(0x330007db);
  });

  it('the ambient rain loops ping-pong via CallPES every 2.8s at DAT volumes', () => {
    const a = script(0x33000428);
    const b = script(0x33000429);
    const soundA = a.steps[0].hook as SoundTweakedHookData;
    expect(soundA.hookType).toBe(AnimationHookType.SoundTweaked);
    expect(soundA.soundId).toBe(0x0a00038b);
    expect(soundA.volume).toBeCloseTo(0.35, 5);
    const callA = a.steps[1].hook as CallPESHookData;
    expect(callA.hookType).toBe(AnimationHookType.CallPES);
    expect(a.steps[1].startTime).toBeCloseTo(2.8, 5);
    expect(callA.pes).toBe(0x33000429);
    const callB = b.steps[1].hook as CallPESHookData;
    expect(callB.pes).toBe(0x33000428); // ping-pong back
    // The quiet variant plays the same wave at 0.10.
    const quiet = script(0x3300042c).steps[0].hook as SoundTweakedHookData;
    expect(quiet.soundId).toBe(0x0a00038b);
    expect(quiet.volume).toBeCloseTo(0.10, 5);
  });

  it('the thunder cycle self-loops every 30s with probabilistic claps + a lightning flash', () => {
    const ps = script(0x33000453);
    const selfCall = ps.steps.find(s => s.hook?.hookType === AnimationHookType.CallPES);
    expect(selfCall).toBeDefined();
    expect((selfCall!.hook as CallPESHookData).pes).toBe(0x33000453); // self
    expect((selfCall!.hook as CallPESHookData).pause).toBe(30);
    const flash = ps.steps.find(s => s.hook?.hookType === AnimationHookType.CreateParticle);
    expect(flash).toBeDefined();
    const claps = ps.steps.filter(s => s.hook?.hookType === AnimationHookType.SoundTweaked);
    expect(claps.length).toBeGreaterThanOrEqual(8);
    for (const c of claps) {
      const d = c.hook as SoundTweakedHookData;
      expect(d.probability).toBeLessThanOrEqual(0.5); // probabilistic, not certain
    }
  });
});
