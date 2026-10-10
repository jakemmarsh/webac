import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import type { DatFileSource } from '@ac/dat-parser/RangedDat.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { Texture, SurfacePixelFormat } from '@ac/dat-parser/file-types/Texture.js';
import { SurfaceTexture } from '@ac/dat-parser/file-types/SurfaceTexture.js';
import { Palette } from '@ac/dat-parser/file-types/Palette.js';
import { PortalFileType } from '@ac/dat-parser/DatFileType.js';
import { LruMap } from '../utils/LruMap.js';
import { textureSamplerPrefs, isPalettedImage, markPalettedImage, type TextureKind, type HiResSource, type RgbaImage } from './TextureSamplerPrefs.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';

/** Which SurfaceTexture level to decode: the portal level (retail's High, the last entry) or level 0 (the highres level). */
export type SurfaceTextureLevel = 'portal' | 'hires';

/**
 * ASSESS: stable 64-bit-ish hash of a composite palette's colors so
 * palette-swapped textures can be cached by content. Two independent
 * FNV-1a passes (different offset bases) keep the collision probability
 * negligible for the few thousand distinct palettes a session sees.
 */
export function hashPaletteColors(colors: number[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i] >>> 0;
    h1 = Math.imul(h1 ^ (c & 0xffff), 0x01000193);
    h1 = Math.imul(h1 ^ (c >>> 16), 0x01000193);
    h2 = Math.imul(h2 ^ (c >>> 16), 0x01000193);
    h2 = Math.imul(h2 ^ (c & 0xffff), 0x01000193);
  }
  return `${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${colors.length}`;
}

/**
 * TextureManager — on-demand texture loading from portal.dat with caching.
 * Loads SurfaceTexture → Texture → RGBA pixel data → Three.js DataTexture.
 * Supports palette application for indexed formats.
 *
 * CORE.17.h.g.c.d — client_highres.dat (retail's HiFi DAT, DBCache id
 * 0x69466948) can be mounted as a second database: a SurfaceTexture's level
 * list is ordered highest-detail first and its index 0 is the highres level
 * (in client_highres.dat for ~2,500 of the 3,024 two-level lists, in
 * portal.dat itself for the rest — RenderTexture::ConstructTexture @
 * 0044ba70 sizes the D3D texture at the first retained level). Every
 * environment texture is registered with a lazy level-0 source; the prefs
 * registry draws it under Environment Texture Detail = Very High while the
 * DAT is mounted (RenderTexture::DropUnwantedLevels @ 0044c390) and the
 * portal level (the last entry, retail's High) otherwise. A 0x06 id is
 * resolved portal.dat first, then client_highres.dat (ACViewer's
 * TextureCache chain).
 */
export class TextureManager {
  private portalDb: DatFileSource;
  private highResDb: DatDatabase | null = null;
  private textureCache = new Map<number, THREE.DataTexture>();
  /**
   * RENDER.sampler-clamp — the TEXADDRESS_CLAMP twins of `textureCache`
   * entries (same key), for surface batches retail samples clamped
   * (D3DPolyRender::SetSurface @ 0059c4d0 with no stippled polygon).
   */
  private clampedTextureCache = new Map<number, THREE.DataTexture>();
  /** SurfaceTexture id → its level list (highest detail first), parsed once. */
  private surfaceLevelCache = new Map<number, number[] | null>();
  // ASSESS: bounded leak backstops (fresh-eyes audit 2026-06-10). Capacities
  // are generous on purpose — normal play should never evict; only multi-hour
  // sessions touching huge swaths of content hit the cap.
  //
  // paletteCache: a Palette is ≤2048 numbers (~16KB as JS array); 512 entries
  // covers far more distinct 0x04 palettes than any session loads (~8MB worst
  // case) and a miss just re-parses from the in-memory portal DAT.
  private paletteCache = new LruMap<number, number[]>(512);
  // paletteTextureCache: composite-palette character textures, keyed by
  // surfaceTextureId + palette-content hash. Each dressed character resolves
  // ~10-20 of these; 1024 ≈ 50+ concurrently-distinct appearances. Evicted
  // textures are disposed — THREE re-uploads a disposed DataTexture from its
  // retained CPU pixels if a live material still references it.
  // PERF.browser-memory-crash — eviction only forgets the cache entry. It
  // used to dispose the texture, but a live character could still be drawing
  // it: three re-uploaded it on the next frame, now outside every cache, and
  // nothing ever disposed it again (918 such textures stayed resident after
  // four teleports). Disposal belongs to sweep(), which knows what is live.
  private paletteTextureCache = new LruMap<string, THREE.DataTexture>(1024);
  /** Every texture this manager created and has not yet released (sweep() disposes the non-live ones). */
  private readonly owned = new Set<THREE.DataTexture>();
  private rgbaCache = new Map<string, { width: number; height: number; data: Uint8Array }>();

