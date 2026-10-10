/**
 * BUG.sky-emitters-fog-on-environs — GameSky::Draw @ 00506ff0 draws the sky
 * cell's objects (and their particle emitters) with
 * `RenderDeviceD3D::SetFFFogEnable(LScape::m_override_enabled != false)`:
 * unfogged normally, fogged while an AdminEnvirons fog override is up. Our
 * sky emitters were created with fog off and stayed that way.
 * D3DPolyRender::SetSurface @ 0059c4d0 keeps fog off for an Additive
 * (0x10000) surface — and every EoL sky emitter is Additive (pinned below),
 * so on the EoL DATs the emitters look the same under the override; the sky
 * OBJECTS' non-additive surfaces (the sky box, clouds) are what fog.
 *
 * Drives the real PhysicsScriptPlayer + SpellEffects + ParticleSystem and
 * SkyboxRenderer.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { PhysicsScriptPlayer } from '../packages/renderer/src/effects/PhysicsScriptPlayer.js';
import { SpellEffects } from '../packages/renderer/src/effects/SpellEffects.js';
import { AnimationHookType } from '../packages/dat-parser/src/file-types/AnimationHook.js';
import type { PhysicsScript, ParticleEmitterInfo } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

function emitterInfo(id: number): ParticleEmitterInfo {
  return {
    id, emitterType: 1, particleType: 9, gfxObjId: 0, hwGfxObjId: 0x01002061,
    birthrate: 0.5, maxParticles: 4, initialParticles: 2, totalParticles: 0, totalSeconds: 0,
    lifespan: 10, lifespanRand: 0, offsetDir: { x: 0, y: 0, z: 1 }, minOffset: 0, maxOffset: 0,
    a: { x: 0, y: 0, z: 0 }, minA: 0, maxA: 0, b: { x: 0, y: 0, z: 0 }, minB: 0, maxB: 0,
    c: { x: 0, y: 0, z: 0 }, minC: 0, maxC: 0, startScale: 1, finalScale: 1, scaleRand: 0,
    startTrans: 0, finalTrans: 0, transRand: 0, isParentLocal: 0, sortingSphereRadius: 1,
  } as never;
}

const script = (emitterInfoId: number): PhysicsScript => ({
  id: 0x33000001,
  steps: [{
    startTime: 0,
    hook: {
      hookType: AnimationHookType.CreateParticle, direction: 0, emitterInfoId, partIndex: 0,
      offset: { origin: { x: 0, y: 0, z: 250 }, orientation: { w: 1, x: 0, y: 0, z: 0 } }, emitterId: 0,
    },
  }],
}) as never;

function setup() {
  const scene = new THREE.Scene();
  const effects = new SpellEffects(scene);
  const player = new PhysicsScriptPlayer({
    spellEffects: effects,
    soundPlayer: { playPositionalSound: vi.fn().mockResolvedValue(undefined) } as never,
    loadEmitterInfo: (id: number) => emitterInfo(id) as never,
    getListenerPos: () => ({ x: 0, y: 0, z: 0 }),
  } as never);
  const sky = new THREE.Group();
  sky.userData.skyTracked = true;
  scene.add(sky);
  const ground = new THREE.Group();
  scene.add(ground);
  return { scene, effects, player, sky, ground };
}

const fogOf = (scene: THREE.Scene, name: string): boolean[] => {
  const obj = scene.getObjectByName(name);
  expect(obj).toBeTruthy();
  const out: boolean[] = [];
  obj!.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(((o as THREE.Mesh).material as THREE.MeshLambertMaterial).fog); });
  expect(out.length).toBeGreaterThan(0);
  return out;
};

describe('sky emitters take the Environs fog override (GameSky::Draw @ 00506ff0)', () => {
  it('unfogged normally; fogged while the override is up; unfogged again when it clears', () => {
    const { scene, player, sky } = setup();
    player.play(script(0x32000455), sky);
    expect(player.skyEmitters.size).toBe(1);
    expect(fogOf(scene, 'particles_32000455')).toEqual([false]);

    player.setSkyFogOverride(true);
    expect(player.skyFogOverrideActive).toBe(true);
    expect(fogOf(scene, 'particles_32000455')).toEqual([true]);

    player.setSkyFogOverride(false);
    expect(fogOf(scene, 'particles_32000455')).toEqual([false]);
  });

  it('a sky emitter born during the override starts fogged', () => {
    const { scene, player, sky } = setup();
    player.setSkyFogOverride(true);
    player.play(script(0x32000456), sky);
    expect(fogOf(scene, 'particles_32000456')).toEqual([true]);
  });

  it('world emitters are untouched by the sky override (they are always in the scene fog)', () => {
    const { scene, player, ground } = setup();
    player.play(script(0x32000457), ground);
    expect(player.skyEmitters.size).toBe(0);
    expect(fogOf(scene, 'particles_32000457')).toEqual([true]);
    player.setSkyFogOverride(true);
    player.setSkyFogOverride(false);
    expect(fogOf(scene, 'particles_32000457')).toEqual([true]);
  });

  it('a stopped sky emitter leaves the set', () => {
    const { player, sky } = setup();
    player.play(script(0x32000455), sky);
    expect(player.skyEmitters.size).toBe(1);
    player.stopForAnchor(sky);
    expect(player.skyEmitters.size).toBe(0);
  });
});

function skyWith(gfxIds: number[]) {
  const skyTime = (begin: number) => ({
    begin, dirBright: 1, dirHeading: 0, dirPitch: 45, dirColor: 0xffffffff, ambBright: 0.5, ambColor: 0xffffffff,
    minWorldFog: 0, maxWorldFog: 1000, worldFogColor: 0xffffffff, worldFog: 0, skyObjReplace: [],
  });
  return {
    tickSize: 30, lightTickSize: 30,
    dayGroups: [{
      chanceOfOccur: 5, dayName: 'Sunny',
      skyObjects: gfxIds.map((id) => ({
        beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0, texVelocityX: 0, texVelocityY: 0,
        defaultGFXObjectId: id, defaultPESObjectId: 0, properties: 0,
      })),
      skyTime: [skyTime(0), skyTime(0.5)],
    }],
  } as never;
}

describe('sky objects take the Environs fog override too, except Additive surfaces', () => {
  it('a normal sky surface fogs under the override; a DAT-Additive one never does', async () => {
    const { SkyboxRenderer } = await import('../packages/renderer/src/effects/SkyboxRenderer.js');
    const sky = new SkyboxRenderer(skyWith([0x01000001, 0x01000002]));
    const RED_FOG = { fogColor: 0x960000, fogMin: 0, fogMax: 50, ambientColor: 0x960000, ambientLevel: 0.4 };
    const modelRenderer = {
      createMesh: (id: number) => {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({
          blending: id === 0x01000002 ? THREE.AdditiveBlending : THREE.NormalBlending,
        })));
        return g;
      },
    };
    sky.initSkyObjects(modelRenderer as never);
    const fogOfObj = (gfx: string): boolean[] => {
      const out: boolean[] = [];
      sky.skyObjectsGroup!.getObjectByName(`sky_obj_${gfx === '0x01000001' ? 0 : 1}_${gfx}`)!.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) out.push(((o as THREE.Mesh).material as THREE.MeshBasicMaterial).fog);
      });
      return out;
    };
    expect(fogOfObj('0x01000001')).toEqual([false]);
    expect(fogOfObj('0x01000002')).toEqual([false]);
    sky.setEnvironOverride(RED_FOG);
    expect(fogOfObj('0x01000001')).toEqual([true]);
    expect(fogOfObj('0x01000002')).toEqual([false]);
    sky.setEnvironOverride(null);
    expect(fogOfObj('0x01000001')).toEqual([false]);
  });
});

const PORTAL = new URL('../dat/client_portal.dat', import.meta.url).pathname;

describe.skipIf(!existsSync(PORTAL))('EoL DAT: every sky emitter is Additive, so the override leaves them visibly unchanged', () => {
  it('the sky Setups\' scripts create four emitters (0x32000455/56/57, 0x320002c2), all on Additive surfaces', async () => {
    const { DatDatabase, DatReader, PhysicsScript, RegionDesc, SetupModel, GfxObj, ParticleEmitterInfo } = await import('@ac/dat-parser');
    const { Surface, SurfaceType } = await import('../packages/dat-parser/src/file-types/Surface.js');
    const portal = openDat(PORTAL);
    const region = new RegionDesc(new DatReader(portal.getFileData(0x13000000)!));
    const scripts = new Set<number>();
    for (const g of region.skyInfo!.dayGroups) {
      for (const o of g.skyObjects) {
        if ((o.defaultGFXObjectId >>> 24) !== 2) continue;
        const setup = new SetupModel(new DatReader(portal.getFileData(o.defaultGFXObjectId)!));
        if (setup.defaultScript) scripts.add(setup.defaultScript >>> 0);
      }
    }
    const seen = new Set<number>();
    const emitters = new Set<number>();
    const walk = (id: number): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const d = portal.getFileData(id);
      if (!d) return;
      for (const st of PhysicsScript.read(new DatReader(d)).steps) {
        const h = st.hook as unknown as { emitterInfoId?: number; pesObjectId?: number } | null;
        if (h?.emitterInfoId) emitters.add(h.emitterInfoId >>> 0);
        if (h?.pesObjectId) walk(h.pesObjectId >>> 0);
      }
    };
    for (const s of scripts) walk(s);
    expect([...emitters].sort()).toEqual([0x320002c2, 0x32000455, 0x32000456, 0x32000457]);
    for (const e of emitters) {
      const info = new ParticleEmitterInfo(new DatReader(portal.getFileData(e)!));
      const gfx = new GfxObj(new DatReader(portal.getFileData(info.hwGfxObjId)!));
      for (const sid of gfx.surfaces) {
        const surf = Surface.read(new DatReader(portal.getFileData(sid)!));
        expect(surf.type & SurfaceType.Additive).not.toBe(0);
      }
    }
  });
});
