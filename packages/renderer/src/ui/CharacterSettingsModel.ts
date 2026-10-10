import { optionString } from './OptionsStrings.js';

/**
 * The retail Options → Character page, ported row for row from
 * `gmCharacterSettingsUI::InitOptions @ 004a02f0` (decomp
 * `acclient-decompiled.annotated.c:160316-161098`).
 *
 * Retail builds the page with `PlayerOptionPage::AddHeader(ID_CharacterOption_
 * <X>_Section)` per section and, per row, `AddToggleOption(<Name>_PlayerOption)`
 * + `SetToggleLabel(row, compute_str_hash("ID_PlayerOption_<Name>"),
 * compute_str_hash("ID_PlayerOption_<Name>_Help"))`. Every row on this page is
 * a checkbox (`AddToggleOption @ 004f2a00` → list template 2,
 * `UIOption_Checkbox::SetPlayerOption @ 00486e80`); an `AddSeperator` (template
 * 1) closes every section. Header and row strings resolve through table enum
 * 0x10000003 = English StringTable 0x23000003 (`SetToggleLabel @ 004f2750`,
 * `AddHeader @ 004f28b0`), keyed by `acStringHash(token)`. Table 0x23000005
 * carries some of the same ids with DIFFERENT (older) text — e.g.
 * ID_PlayerOption_ShowHelm there is "Your helmet or head gear is visible." —
 * so it is not the page's table.
 *
 * Binding: `PlayerModule::GetOption @ 005d3aa0` reads each PlayerOption from a
 * bit of `options_` (ACE CharacterOptions1) or `options2_` (ACE
 * CharacterOptions2). The PlayerOption enum value is exactly ACE's
 * `CharacterOption` value (the SetSingleCharacterOption code).
 *
 * Two retail defaults exist and they disagree on three rows:
 *  - `retailDefault` — the bit in `PlayerModule::PlayerModule @ 005d51f0`'s
 *    `options_ = 0x50c4a54a` / `options2_ = 0x948700` (Ghidra prints the
 *    latter as `&WORD_00948700`). Identical to ACE CharacterOptions1/2
 *    `.Default` (1355064650 / 9733888), i.e. what a fresh character has.
 *  - `defaultsButtonValue` — `PlayerModule::GetDefaultOptionValue @ 005d2a30`,
 *    which `SetPlayerOption` stores as the checkbox's `m_default` (decomp
 *    :137120), i.e. what the page's "Defaults" button restores. It is FALSE
 *    for ConfirmVolatileRareUse, ShowHelm and ShowCloak although the
 *    constructor sets those bits.
 *
 * `label` / `help` are the EoL client_local_English.dat 0x23000003 text for
 * the token (fallbacks; `characterSettingString` prefers the loaded table).
 * `ourKey` is the matching `GameUI.optionsSettings` key (via
 * `GameUI.OPTIONS_TO_CHARACTER_OPTION`, same CharacterOption code), or null
 * when ours has none.
 */

export const PLAYER_MODULE_OPTIONS1_DEFAULT = 0x50c4a54a;
export const PLAYER_MODULE_OPTIONS2_DEFAULT = 0x00948700;

export type CharacterSettingsField = 'options1' | 'options2';

export interface CharacterSettingsPref {
  /** options1 = PlayerModule::options_ (ACE CharacterOptions1); options2 = options2_. */
  field: CharacterSettingsField;
  bit: number;
  mask: number;
}

export interface CharacterSettingsRow {
  /** Retail `PlayerOption` enum member, without the `_PlayerOption` suffix. */
  playerOption: string;
  /** `PlayerOption` value = ACE `CharacterOption` value (SetSingleCharacterOption code). */
  optionId: number;
  token: string;
  label: string;
  helpToken: string;
  help: string;
  control: 'checkbox';
  pref: CharacterSettingsPref;
  /** Bit value in the PlayerModule constructor defaults (= ACE `.Default`). */
  retailDefault: boolean;
  /** `PlayerModule::GetDefaultOptionValue` — what the page's Defaults button restores. */
  defaultsButtonValue: boolean;
  /** ACE `CharacterOption` member name. */
  aceOption: string;
  /** ACE `CharacterOptions1`/`CharacterOptions2` flag, as `Enum.Member`. */
  aceFlag: string;
  /** Our `optionsSettings` key, or null when ours has no such option. */
  ourKey: string | null;
}

export interface CharacterSettingsSection {
  header: { token: string; label: string };
  /** Inclusive decomp line span (annotated.c), AddHeader → closing AddSeperator. */
  decompLines: readonly [number, number];
  rows: readonly CharacterSettingsRow[];
}

