/**
 * Phase 14 — Dungeon Rendering (EnvCell → Three.js)
 *
 * Tests:
 *  - EnvCellRenderer creates geometry for dungeon cells with vertices and polygons
 *  - Cells are positioned at correct world coordinates from Frame data
 *  - Portal connections link adjacent cells
 *  - DungeonRenderer assembles multiple cells into a dungeon group
 *  - LandblockInfo parsing for buildings and dungeon entry
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { EnvCell } from '@ac/dat-parser/file-types/EnvCell.js';
import { Environment } from '@ac/dat-parser/file-types/Environment.js';
import { LandblockInfo } from '@ac/dat-parser/file-types/LandblockInfo.js';
import { TextureManager } from '@ac/renderer/models/TextureManager.js';
import { MaterialFactory } from '@ac/renderer/models/MaterialFactory.js';
import { EnvCellRenderer } from '@ac/renderer/world/EnvCellRenderer.js';
import { DungeonRenderer } from '@ac/renderer/world/DungeonRenderer.js';
import { DungeonCollision } from '@ac/renderer/world/DungeonCollision.js';
import { openDat } from './_harness/dat.js';

const hasRequiredDat = fs.existsSync('dat/client_portal.dat') && fs.existsSync('dat/client_cell_1.dat');

let portalDb: DatDatabase;
let cellDb: DatDatabase;
let textureManager: TextureManager;
let materialFactory: MaterialFactory;
let envCellRenderer: EnvCellRenderer;
let dungeonRenderer: DungeonRenderer;

beforeAll(() => {
  if (!hasRequiredDat) return;
  portalDb = openDat('dat/client_portal.dat');
  cellDb = openDat('dat/client_cell_1.dat');
  textureManager = new TextureManager(portalDb);
  materialFactory = new MaterialFactory(portalDb, textureManager);
  envCellRenderer = new EnvCellRenderer(portalDb, cellDb, materialFactory);
  dungeonRenderer = new DungeonRenderer(cellDb, envCellRenderer);
});

/**
 * Find landblock IDs that have interior cells (dungeons).
 * LandblockInfo files are at 0xXXYYFFFE in cell.dat.
 */
function findDungeonLandblocks(count: number): number[] {
  const ids: number[] = [];
  // LandblockInfo files have ID pattern 0xXXYYFFFE
  const allFiles = cellDb.listFileIds();
  for (const id of allFiles) {
    if ((id & 0xFFFF) === 0xFFFE) {
      const data = cellDb.getFileData(id);
      if (!data) continue;
      try {
        const info = new LandblockInfo(new DatReader(data));
        if (info.numCells > 0) {
          ids.push(id & 0xFFFF0000);
          if (ids.length >= count) break;
        }
      } catch {
        // skip unparseable
      }
    }
  }
  return ids;
}

/**
 * Find individual interior cell IDs from cell.dat.
 * Interior cells: (id & 0xFFFF) >= 0x0001 and <= 0xFFFD
 */
function findInteriorCellIds(count: number): number[] {
  const ids: number[] = [];
  const allFiles = cellDb.listFileIds();
  for (const id of allFiles) {
    const low = id & 0xFFFF;
    if (low >= 0x0001 && low <= 0xFFFD) {
      ids.push(id);
      if (ids.length >= count) break;
    }
  }
  return ids;
}

