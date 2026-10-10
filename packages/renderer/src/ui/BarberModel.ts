/**
 * GAP.barber-ui-retail — the barber's state machine: `gmBarberUI` as the
 * decompiled EoL client runs it (reference/client-eol/decomp/
 * acclient-decompiled.annotated.c; docs/retail-client-symbols.md). No DOM
 * and no three.js here: BarberPanel.ts paints the DAT layout from this
 * model and feeds the clicks back in.
 *
 * Where it lives. `gmBarberUI` (UIElement type 0x1000004a, registered by
 * `Register @ 004de600`) is LayoutDesc 0x21000068 (UILAYOUT enum 0x10000099
 * "classic_barber") root 0x10000599, 500x440, instanced into the smartbox
 * layout 0x2100000f as 0x10000598 at (20, 20) of the 800x600 3D view —
 * hidden until `RecvNotice_StartBarberNotice @ 004e0ec0` runs
 * `InitializePage` with the server's 16 StartBarber fields, refreshes the
 * view and shows the page.
 *
 * The page edits the player's face through a `CharGenState` it rebuilds
 * from those fields (`InitializePage @ 004e0040`):
 *   - RandomizeCharacter(true) + SetHeadgearStyle(−1) (the preview's
 *     clothes), then the player's PlayerDesc gender (0x71) and heritage
 *     (0xbc);
 *   - SetupParts @ 004debf0: m_tChoices[0..3] = hair styles / eye strips /
 *     nose strips / mouth strips of the Sex_CG, colour counts for hair and
 *     eyes;
 *   - the indices recovered from the DIDs by ACCharGenData::GetHairIndexFromID
 *     @ 005c2dd0 (head object, bald = hair texture == BALD_TEXTURE),
 *     GetEyeStripIndexFromID @ 005c2f00 (eyes texture, skeleton, bald),
 *     GetNose/MouthStripIndexFromID @ 005c3070 / 005c3190 (skeleton),
 *     GetHairColorFromID @ 005c33a0 (hair palette → colour + shade),
 *     GetSkinShadeFromID @ 005c32b0, GetEyeColorFromID @ 005c3500 — each
 *     followed by SetSelection(part) so the colour wheel follows;
 *   - "skeleton" = the server's setup is one of the four Undead SKELETON
 *     setups; such strips use their SECOND TextureMapChange.
 * Ghidra numbers InitializePage's parameters one off: the stack reads
 * (objdump of 004e0840–004e0a40: [esp+0x220] eyes, [esp+0x228] nose,
 * [esp+0x230] mouth, [esp+0x238] skin palette, [esp+0x23c] hair palette,
 * [esp+0x240] eyes palette, [esp+0x248] option1) are wire fields 5, 7, 9,
 * 11, 12, 13 and 15 of GameEventStartBarber.
 *
 * `Apply` (0x100005a6, ListenToElementMessage @ 004df260) rebuilds the DIDs
 * with ACCharGenData::GenerateBaseAppearanceData @ 005c28d0 and sends
 * CM_Character::Event_FinishBarber @ 006a1ec0 (the same 16 fields), after
 * the client-side Empyrean motion table / Undead flame / Shadow crown
 * effects; Cancel (0x100005a7) only hides the page. Retail prints nothing
 * on either.
 */
import type { SexCG, ObjDesc, TextureMapChange } from '@ac/dat-parser/file-types/CharacterGenerator.js';
import {
  CHARGEN_SPOT_SAMPLE, COLOR_WHEEL_SPOT_COUNT, palSetSpotColor, paletteSpotColor, type Rgb,
} from './ChargenColorWheel.js';
import { AppearanceViewController, type AcVec3 } from './ChargenAppearanceView.js';
import { appearanceRollLists, randomizeClothing, resetAppearance, type ChargenRandomSource } from './ChargenRandomize.js';
import type { AppearanceState } from './CharacterCreate.js';
import type { AppearanceInfo } from '@ac/shared';
import type { FinishBarberFields } from '@ac/network';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';

// ─── DAT anchors ──────────────────────────────────────────────────────────

/** LayoutDesc 0x21000068 ("classic_barber", UILAYOUT enum 0x10000099). */
export const BARBER_LAYOUT = 0x21000068;
/** The gmBarberUI root (type 0x1000004a), 500x440. */
export const BARBER_ROOT = 0x10000599;
/** The smartbox instance 0x2100000f:0x10000598 — (20, 20) inside the 800x600 3D view. */
export const BARBER_SMARTBOX_SLOT = { layout: 0x2100000f, elementId: 0x10000598, x: 20, y: 20 } as const;

/** gmBarberUI's element ids (InitializePage's GetChildRecursive calls). */
export const BARBER_ELEMENTS = {
  viewFrame: 0x1000059a,
  /** m_pViewport (type 13) → gmCG3DView. */
  viewport: 0x1000059b,
  /** The 0x2100004c:0x1000030c colour-wheel instance. */
  wheel: 0x1000059c,
  /** m_pFaceChoices. */
  faceChoices: 0x1000059d,
  hairRow: 0x1000059e,
  eyesRow: 0x1000059f,
  noseRow: 0x100005a0,
  mouthRow: 0x100005a1,
  skinRow: 0x100005a2,
  rotateClockwise: 0x100005a4,
  rotateCounterClockwise: 0x100005a5,
  apply: 0x100005a6,
  cancel: 0x100005a7,
  leftFrame: 0x100005a8,
  option1: 0x100005c9,
  option2: 0x100005ca,
  option3: 0x100005cb,
} as const;

/** The 0x2100004c:0x10000309 row template's arrows (−1 / +1). */
export const ROW_ARROW_PREV = 0x1000030a;
export const ROW_ARROW_NEXT = 0x1000030b;
/** The wheel template's elements (0x2100004c:0x1000030c). */
export const WHEEL_SPOT_BASE = 0x1000030f;
export const WHEEL_POINTER_BASE = 0x10000318;
export const WHEEL_GRAD_CIRCLE = 0x1000030e;
export const WHEEL_SHADE_SCROLL = 0x10000321;

