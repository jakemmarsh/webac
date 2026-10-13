/**
 * The automation routine document (AGENT.routine-data; docs/agent-play.md
 * "Claude as configurator"): one per account (Jake: routines are
 * per-account), holding named profiles a character runs. It is plain JSON so
 * a player's editor UI, an imported VirindiTank profile and Claude writing
 * it by hand all produce the same thing, and the routine engine reads it.
 *
 * Vocabulary follows the community's (docs/automation-and-plugins.md):
 * VTank metas are `states` of when→do `rules`; VTClassic `.utl` loot
 * profiles are ordered `loot` rules, first match wins; `.nav` routes are
 * `routes`. Everything it can make a character do is something a player
 * can do through the client (the no-cheating rule): there is no rule that
 * teleports, spawns or reads hidden data.
 */

import type { VtankProfileData } from './vtankProfile.js';

export const ROUTINE_SCHEMA_VERSION = 1;

export type Vital = 'health' | 'stamina' | 'mana';

/** A condition a rule tests. All of a rule's `when` must hold. */
export type RoutineCondition =
  | { kind: 'always' }
  | { kind: 'vital-below'; vital: Vital; percent: number }
  | { kind: 'vital-above'; vital: Vital; percent: number }
  | { kind: 'monster-within'; meters: number; names?: string[] }
  | { kind: 'no-monster-within'; meters: number; names?: string[] }
  | { kind: 'buff-missing'; spell: string }
  | { kind: 'free-slots-below'; slots: number }
  | { kind: 'item-count-below'; item: string; count: number }
  | { kind: 'burden-above'; percent: number }
  | { kind: 'chat-matches'; pattern: string }
  | { kind: 'near'; coords: string; meters: number }
  | { kind: 'seconds-in-state'; seconds: number }
  | { kind: 'unassigned-xp-above'; xp: number }
  | { kind: 'not'; condition: RoutineCondition }
  /** VirindiTank's Any / All: holds when any (all) of these hold; an empty Any never holds, an empty All always does. */
  | { kind: 'any'; conditions: RoutineCondition[] }
  | { kind: 'all'; conditions: RoutineCondition[] }
  // VirindiTank's meta conditions (AGENT.vtank-engine-support):
  /** Standing in this landblock (high 16 bits of the cell id, e.g. 0xA9B40000). */
  | { kind: 'landblock'; landblock: number }
  /** Standing in exactly this cell. */
  | { kind: 'landcell'; cell: number }
  /** Since this state began you entered portal space / arrived out of it / died. */
  | { kind: 'portal-entered' }
  | { kind: 'portal-exited' }
  | { kind: 'died' }
  | { kind: 'vendor-open' }
  | { kind: 'vendor-closed' }
  /** The loaded route (load-route) has no points left / was never loaded. */
  | { kind: 'route-done' }
  /** An enchantment you carry has at least this many seconds left (by name, or by spell id: an imported meta). */
  | { kind: 'spell-time-at-least'; spell: string; spellId?: number; seconds: number }
  /** VirindiTank's Seconds in state (P): since the state began, not reset by a pause (ours: seconds-in-state is). */
  | { kind: 'seconds-in-state-persistent'; seconds: number }
  /** VirindiTank's Monster Priority Count Within Distance: at least `count` monsters whose Monsters-tab row has exactly this priority (metaf). */
  | { kind: 'monster-priority-count'; priority: number; count: number; meters: number }
  /** VirindiTank's Dist Any Route Pt >=: the nearest point of the loaded route is at least this far. */
  | { kind: 'route-distance-at-least'; meters: number }
  /** VirindiTank's Chat Message Capture: a chat line matches; its named groups go to capturegroup_<name>. */
  | { kind: 'chat-capture'; pattern: string; colors?: number[] }
  /** At least `count` monsters whose name matches the pattern within range. */
  | { kind: 'monster-count'; pattern: string; count: number; meters: number }
  /** The macro's buff set (setting BuffSet) has a spell off or about to run out (VTank's "Need to buff"). */
  | { kind: 'need-buff' }
  /** A VirindiTank meta expression that must come out true. */
  | { kind: 'expression'; expr: string }
  // Beyond VTank, Jake 2026-10-12: neither VirindiTank nor UtilityBelt had these (an export writes them as Never).
  /** At least `count` creatures attacking you: the attack lines of the last 10 s, each placed on its creature (AgentApi.attackersOfMe). */
  | { kind: 'attackers-at-least'; count: number }
  /** A spell came at you (landed, resisted, failed to affect you) or a creature nearby spoke a spell's words, in the last `seconds` (default 5). */
  | { kind: 'being-cast-at'; seconds?: number }
  /** VTank's No Monsters Within Distance, measured from a point (`coords`) or from the nearest object named `object` instead of from you. */
  | { kind: 'no-monster-near'; meters: number; coords?: string; object?: string }
  /** Your own corpse ("Corpse of <your name>") lies within range. */
  | { kind: 'my-corpse-within'; meters: number }
  /**
   * Something an imported file tested that this engine cannot (kept so the player sees it); never holds.
   * `raw` is the VirindiTank meta condition as read (its type id and typed data), so an export writes it back.
   */
  | { kind: 'unsupported'; what: string; raw?: VtMetRaw };

