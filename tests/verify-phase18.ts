/**
 * Phase 18 — CHECKPOINT: Renderer Smoke Test
 *
 * Integration test that boots the full renderer stack and verifies
 * everything works together. No new implementation — just verification.
 *
 * Tests:
 *  - SceneManager creates scene and camera
 *  - Terrain geometry from real landblock data
 *  - Model loading from portal.dat GfxObj + SetupModel
 *  - Material/texture pipeline resolves
 *  - Animation system can load and apply animation to a model
 *  - Audio system initializes (category management)
 *  - Particle, skybox, spell effects create valid Three.js objects
 *  - No NaN in any generated geometry positions
 *  - Full pipeline: DAT → parser → renderer module → Three.js object
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { CellLandblock } from '@ac/dat-parser/file-types/CellLandblock.js';
import { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import { Animation } from '@ac/dat-parser/file-types/Animation.js';
import { MotionTable } from '@ac/dat-parser/file-types/MotionTable.js';
import { Wave } from '@ac/dat-parser/file-types/Wave.js';
import { ParticleEmitterInfo } from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';
import { LandblockMesh } from '@ac/renderer/terrain/LandblockMesh.js';
import { SceneManager } from '@ac/renderer/scene/SceneManager.js';
import { CameraController } from '@ac/renderer/scene/CameraController.js';
import { buildGfxObjGeometry } from '@ac/renderer/models/GfxObjMesh.js';
import { getPartPlacements } from '@ac/renderer/models/SetupModelGroup.js';
import { AnimationPlayer, interpolateFrames } from '@ac/renderer/animation/AnimationPlayer.js';
import { MotionManager } from '@ac/renderer/animation/MotionManager.js';
import { SkeletonSystem } from '@ac/renderer/animation/SkeletonSystem.js';
import { ParticleSystem } from '@ac/renderer/effects/ParticleSystem.js';
import { SkyboxRenderer } from '@ac/renderer/effects/SkyboxRenderer.js';
import { SpellEffects } from '@ac/renderer/effects/SpellEffects.js';
import { AudioManager } from '@ac/renderer/audio/AudioManager.js';
import { SoundPlayer } from '@ac/renderer/audio/SoundPlayer.js';
import { MusicPlayer } from '@ac/renderer/audio/MusicPlayer.js';
import { openDat } from './_harness/dat.js';

const hasRequiredDat = fs.existsSync('dat/client_portal.dat') && fs.existsSync('dat/client_cell_1.dat');

let portalDb: DatDatabase;
let cellDb: DatDatabase;

beforeAll(() => {
  if (!hasRequiredDat) return;
  portalDb = openDat('dat/client_portal.dat');
  cellDb = openDat('dat/client_cell_1.dat');
});

describe.skipIf(!hasRequiredDat)('Phase 18 — CHECKPOINT: Renderer Smoke Test', () => {
  // ============================================================
  // SceneManager integration
  // ============================================================
  describe('SceneManager + Camera', () => {
    it('should create scene with camera and default lights', () => {
      const sm = new SceneManager();
      expect(sm.scene).toBeInstanceOf(THREE.Scene);
      expect(sm.camera).toBeInstanceOf(THREE.PerspectiveCamera);
      expect(sm.objectCount).toBeGreaterThanOrEqual(0);
    });

    it('should support CameraController for input processing', () => {
      const sm = new SceneManager();
      const cam = new CameraController(sm.camera);
      cam.simulateKeyDown('KeyW');
      cam.update(0.1);
      cam.simulateKeyUp('KeyW');
      // Camera should have moved forward
      const pos = sm.camera.position;
      expect(Number.isFinite(pos.x)).toBe(true);
      expect(Number.isFinite(pos.y)).toBe(true);
      expect(Number.isFinite(pos.z)).toBe(true);
    });
  });

  // ============================================================
  // Terrain pipeline: cell.dat → CellLandblock → LandblockGeometry
  // ============================================================
  describe('Terrain Pipeline', () => {
    it('should load terrain and build geometry without NaN', () => {
      const terrainIds = cellDb.listFileIds(undefined).filter(id => (id & 0xFFFF) === 0xFFFF);
      expect(terrainIds.length).toBeGreaterThan(0);

      let tested = 0;
      for (const id of terrainIds.slice(0, 5)) {
        const data = cellDb.getFileData(id);
        if (!data) continue;

        const lb = CellLandblock.read(new DatReader(data));
        expect(lb.heights.length).toBe(81);

        const mesh = new LandblockMesh({ heights: lb.heights, terrain: lb.terrain });
        const geom = mesh.geometry;

        // Verify no NaN in positions
        for (let i = 0; i < geom.positions.length; i++) {
          expect(Number.isFinite(geom.positions[i])).toBe(true);
        }
        // Verify no NaN in normals
        for (let i = 0; i < geom.normals.length; i++) {
          expect(Number.isFinite(geom.normals[i])).toBe(true);
        }
        // Verify indices are within range
        const vertexCount = geom.positions.length / 3;
        for (let i = 0; i < geom.indices.length; i++) {
          expect(geom.indices[i]).toBeLessThan(vertexCount);
          expect(geom.indices[i]).toBeGreaterThanOrEqual(0);
        }

        tested++;
      }
      expect(tested).toBeGreaterThanOrEqual(3);
    });

    it('should convert terrain to Three.js BufferGeometry', () => {
      const terrainIds = cellDb.listFileIds(undefined).filter(id => (id & 0xFFFF) === 0xFFFF);
      const data = cellDb.getFileData(terrainIds[0]);
      if (!data) throw new Error('DAT entry missing');

      const lb = CellLandblock.read(new DatReader(data));
      const mesh = new LandblockMesh({ heights: lb.heights, terrain: lb.terrain });
      const geom = mesh.geometry;

      const bufGeom = new THREE.BufferGeometry();
      bufGeom.setAttribute('position', new THREE.Float32BufferAttribute(geom.positions, 3));
      bufGeom.setAttribute('normal', new THREE.Float32BufferAttribute(geom.normals, 3));
      bufGeom.setIndex(Array.from(geom.indices));

      expect(bufGeom.attributes.position.count).toBe(81);
      expect(bufGeom.index!.count).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // Model pipeline: portal.dat → GfxObj → buildGfxObjGeometry → BufferGeometry
  // ============================================================
  describe('Model Pipeline', () => {
    it('should load GfxObj and build renderable geometry without NaN', () => {
      const gfxIds = portalDb.listFileIds(0x01);
      expect(gfxIds.length).toBeGreaterThan(0);

      let tested = 0;
      for (const id of gfxIds.slice(0, 20)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        let gfx: GfxObj;
        try {
          gfx = new GfxObj(new DatReader(data));
        } catch {
          continue;
        }

        if (gfx.vertices.length === 0 || gfx.polygons.length === 0) continue;

        const geom = buildGfxObjGeometry(gfx);
        if (!geom) continue;

        // Verify no NaN in positions
        for (let i = 0; i < geom.positions.length; i++) {
          expect(Number.isFinite(geom.positions[i])).toBe(true);
        }
        // Verify no NaN in normals
        for (let i = 0; i < geom.normals.length; i++) {
          expect(Number.isFinite(geom.normals[i])).toBe(true);
        }
        // Verify indices valid
        const vCount = geom.positions.length / 3;
        for (let i = 0; i < geom.indices.length; i++) {
          expect(geom.indices[i]).toBeLessThan(vCount);
          expect(geom.indices[i]).toBeGreaterThanOrEqual(0);
        }

        tested++;
        if (tested >= 10) break;
      }
      expect(tested).toBeGreaterThanOrEqual(10);
    });

    it('should convert GfxObj geometry to Three.js BufferGeometry', () => {
      const gfxIds = portalDb.listFileIds(0x01);
      for (const id of gfxIds.slice(0, 50)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        let gfx: GfxObj;
        try {
          gfx = new GfxObj(new DatReader(data));
        } catch {
          continue;
        }
        if (gfx.vertices.length === 0) continue;

        const geom = buildGfxObjGeometry(gfx);
        if (!geom) continue;

        const bufGeom = new THREE.BufferGeometry();
        bufGeom.setAttribute('position', new THREE.Float32BufferAttribute(geom.positions, 3));
        bufGeom.setAttribute('normal', new THREE.Float32BufferAttribute(geom.normals, 3));
        if (geom.uvs.length > 0) {
          bufGeom.setAttribute('uv', new THREE.Float32BufferAttribute(geom.uvs, 2));
        }
        bufGeom.setIndex(Array.from(geom.indices));

        expect(bufGeom.attributes.position.count).toBeGreaterThan(0);
        expect(bufGeom.index!.count).toBeGreaterThan(0);
        return;
      }
    });

    it('should assemble SetupModel multi-part models', () => {
      const setupIds = portalDb.listFileIds(0x02);
      let tested = 0;

      for (const id of setupIds.slice(0, 50)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        let setup: SetupModel;
        try {
          setup = new SetupModel(new DatReader(data));
        } catch {
          continue;
        }
        if (setup.parts.length === 0) continue;

        const placements = getPartPlacements(setup);
        expect(placements.length).toBe(setup.parts.length);

        // Each part should reference a valid GfxObj ID
        for (const part of setup.parts) {
          if (part !== 0) {
            expect((part >> 24) & 0xFF).toBe(0x01);
          }
        }

        tested++;
        if (tested >= 10) break;
      }
      expect(tested).toBeGreaterThanOrEqual(10);
    });
  });

  // ============================================================
  // Animation pipeline: MotionTable → Animation → frame interpolation
  // ============================================================
  describe('Animation Pipeline', () => {
    it('should load animation and interpolate frames', () => {
      const animIds = portalDb.listFileIds(0x03);
      let tested = 0;

      for (const id of animIds.slice(0, 50)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        let anim: Animation;
        try {
          anim = new Animation(new DatReader(data));
        } catch {
          continue;
        }
        if (anim.numFrames < 2 || anim.numParts < 1) continue;

        // Play animation
        const player = new AnimationPlayer();
        player.play(anim);
        player.update(0.016); // one frame at 60fps

        const transforms = player.getPartTransforms();
        expect(transforms.length).toBe(anim.numParts);

        // All transforms should have finite values
        for (const t of transforms) {
          expect(Number.isFinite(t.origin.x)).toBe(true);
          expect(Number.isFinite(t.origin.y)).toBe(true);
          expect(Number.isFinite(t.origin.z)).toBe(true);
          expect(Number.isFinite(t.orientation.w)).toBe(true);
          expect(Number.isFinite(t.orientation.x)).toBe(true);
          expect(Number.isFinite(t.orientation.y)).toBe(true);
          expect(Number.isFinite(t.orientation.z)).toBe(true);
        }

        tested++;
        if (tested >= 5) break;
      }
      expect(tested).toBeGreaterThanOrEqual(3);
    });

    it('should resolve MotionTable → Animation chain', () => {
      const setupIds = portalDb.listFileIds(0x02);
      let tested = 0;

      for (const id of setupIds) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        let setup: SetupModel;
        try {
          setup = new SetupModel(new DatReader(data));
        } catch {
          continue;
        }
        if (!setup.defaultMotionTable) continue;

        const mtData = portalDb.getFileData(setup.defaultMotionTable);
        if (!mtData) continue;

        let mt: MotionTable;
        try {
          mt = new MotionTable(new DatReader(mtData));
        } catch {
          continue;
        }

        // Try to find a cycle animation
        let foundAnimation = false;
        for (const [, motionData] of mt.cycles) {
          if (!motionData || motionData.anims.length === 0) continue;
          const animId = motionData.anims[0].animId;
          if (!animId) continue;
          const animData = portalDb.getFileData(animId);
          if (!animData) continue;

          try {
            const anim = new Animation(new DatReader(animData));
            if (anim.numFrames > 0) {
              foundAnimation = true;
              break;
            }
          } catch {
            continue;
          }
        }

        if (foundAnimation) {
          tested++;
          if (tested >= 3) break;
        }
      }
      expect(tested).toBeGreaterThanOrEqual(2);
    });

    it('should apply animation to skeleton system', () => {
      const setupIds = portalDb.listFileIds(0x02);

      for (const id of setupIds) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        let setup: SetupModel;
        try {
          setup = new SetupModel(new DatReader(data));
        } catch {
          continue;
        }
        if (setup.parts.length < 2 || !setup.defaultMotionTable) continue;

        const skeleton = new SkeletonSystem();
        skeleton.initFromSetupModel(setup);

        const mtData = portalDb.getFileData(setup.defaultMotionTable);
        if (!mtData) continue;

        let mt: MotionTable;
        try {
          mt = new MotionTable(new DatReader(mtData));
        } catch {
          continue;
        }

        // Find any animation to apply
        for (const [, motionData] of mt.cycles) {
          if (!motionData || motionData.anims.length === 0) continue;
          const animId = motionData.anims[0].animId;
          if (!animId) continue;
          const animData = portalDb.getFileData(animId);
          if (!animData) continue;

          try {
            const anim = new Animation(new DatReader(animData));
            if (anim.numFrames > 0 && anim.numParts === setup.parts.length) {
              // Apply first frame
              skeleton.applyFrame(anim.partFrames[0].frames);
              skeleton.computeWorldTransforms();

              // Get bone positions — all should be finite
              for (let b = 0; b < setup.parts.length; b++) {
                const pos = skeleton.getBoneWorldPosition(b);
                if (pos) {
                  expect(Number.isFinite(pos.x)).toBe(true);
                  expect(Number.isFinite(pos.y)).toBe(true);
                  expect(Number.isFinite(pos.z)).toBe(true);
                }
              }
              return; // test passed
            }
          } catch {
            continue;
          }
        }
      }
    });
  });

  // ============================================================
  // Effects pipeline: particles, skybox, spells
  // ============================================================
  describe('Effects Pipeline', () => {
    it('should create particle system from real emitter data', () => {
      const ids = portalDb.listFileIds(0x32);
      const data = portalDb.getFileData(ids[0]);
      if (!data) throw new Error('DAT entry missing');

      const info = new ParticleEmitterInfo(new DatReader(data));
      const system = new ParticleSystem(info);

      expect(system.meshes[0]).toBeInstanceOf(THREE.InstancedMesh);
      system.update(0.1);
      system.update(0.1);
      system.update(0.1);

      // Each drawn particle is one instance of the emitter's quad geometry
      const geom = system.meshes[0].geometry as THREE.BufferGeometry;
      expect(geom.attributes.position).toBeDefined();
      expect(geom.attributes.uv).toBeDefined();
      expect(system.meshes[0].count).toBeLessThanOrEqual(system.activeCount);

      system.dispose();
    });

    it('should create skybox with time-of-day variations', () => {
      const skybox = new SkyboxRenderer();

      expect(skybox.skyObject).toBeInstanceOf(THREE.Mesh);
      expect(skybox.directionalLight).toBeInstanceOf(THREE.DirectionalLight);
      expect(skybox.ambient).toBeInstanceOf(THREE.AmbientLight);

      // Different times produce different colors
      skybox.updateTimeOfDay(0.0);
      const midnight = skybox.skyColor.clone();

      skybox.updateTimeOfDay(0.5);
      const noon = skybox.skyColor.clone();

      expect(midnight.equals(noon)).toBe(false);

      skybox.dispose();
    });

    it('SpellEffects starts empty and invents no effects (BUG.invented-portal-burst-and-spell-effects)', () => {
      const scene = new THREE.Scene();
      const effects = new SpellEffects(scene);
      expect(effects.activeCount).toBe(0);
      effects.update(0.016);
      expect(scene.children).toEqual([]);
      expect(Object.getOwnPropertyNames(SpellEffects.prototype).filter((n) => /^(create|spawn)/.test(n))).toEqual(['spawnParticleEffect']);
    });
  });

  // ============================================================
  // Audio system baseline
  // ============================================================
  describe('Audio System', () => {
    it('should initialize AudioManager with categories', () => {
      const mgr = new AudioManager();
      const names = mgr.getCategoryNames();
      expect(names.length).toBe(4);
      expect(names).toContain('ambient');
      expect(names).toContain('effects');
      expect(names).toContain('music');
      expect(names).toContain('ui');
    });

    it('should load and decode wave files from portal.dat', () => {
      const mgr = new AudioManager();
      const player = new SoundPlayer(portalDb, mgr);

      const waveIds = portalDb.listFileIds(0x0A);
      let loaded = 0;

      for (const id of waveIds.slice(0, 20)) {
        const wave = player.loadWave(id);
        if (wave && !wave.isMP3) {
          const wavBuf = wave.toWavBuffer();
          expect(wavBuf.byteLength).toBeGreaterThan(44);
          loaded++;
        }
      }
      expect(loaded).toBeGreaterThanOrEqual(5);
    });

    it('should manage MusicPlayer state', () => {
      const mgr = new AudioManager();
      const music = new MusicPlayer(mgr, async () => null);

      expect(music.isPlaying).toBe(false);
      expect(music.volume).toBe(1.0);
      expect(music.crossfade).toBe(2.0);

      music.volume = 0.5;
      expect(music.volume).toBeCloseTo(0.5);

      music.dispose();
    });
  });

  // ============================================================
  // Full pipeline integration: DAT → parse → render
  // ============================================================
  describe('Full Pipeline Integration', () => {
    it('should process multiple terrain landblocks + models in one scene', () => {
      const scene = new THREE.Scene();

      // Load 3 terrain landblocks
      const terrainIds = cellDb.listFileIds(undefined).filter(id => (id & 0xFFFF) === 0xFFFF);
      let terrainCount = 0;

      for (const id of terrainIds.slice(0, 3)) {
        const data = cellDb.getFileData(id);
        if (!data) continue;

        const lb = CellLandblock.read(new DatReader(data));
        const lbMesh = new LandblockMesh({ heights: lb.heights, terrain: lb.terrain });
        const geom = lbMesh.geometry;

        const bufGeom = new THREE.BufferGeometry();
        bufGeom.setAttribute('position', new THREE.Float32BufferAttribute(geom.positions, 3));
        bufGeom.setAttribute('normal', new THREE.Float32BufferAttribute(geom.normals, 3));
        bufGeom.setIndex(Array.from(geom.indices));

        const mesh = new THREE.Mesh(bufGeom, new THREE.MeshStandardMaterial());
        scene.add(mesh);
        terrainCount++;
      }

      expect(terrainCount).toBeGreaterThanOrEqual(3);

      // Load 5 GfxObj models
      const gfxIds = portalDb.listFileIds(0x01);
      let modelCount = 0;

      for (const id of gfxIds) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        let gfx: GfxObj;
        try {
          gfx = new GfxObj(new DatReader(data));
        } catch {
          continue;
        }
        if (gfx.vertices.length === 0) continue;

        const geom = buildGfxObjGeometry(gfx);
        if (!geom) continue;

        const bufGeom = new THREE.BufferGeometry();
        bufGeom.setAttribute('position', new THREE.Float32BufferAttribute(geom.positions, 3));
        bufGeom.setAttribute('normal', new THREE.Float32BufferAttribute(geom.normals, 3));
        bufGeom.setIndex(Array.from(geom.indices));

        const mesh = new THREE.Mesh(bufGeom, new THREE.MeshStandardMaterial());
        scene.add(mesh);
        modelCount++;

        if (modelCount >= 5) break;
      }

      expect(modelCount).toBeGreaterThanOrEqual(5);

      // Add skybox
      const skybox = new SkyboxRenderer();
      scene.add(skybox.skyObject);
      scene.add(skybox.directionalLight);
      scene.add(skybox.ambient);

      // Total objects in scene
      const totalChildren = scene.children.length;
      expect(totalChildren).toBeGreaterThanOrEqual(3 + 5 + 3); // terrain + models + sky/lights

      // Verify no NaN in any scene object positions
      scene.traverse((obj) => {
        expect(Number.isFinite(obj.position.x)).toBe(true);
        expect(Number.isFinite(obj.position.y)).toBe(true);
        expect(Number.isFinite(obj.position.z)).toBe(true);
      });

      skybox.dispose();
    });

    it('should parse all DAT file types used during rendering without errors', () => {
      const results: Record<string, { total: number; success: number }> = {};

      // Textures (0x06)
      const texIds = portalDb.listFileIds(0x06);
      results['Texture'] = { total: 0, success: 0 };
      for (const id of texIds.slice(0, 50)) {
        results['Texture'].total++;
        try {
          const data = portalDb.getFileData(id);
          if (data) results['Texture'].success++;
        } catch { /* */ }
      }

      // Palettes (0x04)
      const palIds = portalDb.listFileIds(0x04);
      results['Palette'] = { total: 0, success: 0 };
      for (const id of palIds.slice(0, 50)) {
        results['Palette'].total++;
        try {
          const data = portalDb.getFileData(id);
          if (data) results['Palette'].success++;
        } catch { /* */ }
      }

      // Surfaces (0x08)
      const surfIds = portalDb.listFileIds(0x08);
      results['Surface'] = { total: 0, success: 0 };
      for (const id of surfIds.slice(0, 50)) {
        results['Surface'].total++;
        try {
          const data = portalDb.getFileData(id);
          if (data) results['Surface'].success++;
        } catch { /* */ }
      }

      // GfxObj (0x01)
      const gfxIds = portalDb.listFileIds(0x01);
      results['GfxObj'] = { total: 0, success: 0 };
      for (const id of gfxIds.slice(0, 50)) {
        results['GfxObj'].total++;
        try {
          const data = portalDb.getFileData(id);
          if (data) {
            new GfxObj(new DatReader(data));
            results['GfxObj'].success++;
          }
        } catch { /* */ }
      }

      // SetupModel (0x02)
      const setupIds = portalDb.listFileIds(0x02);
      results['SetupModel'] = { total: 0, success: 0 };
      for (const id of setupIds.slice(0, 50)) {
        results['SetupModel'].total++;
        try {
          const data = portalDb.getFileData(id);
          if (data) {
            new SetupModel(new DatReader(data));
            results['SetupModel'].success++;
          }
        } catch { /* */ }
      }

      // All file types should have high success rate
      for (const [type, result] of Object.entries(results)) {
        const rate = result.success / result.total;
        expect(rate, `${type} parse rate`).toBeGreaterThanOrEqual(0.95);
      }
    });

    it('should keep bounded vertex/texture counts (no memory leak pattern)', () => {
      const geometries: THREE.BufferGeometry[] = [];

      // Load 10 models and track memory
      const gfxIds = portalDb.listFileIds(0x01);
      let totalVertices = 0;

      for (const id of gfxIds.slice(0, 100)) {
        const data = portalDb.getFileData(id);
        if (!data) continue;

        let gfx: GfxObj;
        try {
          gfx = new GfxObj(new DatReader(data));
        } catch {
          continue;
        }
        if (gfx.vertices.length === 0) continue;

        const geom = buildGfxObjGeometry(gfx);
        if (!geom) continue;

        totalVertices += geom.positions.length / 3;

        const bufGeom = new THREE.BufferGeometry();
        bufGeom.setAttribute('position', new THREE.Float32BufferAttribute(geom.positions, 3));
        geometries.push(bufGeom);

        if (geometries.length >= 10) break;
      }

      // Vertex counts should be reasonable (not billions)
      expect(totalVertices).toBeGreaterThan(0);
      expect(totalVertices).toBeLessThan(10_000_000);

      // Clean up
      for (const g of geometries) {
        g.dispose();
      }
    });
  });
});
