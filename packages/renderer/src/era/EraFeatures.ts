/**
 * Era capabilities: the features a world's era lacks, so the interface hides
 * their controls instead of showing ones that do nothing (CLAUDE.md "No
 * Dead-End UI"; docs/ac1999-support-scope.md Phase 5). One source of truth:
 * the 1999 adapter's absent-feature list (network era1999/Absent1999.ts)
 * plus the interface-only gaps below. End of retail and the classic eras run
 * the end-of-retail client and lack nothing here.
 */
import { ABSENT_1999, type Absent1999Feature } from '@ac/network';
import { INVENTORY_REQUEST_WATCHDOG_1999_SECONDS, TALISMAN_TARGET_TYPES_1999, TALISMAN_TARGET_TYPES_EOR, type TalismanTargetTypes, PROMISSORY_NOTE_RATES_EOR, PROMISSORY_NOTE_RATES_1999, type PromissoryNoteRates } from '@ac/shared';
import type { EraProfile } from './EraProfiles.js';
import { quickslotCommand } from '../network/itemShortcutRestore.js';
import { SPELL_RESEARCH_PAGE_ACTION } from '../input/KeybindClientActions.js';
import type { EraKeymap } from '../input/EraKeymaps.js';
import { MAP_NOTE_LOCATIONS, type MapNoteLocation } from '../ui/HudTooltips.js';
import { MAP_MARKER_AREA, MAP_MARKER_AREA_1999, type MapMarkerArea, type MapPlacement } from '../ui/MapMarkers.js';
import type { HitLineText, ServerTextSlots } from '../ui/ServerMessageText.js';
import { FAILURE_EVENT_TEXT_1999, type FailureEventTable } from '../ui/FailureEventText1999.js';
import { AC1999_PLACEMENT_TEXT, EOR_PLACEMENT_TEXT, type PlacementText } from '../inventory/ItemHolderPlacement.js';
import { AC1999_USE_OBJECT_RULES, EOR_USE_OBJECT_RULES, type UseObjectRules } from '../input/UseObject.js';
import { AC1999_ENCUMBRANCE_NOTICE, EOR_ENCUMBRANCE_NOTICE, type EncumbranceNoticeRules } from '../ui/EncumbranceNotice.js';
import { AC1999_WORLD_RULES, EOR_WORLD_RULES, type EraWorldRules } from './EraWorldRules.js';
import { AC1999_VERBOSE_VERSION } from '../chat/commands/Commands1999.js';
import type { CommandTableStyle } from '../chat/commands/CommandSystem.js';

export type EraFeature =
  | Absent1999Feature
  /** The wcid-keyed weenie side-files (combat style, attack type, weapon time): end-of-retail wcids. */
  | 'eolWcidTables'
  /**
   * The Friends page: 1999 keeps the friends list on the server and answers @friends in chat only
   * (kb 0xF7CD-FriendsCommand: no inbound friends message, no friends panel), so the page sends
   * the 1999 FriendsCommand for /friends instead.
   */
  | 'friendsPanel'
  /** Nether damage: the 1999 armor profile has seven resistances, no nether (Inventory1999 appraisal). */
  | 'netherDamage'
  /**
   * Later item kinds and pastimes the 1999 client.exe has no trace of (BUG.ac1999-char-info-eor-rows
   * sweep): cloaks (the Show Your Cloak option), rare gems (Confirm Use of Rare Gems) and fishing
   * (Allow Others to See Your Fishing Skill). Its options page lists fifteen character options,
   * none of these (strings @ file 0x210a44-0x210ba8), and its strings name no cloak, trinket or
   * fishing at all. (The paperdoll's slots are data: EraClientRules.equipSlotMask.)
   */
  | 'cloaks'
  | 'rareGems'
  | 'fishing'
  /**
   * The Social panel's Squelch page, a list of the squelched names (BUG.ac1999-eor-ui sweep). The
   * 1999 social panel has Allegiance and Fellowship only; its squelch list is a bare id list on the
   * client, set by @squelch / @unsquelch and the chat menu's Ignore item, and nothing lists it:
   * "@squelch with no argument to list the squelched names" came in a later patch (reference/ac1999
   * kb client-behavior/squelch-list.md, Sybex guide appendix). @squelch / @unsquelch stay.
   */
  | 'squelchListPage'
  /**
   * The Components page's desired-level column and @fillcomps (BUG.ac1999-eor-ui sweep): the
   * player's rebuy book, saved on the server by SetDesiredComponentLevel 0x224, which has no 1999
   * builder (docs/ac1999-support.md, Combat1999 drops it), and @fillcomps, which buys from that
   * book (not in the 1999 client's @-command table, kb client-behavior/ui-command-dispatch.md).
   */
  | 'desiredComponents'
  /**
   * Automatically Accept Fellowship Requests (CharacterOptions1.AutoAcceptFellowRequest): not one
   * of the 1999 client's fifteen character options (CharOptionsPanel @ 0x00591260), and
   * nothing on the AC1999 server or in our client acts on it there, so its fellowship-pane
   * checkbox, its Character options row, its Keyboard Config command and the agent's auto toggle
   * are inert on 1999.
   */
  | 'autoAcceptFellowship'
  /**
   * The coordinates under the radar and their Show Coordinates By the Radar option
   * (BUG.webac11-radar-1999, webac#11). End of retail's gmRadarUI::UpdateCoordinates prints them
   * when PlayerModule::CoordinatesOnRadar is on (its default). The 1999 client.exe's
   * RadarUI_Update @ 0x527fc0 prints no coordinates (its only texts are the two hover lines
   * "Blips show creatures and other important objects." 0x607400 and "You are facing toward the
   * top of the Compass." 0x6073d0), its options page has no such row (strings @ file
   * 0x210a44-0x210bb8), and its one coordinate format ("%.1f%s, %.1f%s" 0x602e80) belongs to the
   * map page (MapSubPanel_UpdateDateAndTime @ 0x5087f0, the push @ 0x508c0d). The map keeps them.
   */
  | 'radarCoordinates'
  /**
   * The remaining time beside each spell in the effects list and its Display Spell Durations
   * option (BUG.webac11-radar-1999 sweep). End of retail's EffectInfoRegion::Update @ 004f1c00
   * writes "%d:%02d" / "%d:%02d:%02d" while PlayerModule::SpellDuration is on (its default). The
   * 1999 client.exe's SpellsInEffectPanel (@ 0x59ac70, info text @ 0x59b7c0: the name, the
   * description, "NO SPELLS" / "SELECT A SPELL") shows none, and the exe has no clock format at all
   * (no "%d:%02d"), and no such row on its options page.
   */
  | 'spellDurations'
  /**
   * The spellbook's school and level filter buttons (SWEEP1999.magic MAG-8). The 1999 SpellbookPanel
   * ctor builds the list, its scrollbar, the info text and Delete, and nothing else; AddSpell @
   * 0x5169d0 inserts every spell with no filter test, and the client has no 0x286 SpellbookFilter
   * builder. A 1999 world lists every spell and draws no filter controls.
   */
  | 'spellbookFilters';

const NONE: ReadonlySet<EraFeature> = new Set();
/**
 * What a 1999 world hides, and why each entry still needs to (2026-10-06).
 * Only features whose target needs something the 1999 server or its data
 * lack belong here; a purely client-side panel stays. The World panel (map
 * button, its keys) is client-side: the world portal's own map picture (the
 * 1999 portal's 1999 Dereth, webac#10) and the player's own position, so it
 * shows on 1999 too (Jake 2026-10-06: "there should still be a map button").
 *
 * - every ABSENT_1999 feature (network era1999/Absent1999.ts, one cited kb
 *   scan per entry): the 1999 client has no builder for their actions and
 *   the 1999 server no handler, so their controls would send nothing:
 *   secure trade, housing, consent, chess, TurbineChat, contracts (the
 *   journal button and panel: no contract tracker on the 1999 server),
 *   character titles, salvage, fellowship leadership, allegiance admin, AFK,
 *   the post-launch recalls, PK Lite, squelch filters, confirmations, plugin
 *   queries, the barber, character restore;
 * - eolWcidTables: data, not a control: the side-files are keyed by
 *   end-of-retail wcids, which name other weenies on a 1999 server;
 * - friendsPanel: the 1999 server keeps the friends list and answers
 *   @friends in chat only (no inbound friends message to fill a page);
 * - netherDamage: the 1999 armor profile carries seven resistances, no nether;
 * - squelchListPage: nothing in 1999 lists the squelched names (@squelch stays);
 * - desiredComponents: the rebuy book's 0x224 has no 1999 builder;
 * - radarCoordinates / spellDurations: readouts the 1999 client never drew
 *   (webac#11), shown by default in end of retail;
 * - spellbookFilters: the 1999 spellbook had no filter controls (MAG-8).
 */
const AC1999_UNSUPPORTED: ReadonlySet<EraFeature> = new Set<EraFeature>([
  ...(Object.keys(ABSENT_1999) as Absent1999Feature[]),
  'eolWcidTables',
  'friendsPanel',
  'netherDamage',
  'cloaks',
  'rareGems',
  'fishing',
  'squelchListPage',
  'desiredComponents',
  'autoAcceptFellowship',
  'radarCoordinates',
  'spellDurations',
  'spellbookFilters',
]);

/** The features era `p` lacks (empty for end of retail and the classic eras). */
export function unsupportedFeatures(p: EraProfile | null | undefined): ReadonlySet<EraFeature> {
  return p?.login.protocol === 'ac1999' ? AC1999_UNSUPPORTED : NONE;
}

/** The panels-window panels (PanelsWindow keys) each feature owns. */
export const FEATURE_PANELS: Readonly<Partial<Record<EraFeature, readonly string[]>>> = {
  contracts: ['contracts'],
  chess: ['miniGame'],
};

/** The toolbar buttons (DOM ids) each feature owns. */
export const FEATURE_TOOLBAR_BUTTONS: Readonly<Partial<Record<EraFeature, readonly string[]>>> = {
  contracts: ['tb-journal'],
};

/** The Social panel's tabs (GameUI socialTab keys) each feature owns. */
export const FEATURE_SOCIAL_TABS: Readonly<Partial<Record<EraFeature, readonly string[]>>> = {
  friendsPanel: ['friends'],
  squelchListPage: ['squelch'],
};

/** The World panel's tabs (GameUI worldPanelTab keys) each feature owns: the House page is gmHouseUI's. */
export const FEATURE_WORLD_TABS: Readonly<Partial<Record<EraFeature, readonly string[]>>> = {
  housing: ['house'],
};

/** The indicator strip's icons (GameUI indicatorDefs ids, layout 0x21000071) each feature owns. */
export const FEATURE_INDICATORS: Readonly<Partial<Record<EraFeature, readonly string[]>>> = {
  chess: ['minigame'], // 0x100000f3, lit while a mini-game (chess) is in progress
};

