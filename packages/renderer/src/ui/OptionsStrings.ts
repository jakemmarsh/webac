import { acStringHash, getString, getStringFromTable } from '@ac/dat-parser/file-types/LayoutDesc.js';

/**
 * CORE.17.h.e — the string table the retail options pages are bound to.
 *
 * Every Config-tab option is registered by the retail client through
 * UIPreferences::AttachPreference(&pref, kind, 0x10000003,
 * compute_str_hash("ID_…"), compute_str_hash("ID_…_Help")) (decomp
 * acclient-decompiled.c:2490-2537 for the Sound_ prefs, :2961-2986 for the
 * Render_ and Display_ prefs, :3004-3008 for the Camera_ prefs), and
 * gmConfigUI::InitOptions @ 0049e400 hands each pref to PlayerOptionPage::
 * Add*Option, which puts that label id on the row's 0x2100002b template
 * text. Table enum 0x10000003 is the English table 0x23000003, and
 * compute_str_hash is the LayoutDesc acStringHash — so a row label is
 * `0x23000003[acStringHash("ID_Sound_DisableSound")]` = "Sound Effects",
 * `…("ID_Camera_AlignToSlope")` = "Align camera to slope" (sentence case,
 * not the Title Case our fallbacks used), `…("ID_Rendering_
 * SyncToDisplayRefresh")` = "Sync with Refresh Rate". Section headers
 * (AddHeader(ID_Sound_SoundSection …)), slider end captions
 * (SetSliderLabel(…, ID_Graphics_Value_Soft, ID_Graphics_Value_Hard)) and
 * the Sound Features enum choices (SetEnumChoices: ID_Sound_Stereo /
 * ID_Sound_Mono) go through the same table.
 *
 * Bound per-table (not the flat getString index) for the same reason as
 * FellowshipStrings: ids are token hashes shared across tables with
 * different text, and the flat index is last-write-wins.
 */
export const OPTIONS_STRING_TABLE = 0x23000003;

/**
 * Resolve a retail options-page string token ("ID_Sound_DisableSound") the
 * way the client does: hash it, look it up in the options table, then the
 * flat index, then the given fallback (which should be the DAT text so an
 * unloaded table still renders the retail wording).
 */
export function optionString(token: string, fallback: string): string {
  const id = acStringHash(token);
  return getStringFromTable(OPTIONS_STRING_TABLE, id) ?? getString(id) ?? fallback;
}

/**
 * The Config tab's retail tokens, in gmConfigUI::InitOptions order, with the
 * EoL client_local_English.dat text each resolves to (the fallback text).
 * Kept as data so tests can assert the DAT binding row by row.
 */