/** UIElement states (EnumMapper 0x2200002F). */
export const STATE_NORMAL = 1;
export const STATE_HIGHLIGHT = 6;
export const STATE_GHOSTED = 0xd;

/** gmBarberUI::EParts. */
export enum BarberPart { Hair = 1, Eyes = 2, Nose = 3, Mouth = 4, Skin = 5 }

/** The row element of each part (m_pHairSpin … m_pSkinSpin). */
export const PART_ROW: Readonly<Record<BarberPart, number>> = {
  [BarberPart.Hair]: BARBER_ELEMENTS.hairRow,
  [BarberPart.Eyes]: BARBER_ELEMENTS.eyesRow,
  [BarberPart.Nose]: BARBER_ELEMENTS.noseRow,
  [BarberPart.Mouth]: BARBER_ELEMENTS.mouthRow,
  [BarberPart.Skin]: BARBER_ELEMENTS.skinRow,
};

/** Heritage groups the page special-cases (ACE HeritageGroup). */
export const HERITAGE = {
  Shadowbound: 5, Gearknight: 6, Empyrean: 9, Penumbraen: 10, Undead: 11, Olthoi: 12, OlthoiAcid: 13,
} as const;
/** ACE Gender.Female (the decomp's `gender == 2`). */
export const GENDER_FEMALE = 2;

/** BALD_TEXTURE (globals.tsv 0x817274). */
export const BALD_TEXTURE = 0x050010b7;

/** The client-only setups and scripts Apply / the option checkbox pick (globals.tsv). */
export const BARBER_SETUPS = {
  undeadMaleSkeleton: 0x02001a9c, undeadMaleSkeletonNoFlame: 0x02001a9e,
  undeadMaleZombie: 0x02001a9d, undeadMaleZombieNoFlame: 0x02001a96,
  undeadFemaleSkeleton: 0x02001aa0, undeadFemaleSkeletonNoFlame: 0x02001a9f,
  undeadFemaleZombie: 0x02001aa1, undeadFemaleZombieNoFlame: 0x02001aa2,
  umbraenMaleCrown: 0x0200196f, umbraenFemaleCrown: 0x02001970,
  umbraenMaleNoCrown: 0x02001a5f, umbraenFemaleNoCrown: 0x02001a5e,
  penumbraenMaleCrown: 0x0200196e, penumbraenFemaleCrown: 0x0200196d,
  penumbraenMaleNoCrown: 0x02001a5d, penumbraenFemaleNoCrown: 0x02001a5c,
} as const;
/**
 * The PhysicsScripts Apply plays on the player. The *_NOFLAME_PES and
 * PENUMBRAEN_*_NOCROWN_PES globals live in .bss with no initializer (0 =
 * INVALID_DID): Apply plays nothing for them.
 */
export const BARBER_SCRIPTS = {
  undeadMaleSkeleton: 0x330012d4, undeadMaleZombie: 0x330012d3,
  undeadFemaleSkeleton: 0x330012d5, undeadFemaleZombie: 0x330012d6,
  undeadNoFlame: 0,
  umbraenMaleCrown: 0x33001256, umbraenFemaleCrown: 0x33001257,
  umbraenMaleNoCrown: 0x330012bb, umbraenFemaleNoCrown: 0x330012ba,
  penumbraenMaleCrown: 0x33001255, penumbraenFemaleCrown: 0x33001254,
  penumbraenNoCrown: 0,
} as const;
/** The Empyrean motion tables Apply sets locally (ACE GameEventStartBarber / Player_Character). */
export const EMPYREAN_MOTION = {
  male: 0x0900020e, female: 0x0900020d, maleFloat: 0x0900020b, femaleFloat: 0x0900020a,
} as const;

const UNDEAD_SKELETON_SETUPS: ReadonlySet<number> = new Set([
  BARBER_SETUPS.undeadMaleSkeleton, BARBER_SETUPS.undeadMaleSkeletonNoFlame,
  BARBER_SETUPS.undeadFemaleSkeleton, BARBER_SETUPS.undeadFemaleSkeletonNoFlame,
]);
const UNDEAD_ZOMBIE_SETUPS: ReadonlySet<number> = new Set([
  BARBER_SETUPS.undeadFemaleZombie, BARBER_SETUPS.undeadFemaleZombieNoFlame,
  BARBER_SETUPS.undeadMaleZombie, BARBER_SETUPS.undeadMaleZombieNoFlame,
]);
const UNDEAD_NOFLAME_SETUPS: ReadonlySet<number> = new Set([
  BARBER_SETUPS.undeadFemaleSkeletonNoFlame, BARBER_SETUPS.undeadFemaleZombieNoFlame,
  BARBER_SETUPS.undeadMaleZombieNoFlame, BARBER_SETUPS.undeadMaleSkeletonNoFlame,
]);

/** StringInfo tokens and their tables (enum 0x10000001 → 0x23000001, 0x10000002 → 0x23000002). */
export const BARBER_STRINGS = {
  empyreanOption: { token: 'ID_Barber_Empyrean_Earthbound', table: 0x23000001 },
  undeadOption: { token: 'ID_Barber_Undead_NoFlame', table: 0x23000001 },
  shadowOption: { token: 'ID_Barber_Shadow_NoCrown', table: 0x23000001 },
  gearHair: { token: 'ID_CharGen_GearText_HairButton', table: 0x23000002 },
  gearEyes: { token: 'ID_CharGen_GearText_EyesButton', table: 0x23000002 },
  gearSkin: { token: 'ID_CharGen_GearText_SkinButton', table: 0x23000002 },
  olthoiHair: { token: 'ID_CharGen_OlthoiText_HairButton', table: 0x23000002 },
  olthoiEyes: { token: 'ID_CharGen_OlthoiText_EyesButton', table: 0x23000002 },
  olthoiSkin: { token: 'ID_CharGen_OlthoiText_SkinButton', table: 0x23000002 },
} as const;
export type BarberStringKey = keyof typeof BARBER_STRINGS;

