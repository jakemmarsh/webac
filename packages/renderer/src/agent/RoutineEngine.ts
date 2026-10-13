/**
 * AGENT.routine-engine — runs a RoutineProfile (packages/shared/src/routines)
 * on the agent API: the first-party replacement for VirindiTank's meta
 * system (docs/automation-and-plugins.md). Every half second, while no
 * action sequence is running, the current state's rules are checked top to
 * bottom; the first whose conditions all hold runs its actions in order,
 * each through the agent API (so a routine does exactly what a player can:
 * the no-cheating rule). A disabled module's rules never fire.
 *
 * `dryRun()` answers "which rule would fire now, and why not the others"
 * without acting — how Claude (or the editor) checks a routine against the
 * live game before turning it on.
 */
import {
  itemTypeLabel, parseMetaView, SALVAGE_COMBINE_DEFAULTS, VT_DAMAGE, vtCanonicalName, vtDefaults, type MetaView, type MetaViewButton, type SalvageCombine,
  type LootRule, type PropTest, type Route, type RoutineAction, type RoutineCondition, type RoutineProfile, type RoutineRule, type VtVcsCategory,
} from '@ac/shared';
import { MAP_COORD_ORIGIN, parseMapCoords, type AgentApi, type LootDecision } from './AgentApi.ts';
import { VtMacro, vtAttackHeight } from './macro/vtMacro.ts';
import { matchMonsterRow } from './macro/combatPlan.ts';
import { autoAttackPower, powerItemsToExamine, swingElement, wieldedPair, type PowerItem } from './macro/attackPower.ts';
import { InventoryTidy } from './macro/inventoryPlan.ts';
import { findUst, planSalvageCombine, salvageRefusal } from './macro/salvagePlan.ts';
import { isRecall, nearestStart, objectAt, openDoorOnTheWay, runCheckpoint, runRecall, runUseStep, stopsAt, walksTo, type NodeCtx } from './routeNodes.ts';
import { BEING_CAST_AT_S, PULL_LAND_MS, RECALL_MOVE_M, RECALL_WAIT_MS, awayWord, holdAllows, pullLanded } from './beyondVtank.ts';
import { isCorpseDenial } from './macro/corpseBook.ts';
import { LootExtras } from './macro/lootExtras.ts';
import { propertyDumpLines, testItemLine } from './macro/lootTest.ts';
import type { AgentObservation, AgentResult } from './types.ts';

/** Live facts the conditions read that the observation doesn't carry. */
export interface RoutineFacts {
  /** Active enchantments by spell name, with seconds left. */
  activeSpells(): Array<{ spellId?: number; name: string; remaining: number }>;
  /** Free slots in the main pack. */
  freePackSlots(): number;
  /** Burden as a percent of capacity. */
  burdenPercent(): number;
  /** Count of carried items whose name matches (stacks summed). */
  itemCount(name: string): number;
  /** A skill's base and buffed values by AC skill id (loot rules' character requirements). */
  skill?(id: number): { base: number; buffed: number } | null;
}

/** Which module a rule belongs to, from what it does (a disabled module's rules don't fire). */
export function ruleModules(rule: RoutineRule): Array<keyof RoutineProfile['modules']> {
  const out = new Set<keyof RoutineProfile['modules']>();
  for (const a of rule.do) {
    if (a.kind === 'cast-buffs') out.add('buffs');
    else if (a.kind === 'attack-nearest' || a.kind === 'pull') out.add('combat');
    else if (a.kind === 'loot-nearby' || a.kind === 'loot-corpse') out.add('looting');
    else if (a.kind === 'follow-route' || a.kind === 'walk-to' || a.kind === 'checkpoint' || a.kind === 'use-portal') out.add('navigation');
    else if (a.kind === 'sell-by-loot-rules') out.add('inventory');
    else if (a.kind === 'use-item' || (a.kind === 'cast' && a.target !== 'target')) {
      if (rule.when.some((c) => c.kind === 'vital-below')) out.add('vitals');
    }
  }
  return [...out];
}

/** First loot rule that matches an item (name; value/burden/types/appraisal when known), or null. */
/** What an appraisal reports about an item: property maps by kind, and its spells' names. */
export interface ItemProps {
  int?: Record<number, number>; float?: Record<number, number>; string?: Record<number, string>; bool?: Record<number, boolean>; did?: Record<number, number>;
  spells?: string[];
}

function propHolds(t: PropTest, props: ItemProps): boolean {
  const raw = t.kind === 'did' ? props.did?.[t.key] : props[t.kind]?.[t.key];
  if (t.op === 'match') return typeof raw === 'string' && new RegExp(String(t.value), 'i').test(raw);
  if (t.kind === 'string') return t.op === 'eq' ? raw === t.value : t.op === 'ne' ? raw !== t.value : false;
  // A missing number reads 0 (as VTClassic does); a DAT id compares its low 24 bits.
  let v = typeof raw === 'boolean' ? (raw ? 1 : 0) : typeof raw === 'number' ? raw : 0;
  if (t.kind === 'did') v &= 0xffffff;
  const want = Number(t.value);
  switch (t.op) {
    case 'le': return v <= want;
    case 'ge': return v >= want;
    case 'eq': return v === want;
    case 'ne': return v !== want;
    case 'flag': return (v & want) !== 0;
    default: return false;
  }
}

/** One ObjDesc subpalette of an item, in order, with its example colour (0xRRGGBB; null until the palette is loaded). */
export interface ItemPalette { id: number; example: number | null }

/** System.Drawing.Color's hue (degrees), and VTClassic's saturation (1 − min/max) and value (max/255). */
export function vtcHsv(rgb: readonly [number, number, number]): { h: number; s: number; v: number } {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : 1 - min / max, v: max / 255 };
}

/**
 * VTClassic's similar-colour test: some subpalette (in `slots`, if given) whose example colour has a hue
 * within maxHue degrees (no wrap-around, as VTClassic) and saturation/value within maxSV. The example
 * colour of a subpalette is its palette's colour at the middle of its range — inferred from the
 * community profiles' target colours, 21 of 23 of which are exactly that colour of a real
 * clothing palette (docs/vtank-formats.md §4.11).
 */
export function colourNear(c: { rgb: [number, number, number]; maxHue: number; maxSV: number; slots?: number[] }, palettes: readonly ItemPalette[]): boolean {
  const t = vtcHsv(c.rgb);
  return palettes.some((p, i) => {
    if (c.slots && !c.slots.includes(i)) return false;
    if (p.example === null) return false;
    const e = vtcHsv([(p.example >> 16) & 255, (p.example >> 8) & 255, p.example & 255]);
    return Math.abs(e.h - t.h) <= c.maxHue && Math.hypot(e.s - t.s, e.v - t.v) <= c.maxSV;
  });
}

/** You, for loot rules with character requirements. */
export interface LootCharacter { freeSlots: number; level: number; skill(id: number): { base: number; buffed: number } | null }

export function lootRuleFor(rules: LootRule[], item: { name: string; value?: number; burden?: number; type?: string; appraisal?: string; props?: ItemProps; descFlags?: number; palettes?: ItemPalette[] }, me?: LootCharacter): LootRule | null {
  for (const r of rules) {
    const m = r.match;
    if (r.disabled || m.unsupported) continue;
    if (m.freeSlotsAtLeast !== undefined && !(me && me.freeSlots >= m.freeSlotsAtLeast)) continue;
    if (m.characterLevelAtLeast !== undefined && !(me && me.level >= m.characterLevelAtLeast)) continue;
    if (m.characterLevelAtMost !== undefined && !(me && me.level <= m.characterLevelAtMost)) continue;
    if (m.characterSkills?.some((cs) => {
      const sk = me?.skill(cs.skill);
      return !sk || (cs.atLeast !== undefined && sk.buffed < cs.atLeast) || (cs.baseMin !== undefined && sk.base < cs.baseMin) || (cs.baseMax !== undefined && sk.base > cs.baseMax);
    })) continue;
    if (m.descFlags !== undefined && ((item.descFlags ?? 0) & m.descFlags) >>> 0 !== m.descFlags >>> 0) continue;
    if (m.palettes?.some((x) => item.palettes?.[x.slot] === undefined || (item.palettes[x.slot].id & 0xffffff) !== (x.palette & 0xffffff))) continue;
    if (m.colours?.some((c) => !colourNear(c, item.palettes ?? []))) continue;
    if (m.totalRatingsAtLeast !== undefined) {
      // GearDamage … GearHealingBoost (370–376) and GearMaxHealth (379); a missing rating reads 0.
      const r = [370, 371, 372, 373, 374, 375, 376, 379].reduce((t, k) => t + (item.props?.int?.[k] ?? 0), 0);
      if (!item.props || r < m.totalRatingsAtLeast) continue;
    }
    if (m.minDamageAtLeast !== undefined) {
      const dmg = item.props?.int?.[44];
      const variance = item.props?.float?.[22] ?? 0;
      if (dmg === undefined || dmg - dmg * variance < m.minDamageAtLeast) continue;
    }
    if (m.props?.length && !(item.props && m.props.every((t) => propHolds(t, item.props!)))) continue;
    // Every spell test must hold (VTClassic: all of a rule's requirements match).
    const spellTests = m.spells ? [m.spells, ...(m.moreSpells ?? [])] : m.moreSpells ?? [];
    if (spellTests.length) {
      const names = item.props?.spells;
      if (!names) continue;
      if (!spellTests.every((t) => {
        const yes = new RegExp(t.match, 'i');
        const no = t.notMatch ? new RegExp(t.notMatch, 'i') : null;
        return names.filter((n) => yes.test(n) && !(no && no.test(n))).length >= t.count;
      })) continue;
    }
    if (m.spellCountAtLeast !== undefined && !((item.props?.spells?.length ?? -1) >= m.spellCountAtLeast)) continue;
    if (m.name && !new RegExp(m.name, 'i').test(item.name)) continue;
    // "MeleeWeapon" (ACE's enum name) and "Melee Weapon" (the appraisal's label) are the same type.
    const norm = (t: string): string => t.replace(/\s+/g, '').toLowerCase();
    if (m.types?.length && !(item.type && m.types.some((t) => norm(t) === norm(item.type!)))) continue;
    if (m.valueAtLeast !== undefined && !(item.value !== undefined && item.value >= m.valueAtLeast)) continue;
    if (m.valueAtMost !== undefined && !(item.value !== undefined && item.value <= m.valueAtMost)) continue;
    if (m.burdenAtMost !== undefined && !(item.burden !== undefined && item.burden <= m.burdenAtMost)) continue;
    if (m.appraisal && !(item.appraisal && new RegExp(m.appraisal, 'i').test(item.appraisal))) continue;
    return r;
  }
  return null;
}

/** The facts an item's examination gives the loot rules: "Value: 1,234", "Burden: 50" (or "50 Burden Units"). */
export function appraisalFacts(text: string): { value?: number; burden?: number; appraisal: string } {
  const num = (m: RegExpMatchArray | null): number | undefined => (m ? Number(m[1].replace(/,/g, '')) : undefined);
  return {
    value: num(text.match(/\bValue:\s*([\d,]+)/)),
    burden: num(text.match(/\bBurden:\s*([\d,]+)/) ?? text.match(/([\d,]+) Burden Units/)),
    appraisal: text,
  };
}

/** Whether deciding this item needs its examination: some rule on value/burden/appraisal comes before the first rule its name and type settle. */
export function needsExamination(rules: LootRule[], item: { name: string; type: string }): boolean {
  for (const r of rules) {
    const m = r.match;
    if (m.valueAtLeast !== undefined || m.valueAtMost !== undefined || m.burdenAtMost !== undefined || m.appraisal || m.props?.length || m.spells || m.moreSpells?.length || m.spellCountAtLeast !== undefined || m.minDamageAtLeast !== undefined || m.totalRatingsAtLeast !== undefined) {
      if (lootRuleFor([{ ...r, match: { name: m.name, types: m.types } }], item)) return true;
      continue;
    }
    if (lootRuleFor([r], item)) return false;
  }
  return false;
}

export interface RoutineStatus {
  running: boolean;
  /** Running but holding still until resumed (the panel's Pause). */
  paused: boolean;
  profile: string | null;
  state: string | null;
  /** The rule now acting (its label, or its index). */
  acting: string | null;
  last: string[];
  /** When the current state was entered (the engine's clock). */
  stateSince?: number;
  /** The last state change: from, to, and the rule that made it. */
  lastChange?: { from: string; to: string; rule: string | null } | null;
  /** Rules that fired and wait to re-arm (ruleFiring 'once'), as "state#index": VirindiTank's Meta tab lists them in red. */
  spent?: string[];
  /** A Force Buff round is under way. */
  forcingBuffs?: boolean;
  /** The loaded route and the point it walks to next (VirindiTank's current waypoint). */
  nav?: { route: string; point: number; done: boolean };
  /** A Follow route: whom it follows, whether they are in sight (out of sight: standing still), and the corners of their path still to run. */
  follow?: { target: string; inSight: boolean; trail: number };
}

/** What this run has done (the panel's Stats tab), since it started. */
export interface RoutineStats {
  startedAt: number | null;
  xpGained: number;
  kills: number;
  deaths: number;
  /** Items taken by a keep / keep-up-to / salvage / sell rule, and items left on corpses. */
  kept: number;
  left: number;
  sold: number;
  rebuffs: number;
  /** Milliseconds spent in each state. */
  stateTime: Record<string, number>;
}

const emptyStats = (): RoutineStats => ({ startedAt: null, xpGained: 0, kills: 0, deaths: 0, kept: 0, left: 0, sold: 0, rebuffs: 0, stateTime: {} });

const STEP_MS = 500;

/** VirindiTank's defaults for the settings the macro reads (overridden by the profile's settings, then by set-setting). */
/** The macro's starting settings: VirindiTank's defaults (vtankOptions.ts; EnableMeta is on there, see its note). */
/** A VirindiTank command line (/vt … or /vtank …), or a UtilityBelt one (/ub …): the automation window's handler runs both. */
export const VT_COMMAND = /^\s*\/(vt|vtank|ub)(\s|$)/i;

export const MACRO_DEFAULTS: Record<string, string | number | boolean> = { ...vtDefaults(), BuffSet: '' };

/** Does any rule (through Not) use this condition kind? */
function usesCondition(p: RoutineProfile, kind: RoutineCondition['kind']): boolean {
  const has = (c: RoutineCondition): boolean => c.kind === kind || (c.kind === 'not' && has(c.condition)) || ((c.kind === 'any' || c.kind === 'all') && c.conditions.some(has));
  return p.states.some((s) => s.rules.some((r) => !r.disabled && r.when.some(has)));
}

/** A profile's settings as the macro reads them: VirindiTank's defaults, then the profile's (any spelling). */
function standbySettings(p: RoutineProfile): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { ...MACRO_DEFAULTS };
  for (const [k, v] of Object.entries(p.settings ?? {})) out[vtCanonicalName(k)] = v;
  return out;
}

