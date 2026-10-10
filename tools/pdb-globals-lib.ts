/**
 * Extract every named global / file-static / compile-time constant from the
 * retail client's PDB, with its initial value read out of acclient.exe.
 *
 * Why this exists: Ghidra's decompiled C shows globals such as
 * ATTACK_POWERUP_TIME as opaque names with no initializer, and llvm-pdbutil
 * segfaults on this VC7.1-era PDB's TPI stream, so `symbols/globals.txt` was
 * empty. This is a small self-contained MSF / CodeView reader that tolerates
 * the old toolchain: it never trusts a record it cannot size, and degrades to
 * raw hex instead of throwing.
 *
 * Formats: MSF 7.0 container, DBI stream 3, TPI stream 2, CodeView symbol and
 * leaf records (see LLVM's docs/PDB/*.rst for the byte layouts).
 */

// ── MSF container ────────────────────────────────────────────────────────────

const MSF_MAGIC = 'Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0';

export interface Msf {
  streamCount: number;
  readStream(index: number): Uint8Array;
}

export function readMsf(buf: Uint8Array): Msf {
  const dv = view(buf);
  const magic = latin1(buf.subarray(0, 32));
  if (magic !== MSF_MAGIC) throw new Error('not an MSF 7.0 PDB');
  const blockSize = dv.getUint32(32, true);
  const dirBytes = dv.getUint32(44, true);
  const blockMapAddr = dv.getUint32(52, true);

  const dirBlockCount = Math.ceil(dirBytes / blockSize);
  const dir = new Uint8Array(dirBlockCount * blockSize);
  for (let i = 0; i < dirBlockCount; i++) {
    const blk = dv.getUint32(blockMapAddr * blockSize + i * 4, true);
    dir.set(buf.subarray(blk * blockSize, (blk + 1) * blockSize), i * blockSize);
  }
  const ddv = view(dir);
  const streamCount = ddv.getUint32(0, true);
  const sizes: number[] = [];
  let p = 4;
  for (let i = 0; i < streamCount; i++, p += 4) {
    const s = ddv.getUint32(p, true);
    sizes.push(s === 0xffffffff ? 0 : s);
  }
  const blocks: number[][] = [];
  for (let i = 0; i < streamCount; i++) {
    const n = Math.ceil(sizes[i] / blockSize);
    const list: number[] = [];
    for (let j = 0; j < n; j++, p += 4) list.push(ddv.getUint32(p, true));
    blocks.push(list);
  }

  return {
    streamCount,
    readStream(index: number): Uint8Array {
      if (index < 0 || index >= streamCount) throw new Error(`stream ${index} out of range`);
      const out = new Uint8Array(blocks[index].length * blockSize);
      blocks[index].forEach((blk, j) =>
        out.set(buf.subarray(blk * blockSize, (blk + 1) * blockSize), j * blockSize));
      return out.subarray(0, sizes[index]);
    },
  };
}

/** PDB info stream (1): the GUID that must match the exe's RSDS record. */
export function readPdbGuid(msf: Msf): string {
  return guidString(msf.readStream(1).subarray(12, 28));
}

export interface DbiHeader {
  globalStreamIndex: number;
  publicStreamIndex: number;
  symRecordStream: number;
}

export function readDbiHeader(msf: Msf): DbiHeader {
  const dv = view(msf.readStream(3));
  return {
    globalStreamIndex: dv.getUint16(12, true),
    publicStreamIndex: dv.getUint16(16, true),
    symRecordStream: dv.getUint16(20, true),
  };
}

// ── Numeric leaves ───────────────────────────────────────────────────────────

/** A CodeView numeric leaf. Values that do not fit a double come back as bigint. */
export function readNumeric(dv: DataView, off: number): { value: number | bigint; size: number } {
  const v = dv.getUint16(off, true);
  if (v < 0x8000) return { value: v, size: 2 };
  switch (v) {
    case 0x8000: return { value: dv.getInt8(off + 2), size: 3 };
    case 0x8001: return { value: dv.getInt16(off + 2, true), size: 4 };
    case 0x8002: return { value: dv.getUint16(off + 2, true), size: 4 };
    case 0x8003: return { value: dv.getInt32(off + 2, true), size: 6 };
    case 0x8004: return { value: dv.getUint32(off + 2, true), size: 6 };
    case 0x8005: return { value: dv.getFloat32(off + 2, true), size: 6 };
    case 0x8006: return { value: dv.getFloat64(off + 2, true), size: 10 };
    case 0x8009: return { value: dv.getBigInt64(off + 2, true), size: 10 };
    case 0x800a: return { value: dv.getBigUint64(off + 2, true), size: 10 };
    default: throw new Error(`unsupported numeric leaf 0x${v.toString(16)}`);
  }
}

