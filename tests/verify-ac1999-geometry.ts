/**
 * 1999 retail geometry → end-of-retail bytes (era1999/Geometry1999.ts):
 * GfxObj (0x01), Environment (0x0D) and cell.dat EnvCell records translate
 * into the layouts our EoL parsers read, consumed to the last byte.
 *
 * Synthetic cases (hand-built 1999 records with every pad the 1999 format
 * has) run everywhere; the full-corpus sweep runs only where the 1999 DATs
 * are present (dat-sets/ac1999-retail, gitignored).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { DatWriter } from '../packages/dat-parser/src/era1999/DatWriter.js';
import {
  transcodeEnvCell1999,
  transcodeEnvironment1999,
  transcodeGfxObj1999,
} from '../packages/dat-parser/src/era1999/Geometry1999.js';
import { EnvCell } from '../packages/dat-parser/src/file-types/EnvCell.js';
import { Environment } from '../packages/dat-parser/src/file-types/Environment.js';
import { GfxObj } from '../packages/dat-parser/src/file-types/GfxObj.js';
import type { BSPInternalNode, BSPLeafNode, BSPPortalNode } from '../packages/dat-parser/src/file-types/BSPTree.js';
import { openDat } from './_harness/dat.js';

/** Parse EoL bytes with `P`, asserting every byte is consumed. */
function parseAll<T>(out: ArrayBuffer, P: new (r: DatReader) => T): T {
  const r = new DatReader(out);
  const v = new P(r);
  expect(r.position).toBe(out.byteLength);
  return v;
}

// --- 1999 record builders (test-side encoders of the 1999 layout) -------------

const tag = (s: string): number =>
  (s.charCodeAt(0) << 24 | s.charCodeAt(1) << 16 | s.charCodeAt(2) << 8 | s.charCodeAt(3)) >>> 0;

function vertex1999(w: DatWriter, key: number, x: number, y: number, z: number, uvs: number): void {
  w.writeInt16(key).writeInt16(uvs);
  w.writeFloat32(x).writeFloat32(y).writeFloat32(z);
  w.writeFloat32(0).writeFloat32(0).writeFloat32(1);
  for (let i = 0; i < uvs; i++) w.writeFloat32(i * 0.5).writeFloat32(1 - i * 0.5);
  w.align(4);
}

function vertexArray1999(w: DatWriter, n: number): void {
  w.writeUInt32(1).writeUInt32(n);
  for (let i = 0; i < n; i++) vertex1999(w, i, i, i * 2, i * 3, 1);
}

/** A 1999 CPolygon: i16 id, u8 pts, u8 stippling, u32 sides, i16 pos/neg surface, ids, uvs, align4. */
function poly1999(w: DatWriter, id: number, verts: number[], sides: number, stippling = 0): void {
  w.writeInt16(id).writeUInt8(verts.length).writeUInt8(stippling).writeUInt32(sides);
  w.writeInt16(0).writeInt16(sides === 2 ? 1 : -1);
  for (const v of verts) w.writeInt16(v);
  if (!(stippling & 4)) for (let i = 0; i < verts.length; i++) w.writeUInt8(i);
  if (sides === 2 && !(stippling & 8)) for (let i = 0; i < verts.length; i++) w.writeUInt8(i + 10);
  w.align(4);
}

const plane = (w: DatWriter, d: number): DatWriter => w.writeFloat32(0).writeFloat32(0).writeFloat32(1).writeFloat32(d);
const sphere = (w: DatWriter, r: number): DatWriter => w.writeFloat32(1).writeFloat32(2).writeFloat32(3).writeFloat32(r);