export const CONFIG_STRINGS = {
  soundSection: ['ID_Sound_SoundSection', 'Sound Options'],
  soundFeatures: ['ID_Sound_SoundFeatures', 'Sound Features'],
  stereo: ['ID_Sound_Stereo', 'Stereo'],
  mono: ['ID_Sound_Mono', 'Mono'],
  soundEffects: ['ID_Sound_DisableSound', 'Sound Effects'],
  ambientSounds: ['ID_Sound_DisableAmbientSound', 'Ambient Sounds'],
  interfaceSounds: ['ID_Sound_DisableInterfaceSound', 'Interface Sounds'],
  playSoundsOnlyWhenActive: ['ID_Sound_NoFocusNoSound', 'Play Sounds Only When Active'],
  cameraSection: ['ID_Camera_CameraSection', 'Camera Options'],
  cameraStiffness: ['ID_Camera_Stiffness', 'Camera Stiffness'],
  soft: ['ID_Graphics_Value_Soft', 'Soft'],
  hard: ['ID_Graphics_Value_Hard', 'Hard'],
  cameraAdjustmentSpeed: ['ID_Camera_AdjustmentSpeed', 'Camera Adjustment Speed'],
  slow: ['ID_Graphics_Value_Slow', 'Slow'],
  fast: ['ID_Graphics_Value_Fast', 'Fast'],
  fieldOfView: ['ID_Graphics_FieldOfView', 'Field of View'],
  narrow: ['ID_Graphics_Value_Narrow', 'Narrow'],
  wide: ['ID_Graphics_Value_Wide', 'Wide'],
  alignCameraToSlope: ['ID_Camera_AlignToSlope', 'Align camera to slope'],
  graphicsSection: ['ID_Graphics_GraphicsSection', 'Graphics Options'],
  resolution: ['ID_Rendering_DisplayResolution', 'Resolution'],
  fullScreen: ['ID_Rendering_FullScreen', 'Full Screen'],
  syncWithRefreshRate: ['ID_Rendering_SyncToDisplayRefresh', 'Sync with Refresh Rate'],
  screenBrightness: ['ID_Graphics_ScreenBrightness', 'Screen Brightness'],
  dark: ['ID_Graphics_Value_Dark', 'Dark'],
  bright: ['ID_Graphics_Value_Bright', 'Bright'],
  adaptiveDegrade: ['ID_Graphics_AdaptiveDegrade', 'Adaptive Degrade'],
  adaptiveDegradeBias: ['ID_Graphics_AdaptiveDegradeBias', 'Adaptive Degrade Bias'],
  speed: ['ID_Graphics_Value_Speed', 'Speed'],
  detail: ['ID_Graphics_Value_Detail', 'Detail'],
  // CORE.17.h.g — the rows below Adaptive Degrade Bias (gmConfigUI::
  // InitOptions decomp :158684-158729). The header token
  // ID_Graphics_TextureSection resolves to "Rendering Quality Options" (not
  // "Texture Options"), ID_Graphics_BuildingDetailTextures to "Environment
  // Detail Textures" and ID_Input_UseMouseTurning to the full sentence — the
  // DAT text wins over the pref names.
  degradeDistance: ['ID_Graphics_DegradeDistance', 'Degrade Distance'],
  close: ['ID_Graphics_Value_Close', 'Close'],
  far: ['ID_Graphics_Value_Far', 'Far'],
  renderingQualitySection: ['ID_Graphics_TextureSection', 'Rendering Quality Options'],
  landscapeTextureDetail: ['ID_Graphics_LandscapeTextureDetail', 'Landscape Texture Detail'],
  environmentTextureDetail: ['ID_Graphics_EnvironmentTextureDetail', 'Environment Texture Detail'],
  textureFiltering: ['ID_Graphics_TextureFiltering', 'Texture Filtering'],
  landscapeDrawDistance: ['ID_Graphics_LandscapeDrawDistance', 'Landscape Draw Distance'],
  environmentDetailTextures: ['ID_Graphics_BuildingDetailTextures', 'Environment Detail Textures'],
  multiplePassAlpha: ['ID_Graphics_MultiPassAlpha', 'Multiple Pass Alpha'],
  veryLow: ['ID_Graphics_Value_VeryLow', 'Very Low'],
  low: ['ID_Graphics_Value_Low', 'Low'],
  medium: ['ID_Graphics_Value_Medium', 'Medium'],
  high: ['ID_Graphics_Value_High', 'High'],
  veryHigh: ['ID_Graphics_Value_VeryHigh', 'Very High'],
  extreme: ['ID_Graphics_Value_Extreme', 'Extreme'],
  bilinear: ['ID_Graphics_TextureFiltering_Bilinear', 'Bilinear'],
  trilinear: ['ID_Graphics_TextureFiltering_Trilinear', 'Trilinear'],
  sharp: ['ID_Graphics_TextureFiltering_Sharp', 'Sharp'],
  anisotropic: ['ID_Graphics_TextureFiltering_Anisotropic', 'Anisotropic'],
  inputSection: ['ID_Input_InputSection', 'Input Options'],
  mouselookSensitivity: ['ID_Input_MouseLookSensitivity', 'Mouselook Sensitivity'],
  invertMouselookAxes: ['ID_Input_InvertMouseLookYAxis', 'Invert mouselook axes'],
  useMouseTurning: ['ID_Input_UseMouseTurning', 'Turn your character with camera turning.'],
  uiSection: ['ID_UI_UISection', 'UI Options'],
  chatFontFace: ['ID_UI_ChatFontFace', 'Chat Font Face'],
  chatFontSize: ['ID_UI_ChatFontSize', 'Chat Font Size'],
  arial: ['ID_UI_Value_Arial', 'Arial'],
  courierNew: ['ID_UI_Value_CourierNew', 'Courier New'],
  palatinoLinotype: ['ID_UI_Value_PalatinoLinotype', 'Palatino Linotype'],
  tahoma: ['ID_UI_Value_Tahoma', 'Tahoma'],
  timesNewRoman: ['ID_UI_Value_TimesNewRoman', 'Times New Roman'],
  tiny: ['ID_UI_Value_Tiny', 'Tiny'],
  small: ['ID_UI_Value_Small', 'Small'],
  uiMedium: ['ID_UI_Value_Medium', 'Medium'],
  large: ['ID_UI_Value_Large', 'Large'],
  extraLarge: ['ID_UI_Value_XLarge', 'Extra Large'],
} as const satisfies Record<string, readonly [string, string]>;

