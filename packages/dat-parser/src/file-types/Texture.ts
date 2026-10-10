import { DatReader } from '../DatReader.js';
import { DxtUtil } from './DxtUtil.js';

/**
 * SurfacePixelFormat IDs — from ACE SurfacePixelFormat.cs.
 * Only the actually-used formats are listed here.
 */
export enum SurfacePixelFormat {
  PFID_UNKNOWN = 0,
  PFID_R8G8B8 = 20,
  PFID_A8R8G8B8 = 21,
  PFID_X8R8G8B8 = 22,
  PFID_R5G6B5 = 23,
  PFID_X1R5G5B5 = 24,
  PFID_A1R5G5B5 = 25,
  PFID_A4R4G4B4 = 26,
  PFID_R3G3B2 = 27,
  PFID_A8 = 28,
  PFID_A8R3G3B2 = 29,
  PFID_X4R4G4B4 = 30,
  PFID_A8P8 = 40,
  PFID_P8 = 41,
  PFID_L8 = 50,
  PFID_A8L8 = 51,
  PFID_INDEX16 = 101,
  PFID_CUSTOM_R8G8B8A8 = 240,
  PFID_CUSTOM_A8B8G8R8 = 241,
  PFID_CUSTOM_B8G8R8 = 242,
  PFID_CUSTOM_LSCAPE_R8G8B8 = 243,
  PFID_CUSTOM_LSCAPE_ALPHA = 244,
  PFID_CUSTOM_RAW_JPEG = 500,
  PFID_DXT1 = 827611204,
  PFID_DXT3 = 861165636,
  PFID_DXT5 = 894720068,
}

/**
 * Texture — 0x06 portal.dat files (RenderSurface).
 * Contains pixel data in various formats, convertible to RGBA.
 */
export class Texture {
  id: number = 0;
  unknown: number = 0;
  width: number = 0;
  height: number = 0;
  format: SurfacePixelFormat = SurfacePixelFormat.PFID_UNKNOWN;
  length: number = 0;
  sourceData: Uint8Array = new Uint8Array(0);
  defaultPaletteId: number | null = null;

  static read(reader: DatReader): Texture {
    const tex = new Texture();
    tex.id = reader.readUInt32();
    tex.unknown = reader.readInt32();
    tex.width = reader.readInt32();
    tex.height = reader.readInt32();
    tex.format = reader.readUInt32() as SurfacePixelFormat;
    tex.length = reader.readInt32();
    tex.sourceData = reader.readBytes(tex.length);

    // Palette-indexed formats have a trailing palette ID
    if (tex.format === SurfacePixelFormat.PFID_INDEX16 || tex.format === SurfacePixelFormat.PFID_P8) {
      tex.defaultPaletteId = reader.readUInt32();
    }

    return tex;
  }

