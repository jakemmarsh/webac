/**
 * Verify BSP collision coordinate transforms end-to-end.
 *
 * Tests the full chain: Three.js world pos → AC landblock-local → cell-local → BSP query.
 * Uses real DAT data to ensure the transform produces correct collision results.
 *
 * Reference: ACE AFrame.GlobalToLocal (AFrame.cs:57-68):
 *   offset = point - Origin
 *   result = Transpose(RotationMatrix(Orientation)) * offset
 * Which is equivalent to: conjugate(quat) * (point - origin) = invQuat * offset
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { EnvCell } from '@ac/dat-parser/file-types/EnvCell.js';
import { Environment } from '@ac/dat-parser/file-types/Environment.js';
import {
  buildCollisionBSP, sphereIntersectsPoly, findFloorHeight,
} from '@ac/shared';
import type { CollisionSphere } from '@ac/shared';
import { openDat } from './_harness/dat.js';

const hasDAT = fs.existsSync('dat/client_portal.dat') && fs.existsSync('dat/client_cell_1.dat');

// Simple quaternion math (AC Z-up space, no Three.js dependency)
function quatConjugate(q: { w: number; x: number; y: number; z: number }) {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

function quatRotate(q: { w: number; x: number; y: number; z: number }, v: { x: number; y: number; z: number }) {
  // q * v * q^-1
  const qw = q.w, qx = q.x, qy = q.y, qz = q.z;
  // q * v (v as quaternion with w=0)
  const tw = -qx * v.x - qy * v.y - qz * v.z;
  const tx = qw * v.x + qy * v.z - qz * v.y;
  const ty = qw * v.y + qz * v.x - qx * v.z;
  const tz = qw * v.z + qx * v.y - qy * v.x;
  // result * q^-1 (conjugate for unit quat)
  return {
    x: tx * qw - tw * qx - ty * qz + tz * qy,
    y: ty * qw - tw * qy - tz * qx + tx * qz,
    z: tz * qw - tw * qz - tx * qy + ty * qx,
  };
}

/** ACE AFrame.GlobalToLocal: subtract origin, rotate by inverse quaternion */
function globalToLocal(
  origin: { x: number; y: number; z: number },
  quat: { w: number; x: number; y: number; z: number },
  point: { x: number; y: number; z: number },
) {
  const offset = { x: point.x - origin.x, y: point.y - origin.y, z: point.z - origin.z };
  const invQ = quatConjugate(quat);
  return quatRotate(invQ, offset);
}