export type ConfigStringKey = keyof typeof CONFIG_STRINGS;

/** `optionString` for a Config-tab row by its CONFIG_STRINGS key. */
export function configString(key: ConfigStringKey): string {
  const [token, fallback] = CONFIG_STRINGS[key];
  return optionString(token, fallback);
}

/**
 * VISUAL.options-rows-help-tooltips — the help token of every Config-tab
 * UIPreference, keyed by the optionsSettings key its row edits. The client
 * registers each pref as UIPreferences::AttachPreference(&pref, kind,
 * 0x10000003, hash("ID_…"), hash("ID_…_Help")) (decomp :2488-2545 Sound/UI,
 * :2669-2887 Rendering Quality, :2959-3008 Graphics/Display/Input/Camera);
 * UIOption_Checkbox::SetUIPreference @ 00486b90 (and the Slider / Menu
 * twins) then calls UIOption::SetTooltip(help, table) @ 004ef2c0, so the row
 * widget shows 0x23000003[hash(help)] on hover. The Sound rows are
 * UIOption_CheckboxSlider pairs: the slider key carries the volume pref's
 * help, CONFIG_TOGGLE_HELP_TOKENS the checkbox's.
 */
export const CONFIG_HELP_TOKENS = {
  soundFeatures: 'ID_Sound_SoundFeatures_Help',
  effectsVolume: 'ID_Sound_EffectVolume_Help',
  ambientVolume: 'ID_Sound_AmbientVolume_Help',
  interfaceVolume: 'ID_Sound_InterfaceVolume_Help',
  playSoundsOnlyWhenActive: 'ID_Sound_NoFocusNoSound_Help',
  cameraStiffness: 'ID_Camera_Stiffness_Help',
  cameraAdjustmentSpeed: 'ID_Camera_AdjustmentSpeed_Help',
  fieldOfView: 'ID_Graphics_FieldOfView_Help',
  alignCameraToSlope: 'ID_Camera_AlignToSlope_Help',
  resolution: 'ID_Rendering_DisplayResolution_Help',
  fullScreen: 'ID_Rendering_FullScreen_Help',
  syncWithRefreshRate: 'ID_Rendering_SyncToDisplayRefresh_Help',
  screenBrightness: 'ID_Graphics_ScreenBrightness_Help',
  adaptiveDegrade: 'ID_Graphics_AdaptiveDegrade_Help',
  adaptiveDegradeBias: 'ID_Graphics_AdaptiveDegradeBias_Help',
  degradeDistance: 'ID_Graphics_DegradeDistance_Help',
  landscapeTextureDetail: 'ID_Graphics_LandscapeTextureDetail_Help',
  environmentTextureDetail: 'ID_Graphics_EnvironmentTextureDetail_Help',
  textureFiltering: 'ID_Graphics_TextureFiltering_Help',
  landscapeDrawDistance: 'ID_Graphics_LandscapeDrawDistance_Help',
  buildingDetailTextures: 'ID_Graphics_BuildingDetailTextures_Help',
  multiPassAlpha: 'ID_Graphics_MultiPassAlpha_Help',
  mouseLookSensitivity: 'ID_Input_MouseLookSensitivity_Help',
  invertMouseLookYAxis: 'ID_Input_InvertMouseLookYAxis_Help',
  useMouseTurning: 'ID_Input_UseMouseTurning_Help',
  chatFontFace: 'ID_UI_ChatFontFace_Help',
  chatFontSize: 'ID_UI_ChatFontSize_Help',
} as const satisfies Record<string, string>;

