/**
 * Era capabilities: the features a world's era lacks, so the interface hides
 * their controls instead of showing ones that do nothing (CLAUDE.md "No
 * Dead-End UI"; docs/ac1999-support-scope.md Phase 5). One source of truth:
 * the 1999 adapter's absent-feature list (network era1999/Absent1999.ts)
 * plus the interface-only gaps below. End of retail and the classic eras run
 * the end-of-retail client and lack nothing here.
 */
import { ABSENT_1999, type Absent1999Feature } from '@ac/network';
import { TALISMAN_TARGET_TYPES_1999, TALISMAN_TARGET_TYPES_EOR, type TalismanTargetTypes } from '@ac/shared';
import type { EraProfile } from './EraProfiles.js';
import { quickslotCommand } from '../network/itemShortcutRestore.js';
import { MAP_NOTE_LOCATIONS, type MapNoteLocation } from '../ui/HudTooltips.js';
import { MAP_MARKER_AREA, MAP_MARKER_AREA_1999, type MapMarkerArea, type MapPlacement } from '../ui/MapMarkers.js';

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
   * (Allow Others to See Your Fishing Skill). Its options page lists thirteen character options,
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
   * of the 1999 client's thirteen character options (strings @ file 0x210a44-0x210ba8), and
   * nothing on the AC1999 server or in our client acts on it there, so its fellowship-pane
   * checkbox, its Character options row, its Keyboard Config command and the agent's auto toggle
   * are inert on 1999.
   */
  | 'autoAcceptFellowship';

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
 * - desiredComponents: the rebuy book's 0x224 has no 1999 builder.
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

/**
 * The chat @-commands (CommandEntry names, lower case) each feature owns. An era lacking the
 * feature never registers them: the word falls through as an unknown one does (DoChannelCommand,
 * then the whole line to the server, as both clients do), @help <word> says "Unknown command", and
 * the @help lists leave their lines out (chat/commands/TextUiHelpCommands.ts). The Turbine-chat
 * room commands need no entry: they register only when the server's character list turns
 * TurbineChat on (StartupTurbineChatSystem), which a 1999 world never does.
 *
 * Commands that work in the client alone stay on every era (@title names a chat window, @saveui /
 * @loadui / @lockui keep the layout locally, @die / @corpse / @day / @emotes, the channel words).
 */
export const FEATURE_COMMANDS: Readonly<Partial<Record<EraFeature, readonly string[]>>> = {
  afk: ['afk'],
  // 1999's @-table has no @allegiance at all; every subcommand (boot, info, ban, officer, title,
  // name, lock, house, hometown, motd, broadcast, chat kick / gag) is an administration action.
  allegianceAdmin: ['allegiances', 'allegiance', 'all', 'ab', 'alh', 'ah', 'motd', 'speaker'],
  housing: ['house', 'hou', 'hslist', 'hor', 'hr', 'hom', 'hoa'],
  consent: ['consent', 'permit'],
  postLaunchRecalls: ['marketplace', 'mar', 'mp', 'pkarena', 'pka', 'pklarena', 'pla'],
  pkLite: ['pklite', 'pkl'],
  squelchFilters: ['filter', 'unfilter', 'messagetypes', 'message_types', 'msgtypes', 'msg_types'],
  // @join / @leave set the Listen to <room> Chat options, the TurbineChat rooms'.
  turbineChat: ['join', 'leave'],
  desiredComponents: ['fillcomps'],
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
   * Character options rows that do nothing in this era (CharacterSettingsRow.playerOption): neither
   * its server nor our client acts on them. Rows whose feature the era lacks are FEATURE_CHARACTER_OPTIONS'.
   */
  characterOptionsInert: readonly string[];
  /** The era client's own label for a Character options row (by playerOption); absent = the DAT label. */
  characterOptionLabels: Readonly<Record<string, string>>;
  /** The character examine page's era wording. */
  characterExamineText: CharacterExamineText;
  /** The item hover text's era additions, or null (end of retail: UIElement_UIItem::UpdateTooltip, the name alone). */
  itemHoverText: ItemHoverText | null;
  /** The World panel's map: its town notes and how the player's marker is placed (BUG.ac1999-map-eor-art, webac#10). */
  mapPanel: MapPanelRules;
}

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

/** Character options rows a 1999 world has no use for (BUG.ac1999-eor-ui-values, item 8; each checked). */
const AC1999_INERT_CHARACTER_OPTIONS: readonly string[] = Object.freeze([
  // options2 bits the AC1999 server stores (ClientEvents.cpp CHANGE_PLAYER_OPTION) but never reads,
  // with no local effect in our client either:
  'MainPackPreferred', 'FilterLanguage',
  // Read only by its appraisal builder (ObjectMsgs.cpp ~1494 / ~1711), but the 1999 creature profile
  // the 1999 client and our adapter carry has no age, birth or deaths fields (Inventory1999.ts):
  'DisplayDateOfBirth', 'DisplayAge', 'DisplayNumberDeaths',
  // Stored, never read by the 1999 server (only command/ClientBugs.cpp names it), no local effect.
  // (Automatically Accept Fellowship Requests is the same, but its row, checkbox and key belong to
  // the autoAcceptFellowship feature: FEATURE_CHARACTER_OPTIONS.)
  'UseChargeAttack',
]);