/** InitializePage's gmCG3DView::SetCamera positions (direction (0, 0, 0)). */
export const BARBER_CAMERA: AcVec3 = [0, -0.65, 1.7];
/** Gearknight / Olthoi: (0, −0.8, 1.5) (0xbf4ccccd, 0x3fc00000). */
export const BARBER_CAMERA_GEAR_OLTHOI: AcVec3 = [0, -0.8, 1.5];

/** Apply / Cancel positions (SetPosition, vtable +0x2c): row 274 without an option, 298 with one. */
export const BUTTON_ROW_Y = { plain: 0x112, withOption: 0x12a } as const;
export const APPLY_X = 0x160;
export const CANCEL_X = 0xe8;
/** Gearknight / Olthoi move the Skin row to (0, 0x58). */
export const SKIN_ROW_GEAR_OLTHOI_Y = 0x58;

// ─── The wire record ──────────────────────────────────────────────────────

/** GameEventStartBarber / GameActionFinishBarber — 14 DIDs + 2 longs (ACE field names). */
export interface BarberData {
  paletteBaseDID: number;
  headObjectDID: number;
  hairTexture: number; defaultHairTexture: number;
  eyesTextureDID: number; defaultEyesTextureDID: number;
  noseTextureDID: number; defaultNoseTextureDID: number;
  mouthTextureDID: number; defaultMouthTextureDID: number;
  skinPaletteDID: number; hairPaletteDID: number; eyesPaletteDID: number;
  setupTableId: number;
  option1: number; option2: number;
}

/** What Apply does to the player in the world before the server answers. */
export interface BarberLocalEffects {
  /** CPhysicsObj::SetMotionTableID (Empyrean). */
  motionTableId?: number;
  /** CPhysicsObj::destroy_particle_manager (Undead / Shadow). */
  destroyParticles: boolean;
  /** CPhysicsObj::play_script (0 = none). */
  playScript: number;
}

/** The FinishBarber GameAction's field names for a BarberData (wire order unchanged). */
export function finishBarberFields(d: BarberData): FinishBarberFields {
  return {
    paletteBaseId: d.paletteBaseDID, headObjectDID: d.headObjectDID,
    hairTexture: d.hairTexture, defaultHairTexture: d.defaultHairTexture,
    eyesTextureDID: d.eyesTextureDID, defaultEyesTextureDID: d.defaultEyesTextureDID,
    noseTextureDID: d.noseTextureDID, defaultNoseTextureDID: d.defaultNoseTextureDID,
    mouthTextureDID: d.mouthTextureDID, defaultMouthTextureDID: d.defaultMouthTextureDID,
    skinPaletteDID: d.skinPaletteDID, hairPaletteDID: d.hairPaletteDID, eyesPaletteDID: d.eyesPaletteDID,
    setupTableId: d.setupTableId, optionBound: d.option1, optionUnk: d.option2,
  };
}

/** What the world provides for Apply's effects and its send. */
export interface BarberApplySinks {
  /** CPhysicsObj::destroy_particle_manager on the player. */
  destroyPlayerParticles(): void;
  /** CPhysicsObj::play_script(did) on the player. */
  playPlayerScript(scriptDid: number): void;
  /** CM_Character::Event_FinishBarber. */
  finishBarber(fields: FinishBarberFields): void;
}

/**
 * Apply's world half, in ListenToElementMessage's order: the particle
 * manager goes, the script plays, then Event_FinishBarber — only when
 * GenerateBaseAppearanceData succeeded. (SetMotionTableID needs no sink:
 * ACE answers an Empyrean change with PrivateUpdateDataID MotionTable.)
 */
export function dispatchBarberApply(result: BarberApplyResult, sinks: BarberApplySinks): void {
  if (result.effects.destroyParticles) sinks.destroyPlayerParticles();
  if (result.effects.playScript) sinks.playPlayerScript(result.effects.playScript);
  if (result.fields) sinks.finishBarber(finishBarberFields(result.fields));
}

// ─── Palette access ───────────────────────────────────────────────────────

/** A PalSet: its palettes and PalSet::GetPaletteID(shade) @ 005ac570. */
export interface BarberPalSet {
  readonly paletteList: readonly number[];
  getPaletteId(shade: number): number;
}
export interface BarberPaletteSource {
  loadPaletteSet(id: number): BarberPalSet | null | undefined;
  loadPaletteColors(id: number): readonly number[] | null | undefined;
}

// ─── ACCharGenData lookups ────────────────────────────────────────────────

/** ObjDesc::GetTextureMapChange(n) @ 005ab600 — the nth change (append order = DAT order). */
export function textureMapChange(desc: ObjDesc | undefined, n: number): TextureMapChange | null {
  return desc && n >= 0 && n < desc.textureChanges.length ? desc.textureChanges[n] : null;
}

/** GetHairIndexFromID @ 005c2dd0: the style whose first AnimPartChange is the head and whose bald flag matches. */
export function hairIndexFromId(sex: SexCG, headObject: number, bald: boolean): number {
  if (headObject === 0) return 0;
  const i = sex.hairStyleList.findIndex((h) => h.objDesc.animPartChanges[0]?.partId === headObject && h.bald === bald);
  return i < 0 ? 0 : i;
}

/** GetEyeStripIndexFromID @ 005c2f00: (bald ? objDescBald : objDesc).TextureMapChange(skeleton ? 1 : 0).new. */
export function eyeStripIndexFromId(sex: SexCG, eyesTexture: number, skeleton: boolean, bald: boolean): number {
  if (eyesTexture === 0) return 0;
  const i = sex.eyeStripList.findIndex((e) => textureMapChange(bald ? e.objDescBald : e.objDesc, skeleton ? 1 : 0)?.newTexture === eyesTexture);
  return i < 0 ? 0 : i;
}

