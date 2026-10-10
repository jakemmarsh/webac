/**
 * Textures1999 — translate the 1999 retail portal.dat texture classes (0x05,
 * 0x06, 0x08) into the end-of-retail byte formats SurfaceTexture.read,
 * Texture.read and Surface.read already parse, so TextureManager and every
 * other consumer stays untouched.
 *
 * Layouts measured from dat-sets/ac1999-retail/portal.dat (pre-ToD container,
 * all little-endian); every record of each class matches its layout to the
 * byte (1904 / 3069 / 1599 files):
 *
 *   0x05 SurfaceTexture — IS the image (EoL moved the pixels to 0x06):
 *     u32 id ; u32 format ; u32 width ; u32 height ;
 *     u8 pixels[width*height*bpp] ;
 *     if format == 2 (INDEX8): u32 defaultPaletteId (a 0x04 Palette)
 *   Formats present (pre-ToD SurfacePixelFormat 1–11; release counts):
 *     2 INDEX8     1 B/px + palette   1734  -> PFID_P8 (41), same bytes + palette id
 *     4 ARGB4444   2 B/px              50   -> PFID_A4R4G4B4 (26), same bytes
 *     7 RGB565     2 B/px              86   -> PFID_R5G6B5 (23), same bytes
 *    10 COLOR_SEP  3 B/px, PLANAR       26   -> PFID_R8G8B8 (20): the R plane, G
 *                  plane and B plane are interleaved into D3D B,G,R triples
 *    11 ALPHA_ONLY 1 B/px               8    -> PFID_A8 (28), same bytes
 *   Formats 1, 3, 5, 6, 8, 9 are unexercised by any 1999 file and throw.
 *
 *   0x06 Texture (icons, UI art, splash screens) — no format word:
 *     u32 id ; u32 width ; u32 height ; u8 rgb[width*height*3]  (R,G,B order)
 *   -> PFID_R8G8B8 (20), re-ordered to D3D's B,G,R bytes. No alpha channel:
 *   1999 icons carry an opaque black background.
 *
 *   0x08 Surface — EoL's layout with a leading id:
 *     u32 id ; u32 type ;
 *     if type & (Base1Image|Base1ClipMap): u32 textureId (a 0x05) ; u32 paletteId (0x04 or 0)
 *     else: u32 colorValue
 *     f32 translucency ; f32 luminosity ; f32 diffuse
 *   -> the same minus the id. Texture ids keep pointing at the 0x05, which
 *   the overlay serves transcoded.
 *
 * The EoL chain is Surface -> 0x05 SurfaceTexture (a list of 0x06 ids) ->
 * 0x06 Texture. A 1999 0x05 becomes a one-level SurfaceTexture naming a
 * synthetic Texture id 0x07xxxxxx (same low 24 bits); neither DAT uses
 * class 0x07, and EoL already counts 0x06–0x07 as Texture. The overlay
 * serves that id from synthesizeTexture1999.
 *
 * The EoL Texture header's int32 after the id (ACE `Unknown`, 1–10 in the
 * EoL DAT) and the SurfaceTexture's int32 + byte (always 0 and 2 in EoL)
 * have no 1999 source and are read by nothing; they are written as 0 / 0 / 2.
 */
import { DatWriter } from './DatWriter.js';
import { SurfacePixelFormat } from '../file-types/Texture.js';

export const SYNTHETIC_TEXTURE_PREFIX = 0x07;

/** The synthetic EoL Texture id a 1999 SurfaceTexture (0x05) is served as. */
export function syntheticTextureId(surfaceTextureId: number): number {
  return ((SYNTHETIC_TEXTURE_PREFIX << 24) | (surfaceTextureId & 0xffffff)) >>> 0;
}

/** The pre-ToD SurfacePixelFormat values the 1999 DAT uses. */
export enum PreTodPixelFormat {
  INDEX8 = 2,
  ARGB4444 = 4,
  RGB565 = 7,
  COLOR_SEP = 10,
  ALPHA_ONLY = 11,
}

const hex = (v: number): string => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;

interface Image1999 {
  id: number;
  format: number;
  width: number;
  height: number;
  pixels: Uint8Array;
  paletteId: number | null;
}

/** Parse a 1999 0x05 record, checking it is consumed exactly. */
function read1999SurfaceTexture(raw: ArrayBuffer): Image1999 {
  const n = raw.byteLength;
  if (n < 16) throw new Error(`1999 SurfaceTexture: ${n} bytes, shorter than its 16-byte header`);
  const v = new DataView(raw);
  const id = v.getUint32(0, true);
  const format = v.getUint32(4, true);
  const width = v.getUint32(8, true);
  const height = v.getUint32(12, true);
  let bpp: number;
  switch (format) {
    case PreTodPixelFormat.INDEX8: case PreTodPixelFormat.ALPHA_ONLY: bpp = 1; break;
    case PreTodPixelFormat.ARGB4444: case PreTodPixelFormat.RGB565: bpp = 2; break;
    case PreTodPixelFormat.COLOR_SEP: bpp = 3; break;
    default:
      throw new Error(`1999 SurfaceTexture ${hex(id)}: pixel format ${format} is not used by any 1999 file (no measured layout)`);
  }
  const pixelBytes = width * height * bpp;
  const trailer = format === PreTodPixelFormat.INDEX8 ? 4 : 0;
  if (16 + pixelBytes + trailer !== n) {
    throw new Error(`1999 SurfaceTexture ${hex(id)}: format ${format} ${width}x${height} needs ${16 + pixelBytes + trailer} bytes, record has ${n}`);
  }
  const pixels = new Uint8Array(raw, 16, pixelBytes);
  const paletteId = trailer ? v.getUint32(16 + pixelBytes, true) : null;
  return { id, format, width, height, pixels, paletteId };
}

