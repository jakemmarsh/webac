/**
 * tools/pdb-globals-lib.ts — the PDB/EXE global-constant extractor.
 *
 * The unit suite drives the real parser with a hand-built MSF PDB and PE image
 * (every record type the extractor decodes), so it runs everywhere. The
 * reference suite checks values against the real retail client when
 * reference/client-eol is provisioned; its anchors were cross-validated by a
 * manual stream-8 extraction (progress.md, BUG.jump-charge-frame-dependent).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  extractGlobals,
  findDynamicInitializers,
  readNumeric,
  shortestFloat32,
  toTsv,
  TSV_HEADER,
  type GlobalRow,
} from '../tools/pdb-globals-lib';

// ── byte builders ────────────────────────────────────────────────────────────

class Bytes {
  private readonly out: number[] = [];
  u8(v: number) { this.out.push(v & 0xff); return this; }
  u16(v: number) { return this.u8(v).u8(v >> 8); }
  u32(v: number) { return this.u16(v & 0xffff).u16(v >>> 16); }
  f32(v: number) { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); return this.raw(new Uint8Array(b.buffer)); }
  f64(v: number) { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); return this.raw(new Uint8Array(b.buffer)); }
  cstr(s: string) { for (const c of s) this.u8(c.charCodeAt(0)); return this.u8(0); }
  raw(b: Uint8Array) { for (const x of b) this.out.push(x); return this; }
  get length() { return this.out.length; }
  bytes() { return Uint8Array.from(this.out); }
}

/** A CodeView record: u16 length, u16 kind, payload padded with LF_PAD bytes. */
function record(kind: number, payload: Bytes): Uint8Array {
  const body = new Bytes().u16(kind).raw(payload.bytes());
  while ((body.length + 2) % 4 !== 0) body.u8(0xf0 | (4 - ((body.length + 2) % 4)));
  return new Bytes().u16(body.length).raw(body.bytes()).bytes();
}

function concat(parts: Uint8Array[]): Uint8Array {
  const b = new Bytes();
  for (const p of parts) b.raw(p);
  return b.bytes();
}

function buildMsf(streams: Uint8Array[]): Uint8Array {
  const bs = 512;
  const blocks: Uint8Array[] = [new Uint8Array(bs), new Uint8Array(bs), new Uint8Array(bs)];
  const place = (data: Uint8Array): number[] => {
    const ids: number[] = [];
    for (let o = 0; o < data.length; o += bs) {
      const blk = new Uint8Array(bs);
      blk.set(data.subarray(o, o + bs));
      ids.push(blocks.length);
      blocks.push(blk);
    }
    return ids;
  };
  const streamBlocks = streams.map(place);
  const dir = new Bytes().u32(streams.length);
  streams.forEach((s) => dir.u32(s.length));
  streamBlocks.flat().forEach((id) => dir.u32(id));
  const dirIds = place(dir.bytes());
  const map = new Bytes();
  dirIds.forEach((id) => map.u32(id));
  const mapId = place(map.bytes())[0];

  const sb = new Bytes();
  for (const c of 'Microsoft C/C++ MSF 7.00\r\n\x1aDS\0\0\0') sb.u8(c.charCodeAt(0));
  sb.u32(bs).u32(1).u32(blocks.length).u32(dir.length).u32(0).u32(mapId);
  blocks[0].set(sb.bytes());
  return concat(blocks);
}