/** The 1999 options page's own labels (SystemPanel @ 0x591900-0x592d00) for the rows it had. */
const AC1999_CHARACTER_OPTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ViewCombatTarget: 'Automatically keep combat targets in view', // 0x611478 @ 0x5929d5
  AutoRepeatAttack: 'Automatically Repeat Attacks', // 0x6114a4 @ 0x592861
  AdvancedCombatUI: 'Advanced Combat Interface (No Panel)', // 0x6114c4 @ 0x59258b
  ToggleRun: 'Run as Default Movement', // 0x6114ec @ 0x59241a
  AllowGive: 'Let Other Players Give You Items', // 0x611504
  UseDeception: 'Attempt to Deceive Other Players', // 0x611528
  VividTargetingIndicator: 'Vivid targeting indicator', // 0x61154c @ 0x591d55
  StayInChatMode: 'Stay in Chat Mode after sending a message', // 0x611568 @ 0x591bfd
  ShowTooltips: 'Display Tooltips', // 0x611594 @ 0x591aa5
});

const EOR_CLIENT_RULES: EraClientRules = Object.freeze({
  castStopsMovement: true, attackStopsAlways: false, combatModeCheck: 'eor' as const, spellResearch: false, splitpea: false, vendorBuyOneMask: 0x0dc41cb0, appraisalText: 'eor' as const, statLineText: 'eor' as const, spellBarTabs: 8, shortcutSlots: 18, characterInfoText: 'eor' as const, spellBarArrows: 'pair' as const,
  chatToggle: 'server' as const,
  talismanTargetTypes: TALISMAN_TARGET_TYPES_EOR,
  spellSelfTargetableTypeMask: 0x8107,
  equipSlotMask: 0xffffffff,
  statFooterText: EOR_STAT_FOOTER_TEXT,
  statRaiseTen: true,
  trainSkillConfirm: EOR_TRAIN_SKILL_CONFIRM,
  combatBarOptions: Object.freeze(['repeatAttacks', 'autoTarget', 'keepCombatTargetsInView'] as const),
  // gmSpellbookUI::DeleteSpell @ 0048bd50 (.rdata 0x7a3ea8, its only reference @ 0048bdb6).
  spellDeleteConfirm: 'Are you sure you want to remove %s from your spellbook? You will no longer be able to cast this spell unless you learn it again!',
  chatTargetText: null,
  characterOptionsInert: Object.freeze([]),
  characterOptionLabels: Object.freeze({}),
  // CharExamineUI::SetAppraiseInfo @ 004b45f0: "Alleg. Monarch:", the legend last, nothing when unaffiliated.
  characterExamineText: Object.freeze({ noAllegiance: null, noFellowship: null, allegianceMonarch: 'Alleg. Monarch:', unenchantableLegend: true }),
  itemHoverText: null,
  mapPanel: EOR_MAP_PANEL,
});
const AC1999_CLIENT_RULES: EraClientRules = Object.freeze({
  castStopsMovement: false, attackStopsAlways: true, combatModeCheck: 'ac1999' as const, spellResearch: true, splitpea: true, vendorBuyOneMask: 0x14b0, appraisalText: 'ac1999' as const, statLineText: 'ac1999' as const, spellBarTabs: 1, shortcutSlots: 9, characterInfoText: 'ac1999' as const, spellBarArrows: 'ends' as const,
  chatToggle: 'local' as const,
  talismanTargetTypes: TALISMAN_TARGET_TYPES_1999, // @ 0x5e4150
  spellSelfTargetableTypeMask: 0, // UI ObjectCompatibleWithSpellTargetType @ 0x4d20c0
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
  characterOptionsInert: AC1999_INERT_CHARACTER_OPTIONS,
  characterOptionLabels: AC1999_CHARACTER_OPTION_LABELS,
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
    }),
    vendorWorth: Object.freeze({
      buy: 'Worth %up - Double click to buy', // 0x612f80
      buyList: 'Worth %up - Double click to remove from buying list', // 0x612f4c
      sellList: 'Worth %up - Double click to remove from selling list', // 0x612f14
    }),
  }),
  mapPanel: AC1999_MAP_PANEL,
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

/** Previous / Next / First / Last Spell Tab (ActionMap 0x26000000; gmSpellcastingUI::RecvNotice_*SpellTab). */
export const SPELL_TAB_ACTIONS: readonly number[] = [0x10000063, 0x10000064, 0x10000104, 0x10000105];

/** Every Quickslot / Select Quickslot command id (1-12: 0x10000042-59, 13-18: 0x10000132-3d). */
const QUICKSLOT_ACTIONS: readonly number[] = [
  ...Array.from({ length: 0x18 }, (_, i) => 0x10000042 + i),
  ...Array.from({ length: 12 }, (_, i) => 0x10000132 + i),
];

/**
 * The Keyboard Config commands era `rules` leaves with nothing to do (BUG.ac1999-spell-tabs): the
 * spell-tab commands on a one-tab bar, and the Quickslot / Select Quickslot commands past the
 * toolbar's slot count. Like FEATURE_KEYBIND_ACTIONS, they are not listed (No Dead-End UI).
 */
export function clientRuleHiddenActions(rules: Pick<EraClientRules, 'spellBarTabs' | 'shortcutSlots'>): Set<number> {
  const out = new Set<number>();
  if (rules.spellBarTabs <= 1) for (const id of SPELL_TAB_ACTIONS) out.add(id);
  for (const id of QUICKSLOT_ACTIONS) {
    const q = quickslotCommand(id);
    if (q && q.slot >= rules.shortcutSlots) out.add(id);
  }
  return out;
}