  // LRU order lives in the cache Maps themselves (ES Map iteration is
  // insertion order): a touch re-inserts the key at the end, eviction takes
  // the first key. REND.per-frame-allocations — the previous side arrays
  // paid an O(n) indexOf + splice on every cache hit (thousands of hits a
  // frame while streaming).

  /** Max entries before eviction (0 = unlimited) */
  private maxTextureEntries: number;
  private maxRgbaEntries: number;

  constructor(portalDb: DatFileSource, maxTextureEntries = 2048, maxRgbaEntries = 4096, highResDb: DatDatabase | null = null) {
    this.portalDb = portalDb;
    this.highResDb = highResDb;
    this.maxTextureEntries = maxTextureEntries;
    this.maxRgbaEntries = maxRgbaEntries;
  }

  /** Mount (or unmount) client_highres.dat. Already-decoded level-0 images stay cached. */
  setHighResDb(db: DatDatabase | null): void {
    this.highResDb = db;
  }

  /** The mounted client_highres.dat, if any. */
  get highRes(): DatDatabase | null {
    return this.highResDb;
  }

  /** A 0x06 Texture file's bytes: portal.dat first, then client_highres.dat. */
  private readTextureFile(textureId: number): ArrayBuffer | null {
    return this.portalDb.getFileData(textureId) ?? this.highResDb?.getFileData(textureId) ?? null;
  }

  /** A SurfaceTexture's level list (highest detail first), or null when the 0x05 file is absent. */
  getSurfaceTextureLevels(surfaceTextureId: number): number[] | null {
    const cached = this.surfaceLevelCache.get(surfaceTextureId);
    if (cached !== undefined) return cached;
    const epoch = datMissEpoch();
    const stData = this.portalDb.getFileData(surfaceTextureId);
    const levels = stData ? SurfaceTexture.read(new DatReader(stData)).textures : null;
    if (noDatMissSince(epoch)) this.surfaceLevelCache.set(surfaceTextureId, levels);
    return levels;
  }

  /**
   * The 0x06 id a level resolves to: the last entry for the portal level
   * (what retail draws at High: DropUnwantedLevels keeps the tail), index 0
   * for the highres level — only when the list has more than one entry
   * (a single-level list has no highres level to keep) and the file exists
   * in portal.dat or client_highres.dat.
   */
  resolveLevelTextureId(surfaceTextureId: number, level: SurfaceTextureLevel): number | null {
    const levels = this.getSurfaceTextureLevels(surfaceTextureId);
    if (!levels || levels.length === 0) return null;
    if (level === 'portal') return levels[levels.length - 1];
    if (levels.length < 2) return null;
    const l0 = levels[0];
    return this.portalDb.hasFile(l0) || (this.highResDb?.hasFile(l0) ?? false) ? l0 : null;
  }

  /** Whether a SurfaceTexture has a highres (level-0) entry that can be drawn now. */
  hasHighResLevel(surfaceTextureId: number): boolean {
    return this.resolveLevelTextureId(surfaceTextureId, 'hires') !== null;
  }

  /**
   * The level-0 source handed to the prefs registry for a two-level
   * SurfaceTexture (undefined for single-level lists, so the registry knows
   * the texture has nothing above the portal level). Lazy: the highres
   * texture is decoded only when Very High first asks for it.
   */
  private hiResSourceFor(surfaceTextureId: number, decode: () => RgbaImage | null): HiResSource | undefined {
    const levels = this.getSurfaceTextureLevels(surfaceTextureId);
    if (!levels || levels.length < 2) return undefined;
    return decode;
  }

  /** Touch an RGBA cache key (move to the most-recently-used end). */
  private touchRgba(key: string): void {
    const v = this.rgbaCache.get(key);
    if (v === undefined) return;
    this.rgbaCache.delete(key);
    this.rgbaCache.set(key, v);
  }