// ── Symbol records ───────────────────────────────────────────────────────────

export const S_CONSTANT = 0x1107;
export const S_LDATA32 = 0x110c;
export const S_GDATA32 = 0x110d;
export const S_PUB32 = 0x110e;

export type PdbSymbol =
  | { kind: 'const'; name: string; typeIndex: number; value: number | bigint }
  | { kind: 'gdata' | 'ldata'; name: string; typeIndex: number; segment: number; offset: number }
  | { kind: 'pub'; name: string; segment: number; offset: number; isCode: boolean };

/** Parse a symbol-record stream (the DBI's SymRecordStream). Unknown kinds are skipped. */
export function parseSymbolRecords(stream: Uint8Array): PdbSymbol[] {
  const dv = view(stream);
  const out: PdbSymbol[] = [];
  let p = 0;
  while (p + 4 <= stream.length) {
    const len = dv.getUint16(p, true);
    if (len < 2) break;
    const kind = dv.getUint16(p + 2, true);
    const body = p + 4;
    const end = p + 2 + len;
    try {
      if (kind === S_LDATA32 || kind === S_GDATA32) {
        out.push({
          kind: kind === S_GDATA32 ? 'gdata' : 'ldata',
          typeIndex: dv.getUint32(body, true),
          offset: dv.getUint32(body + 4, true),
          segment: dv.getUint16(body + 8, true),
          name: cstr(stream, body + 10, end),
        });
      } else if (kind === S_CONSTANT) {
        const num = readNumeric(dv, body + 4);
        out.push({
          kind: 'const',
          typeIndex: dv.getUint32(body, true),
          value: num.value,
          name: cstr(stream, body + 4 + num.size, end),
        });
      } else if (kind === S_PUB32) {
        out.push({
          kind: 'pub',
          isCode: (dv.getUint32(body, true) & 0x1) !== 0,
          offset: dv.getUint32(body + 4, true),
          segment: dv.getUint16(body + 8, true),
          name: cstr(stream, body + 10, end),
        });
      }
    } catch {
      // A record we cannot decode is skipped, never fatal.
    }
    p = end;
  }
  return out;
}

// ── Type table (TPI) ─────────────────────────────────────────────────────────

const LF_VTSHAPE = 0x000a;
const LF_MODIFIER = 0x1001;
const LF_POINTER = 0x1002;
const LF_PROCEDURE = 0x1008;
const LF_MFUNCTION = 0x1009;
const LF_FIELDLIST = 0x1203;
const LF_BITFIELD = 0x1205;
const LF_BCLASS = 0x1400;
const LF_VBCLASS = 0x1401;
const LF_IVBCLASS = 0x1402;
const LF_INDEX = 0x1404;
const LF_VFUNCTAB = 0x1409;
const LF_ENUMERATE = 0x1502;
const LF_ARRAY = 0x1503;
const LF_CLASS = 0x1504;
const LF_STRUCTURE = 0x1505;
const LF_UNION = 0x1506;
const LF_ENUM = 0x1507;
const LF_MEMBER = 0x150d;
const LF_STMEMBER = 0x150e;
const LF_METHOD = 0x150f;
const LF_NESTTYPE = 0x1510;
const LF_ONEMETHOD = 0x1511;

