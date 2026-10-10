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
  itemTypeLabel, vtCanonicalName, vtDefaults,
  type LootRule, type PropTest, type Route, type RoutineAction, type RoutineCondition, type RoutineProfile, type RoutineRule,
} from '@ac/shared';
import { parseMapCoords, type AgentApi, type LootDecision } from './AgentApi.ts';
import type { AgentObservation, AgentResult } from './types.ts';

/** Live facts the conditions read that the observation doesn't carry. */
export interface RoutineFacts {
  /** Active enchantments by spell name, with seconds left. */
  activeSpells(): Array<{ name: string; remaining: number }>;
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
    else if (a.kind === 'attack-nearest') out.add('combat');
    else if (a.kind === 'loot-nearby') out.add('looting');
    else if (a.kind === 'follow-route' || a.kind === 'walk-to') out.add('navigation');
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
    if (m.spells) {
      const names = item.props?.spells;
      if (!names) continue;
      const yes = new RegExp(m.spells.match, 'i');
      const no = m.spells.notMatch ? new RegExp(m.spells.notMatch, 'i') : null;
      if (names.filter((n) => yes.test(n) && !(no && no.test(n))).length < m.spells.count) continue;
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
function needsExamination(rules: LootRule[], item: { name: string; type: string }): boolean {
  for (const r of rules) {
    const m = r.match;
    if (m.valueAtLeast !== undefined || m.valueAtMost !== undefined || m.burdenAtMost !== undefined || m.appraisal || m.props?.length || m.spells || m.spellCountAtLeast !== undefined || m.minDamageAtLeast !== undefined || m.totalRatingsAtLeast !== undefined) {
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
export const MACRO_DEFAULTS: Record<string, string | number | boolean> = { ...vtDefaults(), BuffSet: '' };

/** Does any rule (through Not) use this condition kind? */
function usesCondition(p: RoutineProfile, kind: RoutineCondition['kind']): boolean {
  const has = (c: RoutineCondition): boolean => c.kind === kind || (c.kind === 'not' && has(c.condition)) || ((c.kind === 'any' || c.kind === 'all') && c.conditions.some(has));
  return p.states.some((s) => s.rules.some((r) => !r.disabled && r.when.some(has)));
}

const truthySetting = (v: string | number | boolean | undefined): boolean => v === true || v === 1 || (typeof v === 'string' && /^(true|1|yes|on)$/i.test(v));
/** A rule whose every action found nothing to do rests this long, so the rules below it get their turn. */
export const IDLE_REST_MS = 30_000;

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
  /** Names of creatures this routine killed recently (whose corpses it may loot), newest last. */
  private kills: Array<{ name: string; at: number }> = [];
  private stopRequested = false;
  private paused = false;
  /** Events at or before this sequence number are already accounted for (portal / death conditions). */
  private eventMark = 0;
  /** The route the macro walks (load-route / VTank's Embed Nav). */
  private nav: { route: Route; i: number; dir: 1 | -1; done: boolean } | null = null;
  private callStack: string[] = [];
  /** ruleFiring 'once': rules (state#index) that fired and wait for their conditions to turn false. */
  private spent = new Set<string>();
  /** A death already counted (StopMacroOnDeath off holds still while dead). */
  private deadSeen = false;
  private watchdog: { state: string; meters: number; seconds: number; samples: Array<{ t: number; x: number; y: number }> } | null = null;
  private settings: Record<string, string | number | boolean> = {};
  /** The profile a dry run is checking (another one than the running profile, maybe). */
  private checking: RoutineProfile | null = null;
  /** The expression evaluator, when one is attached (VirindiTank meta expressions). */
  expressions: { test(expr: string): boolean; run(expr: string): string } | null = null;
  private lastChange: { from: string; to: string; rule: string | null } | null = null;
  /** Rules (by state + index) resting after a pass where they found nothing to do, until this time. */
  private resting = new Map<string, number>();
  /** Bumped by pause/stop: an action sequence started under an older generation ends at its next step. */
  private gen = 0;
  private stats: RoutineStats = emptyStats();
  private xpAtStart = 0;
  private stateClock = 0;
  /** Player-facing reports ("Kept Pyreals (rule: Money)"); main.ts prints them to chat as [Automation]. */
  onReport: ((text: string) => void) | null = null;

  constructor(private readonly api: AgentApi, private readonly facts: RoutineFacts, private readonly now: () => number) {}

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
    this.callStack = [];
    this.spent.clear();
    this.deadSeen = false;
    this.watchdog = null;
    this.settings = { ...MACRO_DEFAULTS };
    for (const [k, v] of Object.entries(profile.settings ?? {})) this.settings[vtCanonicalName(k)] = v;
    // VirindiTank's Auto-Navigation and Looting profiles: the route and loot set it starts with.
    const navRoute = profile.navRoute ? profile.routes.find((r) => r.name === profile.navRoute) : undefined;
    if (navRoute) this.nav = { route: navRoute, i: 0, dir: 1, done: navRoute.points.length === 0 };
    if (profile.lootSet && profile.lootSets?.[profile.lootSet]) this.profile.loot = profile.lootSets[profile.lootSet];
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
    this.profile = null;
    this.api.stopMoving();
    return { ok: true, message: `stopped "${name}"` };
  }

  status(): RoutineStatus {
    return {
      running: !!this.profile, paused: !!this.profile && this.paused, profile: this.profile?.name ?? null, state: this.profile ? this.state : null,
      acting: this.acting, last: this.log.slice(-12), stateSince: this.stateSince, lastChange: this.lastChange, spent: [...this.spent],
    };
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
    this.report(text);
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
    if (name !== this.state) { this.report(`→ ${name}`); this.lastChange = { from: this.state, to: name, rule }; }
    this.state = name;
    this.eventMark = this.api.currentSeq();
    this.spent.clear();
    this.stateSince = this.now();
  }

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
    this.profile = { ...profile, modules: { ...modules } };
    if (!profile.states.some((s) => s.name === this.state)) this.enterState(profile.initialState, null);
    if (this.nav) { const r = profile.routes.find((x) => x.name === this.nav!.route.name); this.nav = r ? { ...this.nav, route: r, i: Math.min(this.nav.i, Math.max(0, r.points.length - 1)), done: this.nav.done || r.points.length === 0 } : null; }
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

  private report(text: string): void {
    try { this.onReport?.(text); } catch { /* a report never stops the routine */ }
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
      case 'spell-time-at-least': { const on = this.facts.activeSpells().find((x) => x.name.toLowerCase() === c.spell.toLowerCase()); const left = on?.remaining ?? 0; return { ok: left >= c.seconds, why: on ? `${c.spell} ${Math.round(left)} s left` : `${c.spell} not on` }; }
      case 'monster-count': {
        let re: RegExp;
        try { re = new RegExp(c.pattern, 'i'); } catch { return { ok: false, why: `bad pattern /${c.pattern}/` }; }
        const n = obs.nearby.filter((o) => o.kind === 'monster' && o.dist <= c.meters && re.test(o.name)).length;
        return { ok: n >= c.count, why: `${n} matching within ${c.meters} m` };
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
      case 'seconds-in-state': { const s = (this.now() - this.stateSince) / 1000; return { ok: s >= c.seconds, why: `${Math.round(s)} s in "${this.state}"` }; }
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

  /** Called from the agent API's tick (~10 Hz); evaluates at most every half second. */
  tick(): void {
    const p = this.profile;
    if (!p || this.busy || this.paused) return;
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
          this.report(`You died: stopped "${p.name}"`);
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
    if (!truthySetting(this.settings.EnableMeta)) { if (p.macro) this.macroStep(p); return; }
    const verdicts = this.dryRun();
    const at = verdicts.findIndex((v) => v.fires);
    if (at < 0) { if (p.macro) this.macroStep(p); return; }
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
    const obs = this.api.snapshot({ radius: Math.max(range, approach, 20), max: 30 });
    const combat = truthySetting(st.EnableCombat) && p.modules.combat;
    const looting = truthySetting(st.EnableLooting) && p.modules.looting;
    const navOn = truthySetting(st.EnableNav) && p.modules.navigation && !!this.nav && !this.nav.done;
    const monsters = obs.nearby.filter((o) => o.kind === 'monster');
    const inRange = combat && monsters.some((o) => o.dist <= range);
    const near = combat && truthySetting(st.EnableNav) && approach > range ? monsters.filter((o) => o.dist > range && o.dist <= approach).sort((a, b) => a.dist - b.dist)[0] : undefined;
    if (navOn && truthySetting(st.NavPriorityBoost)) { void this.walkNav(); return; }
    const steps: RoutineAction[] = [];
    const lootDue = looting && this.kills.some((k) => this.now() - k.at < 120_000);
    if (inRange) {
      if (lootDue && truthySetting(st.LootPriorityBoost)) steps.push({ kind: 'loot-nearby', meters: 20 });
      steps.push({ kind: 'attack-nearest', meters: range });
    } else if (near) {
      // Approach: run at it until it is within Monster Range.
      this.acting = `approach ${near.name}`;
      this.busy = true;
      void this.api.walkTo(near.guid, { within: Math.max(1, range - 0.5), timeoutMs: 30_000 }).then((r) => this.note(`approach ${near.name}: ${r.message.split('\n')[0]}`)).finally(() => { this.busy = false; this.acting = null; });
      return;
    } else if (lootDue) {
      steps.push({ kind: 'loot-nearby', meters: 20 });
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
    void this.run(steps, p).finally(() => { this.busy = false; this.acting = null; });
  }

  /** A route point's stops (recall, pause, say, use a portal/NPC/vendor, jump), in order. */
  private async runStops(route: Route, i: number): Promise<void> {
    const p = this.profile;
    if (!p) return;
    for (const st of route.stops ?? []) {
      if (st.at !== i) continue;
      for (const a of st.do) {
        if (this.profile !== p) return;
        const r = await this.act(a, p);
        if (r) this.note(`route "${route.name}" point ${i + 1}: ${a.kind}: ${r.message.split('\n')[0]}`);
      }
    }
  }

  /** One point of the loaded route; circular loops, linear turns back, once ends (route-done). */
  private async walkNav(): Promise<void> {
    const n = this.nav!;
    this.acting = `route "${n.route.name}"`;
    this.busy = true;
    try {
      // Follow/Nav Min (NavCloseStopRange): how near a waypoint counts as reaching it.
      const within = Math.max(0.5, Number(this.settings.NavCloseStopRange) || 2);
      const r = await this.api.walkTo(n.route.points[n.i], { within, timeoutMs: 90_000 });
      this.note(`route "${n.route.name}" point ${n.i + 1}: ${r.message.split('\n')[0]}`);
      if (r.ok) await this.runStops(n.route, n.i);
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
      case 'use-item': return this.api.useOn(a.item, a.on === 'target' ? this.api.targetName() : 'self');
      case 'attack-nearest': {
        const obs = this.api.snapshot({ radius: a.meters ?? 60, max: 30 });
        const m = obs.nearby.find((o) => o.kind === 'monster' && (!a.names?.length || a.names.some((n) => o.name.toLowerCase().includes(n.toLowerCase()))));
        if (!m) return { ok: false, message: 'no monster in reach' };
        const since = this.api.currentSeq();
        const r = this.api.attack(m.guid);
        if (!r.ok) return r;
        await this.waitDone(['target-died', 'target-lost', 'death'], 120_000);
        const end = this.api.eventsSince(since).find((e) => (e.type === 'target-died' || e.type === 'target-lost' || e.type === 'death') && (e.type === 'death' || e.guid === m.guid));
        if (end?.type === 'target-died') { this.kills.push({ name: m.name, at: this.now() }); this.kills = this.kills.slice(-10); this.stats.kills++; }
        return { ok: end?.type === 'target-died', message: end?.type === 'target-died' ? `killed ${m.name}` : end?.type === 'target-lost' ? `${m.name} got away` : end?.type === 'death' ? 'you died' : `fight with ${m.name} went on too long` };
      }
      case 'loot-nearby': {
        // Only corpses of what this routine killed in the last two minutes: never a player's, never a stranger's.
        // The corpse appears a second or two after the death starts, so a fresh kill waits up to 5 s for it.
        const recent = this.kills.filter((k) => this.now() - k.at < 120_000).map((k) => `Corpse of ${k.name}`);
        if (!recent.length) return { ok: true, message: 'nothing of ours to loot', idle: true };
        const find = () => this.api.snapshot({ radius: a.meters ?? 20, max: 30 }).nearby.find((o) => o.kind === 'corpse' && recent.includes(o.name));
        let corpse = find();
        for (let w = 0; !corpse && w < 10; w++) { await sleep(500); corpse = find(); }
        if (!corpse) return { ok: true, message: 'no corpse of ours to loot', idle: true };
        // Each item goes through the loot rules, first match wins. A rule on value, burden or appraisal
        // text examines the item first (an Appraise, as a player would); name- and type-only rules don't.
        // No rule, or ignore: left on the corpse. Salvage is taken (to salvage later), as VTank does.
        const examined = new Map<number, ReturnType<typeof appraisalFacts> | 'pending'>();
        const me = this.lootCharacter();
        const paletteWaits = new Map<number, number>();
        const needsColours = p.loot.some((r) => !r.disabled && r.match.colours?.length);
        const decide = (it: { guid: number; name: string; itemType: number; objectDescFlags: number; palettes: ItemPalette[] }): LootDecision => {
          const item = { name: it.name, type: itemTypeLabel(it.itemType), descFlags: it.objectDescFlags, palettes: it.palettes };
          // Colour rules need the item's palettes loaded (streamed builds fetch them on demand); wait up to ~5 s.
          if (needsColours && it.palettes.some((x) => x.example === null) && (paletteWaits.get(it.guid) ?? 0) < 10) {
            paletteWaits.set(it.guid, (paletteWaits.get(it.guid) ?? 0) + 1);
            return 'wait';
          }
          let facts = examined.get(it.guid);
          if (facts === undefined && needsExamination(p.loot, item)) {
            examined.set(it.guid, 'pending');
            void this.api.appraise(it.guid).then((r) => examined.set(it.guid, r.ok ? { ...appraisalFacts(r.message), ...(r.data ? { props: r.data as ItemProps } : {}) } : { appraisal: '' }));
            return 'wait';
          }
          if (facts === 'pending') return 'wait';
          const rule = lootRuleFor(p.loot, { ...item, ...(facts ?? {}) }, me);
          if (!rule || rule.action === 'ignore') { this.stats.left++; return 'skip'; }
          if (rule.action === 'keep-up-to') {
            const held = this.api.inventory().filter((i) => lootRuleFor([rule], { name: i.name, type: i.type, value: i.value, burden: i.burden }))
              .reduce((t, i) => t + (i.stack ?? 1), 0);
            if (held >= (rule.count ?? 1)) { this.stats.left++; return 'skip'; }
          }
          this.stats.kept++;
          this.report(`${rule.action === 'sell' ? 'Took to sell' : rule.action === 'salvage' ? 'Took to salvage' : 'Kept'} ${it.name} (rule: ${rule.label ?? rule.action})`);
          return 'take';
        };
        return this.api.loot(corpse.guid, null, decide);
      }
      case 'follow-route': {
        const route = p.routes.find((r) => r.name === a.route);
        if (!route) return { ok: false, message: `no route "${a.route}"` };
        const pos = this.routeIndex.get(route.name) ?? { i: 0, dir: 1 as const };
        const point = route.points[pos.i];
        const r = await this.api.walkTo(point, { within: 3, timeoutMs: 90_000 });
        if (r.ok) await this.runStops(route, pos.i);
        let next = pos.i + pos.dir;
        let dir = pos.dir;
        if (next >= route.points.length) { if (route.mode === 'circular') next = 0; else if (route.mode === 'linear') { dir = -1; next = Math.max(0, route.points.length - 2); } else next = route.points.length - 1; }
        if (next < 0) { dir = 1; next = Math.min(1, route.points.length - 1); }
        this.routeIndex.set(route.name, { i: next, dir });
        return r;
      }
      case 'walk-to': return this.api.walkTo(a.coords, { within: 3, timeoutMs: 120_000 });
      case 'use-object': return this.api.use(a.name);
      case 'say': return this.api.say(a.text);
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
        this.nav = { route, i: 0, dir: 1, done: route.points.length === 0 };
        return { ok: true, message: `loaded route "${route.name}" (${route.points.length} points)` };
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