  /**
   * PERF.browser-memory-crash — drop and dispose every cached texture no live
   * material references (models/ResourceSweep.ts). The LRU caps alone let
   * ~3,000 textures stay resident on the GPU after the content using them
   * was unloaded. Returns how many were released.
   */
  sweep(live: ReadonlySet<THREE.Texture>): number {
    for (const [key, tex] of [...this.textureCache]) if (!live.has(tex)) this.textureCache.delete(key);
    for (const [key, tex] of [...this.clampedTextureCache]) if (!live.has(tex)) this.clampedTextureCache.delete(key);
    for (const [key, tex] of [...this.paletteTextureCache.entries()]) if (!live.has(tex)) this.paletteTextureCache.delete(key);
    let released = 0;
    for (const tex of [...this.owned]) {
      if (live.has(tex)) continue;
      this.owned.delete(tex);
      textureSamplerPrefs.unregister(tex);
      tex.dispose();
      released++;
    }
    return released;
  }

  /** Textures created and not yet released (tests / probes). */
  get ownedCount(): number { return this.owned.size; }

  /** Evict least recently used textures when over limit. */
  private evictTextures(): void {
    if (this.maxTextureEntries <= 0) return;
    for (const cache of [this.textureCache, this.clampedTextureCache]) {
      while (cache.size > this.maxTextureEntries) {
        // Forget only — the texture stays in `owned` until sweep() finds it unused.
        const evictKey = cache.keys().next().value as number;
        cache.delete(evictKey);
      }
    }
  }

  /** Evict least recently used RGBA entries when over limit. */
  private evictRgba(): void {
    if (this.maxRgbaEntries <= 0) return;
    while (this.rgbaCache.size > this.maxRgbaEntries) {
      this.rgbaCache.delete(this.rgbaCache.keys().next().value as string);
    }
  }

  /**
   * Get or create a Three.js DataTexture from a SurfaceTexture ID (0x05xxxxxx).
   * Uses the highest-resolution texture available.
   *
   * When `isClipMap` is true (caller's Surface.type & Base1ClipMap), palette
   * indices 0-7 are converted to fully-transparent pixels so the material
   * layer can alpha-test them out. The clipmap variant is cached separately
   * from the plain palette variant.
   *
   * CORE.17.h.g.c — `kind` says which Config texture-detail level scales the
   * texture (retail's ImgTex::fLandTextureScale vs fClipmapTextureScale):
   * the TerrainRenderer asks for 'landscape', everything else is
   * 'environment'. Every texture is handed to `textureSamplerPrefs`, which
   * applies the live filter mode / anisotropy / detail shift now and on
   * every later change; the two kinds are separate cache entries.
   */
  getTexture(surfaceTextureId: number, paletteId?: number, isClipMap = false, kind: TextureKind = 'environment', clamp = false): THREE.DataTexture | null {
    const cacheKey = (paletteId ? surfaceTextureId ^ (paletteId << 8) : surfaceTextureId)
      ^ (isClipMap ? 0x80000000 : 0) ^ (kind === 'landscape' ? 0x40000000 : 0);
    const cache = clamp ? this.clampedTextureCache : this.textureCache;
    const cached = cache.get(cacheKey);
    if (cached) {
      touchKey(cache, cacheKey);
      return cached;
    }

    const epoch = datMissEpoch();
    const rgba = this.getRGBA(surfaceTextureId, paletteId, isClipMap);
    if (!rgba) return null;

    // CORE.17.h.g.c.d — the highres level rides along as a lazy source; when
    // Very High is already active the texture is built from it directly.
    const hiRes = this.hiResSourceFor(surfaceTextureId, () => this.getRGBA(surfaceTextureId, paletteId, isClipMap, 'hires'));
    const hiImage = hiRes && textureSamplerPrefs.usesHighResLevel(kind) ? hiRes() : null;
    const image = hiImage ?? rgba;

    const tex = new THREE.DataTexture(
      new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      image.width,
      image.height,
      THREE.RGBAFormat,
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    setAddressing(tex, clamp, rgba);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    textureSamplerPrefs.register(tex, kind, rgba, { hiRes, builtFromHiRes: hiImage !== null, hiResImage: hiImage ?? undefined });

    this.owned.add(tex);
    // RELEASE.streaming-regression-gate — a texture decoded while its streamed
    // palette was not resident (the toRGBA fallback) is not the real one:
    // used once, never cached, so the rebuild after the palette lands decodes it again.
    if (!noDatMissSince(epoch)) return tex;
    cache.set(cacheKey, tex);
    touchKey(cache, cacheKey);
    this.evictTextures();
    return tex;
  }

  /**
   * Get or create a Three.js DataTexture using a composite palette (array of ARGB colors).
   * Used for character appearance where multiple palette ranges are merged.
   */
  getTextureWithPalette(surfaceTextureId: number, paletteColors: number[], isClipMap = false, clamp = false): THREE.DataTexture | null {
    // ASSESS: this path was completely uncached — every appearance rebuild
    // re-decoded + re-uploaded every palette-swapped texture for every dressed
    // character (audit §performance "material explosion"). Cache by content
    // hash so identical appearances share one DataTexture.
    const cacheKey = `${surfaceTextureId}:${hashPaletteColors(paletteColors)}:${isClipMap ? 'c' : 'n'}${clamp ? ':clamp' : ''}`;
    const cached = this.paletteTextureCache.get(cacheKey);
    if (cached) return cached;

    const epoch = datMissEpoch();
    const rgba = this.getRGBAWithPalette(surfaceTextureId, paletteColors, isClipMap);
    if (!rgba) return null;

    // CORE.17.h.g.c.d — same lazy highres level as getTexture, under the composite palette.
    const hiRes = this.hiResSourceFor(surfaceTextureId, () => this.getRGBAWithPalette(surfaceTextureId, paletteColors, isClipMap, 'hires'));
    const hiImage = hiRes && textureSamplerPrefs.usesHighResLevel('environment') ? hiRes() : null;
    const image = hiImage ?? rgba;

    const tex = new THREE.DataTexture(
      new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength),
      image.width,
      image.height,
      THREE.RGBAFormat,
    );
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    setAddressing(tex, clamp, rgba);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    textureSamplerPrefs.register(tex, 'environment', rgba, { hiRes, builtFromHiRes: hiImage !== null, hiResImage: hiImage ?? undefined });

    this.owned.add(tex);
    // A streamed miss during the build (e.g. Very High's highres level not
    // resident yet): used once, never cached, as in getTexture.
    if (!noDatMissSince(epoch)) return tex;
    this.paletteTextureCache.set(cacheKey, tex);
    return tex;
  }