type BasicKind = 'void' | 'int' | 'uint' | 'float' | 'bool' | 'char' | 'wchar';
const BASIC: Record<number, { name: string; size: number; kind: BasicKind }> = {
  0x03: { name: 'void', size: 0, kind: 'void' },
  0x08: { name: 'HRESULT', size: 4, kind: 'int' },
  0x10: { name: 'signed char', size: 1, kind: 'char' },
  0x20: { name: 'unsigned char', size: 1, kind: 'uint' },
  0x70: { name: 'char', size: 1, kind: 'char' },
  0x71: { name: 'wchar_t', size: 2, kind: 'wchar' },
  0x68: { name: '__int8', size: 1, kind: 'int' },
  0x69: { name: 'unsigned __int8', size: 1, kind: 'uint' },
  0x11: { name: 'short', size: 2, kind: 'int' },
  0x21: { name: 'unsigned short', size: 2, kind: 'uint' },
  0x72: { name: 'short', size: 2, kind: 'int' },
  0x73: { name: 'unsigned short', size: 2, kind: 'uint' },
  0x12: { name: 'long', size: 4, kind: 'int' },
  0x22: { name: 'unsigned long', size: 4, kind: 'uint' },
  0x74: { name: 'int', size: 4, kind: 'int' },
  0x75: { name: 'unsigned int', size: 4, kind: 'uint' },
  0x13: { name: '__int64', size: 8, kind: 'int' },
  0x23: { name: 'unsigned __int64', size: 8, kind: 'uint' },
  0x76: { name: '__int64', size: 8, kind: 'int' },
  0x77: { name: 'unsigned __int64', size: 8, kind: 'uint' },
  0x30: { name: 'bool', size: 1, kind: 'bool' },
  0x31: { name: 'bool16', size: 2, kind: 'bool' },
  0x32: { name: 'bool32', size: 4, kind: 'bool' },
  0x40: { name: 'float', size: 4, kind: 'float' },
  0x41: { name: 'double', size: 8, kind: 'float' },
};

export interface Member { name: string; typeIndex: number; offset: number }

/** Resolved shape of a type index, enough to size and print a value. */
export type TypeShape =
  | { kind: 'basic'; name: string; size: number; basic: BasicKind }
  | { kind: 'pointer'; name: string; size: number }
  | { kind: 'array'; name: string; size: number; elem: number }
  | { kind: 'record'; name: string; size: number; members: Member[] }
  | { kind: 'enum'; name: string; size: number; underlying: number; values: Map<string, string> }
  | { kind: 'unknown'; name: string; size: number };

interface RawType { kind: number; data: DataView; start: number; end: number }

export class TypeTable {
  private readonly records = new Map<number, RawType>();
  private readonly definitions = new Map<string, number>();
  private readonly shapes = new Map<number, TypeShape>();

  constructor(tpi: Uint8Array) {
    const dv = view(tpi);
    const headerSize = dv.getUint32(4, true);
    let ti = dv.getUint32(8, true);
    let p = headerSize;
    while (p + 4 <= tpi.length) {
      const len = dv.getUint16(p, true);
      const kind = dv.getUint16(p + 2, true);
      this.records.set(ti, { kind, data: dv, start: p + 4, end: p + 2 + len });
      ti++;
      p += 2 + len;
    }
    // Forward references resolve to the full definition with the same name.
    for (const [index, rec] of this.records) {
      if (!isAggregate(rec.kind)) continue;
      const { name, forward } = aggregateHeader(rec);
      if (!forward && !this.definitions.has(name)) this.definitions.set(name, index);
    }
  }

  shape(ti: number, depth = 0): TypeShape {
    const cached = this.shapes.get(ti);
    if (cached) return cached;
    const s = depth > 32 ? unknownShape(`<type 0x${ti.toString(16)}>`) : this.computeShape(ti, depth);
    this.shapes.set(ti, s);
    return s;
  }