/** What a rule does when it fires, in order. */
export type RoutineAction =
  | { kind: 'set-state'; state: string }
  | { kind: 'cast'; spell: string; target?: 'self' | 'target' }
  | { kind: 'cast-buffs'; set: string }
  /** Use an item you carry, on yourself, your selection, or (`to`) the nearest object of that name (UtilityBelt's /ub use X on Y). */
  | { kind: 'use-item'; item: string; on?: 'self' | 'target'; to?: string }
  | { kind: 'attack-nearest'; names?: string[]; meters?: number }
  | { kind: 'loot-nearby'; meters?: number }
  | { kind: 'follow-route'; route: string }
  | { kind: 'walk-to'; coords: string }
  /** Use an object by name. `vt`: a VirindiTank route point's record of it (vtank.ts), kept for export. */
  | { kind: 'use-object'; name: string; vt?: VtObjectRecord }
  | { kind: 'say'; text: string }
  | { kind: 'sell-by-loot-rules'; vendor: string }
  | { kind: 'wait'; seconds: number }
  /** Spend unassigned XP: one raise per entry in turn (attribute, vital or trained skill) until each reaches `upTo` or XP runs out. */
  | { kind: 'train'; plan: Array<{ stat: string; upTo: number }> }
  | { kind: 'stop' }
  /** Go to a state, remembering where to come back to (Return). */
  | { kind: 'call-state'; state: string; returnTo: string }
  | { kind: 'return' }
  /** VirindiTank's meta views: open a window of buttons from its XML (metaView.ts); close one or all. */
  | { kind: 'create-view'; name: string; xml: string }
  | { kind: 'destroy-view'; name: string }
  | { kind: 'destroy-all-views' }
  /** VirindiTank's NPC Talk: use the NPC until it says something to you (a tell), a few tries. */
  | { kind: 'talk-to'; name: string; vt?: VtObjectRecord }
  /**
   * VirindiTank's Checkpoint point (.nav type 8; /vt addnavcheckpoint): on arriving, wait until the server's
   * own echo of your position is there too, inching forward now and then; the route goes on only then.
   */
  | { kind: 'checkpoint' }
  /**
   * VirindiTank's deprecated portal point (.nav type 1): use the portal with this object id. An id is valid
   * only on the server that recorded it, so where none has it the portal standing nearest the point is used.
   */
  | { kind: 'use-portal'; id: number }
  /** Make this route the one the macro walks (VirindiTank's Embed Nav). */
  | { kind: 'load-route'; route: string }
  /** Change one of the profile's settings for this run. */
  | { kind: 'set-setting'; name: string; value: string | number | boolean }
  /** Go to `state` if you haven't moved `meters` in `seconds`. */
  | { kind: 'set-watchdog'; state: string; meters: number; seconds: number }
  | { kind: 'clear-watchdog' }
  /** Switch combat mode (peace / melee / missile / magic). */
  | { kind: 'combat-mode'; mode: 'peace' | 'melee' | 'missile' | 'magic' }
  /** Give `count` (default all) of an item you carry to someone nearby. */
  | { kind: 'give'; item: string; to: string; count?: number }
  /** Jump: face `heading` first when given; hold the key `holdMs`; run (forward) / walk (Shift) while jumping. */
  | { kind: 'jump'; heading?: number; holdMs?: number; forward?: boolean; walk?: boolean }
  /** Switch to one of the profile's loot sets (VirindiTank's /vt loot load). */
  | { kind: 'load-loot'; set: string }
  /** Evaluate a VirindiTank meta expression for its effects. */
  | { kind: 'expression'; expr: string }
  // Beyond VTank, Jake 2026-10-12: neither VirindiTank nor UtilityBelt had these (an export leaves them out, saying so).
  /**
   * Pull: attack the nearest monster whose name matches `pattern` (within `meters`, default 60) until one swing or shot
   * lands on it or it turns on you, then break off and run back to `back` (map coordinates), keeping going while hit.
   * `holdMeters` also holds position there (as hold-position).
   */
  | { kind: 'pull'; pattern: string; back: string; meters?: number; holdMeters?: number }
  /** Hold position: attack-nearest and the macro's fighting leave alone monsters more than `meters` from here (or `coords`): no chasing down a ledge. */
  | { kind: 'hold-position'; meters: number; coords?: string }
  /** Drop the hold-position anchor. */
  | { kind: 'release-position' }
  /** Loot the corpse of this name ("Corpse of Azreath Lightbringer") through the loot rules, not just a kill of yours. */
  | { kind: 'loot-corpse'; name: string; meters?: number }
  /**
   * A recall that gives up when `abortAttackers` (default 1) or more creatures are attacking you before it takes you:
   * `via` is a recall command ("/ls", "/hr", "/mp") or a recall spell's name. Aborted with a jump (retail's own way to
   * break the kneel), then a run past the server's 8 m recall-move limit.
   */
  | { kind: 'recall'; via: string; abortAttackers?: number }
  /** Run to map coordinates and keep going while hit (walk-to stops to fight back; this doesn't). */
  /** Run to `coords` without stopping when hit, then (with `portal`) use that portal, still not stopping; coords may be empty with a portal. */
  | { kind: 'flee-to'; coords: string; portal?: string }
  /** Something an imported file did that this engine cannot; does nothing (fails) when reached. `raw`: as for the condition. */
  | { kind: 'unsupported'; what: string; raw?: VtMetRaw };

