/**
 * Era capabilities: the features a world's era lacks, so the interface hides
 * their controls instead of showing ones that do nothing (CLAUDE.md "No
 * Dead-End UI"; docs/ac1999-support-scope.md Phase 5). One source of truth:
 * the 1999 adapter's absent-feature list (network era1999/Absent1999.ts)
 * plus the interface-only gaps below. End of retail and the classic eras run
 * the end-of-retail client and lack nothing here.
 */
import { ABSENT_1999, type Absent1999Feature } from '@ac/network';
import type { EraProfile } from './EraProfiles.js';
import { quickslotCommand } from '../network/itemShortcutRestore.js';

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
   * sweep): cloaks and trinkets (their paperdoll slots and the Show Your Cloak option), rare gems
   * (Confirm Use of Rare Gems) and fishing (Allow Others to See Your Fishing Skill). Its options
   * page lists thirteen character options, none of these (strings @ file 0x210a44-0x210ba8), and
   * its strings name no cloak, trinket or fishing at all.
   */
  | 'cloaks'
  | 'trinkets'
  | 'rareGems'
  | 'fishing';

const NONE: ReadonlySet<EraFeature> = new Set();
/**
 * What a 1999 world hides, and why each entry still needs to (2026-10-06).
 * Only features whose target needs something the 1999 server or its data
 * lack belong here; a purely client-side panel stays. The World panel (map
 * button, its keys) is client-side: the end-of-retail Dereth map from the
 * interface portal and the player's own position, so it shows on 1999 too
 * (Jake 2026-10-06: "there should still be a map button").
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
 * - netherDamage: the 1999 armor profile carries seven resistances, no nether.
 */
const AC1999_UNSUPPORTED: ReadonlySet<EraFeature> = new Set<EraFeature>([
  ...(Object.keys(ABSENT_1999) as Absent1999Feature[]),
  'eolWcidTables',
  'friendsPanel',
  'netherDamage',
  'cloaks',
  'trinkets',
  'rareGems',
  'fishing',
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
};

/** The paperdoll equip slots (EquipMask bits) each feature owns. */
export const FEATURE_EQUIP_SLOTS: Readonly<Partial<Record<EraFeature, readonly number[]>>> = {
  cloaks: [0x08000000], // EquipMask.Cloak
  trinkets: [0x04000000], // EquipMask.TrinketOne
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
  contracts: [0x1000012e, 0x10000127, 0x10000128], // Contracts, Quest Detail, Quest Journal
  characterTitles: [0x1000011a, 0x1000011b], // Titles Page, Allow Others to See Your Number of Titles
  secureTrade: [0x10000074, 0x10000088], // Ignore All Trade Requests, Drag Item to Player Opens Trade
  consent: [0x10000081], // Accept Corpse Looting Permissions
  chess: [0x1000008f], // Allow Others to See Your Chess Rank
  salvage: [0x10000093, 0x1000008b], // Salvage Multiple, Use Crafting Chance of Success Dialog
  turbineChat: [0x1000008c, 0x1000010e, 0x1000010f, 0x10000110, 0x10000112, 0x10000125], // Listen to Allegiance/General/Trade/LFG/Roleplay/Society Chat
  friendsPanel: [0x10000118], // Show/Hide Friends Page
};

/** Every entry of `table` owned by a feature in `unsupported`. */
export function hiddenBy<T>(table: Readonly<Partial<Record<EraFeature, readonly T[]>>>, unsupported: ReadonlySet<EraFeature>): Set<T> {
  const out = new Set<T>();
  for (const f of unsupported) for (const v of table[f] ?? []) out.add(v);
  return out;
}

/**
 * The client-code rules that differ by era: facts of each era's executable,
 * not of its DATs (MOVE.combination-sweep era research). End of retail and the
 * classic eras run the end-of-retail acclient.exe; 1999 its own client.exe.
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
}

const EOR_CLIENT_RULES: EraClientRules = Object.freeze({ castStopsMovement: true, attackStopsAlways: false, combatModeCheck: 'eor' as const, spellResearch: false, splitpea: false, vendorBuyOneMask: 0x0dc41cb0, appraisalText: 'eor' as const, statLineText: 'eor' as const, spellBarTabs: 8, shortcutSlots: 18, characterInfoText: 'eor' as const, spellBarArrows: 'pair' as const });
const AC1999_CLIENT_RULES: EraClientRules = Object.freeze({ castStopsMovement: false, attackStopsAlways: true, combatModeCheck: 'ac1999' as const, spellResearch: true, splitpea: true, vendorBuyOneMask: 0x14b0, appraisalText: 'ac1999' as const, statLineText: 'ac1999' as const, spellBarTabs: 1, shortcutSlots: 9, characterInfoText: 'ac1999' as const, spellBarArrows: 'ends' as const });

/** The client-code rules of era `p` (end of retail's for every era that runs its exe). */
export function eraClientRules(p: EraProfile | null | undefined): EraClientRules {
  return p?.login.protocol === 'ac1999' ? AC1999_CLIENT_RULES : EOR_CLIENT_RULES;
}

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