/** Synthetic 1999 GfxObj: flags 3, 4 vertices, 1 physics + 2 drawing polygons, both BSPs. */
function gfxObj1999(): ArrayBuffer {
  const w = new DatWriter();
  w.writeUInt32(0x01000abc).writeUInt32(0x3);
  w.writeUInt32(2).writeUInt32(0x08000001).writeUInt32(0x08000002); // u32 count (EoL: compressed)
  vertexArray1999(w, 4);
  w.writeUInt32(1); // physics polygons
  poly1999(w, 0, [0, 1, 2], 0); // 3 pts → 1 pad byte after the uv indices
  // Physics BSP: BPnN(plane, LEAF, LEAF, sphere); leaves carry solid + sphere + inPolys + align4.
  w.writeUInt32(tag('BPnN'));
  plane(w, 0.5);
  w.writeUInt32(tag('LEAF')).writeUInt32(0).writeUInt32(1);
  sphere(w, 2).writeUInt32(1).writeUInt16(0).align(4); // 1 poly → 2 pad bytes
  w.writeUInt32(tag('LEAF')).writeUInt32(1).writeUInt32(0);
  sphere(w, 3).writeUInt32(0);
  sphere(w, 4);
  w.writeFloat32(0.25).writeFloat32(-0.5).writeFloat32(0.75); // sort center
  w.writeUInt32(2); // drawing polygons
  poly1999(w, 0, [0, 1, 2, 3], 2); // Clockwise: pos + neg uvs
  poly1999(w, 1, [3, 2, 1], 1, 0x4); // CullNone, NoPos: no uvs
  // Drawing BSP: BPIn(plane, PORT(plane, LEAF, BpIn(plane, sphere, polys)), sphere, polys).
  w.writeUInt32(tag('BPIn'));
  plane(w, 1);
  w.writeUInt32(tag('PORT'));
  plane(w, 2);
  w.writeUInt32(tag('LEAF')).writeUInt32(7); // drawing leaf: index only
  w.writeUInt32(tag('BpIn'));
  plane(w, 3);
  sphere(w, 5).writeUInt32(1).writeUInt16(1).align(4);
  sphere(w, 6).writeUInt32(1).writeUInt32(1).writeUInt16(0).writeInt16(3).writeInt16(0).align(4);
  sphere(w, 7).writeUInt32(2).writeUInt16(0).writeUInt16(1).align(4);
  w.align(4);
  return w.toArrayBuffer();
}

/** Synthetic 1999 Environment: one cellstruct with 3 portals and a drawing BSP. */
function environment1999(withDrawing = true): ArrayBuffer {
  const w = new DatWriter();
  w.writeUInt32(0x0d000123).writeUInt32(1);
  w.writeUInt32(0).writeUInt32(2).writeUInt32(1).writeUInt32(3); // id, polys, physics polys, portals
  vertexArray1999(w, 4);
  poly1999(w, 0, [0, 1, 2], 0);
  poly1999(w, 1, [1, 2, 3], 2, 0x8); // Clockwise + NoNeg: pos uvs only
  w.writeUInt16(1).writeUInt16(0).writeUInt16(1).align(4); // portals + align (both eras)
  // Cell BSP: BPnn(plane, BPFL(plane)) — no spheres or polys in a cell tree.
  w.writeUInt32(tag('BPnn'));
  plane(w, 1);
  w.writeUInt32(tag('BPFL'));
  plane(w, 2);
  poly1999(w, 0, [0, 1, 2, 3], 0); // physics polygon
  w.writeUInt32(tag('LEAF')).writeUInt32(0).writeUInt32(1);
  sphere(w, 1).writeUInt32(1).writeUInt16(0).align(4);
  w.writeUInt32(withDrawing ? 1 : 0);
  if (withDrawing) {
    w.writeUInt32(tag('BPOL'));
    plane(w, 4);
    sphere(w, 2).writeUInt32(3).writeUInt16(0).writeUInt16(1).writeUInt16(0).align(4);
  }
  w.align(4);
  return w.toArrayBuffer();
}

/** Synthetic 1999 EnvCell: flags, id, odd surface + stab counts (so both pads are real). */
function envCell1999(id: number, flags: number): ArrayBuffer {
  const w = new DatWriter();
  w.writeUInt32(flags).writeUInt32(id);
  w.writeUInt8(3).writeUInt8(1).writeUInt16(3);
  w.writeUInt16(0x13e4).writeUInt16(0x13e8).writeUInt16(0x047e).align(4);
  w.writeUInt16(0x0128).writeUInt16(2);
  w.writeFloat32(120).writeFloat32(-40).writeFloat32(-60);
  w.writeFloat32(1).writeFloat32(0).writeFloat32(0).writeFloat32(0);
  w.writeUInt16(2).writeUInt16(8).writeUInt16(0x01af).writeInt16(0).align(4);
  w.writeUInt16(0x01af).writeUInt16(0x01b8).writeUInt16(0x01a8).align(4);
  if (flags & 2) {
    w.writeUInt32(1).writeUInt32(0x0200047e);
    w.writeFloat32(1).writeFloat32(2).writeFloat32(3);
    w.writeFloat32(1).writeFloat32(0).writeFloat32(0).writeFloat32(0);
  }
  w.align(4);
  if (flags & 8) w.writeUInt32(0x7000abcd);
  return w.toArrayBuffer();
}

