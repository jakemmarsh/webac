/**
 * Geometry1999 — translate the Oct 1999 retail GEOMETRY records (GfxObj 0x01,
 * Environment 0x0D, cell.dat EnvCell) into the end-of-retail (EoL) byte
 * layouts our parsers read (file-types/GfxObj.ts, Environment.ts, EnvCell.ts,
 * Polygon.ts, BSPTree.ts, Vertex.ts).
 *
 * Sources: the bytes (every record of dat-sets/ac1999-retail measured, see
 * tests/verify-ac1999-geometry.ts); AC1999's AGPL server (Server/Source/PhatSDK:
 * GfxObj.cpp CGfxObj::UnPack, Polygon.cpp CPolygon::UnPack, Vertex.cpp,
 * BSPData.cpp BSPNODE/BSPLEAF/BSPPORTAL, Environment.cpp CCellStruct::UnPack,
 * EnvCell.cpp CEnvCell::UnPack); its KB pages kb/dat/PortalDat/GfxObj,
 * PortalDat/Environment and CellDat/EnvCell (read for orientation only, they
 * are unlicensed; nothing here is transliterated). Output format: ACE
 * ACE.DatLoader FileTypes/GfxObj.cs, Environment.cs, EnvCell.cs + Entity/*.
 *
 * The 1999 formats are the EoL ones with these differences (all measured):
 *
 *  - PACK_ALIGN pads. 1999 aligns to 4 bytes (relative to the record start)
 *    after every CPolygon, after every vertex (always a no-op: 28 + 8n bytes),
 *    after a drawing-tree BSP node's / PORT's InPolys tail, after a physics
 *    LEAF's InPolys tail, and at the end of a GfxObj. EoL has none of these.
 *    (KB GfxObj: "drops the 1999 client's 4-byte padding after each polygon
 *    and physics-BSP leaf" — measured: also after drawing-node InPolys.)
 *    The Environment CellStruct's align after the portal list and at its end
 *    exist in BOTH eras and are kept.
 *  - GfxObj counts. 1999 stores the surface count and the physics / drawing
 *    polygon counts as plain u32; EoL stores CompressedUInt32 (SmartArray).
 *  - Polygon key. 1999 CPolygon carries its own i16 poly_id first; EoL's
 *    dictionary stores a u16 key in the same spot. Same two bytes.
 *  - EnvCell header. 1999 is `flags, id`; EoL is `id, flags, id` (ACE skips
 *    the second id). 1999 also aligns after the u16 surface list and after the
 *    u16 stab list (and after portals/statics, always no-ops); EoL does not.
 *
 * Nothing is lost: every 1999 field has an EoL slot and vice versa. GfxObj
 * flag 0x4 (a trailing drawing sphere in AC1999's reader) never occurs in the
 * 1999 portal and is rejected rather than guessed at.
 */
import { DatReader } from '../DatReader.js';
import { DatWriter } from './DatWriter.js';

/** BSP tree kinds (ACE BSPType). */
const enum Tree {
  Drawing = 0,
  Physics = 1,
  Cell = 2,
}

const FOURCC = (s: string): number =>
  (s.charCodeAt(0) << 24 | s.charCodeAt(1) << 16 | s.charCodeAt(2) << 8 | s.charCodeAt(3)) >>> 0;
const LEAF = FOURCC('LEAF');
const PORT = FOURCC('PORT');
/**
 * Interior node types and which children follow (pos, neg). The 1999 client,
 * AC1999's reader and ACE all treat any other code as an interior node with no
 * children (plane + the tree's tail). Measured in the 1999 portal: 'BpIn'
 * (GfxObj trees) and 'BPFL' (Environment cell trees) occur — the KB calls these
 * preview2-only, but release has them too. They pass through unchanged; any
 * other unlisted code is rejected so a misread cannot masquerade as one.
 */
const NODE_CHILDREN = new Map<number, [boolean, boolean]>([
  [FOURCC('BpIn'), [false, false]],
  [FOURCC('BPFL'), [false, false]],
  [FOURCC('BPOL'), [false, false]],
  [FOURCC('BPnn'), [true, false]],
  [FOURCC('BPIn'), [true, false]],
  [FOURCC('BpIN'), [false, true]],
  [FOURCC('BpnN'), [false, true]],
  [FOURCC('BPIN'), [true, true]],
  [FOURCC('BPnN'), [true, true]],
]);

