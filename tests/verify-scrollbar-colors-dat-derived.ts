/**
 * GAP.81 — scrollThumb/scrollTrack AC_COLORS entries must be DAT-derived,
 * not hand-picked hex guesses.
 *
 * GameUI's chat log (the only remaining scrollbar host on the browser-native
 * `scrollbarColor` CSS property — every other scrollbar host in GameUI.ts
 * renders the real DAT scrollbar images directly via getTexURL(), see
 * VISUAL.101) previously tinted that native scrollbar with invented hex
 * (#4a4020 / #0e0e24) unrelated to any real asset.
 *
 * scrollThumb/scrollTrack now cite the SAME portal.dat scrollbar textures
 * those other hosts already load:
 *   - scrollThumb: 0x06004d34 (the gold/bronze thumb graphic) — average of
 *     its saturated (non-grey/shadow) pixels.
 *   - scrollTrack: 0x06004d33 (the track graphic) — this texture decodes to
 *     a pure 2-color alpha stencil (opaque black shape pixels over a fully
 *     transparent background), so its only real color is black.
 *
 * This test drives the real DAT parser + texture decoder (packages/dat-parser)
 * to re-derive each color from the shipped texture bytes and asserts the
 * AC_COLORS literal matches — not a source-text regex pin.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AC_COLORS } from '../packages/renderer/src/ui/GameUI.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const hasPortalDat = existsSync(PORTAL_DAT);

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Average color among pixels whose (max-min) channel spread exceeds satThreshold — isolates the "colorful" fill area from the dark bevel/shadow that dominates raw pixel count. */
function avgSaturatedColor(rgba: { data: Uint8Array }, satThreshold = 60): [number, number, number] {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < rgba.data.length; i += 4) {
    const a = rgba.data[i + 3];
    if (a < 10) continue;
    const r = rgba.data[i], g = rgba.data[i + 1], b = rgba.data[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) < satThreshold) continue;
    sr += r; sg += g; sb += b; n++;
  }
  if (n === 0) throw new Error('no saturated pixels found');
  return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
}

function expectClose(actual: [number, number, number], expectedHex: string, tolerance: number, label: string) {
  const [er, eg, eb] = hexToRgb(expectedHex);
  const [ar, ag, ab] = actual;
  const diff = Math.max(Math.abs(ar - er), Math.abs(ag - eg), Math.abs(ab - eb));
  expect(diff, `${label}: derived ${rgbToHex(ar, ag, ab)} vs AC_COLORS ${expectedHex}`).toBeLessThanOrEqual(tolerance);
}

describe('GAP.81: scrollbar colors have DAT texture evidence', () => {
  it('AC_COLORS still exports scrollThumb/scrollTrack as 6-digit hex', () => {
    expect(AC_COLORS.scrollThumb).toMatch(/^#[0-9a-f]{6}$/);
    expect(AC_COLORS.scrollTrack).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe.skipIf(!hasPortalDat)('GAP.81: DAT-derived scrollbar colors', () => {
  let portalDb: DatDatabase;

  beforeAll(() => {
    const buf = readFileSync(PORTAL_DAT).buffer;
    portalDb = new DatDatabase(buf as ArrayBuffer);
  });

  function decode(id: number) {
    const data = portalDb.getFileData(id);
    if (!data) throw new Error(`texture 0x${id.toString(16)} missing from portal.dat`);
    const rgba = Texture.read(new DatReader(data)).toRGBA();
    if (!rgba) throw new Error(`texture 0x${id.toString(16)} failed to decode`);
    return rgba;
  }

  it('scrollThumb ~= avgSaturated(0x06004d34) — real gold/bronze thumb, not the old olive #4a4020 guess', () => {
    expectClose(avgSaturatedColor(decode(0x06004d34)), AC_COLORS.scrollThumb, 24, 'scrollThumb');
  });

  it('scrollTrack (0x06004d33) decodes to a pure black/transparent stencil — the old #0e0e24 navy tint has no basis in the shipped bytes', () => {
    const rgba = decode(0x06004d33);
    const opaqueColors = new Set<string>();
    let opaqueCount = 0;
    for (let i = 0; i < rgba.data.length; i += 4) {
      if (rgba.data[i + 3] < 200) continue; // only fully-opaque pixels
      opaqueCount++;
      opaqueColors.add(`${rgba.data[i]},${rgba.data[i + 1]},${rgba.data[i + 2]}`);
    }
    expect(opaqueCount, 'texture has some opaque pixels').toBeGreaterThan(0);
    expect(opaqueColors.size, 'all opaque pixels share one color (a stencil, not a gradient)').toBe(1);
    expect([...opaqueColors][0]).toBe('0,0,0');
    expect(AC_COLORS.scrollTrack).toBe('#000000');
  });
});