  private computeShape(ti: number, depth: number): TypeShape {
    if (ti < 0x1000) {
      const mode = (ti >> 8) & 0x7;
      const base = BASIC[ti & 0xff];
      const baseName = base?.name ?? `<basic 0x${(ti & 0xff).toString(16)}>`;
      if (mode !== 0) return { kind: 'pointer', name: `${baseName} *`, size: mode === 6 ? 8 : 4 };
      if (!base) return unknownShape(baseName);
      return { kind: 'basic', name: base.name, size: base.size, basic: base.kind };
    }
    const rec = this.records.get(ti);
    if (!rec) return unknownShape(`<type 0x${ti.toString(16)}>`);
    const dv = rec.data;
    const b = rec.start;
    switch (rec.kind) {
      case LF_MODIFIER: {
        const inner = this.shape(dv.getUint32(b, true), depth + 1);
        const attr = dv.getUint16(b + 4, true);
        const q = [(attr & 1) && 'const', (attr & 2) && 'volatile'].filter(Boolean).join(' ');
        return { ...inner, name: q ? `${q} ${inner.name}` : inner.name } as TypeShape;
      }
      case LF_POINTER: {
        const attr = dv.getUint32(b + 4, true);
        const size = (attr >> 13) & 0x3f || 4;
        return { kind: 'pointer', name: `${this.shape(dv.getUint32(b, true), depth + 1).name} *`, size };
      }
      case LF_ARRAY: {
        const elem = dv.getUint32(b, true);
        const size = Number(readNumeric(dv, b + 8).value);
        const e = this.shape(elem, depth + 1);
        const count = e.size > 0 ? size / e.size : 0;
        return { kind: 'array', name: `${e.name}[${count}]`, size, elem };
      }
      case LF_CLASS:
      case LF_STRUCTURE:
      case LF_UNION: {
        const hdr = aggregateHeader(rec);
        if (hdr.forward) {
          const def = this.definitions.get(hdr.name);
          return def !== undefined ? this.shape(def, depth + 1) : unknownShape(hdr.name);
        }
        return { kind: 'record', name: hdr.name, size: hdr.size, members: this.members(hdr.fieldList) };
      }
      case LF_ENUM: {
        const underlying = dv.getUint32(b + 4, true);
        const name = cstr(u8(dv), b + 12, rec.end);
        const values = new Map<string, string>();
        for (const e of this.enumerates(dv.getUint32(b + 8, true))) {
          if (!values.has(e.value)) values.set(e.value, e.name);
        }
        return { kind: 'enum', name, size: this.shape(underlying, depth + 1).size || 4, underlying, values };
      }
      case LF_BITFIELD:
        return this.shape(dv.getUint32(b, true), depth + 1);
      case LF_PROCEDURE:
      case LF_MFUNCTION:
        return unknownShape('<function>');
      case LF_VTSHAPE:
        return unknownShape('<vtshape>');
      default:
        return unknownShape(`<leaf 0x${rec.kind.toString(16)}>`);
    }
  }

  /** Data members of a field list (base-class subobjects included, flattened by offset). */
  private members(fieldList: number): Member[] {
    const out: Member[] = [];
    this.walkFieldList(fieldList, (leaf, dv, p) => {
      if (leaf === LF_MEMBER) {
        const num = readNumeric(dv, p + 8);
        out.push({ typeIndex: dv.getUint32(p + 4, true), offset: Number(num.value), name: cstr(u8(dv), p + 8 + num.size) });
      } else if (leaf === LF_BCLASS) {
        const num = readNumeric(dv, p + 8);
        out.push({ typeIndex: dv.getUint32(p + 4, true), offset: Number(num.value), name: '<base>' });
      }
    });
    return out;
  }

  private enumerates(fieldList: number): { name: string; value: string }[] {
    const out: { name: string; value: string }[] = [];
    this.walkFieldList(fieldList, (leaf, dv, p) => {
      if (leaf !== LF_ENUMERATE) return;
      const num = readNumeric(dv, p + 4);
      out.push({ value: String(num.value), name: cstr(u8(dv), p + 4 + num.size) });
    });
    return out;
  }

  /**
   * Visit each sub-record of a field list, following LF_INDEX continuations.
   * Stops at the first sub-record it cannot size rather than guessing.
   */
  private walkFieldList(ti: number, visit: (leaf: number, dv: DataView, p: number) => void, hops = 0): void {
    const rec = this.records.get(ti);
    if (!rec || rec.kind !== LF_FIELDLIST || hops > 64) return;
    const dv = rec.data;
    const bytes = u8(dv);
    let p = rec.start;
    while (p + 2 <= rec.end) {
      if (bytes[p] >= 0xf0) { p += bytes[p] & 0x0f || 1; continue; }
      const leaf = dv.getUint16(p, true);
      let next: number;
      try {
        next = this.fieldListEntryEnd(leaf, dv, bytes, p, rec.end);
      } catch {
        return;
      }
      if (leaf === LF_INDEX) {
        this.walkFieldList(dv.getUint32(p + 4, true), visit, hops + 1);
        return;
      }
      visit(leaf, dv, p);
      p = next;
      while (p < rec.end && bytes[p] >= 0xf0) p += bytes[p] & 0x0f || 1;
    }
  }