/** Reads 1999 bytes and writes EoL bytes in one pass (the field order is shared). */
class Geo {
  readonly r: DatReader;
  readonly w = new DatWriter();

  constructor(raw: ArrayBuffer, public what: string) {
    this.r = new DatReader(raw);
  }

  fail(msg: string): never {
    throw new Error(`${this.what} (1999): ${msg} at byte ${this.r.position} of ${this.r.length}`);
  }

  need(n: number): void {
    if (this.r.remaining < n) this.fail(`needs ${n} more bytes`);
  }

  u8(): number { this.need(1); const v = this.r.readUInt8(); this.w.writeUInt8(v); return v; }
  u16(): number { this.need(2); const v = this.r.readUInt16(); this.w.writeUInt16(v); return v; }
  u32(): number { this.need(4); const v = this.r.readUInt32(); this.w.writeUInt32(v); return v; }
  /** Copy n raw bytes (floats copy bit-exact this way, NaN payloads included). */
  bytes(n: number): void { this.need(n); this.w.writeBytes(this.r.readBytes(n)); }

  /** A 1999 PACK_ALIGN that EoL dropped: consume the pad, write nothing. */
  dropAlign(): void {
    const pad = (4 - (this.r.position % 4)) % 4;
    this.need(pad);
    this.r.skip(pad);
  }

  /** An align both eras have. The writer starts at the record start too, so the pads line up. */
  keepAlign(): void {
    this.dropAlign();
    this.w.align(4);
  }

  /** Assert the whole record was consumed (trailing pad to a dword is the only slack allowed). */
  end(): ArrayBuffer {
    if (this.r.remaining !== 0) this.fail(`${this.r.remaining} unread bytes`);
    return this.w.toArrayBuffer();
  }

  // --- shared sub-structures ---------------------------------------------------

  /** CVertexArray: i32 vertex_type (1), u32 count, count × CVertex. */
  vertexArray(): number {
    const type = this.u32();
    if (type !== 1) this.fail(`vertex_type ${type} (only 1 is SWVertex)`);
    const n = this.u32();
    for (let i = 0; i < n; i++) {
      this.u16(); // index (EoL: dictionary key)
      this.need(2);
      const uvs = this.r.readInt16();
      if (uvs < 0) this.fail(`vertex ${i} has uvcount ${uvs}`);
      this.w.writeUInt16(uvs);
      this.bytes(24 + 8 * uvs); // origin, normal, uvs
      this.dropAlign(); // 1999 CVertex PACK_ALIGN (a no-op at 28 + 8n bytes)
    }
    return n;
  }

  /** CPolygon: i16 poly_id (EoL u16 key) + body; 1999 pads to a dword after each. */
  polygon(numVerts: number): void {
    this.u16(); // poly_id / key
    const numPts = this.u8();
    const stippling = this.u8();
    const sides = this.u32();
    this.u16(); // pos_surface
    this.u16(); // neg_surface
    for (let i = 0; i < numPts; i++) {
      const v = this.u16();
      if (v >= numVerts) this.fail(`polygon vertex id ${v} >= ${numVerts} vertices`);
    }
    if ((stippling & 0x4) === 0) this.bytes(numPts); // pos UV indices
    if (sides === 2 && (stippling & 0x8) === 0) this.bytes(numPts); // neg UV indices (CullMode.Clockwise)
    this.dropAlign();
  }

  plane(): void { this.bytes(16); }
  sphere(): void { this.bytes(16); }

  /** u32 count + count × u16 poly indices. */
  inPolys(): number {
    const n = this.u32();
    this.bytes(2 * n);
    return n;
  }

  /** One BSP node, recursively (BSPNODE::UnPackChild). */
  bspNode(tree: Tree, depth = 0): void {
    if (depth > 4096) this.fail('BSP deeper than 4096');
    const type = this.u32();
    if (type === LEAF) {
      this.u32(); // leaf_index
      if (tree !== Tree.Physics) return;
      this.u32(); // solid
      this.sphere();
      this.inPolys();
      this.dropAlign();
      return;
    }
    if (type === PORT) {
      this.plane();
      this.bspNode(tree, depth + 1);
      this.bspNode(tree, depth + 1);
      if (tree !== Tree.Drawing) return;
      this.sphere();
      const polys = this.u32();
      const portals = this.u32();
      this.bytes(2 * polys); // in_polys
      this.bytes(4 * portals); // CPortalPoly: i16, i16
      this.dropAlign();
      return;
    }
    const children = NODE_CHILDREN.get(type);
    if (!children) this.fail(`unknown BSP node type 0x${type.toString(16)}`);
    this.plane();
    if (children[0]) this.bspNode(tree, depth + 1);
    if (children[1]) this.bspNode(tree, depth + 1);
    if (tree === Tree.Cell) return;
    this.sphere();
    if (tree === Tree.Physics) return;
    this.inPolys();
    this.dropAlign();
  }
}

