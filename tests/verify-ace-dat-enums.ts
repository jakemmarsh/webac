/**
 * Runtime audit for DAT-parser ACE enums:
 *   - BSPType          (3 entries) — drives BSP tree dispatch (drawing vs physics vs cell)
 *   - CullMode         (4 entries) — polygon back-face culling mode
 *   - MotionDataFlags  (2 flags)   — gates HasVelocity/HasOmega in motion blocks
 *   - EmitterType      (3 entries) — particle emitter rate semantics
 *   - AnimationFlags   (1 flag)    — gates PosFrames block in Animation
 *   - EnvCellFlags     (3 flags)   — gates StaticObjects / RestrictionObjects blocks in EnvCell
 *
 * Each rides the DAT file binary format directly. Silent drift → wrong block
 * parsing → corrupted geometry, motion data, particle effects, or interior cells.
 *
 * FAITHFUL.97 fix anchor: EmitterType was renamed Birthrate→BirthratePerSec
 * and Initial→BirthratePerMeter to match ACE source exactly. Values were
 * already correct (1, 2); names obscured the per-sec vs per-meter semantics.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BSPType } from '../packages/dat-parser/src/file-types/BSPTree.js';
import { CullMode } from '../packages/dat-parser/src/file-types/Polygon.js';
import { MotionDataFlags } from '../packages/dat-parser/src/file-types/MotionTable.js';
import { EmitterType, ParticleType } from '../packages/dat-parser/src/file-types/ParticleEmitterInfo.js';
import { AnimationFlags } from '../packages/dat-parser/src/file-types/Animation.js';
import { EnvCellFlags } from '../packages/dat-parser/src/file-types/EnvCell.js';
import { NumberingType } from '../packages/dat-parser/src/file-types/EnumMapper.js';
import { IncorporationFlags, MediaType } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { SurfaceType } from '../packages/dat-parser/src/file-types/Surface.js';

const REPO = resolve(__dirname, '..');
const BSP_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/BSPType.cs');
const CULL_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CullMode.cs');
const MDF_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MotionDataFlags.cs');
const ET_PATH   = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/EmitterType.cs');
const AF_PATH   = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/AnimationFlags.cs');
const ECF_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/EnvCellFlags.cs');
const PT_PATH   = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ParticleType.cs');
const NT_PATH   = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/NumberingType.cs');
const IF_PATH   = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/IncorporationFlags.cs');
const MT_PATH   = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MediaType.cs');
const ST_PATH   = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/SurfaceType.cs');

interface AceEntry { name: string; value: number; }

function parseAceNumeric(path: string, enumName: string): AceEntry[] {
  const src = readFileSync(path, 'utf8');
  const lines = src.split('\n');
  const out: AceEntry[] = [];
  let inside = false;
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|-?\d+)\s*,?\s*(\/\/.*)?$/;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inside) { if (open.test(line)) inside = true; continue; }
    if (/^\s*}/.test(line)) break;
    const m = re.exec(line);
    if (m) {
      const value = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
      out.push({ name: m[1], value });
    }
  }
  return out;
}

function parseAceAutoNumbered(path: string, enumName: string): AceEntry[] {
  const src = readFileSync(path, 'utf8');
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  const lines = src.split('\n');
  const out: AceEntry[] = [];
  let inside = false;
  let index = 0;
  const ID_RE = /^\s*([A-Z][A-Za-z0-9_]*)\s*,?\s*$/;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '').replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').trimEnd();
    if (!inside) { if (open.test(line)) inside = true; continue; }
    if (/^\s*}/.test(line)) break;
    const m = ID_RE.exec(line);
    if (m) {
      out.push({ name: m[1], value: index });
      index++;
    }
  }
  return out;
}

function tsNamesOf(enumObj: Record<string, unknown>): string[] {
  return Object.keys(enumObj).filter((k) => Number.isNaN(Number(k)));
}

// ─── BSPType ────────────────────────────────────────────────

describe('ACE BSPType coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(BSP_PATH, 'BSPType');

  it('parses ACE source', () => {
    expect(existsSync(BSP_PATH)).toBe(true);
    expect(aceEntries.length).toBe(3);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'BSPType.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (BSPType as unknown as Record<string, number>)[name];
      expect(tsVal).toBe(value);
    },
  );
});

// ─── CullMode ───────────────────────────────────────────────

describe('ACE CullMode coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(CULL_PATH, 'CullMode');

  it('parses ACE source', () => {
    expect(existsSync(CULL_PATH)).toBe(true);
    expect(aceEntries.length).toBe(4);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'CullMode.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (CullMode as unknown as Record<string, number>)[name];
      expect(tsVal).toBe(value);
    },
  );
});

// ─── MotionDataFlags ────────────────────────────────────────

describe('ACE MotionDataFlags coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(MDF_PATH, 'MotionDataFlags');

  it('parses ACE source', () => {
    expect(existsSync(MDF_PATH)).toBe(true);
    expect(aceEntries.length).toBe(2);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'MotionDataFlags.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (MotionDataFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBe(value);
    },
  );
});

// ─── EmitterType ────────────────────────────────────────────

describe('ACE EmitterType coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(ET_PATH, 'EmitterType');

  it('parses ACE source', () => {
    expect(existsSync(ET_PATH)).toBe(true);
    expect(aceEntries.length).toBe(3);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'EmitterType.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (EmitterType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('FAITHFUL.97 fix anchor: BirthratePerSec=1, BirthratePerMeter=2', () => {
    expect(EmitterType.BirthratePerSec).toBe(1);
    expect(EmitterType.BirthratePerMeter).toBe(2);
  });
});

// ─── AnimationFlags ─────────────────────────────────────────

describe('ACE AnimationFlags coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(AF_PATH, 'AnimationFlags');

  it('parses ACE source', () => {
    expect(existsSync(AF_PATH)).toBe(true);
    expect(aceEntries.length).toBe(1);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'AnimationFlags.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (AnimationFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBe(value);
    },
  );
});

// ─── EnvCellFlags ───────────────────────────────────────────

describe('ACE EnvCellFlags coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(ECF_PATH, 'EnvCellFlags');

  it('parses ACE source', () => {
    expect(existsSync(ECF_PATH)).toBe(true);
    expect(aceEntries.length).toBe(3);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'EnvCellFlags.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (EnvCellFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(EnvCellFlags as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── ParticleType ───────────────────────────────────────────

describe('ACE ParticleType coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(PT_PATH, 'ParticleType');

  it('parses ACE source', () => {
    expect(existsSync(PT_PATH)).toBe(true);
    expect(aceEntries.length).toBe(14);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'ParticleType.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (ParticleType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('FAITHFUL.98 fix anchor: ACE-source names (ParabolicLVGA, GlobalVelocity, etc.)', () => {
    expect(ParticleType.ParabolicLVGA).toBe(3);
    expect(ParticleType.ParabolicLVGAGR).toBe(4);
    expect(ParticleType.ParabolicLVLA).toBe(8);
    expect(ParticleType.GlobalVelocity).toBe(12);
    expect(ParticleType.NumParticleType).toBe(13);
  });
});

// ─── NumberingType ──────────────────────────────────────────

describe('ACE NumberingType coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(NT_PATH, 'NumberingType');

  it('parses ACE source', () => {
    expect(existsSync(NT_PATH)).toBe(true);
    // ACE has 6 entries (Undefined=0, Normal=Sequential=1, Bitfield=2, Bitfield32=3, Bitfield64=4).
    // The parser picks up all 6 lines but Normal/Sequential share value 1.
    expect(aceEntries.length).toBe(6);
  });

  // Filter the Sequential alias since TS port carries it as a separate
  // SEQUENTIAL_NUMBERING const (TypeScript doesn't allow two enum keys to
  // share the same value via duplicate-name binding).
  it.each(aceEntries.filter((e) => e.name !== 'Sequential').map((e) => [e.name, e.value] as const))(
    'NumberingType.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (NumberingType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

// ─── IncorporationFlags ─────────────────────────────────────

describe('ACE IncorporationFlags coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(IF_PATH, 'IncorporationFlags');

  it('parses ACE source', () => {
    expect(existsSync(IF_PATH)).toBe(true);
    expect(aceEntries.length).toBe(6);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'IncorporationFlags.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (IncorporationFlags as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

// ─── MediaType ──────────────────────────────────────────────

describe('ACE MediaType coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(MT_PATH, 'MediaType');

  it('parses ACE source', () => {
    expect(existsSync(MT_PATH)).toBe(true);
    expect(aceEntries.length).toBe(13);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'MediaType.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (MediaType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});

// ─── SurfaceType ────────────────────────────────────────────

describe('ACE SurfaceType coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(ST_PATH, 'SurfaceType');

  it('parses ACE source', () => {
    expect(existsSync(ST_PATH)).toBe(true);
    expect(aceEntries.length).toBe(13);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'SurfaceType.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (SurfaceType as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );
});
