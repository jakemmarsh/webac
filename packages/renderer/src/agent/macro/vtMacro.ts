/**
 * AGENT.vtank-window — VirindiTank's macro from its tabs: what the routine
 * engine's macro does for a profile with VirindiTank data (`profile.vtank`).
 * Each step asks the planners in VTank's order and does the first thing one
 * of them wants (docs/vtank-macro-behavior.md):
 *
 * 1. Critical pea splitting (Consumables tab components below SpellCompMin-Critical).
 * 2. Recharge (Vitals tab; spells, kits and food on the Consumables tab; the recharge boost after a switch to magic mode).
 * 3. Worn items' mana (RefillWornMana).
 * 4. Buffs due by RebuffTimeRemainingSeconds (VTank's automatic list, Extra Buff Spells, Blacklisted
 *    Buff Families), with a monster in range too; then pea splitting below SpellCompMin-Normal.
 * 5. Dispel a level-7 vuln on you (Cast Dispel Self, Use Dispel Items).
 * 6. Auto Fellow Mgmt.
 * 7. A pet (Summon Pets), then combat within Monster Range (Monsters tab: target, debuffs, attack; Items tab: the weapon).
 * 8. With nothing to fight: crafting, pea splitting below SpellCompMin-Idle and the idle buff top-off.
 * Last of all (the routine engine asks, after the route): RandomHelperBuffs.
 *
 * Monsters a cast or a shot can't reach are blacklisted, and ghosts set aside (targetTracker.ts);
 * every mode change waits for the server to take it (modeGate.ts).
 *
 * That is VTank's rule list (MOSS MacroRuleTable: BuffSelfNormal and SplitPeasNormal above the
 * POSTBUFF dispels, the helpers and the fellowship manager, all above Attack; BuffSelfIdle after it).
 * Before 2026-10-11 buffs waited for no monster in range, so they ran out in long fights, and the
 * dispel and fellowship steps came first of all.
 *
 * The planners are pure (buffPlan / rechargePlan / combatPlan); this reads
 * the agent API into their inputs and turns their answer into one action
 * through the UI's own paths. Spell families are built once per spell table,
 * so each era's own table decides what exists.
 */
import { resolveVtankIds, vtItemIs, vtOption, vtStoredValue, type PlanItem, type PlanSkill, type PlanSpell, type RoutineProfile, type Stance, type VtankProfileData } from '@ac/shared';
import type { AgentApi } from '../AgentApi.ts';
import type { AgentResult } from '../types.ts';
import { buildBuffFamilies, planBuffs, type BuffFamilies } from './buffPlan.ts';
import { blowPoints, buildCombatFamilies, indexMonsterTable, planCombat, planPet, type CombatFamilies, type CombatInput, type CombatMonster, type MonsterFacts } from './combatPlan.ts';
import { FellowManager } from './fellowManager.ts';
import { buildRechargeFamilies, planRecharge, type RechargeFamilies } from './rechargePlan.ts';
import { planPeaSplit, type SplitTier } from './peaPlan.ts';
import { idleCraftCategory, indexRecipes, planCraft, type CraftRow } from './craftPlan.ts';
import { autoAttackPower } from './attackPower.ts';
import { activeUbNet, type UbNet } from '../ubNet.ts';
import type { HelperTarget } from './rechargePlan.ts';
import { castConfirmed, castReplyLines, castTargetsNamed, COMPONENTS_MISSING } from './castReply.ts';

/** The server's refusal for lack of mana (ACE Player_Magic, the same words on GDLE and the 1999 server). */
const NOT_ENOUGH_MANA = /don't have enough mana/i;
/** The macro's own hold while mana comes back: not a cast, so not a buff's miss. */
const MANA_WAIT = 'not enough mana';
import { ItemBuffLedger, type ItemRef } from './itemBuffLedger.ts';
import { HIT_ENVIRONMENT, INVALID_TARGET, TargetTracker, type TrackerSettings } from './targetTracker.ts';
import { BUGGED_COMBAT_STATE, ModeGate } from './modeGate.ts';
import type { CombatModeName } from '../AgentApi.ts';
import { isQuickBuff, itemCooldown, planBuffItem, rebuffThreshold, VT_GEM_FOOD_ITEMS } from './buffItems.ts';
import type { DrainRow } from './drainPlan.ts';
import { itemCastLine } from './itemDebuffs.ts';
import { planPetRefill } from './petRefill.ts';

/** A spell that dispels negative Life Magic (by its description in the era's own SpellTable). */
export const isLifeDispel = (desc: string): boolean => /dispels?\b[^.]*\bnegative\b[^.]*\blife magic\b/i.test(desc);

/**
 * Which of VirindiTank's dispel options can ever act in this era: Cast Dispel
 * Self needs a self dispel of negative Life Magic in the era's SpellTable
 * ("… from the caster": Eradicate Life Magic Self in end of retail and Dark
 * Majesty); Use Dispel Items needs an item spell that is such a dispel, so
 * any negative Life Magic dispel at all. The 1999 table has no dispel spells,
 * so both are hidden there. An unknown table (not loaded yet) hides nothing.
 */
export function dispelOptionsAvailable(table: { spells: Map<number, { desc: string }> } | null): { CastDispelSelf: boolean; UseDispelItems: boolean } {
  if (!table) return { CastDispelSelf: true, UseDispelItems: true };
  let any = false;
  let self = false;
  for (const s of table.spells.values()) {
    if (!isLifeDispel(s.desc ?? '')) continue;
    any = true;
    if (/\bfrom the caster\b/i.test(s.desc)) { self = true; break; }
  }
  return { CastDispelSelf: self, UseDispelItems: any };
}

/** One thing to do, and doing it. */
export interface VtStep { label: string; run: () => Promise<AgentResult> }

const num = (v: unknown, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
/** A VTank option's value from the profile's settings (any case), else VTank's default. */
const opt = (settings: Record<string, string | number | boolean>, name: string): string | number | boolean => {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(settings)) if (k.toLowerCase() === want) return vtStoredValue(name, v);
  return vtOption(name)!.default;
};

/**
 * The game's school names ("War", as the agent reports them) as the planners and the skill table name
 * them ("War Magic"). Before 2026-10-11 the short names reached the planners, so no spell matched its
 * school's skill and the live macro never cast (the tests fed full names).
 */
const FULL_SCHOOL: Record<string, string> = { war: 'War Magic', life: 'Life Magic', item: 'Item Enchantment', creature: 'Creature Enchantment', void: 'Void Magic' };
export const fullSchoolName = (s: string): string => FULL_SCHOOL[s.trim().toLowerCase()] ?? s;

export class VtMacro {
  private table: unknown = null;
  private fam: { buff: BuffFamilies; recharge: RechargeFamilies; combat: CombatFamilies } | null = null;
  /** Debuffs this macro cast (the Monsters tab's recast timing). */
  readonly castLog: Array<{ guid: number; category: number; at: number; duration: number }> = [];
  /** Consumables already sent for examination (their kit / food properties). */
  private asked = new Set<number>();
  /** Monsters this macro attacked or cast at, by guid (their deaths are its kills, for looting). */
  private fought = new Map<number, { name: string; at: number }>();
  private eventMark = 0;
  /**
   * Force Buff: the families recast in this forced round (their enchantment
   * seen landing) and the tries at each (null: not forcing). A family counts
   * done only once its enchantment is on: a fizzle or a lost cast is tried
   * again, up to FORCE_TRIES casts.
   */
  private forced: { done: Set<number>; tries: Map<number, number> } | null = null;
  /** VirindiTank's Force Buff: recast every buff in the list now, whatever time is left; pausing holds the round. */
  forceBuff(): void { this.forced = { done: new Set(), tries: new Map() }; }
  cancelForceBuff(): void { this.forced = null; }
  get forcing(): boolean { return this.forced !== null; }
  /** The target the last attack order went to (not sent again while that fight goes on). */
  private lastAttack: { guid: number; at: number } | null = null;
  /** Magic-mode attempts the server turned back (ACE: no wand wielded), and when spells are left out until. */
  private magicTries: number[] = [];
  /** The era's recipes (loaded on the first craft), and when the last craft was sent (one at a time). */
  private recipes: Map<string, CraftRow[]> | null = null;
  private recipesAsked = false;
  private craftAt = -Infinity;
  /** The era's monster table (Auto's weak element, the streak finisher's max health), asked for once. */
  private monsterFacts: ((name: string) => MonsterFacts | undefined) | undefined;
  private monstersAsked = false;
  /** While the table loads (a lazily imported chunk): the first fight waits for it rather than choosing blind. */
  private monstersLoading: Promise<void> | null = null;
  /** The era's special ammunition (UseSpecialAmmo's kinds by name), asked for with the monster table. */
  private specialAmmo: Map<string, number> | null = null;
  /** The last blow you landed on each monster you fought (combat text), by guid, and how far the chat has been read. */
  private blows = new Map<number, number>();
  private blowMark = 0;
  /** The era's drains and martyrs (Drain Auto's plan; tools/build-drain-tables.ts), once loaded. */
  private drainRows: DrainRow[] | null = null;
  /** Monsters the server answered "You fail to affect …" for: immune to spells that aren't projectiles (no more debuffs). */
  private magicImmune = new Set<number>();

  /** Line-of-fire answers by monster, kept half a second (each is a sweep through the world's collision). */
  private lofSeen = new Map<number, { at: number; blocked: boolean | null }>();
  private lineOfFire(guid: number): boolean | null {
    const t = this.now();
    const had = this.lofSeen.get(guid);
    if (had && t - had.at < 500) return had.blocked;
    if (this.lofSeen.size > 100) for (const [g, v] of this.lofSeen) if (t - v.at >= 500) this.lofSeen.delete(g);
    const blocked = this.api.lineOfFireBlocked(guid);
    this.lofSeen.set(guid, { at: t, blocked });
    return blocked;
  }

