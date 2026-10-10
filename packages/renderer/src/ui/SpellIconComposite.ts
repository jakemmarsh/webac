/**
 * VISUAL.spell-icon-composite — ClientMagicSystem::CompositeSpellIcon
 * @ 00567550: the 32x32 surface GetSpellIcon @ 00568bf0 builds (and caches
 * per spell id) for every spell icon the client draws — the effects rows
 * (EffectInfoRegion @ 004f2560), spell shortcut / spellbook UIItems
 * (UIElement_UIItem::UIItem_SetIcon @ 004e2080), their drag icon
 * (UIElement_ItemList::PrepareDragIcon @ 004e2a50), the endowment underlay
 * (gmSpellcastingUI::UpdateEndowmentIcon @ 004c6120) and the spell examine
 * page (SpellExamineUI::ExamineSpell @ 004b6210). Each caller then draws it
 * with Blit_3Alpha.
 *
 * Retail (reference/client-eol/decomp/acclient-decompiled.annotated.c :349505):
 *   level = SpellFormula::GetPowerLevelOfPowerComponent()   // DeterminePowerLevelOfComponent(_comps[0])
 *   Blit(GetByEnum(level, 0x10000006, 0xc), Blit_Normal)     // master[0x10000006] = the scarab backdrops (0x2500000a)
 *   Blit(spell._iconID, Blit_4Alpha)
 *   ReplaceColor(RGBAColor(1,1,1,1) → GetByEnum(2 - (bitfield & 0x10 ? 1 : 0), 0x10000007, 0xc))
 *                                                            // master[0x10000007] = 0x2500000b: 1 Reversed, 2 NonReversed
 *   badge = bitfield & 0x2000 ? 4 (TargetFellowship) : bitfield & 0x8 ? 3 (TargetSelf) : none
 *   if badge: Blit(GetByEnum(badge, 0x10000007, 0xc), Blit_4Alpha)
 */
import {
  blankSurface, blit, fourChannelAlpha, readMapper, replaceWhite, srcCopy,
  type IconMapperSource, type IconRgba,
} from './ItemIconComposite.js';

/** Master-map enum → the power-level (scarab) backdrops, EnumIDMap 0x2500000a. */
export const SPELL_LEVEL_BACKGROUNDS_MASTER_ENUM = 0x10000006;
/** Master-map enum → the spell icon effects (tint + target badges), EnumIDMap 0x2500000b. */
export const SPELL_ICON_EFFECTS_MASTER_ENUM = 0x10000007;
/** 0x2500000b rows: the white-replace tints and the corner badges. */
export const SPELL_ICON_EFFECT_REVERSED = 1;
export const SPELL_ICON_EFFECT_NON_REVERSED = 2;
export const SPELL_ICON_EFFECT_TARGET_SELF = 3;
export const SPELL_ICON_EFFECT_TARGET_FELLOWSHIP = 4;

/** SpellFlags (ACE SpellFlags.cs) bits CompositeSpellIcon tests. */
export const SPELL_FLAG_SELF_TARGETED = 0x8;
export const SPELL_FLAG_REVERSED = 0x10;
export const SPELL_FLAG_FELLOWSHIP = 0x2000;

/**
 * MagicSystem::DeterminePowerLevelOfComponent @ 005bd240: the scarab's power
 * level (the 0x2500000a row) — components 1..6 (Lead..Pyreal) → 1..6,
 * 0x6e → 7, 0x70 → 8, 0xc0 → 9, 0xc1 → 10; anything else 0.
 */
export function determinePowerLevelOfComponent(componentId: number): number {
  switch (componentId >>> 0) {
    case 1: return 1;
    case 2: return 2;
    case 3: return 3;
    case 4: return 4;
    case 5: return 5;
    case 6: return 6;
    case 0x6e: return 7;
    case 0x70: return 8;
    case 0xc0: return 9;
    case 0xc1: return 10;
    default: return 0;
  }
}

/** The two EnumIDMaps CompositeSpellIcon reads. */
export interface SpellIconEnumMaps {
  /** power level → backdrop 0x06 DID. */
  levelBackgrounds: ReadonlyMap<number, number>;
  /** 1 Reversed / 2 NonReversed / 3 TargetSelf / 4 TargetFellowship → 0x06 DID. */
  effects: ReadonlyMap<number, number>;
}

/** The master map's two spell-icon tables; null when either is missing. */
export function loadSpellIconEnumMaps(db: IconMapperSource, masterMapId: number): SpellIconEnumMaps | null {
  const master = readMapper(db, masterMapId);
  if (!master) return null;
  const bg = readMapper(db, master.client.enumToId.get(SPELL_LEVEL_BACKGROUNDS_MASTER_ENUM));
  const fx = readMapper(db, master.client.enumToId.get(SPELL_ICON_EFFECTS_MASTER_ENUM));
  if (!bg || !fx) return null;
  return { levelBackgrounds: bg.client.enumToId, effects: fx.client.enumToId };
}

/** What CompositeSpellIcon reads off the CSpellBase. */
export interface SpellIconSpec {
  /** CSpellBase::_iconID. */
  iconDid: number;
  /** SpellFormula::_comps[0] — the decrypted first component (the scarab). */
  powerComponent: number;
  /** CSpellBase::_bitfield (SpellFlags). */
  bitfield: number;
}

/** The DIDs CompositeSpellIcon blits (0 = DBObj::Get returned null → skipped). */
export interface SpellIconDids {
  backgroundDid: number;
  iconDid: number;
  tintDid: number;
  badgeDid: number;
}

export function resolveSpellIconDids(spec: SpellIconSpec, maps: SpellIconEnumMaps): SpellIconDids {
  const level = determinePowerLevelOfComponent(spec.powerComponent);
  const bits = spec.bitfield >>> 0;
  const tint = (bits & SPELL_FLAG_REVERSED) !== 0 ? SPELL_ICON_EFFECT_REVERSED : SPELL_ICON_EFFECT_NON_REVERSED;
  const badge = (bits & SPELL_FLAG_FELLOWSHIP) !== 0 ? SPELL_ICON_EFFECT_TARGET_FELLOWSHIP
    : (bits & SPELL_FLAG_SELF_TARGETED) !== 0 ? SPELL_ICON_EFFECT_TARGET_SELF : 0;
  return {
    backgroundDid: maps.levelBackgrounds.get(level) ?? 0,
    iconDid: spec.iconDid >>> 0,
    tintDid: maps.effects.get(tint) ?? 0,
    badgeDid: badge ? (maps.effects.get(badge) ?? 0) : 0,
  };
}

/** Cache key for one composite. */
export function spellIconKey(d: SpellIconDids): string {
  return `${d.backgroundDid}:${d.iconDid}:${d.tintDid}:${d.badgeDid}`;
}

/** The decoded layers (null = that DID resolved to no image). */
export interface SpellIconLayers {
  background: IconRgba | null;
  icon: IconRgba | null;
  tint: IconRgba | null;
  badge: IconRgba | null;
}

/** CompositeSpellIcon's surface from the decoded layers. */
export function compositeSpellIcon(layers: SpellIconLayers): IconRgba {
  const out = blankSurface();
  blit(out, layers.background, srcCopy);
  blit(out, layers.icon, fourChannelAlpha);
  replaceWhite(out, layers.tint);
  blit(out, layers.badge, fourChannelAlpha);
  return out;
}