/** The Sound rows' checkbox halves (Sound_*Disabled prefs), keyed by the row's slider key. */
export const CONFIG_TOGGLE_HELP_TOKENS = {
  effectsVolume: 'ID_Sound_DisableSound_Help',
  ambientVolume: 'ID_Sound_DisableAmbientSound_Help',
  interfaceVolume: 'ID_Sound_DisableInterfaceSound_Help',
} as const satisfies Record<string, string>;

/**
 * VISUAL.combat-bar-keep-in-view-label — the combat bar's three
 * UIOption_Checkbox labels. gmCombatUI::PostInit @ 004cc1a0 overrides each
 * row's LayoutDesc p23 text with SetStringInfo(table enum 0x10000003,
 * compute_str_hash("ID_CombatPanelOption_…")), so 0x10000055 reads "Keep in
 * View" (0x23000003 id 154583636), not its authored 0x23000001 "Target In
 * View" (9706964) — the real EoR client under Wine shows "Keep in View".
 */
export const COMBAT_BAR_STRINGS = {
  repeatAttacks: ['ID_CombatPanelOption_AutoRepeatAttack', 'Repeat Attacks'],
  autoTarget: ['ID_CombatPanelOption_AutoTarget', 'Auto Target'],
  keepCombatTargetsInView: ['ID_CombatPanelOption_ViewCombatTarget', 'Keep in View'],
} as const satisfies Record<string, readonly [string, string]>;

/** `optionString` for a combat-bar checkbox label by its option key. */
export function combatBarString(key: keyof typeof COMBAT_BAR_STRINGS): string {
  const [token, fallback] = COMBAT_BAR_STRINGS[key];
  return optionString(token, fallback);
}

/**
 * VISUAL.combat-bar-checkbox-tooltips — the tooltip gmCombatUI::PostInit @
 * 004cc1a0 sets on each checkbox (SetTooltip, table enum 0x10000003 =
 * 0x23000003): compute_str_hash of these tokens (93502288 / 162025280 /
 * 117471984), all three present in 0x23000003.
 */
export const COMBAT_BAR_HELP_TOKENS = {
  repeatAttacks: 'ID_PlayerOption_AutoRepeatAttack_Help',
  autoTarget: 'ID_PlayerOption_AutoTarget_Help',
  keepCombatTargetsInView: 'ID_PlayerOption_ViewCombatTarget_Help',
} as const satisfies Record<keyof typeof COMBAT_BAR_STRINGS, string>;

/** The combat-bar checkbox's tooltip string id (in OPTIONS_STRING_TABLE), or undefined for an unknown key. */
export function combatBarHelpId(key: string): number | undefined {
  const token = (COMBAT_BAR_HELP_TOKENS as Record<string, string>)[key];
  return token === undefined ? undefined : acStringHash(token);
}

/**
 * VISUAL.options-rows-help-tooltips.a — the Chat tab's string table.
 * gmChatOptionsUI::InitOptions @ 0049fc60 builds each channel checkbox with
 * UIOption_CheckboxBitfield64::AddChild @ 004862a0, which binds the label
 * and tooltip StringInfos to table enum 0x10000006 = 0x2300000d; the
 * gameplay-option descs in GameplayOptionList 0x78000000 point there too.
 * The section headers (AddHeader(ID_ChatOption_*_Section)) are in
 * OPTIONS_STRING_TABLE.
 */
export const CHAT_OPTIONS_STRING_TABLE = 0x2300000d;

/**
 * Each channel checkbox's AddChild tokens, by our option-key suffix
 * (`chatMainWindow<suffix>` / `chatWindow<n><suffix>`): the label is
 * `ID_ChatOption_TextFilter_<stem>`, the tooltip the same token + `_Desc`
 * (CreateChildren @ 00485df0 SetStringInfo's the label and SetTooltip's the
 * description on the child's 0x10000219 text). Retail spells Allegiance
 * "Allegience" in the token; the text is spelled right. The fallback is the
 * EoL 0x2300000d label text.
 */
