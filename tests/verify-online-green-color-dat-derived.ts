/**
 * GAP.81 — onlineGreen AC_COLORS entry must be DAT-derived, not a hand-picked
 * hex guess.
 *
 * AC_COLORS.onlineGreen backs the "on" state of several presence/toggle
 * indicators in GameUI.ts (fellowship/allegiance/social online-name tint,
 * the checkbox-bullet fallback in addCheckSliderRow, the "Slots" gem-toggle
 * fallback) — always as a CSS fallback for when the real DAT texture for
 * that indicator fails to load. The checkbox-bullet call site already
 * getTexURL()'s a real portal.dat asset for its "on" state (0x06004d17) —
 * this test re-derives onlineGreen from that exact texture's saturated
 * pixels, confirming it's a yellow-green lime (~#88c632), not the previously
 * invented pure-green #40c040.
 *
 * Drives the real DAT parser + texture decoder (packages/dat-parser) to
 * re-derive the color from the shipped texture bytes — not a source-text
 * regex pin.
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

describe('GAP.81: onlineGreen color has DAT texture evidence', () => {
  it('AC_COLORS still exports onlineGreen as 6-digit hex', () => {
    expect(AC_COLORS.onlineGreen).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe.skipIf(!hasPortalDat)('GAP.81: DAT-derived onlineGreen color', () => {
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

  it('onlineGreen ~= avgSaturated(0x06004d17) — real checkbox on-bullet lime, not the old pure-green #40c040 guess', () => {
    expectClose(avgSaturatedColor(decode(0x06004d17)), AC_COLORS.onlineGreen, 24, 'onlineGreen');
  });

  it('onlineGreen is hue-distinct from the off-bullet texture 0x06004d19 (a dark bronze, per addCheckSliderRow)', () => {
    const [or_, og, ob] = avgSaturatedColor(decode(0x06004d17));
    const [fr, fg, fb] = avgSaturatedColor(decode(0x06004d19));
    expect(og, 'on-bullet: green dominant').toBeGreaterThan(or_);
    expect(og, 'on-bullet: green dominant').toBeGreaterThan(ob);
    expect(fr, 'off-bullet: red-dominant dark bronze, not green').toBeGreaterThan(fg);
  });
});
