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
  | 'netherDamage';

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
}

const EOR_CLIENT_RULES: EraClientRules = Object.freeze({ castStopsMovement: true, attackStopsAlways: false });
const AC1999_CLIENT_RULES: EraClientRules = Object.freeze({ castStopsMovement: false, attackStopsAlways: true });

/** The client-code rules of era `p` (end of retail's for every era that runs its exe). */
export function eraClientRules(p: EraProfile | null | undefined): EraClientRules {
  return p?.login.protocol === 'ac1999' ? AC1999_CLIENT_RULES : EOR_CLIENT_RULES;
}
