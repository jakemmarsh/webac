/**
 * Phase 9 Verification: World DB — MySQL→SQLite Conversion + Data Integrity
 * Tests world.sqlite existence and data integrity using better-sqlite3 directly
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';
import Database from 'better-sqlite3';

const ROOT = resolve(__dirname, '..');
const WORLD_DB = resolve(ROOT, 'dat/world.sqlite');

const hasWorldDb = existsSync(WORLD_DB);

let db: Database.Database;

beforeAll(() => {
  if (!hasWorldDb) return;
  db = new Database(WORLD_DB, { readonly: true });
});

afterAll(() => {
  db?.close();
});

// Helper functions (previously in WorldDatabase class)
function getWeenie(classId: number) {
  return db.prepare('SELECT class_Id, class_Name, "type" FROM weenie WHERE class_Id = ?').get(classId) as any;
}
function getWeenieByName(className: string) {
  return db.prepare('SELECT class_Id, class_Name, "type" FROM weenie WHERE class_Name = ?').get(className) as any;
}
function searchWeenies(pattern: string) {
  return db.prepare('SELECT class_Id, class_Name, "type" FROM weenie WHERE class_Name LIKE ?').all(`%${pattern}%`) as any[];
}
function getWeenieCount() {
  return (db.prepare('SELECT COUNT(*) as c FROM weenie').get() as any).c;
}
function getWeeniesByType(type: number) {
  return db.prepare('SELECT class_Id, class_Name, "type" FROM weenie WHERE "type" = ?').all(type) as any[];
}
function getPropertiesInt(objectId: number) {
  return db.prepare('SELECT object_Id, "type", "value" FROM weenie_properties_int WHERE object_Id = ?').all(objectId) as any[];
}
function getPropertyInt(objectId: number, type: number) {
  const row = db.prepare('SELECT "value" FROM weenie_properties_int WHERE object_Id = ? AND "type" = ?').get(objectId, type) as any;
  return row?.value;
}
function getPropertiesString(objectId: number) {
  return db.prepare('SELECT object_Id, "type", "value" FROM weenie_properties_string WHERE object_Id = ?').all(objectId) as any[];
}
function getPropertyString(objectId: number, type: number) {
  const row = db.prepare('SELECT "value" FROM weenie_properties_string WHERE object_Id = ? AND "type" = ?').get(objectId, type) as any;
  return row?.value;
}
function getPropertiesFloat(objectId: number) {
  return db.prepare('SELECT object_Id, "type", "value" FROM weenie_properties_float WHERE object_Id = ?').all(objectId) as any[];
}
function getPropertiesBool(objectId: number) {
  return db.prepare('SELECT object_Id, "type", "value" FROM weenie_properties_bool WHERE object_Id = ?').all(objectId) as any[];
}
function getPropertiesDID(objectId: number) {
  return db.prepare('SELECT object_Id, "type", "value" FROM weenie_properties_d_i_d WHERE object_Id = ?').all(objectId) as any[];
}
function getLandblockInstances(landblockId: number) {
  return db.prepare(
    `SELECT "guid", weenie_Class_Id, obj_Cell_Id,
            origin_X, origin_Y, origin_Z,
            angles_W, angles_X, angles_Y, angles_Z,
            is_Link_Child
     FROM landblock_instance WHERE landblock = ?`
  ).all(landblockId) as any[];
}
function getLandblockInstanceCount() {
  return (db.prepare('SELECT COUNT(*) as c FROM landblock_instance').get() as any).c;
}
function getWeenieTypeDistribution() {
  const rows = db.prepare('SELECT "type", COUNT(*) as c FROM weenie GROUP BY "type"').all() as any[];
  const map = new Map<number, number>();
  for (const row of rows) map.set(row.type, row.c);
  return map;
}

describe.skipIf(!hasWorldDb)('Phase 9: World DB — MySQL→SQLite + Data Integrity', () => {

  // ───────── Database existence and size ─────────
  describe('Database file', () => {
    it('world.sqlite exists', () => {
      expect(existsSync(WORLD_DB)).toBe(true);
    });
  });

  // ───────── Weenie queries ─────────
  describe('Weenie queries', () => {
    it('has ≥25,000 weenies', () => {
      expect(getWeenieCount()).toBeGreaterThanOrEqual(25000);
    });

    it('getWeenie retrieves Drudge Skulker (class_Id=7)', () => {
      const weenie = getWeenie(7);
      expect(weenie).toBeDefined();
      expect(weenie.class_Id).toBe(7);
      expect(weenie.class_Name).toBe('drudgeskulker');
      expect(weenie.type).toBe(10);
    });

    it('getWeenie retrieves Human (class_Id=1)', () => {
      const weenie = getWeenie(1);
      expect(weenie).toBeDefined();
      expect(weenie.class_Id).toBe(1);
      expect(weenie.class_Name).toBe('human');
      expect(weenie.type).toBe(10);
    });

    it('getWeenieByName finds by name', () => {
      const weenie = getWeenieByName('drudgeskulker');
      expect(weenie).toBeDefined();
      expect(weenie.class_Id).toBe(7);
    });

    it('searchWeenies returns matches for pattern', () => {
      const results = searchWeenies('holtburg');
      expect(results.length).toBeGreaterThanOrEqual(10);
      for (const r of results) {
        expect(r.class_Name.toLowerCase()).toContain('holtburg');
      }
    });

    it('getWeeniesByType returns creatures (type 10)', () => {
      const creatures = getWeeniesByType(10);
      expect(creatures.length).toBeGreaterThanOrEqual(100);
      for (const c of creatures.slice(0, 20)) {
        expect(c.type).toBe(10);
      }
    });

    it('getWeenie returns undefined for non-existent ID', () => {
      const weenie = getWeenie(99999999);
      expect(weenie).toBeUndefined();
    });
  });

  // ───────── Property queries ─────────
  describe('Property queries', () => {
    it('getPropertiesInt returns int properties for Drudge Skulker', () => {
      const props = getPropertiesInt(7);
      expect(props.length).toBeGreaterThan(5);
      for (const p of props) {
        expect(p.object_Id).toBe(7);
        expect(typeof p.type).toBe('number');
        expect(typeof p.value).toBe('number');
      }
    });

    it('getPropertyInt retrieves specific property', () => {
      const value = getPropertyInt(7, 1);
      expect(value).toBeDefined();
      expect(value).toBe(16);
    });

    it('getPropertyInt returns undefined for missing property', () => {
      const value = getPropertyInt(7, 99999);
      expect(value).toBeUndefined();
    });

    it('getPropertiesString returns string properties', () => {
      const props = getPropertiesString(7);
      expect(props.length).toBeGreaterThan(0);
      const nameStr = props.find((p: any) => p.type === 1);
      expect(nameStr).toBeDefined();
      expect(nameStr.value).toBe('Drudge Skulker');
    });

    it('getPropertyString retrieves name', () => {
      expect(getPropertyString(7, 1)).toBe('Drudge Skulker');
    });

    it('getPropertiesFloat returns float properties', () => {
      const props = getPropertiesFloat(7);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) {
        expect(p.object_Id).toBe(7);
        expect(typeof p.value).toBe('number');
        expect(isFinite(p.value)).toBe(true);
      }
    });

    it('getPropertiesBool returns bool properties', () => {
      const props = getPropertiesBool(7);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) {
        expect(p.object_Id).toBe(7);
        expect(p.value === 0 || p.value === 1).toBe(true);
      }
    });

    it('getPropertiesDID returns DID properties', () => {
      const props = getPropertiesDID(7);
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) {
        expect(p.object_Id).toBe(7);
        expect(typeof p.value).toBe('number');
      }
    });
  });

  // ───────── Landblock instance queries ─────────
  describe('Landblock instance queries', () => {
    it('has ≥300,000 landblock instances', () => {
      expect(getLandblockInstanceCount()).toBeGreaterThanOrEqual(300000);
    });

    it('getLandblockInstances returns spawn list with valid positions', () => {
      const instances = getLandblockInstances(262);
      expect(instances.length).toBeGreaterThan(0);
      for (const inst of instances) {
        expect(typeof inst.guid).toBe('number');
        expect(inst.weenie_Class_Id).toBeGreaterThan(0);
        expect(isFinite(inst.origin_X)).toBe(true);
        expect(isFinite(inst.origin_Y)).toBe(true);
        expect(isFinite(inst.origin_Z)).toBe(true);
        expect(isFinite(inst.angles_W)).toBe(true);
        expect(isFinite(inst.angles_X)).toBe(true);
        expect(isFinite(inst.angles_Y)).toBe(true);
        expect(isFinite(inst.angles_Z)).toBe(true);
      }
    });

    it('landblock instances reference valid weenies', () => {
      const instances = getLandblockInstances(262);
      let validCount = 0;
      for (const inst of instances.slice(0, 20)) {
        if (getWeenie(inst.weenie_Class_Id)) validCount++;
      }
      expect(validCount).toBeGreaterThanOrEqual(Math.floor(Math.min(instances.length, 20) * 0.9));
    });

    it('empty landblock returns empty array', () => {
      expect(getLandblockInstances(99999)).toEqual([]);
    });
  });

  // ───────── Weenie type distribution ─────────
  describe('Weenie type distribution', () => {
    it('has ≥100 creatures (type 10)', () => {
      expect(getWeenieTypeDistribution().get(10)).toBeGreaterThanOrEqual(100);
    });

    it('has ≥100 generic items (type 1)', () => {
      expect(getWeenieTypeDistribution().get(1)).toBeGreaterThanOrEqual(100);
    });

    it('has ≥10 vendors (type 12)', () => {
      expect(getWeenieTypeDistribution().get(12)).toBeGreaterThanOrEqual(10);
    });

    it('has ≥10 portals (type 7)', () => {
      expect(getWeenieTypeDistribution().get(7)).toBeGreaterThanOrEqual(10);
    });

    it('distribution covers multiple weenie types', () => {
      expect(getWeenieTypeDistribution().size).toBeGreaterThanOrEqual(10);
    });
  });

  // ───────── Known weenie spot-checks ─────────
  describe('Known weenie spot-checks', () => {
    it('Holtburg portal (class_Id=1020) is type 7 (portal)', () => {
      const weenie = getWeenie(1020);
      expect(weenie).toBeDefined();
      expect(weenie.class_Name).toBe('portalholtburg');
      expect(weenie.type).toBe(7);
    });

    it('portal weenie has position properties', () => {
      const weenie = getWeenie(1020);
      expect(weenie).toBeDefined();
      const intProps = getPropertiesInt(1020);
      expect(intProps.length).toBeGreaterThan(0);
    });

    it('creature weenies have name string property', () => {
      const creatures = getWeeniesByType(10).slice(0, 20);
      let namedCount = 0;
      for (const c of creatures) {
        const name = getPropertyString(c.class_Id, 1);
        if (name && name.length > 0) namedCount++;
      }
      expect(namedCount).toBeGreaterThanOrEqual(15);
    });

    it('vendor weenies exist and have properties', () => {
      const vendors = getWeeniesByType(12);
      expect(vendors.length).toBeGreaterThanOrEqual(10);
      const vendor = vendors[0];
      const intProps = getPropertiesInt(vendor.class_Id);
      expect(intProps.length).toBeGreaterThan(0);
      const name = getPropertyString(vendor.class_Id, 1);
      expect(name).toBeDefined();
      expect(name.length).toBeGreaterThan(0);
    });
  });
});