  private fieldListEntryEnd(leaf: number, dv: DataView, bytes: Uint8Array, p: number, end: number): number {
    switch (leaf) {
      case LF_MEMBER: { const n = readNumeric(dv, p + 8); return cstrEnd(bytes, p + 8 + n.size, end); }
      case LF_STMEMBER: return cstrEnd(bytes, p + 8, end);
      case LF_ENUMERATE: { const n = readNumeric(dv, p + 4); return cstrEnd(bytes, p + 4 + n.size, end); }
      case LF_BCLASS: { const n = readNumeric(dv, p + 8); return p + 8 + n.size; }
      case LF_VBCLASS:
      case LF_IVBCLASS: {
        const a = readNumeric(dv, p + 12);
        const c = readNumeric(dv, p + 12 + a.size);
        return p + 12 + a.size + c.size;
      }
      case LF_VFUNCTAB: return p + 8;
      case LF_INDEX: return p + 8;
      case LF_METHOD: return cstrEnd(bytes, p + 8, end);
      case LF_NESTTYPE: return cstrEnd(bytes, p + 8, end);
      case LF_ONEMETHOD: {
        const mprop = (dv.getUint16(p + 2, true) >> 2) & 0x7;
        const introducing = mprop === 4 || mprop === 6;
        return cstrEnd(bytes, p + 8 + (introducing ? 4 : 0), end);
      }
      default: throw new Error(`unsized field-list leaf 0x${leaf.toString(16)}`);
    }
  }
}

function isAggregate(kind: number): boolean {
  return kind === LF_CLASS || kind === LF_STRUCTURE || kind === LF_UNION;
}

function aggregateHeader(rec: RawType): { name: string; size: number; fieldList: number; forward: boolean } {
  const dv = rec.data;
  const b = rec.start;
  const prop = dv.getUint16(b + 2, true);
  const fieldList = dv.getUint32(b + 4, true);
  const sizeOff = rec.kind === LF_UNION ? b + 8 : b + 16;
  const num = readNumeric(dv, sizeOff);
  return {
    name: cstr(u8(dv), sizeOff + num.size, rec.end),
    size: Number(num.value),
    fieldList,
    forward: (prop & 0x80) !== 0,
  };
}

function unknownShape(name: string): TypeShape {
  return { kind: 'unknown', name, size: 0 };
}

// ── PE image ────────────────────────────────────────────────────────────────

export interface PeSection { name: string; virtualAddress: number; virtualSize: number; rawOffset: number; rawSize: number }

export interface PeImage {
  imageBase: number;
  sections: PeSection[];
  /** GUID from the CodeView RSDS debug record, or null if absent. */
  pdbGuid: string | null;
  bytes: Uint8Array;
}

export function readPe(bytes: Uint8Array): PeImage {
  const dv = view(bytes);
  const pe = dv.getUint32(0x3c, true);
  if (latin1(bytes.subarray(pe, pe + 4)) !== 'PE\0\0') throw new Error('not a PE image');
  const sectionCount = dv.getUint16(pe + 6, true);
  const optSize = dv.getUint16(pe + 20, true);
  const opt = pe + 24;
  const imageBase = dv.getUint32(opt + 28, true);
  const sections: PeSection[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const o = opt + optSize + i * 40;
    sections.push({
      name: latin1(bytes.subarray(o, o + 8)).replace(/\0+$/, ''),
      virtualSize: dv.getUint32(o + 8, true),
      virtualAddress: dv.getUint32(o + 12, true),
      rawSize: dv.getUint32(o + 16, true),
      rawOffset: dv.getUint32(o + 20, true),
    });
  }

  let pdbGuid: string | null = null;
  const numDirs = dv.getUint32(opt + 92, true);
  if (numDirs > 6) {
    const debugRva = dv.getUint32(opt + 96 + 6 * 8, true);
    const debugSize = dv.getUint32(opt + 96 + 6 * 8 + 4, true);
    const debugOff = rvaToFileOffset(sections, debugRva);
    for (let o = 0; debugOff !== null && o + 28 <= debugSize; o += 28) {
      if (dv.getUint32(debugOff + o + 12, true) !== 2) continue;
      const raw = dv.getUint32(debugOff + o + 24, true);
      if (latin1(bytes.subarray(raw, raw + 4)) === 'RSDS') pdbGuid = guidString(bytes.subarray(raw + 4, raw + 20));
    }
  }
  return { imageBase, sections, pdbGuid, bytes };
}

function rvaToFileOffset(sections: PeSection[], rva: number): number | null {
  for (const s of sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + s.rawSize) return s.rawOffset + rva - s.virtualAddress;
  }
  return null;
}

