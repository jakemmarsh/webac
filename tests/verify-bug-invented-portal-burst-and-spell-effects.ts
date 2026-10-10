/**
 * BUG.invented-portal-burst-and-spell-effects (2026-09-28).
 *
 * PortalEffect.createEntryExitBurst (a THREE.Points burst on every
 * PlayerTeleport and at every teleport destination), the SpellEffects
 * create* layer (impact flash, weapon impact, crit burst, shield block,
 * resist sparkle, fake projectiles) and ServerObjectManager's hit flash /
 * recoil were client inventions. What retail plays instead:
 *
 *  - teleport / login: the object's OWN PhysicsScriptTable, via
 *    CPhysicsObj::set_state @ 00514dd0 → set_hidden @ 00514c60 — Hidden
 *    (0x76) when PhysicsState Hidden sets, UnHide (0x75) when it clears — plus
 *    the server's Hide PlayScript (ACE Player_Location.cs:713);
 *  - a melee hit: the server's Splatter* PlayScript (Player_Combat.cs:175);
 *  - an evade: nothing.
 *
 * Drives the real HiddenStateScripts / ServerObjectManager / PlayScriptResolve
 * and, with the DAT, the human table's teleport scripts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import { PhysicsState, PlayScript } from '@ac/shared';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { PhysicsScript, PhysicsScriptTable } from '@ac/dat-parser/file-types/PhysicsScript.js';
import { AnimationHookType } from '@ac/dat-parser/file-types/AnimationHook.js';
import { hiddenEdgeScript, PHYSICS_STATE_CTOR_DEFAULT } from '../packages/renderer/src/effects/HiddenStateScripts.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { SpellEffects } from '../packages/renderer/src/effects/SpellEffects.js';
import { playScriptType, type PlayScriptSink } from '../packages/renderer/src/effects/PlayScriptResolve.js';
import { openDat } from './_harness/dat.js';

describe('set_hidden edge scripts (CPhysicsObj::set_state @ 00514dd0 → set_hidden @ 00514c60)', () => {
  it('Hidden setting plays Hidden (0x76), clearing plays UnHide (0x75), anything else nothing', () => {
    expect(PlayScript.Hidden).toBe(0x76);
    expect(PlayScript.UnHide).toBe(0x75);
    expect(hiddenEdgeScript(0, PhysicsState.Hidden)).toBe(PlayScript.Hidden);
    expect(hiddenEdgeScript(PhysicsState.Hidden | PhysicsState.Gravity, PhysicsState.Gravity)).toBe(PlayScript.UnHide);
    expect(hiddenEdgeScript(PhysicsState.Hidden, PhysicsState.Hidden | PhysicsState.IgnoreCollisions)).toBeNull();
    expect(hiddenEdgeScript(0, PhysicsState.NoDraw)).toBeNull();
  });

  it('the ctor default state carries no Hidden bit — an object created Hidden plays Hidden', () => {
    expect(PHYSICS_STATE_CTOR_DEFAULT & PhysicsState.Hidden).toBe(0);
    expect(hiddenEdgeScript(PHYSICS_STATE_CTOR_DEFAULT, PhysicsState.Hidden | PhysicsState.IgnoreCollisions)).toBe(PlayScript.Hidden);
  });
});

describe('ServerObjectManager fires the Hidden / UnHide scripts on the state edge', () => {
  const data = (guid: number, physicsState: number) => ({
    guid, name: 'Traveller', weenieClassId: 1, itemType: 0x10, position: null, setupId: 0x02000001,
    motionTableId: 0, iconId: 0, physicsState, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
    wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
    maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
    velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0,
    defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  function som() {
    const setupModelRenderer = {
      createSetupMeshWithOverrides: () => new THREE.Group().add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())),
      loadSetupModel: () => null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = new ServerObjectManager(setupModelRenderer as any, { loadPaletteColors: () => null } as any, new THREE.Scene());
    const played: Array<[number, number]> = [];
    m.onHiddenStateScript = (guid, script) => { played.push([guid, script]); };
    return { m, played };
  }

  it('a teleport: Hidden set, then cleared — Hidden then UnHide, once each', () => {
    const { m, played } = som();
    m.createObject(data(0x50000002, PhysicsState.Gravity));
    expect(played).toEqual([]);
    m.setPhysicsState(0x50000002, PhysicsState.Gravity | PhysicsState.Hidden | PhysicsState.IgnoreCollisions, 1);
    m.setPhysicsState(0x50000002, PhysicsState.Gravity | PhysicsState.Hidden | PhysicsState.IgnoreCollisions, 2);
    m.setPhysicsState(0x50000002, PhysicsState.Gravity | PhysicsState.ReportCollisions, 3);
    expect(played).toEqual([[0x50000002, PlayScript.Hidden], [0x50000002, PlayScript.UnHide]]);
  });

  it('an object arriving Hidden (a player logging in: ACE Player.cs:134) plays Hidden at creation', () => {
    const { m, played } = som();
    m.createObject(data(0x50000003, PhysicsState.Hidden | PhysicsState.IgnoreCollisions));
    expect(played).toEqual([[0x50000003, PlayScript.Hidden]]);
  });

  it('a stale SetState (older sequence) plays nothing', () => {
    const { m, played } = som();
    m.createObject(data(0x50000004, 0));
    m.setPhysicsState(0x50000004, 0, 10);
    m.setPhysicsState(0x50000004, PhysicsState.Hidden, 9);
    expect(played).toEqual([]);
  });
});

describe('the invented effect layer is gone', () => {
  it('SpellEffects runs DAT emitters only', () => {
    const names = Object.getOwnPropertyNames(SpellEffects.prototype);
    for (const gone of ['spawnProjectile', 'spawnParticleBurst', 'createImpactFlash', 'createWeaponImpact',
      'createShieldBlock', 'createCriticalHit', 'createResistSparkle']) {
      expect(names).not.toContain(gone);
    }
    expect(names).toContain('spawnParticleEffect');
  });

  it('ServerObjectManager has no hit flash / recoil', () => {
    expect((ServerObjectManager.prototype as unknown as Record<string, unknown>).flashHitIndicator).toBeUndefined();
    expect((ServerObjectManager.prototype as unknown as Record<string, unknown>).playHitRecoil).toBeUndefined();
  });

  it('PortalEffect (createEntryExitBurst) no longer exists', async () => {
    await expect(import('../packages/renderer/src/effects/' + 'PortalEffect.js')).rejects.toThrow();
  });
});

const hasDat = fs.existsSync('dat/client_portal.dat');

describe.skipIf(!hasDat)('DAT: the human table 0x34000004 carries the teleport effect', () => {
  let portal: DatDatabase;
  let table: PhysicsScriptTable;
  const script = (id: number) => PhysicsScript.read(new DatReader(portal.getFileData(id)!));
  beforeAll(() => {
    portal = openDat('dat/client_portal.dat');
    table = PhysicsScriptTable.read(new DatReader(portal.getFileData(0x34000004)!));
  });

  it('Hide / UnHide / Hidden resolve to 0x33000332 / 0x3300032F / 0x33000331', () => {
    const sink = (played: number[]): PlayScriptSink<string> => ({
      target: () => ({ anchor: 'player', peTableId: 0x34000004, setupId: 0 }),
      loadTable: () => table,
      setupScriptTable: () => 0,
      loadScript: (id) => (portal.getFileData(id) ? script(id) : null),
      play: () => { played.push(1); },
    });
    const played: number[] = [];
    expect(playScriptType(sink(played), 1, PlayScript.Hide, 1.0)).toMatchObject({ played: true, scriptId: 0x33000332 });
    expect(playScriptType(sink(played), 1, PlayScript.UnHide, 1.0)).toMatchObject({ played: true, scriptId: 0x3300032f });
    expect(playScriptType(sink(played), 1, PlayScript.Hidden, 1.0)).toMatchObject({ played: true, scriptId: 0x33000331 });
    expect(played).toHaveLength(3);
  });

  it('Hidden builds the 14 bubble emitters (13 parts + the root); UnHide stops every one and fades back in', () => {
    const hidden = script(0x33000331).steps.map((s) => s.hook as unknown as { hookType: number; emitterId?: number; emitterInfoId?: number; end?: number });
    const unhide = script(0x3300032f).steps.map((s) => s.hook as unknown as { hookType: number; emitterId?: number; start?: number; end?: number; time?: number });
    const created = hidden.filter((h) => h.hookType === AnimationHookType.CreateParticle);
    expect(created).toHaveLength(14);
    expect(new Set(created.map((h) => h.emitterInfoId))).toEqual(new Set([0x3200028b, 0x3200028c]));
    const stopped = unhide.filter((h) => h.hookType === AnimationHookType.StopParticle).map((h) => h.emitterId).sort();
    expect(stopped).toEqual(created.map((h) => h.emitterId).sort());
    expect(unhide.find((h) => h.hookType === AnimationHookType.Transparent)).toMatchObject({ start: 1, end: 0, time: 0.75 });
  });
});
