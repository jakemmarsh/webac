import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { PaletteSet } from '@ac/dat-parser/file-types/PaletteSet.js';
import { Palette } from '@ac/dat-parser/file-types/Palette.js';

/**
 * AppearanceManager — resolves skin/hair/clothing palette variations.
 * Uses PaletteSet to map a hue value (0.0–1.0) to specific palette colors,
 * enabling character customization (skin tone, hair color, equipment color).
 */
export class AppearanceManager {
  private portalDb: DatDatabase;
  private paletteSetCache = new Map<number, PaletteSet>();
  private paletteCache = new Map<number, number[]>();

  constructor(portalDb: DatDatabase) {
    this.portalDb = portalDb;
  }

  /**
   * Load a PaletteSet from portal.dat.
   */
  loadPaletteSet(paletteSetId: number): PaletteSet | null {
    const cached = this.paletteSetCache.get(paletteSetId);
    if (cached) return cached;

    const data = this.portalDb.getFileData(paletteSetId);
    if (!data) return null;

    const ps = new PaletteSet(new DatReader(data));
    this.paletteSetCache.set(paletteSetId, ps);
    return ps;
  }

  /**
   * Load palette colors from a Palette ID (0x04xxxxxx).
   */
  loadPaletteColors(paletteId: number): number[] | null {
    const cached = this.paletteCache.get(paletteId);
    if (cached) return cached;

    const data = this.portalDb.getFileData(paletteId);
    if (!data) return null;

    const palette = Palette.read(new DatReader(data));
    this.paletteCache.set(paletteId, palette.colors);
    return palette.colors;
  }

  /**
   * Resolve a PaletteSet + hue to specific palette colors.
   * Returns the palette colors for the selected hue, or null if not found.
   */
  resolveColors(paletteSetId: number, hue: number): number[] | null {
    const ps = this.loadPaletteSet(paletteSetId);
    if (!ps) return null;

    const paletteId = ps.getPaletteId(hue);
    if (!paletteId) return null;

    return this.loadPaletteColors(paletteId);
  }

  /**
   * Build a composite palette by overlaying sub-palette ranges onto a base palette.
   * Used for character appearance: base skin palette with hair/clothing ranges overlaid.
   */
  buildCompositePalette(
    basePaletteColors: number[],
    overrides: Array<{
      paletteSetId: number;
      hue: number;
      offset: number;
      numColors: number;
    }>,
  ): number[] {
    // Start with a copy of the base palette
    const result = [...basePaletteColors];

    for (const override of overrides) {
      const colors = this.resolveColors(override.paletteSetId, override.hue);
      if (!colors) continue;

      // Copy the specified range of colors from the override palette
      for (let i = 0; i < override.numColors; i++) {
        const srcIdx = override.offset + i;
        const dstIdx = override.offset + i;
        if (srcIdx < colors.length && dstIdx < result.length) {
          result[dstIdx] = colors[srcIdx];
        }
      }
    }

    return result;
  }

  /**
   * Get the number of cached PaletteSets.
   */
  get cacheSize(): number {
    return this.paletteSetCache.size;
  }

  /**
   * Clear all caches.
   */
  clear(): void {
    this.paletteSetCache.clear();
    this.paletteCache.clear();
  }
}
