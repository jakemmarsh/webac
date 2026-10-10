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
  /** Something an imported file tested that this engine cannot (kept so the player sees it); never holds. */
  | { kind: 'unsupported'; what: string };

/** What a rule does when it fires, in order. */
export type RoutineAction =
  | { kind: 'set-state'; state: string }
  | { kind: 'cast'; spell: string; target?: 'self' | 'target' }
  | { kind: 'cast-buffs'; set: string }
  | { kind: 'use-item'; item: string; on?: 'self' | 'target' }
  | { kind: 'attack-nearest'; names?: string[]; meters?: number }
  | { kind: 'loot-nearby'; meters?: number }
  | { kind: 'follow-route'; route: string }
  | { kind: 'walk-to'; coords: string }
  | { kind: 'use-object'; name: string }
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
  | { kind: 'talk-to'; name: string }
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
  /** Something an imported file did that this engine cannot; does nothing (fails) when reached. */
  | { kind: 'unsupported'; what: string };

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

export type LootAction = 'keep' | 'keep-up-to' | 'salvage' | 'sell' | 'ignore';

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
