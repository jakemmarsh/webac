/**
 * BUG.ac1999-subpalette-scale — on a 1999 world every recoloured object drew
 * the wrong colours: a new Aluvian male picked a brown shirt and blue
 * trousers in chargen (the preview was right) and the world dressed him in
 * the skin palette's green and red (playwebac.com, 2026-10-08).
 *
 * Parsed Subpalette ranges are the wire bytes × 8 (Subpalette::UnPack
 * @ 005adab0) because end-of-retail palettes have 2048 colours. The 1999
 * palettes have 256 and the AC1999 server sends raw indices (ObjDesc.cpp
 * `offset >> 3` of a ×8 store whose 1999 values are raw): skin (0, 0x18),
 * hair (0x18, 8), eyes (0x20, 8), the shirt from 40. Read × 8, skin covered
 * [0,192) — every clothing range — and the shirt (320) was refused.
 * subPaletteScale rescales by the palette's own size (every EoL 0x04 has
 * 2048 entries, every 1999 one 256).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { Gender, Heritage } from '@ac/shared';
import type { AppearanceInfo } from '@ac/shared';
import type { SexCG } from '@ac/dat-parser/file-types/CharacterGenerator.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import {
  buildAppearanceOverrides, subPaletteScale, FACE_SUBPALETTE_RANGES,
} from '../packages/renderer/src/models/AppearanceOverrides.js';
import { AppearanceManager } from '../packages/renderer/src/models/AppearanceManager.js';
import { CharacterModelBuilder } from '../packages/renderer/src/models/CharacterModelBuilder.js';
import { ClothingRenderer } from '../packages/renderer/src/models/ClothingRenderer.js';

const BASE = 1, SKIN = 2, SHIRT = 3;
const palettes = (len: number): Map<number, number[]> => new Map([
  [BASE, Array.from({ length: len }, () => 0x111111)],
  [SKIN, Array.from({ length: len }, () => 0x00aa00)],
  [SHIRT, Array.from({ length: len }, () => 0x8b4513)],
]);
/** What the 1999 server sends for a player (skin over (0, 0x18), the shirt over (40, 24)), as parsed (× 8). */
const player1999 = {
  basePalette: BASE,
  subPalettes: [
    { paletteId: SKIN, offset: 0, length: 0x18 * 8 },
    { paletteId: SHIRT, offset: 40 * 8, length: 24 * 8 },
  ],
  textureChanges: [], animPartChanges: [],
};

describe('subPaletteScale: the range scale follows the palette size', () => {
  it('2048 colours (end of retail) → 1; 256 (1999) → 1/8; any other size → 1', () => {
    expect(subPaletteScale(2048)).toBe(1);
    expect(subPaletteScale(256)).toBe(1 / 8);
    expect(subPaletteScale(32)).toBe(1);
  });

  it('a 1999 player on a 256-entry palette: skin stays in [0,24), the shirt lands at [40,64); before, skin filled [0,192) and the shirt was refused', () => {
    const pals = palettes(256);
    const out = buildAppearanceOverrides(player1999, (id) => pals.get(id)).paletteColors!;
    for (let i = 0; i < 24; i++) expect(out[i]).toBe(0x00aa00);
    for (let i = 24; i < 40; i++) expect(out[i]).toBe(0x111111);
    for (let i = 40; i < 64; i++) expect(out[i]).toBe(0x8b4513);
    for (let i = 64; i < 256; i++) expect(out[i]).toBe(0x111111);
  });

  it('the same wire ranges on a 2048-entry palette (end of retail) are unchanged: skin [0,192), the shirt [320,512)', () => {
    const pals = palettes(2048);
    const out = buildAppearanceOverrides(player1999, (id) => pals.get(id)).paletteColors!;
    expect(out[0]).toBe(0x00aa00);
    expect(out[191]).toBe(0x00aa00);
    expect(out[192]).toBe(0x111111);
    expect(out[320]).toBe(0x8b4513);
    expect(out[511]).toBe(0x8b4513);
    expect(out[512]).toBe(0x111111);
  });

  it('the fixed face ranges scale to the 1999 skin [0,24), hair [24,32), eyes [32,40)', () => {
    const k = subPaletteScale(256);
    const r = (x: { offset: number; numColors: number }) => [x.offset * k, x.numColors * k];
    expect(r(FACE_SUBPALETTE_RANGES.skin)).toEqual([0, 24]);
    expect(r(FACE_SUBPALETTE_RANGES.hair)).toEqual([24, 8]);
    expect(r(FACE_SUBPALETTE_RANGES.eyes)).toEqual([32, 8]);
  });
});

// ── the real 1999 portal ────────────────────────────────────────────────

const PORTAL_1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat');

describe.skipIf(!existsSync(PORTAL_1999))('the 1999 retail portal: the default Aluvian male', () => {
  let am: AppearanceManager;
  let builder: CharacterModelBuilder;
  let sex: SexCG;
  beforeAll(() => {
    const world = new DatDatabase(new FileDatBytes(PORTAL_1999));
    world.setOverlay(ac1999PortalOverlay());
    am = new AppearanceManager(world);
    builder = new CharacterModelBuilder(world, null as never, new ClothingRenderer(world, null as never, null as never, null as never), am);
    sex = builder.getSexCG(Heritage.Aluvian, Gender.Male)!;
  });

  it('every 1999 palette has 256 entries', () => {
    expect(am.loadPaletteColors(0x0400007e)!.length).toBe(256);
    expect(am.loadPaletteColors(0x040002b8)!.length).toBe(256);
  });

  it('the world path: skin 0x040002B8 over (0, 0x18) no longer paints its greens / reds over the shirt [40,64) and trousers [64,72)', () => {
    const base = am.loadPaletteColors(0x0400007e)!;
    const out = buildAppearanceOverrides({
      basePalette: 0x0400007e,
      subPalettes: [{ paletteId: 0x040002b8, offset: 0, length: 0x18 * 8 }],
      textureChanges: [], animPartChanges: [],
    }, (id) => am.loadPaletteColors(id)).paletteColors!;
    const skin = am.loadPaletteColors(0x040002b8)!;
    for (let i = 0; i < 24; i++) expect(out[i]).toBe(skin[i]);
    for (let i = 40; i < 72; i++) expect(out[i]).toBe(base[i]);
  });

  it('the preview: the eye palette lands at [32,40) of the 256-entry composite', () => {
    const appearance = { eyes: 0, nose: 0, mouth: 0, hairColor: 0, eyeColor: 0, hairStyle: 0, hairShade: 0, skinShade: 0 } as unknown as AppearanceInfo;
    const out = (builder as unknown as { buildCompositePalette(s: SexCG, a: AppearanceInfo): number[] }).buildCompositePalette(sex, appearance);
    expect(out.length).toBe(256);
    const eyes = am.loadPaletteColors(sex.eyeColorList[0])!;
    for (let i = 32; i < 40; i++) expect(out[i]).toBe(eyes[i]);
  });
});
