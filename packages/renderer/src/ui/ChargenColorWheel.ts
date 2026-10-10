/**
 * VISUAL.chargen-swatch-colours — the chargen Appearance page's colour
 * wheel (template 0x2100004c:0x1000030c, instanced in 0x100003b9) as
 * gmCGAppearancePage draws it (decompiled EoL client,
 * reference/client-eol/decomp/acclient-decompiled.annotated.c).
 *
 * SPOT COLOURS — gmCGAppearancePage::SetSelection @ 0047e260 (:128744) fills
 * m_tColorWheel[i].iRed/iGreen/iBlue per part:
 *   - hair (Sex_CG.mHairColorList), headgear / shirt / trousers / footwear
 *     (CharGenState::Get*PalSetID — StoreColorInformation's per-item palette
 *     sets) and nose / mouth / skin (ONE spot: Sex_CG's skin PalSet): the
 *     spot is the AVERAGE over EVERY palette of the PalSet
 *     (PalSet::GetPaletteID_Integral(i), i < num_pals) of
 *     ClientCharGenState::GetColorFromPal(palette, SAMPLE) @ 00563990 =
 *     Palette::get_color32 = ARGB[SAMPLE]; channel sums are divided by
 *     num_pals (unsigned, truncating) :128966-128997. SAMPLE is the part's
 *     palette entry, `mov [esp+0x20], imm` @ 0047e388 (hair 0xd0),
 *     0047e488/e4e9/e542 (nose / mouth / skin 0xb0), 0047e62b/e6ab/e733
 *     (clothing 0x520).
 *   - eyes (Sex_CG.mEyeColorList — palettes, not sets): the single entry
 *     GetColorFromPal(palette, 0x103) (`push 0x103` @ 0047e3da) :128832.
 *   The shade does not enter the spot colour.
 *   Palette::InitLoad @ 0053e060 widens a 256-entry palette to 2048 at run
 *   time (every entry repeated 8×), so ARGB[i] of such a palette is raw[i >> 3].
 *
 * SPOT ART — DoColorSpots @ 0047d850 (:128244), for each of the 9 spots:
 * DBObj::GetDIDByEnum(0x1000000d / 0x1000000f, 7) — master enum 7 is UIASSET
 * (`push 0x7` @ 0047d870 / 0047d881) → ColorBullet / ColorEmpty. A spot
 * i < iNumColors is ColorBullet with SurfaceWindow::ReplaceColor @ 00441530
 * swapping every pixel that is exactly opaque black (RGBAColor(0,0,0,1)) for
 * the spot's colour (alpha 1); the others are plain ColorEmpty. The
 * iRed/255 → RGBAColor → GetColor32 (×255.0f @ 0x796188, ftol) round trip is
 * exact for 0..255.
 *
 * GRADIENT CIRCLE — DoGradDisk(bool) @ 0047da90 (:128363): enums 0x1000000e
 * ColorRing / 0x10000010 GradientPlug (UIASSET). DoGradDisk(false) blits
 * ColorRing then SurfaceWindow::BlitAndColor(.., Blit_Multiply, color32 of
 * m_tColorWheel[m_iCurColor]) with no mask → ColoringLoopNoScale<
 * BlitOp_Multiply<Fill, ARGB>> @ 00668c00 (:573883): strength 0xff → per
 * channel dst = ((src + (src != 0)) · dst) >> 8, alpha kept. The result is
 * m_pGradCircle (0x1000030e). DoGradDisk(true) — the Eyes part
 * (SetSelection's `cmp [esp+0x1fc], 2` @ 0047e84f) — shows GradientPlug
 * instead and hides the shade scroll 0x10000321.
 *
 * Which m_tColorWheel entry is which element: InitializePage (:130164) —
 * spot i = 0x1000030f + i, its pointer = 0x10000318 + i; SetColor @ 0047dd50
 * shows only the current colour's pointer.
 */
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { readDidMapper } from '@ac/dat-parser/file-types/DidMapper.js';
import { UIASSET_MASTER_ENUM } from './ItemIconComposite.js';

/** The palette entry each part's spot samples (SetSelection's local_1d8 / the eyes' push). */
export const CHARGEN_SPOT_SAMPLE = {
  hair: 0xd0,
  eyes: 0x103,
  skin: 0xb0,
  clothing: 0x520,
} as const;

/** m_tColorWheel[9]. */
export const COLOR_WHEEL_SPOT_COUNT = 9;