/** The Social panel's fellowship-pane controls each feature owns (layout 0x21000031 element ids). */
export const FEATURE_FELLOWSHIP_CONTROLS: Readonly<Partial<Record<EraFeature, readonly number[]>>> = {
  autoAcceptFellowship: [0x10000271], // the Automatically Accept Fellowship Requests checkbox
};

/** The Components page's controls each feature owns: the desired-level field 0x1000046b (0x21000033). */
export const FEATURE_COMPONENT_CONTROLS: Readonly<Partial<Record<EraFeature, readonly number[]>>> = {
  desiredComponents: [0x1000046b],
};

/** The Character options rows (CharacterSettingsRow.playerOption) each feature owns. */
export const FEATURE_CHARACTER_OPTIONS: Readonly<Partial<Record<EraFeature, readonly string[]>>> = {
  secureTrade: ['IgnoreTradeRequests', 'DragItemOnPlayerOpensSecureTrade'],
  housing: ['DisableHouseRestrictionEffects'],
  consent: ['AcceptLootPermits'],
  chess: ['DisplayChessRank'],
  characterTitles: ['DisplayNumberCharacterTitles'],
  salvage: ['SalvageMultiple', 'UseCraftSuccessDialog'],
  turbineChat: ['HearAllegianceChat', 'HearGeneralChat', 'HearTradeChat', 'HearLFGChat', 'HearRoleplayChat', 'HearSocietyChat'],
  cloaks: ['ShowCloak'],
  rareGems: ['ConfirmVolatileRareUse'],
  fishing: ['DisplayFishingSkill'],
  autoAcceptFellowship: ['FellowshipAutoAcceptRequests'],
  radarCoordinates: ['CoordinatesOnRadar'],
  spellDurations: ['SpellDuration'],
};

/** The Chat options channel filters (CHAT_CHANNELS suffixes) each feature owns. */
export const FEATURE_CHAT_FILTERS: Readonly<Partial<Record<EraFeature, readonly string[]>>> = {
  turbineChat: ['General', 'Trade', 'LFG', 'Roleplay', 'Society'],
};

/** The Chat button menu's talk focuses (ChatTalkFocus TalkFocus ids) each feature owns: 7-13 are TurbineChat rooms. */
export const FEATURE_TALK_FOCUSES: Readonly<Partial<Record<EraFeature, readonly number[]>>> = {
  turbineChat: [7, 8, 9, 10, 11, 12, 13],
};

/** The Keyboard Config commands (ActionMap 0x26000000 ids) each feature owns. */
export const FEATURE_KEYBIND_ACTIONS: Readonly<Partial<Record<EraFeature, readonly number[]>>> = {
  housing: [0x10000018, 0x10000087], // House Page, Disable House Restriction Effects
  contracts: [0x1000012e, 0x10000127, 0x10000128, 0x10000129], // Contracts, Quest Detail, Quest Journal, Journal Page List
  characterTitles: [0x1000011a, 0x1000011b], // Titles Page, Allow Others to See Your Number of Titles
  secureTrade: [0x10000074, 0x10000088], // Ignore All Trade Requests, Drag Item to Player Opens Trade
  consent: [0x10000081], // Accept Corpse Looting Permissions
  chess: [0x1000008f], // Allow Others to See Your Chess Rank
  salvage: [0x10000093, 0x1000008b], // Salvage Multiple, Use Crafting Chance of Success Dialog
  turbineChat: [0x1000008c, 0x1000010e, 0x1000010f, 0x10000110, 0x10000112, 0x10000125], // Listen to Allegiance/General/Trade/LFG/Roleplay/Society Chat
  friendsPanel: [0x10000118], // Show/Hide Friends Page
  cloaks: [0x1000012f], // Your cloak is visible.
  rareGems: [0x10000123], // Confirm Use of Rare Gems
  fishing: [0x10000090], // Allow Others to See Your Fishing Skill
  autoAcceptFellowship: [0x10000083], // Automatically Accept Fellowship Requests
  radarCoordinates: [0x10000085], // Show Coordinates By the Radar
  spellDurations: [0x10000086], // Display Spell Durations
};

/** Every entry of `table` owned by a feature in `unsupported`. */
export function hiddenBy<T>(table: Readonly<Partial<Record<EraFeature, readonly T[]>>>, unsupported: ReadonlySet<EraFeature>): Set<T> {
  const out = new Set<T>();
  for (const f of unsupported) for (const v of table[f] ?? []) out.add(v);
  return out;
}

/**
 * The era's client profile: the client-code rules and values that differ by
 * era, facts of each era's executable, not of its DATs (MOVE.combination-sweep
 * era research; BUG.ac1999-eor-ui-values). End of retail and the classic eras
 * run the end-of-retail acclient.exe; 1999 its own client.exe. One table: the
 * shared panels read their era's values here instead of branching on the era.
 */
export interface EraClientRules {
  /**
   * A cast stops the player (cmdinterp->MaybeStopCompletely before the
   * cast: ClientMagicSystem::CastSpell @ 00568040, FreeHandsAndCastSpell
   * @ 00566ef0). The 1999 client.exe's PanelUI_FreeHandsAndCastSpell
   * @ 0x4fecc0 only sends the cast and bumps the busy count, and
   * UI_CastSpell @ 0x4d1bd0 never stops either: a 1999 player could run while
   * casting (the server-side "moved too far" interrupt arrived Nov 2001, "The
   * Gathering Storm").
   */
  castStopsMovement: boolean;
  /**
   * An attack request stops the player even while the server moves it: the
   * 1999 PanelUI_StartAttackRequest @ 0x4f8850 calls the command
   * interpreter's StopCompletely (vtable +0xbc) directly; end of retail's
   * StartAttackRequest @ 0056c040 calls MaybeStopCompletely, which does
   * nothing under server control.
   */
  attackStopsAlways: boolean;
  /**
   * Which CompatibleCombatMode the client applies to a requested combat-mode
   * change (controllers/CombatModeChange.ts compatibleCombatMode). End of
   * retail's ClientCombatSystem::CompatibleCombatMode @ 0056a580 lets magic
   * mode in only with a caster in the Held slot (0x1000000), so a bare-handed
   * player can't enter it. The 1999 client.exe asks only for the mode
   * PanelUI::GetDefaultCombatMode @ 0x4f9130 picks (magic only with a caster
   * held, missile only with a missile weapon), and its UI::SetCombatMode
   * @ 0x4d04c0 also refuses melee / missile while a Held item is wielded, with
   * its own "You can't enter combat mode while wielding the %s" line.
   */
  combatModeCheck: 'eor' | 'ac1999';
  /**
   * The Spell Research panel: MagicPanBase's third tab, "Create Spell"
   * (CreateSpellPanel, ctor @ 0x5ab060, built by MagicPanBase @ 0x54c500 at
   * +0x104 beside Spellbook and Components). The 1999 client.exe learns spells
   * by researching a formula (0x4B ResearchSpell); the panel was cut before
   * the 2005 client and end of retail has no research message, so only a 1999
   * world builds it (ui/SpellResearch1999.ts).
   */
  spellResearch: boolean;
  /**
   * Splitpea, the 1999 taper program (reference/plugin-specs/splitpea.md): a VVS-bar plugin for the
   * 1999 spell research system. Only the 1999 client researches spells (RandomizeVersion1 tapers).
   */
  splitpea: boolean;
  /**
   * The ITEM_TYPE mask of shop wares whose toolbar buy quantity seeds 1
   * instead of the whole object stack (gmToolbarUI::HandleSelectionChanged
   * @ 004bf380, decomp 185731–185737: `& 0xdc41cb0`). The 1999 client.exe's
   * PanelUI::UpdateSplitUI @ 0x004fde40 tests 0x14B0 (Creature, Food, Misc,
   * Useless, SpellComponents; reference/ac1999 kb vendor-buy-quantity-default):
   * a 1999 gem, trade note or craft base defaults to the whole stack.
   */
  vendorBuyOneMask: number;
  /**
   * Which client builds the item examine text (BUG.ac1999-appraisal-details). End of retail's
   * ItemExamineUI::SetAppraiseInfo @ 004b72b0 and its Appraisal_Show* sections
   * (ui/examine/ItemAppraisalText.ts), or the 1999 client.exe's single
   * ItemExaminePanel::SetAppraiseInfo @ 0x0050b6c0, whose lines and wording differ
   * ("Speed: Average (45)", "Uses Bow Skill", "Use this item, or drag it …";
   * ui/examine/ItemAppraisalText1999.ts).
   */
  appraisalText: 'eor' | 'ac1999';
  /**
   * How the character panel's selection line shows a stat (REVERT.ac1999-forked-panels).
   * End of retail's gmStatManagementUI footer title, "Strength 80+" with the value green
   * (DisplaySelectionFooter_Attribute @ 0049d280), or the 1999 client.exe's InfoBox::SetBase
   * @ 0x00544a70 wording in the same shared footer: "Strength 80 (+15)", the enchantments'
   * " (+n)" green / " (-n)" red, the vitae " (-n)" cyan, " (+0)" when they cancel, a vital
   * "cur/max" (ui/SkillDisplay.ts statLineRuns1999). Only the text differs: the panel is
   * the shared one in every era (Jake, 2026-10-22).
   */
  statLineText: 'eor' | 'ac1999';
  /**
   * How many spell-bar tabs (favourite spell lists) the magic bar has (BUG.ac1999-spell-tabs,
   * webac#5). End of retail: eight (gmSpellcastingUI's tab ids 0x100000a3-a9 + 0x100005c2,
   * RecvNotice_PlayerDescReceived @ 004c69a0 loops all 8; the Dark Majesty local DATs carry the
   * same eight tabs in 0x21000010, and those servers run the end-of-retail acclient.exe). The 1999
   * client.exe has ONE bar and no tabs: CM_Character_Event_AddToSpellbar @ 0x53e2d0 writes only
   * {spellID, index} (no bar field), RemoveFromSpellbar @ 0x53e3b0 only {spellID}, its PlayerModule
   * carries a single favorites list, and it has no spell-tab commands (tabs came with Heroes'
   * Respite, May 2000). With one tab the shared bar draws no tab strip at all.
   */
  spellBarTabs: number;
  /**
   * How many item-shortcut (quick) slots the toolbar has (BUG.ac1999-spell-tabs sweep). End of
   * retail: 18, two rows of 9 (gmToolbarUI::InitShortcutArray @ 004bdd50, Quickslot 1-18). The
   * 1999 client.exe: nine, the 1-9 tray (ShortCutManager::AddShortCut @ 0x586f00 refuses an index
   * past 8; its key commands are UseShortcut 1-9). The 1999 toolbar shows one row.
   */
  shortcutSlots: number;
  /**
   * What the Character Information panel says (BUG.ac1999-char-info-eor-rows, webac#8). End of
   * retail's gmCharacterInfoUI::Update @ 0x4ba790 (born / played / deaths, resistance and
   * regeneration tiers, innate attributes, chess / fishing, masteries, luminance, augmentations,
   * burden; the classic eras run that exe with the same strings in their local DATs). The 1999
   * client.exe has none of those strings: its only character text is the Burden panel
   * (@ 0x59a9e0), so a 1999 world shows born / played / deaths (the 1999 server sends them)
   * and the 1999 burden text (ui/CharacterInfoReport.ts burdenText1999) in the shared panel.
   */
  characterInfoText: 'eor' | 'ac1999';
  /**
   * When the spell bar's two scroll arrows show (BUG.ac1999-spellbar-arrows, webac#6). End of
   * retail ('pair'): the arrows are one UIElement_Scrollbar (0x21000010:0x100000b5, template
   * 0x21000008:0x10000070, p121 hide-disabled), shown whole while the list overflows and hidden
   * whole when it fits (UIElement_Scrollbar::UpdateLayout @ 004710d0). The 1999 client.exe
   * ('ends'): two separate buttons the spell menu owns (SpellCastSubPanel ctor @ 0x512390, menu
   * +0x110 / +0x114), each set to hide while disabled (0x4513d0(1)); the menu's 0x5d3dc0 disables
   * the left one at scroll 0 and the right one once the last cell is in view, so each shows only
   * while there is more to see on its side.
   */
  spellBarArrows: 'pair' | 'ends';
  /**
   * What @chat on / off does. End of retail ('server'): DoChatToggle @ 0056fad0 sends
   * Event_ModifyGlobalSquelch 0x5B (Speech) and the server's squelch reply gates it. The 1999
   * client.exe ('local'): CmdHandlers_DoChatToggle → UI_SetLocalChatSquelched @ 0x4d0470 sets
   * UI+0x5a0, prints "Local chat is now squelched." / "Local chat is no longer squelched." and sends
   * nothing; UI_ShouldHearSpeaker @ 0x4d0360 then hides every HearSpeech 0x37 and HearEmote line
   * whose speaker id is non-zero (kb client-behavior/squelch-list.md). Tells are not affected.
   */
  chatToggle: 'server' | 'local';
  /**
   * The spell formula's talisman → target ItemType table, which decides whether a cast needs a
   * selection and what it may be cast on (CSpellBase::InqTargetType; webac#9). End of retail:
   * SpellComponentTable::GetTargetTypeFromComponentID @ 005bbf50 (Ashwood 0x88b8f, Hazel
   * 0x10010000). 1999: the switch @ 0x5e4150 (Ashwood 0xa090f, Hazel 0x10000; @ac/shared
   * TALISMAN_TARGET_TYPES_1999).
   */
  talismanTargetTypes: TalismanTargetTypes;
  /**
   * The target-type bits that let a non-Self spell be cast with the caster selected (an item
   * spell cast on yourself lands on your gear). End of retail: 0x8107
   * (ObjectCompatibleWithSpellTargetType @ 00567230). 1999: 0, the 1999 client.exe's check
   * @ 0x4d20c0 refuses the caster outright ("You cannot cast this spell upon yourself"), and the
   * AC1999 server never redirects an item spell to worn gear (SpellcastingManager.cpp
   * CheckTargetValidity: "1999 makes you buff each item individually").
   */
  spellSelfTargetableTypeMask: number;
  /**
   * Which InqShowableOnRadar decides a radar blip (and a Closest Compass Item candidate;
   * BUG.webac11-radar-1999, webac#11). End of retail ('eor'): ACCWeenieObject::
   * InqShowableOnRadar @ 0058c250 shows RadarBehavior ShowMovement, ShowAttacking and ShowAlways
   * alike, so every monster the server sends shows (the classic eras run that exe). The 1999
   * client.exe ('ac1999', @ 0x4e2f20): ShowAlways always; a ShowMovement object only within
   * 10 m, or while it moves, turns, acts or holds a combat stance; a ShowAttacking one only
   * within 10 m or in a combat stance; the selected creature always (ui/RadarBlips.ts
   * inqShowableOnRadar1999). Most 1999 monsters are ShowMovement, so an idle one is off the radar.
   */
  radarVisibility: 'eor' | 'ac1999';
  /**
   * The default key bindings (input/EraKeymaps.ts; SWEEP1999.input). End of retail ('eor'): the
   * portal KeyMaps 0x14000000 / 0x14000002 (the classic eras' DATs carry the same). The 1999
   * client.exe ('ac1999') has no KeyMap: InputMapper @ 0x0059fe70 loads Default.map
   * (input/KeyMap1999.ts): F7 opens Create Spell, V drops the selection, the three attack keys
   * cast in magic mode and the power keys step the spell selection there, and no mouse button is
   * bound. Each keymap saves the player's own bindings under its own key.
   */
  keymap: EraKeymap;
  /**
   * What a single click on a non-attackable object does in melee or missile mode (CM-3). End of
   * retail ('any'): it selects, like any click. 1999 ('attackableOnly'): PanelUI::
   * HandleMouseDownOnObject @ 0x004f83c0 refuses it with "You cannot select that while in combat
   * mode" (a double click still uses the object, without selecting it); clicks on the radar go
   * the same way.
   */
  combatClickSelect: 'any' | 'attackableOnly';
  /**
   * Which checks an item dropped on a shortcut slot meets first (HC-13). End of retail ('eor'):
   * none, gmToolbarUI::HandleDropRelease goes straight to CreateShortcutToItem. 1999 ('ac1999'):
   * ShortcutSlot::AcceptDragObject @ 0x00500240 refuses an unusable item, a drop while a split
   * is pending and a stuck object or creature (network/itemShortcutRestore.ts
   * shortcutDropRefusal1999).
   */
  shortcutDropCheck: 'eor' | 'ac1999';

