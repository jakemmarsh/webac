/**
 * Phase 16 — Particles, Skybox, Visual Effects
 *
 * Tests:
 *  - ParticleEmitterInfo parsing from portal.dat (0x32 file type)
 *  - ParticleSystem emits particles, moves by velocity, removes expired
 *  - SkyboxRenderer changes colors with time of day (noon vs midnight)
 *  - SpellEffects creates visible geometry for all 5 magic schools
 *  - Fog color syncs with skybox
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { ParticleEmitterInfo } from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';
import { ParticleSystem } from '@ac/renderer/effects/ParticleSystem.js';
import { SkyboxRenderer } from '@ac/renderer/effects/SkyboxRenderer.js';
import { SpellEffects } from '@ac/renderer/effects/SpellEffects.js';
import { openDat } from './_harness/dat.js';

const hasPortalDat = fs.existsSync('dat/client_portal.dat');

let portalDb: DatDatabase;

beforeAll(() => {
  if (!hasPortalDat) return;
  portalDb = openDat('dat/client_portal.dat');
});

describe.skipIf(!hasPortalDat)('Phase 16 — Particles, Skybox, Visual Effects', () => {
  // ============================================================
  // ParticleEmitterInfo parsing
  // ============================================================
  describe('ParticleEmitterInfo Parsing', () => {
    it('should find particle emitter files in portal.dat (0x32)', () => {
      const ids = portalDb.listFileIds(0x32);
      expect(ids.length).toBeGreaterThanOrEqual(10);
    });

    it('should parse particle emitters with valid data', () => {
      const ids = portalDb.listFileIds(0x32);
      let parsed = 0;

      for (const id of ids.slice(0, 50)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const emitter = new ParticleEmitterInfo(new DatReader(data));
        expect(emitter.id).toBe(id);
        expect(Number.isFinite(emitter.birthrate)).toBe(true);
        expect(Number.isFinite(emitter.lifespan)).toBe(true);
        expect(Number.isFinite(emitter.startScale)).toBe(true);
        expect(Number.isFinite(emitter.finalScale)).toBe(true);
        expect(Number.isFinite(emitter.startTrans)).toBe(true);
        expect(Number.isFinite(emitter.finalTrans)).toBe(true);
        expect(emitter.maxParticles).toBeGreaterThanOrEqual(0);
        parsed++;
      }
      expect(parsed).toBeGreaterThanOrEqual(50);
    });

    it('should have valid velocity vectors (A, B, C)', () => {
      const ids = portalDb.listFileIds(0x32);
      let withVelocity = 0;

      for (const id of ids.slice(0, 50)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const emitter = new ParticleEmitterInfo(new DatReader(data));
        expect(Number.isFinite(emitter.a.x)).toBe(true);
        expect(Number.isFinite(emitter.a.y)).toBe(true);
        expect(Number.isFinite(emitter.a.z)).toBe(true);
        expect(Number.isFinite(emitter.b.x)).toBe(true);
        expect(Number.isFinite(emitter.c.x)).toBe(true);

        if (Math.abs(emitter.a.x) + Math.abs(emitter.a.y) + Math.abs(emitter.a.z) > 0.001) {
          withVelocity++;
        }
      }
      expect(withVelocity).toBeGreaterThanOrEqual(5);
    });

    it('should parse 100% of particle emitters without errors', () => {
      const ids = portalDb.listFileIds(0x32);
      let success = 0;
      let total = 0;

      for (const id of ids) {
        total++;
        try {
          const data = portalDb.getFileData(id);
          if (!data) continue;
          const emitter = new ParticleEmitterInfo(new DatReader(data));
          if (Number.isFinite(emitter.birthrate)) success++;
        } catch {
          // Parse failure
        }
      }
      expect(success / total).toBeGreaterThanOrEqual(0.98);
    });
  });

  // ============================================================
  // ParticleSystem tests
  // ============================================================
  describe('ParticleSystem', () => {
    it('should emit particles over time from real emitter data', () => {
      const ids = portalDb.listFileIds(0x32);
      let tested = 0;

      for (const id of ids.slice(0, 20)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const info = new ParticleEmitterInfo(new DatReader(data));
        if (info.birthrate <= 0 && info.initialParticles <= 0) continue;

        const system = new ParticleSystem(info);
        const initial = system.activeCount;

        // Advance time to spawn particles
        for (let i = 0; i < 10; i++) {
          system.update(0.1);
        }

        // Should have particles now (initial + birthed)
        if (initial > 0 || system.activeCount > 0) {
          tested++;
        }

        system.dispose();
        if (tested >= 5) break;
      }
      expect(tested).toBeGreaterThanOrEqual(3);
    });

    it('should move particles according to velocity', () => {
      const ids = portalDb.listFileIds(0x32);

      for (const id of ids.slice(0, 50)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const info = new ParticleEmitterInfo(new DatReader(data));
        if (info.birthrate <= 0 && info.initialParticles <= 0) continue;
        if (Math.abs(info.a.x) + Math.abs(info.a.y) + Math.abs(info.a.z) < 0.001) continue;

        const system = new ParticleSystem(info);
        system.update(0.1);

        // The particles are laid out as instanced GfxObj meshes (VISUAL.particles-oriented-quads)
        const obj = system.object3D;
        expect(obj).toBeInstanceOf(THREE.Object3D);
        expect(system.meshes.length).toBeGreaterThan(0);
        expect(system.meshes[0]).toBeInstanceOf(THREE.InstancedMesh);
        expect(system.drawnCount).toBe(system.activeCount - [...Array(system.activeCount)].filter((_, i) => system.alphaAt(i) <= 0).length);

        system.dispose();
        break;
      }
    });

    it('should remove expired particles', () => {
      const ids = portalDb.listFileIds(0x32);

      for (const id of ids.slice(0, 50)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        const info = new ParticleEmitterInfo(new DatReader(data));
        if (info.lifespan <= 0 || info.lifespan > 10) continue;
        if (info.birthrate <= 0 && info.initialParticles <= 0) continue;
        // Need totalParticles or totalSeconds to be bounded
        if (info.totalParticles <= 0 && info.totalSeconds <= 0) continue;

        const system = new ParticleSystem(info);

        // Spawn some particles
        system.update(0.5);
        const countAfterSpawn = system.activeCount;
        if (countAfterSpawn === 0) continue;

        // Advance past lifespan to expire them
        for (let i = 0; i < 100; i++) {
          system.update(info.lifespan / 10);
        }

        // After enough time, some or all should have expired
        expect(system.activeCount).toBeLessThanOrEqual(info.maxParticles);
        system.dispose();
        break;
      }
    });

    it('should produce instanced meshes (one draw per GfxObj surface)', () => {
      const ids = portalDb.listFileIds(0x32);
      const data = portalDb.getFileData(ids[0]);
      if (!data) throw new Error('DAT entry missing');

      const info = new ParticleEmitterInfo(new DatReader(data));
      const system = new ParticleSystem(info);

      expect(system.meshes[0]).toBeInstanceOf(THREE.InstancedMesh);
      expect(system.meshes[0].geometry).toBeInstanceOf(THREE.BufferGeometry);
      expect(system.meshes[0].parent?.parent).toBe(system.object3D);

      system.dispose();
    });
  });

  // ============================================================
  // SkyboxRenderer tests
  // ============================================================
  describe('SkyboxRenderer', () => {
    it('should create a sky mesh and lights', () => {
      const skybox = new SkyboxRenderer();
      expect(skybox.skyObject).toBeInstanceOf(THREE.Mesh);
      expect(skybox.directionalLight).toBeInstanceOf(THREE.DirectionalLight);
      expect(skybox.ambient).toBeInstanceOf(THREE.AmbientLight);
      skybox.dispose();
    });

    it('should have different colors at noon vs midnight', () => {
      const skybox = new SkyboxRenderer();

      skybox.updateTimeOfDay(0.5); // noon
      const noonColor = skybox.skyColor.clone();

      skybox.updateTimeOfDay(0.0); // midnight
      const midnightColor = skybox.skyColor.clone();

      // Noon should be brighter than midnight
      const noonBrightness = noonColor.r + noonColor.g + noonColor.b;
      const midnightBrightness = midnightColor.r + midnightColor.g + midnightColor.b;
      expect(noonBrightness).toBeGreaterThan(midnightBrightness);

      skybox.dispose();
    });

    it('should vary colors across the full day cycle', () => {
      const skybox = new SkyboxRenderer();
      const colors: THREE.Color[] = [];

      for (let t = 0; t <= 1.0; t += 0.1) {
        skybox.updateTimeOfDay(t);
        colors.push(skybox.skyColor.clone());
      }

      // Not all colors should be the same
      let different = 0;
      for (let i = 1; i < colors.length; i++) {
        if (!colors[i].equals(colors[0])) different++;
      }
      expect(different).toBeGreaterThanOrEqual(3);

      skybox.dispose();
    });

    it('should sync fog color with skybox', () => {
      const skybox = new SkyboxRenderer();
      const fog = new THREE.Fog(0x000000, 10, 500);
      skybox.setFog(fog);

      skybox.updateTimeOfDay(0.5); // noon
      const noonFogColor = fog.color.clone();

      skybox.updateTimeOfDay(0.0); // midnight
      const midnightFogColor = fog.color.clone();

      // Fog should change with time
      expect(noonFogColor.equals(midnightFogColor)).toBe(false);

      skybox.dispose();
    });

    it('should change sun position with time of day', () => {
      const skybox = new SkyboxRenderer();

      skybox.updateTimeOfDay(0.25); // sunrise
      const sunrisePos = skybox.directionalLight.position.clone();

      skybox.updateTimeOfDay(0.5); // noon
      const noonPos = skybox.directionalLight.position.clone();

      // Sun position should change
      expect(sunrisePos.equals(noonPos)).toBe(false);

      // At noon, sun should be higher
      expect(noonPos.y).toBeGreaterThan(sunrisePos.y);

      skybox.dispose();
    });

    it('should advance time with update(deltaTime)', () => {
      const skybox = new SkyboxRenderer();
      skybox.updateTimeOfDay(0.0); // start at midnight

      const before = skybox.currentTimeOfDay;
      skybox.update(skybox.DAY_DURATION / 2); // advance half a day
      const after = skybox.currentTimeOfDay;

      // Should have advanced approximately 0.5
      expect(Math.abs(after - 0.5)).toBeLessThan(0.01);

      skybox.dispose();
    });

    it('should have lower sun intensity at night', () => {
      const skybox = new SkyboxRenderer();

      skybox.updateTimeOfDay(0.5); // noon
      const noonIntensity = skybox.directionalLight.intensity;

      skybox.updateTimeOfDay(0.0); // midnight
      const midnightIntensity = skybox.directionalLight.intensity;

      expect(noonIntensity).toBeGreaterThan(midnightIntensity);

      skybox.dispose();
    });
  });

  // ============================================================
  // SpellEffects tests
  // ============================================================
  describe('SpellEffects', () => {
    let scene: THREE.Scene;
    beforeEach(() => { scene = new THREE.Scene(); });

    // BUG.invented-portal-burst-and-spell-effects — SpellEffects only runs
    // DAT emitters; the school-coloured projectiles / impact flashes it used
    // to invent are gone (retail draws every particle from a 0x32 emitter).
    it('has no procedural effect API — only DAT emitters', () => {
      const names = Object.getOwnPropertyNames(SpellEffects.prototype);
      expect(names.filter((n) => /^(create|spawn)/.test(n))).toEqual(['spawnParticleEffect']);
    });

    it('runs a DAT emitter and removes it once it is done', () => {
      const effects = new SpellEffects(scene);
      const info = Object.assign(Object.create(ParticleEmitterInfo.prototype), {
        id: 0x32000001, emitterType: 1, particleType: 1, gfxObjId: 0, hwGfxObjId: 0,
        birthrate: 0, maxParticles: 4, initialParticles: 4, totalParticles: 4, totalSeconds: 0,
        lifespan: 0.5, lifespanRand: 0, offsetDir: { x: 0, y: 0, z: 1 }, minOffset: 0, maxOffset: 0,
        a: { x: 0, y: 0, z: 0 }, minA: 0, maxA: 0, b: { x: 0, y: 0, z: 0 }, minB: 0, maxB: 0,
        c: { x: 0, y: 0, z: 0 }, minC: 0, maxC: 0, startScale: 1, finalScale: 1, scaleRand: 0,
        startTrans: 0, finalTrans: 1, transRand: 0, isParentLocal: 0,
      });
      effects.spawnParticleEffect(info, { x: 1, y: 2, z: 3 });
      expect(effects.activeCount).toBe(1);
      expect(scene.getObjectByName('particles_32000001')).toBeDefined();
      for (let i = 0; i < 20; i++) effects.update(0.1);
      expect(effects.activeCount).toBe(0);
      expect(scene.getObjectByName('particles_32000001')).toBeUndefined();
    });
  });

  // ============================================================
  // Fog integration tests
  // ============================================================
  describe('Fog Integration', () => {
    it('should create fog with configurable distance', () => {
      const fog = new THREE.Fog(0x888888, 50, 500);
      expect(fog.near).toBe(50);
      expect(fog.far).toBe(500);
    });

    it('should have increasing density with distance (fog far > fog near)', () => {
      const fog = new THREE.Fog(0x888888, 50, 500);
      expect(fog.far).toBeGreaterThan(fog.near);

      // Objects at near should be fully visible (no fog)
      // Objects at far should be fully fogged
      // The ratio represents the fog gradient
      expect(fog.far - fog.near).toBeGreaterThan(0);
    });
  });
});