describe.skipIf(!hasDAT)('BSP Coordinate Transform Verification', () => {
  let portalDb: DatDatabase;
  let cellDb: DatDatabase;

  const loadCell = (cellId: number) => {
    const data = cellDb.getFileData(cellId);
    return data ? new EnvCell(new DatReader(data)) : null;
  };

  const loadCellStruct = (envCell: EnvCell) => {
    const envData = portalDb.getFileData(envCell.environmentId);
    if (!envData) return null;
    const env = new Environment(new DatReader(envData));
    return env.cells.get(envCell.cellStructure) ?? null;
  };

  if (hasDAT) {
    portalDb = openDat('dat/client_portal.dat');
    cellDb = openDat('dat/client_cell_1.dat');
  }

  it('should transform cell origin to (0,0,0) in cell-local space', () => {
    const cellId = 0xC6A90104;
    const envCell = loadCell(cellId)!;
    const pos = envCell.position;

    // Transform the cell's own origin to cell-local → should be (0,0,0)
    const local = globalToLocal(pos.origin, pos.orientation, pos.origin);
    expect(local.x).toBeCloseTo(0, 3);
    expect(local.y).toBeCloseTo(0, 3);
    expect(local.z).toBeCloseTo(0, 3);
  });

  it('should find floor at (0,0,0) in cell-local space', () => {
    const cellId = 0xC6A90104;
    const envCell = loadCell(cellId)!;
    const cellStruct = loadCellStruct(envCell)!;

    const bsp = buildCollisionBSP(
      cellStruct.physicsBSP.rootNode,
      cellStruct.physicsPolygons,
      cellStruct.vertexArray,
    );

    // Cell-local (0,0,0) should be on the floor
    const floorZ = findFloorHeight(bsp, 0, 0, 0);
    console.log(`Cell 0x${cellId.toString(16)}: floor at local (0,0) = ${floorZ}`);
    expect(floorZ).not.toBeNull();
    // Floor should be near Z=0 in cell-local space
    expect(Math.abs(floorZ!)).toBeLessThan(1.0);
  });

  it('should find walls at cell boundaries in cell-local space', () => {
    const cellId = 0xC6A90104;
    const envCell = loadCell(cellId)!;
    const cellStruct = loadCellStruct(envCell)!;

    const bsp = buildCollisionBSP(
      cellStruct.physicsBSP.rootNode,
      cellStruct.physicsPolygons,
      cellStruct.vertexArray,
    );

    // Collect all wall polygon normals to check their direction
    const wallNormals: string[] = [];
    function dumpNode(node: any) {
      if (node.polygons) {
        for (const poly of node.polygons) {
          if (Math.abs(poly.plane.normal.z) < 0.3) { // wall
            const n = poly.plane.normal;
            const cx = poly.vertices.reduce((s: number, v: any) => s + v.x, 0) / poly.vertices.length;
            const cy = poly.vertices.reduce((s: number, v: any) => s + v.y, 0) / poly.vertices.length;
            wallNormals.push(`center=(${cx.toFixed(1)},${cy.toFixed(1)}) normal=(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)})`);
          }
        }
      }
      if (node.posNode) dumpNode(node.posNode);
      if (node.negNode) dumpNode(node.negNode);
    }
    dumpNode(bsp);
    console.log(`Wall polygon normals (${wallNormals.length}):`);
    for (const w of wallNormals.slice(0, 8)) console.log(`  ${w}`);

    // The key insight: normals may point OUTWARD (away from room center at 0,0).
    // A wall at X=+4 with normal pointing +X means dot(east_movement, +X) > 0 → backface cull!
    // So we need to check: do normals point away from center?
    let outward = 0, inward = 0;
    for (const w of wallNormals) {
      const match = w.match(/center=\(([-\d.]+),([-\d.]+)\).*normal=\(([-\d.]+),([-\d.]+)/);
      if (!match) continue;
      const cx = parseFloat(match[1]), cy = parseFloat(match[2]);
      const nx = parseFloat(match[3]), ny = parseFloat(match[4]);
      // Dot(center, normal) > 0 means normal points AWAY from origin (outward)
      if (cx * nx + cy * ny > 0) outward++;
      else inward++;
    }
    console.log(`Outward-facing: ${outward}, Inward-facing: ${inward}`);
    expect(wallNormals.length).toBeGreaterThan(0);

    // BSP collision tests sphere at DESTINATION, not along a path.
    // Test sphere at wall boundary positions (where player would be after moving)
    let wallHitsAtBoundary = 0;
    for (const [px, py] of [[4.2, 0], [-4.2, 0], [0, 1.7], [0, -1.7]]) {
      const destSphere: CollisionSphere = { center: { x: px, y: py, z: 1.0 }, radius: 0.4 };
      const movement = { x: px > 0 ? 1 : px < 0 ? -1 : 0, y: py > 0 ? 1 : py < 0 ? -1 : 0, z: 0 };
      const hit = sphereIntersectsPoly(bsp, destSphere, movement);
      if (hit) wallHitsAtBoundary++;
    }
    console.log(`Wall hits at boundary positions: ${wallHitsAtBoundary}/4`);
    expect(wallHitsAtBoundary).toBeGreaterThan(0);
  });

  it('should correctly transform Three.js world → AC landblock → cell-local', () => {
    const cellId = 0xC6A90104;
    const envCell = loadCell(cellId)!;
    const pos = envCell.position;

    // Cell origin in AC Z-up landblock-local: (60.81, 36.69, 42.00)
    // Cell quaternion: (w=0.7071, x=0, y=0, z=-0.7071) — 90° rotation around Z
    console.log(`Cell origin (AC Z-up): (${pos.origin.x.toFixed(2)}, ${pos.origin.y.toFixed(2)}, ${pos.origin.z.toFixed(2)})`);
    console.log(`Cell quat: (w=${pos.orientation.w.toFixed(4)}, x=${pos.orientation.x.toFixed(4)}, y=${pos.orientation.y.toFixed(4)}, z=${pos.orientation.z.toFixed(4)})`);

    const blockX = (cellId >>> 24) & 0xFF; // 0xC6 = 198
    const blockY = (cellId >>> 16) & 0xFF; // 0xA9 = 169

    // Three.js world position at cell center:
    // worldX = blockX * 192 + origin.x, worldY = origin.z, worldZ = blockY * 192 + origin.y
    const worldX = blockX * 192 + pos.origin.x;
    const worldY = pos.origin.z; // AC Z → Three.js Y
    const worldZ = blockY * 192 + pos.origin.y; // AC Y → Three.js Z

    // Step 1: Three.js world → AC landblock-local
    // AC x = worldX - blockX*192, AC y = worldZ - blockY*192, AC z = worldY
    const acLocal = {
      x: worldX - blockX * 192,  // = origin.x
      y: worldZ - blockY * 192,  // = origin.y
      z: worldY,                  // = origin.z
    };
    expect(acLocal.x).toBeCloseTo(pos.origin.x, 3);
    expect(acLocal.y).toBeCloseTo(pos.origin.y, 3);
    expect(acLocal.z).toBeCloseTo(pos.origin.z, 3);

    // Step 2: AC landblock-local → cell-local via GlobalToLocal
    const cellLocal = globalToLocal(pos.origin, pos.orientation, acLocal);
    // At the cell origin, this should be (0, 0, 0)
    expect(cellLocal.x).toBeCloseTo(0, 3);
    expect(cellLocal.y).toBeCloseTo(0, 3);
    expect(cellLocal.z).toBeCloseTo(0, 3);

    // Step 3: Test a point 2m east in Three.js world
    const testWorldX = worldX + 2;
    const testACLocal = {
      x: testWorldX - blockX * 192,  // = origin.x + 2
      y: worldZ - blockY * 192,       // = origin.y
      z: worldY,                       // = origin.z
    };
    const testCellLocal = globalToLocal(pos.origin, pos.orientation, testACLocal);
    console.log(`2m east in world → cell-local: (${testCellLocal.x.toFixed(3)}, ${testCellLocal.y.toFixed(3)}, ${testCellLocal.z.toFixed(3)})`);
    // With 90° Z rotation, AC +X → cell-local +Y (approximately)
    // The exact mapping depends on the quaternion direction
    const dist = Math.sqrt(testCellLocal.x ** 2 + testCellLocal.y ** 2);
    expect(dist).toBeCloseTo(2.0, 1); // Should be 2m from origin in some direction
  });

  it('should find floor after full transform chain', () => {
    const cellId = 0xC6A90104;
    const envCell = loadCell(cellId)!;
    const cellStruct = loadCellStruct(envCell)!;
    const pos = envCell.position;

    const bsp = buildCollisionBSP(
      cellStruct.physicsBSP.rootNode,
      cellStruct.physicsPolygons,
      cellStruct.vertexArray,
    );

    const blockX = (cellId >>> 24) & 0xFF;
    const blockY = (cellId >>> 16) & 0xFF;

    // Three.js world position at cell center
    const worldX = blockX * 192 + pos.origin.x;
    const worldY = pos.origin.z;
    const worldZ = blockY * 192 + pos.origin.y;

    // Full transform chain
    const acLocal = {
      x: worldX - blockX * 192,
      y: worldZ - blockY * 192,
      z: worldY,
    };
    const cellLocal = globalToLocal(pos.origin, pos.orientation, acLocal);

    // Query BSP for floor at this cell-local position
    const floorZ = findFloorHeight(bsp, cellLocal.x, cellLocal.y, cellLocal.z);
    console.log(`Floor at cell center via full transform: ${floorZ}`);
    expect(floorZ).not.toBeNull();

    // Convert floor Z back to Three.js world Y
    // cell-local floor Z → needs to be transformed back to AC landblock → Three.js
    // For now just verify the floor is found
    if (floorZ !== null) {
      // Floor Z should be near 0 (cell-local ground level)
      expect(Math.abs(floorZ)).toBeLessThan(1.0);
    }
  });
});