export const CHARACTER_SETTINGS_PAGE: readonly CharacterSettingsSection[] = [
  {
    header: { token: 'ID_CharacterOption_UIBehavior_Section', label: 'User Interface Behavior' },
    decompLines: [160324, 160371],
    rows: [
      {
        playerOption: 'ViewCombatTarget', optionId: 0x07,
        token: 'ID_PlayerOption_ViewCombatTarget', label: 'Keep Combat Targets in View',
        helpToken: 'ID_PlayerOption_ViewCombatTarget_Help',
        help: 'When enabled the camera will rotate to face the currently selected target when you are in combat.',
        control: 'checkbox', pref: { field: 'options1', bit: 7, mask: 0x00000080 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'KeepCombatTargetsInView', aceFlag: 'CharacterOptions1.ViewCombatTarget', ourKey: 'keepCombatTargetsInView',
      },
      {
        playerOption: 'SalvageMultiple', optionId: 0x22,
        token: 'ID_PlayerOption_SalvageMultiple', label: 'Salvage Multiple Materials at Once',
        helpToken: 'ID_PlayerOption_SalvageMultiple_Help',
        help: 'When enabled you can drag items of multiple material types into the salvaging window at the same time.  Each material type will be separately salvaged.',
        control: 'checkbox', pref: { field: 'options2', bit: 7, mask: 0x00000080 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'SalvageMultipleMaterialsAtOnce', aceFlag: 'CharacterOptions2.SalvageMultiple', ourKey: 'salvageMultipleMaterialsAtOnce',
      },
      {
        playerOption: 'MainPackPreferred', optionId: 0x29,
        token: 'ID_PlayerOption_MainPackPreferred', label: 'Use Main Pack as Default for Picking Up Items',
        helpToken: 'ID_PlayerOption_MainPackPreferred_Help',
        help: 'When this option is enabled, items that you pick up will always try to fit into your main pack first. When not enabled, items will try to fit into whatever pack you have opened first.',
        control: 'checkbox', pref: { field: 'options2', bit: 14, mask: 0x00004000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'UseMainPackAsDefaultForPickingUpItems', aceFlag: 'CharacterOptions2.MainPackPreferred', ourKey: 'useMainPackAsDefaultForPickingUpItems',
      },
    ],
  },
  {
    header: { token: 'ID_CharacterOption_UIDisplay_Section', label: 'User Interface Display' },
    decompLines: [160372, 160606],
    rows: [
      {
        playerOption: 'VividTargetingIndicator', optionId: 0x0e,
        token: 'ID_PlayerOption_VividTargetingIndicator', label: 'Vivid Targeting Indicator',
        helpToken: 'ID_PlayerOption_VividTargetingIndicator_Help',
        help: 'Enable this option to apply a targeting indicator around selected objects and monsters for better visual reference.',
        control: 'checkbox', pref: { field: 'options1', bit: 15, mask: 0x00008000 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'VividTargetingIndicator', aceFlag: 'CharacterOptions1.VividTargetingIndicator', ourKey: 'vividTargetingIndicator',
      },
      {
        playerOption: 'ShowTooltips', optionId: 0x08,
        token: 'ID_PlayerOption_ShowTooltips', label: 'Display 3D Tooltips',
        helpToken: 'ID_PlayerOption_ShowTooltips_Help',
        help: 'Toggles the tooltip messages on and off. This affects only those tooltips displayed in the 3D view.',
        control: 'checkbox', pref: { field: 'options1', bit: 8, mask: 0x00000100 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'Display3dTooltips', aceFlag: 'CharacterOptions1.ShowTooltips', ourKey: 'showTooltips',
      },
      {
        playerOption: 'CoordinatesOnRadar', optionId: 0x14,
        token: 'ID_PlayerOption_CoordinatesOnRadar', label: 'Show Coordinates By the Radar',
        helpToken: 'ID_PlayerOption_CoordinatesOnRadar_Help',
        help: 'When this option is enabled, your current coordinates are shown near the radar display.',
        control: 'checkbox', pref: { field: 'options1', bit: 22, mask: 0x00400000 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'ShowCoordinatesByTheRadar', aceFlag: 'CharacterOptions1.CoordinatesOnRadar', ourKey: 'showCoordinatesByTheRadar',
      },
      {
        playerOption: 'SideBySideVitals', optionId: 0x13,
        token: 'ID_PlayerOption_SideBySideVitals', label: 'Side By Side Vitals',
        helpToken: 'ID_PlayerOption_SideBySideVitals_Help',
        help: 'When this option is enabled, your vitals will be displayed side by side instead of stacked.',
        control: 'checkbox', pref: { field: 'options1', bit: 21, mask: 0x00200000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'SideBySideVitals', aceFlag: 'CharacterOptions1.SideBySideVitals', ourKey: 'sideBySideVitals',
      },
      {
        playerOption: 'SpellDuration', optionId: 0x15,
        token: 'ID_PlayerOption_SpellDuration', label: 'Display Spell Durations',
        helpToken: 'ID_PlayerOption_SpellDuration_Help',
        help: 'When this option is enabled, you will see the time remaining for all the spells in your spell effect panel.',
        control: 'checkbox', pref: { field: 'options1', bit: 23, mask: 0x00800000 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'DisplaySpellDurations', aceFlag: 'CharacterOptions1.SpellDuration', ourKey: 'displaySpellDurations',
      },
      {
        playerOption: 'DisableMostWeatherEffects', optionId: 0x04,
        token: 'ID_PlayerOption_DisableMostWeatherEffects', label: 'Disable Most Weather Effects',
        helpToken: 'ID_PlayerOption_DisableMostWeatherEffects_Help',
        help: 'Turns off most weather effects. Turning off weather effects can help improve game performance.',
        control: 'checkbox', pref: { field: 'options1', bit: 16, mask: 0x00010000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'DisableMostWeatherEffects', aceFlag: 'CharacterOptions1.DisableMostWeatherEffects', ourKey: 'disableWeather',
      },
      {
        playerOption: 'DisableDistanceFog', optionId: 0x30,
        token: 'ID_PlayerOption_DisableDistanceFog', label: 'Disable Distance Fog',
        helpToken: 'ID_PlayerOption_DisableDistanceFog_Help',
        help: 'When this option is enabled, the landscape will no longer use distance fog.',
        control: 'checkbox', pref: { field: 'options2', bit: 21, mask: 0x00200000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'DisableDistanceFog', aceFlag: 'CharacterOptions2.DisableDistanceFog', ourKey: 'disableDistanceFog',
      },
      {
        playerOption: 'PersistentAtDay', optionId: 0x05,
        token: 'ID_PlayerOption_PersistentAtDay', label: 'Always Daylight Outdoors',
        helpToken: 'ID_PlayerOption_PersistentAtDay_Help',
        help: 'Increases the ambient light when outside at night.',
        control: 'checkbox', pref: { field: 'options2', bit: 0, mask: 0x00000001 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'AlwaysDaylightOutdoors', aceFlag: 'CharacterOptions2.PersistentAtDay', ourKey: 'alwaysDaylight',
      },
      {
        playerOption: 'DisableHouseRestrictionEffects', optionId: 0x16,
        token: 'ID_PlayerOption_DisableHouseRestrictionEffects', label: 'Disable House Restriction Effects',
        helpToken: 'ID_PlayerOption_DisableHouseRestrictionEffects_Help',
        help: 'Disables the particle effects that are displayed when you collide with a house barrier. Turning off this option may improve game performance.',
        control: 'checkbox', pref: { field: 'options1', bit: 25, mask: 0x02000000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'DisableHouseRestrictionEffects', aceFlag: 'CharacterOptions1.DisableHouseRestrictionEffects', ourKey: 'disableHouseRestrictionEffects',
      },
      {
        playerOption: 'UseCraftSuccessDialog', optionId: 0x1a,
        token: 'ID_PlayerOption_UseCraftSuccessDialog', label: 'Use Crafting Chance of Success Dialog',
        helpToken: 'ID_PlayerOption_UseCraftSuccessDialog_Help',
        help: 'When enabled your craft attempts will first display a dialog with your percentage chance of succeeding.  Only after accepting this dialog will a crafting attempt be made.',
        control: 'checkbox', pref: { field: 'options1', bit: 31, mask: 0x80000000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'UseCraftingChanceOfSuccessDialog', aceFlag: 'CharacterOptions1.UseCraftSuccessDialog', ourKey: 'useCraftingChanceOfSuccessDialog',
      },
      {
        playerOption: 'ConfirmVolatileRareUse', optionId: 0x2d,
        token: 'ID_PlayerOption_ConfirmVolatileRareUse', label: 'Confirm Use of Rare Gems',
        helpToken: 'ID_PlayerOption_ConfirmVolatileRareUse_Help',
        help: 'When enabled, this option causes any one-use rare gem to trigger a confirmation dialog. This helps prevent the accidental use of one-use rare gems.',
        control: 'checkbox', pref: { field: 'options2', bit: 18, mask: 0x00040000 },
        retailDefault: true, defaultsButtonValue: false,
        aceOption: 'ConfirmUseOfRareGems', aceFlag: 'CharacterOptions2.ConfirmVolatileRareUse', ourKey: 'confirmUseOfRareGems',
      },
      {
        playerOption: 'DisplayTimeStamps', optionId: 0x21,
        token: 'ID_PlayerOption_DisplayTimeStamps', label: 'Display Timestamps',
        helpToken: 'ID_PlayerOption_DisplayTimeStamps_Help',
        help: 'Attaches a time stamp to all displayed text.',
        control: 'checkbox', pref: { field: 'options2', bit: 6, mask: 0x00000040 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'DisplayTimestamps', aceFlag: 'CharacterOptions2.TimeStamp', ourKey: 'displayTimestamps',
      },
      {
        playerOption: 'FilterLanguage', optionId: 0x2c,
        token: 'ID_PlayerOption_FilterLanguage', label: 'Filter Language',
        helpToken: 'ID_PlayerOption_FilterLanguage_Help',
        help: 'When this option is enabled, vulgar language will display as *** in your chat windows.',
        control: 'checkbox', pref: { field: 'options2', bit: 17, mask: 0x00020000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'FilterLanguage', aceFlag: 'CharacterOptions2.FilterLanguage', ourKey: 'filterLanguage',
      },
      {
        playerOption: 'ShowHelm', optionId: 0x2f,
        token: 'ID_PlayerOption_ShowHelm', label: 'Show Your Helm or Head Gear',
        helpToken: 'ID_PlayerOption_ShowHelm_Help',
        help: 'When this option is enabled, your helm or head gear is visible.',
        control: 'checkbox', pref: { field: 'options2', bit: 20, mask: 0x00100000 },
        retailDefault: true, defaultsButtonValue: false,
        aceOption: 'ShowYourHelmOrHeadGear', aceFlag: 'CharacterOptions2.ShowHelm', ourKey: 'showHelm',
      },
      {
        playerOption: 'ShowCloak', optionId: 0x32,
        token: 'ID_PlayerOption_ShowCloak', label: 'Show Your Cloak',
        helpToken: 'ID_PlayerOption_ShowCloak_Help',
        help: 'When this option is enabled, your cloak is visible.',
        control: 'checkbox', pref: { field: 'options2', bit: 23, mask: 0x00800000 },
        retailDefault: true, defaultsButtonValue: false,
        aceOption: 'ShowYourCloak', aceFlag: 'CharacterOptions2.ShowCloak', ourKey: 'showCloak',
      },
    ],
  },
  {
    header: { token: 'ID_CharacterOption_Grouping_Section', label: 'Grouping' },
    decompLines: [160607, 160708],
    rows: [
      {
        playerOption: 'IgnoreAllegianceRequests', optionId: 0x01,
        token: 'ID_PlayerOption_IgnoreAllegianceRequests', label: 'Ignore Allegiance Requests',
        helpToken: 'ID_PlayerOption_IgnoreAllegianceRequests_Help',
        help: 'When this option is enabled, you will automatically ignore invitations to join an allegiance, thus avoiding the display of the normal dialog box. Note that you always ignore allegiance requests from players you have squelched, regardless of this setting.',
        control: 'checkbox', pref: { field: 'options1', bit: 2, mask: 0x00000004 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'IgnoreAllegianceRequests', aceFlag: 'CharacterOptions1.IgnoreAllegianceRequests', ourKey: 'ignoreAllegianceRequests',
      },
      {
        playerOption: 'IgnoreFellowshipRequests', optionId: 0x02,
        token: 'ID_PlayerOption_IgnoreFellowshipRequests', label: 'Ignore Fellowship Requests',
        helpToken: 'ID_PlayerOption_IgnoreFellowshipRequests_Help',
        help: 'When this option is enabled, you will automatically ignore invitations to join a fellowship, thus avoiding the display of the normal dialog box. Note that you always ignore fellowship requests from players you have squelched, regardless of this setting.',
        control: 'checkbox', pref: { field: 'options1', bit: 3, mask: 0x00000008 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'IgnoreFellowshipRequests', aceFlag: 'CharacterOptions1.IgnoreFellowshipRequests', ourKey: 'ignoreFellowshipRequests',
      },
      {
        playerOption: 'DisplayAllegianceLogonNotifications', optionId: 0x18,
        token: 'ID_PlayerOption_DisplayAllegianceLogonNotifications', label: 'Show Allegiance Logons',
        helpToken: 'ID_PlayerOption_DisplayAllegianceLogonNotifications_Help',
        help: 'When enabled you will get messages when your Monarch, Patron, or Vassals log in or log out.',
        control: 'checkbox', pref: { field: 'options1', bit: 27, mask: 0x08000000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'ShowAllegianceLogons', aceFlag: 'CharacterOptions1.DisplayAllegianceLogonNotifications', ourKey: 'showAllegianceLogons',
      },
      {
        playerOption: 'FellowshipShareXP', optionId: 0x0f,
        token: 'ID_PlayerOption_FellowshipShareXP', label: 'Share Fellowship Experience and Luminance',
        helpToken: 'ID_PlayerOption_FellowshipShareXP_Help',
        help: 'This only affects the creation of new fellowships. When checked, experience earned while in a fellowship will be shared with other fellowship members.',
        control: 'checkbox', pref: { field: 'options1', bit: 18, mask: 0x00040000 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'ShareFellowshipExpAndLuminance', aceFlag: 'CharacterOptions1.FellowshipShareXP', ourKey: 'shareFellowshipXP',
      },
      {
        playerOption: 'FellowshipShareLoot', optionId: 0x11,
        token: 'ID_PlayerOption_FellowshipShareLoot', label: 'Share Fellowship Loot',
        helpToken: 'ID_PlayerOption_FellowshipShareLoot_Help',
        help: 'This only affects the creation of new fellowships.  When checked anyone in your fellowship can loot things killed by a member of the fellowship.',
        control: 'checkbox', pref: { field: 'options1', bit: 20, mask: 0x00100000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'ShareFellowshipLoot', aceFlag: 'CharacterOptions1.FellowshipShareLoot', ourKey: 'shareFellowshipLoot',
      },
      {
        playerOption: 'FellowshipAutoAcceptRequests', optionId: 0x12,
        token: 'ID_PlayerOption_FellowshipAutoAcceptRequests', label: 'Automatically Accept Fellowship Requests',
        helpToken: 'ID_PlayerOption_FellowshipAutoAcceptRequests_Help',
        help: 'When this option is enabled, you will automatically accept any fellowship requests. Note that Accept Fellowship Requests must be on before this will work.',
        control: 'checkbox', pref: { field: 'options1', bit: 29, mask: 0x20000000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'AutomaticallyAcceptFellowshipRequests', aceFlag: 'CharacterOptions1.AutoAcceptFellowRequest', ourKey: 'autoAcceptFellowshipRequests',
      },
    ],
  },
  {
    header: { token: 'ID_CharacterOption_OtherPlayers_Section', label: 'Other Players' },
    decompLines: [160709, 160882],
    rows: [
      {
        playerOption: 'AcceptLootPermits', optionId: 0x10,
        token: 'ID_PlayerOption_AcceptLootPermits', label: 'Accept Corpse Looting Permissions',
        helpToken: 'ID_PlayerOption_AcceptLootPermits_Help',
        help: 'When checked your character will accept permission to loot other peoples corpses.  The corpse owner must first grant permission using the @permit command.',
        control: 'checkbox', pref: { field: 'options1', bit: 19, mask: 0x00080000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'AcceptCorpseLootingPermissions', aceFlag: 'CharacterOptions1.AcceptLootPermits', ourKey: 'acceptCorpseLooting',
      },
      {
        playerOption: 'UseDeception', optionId: 0x09,
        token: 'ID_PlayerOption_UseDeception', label: 'Attempt to Deceive Other Players',
        helpToken: 'ID_PlayerOption_UseDeception_Help',
        help: 'When enabled your character will attempt to use the Deception skill to hide your player information from other players.',
        control: 'checkbox', pref: { field: 'options1', bit: 9, mask: 0x00000200 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'AttemptToDeceiveOtherPlayers', aceFlag: 'CharacterOptions1.UseDeception', ourKey: 'attemptToDeceiveOthers',
      },
      {
        playerOption: 'AllowGive', optionId: 0x06,
        token: 'ID_PlayerOption_AllowGive', label: 'Let Other Players Give You Items',
        helpToken: 'ID_PlayerOption_AllowGive_Help',
        help: 'When this option is checked, other players can give you items without your consent.',
        control: 'checkbox', pref: { field: 'options1', bit: 6, mask: 0x00000040 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'LetOtherPlayersGiveYouItems', aceFlag: 'CharacterOptions1.AllowGive', ourKey: 'allowGive',
      },
      {
        playerOption: 'IgnoreTradeRequests', optionId: 0x03,
        token: 'ID_PlayerOption_IgnoreTradeRequests', label: 'Ignore All Trade Requests',
        helpToken: 'ID_PlayerOption_IgnoreTradeRequests_Help',
        help: 'When checked you will ignore attempts by other players to enter secure trade with you.',
        control: 'checkbox', pref: { field: 'options1', bit: 17, mask: 0x00020000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'IgnoreAllTradeRequests', aceFlag: 'CharacterOptions1.IgnoreTradeRequests', ourKey: 'ignoreTradeRequests',
      },
      {
        playerOption: 'DragItemOnPlayerOpensSecureTrade', optionId: 0x17,
        token: 'ID_PlayerOption_DragItemOnPlayerOpensSecureTrade', label: 'Drag Item to Player Opens Trade',
        helpToken: 'ID_PlayerOption_DragItemOnPlayerOpensSecureTrade_Help',
        help: 'When this option is enabled, dragging an item to another player will open secure trade. When this option is disabled, dragging an item to another player will attempt to give away the item.',
        control: 'checkbox', pref: { field: 'options1', bit: 26, mask: 0x04000000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'DragItemToPlayerOpensTrade', aceFlag: 'CharacterOptions1.DragItemOnPlayerOpensSecureTrade', ourKey: 'dragItemToPlayerOpensTrade',
      },
      {
        playerOption: 'DisplayDateOfBirth', optionId: 0x1c,
        token: 'ID_PlayerOption_DisplayDateOfBirth', label: 'Allow Others to See Your Date of Birth',
        helpToken: 'ID_PlayerOption_DisplayDateOfBirth_Help',
        help: 'When this option is enabled, other players can see the date your character was created.',
        control: 'checkbox', pref: { field: 'options2', bit: 1, mask: 0x00000002 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'AllowOthersToSeeYourDateOfBirth', aceFlag: 'CharacterOptions2.DisplayDateOfBirth', ourKey: 'allowSeeDateOfBirth',
      },
      {
        playerOption: 'DisplayAge', optionId: 0x1d,
        token: 'ID_PlayerOption_DisplayAge', label: 'Allow Others to See Your Age',
        helpToken: 'ID_PlayerOption_DisplayAge_Help',
        help: 'When this option is enabled, other players can see how long your character has been in the world.',
        control: 'checkbox', pref: { field: 'options2', bit: 5, mask: 0x00000020 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'AllowOthersToSeeYourAge', aceFlag: 'CharacterOptions2.DisplayAge', ourKey: 'allowSeeAge',
      },
      {
        playerOption: 'DisplayChessRank', optionId: 0x1e,
        token: 'ID_PlayerOption_DisplayChessRank', label: 'Allow Others to See Your Chess Rank',
        helpToken: 'ID_PlayerOption_DisplayChessRank_Help',
        help: 'When this option is enabled, other players can see your chess ranking.',
        control: 'checkbox', pref: { field: 'options2', bit: 2, mask: 0x00000004 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'AllowOthersToSeeYourChessRank', aceFlag: 'CharacterOptions2.DisplayChessRank', ourKey: 'allowSeeChessRank',
      },
      {
        playerOption: 'DisplayFishingSkill', optionId: 0x1f,
        token: 'ID_PlayerOption_DisplayFishingSkill', label: 'Allow Others to See Your Fishing Skill',
        helpToken: 'ID_PlayerOption_DisplayFishingSkill_Help',
        help: 'When this option is enabled, other players can see your fishing skill.',
        control: 'checkbox', pref: { field: 'options2', bit: 3, mask: 0x00000008 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'AllowOthersToSeeYourFishingSkill', aceFlag: 'CharacterOptions2.DisplayFishingSkill', ourKey: 'allowSeeFishingSkill',
      },
      {
        playerOption: 'DisplayNumberDeaths', optionId: 0x20,
        token: 'ID_PlayerOption_DisplayNumberDeaths', label: 'Allow Others to See Your Number of Deaths',
        helpToken: 'ID_PlayerOption_DisplayNumberDeaths_Help',
        help: 'When this option is enabled, other players can see how many times you have died.',
        control: 'checkbox', pref: { field: 'options2', bit: 4, mask: 0x00000010 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'AllowOthersToSeeYourNumberOfDeaths', aceFlag: 'CharacterOptions2.DisplayNumberDeaths', ourKey: 'allowSeeNumberOfDeaths',
      },
      {
        playerOption: 'DisplayNumberCharacterTitles', optionId: 0x28,
        token: 'ID_PlayerOption_DisplayNumberCharacterTitles', label: 'Allow Others to See Your Number of Titles',
        helpToken: 'ID_PlayerOption_DisplayNumberCharacterTitles_Help',
        help: 'When this option is enabled, other players can see how many character titles you possess.',
        control: 'checkbox', pref: { field: 'options2', bit: 13, mask: 0x00002000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'AllowOthersToSeeYourNumberOfTitles', aceFlag: 'CharacterOptions2.DisplayNumberCharacterTitles', ourKey: 'allowSeeNumberOfTitles',
      },
    ],
  },
  {
    header: { token: 'ID_CharacterOption_CharacterBehavior_Section', label: 'Character Behavior' },
    decompLines: [160883, 160989],
    rows: [
      {
        playerOption: 'ToggleRun', optionId: 0x0a,
        token: 'ID_PlayerOption_ToggleRun', label: 'Run as Default Movement',
        helpToken: 'ID_PlayerOption_ToggleRun_Help',
        help: 'When this option is enabled, the forward command will cause your avatar to run instead of walk.',
        control: 'checkbox', pref: { field: 'options1', bit: 10, mask: 0x00000400 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'RunAsDefaultMovement', aceFlag: 'CharacterOptions1.ToggleRun', ourKey: 'runAsDefault',
      },
      {
        playerOption: 'AdvancedCombatUI', optionId: 0x0c,
        token: 'ID_PlayerOption_AdvancedCombatUI', label: 'Advanced Combat Interface',
        helpToken: 'ID_PlayerOption_AdvancedCombatUI_Help',
        help: 'Enabling Advanced Combat disables the combat panel, and only displays the Power/Accuracy bar when in combat mode.',
        control: 'checkbox', pref: { field: 'options1', bit: 12, mask: 0x00001000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'AdvancedCombatInterface', aceFlag: 'CharacterOptions1.AdvancedCombatUI', ourKey: 'advancedCombatUI',
      },
      {
        playerOption: 'AutoTarget', optionId: 0x0d,
        token: 'ID_PlayerOption_AutoTarget', label: 'Auto Target',
        helpToken: 'ID_PlayerOption_AutoTarget_Help',
        help: 'When this option is enabled, in combat you will automatically target the next closest enemy once your current enemy dies.',
        control: 'checkbox', pref: { field: 'options1', bit: 13, mask: 0x00002000 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'AutoTarget', aceFlag: 'CharacterOptions1.AutoTarget', ourKey: 'autoTarget',
      },
      {
        playerOption: 'AutoRepeatAttack', optionId: 0x00,
        token: 'ID_PlayerOption_AutoRepeatAttack', label: 'Automatically Repeat Attacks',
        helpToken: 'ID_PlayerOption_AutoRepeatAttack_Help',
        help: 'When in melee or missile combat modes, this option will automatically begin another attack when your previous attack finishes.',
        control: 'checkbox', pref: { field: 'options1', bit: 1, mask: 0x00000002 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'AutoRepeatAttacks', aceFlag: 'CharacterOptions1.AutoRepeatAttack', ourKey: 'repeatAttacks',
      },
      {
        playerOption: 'UseChargeAttack', optionId: 0x19,
        token: 'ID_PlayerOption_UseChargeAttack', label: 'Use Charge Attack',
        helpToken: 'ID_PlayerOption_UseChargeAttack_Help',
        help: 'When enabled you will do a short high-speed sprint when melee attacking at range.  If you do not reach the target during this sprint you will stop.  When disabled you will charge opponents at normal run speed but without the distance limit.',
        control: 'checkbox', pref: { field: 'options1', bit: 28, mask: 0x10000000 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'UseChargeAttack', aceFlag: 'CharacterOptions1.UseChargeAttack', ourKey: 'useChargeAttack',
      },
      {
        playerOption: 'LeadMissileTargets', optionId: 0x2a,
        token: 'ID_PlayerOption_LeadMissileTargets', label: 'Lead Missile Targets',
        helpToken: 'ID_PlayerOption_LeadMissileTargets_Help',
        help: 'When this option is enabled, you will lead your targets (aiming where you believe they will be shortly) when attacking with a missile weapon like a bow, crossbow, or atlatl. When this option is disabled, you will aim exactly where you target is when you fire the missile. This option does not affect magic projectiles.',
        control: 'checkbox', pref: { field: 'options2', bit: 15, mask: 0x00008000 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'LeadMissileTargets', aceFlag: 'CharacterOptions2.LeadMissileTargets', ourKey: 'leadMissileTargets',
      },
      {
        playerOption: 'UseFastMissiles', optionId: 0x2b,
        token: 'ID_PlayerOption_UseFastMissiles', label: 'Use Fast Missiles',
        helpToken: 'ID_PlayerOption_UseFastMissiles_Help',
        help: 'When this option is enabled, any missiles that you fire (like arrows, quarrels, and atlatl darts) will travel faster than normal, and with less arc than normal. Note that your rate of fire will remain unchanged.',
        control: 'checkbox', pref: { field: 'options2', bit: 16, mask: 0x00010000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'UseFastMissiles', aceFlag: 'CharacterOptions2.UseFastMissiles', ourKey: 'useFastMissiles',
      },
    ],
  },
  {
    header: { token: 'ID_CharacterOption_Chat_Section', label: 'Chat' },
    decompLines: [160990, 161093],
    rows: [
      {
        playerOption: 'StayInChatMode', optionId: 0x0b,
        token: 'ID_PlayerOption_StayInChatMode', label: 'Stay in Chat Mode After Sending a Message',
        helpToken: 'ID_PlayerOption_StayInChatMode_Help',
        help: 'Normally pressing return from chat mode will return you to gameplay mode.  With this option enabled it will leave you in chat mode ready to type your next message.',
        control: 'checkbox', pref: { field: 'options1', bit: 11, mask: 0x00000800 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'StayInChatModeAfterSendingMessage', aceFlag: 'CharacterOptions1.StayInChatMode', ourKey: 'stayInChatMode',
      },
      {
        playerOption: 'HearAllegianceChat', optionId: 0x1b,
        token: 'ID_PlayerOption_HearAllegianceChat', label: 'Listen to Allegiance Chat',
        helpToken: 'ID_PlayerOption_HearAllegianceChat_Help',
        help: 'When this option is enabled, you can hear the chat channel for your allegiance.',
        control: 'checkbox', pref: { field: 'options1', bit: 30, mask: 0x40000000 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'ListenToAllegianceChat', aceFlag: 'CharacterOptions1.HearAllegianceChat', ourKey: 'listenAllegiance',
      },
      {
        playerOption: 'HearGeneralChat', optionId: 0x23,
        token: 'ID_PlayerOption_HearGeneralChat', label: 'Listen to General Chat',
        helpToken: 'ID_PlayerOption_HearGeneralChat_Help',
        help: "When this option is enabled, you can hear and speak on the global General chat channel. This channel is for general discussions about Asheron's Call.",
        control: 'checkbox', pref: { field: 'options2', bit: 8, mask: 0x00000100 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'ListenToGeneralChat', aceFlag: 'CharacterOptions2.HearGeneralChat', ourKey: 'listenGeneral',
      },
      {
        playerOption: 'HearTradeChat', optionId: 0x24,
        token: 'ID_PlayerOption_HearTradeChat', label: 'Listen to Trade Chat',
        helpToken: 'ID_PlayerOption_HearTradeChat_Help',
        help: 'When this option is enabled, you can hear and speak on the global Trade chat channel. This channel is for arranging in-game trades with other players.',
        control: 'checkbox', pref: { field: 'options2', bit: 9, mask: 0x00000200 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'ListenToTradeChat', aceFlag: 'CharacterOptions2.HearTradeChat', ourKey: 'listenTrade',
      },
      {
        playerOption: 'HearLFGChat', optionId: 0x25,
        token: 'ID_PlayerOption_HearLFGChat', label: 'Listen to LFG Chat',
        helpToken: 'ID_PlayerOption_HearLFGChat_Help',
        help: 'When this option is enabled, you can hear and speak on the global Looking For Group chat channel. This channel helps you find other players to adventure with.',
        control: 'checkbox', pref: { field: 'options2', bit: 10, mask: 0x00000400 },
        retailDefault: true, defaultsButtonValue: true,
        aceOption: 'ListenToLFGChat', aceFlag: 'CharacterOptions2.HearLFGChat', ourKey: 'listenLFG',
      },
      {
        playerOption: 'HearRoleplayChat', optionId: 0x26,
        token: 'ID_PlayerOption_HearRoleplayChat', label: 'Listen to Roleplay Chat',
        helpToken: 'ID_PlayerOption_HearRoleplayChat_Help',
        help: "When this option is enabled, you can hear and speak on the global Roleplay chat channel. This channel is for in-character roleplaying and for discussions about roleplaying in Asheron's Call.",
        control: 'checkbox', pref: { field: 'options2', bit: 11, mask: 0x00000800 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'ListenToRoleplayChat', aceFlag: 'CharacterOptions2.HearRoleplayChat', ourKey: 'listenRoleplay',
      },
      {
        playerOption: 'HearSocietyChat', optionId: 0x2e,
        token: 'ID_PlayerOption_HearSocietyChat', label: 'Listen to Society Chat',
        helpToken: 'ID_PlayerOption_HearSocietyChat_Help',
        help: "When this option is enabled, you can hear and speak on the global Society chat channel. This channel is for coordinating Society based quests and for discussions about your Society affiliation in Asheron's Call.",
        control: 'checkbox', pref: { field: 'options2', bit: 19, mask: 0x00080000 },
        retailDefault: false, defaultsButtonValue: false,
        aceOption: 'ListenToSocietyChat', aceFlag: 'CharacterOptions2.HearSocietyChat', ourKey: 'listenSociety',
      },
    ],
  },
];

/** Every row in retail page order. */
export const CHARACTER_SETTINGS_ROWS: readonly CharacterSettingsRow[] =
  CHARACTER_SETTINGS_PAGE.flatMap((s) => s.rows);

/** Retail rows ours has no option for (the integrator must add them). */
export const CHARACTER_SETTINGS_UNSUPPORTED: readonly CharacterSettingsRow[] =
  CHARACTER_SETTINGS_ROWS.filter((r) => r.ourKey === null);

/**
 * Toggles our Character tab renders that retail's Character page does NOT
 * have, with where retail puts them instead.
 */
export const OUR_CHARACTER_TAB_EXTRAS: ReadonlyArray<{ ourKey: string; retailHome: string }> = [
  {
    ourKey: 'lockUI',
    retailHome: 'LockUI_PlayerOption (51) is on no options page: the radar lock button '
      + '(gmRadarUI::ListenToElementMessage @ 004d75b0) and /lockui '
      + '(ClientCommunicationSystem::DoLockUI @ 005703b0) toggle it.',
  },
  {
    ourKey: 'useMouseTurning',
    retailHome: 'Config page, Input section (gmConfigUI::InitOptions @ 0049e400; '
      + 'ID_Input_UseMouseTurning).',
  },
  {
    ourKey: 'appearOffline',
    retailHome: 'Friends panel checkbox (gmFriendsUI::PostInit @ 0048d0f0, '
      + 'SetPlayerOption(AppearOffline_PlayerOption), decomp :143174).',
  },
];

/** Resolve a page token through the live 0x23000003 table, else the EoL text. */
export function characterSettingString(token: string, fallback: string): string {
  return optionString(token, fallback);
}

/** Retail row for one of our option keys, if the Character page has it. */
export function characterSettingsRowForKey(ourKey: string): CharacterSettingsRow | undefined {
  return CHARACTER_SETTINGS_ROWS.find((r) => r.ourKey === ourKey);
}

/** `PlayerModule::GetOption` for a page row. */
export function readCharacterSetting(
  row: CharacterSettingsRow, options1: number, options2: number,
): boolean {
  const word = row.pref.field === 'options1' ? options1 : options2;
  return ((word >>> row.pref.bit) & 1) === 1;
}

/** Set/clear a row's bit; returns the updated [options1, options2] words (uint32). */
export function writeCharacterSetting(
  row: CharacterSettingsRow, options1: number, options2: number, value: boolean,
): [number, number] {
  const apply = (w: number): number => (value ? (w | row.pref.mask) : (w & ~row.pref.mask)) >>> 0;
  return row.pref.field === 'options1'
    ? [apply(options1), options2 >>> 0]
    : [options1 >>> 0, apply(options2)];
}