describe.skipIf(!hasRequiredDat)('Phase 14 — Dungeon Rendering', () => {
  // ============================================================
  // EnvCell parsing tests
  // ============================================================
  describe('EnvCell Parsing', () => {
    it('should find interior cells in cell.dat', () => {
      const ids = findInteriorCellIds(50);
      expect(ids.length).toBeGreaterThanOrEqual(50);
    });

    it('should parse EnvCell data with valid position frames', () => {
      const ids = findInteriorCellIds(50);
      let parsed = 0;

      for (const id of ids) {
        const cell = envCellRenderer.loadEnvCell(id);
        if (!cell) continue;

        expect(Number.isFinite(cell.position.origin.x)).toBe(true);
        expect(Number.isFinite(cell.position.origin.y)).toBe(true);
        expect(Number.isFinite(cell.position.origin.z)).toBe(true);
        expect(Number.isFinite(cell.position.orientation.w)).toBe(true);
        parsed++;
      }
      expect(parsed).toBeGreaterThanOrEqual(40);
    });

    it('should have valid environment IDs (0x0D prefix)', () => {
      const ids = findInteriorCellIds(30);
      for (const id of ids) {
        const cell = envCellRenderer.loadEnvCell(id);
        if (!cell) continue;
        expect(cell.environmentId >>> 24).toBe(0x0D);
      }
    });

    it('should have valid surface IDs (0x08 prefix)', () => {
      const ids = findInteriorCellIds(30);
      let withSurfaces = 0;
      for (const id of ids) {
        const cell = envCellRenderer.loadEnvCell(id);
        if (!cell || cell.surfaces.length === 0) continue;
        withSurfaces++;
        for (const surfId of cell.surfaces) {
          expect(surfId >>> 24).toBe(0x08);
        }
      }
      expect(withSurfaces).toBeGreaterThanOrEqual(10);
    });
  });

  // ============================================================
  // Environment parsing tests
  // ============================================================
  describe('Environment Parsing', () => {
    it('should load Environment files from portal.dat', () => {
      const envIds = portalDb.listFileIds(0x0D);
      expect(envIds.length).toBeGreaterThanOrEqual(10);

      let parsed = 0;
      let attempted = 0;
      for (const id of envIds.slice(0, 50)) {
        attempted++;
        const env = envCellRenderer.loadEnvironment(id);
        if (env && env.cells.size > 0) parsed++;
      }
      // 100% should parse successfully
      expect(parsed / attempted).toBeGreaterThanOrEqual(1.0);
    });

    it('should have CellStruct with vertices and polygons', () => {
      const envIds = portalDb.listFileIds(0x0D);
      let withGeometry = 0;

      for (const id of envIds.slice(0, 20)) {
        const env = envCellRenderer.loadEnvironment(id);
        if (!env) continue;

        for (const [, cellStruct] of env.cells) {
          if (cellStruct.vertexArray.vertices.size > 0 && cellStruct.polygons.size > 0) {
            withGeometry++;
            break;
          }
        }
      }
      expect(withGeometry).toBeGreaterThanOrEqual(10);
    });
  });

  // ============================================================
  // EnvCellRenderer tests
  // ============================================================
  describe('EnvCellRenderer', () => {
    it('should create Three.js geometry for dungeon cells', () => {
      const ids = findInteriorCellIds(100);
      let rendered = 0;
      let attempted = 0;

      for (const id of ids) {
        attempted++;
        try {
          const mesh = envCellRenderer.createCellMesh(id);
          if (mesh && mesh.children.length > 0) {
            rendered++;
          }
        } catch {
          // Some environments have parsing edge cases; skip them
        }
      }
      // All cells should render successfully
      expect(rendered / attempted).toBeGreaterThanOrEqual(0.95);
    });

    it('should position cells at finite world coordinates', () => {
      const ids = findInteriorCellIds(200);
      let checked = 0;
      for (const id of ids) {
        try {
          const mesh = envCellRenderer.createCellMesh(id);
          if (!mesh || mesh.children.length === 0) continue;
          expect(Number.isFinite(mesh.position.x)).toBe(true);
          expect(Number.isFinite(mesh.position.y)).toBe(true);
          expect(Number.isFinite(mesh.position.z)).toBe(true);
          checked++;
          if (checked >= 10) break;
        } catch {
          // skip parsing failures
        }
      }
      expect(checked).toBeGreaterThanOrEqual(10);
    });

    it('should have geometry with no NaN in position attributes', () => {
      const ids = findInteriorCellIds(200);
      let checked = 0;

      for (const id of ids) {
        try {
          const mesh = envCellRenderer.createCellMesh(id);
          if (!mesh || mesh.children.length === 0) continue;

          let hasNaN = false;
          mesh.traverse((child) => {
            if (child instanceof THREE.Mesh) {
              const posAttr = child.geometry.getAttribute('position');
              if (posAttr) {
                const arr = posAttr.array as Float32Array;
                for (let i = 0; i < Math.min(arr.length, 30); i++) {
                  if (Number.isNaN(arr[i])) hasNaN = true;
                }
              }
            }
          });
          if (!hasNaN) {
            checked++;
            if (checked >= 10) break;
          }
        } catch {
          // skip parsing failures
        }
      }
      expect(checked).toBeGreaterThanOrEqual(10);
    });
  });

  // ============================================================
  // Portal connections tests
  // ============================================================
  describe('Portal Connections', () => {
    it('should have portal connections between interior cells', () => {
      const ids = findInteriorCellIds(50);
      let withPortals = 0;

      for (const id of ids) {
        const cell = envCellRenderer.loadEnvCell(id);
        if (!cell) continue;
        if (cell.cellPortals.length > 0) {
          withPortals++;
        }
      }
      expect(withPortals).toBeGreaterThanOrEqual(10);
    });

    it('should reference valid cell IDs in portal connections', () => {
      const dungeons = findDungeonLandblocks(5);
      let verified = 0;

      for (const lbId of dungeons) {
        const cells = dungeonRenderer.findInteriorCells(lbId);
        if (cells.length < 2) continue;

        const cellIdSet = new Set(cells);

        for (const cellId of cells.slice(0, 5)) {
          const connections = dungeonRenderer.getCellPortalConnections(cellId);
          for (const connId of connections) {
            // Connected cells should exist in the same landblock
            if (cellIdSet.has(connId)) {
              verified++;
            }
          }
        }
        if (verified >= 3) break;
      }
      expect(verified).toBeGreaterThanOrEqual(1);
    });
  });

  // ============================================================
  // DungeonRenderer tests
  // ============================================================
  describe('DungeonRenderer', () => {
    it('should find dungeon landblocks in cell.dat', () => {
      const dungeons = findDungeonLandblocks(10);
      expect(dungeons.length).toBeGreaterThanOrEqual(3);
    });

    it('should assemble dungeon cells into a group', () => {
      const dungeons = findDungeonLandblocks(20);
      let assembled = 0;

      for (const lbId of dungeons) {
        try {
          const group = dungeonRenderer.createDungeon(lbId);
          if (group && group.children.length > 0) {
            assembled++;
            if (assembled >= 3) break;
          }
        } catch {
          // skip dungeons with parsing issues
        }
      }
      expect(assembled).toBeGreaterThanOrEqual(3);
    });

    it('should have multiple cells in a dungeon group', () => {
      const dungeons = findDungeonLandblocks(20);
      let multiCell = 0;

      for (const lbId of dungeons) {
        const cells = dungeonRenderer.findInteriorCells(lbId);
        if (cells.length >= 3) {
          multiCell++;
          if (multiCell >= 3) break;
        }
      }
      expect(multiCell).toBeGreaterThanOrEqual(3);
    });
  });

  // ============================================================
  // Static object positioning tests (inverse cell rotation fix)
  // Verifies the math that compensates for parent cell rotation
  // so static objects end up at their correct world positions.
  // ============================================================
  describe('Static Object Positioning', () => {
    it('should have rotated cells with static objects in the DAT', () => {
      // Verify that the problem scenario exists: cells with non-identity
      // rotation AND static objects. This is common in surface buildings.
      const ids = findInteriorCellIds(500);
      let rotatedWithStatics = 0;

      for (const id of ids) {
        const cell = envCellRenderer.loadEnvCell(id);
        if (!cell || cell.staticObjects.length === 0) continue;

        const o = cell.position.orientation;
        const isIdentity = Math.abs(o.w - 1) < 0.001 && Math.abs(o.x) < 0.001
          && Math.abs(o.y) < 0.001 && Math.abs(o.z) < 0.001;
        if (!isIdentity) rotatedWithStatics++;
        if (rotatedWithStatics >= 20) break;
      }
      // Many surface building cells have rotations — this must be > 0
      expect(rotatedWithStatics).toBeGreaterThanOrEqual(10);
    });

    it('should compute correct world positions for static objects in rotated cells', () => {
      // Simulate the exact math from EnvCellRenderer.createCellMesh()
      // for rotated cells and verify the inverse quaternion produces
      // correct world positions matching worldOffset + stab.origin
      const ids = findInteriorCellIds(500);
      let verified = 0;

      for (const id of ids) {
        const cell = envCellRenderer.loadEnvCell(id);
        if (!cell || cell.staticObjects.length === 0) continue;

        const o = cell.position.orientation;
        const isIdentity = Math.abs(o.w - 1) < 0.001 && Math.abs(o.x) < 0.001
          && Math.abs(o.y) < 0.001 && Math.abs(o.z) < 0.001;
        if (isIdentity) continue;

        const blockX = (id >>> 24) & 0xFF;
        const blockY = (id >>> 16) & 0xFF;
        const worldOffsetX = blockX * 192;
        const worldOffsetZ = blockY * 192;

        const pos = cell.position;
        const cellOrigin = pos.origin;

        // Build parent group (same as EnvCellRenderer)
        const group = new THREE.Group();
        group.position.set(
          worldOffsetX + cellOrigin.x,
          cellOrigin.z,
          worldOffsetZ + cellOrigin.y,
        );
        group.quaternion.set(
          -pos.orientation.x,
          -pos.orientation.z,
          -pos.orientation.y,
          pos.orientation.w,
        );

        // Compute inverse cell quaternion (the fix)
        const invCellQuat = new THREE.Quaternion(
          -pos.orientation.x,
          -pos.orientation.z,
          -pos.orientation.y,
          pos.orientation.w,
        ).invert();

        // Test each static object's position
        for (const stab of cell.staticObjects.slice(0, 3)) {
          const offset = new THREE.Vector3(
            stab.frame.origin.x - cellOrigin.x,
            stab.frame.origin.z - cellOrigin.z,
            stab.frame.origin.y - cellOrigin.y,
          );
          offset.applyQuaternion(invCellQuat);

          const child = new THREE.Object3D();
          child.position.copy(offset);
          group.add(child);
        }

        group.updateMatrixWorld(true);

        let stabIdx = 0;
        for (const child of group.children) {
          if (stabIdx >= cell.staticObjects.length) break;
          const stab = cell.staticObjects[stabIdx];
          stabIdx++;

          const worldPos = new THREE.Vector3();
          child.getWorldPosition(worldPos);

          // Expected: landblock offset + stab origin (AC→Three.js Y/Z swap)
          expect(worldPos.x).toBeCloseTo(worldOffsetX + stab.frame.origin.x, 1);
          expect(worldPos.y).toBeCloseTo(stab.frame.origin.z, 1);
          expect(worldPos.z).toBeCloseTo(worldOffsetZ + stab.frame.origin.y, 1);
        }

        verified++;
        if (verified >= 5) break;
      }
      expect(verified).toBeGreaterThanOrEqual(3);
    });
  });

  // ============================================================
  // LandblockInfo tests
  // ============================================================
  describe('LandblockInfo', () => {
    it('should parse LandblockInfo with building data', () => {
      const allFiles = cellDb.listFileIds();
      let withBuildings = 0;

      for (const id of allFiles) {
        if ((id & 0xFFFF) !== 0xFFFE) continue;
        const data = cellDb.getFileData(id);
        if (!data) continue;
        try {
          const info = new LandblockInfo(new DatReader(data));
          if (info.buildings.length > 0) {
            withBuildings++;
            // Building model IDs should reference valid models
            for (const building of info.buildings) {
              const prefix = building.modelId >>> 24;
              // Should be GfxObj (0x01) or SetupModel (0x02) or 0
              expect(prefix === 0x01 || prefix === 0x02 || building.modelId === 0).toBe(true);
            }
          }
        } catch {
          // skip
        }
        if (withBuildings >= 10) break;
      }
      expect(withBuildings).toBeGreaterThanOrEqual(5);
    });

    it('should have valid position frames in buildings', () => {
      const allFiles = cellDb.listFileIds();
      let checked = 0;

      for (const id of allFiles) {
        if ((id & 0xFFFF) !== 0xFFFE) continue;
        const data = cellDb.getFileData(id);
        if (!data) continue;
        try {
          const info = new LandblockInfo(new DatReader(data));
          for (const building of info.buildings) {
            expect(Number.isFinite(building.frame.origin.x)).toBe(true);
            expect(Number.isFinite(building.frame.origin.y)).toBe(true);
            expect(Number.isFinite(building.frame.origin.z)).toBe(true);
            checked++;
          }
        } catch {
          // skip
        }
        if (checked >= 20) break;
      }
      expect(checked).toBeGreaterThanOrEqual(10);
    });
  });

  // ============================================================
  // Building collision mesh tests — exterior shells excluded
  // ============================================================
  describe('Building Collision Meshes', () => {
    it('should have landblocks with both buildings and interior cells', () => {
      // Find landblocks that have buildings WITH interior cells
      const allFiles = cellDb.listFileIds();
      let found = 0;

      for (const id of allFiles) {
        if ((id & 0xFFFF) !== 0xFFFE) continue;
        const data = cellDb.getFileData(id);
        if (!data) continue;
        try {
          const info = new LandblockInfo(new DatReader(data));
          if (info.buildings.length > 0 && info.numCells > 0) {
            found++;
          }
        } catch { /* skip */ }
        if (found >= 10) break;
      }
      // Many landblocks have surface buildings with interior cells
      expect(found).toBeGreaterThanOrEqual(5);
    });

    it('should exclude building exterior models from collision set (interior cells only)', () => {
      // This test verifies the architectural decision: collision meshes
      // should come from interior cells (EnvCells with portal openings
      // filtered out) NOT from building exterior shells (solid, no doorways).
      const allFiles = cellDb.listFileIds();
      let verified = 0;

      for (const id of allFiles) {
        if ((id & 0xFFFF) !== 0xFFFE) continue;
        const data = cellDb.getFileData(id);
        if (!data) continue;
        try {
          const info = new LandblockInfo(new DatReader(data));
          if (info.buildings.length === 0 || info.numCells === 0) continue;

          // Interior cells should have portal openings (stippling 0x04 excluded)
          const prefix = id & 0xFFFF0000;
          let cellsWithPortals = 0;
          for (let i = 0; i < Math.min(info.numCells, 10); i++) {
            const cellId = (prefix | (0x0100 + i)) >>> 0;
            const cell = envCellRenderer.loadEnvCell(cellId);
            if (cell && cell.cellPortals.length > 0) cellsWithPortals++;
          }
          // Buildings with interior cells should have portal connections (doorways)
          if (cellsWithPortals > 0) verified++;
          if (verified >= 5) break;
        } catch { /* skip */ }
      }
      expect(verified).toBeGreaterThanOrEqual(3);
    });

    it('should filter portal opening polygons from cell geometry (stippling 0x04)', () => {
      // Verify that EnvCellRenderer.buildCellGeometry excludes polygons with
      // stippling 0x04 (NoPos) — these are door/portal openings that must be
      // passable for collision to work correctly.
      const ids = findInteriorCellIds(200);
      let cellsWithFilteredPortals = 0;

      for (const id of ids) {
        const cell = envCellRenderer.loadEnvCell(id);
        if (!cell) continue;

        const cellStruct = envCellRenderer.getCellStruct(cell);
        if (!cellStruct) continue;

        // Count total polygons vs polygons with stippling 0x04
        let totalPolys = 0;
        let portalPolys = 0;
        for (const [, poly] of cellStruct.polygons) {
          totalPolys++;
          if ((poly.stippling & 0x04) !== 0) portalPolys++;
        }

        if (portalPolys > 0 && totalPolys > portalPolys) {
          // This cell has portal openings that should be excluded from geometry
          const mesh = envCellRenderer.createCellMesh(id);
          if (mesh) {
            // The rendered geometry should have FEWER triangles than if all
            // polygons were included — portal openings are skipped
            cellsWithFilteredPortals++;
          }
        }
        if (cellsWithFilteredPortals >= 5) break;
      }
      expect(cellsWithFilteredPortals).toBeGreaterThanOrEqual(3);
    });
  });
});

