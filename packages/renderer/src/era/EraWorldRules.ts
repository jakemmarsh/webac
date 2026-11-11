/**
 * The era client's world and pre-world presentation values (SWEEP1999.world): the parts of
 * `eraClientRules()` that the landscape, the sky, the UI sounds, character select and chargen
 * read. End of retail (and the classic eras, which run its exe) keep today's values; the 1999
 * entry holds what the 1999 client.exe did (reference/ac1999/Client/decomp, client.exe
 * disassembly). One table, no era checks in the panels (docs/ac1999-support.md).
 */
import { Sound } from '@ac/shared';
import type { TextureSamplingRule } from '../models/TextureSamplerPrefs.js';
import type { LightColourRule, PointLightRule } from '../models/RetailLighting.js';
import type { LightPoolRule } from '../effects/DatLightBudget.js';

/** The chargen "you have unspent credits" requesters (gmCharGenMainUI::DoFinish / the 1999 CG pages). */
export interface ChargenCreditWarnings {
  /**
   * FINISH with attribute credits left. End of retail: ID_CharGen_CreditWarning (a string-table
   * token, read by GameUI); 1999: CharGen_OnCreateConfirm @ 0x567980's literal.
   */
  attributes: string | null;
  /** FINISH with skill (training) credits left: 1999 only (OnCreateConfirm, after the attribute check). */
  trainingAtFinish: string | null;
  /** The Skills page's Next with training credits left: 1999 only (CG_8 ListenToMessage, its ctor's requester). */
  trainingAtSkillsNext: string | null;
  /** The requesters' chime: 1999 UI_GeneralQuery 0x6C at each (end of retail plays none). */
  sound: Sound | null;
}

