/**
 * CORE.18.c.a — IconData::RenderIcons @ 0058d180: the ONE compositor every
 * retail UIItem icon goes through (inventory grid, pack strips, paperdoll,
 * container / vendor / trade / salvage lists, toolbar shortcuts).
 *
 * Retail (reference/client-eol/decomp/acclient-decompiled.annotated.c :382722,
 * operands recovered from acclient.exe @ 0058d1e5-0058d260):
 *   m_idIcon           = obj->InqIconID()                  (vtable +0x64)
 *   m_idCustomOverlay  = pwd._iconOverlayID
 *   m_idCustomUnderlay = pwd._iconUnderlayID
 *   m_itemType         = obj->InqType()                    (vtable +0x18)
 *   m_effects          = pwd._effects                      (UiEffects)
 *   if (obj->IsThePlayer())                                (vtable +0x14 = 0058c3d0)
 *     m_idIcon   = DBObj::GetDIDByEnum(0x10000004, 7)      // master[7] UIASSET → PlayerIcon
 *     m_itemType = TYPE_CONTAINER (0x200)
 *   background = DBObj::GetByEnum(LowestSetBit(m_itemType)+1 (0 → 0x21), 0x10000004, 0xc)
 *                // master[0x10000004] = UIIconBackgrounds (DidMapper 0x25000008)
 *   effects    = DBObj::GetByEnum(LowestSetBit(m_effects)+1, 0x10000005, 0xc)
 *                ?? DBObj::GetByEnum(0x21, 0x10000005, 0xc)
 *                // master[0x10000005] = UIEffectIcons (DidMapper 0x25000009)
 *   surface 1 (m_pDragIcon, 32x32):
 *     icon Blit_Normal; overlay Blit_4Alpha;
 *     ReplaceColor(RGBAColor(1,1,1,1) → the effects surface)   // SurfaceWindow::ReplaceColor @ 004415b0
 *   surface 2 (m_pIcon, 32x32):
 *     background Blit_Normal; underlay Blit_3Alpha; surface 1 Blit_3Alpha
 *
 * UIElement_UIItem::UIItem_SetIcon @ 004e2080 draws GetIcon (surface 2) with
 * Blit_Normal; the drag paths (UIElement_ItemList::PrepareDragIcon @ 004e2a50,
 * gmPaperDollUI::PrepareDragIcon @ 004a4580, the SmartBox drag @ 004e58f0) and
 * gmSpellcastingUI::UpdateEndowmentIcon @ 004c6120 use GetDragIcon (surface 1).
 *
 * The blit ops (SoftwareBlitAndColor @ 00660300, ARGB→ARGB loops):
 *   SrcCopy           @ 00660420 — all four channels copied.
 *   ThreeChannelAlpha @ 006606c0 — a = src alpha; a==0 skip; a==255 → dst.rgb = src.rgb;
 *                                  else dst.c = dst.c − ((dst.c·(a+1))>>8) + ((src.c·(a+1))>>8);
 *                                  dst alpha is kept.
 *   FourChannelAlpha  @ 0066bd70 — a==0 skip; a==255 or dst alpha 0 → dst = src; else the
 *                                  non-premultiplied "over": A' = (da+1) + w − (((da+1)·w)>>8),
 *                                  dst.c = round(dst.c − (dst.c − src.c)·w / A'), dst.a = A'−1.
 */
import type { DidMapper } from '@ac/dat-parser/file-types/DidMapper.js';
import { readDidMapper } from '@ac/dat-parser/file-types/DidMapper.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { AC1999_OVERLAY_KIND } from '@ac/dat-parser/era1999/Ac1999Overlay.js';