const truthySetting = (v: string | number | boolean | undefined): boolean => v === true || v === 1 || (typeof v === 'string' && /^(true|1|yes|on)$/i.test(v));
/** A rule whose every action found nothing to do rests this long, so the rules below it get their turn. */
export const IDLE_REST_MS = 30_000;
/** NPC Talk (VirindiTank): how long each use of the NPC waits for its tell, and when the step gives up. */
export const TALK_USE_WAIT_MS = 10_000;
export const TALK_GIVE_UP_MS = 300_000;
/** Recent kills remembered for looting (enough for a ring's or an arc's worth). */
const KILLS_KEPT = 30;
/** VTank opens corpses within arm's reach, a little over 5 m (MOSS Looting.CorpseScan CorpseOpenRangeMeters 240/48). */
export const CORPSE_OPEN_RANGE_M = 5;
/**
 * Loot Only Rare Corpses: how long before your rare's announcement its kill may be. VTank takes corpses
 * that appeared up to 5 s before it (MOSS RareAnnouncementLeadSeconds); ours times the kill, which is the
 * death's start, a few seconds before its corpse appears, so 5 s more.
 */
const RARE_LEAD_MS = 10_000;
/** A Salvage item the server didn't take after this many sends is kept (reported), not tried for ever. */
const SALVAGE_TRIES = 3;
/** How long an item waits for its appraisal (NumTimesTinkered) before it is kept unsalvaged. */
const SALVAGE_EXAMINE_MS = 10_000;
/** A bag that won't combine after this many tries is left alone (MOSS: a "bugged salvage bag" after 40). */
const COMBINE_TRIES = 40;

/**
 * VTank's next corpse (MOSS Looting.CorpseScan SelectCorpse): among those within CORPSE_OPEN_RANGE_M,
 * the one needing the least turn to face; with none that close, the nearest (the one to walk to).
 */
export function pickCorpse<T extends { dist: number; relBearing: number }>(corpses: T[]): T | undefined {
  const close = corpses.filter((c) => c.dist <= CORPSE_OPEN_RANGE_M);
  const pool = close.length ? close : corpses;
  const metric = (c: T) => (close.length ? Math.abs(c.relBearing) : c.dist);
  let best: T | undefined;
  for (const c of pool) if (!best || metric(c) < metric(best)) best = c;
  return best;
}

export class RoutineEngine {
  private profile: RoutineProfile | null = null;
  private state = '';
  private stateSince = 0;
  private busy = false;
  private acting: string | null = null;
  private log: string[] = [];
  private lastStep = -Infinity;
  private chatSeq = 0;
  private routeIndex = new Map<string, { i: number; dir: 1 | -1 }>();
  /**
   * Creatures this routine killed recently (whose corpses it may loot), newest last. `looted`: its
   * corpse was looted (or looked for and never found), so it is no longer loot to fetch.
   */
  private kills: Array<{ name: string; at: number; looted?: boolean }> = [];
  /**
   * VirindiTank's looting beyond the rules (macro/lootExtras.ts): the corpse book (whose corpse, looted,
   * refused, skipped), unknown scrolls to read and mana donors to drain.
   */
  readonly loot: LootExtras;
  /** When the latest rare of yours was announced (Loot Only Rare Corpses looks at kills around then). */
  private rareAt = -Infinity;
  private stopRequested = false;
  private paused = false;
  /** Events at or before this sequence number are already accounted for (portal / death conditions). */
  private eventMark = 0;
  /** The route the macro walks (load-route / VTank's Embed Nav). */
  private nav: { route: Route; i: number; dir: 1 | -1; done: boolean } | null = null;
  /** OpenDoors: doors left alone for a while (wouldn't open, or locked past our lockpicks). */
  private doorSkip = new Map<number, number>();
  /** The route point NavFarStopRange last held the route at (said once per point). */
  private farHeld: string | null = null;
  private callStack: string[] = [];
  /**
   * A Follow route's leader: where they have been (global metres, the
   * corners of their path still ahead of us: FollowAroundCorners), whether
   * they are in sight, and whether a leg toward them is under way.
   */
  private follow: { who: string; trail: Array<{ x: number; y: number }>; inSight: boolean; sampledAt: number; walking: 'lead' | 'corner' | null } | null = null;
  /** ruleFiring 'once': rules (state#index) that fired and wait for their conditions to turn false. */
  private spent = new Set<string>();
  /** Loot Only Rare Corpses: a rare of yours was announced and not looted yet. */
  private rarePending = false;
  private rareMark = 0;
  /** Autostack / Autocram (and UB's /ub autostack / autocram passes): one move at a time, each waiting for the server's answer. */
  private tidyRun: InventoryTidy | null = null;
  get tidy(): InventoryTidy { return (this.tidyRun ??= new InventoryTidy(this.api, this.now)); }
  /** Wielded weapons the macro asked to examine for the power bar (once each). */
  private powerAsked = new Set<number>();
  /** VirindiTank's planners, for profiles with its tabs (made on first use). */
  private vt: VtMacro | null = null;
  /** Items a Salvage loot rule took (guid → name, sends tried, when its appraisal was asked for), waiting for the Ust. */
  private toSalvage = new Map<number, { name: string; tries: number; askedAt?: number }>();
  /** The "no Ust" warning was given (again only after a Ust has come and gone). */
  private warnedNoUst = false;
  /** CombineSalvage: tries per bag, and bags given up on. */
  private combineTries = new Map<number, number>();
  private combineSkip = new Set<number>();
  /** The loot set in use (start's lootSet, then load-loot), whose SalvageCombine bands apply; null: the profile's own loot. */
  private activeLootSet: string | null = null;
  /** A death already counted (StopMacroOnDeath off holds still while dead). */
  private deadSeen = false;
  /** When the run last resumed from a pause (Seconds in State counts from it, as VTank's does from switching on). */
  private resumedAt = -Infinity;
  private watchdog: { state: string; meters: number; seconds: number; samples: Array<{ t: number; x: number; y: number }> } | null = null;
  /** hold-position's anchor (beyond VTank, Jake 2026-10-12): attack-nearest and the macro fight nothing farther than `meters` from it. */
  private hold: { x: number; y: number; meters: number } | null = null;
  private settings: Record<string, string | number | boolean> = {};
  /** The profile a dry run is checking (another one than the running profile, maybe). */
  private checking: RoutineProfile | null = null;
  /** The expression evaluator, when one is attached (VirindiTank meta expressions). */
  expressions: { test(expr: string): boolean; run(expr: string): string; setVar?(name: string, value: string): void } | null = null;
  private lastChange: { from: string; to: string; rule: string | null } | null = null;
  /** Rules (by state + index) resting after a pass where they found nothing to do, until this time. */
  private resting = new Map<string, number>();
  /** Bumped by pause/stop: an action sequence started under an older generation ends at its next step. */
  private gen = 0;
  private stats: RoutineStats = emptyStats();
  private xpAtStart = 0;
  private stateClock = 0;
  /** Where meta views open (GameUI; main.ts wires it). */
  views: {
    open(name: string, view: MetaView, click: (b: MetaViewButton) => void): void; close(name: string): void; closeAll(): void;
    /** Expressions' uigetcontrol / uisetlabel: a named control of an open view, and its button label. */
    hasControl?(view: string, control: string): boolean;
    setLabel?(view: string, control: string, text: string): boolean;
  } | null = null;

  /** A meta view's button: its actionexpr runs, then its setstate (VirindiTank's Meta_Views). */
  viewButton(b: MetaViewButton): void {
    if (!this.profile) return;
    if (b.actionexpr) { try { this.expressions?.run(b.actionexpr); } catch (e) { this.note(`view button ${b.name}: ${(e as Error).message}`); } }
    if (b.setstate && this.profile.states.some((s) => s.name === b.setstate)) this.enterState(b.setstate, `view button ${b.name}`);
  }

  /** VirindiTank's /vt commands (the window's handler; main.ts wires it). */
  onVtCommand: ((line: string) => void) | null = null;
  /** VirindiTank's /vt fakedeath: the meta's Character Death fires as if you had died. */
  fakeDeath(): AgentResult { this.api.push('death', 'fake death (/vt fakedeath)'); return { ok: true, message: 'fake death' }; }
  /**
   * Player-facing reports ("Kept Pyreals (rule: Money)"); main.ts prints them to chat as [Automation].
   * `category` is VTank's Virindi Chat System category when the line's source says it (Echo, MetaUpdates,
   * Errors, Warnings); otherwise main.ts files it under CommandLine.
   */
  onReport: ((text: string, category?: VtVcsCategory) => void) | null = null;

  constructor(private readonly api: AgentApi, private readonly facts: RoutineFacts, private readonly now: () => number) {
    this.loot = new LootExtras(api, now, (t) => this.report(t));
  }

  start(profile: RoutineProfile): AgentResult {
    // A copy: the panel's module switches change this run, not the stored document.
    this.profile = { ...profile, modules: { ...profile.modules } };
    this.state = profile.initialState;
    this.stateSince = this.now();
    this.stopRequested = false;
    this.paused = false;
    this.stats = { ...emptyStats(), startedAt: this.now() };
    this.resting.clear();
    this.stateClock = this.now();
    this.xpAtStart = this.api.snapshot({ max: 0 }).me?.xp?.total ?? 0;
    this.chatSeq = this.api.currentSeq();
    this.eventMark = this.api.currentSeq();
    this.nav = null;
    this.follow = null;
    this.callStack = [];
    this.spent.clear();
    this.deadSeen = false;
    this.resumedAt = -Infinity;
    this.rareAt = -Infinity;
    this.rarePending = false;
    this.rareMark = this.api.currentSeq();
    this.watchdog = null;
    this.hold = null;
    this.settings = { ...MACRO_DEFAULTS };
    for (const [k, v] of Object.entries(profile.settings ?? {})) this.settings[vtCanonicalName(k)] = v;
    // VirindiTank's Auto-Navigation and Looting profiles: the route and loot set it starts with.
    const navRoute = profile.navRoute ? profile.routes.find((r) => r.name === profile.navRoute) : undefined;
    this.reversed = false;
    if (navRoute) this.nav = this.loadNav(navRoute);
    this.activeLootSet = null;
    if (profile.lootSet && profile.lootSets?.[profile.lootSet]) { this.profile.loot = profile.lootSets[profile.lootSet]; this.activeLootSet = profile.lootSet; }
    this.note(`started "${profile.name}" in "${this.state}"`);
    return { ok: true, message: `running "${profile.name}" (starts in "${this.state}")` };
  }

  stop(why = 'stopped'): AgentResult {
    if (!this.profile) return { ok: false, message: 'no routine is running' };
    this.clockState();
    this.note(`${why}`);
    this.paused = false;
    this.stopRequested = true;
    const name = this.profile.name;
    // A meta's views go with the run.
    this.views?.closeAll();
    this.profile = null;
    this.api.stopMoving();
    return { ok: true, message: `stopped "${name}"` };
  }

  status(): RoutineStatus {
    return {
      running: !!this.profile, paused: !!this.profile && this.paused, profile: this.profile?.name ?? null, state: this.profile ? this.state : null,
      acting: this.acting, last: this.log.slice(-12), stateSince: this.stateSince, lastChange: this.lastChange, spent: [...this.spent], forcingBuffs: !!this.vt?.forcing,
      ...(this.nav ? { nav: { route: this.nav.route.name, point: this.nav.i, done: this.nav.done } } : {}),
      ...(this.follow && this.nav?.route.mode === 'follow' ? { follow: { target: this.follow.who, inSight: this.follow.inSight, trail: this.follow.trail.length } } : {}),
    };
  }

  /** The running profile (UtilityBelt's AutoVendor / equip / ig read its loot sets), or null. */
  get loadedProfile(): RoutineProfile | null { return this.profile; }

  /** Until when UtilityBelt holds the macro's navigation (its VTank Navigation lock: vendor, give, jump, portal). */
  private navHeldUntil = 0;
  /** UtilityBelt's navigation lock: no route walking for `ms` (0 lets go). */
  holdNav(ms: number): void { this.navHeldUntil = ms > 0 ? this.now() + ms : 0; }

  /**
   * UtilityBelt's `/ub follow` (Plugin.FollowChar): load a Follow route on this player and switch
   * navigation on, as UB loads VTank's "UBFollow" nav. Not saved in the profile.
   */
  followPlayer(name: string): AgentResult {
    if (!this.profile) return { ok: false, message: 'no routine is running (start the macro first: /vt start)' };
    this.reversed = false;
    this.nav = this.loadNav({ name: 'UBFollow', mode: 'follow', follow: name, points: [] });
    this.settings.EnableNav = true;
    return { ok: true, message: `following ${name}` };
  }

  /** Hold still (the current action finishes its step; nothing new starts) until resume(). */
  pause(): AgentResult {
    if (!this.profile) return { ok: false, message: 'no routine is running' };
    if (this.paused) return { ok: true, message: 'already paused' };
    this.paused = true;
    this.gen++;
    this.api.stopMoving();
    this.note('paused');
    return { ok: true, message: `paused "${this.profile.name}"` };
  }

  resume(): AgentResult {
    if (!this.profile) return { ok: false, message: 'no routine is running' };
    if (!this.paused) return { ok: true, message: 'already running' };
    this.paused = false;
    this.resumedAt = this.now();
    this.note('resumed');
    return { ok: true, message: `resumed "${this.profile.name}" in "${this.state}"` };
  }

  /** Go to a state now (an expression's setmetastate / VTank's /vt setmetastate). */
  goTo(state: string): void {
    const p = this.profile;
    if (!p || !p.states.some((s) => s.name === state)) return;
    void this.act({ kind: 'set-state', state }, p);
  }

  /** A line an expression prints for the player (echo): the run's log, and chat when the panel shows reports. */
  echo(text: string): void {
    this.note(`echo: ${text}`);
    this.report(text, 'Echo');
  }

  /** A setting as the macro and expressions see it (profile's, then set-setting's). */
  /** A setting by any spelling VirindiTank accepts (option names are case-insensitive). */
  setting(name: string): string | number | boolean | undefined { return this.settings[vtCanonicalName(name)]; }
  setSetting(name: string, value: string | number | boolean): void { this.settings[vtCanonicalName(name)] = value; }

  /** The whole log of this run (the editor's History), oldest first. */
  history(): string[] { return [...this.log]; }

  /** While paused: run the rule that would fire now, once (the editor's "Step one rule"). */
  stepOnce(): AgentResult {
    const p = this.profile;
    if (!p) return { ok: false, message: 'no routine is running' };
    if (!this.paused) return { ok: false, message: 'pause the routine to step it' };
    if (this.busy) return { ok: false, message: 'a rule is still acting' };
    const verdicts = this.dryRun();
    const at = verdicts.findIndex((v) => v.fires);
    if (at < 0) return { ok: true, message: 'no rule would fire now' };
    const rule = p.states.find((x) => x.name === this.state)!.rules[at];
    this.acting = verdicts[at].rule;
    this.busy = true;
    void this.run(rule.do, p, `${this.state}#${at}`).finally(() => { this.busy = false; this.acting = null; });
    return { ok: true, message: `stepping "${verdicts[at].rule}"` };
  }