export interface EraWorldRules {
  /**
   * What the Config page's brightness slider drives. End of retail: Render.ScreenBrightness, a gamma
   * ramp (ui/ScreenGamma.ts), and LScape::min_ambient is the constant 0.2. 1999: there is no gamma
   * slider; the Performance panel's brightness b (0..1, default 0.5) goes to SmartBox_SetBrightness
   * @ 0x40df93 → LScape_SetMinBrightness @ 0x441d91, `min_ambient = b * 0.3 + 0.2` (0.35 at the
   * default), the floor LScape_UseTime @ 0x442242 holds the region ambient to (every 1999 day
   * group's amb_bright is 0.3, so the floor always wins).
   */
  brightness: { gamma: boolean; minAmbientBase: number; minAmbientPerBrightness: number };
  /**
   * Client-local UI sounds the era plays beyond end of retail's own (audio/RetailLocalSounds.ts).
   * 1999 (each through SoundManager_PlaySoundFromCenter, gated on UI_GetUISoundsEnabled): 0x6C
   * GeneralQuery (chargen refusals and warnings), 0x6D GeneralError (create refused,
   * CG_10_UI_Global_Loop; the research panel's magic-mode refusal), 0x6E TransientMessage (every
   * urgent status line, UI_PlayTransientMessageSound @ 0x4cccc0), 0x6F / 0x70 / 0x71 icon pick-up /
   * drop / refused drop (ItemSlot / ItemList / ShopList / ShortcutSlot / InventoryPanel
   * ReleaseDragObject and DropNotify), 0x74 slider release (the UI ctor's `mov ecx,0x74` @ 0x4c6134
   * into the slider sound @ 0x656b6c, played by the slider's release @ 0x4945b0) and 0x75
   * NewTargetSelected (PanelUI_SetSelectedItem @ 0x4fcb20, a change to a non-zero selection).
   */
  localUiSounds: readonly Sound[];
  /**
   * Every button plays UI_ButtonPress on its press. 1999: the UI ctor stores 0x72 (`mov ecx,0x72`
   * @ 0x4c612a) as the global press sound @ 0x656400 that every button class's press @ 0x4516e0
   * plays. End of retail: only the elements whose LayoutDesc pressed state carries Sound media
   * (ui/LayoutPressSound.ts).
   */
  pressSoundOnEveryButton: boolean;
  chargenCreditWarnings: ChargenCreditWarnings;
  /**
   * A fixed landscape radius in landblocks, or null for the Config page's Landscape Draw Distance.
   * 1999: LScape_ctor @ 0x441b42 calls SetMidRadius(5) and the client has no draw-distance option
   * (only the `@render radius` debug command), so its world is an 11 x 11 grid.
   */
  fixedLandscapeRadius: number | null;
  /**
   * The text a character pending deletion shows in place of its name, or null for the name (end of
   * retail: the name in red, CharacterSet::GetGreyedOutFor). 1999: IntroUI_Update @ 0x504e80 /
   * CharSlot_SetAvailable @ 0x505b10 write "Temporarily Unavailable", the row cannot be selected,
   * and the slot is cleared locally when its deleteTimeout counts out (CharList_ClearEntry).
   */
  pendingDeleteRowText: string | null;
  /**
   * After the server accepts a new character. End of retail: the new character enters the world
   * (m_bAwaitingCharSetForLogin). 1999: CG_10_UI_Global_Loop's code-1 path runs
   * CharGenState_Reset and Game_SetUIMode(2): back to character select.
   */
  afterCharacterCreate: 'enterWorld' | 'characterSelect';
  /**
   * The selection blink's end count in SelectionLighting's numbering (it starts at 1, HIGH). End of
   * retail: 5 (HIGH, LOW, HIGH, LOW, restore). 1999: ItemHolder's loop @ 0x59de50 starts at 0 and
   * toggles while ++count < 2 (0x0059fa90 sets HIGH, count 0): HIGH, LOW, restore = 3 here.
   */
  selectionFlipEndCount: number;
  /**
   * The sky objects' timeline state (luminosity, translucency, arc windows) changes only on the
   * landscape tick (sky_info.tick_size, 0.8 s). 1999: LScape_UseTime @ 0x442242 calls
   * GameSky_UseTime inside its next_tick gate. End of retail runs GameSky::UseTime every frame.
   * Their MOTION is every frame in every era (SkyboxRenderer.updateSkyMotion,
   * BUG.sky-steps-not-smooth): texture scroll is CPhysics' (0x444160), never the tick's, and the
   * 1999 arc step (half a pixel on a 1999 screen, several today) is a browser-UX exception.
   */
  skyObjectsOnTick: boolean;
  /**
   * The degrade (LOD) pick subtracts the Degrade Distance preference from the viewer distance.
   * End of retail: GfxObjDegradeInfo::get_degrade @ 0051e4b0 (|dist| − Render::s_rDegradeDistance,
   * Config "Degrade Distance"). 1999: get_degrade @ 0x0044b6d0 compares |dist| itself, and the
   * 1999 exe has no Degrade Distance option (its only degrade string is "Auto-Degrade"). Everything
   * else in the pick is the same in both exes: the disabled / force-level overrides, the bias
   * formulas (≥ 0: ideal − (ideal − max)·bias; < 0: ideal + (ideal − min)·bias), the last level
   * past every threshold, the player's own parts at level 0 (0x00446f90), dist / gfxobj_scale.z,
   * and the 50 m land-cell distance (0x0057eb60, 0x0060e618 = 50.0).
   */
  degradeDistanceShift: boolean;
  /**
   * The hourglass while an inventory request is pending. 1999: PanelUI_Global_Loop raises the busy
   * count while ACCWeenieObject_get_prevRequest() is non-zero and drops it when the request clears.
   * End of retail has no such site (ui/BusyCount.ts).
   */
  inventoryRequestBusy: boolean;
  /**
   * The chat log's cap: past `max` entries the oldest go until `trimTo` remain. End of retail: ours,
   * 100 / 100 (FAITHFUL.267). 1999: PanelUI_AddTextToScroll @ 0x4f9b70 deletes the first 100 once
   * it holds more than 300.
   */
  chatHistory: { max: number; trimTo: number };
  /**
   * The world textures' samplers (TextureSamplerPrefs.setSamplingRule). End of retail: 'prefs', the
   * Config page's Texture Filtering (RenderDeviceD3D::SetSamplerFilterMode, mipmapped). 1999:
   * 'bilinearNoMips', fixed: Render_SetupD3DDevice @ 0x43d2a0 sets MIN / MAG LINEAR and never a mip
   * filter, ImgTex_InitOther @ 0x42a34f makes one-level textures, and the client has no filtering
   * option, so the Config page lists no Texture Filtering row (`textureFilteringOption`).
   */
  textureSampling: TextureSamplingRule;
  /**
   * What a light's colour does (RetailLighting.lightColourRule). End of retail: 'rgb', colour ×
   * level per channel. 1999: 'intensityOnly', one intensity per vertex and no light colour read
   * (0x5832b0 / 0x5832f0 / 0x583330 into vertex + 0x44, the scalar landscape arm of 0x47d8a0, the
   * grey diffuse of 0x5836e0): every light draws white at its own level.
   */
  lightColour: LightColourRule;
  /**
   * How a point light falls off (RetailLighting.pointLightRule, BUG.ac1999-point-light-falloff).
   * End of retail: 'd3d', calc_point_light @ 0059c8b0 for static lights on env cells (range
   * falloff × 1.3, a (1 − d/range) window, 1/d² past a metre, capped at the colour) and the D3D
   * hardware light for the rest (N·L / d inside falloff × 1.5). 1999: 'software1999', one software
   * function @ 0x583330 for every point light on every vertex: range = falloff, the same
   * (cos θ + 0.5) / 1.5 wrap and 1/d² past a metre, no window, no cap.
   */
  pointLight: PointLightRule;
  /**
   * The viewer (player) light's intensity and falloff per unit of the brightness slider, or null
   * for end of retail's fixed SmartBox.ViewerLightIntensity / Falloff (2.25 / 10, ViewerLight.ts).
   * 1999: SmartBox_SetBrightness @ 0x40df93 sets 0x62ffe4 = b·4.5 + b·4.5, and SmartBox_set_viewer
   * @ 0x40e2ad copies it into BOTH the viewer light's intensity (+0x48, 0x62ffb8) and falloff
   * (+0x4c, 0x62ffbc): 9 · b, 4.5 at the default b = 0.5 (the Performance panel's ctor applies its
   * settings through PerformancePanel_ApplySettings @ 0x598430).
   */
  viewerLightPerBrightness: number | null;
  /**
   * Which lights make the world pool (DatLightBudget.LightPoolRule). End of retail: 'eor', 40 + 20·L
   * static / 7 + 3·L dynamic, from the player. 1999: 'ac1999', 0x43ffd0's 20 + 10·L static (30 /
   * 10 at the Automatic degrade's L = 1), from the player's current cell's frame (0x43f7b0,
   * CellManager_ChangePosition); the same per-object reach test. Both rank each light by its
   * owner's origin (0054d1b0 / 0x43f7b0; DatLightBudget.lightPoolRanksFromOwner).
   */
  lightPool: LightPoolRule;
  /**
   * The open Examine window re-appraises its creature / character every 0.75 s outside peace mode.
   * End of retail: gmExaminationUI::UseTime @ 004ab530. 1999: no such loop; CM_Item_Event_Appraise
   * @ 0x005adca0 is called only by ExaminePanel_ExamineObject @ 0x005096d0 (an examine, or a new
   * selection while the panel examines) and the panel's release paths. On the AC1999 server each
   * re-appraisal also turned the player (appraisalTurnsAppraiser), every 0.75 s (webac#20).
   */
  examineReappraise: boolean;
  /**
   * The era's server turns the appraiser to face a world object it appraises (the AC1999 server's
   * CClientEvents::TurnToAppraiseTarget, 1999 retail until the 2002-07 Repercussions patch). The
   * client then sends no appraisal of a world object the player didn't ask for
   * (controllers/BackgroundAppraisal.ts). ACE and GDLE turn nothing.
   */
  appraisalTurnsAppraiser: boolean;
  /**
   * The landscape detail texture pass (webac#23), or null where the era's client offers none.
   * 1999: the Performance panel's "Detail Texture: Landscape" checkbox (PerformancePanel @ 0x594e00,
   * default off: the render-options defaults @ 0x42c236 zero it) → LScape_SetDetailTexturing
   * @ 0x44340f. The D3D land draw (0x57e9de, full-resolution blocks only) then draws each land
   * triangle again with the region's terrain_desc[0] detail texture at its DetailTexTiling per
   * cell, SRCALPHA / INVSRCALPHA over MODULATE(texture, lit diffuse), the vertex alpha fading with
   * depth (0x583a58: 255 below screen z 0.02, linear to 0 at 0.04; screen z = view depth / 500
   * there, the 0x61dbc8 scale over the 1/F camera z, so 10 m to 20 m). End of retail: none.
   * Render::UpdateFromPreferences @ 0054d850 forces
   * Current_Render_LandscapeDetailTextures false and passes landscape = false to
   * SmartBox::SetDetailTexturing, and gmConfigUI attaches no row for Render.LandscapeDetailTextures.
   * The classic (Dark Majesty) eras run that exe but get the pre-ToD option at Jake's request
   * (2026-11-06, webac#23): CLASSIC_WORLD_RULES, the exe's own dormant fade (see CLASSIC_LANDSCAPE_DETAIL).
   * Where the option exists, it is offered only for a region whose detail texture is see-through
   * (DetailTexturing.landscapeUsable: Classic Dereth's opaque 0x5001786 would cover the ground).
   */
  landscapeDetailTextures: LandscapeDetailRule | null;
  /**
   * The Config page's two texture-detail menus (Landscape / Environment Texture Detail), or null
   * for end of retail's five choices (Very Low … Very High, preference values 4 … 0; Very High
   * keeps client_highres.dat's level). The values are ours (TextureSamplerPrefs: value v is
   * texture scale max(v − 1, 0), the shift ImageShift[scale]); the labels are the era client's.
   * 1999: the Performance panel's texture-resolution menus (PerformancePanel @ 0x594e00: Landscape,
   * ClipMap, 0x6116e0, Indexed) each offer "Full", "1/2", "1/4", "1/8" (0x6116fc / f8 / f4 / f0)
   * as items 0..3, and the item is the shift index: 0x0042a732 / 0x004a7ee0 shift a texture's size
   * by .rdata 0x5f75a8 / 0x5fe0d8 = {0, 1, 2, 4}[item], which is end of retail's ImageShift for
   * scale = item. So item L is our value L + 1 (Full = High: the portal's own largest image, no
   * shift; 1999 SurfaceTextures are one image, Textures1999.ts). There is no Very High: the 1999
   * client has no HiFi DAT, so a 1999 world never mounts client_highres.dat
   * (`eraOffersHighResTextures`), and a stored Very High reads as Full (`eraTextureDetail`).
   * Landscape -> Landscape Texture Detail; ClipMap / 0x6116e0 / Indexed (every other texture
   * type, 0x0042a732) -> Environment Texture Detail.
   */
  textureDetailMenu: TextureDetailMenu | null;
}