/** UIASSET enums DoColorSpots / DoGradDisk resolve (master enum 7). */
export const UIASSET_COLOR_BULLET = 0x1000000d;
export const UIASSET_COLOR_RING = 0x1000000e;
export const UIASSET_COLOR_EMPTY = 0x1000000f;
export const UIASSET_GRADIENT_PLUG = 0x10000010;

export interface WheelRect {
  readonly elementId: number;
  readonly x: number; readonly y: number; readonly width: number; readonly height: number;
}
export interface WheelSpotRect extends WheelRect {
  /** The spot's pointer arrow (m_tColorWheel[i].pPointer) and its media. */
  readonly pointer: WheelRect & { readonly media: number };
}

/** The wheel template root (0x2100004c:0x1000030c, 220x220 — the page's 0x100003b9). */
export const COLOR_WHEEL_TEMPLATE_ROOT = 0x1000030c;

/** 0x1000030c's spots, in m_tColorWheel order (InitializePage), offsets inside the 220x220 wheel. */
export const COLOR_WHEEL_SPOTS: readonly WheelSpotRect[] = [
  { elementId: 0x1000030f, x: 89, y: 6, width: 37, height: 44, pointer: { elementId: 0x10000318, x: 91, y: 39, width: 33, height: 29, media: 0x06004d47 } },
  { elementId: 0x10000310, x: 141, y: 18, width: 37, height: 44, pointer: { elementId: 0x10000319, x: 123, y: 49, width: 31, height: 30, media: 0x06004d48 } },
  { elementId: 0x10000311, x: 170, y: 68, width: 37, height: 44, pointer: { elementId: 0x1000031a, x: 145, y: 81, width: 34, height: 34, media: 0x06004d49 } },
  { elementId: 0x10000312, x: 163, y: 123, width: 37, height: 44, pointer: { elementId: 0x1000031b, x: 142, y: 120, width: 31, height: 32, media: 0x06004d4a } },
  { elementId: 0x10000313, x: 119, y: 165, width: 37, height: 44, pointer: { elementId: 0x1000031c, x: 108, y: 148, width: 36, height: 32, media: 0x06004d4b } },
  { elementId: 0x10000314, x: 57, y: 165, width: 37, height: 44, pointer: { elementId: 0x1000031d, x: 70, y: 149, width: 35, height: 32, media: 0x06004d4c } },
  { elementId: 0x10000315, x: 14, y: 123, width: 37, height: 44, pointer: { elementId: 0x1000031e, x: 40, y: 118, width: 29, height: 36, media: 0x06004d4d } },
  { elementId: 0x10000316, x: 8, y: 68, width: 37, height: 44, pointer: { elementId: 0x1000031f, x: 36, y: 78, width: 30, height: 35, media: 0x06004d4e } },
  { elementId: 0x10000317, x: 37, y: 18, width: 37, height: 44, pointer: { elementId: 0x10000320, x: 56, y: 50, width: 32, height: 31, media: 0x06004d4f } },
];

/** The rim behind the circle (0x1000030d, media 0x06004d44). */
export const COLOR_WHEEL_FRAME: WheelRect & { readonly media: number } = { elementId: 0x1000030d, x: 52, y: 54, width: 110, height: 112, media: 0x06004d44 };
/** m_pGradCircle (0x1000030e). */
export const COLOR_WHEEL_GRAD_CIRCLE: WheelRect = { elementId: 0x1000030e, x: 52, y: 54, width: 110, height: 112 };
/** m_pShadeScroll (0x10000321, type 11) and its thumb child (0x1, 33x21, media 0x06004d50). */
export const COLOR_WHEEL_SHADE_SCROLL: WheelRect & { readonly thumb: { readonly width: number; readonly height: number; readonly media: number } } = {
  elementId: 0x10000321, x: 90, y: 65, width: 33, height: 85, thumb: { width: 33, height: 21, media: 0x06004d50 },
};

export interface Rgb { readonly r: number; readonly g: number; readonly b: number }

export interface RgbaImage { width: number; height: number; data: Uint8Array }

/** Palette::get_color32 after Palette::InitLoad's 256 → 2048 widening; 0 outside the palette. */
export function paletteColor32(colors: readonly number[], index: number): number {
  const i = colors.length === 0x100 ? index >> 3 : index;
  return i >= 0 && i < colors.length ? colors[i] >>> 0 : 0;
}

/** One palette's entry as a spot colour (the eyes). */
export function paletteSpotColor(colors: readonly number[] | null | undefined, sample: number): Rgb | null {
  if (!colors) return null;
  const c = paletteColor32(colors, sample);
  return { r: (c >>> 16) & 0xff, g: (c >>> 8) & 0xff, b: c & 0xff };
}