  // ── The era client's values (BUG.ac1999-eor-ui-values) ─────────────────────
  // Where 1999 differs from end of retail only in a value (a string, a slot set, an option
  // list), the shared panel reads it here: one lookup per panel, no per-era branch. End of
  // retail's values are today's (its local-DAT string ids with their fallbacks); the 1999
  // values are the 1999 client.exe's own (Oct 1999 4.35752, addresses cited per value).

  /**
   * The paperdoll's equip slots (EquipMask bits; a slot shows when its mask meets this). End of
   * retail: every slot (gmPaperDollUI, layout 0x21000024). 1999: InventoryPanel's ctor @ 0x522fc0
   * builds exactly eight ItemSlots, neck 0x8000, bracelets 0x10000 / 0x20000, rings 0x40000 /
   * 0x80000, weapon 0x1500000, ammo 0x800000, shield 0x200000 (OR 0x1bf8000): no shirt / pants
   * flank, no body-region armour view (so no "Slots" gem), no cloak, trinket or aetheria.
   */
  equipSlotMask: number;
  /** The character panel's footer wording (gmStatManagementUI footers / the 1999 InfoBox family). */
  statFooterText: StatFooterText;
  /**
   * Whether the stat footer has the "+10" raise button (0x100005eb). End of retail: yes. 1999: one
   * Raise button only (StatsPanel @ 0x00549c90; 0x00549809 sends the shown price for an attribute
   * or vital, 0x005471f9 for a skill).
   */
  statRaiseTen: boolean;
  /**
   * The prompt before training a skill ("%d" credits, "%s" skill), or null when the client trains
   * at once. End of retail: gmSkillUI::TrainSkill @ 0049c5f0's .rdata 0x7a7864. 1999: the Raise
   * press sends 0x47 TrainSkill with no dialog (0x005471f9).
   */
  trainSkillConfirm: string | null;
  /**
   * The combat bar's checkbox rows, in order (GameUI optionsSettings keys). End of retail:
   * gmCombatUI::PostInit @ 004cc1a0, Repeat Attacks / Auto Target / Keep in View. 1999:
   * CombatPanel @ 0x589bc0 builds High / Medium / Low, Repeat Attacks, Auto Target, Speed and
   * Power only; "keep combat targets in view" lives on its options page instead (0x611478).
   */
  combatBarOptions: readonly CombatBarOption[];
  /** The spellbook's delete prompt ("%s" = the spell's name). */
  spellDeleteConfirm: string;
  /** The Chat button menu's wording, or null for the local DAT's ID_Chat_* strings (end of retail). */
  chatTargetText: ChatTargetText | null;
  /**
   * The era client's own Character options page, row by row in its order (SWEEP1999.character,
   * CHAR-1), or null for end of retail's gmCharacterSettingsUI page (CharacterSettingsModel's
   * sections, less the rows of features the era lacks: FEATURE_CHARACTER_OPTIONS). An option not
   * listed here is not on the era's page, and the fellowship pane's checkboxes follow the same
   * list (FELLOWSHIP_PANE_OPTIONS).
   */
  characterOptionsPage: readonly EraCharacterOption[] | null;
  /**
   * Options whose local effect the era's client never had, pinned to the value the era's client
   * behaved as (by GameUI optionsSettings key). The stored value stays for the next world of
   * another era; GameUI.optionOn reads the pin, and a Config row bound to a pinned key is not
   * listed. End of retail pins only the three 1999 options its client dropped.
   */
  optionPins: Readonly<Record<string, boolean>>;
  /** Server options-word bits held at the era client's value (OptionsWordFix), or null for none (end of retail). */
  optionsWordFix: OptionsWordFix | null;
  /**
   * The character panel's heritage line under the name. End of retail ('eor'):
   * gmStatManagementUI::UpdateCharacterInfo @ 004f0770, "Male Aluvian" and the title. 1999
   * ('ac1999'): StatRegion_UpdateFromPlayerDesc @ 0x00543520, '(' + the Sex, Heritage and Template
   * strings (PropertyString 3 / 4 / 5) the server sent, space-separated, + ')'.
   */
  heritageLine: 'eor' | 'ac1999';
  /**
   * The vitae panel: the XP-to-regain formula and the text. End of retail ('eor'): VitaeSystem::
   * VitaeCPPoolThreshold (ACE Player_Xp.cs: level^2.5 x 2.5 + 20) and gmVitaeUI::Update's DAT
   * strings. 1999 ('ac1999'): 0x005f0610 (level^2 x 5 + 20, capped at 12,500; the AC1999 server's
   * VitaeSystem.cpp is the same) and VitaePanel_UpdateFromPlayerDesc @ 0x0054c120's own text.
   */
  vitaePanel: 'eor' | 'ac1999';
  /** The character examine page's era wording. */
  characterExamineText: CharacterExamineText;
  /** The item hover text's era additions, or null (end of retail: UIElement_UIItem::UpdateTooltip, the name alone). */
  itemHoverText: ItemHoverText | null;
  /** The World panel's map: its town notes and how the player's marker is placed (BUG.ac1999-map-eor-art, webac#10). */
  mapPanel: MapPanelRules;
  /**
   * Seconds after which the one pending inventory request is force-cleared, or null for never
   * (BUG.webac12-inventory-request-lock, webac#12). The 1999 client's Global_Loop @ 0x4c6b30
   * clears it once `105.0 <= cur_time - prevRequestTime` (reference/ac1999/Client/decomp/UI/
   * Global_Loop.c:447-451, ClearCurrentInventoryRequest @ 0x4e2ec0); the end-of-retail client
   * never reads prevRequestTime.
   */
  inventoryRequestWatchdogSeconds: number | null;
  /**
   * Whether ANY stat update ends the character panel's one-raise-in-flight guard (m_bAwaitingRaise)
   * (AUDIT.ac1999-request-completion). The 1999 client clears StatsPanel_awaiting_raise in every
   * stat fan-out: StatsPanel_SetAttribute @ 0x0054a6f0 (0x26), StatsPanel_SetInt @ 0x0054a740
   * (UpdateInt), the vital and skill fan-outs @ 0x0054a7e0 / 0x0054a840 (reference/ac1999/Client/
   * decomp/StatsPanel/SetAttribute.c:26, SetInt.c:27; the vital fan-out 0x0054a7e0). The AC1999
   * server answers a refused raise with the unchanged 0x26 + 0x0E (ClientEvents.cpp SpendAttributeXP)
   * or with nothing (RaiseVital / RaiseSkill / TrainSkill), so a guard released only by a change in
   * the XP / credit pools held every raise button dead until the next kill. false: end of retail's
   * pools-changed release (gmStatManagementUI's 0x10000004 path) is kept.
   */
  raiseAwaitClearsOnStatUpdate: boolean;
  /**
   * How a server text line (0xF7E0) is painted and routed (SWEEP1999.messages HC-1 / HC-8). null:
   * end of retail's AddTextToScroll, by text type (0x1a the spew box, the rest chat lines in
   * BuildChatColorLookupTable's colours; the classic eras run that exe). 1999: the client.exe's
   * raw 14-slot table (PanelUI_AddTextToScroll @ 0x004f9b70, colours from the UI ctor @ 0x004c4af0),
   * every other channel (0x1a and everything from 14 up) a green chat line. The AC1999 server writes
   * end-of-retail LogTextType numbers, and the real 1999 client paints them by this raw table, so
   * its "You tell X, ..." (type 4) is purple and its type-1 lines white: we show what that pairing
   * showed (decision in docs/ac1999-support.md, "Message texts").
   */
  serverTextSlots: ServerTextSlots | null;
  /**
   * The client's failure-code switch for 0x28A WeenieError (the AC1999 server's 0x1C AttemptFailed)
   * and a non-zero 0x1C7 UseDone (SWEEP1999.messages HC-6 / VTE-2 / MAG-9). null: end of retail's
   * ClientCommunicationSystem::HandleFailureEvent @ 00571990 (@ac/shared WeenieErrorSink, 344 codes).
   * 1999: UI_HandleFailureEvent @ 0x004ccd10, about 50 codes in its own wording, nothing for the rest
   * (ui/FailureEventText1999.ts). 0x28B WithString keeps end of retail's switch in every era.
   */
  failureEventText: FailureEventTable | null;
  /**
   * Whether 0xA0 InventoryServerSaveFailed also runs the failure switch after
   * ServerSaysAttemptFailed's verb line (INV-3). End of retail: yes, unless the code is one of the
   * seven name-templated ones (the 0xA0 dispatch @ decomp :339961). 1999: no, Net_DispatchServerMessage
   * case 0xa0 calls only ACCWeenieObject_ServerSaysAttemptFailed (verb line + suffix).
   */
  inventoryFailedRunsFailureEvent: boolean;
  /** Which client builds the four combat lines (ui/ServerMessageText.ts HitLineText; HC-5 / CM-2). */
  hitLineText: HitLineText;
  /** The encumbrance notice's wording and repeat (ui/EncumbranceNotice.ts; HC-9, every era). */
  encumbranceNotice: EncumbranceNoticeRules;
  /** The era client's UseObject: its DetermineUseResult cases and spew lines (input/UseObject.ts; VTE-4 / INV-7). */
  useObject: UseObjectRules;
  /**
   * The character-select delete prompt as a Yes / No question ("%s" = the name), or null for end of
   * retail's typed-DELETE dialog (gmCharacterManagementUI::MakeDeleteCharacterConfirmationDialog
   * @ 004ecca0, ID_CharacterManagement_DeleteCharacterConfirmation, which offers a restore within an
   * hour). 1999: IntroUI_ListenToMessage's requester, "\n\nDeleting %s cannot be undone.  Are you
   * sure?" (its two layout newlines dropped); a 1999 world has no restore (PW-9).
   */
  deleteCharacterConfirm: string | null;
  /** The placement and merge refusal wording (inventory/ItemHolderPlacement.ts PlacementText; INV-11). */
  placementText: PlacementText;
  /**
   * The spell bar's Charge meter (SWEEP1999.magic MAG-3). The 1999 SpellCastSubPanel (ctor @ 0x512390,
   * Arrange @ 0x513620) shows a "Charge" caption and a meter while a spell is selected, filled to the
   * spell's charge: UpdateChargeMeter @ 0x513390 sets ftol(charge × 100 + 0.5) / 100 and the "%u%%"
   * text, on a selection and from Global_Loop's 5 s tick. End of retail has no charge and no meter.
   */
  spellBarChargeMeter: boolean;
  /**
   * The one combined effects window's title, or null for end of retail's two (MAG-4). The 1999
   * PanelUI has one magic status indicator, lit while any enchantment is in effect (0x4fa740 →
   * 0x52b4e0: the registry's mult + add list counts), opening one "Spells in Effect" panel (ctor
   * @ 0x59ac70) that lists every spell. End of retail splits them into Beneficial / Harmful.
   */
  combinedEffectsTitle: string | null;
  /**
   * The spell examine page's Duration line (MAG-5). 'eor': SpellExamineUI's "Duration: %u min." /
   * "%u sec.". 'ac1999': SpellExaminePanel::ExamineSpell @ 0x511110 prints the band the server rolls
   * in (×0.75 to ×1.25), "Duration: %.1f-%.1f min." past 90 s, else "Duration: %u-%u sec."; a
   * portal summon (meta type 7) keeps one value.
   */
  spellDurationText: 'eor' | 'ac1999';
  /**
   * The Cast button's face text, or null when it is end of retail's static "Cast" with the state in a
   * tooltip and the spell's name beside it (MAG-6). The 1999 SpellCastSubPanel_UpdateCastButton @
   * 0x513e00 writes the state onto the 200 px button itself ("CAST <spell>\non <target>", "You must
   * select a target\nfor <spell>", …), and its hover text is AC_ToolTipHandler case 0x55.
   */
  castButtonText: CastButtonText | null;
  /**
   * Learning a spell opens the Magic panel on it (MAG-7). The 1999 Net_UpdateSpell @ 0x4cfa40 adds a
   * new spell with MagicPanBase_AddSpell(spell, 1), and SpellbookPanel_AddSpell @ 0x5169d0 then
   * selects its row and shows the panel (0x4d06f0) on the spellbook tab. End of retail's
   * RecvNotice_SpellAdded only selects it.
   */
  learnOpensSpellbook: boolean;
  /**
   * The spellbook list's order (MAG-8). 'displayOrder': gmSpellbookUI::GetSortedInsertionPlace @
   * 0048b440 (the SpellTable's DisplayOrder). 'name': the 1999 SpellbookPanel_AddSpell @ 0x5169d0
   * inserts before the first row whose name is >= its own (byte-wise compare).
   */
  spellbookOrder: 'displayOrder' | 'name';
  /**
   * The formula slots the local component pre-check walks, [first, end) (MAG-10). End of retail's
   * ClientMagicSystem::CastSpell @ 00568040 checks every one; the 1999 UI_CastSpell @ 0x4d1bd0 runs
   * `for i = 1; i < 6` over the 0-based slots (0x4d1e40), so the scarab (0) and slots 6-7 (taper,
   * talisman) are left to the server.
   */
  componentPrecheckSlots: readonly [number, number];

