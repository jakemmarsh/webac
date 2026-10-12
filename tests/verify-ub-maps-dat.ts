/**
 * UtilityBelt's maps over each era's own data (docs/vtank-parity-gaps.md §11.7): the Dungeon Maps model on
 * Holtburg Dungeon (0x01F6) from the end-of-retail, Dark Majesty and 1999 cell.dat / portal.dat, the
 * Landscape Maps terrain from each era's Region and landblocks, the generated marker tables
 * (tools/build-map-markers.ts) and that tool's parsers on ACE-layout SQL.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.ts';
import { EnvCell } from '../packages/dat-parser/src/file-types/EnvCell.ts';
import { Environment } from '../packages/dat-parser/src/file-types/Environment.ts';
import { CellLandblock } from '../packages/dat-parser/src/file-types/CellLandblock.ts';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.ts';
import { ac1999CellOverlay, ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.ts';
import { buildDungeonMap, isDungeonCell, type DungeonMapSource } from '../packages/renderer/src/ui/maps/dungeonMapModel.ts';
import { paintLandblock, parseMapTable, reliefShade, TERRAIN_MAP_SIZE, terrainPalette } from '../packages/renderer/src/ui/maps/landscapeMapModel.ts';
import { loadMapTable } from '../packages/renderer/src/ui/maps/ubMapHost.ts';
import { buildMapTable, parseLandblockSql, parseMapWeenieSql, trimPortalName, UB_TOWNS } from '../tools/build-map-markers.ts';

const REPO = resolve(__dirname, '..');
const ERAS = [
  { name: 'end of retail', portal: DAT_PATHS.portal, cell: DAT_PATHS.cell, y1999: false },
  { name: 'Dark Majesty', portal: resolve(REPO, 'dat-sets/classicace-customdm-1.60/client_portal.dat'), cell: resolve(REPO, 'dat-sets/classicace-customdm-1.60/client_cell_1.dat'), y1999: false },
  { name: '1999', portal: resolve(REPO, 'dat-sets/ac1999-retail/portal.dat'), cell: resolve(REPO, 'dat-sets/ac1999-retail/cell.dat'), y1999: true },
];

/** The era's files as the client reads them (the 1999 overlay translating, as the client installs it). */
function eraReader(e: (typeof ERAS)[number]) {
  const portal: DatDatabase = openDat(e.portal);
  const cell: DatDatabase = openDat(e.cell);
  const pov = e.y1999 ? ac1999PortalOverlay() : null;
  const cov = e.y1999 ? ac1999CellOverlay() : null;
  const p = (id: number) => (pov ? pov.get(id, (i) => portal.getFileData(i)) ?? portal.getFileData(id) : portal.getFileData(id));
  const c = (id: number) => (cov ? cov.get(id, (i) => cell.getFileData(i)) ?? cell.getFileData(id) : cell.getFileData(id));
  return { p, c, cell };
}