/** Master-map enum → UIIconBackgrounds (the per-ITEM_TYPE backdrops). */
export const UI_ICON_BACKGROUNDS_MASTER_ENUM = 0x10000004;
/** Master-map enum → UIEffectIcons (the UiEffects outline tints). */
export const UI_EFFECT_ICONS_MASTER_ENUM = 0x10000005;
/** Master-map enum → UIASSET (GetDIDByEnum(.., 0x10000004, 7) — push 7 @ 0058d1f0). */
export const UIASSET_MASTER_ENUM = 7;
/** UIASSET enum → PlayerIcon (the player's own pack icon). */
export const UIASSET_PLAYER_ICON_ENUM = 0x10000004;
/** The "Default" row both tables carry (RenderIcons' 0x21 fallbacks). */
export const ICON_ENUM_DEFAULT = 0x21;
/** ITEM_TYPE TYPE_CONTAINER — IsThePlayer forces it (mov [esi+0x18], 0x200 @ 0058d209). */
export const ITEM_TYPE_CONTAINER = 0x200;
/** RenderIcons' surfaces are 32x32 (CreateSurface(0x20, 0x20, ..)). */
export const ICON_SIZE = 32;

/** LowestSetBit @ 00684460: the index of the lowest set bit, -1 for 0. */
export function lowestSetBit(v: number): number {
  for (let i = 0; i < 32; i++) if (((v >>> i) & 1) !== 0) return i;
  return -1;
}

/** The two EnumIDMaps + the PlayerIcon DID RenderIcons reads. */
export interface IconEnumMaps {
  /** UIIconBackgrounds: enum (LowestSetBit(itemType)+1 / 0x21) → 0x06 DID. */
  backgrounds: ReadonlyMap<number, number>;
  /** UIEffectIcons: enum (LowestSetBit(effects)+1 / 0x21) → 0x06 DID. */
  effects: ReadonlyMap<number, number>;
  /** UIASSET[0x10000004] — 0 when the DAT lacks it. */
  playerIconDid: number;
}

export interface IconMapperSource {
  getFileData(id: number): ArrayBuffer | null | undefined;
}

export function readMapper(db: IconMapperSource, id: number | undefined): DidMapper | null {
  if (!id) return null;
  try {
    const data = db.getFileData(id);
    return data ? readDidMapper(new DatReader(data)) : null;
  } catch {
    return null;
  }
}

/**
 * DBCache::GetDIDFromEnum @ 00413940's chain for the three tables: the DAT
 * header's MasterMapID (0x25000000) names each EnumIDMap by master enum.
 * Null when the master map or either icon table is missing.
 */
export function loadIconEnumMaps(db: IconMapperSource, masterMapId: number): IconEnumMaps | null {
  const master = readMapper(db, masterMapId);
  if (!master) return null;
  const bg = readMapper(db, master.client.enumToId.get(UI_ICON_BACKGROUNDS_MASTER_ENUM));
  const fx = readMapper(db, master.client.enumToId.get(UI_EFFECT_ICONS_MASTER_ENUM));
  if (!bg || !fx) return null;
  const uiAsset = readMapper(db, master.client.enumToId.get(UIASSET_MASTER_ENUM));
  return {
    backgrounds: bg.client.enumToId,
    effects: fx.client.enumToId,
    playerIconDid: uiAsset?.client.enumToId.get(UIASSET_PLAYER_ICON_ENUM) ?? 0,
  };
}

/** What RenderIcons reads off the ACCWeenieObject. */
export interface ItemIconSpec {
  iconDid: number;
  overlayDid?: number;
  underlayDid?: number;
  /** ITEM_TYPE mask (InqType); 0 / undefined → the 0x21 Default backdrop. */
  itemType?: number;
  /** UiEffects mask (pwd._effects); 0 / undefined → the 0x21 Default tint. */
  effects?: number;
  /** ACCWeenieObject::IsThePlayer — the main-pack cell (the player object). */
  isThePlayer?: boolean;
}