/**
 * What a VirindiTank route point records about the object it uses (Use Portal/NPC, NPC Talk, Open Vendor):
 * its Decal object class (14 portal, 37 NPC, 10 container), where it stands (map units: E/W, N/S, Z), and its
 * object id (only valid on the server that recorded it). The engine finds the object by name; an export writes these back.
 */
export interface VtObjectRecord { objectClass?: number; at?: [number, number, number]; id?: number }

/** A VirindiTank meta element kept as read: its condition / action type id and its typed value (vtank.ts MetValue). */
export interface VtMetRaw { id: number; data: unknown }

export interface RoutineRule {
  /** Shown in the editor and in traces ("Low health → heal"). */
  label?: string;
  /** Switched off: never fires (imports switch off what they cannot run exactly). */
  disabled?: boolean;
  /** Why it is the way it is (an import's account of what it changed or could not carry over). */
  note?: string;
  when: RoutineCondition[];
  do: RoutineAction[];
}

export interface RoutineState {
  name: string;
  /** Checked top to bottom each step; the first rule whose `when` all hold fires. */
  rules: RoutineRule[];
}

/** read: VTClassic's Read action (4): take it, and read a scroll you can learn (docs/vtank-macro-behavior.md). */
export type LootAction = 'keep' | 'keep-up-to' | 'salvage' | 'sell' | 'read' | 'ignore';

