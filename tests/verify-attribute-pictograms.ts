/**
 * ASSESS: VISUAL.5 — attribute pictograms on the character panel.
 *
 * The six attribute rows (Str/End/Coord/Quick/Focus/Self) carry the real
 * retail pictogram textures 0x060002c4-0x060002c9 from portal.dat (25x25,
 * the same size class as the shipped vital hearts 0x06004c3b-3d). The old
 * "pictograms not in portal.dat" blocker note was refuted by the 2026-06-09
 * panel-spec sweep (verification/panel-specs/char-skills+attributes.md);
 * the per-attribute assignment was re-verified 2026-06-10 by decoding each
 * texture and matching it against the retail icon column in
 * reference/images/hud/character-panel-attributes.jpg.
 *
 * Pins:
 *   1. The mapping module covers exactly the six attributes with the
 *      spec-verified texture IDs (all distinct, all 0x06 texture-class).
 *   2. (DAT) Every pictogram exists in portal.dat and decodes to a 25x25
 *      RGBA image with real art (non-trivial opaque coverage, multiple
 *      distinct colors).
 *   3. (DAT) The six decode to pairwise-different pixel data — no two
 *      attributes share an icon.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ATTRIBUTE_PICTOGRAM_TEXTURES,
  ATTRIBUTE_PICTOGRAM_SIZE,
} from '../packages/renderer/src/ui/attributePictograms.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const hasPortalDat = existsSync(PORTAL_DAT);

describe('VISUAL.5: attribute pictogram mapping', () => {
  it('covers exactly the six primary attributes in display order', () => {
    expect(Object.keys(ATTRIBUTE_PICTOGRAM_TEXTURES)).toEqual([
      'strength', 'endurance', 'coordination', 'quickness', 'focus', 'self',
    ]);
  });

  it('uses the spec-verified texture IDs (panel-specs/char-skills+attributes.md)', () => {
    expect(ATTRIBUTE_PICTOGRAM_TEXTURES).toEqual({
      strength: 0x060002c8,
      endurance: 0x060002c4,
      coordination: 0x060002c9,
      quickness: 0x060002c6,
      focus: 0x060002c5,
      self: 0x060002c7,
    });
  });

  it('all IDs are distinct 0x06 (Texture) class file IDs', () => {
    const ids = Object.values(ATTRIBUTE_PICTOGRAM_TEXTURES);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id >>> 24).toBe(0x06);
    }
  });
});

describe.skipIf(!hasPortalDat)('VISUAL.5: pictogram textures in portal.dat', () => {
  let portalDb: DatDatabase;
  const decoded = new Map<string, { width: number; height: number; data: Uint8Array }>();

  beforeAll(() => {
    const buf = readFileSync(PORTAL_DAT).buffer;
    portalDb = new DatDatabase(buf as ArrayBuffer);
    for (const [attr, id] of Object.entries(ATTRIBUTE_PICTOGRAM_TEXTURES)) {
      const data = portalDb.getFileData(id);
      if (!data) continue;
      const rgba = Texture.read(new DatReader(data)).toRGBA();
      if (rgba) decoded.set(attr, rgba);
    }
  });

  it('every pictogram exists and decodes to RGBA', () => {
    expect([...decoded.keys()].sort()).toEqual(
      Object.keys(ATTRIBUTE_PICTOGRAM_TEXTURES).sort(),
    );
  });

  it(`every pictogram is ${ATTRIBUTE_PICTOGRAM_SIZE}x${ATTRIBUTE_PICTOGRAM_SIZE}`, () => {
    for (const [attr, rgba] of decoded) {
      expect(rgba.width, attr).toBe(ATTRIBUTE_PICTOGRAM_SIZE);
      expect(rgba.height, attr).toBe(ATTRIBUTE_PICTOGRAM_SIZE);
      expect(rgba.data.length, attr).toBe(rgba.width * rgba.height * 4);
    }
  });

  it('every pictogram carries real art (opaque coverage + multiple colors)', () => {
    for (const [attr, rgba] of decoded) {
      let opaque = 0;
      const colors = new Set<number>();
      for (let i = 0; i < rgba.data.length; i += 4) {
        if (rgba.data[i + 3] > 0) {
          opaque++;
          colors.add((rgba.data[i] << 16) | (rgba.data[i + 1] << 8) | rgba.data[i + 2]);
        }
      }
      const total = rgba.width * rgba.height;
      // The icons are circular medallions on transparent corners — expect a
      // majority-opaque image with a real palette, not a blank or flat fill.
      expect(opaque / total, `${attr}: opaque coverage`).toBeGreaterThan(0.4);
      expect(colors.size, `${attr}: distinct colors`).toBeGreaterThan(8);
    }
  });

  it('no two attributes share pixel data', () => {
    const entries = [...decoded.entries()];
    for (let a = 0; a < entries.length; a++) {
      for (let b = a + 1; b < entries.length; b++) {
        const [nameA, texA] = entries[a];
        const [nameB, texB] = entries[b];
        expect(
          Buffer.from(texA.data).equals(Buffer.from(texB.data)),
          `${nameA} vs ${nameB}`,
        ).toBe(false);
      }
    }
  });
});