/** The DIDs RenderIcons blits (0 = DBObj::Get returned null → that blit is skipped). */
export interface RenderIconsDids {
  iconDid: number;
  overlayDid: number;
  underlayDid: number;
  itemType: number;
  backgroundDid: number;
  effectsDid: number;
}

/** RenderIcons' DID resolution (the IsThePlayer swap, both enum lookups + fallbacks). */
export function resolveRenderIconsDids(spec: ItemIconSpec, maps: IconEnumMaps): RenderIconsDids {
  let iconDid = spec.iconDid >>> 0;
  let itemType = (spec.itemType ?? 0) >>> 0;
  if (spec.isThePlayer) {
    iconDid = maps.playerIconDid;
    itemType = ITEM_TYPE_CONTAINER;
  }
  let bgEnum = lowestSetBit(itemType) + 1;
  if (bgEnum === 0) bgEnum = ICON_ENUM_DEFAULT;
  const backgroundDid = maps.backgrounds.get(bgEnum) ?? 0;
  const fxEnum = lowestSetBit((spec.effects ?? 0) >>> 0) + 1;
  // GetByEnum(0 or an unmapped row) → DBObj::Get(INVALID_DID) = null → the 0x21 row.
  const effectsDid = (maps.effects.get(fxEnum) || maps.effects.get(ICON_ENUM_DEFAULT)) ?? 0;
  return {
    iconDid, overlayDid: (spec.overlayDid ?? 0) >>> 0, underlayDid: (spec.underlayDid ?? 0) >>> 0,
    itemType, backgroundDid, effectsDid,
  };
}

/** RGBA pixels, row-major, 4 bytes per pixel (R, G, B, A). */
export interface IconRgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** The decoded layers (null = that DID resolved to no image). */
export interface RenderIconsLayers {
  icon: IconRgba | null;
  overlay: IconRgba | null;
  underlay: IconRgba | null;
  background: IconRgba | null;
  effects: IconRgba | null;
}

export interface RenderedIcons {
  /** m_pIcon — the UIItem cell image. */
  icon: IconRgba;
  /** m_pDragIcon — the drag / endowment image. */
  dragIcon: IconRgba;
}

export function blankSurface(): IconRgba {
  return { width: ICON_SIZE, height: ICON_SIZE, data: new Uint8Array(ICON_SIZE * ICON_SIZE * 4) };
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export type BlitOp = (dst: Uint8Array, d: number, src: Uint8Array, s: number) => void;

/** BlitOp_SrcCopy — the four channels copied. */
export const srcCopy: BlitOp = (dst, d, src, s) => {
  dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
};

/** BlitOp_ThreeChannelAlpha — colour lerp by the source alpha; the destination keeps its alpha. */
export const threeChannelAlpha: BlitOp = (dst, d, src, s) => {
  const a = src[s + 3];
  if (a === 0) return;
  if (a === 255) {
    dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2];
    return;
  }
  const w = a + 1;
  for (let c = 0; c < 3; c++) {
    dst[d + c] = clamp8(dst[d + c] - ((dst[d + c] * w) >> 8) + ((src[s + c] * w) >> 8));
  }
};

/** BlitOp_FourChannelAlpha — the non-premultiplied "over", alpha included. */
export const fourChannelAlpha: BlitOp = (dst, d, src, s) => {
  const a = src[s + 3];
  if (a === 0) return;
  const da = dst[d + 3];
  if (a === 255 || da === 0) {
    srcCopy(dst, d, src, s);
    return;
  }
  const w = a + 1;
  const outA = (da + 1) + w - (((da + 1) * w) >> 8);
  for (let c = 0; c < 3; c++) {
    dst[d + c] = clamp8(Math.round(dst[d + c] - ((dst[d + c] - src[s + c]) * w) / outA));
  }
  dst[d + 3] = clamp8(outA - 1);
};