  // ── Inventory, vendor and examine (SWEEP1999.inventory) ─────────────────────

  /**
   * Where a pick-up, a loot, an unwield or a pack-grid drop puts an object (INV-1). End of retail
   * ('eor', ItemHolder::AttemptToPlaceInContainer @ 00588140): the shown side pack first, then the
   * main pack, then any side pack with room; auto-merge into any pack's stacks; "…is completely
   * full!". The 1999 client.exe ('ac1999', ItemHolder_AttemptPlaceInContainer @ 0x4e55b0 /
   * AttemptPlaceInContainerIsLegal @ 0x4e57b0): exactly the container asked for (PlaceInBackpack
   * @ 0x4ffb80 always asks for the player), auto-merge only into that container's own stacks
   * ("Too big to merge. Putting in X." when a stack matched without room), and the container's own
   * no-room line when it has none (its 1999 wording is the era's placement text).
   */
  inventoryPlacement: 'eor' | 'ac1999';
  /**
   * Whether a drop on an occupied paperdoll slot swaps (INV-4). End of retail: gmPaperDollUI::
   * AcceptDragObject calls AutoWield(obj, side, 0, 1, 0, 0) and param_5 = 0 never unwields, so the
   * drop is refused without a word. The 1999 client.exe: ItemSlot_AcceptDragObject calls
   * PanelUI_AutoWield(obj, side, 0, 1, 0, 0) and its param_4 = 1 moves the occupant to the
   * backpack ("Moving X to your backpack") and wields the new item (PanelUI_AutoWield @ 0x4fee20).
   */
  paperdollSlotDropSwaps: boolean;
  /**
   * Whether a melee weapon dropped on the shield slot is a left-hand (dual) wield (INV-5). End of
   * retail: gmPaperDollUI::AcceptDragObject @ 004a3b10 widens the shield slot for a melee weapon.
   * 1999: ItemSlot_AcceptDragObject / DragOverAction test only valid & slot (no dual wield; the AC1999
   * server refuses it, Container_CanEquip).
   */
  dualWieldShieldSlot: boolean;
  /**
   * Whether a target-mode use asks first (INV-9): end of retail's ItemHolder::TargetAcquired
   * @ 00588ef0 confirms an empty mana stone (and refuses one on a Retained item) and a salvage bag.
   * The 1999 target completion (0x004e65c0) checks compatibility and sends at once.
   */
  targetedUseConfirmations: boolean;
  /**
   * Whether a partial split dropped on a vendor in 3D is refused (INV-12). End of retail's
   * AttemptPlaceIn3D @ 00588600: "You must split the stack before selling it.". The 1999
   * ItemHolder_AttemptPlaceIn3D hands the item to the vendor drop (0x004d00d0) with no split test.
   */
  vendorDropNeedsWholeStack: boolean;
  /** use-with-target's lines (ItemHolder::TargetCompatibleWithObject; INV-8). */
  useWithTargetText: UseWithTargetText;
  /** The trade-note rates (ShopSystem::SellPrice / BuyPrice; VTE-1). */
  promissoryNoteRates: PromissoryNoteRates;
  /**
   * The vendor's client-side sell gate (VendorProfile::InqAcceptability; VTE-6). End of retail
   * ('eor', @ 005d1a90): a Retained item is refused, a trade note is exempt from max_value. The 1999
   * client.exe ('ac1999', VendorProfile_InqAcceptability @ 0x005e1920): type mask, a zero unit
   * value, min and max only, so a note worth more than max_value is "too valuable to sell here".
   */
  vendorAcceptability: 'eor' | 'ac1999';
  /**
   * The vendor's item-type menu, in order (VTE-7). End of retail: gmVendorUI's masks (annotated
   * decomp ~188030-188142). 1999 ItemsEnvPanel_OpenVendor @ 0x005a5490: Keys, Tools 0x4000 and
   * Cooking Items 0x2400000 (the 1999 cooking intermediates are typed 0x2000000).
   */
  vendorTypeFilters: ReadonlyArray<readonly [string, number]>;
  /** The empty inscription block's text (VTE-5); `centered` draws it centred in the block. */
  inscribePlaceholder: { readonly text: string; readonly centered: boolean };
  /** The book window's era behaviour (VTE-8). */
  book: BookRules;
  /** The world and pre-world presentation values (era/EraWorldRules.ts, SWEEP1999.world). */
  world: EraWorldRules;