  /** The monster of that name the macro fought most recently. */
  private foughtNamed(name: string): number | null {
    let best: { guid: number; at: number } | null = null;
    for (const [guid, f] of this.fought) if (f.name.toLowerCase() === name.toLowerCase() && (!best || f.at > best.at)) best = { guid, at: f.at };
    return best?.guid ?? null;
  }

  /**
   * Spell lines about the monsters the macro fights: "You fail to affect X with Y" (ACE and ClassicACE
   * Player_Magic / WorldObject_Weapon NonProjectileMagicImmune) or "You fail to affect X because X cannot be
   * harmed!" (AC1999 SpellcastingManager.cpp) marks X immune to debuffs; "<item> cast <debuff> on X"
   * (a caster's spell or a weapon's proc; itemDebuffs.itemCastLine) logs that debuff on X for its duration.
   * True when the line was one of these.
   */
  private noteSpellLine(line: string): boolean {
    const immune = /^You fail to affect (.+?) (?:with .+|because .+)$/.exec(line);
    if (immune) { const g = this.foughtNamed(immune[1]); if (g !== null) this.magicImmune.add(g); return true; }
    const c = itemCastLine(line);
    if (!c || /^you$/i.test(c.caster)) return false;
    const guid = this.foughtNamed(c.target);
    const table = this.api.spellTableData();
    if (guid === null || !table) return false;
    for (const [, sp] of table.spells) {
      if (sp.name.toLowerCase() !== c.spell.toLowerCase() || !(sp.duration && sp.duration > 0)) continue;
      this.castLog.push({ guid, category: sp.category, at: this.now(), duration: sp.duration });
      return true;
    }
    return false;
  }

  /**
   * Loads the monster table on first use, and reads new combat lines: the blows you landed (the streak
   * finisher's bar; a blow also clears the monster's miss count), and "Your missile attack hit the
   * environment." after a weapon attack (a miss on the monster it went to: the blacklist's count).
   */
  private noteFights(settings: Record<string, string | number | boolean>): void {
    if (!this.monstersAsked) {
      this.monstersAsked = true;
      this.monstersLoading = this.api.monsterTable().then((t) => { if (t) this.monsterFacts = indexMonsterTable(t); }, () => undefined).finally(() => { this.monstersLoading = null; });
      // No table from the host: Drain Auto keeps casting the best drain (combatPlan); an era's empty table means no drains.
      void this.api.drainTable().then((t) => { this.drainRows = t; }, () => undefined);
      void this.api.specialAmmoTable().then((t) => { this.specialAmmo = new Map((t ?? []).map(([n, m]) => [n.toLowerCase(), m])); }, () => undefined);
    }
    for (const e of this.api.eventsSince(this.blowMark)) {
      this.blowMark = Math.max(this.blowMark, e.seq);
      if (e.type !== 'chat') continue;
      if (this.noteSpellLine(e.text.replace(/^\([a-z]+\) /i, '').trim())) continue;
      // A shot from a bow or a thrown weapon (a spell's miss is its unanswered cast: noteCastAt).
      if (HIT_ENVIRONMENT.test(e.text.replace(/^\([a-z]+\) /i, '').trim()) && this.lastTarget !== null && this.lastWasAttack) {
        const f = this.fought.get(this.lastTarget);
        const n = f ? this.targets.miss(this.lastTarget, f.name, trackerSettings(settings)) : null;
        if (n) this.notices.push(n);
        continue;
      }
      // The line names a monster, not a guid: the one of that name fought most recently.
      let best: { guid: number; at: number; pts: number } | null = null;
      for (const [guid, f] of this.fought) {
        const pts = blowPoints(e.text, f.name);
        if (pts !== null && (!best || f.at > best.at)) best = { guid, at: f.at, pts };
      }
      if (best) { this.blows.set(best.guid, best.pts); this.targets.reached(best.guid); }
    }
    for (const g of this.blows.keys()) if (!this.fought.has(g)) this.blows.delete(g);
  }