/** Write an EoL Texture (RenderSurface) record. */
function writeTexture(id: number, width: number, height: number, format: SurfacePixelFormat, data: Uint8Array, paletteId: number | null): ArrayBuffer {
  const w = new DatWriter();
  w.writeUInt32(id).writeInt32(0).writeInt32(width).writeInt32(height).writeUInt32(format).writeInt32(data.length).writeBytes(data);
  if (format === SurfacePixelFormat.PFID_P8 || format === SurfacePixelFormat.PFID_INDEX16) w.writeUInt32(paletteId ?? 0);
  return w.toArrayBuffer();
}

/** 1999 0x05 SurfaceTexture -> EoL SurfaceTexture naming the one synthetic Texture. */
export function transcodeSurfaceTexture1999(raw: ArrayBuffer, id: number): ArrayBuffer {
  const img = read1999SurfaceTexture(raw);
  if (img.id !== id >>> 0) throw new Error(`1999 SurfaceTexture ${hex(id)}: record carries id ${hex(img.id)}`);
  return new DatWriter()
    .writeUInt32(id)
    .writeInt32(0)
    .writeUInt8(2)
    .writeInt32(1)
    .writeUInt32(syntheticTextureId(id))
    .toArrayBuffer();
}

/**
 * The EoL Texture for a synthetic 0x07 id: the 1999 0x05 image of the same
 * low 24 bits, re-encoded. Null when the id is not synthetic or the 0x05 is absent.
 */
export function synthesizeTexture1999(syntheticId: number, getRaw: (id: number) => ArrayBuffer | null): ArrayBuffer | null {
  if (syntheticId >>> 24 !== SYNTHETIC_TEXTURE_PREFIX) return null;
  const sourceId = (0x05000000 | (syntheticId & 0xffffff)) >>> 0;
  const raw = getRaw(sourceId);
  if (!raw) return null;
  const img = read1999SurfaceTexture(raw);
  const outId = syntheticId >>> 0;
  switch (img.format) {
    case PreTodPixelFormat.INDEX8:
      return writeTexture(outId, img.width, img.height, SurfacePixelFormat.PFID_P8, img.pixels, img.paletteId);
    case PreTodPixelFormat.ARGB4444:
      return writeTexture(outId, img.width, img.height, SurfacePixelFormat.PFID_A4R4G4B4, img.pixels, null);
    case PreTodPixelFormat.RGB565:
      return writeTexture(outId, img.width, img.height, SurfacePixelFormat.PFID_R5G6B5, img.pixels, null);
    case PreTodPixelFormat.ALPHA_ONLY:
      return writeTexture(outId, img.width, img.height, SurfacePixelFormat.PFID_A8, img.pixels, null);
    case PreTodPixelFormat.COLOR_SEP: {
      const count = img.width * img.height;
      const src = img.pixels;
      const bgr = new Uint8Array(count * 3);
      for (let i = 0; i < count; i++) {
        bgr[i * 3] = src[2 * count + i]; // B plane
        bgr[i * 3 + 1] = src[count + i]; // G plane
        bgr[i * 3 + 2] = src[i]; // R plane
      }
      return writeTexture(outId, img.width, img.height, SurfacePixelFormat.PFID_R8G8B8, bgr, null);
    }
    default:
      throw new Error(`1999 SurfaceTexture ${hex(img.id)}: unhandled format ${img.format}`);
  }
}

/** 1999 0x06 Texture (id, w, h, R,G,B pixels) -> EoL PFID_R8G8B8 Texture. */
export function transcodeTexture1999(raw: ArrayBuffer): ArrayBuffer {
  const n = raw.byteLength;
  if (n < 12) throw new Error(`1999 Texture: ${n} bytes, shorter than its 12-byte header`);
  const v = new DataView(raw);
  const id = v.getUint32(0, true);
  const width = v.getUint32(4, true);
  const height = v.getUint32(8, true);
  const count = width * height;
  if (12 + count * 3 !== n) {
    throw new Error(`1999 Texture ${hex(id)}: ${width}x${height} RGB needs ${12 + count * 3} bytes, record has ${n}`);
  }
  const src = new Uint8Array(raw, 12, count * 3);
  const bgr = new Uint8Array(count * 3);
  for (let i = 0; i < count * 3; i += 3) {
    bgr[i] = src[i + 2];
    bgr[i + 1] = src[i + 1];
    bgr[i + 2] = src[i];
  }
  return writeTexture(id, width, height, SurfacePixelFormat.PFID_R8G8B8, bgr, null);
}

/** 1999 0x08 Surface -> EoL Surface (drops the leading id). */
export function transcodeSurface1999(raw: ArrayBuffer): ArrayBuffer {
  const n = raw.byteLength;
  if (n < 8) throw new Error(`1999 Surface: ${n} bytes, shorter than id + type`);
  const v = new DataView(raw);
  const id = v.getUint32(0, true);
  const type = v.getUint32(4, true);
  const hasImage = (type & 0x6) !== 0; // Base1Image | Base1ClipMap
  const expected = 8 + (hasImage ? 8 : 4) + 12;
  if (n !== expected) {
    throw new Error(`1999 Surface ${hex(id)}: type ${hex(type)} needs ${expected} bytes, record has ${n}`);
  }
  return raw.slice(4);
}
