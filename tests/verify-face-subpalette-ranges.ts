/**
 * BUG.barber-hair-preview-colour — the barber / chargen 3D preview and the
 * in-world player disagreed about one character's hair: +Fxprobe Three
 * (Aluvian male, HairPaletteDID 0x04001FD8 = hair colour 2, shade 0) drew
 * BLACK in the world but GINGER in the barber preview.
 *
 * Retail: every face colour is a Subpalette over a FIXED range of the
 * character's palette, applied index for index by Palette::Modify @ 0053e160
 * (dest[i] = src[i]). ACCharGenData::GenerateBaseAppearanceData @ 005c28d0
 * and gmCG3DView::Update @ 004ee9d0 build skin over 0..0xBF, hair over
 * 0xC0..0xFF (PalSet(mHairColorList[hairColor]).GetPaletteID(hairShade)),
 * eyes over 0x100..0x13F (mEyeColorList[eyeColor]); ACE sends the same
 * ranges for a player (WorldObject_Networking.cs, wire bytes × 8). The hair
 * meshes' texels index 0xC0..0xFF.
 *
 * The world path (buildAppearanceOverrides) already did that. The preview
 * (CharacterModelBuilder) looked for the ranges in the CharGen hair-style /
 * eye-strip / base ObjDescs, which carry no sub-palettes in the EoL DAT, so
 * it never applied skin, hair or eye colour and the hair showed the base
 * palette 0x0400007E's 0xC0..0xFF — auburn.
 */
import { existsSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { Gender, Heritage } from '@ac/shared';
import type { AppearanceInfo } from '@ac/shared';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import type { SexCG } from '@ac/dat-parser/file-types/CharacterGenerator.js';
import {
  buildAppearanceOverrides, modifyPalette, FACE_SUBPALETTE_RANGES,
} from '../packages/renderer/src/models/AppearanceOverrides.js';
import { CharacterModelBuilder } from '../packages/renderer/src/models/CharacterModelBuilder.js';
import { ClothingRenderer } from '../packages/renderer/src/models/ClothingRenderer.js';
import { AppearanceManager } from '../packages/renderer/src/models/AppearanceManager.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { openDat } from './_harness/dat.js';

describe('Palette::Modify — sub-palettes copy index for index over fixed face ranges', () => {
  it('copies src[i] into dest[i] over [offset, offset + numColors) only', () => {
    const dest = Array.from({ length: 16 }, () => 0);
    const src = Array.from({ length: 16 }, (_, i) => 100 + i);
    expect(modifyPalette(dest, src, 4, 3)).toBe(true);
    expect(dest).toEqual([0, 0, 0, 0, 104, 105, 106, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('refuses a range that runs past the destination palette, leaving it untouched', () => {
    const dest = [1, 2, 3, 4];
    expect(modifyPalette(dest, [9, 9, 9, 9, 9, 9], 2, 3)).toBe(false);
    expect(dest).toEqual([1, 2, 3, 4]);
  });

  it('retail\'s face ranges: skin 0..0xBF, hair 0xC0..0xFF, eyes 0x100..0x13F (ACE: 0x0/0x18, 0x18/0x8, 0x20/0x8 × 8)', () => {
    expect(FACE_SUBPALETTE_RANGES.skin).toEqual({ offset: 0x00 * 8, numColors: 0x18 * 8 });
    expect(FACE_SUBPALETTE_RANGES.hair).toEqual({ offset: 0x18 * 8, numColors: 0x08 * 8 });
    expect(FACE_SUBPALETTE_RANGES.eyes).toEqual({ offset: 0x20 * 8, numColors: 0x08 * 8 });
  });

  it('buildAppearanceOverrides applies a wire sub-palette index for index', () => {
    const pals = new Map<number, number[]>([
      [0x04000001, Array.from({ length: 2048 }, () => 1)],
      [0x04000002, Array.from({ length: 2048 }, (_, i) => 0x1000 + i)],
    ]);
    const ov = buildAppearanceOverrides(
      { basePalette: 0x04000001, subPalettes: [{ paletteId: 0x04000002, offset: 192, length: 64 }], textureChanges: [], animPartChanges: [] },
      (id) => pals.get(id),
    );
    expect(ov.paletteColors![191]).toBe(1);
    expect(ov.paletteColors![192]).toBe(0x1000 + 192);
    expect(ov.paletteColors![255]).toBe(0x1000 + 255);
    expect(ov.paletteColors![256]).toBe(1);
  });
});

const PORTAL_DAT = 'dat/client_portal.dat';
const PLAYER_PALETTE_BASE = 0x0400007e;
const FXPROBE_HAIR_PALETTE = 0x04001fd8; // ACE biota_properties_d_i_d type 15 for +Fxprobe Three
const HAIR_TEXTURE = 0x05003031; // hair style 2's (GfxObj 0x010047F8) hair surface 0x080016A3

function appearance(over: Partial<AppearanceInfo> = {}): AppearanceInfo {
  return {
    hairStyle: 2, hairColor: 2, eyesStrip: 0, eyeColor: 0, skinColor: 0, noseStyle: 0, mouthStyle: 0,
    headgearStyle: -1, headgearColor: 0, shirtStyle: -1, shirtColor: 0, pantsStyle: -1, pantsColor: 0,
    footwearStyle: -1, footwearColor: 0, skinHue: 0.3, hairHue: 1 / 13, ...over,
  };
}

const rgbOf = (c: number) => [(c >>> 16) & 255, (c >>> 8) & 255, c & 255];

describe.skipIf(!existsSync(PORTAL_DAT))('real DAT: the preview and the world draw the same hair for the same palette', () => {
  let db: DatDatabase;
  let am: AppearanceManager;
  let tm: TextureManager;
  let builder: CharacterModelBuilder;
  let sex: SexCG;

  beforeAll(() => {
    db = openDat(PORTAL_DAT);
    am = new AppearanceManager(db);
    tm = new TextureManager(db);
    builder = new CharacterModelBuilder(db, null as never, new ClothingRenderer(db, null as never, null as never, null as never), am);
    sex = builder.getSexCG(Heritage.Aluvian, Gender.Male)!;
  });

  const preview = (a: AppearanceInfo): number[] =>
    (builder as unknown as { buildCompositePalette(s: SexCG, a: AppearanceInfo): number[] }).buildCompositePalette(sex, a);

  /** What ACE sends for the player (WorldObject_Networking.cs) through the live world path. */
  const world = (skin: number, hair: number, eyes: number): number[] => buildAppearanceOverrides({
    basePalette: PLAYER_PALETTE_BASE,
    subPalettes: [
      { paletteId: hair, offset: 0x18 * 8, length: 0x8 * 8 },
      { paletteId: skin, offset: 0, length: 0x18 * 8 },
      { paletteId: eyes, offset: 0x20 * 8, length: 0x8 * 8 },
    ],
    textureChanges: [], animPartChanges: [],
  }, (id) => am.loadPaletteColors(id)).paletteColors!;

  it('the CharGen ObjDescs carry no face sub-palettes — the ranges must be the fixed ones', () => {
    expect(sex.baseObjDesc.subPalettes).toHaveLength(0);
    for (const h of sex.hairStyleList) expect(h.objDesc.subPalettes).toHaveLength(0);
  });

  it('+Fxprobe Three: colour 2 shade 1/13 is HairPaletteDID 0x04001FD8, whose 0xC0..0xFF is pure black', () => {
    const set = am.loadPaletteSet(sex.hairColorList[2])!;
    expect(set.getPaletteId(1 / 13)).toBe(FXPROBE_HAIR_PALETTE); // barber hairColorFromId shade (j + 1) / n
    expect(set.getPaletteId(0)).toBe(FXPROBE_HAIR_PALETTE);
    const hair = am.loadPaletteColors(FXPROBE_HAIR_PALETTE)!;
    for (let i = 0xc0; i < 0x100; i++) expect(hair[i] & 0xffffff).toBe(0);
    // The base palette's hair range (what the old preview showed) is auburn.
    const base = am.loadPaletteColors(PLAYER_PALETTE_BASE)!;
    const [r, , b] = rgbOf(base[0xd0]);
    expect(r).toBeGreaterThan(80);
    expect(r).toBeGreaterThan(b * 2);
  });

  it('the hair texture indexes only the hair range 0xC0..0xFF', () => {
    const idx = Array.from({ length: 2048 }, (_, i) => (0xff000000 | i) >>> 0);
    const out = tm.getRGBAWithPalette(HAIR_TEXTURE, idx)!;
    for (let i = 0; i < out.data.length; i += 4) {
      const k = (out.data[i + 1] << 8) | out.data[i + 2];
      expect(k >= 0xc0 && k < 0x100).toBe(true);
    }
  });

  it('preview and world give identical skin, hair and eye ranges and identical hair texels — black for 0x04001FD8', () => {
    const a = appearance();
    const skin = am.loadPaletteSet(sex.skinPalSet)!.getPaletteId(a.skinHue!);
    const eyes = sex.eyeColorList[a.eyeColor];
    const p = preview(a);
    const w = world(skin, FXPROBE_HAIR_PALETTE, eyes);
    expect(p.slice(0, 0x140)).toEqual(w.slice(0, 0x140));

    const pTex = tm.getRGBAWithPalette(HAIR_TEXTURE, p)!.data;
    const wTex = tm.getRGBAWithPalette(HAIR_TEXTURE, w)!.data;
    expect(Array.from(pTex)).toEqual(Array.from(wTex));
    let max = 0;
    for (let i = 0; i < pTex.length; i += 4) max = Math.max(max, pTex[i], pTex[i + 1], pTex[i + 2]);
    expect(max).toBe(0);
  });

  it('the preview follows the picked colour and shade: colour 3 (red) at full shade is red, colour 2 at full shade is grey', () => {
    const red = preview(appearance({ hairColor: 3, hairHue: 1 }));
    const redPal = am.loadPaletteColors(am.loadPaletteSet(sex.hairColorList[3])!.getPaletteId(1))!;
    for (let i = 0xc0; i < 0x100; i++) expect(red[i]).toBe(redPal[i]);
    const [r, g] = rgbOf(red[0xe0]);
    expect(r).toBeGreaterThan(g * 2);

    const grey = preview(appearance({ hairColor: 2, hairHue: 1 }));
    const [gr, gg, gb] = rgbOf(grey[0xe0]);
    expect(gr).toBeGreaterThan(120);
    expect(Math.abs(gr - gg) + Math.abs(gg - gb)).toBeLessThan(8);
  });

  it('eye colour lands on 0x100..0x13F from mEyeColorList, whichever strip is worn', () => {
    // Colour 3 (0x040002BF) differs from the base palette over the whole eye
    // range (colour 1, 0x040004B0, happens to equal it), and no eye strip
    // carries a sub-palette of its own.
    const eyes = am.loadPaletteColors(sex.eyeColorList[3])!;
    const base = am.loadPaletteColors(PLAYER_PALETTE_BASE)!;
    expect(eyes.slice(0x100, 0x140)).not.toEqual(base.slice(0x100, 0x140));
    for (const strip of [0, 3]) {
      expect(sex.eyeStripList[strip].objDesc.subPalettes).toHaveLength(0);
      const p = preview(appearance({ eyesStrip: strip, eyeColor: 3 }));
      for (let i = 0x100; i < 0x140; i++) expect(p[i]).toBe(eyes[i]);
    }
  });
});