/** GetNoseStripIndexFromID @ 005c3070 / GetMouthStripIndexFromID @ 005c3190. */
export function faceStripIndexFromId(strips: SexCG['noseStripList'], texture: number, skeleton: boolean): number {
  if (texture === 0) return 0;
  const i = strips.findIndex((s) => textureMapChange(s.objDesc, skeleton ? 1 : 0)?.newTexture === texture);
  return i < 0 ? 0 : i;
}

/** GetSkinShadeFromID @ 005c32b0: (index + 1) / num_pals of the skin PalSet (0 for INVALID_DID). */
export function skinShadeFromId(sex: SexCG, skinPalette: number, pal: BarberPaletteSource): number {
  if (skinPalette === 0) return 0;
  const set = pal.loadPaletteSet(sex.skinPalSet);
  const n = set?.paletteList.length ?? 0;
  if (!set || n === 0) return 0;
  let i = 0;
  while (i < n && set.paletteList[i] !== skinPalette) i++;
  return (i + 1) / n;
}

/** GetHairColorFromID @ 005c33a0: the colour whose PalSet holds the palette, shade (j + 1) / num_pals; else 0 / 0. */
export function hairColorFromId(sex: SexCG, hairPalette: number, pal: BarberPaletteSource): { color: number; shade: number } {
  if (hairPalette === 0) return { color: 0, shade: 0 };
  for (let c = 0; c < sex.hairColorList.length; c++) {
    const set = pal.loadPaletteSet(sex.hairColorList[c]);
    if (!set) continue;
    const j = set.paletteList.indexOf(hairPalette);
    if (j >= 0) return { color: c, shade: (j + 1) / set.paletteList.length };
  }
  return { color: 0, shade: 0 };
}

/** GetEyeColorFromID @ 005c3500: the palette's index in mEyeColorList (0 when absent). */
export function eyeColorFromId(sex: SexCG, eyesPalette: number): number {
  if (eyesPalette === 0) return 0;
  const i = sex.eyeColorList.indexOf(eyesPalette);
  return i < 0 ? 0 : i;
}

/** CharGenState::GetSetupID @ 005c5a90: the hair style's alternate setup, else the sex's. */
export function chargenSetupId(sex: SexCG, hairStyle: number): number {
  if (hairStyle !== -1) {
    const alt = sex.hairStyleList[hairStyle]?.alternateSetup ?? 0;
    return alt !== 0 ? alt : sex.setupId;
  }
  return sex.setupId;
}

/** The CharGenState fields the barber reads and writes. */
export interface BarberFace {
  hairStyle: number;
  hairColor: number;
  hairShade: number;
  eyesStrip: number;
  eyeColor: number;
  noseStrip: number;
  mouthStrip: number;
  skinShade: number;
}

/** CharAppearanceData — GenerateBaseAppearanceData's output (0 = INVALID_DID). */
export interface CharAppearanceData {
  basePalette: number;
  headObject: number;
  eyesTexture: number; defaultEyesTexture: number;
  noseTexture: number; defaultNoseTexture: number;
  mouthTexture: number; defaultMouthTexture: number;
  skinPalette: number; hairPalette: number; eyesPalette: number;
}

/**
 * ACCharGenData::GenerateBaseAppearanceData @ 005c28d0. Null when the skin
 * or the hair-colour PalSet is missing (the function returns 0 and Apply
 * sends nothing).
 */
export function generateBaseAppearanceData(
  heritage: number, sex: SexCG, face: BarberFace, pal: BarberPaletteSource,
): CharAppearanceData | null {
  const out: CharAppearanceData = {
    basePalette: sex.basePalette, headObject: 0,
    eyesTexture: 0, defaultEyesTexture: 0, noseTexture: 0, defaultNoseTexture: 0,
    mouthTexture: 0, defaultMouthTexture: 0, skinPalette: 0, hairPalette: 0, eyesPalette: 0,
  };
  const hair = sex.hairStyleList[face.hairStyle];
  const head = hair?.objDesc.animPartChanges[0];
  if (head) out.headObject = heritage === HERITAGE.Gearknight ? 0 : head.partId;
  const skeleton = hair !== undefined
    && (hair.alternateSetup === BARBER_SETUPS.undeadMaleSkeleton || hair.alternateSetup === BARBER_SETUPS.undeadFemaleSkeleton);
  const pick = (desc: ObjDesc | undefined): TextureMapChange | null =>
    (skeleton ? textureMapChange(desc, 1) : null) ?? textureMapChange(desc, 0);
  const eyes = sex.eyeStripList[face.eyesStrip];
  const eyesTmc = pick(hair?.bald ? eyes?.objDescBald : eyes?.objDesc);
  if (eyesTmc) { out.eyesTexture = eyesTmc.newTexture; out.defaultEyesTexture = eyesTmc.oldTexture; }
  const noseTmc = pick(sex.noseStripList[face.noseStrip]?.objDesc);
  if (noseTmc) { out.noseTexture = noseTmc.newTexture; out.defaultNoseTexture = noseTmc.oldTexture; }
  const mouthTmc = pick(sex.mouthStripList[face.mouthStrip]?.objDesc);
  if (mouthTmc) { out.mouthTexture = mouthTmc.newTexture; out.defaultMouthTexture = mouthTmc.oldTexture; }
  const skin = pal.loadPaletteSet(sex.skinPalSet);
  if (!skin) return null;
  out.skinPalette = skin.getPaletteId(face.skinShade);
  const hairSet = pal.loadPaletteSet(sex.hairColorList[face.hairColor] ?? 0);
  if (!hairSet) return null;
  out.hairPalette = hairSet.getPaletteId(face.hairShade);
  out.eyesPalette = sex.eyeColorList[face.eyeColor] ?? 0;
  return out;
}