describe('1999 geometry transcode (synthetic, runs in CI)', () => {
  it('GfxObj: u32 counts → compressed, pads dropped, every field preserved', () => {
    const raw = gfxObj1999();
    const out = transcodeGfxObj1999(raw);
    expect(out.byteLength).toBeLessThan(raw.byteLength);
    const g = parseAll(out, GfxObj);
    expect(g.id).toBe(0x01000abc);
    expect(g.flags).toBe(3);
    expect(g.surfaces).toEqual([0x08000001, 0x08000002]);
    expect(g.vertices.length).toBe(4);
    expect(g.vertices[3].origin).toEqual({ x: 3, y: 6, z: 9 });
    expect(g.vertices[3].uvs).toEqual([{ u: 0, v: 1 }]);
    expect(g.physicsPolygons.get(0)?.vertexIndices).toEqual([0, 1, 2]);
    const phys = g.physicsBSP!.rootNode as BSPInternalNode;
    expect(phys.type).toBe('BPnN');
    expect((phys.posNode as BSPLeafNode).inPolys).toEqual([0]);
    expect((phys.posNode as BSPLeafNode).solid).toBe(1);
    expect((phys.negNode as BSPLeafNode).leafIndex).toBe(1);
    expect(phys.sphere?.radius).toBe(4);
    expect(g.sortCenter).toEqual({ x: 0.25, y: -0.5, z: 0.75 });
    expect(g.polygons.length).toBe(2);
    expect(g.polygons[0]).toMatchObject({ numPts: 4, sidesType: 2, negSurface: 1, posUVIndices: [0, 1, 2, 3], negUVIndices: [10, 11, 12, 13] });
    expect(g.polygons[1]).toMatchObject({ numPts: 3, sidesType: 1, stippling: 4, vertexIndices: [3, 2, 1], posUVIndices: [] });
    const draw = g.drawingBSP!.rootNode as BSPInternalNode;
    expect(draw.type).toBe('BPIn');
    expect(draw.inPolys).toEqual([0, 1]);
    const port = draw.posNode as BSPPortalNode;
    expect(port.type).toBe('PORT');
    expect((port.posNode as BSPLeafNode).leafIndex).toBe(7);
    expect((port.negNode as BSPInternalNode).type).toBe('BpIn');
    expect((port.negNode as BSPInternalNode).inPolys).toEqual([1]);
    expect(port.inPolys).toEqual([0]);
    expect(port.inPortals).toEqual([{ portalIndex: 3, polygonId: 0 }]);
  });

  it('GfxObj: a short or overlong record is rejected, not half-read', () => {
    const raw = new Uint8Array(gfxObj1999());
    expect(() => transcodeGfxObj1999(raw.slice(0, raw.length - 8).buffer)).toThrow(/GfxObj 0x01000abc/);
    const long = new Uint8Array(raw.length + 4);
    long.set(raw);
    expect(() => transcodeGfxObj1999(long.buffer)).toThrow(/4 unread bytes/);
  });

  it('Environment: per-polygon and per-node pads dropped; the cellstruct aligns kept', () => {
    for (const withDrawing of [true, false]) {
      const out = transcodeEnvironment1999(environment1999(withDrawing));
      const e = parseAll(out, Environment);
      expect(e.id).toBe(0x0d000123);
      const cs = e.cells.get(0)!;
      expect(cs.vertexArray.vertices.size).toBe(4);
      expect(cs.polygons.size).toBe(2);
      expect(cs.polygons.get(1)).toMatchObject({ sidesType: 2, stippling: 8, posUVIndices: [0, 1, 2], negUVIndices: [] });
      expect(cs.portals).toEqual([1, 0, 1]);
      const cell = cs.cellBSP.rootNode as BSPInternalNode;
      expect(cell.type).toBe('BPnn');
      expect((cell.posNode as BSPInternalNode).type).toBe('BPFL');
      expect((cell.posNode as BSPInternalNode).splittingPlane.distance).toBe(2);
      expect(cs.physicsPolygons.get(0)?.numPts).toBe(4);
      expect((cs.physicsBSP.rootNode as BSPLeafNode).inPolys).toEqual([0]);
      if (withDrawing) {
        const d = cs.drawingBSP!.rootNode as BSPInternalNode;
        expect(d.type).toBe('BPOL');
        expect(d.inPolys).toEqual([0, 1, 0]);
      } else {
        expect(cs.drawingBSP).toBeNull();
      }
    }
  });

  it('EnvCell: flags,id → id,flags,id; the u16-list pads dropped', () => {
    const id = 0x01390105;
    for (const flags of [0x0, 0x1, 0x2, 0xb]) {
      const out = transcodeEnvCell1999(envCell1999(id, flags), id);
      const c = parseAll(out, EnvCell);
      expect(c.id).toBe(id);
      expect(c.flags).toBe(flags);
      expect(new DataView(out).getUint32(8, true)).toBe(id);
      expect(c.surfaces).toEqual([0x080013e4, 0x080013e8, 0x0800047e]);
      expect(c.environmentId).toBe(0x0d000128);
      expect(c.cellStructure).toBe(2);
      expect(c.position.origin).toEqual({ x: 120, y: -40, z: -60 });
      expect(c.cellPortals).toEqual([{ flags: 2, polygonId: 8, otherCellId: 0x01af, otherPortalId: 0 }]);
      expect(c.visibleCells).toEqual([0x01af, 0x01b8, 0x01a8]);
      expect(c.staticObjects.length).toBe(flags & 2 ? 1 : 0);
      if (flags & 2) expect(c.staticObjects[0].frame.origin).toEqual({ x: 1, y: 2, z: 3 });
      expect(c.restrictionObj).toBe(flags & 8 ? 0x7000abcd : 0);
    }
    expect(() => transcodeEnvCell1999(envCell1999(id, 0), id + 1)).toThrow(/record id/);
  });
});