  /**
   * Convert texture to RGBA8888 pixel data.
   * Returns { width, height, data: Uint8Array } where data is RGBA, 4 bytes/pixel.
   * Palette-indexed formats return index values as greyscale without a palette reference.
   */
  toRGBA(): { width: number; height: number; data: Uint8Array } {
    const w = this.width;
    const h = this.height;
    const pixelCount = w * h;
    const data = new Uint8Array(pixelCount * 4);

    if (this.length === 0) {
      return { width: w, height: h, data };
    }

    switch (this.format) {
      case SurfacePixelFormat.PFID_DXT1: {
        const decompressed = DxtUtil.decompressDxt1(this.sourceData, w, h);
        data.set(decompressed);
        break;
      }

      case SurfacePixelFormat.PFID_DXT3: {
        const decompressed = DxtUtil.decompressDxt3(this.sourceData, w, h);
        data.set(decompressed);
        break;
      }

      case SurfacePixelFormat.PFID_DXT5: {
        const decompressed = DxtUtil.decompressDxt5(this.sourceData, w, h);
        data.set(decompressed);
        break;
      }

      case SurfacePixelFormat.PFID_A8R8G8B8: {
        // ARGB → RGBA
        const src = this.sourceData;
        for (let i = 0; i < pixelCount; i++) {
          const si = i * 4;
          const di = i * 4;
          data[di] = src[si + 2];     // R (from offset 2 in BGRA layout read as little-endian ARGB)
          data[di + 1] = src[si + 1]; // G
          data[di + 2] = src[si];     // B
          data[di + 3] = src[si + 3]; // A
        }
        break;
      }

      case SurfacePixelFormat.PFID_R8G8B8: {
        // BGR byte order → RGBA
        const src = this.sourceData;
        for (let i = 0; i < pixelCount; i++) {
          const si = i * 3;
          const di = i * 4;
          data[di] = src[si + 2];     // R
          data[di + 1] = src[si + 1]; // G
          data[di + 2] = src[si];     // B
          data[di + 3] = 255;         // A
        }
        break;
      }

      case SurfacePixelFormat.PFID_CUSTOM_LSCAPE_R8G8B8: {
        // RGB byte order → RGBA
        const src = this.sourceData;
        for (let i = 0; i < pixelCount; i++) {
          const si = i * 3;
          const di = i * 4;
          data[di] = src[si];         // R
          data[di + 1] = src[si + 1]; // G
          data[di + 2] = src[si + 2]; // B
          data[di + 3] = 255;         // A
        }
        break;
      }

      case SurfacePixelFormat.PFID_R5G6B5: {
        const view = new DataView(this.sourceData.buffer, this.sourceData.byteOffset, this.sourceData.byteLength);
        for (let i = 0; i < pixelCount; i++) {
          const val = view.getUint16(i * 2, true);
          const di = i * 4;
          // Convert 565 to 888 by bit replication, not a bare left-shift: a
          // plain v << 3 maps 0..31 onto 0,8,16..248 and can never reach 255,
          // so a fully saturated white decodes to (248,252,248) instead of
          // (255,255,255). Replicating the high bits into the low bits spans
          // the full 0..255 range (matches ACE Texture.cs get565RGB, fixed
          // upstream in commit acbced8b / PR #4480).
          const r5 = (val & 0xf800) >> 11;
          const g6 = (val & 0x07e0) >> 5;
          const b5 = val & 0x001f;
          data[di] = (r5 << 3) | (r5 >> 2);      // R
          data[di + 1] = (g6 << 2) | (g6 >> 4);  // G
          data[di + 2] = (b5 << 3) | (b5 >> 2);  // B
          data[di + 3] = 255;                     // A
        }
        break;
      }

      case SurfacePixelFormat.PFID_A4R4G4B4: {
        const view = new DataView(this.sourceData.buffer, this.sourceData.byteOffset, this.sourceData.byteLength);
        for (let i = 0; i < pixelCount; i++) {
          const val = view.getUint16(i * 2, true);
          const di = i * 4;
          data[di] = ((val >> 8) & 0xf) * 17;     // R (4bit→8bit: multiply by 17)
          data[di + 1] = ((val >> 4) & 0xf) * 17;  // G
          data[di + 2] = (val & 0xf) * 17;          // B
          data[di + 3] = ((val >> 12) & 0xf) * 17;  // A
        }
        break;
      }

      case SurfacePixelFormat.PFID_A8:
      case SurfacePixelFormat.PFID_CUSTOM_LSCAPE_ALPHA: {
        // Alpha-only format: each byte is an alpha value.
        // White RGB with variable alpha — used as alpha mask for font spritesheets,
        // terrain blending, etc. Color is applied externally (e.g. via composite ops).
        const src = this.sourceData;
        for (let i = 0; i < pixelCount; i++) {
          const di = i * 4;
          data[di] = 255;       // R = white
          data[di + 1] = 255;   // G = white
          data[di + 2] = 255;   // B = white
          data[di + 3] = src[i]; // A = alpha from byte
        }
        break;
      }

      case SurfacePixelFormat.PFID_P8: {
        // 8-bit palette-indexed — render as greyscale without palette
        const src = this.sourceData;
        for (let i = 0; i < pixelCount; i++) {
          const di = i * 4;
          data[di] = src[i];
          data[di + 1] = src[i];
          data[di + 2] = src[i];
          data[di + 3] = 255;
        }
        break;
      }

      case SurfacePixelFormat.PFID_INDEX16: {
        // 16-bit palette-indexed — render low byte as greyscale without palette
        const view = new DataView(this.sourceData.buffer, this.sourceData.byteOffset, this.sourceData.byteLength);
        for (let i = 0; i < pixelCount; i++) {
          const val = view.getUint16(i * 2, true) & 0xff;
          const di = i * 4;
          data[di] = val;
          data[di + 1] = val;
          data[di + 2] = val;
          data[di + 3] = 255;
        }
        break;
      }

      case SurfacePixelFormat.PFID_CUSTOM_R8G8B8A8: {
        // RGBA byte order — already in our target format
        data.set(this.sourceData.subarray(0, pixelCount * 4));
        break;
      }

      case SurfacePixelFormat.PFID_CUSTOM_A8B8G8R8: {
        // ABGR → RGBA
        const src = this.sourceData;
        for (let i = 0; i < pixelCount; i++) {
          const si = i * 4;
          const di = i * 4;
          data[di] = src[si + 3];     // R
          data[di + 1] = src[si + 2]; // G
          data[di + 2] = src[si + 1]; // B
          data[di + 3] = src[si];     // A
        }
        break;
      }

      case SurfacePixelFormat.PFID_CUSTOM_B8G8R8: {
        // BGR → RGBA
        const src = this.sourceData;
        for (let i = 0; i < pixelCount; i++) {
          const si = i * 3;
          const di = i * 4;
          data[di] = src[si + 2];     // R
          data[di + 1] = src[si + 1]; // G
          data[di + 2] = src[si];     // B
          data[di + 3] = 255;
        }
        break;
      }

      case SurfacePixelFormat.PFID_CUSTOM_RAW_JPEG: {
        // JPEG format — width/height are 0 in the header; actual dimensions
        // are in the JPEG data. Cannot decode synchronously; return empty.
        // Use toRGBAAsync() or getJPEGDataURL() instead.
        return { width: 0, height: 0, data: new Uint8Array(0) };
      }

      default:
        // Unknown format — leave as zeroes
        break;
    }

    return { width: w, height: h, data };
  }

