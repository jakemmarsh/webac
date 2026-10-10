/**
 * BUG.r5g6b5-texture-decode-clamped-below-255 — PFID_R5G6B5 texture decode
 * never reached 255.
 *
 * Texture.toRGBA()'s PFID_R5G6B5 case expanded each 5/6-bit channel with a
 * bare left shift (v << 3 / v << 2), which maps the max channel value onto
 * 248 (5-bit) / 252 (6-bit) — never 255. A fully saturated white pixel
 * (0xFFFF) decoded to (248, 252, 248) instead of (255, 255, 255): visibly
 * dark and green-tinted. This reproduced the exact bug ACEmulator/ACE PR
 * #4480 (commit acbced8b, "Fix 16-bit texture decode: A4R4G4B4 and R5G6B5")
 * fixed upstream in Texture.cs get565RGB().
 *
 * The fix replicates the high bits into the low bits — (v5 << 3) | (v5 >> 2)
 * for the 5-bit channels, (v6 << 2) | (v6 >> 4) for the 6-bit green channel —
 * so the value range 0..31 / 0..63 maps onto the full 0..255 byte range.
 *
 * The sibling PFID_A4R4G4B4 case already used the correct `nibble * 17`
 * expansion (matching ACE's fix for that format) both before and after this
 * change — covered here as a control to confirm it was never broken.
 *
 * This test drives the real `Texture.toRGBA()` from `@ac/dat-parser` against
 * hand-built RGB565 source bytes — no DAT file required.
 */
import { describe, it, expect } from 'vitest';
import { Texture, SurfacePixelFormat } from '../packages/dat-parser/src/file-types/Texture';

function makeR5G6B5Texture(pixels: number[]): Texture {
  const tex = new Texture();
  tex.width = pixels.length;
  tex.height = 1;
  tex.format = SurfacePixelFormat.PFID_R5G6B5;
  tex.length = pixels.length * 2;
  const bytes = new Uint8Array(tex.length);
  const view = new DataView(bytes.buffer);
  pixels.forEach((val, i) => view.setUint16(i * 2, val, true));
  tex.sourceData = bytes;
  return tex;
}

function makeA4R4G4B4Texture(pixels: number[]): Texture {
  const tex = new Texture();
  tex.width = pixels.length;
  tex.height = 1;
  tex.format = SurfacePixelFormat.PFID_A4R4G4B4;
  tex.length = pixels.length * 2;
  const bytes = new Uint8Array(tex.length);
  const view = new DataView(bytes.buffer);
  pixels.forEach((val, i) => view.setUint16(i * 2, val, true));
  tex.sourceData = bytes;
  return tex;
}

describe('Texture.toRGBA() PFID_R5G6B5 — bit-replication reaches full 0..255 range', () => {
  it('decodes fully saturated white (0xFFFF) to RGB (255, 255, 255), not (248, 252, 248)', () => {
    const tex = makeR5G6B5Texture([0xffff]);
    const { data } = tex.toRGBA();
    expect(data[0]).toBe(255); // R
    expect(data[1]).toBe(255); // G
    expect(data[2]).toBe(255); // B
    expect(data[3]).toBe(255); // A (R5G6B5 has no alpha channel — always opaque)
  });

  it('decodes fully unsaturated black (0x0000) to RGB (0, 0, 0)', () => {
    const tex = makeR5G6B5Texture([0x0000]);
    const { data } = tex.toRGBA();
    expect(data[0]).toBe(0);
    expect(data[1]).toBe(0);
    expect(data[2]).toBe(0);
  });

  it('decodes a partial-saturation pixel via bit replication, matching the upstream fix example', () => {
    // r5=27 (11011), g6=6 (000110), b5=31 (11111) -> R5G6B5 encoding
    const r5 = 27, g6 = 6, b5 = 31;
    const val = (r5 << 11) | (g6 << 5) | b5;
    const tex = makeR5G6B5Texture([val]);
    const { data } = tex.toRGBA();
    // Bit replication: (v << shift) | (v >> (bits - shift))
    expect(data[0]).toBe((r5 << 3) | (r5 >> 2));
    expect(data[1]).toBe((g6 << 2) | (g6 >> 4));
    expect(data[2]).toBe((b5 << 3) | (b5 >> 2));
    // Confirm this no longer matches the old buggy bare-shift formula for a
    // value where the two approaches actually disagree.
    expect(data[0]).not.toBe((r5 << 3) & 0xff);
  });

  it('every max-channel value in a multi-pixel texture reaches 255, not the old 248/252 ceiling', () => {
    // 4 pixels: pure red, pure green, pure blue, white — all fully saturated.
    const pureRed = 0b11111_000000_00000;
    const pureGreen = 0b00000_111111_00000;
    const pureBlue = 0b00000_000000_11111;
    const white = 0xffff;
    const tex = makeR5G6B5Texture([pureRed, pureGreen, pureBlue, white]);
    const { data } = tex.toRGBA();
    expect(data[0]).toBe(255); // pixel 0 R
    expect(data[5]).toBe(255); // pixel 1 G
    expect(data[10]).toBe(255); // pixel 2 B
    expect([data[12], data[13], data[14]]).toEqual([255, 255, 255]); // pixel 3 white
  });
});

describe('Texture.toRGBA() PFID_A4R4G4B4 — control: nibble*17 expansion already correct', () => {
  it('decodes fully saturated ARGB (0xFFFF) to (255, 255, 255, 255)', () => {
    const tex = makeA4R4G4B4Texture([0xffff]);
    const { data } = tex.toRGBA();
    expect(data[0]).toBe(255); // R
    expect(data[1]).toBe(255); // G
    expect(data[2]).toBe(255); // B
    expect(data[3]).toBe(255); // A
  });

  it('decodes a mid-range nibble (0xF) exactly via *17, not integer-division-to-zero', () => {
    // A=0xF, R=0x8, G=0x4, B=0x1
    const val = (0xf << 12) | (0x8 << 8) | (0x4 << 4) | 0x1;
    const tex = makeA4R4G4B4Texture([val]);
    const { data } = tex.toRGBA();
    expect(data[0]).toBe(0x8 * 17); // R = 136
    expect(data[1]).toBe(0x4 * 17); // G = 68
    expect(data[2]).toBe(0x1 * 17); // B = 17
    expect(data[3]).toBe(0xf * 17); // A = 255
  });
});