/** The 9-entry m_tChoices row (only hair / eyes / nose / mouth / skin are used here). */
export interface BarberChoice {
  numChoices: number;
  currentChoice: number;
  numColors: number;
  currentColor: number;
  shade: number;
}

/** The wheel's paint state: spot colours, which spots are bullets, the lit pointer, the disk. */
export interface BarberWheelView {
  /** m_tColorWheel[i] colour (null = never computed). */
  spotColors: (Rgb | null)[];
  /** Spots drawn as a coloured ColorBullet (i < iNumColors); the rest are ColorEmpty. */
  spotCount: number;
  /** m_iCurColor — the one visible pointer (−1 none). */
  currentColor: number;
  /** DoGradDisk(true): the GradientPlug instead of the tinted ColorRing (Eyes). */
  gradPlug: boolean;
  /** The ColorRing tint — m_tColorWheel[m_iCurColor]. */
  gradColor: Rgb | null;
  /** m_pShadeScroll visible. */
  shadeVisible: boolean;
  /** m_pShadeScroll position (attribute 0x86). */
  shade: number;
}

export interface BarberOptionView {
  visible: boolean;
  label: BarberStringKey | null;
  /** Button state 6 (checked) / 1. */
  checked: boolean;
}

export interface BarberApplyResult {
  /** The FinishBarber payload, or null when GenerateBaseAppearanceData failed (nothing is sent). */
  fields: BarberData | null;
  effects: BarberLocalEffects;
}

/**
 * gmBarberUI's state. `initializePage` is InitializePage; the click
 * methods are the ListenToElementMessage arms; `face` is the CharGenState
 * the preview draws.
 */
export class BarberModel {
  readonly heritage: number;
  readonly gender: number;
  readonly sex: SexCG;
  private readonly pal: BarberPaletteSource;

  /** The CharGenState face (and the randomised clothes the preview wears). */
  readonly face: BarberFace = {
    hairStyle: -1, hairColor: -1, hairShade: -1, eyesStrip: -1, eyeColor: -1, noseStrip: -1, mouthStrip: -1, skinShade: -1,
  };
  /** The rest of the CharGenState the preview dresses in (CharGenState::Reset values until dressPreview). */
  readonly preview: AppearanceState = {
    hairStyle: -1, hairColor: -1, eyesStrip: -1, eyeColor: -1, skinColor: 0, noseStyle: -1, mouthStyle: -1,
    headgearStyle: -1, headgearColor: -1, shirtStyle: -1, shirtColor: -1, pantsStyle: -1, pantsColor: -1,
    footwearStyle: -1, footwearColor: -1, skinHue: -1, hairHue: -1, headgearHue: -1, shirtHue: -1, pantsHue: -1, footwearHue: -1,
  };
  /** m_tChoices[0..4] — hair, eyes, nose, mouth, skin. */
  readonly choices: BarberChoice[] = Array.from({ length: 5 }, () => ({ numChoices: 0, currentChoice: 0, numColors: 0, currentColor: 0, shade: 0 }));
  /** m_eCurPart (ctor: ECG_PARTS_HAIR) and m_iPartIndex. */
  curPart: BarberPart = BarberPart.Hair;
  /** Streamed DATs: the wheel's spot colours were computed while a palette was not resident yet. */
  private spotsMissed = false;
  partIndex = 0;
  /** The lit row (m_pCurSelection, state 6). */
  selectedRow: number = BARBER_ELEMENTS.hairRow;
  readonly wheel: BarberWheelView = {
    spotColors: Array.from({ length: COLOR_WHEEL_SPOT_COUNT }, () => null),
    spotCount: 0, currentColor: -1, gradPlug: false, gradColor: null, shadeVisible: true, shade: 0,
  };
  /** m_p3DView->m_alternateSetupID (0 = INVALID_DID). */
  alternateSetupId = 0;
  /** gmCG3DView camera position (direction (0, 0, 0)). */
  camera: AcVec3 = BARBER_CAMERA;
  /** The rotation machine (Rotate @ 004de520 / DoRotation @ 004de450 match gmCGAppearancePage's). */
  readonly view = new AppearanceViewController();

  // Layout changes InitializePage makes per heritage.
  readonly rowLabels = new Map<number, BarberStringKey>();
  readonly hiddenRows = new Set<number>();
  /** Rows whose two arrows are ghosted (SetAttribute_Bool(0xd, true)). */
  readonly ghostedArrowRows = new Set<number>([BARBER_ELEMENTS.skinRow]);
  skinRowY: number | null = null;
  readonly options: [BarberOptionView, BarberOptionView, BarberOptionView] = [
    { visible: false, label: null, checked: false },
    { visible: false, label: null, checked: false },
    { visible: false, label: null, checked: false },
  ];
  applyPos: { x: number; y: number } = { x: APPLY_X, y: BUTTON_ROW_Y.plain };
  cancelPos: { x: number; y: number } = { x: CANCEL_X, y: BUTTON_ROW_Y.plain };
  /** Bumped whenever the preview must redraw (gmCG3DView::Update). */
  viewRevision = 0;

  constructor(heritage: number, gender: number, sex: SexCG, pal: BarberPaletteSource) {
    this.heritage = heritage;
    this.gender = gender;
    this.sex = sex;
    this.pal = pal;
  }

  private get gearOrOlthoi(): boolean {
    return this.heritage === HERITAGE.Gearknight || this.heritage === HERITAGE.Olthoi || this.heritage === HERITAGE.OlthoiAcid;
  }

  /** The setup the preview draws: gmCG3DView::Update's GetSetupID unless m_alternateSetupID is set. */
  get previewSetupId(): number {
    return this.alternateSetupId !== 0 ? this.alternateSetupId : chargenSetupId(this.sex, this.face.hairStyle);
  }