for (const era of ERAS) {
  describe.skipIf(!existsSync(era.portal) || !existsSync(era.cell))(`UB maps over ${era.name}'s DATs`, () => {
    let R: ReturnType<typeof eraReader>;
    let src: DungeonMapSource;
    beforeAll(() => {
      R = eraReader(era);
      src = {
        cellIds: (lb) => {
          const out: number[] = [];
          for (let i = 0x100; i < 0x1000; i++) { const id = ((lb & 0xffff0000) | i) >>> 0; if (R.cell.hasFile(id)) out.push(id); }
          return out;
        },
        cell: (id) => {
          const d = R.c(id);
          if (!d) return null;
          const ec = new EnvCell(new DatReader(d));
          const env = R.p(ec.environmentId);
          if (!env) return null;
          const cs = new Environment(new DatReader(env)).cells.get(ec.cellStructure);
          return cs ? { cellStruct: cs, position: ec.position } : null;
        },
      };
    });

    it('draws Holtburg Dungeon from its cells: floors, walls, floors by height, you inside its bounds', () => {
      const first = src.cellIds(0x01f60000)[0]!;
      const flags = new EnvCell(new DatReader(R.c(first)!)).flags;
      expect(isDungeonCell(first, flags)).toBe(true);
      const m = buildDungeonMap(first, src)!;
      expect(m.cells.size).toBeGreaterThan(50);
      const kinds = new Map<string, number>();
      for (const c of m.cells.values()) for (const p of c.polys) kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
      expect(kinds.get('floor')).toBeGreaterThan(m.cells.size * 0.5);
      expect(kinds.get('wall')).toBeGreaterThan(m.cells.size);
      // Every cell's origin lies inside the dungeon's drawn bounds.
      for (const c of m.cells.values()) {
        expect(c.x).toBeGreaterThanOrEqual(m.minX - 1);
        expect(c.x).toBeLessThanOrEqual(m.maxX + 1);
        expect(c.y).toBeGreaterThanOrEqual(m.minY - 1);
        expect(c.y).toBeLessThanOrEqual(m.maxY + 1);
      }
      expect(m.layers.size).toBeGreaterThanOrEqual(1);
    });

    it('a Holtburg building interior is SeenOutside: not a dungeon', () => {
      let found = 0;
      for (let i = 0x100; i < 0x200 && !found; i++) {
        const id = (0xa9b40000 | i) >>> 0;
        const d = R.c(id);
        if (!d) continue;
        const f = new EnvCell(new DatReader(d)).flags;
        if (f & 1) { expect(isDungeonCell(id, f)).toBe(false); found = id; }
      }
      expect(found).not.toBe(0);
    });

    it('paints Holtburg\'s landblock in the Region\'s terrain colours', () => {
      const region = new RegionDesc(new DatReader(R.p(0x13000000)!));
      const colors = region.terrainInfo.terrainTypes.map((t) => t.terrainColor >>> 0);
      expect(colors.length).toBeGreaterThanOrEqual(27);
      const pal = terrainPalette(colors, [128, 128, 128]);
      const lb = CellLandblock.read(new DatReader(R.c(0xa9b4ffff)!));
      const out = new Uint8ClampedArray(TERRAIN_MAP_SIZE * TERRAIN_MAP_SIZE * 4);
      paintLandblock(out, 0xa9, 0xb4, lb, region.landDefs.landHeightTable, pal);
      let painted = 0;
      for (let cx = 0; cx < 8; cx++) for (let cy = 0; cy < 8; cy++) {
        const o = (((TERRAIN_MAP_SIZE - 1 - (0xb4 * 8 + cy)) * TERRAIN_MAP_SIZE) + 0xa9 * 8 + cx) * 4;
        if (out[o + 3] === 255) painted++;
        const t = lb.terrain[cx * 9 + cy]!;
        // The cell's colour is its type's Region colour (or the road's) times its relief.
        const h = (x: number, y: number) => region.landDefs.landHeightTable[lb.heights[x * 9 + y]!]!;
        const k = reliefShade(h(cx, cy), h(cx + 1, cy), h(cx, cy + 1));
        const rgb = (t & 3) !== 0 ? pal.road : pal.types[(t & 0x7c) >> 2]!;
        for (let i = 0; i < 3; i++) expect(Math.abs(out[o + i]! - Math.min(255, rgb[i]! * k))).toBeLessThanOrEqual(1);
      }
      expect(painted).toBe(64);
    });
  });
}

describe('the era marker tables (tools/build-map-markers.ts output)', () => {
  it('every era has its own lifestones, vendors, portals and dungeon names, all on the map', async () => {
    for (const era of ['eol', 'dm', 'ac1999'] as const) {
      const t = await loadMapTable(era);
      const of = (type: string) => t.markers.filter((m) => m.type === type);
      expect(of('Lifestone').length).toBeGreaterThan(150);
      expect(of('Vendor').length).toBeGreaterThan(300);
      expect(of('Dungeon').length).toBeGreaterThan(100);
      expect(t.dungeons.get(0x01f60000)).toBe('Holtburg Dungeon');
      for (const m of t.markers) {
        expect(Math.abs(m.ns)).toBeLessThan(102.1);
        expect(Math.abs(m.ew)).toBeLessThan(102.1);
      }
      // Holtburg: the town, and a lifestone within 1 of 42.1N 33.6E.
      expect(of('Town').some((m) => m.name === 'Holtburg')).toBe(true);
      expect(of('Lifestone').some((m) => Math.hypot(m.ns - 42.1, m.ew - 33.6) < 1)).toBe(true);
    }
  });

  it('a town shows only in the eras that have it (Ahurenga came with Viamont, after 1999)', async () => {
    const eol = await loadMapTable('eol');
    const y1999 = await loadMapTable('ac1999');
    expect(eol.markers.some((m) => m.type === 'Town' && m.name === 'Ahurenga')).toBe(true);
    expect(y1999.markers.some((m) => m.type === 'Town' && m.name === 'Ahurenga')).toBe(false);
    expect(y1999.markers.length).toBeLessThan(eol.markers.length);
  });
});