  /**
   * Get RGBA pixel data using a composite palette.
   */
  getRGBAWithPalette(surfaceTextureId: number, paletteColors: number[], isClipMap = false, level: SurfaceTextureLevel = 'portal'): { width: number; height: number; data: Uint8Array } | null {
    const texId = this.resolveLevelTextureId(surfaceTextureId, level);
    if (texId === null) return null;
    const texData = this.readTextureFile(texId);
    if (!texData) return null;

    const texture = Texture.read(new DatReader(texData));

    // Use composite palette if the texture is palette-indexed
    if (texture.defaultPaletteId !== null) {
      return markPalettedImage(texture.toRGBAWithPalette(paletteColors, isClipMap));
    }
    return texture.toRGBA();
  }

  /**
   * Get RGBA pixel data from a SurfaceTexture ID.
   * Resolves SurfaceTexture → picks the requested level (the portal level by
   * default — the last entry, retail's High; 'hires' = index 0, the
   * client_highres.dat level, null when the list has no such level) →
   * converts to RGBA.
   */
  getRGBA(surfaceTextureId: number, paletteId?: number, isClipMap = false, level: SurfaceTextureLevel = 'portal'): { width: number; height: number; data: Uint8Array } | null {
    const key = `${surfaceTextureId}:${paletteId ?? 0}:${isClipMap ? 'c' : 'n'}${level === 'hires' ? ':h' : ''}`;
    const cached = this.rgbaCache.get(key);
    if (cached) {
      this.touchRgba(key);
      return cached;
    }

    const texId = this.resolveLevelTextureId(surfaceTextureId, level);
    if (texId === null) return null;
    const epoch = datMissEpoch();
    const texData = this.readTextureFile(texId);
    if (!texData) return null;

    const texture = Texture.read(new DatReader(texData));

    let rgba: { width: number; height: number; data: Uint8Array };

    // Apply palette if needed and available
    if (paletteId && texture.defaultPaletteId !== null) {
      const colors = this.getPaletteColors(paletteId);
      if (colors) {
        rgba = texture.toRGBAWithPalette(colors, isClipMap);
      } else {
        rgba = texture.toRGBA();
      }
    } else if (texture.defaultPaletteId !== null) {
      const colors = this.getPaletteColors(texture.defaultPaletteId);
      if (colors) {
        rgba = texture.toRGBAWithPalette(colors, isClipMap);
      } else {
        rgba = texture.toRGBA();
      }
    } else {
      rgba = texture.toRGBA();
    }
    if (texture.defaultPaletteId !== null) markPalettedImage(rgba);

    // RELEASE.streaming-regression-gate — decoded without a streamed palette: not cached (getTexture).
    if (!noDatMissSince(epoch)) return rgba;
    this.rgbaCache.set(key, rgba);
    this.touchRgba(key);
    this.evictRgba();
    return rgba;
  }

