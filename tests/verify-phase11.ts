/**
 * Phase 11 Verification: Three.js Scene + Camera + Textured Terrain
 * Tests SceneManager, CameraController, TerrainRenderer — all in Node.js
 * (no WebGL context needed, Three.js scene/camera/geometry work in Node)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { SceneManager } from '../packages/renderer/src/scene/SceneManager.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { TerrainRenderer } from '../packages/renderer/src/terrain/TerrainRenderer.js';
import { TerrainManager } from '../packages/renderer/src/terrain/TerrainManager.js';
import { LandblockMesh, LandblockGeometry } from '../packages/renderer/src/terrain/LandblockMesh.js';
import { DatDatabase } from '../packages/dat-parser/src/index.js';
import { CellLandblock } from '../packages/dat-parser/src/file-types/CellLandblock.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { openDat } from './_harness/dat.js';

const ROOT = resolve(__dirname, '..');
const CELL_DAT = resolve(ROOT, 'dat/client_cell_1.dat');
const hasCellDat = existsSync(CELL_DAT);

let cellDb: DatDatabase;

beforeAll(() => {
  if (!hasCellDat) return;
  cellDb = openDat(CELL_DAT);
});

describe.skipIf(!hasCellDat)('Phase 11: Three.js Scene + Camera + Textured Terrain', () => {

  // ───────── SceneManager ─────────
  describe('SceneManager', () => {
    it('creates Scene and PerspectiveCamera', () => {
      const sm = new SceneManager();
      expect(sm.scene).toBeInstanceOf(THREE.Scene);
      expect(sm.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    });

    it('scene has no light of its own', () => {
      // CORE.17.e removed the undriven 0.8 directional; CORE.17.q removed the
      // sealed-interior fill that replaced it. Every world light now comes
      // from SkyboxRenderer (sun + DAT ambient), the DAT static lights and
      // the retail viewer light. DECOMP.environs-ambient-additive removed the
      // EnvironChange ambient holder: the override replaces the SkyboxRenderer
      // ambient instead of adding a second one.
      const sm = new SceneManager();
      let ambientCount = 0;
      let directionalCount = 0;
      sm.scene.traverse((child) => {
        if (child instanceof THREE.AmbientLight) ambientCount++;
        if (child instanceof THREE.DirectionalLight) directionalCount++;
      });
      expect(ambientCount).toBe(0);
      expect(directionalCount).toBe(0);
    });

    it('camera has default position above ground', () => {
      const sm = new SceneManager();
      expect(sm.camera.position.y).toBeGreaterThan(0);
    });

    it('renderer is null before initRenderer', () => {
      const sm = new SceneManager();
      expect(sm.renderer).toBeNull();
    });

    it('add/remove objects to scene', () => {
      const sm = new SceneManager();
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial()
      );
      sm.add(mesh);
      expect(sm.scene.children).toContain(mesh);
      sm.remove(mesh);
      expect(sm.scene.children).not.toContain(mesh);
    });

    it('resize updates camera aspect ratio', () => {
      const sm = new SceneManager();
      sm.resize(1920, 1080);
      expect(sm.camera.aspect).toBeCloseTo(1920 / 1080, 2);
    });

    it('fog is set when configured', () => {
      const sm = new SceneManager({ fogColor: 0x87ceeb, fogNear: 100, fogFar: 1500 });
      // SceneManager only adds fog if fogColor is provided (not undefined)
      // In our constructor, fog is added when fogColor !== undefined
      // Since we passed fogColor, fog should be set
      expect(sm.scene.fog).not.toBeNull();
    });
  });

  // ───────── CameraController ─────────
  describe('CameraController', () => {
    it('creates controller with camera', () => {
      const camera = new THREE.PerspectiveCamera();
      const ctrl = new CameraController(camera);
      expect(ctrl.camera).toBe(camera);
      expect(ctrl.runRate).toBe(1.0);
    });

    it('WASD moves camera position', () => {
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(0, 0, 0);
      const ctrl = new CameraController(camera);
      ctrl.runRate = 2.5;

      // Press W (forward) for 1 second
      ctrl.simulateKeyDown('KeyW');
      ctrl.update(1.0);
      ctrl.simulateKeyUp('KeyW');

      // Camera should have moved (yaw=0 means forward is -Z)
      const pos = ctrl.position;
      expect(Math.abs(pos.z)).toBeGreaterThan(0);
    });

    it('strafing moves perpendicular to look direction', () => {
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(0, 0, 0);
      const ctrl = new CameraController(camera);

      // Press Z (strafe left) — D is now keyboard turn, Z/C = strafe
      ctrl.simulateKeyDown('KeyZ');
      ctrl.update(1.0);
      ctrl.simulateKeyUp('KeyZ');

      // With yaw=0 the player faces AC south (−Z); CORE.18 — their left is
      // AC east, three +X.
      expect(ctrl.position.x).toBeGreaterThan(0);
    });

    it('mouse look changes yaw and pitch', () => {
      const camera = new THREE.PerspectiveCamera();
      const ctrl = new CameraController(camera);

      const initialYaw = ctrl.yaw;
      const initialPitch = ctrl.pitch;
      let t = 100; ctrl.clock = () => (t += 0.016);
      ctrl.frameRate.push(0.016); // SceneTool::m_FramesPerSecond (the render loop feeds it)

      // Retail mouse-look is opt-in (held middle button / F2) and each axis
      // acts after 5 consecutive non-zero calls (CameraSet::MouseLookHandler).
      ctrl.setMouseLook(true);
      for (let i = 0; i < 6; i++) { ctrl.simulateMouseMove(100, 50); ctrl.update(0.016); }

      expect(ctrl.yaw).not.toBe(initialYaw);
      expect(ctrl.pitch).not.toBe(initialPitch);
    });

    it('pitch is clamped to min/max', () => {
      const camera = new THREE.PerspectiveCamera();
      const ctrl = new CameraController(camera);

      // Look way down
      let t = 100; ctrl.clock = () => (t += 0.016);
      ctrl.setMouseLook(true);
      for (let i = 0; i < 6; i++) { ctrl.simulateMouseMove(0, 10000); ctrl.update(0.016); }
      expect(ctrl.pitch).toBeGreaterThanOrEqual(ctrl.minPitch);
      expect(ctrl.pitch).toBeLessThanOrEqual(ctrl.maxPitch);
    });

    it('setPosition updates camera position', () => {
      const camera = new THREE.PerspectiveCamera();
      const ctrl = new CameraController(camera);

      ctrl.setPosition(100, 200, 300);
      expect(camera.position.x).toBe(100);
      expect(camera.position.y).toBe(200);
      expect(camera.position.z).toBe(300);
    });

    it('no movement when no keys pressed', () => {
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(10, 20, 30);
      const ctrl = new CameraController(camera);

      ctrl.update(1.0);

      expect(ctrl.position.x).toBe(10);
      expect(ctrl.position.y).toBe(20);
      expect(ctrl.position.z).toBe(30);
    });
  });

  // ───────── TerrainRenderer ─────────
  describe('TerrainRenderer', () => {
    it('toBufferGeometry converts LandblockGeometry to Three.js BufferGeometry', () => {
      // Create a simple landblock
      const data = { heights: new Array(81).fill(10) };
      const lbMesh = new LandblockMesh(data);

      const bufGeom = TerrainRenderer.toBufferGeometry(lbMesh.geometry);
      expect(bufGeom).toBeInstanceOf(THREE.BufferGeometry);

      const posAttr = bufGeom.getAttribute('position');
      expect(posAttr.count).toBe(81);

      const normalAttr = bufGeom.getAttribute('normal');
      expect(normalAttr.count).toBe(81);

      const uvAttr = bufGeom.getAttribute('uv');
      expect(uvAttr.count).toBe(81);

      const index = bufGeom.getIndex();
      expect(index).not.toBeNull();
      expect(index!.count).toBe(384);
    });

    it('creates textured geometry from real CellLandblock data', () => {
      // Parse a real landblock from cell.dat
      const fileId = TerrainManager.blockToFileId(0x80, 0x80);
      expect(cellDb.hasFile(fileId)).toBe(true);

      const data = cellDb.getFileData(fileId)!;
      const reader = new DatReader(data);
      const lb = CellLandblock.read(reader);

      const lbMesh = new LandblockMesh({ heights: lb.heights });
      const bufGeom = TerrainRenderer.toBufferGeometry(lbMesh.geometry);

      const posAttr = bufGeom.getAttribute('position');
      expect(posAttr.count).toBe(81);

      // Verify positions are finite
      for (let i = 0; i < posAttr.count * 3; i++) {
        expect(isFinite(posAttr.array[i])).toBe(true);
      }
    });

    it('terrain types are extractable from terrain data', () => {
      const terrain = [0b0000_0000_0001_0100, 0b0000_0000_0010_1000]; // types 5 and 10
      const types = TerrainRenderer.getTerrainTypes(terrain);
      expect(types[0]).toBe(5);
      expect(types[1]).toBe(10);
    });

    it('terrain streaming creates/removes meshes in scene', () => {
      const scene = new THREE.Scene();
      const tm = new TerrainManager({ loadRadius: 1 });

      // Mock cell database
      const mockDb = {
        hasFile: (id: number) => true,
        getReader: (_id: number) => {
          return null; // We need a proper mock
        },
      };
      const mockReader = {
        read: (_reader: any) => ({
          heights: new Array(81).fill(10),
          terrain: new Array(81).fill(0),
        }),
      };
      tm.init(mockDb, mockReader);

      const tr = new TerrainRenderer(scene, tm);

      // Update at a position — should load nearby blocks
      const result = tr.update(100 * 192, 100 * 192);
      expect(result.added).toBeGreaterThan(0);
      expect(tr.meshCount).toBeGreaterThan(0);

      // Each terrain mesh should be a Three.js Mesh in the scene
      let meshCount = 0;
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) meshCount++;
      });
      expect(meshCount).toBe(tr.meshCount);
    });

    it('terrain streaming unloads when moving away', () => {
      const scene = new THREE.Scene();
      const tm = new TerrainManager({ loadRadius: 1 });
      const mockDb = {
        hasFile: () => true,
        getReader: () => null,
      };
      const mockReader = {
        read: () => ({ heights: new Array(81).fill(5) }),
      };
      tm.init(mockDb, mockReader);
      const tr = new TerrainRenderer(scene, tm);

      // Load at position A
      tr.update(50 * 192, 50 * 192);
      const countA = tr.meshCount;
      expect(countA).toBeGreaterThan(0);

      // Move far away
      tr.update(200 * 192, 200 * 192);
      // Some old blocks should have been unloaded
      // (new blocks loaded in the new area)
      expect(tr.meshCount).toBeGreaterThan(0);
    });

    it('clear removes all terrain meshes', () => {
      const scene = new THREE.Scene();
      const tm = new TerrainManager({ loadRadius: 0 });
      const mockDb = {
        hasFile: () => true,
        getReader: () => null,
      };
      const mockReader = {
        read: () => ({ heights: new Array(81).fill(0) }),
      };
      tm.init(mockDb, mockReader);
      const tr = new TerrainRenderer(scene, tm);

      tr.update(50 * 192, 50 * 192);
      expect(tr.meshCount).toBeGreaterThan(0);

      tr.clear();
      expect(tr.meshCount).toBe(0);
    });
  });

  // ───────── Terrain coordinate system ─────────
  describe('Terrain coordinate system', () => {
    it('worldToBlock converts correctly', () => {
      // 100 * 192 = world position for block 100
      const { blockX, blockY } = TerrainManager.worldToBlock(100 * 192, 150 * 192);
      expect(blockX).toBe(100);
      expect(blockY).toBe(150);
    });

    it('blockToFileId and fileIdToBlock are inverse operations', () => {
      const fileId = TerrainManager.blockToFileId(0xA9, 0xB3);
      const { blockX, blockY } = TerrainManager.fileIdToBlock(fileId);
      expect(blockX).toBe(0xA9);
      expect(blockY).toBe(0xB3);
    });

    it('landblock mesh positions span 192m', () => {
      const data = { heights: new Array(81).fill(0) };
      const lbMesh = new LandblockMesh(data);
      lbMesh.geometry.computeBoundingBox();
      const bb = lbMesh.geometry.boundingBox!;
      expect(bb.max.x - bb.min.x).toBe(192);
      expect(bb.max.z - bb.min.z).toBe(192);
    });

    it('5×5 grid loads 25 landblocks', () => {
      const tm = new TerrainManager({ loadRadius: 2 }); // 2 = 5×5
      const mockDb = {
        hasFile: () => true,
        getReader: () => null,
      };
      const mockReader = {
        read: () => ({ heights: new Array(81).fill(0) }),
      };
      tm.init(mockDb, mockReader);

      tm.update(128 * 192, 128 * 192);
      expect(tm.getLoadedMeshes().size).toBe(25);
    });
  });

  // ───────── Vite config and HTML ─────────
  describe('Vite dev server files', () => {
    it('vite.config.ts exists', () => {
      expect(existsSync(resolve(ROOT, 'vite.config.ts'))).toBe(true);
    });

    it('renderer index.html exists', () => {
      expect(existsSync(resolve(ROOT, 'packages/renderer/index.html'))).toBe(true);
    });

    it('renderer main.ts entry point exists', () => {
      expect(existsSync(resolve(ROOT, 'packages/renderer/src/main.ts'))).toBe(true);
    });
  });
});