  /**
   * InitializePage's RandomizeCharacter(true) + SetHeadgearStyle(−1): the
   * clothes the preview wears are a fresh roll (CharGenState::Reset, then
   * RandomizeClothing's shirt / trousers / footwear draws; SetGender /
   * SetHeritageGroup keep the indices inside the player's lists), with no
   * headgear.
   */
  dressPreview(src: ChargenRandomSource): void {
    resetAppearance(this.preview);
    randomizeClothing(src, this.preview, appearanceRollLists(this.sex), false);
    this.preview.headgearStyle = -1;
    this.viewRevision++;
  }

  /** The CharGenState as the preview builds it (the face over the rolled clothes). */
  appearanceInfo(): AppearanceInfo {
    const f = this.face;
    return {
      ...this.preview,
      hairStyle: f.hairStyle, hairColor: f.hairColor, hairHue: f.hairShade,
      eyesStrip: f.eyesStrip, eyeColor: f.eyeColor, noseStyle: f.noseStrip, mouthStyle: f.mouthStrip,
      skinHue: f.skinShade,
    };
  }

  /** InitializePage @ 004e0040 (the 3D view's heading / camera, the layout per heritage, the face from the DIDs). */
  initializePage(data: BarberData): void {
    const E = BARBER_ELEMENTS;
    this.view.initializePage(this.heritage);
    this.camera = BARBER_CAMERA;
    if (this.heritage === HERITAGE.Gearknight || this.heritage === HERITAGE.Olthoi || this.heritage === HERITAGE.OlthoiAcid) {
      this.camera = BARBER_CAMERA_GEAR_OLTHOI;
      this.hiddenRows.add(E.noseRow);
      this.hiddenRows.add(E.mouthRow);
      const gear = this.heritage === HERITAGE.Gearknight;
      this.rowLabels.set(E.hairRow, gear ? 'gearHair' : 'olthoiHair');
      this.rowLabels.set(E.eyesRow, gear ? 'gearEyes' : 'olthoiEyes');
      this.rowLabels.set(E.skinRow, gear ? 'gearSkin' : 'olthoiSkin');
      this.ghostedArrowRows.add(E.eyesRow);
      this.skinRowY = SKIN_ROW_GEAR_OLTHOI_Y;
    }
    this.setupParts();

    const bald = data.hairTexture === BALD_TEXTURE;
    const skeleton = UNDEAD_SKELETON_SETUPS.has(data.setupTableId);
    this.face.hairStyle = this.stepTo(0, hairIndexFromId(this.sex, data.headObjectDID, bald));
    this.setSelection(BarberPart.Hair);
    this.face.eyesStrip = this.stepTo(1, eyeStripIndexFromId(this.sex, data.eyesTextureDID, skeleton, bald));
    this.setSelection(BarberPart.Eyes);
    this.face.noseStrip = this.stepTo(2, faceStripIndexFromId(this.sex.noseStripList, data.noseTextureDID, skeleton));
    this.setSelection(BarberPart.Nose);
    this.face.mouthStrip = this.stepTo(3, faceStripIndexFromId(this.sex.mouthStripList, data.mouthTextureDID, skeleton));
    this.setSelection(BarberPart.Mouth);
    this.setSelection(BarberPart.Hair);
    const hair = hairColorFromId(this.sex, data.hairPaletteDID, this.pal);
    this.face.hairColor = hair.color;
    this.face.hairShade = hair.shade;
    this.setColor(hair.color);
    this.setShade(hair.shade);
    this.face.skinShade = skinShadeFromId(this.sex, data.skinPaletteDID, this.pal);
    this.face.eyeColor = eyeColorFromId(this.sex, data.eyesPaletteDID);
    this.viewRevision++;

    // The option checkboxes and the button row.
    const opt = this.options[0];
    const setup = data.setupTableId;
    const withOption = (label: BarberStringKey, checked: boolean): void => {
      opt.visible = true; opt.label = label; opt.checked = checked;
      this.applyPos = { x: APPLY_X, y: BUTTON_ROW_Y.withOption };
      this.cancelPos = { x: CANCEL_X, y: BUTTON_ROW_Y.withOption };
    };
    if (this.heritage === HERITAGE.Empyrean) {
      withOption('empyreanOption', data.option1 !== 0);
    } else if (this.heritage === HERITAGE.Undead) {
      if (setup !== 0) this.alternateSetupId = setup;
      withOption('undeadOption', UNDEAD_NOFLAME_SETUPS.has(setup));
    } else if (this.heritage === HERITAGE.Shadowbound) {
      if (setup !== 0) this.alternateSetupId = setup;
      withOption('shadowOption', setup === BARBER_SETUPS.umbraenMaleNoCrown || setup === BARBER_SETUPS.umbraenFemaleNoCrown);
    } else if (this.heritage === HERITAGE.Penumbraen) {
      if (setup !== 0) this.alternateSetupId = setup;
      withOption('shadowOption', setup === BARBER_SETUPS.penumbraenMaleNoCrown || setup === BARBER_SETUPS.penumbraenFemaleNoCrown);
    }
  }

  /** The m_tChoices[k] clamp InitializePage / the row buttons apply (≥ n → 0, < 0 → n − 1). */
  private stepTo(k: number, value: number): number {
    const c = this.choices[k];
    c.currentChoice = value;
    if (value >= c.numChoices) c.currentChoice = 0;
    else if (value < 0) c.currentChoice = c.numChoices - 1;
    return c.currentChoice;
  }