/** An era's texture-detail menu: our preference values, in its order, with its own labels. */
export interface TextureDetailMenu {
  values: readonly number[];
  labels: readonly string[];
  /** The era client's texture shift for each value (TextureSamplerPrefs.setEnvironmentShifts). */
  shifts: readonly number[];
}

/** 1999's texture-resolution menus (EraWorldRules.textureDetailMenu). */
export const AC1999_TEXTURE_DETAIL_MENU: TextureDetailMenu = Object.freeze({
  values: Object.freeze([1, 2, 3, 4]),
  labels: Object.freeze(['Full', '1/2', '1/4', '1/8']),
  shifts: Object.freeze([0, 1, 2, 4]), // .rdata 0x5f75a8 / 0x5fe0d8
});

/** The landscape detail pass's view-depth fade (metres): full below `fadeMinZ`, none beyond `fadeMaxZ`. */
export interface LandscapeDetailRule {
  fadeMinZ: number;
  fadeMaxZ: number;
}

/** 1999: screen z 0.02 / 0.04 (.rdata 0x60e740 / 0x60e744) × the 500 m depth scale (0x61c4d4). */
export const AC1999_LANDSCAPE_DETAIL: LandscapeDetailRule = Object.freeze({ fadeMinZ: 10, fadeMaxZ: 20 });

