/**
 * FAITHFUL.170 — readString16 + 5 inline TextDecoder('ascii') sites were
 * using the wrong encoding (UTF-8 / ASCII) for ACE WriteString16L output.
 *
 * Per `reference/ACE/Source/ACE.Server/Network/Extensions.cs:12-21`:
 *
 *   public static void WriteString16L(this BinaryWriter writer, string data)
 *   {
 *       if (data == null) data = "";
 *       writer.Write((ushort)data.Length);
 *       writer.Write(System.Text.Encoding.GetEncoding(1252).GetBytes(data));
 *       writer.Pad(CalculatePadMultiple(sizeof(ushort) + (uint)data.Length, 4u));
 *   }
 *
 * Pre-FAITHFUL.170 we used `TextDecoder('utf-8')` in BinaryReader.readString16
 * and 5 inline `TextDecoder('ascii')` calls in MessageSerializer.ts parsers.
 * ASCII chars (0x00-0x7F) decode the same in all three encodings, but bytes
 * 0x80-0xFF (accented characters in player names, smart quotes, em-dashes,
 * special symbols in NPC dialog text) silently mojibake'd or triggered
 * UTF-8 multi-byte decode errors.
 *
 * Windows-1252 is a strict superset of ASCII, so all English-only test data
 * continues to decode identically. Only the 0x80-0xFF range changes — for
 * the better.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BinaryReader, BinaryWriter, encodeWindows1252, parseFellowshipUpdateFellow } from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACE_EXT = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Extensions.cs');

describe.skipIf(!aceReferenceExists(ACE_EXT))('ACE source pinning', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_EXT, 'utf8');
  });

  it('WriteString16L uses GetEncoding(1252) — Windows-1252, not UTF-8', () => {
    expect(src).toMatch(/Encoding\.GetEncoding\(1252\)\.GetBytes\(data\)/);
  });

  it('WriteString16L pads to a 4-byte boundary INCLUDING the 2-byte length prefix', () => {
    expect(src).toMatch(/writer\.Pad\(CalculatePadMultiple\(sizeof\(ushort\)\s*\+\s*\(uint\)data\.Length,\s*4u\)\)/);
  });
});

describe('encodeWindows1252 helper round-trips through readString16', () => {
  it('ASCII-only text round-trips byte-for-byte', () => {
    const w = new BinaryWriter(32);
    w.writeString16('Hello, world!');
    const r = new BinaryReader(w.toBuffer());
    expect(r.readString16()).toBe('Hello, world!');
  });

  it('Player names with German umlauts (Müller) round-trip correctly', () => {
    const w = new BinaryWriter(32);
    w.writeString16('Müller');
    const buf = w.toBuffer();
    // Pre-FAITHFUL.170 the UTF-8 encode would write 0xC3 0xBC for ü (2 bytes),
    // then UTF-8 decode would decode it back to ü — only round-tripping
    // because both sides were wrong consistently. Now we encode 0xFC (one byte
    // Windows-1252) and decode 0xFC back to ü.
    const dv = new DataView(buf.buffer);
    const len = dv.getUint16(0, true);
    expect(len).toBe(6);          // "Müller" = 6 Windows-1252 bytes
    expect(buf[2]).toBe(0x4D);    // M
    expect(buf[3]).toBe(0xFC);    // ü in Windows-1252 = 0xFC (one byte, NOT C3 BC)
    expect(buf[4]).toBe(0x6C);    // l

    const r = new BinaryReader(buf);
    expect(r.readString16()).toBe('Müller');
  });

  it('Scandinavian characters (Sørensen, Bjørn) round-trip', () => {
    for (const name of ['Sørensen', 'Bjørn', 'Hägglund']) {
      const w = new BinaryWriter(32);
      w.writeString16(name);
      const r = new BinaryReader(w.toBuffer());
      expect(r.readString16()).toBe(name);
    }
  });

  it('Windows-1252 punctuation (smart quotes, em-dash) round-trips', () => {
    const w = new BinaryWriter(64);
    // Punctuation in NPC dialog: "Hello," he said — and walked away.
    w.writeString16('“Hello,” he said — and walked away.');
    const r = new BinaryReader(w.toBuffer());
    expect(r.readString16()).toBe('“Hello,” he said — and walked away.');
  });

  it('Unmappable codepoints (e.g. ✓ U+2713) become "?" (0x3F) like ACE GetEncoding fallback', () => {
    const bytes = encodeWindows1252('A✓B');
    expect(bytes).toEqual(new Uint8Array([0x41, 0x3F, 0x42]));
  });

  it('Boundary characters at U+00A0 (nbsp) through U+00FF (ÿ) round-trip', () => {
    // The Latin-1 supplement range (0xA0-0xFF) maps 1:1 in Windows-1252.
    let s = '';
    for (let cp = 0xA0; cp <= 0xFF; cp++) s += String.fromCharCode(cp);
    const w = new BinaryWriter(256);
    w.writeString16(s);
    const r = new BinaryReader(w.toBuffer());
    expect(r.readString16()).toBe(s);
  });
});

describe('ACE-faithful byte-level encoding', () => {
  it('encodeWindows1252 produces the exact ACE GetEncoding(1252).GetBytes output for common chars', () => {
    // Validation against known Windows-1252 byte values (publicly documented).
    expect(encodeWindows1252('A')).toEqual(new Uint8Array([0x41]));
    expect(encodeWindows1252('a')).toEqual(new Uint8Array([0x61]));
    expect(encodeWindows1252('ü')).toEqual(new Uint8Array([0xFC]));
    expect(encodeWindows1252('é')).toEqual(new Uint8Array([0xE9]));
    expect(encodeWindows1252('ñ')).toEqual(new Uint8Array([0xF1]));
    expect(encodeWindows1252('€')).toEqual(new Uint8Array([0x80]));
    expect(encodeWindows1252('—')).toEqual(new Uint8Array([0x97])); // em-dash
    expect(encodeWindows1252('“')).toEqual(new Uint8Array([0x93])); // left double quote
    expect(encodeWindows1252('”')).toEqual(new Uint8Array([0x94])); // right double quote
  });
});

// Raw Windows-1252 bytes whose code points DIFFER from Latin-1/UTF-8 decoding:
// 0x80 €, 0x93 “, 0x94 ”, 0x97 —, 0x9A š, plus 0xFC ü and 0xF8 ø.
const CP1252_BYTES = [0x80, 0x93, 0x94, 0x97, 0x9A, 0xFC, 0xF8];
const CP1252_TEXT = '€“”—šüø';

function string16(bytes: number[]): number[] {
  const out = [bytes.length & 0xff, bytes.length >> 8, ...bytes];
  while (out.length % 4 !== 0) out.push(0);
  return out;
}

describe('Integration (FAITHFUL.170, behavioural)', () => {
  it('BinaryReader.readString16 decodes raw Windows-1252 bytes (0x80-0x9F included), not UTF-8/Latin-1', () => {
    const r = new BinaryReader(new Uint8Array(string16(CP1252_BYTES)));
    expect(r.readString16()).toBe(CP1252_TEXT);
    expect(r.position % 4).toBe(0);
  });

  it('BinaryWriter.writeString16 emits the exact Windows-1252 bytes (encodeWindows1252)', () => {
    const w = new BinaryWriter(32);
    w.writeString16(CP1252_TEXT);
    expect([...w.toBuffer()]).toEqual(string16(CP1252_BYTES));
  });

  it('the internal String16L reader (fellowship / allegiance / friends parsers) decodes Windows-1252 too', () => {
    const head = new Uint8Array(44);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 0x50000001, true); // guid
    dv.setUint32(12, 42, true);        // level
    const payload = new Uint8Array([...head, ...string16(CP1252_BYTES), 3, 0, 0, 0]); // + updateType u32
    const parsed = parseFellowshipUpdateFellow(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.fellow.name).toBe(CP1252_TEXT);
    expect(parsed!.fellow.level).toBe(42);
    expect(parsed!.updateType).toBe(3);
  });

  it('encodeWindows1252 is exported from @ac/network', () => {
    expect(typeof encodeWindows1252).toBe('function');
  });
});