/**
 * A VTClassic loot profile's SalvageCombine block (UTLBlock_SalvageCombine.cs; docs/vtank-formats.md §3.5):
 * which workmanships of one material may be combined into one bag. A band string is ranges separated by
 * `,` or `;`, each `a-b` or one number ("1-6, 7-8, 9, 10"); two bags combine when their workmanship falls in
 * the same range (a gap between ranges counts with the range before it).
 */
export interface SalvageCombine {
  /** The bands for any material without its own. */
  default: string;
  /** Bands by material (ACE MaterialType id, as a string key). */
  materials?: Record<string, string>;
  /** VTClassic's "value mode" per material (MaterialValueModeValues): combine a band only once its bags are worth this many pyreals together, else two bags under 100 units. */
  valueModes?: Record<string, number>;
}

export interface LootMatch {
  /** Case-insensitive regex on the item's name. */
  name?: string;
  /** Item kinds as the appraisal shows them (e.g. "Armor", "MeleeWeapon", "Gem"). */
  types?: string[];
  valueAtLeast?: number;
  valueAtMost?: number;
  burdenAtMost?: number;
  /** Case-insensitive regex that must match the appraisal text (spells, workmanship, material…). */
  appraisal?: string;
  /** Tests on the item's properties as its appraisal reports them (ACE property ids). */
  props?: PropTest[];
  /** At least `count` of the item's spells match `match` (and not `notMatch`), case-insensitive regexes. */
  spells?: { match: string; notMatch?: string; count: number };
  /**
   * Further spell tests, each of which must hold too (a VTClassic rule's second and later Spell Name Match /
   * Spell Match and Count requirements: all of a rule's requirements must match).
   */
  moreSpells?: Array<{ match: string; notMatch?: string; count: number }>;
  spellCountAtLeast?: number;
  /** The item's ObjectDescriptionFlags include all of these bits (healer 0x10000, lockpick 0x20000, book 0x100). */
  descFlags?: number;
  /**
   * Some subpalette's example colour is near this colour (VTClassic Any / Armor Type / Slot Similar Color):
   * hue within `maxHue` degrees and saturation/value within `maxSV` (Euclidean). `slots` limits which
   * subpalettes count (an armour group's slots, or one slot); `group` names the armour group it came from.
   */
  colours?: Array<{ rgb: [number, number, number]; maxHue: number; maxSV: number; slots?: number[]; group?: string }>;
  /** The item's ObjDesc subpalette at each slot is this palette (low 24 bits; VTClassic SlotExactPalette). */
  palettes?: Array<{ slot: number; palette: number }>;
  /** Sum of the item's gear ratings (PropertyInt 370–376 and 379; VTClassic ComputedItemInfo.TotalRatings) at least this. */
  totalRatingsAtLeast?: number;
  /** Damage − damage × variance (VTClassic's minimum damage) at least this. */
  minDamageAtLeast?: number;
  /** Conditions on you, not the item (VTClassic's character requirements). */
  freeSlotsAtLeast?: number;
  characterLevelAtLeast?: number;
  characterLevelAtMost?: number;
  /** By AC skill id: buffed value at least `atLeast`, and/or base value in baseMin..baseMax. */
  characterSkills?: Array<{ skill: number; atLeast?: number; baseMin?: number; baseMax?: number }>;
  /** A requirement an imported profile had that this engine cannot test: the rule never matches. */
  unsupported?: string;
}

/** One property test. `did` compares the low 24 bits (a DAT id's index, as Decal reports icons). */
export interface PropTest {
  kind: 'int' | 'float' | 'string' | 'bool' | 'did';
  key: number;
  op: 'le' | 'ge' | 'eq' | 'ne' | 'flag' | 'match';
  value: number | string;
}

export interface LootRule {
  label?: string;
  /** Switched off: never matches. */
  disabled?: boolean;
  note?: string;
  action: LootAction;
  /** For keep-up-to: how many to hold. */
  count?: number;
  /** All given fields must match. */
  match: LootMatch;
  /**
   * What the VTClassic profile had that this engine can't run, kept as written so an export
   * writes it back: the rule's action id (Read, User1–5) and the requirements behind `match.unsupported`.
   */
  vtc?: { action?: number; reqs?: Array<{ type: number; lines: string[] }> };
}