/**
 * Dark Majesty (classic eras, the end-of-retail exe): the fade that exe's own landscape detail draw
 * uses, ACRender::landPolyDraw @ 006b6320 (dormant there): MY_MIN_Z_TO_DETAIL 10 / MY_MAX_Z_TO_DETAIL
 * 50 (.rdata 0x8067b0 / 0x8067b4). No pre-ToD (2002-2004) client is in reference/ to read its value
 * from; this is the immediate-mode path the pre-built-mesh clients ran, as compiled into the exe
 * these eras run.
 */
export const CLASSIC_LANDSCAPE_DETAIL: LandscapeDetailRule = Object.freeze({ fadeMinZ: 10, fadeMaxZ: 50 });

export const EOR_WORLD_RULES: EraWorldRules = Object.freeze({
  brightness: Object.freeze({ gamma: true, minAmbientBase: 0.2, minAmbientPerBrightness: 0 }),
  localUiSounds: Object.freeze([]),
  pressSoundOnEveryButton: false,
  chargenCreditWarnings: Object.freeze({ attributes: null, trainingAtFinish: null, trainingAtSkillsNext: null, sound: null }),
  fixedLandscapeRadius: null,
  pendingDeleteRowText: null,
  afterCharacterCreate: 'enterWorld' as const,
  selectionFlipEndCount: 5,
  skyObjectsOnTick: false,
  degradeDistanceShift: true,
  inventoryRequestBusy: false,
  chatHistory: Object.freeze({ max: 100, trimTo: 100 }),
  textureSampling: 'prefs' as const,
  lightColour: 'rgb' as const,
  pointLight: 'd3d' as const,
  viewerLightPerBrightness: null,
  lightPool: 'eor' as const,
  examineReappraise: true,
  appraisalTurnsAppraiser: false,
  landscapeDetailTextures: null,
  textureDetailMenu: null,
});