  /** Whether this texture uses JPEG format (requires async decode or direct data URL). */
  get isJPEG(): boolean {
    return this.format === SurfacePixelFormat.PFID_CUSTOM_RAW_JPEG;
  }

  /**
   * Create a data:image/jpeg data URL from the raw JPEG source data.
   * Only valid for PFID_CUSTOM_RAW_JPEG textures.
   */
  getJPEGDataURL(): string | null {
    if (!this.isJPEG || this.sourceData.length === 0) return null;
    let binary = '';
    const bytes = this.sourceData;
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return `data:image/jpeg;base64,${btoa(binary)}`;
  }

  /**
   * Async RGBA decode for JPEG textures (browser only).
   * Uses createImageBitmap to decode the JPEG, then reads pixels from canvas.
   * For non-JPEG formats, falls back to synchronous toRGBA().
   */
  async toRGBAAsync(): Promise<{ width: number; height: number; data: Uint8Array }> {
    if (!this.isJPEG) return this.toRGBA();
    if (this.sourceData.length === 0) return { width: 0, height: 0, data: new Uint8Array(0) };

    const jpegBytes = this.sourceData.slice();
    const blob = new Blob([jpegBytes.buffer], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();

    return {
      width: bitmap.width,
      height: bitmap.height,
      data: new Uint8Array(imageData.data.buffer),
    };
  }

  /**
   * Convert texture to RGBA with a palette applied (for indexed formats).
   *
   * When `isClipMap` is true (Surface.type & Base1ClipMap), palette indices
   * 0-7 are written as fully-transparent RGBA(0,0,0,0). This is AC's
   * convention for clip-map foliage / decals: the low palette slots are
   * reserved for "punch-through" pixels that the renderer must alpha-test
   * out. Source: reference/ACViewer/Render/TextureCache.cs:356.
   */
  toRGBAWithPalette(paletteColors: number[], isClipMap = false): { width: number; height: number; data: Uint8Array } {
    const w = this.width;
    const h = this.height;
    const pixelCount = w * h;
    const data = new Uint8Array(pixelCount * 4);

    if (this.length === 0) return { width: w, height: h, data };

    if (this.format === SurfacePixelFormat.PFID_P8) {
      const src = this.sourceData;
      for (let i = 0; i < pixelCount; i++) {
        const colorIdx = src[i];
        const di = i * 4;
        if (isClipMap && colorIdx < 8) {
          data[di] = data[di + 1] = data[di + 2] = data[di + 3] = 0;
          continue;
        }
        const argb = paletteColors[colorIdx] ?? 0;
        data[di] = (argb >> 16) & 0xff;     // R
        data[di + 1] = (argb >> 8) & 0xff;  // G
        data[di + 2] = argb & 0xff;          // B
        data[di + 3] = (argb >>> 24) & 0xff; // A
      }
    } else if (this.format === SurfacePixelFormat.PFID_INDEX16) {
      const view = new DataView(this.sourceData.buffer, this.sourceData.byteOffset, this.sourceData.byteLength);
      for (let i = 0; i < pixelCount; i++) {
        const colorIdx = view.getInt16(i * 2, true);
        const di = i * 4;
        if (isClipMap && colorIdx < 8) {
          data[di] = data[di + 1] = data[di + 2] = data[di + 3] = 0;
          continue;
        }
        const argb = paletteColors[colorIdx] ?? 0;
        data[di] = (argb >> 16) & 0xff;     // R
        data[di + 1] = (argb >> 8) & 0xff;  // G
        data[di + 2] = argb & 0xff;          // B
        data[di + 3] = (argb >>> 24) & 0xff; // A
      }
    } else {
      return this.toRGBA();
    }

    return { width: w, height: h, data };
  }
}