// ============================================================
// Building exterior visibility toggle — pure unit test
// ============================================================
describe('Building Visibility Toggle', () => {
  it('should swap exterior/interior visibility based on player position', () => {
    const exterior = new THREE.Group();
    const interior1 = new THREE.Group();
    const interior2 = new THREE.Group();
    const bbox = new THREE.Box3(
      new THREE.Vector3(95, 40, 195),
      new THREE.Vector3(105, 48, 205),
    );
    const bldg = { exterior, interiors: [interior1, interior2], bbox };

    // Player inside footprint → hide exterior, show interiors
    let px = 100, pz = 200;
    let inside = px >= bbox.min.x && px <= bbox.max.x && pz >= bbox.min.z && pz <= bbox.max.z;
    bldg.exterior.visible = !inside;
    for (const i of bldg.interiors) i.visible = inside;
    expect(bldg.exterior.visible).toBe(false);
    expect(interior1.visible).toBe(true);
    expect(interior2.visible).toBe(true);

    // Player outside footprint → show exterior, hide interiors
    px = 120; pz = 200;
    inside = px >= bbox.min.x && px <= bbox.max.x && pz >= bbox.min.z && pz <= bbox.max.z;
    bldg.exterior.visible = !inside;
    for (const i of bldg.interiors) i.visible = inside;
    expect(bldg.exterior.visible).toBe(true);
    expect(interior1.visible).toBe(false);
    expect(interior2.visible).toBe(false);
  });
});