  // ── Chat commands and chat lines (SWEEP1999.commands) ──────────────────────

  /**
   * The chat @-command table (chat/commands). End of retail ('eor'): ClientCommunicationSystem::
   * InitializeCommands @ 00581970 and its help. 1999 ('ac1999'): the 38 names the client.exe's
   * ChatEntryField ctor @ 0x518970 registers, with their 1999 handlers and help
   * (chat/commands/Commands1999.ts: @lifestone / @sepaku kill the character after a Yes / No,
   * @friends_add / _remove, the 1999 @loc / @version / @render, tells through TargetedChat), the
   * 1999 channel aliases (no allegiance or co-vassal channel; @ab is Abuse) and channel command
   * (only "@f, text" broadcasts). Any other word goes to the server as Talk, as in both clients.
   */
  commandTable: CommandTableStyle;
  /**
   * Who is heard (UI_ShouldHearSpeaker). End of retail ('all'): every HearSpeech / HearEmote the
   * server sends shows. 1999 ('radar', @ 0x4d0360): a known speaker at or past the radar range less
   * one metre (RadarUI+0xfc: 75 m outdoors, 25 m indoors; 2-D distance) is not shown; the AC1999
   * server sends speech to the whole PVS (WeenieObject.cpp BroadcastPVS).
   */
  speechHearing: 'all' | 'radar';
  /**
   * The fellowship lines' wording (chat/ChannelBroadcastLine.ts, ui/fellowshipChatLines.ts). 1999:
   * UI_HandleChannelMessage @ 0x4d24a0's `X says to your fellowship, "…"` / `You say to your
   * Fellowship, "…"`, and 0x00536f40's `<leader> has recruited you into the <name> Fellowship.`
   */
  socialLineText: 'eor' | 'ac1999';
  /**
   * The chat line printed on entering the world, or null. 1999: ClientMode_RunTransition @ 0x4d08a0
   * prints the client's version string (0x0062f508) as the first line; end of retail prints none.
   */
  worldEntryVersionLine: string | null;
}

/** ItemHolder::TargetCompatibleWithObject's lines ("%s" = the source item's name, then the target's). */
export interface UseWithTargetText {
  mustOwn: string;
  mustWield: string;
  /** The target is on the trade window (null: the era has no such check). */
  targetTrading: string | null;
  targetNotOwned: string;
  targetNotWielded: string;
  onYourself: string;
  cannotUseWith: string;
  /** The line shown before the request goes out, then " on " (a player target) or " with the " and the target's name. */
  using: string;
  usingOn: string;
  usingWith: string;
}

/** The book window's era rules (gmBookUI / the 1999 ReadWritePanel). */
export interface BookRules {
  /** The page menu's author line ("%s" = the author); an empty author shows nothing. */
  menuAuthorFormat: string;
  /**
   * Whether leaving an editable page saves it only when its text changed. End of retail's
   * gmBookUI::CloseCurPage @ 004bb340 saves changed or not; the 1999 ReadWritePanel_CloseCurPage
   * @ 0x00521820 only when the text region is dirty.
   */
  saveOnlyChanged: boolean;
}

/** gmVendorUI's item-type menu (end of retail). */
const EOR_VENDOR_TYPE_FILTERS: ReadonlyArray<readonly [string, number]> = Object.freeze([
  ['Armor', 0x2], ['Books, Paper', 0x2000], ['Clothing', 0x4],
  ['Containers', 0x200], ['Food', 0x20], ['Gems', 0x800],
  ['Jewelry', 0x8], ['Keys, Tools', 0x20004000], ['Miscellaneous', 0x490],
  ['Services', 0x100000], ['Spell Components', 0x1000],
  ['Trade Notes', 0x40000], ['Weapons', 0x101], ['Mana Stones', 0x80000],
  ['Magic Items', 0x8000], ['Alchemical Items', 0x4800000],
  ['Cooking Items', 0x400000], ['Fletching Items', 0x9000000],
] as const);
/** ItemsEnvPanel_OpenVendor @ 0x005a5490 (the 1999 client.exe): the same menu, two masks differ. */
const AC1999_VENDOR_TYPE_FILTERS: ReadonlyArray<readonly [string, number]> = Object.freeze(
  EOR_VENDOR_TYPE_FILTERS.map(([label, mask]) => [label, label === 'Keys, Tools' ? 0x4000 : label === 'Cooking Items' ? 0x2400000 : mask] as const),
);

/** acclient.exe .rdata (UTF-16): 0x7e2600 / 0x7e25c0 / 0x7e2560 / 0x7e2508 / 0x7e24a0 / 0x7e2460 / 0x7e2424 / 0x7ce214, " on " 0x7e2418, " with the " 0x7e2400. */
const EOR_USE_WITH_TARGET_TEXT: UseWithTargetText = Object.freeze({
  mustOwn: 'You must own the %s to use it',
  mustWield: 'You must wield the %s to use it',
  targetTrading: "You can't use the %s on an item you are trading",
  targetNotOwned: "You can't use the %s on what you don't own",
  targetNotWielded: "You can't use the %s on what you aren't wielding",
  onYourself: 'Cannot use the %s on yourself',
  cannotUseWith: 'Cannot use the %s with the %s',
  using: 'Using the %s', usingOn: ' on ', usingWith: ' with the ',
});
/** The 1999 ItemHolder_TargetCompatibleWithObject @ 0x004e6630 (client.exe 0x2009bc …, " on " 0x60133c): no trade check. */
const AC1999_USE_WITH_TARGET_TEXT: UseWithTargetText = Object.freeze({
  mustOwn: 'You must own the %s to use it.',
  mustWield: 'You must wield the %s to use it.',
  targetTrading: null,
  targetNotOwned: "You can't use the %s on what you don't own.",
  targetNotWielded: "You can't use the %s on what you aren't wielding.",
  onYourself: 'Cannot use the %s on yourself',
  cannotUseWith: 'Cannot use the %s with the %s',
  using: 'Using the %s', usingOn: ' on ', usingWith: ' with the ',
});

/**
 * The 1999 Cast button's face texts (SpellCastSubPanel_UpdateCastButton @ 0x513e00) and its hover
 * texts (AC_ToolTipHandler @ 0x5871b0, case 0x55). `%s` is the spell's or the item's name; each
 * text is cut to two lines (0x4579b0(2)), "CAST <spell>" to one, then a line break (or a space
 * after a cut name) and "on <target>".
 */
export interface CastButtonText {
  noSpells: string;
  selectSpell: string;
  selectTarget: string;
  selectAppropriateTarget: string;
  cast: string;
  on: string;
  selectTargetForItem: string;
  selectAppropriateTargetForItem: string;
  use: string;
  useOn: string;
  hover: {
    /** A disabled button with nothing on the bar (0x514640 false). */
    dragSpell: string;
    /** A disabled button with spells on the bar. */
    selectSpell: string;
    /** An enabled button with a spell selected. */
    cast: string;
    /** An enabled button with the endowment item selected. */
    use: string;
  };
}

/** The 1999 Cast button's texts (string VAs in the 1999 client.exe). */
const AC1999_CAST_BUTTON_TEXT: CastButtonText = Object.freeze({
  noSpells: 'You have no spells\nready to cast',
  selectSpell: 'Select a spell to cast',
  selectTarget: 'You must select a target\nfor %s',
  selectAppropriateTarget: 'You must select an appropriate\ntarget for %s',
  cast: 'CAST %s',
  on: 'on %s', // 0x6047f8 "on "
  selectTargetForItem: 'You must select a target for\nthe %s',
  selectAppropriateTargetForItem: 'You must select an appropriate\ntarget for the %s',
  use: 'USE the %s',
  useOn: ' on %s', // 0x60133c " on "
  hover: Object.freeze({
    dragSpell: 'Drag a spell to the menu above,\nthen click here to cast it.',
    selectSpell: 'Select a spell from the menu above,\nthen click here to cast it.',
    cast: 'Click to cast %s',
    use: 'Click to use your %s',
  }),
});

/**
 * The 1999 client.exe's scroll slots (PanelUI_AddTextToScroll @ 0x004f9b70: case n → UI+0x1c4 + 4n,
 * 0xc → +0x1fc, 0xd → +0x1f4, 0x38f → +0x1f8; colours set in the UI ctor @ 0x004c4af0).
 */
export const SERVER_TEXT_SLOTS_1999: ServerTextSlots = Object.freeze({
  colors: Object.freeze({
    1: '#ffffff', 2: '#ffff3f', 3: '#d2d264', 4: '#ff7fff', 5: '#ff7fff', 6: '#ff3f3f', 7: '#3fbfff',
    8: '#ff9696', 9: '#dca0a0', 10: '#ffff3f', 11: '#d2d264', 12: '#d2d2c8', 13: '#3fffff', 0x38f: '#ff3f3f',
  }),
  fallback: '#80ff7f', // UI+0x1c4 (0x80, 0xff, 0x7f)
});

/**
 * The era client's map page (BUG.ac1999-map-eor-art, webac#10). The picture itself is world art
 * (MapMarkers.MAP_IMAGE, read from the world portal), so each era's DAT draws its own Dereth; these
 * are the client code's parts.
 */
export interface MapPanelRules {
  /**
   * The hover notes over the picture (gmMapUI::PostInit @ 004a1c70 → AddMapNote: the exe's
   * `s_rgLocations` @ .rdata 0x7aa3f8, 53 end-of-retail places). The 1999 client.exe has none: its
   * MapSubPanel ctor @ 0x00507f70 builds the picture, the player icon, the date / time and the
   * coordinate texts and nothing else, and its only town strings are the character-creation start
   * towns.
   */
  notes: readonly MapNoteLocation[];
  /** The box the markers are placed in and clicks are read from, relative to the 257x267 picture. */
  markerArea: Readonly<MapMarkerArea>;
  /** MapMarkers.MapPlacement: gmMapUI::PlaceMarkerOnMap ('eor') or the 1999 MapSubPanel ('ac1999'). */
  placement: MapPlacement;
}