/** SurfaceWindow::Blit — the source at (0,0), clipped to both surfaces. */
export function blit(dst: IconRgba, src: IconRgba | null, op: BlitOp): void {
  if (!src) return;
  const w = Math.min(dst.width, src.width);
  const h = Math.min(dst.height, src.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) op(dst.data, (y * dst.width + x) * 4, src.data, (y * src.width + x) * 4);
  }
}

/**
 * SurfaceWindow::ReplaceColor(RGBAColor*, SurfaceWindow*) @ 004415b0: every
 * pixel whose 32-bit colour equals RGBAColor(1,1,1,1) — opaque white — takes
 * the replacement surface's pixel at the same position. Refused (no change)
 * when the replacement is smaller than the target.
 */
export function replaceWhite(dst: IconRgba, repl: IconRgba | null): void {
  if (!repl || repl.width < dst.width || repl.height < dst.height) return;
  const p = dst.data;
  for (let y = 0; y < dst.height; y++) {
    for (let x = 0; x < dst.width; x++) {
      const i = (y * dst.width + x) * 4;
      if (p[i] === 255 && p[i + 1] === 255 && p[i + 2] === 255 && p[i + 3] === 255) {
        const j = (y * repl.width + x) * 4;
        p[i] = repl.data[j]; p[i + 1] = repl.data[j + 1]; p[i + 2] = repl.data[j + 2]; p[i + 3] = repl.data[j + 3];
      }
    }
  }
}

/** IconData::RenderIcons' two surfaces from the decoded layers. */
export function renderIcons(layers: RenderIconsLayers): RenderedIcons {
  const drag = blankSurface();
  blit(drag, layers.icon, srcCopy);
  blit(drag, layers.overlay, fourChannelAlpha);
  replaceWhite(drag, layers.effects);

  const icon = blankSurface();
  blit(icon, layers.background, srcCopy);
  blit(icon, layers.underlay, threeChannelAlpha);
  blit(icon, drag, threeChannelAlpha);
  return { icon, dragIcon: drag };
}

/**
 * The 1999 world's icons (its 0x06 Textures, Textures1999.ts) are bare RGB
 * with no alpha channel: pure black (0,0,0) is the transparent key. Measured
 * against the end-of-retail portal (every 32x32 0x06 id in both DATs, 1,800
 * icons): 1,588 match the rule pixel for pixel — each pure-black 1999 pixel is
 * exactly an alpha-0 pixel of the EoL icon, every other pixel opaque — and
 * the rest differ by a few retouched pixels. Read opaque, a 1999 icon is a
 * black square that hides RenderIcons' ITEM_TYPE backdrop and paints black
 * around the picture in every item cell, so a 1999 world's icons go through
 * this before they reach the compositor or an <img>.
 */
export function keyBlackTransparent(img: IconRgba): IconRgba {
  const data = new Uint8Array(img.data);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0) data[i + 3] = 0;
  }
  return { width: img.width, height: img.height, data };
}

/**
 * Whether a world portal serves 1999 icons (black-keyed, keyBlackTransparent):
 * the pre-ToD file itself, or any DAT (a streamed 1999 world set included)
 * wearing the 1999 overlay. False for end of retail and the classic eras.
 */
export function worldIconsBlackKeyed(worldPortal: { container?: string; overlayKind?: string | null } | null | undefined): boolean {
  return !!worldPortal && (worldPortal.container === 'pre-tod' || worldPortal.overlayKind === AC1999_OVERLAY_KIND);
}

/** Cache key for one (icon, overlay, underlay, type, effects) render. */
export function renderIconsKey(d: RenderIconsDids): string {
  return `${d.iconDid}:${d.overlayDid}:${d.underlayDid}:${d.backgroundDid}:${d.effectsDid}`;
}

/** A PNG data URL for a rendered surface (TextureManager.rgbaToDataURL's canvas path); null without a 2D canvas. */
export function iconRgbaToDataURL(img: IconRgba): string | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imageData = ctx.createImageData(img.width, img.height);
  imageData.data.set(img.data);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}