/** GfxObj (portal 0x01xxxxxx): 1999 u32 counts + pads → EoL compressed counts, no pads. */
export function transcodeGfxObj1999(raw: ArrayBuffer): ArrayBuffer {
  const g = new Geo(raw, 'GfxObj');
  const id = g.u32();
  g.what = `GfxObj 0x${id.toString(16).padStart(8, '0')}`;
  const flags = g.u32();
  if (flags & ~0xb) g.fail(`unknown flags 0x${flags.toString(16)}`);

  g.need(4);
  const numSurfaces = g.r.readUInt32();
  g.w.writeCompressedUInt32(numSurfaces);
  g.bytes(4 * numSurfaces);

  const numVerts = g.vertexArray();

  const polys = (): void => {
    g.need(4);
    const n = g.r.readUInt32();
    g.w.writeCompressedUInt32(n);
    for (let i = 0; i < n; i++) g.polygon(numVerts);
  };

  if (flags & 0x1) {
    polys();
    g.bspNode(Tree.Physics);
  }
  g.bytes(12); // sort center
  if (flags & 0x2) {
    polys();
    g.bspNode(Tree.Drawing);
  }
  if (flags & 0x8) g.u32(); // DIDDegrade
  g.dropAlign(); // CGfxObj::UnPack's closing PACK_ALIGN
  return g.end();
}

/** Environment (portal 0x0Dxxxxxx): same structure; only the per-polygon / per-node pads go. */
export function transcodeEnvironment1999(raw: ArrayBuffer): ArrayBuffer {
  const g = new Geo(raw, 'Environment');
  const id = g.u32();
  g.what = `Environment 0x${id.toString(16).padStart(8, '0')}`;
  const numCells = g.u32();
  for (let c = 0; c < numCells; c++) {
    g.u32(); // cellstruct id (EoL dictionary key)
    const numPolys = g.u32();
    const numPhys = g.u32();
    const numPortals = g.u32();
    const numVerts = g.vertexArray();
    for (let i = 0; i < numPolys; i++) g.polygon(numVerts);
    g.bytes(2 * numPortals);
    g.keepAlign();
    g.bspNode(Tree.Cell);
    for (let i = 0; i < numPhys; i++) g.polygon(numVerts);
    g.bspNode(Tree.Physics);
    if (g.u32() !== 0) g.bspNode(Tree.Drawing);
    g.keepAlign();
  }
  return g.end();
}

/**
 * EnvCell (cell.dat 0xXXYY0100..0xXXYYFFFD): 1999 `flags, id, …` with pads
 * after the u16 lists → EoL `id, flags, id, …` with none.
 */
export function transcodeEnvCell1999(raw: ArrayBuffer, id: number): ArrayBuffer {
  const g = new Geo(raw, `EnvCell 0x${(id >>> 0).toString(16).padStart(8, '0')}`);
  g.need(8);
  const flags = g.r.readUInt32();
  const ownId = g.r.readUInt32();
  if (ownId !== id >>> 0) g.fail(`record id 0x${ownId.toString(16)} != requested id`);
  if (flags & ~0xb) g.fail(`unknown flags 0x${flags.toString(16)}`);
  g.w.writeUInt32(id).writeUInt32(flags).writeUInt32(id);

  const numSurfaces = g.u8();
  const numPortals = g.u8();
  const numStabs = g.u16();
  g.bytes(2 * numSurfaces);
  g.dropAlign();
  g.u16(); // environment id (low word)
  g.u16(); // cell struct index
  g.bytes(28); // frame: origin + quaternion (w, x, y, z)
  g.bytes(8 * numPortals); // CCellPortal: flags, poly, other cell, other portal
  g.dropAlign();
  g.bytes(2 * numStabs);
  g.dropAlign();
  if (flags & 0x2) {
    const n = g.u32();
    g.bytes(32 * n); // u32 id + frame
  }
  g.dropAlign();
  if (flags & 0x8) g.u32(); // restriction object
  return g.end();
}