  /**
   * VirindiTank's AutoCraftItems (craftPlan.ts): one of every Consumables / Items entry you've run out of,
   * then (idle) kits and foods up to their IdleCraftCount_*. Crafting is done in peace mode, one use at a time.
   */
  private craftStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>, stance: Stance, idle: boolean): VtStep | null {
    if (!opt(settings, 'AutoCraftItems')) return null;
    if (!this.recipes) {
      if (!this.recipesAsked) { this.recipesAsked = true; void this.api.craftTable().then((t) => { this.recipes = indexRecipes(t ?? []); }); }
      return null;
    }
    if (!this.recipes.size || this.now() - this.craftAt < 3000) return null;
    const inv = this.api.inventory();
    // UseSpecialAmmo also gates crafting special ammunition (VTank: "craft and use"); the era's table names it.
    const allowedAmmo = Math.trunc(Number(opt(settings, 'UseSpecialAmmo')) || 0);
    const specialOff = (n: string) => { const m = this.specialAmmo?.get(n.toLowerCase()) ?? 0; return m !== 0 && (m & allowedAmmo) === 0; };
    const names = [...p.vtank.consumables, ...p.vtank.items.map((x) => x.name)].filter((n) => !/ Pea$/i.test(n) && n !== '[All Peas]' && !specialOff(n));
    const counts = new Map<string, { name: string; count: number }>();
    const want = (name: string, count: number) => { const k = name.toLowerCase(); const had = counts.get(k); if (!had || had.count < count) counts.set(k, { name, count }); };
    for (const n of names) want(n, 1);
    if (idle) {
      for (const n of p.vtank.consumables) {
        const carried = inv.find((i) => i.name.toLowerCase() === n.toLowerCase());
        const cat = idleCraftCategory(n, carried ? this.api.itemData(carried.guid)?.int?.[89] : undefined);
        if (cat) want(n, Math.max(0, Math.round(Number(opt(settings, `IdleCraftCount_${cat}`)) || 0)));
      }
    }
    const step = planCraft({
      recipes: this.recipes, skills: this.api.skillList(), want: [...counts.values()],
      items: inv.filter((i) => i.where !== 'equipped').map((i) => ({ guid: i.guid, name: i.name, ...(i.stack !== undefined ? { stack: i.stack } : {}) })),
      fletchExcess: Number(opt(settings, 'ArrowheadFletchDiffExcessThreshold')) || 0,
    });
    if (!step) return null;
    if (stance !== 'peace') return { label: `craft: to make ${step.result}: switching to peace mode`, run: () => this.switchMode(p, 'peace') };
    // A recipe on two of the same thing, one stack carried: split one off; the next decision crafts.
    if (step.split) { const s = step.split; return { label: `craft: ${step.why}`, run: async () => { this.craftAt = this.now() - 2000; return this.api.splitStack(s.guid, 1); } }; }
    return { label: `craft: ${step.why}`, run: async () => {
      this.craftAt = this.now();
      const res = this.api.useOn(step.first.guid, step.second.guid);
      if (!res.ok) return res;
      // The server's "chance of success" confirmation (when the character has it on): VTank answers it, so do we.
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const d = this.api.openDialogs().find((x) => x.buttons.some((b) => /^yes$/i.test(b)) && /chance|craft|make|combine/i.test(x.text));
        if (d) return this.api.dialog('Yes');
      }
      return res;
    } };
  }
  /** Monsters a spell couldn't reach ("no line of fire"), set aside until then (VTank moves on to another target). */
  private blocked = new Map<number, number>();
  private noMagicUntil = 0;

  /**
   * A step into magic mode, VTank's way: wield a caster first (an Items-tab one, else any carried), as
   * ACE refuses magic mode without one. If the server still turns it back three times in 15 s, spells
   * are left out for a minute (and said so) instead of asking forever.
   */
  private toMagic(p: RoutineProfile & { vtank: VtankProfileData }, label: string, before?: () => void): VtStep {
    const inv = this.api.inventory();
    const isCaster = (i: { itemType?: number }) => ((i.itemType ?? 0) & 0x8000) !== 0;
    if (!inv.some((i) => i.where === 'equipped' && isCaster(i))) {
      const listed = new Set(p.vtank.items.map((x) => x.name.toLowerCase()));
      const wand = inv.find((i) => isCaster(i) && listed.has(i.name.toLowerCase())) ?? inv.find((i) => isCaster(i));
      if (wand) return { label: `${label}: wielding ${wand.name} to cast`, run: async () => this.api.equip(wand.guid) };
    }
    return { label, run: async () => {
      before?.();
      const t = this.now();
      this.magicTries = [...this.magicTries.filter((x) => t - x < 15_000), t];
      if (this.magicTries.length > 3) {
        this.noMagicUntil = t + 60_000;
        this.magicTries = [];
        return { ok: false, message: 'the server keeps refusing magic mode (no wand to cast with?): leaving spells out for a minute' };
      }
      return this.switchMode(p, 'magic');
    } };
  }

  /** VTank's combat-mode gate (modeGate.ts): mode changes, the server's confirmation, and the bugged-state fix. */
  private readonly gate: ModeGate;

  /**
   * Ask for a mode the way VTank's gate does: a drop to peace that has failed DropToPeaceModeRetryCount
   * times wields the first caster on the Items tab instead (that clears a stuck combat state); otherwise
   * the change is asked for and waited on until the server takes it (or the client gives it up).
   */
  private async switchMode(p: RoutineProfile & { vtank: VtankProfileData }, to: CombatModeName): Promise<AgentResult> {
    const current = this.api.self()?.combatMode ?? 'unknown';
    const retries = Number(opt(this.lastSettings, 'DropToPeaceModeRetryCount')) || 0;
    if (this.gate.request(to, current, retries)) {
      const listed = new Set(p.vtank.items.map((x) => x.name.toLowerCase()));
      const wand = this.api.inventory().find((i) => ((i.itemType ?? 0) & 0x8000) !== 0 && listed.has(i.name.toLowerCase()));
      if (!wand) return { ok: false, message: `${BUGGED_COMBAT_STATE} Add at least one wand to your profile first.` };
      const r = await this.api.equip(wand.guid);
      return { ok: r.ok, message: `${BUGGED_COMBAT_STATE} (${wand.name}): ${r.message.split('\n')[0]}` };
    }
    const res = this.api.combatMode(to);
    if (!res.ok) return res;
    for (let w = 0; w < 40; w++) {
      const me = this.api.self();
      if (!this.gate.unconfirmed(me?.combatMode ?? 'unknown', me?.serverMode)) break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    const now = this.api.self()?.combatMode;
    return now === to ? res : { ok: false, message: `${to} mode didn't take (still ${now ?? 'unknown'})` };
  }
  /** The settings of the last decision (the mode gate reads DropToPeaceModeRetryCount). */
  private lastSettings: Record<string, string | number | boolean> = {};

  /** VirindiTank's Peace Mode When Idle, through the mode gate. */
  peaceStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>): VtStep | null {
    p = this.resolved(p);
    this.lastSettings = settings;
    const mode = this.api.self()?.combatMode;
    if (!mode || mode === 'peace' || mode === 'unknown') return null;
    return { label: 'idle: peace mode', run: () => this.switchMode(p, 'peace') };
  }

  /** Deaths since the last call of monsters this macro fought: its kills. */
  kills(): string[] {
    const out: string[] = [];
    for (const e of this.api.eventsSince(this.eventMark)) {
      this.eventMark = Math.max(this.eventMark, e.seq);
      if (e.type !== 'target-died' || e.guid === undefined) continue;
      const f = this.fought.get(e.guid);
      if (f) { out.push(f.name); this.fought.delete(e.guid); }
    }
    for (const [g, f] of this.fought) if (this.now() - f.at > 600_000) this.fought.delete(g);
    return out;
  }

  constructor(private readonly api: AgentApi, private readonly now: () => number, ledger?: ItemBuffLedger) {
    this.fellows = new FellowManager(api, now);
    this.itemTimers = ledger ?? new ItemBuffLedger();
    this.targets = new TargetTracker(now);
    this.gate = new ModeGate(now);
  }

  /** VTank's monster blacklist and ghosts (targetTracker.ts). */
  readonly targets: TargetTracker;
  /** The monster the last combat action went to (VTank's sticky last target; the environment-hit miss goes to it), and whether that was a weapon attack. */
  private lastTarget: number | null = null;
  private lastWasAttack = false;
  /** Blacklist and ghost notices, said as the next step. */
  private notices: string[] = [];
  /** [0, 1) random numbers (RandomHelperBuffs' picks). */
  random: () => number = Math.random;
  /** When RandomHelperBuffs may cast again. */
  private helperUntil = -Infinity;

  /** VTank's BuffedItems: timers for buffs on items (banes, impenetrability, weapon spells), kept per character. */
  readonly itemTimers: ItemBuffLedger;
  /** Worn pieces a confirmed armor-buff cast left out (the server didn't enchant them): not waited on. */
  private armorSkip = new Set<number>();
  /**
   * Whether this server charges spell components, learned from its refusal ("You don't have all the
   * components …") or the client's own pre-check. The client can't read it up front: ACE stores
   * SpellComponentsRequired inverted and never sends true at login (SpellComponentCheck.ts), and a
   * server may switch components off (require_spell_comps). Until then no tier is held back.
   */
  componentsRequired = false;

  /**
   * Every cast the macro makes goes through here: a components refusal teaches the macro that this
   * server charges them, so from then on tiers you can't pay for are left out (VTank BuffCastability).
   */
  private async cast(spellId: number, target: number | 'self'): Promise<AgentResult> {
    // After "You don't have enough Mana to cast this spell." nothing is cast until your mana reaches the spell's
    // base cost (the spell table's; Mana Conversion only lowers it), or 30 s pass: the server refuses each try,
    // and the macro had sent two a second, then one per mana tick, while an out-of-mana caster stood at a golem
    // (2026-10-11). It waits up to 3 s per call.
    const short = this.manaShort;
    if (short) {
      const mana = () => this.api.snapshot({ max: 0 }).me?.mana.cur ?? 0;
      const need = this.api.spellTableData()?.spells.get(spellId)?.baseMana ?? short.mana + 1;
      const waiting = () => mana() < need && this.now() - short.at < 30_000;
      for (let w = 0; w < 15 && waiting(); w++) await new Promise((ok) => setTimeout(ok, 200));
      if (waiting()) return { ok: false, message: `${MANA_WAIT} (${mana()} of ${need}): waiting for it to come back` };
      this.manaShort = null;
    }
    const res = await this.api.cast(spellId, target);
    if (!res.ok && COMPONENTS_MISSING.test(res.message)) this.componentsRequired = true;
    if (!res.ok && NOT_ENOUGH_MANA.test(res.message)) this.manaShort = { mana: this.api.snapshot({ max: 0 }).me?.mana.cur ?? 0, at: this.now() };
    return res;
  }
  /** When UseBreakableTurnTo last turned to each monster (one turn per monster every 3 s). */
  private turnedAt = new Map<number, number>();
  /** The mana a cast was refused at for lack of it ("You don't have enough Mana"), and when. */
  private manaShort: { mana: number; at: number } | null = null;

  /** Worn armor and clothing an armor buff cast on yourself goes on (ACE: ItemType Vestements, Armor | Clothing). */
  private wornVestments(): ItemRef[] {
    return this.api.inventory().filter((i) => i.where === 'equipped' && ((i.itemType ?? 0) & 0x6) !== 0 && !this.armorSkip.has(i.guid)).map((i) => ({ guid: i.guid, name: i.name }));
  }

  /**
   * A confirmed item buff goes in the timers: on the weapon it was cast at, or on each worn piece the
   * server named ("You cast Acid Bane on Leather Coat"); a worn piece it didn't name was not enchanted
   * (not enchantable) and is not waited on.
   */
  private noteItemBuff(res: AgentResult, spell: PlanSpell, target: 'weapon' | 'armor', weapon: ItemRef | null): boolean {
    if (!castConfirmed(res, spell.name)) return false;
    if (target === 'weapon') { if (weapon) this.itemTimers.note([weapon], spell); return true; }
    const named = new Set(castTargetsNamed(res, spell.name).map((n) => n.toLowerCase()));
    if (!named.size) return true;
    const worn = this.wornVestments();
    this.itemTimers.note(worn.filter((w) => named.has(w.name.toLowerCase())), spell);
    for (const w of worn) if (!named.has(w.name.toLowerCase())) this.armorSkip.add(w.guid);
    return true;
  }

  private families(): typeof this.fam {
    const t = this.api.spellTableData();
    if (!t) return null;
    if (t !== this.table || !this.fam) {
      this.table = t;
      const skills = this.api.skillList().map((s) => [s.id, s.name] as [number, string]);
      this.fam = { buff: buildBuffFamilies(t, skills), recharge: buildRechargeFamilies(t), combat: buildCombatFamilies(t) };
    }
    return this.fam;
  }

  /**
   * Spells you know, less those that need an Excluded Scarab Type (the Consumables tab: such spells
   * are not cast) and, once the server is known to charge components, those your pack can't pay for:
   * every planner (buffs, debuffs, attacks, recharges) then takes the best tier you can pay for, as
   * VTank's BuffCastability drops to a lower tier.
   */
  private spells(excluded: string[] = []): PlanSpell[] {
    const no = new Set(excluded.map((x) => x.trim().toLowerCase()).filter(Boolean));
    const pay = this.componentsRequired ? componentPurse(this.api.inventory()) : null;
    return this.api.spells('', 1000).flatMap((s) => (s.category === undefined || s.power === undefined || (no.size && this.api.spellComponents(s.id).some((c) => no.has(c.toLowerCase()))) || (pay && !pay(this.api.spellComponents(s.id))) ? [] : [{
      id: s.id, name: s.name, school: fullSchoolName(s.school), category: s.category, power: s.power, self: !!s.self, buff: !!s.buff, duration: s.duration ?? 0,
      ...(s.range !== undefined ? { range: s.range } : {}),
    }]));
  }

  private skills(): PlanSkill[] { return this.api.skillList(); }

  /**
   * Carried items as the planners read them (examined ints / floats / data ids and spells when known).
   * `examine`: names (the Items and Consumables tabs) to examine quietly too, when not filtering by name.
   */
  private items(names?: string[], examine: string[] = []): PlanItem[] {
    const want = names ? new Set(names.map((n) => n.toLowerCase())) : null;
    const look = new Set(examine.map((n) => n.toLowerCase()));
    const ids = this.spellIdsByName();
    return this.api.inventory().filter((i) => !want || want.has(i.name.toLowerCase())).map((i) => {
      const d = this.api.itemData(i.guid);
      // Listed items, and carried ammunition and wielded launchers (their AmmoType / DamageType pick the arrows), are examined quietly once.
      // So are wielded melee weapons: their DamageType / AttackType / WeaponType set the power bar (attackPower.ts).
      const wantsData = want || look.has(i.name.toLowerCase()) || /MissileAmmo/.test(i.fits ?? i.slot ?? '') || ((i.itemType ?? 0) & 0x100) !== 0 || (i.where === 'equipped' && ((i.itemType ?? 0) & 0x1) !== 0);
      if (!d && wantsData && !this.asked.has(i.guid)) { this.asked.add(i.guid); void this.api.appraise(i.guid, { quiet: true }); }
      // The examination's spells by id (a weapon's cast-on-strike, a grenade's; itemDebuffs.ts).
      const spells = d?.spells?.length && ids ? d.spells.flatMap((n) => { const id = ids.get(n.toLowerCase()); return id === undefined ? [] : [id]; }) : [];
      return {
        guid: i.guid, name: i.name, ...(i.stack !== undefined ? { stack: i.stack } : {}), ...(d ? { ints: d.int, floats: d.float, dids: d.did } : {}), ...(i.where === 'equipped' ? { equipped: true } : {}),
        ...(i.uiEffects ? { uiEffects: i.uiEffects } : {}), ...(i.itemType ? { itemType: i.itemType } : {}), ...(i.fits ? { fits: i.fits } : {}), ...(i.slot ? { slot: i.slot } : {}), ...(i.ammoType ? { ammoType: i.ammoType } : {}),
        ...(spells.length ? { spells } : {}),
      };
    });
  }

  /** Spell ids by lower-case name, from the era's spell table (an examination lists spells by name). */
  private spellIdsByName(): Map<string, number> | null {
    const t = this.api.spellTableData();
    if (!t) return null;
    if (this.idsFor !== t) {
      this.idsFor = t;
      this.idsByName = new Map();
      for (const [id, sp] of t.spells) if (!this.idsByName.has(sp.name.toLowerCase())) this.idsByName.set(sp.name.toLowerCase(), id);
    }
    return this.idsByName;
  }
  private idsFor: unknown = null;
  private idsByName = new Map<string, number>();

  private manaLookAt = -Infinity;
  /** Recharge boost: on until this time (ms) after the macro switched to magic mode to recharge. */
  private boostUntil = -Infinity;
  /** Pea splits sent, by pea guid (the inventory shows the new components a moment later). */
  private splitAt = new Map<number, number>();

  /**
   * VirindiTank's pea splitting at one tier (SpellCompMin-Critical before
   * healing, -Normal after buffing, -Idle when idle): the Splitting Tool used
   * on a pea, as a player does (peaPlan.ts). The same pea is not split again
   * for 5 s, while the server's answer comes back.
   */
  splitStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>, tier: SplitTier): VtStep | null {
    if (!p.vtank.consumables.length) return null;
    const t = this.now();
    for (const [g, at] of this.splitAt) if (t - at >= 5_000) this.splitAt.delete(g);
    const inv = this.api.inventory().filter((i) => !this.splitAt.has(i.guid));
    const s = planPeaSplit({ inventory: inv, listed: p.vtank.consumables, settings, tier });
    if (!s) return null;
    this.splitAt.set(s.pea.guid, t);
    return { label: `split peas (${tier}): ${s.why}`, run: async () => this.api.useOn(s.tool.guid, s.pea.guid) };
  }

  /**
   * Recharge boost (RechargeBoostTimeSeconds, RechargeBoostAmount,
   * ClearLevelBoostFlagOnCast): the points a vital may sit above its level and
   * still be recharged, while in magic mode within the boost time of the
   * switch the recharge asked for; 0 otherwise.
   */
  private boostPoints(settings: Record<string, string | number | boolean>, stance: Stance): number {
    if (stance !== 'magic' || this.now() >= this.boostUntil) return 0;
    return Math.max(0, Number(opt(settings, 'RechargeBoostAmount')) || 0);
  }
  /** A spell went out: with ClearLevelBoostFlagOnCast, the boost was for that first cast only. */
  private castSpent(settings: Record<string, string | number | boolean>): void {
    if (opt(settings, 'ClearLevelBoostFlagOnCast') === true) this.boostUntil = -Infinity;
  }

  /**
   * VirindiTank's RefillWornMana (with M. Charges When Off also while the
   * macro is switched off): a worn item below RefillWornMana-Item-ManaPercent
   * of its mana gets a charged mana stone or charge from the Consumables tab
   * used on you, which pours mana into everything you wear (ACE
   * ManaStone.HandleActionUseOnTarget). Worn items' mana is read from their
   * examination (ItemCurMana 107 / ItemMaxMana 108), refreshed every 90 s.
   */
  manaStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>): VtStep | null {
    p = this.resolved(p);
    if (!(settings.RefillWornMana === true || settings.RefillWornMana === 'true')) return null;
    const pct = Number(settings['RefillWornMana-Item-ManaPercent']) || 33;
    // A stone used since its last examination may be spent (ACE ManaStone: ItemCurMana goes away, or the
    // stone is destroyed): it waits for a fresh examination, asked for 2 s after the use, once the server has
    // applied it. Stones are always used on you, never on an item (an empty stone used on an item drains it).
    const t = this.now();
    for (const [g, u] of this.usedStones) {
      const d = this.api.itemData(g);
      if (!this.api.inventory().some((i) => i.guid === g) || (d && d !== u.data)) this.usedStones.delete(g);
      else if (!u.asked && t - u.at >= 2000) { u.asked = true; void this.api.appraise(g, { quiet: true }); }
      else if (u.asked && t - u.at >= 15_000) { u.at = t; u.asked = false; }
    }
    // After a use, the worn items are looked at again (2 s on) before anything else is used.
    if (this.now() - this.manaUsedAt < 4000) return null;
    const worn = this.api.inventory().filter((i) => i.where === 'equipped');
    if (this.now() - this.manaLookAt > 90_000) { this.manaLookAt = this.now(); for (const w of worn) void this.api.appraise(w.guid, { quiet: true }); }
    // "At or below" the percentage (VTank's RefillWornMana-Item-ManaPercent).
    const low = worn.find((w) => { const d = this.api.itemData(w.guid); const cur = d?.int[107]; const max = d?.int[108]; return cur !== undefined && max ? (cur / max) * 100 <= pct : false; });
    if (!low) return null;
    const stone = this.items(p.vtank.consumables).find((i) => !i.equipped && !this.usedStones.has(i.guid) && (i.ints?.[107] ?? 0) > 0);
    if (!stone) return null;
    return { label: `mana: ${low.name} is low, using ${stone.name}`, run: async () => {
      // The worn items' mana will change: look again in 2 s.
      this.manaUsedAt = this.now();
      this.manaLookAt = this.manaUsedAt - 88_000;
      this.usedStones.set(stone.guid, { at: this.now(), data: this.api.itemData(stone.guid), asked: false });
      return this.api.useOn(stone.guid, 'self');
    } };
  }
  /** When a stone or charge was last used (the worn items' mana is looked at again before the next). */
  private manaUsedAt = -Infinity;
  /** Mana stones used on you, waiting for the examination that says whether they still hold mana. */
  private usedStones = new Map<number, { at: number; data: unknown; asked: boolean }>();

  /** Pet range (metres): Monster Range, or Custom Pet Range with PetRangeMode 1. */
  static petRange(settings: Record<string, string | number | boolean>): number {
    return Number(settings.PetRangeMode) === 1 ? Number(settings.PetCustomRange) || 5 : num(settings.AttackDistance, vtOption('AttackDistance')!.default as number);
  }

  /**
   * VirindiTank's Summon Pets (facts from MOSS SummonPetRule, PetAutomation): with combat on, Summoning
   * (skill 54) trained and at least Pet Min. Monsters within pet range (counted for summoning: PetDmg not
   * None), the best usable essence on the Items tab for the chosen monster (combatPlan planPet: usable,
   * ranked by element) is used. Held back while:
   * - the summoning cooldown runs (the essence's SharedCooldown, PropertyInt 280: the client's cooldown
   *   enchantment, or the macro's own clock from its CooldownDuration);
   * - the server hasn't answered the last summon (5 s at most);
   * - a refused summon waits 1 s before it is tried again;
   * - there is no room 3 m ahead for the pet to appear (the client's collision sweep; can't tell = room).
   * Before 2026-10-11 a summon simply waited 45 s, whatever the server said. Summoning exists only where
   * the era's skill table has it: an era without essences has no device, and the window hides the controls.
   */
  private petStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>, base: Omit<CombatInput, 'monsters'>, monsters: CombatMonster[]): VtStep | null {
    if (!(settings.SummonPets === true || settings.SummonPets === 'true')) return null;
    const t = this.now();
    if (t < this.petRetryAt) return null;
    const summoning = base.skills.find((k) => k.id === 54);
    if (!summoning || summoning.training === 'untrained') return null;
    const range = VtMacro.petRange(settings);
    const devices = this.items(p.vtank.items.map((x) => x.name)).filter((i) => i.ints?.[266] !== undefined);
    // The cooldown every essence shares.
    for (const d of devices) {
      const cd = itemCooldown(d);
      if (cd && (this.api.cooldownRemaining(cd.id) > 0 || (this.cooldownUntil.get(cd.id) ?? 0) > t)) return null;
    }
    const me = this.api.self();
    const mastery = this.api.charInt(362);
    const pet = planPet({ ...base, monsters }, { range, minMonsters: Math.max(1, Number(settings.PetMonsterDensity) || 1), devices, ...(me ? { level: me.level } : {}), ...(mastery !== undefined ? { mastery } : {}) });
    if (!pet) return null;
    if (this.api.roomAhead(3) === false) return null;
    return { label: `pet: ${pet.why}`, run: async () => {
      // Held until the server answers (api.use waits for it); a refusal waits 1 s, a summon its cooldown.
      this.petRetryAt = this.now() + 5_000;
      const res = await this.api.use(pet.device.guid);
      if (!res.ok) { this.petRetryAt = this.now() + 1_000; return res; }
      const cd = itemCooldown(pet.device);
      if (cd) this.cooldownUntil.set(cd.id, this.now() + cd.seconds * 1000);
      this.petRetryAt = this.now();
      return res;
    } };
  }
  /** When Summon Pets may try again (the server's answer to the last summon, a refusal's 1 s). */
  private petRetryAt = -Infinity;

  /**
   * VirindiTank's pet refills (petRefill.ts): an Items-tab essence down to `option`'s charge count is
   * topped up with an Encapsulated Spirit in peace mode. A refused refill waits 1 s.
   */
  private refillStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>, stance: Stance, option: 'PetRefillCount-Normal' | 'PetRefillCount-Idle'): VtStep | null {
    if (!p.vtank.items.length || this.now() < this.refillRetryAt) return null;
    const devices = this.items(p.vtank.items.map((x) => x.name)).filter((i) => i.ints?.[266] !== undefined);
    if (!devices.length) return null;
    const r = planPetRefill(devices, this.items(), Number(opt(settings, option)) || 0);
    if (!r) return null;
    if (stance !== 'peace') return { label: `pet refill: ${r.why}: switching to peace mode`, run: () => this.switchMode(p, 'peace') };
    return { label: `pet refill: ${r.why}`, run: async () => {
      const res = this.api.useOn(r.spirit.guid, r.device.guid);
      // The essence's charges change on the server's answer: look again shortly, and after a refusal wait 1 s.
      this.refillRetryAt = this.now() + (res.ok ? 2_000 : 1_000);
      this.asked.delete(r.device.guid);
      setTimeout(() => void this.api.appraise(r.device.guid, { quiet: true }), 1_500);
      return res;
    } };
  }
  private refillRetryAt = -Infinity;
  /** VirindiTank's Auto Fellow Mgmt (its Fellowship Commands; fellowManager.ts). */
  readonly fellows: FellowManager;
  private fellowStep(settings: Record<string, string | number | boolean>): VtStep | null {
    return this.fellows.step(settings.AutoFellowManagement === true || settings.AutoFellowManagement === 'true');
  }

  /**
   * VirindiTank's Use Dispel Items / Cast Dispel Self: "when a level 7 vuln is
   * present on your character". A vuln is an elemental Vulnerability family
   * (the combat planner's, from the era's table); its level is its power's
   * rank in the family. Cast Dispel Self casts the best self dispel of Life
   * Magic you know (spells whose description dispels negative Life Magic);
   * Use Dispel Items uses a carried item whose spell is such a dispel.
   */
  private dispelStep(fam: NonNullable<typeof this.fam>, settings: Record<string, string | number | boolean>, spells: PlanSpell[], skills: PlanSkill[]): VtStep | null {
    const useItems = settings.UseDispelItems === true || settings.UseDispelItems === 'true';
    const castSelf = settings.CastDispelSelf === true || settings.CastDispelSelf === 'true';
    if (!useItems && !castSelf) return null;
    const t = this.api.spellTableData();
    if (!t) return null;
    const vulnCats = new Map<number, number[]>();
    for (const f of Object.values(fam.combat.vuln)) {
      if (!f) continue;
      vulnCats.set(f.category, [...new Set([...f.ids].map((id) => t.spells.get(id)?.power ?? 0))].sort((a, b) => a - b));
    }
    const bad = this.api.activeSpellsNow().find((e) => e.category !== undefined && e.power !== undefined && vulnCats.has(e.category) && vulnCats.get(e.category)!.indexOf(e.power) >= 6);
    if (!bad) return null;
    const isDispel = isLifeDispel;
    if (castSelf) {
      const life = skills.find((s) => /^life magic$/i.test(s.name));
      const th = Number(settings['SpellDiffExcessThreshold-Hunt']) || 25;
      const best = spells.filter((s) => s.self && isDispel(t.spells.get(s.id)?.desc ?? '') && (!life || s.power + th <= life.buffed)).sort((a, b) => b.power - a.power)[0];
      if (best) return { label: `dispel: ${bad.name} on you`, run: () => this.cast(best.id, 'self') };
    }
    if (useItems) {
      for (const i of this.api.inventory()) {
        if (i.where === 'equipped') continue;
        const d = this.api.itemData(i.guid);
        if (!d) { if (/gem|food|potion|misc/i.test(i.type ?? '') && !this.asked.has(i.guid)) { this.asked.add(i.guid); void this.api.appraise(i.guid, { quiet: true }); } continue; }
        const sid = d.did?.[28];
        if (sid && isDispel(t.spells.get(sid)?.desc ?? '')) return { label: `dispel: ${bad.name} on you, using ${i.name}`, run: async () => this.api.useOn(i.guid, 'self') };
      }
    }
    return null;
  }

  /** What the macro should do now, or null. `range`: Monster Range (metres). */
  /** The routine's hold-position (beyond VTank, Jake 2026-10-12): a monster this refuses is no target. */
  allowTarget?: (o: { dist: number; bearing: number }) => boolean;

  decide(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>, ctx: { combat: boolean; buffing: boolean; idle: boolean }): VtStep | null {
    p = this.resolved(p);
    const fam = this.families();
    const range = num(settings.AttackDistance, vtOption('AttackDistance')!.default as number);
    const petRange = VtMacro.petRange(settings);
    const snap = this.api.snapshot({ radius: Math.max(range, petRange, 60), max: 40 });
    const me = snap.me;
    if (!me) return null;
    // Death strips item enchantments (VTank's death handler clears its item timers too).
    if (me.dead) { this.itemTimers.clear(); this.targets.clear(); this.gate.reset(); this.lastTarget = null; return null; }
    this.lastSettings = settings;
    this.itemTimers.bind({ guid: me.guid, name: me.name });
    this.itemTimers.expire();
    // Auto Fellow Mgmt needs no spell data: before the spell table is loaded it is all there is to do.
    if (!fam) return this.fellowStep(settings);
    // UtilityBelt cast sharing: debuffs your other clients landed count as cast here (ubNet.ts).
    const net = activeUbNet();
    if (net) this.takeSharedCasts(net);
    const stance: Stance = me.combatMode === 'unknown' ? 'peace' : me.combatMode;
    // Magic mode refused (no wand): spells are left out for a while (toMagic).
    const spells = this.now() < this.noMagicUntil ? [] : this.spells(p.vtank.excludedScarabs);
    const skills = this.skills();
    for (const [g, until] of this.blocked) if (until <= this.now()) this.blocked.delete(g);
    this.noteFights(settings);
    // Blacklisted monsters and ghosts are no targets (targetTracker.ts).
    const ts = trackerSettings(settings);
    const seen = snap.nearby.filter((o) => o.kind === 'monster' && !o.dying);
    this.targets.observe(seen, ts);
    const ghost = this.targets.checkHp((name) => (this.monsterFacts?.(name)?.maxHealth ?? 0) > 0, ts);
    if (ghost) this.notices.push(ghost);
    if (this.notices.length) {
      const said = this.notices.splice(0);
      return { label: 'combat', run: async () => ({ ok: true, message: said.join('; ') }) };
    }
    for (const g of this.magicImmune) if (!seen.some((o) => o.guid === g)) this.magicImmune.delete(g);
    // UseProjectileAwareness: each monster within Monster Range gets the client's line-of-fire test (a bolt or an
    // arrow at it would hit a wall, the ground or an object first); the planner then fights another (combatPlan).
    const aware = opt(settings, 'UseProjectileAwareness') === true;
    const near: CombatMonster[] = seen.filter((o) => !this.blocked.has(o.guid) && !this.targets.excluded(o.guid) && (this.allowTarget?.(o) ?? true)).map((o) => {
      const blow = this.blows.get(o.guid);
      const lof = aware && o.dist <= range ? this.lineOfFire(o.guid) : null;
      return {
        guid: o.guid, name: o.name, dist: o.dist, relBearing: o.relBearing, ...(o.health !== undefined ? { health: o.health } : {}), ...(blow !== undefined ? { lastDamage: blow } : {}),
        ...(lof ? { blocked: true } : {}), ...(this.magicImmune.has(o.guid) ? { magicImmune: true } : {}),
      };
    });
    const monsters = near.filter((m) => m.dist <= range);
    const petMonsters = near.filter((m) => m.dist <= petRange);
    const hasTarget = ctx.combat && monsters.length > 0;

    // 1. Critical pea splitting (SpellCompMin-Critical: above healing).
    const critical = this.splitStep(p, settings, 'critical');
    if (critical) return critical;

    // 2. Recharge.
    const r = planRecharge({
      vitals: { health: { cur: me.health.cur, max: me.health.max }, stamina: { cur: me.stamina.cur, max: me.stamina.max }, mana: { cur: me.mana.cur, max: me.mana.max } },
      stance, hasTarget, settings, spells, skills, consumables: this.items(p.vtank.consumables), rechargeFamilies: fam.recharge,
      fellows: this.withNetFellows(this.api.fellowsNear(), snap.nearby, me.guid, net), boost: this.boostPoints(settings, stance),
      // Items-tab casters whose own spell recharges (wands, Healer's Heart): rechargePlan's caster items.
      casterItems: this.items(p.vtank.items.map((x) => x.name)).filter((i) => ((i.itemType ?? 0) & 0x8000) !== 0), level: me.level,
    });
    if (r) {
      if (r.kind === 'item') return r.wield
        ? { label: `recharge: ${r.why}: wielding ${r.item.name}`, run: async () => this.api.equip(r.item.guid) }
        : { label: `recharge: ${r.why}`, run: async () => this.useCaster(r.item.guid, r.target ?? 'self', settings) };
      if (r.kind === 'cast') return { label: `recharge: ${r.why}`, run: () => { this.castSpent(settings); return this.cast(r.spell.id, r.target ?? 'self'); } };
      if (r.kind === 'use') return { label: `recharge: ${r.why}`, run: async () => this.api.useOn(r.item.guid, 'self') };
      // Switching to magic mode to recharge starts the recharge boost.
      if (r.to === 'magic') return this.toMagic(p, `recharge: ${r.why}`, () => { this.boostUntil = this.now() + Math.max(0, Number(opt(settings, 'RechargeBoostTimeSeconds')) || 0) * 1000; });
      return { label: `recharge: ${r.why}`, run: () => this.switchMode(p, r.to) };
    }

    // 3. Worn items' mana.
    const mana = this.manaStep(p, settings);
    if (mana) return mana;

    // 4. Buffs whose time left is below RebuffTimeRemainingSeconds (a Force Buff round first), a monster
    // in range or not: VTank's BuffSelfNormal sits above Attack. Then SpellCompMin-Normal pea splitting.
    const buff = this.buffStep(p, settings, ctx, fam, spells, skills, me.level, stance, false);
    if (buff) return buff;
    const normalSplit = this.splitStep(p, settings, 'normal');
    if (normalSplit) return normalSplit;

    // 5. A level-7 vuln on you (Cast Dispel Self, Use Dispel Items): VTank's POSTBUFF rules.
    const dispel = this.dispelStep(fam, settings, spells, skills);
    if (dispel) return dispel;

    // 5b. A summoning essence down to PetRefillCount-Normal charges (VTank's RefillPetChargesNormal, above the fellowship manager).
    const refill = this.refillStep(p, settings, stance, 'PetRefillCount-Normal');
    if (refill) return refill;

    // 6. Auto Fellow Mgmt: a /tell command while you lead the fellowship.
    const fellow = this.fellowStep(settings);
    if (fellow) return fellow;

    // 7. A pet when the fight is big enough, then combat.
    const combatBase = (): Omit<CombatInput, 'monsters'> => {
      const wieldedItems = this.api.inventory().filter((i) => i.where === 'equipped');
      const itemNames = p.vtank.items.map((x) => x.name);
      const table = this.api.spellTableData();
      return {
        rows: p.vtank.monsters, spells, skills, items: this.items(undefined, [...itemNames, ...p.vtank.consumables]), itemNames,
        wielded: { weapon: wieldedItems.find((i) => /weapon|wand|staff|orb|caster/i.test(`${i.type ?? ''} ${i.slot ?? ''}`))?.name, offhand: wieldedItems.find((i) => /shield/i.test(`${i.type ?? ''} ${i.slot ?? ''}`))?.name },
        stance, settings, castLog: this.castLog, now: this.now(), selectedGuid: this.api.selectedGuid(), families: fam.combat,
        ...(this.monsterFacts ? { monsterFacts: this.monsterFacts } : {}),
        ...(this.specialAmmo?.size ? { specialAmmo: (n: string) => this.specialAmmo?.get(n.toLowerCase()) ?? 0 } : {}),
        lastTarget: this.lastTarget,
        // The Items tab's Hands column (an entry's by its object id when it has one, else by name).
        hands: (item) => p.vtank.items.find((e) => e.hands !== undefined && vtItemIs(e, item))?.hands,
        // Item debuffs (casters, cast-on-strike weapons, grenades) read their spells from the era's table; Drain Auto plans with your health.
        ...(table ? { spellInfo: (id: number) => table.spells.get(id) } : {}),
        consumableNames: p.vtank.consumables,
        vitals: { health: me.health.cur, maxHealth: me.health.max },
        ...(this.drainRows ? { drainTable: this.drainRows } : {}),
      };
    };
    // A pet counts every monster within pet range, which may reach past Monster Range.
    if (ctx.combat && petMonsters.length) { const pet = this.petStep(p, settings, combatBase(), petMonsters); if (pet) return pet; }

    if (hasTarget) {
      const loading = this.monstersLoading;
      if (loading) return { label: 'combat: reading the monster table', run: async () => { await loading; return { ok: true, message: 'monster table read' }; } };
      const c = planCombat({ ...combatBase(), monsters });
      if (c) {
        const tm = monsters.find((m) => m.guid === (c as { target?: number }).target);
        const name = tm?.name;
        if (name && 'target' in c) this.fought.set(c.target, { name, at: this.now() });
        // The monster acted on: the sticky last target, and the one the HP tracker follows.
        const acted = (guid: number, attack: boolean) => { this.lastTarget = guid; this.lastWasAttack = attack; if (tm) this.targets.engage(guid, tm.name, tm.health); };
        // UseBreakableTurnTo: turn to face the monster ourselves before a bolt, arc, streak or martyr (VTank turns with its
        // own movement, which it can drop when it changes its mind, rather than the cast's own turn; within 2° is facing).
        // One turn per monster every 3 s: right beside it (1 m) the bearing never settles within 2°, and the macro had
        // turned for ever without casting (Sparring Golem, 2026-10-11); the cast turns you itself after that.
        const turnedAt = this.turnedAt.get(c.kind === 'cast' ? c.target : -1) ?? -Infinity;
        if (c.kind === 'cast' && c.projectile && tm && Math.abs(tm.relBearing) > 2 && opt(settings, 'UseBreakableTurnTo') === true && this.now() - turnedAt > 3000) {
          this.turnedAt.set(c.target, this.now());
          return { label: `combat: turning to face ${tm.name} for ${c.spell.name}`, run: async () => this.api.turn(c.target) };
        }
        if (c.kind === 'use-item') return { label: `combat: ${c.why}`, run: async () => {
          // A caster's own debuff, used on the monster; logged when the server says "<caster> cast <spell> on <monster>".
          acted(c.target, false);
          const since = this.api.currentSeq();
          const res = this.useCaster(c.item.guid, c.target, settings);
          if (!res.ok) return res;
          for (let w = 0; w < 15 && !this.castLog.some((x) => x.guid === c.target && x.category === c.spell.category && x.at >= this.now() - 4000); w++) {
            await new Promise((ok) => setTimeout(ok, 200));
            this.noteFights(settings);
          }
          const said = this.api.eventsSince(since).filter((e) => e.type === 'chat').map((e) => e.text);
          return { ok: res.ok, message: [res.message, ...said.map((l) => `  ${l}`)].join('\n') };
        } };
        if (c.kind === 'cast') return { label: `combat: ${c.why}`, run: async () => {
          this.castSpent(settings);
          acted(c.target, false);
          const res = await this.cast(c.spell.id, c.target);
          // A wall or the ground in the way: leave this one for 15 s rather than casting into the wall again.
          if (!res.ok && /no line of fire/i.test(res.message)) this.blocked.set(c.target, this.now() + 15_000);
          this.noteCastAt(c.target, name ?? `#${c.target.toString(16)}`, tm?.health, res, c.spell.name, ts);
          // A debuff counts only once the server says it went on ("You cast Imperil Other I on Drudge
          // Skulker"): a resist, a fizzle or no answer leaves it due, so it is cast again (VTank
          // DebuffScheduler records only a success). Before 2026-10-11 a resisted debuff was logged for
          // its whole duration and never recast.
          if (c.spell.duration > 0 && castConfirmed(res, c.spell.name)) {
            this.castLog.push({ guid: c.target, category: c.spell.category, at: this.now(), duration: c.spell.duration });
            activeUbNet()?.shareCast(c.target, c.spell.id, c.spell.duration * 1000);
          }
          if (this.castLog.length > 200) this.castLog.splice(0, this.castLog.length - 200);
          return res;
        } };
        if (c.kind === 'attack') return { label: `combat: ${c.why}`, run: async () => {
          // One attack order per target: sending it again restarts the run-up. Then wait for it to end
          // (or 10 s, so recharging gets a look in); a fresh decision on the same target just waits on.
          const since = this.api.currentSeq();
          const same = this.lastAttack && this.lastAttack.guid === c.target && this.now() - this.lastAttack.at < 60_000;
          // AutoAttackPower / UseRecklessness: the bar for the row's element and the wielded weapon (attackPower.ts).
          // A swing or throw for a weapon's or grenade's debuff is logged when the server says it went on (noteSpellLine).
          const power = same ? 'bar' : autoAttackPower({ element: c.element ?? null, items: this.items(), settings, skills });
          acted(c.target, true);
          const res = same ? { ok: true, message: `still fighting #${c.target.toString(16)}` } : this.api.attack(c.target, { height: vtAttackHeight(settings), power, far: true });
          if (!same && res.ok) this.lastAttack = { guid: c.target, at: this.now() };
          if (!res.ok) return res;
          const ev = await this.api.waitFor({ types: ['target-died', 'target-lost', 'death', 'vitals-low'] }, 10_000);
          const end = ev.find((e) => e.seq > since && (e.guid === c.target || e.type === 'death' || e.type === 'vitals-low'));
          if (end && end.type !== 'vitals-low') this.lastAttack = null;
          return res;
        } };
        // A weapon or mode change ends the server's attack: the next attack order is sent afresh (a grenade or a
        // cast-on-strike weapon is wielded mid-fight for its debuff, then the row's weapon again).
        if (c.kind === 'equip') return { label: `combat: ${c.why}`, run: async () => { this.lastAttack = null; return this.api.equip(c.item.guid); } };
        if (c.to === 'magic') return this.toMagic(p, `combat: ${c.why}`);
        return { label: `combat: ${c.why}`, run: () => { this.lastAttack = null; return this.switchMode(p, c.to); } };
      }
    }

    // 8. Nothing to fight: crafting (AutoCraftItems, in peace mode), SpellCompMin-Idle pea splitting and
    // the idle buff top-off (IdleBuffTopoff: VTank's BuffSelfIdle, after Attack).
    if (hasTarget) return null;
    const craft = this.craftStep(p, settings, stance, ctx.idle);
    if (craft) return craft;
    if (!ctx.idle) return null;
    // VTank's idle band: SplitPeasIdle, CraftFoodIdle, RefillPetChargesIdle, then BuffSelfIdle.
    return this.splitStep(p, settings, 'idle') ?? this.refillStep(p, settings, stance, 'PetRefillCount-Idle') ?? this.buffStep(p, settings, ctx, fam, spells, skills, me.level, stance, true);
  }

  /**
   * VirindiTank's buffing, in its two places in the rule list: `idleSlot` false is BuffSelfNormal (a buff
   * below RebuffTimeRemainingSeconds, and a Force Buff round), above Attack; true is BuffSelfIdle (the
   * IdleBuffTopoff top-off), when idle. Casting needs magic mode (a caster wielded on ACE): that is the
   * step first. Buffs on items (banes, impenetrability, weapon spells) are timed by the macro's own
   * item timers (itemBuffLedger.ts), as the effects list shows only your own enchantments.
   */
  private buffStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>, ctx: { buffing: boolean; idle: boolean }, fam: NonNullable<typeof this.fam>, spells: PlanSpell[], skills: PlanSkill[], level: number, stance: Stance, idleSlot: boolean): VtStep | null {
    if (!ctx.buffing && !(this.forced && !idleSlot)) return null;
    const weapon = this.api.inventory().find((i) => i.where === 'equipped' && /weapon|wand|staff|orb|caster/i.test(`${i.type ?? ''} ${i.slot ?? ''}`));
    const wielded = !weapon ? null : /missile|bow/i.test(`${weapon.type ?? ''} ${weapon.slot ?? ''}`) ? 'missile' : /wand|staff|orb|caster/i.test(`${weapon.type ?? ''} ${weapon.slot ?? ''}`) ? 'caster' : 'melee';
    const weaponRef: ItemRef | null = weapon ? { guid: weapon.guid, name: weapon.name } : null;
    const b = planBuffs({
      spells, skills, settings, idle: idleSlot && ctx.idle, families: fam.buff, level, wielded,
      active: this.api.activeSpellsNow(), extraBuffs: p.vtank.extraBuffs, blacklistedBuffs: p.vtank.blacklistedBuffs,
      recastExtra: this.now() < this.recastUntil ? Math.max(0, Number(opt(settings, 'BuffCastRecast_Seconds')) || 0) : 0,
      itemRemaining: (target, spell) => (target === 'weapon'
        ? (weaponRef ? this.itemTimers.remainingOn(weaponRef, spell.category, spell.power) : null)
        : this.itemTimers.remainingOnAll(this.wornVestments(), spell.category, spell.power)),
    });
    // Add (no buffs) on the Items tab: that weapon gets no auras (a Force Buff round included).
    // By the entry's object id when it has one: of two same-named weapons only the listed one goes without.
    if (weapon && p.vtank.items.some((x) => x.noBuffs && vtItemIs(x, weapon))) { b.due = b.due.filter((x) => x.target !== 'weapon'); b.wanted = b.wanted.filter((x) => x.target !== 'weapon'); }
    // Nothing worn for an armor buff to go on: the server would enchant nothing, so it is never due.
    if (!this.wornVestments().length) { b.due = b.due.filter((x) => x.target !== 'armor'); b.wanted = b.wanted.filter((x) => x.target !== 'armor'); }
    /** An item buff: a bane on the armor, or a weapon spell cast at the weapon (not an Aura on yourself). */
    const onItem = (x: { target: string; spell: PlanSpell }): 'weapon' | 'armor' | null => (x.target === 'armor' ? 'armor' : x.target === 'weapon' && weapon && !x.spell.self ? 'weapon' : null);
    const toMagicFirst = (label: string): VtStep | null => (stance !== 'magic' ? this.toMagic(p, `${label}: switching to magic mode to cast`) : null);
    if (this.forced && !idleSlot) {
      const f = this.forced;
      const nx = b.wanted.find((w) => !f.done.has(w.spell.category));
      if (!nx) this.forced = null;
      else {
        const mode = toMagicFirst(`force buff: ${nx.why}`);
        if (mode) return mode;
        const category = nx.spell.category;
        const target = nx.target === 'weapon' && weapon && !nx.spell.self ? weapon.guid : 'self';
        const item = onItem(nx);
        return { label: `force buff: ${nx.why}`, run: async () => {
          const sentAt = this.now();
          this.castSpent(settings);
          const res = await this.castBuff(nx.spell, target, settings);
          if (this.forced !== f) return res; // cancelled (or restarted) meanwhile
          // A buff on an item is done on the server's success line naming it (and goes in the item timers).
          if (item) {
            if (this.noteItemBuff(res, nx.spell, item, weaponRef)) { f.done.add(category); return res; }
          } else {
            // Done only once the enchantment is on: refreshed past what was left before the cast.
            // What was left then has run down since; a recast puts the clock back up past that.
            const left = (): number | null => (nx.remaining === null ? null : nx.remaining - (this.now() - sentAt) / 1000);
            let after = this.familyRemaining(category, nx.spell.power);
            for (let w = 0; w < 10 && res.ok && !landed(left(), after); w++) { await new Promise((ok) => setTimeout(ok, 200)); after = this.familyRemaining(category, nx.spell.power); }
            const unseen = nx.remaining === null && after === null && castConfirmed(res, nx.spell.name);
            const permanent = res.ok && nx.remaining === Infinity && after === Infinity;
            if (landed(left(), after) || unseen || permanent) { f.done.add(category); return res; }
          }
          const tries = (f.tries.get(category) ?? 0) + 1;
          f.tries.set(category, tries);
          if (tries >= FORCE_TRIES) { f.done.add(category); return { ok: false, message: `force buff: ${nx.spell.name} didn't take after ${tries} casts; moving on` }; }
          return { ok: false, message: `force buff: ${nx.spell.name} didn't take (${res.ok ? 'no enchantment seen' : res.message.split('\n').slice(1).join(' ').trim() || 'not cast'}); casting it again` };
        } };
      }
    }
    // A family whose casts keep not taking (no answer, a refusal, fizzles) rests a minute after three in a
    // row, so a buff that can't go on never holds the fight up for good (buffs now come before Attack).
    const t = this.now();
    const next = ctx.buffing ? b.due.find((x) => !((this.buffMisses.get(x.spell.category)?.until ?? 0) > t)) : undefined;
    // No spell due: a buff gem, food or potion (VTank tries its consumables after its spells).
    if (!next) return ctx.buffing ? this.buffItemStep(p, settings, idleSlot && ctx.idle, skills, level) : null;
    const mode = toMagicFirst(`buff: ${next.why}`);
    if (mode) return mode;
    const target = next.target === 'weapon' && weapon && !next.spell.self ? weapon.guid : 'self';
    const item = onItem(next);
    return { label: `buff: ${next.why}`, run: async () => {
      this.castSpent(settings);
      const res = await this.castBuff(next.spell, target, settings);
      const ok = item ? this.noteItemBuff(res, next.spell, item, weaponRef) : castConfirmed(res, next.spell.name);
      const cat = next.spell.category;
      if (ok) this.buffMisses.delete(cat);
      else if (!res.message.startsWith(MANA_WAIT)) {
        const m = this.buffMisses.get(cat) ?? { n: 0, until: 0 };
        m.n++;
        if (m.n >= BUFF_TRIES) { m.n = 0; m.until = this.now() + 60_000; }
        this.buffMisses.set(cat, m);
      }
      return res;
    } };
  }
  /**
   * What a combat cast's reply says about its target (targetTracker.ts): "invalid target" blacklists it
   * at once. No result (no answer, or only "Your missile attack hit the environment.": a bolt the world
   * stopped) is a miss, as VTank's result timeout is; no answer at all is also a silent cast (the ghost
   * count). Any answer clears the silence; a cast that went on, or a bolt's damage line, clears the
   * misses. A cast the client never sent (no line of fire, the target gone) is no attempt.
   */
  private noteCastAt(guid: number, name: string, health: number | undefined, res: AgentResult, spellName: string, ts: TrackerSettings): void {
    const lines = castReplyLines(res);
    if (lines.some((l) => INVALID_TARGET.test(l))) { this.notices.push(this.targets.invalid(guid, name, ts)); return; }
    if (!res.ok && !lines.length) return;
    if (lines.length) this.targets.answered(guid);
    else {
      const ghost = this.targets.silent(guid, name, health, ts);
      if (ghost) this.notices.push(ghost);
    }
    if (castConfirmed(res, spellName) || lines.some((l) => blowPoints(l, name) !== null)) { this.targets.reached(guid); return; }
    if (lines.some((l) => !HIT_ENVIRONMENT.test(l))) return; // answered: a resist or a fizzle is no miss
    const miss = this.targets.miss(guid, name, ts);
    if (miss) this.notices.push(miss);
  }

  /**
   * VirindiTank's RandomHelperBuffs (facts from MOSS RandomHelperRule): now and then, one random
   * beneficial spell on one random player within 18 m (never you). The spell is drawn from Endurance,
   * Regeneration, Rejuvenation, Armor and the seven Protection Other families (up to 100 draws), at the
   * best level you can cast; the families come from the era's own SpellTable by their level-I names,
   * so an era without one simply never draws it. A cast sent starts RandomHelperIntervalSeconds before
   * the next; a draw that found nothing, or a switch to magic mode, doesn't. VTank's last rule: the
   * routine engine asks after everything else, the route included.
   */
  helperStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>): VtStep | null {
    p = this.resolved(p);
    if (!opt(settings, 'RandomHelperBuffs') || this.now() < this.helperUntil || this.now() < this.noMagicUntil) return null;
    const table = this.api.spellTableData();
    const snap = this.api.snapshot({ radius: HELPER_RANGE, max: 40 });
    const me = snap.me;
    if (!table || !me) return null;
    const players = snap.nearby.filter((o) => o.kind === 'player' && o.guid !== me.guid && o.dist < HELPER_RANGE);
    if (!players.length) return null;
    const target = players[Math.min(players.length - 1, Math.floor(this.random() * players.length))];
    const families: Array<{ category: number; school: number }> = [];
    for (const name of HELPER_SPELLS) {
      for (const s of table.spells.values()) if (s.name === name) { families.push({ category: s.category, school: s.school }); break; }
    }
    if (!families.length) return null;
    const known = this.spells(p.vtank.excludedScarabs);
    const skills = this.skills();
    const threshold = Number(opt(settings, 'SpellDiffExcessThreshold-Buff')) || 0;
    const SCHOOL: Record<number, string> = { 1: 'War Magic', 2: 'Life Magic', 3: 'Item Enchantment', 4: 'Creature Enchantment', 5: 'Void Magic' };
    for (let draw = 0; draw < 100; draw++) {
      const f = families[Math.min(families.length - 1, Math.floor(this.random() * families.length))];
      const skill = skills.find((k) => k.name.toLowerCase() === (SCHOOL[f.school] ?? '').toLowerCase());
      if (!skill || skill.training === 'untrained') continue;
      const best = known.filter((s) => s.category === f.category && !s.self && s.school === SCHOOL[f.school] && s.power + threshold <= skill.buffed).sort((a, b) => b.power - a.power)[0];
      if (!best) continue;
      if (me.combatMode !== 'magic') return this.toMagic(p, `helper: ${best.name} on ${target.name}: switching to magic mode to cast`);
      return { label: `helper: ${best.name} on ${target.name}`, run: async () => {
        this.helperUntil = this.now() + Math.max(0, Number(opt(settings, 'RandomHelperIntervalSeconds')) || 0) * 1000;
        this.castSpent(settings);
        return this.cast(best.id, target.guid);
      } };
    }
    return null;
  }

  /**
   * The tabs with what a `.usd` kept by id named from what you carry and the spell table
   * (vtankUsd.ts resolveVtankIds; an import without the client keeps object and spell ids).
   */
  private resolved(p: RoutineProfile & { vtank: VtankProfileData }): RoutineProfile & { vtank: VtankProfileData } {
    const v = resolveVtankIds(p.vtank, {
      objectName: (guid) => this.api.inventory().find((i) => i.guid >>> 0 === guid)?.name,
      spellName: (id) => this.api.spellTableData()?.spells.get(id)?.name,
    });
    return v === p.vtank ? p : { ...p, vtank: v };
  }

  /** UtilityBelt cast sharing: another client's debuff, on its target, as if this macro had cast it. */
  private takeSharedCasts(net: UbNet): void {
    const table = this.api.spellTableData();
    for (const c of net.takeCasts()) {
      const category = table?.spells.get(c.spellId)?.category;
      if (category === undefined || c.durationMs <= 0) continue;
      this.castLog.push({ guid: c.target >>> 0, category, at: this.now(), duration: c.durationMs / 1000 });
    }
    if (this.castLog.length > 200) this.castLog.splice(0, this.castLog.length - 200);
  }

  /**
   * UtilityBelt vital sharing: your other clients near you, with the vitals they sent, join the
   * Helper's fellows (VTank heals them though they aren't in your fellowship). Matched by name to a
   * player in view, for their object id and distance.
   */
  private withNetFellows(fellows: HelperTarget[], nearby: Array<{ guid: number; name: string; kind: string; dist: number }>, myGuid: number, net: UbNet | null): HelperTarget[] {
    const shared = net?.vitalSharing ? net.sharedVitals() : [];
    if (!shared.length) return fellows;
    const out = [...fellows];
    for (const s of shared) {
      const o = nearby.find((x) => x.kind === 'player' && x.guid !== myGuid && x.name.toLowerCase() === s.name.toLowerCase());
      if (!o || out.some((f) => f.guid === o.guid)) continue;
      out.push({ guid: o.guid, name: o.name, distance: o.dist, health: { ...s.vitals.health }, stamina: { ...s.vitals.stamina }, mana: { ...s.vitals.mana } });
    }
    return out;
  }

  /** Buff families whose casts didn't take, by category: misses in a row, and when it may be tried again. */
  private buffMisses = new Map<number, { n: number; until: number }>();

  /** BuffCastRecast: until when (ms) the other buffs' threshold is raised after a buff cast. */
  private recastUntil = -Infinity;
  /** Buff items and their spell families held back after a use, until (ms); shared cooldowns this macro started, by id. */
  private itemHeld = new Map<string, number>();
  private cooldownUntil = new Map<number, number>();

  /**
   * Every buff cast: arms BuffCastRecast, and with FastCastBuffs walks backwards while a quick buff is
   * cast (VTank 1.0: "Moves you backwards during casting").
   */
  private async castBuff(spell: PlanSpell, target: number | 'self', settings: Record<string, string | number | boolean>): Promise<AgentResult> {
    this.recastUntil = this.now() + Math.max(0, Number(opt(settings, 'BuffCastRecastReset_Seconds')) || 0) * 1000;
    const row = this.api.spellTableData()?.spells.get(spell.id);
    const fast = opt(settings, 'FastCastBuffs') === true && !!row && isQuickBuff(row);
    if (fast) this.api.holdMove('backward', true);
    try { return await this.cast(spell.id, target); } finally { if (fast) this.api.holdMove('backward', false); }
  }

  /** A caster item's own spell on you or a fellow; with JumpOutWandCasting a jump follows 0.2 s later to cut the cast short. */
  private useCaster(guid: number, target: number | 'self', settings: Record<string, string | number | boolean>): AgentResult {
    const res = this.api.useOn(guid, target);
    if (res.ok && opt(settings, 'JumpOutWandCasting') === true) setTimeout(() => this.api.jump({ holdMs: 50 }), 200);
    return res;
  }

  /** VTank's buff items (buffItems.ts): a gem, food or potion whose spell is due, used from the pack. */
  private buffItemStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>, idle: boolean, skills: PlanSkill[], level: number): VtStep | null {
    const table = this.api.spellTableData();
    if (!table || opt(settings, 'EnableBuffing') !== true) return null;
    const t = this.now();
    for (const [k, until] of this.itemHeld) if (until <= t) this.itemHeld.delete(k);
    // A .usd's GemFoodItems when imported (vtankUsd.ts), else VTank's default profile's.
    const listed = [...(p.vtank.gemFood?.map((g) => g.name) ?? VT_GEM_FOOD_ITEMS), ...p.vtank.consumables];
    const base = idle && opt(settings, 'IdleBuffTopoff') === true ? Number(opt(settings, 'IdleBuffTopoffTimeSeconds')) : Number(opt(settings, 'RebuffTimeRemainingSeconds'));
    const pick = planBuffItem({
      items: this.items(listed), listed, spellTable: table, active: this.api.activeSpellsNow(), skills, level,
      threshold: rebuffThreshold(base, t < this.recastUntil, Number(opt(settings, 'BuffCastRecast_Seconds')) || 0),
      inFellowship: !!this.api.fellowshipInfo(),
      cooldownLeft: (id) => Math.max(this.api.cooldownRemaining(id), ((this.cooldownUntil.get(id) ?? 0) - t) / 1000),
      heldBack: (guid, category) => this.itemHeld.has(`i${guid}`) || this.itemHeld.has(`c${category}`),
    });
    if (!pick) return null;
    return { label: `buff item: ${pick.why}`, run: async () => {
      const res = await this.api.use(pick.item.guid);
      // The effect shows a moment after the use: the item and its family wait 5 s, or 30 s when it was refused.
      const until = this.now() + (res.ok ? 5_000 : 30_000);
      this.itemHeld.set(`i${pick.item.guid}`, until);
      this.itemHeld.set(`c${pick.spell.category}`, until);
      const cd = itemCooldown(pick.item);
      if (res.ok && cd) this.cooldownUntil.set(cd.id, this.now() + cd.seconds * 1000);
      return res;
    } };
  }

  /** Seconds left on a family's enchantment on you at least as strong as `power` (the longest one), or null when none is seen. */
  private familyRemaining(category: number, power: number): number | null {
    let best: number | null = null;
    for (const e of this.api.activeSpellsNow()) {
      if (e.category !== category || (e.power !== undefined && e.power < power)) continue;
      if (best === null || e.remaining > best) best = e.remaining;
    }
    return best;
  }
}