  private enterState(name: string, rule: string | null): void {
    this.clockState();
    if (name !== this.state) { this.report(`→ ${name}`, 'MetaUpdates'); this.lastChange = { from: this.state, to: name, rule }; }
    this.state = name;
    this.eventMark = this.api.currentSeq();
    this.spent.clear();
    this.stateSince = this.now();
  }

  /** VirindiTank's /vt reverseroute [true|false]: walk the loaded route the other way (its stops move with their points); no argument flips it. */
  reverseRoute(on?: boolean): AgentResult {
    if (!this.nav) return { ok: false, message: 'no route loaded' };
    const r = this.nav.route;
    if (on !== undefined && on === this.reversed) return { ok: true, message: `route "${r.name}" ${on ? 'already reversed' : 'already walked forwards'}` };
    const last = r.points.length - 1;
    this.nav.route = { ...r, points: [...r.points].reverse(), ...(r.stops ? { stops: r.stops.map((st) => ({ ...st, at: last - st.at })) } : {}) };
    this.nav.i = Math.max(0, last - this.nav.i);
    this.reversed = !this.reversed;
    return { ok: true, message: `route "${r.name}" reversed` };
  }
  /** Whether /vt reverseroute has the loaded route reversed (/vt reverseroutequery). */
  reversed = false;

