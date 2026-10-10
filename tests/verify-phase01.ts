/**
 * Phase 1 Verification: Project Scaffolding + DatReader
 * Tests that the monorepo structure exists, packages resolve, and DatReader works correctly.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');

describe('Phase 1: Project Scaffolding', () => {
  it('root package.json exists with workspaces', async () => {
    const pkg = await import(resolve(ROOT, 'package.json'));
    expect(pkg.workspaces ?? pkg.default?.workspaces).toBeDefined();
  });

  it('tsconfig.json exists at root', () => {
    expect(existsSync(resolve(ROOT, 'tsconfig.json'))).toBe(true);
  });

  it('vitest.config exists', () => {
    const hasTs = existsSync(resolve(ROOT, 'vitest.config.ts'));
    const hasJs = existsSync(resolve(ROOT, 'vitest.config.js'));
    const hasMts = existsSync(resolve(ROOT, 'vitest.config.mts'));
    expect(hasTs || hasJs || hasMts).toBe(true);
  });

  it('package directories exist', () => {
    const dirs = [
      'packages/shared',
      'packages/dat-parser',
      'packages/renderer',
      'packages/network',
    ];
    for (const dir of dirs) {
      expect(existsSync(resolve(ROOT, dir))).toBe(true);
    }
  });

  it('each package has its own package.json', () => {
    const pkgs = ['shared', 'dat-parser', 'renderer', 'network'];
    for (const pkg of pkgs) {
      expect(existsSync(resolve(ROOT, `packages/${pkg}/package.json`))).toBe(true);
    }
  });
});

describe('Phase 1: DatReader', () => {
  let DatReader: any;

  it('DatReader module can be imported', async () => {
    const mod = await import('../packages/dat-parser/src/DatReader');
    DatReader = mod.DatReader;
    expect(DatReader).toBeDefined();
  });

  it('reads uint8', () => {
    const buf = new ArrayBuffer(1);
    new DataView(buf).setUint8(0, 0xAB);
    const r = new DatReader(buf);
    expect(r.readUInt8()).toBe(0xAB);
  });

  it('reads uint16 little-endian', () => {
    const buf = new ArrayBuffer(2);
    new DataView(buf).setUint16(0, 0x1234, true);
    const r = new DatReader(buf);
    expect(r.readUInt16()).toBe(0x1234);
  });

  it('reads uint32 little-endian', () => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, 0xDEADBEEF, true);
    const r = new DatReader(buf);
    expect(r.readUInt32()).toBe(0xDEADBEEF);
  });

  it('reads int8', () => {
    const buf = new ArrayBuffer(1);
    new DataView(buf).setInt8(0, -42);
    const r = new DatReader(buf);
    expect(r.readInt8()).toBe(-42);
  });

  it('reads int16 little-endian', () => {
    const buf = new ArrayBuffer(2);
    new DataView(buf).setInt16(0, -1000, true);
    const r = new DatReader(buf);
    expect(r.readInt16()).toBe(-1000);
  });

  it('reads int32 little-endian', () => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setInt32(0, -100000, true);
    const r = new DatReader(buf);
    expect(r.readInt32()).toBe(-100000);
  });

  it('reads float32', () => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, 3.14, true);
    const r = new DatReader(buf);
    expect(r.readFloat32()).toBeCloseTo(3.14, 2);
  });

  it('reads float64', () => {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, 2.718281828, true);
    const r = new DatReader(buf);
    expect(r.readFloat64()).toBeCloseTo(2.718281828, 6);
  });

  it('readBytes returns correct slice', () => {
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    for (let i = 0; i < 8; i++) view.setUint8(i, i * 10);
    const r = new DatReader(buf);
    r.readUInt16(); // skip 2 bytes
    const bytes = r.readBytes(4);
    expect(bytes.length).toBe(4);
    expect(bytes[0]).toBe(20);
    expect(bytes[1]).toBe(30);
    expect(bytes[2]).toBe(40);
    expect(bytes[3]).toBe(50);
  });

  it('readCompressedUInt32 — 1-byte form (0-127)', () => {
    const buf = new ArrayBuffer(1);
    new DataView(buf).setUint8(0, 42);
    const r = new DatReader(buf);
    expect(r.readCompressedUInt32()).toBe(42);
  });

  it('readCompressedUInt32 — 2-byte form (128-16383)', () => {
    // Value 300 = 0x012C → encoded as: first byte = 0x80 | (300 >> 8) = 0x81, second = 0x2C
    const buf = new ArrayBuffer(2);
    const view = new DataView(buf);
    view.setUint8(0, 0x81);
    view.setUint8(1, 0x2C);
    const r = new DatReader(buf);
    expect(r.readCompressedUInt32()).toBe(300);
  });

  it('readCompressedUInt32 — 4-byte form (large values)', () => {
    // Value 0x00050001 = 327681
    // Encoded: byte0 = 0xC0 | (0x0005 >> 8) = 0xC0, byte1 = 0x05, uint16 = 0x0001
    const buf = new ArrayBuffer(4);
    const view = new DataView(buf);
    view.setUint8(0, 0xC0);
    view.setUint8(1, 0x05);
    view.setUint16(2, 0x0001, true);
    const r = new DatReader(buf);
    expect(r.readCompressedUInt32()).toBe(0x00050001);
  });

  it('readPString reads without auto-alignment', () => {
    // String "Hi" with 2-byte length prefix: [0x02, 0x00, 0x48, 0x69]
    // readPString does NOT auto-align (callers must call align(4) explicitly)
    const buf = new ArrayBuffer(8);
    const view = new DataView(buf);
    view.setUint16(0, 2, true); // length = 2
    view.setUint8(2, 0x48); // 'H'
    view.setUint8(3, 0x69); // 'i'
    const r = new DatReader(buf);
    const str = r.readPString();
    expect(str).toBe('Hi');
    expect(r.position).toBe(4); // 2 (length) + 2 (string) = 4, happens to be aligned
  });

  it('readPString with odd-length string does not auto-align', () => {
    // String "Hey" length=3: [0x03, 0x00, 'H', 'e', 'y'] → position 5, NOT aligned
    // Callers that need alignment call r.align(4) explicitly
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    view.setUint16(0, 3, true);
    view.setUint8(2, 0x48); // H
    view.setUint8(3, 0x65); // e
    view.setUint8(4, 0x79); // y
    const r = new DatReader(buf);
    const str = r.readPString();
    expect(str).toBe('Hey');
    expect(r.position).toBe(5); // 2 + 3 = 5, no auto-alignment
    r.align(4); // explicit alignment by caller
    expect(r.position).toBe(8); // now aligned
  });

  it('position getter tracks read position', () => {
    const buf = new ArrayBuffer(16);
    const r = new DatReader(buf);
    expect(r.position).toBe(0);
    r.readUInt8();
    expect(r.position).toBe(1);
    r.readUInt32();
    expect(r.position).toBe(5);
  });

  it('remaining getter returns bytes left', () => {
    const buf = new ArrayBuffer(10);
    const r = new DatReader(buf);
    expect(r.remaining).toBe(10);
    r.readUInt32();
    expect(r.remaining).toBe(6);
  });

  it('seek moves to absolute position', () => {
    const buf = new ArrayBuffer(16);
    new DataView(buf).setUint8(10, 0x42);
    const r = new DatReader(buf);
    r.seek(10);
    expect(r.readUInt8()).toBe(0x42);
  });

  it('skip advances by relative amount', () => {
    const buf = new ArrayBuffer(16);
    new DataView(buf).setUint8(5, 0x77);
    const r = new DatReader(buf);
    r.skip(5);
    expect(r.readUInt8()).toBe(0x77);
  });

  it('align rounds up to boundary', () => {
    const buf = new ArrayBuffer(16);
    const r = new DatReader(buf);
    r.skip(3);
    r.align(4);
    expect(r.position).toBe(4);

    r.seek(4);
    r.align(4);
    expect(r.position).toBe(4); // already aligned, no change

    r.seek(5);
    r.align(4);
    expect(r.position).toBe(8);
  });

  it('slice returns sub-buffer and advances position', () => {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    view.setUint32(4, 0xCAFEBABE, true);
    const r = new DatReader(buf);
    r.skip(4);
    const sliced = r.slice(4);
    expect(sliced.byteLength).toBe(4);
    expect(new DataView(sliced).getUint32(0, true)).toBe(0xCAFEBABE);
    expect(r.position).toBe(8);
  });

  it('readList reads array of items', () => {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    view.setUint32(0, 2, true); // count = 2
    view.setUint32(4, 100, true);
    view.setUint32(8, 200, true);
    const r = new DatReader(buf);
    const list = r.readList(() => r.readUInt32());
    expect(list).toEqual([100, 200]);
  });
});

describe('Phase 1: Shared Types', () => {
  it('shared types module exports Position, Vector3, Quaternion', async () => {
    // Just verify the module can be imported — types are compile-time only,
    // but the module should exist and not throw
    const mod = await import('../packages/shared/src/types');
    expect(mod).toBeDefined();
  });

  it('weenie-types module exports property enums', async () => {
    const mod = await import('../packages/shared/src/weenie-types');
    expect(mod).toBeDefined();
    // Should have PropertyInt, PropertyString, etc.
    expect(mod.PropertyInt).toBeDefined();
  });
});
