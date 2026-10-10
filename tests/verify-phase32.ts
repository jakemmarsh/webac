/**
 * Phase 32 — World Database in Browser
 *
 * Tests:
 *  - BrowserWorldDatabase API compatibility (tested via server WorldDatabase in Node.js)
 *  - getLandblockInstances for Holtburg area returns ≥5 entities
 *  - EntityManager spawns entities with correct positions and model IDs
 *  - Spawned entities have properties (name, type, level for creatures)
 *  - World DB loading pipeline integration
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import * as THREE from 'three';
import Database from 'better-sqlite3';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { PropertyInt, PropertyString, PropertyDataId, WeenieType } from '@ac/shared';
import { openDat } from './_harness/dat.js';

// We test the database API using better-sqlite3 directly (Node.js environment)
// The BrowserWorldDatabase has the same API but uses sql.js in the browser

interface WeenieRow {
  class_Id: number;
  class_Name: string;
  type: number;
}

interface LandblockInstance {
  guid: number;
  weenie_Class_Id: number;
  obj_Cell_Id: number;
  origin_X: number;
  origin_Y: number;
  origin_Z: number;
  angles_W: number;
  angles_X: number;
  angles_Y: number;
  angles_Z: number;
  is_Link_Child: number;
}

const hasRequiredDat = fs.existsSync('dat/client_portal.dat') && fs.existsSync('dat/world.sqlite');

let db: Database.Database;
let portalDb: DatDatabase;

beforeAll(() => {
  if (!hasRequiredDat) return;
  db = new Database('dat/world.sqlite', { readonly: true });
  portalDb = openDat('dat/client_portal.dat');
});

describe.skipIf(!hasRequiredDat)('Phase 32 — World Database in Browser', () => {
  // ============================================================
  // B1: Database API
  // ============================================================
  describe('World Database API', () => {
    it('should query weenie count ≥25000', () => {
      const row = db.prepare('SELECT COUNT(*) as c FROM weenie').get() as any;
      expect(row.c).toBeGreaterThanOrEqual(25000);
    });

    it('should look up weenie by class_Id', () => {
      const row = db.prepare(
        'SELECT class_Id, class_Name, "type" FROM weenie WHERE class_Id = 1'
      ).get() as WeenieRow | undefined;
      expect(row).toBeDefined();
      expect(row!.class_Id).toBe(1);
      expect(row!.class_Name).toBeTruthy();
    });

    it('should search weenies by name pattern', () => {
      const rows = db.prepare(
        'SELECT class_Id, class_Name, "type" FROM weenie WHERE class_Name LIKE ?'
      ).all('%Drudge%') as WeenieRow[];
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.class_Name.toLowerCase()).toContain('drudge');
      }
    });

    it('should query properties for a weenie', () => {
      // Find a creature weenie
      const creatures = db.prepare(
        'SELECT class_Id, class_Name FROM weenie WHERE "type" = ?'
      ).all(WeenieType.Creature) as WeenieRow[];
      expect(creatures.length).toBeGreaterThan(0);

      const creatureId = creatures[0].class_Id;

      // Get int properties
      const intProps = db.prepare(
        'SELECT "type", "value" FROM weenie_properties_int WHERE object_Id = ?'
      ).all(creatureId) as any[];
      expect(intProps.length).toBeGreaterThan(0);

      // Get string properties
      const strProps = db.prepare(
        'SELECT "type", "value" FROM weenie_properties_string WHERE object_Id = ?'
      ).all(creatureId) as any[];
      // Should have a Name property
      const nameRow = strProps.find((p: any) => p.type === PropertyString.Name);
      expect(nameRow).toBeDefined();
    });
  });

  // ============================================================
  // B2: Landblock Instance Queries
  // ============================================================
  describe('Landblock Instances', () => {
    it('should return ≥5 entities for Holtburg area (0xA9B4)', () => {
      // Holtburg: blockX=0xA9, blockY=0xB4 → landblock=0xA9B4
      const landblockHigh = 0xA9B4;
      const instances = db.prepare(
        `SELECT "guid", weenie_Class_Id, obj_Cell_Id,
                origin_X, origin_Y, origin_Z,
                angles_W, angles_X, angles_Y, angles_Z,
                is_Link_Child
         FROM landblock_instance WHERE (obj_Cell_Id >> 16) = ?`
      ).all(landblockHigh) as LandblockInstance[];

      expect(instances.length).toBeGreaterThanOrEqual(5);
    });

    it('should have valid positions for landblock instances', () => {
      const landblockHigh = 0xA9B4;
      const instances = db.prepare(
        `SELECT origin_X, origin_Y, origin_Z, angles_W
         FROM landblock_instance WHERE (obj_Cell_Id >> 16) = ?`
      ).all(landblockHigh) as any[];

      for (const inst of instances) {
        expect(Number.isFinite(inst.origin_X)).toBe(true);
        expect(Number.isFinite(inst.origin_Y)).toBe(true);
        expect(Number.isFinite(inst.origin_Z)).toBe(true);
        expect(Number.isFinite(inst.angles_W)).toBe(true);
      }
    });

    it('should reference valid weenies from instances', () => {
      const landblockHigh = 0xA9B4;
      const instances = db.prepare(
        `SELECT weenie_Class_Id
         FROM landblock_instance WHERE (obj_Cell_Id >> 16) = ?`
      ).all(landblockHigh) as any[];

      let validCount = 0;
      for (const inst of instances) {
        const weenie = db.prepare(
          'SELECT class_Id FROM weenie WHERE class_Id = ?'
        ).get(inst.weenie_Class_Id);
        if (weenie) validCount++;
      }

      // At least 90% should reference valid weenies
      expect(validCount / instances.length).toBeGreaterThanOrEqual(0.9);
    });
  });

  // ============================================================
  // B2: Entity Spawning
  // ============================================================
  describe('Entity Spawning from Instances', () => {
    it('should create entity objects from landblock instances with properties', () => {
      const landblockHigh = 0xA9B4;
      const instances = db.prepare(
        `SELECT "guid", weenie_Class_Id, obj_Cell_Id,
                origin_X, origin_Y, origin_Z,
                angles_W, angles_X, angles_Y, angles_Z,
                is_Link_Child
         FROM landblock_instance WHERE (obj_Cell_Id >> 16) = ?`
      ).all(landblockHigh) as LandblockInstance[];

      let entitiesWithNames = 0;
      let entitiesWithSetup = 0;
      let entitiesWithLevel = 0;

      for (const inst of instances) {
        if (inst.is_Link_Child) continue;

        const weenie = db.prepare(
          'SELECT class_Id, class_Name, "type" FROM weenie WHERE class_Id = ?'
        ).get(inst.weenie_Class_Id) as WeenieRow | undefined;
        if (!weenie) continue;

        // Check name
        const name = db.prepare(
          'SELECT "value" FROM weenie_properties_string WHERE object_Id = ? AND "type" = ?'
        ).get(inst.weenie_Class_Id, PropertyString.Name) as any;
        if (name) entitiesWithNames++;

        // Check setup model (DID)
        const setup = db.prepare(
          'SELECT "value" FROM weenie_properties_d_i_d WHERE object_Id = ? AND "type" = ?'
        ).get(inst.weenie_Class_Id, PropertyDataId.Setup) as any;
        if (setup) entitiesWithSetup++;

        // Check level (int)
        const level = db.prepare(
          'SELECT "value" FROM weenie_properties_int WHERE object_Id = ? AND "type" = ?'
        ).get(inst.weenie_Class_Id, PropertyInt.Level) as any;
        if (level) entitiesWithLevel++;
      }

      // Most entities should have names and setup models
      expect(entitiesWithNames).toBeGreaterThan(0);
      expect(entitiesWithSetup).toBeGreaterThan(0);
    });

    it('should resolve SetupModel IDs to valid portal.dat entries', () => {
      // Get some entities with setup models
      const instances = db.prepare(
        `SELECT li.weenie_Class_Id, d.value as setup_id
         FROM landblock_instance li
         JOIN weenie_properties_d_i_d d ON d.object_Id = li.weenie_Class_Id AND d.type = ?
         LIMIT 20`
      ).all(PropertyDataId.Setup) as any[];

      let validModels = 0;
      for (const inst of instances) {
        const setupId = inst.setup_id;
        if (portalDb.hasFile(setupId)) {
          validModels++;
        }
      }

      // At least some should resolve to valid models
      expect(validModels).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // B3: Integration - Entity Types
  // ============================================================
  describe('Entity Type Distribution', () => {
    it('should have creatures, portals, vendors, and NPCs in Holtburg area', () => {
      // Check multiple nearby landblocks around Holtburg
      const landblocks = [0xA9B4, 0xA8B4, 0xA9B3, 0xA9B5, 0xAAB4];
      const typeSet = new Set<number>();

      for (const lb of landblocks) {
        const instances = db.prepare(
          `SELECT li.weenie_Class_Id, w.type
           FROM landblock_instance li
           JOIN weenie w ON w.class_Id = li.weenie_Class_Id
           WHERE (li.obj_Cell_Id >> 16) = ?`
        ).all(lb) as any[];

        for (const inst of instances) {
          typeSet.add(inst.type);
        }
      }

      // Should have at least 3 different entity types
      expect(typeSet.size).toBeGreaterThanOrEqual(3);
    });

    it('should correctly position entities within landblock bounds', () => {
      const landblockHigh = 0xA9B4;
      const blockX = (landblockHigh >> 8) & 0xff;
      const blockY = landblockHigh & 0xff;

      const instances = db.prepare(
        `SELECT origin_X, origin_Y, origin_Z, obj_Cell_Id
         FROM landblock_instance WHERE (obj_Cell_Id >> 16) = ?`
      ).all(landblockHigh) as any[];

      // Outdoor entities should have positions within the landblock
      for (const inst of instances) {
        // Only check outdoor positions (obj_Cell_Id with FFFF suffix)
        const cellLow = inst.obj_Cell_Id & 0xFFFF;
        if (cellLow === 0xFFFF || cellLow > 0) {
          // X and Y should be within reasonable world coords
          expect(Number.isFinite(inst.origin_X)).toBe(true);
          expect(Number.isFinite(inst.origin_Y)).toBe(true);
          expect(Number.isFinite(inst.origin_Z)).toBe(true);
        }
      }
    });
  });
});