// --- the real 1999 retail DATs ------------------------------------------------

const PORTAL = resolve(__dirname, '..', 'dat-sets/ac1999-retail/portal.dat');
const CELL = resolve(__dirname, '..', 'dat-sets/ac1999-retail/cell.dat');

describe.skipIf(!existsSync(PORTAL) || !existsSync(CELL))('1999 retail geometry transcode (every record)', () => {
  let portal: DatDatabase;
  let cell: DatDatabase;
  beforeAll(() => {
    portal = openDat(PORTAL);
    cell = openDat(CELL);
  });

  it('every GfxObj transcodes and parses to the last byte, matching the 1999 header', () => {
    const ids = portal.listFileIds(0x01);
    expect(ids.length).toBe(3816);
    for (const id of ids) {
      const raw = portal.getFileData(id)!;
      const g = parseAll(transcodeGfxObj1999(raw), GfxObj);
      // Independent read of the 1999 header: id, flags, u32 surface count + ids, vertex array.
      const dv = new DataView(raw);
      expect(g.id).toBe(id);
      expect(g.flags).toBe(dv.getUint32(4, true));
      const ns = dv.getUint32(8, true);
      expect(g.surfaces).toEqual(Array.from({ length: ns }, (_, i) => dv.getUint32(12 + 4 * i, true)));
      let at = 12 + 4 * ns;
      expect(dv.getUint32(at, true)).toBe(1);
      const nv = dv.getUint32(at + 4, true);
      expect(g.vertices.length).toBe(nv);
      at += 8;
      for (let i = 0; i < nv; i++) {
        const uvs = dv.getInt16(at + 2, true);
        if (i === 0) expect(g.vertices[0].origin.x).toBe(dv.getFloat32(at + 4, true));
        at += 28 + 8 * uvs;
      }
      if (g.flags & 1) expect(g.physicsPolygons.size).toBe(dv.getUint32(at, true));
      if (g.flags === 2) expect(g.polygons.length).toBe(dv.getUint32(at + 12, true)); // after sort center
      for (const p of g.polygons) for (const v of p.vertexIndices) expect(v).toBeLessThan(nv);
      if (g.flags & 2) expect(g.drawingBSP).not.toBeNull();
    }
  });

  it('a known GfxObj (0x01000001) decodes to its 1999 mesh', () => {
    const g = parseAll(transcodeGfxObj1999(portal.getFileData(0x01000001)!), GfxObj);
    expect(g.surfaces).toEqual([0x0800000e]);
    expect(g.vertices.length).toBe(11);
    expect(g.vertices[0].origin.x).toBeCloseTo(0.142603, 5);
    expect(g.vertices[0].origin.y).toBeCloseTo(-0.0043068, 6);
    expect(g.vertices[0].origin.z).toBeCloseTo(0.171893, 5);
    expect(g.vertices[0].uvs[0].u).toBeCloseTo(0.870477, 5);
    expect(g.polygons.length).toBe(13);
    // 13 polygons fan into the 17 triangles AC1999's KB records for this mesh.
    expect(g.polygons.reduce((n, p) => n + p.numPts - 2, 0)).toBe(17);
  });

  it('every Environment transcodes and parses to the last byte, matching the 1999 header', () => {
    const ids = portal.listFileIds(0x0d);
    expect(ids.length).toBe(369);
    for (const id of ids) {
      const raw = portal.getFileData(id)!;
      const e = parseAll(transcodeEnvironment1999(raw), Environment);
      const dv = new DataView(raw);
      expect(e.id).toBe(id);
      expect(e.cells.size).toBe(dv.getUint32(4, true));
      const first = e.cells.get(dv.getUint32(8, true))!;
      expect(first.polygons.size).toBe(dv.getUint32(12, true));
      expect(first.physicsPolygons.size).toBe(dv.getUint32(16, true));
      expect(first.portals.length).toBe(dv.getUint32(20, true));
      expect(first.vertexArray.vertices.size).toBe(dv.getUint32(28, true));
    }
    const e = parseAll(transcodeEnvironment1999(portal.getFileData(0x0d000002)!), Environment);
    const cs = e.cells.get(0)!;
    expect([cs.vertexArray.vertices.size, cs.polygons.size, cs.physicsPolygons.size]).toEqual([13, 13, 10]);
    expect(cs.portals).toEqual([11, 10, 12]);
  });

  it('every EnvCell transcodes and parses to the last byte, matching the 1999 record', () => {
    const ids = cell.listFileIds().filter((i) => (i & 0xffff) >= 0x100 && (i & 0xffff) <= 0xfffd);
    expect(ids.length).toBe(65064);
    for (const id of ids) {
      const raw = cell.getFileData(id)!;
      const c = parseAll(transcodeEnvCell1999(raw, id), EnvCell);
      const dv = new DataView(raw);
      expect(c.flags).toBe(dv.getUint32(0, true));
      expect(c.id).toBe(id);
      const ns = dv.getUint8(8);
      expect(c.surfaces.length).toBe(ns);
      expect(c.cellPortals.length).toBe(dv.getUint8(9));
      expect(c.visibleCells.length).toBe(dv.getUint16(10, true));
      const env = 12 + ((2 * ns + 3) & ~3);
      expect(c.environmentId).toBe((0x0d000000 | dv.getUint16(env, true)) >>> 0);
      expect(c.cellStructure).toBe(dv.getUint16(env + 2, true));
      expect(c.position.origin.x).toBe(dv.getFloat32(env + 4, true));
    }
    // Dungeon 0x01ED (AC1999's KB: 564 cells, 7 floors) — all present.
    const dungeon = ids.filter((i) => i >>> 16 === 0x01ed);
    expect(dungeon.length).toBe(564);
    const known = parseAll(transcodeEnvCell1999(cell.getFileData(0x01390100)!, 0x01390100), EnvCell);
    expect(known.environmentId).toBe(0x0d000128);
    expect(known.position.origin).toEqual({ x: 120, y: -40, z: -60 });
    expect(known.cellPortals[0]).toEqual({ flags: 2, polygonId: 8, otherCellId: 431, otherPortalId: 0 });
    expect(known.visibleCells.length).toBe(37);
  });
});