const GUID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const OTHER_GUID = Uint8Array.from([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);

const IMAGE_BASE = 0x400000;
const RDATA_RVA = 0x1000;
const RDATA_RAW = 0x400;
const DATA_RVA = 0x2000;
const DATA_RAW = 0x600;
const DATA_RAW_SIZE = 0x80;
const STRING_OFF = 44;
const DEBUG_DIR_OFF = 0x80;
const RSDS_OFF = 0xa0;

/** Minimal PE32: .rdata with the initialized values, .data with a short raw tail (rest is bss). */
function buildPe(guid: Uint8Array): Uint8Array {
  const file = new Uint8Array(DATA_RAW + DATA_RAW_SIZE);
  const dv = new DataView(file.buffer);
  dv.setUint32(0x3c, 0x40, true);
  file.set([0x50, 0x45, 0, 0], 0x40);
  dv.setUint16(0x40 + 4 + 2, 2, true);
  dv.setUint16(0x40 + 4 + 16, 224, true);
  const opt = 0x40 + 24;
  dv.setUint16(opt, 0x10b, true);
  dv.setUint32(opt + 28, IMAGE_BASE, true);
  dv.setUint32(opt + 92, 16, true);
  dv.setUint32(opt + 96 + 6 * 8, RDATA_RVA + DEBUG_DIR_OFF, true);
  dv.setUint32(opt + 96 + 6 * 8 + 4, 28, true);
  const sections: [string, number, number, number, number][] = [
    ['.rdata', 0x100, RDATA_RVA, 0x200, RDATA_RAW],
    ['.data', 0x1000, DATA_RVA, DATA_RAW_SIZE, DATA_RAW],
  ];
  sections.forEach(([name, vsize, va, rawSize, rawOff], i) => {
    const o = opt + 224 + i * 40;
    for (let c = 0; c < name.length; c++) file[o + c] = name.charCodeAt(c);
    dv.setUint32(o + 8, vsize, true);
    dv.setUint32(o + 12, va, true);
    dv.setUint32(o + 16, rawSize, true);
    dv.setUint32(o + 20, rawOff, true);
  });

  const rdata = new Bytes()
    .f64(1.0) //                        0  POWER_TIME
    .f64(1.0) //                        8  POWER_TIME (second TU's copy)
    .f32(0.001) //                      16 JUMP_EXTENT
    .f32(1.5).f32(-2) //                20 g_origin
    .u32(1).u32(2).u32(300) //          28 g_table
    .u32(IMAGE_BASE + RDATA_RVA + STRING_OFF) // 40 g_name
    .cstr('Holtburg'); //               44
  file.set(rdata.bytes(), RDATA_RAW);
  dv.setUint32(RDATA_RAW + DEBUG_DIR_OFF + 12, 2, true);
  dv.setUint32(RDATA_RAW + DEBUG_DIR_OFF + 24, RDATA_RAW + RSDS_OFF, true);
  file.set([0x52, 0x53, 0x44, 0x53], RDATA_RAW + RSDS_OFF);
  file.set(guid, RDATA_RAW + RSDS_OFF + 4);
  return file;
}

const T_INT4 = 0x74;
const T_UINT4 = 0x75;
const T_REAL32 = 0x40;
const T_REAL64 = 0x41;
const T_RCHAR = 0x70;

function buildTpi(): Uint8Array {
  const records = [
    // 0x1000 const double
    record(0x1001, new Bytes().u32(T_REAL64).u16(1)),
    // 0x1001 const float
    record(0x1001, new Bytes().u32(T_REAL32).u16(1)),
    // 0x1002 enum field list
    record(0x1203, new Bytes()
      .u16(0x1502).u16(3).u16(1).cstr('SIDE_LEFT')
      .u16(0x1502).u16(3).u16(2).cstr('SIDE_RIGHT')),
    // 0x1003 enum Side : int
    record(0x1507, new Bytes().u16(2).u16(0).u32(T_INT4).u32(0x1002).cstr('Side')),
    // 0x1004 Vec2 field list
    record(0x1203, new Bytes()
      .u16(0x150d).u16(3).u32(T_REAL32).u16(0).cstr('x')
      .u16(0x150d).u16(3).u32(T_REAL32).u16(4).cstr('y')),
    // 0x1005 forward reference to Vec2
    record(0x1505, new Bytes().u16(0).u16(0x80).u32(0).u32(0).u32(0).u16(0).cstr('Vec2')),
    // 0x1006 Vec2 definition
    record(0x1505, new Bytes().u16(2).u16(0).u32(0x1004).u32(0).u32(0).u16(8).cstr('Vec2')),
    // 0x1007 int[3]
    record(0x1503, new Bytes().u32(T_INT4).u32(0x22).u16(12).cstr('')),
    // 0x1008 char * (near32)
    record(0x1002, new Bytes().u32(T_RCHAR).u32((4 << 13) | 0x0a)),
  ];
  const body = concat(records);
  const header = new Bytes().u32(20040203).u32(56).u32(0x1000).u32(0x1000 + records.length).u32(body.length);
  while (header.length < 56) header.u8(0);
  return concat([header.bytes(), body]);
}

function data(kind: 0x110c | 0x110d, type: number, segment: number, offset: number, name: string): Uint8Array {
  return record(kind, new Bytes().u32(type).u32(offset).u16(segment).cstr(name));
}

function buildSymbols(): Uint8Array {
  return concat([
    data(0x110c, 0x1000, 1, 0, 'POWER_TIME'),
    data(0x110c, 0x1000, 1, 8, 'POWER_TIME'),
    data(0x110c, 0x1001, 1, 16, 'JUMP_EXTENT'),
    data(0x110d, 0x1005, 1, 20, 'g_origin'),
    data(0x110d, 0x1007, 1, 28, 'g_table'),
    data(0x110d, 0x1008, 1, 40, 'g_name'),
    data(0x110d, T_INT4, 2, 0x100, 'g_bss'),
    data(0x110d, T_REAL64, 2, 0, 'g_dyn'),
    record(0x1107, new Bytes().u32(0x1003).u16(2).cstr('SIDE_RIGHT')),
    record(0x1107, new Bytes().u32(T_UINT4).u16(0x8004).u32(0x80000000).cstr('BIG')),
    record(0x110e, new Bytes().u32(2).u32(0).u16(1).cstr('?Unrelated@@YAXXZ')),
  ]);
}

function buildPdb(guid: Uint8Array): Uint8Array {
  const info = new Bytes().u32(20000404).u32(0).u32(1).raw(guid).bytes();
  const dbi = new Bytes();
  dbi.u32(0xffffffff).u32(19990903).u32(1).u16(0).u16(0).u16(0).u16(0).u16(4);
  while (dbi.length < 64) dbi.u8(0);
  return buildMsf([new Uint8Array(0), info, buildTpi(), dbi.bytes(), buildSymbols()]);
}

const DECOMP = [
  '// ===== CPhysicsObj::update_object @ 00515e00 =====',
  '  g_bss = 5;',
  '// ===== $E7 @ 006c2b90 =====',
  'void __cdecl _E7(void)',
  '{',
  '  g_dyn = ___real_3ff0000000000000 / MIN_FRAMERATE;',
  '  local_8 = 3;',
  '  atexit(_E8);',
  '}',
].join('\n');

// ── unit suite ───────────────────────────────────────────────────────────────

describe('pdb-globals: synthetic PDB + PE', () => {
  let rows: GlobalRow[] = [];
  beforeAll(() => {
    rows = extractGlobals(buildPdb(GUID), buildPe(GUID), DECOMP);
  });
  const row = (name: string): GlobalRow => {
    const r = rows.find((x) => x.name === name);
    if (!r) throw new Error(`no row ${name}`);
    return r;
  };

  it('reads doubles from .rdata and collapses per-TU copies with the same value', () => {
    expect(row('POWER_TIME')).toMatchObject({
      kind: 'ldata', type: 'const double', section: '.rdata', init: 'static', value: '1', copies: 2,
      va: `0x${(IMAGE_BASE + RDATA_RVA).toString(16)}`,
    });
  });

  it('prints a 4-byte float at its shortest round-trip precision', () => {
    expect(row('JUMP_EXTENT')).toMatchObject({ type: 'const float', value: '0.001' });
  });

  it('resolves a forward-referenced struct to its definition and decodes its members', () => {
    expect(row('g_origin')).toMatchObject({ type: 'Vec2', value: '{x=1.5, y=-2}' });
  });

  it('decodes arrays element by element, adding hex for larger integers', () => {
    expect(row('g_table')).toMatchObject({ type: 'int[3]', value: '[1, 2, 300 (0x12c)]' });
  });

  it('follows a char pointer to the string it names', () => {
    const va = IMAGE_BASE + RDATA_RVA + STRING_OFF;
    expect(row('g_name')).toMatchObject({ type: 'char *', value: `0x${va.toString(16)} -> "Holtburg"` });
  });

  it('marks storage past the raw section data as bss rather than reporting a fake 0', () => {
    expect(row('g_bss')).toMatchObject({ section: '.data', init: 'bss', value: '' });
  });

  it('attributes a global written by a $E dynamic initializer to that initializer', () => {
    expect(row('g_dyn')).toMatchObject({
      init: 'dyninit', value: '$E7: ___real_3ff0000000000000 / MIN_FRAMERATE',
    });
  });

  it('names enum constants and decodes wide numeric leaves', () => {
    expect(row('SIDE_RIGHT')).toMatchObject({ kind: 'const', type: 'Side', value: 'SIDE_RIGHT (2)', va: '' });
    expect(row('BIG')).toMatchObject({ type: 'unsigned int', value: '2147483648 (0x80000000)' });
  });

  it('emits no rows for public (linker) symbols', () => {
    expect(rows.some((r) => r.name.startsWith('?'))).toBe(false);
  });

  it('refuses a PDB whose GUID does not match the executable', () => {
    expect(() => extractGlobals(buildPdb(OTHER_GUID), buildPe(GUID))).toThrow(/mismatch/);
  });

  it('writes one tab-separated line per row under a fixed header', () => {
    const lines = toTsv(rows).trimEnd().split('\n');
    expect(lines[0]).toBe(TSV_HEADER);
    expect(lines).toHaveLength(rows.length + 1);
    expect(lines.every((l) => l.split('\t').length === TSV_HEADER.split('\t').length)).toBe(true);
  });
});

describe('pdb-globals: helpers', () => {
  it('findDynamicInitializers ignores non-$E functions and names that are not data symbols', () => {
    const found = findDynamicInitializers(DECOMP, new Set(['g_dyn', 'g_bss']));
    expect([...found.keys()]).toEqual(['g_dyn']);
  });

  it('findDynamicInitializers attributes constructor calls taking a global by address', () => {
    const c = [
      '// ===== $E927 @ 006c3000 =====',
      '  PStringBase<char>::PStringBase<char>(&param_TEXOP_MODULATE4X,"Modulate4X");',
    ].join('\n');
    expect(findDynamicInitializers(c, new Set(['param_TEXOP_MODULATE4X'])).get('param_TEXOP_MODULATE4X'))
      .toBe('$E927: PStringBase<char>::PStringBase<char>(&param_TEXOP_MODULATE4X,"Modulate4X");');
  });

  it('readNumeric decodes inline and prefixed numeric leaves', () => {
    const dv = (b: Bytes) => new DataView(b.bytes().buffer);
    expect(readNumeric(dv(new Bytes().u16(12)), 0)).toEqual({ value: 12, size: 2 });
    expect(readNumeric(dv(new Bytes().u16(0x8001).u16(0xfffe)), 0)).toEqual({ value: -2, size: 4 });
    expect(readNumeric(dv(new Bytes().u16(0x8006).f64(0.8)), 0)).toEqual({ value: 0.8, size: 10 });
  });

  it('shortestFloat32 prints the shortest decimal that round-trips through float32', () => {
    expect(shortestFloat32(Math.fround(0.001))).toBe('0.001');
    expect(shortestFloat32(Math.fround(3.12))).toBe('3.12');
    expect(shortestFloat32(Math.fround(1 / 3))).toBe('0.33333334');
  });
});

// ── reference suite (real retail client; skipped when not provisioned) ───────

const CLIENT_EOL = join(__dirname, '..', 'reference', 'client-eol');
const HAS_CLIENT = existsSync(join(CLIENT_EOL, 'acclient.pdb')) && existsSync(join(CLIENT_EOL, 'acclient.exe'));
const HAS_DECOMP = existsSync(join(CLIENT_EOL, 'decomp', 'acclient-decompiled.c'));

describe.skipIf(!HAS_CLIENT)('pdb-globals: retail acclient (build ac1_sep13)', () => {
  let byName: Map<string, GlobalRow>;

  beforeAll(() => {
    const decompPath = join(CLIENT_EOL, 'decomp', 'acclient-decompiled.c');
    const rows = extractGlobals(
      readFileSync(join(CLIENT_EOL, 'acclient.pdb')),
      readFileSync(join(CLIENT_EOL, 'acclient.exe')),
      existsSync(decompPath) ? readFileSync(decompPath, 'latin1') : undefined,
    );
    byName = new Map(rows.map((r) => [r.name, r]));
  }, 120_000);

  it('matches the hand-extracted power-bar and framerate anchors', () => {
    expect(byName.get('ATTACK_POWERUP_TIME')).toMatchObject({ type: 'const double', value: '1' });
    expect(byName.get('DUAL_WIELD_POWERUP_TIME')).toMatchObject({ type: 'const double', value: '0.8' });
    expect(byName.get('MIN_FRAMERATE')).toMatchObject({ value: '5' });
    expect(byName.get('MAX_FRAMERATE')).toMatchObject({ value: '30' });
  });

  it('reads MIN_JUMP_EXTENT as a 4-byte float, not a double', () => {
    expect(byName.get('MIN_JUMP_EXTENT')).toMatchObject({ type: 'const float', value: '0.001' });
  });

  it('decodes the enum constants the paperdoll slot switch uses', () => {
    expect(byName.get('SLOT_SIDE_LEFT')).toMatchObject({ kind: 'const', value: 'SLOT_SIDE_LEFT (1)' });
  });

  it.skipIf(!HAS_DECOMP)('attributes the physics quantum bounds to their dynamic initializers', () => {
    expect(byName.get('MAX_QUANTUM')?.init).toBe('dyninit');
    expect(byName.get('MAX_QUANTUM')?.value).toContain('/ MIN_FRAMERATE');
  });
});