// ── Value formatting ─────────────────────────────────────────────────────────

const MAX_ARRAY_ELEMS = 32;
const MAX_TEXT = 1500;

export interface ValueContext {
  types: TypeTable;
  pe: PeImage;
  /** VA → symbol name, used to annotate pointers. */
  symbolAt: Map<number, string>;
}

/** Read `size` initialized bytes at segment:offset; null when they live in the zero-fill (bss) tail. */
export function readInitialized(pe: PeImage, segment: number, offset: number, size: number): Uint8Array | null {
  const s = pe.sections[segment - 1];
  if (!s || offset + size > s.rawSize) return null;
  return pe.bytes.subarray(s.rawOffset + offset, s.rawOffset + offset + size);
}

export function formatValue(ctx: ValueContext, ti: number, bytes: Uint8Array, depth = 0): string {
  const shape = ctx.types.shape(ti);
  const dv = view(bytes);
  switch (shape.kind) {
    case 'basic': return formatBasic(shape.basic, shape.size, dv);
    case 'enum': {
      const raw = String(readInt(dv, shape.size, true));
      const member = shape.values.get(raw);
      return member ? `${member} (${raw})` : raw;
    }
    case 'pointer': {
      if (shape.size !== 4) return hex(bytes);
      const va = dv.getUint32(0, true);
      if (va === 0) return 'NULL';
      const sym = ctx.symbolAt.get(va);
      if (sym) return `0x${va.toString(16)} -> ${sym}`;
      const str = cStringAt(ctx.pe, va);
      return str !== null ? `0x${va.toString(16)} -> ${JSON.stringify(str)}` : `0x${va.toString(16)}`;
    }
    case 'array': {
      const elem = ctx.types.shape(shape.elem);
      if (elem.kind === 'basic' && elem.basic === 'char') return JSON.stringify(latin1(bytes).replace(/\0.*$/s, ''));
      if (elem.size <= 0) return hex(bytes);
      const count = Math.floor(shape.size / elem.size);
      const parts: string[] = [];
      for (let i = 0; i < Math.min(count, MAX_ARRAY_ELEMS); i++) {
        parts.push(formatValue(ctx, shape.elem, bytes.subarray(i * elem.size, (i + 1) * elem.size), depth + 1));
      }
      if (count > MAX_ARRAY_ELEMS) parts.push(`…+${count - MAX_ARRAY_ELEMS}`);
      return clip(`[${parts.join(', ')}]`);
    }
    case 'record': {
      if (depth > 3 || shape.members.length === 0) return hex(bytes);
      const parts = shape.members.map((m) => {
        const size = ctx.types.shape(m.typeIndex).size;
        if (size <= 0 || m.offset + size > bytes.length) return `${m.name}=?`;
        return `${m.name}=${formatValue(ctx, m.typeIndex, bytes.subarray(m.offset, m.offset + size), depth + 1)}`;
      });
      return clip(`{${parts.join(', ')}}`);
    }
    default:
      return hex(bytes);
  }
}

function formatBasic(kind: BasicKind, size: number, dv: DataView): string {
  switch (kind) {
    case 'float': return size === 4 ? shortestFloat32(dv.getFloat32(0, true)) : String(dv.getFloat64(0, true));
    case 'bool': return readInt(dv, size, false) === 0n ? 'false' : 'true';
    case 'int':
    case 'char': return withHex(readInt(dv, size, true));
    case 'uint':
    case 'wchar': return withHex(readInt(dv, size, false));
    default: return '';
  }
}

export function shortestFloat32(f: number): string {
  if (!Number.isFinite(f)) return String(f);
  for (let p = 1; p <= 9; p++) {
    const s = Number(f.toPrecision(p));
    if (Math.fround(s) === f) return String(s);
  }
  return String(f);
}

function readInt(dv: DataView, size: number, signed: boolean): bigint {
  switch (size) {
    case 1: return BigInt(signed ? dv.getInt8(0) : dv.getUint8(0));
    case 2: return BigInt(signed ? dv.getInt16(0, true) : dv.getUint16(0, true));
    case 4: return BigInt(signed ? dv.getInt32(0, true) : dv.getUint32(0, true));
    case 8: return signed ? dv.getBigInt64(0, true) : dv.getBigUint64(0, true);
    default: return 0n;
  }
}