/** The classic (Dark Majesty) eras: end of retail's world plus the pre-ToD landscape detail option (webac#23). */
export const CLASSIC_WORLD_RULES: EraWorldRules = Object.freeze({
  ...EOR_WORLD_RULES,
  landscapeDetailTextures: CLASSIC_LANDSCAPE_DETAIL,
});

export const AC1999_WORLD_RULES: EraWorldRules = Object.freeze({
  brightness: Object.freeze({ gamma: false, minAmbientBase: 0.2, minAmbientPerBrightness: 0.3 }),
  localUiSounds: Object.freeze([
    Sound.UI_GeneralQuery, Sound.UI_GeneralError, Sound.UI_TransientMessage,
    Sound.UI_IconPickUp, Sound.UI_IconSuccessfulDrop, Sound.UI_IconInvalid_Drop,
    Sound.UI_ReleaseSlider, Sound.UI_NewTargetSelected,
  ]),
  pressSoundOnEveryButton: true,
  // The literals' leading layout newlines are dropped (as spellDeleteConfirm's).
  chargenCreditWarnings: Object.freeze({
    attributes: "You have not spent all your Attribute Credits.  If you don't spend them during character creation, you will lose them.  Create this character anyway?",
    trainingAtFinish: "You have not spent all your Training Credits.  If you don't spend them during character creation, you will lose them.  Create this character anyway?",
    trainingAtSkillsNext: "You have not spent all your Training Credits.  If you don't spend them during character creation, you will lose them.  Do you want to continue?",
    sound: Sound.UI_GeneralQuery,
  }),
  fixedLandscapeRadius: 5,
  pendingDeleteRowText: 'Temporarily Unavailable',
  afterCharacterCreate: 'characterSelect' as const,
  selectionFlipEndCount: 3,
  skyObjectsOnTick: true,
  degradeDistanceShift: false,
  inventoryRequestBusy: true,
  chatHistory: Object.freeze({ max: 300, trimTo: 200 }),
  textureSampling: 'bilinearNoMips' as const,
  lightColour: 'intensityOnly' as const,
  pointLight: 'software1999' as const,
  viewerLightPerBrightness: 9, // 0x40df93: b * 4.5 + b * 4.5
  lightPool: 'ac1999' as const,
  examineReappraise: false,
  appraisalTurnsAppraiser: true,
  landscapeDetailTextures: AC1999_LANDSCAPE_DETAIL,
  textureDetailMenu: AC1999_TEXTURE_DETAIL_MENU,
});