/**
 * Whether the pack can pay for a spell's components (`AgentHost.spellComponents`: the formula the server
 * charges, personalized, or scarabs and tapers with foci), counted as the server counts them: each
 * component as many times as the formula names it, against every carried stack of that name (ACE
 * SpellFormula.GetRequiredComps + Player.GetNumInventoryItemsOfWCID). A stack may be named in the
 * plural ("Prismatic Tapers"), so names compare without a trailing "s".
 */
export function componentPurse(inventory: Array<{ name: string; stack?: number; where?: string }>): (components: string[]) => boolean {
  const norm = (n: string): string => n.trim().toLowerCase().replace(/s$/, '');
  const have = new Map<string, number>();
  for (const i of inventory) {
    if (i.where === 'equipped') continue;
    const k = norm(i.name);
    have.set(k, (have.get(k) ?? 0) + Math.max(1, i.stack ?? 1));
  }
  return (components) => {
    const need = new Map<string, number>();
    for (const c of components) { const k = norm(c); need.set(k, (need.get(k) ?? 0) + 1); }
    for (const [k, n] of need) if ((have.get(k) ?? 0) < n) return false;
    return true;
  };
}

/** The blacklist and ghost options, as the target tracker reads them. */
function trackerSettings(settings: Record<string, string | number | boolean>): TrackerSettings {
  const n = (name: string): number => Number(opt(settings, name)) || 0;
  return {
    BlacklistMonsterAttemptCount: n('BlacklistMonsterAttemptCount'), BlacklistMonsterTimeoutSeconds: n('BlacklistMonsterTimeoutSeconds'),
    DeleteGhostMonsters: opt(settings, 'DeleteGhostMonsters') === true, GhostMonsterSpellAttemptCount: n('GhostMonsterSpellAttemptCount'),
    DeleteGhostMonstersByHPTracker: opt(settings, 'DeleteGhostMonstersByHPTracker') === true, GhostDeleteHPTrackerSeconds: n('GhostDeleteHPTrackerSeconds'),
  };
}

