/**
 * GAP.81 — drop the orphaned AC_COLORS.radarBg + the Full Map panel's
 * procedural-canvas fallback that was its only consumer.
 *
 * The Full Map panel's mapTexUrl lookup (0x0600127d, the full-color Dereth
 * landmass art) fell back to a hand-drawn canvas — grid lines + a green
 * ellipse "landmass" filled with AC_COLORS.radarBg — whenever mapTexUrl was
 * falsy. dat-parser confirms 0x0600127d decodes successfully (257x267, P8,
 * fully opaque) directly from the shipped client_portal.dat, and getTexURL/
 * getItemIconURL's underlying TextureManager decode is synchronous against
 * the in-memory portal.dat the client requires fully loaded to boot at all
 * — so that branch was provably unreachable invented dead code (the same
 * shape as the already-removed combat-mode vector-icon fallback, see
 * verify-combat-toggle-indicator.ts). GAP.81's mandate is "no procedural /
 * no CSS-approximations" for real UI; for a fallback that can never render,
 * deleting the invented hex + the dead canvas code is the correct fix.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AC_COLORS } from '../packages/renderer/src/ui/GameUI.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';
import { openDat } from './_harness/dat.js';

const DAT_PATH = path.resolve(__dirname, '../dat/client_portal.dat');
const hasDats = fs.existsSync(DAT_PATH);

describe('GAP.81: orphaned AC_COLORS.radarBg removed', () => {
  it('radarBg is no longer exported', () => {
    expect('radarBg' in AC_COLORS).toBe(false);
  });
});

describe.skipIf(!hasDats)('GAP.81: Full Map texture 0x0600127d always decodes (fallback was unreachable)', () => {
  let db: DatDatabase;

  beforeAll(() => {
    db = openDat(DAT_PATH);
  });

  it('decodes to a fully-opaque RGBA bitmap from the real shipped DAT', () => {
    const data = db.getFileData(0x0600127d);
    expect(data).not.toBeNull();
    const tex = Texture.read(new DatReader(data!));
    expect(tex.width).toBe(257);
    expect(tex.height).toBe(267);
    const rgba = tex.toRGBA();
    expect(rgba.data.length).toBe(tex.width * tex.height * 4);
    let opaque = 0;
    for (let i = 3; i < rgba.data.length; i += 4) if (rgba.data[i] === 255) opaque++;
    expect(opaque).toBe(rgba.data.length / 4);
  });
});