export const CHAT_FILTER_TOKENS = {
  Gameplay: ['Gameplay', 'Gameplay'],
  Combat: ['Combat', 'Combat'],
  Magic: ['Magic', 'Magic'],
  AreaChat: ['AreaSpeech', 'Area Chat'],
  Tells: ['Tells', 'Tells'],
  Allegiance: ['Allegience', 'Allegiance'],
  Fellowship: ['Fellowship', 'Fellowship'],
  General: ['General', 'General Channel'],
  Trade: ['Trade', 'Trade Channel'],
  LFG: ['LFG', 'LFG Channel'],
  Roleplay: ['Roleplay', 'Roleplay Channel'],
  Society: ['Society', 'Society Channel'],
  Errors: ['Error', 'Errors'],
} as const satisfies Record<string, readonly [string, string]>;

export type ChatFilterSuffix = keyof typeof CHAT_FILTER_TOKENS;

/** A channel checkbox's label, resolved through CHAT_OPTIONS_STRING_TABLE. */
export function chatFilterLabel(suffix: ChatFilterSuffix): string {
  const [stem, fallback] = CHAT_FILTER_TOKENS[suffix];
  const id = acStringHash(`ID_ChatOption_TextFilter_${stem}`);
  return getStringFromTable(CHAT_OPTIONS_STRING_TABLE, id) ?? fallback;
}

/** A channel checkbox's tooltip string id (`ID_ChatOption_TextFilter_<stem>_Desc`). */
export function chatFilterHelpId(suffix: ChatFilterSuffix): number {
  return acStringHash(`ID_ChatOption_TextFilter_${CHAT_FILTER_TOKENS[suffix][0]}_Desc`);
}

/** The channel suffix of a Chat-tab checkbox option key, or undefined for any other key. */
export function chatFilterSuffixForKey(key: string): ChatFilterSuffix | undefined {
  const m = /^chat(?:MainWindow|Window[1-4])(.+)$/.exec(key);
  return m && m[1] in CHAT_FILTER_TOKENS ? m[1] as ChatFilterSuffix : undefined;
}

/**
 * The Chat tab's section headers (AddHeader tokens, OPTIONS_STRING_TABLE).
 * Window n is ID_ChatOption_FloatyChatWindow<n>_Section.
 */
export const CHAT_SECTION_TOKENS = {
  general: ['ID_ChatOption_GeneralOptions_Section', 'General Chat Options'],
  main: ['ID_ChatOption_MainChatWindow_Section', 'Main Chat Window'],
} as const satisfies Record<string, readonly [string, string]>;

export function chatSectionHeader(section: keyof typeof CHAT_SECTION_TOKENS | 1 | 2 | 3 | 4): string {
  if (typeof section === 'number') return optionString(`ID_ChatOption_FloatyChatWindow${section}_Section`, `Chat Window ${section}`);
  const [token, fallback] = CHAT_SECTION_TOKENS[section];
  return optionString(token, fallback);
}

/**
 * The two opacity sliders' gameplay-option descs. UIOption_Slider::
 * SetGameplayOptionProperty @ 00485030 asks UIOption::
 * InqGameplayOptionNameAndTooltip @ 004ef750, which finds the option in the
 * 0xd2 array of GameplayOptionList 0x78000000 (UNIQUEDB enum 0x15) by its
 * 0xd6 id and returns the 0xd4 name / 0xd5 tooltip StringInfos; the slider
 * takes the name as its label and SetTooltip's the tooltip. Both entries
 * point into 0x2300000d (tests pin these ids to the DAT).
 */
export const CHAT_OPACITY_OPTION_DESCS = {
  chatInactiveOpacity: { option: 0x10000080, nameId: 196233705, tooltipId: 241731587, fallback: 'Inactive Opacity' },
  chatActiveOpacity: { option: 0x10000081, nameId: 216483161, tooltipId: 87939267, fallback: 'Active Opacity' },
} as const;

/** An opacity slider's 0xd4 name from CHAT_OPTIONS_STRING_TABLE. */
export function chatOpacityLabel(key: keyof typeof CHAT_OPACITY_OPTION_DESCS): string {
  const d = CHAT_OPACITY_OPTION_DESCS[key];
  return getStringFromTable(CHAT_OPTIONS_STRING_TABLE, d.nameId) ?? d.fallback;
}