/** The slider's value `pref` (-1..1) as the 1999 Performance panel's brightness b (0..1, default 0.5). */
export function sliderBrightness(pref: number): number {
  return Math.max(0, Math.min(1, ((Number.isFinite(pref) ? pref : 0) + 1) / 2));
}

/** LScape min_ambient for the brightness slider's value `pref` (Render.ScreenBrightness, -1..1). */
export function landscapeMinAmbient(rules: EraWorldRules, pref: number): number {
  const b = sliderBrightness(pref);
  return rules.brightness.minAmbientBase + rules.brightness.minAmbientPerBrightness * b;
}

/** Whether the Config page lists Landscape Draw Distance (not on a fixed-radius era: 1999 had no such option). */
export function landscapeDrawDistanceOption(rules: EraWorldRules): boolean {
  return rules.fixedLandscapeRadius === null;
}

/** Whether the Config page lists Texture Filtering (not where the era fixes the samplers: 1999 had no such option). */
/** Whether the era's client had a HiFi DAT for Very High (end of retail and the classic eras; not 1999). */
export function eraOffersHighResTextures(rules: EraWorldRules): boolean {
  return rules.textureDetailMenu === null || rules.textureDetailMenu.values.includes(0);
}

/**
 * A stored texture-detail value as the era draws it: a value its menu offers stays; one finer than
 * its finest (Very High on 1999) is its finest (Full). Anything else is left to the samplers'
 * own validation (TextureSamplerPrefs.normalizeTextureDetail).
 */
export function eraTextureDetail(rules: EraWorldRules, value: unknown): unknown {
  const menu = rules.textureDetailMenu;
  if (!menu || typeof value !== 'number' || menu.values.includes(value)) return value;
  const finest = Math.min(...menu.values);
  return value < finest ? finest : value;
}

/** The texture prefs with both detail values as the era draws them (eraTextureDetail). */
export function eraTexturePrefs<T extends { landscapeTextureDetail?: unknown; environmentTextureDetail?: unknown }>(rules: EraWorldRules, prefs: T): T {
  const out = { ...prefs };
  if ('landscapeTextureDetail' in prefs) out.landscapeTextureDetail = eraTextureDetail(rules, prefs.landscapeTextureDetail);
  if ('environmentTextureDetail' in prefs) out.environmentTextureDetail = eraTextureDetail(rules, prefs.environmentTextureDetail);
  return out;
}

export function textureFilteringOption(rules: EraWorldRules): boolean {
  return rules.textureSampling === 'prefs';
}

/** Whether the era has a Landscape Detail Textures option (1999's client; the classic eras by request). The row also needs a see-through region texture. */
export function landscapeDetailTexturesOption(rules: EraWorldRules): boolean {
  return rules.landscapeDetailTextures !== null;
}

/** The landscape radius the era draws: its fixed one, else the player's choice. */
export function eraLandscapeRadius(rules: EraWorldRules, chosen: number): number {
  return rules.fixedLandscapeRadius ?? chosen;
}

/** Trim a chat log's children to the era's history cap. */
export function trimChatLog(log: Element, cap: EraWorldRules['chatHistory']): void {
  if (log.children.length <= cap.max) return;
  while (log.children.length > cap.trimTo) log.removeChild(log.children[0]);
}

/**
 * Every UI sound some era's client plays on its own beyond end of retail's: the shared call sites
 * ask for these, and an era whose client never played one skips it quietly.
 */
export const ERA_OPTIONAL_UI_SOUNDS: ReadonlySet<Sound> = new Set(AC1999_WORLD_RULES.localUiSounds);