/** RandomHelperBuffs: how near a player must be (metres), and its spells by their level-I names (MOSS RandomHelperRule). */
const HELPER_RANGE = 18;
export const HELPER_SPELLS = [
  'Endurance Other I', 'Regeneration Other I', 'Rejuvenation Other I', 'Armor Other I', 'Blade Protection Other I', 'Bludgeoning Protection Other I',
  'Cold Protection Other I', 'Fire Protection Other I', 'Lightning Protection Other I', 'Piercing Protection Other I', 'Acid Protection Other I',
];

/** Casts at one family in a Force Buff round before it is given up on (a fizzle, no mana, no components). */
const FORCE_TRIES = 3;
/** Casts in a row at a due buff that don't take before it rests for a minute. */
const BUFF_TRIES = 3;

/** Whether a recast landed: the family's enchantment is on now and longer than before the cast (or new). */
function landed(before: number | null, after: number | null): boolean {
  if (after === null) return false;
  if (before === null) return true;
  return after > before + 1;
}

/** VirindiTank's DefaultMeleeAttackHeight (1 High, 2 Medium, 3 Low) as the combat bar's height. */
export function vtAttackHeight(settings: Record<string, string | number | boolean>): 'high' | 'medium' | 'low' {
  const v = Number(settings.DefaultMeleeAttackHeight);
  return v === 1 ? 'high' : v === 3 ? 'low' : 'medium';
}