function withHex(v: bigint): string {
  const abs = v < 0n ? -v : v;
  return abs > 255n ? `${v} (0x${v < 0n ? '-' : ''}${abs.toString(16)})` : String(v);
}

function cStringAt(pe: PeImage, va: number): string | null {
  const rva = va - pe.imageBase;
  const section = pe.sections.find((s) => rva >= s.virtualAddress && rva < s.virtualAddress + s.rawSize);
  if (!section || section.name === '.text') return null;
  const off = rvaToFileOffset(pe.sections, rva);
  if (off === null) return null;
  let end = off;
  while (end < pe.bytes.length && end - off < 256 && pe.bytes[end] !== 0) {
    const c = pe.bytes[end];
    if ((c < 0x20 || c > 0x7e) && c !== 0x09 && c !== 0x0a && c !== 0x0d) return null;
    end++;
  }
  if (end === off || pe.bytes[end] !== 0) return null;
  return latin1(pe.bytes.subarray(off, end));
}

// ── Top-level extraction ────────────────────────────────────────────────────

export interface GlobalRow {
  name: string;
  /** const = compile-time S_CONSTANT; gdata/ldata = storage in the image. */
  kind: 'const' | 'gdata' | 'ldata';
  type: string;
  /** Virtual address, or '' for compile-time constants. */
  va: string;
  section: string;
  /**
   * `static` = value read from the image; `bss` = zero-fill storage, set at
   * runtime; `dyninit` = a `$E` C++ dynamic initializer computes it at startup
   * (value names the initializer and its expression; image bytes are not the
   * real value); `const` = compile-time constant.
   */
  init: 'static' | 'bss' | 'dyninit' | 'const';
  value: string;
  /** How many distinct storage copies share this name/type/value (per-TU statics). */
  copies: number;
}

/**
 * @param decompiledC Ghidra's exported C (optional). VC7.1 names its C++
 *   dynamic initializers `$E1`, `$E4`, … as module-local procedures, so the PDB
 *   alone cannot say which global each one computes; their decompiled bodies can.
 */
export function extractGlobals(pdbBytes: Uint8Array, exeBytes: Uint8Array, decompiledC?: string): GlobalRow[] {
  const msf = readMsf(pdbBytes);
  const pe = readPe(exeBytes);
  const pdbGuid = readPdbGuid(msf);
  if (pe.pdbGuid && pe.pdbGuid !== pdbGuid) {
    throw new Error(`PDB/EXE mismatch: exe expects ${pe.pdbGuid}, pdb is ${pdbGuid}`);
  }
  const dbi = readDbiHeader(msf);
  const types = new TypeTable(msf.readStream(2));
  const symbols = parseSymbolRecords(msf.readStream(dbi.symRecordStream));

  const vaOf = (segment: number, offset: number): number | null => {
    const s = pe.sections[segment - 1];
    return s ? pe.imageBase + s.virtualAddress + offset : null;
  };

  const symbolAt = new Map<number, string>();
  const dataNames = new Set<string>();
  for (const s of symbols) {
    if (s.kind !== 'gdata' && s.kind !== 'ldata') continue;
    dataNames.add(s.name);
    const va = vaOf(s.segment, s.offset);
    if (va !== null && !symbolAt.has(va)) symbolAt.set(va, s.name);
  }
  const dynInit = decompiledC ? findDynamicInitializers(decompiledC, dataNames) : new Map<string, string>();

  const rows = new Map<string, GlobalRow>();
  const seenStorage = new Set<string>();
  const ctx: ValueContext = { types, pe, symbolAt };
  for (const s of symbols) {
    if (s.kind === 'pub') continue;
    let row: GlobalRow;
    if (s.kind === 'const') {
      row = {
        name: s.name, kind: 'const', type: types.shape(s.typeIndex).name, va: '', section: '',
        init: 'const', value: formatConstant(types, s.typeIndex, s.value), copies: 1,
      };
    } else {
      const storage = `${s.segment}:${s.offset}:${s.name}`;
      if (seenStorage.has(storage)) continue;
      seenStorage.add(storage);
      const shape = types.shape(s.typeIndex);
      const va = vaOf(s.segment, s.offset);
      const section = pe.sections[s.segment - 1]?.name ?? `seg${s.segment}`;
      const bytes = shape.size > 0 ? readInitialized(pe, s.segment, s.offset, shape.size) : null;
      let init: GlobalRow['init'];
      let value: string;
      const initializer = dynInit.get(s.name);
      if (initializer !== undefined) {
        init = 'dyninit';
        value = initializer;
      } else if (shape.size <= 0) {
        init = 'static';
        value = '';
      } else if (!bytes) {
        init = 'bss';
        value = '';
      } else {
        init = 'static';
        value = formatValue(ctx, s.typeIndex, bytes);
      }
      row = {
        name: s.name, kind: s.kind, type: shape.name, va: va === null ? '' : `0x${va.toString(16)}`,
        section, init, value, copies: 1,
      };
    }
    const key = `${row.name}\t${row.kind === 'const' ? 'const' : 'data'}\t${row.type}\t${row.init}\t${row.value}`;
    const existing = rows.get(key);
    if (existing) existing.copies++;
    else rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.va < b.va ? -1 : 1));
}