  /**
   * Load and cache palette colors from a palette ID (0x04xxxxxx).
   */
  getPaletteColors(paletteId: number): number[] | null {
    const cached = this.paletteCache.get(paletteId);
    if (cached) return cached;

    const data = this.portalDb.getFileData(paletteId);
    if (!data) return null;

    const palette = Palette.read(new DatReader(data));
    this.paletteCache.set(paletteId, palette.colors);
    return palette.colors;
  }

  /** The highres (level-0) RGBA of a SurfaceTexture, or null when it has none (see getRGBA). */
  getHighResRGBA(surfaceTextureId: number, paletteId?: number, isClipMap = false): { width: number; height: number; data: Uint8Array } | null {
    return this.getRGBA(surfaceTextureId, paletteId, isClipMap, 'hires');
  }

  /**
   * Get RGBA pixel data from a raw Texture ID (0x06xxxxxx).
   * Unlike getRGBA() which expects a SurfaceTexture (0x05), this loads
   * the texture directly.
   */
  getDirectRGBA(textureId: number, paletteId?: number): { width: number; height: number; data: Uint8Array } | null {
    const key = `direct:${textureId}:${paletteId ?? 0}`;
    const cached = this.rgbaCache.get(key);
    if (cached) {
      this.touchRgba(key);
      return cached;
    }

    const epoch = datMissEpoch();
    const texData = this.readTextureFile(textureId);
    if (!texData) return null;

    const texture = Texture.read(new DatReader(texData));

    let rgba: { width: number; height: number; data: Uint8Array };
    if (paletteId && texture.defaultPaletteId !== null) {
      const colors = this.getPaletteColors(paletteId);
      rgba = colors ? texture.toRGBAWithPalette(colors) : texture.toRGBA();
    } else if (texture.defaultPaletteId !== null) {
      const colors = this.getPaletteColors(texture.defaultPaletteId);
      rgba = colors ? texture.toRGBAWithPalette(colors) : texture.toRGBA();
    } else {
      rgba = texture.toRGBA();
    }

    // RELEASE.streaming-regression-gate — decoded without a streamed palette: not cached (getTexture).
    if (!noDatMissSince(epoch)) return rgba;
    this.rgbaCache.set(key, rgba);
    this.touchRgba(key);
    this.evictRgba();
    return rgba;
  }

  /**
   * Get RGBA pixel data from any icon/texture ID, auto-detecting whether
   * it's a SurfaceTexture, direct Texture, or other type.
   */
  getIconRGBA(iconId: number, paletteId?: number): { width: number; height: number; data: Uint8Array } | null {
    const fileType = (iconId >> 24) & 0xFF;
    if (fileType === PortalFileType.SurfaceTexture) {
      return this.getRGBA(iconId, paletteId);
    } else if (fileType === PortalFileType.Texture) {
      return this.getDirectRGBA(iconId, paletteId);
    } else {
      // Try as SurfaceTexture first, fall back to direct
      const result = this.getRGBA(iconId, paletteId);
      if (result) return result;
      return this.getDirectRGBA(iconId, paletteId);
    }
  }

  /**
   * Convert an icon/texture ID to a data URL suitable for DOM <img> elements.
   * Handles SurfaceTexture and direct Texture IDs.
   */
  getIconDataURL(iconId: number, paletteId?: number): string | null {
    const rgba = this.getIconRGBA(iconId, paletteId);
    if (!rgba) return null;
    return TextureManager.rgbaToDataURL(rgba.width, rgba.height, rgba.data);
  }

  /**
   * Get a data URL for a JPEG texture (format 0x1f4) directly from its raw bytes.
   * Returns null if the texture is not JPEG format or not found.
   * This avoids async decoding — the JPEG bytes become a data:image/jpeg URL.
   */
  getJPEGDataURL(textureId: number): string | null {
    const texData = this.portalDb.getFileData(textureId);
    if (!texData) return null;

    const texture = Texture.read(new DatReader(texData));
    if (!texture.isJPEG) return null;
    return texture.getJPEGDataURL();
  }

