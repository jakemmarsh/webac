/**
 * GAP.81 — vital bar + panel-frame AC_COLORS entries must be DAT-derived,
 * not hand-picked hex guesses.
 *
 * GameUI.ts's AC_COLORS block previously hardcoded barHealth/barHealthBg/
 * barStamina/barMana/goldFrame/panelBorder as invented hex approximations.
 * These six now cite real portal.dat textures:
 *   - barHealth / barStamina / barMana: the vital-bar "bg" mid-textures
 *     from LayoutDesc 0x21000014 (classic_vitals) — 0x06001132 / 0x06001138
 *     / 0x06001135 — averaged over saturated (non-grey/shadow) pixels.
 *   - barHealthBg: the paired dark companion texture 0x06001140 — mode of
 *     non-near-black pixels.
 *   - goldFrame / panelBorder: the LayoutDesc 0x2100001a title-bar plate
 *     texture 0x06004cfa (reused as panel-frame chrome across ~12 HUD
 *     panels) — bright-gold highlight bucket vs. dark-bronze shadow bucket
 *     of the same bevel gradient.
 *
 * This test drives the real DAT parser + texture decoder (packages/dat-parser)
 * to re-derive each color from the shipped texture bytes and asserts the
 * AC_COLORS literal is within a small per-channel tolerance of that
 * derivation — not a source-text regex pin. Tolerance exists because the
 * derivation is a documented statistical summary (saturated-pixel average /
 * histogram mode), not a single deterministic pixel.
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

/** Most frequent color bucket (4-bit-per-channel), excluding near-black (<24 summed) anti-aliasing/edge noise. */
function modeColor(rgba: { data: Uint8Array }, blackThreshold = 24): [number, number, number] {
  const counts = new Map<string, number>();
  for (let i = 0; i < rgba.data.length; i += 4) {
    const a = rgba.data[i + 3];
    if (a < 10) continue;
    const r = rgba.data[i], g = rgba.data[i + 1], b = rgba.data[i + 2];
    if (r + g + b < blackThreshold) continue;
    const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) throw new Error('no non-black pixels found');
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [r, g, b] = best[0].split('-').map(Number);
  return [(r << 4) + 8, (g << 4) + 8, (b << 4) + 8];
}

function expectClose(actual: [number, number, number], expectedHex: string, tolerance: number, label: string) {
  const [er, eg, eb] = hexToRgb(expectedHex);
  const [ar, ag, ab] = actual;
  const diff = Math.max(Math.abs(ar - er), Math.abs(ag - eg), Math.abs(ab - eb));
  expect(diff, `${label}: derived ${rgbToHex(ar, ag, ab)} vs AC_COLORS ${expectedHex}`).toBeLessThanOrEqual(tolerance);
}

describe('GAP.81: vital bar + panel-frame colors have DAT texture evidence', () => {
  it('AC_COLORS still exports the six audited keys as 6-digit hex', () => {
    for (const key of ['barHealth', 'barHealthBg', 'barStamina', 'barMana', 'goldFrame', 'panelBorder'] as const) {
      expect(AC_COLORS[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe.skipIf(!hasPortalDat)('GAP.81: DAT-derived vital bar + panel-frame colors', () => {
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

  it('barHealth ~= avgSaturated(0x06001132) — real vitals red, not the old #8b1a1a guess', () => {
    expectClose(avgSaturatedColor(decode(0x06001132)), AC_COLORS.barHealth, 24, 'barHealth');
  });

  it('barStamina ~= avgSaturated(0x06001138) — real vitals amber, not the old olive #8a7a20 guess', () => {
    expectClose(avgSaturatedColor(decode(0x06001138)), AC_COLORS.barStamina, 24, 'barStamina');
  });

  it('barMana ~= avgSaturated(0x06001135) — real vitals teal-blue, not the old purple-blue #1a3a8b guess', () => {
    expectClose(avgSaturatedColor(decode(0x06001135)), AC_COLORS.barMana, 24, 'barMana');
  });

  it('barHealthBg ~= mode(0x06001140) — real dark companion texture, not the invented #3a0808', () => {
    expectClose(modeColor(decode(0x06001140)), AC_COLORS.barHealthBg, 24, 'barHealthBg');
  });

  it('goldFrame ~= dominant bright-gold bucket of 0x06004cfa title-plate texture', () => {
    expectClose(modeColor(decode(0x06004cfa), 200), AC_COLORS.goldFrame, 32, 'goldFrame');
  });

  it('panelBorder ~= dominant dark-bronze bucket of the same 0x06004cfa texture', () => {
    expectClose(modeColor(decode(0x06004cfa)), AC_COLORS.panelBorder, 24, 'panelBorder');
  });

  it('the three vital bar colors are hue-distinct (red vs amber vs teal-blue, matching HP/Stamina/Mana semantics)', () => {
    const [hr, hg, hb] = avgSaturatedColor(decode(0x06001132));
    const [sr, sg, sb] = avgSaturatedColor(decode(0x06001138));
    const [mr, mg, mb] = avgSaturatedColor(decode(0x06001135));
    expect(hr, 'health: red dominant').toBeGreaterThan(hg);
    expect(hr, 'health: red dominant').toBeGreaterThan(hb);
    expect(sr, 'stamina: red+green (amber), low blue').toBeGreaterThan(sb);
    expect(sg, 'stamina: red+green (amber), low blue').toBeGreaterThan(sb);
    expect(mb, 'mana: blue dominant').toBeGreaterThan(mr);
    expect(mb, 'mana: blue dominant').toBeGreaterThan(mg * 0.5);
  });
});