export interface BuffSet {
  name: string;
  spells: Array<{ spell: string; target?: 'self' | string }>;
  /** Recast a buff with fewer than this many seconds left. */
  rebuffBelowSeconds?: number;
}

export interface Route {
  name: string;
  /** What an import could not carry over (recall / chat / portal steps…). */
  note?: string;
  /** follow: VirindiTank's Follow route, chasing the player named in `follow` (no points). */
  mode: 'circular' | 'linear' | 'once' | 'follow';
  /** A Follow route's player, by name. */
  follow?: string;
  /** Map coordinates ("42.1N, 33.6E"), walked in order. */
  points: string[];
  /**
   * Each point's height as VirindiTank records it (map units: metres / 240), parallel to `points`;
   * null where unknown (a point recorded here). Kept so an exported .nav has its heights.
   */
  z?: Array<number | null>;
  /** What to do on arriving at a point (a VirindiTank route's recall / pause / chat / portal / vendor / jump steps). */
  stops?: Array<{ at: number; do: RoutineAction[] }>;
}

export interface RoutineProfile {
  name: string;
  description?: string;
  /** Module switches the player flips in the panel; a disabled module's rules don't fire. */
  modules: {
    buffs: boolean; vitals: boolean; combat: boolean; looting: boolean;
    navigation: boolean; inventory: boolean; service: boolean;
  };
  initialState: string;
  states: RoutineState[];
  loot: LootRule[];
  /** Other loot rule lists by name (imported VTClassic profiles); load-loot makes one the active `loot`. */
  lootSets?: Record<string, LootRule[]>;
  /**
   * The active loot's salvage-bag combining bands (a .utl's SalvageCombine block; VTank's CombineSalvage).
   * Unset: VTClassic's defaults (salvageCombine.ts SALVAGE_COMBINE_DEFAULTS).
   */
  salvageCombine?: SalvageCombine;
  /** Each loot set's SalvageCombine block, by the loot set's name; load-loot makes it the active one. */
  salvageCombineSets?: Record<string, SalvageCombine>;
  buffSets: BuffSet[];
  routes: Route[];
  /** The route the macro loads at the start (VirindiTank's Auto-Navigation profile). */
  navRoute?: string;
  /** The loot set made active at the start (VirindiTank's Looting profile); unset: `loot`. */
  lootSet?: string;
  /** VirindiTank's Monsters / Items / Consumables / Buffs tabs (vtankProfile.ts). */
  vtank?: VtankProfileData;
  /**
   * VirindiTank's macro: when no rule acts, fight (EnableCombat), loot
   * (EnableLooting), buff (EnableBuffing, set BuffSet) and walk the loaded
   * route (EnableNav), as VTank does from its settings outside the meta.
   */
  macro?: boolean;
  /**
   * 'repeat' (default): a rule fires every step its conditions hold.
   * 'once': VirindiTank's metas — a rule fires when its conditions become
   * true and again only after they have been false (or the state is
   * re-entered); 2,017 of the community metas' Always rules sit above other
   * rules, which only works this way.
   */
  ruleFiring?: 'repeat' | 'once';
  /** Settings the macro and expressions read (VTank option names: EnableCombat, AttackDistance, …). */
  settings?: Record<string, string | number | boolean>;
}

export interface RoutineDoc {
  schemaVersion: number;
  /** The account these belong to, and its server (routines are per account). */
  account: string;
  server: string;
  updatedAt: string;
  profiles: RoutineProfile[];
  /** Which profile each character starts with (character name → profile name). */
  characters?: Record<string, string>;
}

export function emptyRoutineDoc(server: string, account: string, now = new Date()): RoutineDoc {
  return { schemaVersion: ROUTINE_SCHEMA_VERSION, account, server, updatedAt: now.toISOString(), profiles: [] };
}

export const ALL_MODULES_OFF: RoutineProfile['modules'] = {
  buffs: false, vitals: false, combat: false, looting: false, navigation: false, inventory: false, service: false,
};
