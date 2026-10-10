/**
 * FAITHFUL.171 — DatReader string methods used wrong encoding.
 *
 * ACE DAT-file string handling (BinaryReaderExtensions.cs):
 *   - ReadPString:           Encoding.Default.GetString → Windows-1252
 *   - ReadObfuscatedString:  Encoding.GetEncoding(1252).GetString → Windows-1252 (explicit)
 *   - ReadString (.NET BinaryReader.ReadString): Encoding.Default → Windows-1252
 *
 * Our DatReader.readString / readPString / readObfuscatedString used
 * TextDecoder('ascii'). DAT-file strings (NPC names from StringTable, item
 * names, font glyphs, dialog text) had the same 0x80-0xFF mojibake risk as
 * the network parsers fixed in FAITHFUL.170.
 *
 * This commit moves the Windows-1252 helpers from `@ac/network` to
 * `@ac/shared` so both the network stack (MessageSerializer) and the
 * DAT-parser stack (DatReader) can share a single implementation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatReader } from '@ac/dat-parser';
import { encodeWindows1252, decodeWindows1252 } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const ACE_EXT = resolve(REPO, 'reference/ACE/Source/ACE.DatLoader/BinaryReaderExtensions.cs');

describe.skipIf(!aceReferenceExists(ACE_EXT))('ACE DatLoader source pinning', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_EXT, 'utf8');
  });

  it('ReadPString uses Encoding.Default.GetString (Windows-1252 on Western Windows)', () => {
    expect(src).toMatch(/public static string ReadPString[\s\S]+?Encoding\.Default\.GetString/);
  });

  it('ReadObfuscatedString uses Encoding.GetEncoding(1252).GetString', () => {
    expect(src).toMatch(/public static string ReadObfuscatedString[\s\S]+?Encoding\.GetEncoding\(1252\)\.GetString/);
  });
});

describe('DatReader Windows-1252 round-trips', () => {
  function buildPStringBuffer(s: string): ArrayBuffer {
    const bytes = encodeWindows1252(s);
    const buf = new ArrayBuffer(2 + bytes.length);
    const dv = new DataView(buf);
    dv.setUint16(0, bytes.length, true);
    new Uint8Array(buf, 2).set(bytes);
    return buf;
  }

  it('readPString decodes German umlauts correctly', () => {
    const buf = buildPStringBuffer('Aerlinthe');
    const r = new DatReader(buf);
    expect(r.readPString()).toBe('Aerlinthe');
  });

  it('readPString decodes Müller (one-byte ü = 0xFC, not UTF-8 multi-byte)', () => {
    const buf = buildPStringBuffer('Müller');
    const r = new DatReader(buf);
    const result = r.readPString();
    expect(result).toBe('Müller');
    // Sanity: the buffer must have used exactly 6 bytes (NOT 7 which would be UTF-8).
    expect(new DataView(buf).getUint16(0, true)).toBe(6);
  });

  it('readPString decodes Windows-1252 smart quotes', () => {
    const buf = buildPStringBuffer('“Hi”');
    const r = new DatReader(buf);
    expect(r.readPString()).toBe('“Hi”');
  });

  it('readObfuscatedString round-trips through nibble swap + Windows-1252 decode', () => {
    // Build the obfuscated buffer: u16 length + nibble-swapped Windows-1252 bytes.
    const bytes = encodeWindows1252('Aerlinthe');
    const swapped = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      swapped[i] = ((bytes[i] >> 4) | (bytes[i] << 4)) & 0xff;
    }
    const buf = new ArrayBuffer(2 + swapped.length);
    const dv = new DataView(buf);
    dv.setUint16(0, swapped.length, true);
    new Uint8Array(buf, 2).set(swapped);
    const r = new DatReader(buf);
    expect(r.readObfuscatedString()).toBe('Aerlinthe');
  });
});

describe('Helper colocation (FAITHFUL.171, behavioural)', () => {
  // DEBT.test-harness-hygiene: formerly regexes over DatReader.ts /
  // shared/index.ts; now executed against the real modules + the package
  // manifest (the dependency direction is a manifest fact, not source text).

  it('@ac/dat-parser depends on @ac/shared only (never @ac/network) for its decoder', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO, 'packages/dat-parser/package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toContain('@ac/shared');
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@ac/network');
  });

  it('@ac/shared exports encodeWindows1252 + decodeWindows1252', async () => {
    const shared = await import('@ac/shared');
    expect(shared.encodeWindows1252).toBe(encodeWindows1252);
    expect(shared.decodeWindows1252).toBe(decodeWindows1252);
    expect(typeof shared.decodeWindows1252).toBe('function');
  });

  // Every byte 0x80-0xFF, where Windows-1252 differs from ASCII / Latin-1
  // (0x80 → €, 0x93/0x94 → “ ”, 0xFC → ü). 0x81/0x8D/0x8F/0x90/0x9D are
  // undefined in 1252; the expected string is whatever the canonical
  // decodeWindows1252 maps them to, so every DatReader string path must agree
  // with it byte for byte.
  const HIGH = Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i);

  it('DatReader.readString (.NET 7-bit length) decodes Windows-1252, not UTF-8/ASCII', () => {
    // 128 = 0x80 0x01 as a 7-bit encoded int.
    const buf = new Uint8Array(2 + HIGH.length);
    buf.set([0x80, 0x01], 0);
    buf.set(HIGH, 2);
    const s = new DatReader(buf.buffer).readString();
    expect(s).toBe(decodeWindows1252(HIGH));
    expect(s.length).toBe(128);
    expect(s[0]).toBe('€');
    expect(s[0x93 - 0x80]).toBe('“');
    expect(s[0xfc - 0x80]).toBe('ü');
  });

  it('readPString (1- and 2-byte length) decodes the same high range identically', () => {
    const two = new Uint8Array(2 + HIGH.length);
    new DataView(two.buffer).setUint16(0, HIGH.length, true);
    two.set(HIGH, 2);
    expect(new DatReader(two.buffer).readPString()).toBe(decodeWindows1252(HIGH));
    const one = new Uint8Array(1 + 100);
    one[0] = 100;
    one.set(HIGH.subarray(0, 100), 1);
    expect(new DatReader(one.buffer).readPString(1)).toBe(decodeWindows1252(HIGH.subarray(0, 100)));
  });
});

describe('Cross-package helper identity', () => {
  it('decodeWindows1252 from @ac/shared equals what @ac/network re-exports', async () => {
    const network = await import('@ac/network');
    expect(network.decodeWindows1252).toBe(decodeWindows1252);
    expect(network.encodeWindows1252).toBe(encodeWindows1252);
  });
});