/** gmMapUI: the end-of-retail exe's notes, the EoL DAT's marker box (0x21000026:0x100001ec). */
const EOR_MAP_PANEL: MapPanelRules = Object.freeze({ notes: MAP_NOTE_LOCATIONS, markerArea: MAP_MARKER_AREA, placement: 'eor' as const });
/** The 1999 MapSubPanel: no notes, its own box (MapMarkers.MAP_MARKER_AREA_1999). */
const AC1999_MAP_PANEL: MapPanelRules = Object.freeze({ notes: Object.freeze([]), markerArea: MAP_MARKER_AREA_1999, placement: 'ac1999' as const });

/** A client string: an exe literal, or a local-DAT string-table entry with its fallback. */
export type ClientText = string | { readonly stringId: number; readonly fallback: string };

/** Resolve a ClientText through `lookup` (the loaded string tables). */
export function resolveClientText(t: ClientText, lookup: (id: number) => string | null | undefined): string {
  return typeof t === 'string' ? t : (lookup(t.stringId) ?? t.fallback);
}

export interface StatFooterText {
  attributePrompt: ClientText;
  skillPrompt: ClientText;
  /** Line 1 of a selected attribute. */
  xpToRaise: ClientText;
  /** Line 1 of a selected vital. */
  xpToRaiseVital: ClientText;
  /** Line 1 of a selected trained / specialized skill. */
  xpToRaiseSkill: ClientText;
  unassignedXp: ClientText;
  creditsToTrain: ClientText;
  creditsAvailable: ClientText;
  /** The price of a raise past the table's end. */
  infinity: ClientText;
  /** The header's total-XP label. */
  totalXp: ClientText;
}

export type CombatBarOption = 'repeatAttacks' | 'autoTarget' | 'keepCombatTargetsInView';

/** One row of an era client's own Character options page (EraClientRules.characterOptionsPage). */
export interface EraCharacterOption {
  /** CharacterSettingsRow.playerOption, or (with `ourKey`) an option end of retail's page doesn't have. */
  readonly playerOption: string;
  /** The era client's own label. */
  readonly label: string;
  /** The checkbox shows the bit's opposite (1999's "Accept Allegiance Requests" over IgnoreAllegianceRequests). */
  readonly inverted?: boolean;
  /**
   * An option end of retail dropped: our optionsSettings key and its options_ bit. It has no
   * SetSingleCharacterOption code, so a toggle sends the whole word (0x1A1), as the 1999 client
   * does for every option (SetCharacterOption1's worker @ 0x593b70).
   */
  readonly ourKey?: string;
  readonly options1Mask?: number;
}

/** The fellowship pane's option checkboxes (layout 0x21000031) and the option each sets (gmFellowshipUI::PostInit @ 0048fd40). */
export const FELLOWSHIP_PANE_OPTIONS: ReadonlyArray<readonly [number, string]> = [
  [0x10000270, 'IgnoreFellowshipRequests'],
  [0x10000271, 'FellowshipAutoAcceptRequests'],
  [0x10000272, 'FellowshipShareXP'],
  [0x10000273, 'FellowshipShareLoot'],
];

export interface ChatTargetText {
  /** The squelch row with nobody selected. */
  squelchSelected: string;
  /** The squelch row's prefix before the selected name. */
  squelchPrefix: string;
  /** The Chat button's label per talk focus (ChatTalkFocus TalkFocus ids); absent = the DAT's. */
  buttonLabels: Readonly<Partial<Record<number, string>>>;
}

export interface CharacterExamineText {
  /** Shown when the character has no allegiance, or null for nothing (end of retail). */
  noAllegiance: string | null;
  /** Shown when the character has no fellowship, or null for nothing (end of retail). */
  noFellowship: string | null;
  /** The label over a monarch's follower count. */
  allegianceMonarch: string;
  /** Whether the page ends with the "* = Unenchantable" legend. */
  unenchantableLegend: boolean;
}

/** The 1999 hover text (the help bar's two lines: the name line, then the hint). */
export interface ItemHoverText {
  wielded: string;
  worn: string;
  container: string;
  selling: string;
  hints: {
    wear: string; wield: string; pickUp: string; takeOff: string; use: string;
    consume: string; openClose: string; readWrite: string; unlock: string;
    manaTransfer: string; manaDrain: string; enterPortal: string;
    /** The world-object hints of the same function (@ 0x589460, case 1): a corpse, a vendor, a lifestone, a creature in combat mode. */
    lootCorpse: string; beginShopping: string; setResurrection: string; attack: string;
  };
  /** The vendor's line in place of the hint ("%u" = the price). */
  vendorWorth: { buy: string; buyList: string; sellList: string };
}

/** gmSkillUI::TrainSkill's prompt (.rdata 0x7a7864, a literal: no string-table entry). */
export const EOR_TRAIN_SKILL_CONFIRM = 'Are you sure you want to spend %d credits to train %s?';

const EOR_STAT_FOOTER_TEXT: StatFooterText = Object.freeze({
  attributePrompt: { stringId: 202231733, fallback: 'Select an Attribute to Improve' },
  skillPrompt: { stringId: 220682197, fallback: 'Select a Skill to Improve' },
  xpToRaise: { stringId: 175085980, fallback: 'Experience To Raise:' },
  xpToRaiseVital: { stringId: 175085980, fallback: 'Experience To Raise:' },
  xpToRaiseSkill: { stringId: 175085980, fallback: 'Experience To Raise:' },
  unassignedXp: { stringId: 249332076, fallback: 'Unassigned Experience:' },
  creditsToTrain: { stringId: 218797164, fallback: 'Skill Credits To Train' },
  creditsAvailable: { stringId: 230538876, fallback: 'Skill Credits Available:' },
  infinity: { stringId: 206482569, fallback: 'Infinity!' },
  totalXp: { stringId: 168019916, fallback: 'Total Experience (XP):' },
});

/** The 1999 client.exe's character panel strings (StatRegion / InfoBox / AttribInfoBox / SkillInfoBox). */
const AC1999_STAT_FOOTER_TEXT: StatFooterText = Object.freeze({
  attributePrompt: 'Select an attribute to improve.', // 0x608ca4, InfoBox @ 0x544092
  skillPrompt: 'Select a skill to improve.', // 0x608f34, SkillInfoBox @ 0x5455d7
  xpToRaise: 'XP to raise:', // 0x608cd4, InfoBox @ 0x543ef3 / AttribInfoBox::Display @ 0x544fad
  xpToRaiseVital: 'XP to raise max value:', // 0x608f1c, AttribInfoBox::Display @ 0x544f92 (a vital)
  xpToRaiseSkill: 'XP cost to raise skill:', // 0x608f50, SkillInfoBox @ 0x5455be
  unassignedXp: 'Unassigned XP:', // 0x608cc4, InfoBox @ 0x543fc8 / 0x5440f4 / 0x544a13
  creditsToTrain: 'Skill credits needed to train:', // 0x60908c, SkillInfoBox display @ 0x545896
  creditsAvailable: 'Skill credits available:', // 0x608f68, @ 0x54532c / 0x545c14
  infinity: 'INFINITY', // 0x608c90, @ 0x543815 / 0x544ffd / 0x545f6e
  totalXp: 'Total experience (XP):', // 0x608b7c, StatRegion @ 0x542e34
});

/**
 * The 1999 options page (SWEEP1999.character, CHAR-1): CharOptionsPanel's ctor @ 0x00591260 builds
 * exactly these fifteen checkboxes, top to bottom (CharOptionsPanel.c :209-572), one per options_
 * bit 0x1-0x8000 (PanelUI_HandleCommand @ 0x4f5700 toggles each through SetCharacterOption1; its
 * switch tops out at 0x9000114 / bit 0x8000; kb structures/CharacterOption). The 1999 PlayerModule
 * has no options2_ and nothing else in the client sets a later bit, so every end-of-retail row
 * past these (Always Daylight, Distance Fog, Share Fellowship XP / Loot, Show Helm, allegiance
 * logons, ...) is gone. Accept Allegiance / Fellowship Requests show the Ignore bits inverted
 * (CharOptionsPanel_Reset @ 0x005948a0: `0x004f7150() == 0`). Automatically Create Shortcuts
 * (0x1), Invert Mouse Look (0x10) and Right-click mouselook (0x4000) are bits end of retail
 * dropped (ACE CharacterOptions1 NotUsed1 / NotUsed2 / NotUsed4).
 */
const AC1999_CHARACTER_OPTIONS_PAGE: readonly EraCharacterOption[] = Object.freeze(([
  { playerOption: 'AutoShortCut', label: 'Automatically Create Shortcuts', ourKey: 'autoCreateShortcuts', options1Mask: 0x1 }, // :209
  { playerOption: 'ShowTooltips', label: 'Display Tooltips' }, // :234, 0x611594
  { playerOption: 'StayInChatMode', label: 'Stay in Chat Mode after sending a message' }, // :261, 0x611568
  { playerOption: 'VividTargetingIndicator', label: 'Vivid targeting indicator' }, // :287, 0x61154c
  { playerOption: 'IgnoreAllegianceRequests', label: 'Accept Allegiance Requests', inverted: true }, // :313
  { playerOption: 'IgnoreFellowshipRequests', label: 'Accept Fellowship Requests', inverted: true }, // :339
  { playerOption: 'UseDeception', label: 'Attempt to Deceive Other Players' }, // :365, 0x611528
  { playerOption: 'AllowGive', label: 'Let Other Players Give You Items' }, // :391, 0x611504
  { playerOption: 'ToggleRun', label: 'Run as Default Movement' }, // :417, 0x6114ec
  { playerOption: 'AdvancedCombatUI', label: 'Advanced Combat Interface (No Panel)' }, // :443, 0x6114c4
  { playerOption: 'AutoTarget', label: 'Auto Target' }, // :468
  { playerOption: 'AutoRepeatAttack', label: 'Automatically Repeat Attacks' }, // :495, 0x6114a4
  { playerOption: 'ViewCombatTarget', label: 'Automatically keep combat targets in view' }, // :521, 0x611478
  { playerOption: 'InvertMouseLook', label: 'Invert Mouse Look Up/Down', ourKey: 'invertMouseLook', options1Mask: 0x10 }, // :547
  { playerOption: 'RightClickMouselook', label: 'Right-click mouselook', ourKey: 'rightClickMouselook', options1Mask: 0x4000 }, // :572
] as EraCharacterOption[]).map((o) => Object.freeze(o)));