/**
 * SetSelection's per-set average: Σ GetColorFromPal(pal_i, sample) / num_pals
 * over every palette of the set (a palette that fails to load contributes 0,
 * as GetColorFromPal returns 0). Null for an empty / missing set.
 */
export function palSetSpotColor(
  paletteIds: readonly number[] | null | undefined,
  sample: number,
  loadPalette: (paletteId: number) => readonly number[] | null | undefined,
): Rgb | null {
  if (!paletteIds || paletteIds.length === 0) return null;
  let r = 0, g = 0, b = 0;
  for (const id of paletteIds) {
    const colors = loadPalette(id);
    const c = colors ? paletteColor32(colors, sample) : 0;
    r += (c >>> 16) & 0xff; g += (c >>> 8) & 0xff; b += c & 0xff;
  }
  const n = paletteIds.length;
  return { r: Math.floor(r / n), g: Math.floor(g / n), b: Math.floor(b / n) };
}

/** `#rrggbb`. */
export function rgbCss(c: Rgb): string {
  return `#${((c.r << 16) | (c.g << 8) | c.b).toString(16).padStart(6, '0')}`;
}

/** SurfaceWindow::ReplaceColor @ 00441530: every pixel exactly `from` (RGBA bytes) becomes `to` (opaque). */
export function replaceColorRGBA(img: RgbaImage, from: readonly [number, number, number, number], to: Rgb): RgbaImage {
  const data = new Uint8Array(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === from[0] && data[i + 1] === from[1] && data[i + 2] === from[2] && data[i + 3] === from[3]) {
      data[i] = to.r; data[i + 1] = to.g; data[i + 2] = to.b; data[i + 3] = 0xff;
    }
  }
  return { width: img.width, height: img.height, data };
}

/** DoColorSpots: a ColorBullet with its opaque black (RGBAColor(0,0,0,1)) replaced by the spot colour. */
export function colorBulletRGBA(bullet: RgbaImage, color: Rgb): RgbaImage {
  return replaceColorRGBA(bullet, [0, 0, 0, 0xff], color);
}

/** BlitOp_Multiply<Fill, ARGB> at full strength: dst.c = ((c + (c != 0)) · dst.c) >> 8, alpha kept. */
export function multiplyChannel(src: number, dst: number): number {
  return ((src + (src !== 0 ? 1 : 0)) * dst) >> 8;
}

/** DoGradDisk(false): ColorRing multiplied by the current spot's colour. */
export function gradDiskRGBA(ring: RgbaImage, color: Rgb): RgbaImage {
  const data = new Uint8Array(ring.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = multiplyChannel(color.r, data[i]);
    data[i + 1] = multiplyChannel(color.g, data[i + 1]);
    data[i + 2] = multiplyChannel(color.b, data[i + 2]);
  }
  return { width: ring.width, height: ring.height, data };
}

/** The four UIASSET DIDs the wheel draws (0 when the DAT lacks one). */
export interface ColorWheelAssets {
  bullet: number;
  ring: number;
  empty: number;
  plug: number;
}

/** DBCache::GetDIDFromEnum's chain: header MasterMapID → master[7] UIASSET → the four enums. */
export function loadColorWheelAssets(
  db: { getFileData(id: number): ArrayBuffer | null | undefined },
  masterMapId: number,
): ColorWheelAssets | null {
  const read = (id: number | undefined) => {
    if (!id) return null;
    try {
      const data = db.getFileData(id);
      return data ? readDidMapper(new DatReader(data)) : null;
    } catch {
      return null;
    }
  };
  const master = read(masterMapId);
  const uiAsset = read(master?.client.enumToId.get(UIASSET_MASTER_ENUM));
  if (!uiAsset) return null;
  const did = (e: number) => uiAsset.client.enumToId.get(e) ?? 0;
  return {
    bullet: did(UIASSET_COLOR_BULLET), ring: did(UIASSET_COLOR_RING),
    empty: did(UIASSET_COLOR_EMPTY), plug: did(UIASSET_GRADIENT_PLUG),
  };
}

/** The shade scroll's thumb top (px inside the track) for a shade in [0, 1]. */
export function shadeThumbTop(shade: number): number {
  const s = COLOR_WHEEL_SHADE_SCROLL;
  return Math.round(Math.max(0, Math.min(1, shade)) * (s.height - s.thumb.height));
}

/** The shade for a pointer at `y` px inside the track (the thumb centred on it). */
export function shadeFromTrackY(y: number): number {
  const s = COLOR_WHEEL_SHADE_SCROLL;
  return Math.max(0, Math.min(1, (y - s.thumb.height / 2) / (s.height - s.thumb.height)));
}