describe('the marker table builder\'s parsers', () => {
  const portal = `INSERT INTO \`weenie\` (\`class_Id\`, \`class_Name\`, \`type\`, \`last_Modified\`)
VALUES (34542, 'ace34542-realaidaineasternvault', 7, '2021-11-17 16:56:08') /* Portal */;

INSERT INTO \`weenie_properties_string\` (\`object_Id\`, \`type\`, \`value\`)
VALUES (34542,   1, 'Portal to Realaidain''s Vault') /* Name */
     , (34542,  16, 'Long') /* LongDesc */;

INSERT INTO \`weenie_properties_position\` (\`object_Id\`, \`position_Type\`, \`obj_Cell_Id\`, \`origin_X\`, \`origin_Y\`, \`origin_Z\`, \`angles_W\`, \`angles_X\`, \`angles_Y\`, \`angles_Z\`)
VALUES (34542, 2, 0x005001E9, 480, -330, 0.006, 1, 0, 0, 0) /* Destination */;
`;
  const creature = (attackable: boolean) => `INSERT INTO \`weenie\` (\`class_Id\`, \`class_Name\`, \`type\`, \`last_Modified\`)
VALUES (100, 'npc', 10, '2021-11-17 16:56:08') /* Creature */;

INSERT INTO \`weenie_properties_int\` (\`object_Id\`, \`type\`, \`value\`)
VALUES (100,   1,         16) /* ItemType - Creature */;

INSERT INTO \`weenie_properties_bool\` (\`object_Id\`, \`type\`, \`value\`)
VALUES (100,  19, ${attackable ? 'True' : 'False'}) /* Attackable */;

INSERT INTO \`weenie_properties_string\` (\`object_Id\`, \`type\`, \`value\`)
VALUES (100,   1, 'Town Crier') /* Name */;
`;

  it('reads a portal with its destination, an NPC, and passes monsters by', () => {
    expect(parseMapWeenieSql(portal)).toEqual({ wcid: 34542, kind: 'P', name: "Portal to Realaidain's Vault", dest: 0x005001e9 });
    expect(parseMapWeenieSql(creature(false))).toEqual({ wcid: 100, kind: 'N', name: 'Town Crier' });
    expect(parseMapWeenieSql(creature(true))).toBeNull();
    expect(trimPortalName('Holtburg Dungeon Portal')).toBe('Holtburg Dungeon');
  });

  it('reads a landblock\'s placements', () => {
    const sql = "INSERT INTO `landblock_instance` (`guid`, `weenie_Class_Id`, `obj_Cell_Id`, `origin_X`, `origin_Y`, `origin_Z`, `angles_W`, `angles_X`, `angles_Y`, `angles_Z`, `is_Link_Child`, `last_Modified`)\nVALUES (0x7A9B4000,   509, 0xA9B40019, 84, 96.5, 94, 1, 0, 0, 0, False, '2005-02-09 10:00:00'); /* Life Stone */";
    expect(parseLandblockSql(sql)).toEqual([[509, 0xa9b40019, 84, 96.5]]);
  });

  it('marks a portal into a dungeon as a Dungeon named by its portals, leaves dungeon dwellers off the landscape, keeps towns with people', () => {
    const weenies = [
      { wcid: 1, kind: 'P' as const, name: 'Holtburg Dungeon Portal', dest: 0x01f60289 },
      { wcid: 2, kind: 'P' as const, name: 'Portal to Arwic', dest: 0xc6a90009 },
      { wcid: 3, kind: 'L' as const, name: 'Life Stone' },
      { wcid: 4, kind: 'V' as const, name: 'Vendor' },
    ];
    const holtburg = UB_TOWNS.find((t) => t[0] === 'Holtburg')!;
    const t = buildMapTable(weenies, [
      [1, 0xa9b40019, 10, 10], [2, 0xa9b40019, 20, 20], [3, 0xa9b40019, 84, 96],
      // A vendor inside the dungeon isn't on the landscape map.
      [4, 0x01f60105, 0, 0],
    ], (cell) => ((cell & 0xffff) >= 0x100 ? (cell >>> 16) !== 0x01f6 : null));
    const parsed = parseMapTable(JSON.stringify(t));
    expect(parsed.markers.find((m) => m.name === 'Holtburg Dungeon')?.type).toBe('Dungeon');
    expect(parsed.markers.find((m) => m.name === 'Arwic')?.type).toBe('Portal');
    expect(parsed.markers.some((m) => m.type === 'Vendor')).toBe(false);
    expect(parsed.dungeons.get(0x01f60000)).toBe('Holtburg Dungeon');
    expect(parsed.markers.some((m) => m.type === 'Town' && m.name === 'Holtburg' && m.ns === holtburg[2])).toBe(true);
    expect(parsed.markers.some((m) => m.type === 'Town' && m.name === 'Arwic')).toBe(false);
  });
});