function formatConstant(types: TypeTable, ti: number, value: number | bigint): string {
  const shape = types.shape(ti);
  if (typeof value === 'number' && !Number.isInteger(value)) return String(value);
  const big = BigInt(value);
  if (shape.kind === 'enum') {
    const member = shape.values.get(String(big));
    return member ? `${member} (${big})` : String(big);
  }
  return withHex(big);
}

const DYN_INIT_HEADER = /^\/\/ ===== (\$E\d+) @ [0-9a-f]+ =====$/;
const ASSIGNMENT = /^\s*([A-Za-z_][\w:]*)(?:\.[\w.]+|\[[^\]]*\])*\s*=(?!=)\s*(.*?);?\s*$/;
const ADDRESS_ARG = /\(&([A-Za-z_][\w:]*)/g;

/**
 * Map each global written by a `$E` dynamic initializer to a short
 * description of what the initializer does (`$E7: <expression>`). Only names
 * that are real PDB data symbols count, so locals and temporaries are ignored.
 */
export function findDynamicInitializers(decompiledC: string, dataNames: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const line of decompiledC.split('\n')) {
    if (line.startsWith('// ===== ')) {
      current = DYN_INIT_HEADER.exec(line)?.[1] ?? null;
      continue;
    }
    if (!current) continue;
    const assign = ASSIGNMENT.exec(line);
    if (assign && dataNames.has(assign[1]) && !out.has(assign[1])) {
      out.set(assign[1], clip(`${current}: ${assign[2]}`, 200));
      continue;
    }
    for (const m of line.matchAll(ADDRESS_ARG)) {
      if (dataNames.has(m[1]) && !out.has(m[1])) out.set(m[1], clip(`${current}: ${line.trim()}`, 200));
    }
  }
  return out;
}

export const TSV_HEADER = 'name\tkind\ttype\tva\tsection\tinit\tvalue\tcopies';

export function toTsv(rows: GlobalRow[]): string {
  const clean = (s: string) => s.replace(/[\t\r\n]/g, ' ');
  return [TSV_HEADER, ...rows.map((r) =>
    [r.name, r.kind, r.type, r.va, r.section, r.init, r.value, String(r.copies)].map(clean).join('\t'))].join('\n') + '\n';
}

// ── byte helpers ─────────────────────────────────────────────────────────────

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function u8(dv: DataView): Uint8Array {
  return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function cstrEnd(b: Uint8Array, start: number, end: number): number {
  let i = start;
  while (i < end && b[i] !== 0) i++;
  if (i >= end) throw new Error('unterminated name');
  return i + 1;
}

function cstr(b: Uint8Array, start: number, end = b.length): string {
  let i = start;
  while (i < end && b[i] !== 0) i++;
  return latin1(b.subarray(start, i));
}

function hex(b: Uint8Array): string {
  const n = Math.min(b.length, 64);
  let s = '';
  for (let i = 0; i < n; i++) s += b[i].toString(16).padStart(2, '0');
  return `hex:${s}${b.length > n ? `…(${b.length}B)` : ''}`;
}

function clip(s: string, max = MAX_TEXT): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function guidString(g: Uint8Array): string {
  const dv = view(g);
  const h = (n: number, w: number) => n.toString(16).padStart(w, '0');
  const tail = [...g.subarray(8)].map((x) => h(x, 2)).join('');
  return `${h(dv.getUint32(0, true), 8)}-${h(dv.getUint16(4, true), 4)}-${h(dv.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`.toUpperCase();
}