  /** SetupParts @ 004debf0. */
  private setupParts(): void {
    const s = this.sex;
    Object.assign(this.choices[0], { numChoices: s.hairStyleList.length, currentChoice: this.face.hairStyle, currentColor: this.face.hairColor, numColors: s.hairColorList.length, shade: this.face.hairShade });
    Object.assign(this.choices[1], { numChoices: s.eyeStripList.length, currentChoice: this.face.eyesStrip, currentColor: this.face.eyeColor, numColors: s.eyeColorList.length, shade: 0 });
    Object.assign(this.choices[2], { numChoices: s.noseStripList.length, currentChoice: this.face.noseStrip, currentColor: -1, numColors: 0, shade: 0 });
    Object.assign(this.choices[3], { numChoices: s.mouthStripList.length, currentChoice: this.face.mouthStrip, currentColor: -1, numColors: 0, shade: 0 });
  }

  /** SetSelection(EParts) @ 004dedf0. */
  setSelection(part: BarberPart): void {
    const missEpoch = datMissEpoch();
    try {
      this.applySelection(part);
    } finally {
      this.spotsMissed = !noDatMissSince(missEpoch);
    }
  }

  /**
   * Streamed DATs: recompute the wheel when its spot colours were built
   * across a palette miss (the barber page calls this on every paint, so
   * the spots fill in once the files land). True when it recomputed.
   */
  refreshSpotColors(): boolean {
    if (!this.spotsMissed) return false;
    this.setSelection(this.curPart);
    return true;
  }

  private applySelection(part: BarberPart): void {
    this.curPart = part;
    this.selectedRow = PART_ROW[part];
    const w = this.wheel;
    let count = 0;
    let color = 0;
    let shade = 0;
    if (part === BarberPart.Hair) {
      count = this.sex.hairColorList.length;
      for (let i = 0; i < Math.min(count, COLOR_WHEEL_SPOT_COUNT); i++) {
        w.spotColors[i] = this.palSetColor(this.sex.hairColorList[i], CHARGEN_SPOT_SAMPLE.hair) ?? w.spotColors[i];
      }
      color = this.face.hairColor === -1 ? 0 : this.face.hairColor;
      shade = this.face.hairShade;
      this.partIndex = 0;
    } else if (part === BarberPart.Eyes) {
      count = this.sex.eyeColorList.length;
      for (let i = 0; i < Math.min(count, COLOR_WHEEL_SPOT_COUNT); i++) {
        w.spotColors[i] = paletteSpotColor(this.pal.loadPaletteColors(this.sex.eyeColorList[i]), CHARGEN_SPOT_SAMPLE.eyes) ?? { r: 0, g: 0, b: 0 };
      }
      color = this.face.eyeColor;
      this.partIndex = 1;
    } else {
      // Nose / mouth / skin: ONE spot, the skin PalSet's average.
      count = 1;
      w.spotColors[0] = this.palSetColor(this.sex.skinPalSet, CHARGEN_SPOT_SAMPLE.skin) ?? w.spotColors[0];
      color = 0;
      shade = this.face.skinShade;
      this.partIndex = part === BarberPart.Nose ? 2 : part === BarberPart.Mouth ? 3 : 4;
    }
    w.currentColor = color;
    this.choices[this.partIndex].numColors = count;
    // DoColorSpots(m_iPartIndex) @ 004de640.
    w.spotCount = this.choices[this.partIndex].numColors;
    if (part === BarberPart.Eyes) {
      w.gradPlug = true;
      w.shadeVisible = false;
    } else {
      w.gradPlug = false;
      w.gradColor = w.spotColors[color] ?? null;
      w.shadeVisible = true;
      this.setShade(shade);
    }
    this.setColor(color);
  }

  private palSetColor(id: number, sample: number): Rgb | null {
    const set = this.pal.loadPaletteSet(id);
    return palSetSpotColor(set?.paletteList, sample, (p) => this.pal.loadPaletteColors(p));
  }

  /** SetColor(int) @ 004deb40: the lit pointer, the state's hair / eye colour, the disk. */
  setColor(index: number): void {
    const w = this.wheel;
    w.currentColor = index;
    let plug = false;
    if (this.curPart === BarberPart.Hair) this.face.hairColor = index;
    else if (this.curPart === BarberPart.Eyes) { this.face.eyeColor = index; plug = true; }
    // DoGradDisk(plug) @ 004de880.
    w.gradPlug = plug;
    w.gradColor = index >= 0 ? (w.spotColors[index] ?? null) : null;
    this.viewRevision++;
  }

  /** SetShade(double) @ 004de3d0: the scroll position, then the hair or (nose / mouth / skin) skin shade. */
  setShade(shade: number): void {
    this.wheel.shade = shade;
    if (this.curPart === BarberPart.Hair) this.face.hairShade = shade;
    else if (this.curPart > BarberPart.Eyes && this.curPart < 6) this.face.skinShade = shade;
    this.viewRevision++;
  }

  /** The shade scroll's message 10: dwParam1 · 0.001 clamped to [0, 1] (0x3a83126f). */
  scrollShade(position: number): void {
    this.setShade(Math.max(0, Math.min(1, position)));
  }

  /** A row button (0x1000059e–a2, message 1): clamp its choice and select its part. */
  clickRow(part: BarberPart): void {
    const k = part - 1;
    const v = this.stepTo(k, this.choices[k].currentChoice);
    this.writeChoice(part, v);
    this.setSelection(part);
  }

  /** A row arrow (0x1000030a −1 / 0x1000030b +1) on hair / eyes / nose / mouth. */
  clickArrow(part: BarberPart, dir: -1 | 1): void {
    if (part === BarberPart.Skin) return;
    if (this.ghostedArrowRows.has(PART_ROW[part])) return;
    const k = part - 1;
    const v = this.stepTo(k, this.choices[k].currentChoice + dir);
    this.writeChoice(part, v);
    this.setSelection(part);
  }

  private writeChoice(part: BarberPart, v: number): void {
    if (part === BarberPart.Hair) this.face.hairStyle = v;
    else if (part === BarberPart.Eyes) this.face.eyesStrip = v;
    else if (part === BarberPart.Nose) this.face.noseStrip = v;
    else if (part === BarberPart.Mouth) this.face.mouthStrip = v;
  }