/**
 * What a 1999 world pins (CHAR-1): the local effects of end-of-retail options the 1999 client
 * never had, so a value an end-of-retail session stored can't carry a night-vision, fog-free or
 * other later view into 1999. Always Daylight (LScape::SetDay), Disable Distance Fog and Disable
 * Most Weather Effects came with later clients; the 1999 vitals are one stacked cluster, its chat
 * lines carry no time stamps, and it has no Use Mouse Turning (Right-click mouselook, on its
 * options page, is the 1999 way).
 */
const AC1999_OPTION_PINS: Readonly<Record<string, boolean>> = Object.freeze({
  alwaysDaylight: false,
  disableDistanceFog: false,
  disableWeather: false,
  sideBySideVitals: false,
  displayTimestamps: false,
  useMouseTurning: false,
  // Fellowship sharing, as the 1999 options word had it (AC1999_OPTIONS_WORD_FIX).
  shareFellowshipXP: true,
  shareFellowshipLoot: false,
});

/**
 * Bits of the server's options word the era's client had no way to change, held at that client's
 * value (SWEEP1999.character). The 1999 client has no FellowshipShareXP (0x40000) or
 * FellowshipShareLoot (0x100000) bit (its options stop at 0x8000; kb structures/CharacterOption), but
 * the AC1999 server still honours both (FellowshipManager.cpp). A 1999 player only ever had the
 * server's default word (PhatSDK/PlayerModule.h `options_ = 0x50C4A542`): XP shared, loot not; the
 * 1999 roster has no share_loot field either (kb structures/Fellow). An earlier webAC build let a
 * 1999 player flip them; the login's word is put back (correctedOptionsWord).
 */
export interface OptionsWordFix {
  /** Bits that must be set. */
  readonly set: number;
  /** Bits that must be clear. */
  readonly clear: number;
}
const AC1999_OPTIONS_WORD_FIX: OptionsWordFix = Object.freeze({ set: 0x40000, clear: 0x100000 });

/** The options word with the era's fixed bits restored, or null when it already has them (or there is no fix). */
export function correctedOptionsWord(word: number, fix: OptionsWordFix | null): number | null {
  if (!fix) return null;
  const fixed = ((word | fix.set) & ~fix.clear) >>> 0;
  return fixed === (word >>> 0) ? null : fixed;
}

const EOR_CLIENT_RULES: EraClientRules = Object.freeze({
  castStopsMovement: true, attackStopsAlways: false, combatModeCheck: 'eor' as const, spellResearch: false, splitpea: false, vendorBuyOneMask: 0x0dc41cb0, appraisalText: 'eor' as const, statLineText: 'eor' as const, spellBarTabs: 8, shortcutSlots: 18, characterInfoText: 'eor' as const, spellBarArrows: 'pair' as const,
  chatToggle: 'server' as const,
  talismanTargetTypes: TALISMAN_TARGET_TYPES_EOR,
  spellSelfTargetableTypeMask: 0x8107,
  radarVisibility: 'eor' as const, // ACCWeenieObject::InqShowableOnRadar @ 0058c250
  keymap: 'eor' as const, // portal KeyMap 0x14000000 + 0x14000002
  combatClickSelect: 'any' as const,
  shortcutDropCheck: 'eor' as const,
  equipSlotMask: 0xffffffff,
  statFooterText: EOR_STAT_FOOTER_TEXT,
  statRaiseTen: true,
  trainSkillConfirm: EOR_TRAIN_SKILL_CONFIRM,
  combatBarOptions: Object.freeze(['repeatAttacks', 'autoTarget', 'keepCombatTargetsInView'] as const),
  // gmSpellbookUI::DeleteSpell @ 0048bd50 (.rdata 0x7a3ea8, its only reference @ 0048bdb6).
  spellDeleteConfirm: 'Are you sure you want to remove %s from your spellbook? You will no longer be able to cast this spell unless you learn it again!',
  chatTargetText: null,
  characterOptionsPage: null,
  // The 1999 options_ bits end of retail dropped (ACE CharacterOptions1 NotUsed1 / 2 / 4): no row,
  // no effect, whatever a 1999 session stored.
  optionPins: Object.freeze({ autoCreateShortcuts: false, invertMouseLook: false, rightClickMouselook: false }),
  optionsWordFix: null,
  heritageLine: 'eor' as const,
  vitaePanel: 'eor' as const,
  // CharExamineUI::SetAppraiseInfo @ 004b45f0: "Alleg. Monarch:", the legend last, nothing when unaffiliated.
  characterExamineText: Object.freeze({ noAllegiance: null, noFellowship: null, allegianceMonarch: 'Alleg. Monarch:', unenchantableLegend: true }),
  itemHoverText: null,
  mapPanel: EOR_MAP_PANEL,
  inventoryRequestWatchdogSeconds: null,
  raiseAwaitClearsOnStatUpdate: false,
  serverTextSlots: null,
  failureEventText: null,
  inventoryFailedRunsFailureEvent: true,
  hitLineText: 'eor' as const,
  encumbranceNotice: EOR_ENCUMBRANCE_NOTICE, // CPlayerSystem::OnLoadChanged @ 0055f510
  useObject: EOR_USE_OBJECT_RULES, // ItemHolder::UseObject @ 00588a80
  deleteCharacterConfirm: null,
  placementText: EOR_PLACEMENT_TEXT,
  spellBarChargeMeter: false,
  combinedEffectsTitle: null,
  spellDurationText: 'eor' as const,
  castButtonText: null,
  learnOpensSpellbook: false,
  spellbookOrder: 'displayOrder' as const,
  componentPrecheckSlots: Object.freeze([0, 8] as const),
  inventoryPlacement: 'eor' as const,
  paperdollSlotDropSwaps: false,
  dualWieldShieldSlot: true,
  targetedUseConfirmations: true,
  vendorDropNeedsWholeStack: true,
  useWithTargetText: EOR_USE_WITH_TARGET_TEXT,
  promissoryNoteRates: PROMISSORY_NOTE_RATES_EOR,
  vendorAcceptability: 'eor' as const,
  vendorTypeFilters: EOR_VENDOR_TYPE_FILTERS,
  // ItemExamineUI::SetInscription @ 004ae2f0 (acclient.exe 0x3af564).
  inscribePlaceholder: Object.freeze({ text: '<Inscribe here>', centered: false }),
  // gmBookUI::UpdateMenu @ 004baf80 (the bare author name); CloseCurPage @ 004bb340 saves changed or not.
  book: Object.freeze({ menuAuthorFormat: '%s', saveOnlyChanged: false }),
  world: EOR_WORLD_RULES,
  commandTable: 'eor' as const,
  speechHearing: 'all' as const,
  socialLineText: 'eor' as const,
  worldEntryVersionLine: null,
});
const AC1999_CLIENT_RULES: EraClientRules = Object.freeze({
  castStopsMovement: false, attackStopsAlways: true, combatModeCheck: 'ac1999' as const, spellResearch: true, splitpea: true, vendorBuyOneMask: 0x14b0, appraisalText: 'ac1999' as const, statLineText: 'ac1999' as const, spellBarTabs: 1, shortcutSlots: 9, characterInfoText: 'ac1999' as const, spellBarArrows: 'ends' as const,
  chatToggle: 'local' as const,
  talismanTargetTypes: TALISMAN_TARGET_TYPES_1999, // @ 0x5e4150
  spellSelfTargetableTypeMask: 0, // UI ObjectCompatibleWithSpellTargetType @ 0x4d20c0
  radarVisibility: 'ac1999' as const, // ACCWeenieObject_InqShowableOnRadar @ 0x4e2f20
  keymap: 'ac1999' as const, // Default.map (InputMapper @ 0x0059fe70)
  combatClickSelect: 'attackableOnly' as const, // PanelUI_HandleMouseDownOnObject @ 0x004f83c0
  shortcutDropCheck: 'ac1999' as const, // ShortcutSlot_AcceptDragObject @ 0x00500240
  equipSlotMask: 0x1bf8000, // InventoryPanel @ 0x522fc0
  statFooterText: AC1999_STAT_FOOTER_TEXT,
  statRaiseTen: false,
  trainSkillConfirm: null,
  combatBarOptions: Object.freeze(['repeatAttacks', 'autoTarget'] as const), // CombatPanel @ 0x589bc0
  // 0x604e60 (its three leading layout newlines dropped), _snprintf'd with the row's spell name @ 0x516701.
  spellDeleteConfirm: 'Are you sure you want to delete %s?',
  // ChatMenu @ 0x51b390 (0x605524 "Ignore Selected"), SetSelected's "Ignore " (0x605650 @ 0x51c4de);
  // the button reads "Chat" for Chat to All and "Tell" for every tell (@ 0x51c050: 0x51c22b-0x51c2f9).
  chatTargetText: Object.freeze({
    squelchSelected: 'Ignore Selected', squelchPrefix: 'Ignore ',
    buttonLabels: Object.freeze({ 1: 'Chat', 2: 'Tell', 3: 'Tell', 4: 'Tell', 5: 'Tell', 6: 'Tell' }),
  }),
  characterOptionsPage: AC1999_CHARACTER_OPTIONS_PAGE,
  optionPins: AC1999_OPTION_PINS,
  optionsWordFix: AC1999_OPTIONS_WORD_FIX,
  heritageLine: 'ac1999' as const, // StatRegion_UpdateFromPlayerDesc @ 0x00543520
  vitaePanel: 'ac1999' as const, // 0x005f0610, VitaePanel_UpdateFromPlayerDesc @ 0x0054c120
  // CharExaminePanel::SetAppraiseInfo @ 0x0050f760: "No Allegiance" (0x604160, then Loyalty / Leadership),
  // "Allegiance Monarch:" (0x604190), "No Fellowship" (0x603fe4); no legend line.
  characterExamineText: Object.freeze({ noAllegiance: 'No Allegiance', noFellowship: 'No Fellowship', allegianceMonarch: 'Allegiance Monarch:', unenchantableLegend: false }),
  // The hover text builder @ 0x5873c0 (name line), its hint @ 0x589460, the vendor line @ 0x5a4000.
  itemHoverText: Object.freeze({
    wielded: ' (wielded)', worn: ' (worn)', container: ' (container)', selling: 'Selling ', // 0x60fa54 / 60 / 68, 0x60fa8c
    hints: Object.freeze({
      wear: "Double click to wear (if there's room)", wield: 'Double click to wield', // 0x60fb2c, 0x60fb54
      pickUp: 'Double click to pick up', takeOff: 'Double click to unwield/take off', // 0x60fb6c, 0x60fb84
      use: 'Double click to use', consume: 'Double click to consume', // 0x60fba8, 0x60fc90
      openClose: 'Double click to open and close', readWrite: 'Double click to read or write', // 0x60fc70, 0x60fc50
      unlock: 'Double click to unlock your last selected item', // 0x60fc20
      manaTransfer: 'Double click to transfer Mana to an item.', manaDrain: 'Double click to drain Mana from, and destroy, an item.', // 0x60fbf4, 0x60fbbc
      enterPortal: 'Double click to enter portal', // 0x60fca8
      lootCorpse: 'Double click to loot corpse', beginShopping: 'Double click to begin shopping',
      setResurrection: 'Double click to set your resurrection location', attack: 'Double click to attack',
    }),
    vendorWorth: Object.freeze({
      buy: 'Worth %up - Double click to buy', // 0x612f80
      buyList: 'Worth %up - Double click to remove from buying list', // 0x612f4c
      sellList: 'Worth %up - Double click to remove from selling list', // 0x612f14
    }),
  }),
  mapPanel: AC1999_MAP_PANEL,
  inventoryRequestWatchdogSeconds: INVENTORY_REQUEST_WATCHDOG_1999_SECONDS, // Global_Loop @ 0x4c6b30
  raiseAwaitClearsOnStatUpdate: true, // StatsPanel_SetAttribute @ 0x0054a6f0, StatsPanel_SetInt @ 0x0054a740
  serverTextSlots: SERVER_TEXT_SLOTS_1999,
  failureEventText: FAILURE_EVENT_TEXT_1999, // UI_HandleFailureEvent @ 0x004ccd10
  inventoryFailedRunsFailureEvent: false, // Net_DispatchServerMessage case 0xa0
  hitLineText: 'ac1999' as const, // Net_HandleAttackerNotification @ 0x004cd7f0 and its three siblings
  encumbranceNotice: AC1999_ENCUMBRANCE_NOTICE, // 0x004fa610 + PanelUI_Global_Loop @ 0x004f4e10
  useObject: AC1999_USE_OBJECT_RULES, // ItemHolder_UseObject @ 0x004e5ee0
  deleteCharacterConfirm: 'Deleting %s cannot be undone.  Are you sure?', // IntroUI_ListenToMessage
  placementText: AC1999_PLACEMENT_TEXT, // AttemptPlaceInContainerIsLegal / AttemptMergeIsLegal
  spellBarChargeMeter: true, // SpellCastSubPanel ctor @ 0x512390, UpdateChargeMeter @ 0x513390
  combinedEffectsTitle: 'Spells in Effect', // SpellsInEffectPanel ctor @ 0x59ac70
  spellDurationText: 'ac1999' as const, // SpellExaminePanel_ExamineSpell @ 0x511110
  castButtonText: AC1999_CAST_BUTTON_TEXT, // UpdateCastButton @ 0x513e00
  learnOpensSpellbook: true, // SpellbookPanel_AddSpell @ 0x5169d0 (param_2)
  spellbookOrder: 'name' as const, // SpellbookPanel_AddSpell's insertion loop
  componentPrecheckSlots: Object.freeze([1, 6] as const), // UI_CastSpell @ 0x4d1bd0
  inventoryPlacement: 'ac1999' as const, // ItemHolder_AttemptPlaceInContainer @ 0x4e55b0
  paperdollSlotDropSwaps: true, // ItemSlot_AcceptDragObject → PanelUI_AutoWield(obj, side, 0, 1, 0, 0)
  dualWieldShieldSlot: false, // ItemSlot_AcceptDragObject: valid & slot only
  targetedUseConfirmations: false, // 0x004e65c0
  vendorDropNeedsWholeStack: false, // ItemHolder_AttemptPlaceIn3D → 0x004d00d0
  useWithTargetText: AC1999_USE_WITH_TARGET_TEXT,
  promissoryNoteRates: PROMISSORY_NOTE_RATES_1999, // ShopSystem_SellPrice @ 0x5f3ce0 / BuyPrice @ 0x5f3c70
  vendorAcceptability: 'ac1999' as const, // VendorProfile_InqAcceptability @ 0x5e1920
  vendorTypeFilters: AC1999_VENDOR_TYPE_FILTERS,
  // ItemExaminePanel_SetInscription @ 0x0050b2e0: "(inscribe here)", centred in the block.
  inscribePlaceholder: Object.freeze({ text: '(inscribe here)', centered: true }),
  // ReadWritePanel_UpdateMenu @ 0x00521230 ("- %s" 0x606cc4); CloseCurPage @ 0x00521820 saves a dirty page only.
  book: Object.freeze({ menuAuthorFormat: '- %s', saveOnlyChanged: true }),
  world: AC1999_WORLD_RULES,
  commandTable: 'ac1999' as const, // ChatEntryField @ 0x518970
  speechHearing: 'radar' as const, // UI_ShouldHearSpeaker @ 0x4d0360
  socialLineText: 'ac1999' as const, // UI_HandleChannelMessage @ 0x4d24a0, 0x00536f40
  worldEntryVersionLine: AC1999_VERBOSE_VERSION, // ClientMode_RunTransition @ 0x4d08a0
});