  /**
   * Async version of getDirectRGBA that handles JPEG textures.
   * For non-JPEG textures, returns the same as getDirectRGBA synchronously.
   */
  async getDirectRGBAAsync(textureId: number, paletteId?: number): Promise<{ width: number; height: number; data: Uint8Array } | null> {
    const key = `direct:${textureId}:${paletteId ?? 0}`;
    const cached = this.rgbaCache.get(key);
    if (cached) {
      this.touchRgba(key);
      return cached;
    }

    const epoch = datMissEpoch();
    const texData = this.readTextureFile(textureId);
    if (!texData) return null;

    const texture = Texture.read(new DatReader(texData));

    let rgba: { width: number; height: number; data: Uint8Array };
    if (texture.isJPEG) {
      rgba = await texture.toRGBAAsync();
    } else if (paletteId && texture.defaultPaletteId !== null) {
      const colors = this.getPaletteColors(paletteId);
      rgba = colors ? texture.toRGBAWithPalette(colors) : texture.toRGBA();
    } else if (texture.defaultPaletteId !== null) {
      const colors = this.getPaletteColors(texture.defaultPaletteId);
      rgba = colors ? texture.toRGBAWithPalette(colors) : texture.toRGBA();
    } else {
      rgba = texture.toRGBA();
    }

    // RELEASE.streaming-regression-gate — decoded without a streamed palette: not cached (getTexture).
    if (!noDatMissSince(epoch)) return rgba;
    this.rgbaCache.set(key, rgba);
    this.touchRgba(key);
    this.evictRgba();
    return rgba;
  }

  /**
   * Async version of getIconRGBA that handles JPEG textures.
   */
  async getIconRGBAAsync(iconId: number, paletteId?: number): Promise<{ width: number; height: number; data: Uint8Array } | null> {
    const fileType = (iconId >> 24) & 0xFF;
    if (fileType === PortalFileType.Texture) {
      return this.getDirectRGBAAsync(iconId, paletteId);
    }
    // Non-Texture types don't have JPEG format, use sync path
    return this.getIconRGBA(iconId, paletteId);
  }

  /**
   * Convert RGBA pixel data to a data URL string.
   */
  static rgbaToDataURL(width: number, height: number, data: Uint8Array): string {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(data);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
  }

  /**
   * Get the number of cached textures.
   */
  get cacheSize(): number {
    return this.textureCache.size;
  }

  /**
   * Clear all caches.
   */
  clear(): void {
    for (const tex of this.owned) {
      textureSamplerPrefs.unregister(tex);
      tex.dispose();
    }
    this.owned.clear();
    this.textureCache.clear();
    this.clampedTextureCache.clear();
    this.paletteTextureCache.clear();
    this.paletteCache.clear();
    this.rgbaCache.clear();
    this.surfaceLevelCache.clear();
  }

  /** Get total memory usage estimate (RGBA bytes cached). */
  get estimatedMemoryBytes(): number {
    let total = 0;
    for (const entry of this.rgbaCache.values()) {
      total += entry.data.byteLength;
    }
    return total;
  }

  /** Get cache statistics for debugging. */
  get stats(): { textures: number; paletteTextures: number; rgbaEntries: number; palettes: number; estimatedMB: number; highResMounted: boolean } {
    return {
      textures: this.textureCache.size,
      paletteTextures: this.paletteTextureCache.size,
      rgbaEntries: this.rgbaCache.size,
      palettes: this.paletteCache.size,
      estimatedMB: Math.round(this.estimatedMemoryBytes / (1024 * 1024) * 10) / 10,
      highResMounted: this.highResDb !== null,
    };
  }
}

/** Move a cache key to the most-recently-used end. */
function touchKey<K, V>(cache: Map<K, V>, key: K): void {
  const v = cache.get(key);
  if (v === undefined) return;
  cache.delete(key);
  cache.set(key, v);
}

/**
 * RENDER.sampler-clamp — D3DPolyRender::SetSurface @ 0059c4d0:
 * `SetSamplerAddressMode(0, wrap ? TEXADDRESS_WRAP : TEXADDRESS_CLAMP)`,
 * where `wrap` is the batch's stippled bit (GfxObjGeometry.clampUV).
 */
function setAddressing(tex: THREE.DataTexture, clamp: boolean, rgba: object): void {
  const mode = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.wrapS = mode;
  tex.wrapT = mode;
  tex.userData.acPaletted = isPalettedImage(rgba);
}