  /**
   * VirindiTank's current-waypoint arrow: the loaded route walks next to its
   * point nearest the character. Circular routes only, as in VTank.
   */
  setNearestWaypoint(): AgentResult {
    if (!this.nav) return { ok: false, message: 'no route loaded' };
    if (this.nav.route.mode !== 'circular') return { ok: false, message: 'the current waypoint is set on circular routes only' };
    const me = this.api.snapshot({ max: 0 }).me;
    if (!me) return { ok: false, message: 'your position is not known yet' };
    let best = -1;
    let bestD = Infinity;
    this.nav.route.points.forEach((pt, i) => {
      const g = parseMapCoords(pt);
      if (!g) return;
      const d = Math.hypot(g.x - me.pos.x, g.y - me.pos.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best < 0) return { ok: false, message: 'the route has no points' };
    this.nav.i = best;
    this.nav.done = false;
    this.note(`route "${this.nav.route.name}": next point ${best + 1}, the nearest (${Math.round(bestD)} m)`);
    return { ok: true, message: `next point ${best + 1}` };
  }

  /** VirindiTank's Force Buff / Cancel Force Buff (a profile with its tabs). */
  forceBuff(): AgentResult {
    if (!this.profile) return { ok: false, message: 'no routine is running' };
    if (!this.profile.vtank) return { ok: false, message: 'Force Buff works with the VirindiTank tabs\' buffs' };
    this.vt ??= new VtMacro(this.api, this.now);
    this.vt.forceBuff();
    this.note('force buff');
    return { ok: true, message: 'force buff: recasting every buff' };
  }
  cancelForceBuff(): AgentResult {
    this.vt?.cancelForceBuff();
    this.note('force buff cancelled');
    return { ok: true, message: 'force buff cancelled' };
  }

  /**
   * VirindiTank's "Loot this Container" hotkey (its changelog, 0.3.1.11x): the container you have open, else
   * the selected corpse or chest, looted with the profile's loot rules, as the macro loots its own corpses.
   * Paused or not, it runs as soon as the macro is between actions.
   */
  lootThis(): AgentResult {
    if (!this.profile) return { ok: false, message: 'no routine is running' };
    const guid = this.api.openContainerGuid() ?? this.api.selectedGuid();
    if (guid === null) return { ok: false, message: 'Open or select a corpse or chest first.' };
    this.lootThisGuid = guid;
    this.note(`loot this container: ${guid >>> 0}`);
    return { ok: true, message: 'looting this container' };
  }
  private lootThisGuid: number | null = null;

  /** Put the running routine in a state by hand (VirindiTank's Current State menu). */
  setState(name: string): AgentResult {
    if (!this.profile) return { ok: false, message: 'no routine is running' };
    if (!this.profile.states.some((s) => s.name === name)) return { ok: false, message: `no state "${name}"` };
    this.enterState(name, null);
    this.note(`state set to "${name}" by hand`);
    return { ok: true, message: `→ "${name}"` };
  }

  /**
   * Take the player's edits while running (VirindiTank applies every change
   * at once): the new rules, routes and loot; the run keeps its state,
   * loaded route, stats, module switches and settings (those change through
   * setSetting, as the window and the meta's Set VT Option do).
   */
  update(profile: RoutineProfile): AgentResult {
    if (!this.profile) return { ok: false, message: 'no routine is running' };
    if (profile.name !== this.profile.name) return { ok: false, message: `"${profile.name}" is not the running routine` };
    const modules = this.profile.modules;
    const before = this.profile.lootSet;
    this.profile = { ...profile, modules: { ...modules } };
    // The loot set in use stays loaded, with its edits (before 2026-10-11 an edit while running put the
    // profile's own rules back in its place); choosing another Looting profile loads that one, as VTank's dropdown does.
    const set = profile.lootSet !== before ? profile.lootSet ?? null : this.activeLootSet;
    if (set !== null && profile.lootSets?.[set]) { this.profile.loot = profile.lootSets[set]; this.activeLootSet = set; } else this.activeLootSet = null;
    if (!profile.states.some((s) => s.name === this.state)) this.enterState(profile.initialState, null);
    if (this.nav) { const r = profile.routes.find((x) => x.name === this.nav!.route.name); this.nav = r ? { ...this.nav, route: r, i: Math.min(this.nav.i, Math.max(0, r.points.length - 1)), done: this.nav.done || (r.mode !== 'follow' && r.points.length === 0) } : null; } // a Follow route has no points and never ends
    this.spent.clear();
    this.resting.clear();
    return { ok: true, message: `updated "${profile.name}"` };
  }

  /** Turn one module of the running profile on or off (this run only). */
  setModule(module: keyof RoutineProfile['modules'], on: boolean): AgentResult {
    if (!this.profile) return { ok: false, message: 'no routine is running' };
    this.profile.modules[module] = on;
    this.note(`${module} ${on ? 'on' : 'off'}`);
    return { ok: true, message: `${module} ${on ? 'on' : 'off'}` };
  }

  /** The running profile (with this run's module switches), or null. */
  current(): RoutineProfile | null { return this.profile; }

  /** What this run has done; xpGained and state times are as of now. */
  statsNow(): RoutineStats {
    this.clockState();
    const xp = this.api.snapshot({ max: 0 }).me?.xp?.total;
    return { ...this.stats, xpGained: this.stats.startedAt !== null && xp !== undefined ? Math.max(0, xp - this.xpAtStart) : this.stats.xpGained, stateTime: { ...this.stats.stateTime } };
  }

  /** Clear the counters (the Stats tab's Reset); the run goes on. */
  resetStats(): void {
    this.stats = { ...emptyStats(), startedAt: this.profile ? this.now() : null };
    this.stateClock = this.now();
    this.xpAtStart = this.api.snapshot({ max: 0 }).me?.xp?.total ?? 0;
  }

  private clockState(): void {
    if (!this.profile || this.paused) { this.stateClock = this.now(); return; }
    const t = this.now();
    this.stats.stateTime[this.state] = (this.stats.stateTime[this.state] ?? 0) + (t - this.stateClock);
    this.stateClock = t;
  }

  /** The buff set the macro keeps up (setting BuffSet), if it names one of the profile's. */
  private macroBuffSet(): RoutineProfile['buffSets'][number] | null {
    // A dry run of a profile that isn't running reads that profile's own settings.
    const p = this.checking ?? this.profile;
    const name = p && p !== this.profile ? { ...MACRO_DEFAULTS, ...(p.settings ?? {}) }.BuffSet : this.settings.BuffSet;
    return (name && p?.buffSets.find((b) => b.name === name)) || null;
  }

  /** The macro buff set's spells that are off or within its rebuff window. */
  private buffsDue(): string[] {
    const set = this.macroBuffSet();
    if (!set) return [];
    const active = this.facts.activeSpells();
    return set.spells.filter((sp) => (active.find((x) => x.name.toLowerCase() === sp.spell.toLowerCase())?.remaining ?? 0) < (set.rebuffBelowSeconds ?? 60)).map((sp) => sp.spell);
  }

  /** You, as loot rules' character requirements see you. */
  private lootCharacter(): LootCharacter {
    return {
      freeSlots: this.facts.freePackSlots(),
      level: this.api.snapshot({ max: 0 }).me?.level ?? 0,
      skill: (id) => this.facts.skill?.(id) ?? null,
    };
  }

  private report(text: string, category?: VtVcsCategory): void {
    try { this.onReport?.(text, category); } catch { /* a report never stops the routine */ }
  }

  private note(s: string): void {
    this.log.push(`${new Date().toISOString().slice(11, 19)} ${s}`);
    if (this.log.length > 60) this.log.shift();
  }

  // ── conditions ──

  /** Whether a condition holds now, and a short reason (for dry runs and traces). */
  check(c: RoutineCondition, obs: AgentObservation): { ok: boolean; why: string } {
    const me = obs.me;
    const pct = (v: { cur: number; max: number }): number => (v.max ? (v.cur / v.max) * 100 : 100);
    const monsters = (names?: string[], meters = 60) => obs.nearby.filter((o) => o.kind === 'monster' && o.dist <= meters
      && (!names?.length || names.some((n) => o.name.toLowerCase().includes(n.toLowerCase()))));
    switch (c.kind) {
      case 'always': return { ok: true, why: 'always' };
      case 'vital-below': case 'vital-above': {
        if (!me) return { ok: false, why: 'not in world' };
        const p = Math.round(pct(me[c.vital]));
        const ok = c.kind === 'vital-below' ? p < c.percent : p > c.percent;
        return { ok, why: `${c.vital} ${p}%` };
      }
      case 'monster-within': case 'no-monster-within': {
        const m = monsters(c.names, c.meters);
        const ok = c.kind === 'monster-within' ? m.length > 0 : m.length === 0;
        return { ok, why: m.length ? `${m[0].name} at ${m[0].dist} m` : `none within ${c.meters} m` };
      }
      case 'buff-missing': {
        const on = this.facts.activeSpells().find((s) => s.name.toLowerCase() === c.spell.toLowerCase());
        return { ok: !on, why: on ? `${c.spell} on (${Math.round(on.remaining)} s left)` : `${c.spell} not on` };
      }
      case 'need-buff': {
        const due = this.buffsDue();
        return { ok: due.length > 0, why: due.length ? `${due[0]} needs a rebuff` : this.macroBuffSet() ? 'buffs all up' : 'no buff set chosen' };
      }
      case 'free-slots-below': { const n = this.facts.freePackSlots(); return { ok: n < c.slots, why: `${n} free slots` }; }
      case 'item-count-below': { const n = this.facts.itemCount(c.item); return { ok: n < c.count, why: `${n} ${c.item}` }; }
      case 'burden-above': { const b = Math.round(this.facts.burdenPercent()); return { ok: b > c.percent, why: `burden ${b}%` }; }
      case 'unassigned-xp-above': { const x = me?.xp?.unassigned ?? 0; return { ok: x > c.xp, why: `${x.toLocaleString()} unassigned XP` }; }
      case 'unsupported': return { ok: false, why: `can't run: ${c.what}` };
      case 'landblock': { const cell = me ? parseInt(me.cell, 16) >>> 0 : 0; return { ok: ((cell & 0xffff0000) >>> 0) === ((c.landblock & 0xffff0000) >>> 0), why: `in 0x${(cell >>> 0).toString(16).toUpperCase()}` }; }
      case 'landcell': { const cell = me ? parseInt(me.cell, 16) >>> 0 : 0; return { ok: (cell >>> 0) === (c.cell >>> 0), why: `in 0x${(cell >>> 0).toString(16).toUpperCase()}` }; }
      case 'portal-entered': { const hit = this.api.eventsSince(this.eventMark).some((e) => e.type === 'portal' && /entered/.test(e.text)); return { ok: hit, why: hit ? 'entered portal space' : 'no portal since' }; }
      case 'portal-exited': { const hit = this.api.eventsSince(this.eventMark).some((e) => e.type === 'portal' && /arrived/.test(e.text)); return { ok: hit, why: hit ? 'came out of portal space' : 'no arrival since' }; }
      case 'died': { const hit = this.api.eventsSince(this.eventMark).some((e) => e.type === 'death'); return { ok: hit, why: hit ? 'you died' : 'no death since' }; }
      case 'vendor-open': case 'vendor-closed': { const open = this.api.vendorOpen(); return { ok: c.kind === 'vendor-open' ? open : !open, why: open ? 'a vendor is open' : 'no vendor open' }; }
      case 'route-done': { const done = !this.nav || this.nav.done; return { ok: done, why: !this.nav ? 'no route loaded' : done ? `"${this.nav.route.name}" finished` : `"${this.nav.route.name}" point ${this.nav.i + 1} of ${this.nav.route.points.length}` }; }
      case 'spell-time-at-least': {
        // By id (an imported meta) or by name; the longest-lasting layer counts.
        const label = c.spell || `spell ${c.spellId}`;
        const on = this.facts.activeSpells().filter((x) => (c.spellId ? x.spellId === c.spellId : x.name.toLowerCase() === c.spell.toLowerCase())).sort((a, b) => b.remaining - a.remaining)[0];
        const left = on ? (on.remaining < 0 ? Infinity : on.remaining) : 0;
        return { ok: left >= c.seconds, why: on ? `${label} ${on.remaining < 0 ? 'lasts' : `${Math.round(left)} s left`}` : `${label} not on` };
      }
      case 'seconds-in-state-persistent': { const s = (this.now() - this.stateSince) / 1000; return { ok: s >= c.seconds, why: `${Math.round(s)} s in "${this.state}"` }; }
      case 'monster-priority-count': {
        const rows = (this.checking ?? this.profile)?.vtank?.monsters;
        if (!rows) return { ok: false, why: 'no Monsters tab in this profile' };
        const n = obs.nearby.filter((o) => o.kind === 'monster' && !o.dying && o.dist <= c.meters && matchMonsterRow(rows, o, { settings: this.settings }).priority === c.priority).length;
        return { ok: n >= c.count, why: `${n} of priority ${c.priority} within ${c.meters} m` };
      }
      case 'route-distance-at-least': {
        if (!this.nav || !me) return { ok: false, why: !this.nav ? 'no route loaded' : 'not in world' };
        const pts = this.nav.route.points.map(parseMapCoords).filter((x): x is NonNullable<typeof x> => !!x);
        if (!pts.length) return { ok: false, why: 'the route has no points' };
        const d = Math.min(...pts.map((g) => Math.hypot(g.x - me.pos.x, g.y - me.pos.y)));
        return { ok: d >= c.meters, why: `${Math.round(d)} m from the nearest route point` };
      }
      case 'chat-capture': {
        let re: RegExp;
        try { re = new RegExp(c.pattern, 'i'); } catch { return { ok: false, why: `bad pattern /${c.pattern}/` }; }
        for (const e of this.api.eventsSince(this.chatSeq)) {
          if (e.type !== 'chat') continue;
          if (c.colors?.length && (e.chatType === undefined || !c.colors.includes(e.chatType))) continue;
          const line = e.text.replace(/^\([a-z]+\) /, '');
          const m = re.exec(line);
          if (!m) continue;
          // The first match since the last check; its named groups become capturegroup_<name> (VTank's CMC).
          // (the running routine's checks only: a dry run of another profile sets nothing)
          if (this.checking === this.profile) {
            for (const [k, v] of Object.entries(m.groups ?? {})) this.expressions?.setVar?.(`capturegroup_${k}`, v ?? '');
            if (e.chatType !== undefined) this.expressions?.setVar?.('capturecolor', String(e.chatType));
          }
          return { ok: true, why: `chat: ${line.slice(0, 60)}` };
        }
        return { ok: false, why: 'no matching chat' };
      }
      case 'monster-count': {
        let re: RegExp;
        try { re = new RegExp(c.pattern, 'i'); } catch { return { ok: false, why: `bad pattern /${c.pattern}/` }; }
        const n = obs.nearby.filter((o) => o.kind === 'monster' && o.dist <= c.meters && re.test(o.name)).length;
        return { ok: n >= c.count, why: `${n} matching within ${c.meters} m` };
      }
      // Beyond VTank, Jake 2026-10-12 (beyondVtank.ts).
      case 'attackers-at-least': {
        const att = [...this.api.attackersOfMe()];
        const names = att.map(([g]) => obs.nearby.find((o) => o.guid === g)?.name ?? `#${g.toString(16)}`);
        return { ok: att.length >= c.count, why: att.length ? `${att.length} attacking you (${names.join(', ')})` : 'nothing attacking you' };
      }
      case 'being-cast-at': {
        const secs = c.seconds ?? BEING_CAST_AT_S;
        const now = this.now();
        const hit = this.api.eventsSince(0).filter((e) => e.type === 'cast-at-you' && now - e.t <= secs * 1000).pop();
        return { ok: !!hit, why: hit ? `cast at: ${hit.text.slice(0, 60)}` : `no spell at you in ${secs} s` };
      }
      case 'no-monster-near': {
        if (!me) return { ok: false, why: 'not in world' };
        let at: { x: number; y: number } | null;
        let label: string;
        if (c.coords) { at = parseMapCoords(c.coords); label = c.coords; } else {
          const want = (c.object ?? '').toLowerCase();
          const o = obs.nearby.find((x) => x.name.toLowerCase() === want) ?? obs.nearby.find((x) => x.name.toLowerCase().includes(want));
          at = o ? objectAt(me.pos, o) : null;
          label = o ? o.name : `the ${c.object}`;
          if (!o) return { ok: false, why: `${c.object} not in sight` };
        }
        if (!at) return { ok: false, why: 'not on the landscape' };
        const m = obs.nearby.filter((o) => o.kind === 'monster' && !o.dying).map((o) => ({ o, d: Math.hypot(objectAt(me.pos, o).x - at!.x, objectAt(me.pos, o).y - at!.y) }))
          .filter((x) => x.d <= c.meters).sort((a, b) => a.d - b.d);
        return { ok: m.length === 0, why: m.length ? `${m[0].o.name} ${Math.round(m[0].d)} m from ${label}` : `none within ${c.meters} m of ${label}` };
      }
      case 'my-corpse-within': {
        if (!me) return { ok: false, why: 'not in world' };
        const mine = `corpse of ${me.name}`.toLowerCase();
        const k = obs.nearby.filter((o) => o.kind === 'corpse' && o.name.toLowerCase() === mine && o.dist <= c.meters).sort((a, b) => a.dist - b.dist)[0];
        return { ok: !!k, why: k ? `your corpse ${Math.round(k.dist)} m away` : `no corpse of yours within ${c.meters} m` };
      }
      case 'expression': {
        if (!this.expressions) return { ok: false, why: `can't run expressions yet: ${c.expr}` };
        try { const ok = this.expressions.test(c.expr); return { ok, why: `${c.expr} is ${ok}` }; } catch (e) { return { ok: false, why: `expression failed: ${(e as Error).message}` }; }
      }
      case 'chat-matches': {
        const re = new RegExp(c.pattern, 'i');
        const hit = this.api.eventsSince(this.chatSeq).find((e) => e.type === 'chat' && re.test(e.text));
        return { ok: !!hit, why: hit ? `chat: ${hit.text.slice(0, 60)}` : 'no matching chat' };
      }
      case 'near': {
        const goal = parseMapCoords(c.coords);
        if (!me || !goal) return { ok: false, why: 'not on the landscape' };
        const d = Math.hypot(goal.x - me.pos.x, goal.y - me.pos.y);
        return { ok: d <= c.meters, why: `${Math.round(d)} m from ${c.coords}` };
      }
      // VirindiTank's Seconds in State resets when the macro is switched off and on (our pause / resume).
      case 'seconds-in-state': { const s = (this.now() - Math.max(this.stateSince, this.resumedAt)) / 1000; return { ok: s >= c.seconds, why: `${Math.round(s)} s in "${this.state}"` }; }
      case 'not': {
        // Not over a check this engine can't make doesn't hold either.
        if (c.condition.kind === 'unsupported') return { ok: false, why: `can't run: not (${c.condition.what})` };
        const r = this.check(c.condition, obs);
        return { ok: !r.ok, why: `not (${r.why})` };
      }
      case 'any': {
        // An Any holds on its first branch that does; the rest are not checked.
        const whys: string[] = [];
        for (const x of c.conditions) {
          const r = this.check(x, obs);
          if (r.ok) return { ok: true, why: r.why };
          whys.push(r.why);
        }
        return { ok: false, why: c.conditions.length ? `none of (${whys.join('; ')})` : 'an empty Any never holds' };
      }
      case 'all': {
        const whys: string[] = [];
        for (const x of c.conditions) {
          const r = this.check(x, obs);
          if (!r.ok) return { ok: false, why: r.why };
          whys.push(r.why);
        }
        return { ok: true, why: whys.join('; ') || 'always' };
      }
      // A document from a newer client: a kind this one doesn't know never holds.
      default: return { ok: false, why: `unknown condition "${(c as { kind: string }).kind}"` };
    }
  }

  /**
   * The current state's rules (or, for a profile that isn't running, its
   * initial state's), each with whether it would fire and why; the first
   * `fires` is the one that runs. Acts on nothing.
   */
  dryRun(other?: RoutineProfile): Array<{ rule: string; fires: boolean; enabled: boolean; off?: boolean; why: string[] }> {
    const p = other ?? this.profile;
    if (!p) return [];
    const obs = this.api.snapshot({ max: 60, radius: 120 });
    const stateName = other && other !== this.profile ? other.initialState : this.state;
    const st = p.states.find((s) => s.name === stateName);
    const t = this.now();
    this.checking = p;
    try { return (st?.rules ?? []).map((r, i) => {
      const results = r.when.map((c) => this.check(c, obs));
      const enabled = !r.disabled && ruleModules(r).every((m) => p.modules[m]);
      const key = `${stateName}#${i}`;
      const restUntil = p === this.profile ? this.resting.get(key) ?? 0 : 0;
      const holds = results.every((x) => x.ok);
      // ruleFiring 'once': a rule that fired waits until its conditions have been false.
      if (p === this.profile && !holds) this.spent.delete(key);
      const spent = p === this.profile && p.ruleFiring === 'once' && this.spent.has(key);
      const rest = restUntil > t ? [`… found nothing to do last time; again in ${Math.ceil((restUntil - t) / 1000)} s`] : spent ? ['… fired; waits for its conditions to turn false'] : [];
      return { rule: r.label ?? `rule ${i + 1}`, fires: enabled && !rest.length && holds, enabled, ...(r.disabled ? { off: true } : {}), why: [...results.map((x) => `${x.ok ? '✓' : '✗'} ${x.why}`), ...rest] };
    }); } finally { this.checking = null; }
  }

  /**
   * The macro settings profile the player has selected while no routine runs
   * (the VirindiTank window's Macro Settings for the character in the world;
   * main.ts wires it). VTank's M. Charges When Off keeps worn items topped up
   * with it while Run Macro is off.
   */
  standby: (() => RoutineProfile | null) | null = null;

  /**
   * What the macro does while switched off (paused, stopped, or never started):
   * M. Charges When Off, VirindiTank's RefillWornMana with the Consumables
   * tab's stones and charges. Nothing else runs while off (VTank documents no
   * other upkeep; docs/vtank-macro-behavior.md §1).
   */
  private offUpkeep(p: RoutineProfile, settings: Record<string, string | number | boolean>): void {
    if (!p.vtank || !truthySetting(settings.ManaChargesWhenOff) || this.now() - this.lastStep < STEP_MS) return;
    this.lastStep = this.now();
    if (this.api.snapshot({ max: 0 }).me?.dead) return;
    this.vt ??= new VtMacro(this.api, this.now);
    const m = this.vt.manaStep(p as RoutineProfile & { vtank: NonNullable<RoutineProfile['vtank']> }, settings);
    if (m) { this.busy = true; void m.run().then((r) => this.note(`${m.label}: ${r.message.split('\n')[0]}`)).finally(() => { this.busy = false; }); }
  }

  /** Called from the agent API's tick (~10 Hz); evaluates at most every half second. */
  tick(): void {
    const p = this.profile;
    if (!p) {
      if (this.busy) return;
      // Run Macro never on, or stopped (StopMacroOnDeath): the stand-by profile's upkeep.
      const sb = this.standby?.() ?? null;
      if (sb) this.offUpkeep(sb, standbySettings(sb));
      return;
    }
    if (!this.paused) this.watchLeader(p);
    if (this.busy) return;
    if (this.lootThisGuid !== null) {
      const guid = this.lootThisGuid;
      this.lootThisGuid = null;
      const at = this.api.snapshot({ radius: 60, max: 60 }).nearby.find((o) => o.guid === guid);
      this.busy = true;
      void this.lootOne({ guid, dist: at?.dist ?? 0 }, undefined, p)
        .then((r) => this.report(`Loot this Container: ${r.message}`))
        .catch((e) => this.note(`error: ${String((e as Error)?.message ?? e)}`))
        .finally(() => { this.busy = false; });
      return;
    }
    if (this.paused) { this.offUpkeep(p, this.settings); return; }
    const t = this.now();
    if (t - this.lastStep < STEP_MS) return;
    this.lastStep = t;
    const me = this.api.snapshot({ max: 0 }).me;
    if (me?.dead) {
      // A routine with its own death rules (VTank's "Character death") handles it; otherwise stop.
      if (!usesCondition(p, 'died')) {
        // StopMacroOnDeath (VTank, on by default): stop; off: hold still until you're back.
        if (!this.deadSeen) { this.deadSeen = true; this.stats.deaths++; }
        if (truthySetting(this.settings.StopMacroOnDeath)) {
          this.report(`You died: stopped "${p.name}"`, 'Errors');
          this.stop('stopped: you died');
        }
        return;
      }
    }
    if (me && !me.dead) this.deadSeen = false;
    if (this.watchdog && me) {
      const g = parseMapCoords(me.coords ?? '');
      if (g) {
        const w = this.watchdog;
        w.samples.push({ t, x: g.x, y: g.y });
        while (w.samples.length && t - w.samples[0].t > w.seconds * 1000) w.samples.shift();
        const first = w.samples[0];
        if (first && t - first.t >= w.seconds * 1000 - STEP_MS && Math.hypot(g.x - first.x, g.y - first.y) < w.meters) {
          const target = w.state;
          this.watchdog = null;
          this.note(`watchdog: no ${w.meters} m in ${w.seconds} s → "${target}"`);
          void this.act({ kind: 'set-state', state: target }, p);
          return;
        }
      }
    }
    // Enable Meta off (VirindiTank): the rules don't run; the macro still does.
    if (!truthySetting(this.settings.EnableMeta)) { if (p.macro) this.macroStep(p); else this.lootUpkeep(p); return; }
    const verdicts = this.dryRun();
    const at = verdicts.findIndex((v) => v.fires);
    // No rule acting: the macro, or (a rules-only profile) the loot's salvaging.
    if (at < 0) { if (p.macro) this.macroStep(p); else this.lootUpkeep(p); return; }
    const rule = p.states.find((s) => s.name === this.state)!.rules[at];
    const key = `${this.state}#${at}`;
    if (p.ruleFiring === 'once') this.spent.add(key);
    this.acting = verdicts[at].rule;
    this.busy = true;
    this.chatSeq = this.api.currentSeq();
    this.eventMark = this.api.currentSeq();
    void this.run(rule.do, p, key).catch((e) => this.note(`error: ${String((e as Error)?.message ?? e)}`)).finally(() => { this.busy = false; this.acting = null; });
  }

  /**
   * VirindiTank's macro, when no rule acts: fight what's within Monster
   * Range, run toward what's within Approach (with navigation on), loot once
   * the area is clear (first, with Boost Loot Priority), keep the buffs up,
   * walk the loaded route (before fighting, with Boost Nav. Priority), and
   * drop to peace when there's nothing to do (Peace Mode When Idle).
   */
  private macroStep(p: RoutineProfile): void {
    const st = this.settings;
    const range = Math.max(0, Number(st.AttackDistance) || 0);
    const approach = Math.max(0, Number(st.ApproachDistance) || 0);
    const reach = this.corpseReach();
    const obs = this.api.snapshot({ radius: Math.max(range, approach, reach, 20), max: 30 });
    const combat = truthySetting(st.EnableCombat) && p.modules.combat;
    const looting = truthySetting(st.EnableLooting) && p.modules.looting;
    const navOn = truthySetting(st.EnableNav) && p.modules.navigation && !!this.nav && !this.nav.done && this.now() >= this.navHeldUntil;
    const monsters = obs.nearby.filter((o) => o.kind === 'monster' && !o.dying && (!this.hold || !obs.me || holdAllows(this.hold, obs.me.pos, o)));
    const inRange = combat && monsters.some((o) => o.dist <= range);
    const near = combat && truthySetting(st.EnableNav) && approach > range ? monsters.filter((o) => o.dist > range && o.dist <= approach).sort((a, b) => a.dist - b.dist)[0] : undefined;
    if (navOn && truthySetting(st.NavPriorityBoost)) { void this.walkNav(); return; }
    const steps: RoutineAction[] = [];
    // Loot Only Rare Corpses: only after the server's "<you> has discovered the <rare>!" (ACE Corpse.EnterWorld).
    const myName = obs.me?.name;
    for (const e of this.api.eventsSince(this.rareMark)) {
      this.rareMark = Math.max(this.rareMark, e.seq);
      if (myName && e.type === 'chat' && e.text.replace(/^\([a-z]+\) /, '').startsWith(`${myName} has discovered the `)) { this.rarePending = true; this.rareAt = this.now(); }
    }
    // A kill is loot to fetch until its own corpse is looted (one try per corpse), so every kill of a ring or arc gets looted;
    // with LootFellowCorpses / LootAllCorpses, so is another's corpse once VTank may take it (corpseBook.ts).
    if (looting) this.loot.book.observe(obs.nearby.filter((o) => o.kind === 'corpse').map((o) => o.guid), this.now(), this.loot.settings(st));
    const lootDue = looting && (truthySetting(st.LootOnlyRareCorpses) ? this.rarePending : this.killsToLoot().length > 0 || this.othersDue(obs.nearby, reach));
    // A profile with VirindiTank's tabs: its planners decide recharge, combat and buffs (vtMacro.ts).
    if (p.vtank) {
      this.vt ??= new VtMacro(this.api, this.now);
      this.vt.allowTarget = (o) => this.holdOk(o);
      for (const name of this.vt.kills()) { this.kills.push({ name, at: this.now() }); this.kills = this.kills.slice(-KILLS_KEPT); this.stats.kills++; }
      // A corpse of ours waiting and nothing in range: only recharging comes before the loot (buffs wait for idle);
      // with Boost Loot Priority it comes first outright.
      if (lootDue && truthySetting(st.LootPriorityBoost) && !inRange) { /* loot first, below */ } else {
        const step = this.vt.decide(p as RoutineProfile & { vtank: NonNullable<RoutineProfile['vtank']> }, st, { combat, buffing: truthySetting(st.EnableBuffing) && p.modules.buffs && !(lootDue && !inRange), idle: !inRange && !lootDue });
        if (step) {
          this.acting = step.label;
          this.busy = true;
          void step.run().then((r) => this.note(`${step.label}: ${r.message.split('\n')[0]}`)).catch((e) => this.note(`${step.label}: ${String((e as Error)?.message ?? e)}`)).finally(() => { this.busy = false; this.acting = null; });
          return;
        }
      }
      // Salvage (the Salvage loot action, then CombineSalvage) before the next corpse, as VTank's loot pass does.
      if (!inRange && this.lootUpkeep(p)) return;
      if (lootDue && !inRange) steps.push({ kind: 'loot-nearby', meters: reach });
      else if (!inRange && !near && (truthySetting(st.AutoStack) || truthySetting(st.AutoCram))) {
        // Enable Autostack / Autocram: one pack tidy-up at a time when nothing else is to do; the next waits for the server's answer.
        const t = this.tidy.step({ autostack: truthySetting(st.AutoStack), autocram: truthySetting(st.AutoCram) });
        if (t.text) this.note(t.text);
        if (t.kind === 'moved' || t.kind === 'abandoned') return;
      }
      if (steps.length) { /* loot below */ } else if (near) {
        this.acting = `approach ${near.name}`;
        this.busy = true;
        void this.api.walkTo(near.guid, { within: Math.max(1, range - 0.5), timeoutMs: 30_000 }).finally(() => { this.busy = false; this.acting = null; });
        return;
      }
      if (!steps.length && navOn) { void this.walkNav(); return; }
      if (!steps.length) {
        // VTank's last rules: RandomHelperBuffs, then Peace Mode When Idle (through the macro's mode gate).
        const vp = p as RoutineProfile & { vtank: NonNullable<RoutineProfile['vtank']> };
        const last = (p.modules.buffs ? this.vt.helperStep(vp, st) : null) ?? (truthySetting(st.IdlePeaceMode) ? this.vt.peaceStep(vp, st) : null);
        if (last) {
          this.acting = last.label;
          this.busy = true;
          void last.run().then((r) => this.note(`${last.label}: ${r.message.split('\n')[0]}`)).catch((e) => this.note(`${last.label}: ${String((e as Error)?.message ?? e)}`)).finally(() => { this.busy = false; this.acting = null; });
        }
        return;
      }
      this.acting = 'macro';
      this.busy = true;
      const looting3 = steps.some((x) => x.kind === 'loot-nearby');
      void this.run(steps, p).finally(() => { if (looting3) this.rarePending = false; this.busy = false; this.acting = null; });
      return;
    }
    if (inRange) {
      if (lootDue && truthySetting(st.LootPriorityBoost)) steps.push({ kind: 'loot-nearby', meters: reach });
      steps.push({ kind: 'attack-nearest', meters: range });
    } else if (near) {
      // Approach: run at it until it is within Monster Range.
      this.acting = `approach ${near.name}`;
      this.busy = true;
      void this.api.walkTo(near.guid, { within: Math.max(1, range - 0.5), timeoutMs: 30_000 }).then((r) => this.note(`approach ${near.name}: ${r.message.split('\n')[0]}`)).finally(() => { this.busy = false; this.acting = null; });
      return;
    } else if (this.lootUpkeep(p)) {
      return;
    } else if (lootDue) {
      steps.push({ kind: 'loot-nearby', meters: reach });
    } else if (truthySetting(st.EnableBuffing) && p.modules.buffs && this.buffsDue().length) {
      steps.push({ kind: 'cast-buffs', set: this.macroBuffSet()!.name });
    }
    if (!steps.length && navOn) { void this.walkNav(); return; }
    if (!steps.length) {
      const mode = obs.me?.combatMode;
      if (truthySetting(st.IdlePeaceMode) && mode && mode !== 'peace' && mode !== 'unknown') void this.act({ kind: 'combat-mode', mode: 'peace' }, p);
      return;
    }
    this.acting = 'macro';
    this.busy = true;
    const looting2 = steps.some((x) => x.kind === 'loot-nearby');
    void this.run(steps, p).finally(() => { if (looting2) this.rarePending = false; this.busy = false; this.acting = null; });
  }

  /**
   * How far the macro goes for a corpse (VTank, MOSS CorpseApproach): arm's reach (CORPSE_OPEN_RANGE_M), or out to
   * CorpseApproachRange-Max when that is further (the Options tab's Approach box sets it too: vtLinkedSettings).
   */
  private corpseReach(): number {
    return Math.max(CORPSE_OPEN_RANGE_M, Number(this.settings['CorpseApproachRange-Max']) || 0);
  }

  /** LootFellowCorpses / LootAllCorpses: some corpse within reach still to look at, or that VTank may take now. */
  private othersDue(nearby: ReadonlyArray<{ guid: number; kind: string; dist: number }>, reach: number): boolean {
    const bs = this.loot.settings(this.settings);
    if (!bs.lootAll && !bs.lootFellow) return false;
    const me = this.api.snapshot({ max: 0 }).me?.name ?? '';
    const ctx = { me, fellows: this.loot.fellows(), settings: bs, now: this.now() };
    return nearby.some((o) => o.kind === 'corpse' && o.dist <= reach && !this.loot.book.skipped(o.guid, ctx.now, bs)
      && (this.loot.book.needsDescription(o.guid) || this.loot.book.mayLoot(o.guid, ctx) === true));
  }

  /**
   * Between corpses, VTank's loot pass: read an unknown scroll it took, drain a donor into a stone (lootExtras.ts),
   * then salvage. Only with looting on (the macro's Enable Looting too). True when it started a step.
   */
  private lootUpkeep(p: RoutineProfile): boolean {
    if (p.modules.looting && !(p.macro && !truthySetting(this.settings.EnableLooting))) {
      const step = this.loot.step(p.vtank?.consumables ?? [], this.settings);
      if (step) {
        this.busy = true;
        this.acting = step.label;
        void step.run().then((r) => this.note(`${step.label}: ${r.message.split('\n')[0]}`)).catch((e) => this.note(`${step.label}: ${String((e as Error)?.message ?? e)}`)).finally(() => { this.busy = false; this.acting = null; });
        return true;
      }
    }
    return this.salvageUpkeep(p);
  }

  /**
   * VirindiTank's /vt testitem: what the loot rules would do with the selected item were it on a corpse
   * (examining it first, quietly, for rules that need its properties). `rules`: the window's loot rules; else the run's.
   */
  async testItem(rules?: LootRule[]): Promise<string[]> {
    const g = this.api.selectedGuid();
    if (g === null) return ['TestItem: select an item first.'];
    const carried = this.api.inventory().find((i) => i.guid === g);
    const o = this.api.snapshot({ max: 60, radius: 200 }).nearby.find((x) => x.guid === g);
    const name = carried?.name ?? o?.name;
    if (!name) return ['TestItem: select an item first.'];
    const r = await this.api.appraise(g, { quiet: true });
    const facts = r.ok ? { ...appraisalFacts(r.message), ...(r.data ? { props: r.data as ItemProps } : {}) } : {};
    const type = carried?.type ?? (carried?.itemType !== undefined ? itemTypeLabel(carried.itemType) : undefined);
    const rule = lootRuleFor(rules ?? this.profile?.loot ?? [], { name, ...(type ? { type } : {}), ...(carried?.value !== undefined ? { value: carried.value } : {}), ...(carried?.burden !== undefined ? { burden: carried.burden } : {}), palettes: this.api.itemPalettes(g), ...facts }, this.lootCharacter());
    return [testItemLine(name, rule && rule.action !== 'ignore' ? { action: rule.action, rule: rule.label ?? rule.action } : null)];
  }

  /** VirindiTank's /vt propertydump: the selected item's raw properties, as its examination gave them. */
  async propertyDump(): Promise<string[]> {
    const g = this.api.selectedGuid();
    if (g === null) return ['propertydump: select something first.'];
    const r = await this.api.appraise(g, { quiet: true });
    const name = this.api.inventory().find((i) => i.guid === g)?.name ?? this.api.snapshot({ max: 60, radius: 200 }).nearby.find((x) => x.guid === g)?.name ?? `#${g.toString(16)}`;
    if (!r.ok) return [`propertydump: ${r.message}`];
    return propertyDumpLines(name, (r.data ?? this.api.itemData(g)) as ItemProps | null);
  }

  /** The SalvageCombine bands in use: the loaded loot set's, else the profile's own, else VTClassic's defaults. */
  private salvageBands(p: RoutineProfile): SalvageCombine {
    if (this.activeLootSet !== null) return p.salvageCombineSets?.[this.activeLootSet] ?? SALVAGE_COMBINE_DEFAULTS;
    return p.salvageCombine ?? SALVAGE_COMBINE_DEFAULTS;
  }

  /**
   * VirindiTank's salvaging, with looting on, between corpses (docs/vtank-parity-gaps.md §3.1;
   * macro/salvagePlan.ts): first each item a Salvage rule took goes into the Ust, one at a time, through
   * the salvage panel's own action (never a tinkered, retained or worn one; a missing Ust is said once);
   * then, with CombineSalvage, partial bags of one material in one workmanship band are combined. Only
   * where the era can salvage (none in 1999: EraFeatures). True when it started a step (the engine is busy).
   */
  private salvageUpkeep(p: RoutineProfile): boolean {
    // Looting on: the module, and for the macro its Enable Looting (a rules-only profile loots by its rules' loot-nearby).
    if (!p.modules.looting || (p.macro && !truthySetting(this.settings.EnableLooting))) return false;
    if (!this.api.canSalvage()) { this.toSalvage.clear(); return false; }
    const inv = this.api.inventory();
    const carried = new Map(inv.map((i) => [i.guid, i]));
    for (const g of [...this.toSalvage.keys()]) if (!carried.has(g)) this.toSalvage.delete(g);
    const ust = findUst(inv.map((i) => ({ ...i, equipped: i.where === 'equipped' })));
    if (this.toSalvage.size) {
      if (!ust) {
        if (!this.warnedNoUst) { this.warnedNoUst = true; this.report('No Ust in your inventory: items marked for salvage are kept until you carry one.', 'Warnings'); this.note('salvage: waiting for a Ust'); }
      } else {
        this.warnedNoUst = false;
        for (const [g, m] of this.toSalvage) {
          const item = { ...carried.get(g)!, equipped: carried.get(g)!.where === 'equipped' };
          // Whether it was tinkered (or retained) is in its appraisal: look first, quietly.
          const props = this.api.itemData(g);
          if (!props) {
            if (m.askedAt === undefined) { m.askedAt = this.now(); void this.api.appraise(g, { quiet: true }); return false; }
            if (this.now() - m.askedAt < SALVAGE_EXAMINE_MS) return false;
          }
          const why = props ? salvageRefusal(item, props) : 'its appraisal never came';
          if (why) { this.toSalvage.delete(g); this.report(`Kept ${m.name} unsalvaged: ${why}`, 'Warnings'); this.note(`salvage: kept ${m.name}: ${why}`); continue; }
          this.busy = true;
          this.acting = `salvage ${m.name}`;
          void this.api.salvage(ust.guid, [g]).then((r) => {
            this.note(`salvage ${m.name}: ${r.message}`);
            if (r.ok) { this.toSalvage.delete(g); this.report(`Salvaged ${m.name}`); return; }
            if (++m.tries >= SALVAGE_TRIES) { this.toSalvage.delete(g); this.report(`Kept ${m.name} unsalvaged: ${r.message}`, 'Warnings'); }
          }).finally(() => { this.busy = false; this.acting = null; });
          return true;
        }
      }
    }
    if (!ust || !truthySetting(this.settings.CombineSalvage)) return false;
    const plan = planSalvageCombine(inv.map((i) => ({ ...i, equipped: i.where === 'equipped' })), this.salvageBands(p), this.combineSkip);
    if (!plan) return false;
    this.busy = true;
    this.acting = 'combine salvage';
    void this.api.salvage(ust.guid, plan.guids).then((r) => {
      this.note(`combine salvage (${plan.names.join(', ')}): ${r.message}`);
      if (r.ok) { for (const g of plan.guids) this.combineTries.delete(g); return; }
      const first = plan.guids[0];
      const n = (this.combineTries.get(first) ?? 0) + 1;
      this.combineTries.set(first, n);
      if (n >= COMBINE_TRIES) { this.combineSkip.add(first); this.combineTries.delete(first); this.note(`combine salvage: gave up on ${plan.names[0]}`); }
    }).finally(() => { this.busy = false; this.acting = null; });
    return true;
  }

  /**
   * Kills whose corpse is still to loot: the last two minutes', not looted yet. With Loot Only Rare
   * Corpses, only those around your latest rare announcement (VTank describes corpses that appeared
   * from RARE_LEAD_MS before it; MOSS Looting.CorpseScan).
   */
  private killsToLoot(): Array<{ name: string; at: number; looted?: boolean }> {
    const rareOnly = truthySetting(this.settings.LootOnlyRareCorpses);
    return this.kills.filter((k) => !k.looted && this.now() - k.at < 120_000 && (!rareOnly || k.at >= this.rareAt - RARE_LEAD_MS));
  }

  /**
   * The macro's power bar for a swing at `m` (VirindiTank's AutoAttackPower / UseRecklessness,
   * attackPower.ts): the element its Monsters-tab row wants, the wielded weapon's examination.
   */
  private macroAttackPower(p: RoutineProfile, m: { guid: number; name: string; dist: number; relBearing: number }): number | 'bar' {
    const items: PowerItem[] = this.api.inventory().filter((i) => i.where === 'equipped').map((i) => {
      const d = this.api.itemData(i.guid);
      return { guid: i.guid, name: i.name, equipped: true, ...(i.slot ? { slot: i.slot } : {}), ...(i.itemType ? { itemType: i.itemType } : {}), ...(d ? { ints: d.int } : {}) };
    });
    for (const i of powerItemsToExamine(items)) if (!this.powerAsked.has(i.guid)) { this.powerAsked.add(i.guid); void this.api.appraise(i.guid, { quiet: true }); }
    const damage = p.vtank ? matchMonsterRow(p.vtank.monsters, m, { settings: this.settings })?.damage ?? VT_DAMAGE.Auto : VT_DAMAGE.Auto;
    return autoAttackPower({ element: swingElement(damage, wieldedPair(items).weapon), items, settings: this.settings, skills: this.api.skillList() });
  }

  /**
   * A route as the macro starts it (VirindiTank, at Run Macro and at a route load): circular and linear
   * routes start at the point nearest you that you could be at; a once route at its head.
   */
  private loadNav(route: Route): { route: Route; i: number; dir: 1 | -1; done: boolean } {
    const me = this.api.snapshot({ max: 0 }).me;
    const i = me && route.points.length ? nearestStart(route, me.pos) : 0;
    if (i) this.note(`route "${route.name}" starts at point ${i + 1}, the nearest`);
    return { route, i, dir: 1, done: route.mode !== 'follow' && route.points.length === 0 };
  }

  /** What the route steps need from the engine (routeNodes.ts). */
  private nodeCtx(p: RoutineProfile): NodeCtx {
    const gen = this.gen;
    return { api: this.api, now: this.now, sleep, alive: () => this.profile === p && !this.stopRequested && this.gen === gen };
  }

  /**
   * One visit to a route point, as VirindiTank makes it: a plain point or a checkpoint is walked to (first
   * past any door on the way, with OpenDoors; not at all while it is beyond NavFarStopRange); then its
   * steps run where you are, waiting for what they start (a recall's or portal's trip, an NPC's reply,
   * the server confirming a checkpoint). `advance`: the route moves on (false: this point again next time).
   */
  private async visitPoint(route: Route, i: number, within: number): Promise<{ advance: boolean; ok: boolean; message: string }> {
    const p = this.profile;
    if (!p) return { advance: false, ok: false, message: 'stopped' };
    const pt = route.points[i];
    const st = this.settings;
    if (walksTo(route, i)) {
      const g = parseMapCoords(pt);
      const me = this.api.snapshot({ max: 0 }).me;
      if (g && me) {
        // NavFarStopRange: a point this far off is no leg to walk (VTank stops navigating until you're nearer).
        const far = Number(st.NavFarStopRange);
        const d = Math.hypot(g.x - me.pos.x, g.y - me.pos.y);
        if (Number.isFinite(far) && far > 0 && d > far) {
          const key = `${route.name}#${i}`;
          if (this.farHeld !== key) { this.farHeld = key; this.report(`Navigation: point ${i + 1} of "${route.name}" is ${Math.round(d)} m away, past NavFarStopRange (${Math.round(far)} m); holding`, 'Warnings'); }
          await sleep(1000);
          return { advance: false, ok: false, message: `${Math.round(d)} m off, past NavFarStopRange` };
        }
        this.farHeld = null;
        if (truthySetting(st.OpenDoors)) {
          const h = route.z?.length === route.points.length ? route.z[i] : null;
          const door = await openDoorOnTheWay(this.nodeCtx(p), { ...g, ...(typeof h === 'number' ? { dz: h * 240 - me.pos.z } : {}) }, {
            idRange: Math.max(0, Number(st.DoorIDRange) || 0), openRange: Math.max(0.5, Number(st.DoorOpenRange) || 0),
            threshold: Number(st.DoorLockpickDiffExcessThreshold) || 0, consumables: p.vtank?.consumables ?? [], skip: this.doorSkip,
          });
          if (door) { this.note(`route "${route.name}" point ${i + 1}: door: ${door.message}`); if (door.ok === false && /locked door skipped/.test(door.message)) this.report(door.message); }
        }
      }
      const r = await this.api.walkTo(pt, { within, timeoutMs: 90_000 });
      const said = r.message.split('\n')[0];
      this.note(`route "${route.name}" point ${i + 1}: ${said}`);
      // As before: a walk that didn't get there moves on without the point's steps.
      if (!r.ok || !stopsAt(route, i).length) return { advance: true, ok: r.ok, message: said };
    }
    return this.runStops(route, i, within);
  }

  /** A route point's stops (recall, pause, say, use a portal/NPC/vendor, jump), in order. */
  private async runStops(route: Route, i: number, within: number): Promise<{ advance: boolean; ok: boolean; message: string }> {
    const p = this.profile;
    if (!p) return { advance: false, ok: false, message: 'stopped' };
    let last = 'done';
    let ok = true;
    for (const a of stopsAt(route, i)) {
      if (this.profile !== p) return { advance: false, ok: false, message: 'stopped' };
      const ctx = this.nodeCtx(p);
      // The steps that wait for what they start (routeNodes.ts); the rest run as a rule's would.
      const r = a.kind === 'checkpoint' ? await runCheckpoint(ctx, route.points[i], within)
        : a.kind === 'cast' && a.target !== 'target' && isRecall(a.spell) ? await runRecall(ctx, a.spell)
        : a.kind === 'use-object' || a.kind === 'use-portal' ? await runUseStep(ctx, a, { point: route.points[i], usePortalDistance: Number(this.settings.UsePortalDistance) || 4 })
        : await this.act(a, p);
      if (!r) continue;
      // A use's reply follows on indented lines ("used X:\n  X tells you …"): keep it on the one history line.
      last = `${a.kind}: ${r.message.replace(/:?\n\s*/g, (m) => (m.startsWith(':') ? ': ' : '; ')).trim()}`;
      ok &&= r.ok;
      this.note(`route "${route.name}" point ${i + 1}: ${last}`);
      // A checkpoint the server hasn't confirmed holds the route at this point.
      if (a.kind === 'checkpoint' && !r.ok) return { advance: false, ok: false, message: last };
    }
    return { advance: true, ok, message: last };
  }

  /**
   * A Follow route's leader, every FOLLOW_SAMPLE_MS while navigation runs:
   * record where they are (the corners of their path, for
   * FollowAroundCorners), and when they go out of sight, stop moving and
   * say so (status().follow.inSight) until they are back.
   */
  private watchLeader(p: RoutineProfile, now = false): void {
    const n = this.nav;
    if (!n || n.route.mode !== 'follow' || !n.route.follow || !truthySetting(this.settings.EnableNav) || !p.modules.navigation) { this.follow = null; return; }
    if (this.follow && this.follow.who !== n.route.follow) this.follow = null;
    const f = (this.follow ??= { who: n.route.follow, trail: [], inSight: true, sampledAt: -Infinity, walking: null });
    const t = this.now();
    if (!now && t - f.sampledAt < FOLLOW_SAMPLE_MS) return;
    f.sampledAt = t;
    const obs = this.api.snapshot({ radius: FOLLOW_SIGHT_M, max: 100 });
    const lead = findLeader(obs.nearby, f.who);
    if (!lead || !obs.me) {
      if (f.inSight) {
        f.inSight = false;
        f.trail = [];
        this.report(`Follow: ${f.who} is out of sight; standing still`, 'Warnings');
      }
      if (f.walking) { f.walking = null; this.api.stopMoving(); }
      return;
    }
    if (!f.inSight) { f.inSight = true; this.note(`Follow: ${f.who} is in sight again`); }
    addTrailPoint(f.trail, leaderAt(obs.me.pos, lead), obs.me.pos);
    // Running straight at them and they turned a corner: end that leg, so the next one runs their path.
    if (f.walking === 'lead' && f.trail.length > 1 && truthySetting(this.settings.FollowAroundCorners)) { f.walking = null; this.api.stopMoving(); }
  }

  /** One point of the loaded route; circular loops, linear turns back, once ends (route-done). */
  private async walkNav(): Promise<void> {
    const n = this.nav!;
    this.acting = `route "${n.route.name}"`;
    this.busy = true;
    if (n.route.mode === 'follow') {
      // VirindiTank's Follow route: keep within Follow/Nav Min of the leader; it never finishes. With
      // FollowAroundCorners (on by default) it runs the leader's own path, corner by corner; off, straight at them.
      try {
        const within = Math.max(0.5, Number(this.settings.NavCloseStopRange) || 2);
        const p = this.profile;
        if (p) this.watchLeader(p, true);
        const f = this.follow;
        const obs = this.api.snapshot({ radius: FOLLOW_SIGHT_M, max: 100 });
        const lead = f?.inSight ? findLeader(obs.nearby, f.who) : undefined;
        // Out of sight: stand still (watchLeader stopped us and said so) until they come back.
        if (!f || !lead || !obs.me) { await sleep(1000); return; }
        const me = obs.me.pos;
        if (lead.dist <= within) { f.trail = [leaderAt(me, lead)]; await sleep(500); return; }
        // NavFarStopRange: a leader this far off isn't followed (VTank holds until they are nearer).
        const far = Number(this.settings.NavFarStopRange);
        if (Number.isFinite(far) && far > 0 && lead.dist > far) { await sleep(1000); return; }
        // A corner reached, or just passed (a few metres off and nearer the next corner than it is): on to the next one.
        const d = (u: { x: number; y: number }, v: { x: number; y: number }): number => Math.hypot(u.x - v.x, u.y - v.y);
        while (f.trail.length > 1 && (d(f.trail[0], me) <= FOLLOW_CORNER_M || (d(f.trail[0], me) <= 3 && d(me, f.trail[1]) < d(f.trail[0], f.trail[1])))) f.trail.shift();
        if (truthySetting(this.settings.FollowAroundCorners) && f.trail.length > 1) {
          f.walking = 'corner';
          const corner = f.trail[0];
          await this.api.walkTo(mapCoordsText(corner), { within: FOLLOW_CORNER_M, timeoutMs: 15_000 });
          // Reached it, or couldn't: the next leg goes on to the next corner either way.
          if (this.follow === f && f.inSight && f.trail[0] === corner) f.trail.shift();
        } else {
          f.walking = 'lead';
          await this.api.walkTo(lead.guid, { within, timeoutMs: 15_000 });
        }
      } finally { if (this.follow) this.follow.walking = null; this.busy = false; this.acting = null; }
      return;
    }
    try {
      // Follow/Nav Min (NavCloseStopRange): how near a waypoint counts as reaching it.
      const within = Math.max(0.5, Number(this.settings.NavCloseStopRange) || 2);
      const route = n.route, at = n.i;
      const v = await this.visitPoint(route, at, within);
      // Held (a checkpoint not yet confirmed, a point past NavFarStopRange), or the route changed meanwhile.
      if (!v.advance || this.nav !== n || n.route !== route) return;
      const last = n.route.points.length - 1;
      if (n.route.mode === 'once') { if (n.i >= last) n.done = true; else n.i++; }
      else if (n.route.mode === 'circular') n.i = n.i >= last ? 0 : n.i + 1;
      else { if (n.i + n.dir > last || n.i + n.dir < 0) n.dir = (-n.dir) as 1 | -1; n.i = Math.max(0, Math.min(last, n.i + n.dir)); }
    } finally {
      this.busy = false;
      this.acting = null;
    }
  }

  private async run(actions: RoutineAction[], p: RoutineProfile, key?: string): Promise<void> {
    const gen = this.gen;
    let idle = true;
    for (const a of actions) {
      if (this.stopRequested || this.profile !== p || this.gen !== gen) return;
      const r = await this.act(a, p);
      if (r) this.note(`${a.kind}: ${r.message.split('\n')[0]}`);
      if (!r?.idle) idle = false;
      if (a.kind === 'set-state' || a.kind === 'stop') return;
    }
    // Every action found nothing to do (a met training plan, no corpse of ours, buffs all up):
    // firing it again at once would starve the rules below it.
    if (idle && key) { this.resting.set(key, this.now() + IDLE_REST_MS); this.note(`resting "${this.acting ?? key}" ${IDLE_REST_MS / 1000} s (nothing to do)`); }
  }

  private async waitDone(types: string[], ms: number): Promise<void> {
    await this.api.waitFor({ types: types as never }, ms);
  }

  /**
   * Loot one corpse or chest with the profile's loot rules: the macro walks to it first, each item goes
   * through the rules, and the corpse book learns how it went. The macro's looting and VirindiTank's
   * "Loot this Container" hotkey (lootThis) both come here.
   */
  private async lootOne(corpse: { guid: number; dist: number }, kill: { looted?: boolean } | undefined, p: RoutineProfile): Promise<AgentResult> {
    const st = this.settings;
    const bs = this.loot.settings(st);
    const book = this.loot.book;
    const now = () => this.now();
    // The macro walks to within CorpseApproachRange-Min first, then opens it (MOSS CorpseApproach).
    if (p.macro) {
      const min = Math.max(0.5, Number(st['CorpseApproachRange-Min']) || 0);
      if (corpse.dist > min) await this.api.walkTo(corpse.guid, { within: min, timeoutMs: 30_000 });
    }
    // Each item goes through the loot rules, first match wins. A rule on value, burden or appraisal
    // text examines the item first (an Appraise, as a player would); name- and type-only rules don't.
    // No rule, or ignore: an unknown scroll you can learn, or a mana stone / donor (lootExtras.ts), else
    // left on the corpse. Salvage is taken (to salvage later), as VTank does.
    const examined = new Map<number, (ReturnType<typeof appraisalFacts> & { props?: ItemProps; at?: number }) | 'pending'>();
    const askedAt = new Map<number, number>();
    const me = this.lootCharacter();
    const paletteWaits = new Map<number, number>();
    const needsColours = p.loot.some((r) => !r.disabled && r.match.colours?.length);
    const consumables = p.vtank?.consumables ?? [];
    // CorpseItemIDTimeoutSeconds: how long an item's examination is waited for (asked again while it lasts).
    const idTimeout = Math.max(1, Number(st.CorpseItemIDTimeoutSeconds) || 60) * 1000;
    this.loot.beginPass();
    // A rule that leaves the item (none, or Leave) still lets the scroll and mana checks have it (MOSS Looting: NoLoot falls through).
    const takes = (r: LootRule | null): boolean => !!r && r.action !== 'ignore';
    const decide = (it: { guid: number; name: string; itemType: number; objectDescFlags: number; palettes: ItemPalette[]; uiEffects?: number }): LootDecision => {
      const item = { name: it.name, type: itemTypeLabel(it.itemType), descFlags: it.objectDescFlags, palettes: it.palettes };
      const view = { guid: it.guid, name: it.name, itemType: it.itemType, descFlags: it.objectDescFlags, ...(it.uiEffects !== undefined ? { uiEffects: it.uiEffects } : {}) };
      // Colour rules need the item's palettes loaded (streamed builds fetch them on demand); wait up to ~5 s.
      if (needsColours && it.palettes.some((x) => x.example === null) && (paletteWaits.get(it.guid) ?? 0) < 10) {
        paletteWaits.set(it.guid, (paletteWaits.get(it.guid) ?? 0) + 1);
        return 'wait';
      }
      let facts = examined.get(it.guid);
      if (facts === undefined && (needsExamination(p.loot, item) || (!takes(lootRuleFor(p.loot, item, me)) && this.loot.needsLook(view, consumables, st)))) {
        examined.set(it.guid, 'pending');
        if (!askedAt.has(it.guid)) askedAt.set(it.guid, this.now());
        void this.api.appraise(it.guid, { quiet: true }).then((r) => {
          if (r.ok) examined.set(it.guid, { ...appraisalFacts(r.message), ...(r.data ? { props: r.data as ItemProps } : {}) });
          // No answer: asked again until the ID timeout runs out, then decided without it.
          else if (this.now() - (askedAt.get(it.guid) ?? 0) < idTimeout) examined.delete(it.guid);
          else examined.set(it.guid, { appraisal: '' });
        });
        return 'wait';
      }
      if (facts === 'pending') return 'wait';
      const rule = lootRuleFor(p.loot, { ...item, ...(facts ?? {}) }, me);
      if (!rule || rule.action === 'ignore') {
        const extra = this.loot.itemAction(view, (facts as { props?: ItemProps } | undefined)?.props, consumables, st);
        if (!extra) { this.stats.left++; return 'skip'; }
        this.stats.kept++;
        this.report(`${extra === 'read' ? 'Took to read' : extra === 'stone' ? 'Kept' : 'Took for its mana'} ${it.name} (${extra === 'read' ? 'an unknown scroll' : extra === 'stone' ? 'a mana stone' : 'a mana donor'})`);
        return 'take';
      }
      if (rule.action === 'keep-up-to') {
        const held = this.api.inventory().filter((i) => lootRuleFor([rule], { name: i.name, type: i.type, value: i.value, burden: i.burden }))
          .reduce((t, i) => t + (i.stack ?? 1), 0);
        if (held >= (rule.count ?? 1)) { this.stats.left++; return 'skip'; }
      }
      this.stats.kept++;
      this.report(`${rule.action === 'sell' ? 'Took to sell' : rule.action === 'salvage' ? 'Took to salvage' : rule.action === 'read' ? 'Took to read' : 'Kept'} ${it.name} (rule: ${rule.label ?? rule.action})`);
      // VTank salvages what a Salvage rule took once no corpse is open (salvageUpkeep); a Read rule's scroll is read later.
      if (rule.action === 'salvage') this.toSalvage.set(it.guid, { name: it.name, tries: 0 });
      if (rule.action === 'read') this.loot.readTaken(view, (facts as { props?: ItemProps } | undefined)?.props);
      return 'take';
    };
    // VTank's corpse timings (CorpseOpenTimeoutSeconds, CorpseItemAppearanceTimeoutSeconds, CorpseLootItemMaxAttempts)
    // for the macro; a rule's loot keeps the agent's own. Either way the corpse is closed when done.
    const opts = p.macro ? {
      openTimeoutMs: Math.max(250, (Number(st.CorpseOpenTimeoutSeconds) || 1.5) * 1000),
      appearMs: Math.min(300, Math.max(0, Number(st.CorpseItemAppearanceTimeoutSeconds) || 0)) * 1000,
      itemTries: Math.min(100, Math.max(1, Math.round(Number(st.CorpseLootItemMaxAttempts) || 20))),
      close: true,
    } : { close: true };
    const since = this.api.currentSeq();
    const r = await this.api.loot(corpse.guid, null, decide, opts);
    // Refused by the server ("in use", "no right"): skipped for 10 s, then tried again.
    if (this.api.eventsSince(since).some((e) => e.type === 'chat' && isCorpseDenial(e.text.replace(/^\([a-z]+\) /, '')))) {
      book.denied(corpse.guid, now(), bs);
      return { ...r, message: `${r.message}; refused, skipping it for 10 s` };
    }
    // Never opened: an attempt; after BlacklistCorpseOpenAttemptCount it is skipped for BlacklistCorpseOpenTimeoutSeconds.
    if (!r.ok && /never opened/.test(r.message)) {
      if (book.openFailed(corpse.guid, now(), bs)) {
        if (kill) kill.looted = true;
        return { ...r, message: `${r.message}; skipping it for ${bs.blacklistSeconds} s` };
      }
      return r;
    }
    book.complete(corpse.guid, now());
    if (kill) kill.looted = true;
    return r;
  }

  /** Whether a monster stands within the held position's range (always, with none held). */
  private holdOk(o: { dist: number; bearing: number }): boolean {
    const me = this.api.snapshot({ max: 0 }).me;
    return !this.hold || !me || holdAllows(this.hold, me.pos, o);
  }

  /**
   * pull (beyond VTank, Jake 2026-10-12): one attack order on the nearest match, broken off as soon as a swing or shot
   * lands on it (a chat line naming it) or it turns on you, then a run back to the fallback point that keeps going while
   * hit. A plain attack, as the attack button sends: the server walks a melee character in and a missile one shoots.
   */
  private async pull(a: Extract<RoutineAction, { kind: 'pull' }>): Promise<AgentResult> {
    let re: RegExp;
    try { re = new RegExp(a.pattern, 'i'); } catch { return { ok: false, message: `bad pattern /${a.pattern}/` }; }
    const m = this.api.snapshot({ radius: a.meters ?? 60, max: 60 }).nearby.find((o) => o.kind === 'monster' && !o.dying && re.test(o.name));
    if (!m) return { ok: false, message: `nothing matching /${a.pattern}/ within ${a.meters ?? 60} m`, idle: true };
    const since = this.api.currentSeq();
    const r = this.api.attack(m.guid);
    if (!r.ok) return r;
    const t0 = this.now();
    let landed: string | null = null;
    while (this.now() - t0 < PULL_LAND_MS && !this.stopRequested) {
      landed = pullLanded(m, this.api.eventsSince(since), this.api.attackersOfMe());
      if (landed) break;
      await this.api.waitFor({ types: ['chat', 'attacked', 'target-died', 'target-lost', 'death'] as never }, 500);
    }
    this.api.stopAttacking();
    if (!landed) return { ok: false, message: `${m.name}: no swing or shot landed in ${PULL_LAND_MS / 1000} s; not pulled` };
    const back = await this.api.walkTo(a.back, { within: 2, timeoutMs: 120_000, flee: true });
    if (a.holdMeters) { const at = parseMapCoords(a.back); if (at) this.hold = { x: at.x, y: at.y, meters: a.holdMeters }; }
    return { ok: back.ok, message: `pulled ${m.name} (${landed}); back to ${a.back}: ${back.message.split('\n')[0]}` };
  }

  /**
   * recall (beyond VTank, Jake 2026-10-12): a recall command or spell that gives up when abortAttackers or more creatures
   * are on you before it takes you. Retail breaks the kneel with a jump (CMotionInterp::LeaveGround →
   * RemoveLinkAnimations); ACE cancels a recall when you end it more than 8 m from where it began
   * (Player_Location.RecallMoveThreshold), so the jump is followed by a run that far from the attackers.
   */
  private async recall(a: Extract<RoutineAction, { kind: 'recall' }>): Promise<AgentResult> {
    const limit = a.abortAttackers ?? 1;
    const count = () => this.api.attackersOfMe().size;
    if (count() >= limit) return { ok: false, message: `not recalling: ${count()} creature(s) attacking you` };
    const mark = this.api.currentSeq();
    const command = a.via.trim().startsWith('/');
    this.api.stopMoving();
    // A spell's cast resolves when it lands or fails; a failure (fizzle, no such spell) is the recall's answer.
    const cast: { r: AgentResult | null } = { r: null };
    if (command) { const r = this.api.say(a.via.trim()); if (!r.ok) return r; } else void this.api.cast(/^\d+$/.test(a.via.trim()) ? Number(a.via) : a.via.trim(), 'self').then((r) => { cast.r = r; });
    const t0 = this.now();
    const entered = () => this.api.status().screen === 'portal-space' || this.api.eventsSince(mark).some((e) => e.type === 'portal' && /entered/.test(e.text));
    while (this.now() - t0 < RECALL_WAIT_MS && !this.stopRequested) {
      if (entered()) {
        await this.api.waitFor({ types: ['portal'] as never }, 30_000);
        return { ok: true, message: `recalled (${a.via})` };
      }
      const n = count();
      if (n >= limit) {
        // The client's own abort: a jump cuts the kneel; then far enough that the server cancels it too.
        this.api.jump();
        const seen = this.api.snapshot({ radius: 80, max: 60 }).nearby;
        const away = awayWord([...this.api.attackersOfMe().keys()].map((g) => seen.find((o) => o.guid === g)).filter((o): o is NonNullable<typeof o> => !!o));
        await sleep(400);
        const run = away ? await this.api.walkTo(`${RECALL_MOVE_M}m ${away}`, { within: 1, timeoutMs: 15_000, flee: true }) : null;
        return { ok: false, message: `recall aborted: ${n} creature(s) attacking you${run ? `; ran ${away}: ${run.message.split('\n')[0]}` : ''}` };
      }
      if (cast.r && !cast.r.ok && !entered()) return cast.r;
      await this.api.waitFor({ types: ['portal', 'attacked', 'attackers-up'] as never }, 250);
    }
    return { ok: false, message: `${a.via}: no portal space in ${RECALL_WAIT_MS / 1000} s` };
  }

  private async act(a: RoutineAction, p: RoutineProfile): Promise<AgentResult | null> {
    switch (a.kind) {
      case 'set-state':
        this.enterState(a.state, this.acting);
        return { ok: true, message: `→ "${a.state}"` };
      case 'stop': this.stop('stopped by its own rule'); return null;
      // A spell by name, or by id (imported VTank recall steps carry the id).
      case 'cast': return this.api.cast(/^\d+$/.test(a.spell.trim()) ? Number(a.spell) : a.spell, a.target === 'target' ? null : 'self');
      case 'cast-buffs': {
        const set = p.buffSets.find((b) => b.name === a.set);
        if (!set) return { ok: false, message: `no buff set "${a.set}"` };
        const active = this.facts.activeSpells();
        const due = set.spells.filter((s) => {
          const on = active.find((x) => x.name.toLowerCase() === s.spell.toLowerCase());
          return !on || on.remaining < (set.rebuffBelowSeconds ?? 60);
        });
        let cast = 0;
        for (const s of due) {
          const r = await this.api.cast(s.spell, s.target && s.target !== 'self' ? s.target : 'self');
          if (!r.ok) { if (cast) this.report(`Rebuffed ${cast} of ${due.length} spells (set: ${set.name}); ${r.message}`); return r; }
          cast++;
          await sleep(3500); // a cast's wind-up and recovery
        }
        if (cast) { this.stats.rebuffs++; this.report(`Rebuffed ${cast} of ${due.length} spells (set: ${set.name})`); }
        return { ok: true, message: due.length ? `cast ${due.map((d) => d.spell).join(', ')}` : 'buffs all up', ...(due.length ? {} : { idle: true }) };
      }
      case 'use-item': return this.api.useOn(a.item, a.to ?? (a.on === 'target' ? this.api.targetName() : 'self'));
      case 'attack-nearest': {
        const obs = this.api.snapshot({ radius: a.meters ?? 60, max: 30 });
        // A VirindiTank Monsters row with priority -1 means leave that one alone, whoever asks.
        const ignored = (o: { guid: number; name: string; dist: number; relBearing: number }) => !!p.vtank && matchMonsterRow(p.vtank.monsters, o, { settings: this.settings }).priority < 0;
        const m = obs.nearby.find((o) => o.kind === 'monster' && !o.dying && !ignored(o) && this.holdOk(o) && (!a.names?.length || a.names.some((n) => o.name.toLowerCase().includes(n.toLowerCase()))));
        if (!m) return { ok: false, message: this.hold ? `no monster in reach within ${this.hold.meters} m of the held position` : 'no monster in reach' };
        const since = this.api.currentSeq();
        const r = this.api.attack(m.guid, p.macro ? { height: vtAttackHeight(this.settings), power: this.macroAttackPower(p, m) } : {});
        if (!r.ok) return r;
        if (!this.hold) await this.waitDone(['target-died', 'target-lost', 'death'], 120_000);
        else {
          // Holding position: the fight is watched, and broken off once the target goes past the anchor's range (no chase down a ledge).
          const t0 = this.now();
          while (this.now() - t0 < 120_000) {
            const ev = await this.api.waitFor({ types: ['target-died', 'target-lost', 'death'] as never }, 500);
            if (ev.length) break;
            const o = this.api.snapshot({ radius: 120, max: 60 }).nearby.find((x) => x.guid === m.guid);
            if (o && !o.dying && this.hold && !this.holdOk(o)) {
              this.api.stopAttacking();
              return { ok: false, message: `${m.name} went past the held position's ${this.hold.meters} m: left it` };
            }
          }
        }
        const end = this.api.eventsSince(since).find((e) => (e.type === 'target-died' || e.type === 'target-lost' || e.type === 'death') && (e.type === 'death' || e.guid === m.guid));
        if (end?.type === 'target-died') { this.kills.push({ name: m.name, at: this.now() }); this.kills = this.kills.slice(-KILLS_KEPT); this.stats.kills++; }
        return { ok: end?.type === 'target-died', message: end?.type === 'target-died' ? `killed ${m.name}` : end?.type === 'target-lost' ? `${m.name} got away` : end?.type === 'death' ? 'you died' : `fight with ${m.name} went on too long` };
      }
      case 'loot-nearby': {
        // Corpses of what this routine killed in the last two minutes (by the kill, and by the corpse's own
        // "Killed by …" once it is examined: never a stranger's kill of the same name), and with
        // LootFellowCorpses / LootAllCorpses the others VTank may take (corpseBook.ts). One corpse per step, each
        // once (a ring's or arc's kills each get theirs; the macro re-decides between corpses, as VTank's pass
        // does). VTank's pick (MOSS Looting.CorpseScan): within arm's reach (CORPSE_OPEN_RANGE_M) the least turn to
        // face it, else the nearest. The corpse appears a second or two after the death starts, so a fresh kill
        // waits up to 5 s for it.
        const st = this.settings;
        const bs = this.loot.settings(st);
        const book = this.loot.book;
        const now = () => this.now();
        const pending = this.killsToLoot();
        const others = (bs.lootAll || bs.lootFellow) && !truthySetting(st.LootOnlyRareCorpses);
        if (!pending.length && !others) return { ok: true, message: 'nothing of ours to loot', idle: true };
        const meName = this.api.snapshot({ max: 0 }).me?.name ?? '';
        const ctx = () => ({ me: meName, fellows: this.loot.fellows(), settings: bs, now: now() });
        const wanted = new Set(pending.map((k) => `Corpse of ${k.name}`));
        const look = () => this.api.snapshot({ radius: a.meters ?? 20, max: 30 }).nearby
          .filter((o) => o.kind === 'corpse' && !book.skipped(o.guid, now(), bs) && (wanted.has(o.name) || others));
        let cands = look();
        for (let w = 0; pending.length && !cands.some((c) => wanted.has(c.name)) && w < 10; w++) { await sleep(500); cands = look(); }
        book.observe(cands.map((c) => c.guid), now(), bs);
        // Each one not yet described is examined (one look this pass; VTank asks every corpse as it appears).
        for (const c of cands) if (book.needsDescription(c.guid)) await this.loot.describe(c.guid, st);
        const c0 = ctx();
        // Described: VTank's CanLoot. Not described (no answer): your own kill's by name, as before.
        const lootable = cands.filter((c) => { const may = book.mayLoot(c.guid, c0); return may === true || (may === undefined && wanted.has(c.name)); });
        const corpse = pickCorpse(lootable);
        // None of ours turned up: those kills are done (one look per kill, not two minutes of looks).
        if (!corpse) { for (const k of pending) k.looted = true; return { ok: true, message: pending.length ? `no corpse of ours within ${Math.round(a.meters ?? 20)} m${a.meters !== undefined && p.macro ? ' (VTank walks to corpses only as far as CorpseApproachRange-Max, the Approach box; 0 never walks)' : ''}` : 'no corpse to loot yet', idle: true }; }
        const kill = pending.find((k) => `Corpse of ${k.name}` === corpse.name && (book.killer(corpse.guid) === undefined || book.isOwn(corpse.guid, meName)));
        return this.lootOne(corpse, kill, p);
      }
      case 'follow-route': {
        const route = p.routes.find((r) => r.name === a.route);
        if (!route) return { ok: false, message: `no route "${a.route}"` };
        const pos = this.routeIndex.get(route.name) ?? { i: 0, dir: 1 as const };
        const v = await this.visitPoint(route, pos.i, 3);
        const r: AgentResult = { ok: v.ok, message: `point ${pos.i + 1}: ${v.message}` };
        if (!v.advance) return r;
        let next = pos.i + pos.dir;
        let dir = pos.dir;
        if (next >= route.points.length) { if (route.mode === 'circular') next = 0; else if (route.mode === 'linear') { dir = -1; next = Math.max(0, route.points.length - 2); } else next = route.points.length - 1; }
        if (next < 0) { dir = 1; next = Math.min(1, route.points.length - 1); }
        this.routeIndex.set(route.name, { i: next, dir });
        return r;
      }
      case 'walk-to': return this.api.walkTo(a.coords, { within: 3, timeoutMs: 120_000 });
      // Beyond VTank, Jake 2026-10-12 (beyondVtank.ts; docs/automation-vtank-window.md).
      case 'flee-to': {
        // Through a portal too (acjs-1b, 2026-10-12): AgentApi.use with flee keeps walking to it through hits.
        if (a.coords) {
          const r = await this.api.walkTo(a.coords, { within: 3, timeoutMs: 120_000, flee: true });
          if (!r.ok || !a.portal) return r;
        }
        return a.portal ? this.api.use(a.portal, { flee: true }) : { ok: false, message: 'flee-to needs coords or a portal' };
      }
      case 'hold-position': {
        const me = this.api.snapshot({ max: 0 }).me;
        const at = a.coords ? parseMapCoords(a.coords) : me ? { x: me.pos.x, y: me.pos.y } : null;
        if (!at) return { ok: false, message: a.coords ? `can't read ${a.coords}` : 'your position is not known yet' };
        this.hold = { x: at.x, y: at.y, meters: a.meters };
        return { ok: true, message: `holding position: nothing fought more than ${a.meters} m from ${a.coords ?? 'here'}` };
      }
      case 'release-position': this.hold = null; return { ok: true, message: 'position released' };
      case 'pull': return this.pull(a);
      case 'loot-corpse': {
        const want = a.name.trim().toLowerCase();
        const c = this.api.snapshot({ radius: a.meters ?? 40, max: 60 }).nearby.filter((o) => o.kind === 'corpse' && o.name.toLowerCase() === want).sort((x, y) => x.dist - y.dist)[0];
        if (!c) return { ok: true, message: `no ${a.name} within ${a.meters ?? 40} m`, idle: true };
        return this.lootOne(c, undefined, p);
      }
      case 'recall': return this.recall(a);
      case 'use-object': return this.api.use(a.name);
      // Route steps (a rule running one has no point): the portal by id or nearest you; a checkpoint where you stand.
      case 'use-portal': return runUseStep(this.nodeCtx(p), a, { point: null, usePortalDistance: Number(this.settings.UsePortalDistance) || 4 });
      case 'checkpoint': { const me = this.api.snapshot({ max: 0 }).me; return me ? runCheckpoint(this.nodeCtx(p), mapCoordsText(me.pos), Math.max(0.5, Number(this.settings.NavCloseStopRange) || 2)) : { ok: false, message: 'your position is not known yet' }; }
      case 'create-view': {
        const v = parseMetaView(a.xml);
        if (!v) return { ok: false, message: `view "${a.name}" has no <view>` };
        if (!this.views) return { ok: false, message: 'views need the game window' };
        this.views.open(a.name, v, (b) => this.viewButton(b));
        return { ok: true, message: `view "${a.name}" open` };
      }
      case 'destroy-view': this.views?.close(a.name); return { ok: true, message: `view "${a.name}" closed` };
      case 'destroy-all-views': this.views?.closeAll(); return { ok: true, message: 'views closed' };
      case 'talk-to': {
        // VirindiTank's NPC Talk: use the NPC until a tell comes back from it (each use waits
        // TALK_USE_WAIT_MS for it). A safety limit (TALK_GIVE_UP_MS) ends it, and says so.
        const started = this.now();
        const tell = `^\\(tell\\) ${a.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} tells you`;
        for (let uses = 1; ; uses++) {
          if (this.profile !== p || this.stopRequested) return null;
          const since = this.api.currentSeq();
          const r = await this.api.use(a.name);
          if (!r.ok) return r;
          const said = await this.api.waitFor({ types: ['chat'], chatMatch: tell, sinceSeq: since }, TALK_USE_WAIT_MS);
          if (said.length) return { ok: true, message: `${a.name} answered${uses > 1 ? ` (after ${uses} uses)` : ''}` };
          if (this.now() - started >= TALK_GIVE_UP_MS) {
            const why = `${a.name} didn't answer in ${Math.round((this.now() - started) / 1000)} s (${uses} uses); NPC Talk gave up`;
            this.report(why, 'Warnings');
            return { ok: false, message: why };
          }
        }
      }
      // A rule's Chat Command that is VirindiTank's own (/vt …) goes to its command handler, not the server.
      case 'say': if (VT_COMMAND.test(a.text) && this.onVtCommand) { this.onVtCommand(a.text); return { ok: true, message: a.text }; } return this.api.say(a.text);
      case 'combat-mode': return this.api.combatMode(a.mode);
      case 'give': return this.api.give(a.item, a.to, a.count ?? null);
      case 'sell-by-loot-rules': {
        // No vendor named: the window already open (UtilityBelt's /ub autovendor).
        if (a.vendor) { const opened = await this.api.use(a.vendor); if (!opened.ok) return opened; }
        else if (!this.api.vendorOpen()) return { ok: false, message: 'no vendor window is open', idle: true };
        const me = this.lootCharacter();
        const sells = this.api.inventory().filter((it) => lootRuleFor(p.loot, { name: it.name, value: it.value, burden: it.burden, palettes: this.api.itemPalettes(it.guid) }, me)?.action === 'sell');
        const sold: string[] = [];
        for (const it of sells) { const r = await this.api.sell(it.guid, null); if (r.ok) sold.push(it.name); }
        this.stats.sold += sold.length;
        if (sold.length) this.report(`Sold ${sold.length} item${sold.length > 1 ? 's' : ''} to ${a.vendor}`);
        return { ok: true, message: sold.length ? `sold ${sold.join(', ')}` : 'nothing to sell', ...(sold.length ? {} : { idle: true }) };
      }
      case 'wait': await sleep(a.seconds * 1000); return { ok: true, message: `waited ${a.seconds} s` };
      case 'unsupported': return { ok: false, message: `can't run: ${a.what}` };
      case 'call-state':
        this.callStack.push(a.returnTo);
        return this.act({ kind: 'set-state', state: a.state }, p);
      case 'return': {
        const back = this.callStack.pop();
        if (!back) return { ok: false, message: 'nothing to return to' };
        return this.act({ kind: 'set-state', state: back }, p);
      }
      case 'load-route': {
        const route = p.routes.find((r) => r.name === a.route);
        if (!route) return { ok: false, message: `no route "${a.route}"` };
        this.reversed = false;
        this.nav = this.loadNav(route);
        return { ok: true, message: `loaded route "${route.name}" (${route.points.length} points${this.nav.i ? `; starts at point ${this.nav.i + 1}, the nearest` : ''})` };
      }
      case 'set-setting': this.settings[a.name] = a.value; return { ok: true, message: `${a.name} = ${String(a.value)}` };
      case 'set-watchdog': this.watchdog = { state: a.state, meters: a.meters, seconds: a.seconds, samples: [] }; return { ok: true, message: `watchdog: "${a.state}" if still for ${a.seconds} s` };
      case 'clear-watchdog': this.watchdog = null; return { ok: true, message: 'watchdog cleared' };
      case 'jump': {
        if (a.heading !== undefined) { this.api.turn(a.heading); await sleep(400); }
        const r = this.api.jump({ holdMs: a.holdMs, forward: a.forward, walk: a.walk });
        await sleep((a.holdMs ?? 350) + 900); // the jump's flight
        return r;
      }
      case 'load-loot': {
        const set = p.lootSets?.[a.set];
        if (!set) return { ok: false, message: `no loot set "${a.set}"` };
        p.loot = set;
        this.activeLootSet = a.set;
        return { ok: true, message: `loot set "${a.set}" (${set.length} rules)` };
      }
      case 'expression': {
        if (!this.expressions) return { ok: false, message: `can't run expressions yet: ${a.expr}` };
        try { return { ok: true, message: `${a.expr} → ${this.expressions.run(a.expr)}` }; } catch (e) { return { ok: false, message: `expression failed: ${(e as Error).message}` }; }
      }
      case 'train': {
        // Round-robin, one raise per entry per pass, so the XP spreads over the plan instead of draining into its first line.
        const raised = new Map<string, { name: string; from: number; to: number; n: number }>();
        const done = new Set<number>();
        let spent = 0;
        let stop = '';
        for (let pass = 0; pass < 500 && done.size < a.plan.length; pass++) {
          a.plan.forEach((e, i) => {
            if (done.has(i)) return;
            const r = this.api.raiseOnce(e.stat, e.upTo);
            if (!r.ok) { done.add(i); if (!r.reached) stop = r.message; return; }
            spent += r.cost;
            const prev = raised.get(r.name);
            raised.set(r.name, { name: r.name, from: prev?.from ?? r.from, to: r.to, n: (prev?.n ?? 0) + 1 });
          });
        }
        if (!raised.size) return { ok: true, message: stop || 'nothing to raise: the plan is met', idle: true };
        const list = [...raised.values()].map((x) => `${x.name} ${x.from} → ${x.to}`).join(', ');
        return { ok: true, message: `${list} (${spent.toLocaleString()} XP)${stop ? `; ${stop}` : ''}` };
      }
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Follow routes: how often the leader's position is taken, how far they can be seen, and how near a corner of their path counts as reached. */
export const FOLLOW_SAMPLE_MS = 250;
const FOLLOW_SIGHT_M = 250;
const FOLLOW_CORNER_M = 1;

/** The Follow route's leader among what you see: the player of that name first, else a creature (VirindiTank follows the selection). */
export function findLeader<T extends { name: string; kind: string; dying?: boolean }>(nearby: T[], who: string): T | undefined {
  const w = who.toLowerCase();
  const named = nearby.filter((o) => o.name.toLowerCase() === w && !o.dying);
  return named.find((o) => o.kind === 'player') ?? named.find((o) => o.kind === 'monster' || o.kind === 'npc' || o.kind === 'vendor');
}

/** Where a seen object is, in global metres, from your position and its distance and compass bearing. */
function leaderAt(me: { x: number; y: number }, o: { dist: number; bearing: number }): { x: number; y: number } {
  const r = (o.bearing * Math.PI) / 180;
  return { x: me.x + o.dist * Math.sin(r), y: me.y + o.dist * Math.cos(r) };
}

/**
 * Add the leader's latest position to their trail. A point in line with
 * the two before it (or, for a trail of one, with you and it) replaces the
 * last one, since a straight run is one leg: the trail keeps only the
 * corners of their path. Under a metre of movement is not recorded.
 */
export function addTrailPoint(trail: Array<{ x: number; y: number }>, at: { x: number; y: number }, me?: { x: number; y: number }): void {
  const last = trail[trail.length - 1];
  if (last && Math.hypot(at.x - last.x, at.y - last.y) < 1) return;
  const prev = trail[trail.length - 2] ?? (me && last && Math.hypot(last.x - me.x, last.y - me.y) >= 1 ? me : undefined);
  if (last && prev) {
    const a = Math.atan2(last.y - prev.y, last.x - prev.x);
    const b = Math.atan2(at.y - last.y, at.x - last.x);
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    if (d < (15 * Math.PI) / 180) { trail[trail.length - 1] = at; return; }
  }
  trail.push(at);
  if (trail.length > 200) trail.splice(0, trail.length - 200);
}

/** Global metres as map coordinates precise to a few centimetres ("42.1234N, 33.5678E"; parseMapCoords reads them back). */
export function mapCoordsText(p: { x: number; y: number }): string {
  const ns = p.y / 240 - MAP_COORD_ORIGIN;
  const ew = p.x / 240 - MAP_COORD_ORIGIN;
  return `${Math.abs(ns).toFixed(4)}${ns < 0 ? 'S' : 'N'}, ${Math.abs(ew).toFixed(4)}${ew < 0 ? 'W' : 'E'}`;
}