/** The client-code rules of era `p` (end of retail's for every era that runs its exe). */
export function eraClientRules(p: EraProfile | null | undefined): EraClientRules {
  if (p?.login.protocol === 'ac1999') return AC1999_CLIENT_RULES;
  const renames = p?.mapNoteRenames;
  if (!renames) return EOR_CLIENT_RULES;
  let rules = renamedNoteRules.get(renames);
  if (!rules) {
    const notes = Object.freeze(MAP_NOTE_LOCATIONS.map((n) => (renames[n.name] ? Object.freeze({ ...n, name: renames[n.name] }) : n)));
    rules = Object.freeze({ ...EOR_CLIENT_RULES, mapPanel: Object.freeze({ ...EOR_MAP_PANEL, notes }) });
    renamedNoteRules.set(renames, rules);
  }
  return rules;
}
const renamedNoteRules = new WeakMap<object, EraClientRules>();

/** Show/Hide Negative Magic Panel (ActionMap 0x26000000; 0x2100001b:0x10000121's p87). */
export const SHOW_HIDE_NEGATIVE_MAGIC_PANEL = 0x10000007;

/** Previous / Next / First / Last Spell Tab (ActionMap 0x26000000; gmSpellcastingUI::RecvNotice_*SpellTab). */
export const SPELL_TAB_ACTIONS: readonly number[] = [0x10000063, 0x10000064, 0x10000104, 0x10000105];

/** Every Quickslot / Select Quickslot command id (1-12: 0x10000042-59, 13-18: 0x10000132-3d). */
const QUICKSLOT_ACTIONS: readonly number[] = [
  ...Array.from({ length: 0x18 }, (_, i) => 0x10000042 + i),
  ...Array.from({ length: 12 }, (_, i) => 0x10000132 + i),
];

/**
 * The Keyboard Config commands era `rules` leaves with nothing to do (BUG.ac1999-spell-tabs): the
 * spell-tab commands on a one-tab bar, the Quickslot / Select Quickslot commands past the
 * toolbar's slot count, and Show/Hide Spell Research Page without the research tab. Like FEATURE_KEYBIND_ACTIONS, they are not listed (No Dead-End UI).
 */
export function clientRuleHiddenActions(rules: Pick<EraClientRules, 'spellBarTabs' | 'shortcutSlots'> & Partial<Pick<EraClientRules, 'spellResearch' | 'combinedEffectsTitle' | 'characterOptionsPage'>>): Set<number> {
  const out = new Set<number>();
  if (rules.spellBarTabs <= 1) for (const id of SPELL_TAB_ACTIONS) out.add(id);
  // SWEEP1999.input — the 1999 Spell Research Page command, only where the research tab exists.
  if (!rules.spellResearch) out.add(SPELL_RESEARCH_PAGE_ACTION);
  // One combined effects window (MAG-4): Show/Hide Negative Magic Panel has no window to show.
  if (rules.combinedEffectsTitle) out.add(SHOW_HIDE_NEGATIVE_MAGIC_PANEL);
  for (const id of QUICKSLOT_ACTIONS) {
    const q = quickslotCommand(id);
    if (q && q.slot >= rules.shortcutSlots) out.add(id);
  }
  // SWEEP1999.character — an era with its own options page: the toggle commands of options not on it.
  const page = rules.characterOptionsPage;
  if (page) {
    for (const [id, opt] of Object.entries(OPTION_KEYBIND_ACTIONS)) if (!page.some((o) => o.playerOption === opt)) out.add(Number(id));
  }
  return out;
}

/**
 * The Keyboard Config's option toggles (ActionMap 0x26000000, ActionClass CharacterSettings) and the
 * PlayerOption each flips. On an era with its own options page (EraClientRules.characterOptionsPage)
 * a toggle whose option isn't on it is not listed: 1999 keeps the twelve of its fifteen that end of
 * retail still binds.
 */
export const OPTION_KEYBIND_ACTIONS: Readonly<Record<number, string>> = {
  0x10000071: 'AutoRepeatAttack', 0x10000072: 'IgnoreAllegianceRequests', 0x10000073: 'IgnoreFellowshipRequests',
  0x10000074: 'IgnoreTradeRequests', 0x10000076: 'PersistentAtDay', 0x10000077: 'AllowGive', 0x10000078: 'ViewCombatTarget',
  0x10000079: 'ShowTooltips', 0x1000007a: 'UseDeception', 0x1000007b: 'ToggleRun', 0x1000007c: 'StayInChatMode',
  0x1000007d: 'AdvancedCombatUI', 0x1000007e: 'AutoTarget', 0x1000007f: 'VividTargetingIndicator',
  0x10000080: 'FellowshipShareXP', 0x10000081: 'AcceptLootPermits', 0x10000082: 'FellowshipShareLoot',
  0x10000083: 'FellowshipAutoAcceptRequests', 0x10000085: 'CoordinatesOnRadar', 0x10000086: 'SpellDuration',
  0x10000087: 'DisableHouseRestrictionEffects', 0x10000088: 'DragItemOnPlayerOpensSecureTrade',
  0x10000089: 'DisplayAllegianceLogonNotifications', 0x1000008a: 'UseChargeAttack', 0x1000008b: 'UseCraftSuccessDialog',
  0x1000008c: 'HearAllegianceChat', 0x1000008d: 'DisplayDateOfBirth', 0x1000008e: 'DisplayAge', 0x1000008f: 'DisplayChessRank',
  0x10000090: 'DisplayFishingSkill', 0x10000091: 'DisplayNumberDeaths', 0x10000092: 'DisplayTimeStamps', 0x10000093: 'SalvageMultiple',
  0x1000010e: 'HearGeneralChat', 0x1000010f: 'HearTradeChat', 0x10000110: 'HearLFGChat', 0x10000112: 'HearRoleplayChat',
  0x1000011b: 'DisplayNumberCharacterTitles', 0x1000011d: 'MainPackPreferred', 0x1000011e: 'LeadMissileTargets',
  0x1000011f: 'UseFastMissiles', 0x10000120: 'FilterLanguage', 0x10000123: 'ConfirmVolatileRareUse', 0x10000125: 'HearSocietyChat',
  0x1000012a: 'ShowHelm', 0x1000012c: 'DisableDistanceFog', 0x1000012f: 'ShowCloak', 0x1000013e: 'SideBySideVitals',
};