  /** A colour spot (0x1000030f + i): only i < iNumColors of the current part. */
  clickSpot(i: number): void {
    if (i < this.choices[this.partIndex].numColors) this.setColor(i);
  }

  /** 0x100005c9 (a p11 toggle: the release flips it, then the page re-picks the preview's setup). */
  clickOption1(): void {
    const opt = this.options[0];
    if (!opt.visible) return;
    opt.checked = !opt.checked;
    const female = this.gender === GENDER_FEMALE;
    let setup = chargenSetupId(this.sex, this.face.hairStyle);
    if (this.heritage === HERITAGE.Undead && opt.checked) {
      if (female) {
        if (setup === BARBER_SETUPS.undeadFemaleSkeleton) setup = BARBER_SETUPS.undeadFemaleSkeletonNoFlame;
        if (setup === BARBER_SETUPS.undeadFemaleZombie) setup = BARBER_SETUPS.undeadFemaleZombieNoFlame;
      } else {
        if (setup === BARBER_SETUPS.undeadMaleSkeleton) setup = BARBER_SETUPS.undeadMaleSkeletonNoFlame;
        if (setup === BARBER_SETUPS.undeadMaleZombie) setup = BARBER_SETUPS.undeadMaleZombieNoFlame;
      }
    }
    if (this.heritage === HERITAGE.Shadowbound && opt.checked) {
      setup = female ? BARBER_SETUPS.umbraenFemaleNoCrown : BARBER_SETUPS.umbraenMaleNoCrown;
    }
    if (this.heritage === HERITAGE.Penumbraen && opt.checked) {
      setup = female ? BARBER_SETUPS.penumbraenFemaleNoCrown : BARBER_SETUPS.penumbraenMaleNoCrown;
    }
    if (setup !== 0) {
      this.alternateSetupId = setup;
      this.viewRevision++;
    }
  }

  /** Apply (0x100005a6): the local effects, then GenerateBaseAppearanceData → Event_FinishBarber's 16 fields. */
  apply(): BarberApplyResult {
    const female = this.gender === GENDER_FEMALE;
    const checked = this.options[0].checked;
    const S = BARBER_SETUPS;
    const P = BARBER_SCRIPTS;
    let hairTexture = 0;
    let defaultHairTexture = 0;
    if (!this.gearOrOlthoi) {
      const tmc = textureMapChange(this.sex.hairStyleList[this.face.hairStyle]?.objDesc, 0);
      if (tmc) { hairTexture = tmc.newTexture; defaultHairTexture = tmc.oldTexture; }
    }
    let setup = chargenSetupId(this.sex, this.face.hairStyle);
    let option1 = 0;
    const effects: BarberLocalEffects = { destroyParticles: false, playScript: 0 };
    if (this.heritage === HERITAGE.Empyrean) {
      if (checked) {
        option1 = 1;
        effects.motionTableId = female ? EMPYREAN_MOTION.female : EMPYREAN_MOTION.male;
      } else {
        effects.motionTableId = female ? EMPYREAN_MOTION.femaleFloat : EMPYREAN_MOTION.maleFloat;
      }
    }
    if (this.heritage === HERITAGE.Undead) {
      const zombie = UNDEAD_ZOMBIE_SETUPS.has(setup);
      effects.destroyParticles = true;
      if (checked) {
        setup = female
          ? (zombie ? S.undeadFemaleZombieNoFlame : S.undeadFemaleSkeletonNoFlame)
          : (zombie ? S.undeadMaleZombieNoFlame : S.undeadMaleSkeletonNoFlame);
        effects.playScript = P.undeadNoFlame;
      } else if (female) {
        setup = zombie ? S.undeadFemaleZombie : S.undeadFemaleSkeleton;
        effects.playScript = zombie ? P.undeadFemaleZombie : P.undeadFemaleSkeleton;
      } else {
        setup = zombie ? S.undeadMaleZombie : S.undeadMaleSkeleton;
        effects.playScript = zombie ? P.undeadMaleZombie : P.undeadMaleSkeleton;
      }
    }
    if (this.heritage === HERITAGE.Shadowbound) {
      effects.destroyParticles = true;
      if (checked) {
        setup = female ? S.umbraenFemaleNoCrown : S.umbraenMaleNoCrown;
        effects.playScript = female ? P.umbraenFemaleNoCrown : P.umbraenMaleNoCrown;
      } else {
        setup = female ? S.umbraenFemaleCrown : S.umbraenMaleCrown;
        effects.playScript = female ? P.umbraenFemaleCrown : P.umbraenMaleCrown;
      }
    }
    if (this.heritage === HERITAGE.Penumbraen) {
      effects.destroyParticles = true;
      if (checked) {
        setup = female ? S.penumbraenFemaleNoCrown : S.penumbraenMaleNoCrown;
        effects.playScript = P.penumbraenNoCrown;
      } else {
        setup = female ? S.penumbraenFemaleCrown : S.penumbraenMaleCrown;
        effects.playScript = female ? P.penumbraenFemaleCrown : P.penumbraenMaleCrown;
      }
    }
    const app = generateBaseAppearanceData(this.heritage, this.sex, this.face, this.pal);
    if (!app) return { fields: null, effects };
    return {
      effects,
      fields: {
        paletteBaseDID: app.basePalette,
        headObjectDID: app.headObject,
        hairTexture, defaultHairTexture,
        eyesTextureDID: app.eyesTexture, defaultEyesTextureDID: app.defaultEyesTexture,
        noseTextureDID: app.noseTexture, defaultNoseTextureDID: app.defaultNoseTexture,
        mouthTextureDID: app.mouthTexture, defaultMouthTextureDID: app.defaultMouthTexture,
        skinPaletteDID: app.skinPalette, hairPaletteDID: app.hairPalette, eyesPaletteDID: app.eyesPalette,
        setupTableId: setup,
        option1, option2: 0,
      },
    };
  }
}