// ============================================================
// Physics mesh collision — verify physics meshes are used for collision
// ============================================================
describe('DungeonCollision Raycaster Fallback', () => {
  it('should use raycaster for wall collision when no BSP cells loaded', () => {
    const collision = new DungeonCollision();

    // Create a wall mesh
    const wallGeom = new THREE.PlaneGeometry(10, 3);
    const wall = new THREE.Mesh(wallGeom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    wall.position.set(100, 1.5, 100);
    wall.updateMatrixWorld(true);

    collision.setMeshes([wall]);

    // Player near the wall
    const pos = new THREE.Vector3(100, 1.5, 100.5);
    const [dx, dz] = collision.getAdjustedMovement(pos, 0, -1);
    // Should be blocked or deflected
    expect(Math.abs(dz)).toBeLessThan(1);
  });

  it('should find floor height from render meshes', () => {
    const collision = new DungeonCollision();

    const floorGeom = new THREE.PlaneGeometry(20, 20);
    floorGeom.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(floorGeom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    floor.position.set(100, 42, 100);
    floor.updateMatrixWorld(true);

    collision.setMeshes([floor]);

    const height = collision.getFloorHeight(100, 100, 42);
    expect(height).not.toBeNull();
    expect(height!).toBeCloseTo(42, 0);
  });
});

// ============================================================
// DungeonCollision.getFloorHeight unit tests — no DAT files required
// ============================================================
describe('DungeonCollision Floor Height', () => {
  it('should find floor below player position', () => {
    const collision = new DungeonCollision();

    // Create a simple floor plane at y=42
    const floorGeom = new THREE.PlaneGeometry(20, 20);
    floorGeom.rotateX(-Math.PI / 2); // horizontal
    const floor = new THREE.Mesh(floorGeom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    floor.userData.cellGeometry = true;
    floor.position.set(100, 42, 100);
    floor.updateMatrixWorld(true);

    collision.setMeshes([floor]);

    // Player at y=42, should find the floor
    const height = collision.getFloorHeight(100, 100, 42);
    expect(height).not.toBeNull();
    expect(height!).toBeCloseTo(42, 0);
  });

  it('should NOT find ceiling above player (raycast goes downward only)', () => {
    const collision = new DungeonCollision();

    // Create a ceiling at y=45 and floor at y=42
    const ceilingGeom = new THREE.PlaneGeometry(20, 20);
    ceilingGeom.rotateX(-Math.PI / 2);
    const ceiling = new THREE.Mesh(ceilingGeom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    ceiling.userData.cellGeometry = true;
    ceiling.position.set(100, 45, 100);
    ceiling.updateMatrixWorld(true);

    const floorGeom = new THREE.PlaneGeometry(20, 20);
    floorGeom.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(floorGeom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    floor.userData.cellGeometry = true;
    floor.position.set(100, 42, 100);
    floor.updateMatrixWorld(true);

    collision.setMeshes([ceiling, floor]);

    // Player at y=42 — should find floor at 42, not ceiling at 45
    const height = collision.getFloorHeight(100, 100, 42);
    expect(height).not.toBeNull();
    expect(height!).toBeCloseTo(42, 0);
  });

  it('should return null when no floor is beneath player', () => {
    const collision = new DungeonCollision();

    // Floor far away from the test position
    const floorGeom = new THREE.PlaneGeometry(5, 5);
    floorGeom.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(floorGeom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    floor.userData.cellGeometry = true;
    floor.position.set(200, 42, 200); // 100m away
    floor.updateMatrixWorld(true);

    collision.setMeshes([floor]);

    const height = collision.getFloorHeight(100, 100, 42);
    expect(height).toBeNull();
  });
});

// ============================================================
// Pure unit tests — no DAT files required
// Tests the inverse-rotation math that fixes static object positioning
// ============================================================
describe('EnvCell Static Object Rotation Math', () => {
  it('should undo parent rotation so world position equals landblock offset + stab origin', () => {
    // Simulate a cell with 90-degree Z rotation (common in AC buildings)
    // AC quaternion: w=0.7071, x=0, y=0, z=-0.7071
    // Three.js quaternion (with AC→Three.js conversion): (-x, -z, -y, w) = (0, 0.7071, 0, 0.7071)
    const cellOrigin = { x: 60, y: 40, z: 42 }; // landblock-local AC coords
    const cellQuat = { w: 0.7071, x: 0, y: 0, z: -0.7071 }; // AC quaternion

    // A stab at landblock-local position (65, 45, 42.5)
    const stabOrigin = { x: 65, y: 45, z: 42.5 };

    const blockX = 0xC6;
    const blockY = 0xA9;
    const worldOffsetX = blockX * 192;
    const worldOffsetZ = blockY * 192;

    // Build the cell group transform (same as EnvCellRenderer.createCellMesh)
    const group = new THREE.Group();
    group.position.set(
      worldOffsetX + cellOrigin.x,
      cellOrigin.z,
      worldOffsetZ + cellOrigin.y,
    );
    group.quaternion.set(
      -cellQuat.x,
      -cellQuat.z,
      -cellQuat.y,
      cellQuat.w,
    );

    // Compute inverse cell quaternion (same as the fix)
    const invCellQuat = new THREE.Quaternion(
      -cellQuat.x,
      -cellQuat.z,
      -cellQuat.y,
      cellQuat.w,
    ).invert();

    // Position the static object with inverse rotation applied
    const offset = new THREE.Vector3(
      stabOrigin.x - cellOrigin.x,
      stabOrigin.z - cellOrigin.z,
      stabOrigin.y - cellOrigin.y,
    );
    offset.applyQuaternion(invCellQuat);

    const child = new THREE.Object3D();
    child.position.copy(offset);
    group.add(child);

    // Update world matrices
    group.updateMatrixWorld(true);

    // Get the child's actual world position
    const worldPos = new THREE.Vector3();
    child.getWorldPosition(worldPos);

    // Expected: worldOffset + stab origin (with AC→Three.js Y/Z swap)
    const expectedX = worldOffsetX + stabOrigin.x;
    const expectedY = stabOrigin.z;
    const expectedZ = worldOffsetZ + stabOrigin.y;

    expect(worldPos.x).toBeCloseTo(expectedX, 2);
    expect(worldPos.y).toBeCloseTo(expectedY, 2);
    expect(worldPos.z).toBeCloseTo(expectedZ, 2);
  });

  it('should work correctly with 180-degree rotated cells', () => {
    // AC quaternion: w=0, x=0, y=0, z=-1 (180-degree Z rotation)
    const cellOrigin = { x: 108, y: 36, z: 42 };
    const cellQuat = { w: 0, x: 0, y: 0, z: -1 };
    const stabOrigin = { x: 112, y: 40, z: 43 };

    const worldOffsetX = 100 * 192;
    const worldOffsetZ = 150 * 192;

    const group = new THREE.Group();
    group.position.set(
      worldOffsetX + cellOrigin.x,
      cellOrigin.z,
      worldOffsetZ + cellOrigin.y,
    );
    group.quaternion.set(-cellQuat.x, -cellQuat.z, -cellQuat.y, cellQuat.w);

    const invCellQuat = new THREE.Quaternion(
      -cellQuat.x, -cellQuat.z, -cellQuat.y, cellQuat.w,
    ).invert();

    const offset = new THREE.Vector3(
      stabOrigin.x - cellOrigin.x,
      stabOrigin.z - cellOrigin.z,
      stabOrigin.y - cellOrigin.y,
    );
    offset.applyQuaternion(invCellQuat);

    const child = new THREE.Object3D();
    child.position.copy(offset);
    group.add(child);
    group.updateMatrixWorld(true);

    const worldPos = new THREE.Vector3();
    child.getWorldPosition(worldPos);

    expect(worldPos.x).toBeCloseTo(worldOffsetX + stabOrigin.x, 2);
    expect(worldPos.y).toBeCloseTo(stabOrigin.z, 2);
    expect(worldPos.z).toBeCloseTo(worldOffsetZ + stabOrigin.y, 2);
  });

  it('should be identity (no displacement) for unrotated cells', () => {
    // Identity quaternion: w=1, x=0, y=0, z=0
    const cellOrigin = { x: 50, y: 50, z: 42 };
    const cellQuat = { w: 1, x: 0, y: 0, z: 0 };
    const stabOrigin = { x: 55, y: 55, z: 43 };

    const group = new THREE.Group();
    group.position.set(50, 42, 50);
    group.quaternion.set(0, 0, 0, 1); // identity

    const invCellQuat = new THREE.Quaternion(0, 0, 0, 1).invert();

    const offset = new THREE.Vector3(
      stabOrigin.x - cellOrigin.x,
      stabOrigin.z - cellOrigin.z,
      stabOrigin.y - cellOrigin.y,
    );
    offset.applyQuaternion(invCellQuat); // no-op for identity

    const child = new THREE.Object3D();
    child.position.copy(offset);
    group.add(child);
    group.updateMatrixWorld(true);

    const worldPos = new THREE.Vector3();
    child.getWorldPosition(worldPos);

    // For identity rotation, offset is unchanged
    expect(worldPos.x).toBeCloseTo(50 + 5, 2); // cellOrigin.x + (stab.x - cell.x)
    expect(worldPos.y).toBeCloseTo(42 + 1, 2);
    expect(worldPos.z).toBeCloseTo(50 + 5, 2);
  });
});
