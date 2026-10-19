/**
 * VirindiTank's vital recharge, as a pure planner: given your vitals, stance,
 * spells, skills and Consumables-tab items, the one next step (cast, use, or
 * change stance) or null (docs/vtank-macro-behavior.md §3, §6, §10).
 *
 * Order: VTank's stored `RechargeHandlerSet` (26 rows: vital, handler, min %,
 * max %, stance class), checked top to bottom per vital; the first usable row
 * runs. Health is planned before stamina, stamina before mana.
 *
 * Spell families come from each era's own spell table (buildRechargeFamilies):
 * a spell's kind is read from its description, which states the vital(s) and
 * the amounts ACE's spell data holds (boost / boost variance; transfer
 * proportion, 1 − loss %, cap). Families are keyed by spell id, not by
 * category: the 1999 table puts Revitalize Self and Mana Boost Self in one
 * category (77), and every era puts Stamina to Health and Stamina to Mana in
 * one (the source vital's).
 *
 * Kits and food are recognised by ACE item properties (BoosterEnum, BoostValue,
 * HealkitMod, ItemUseable, Structure) and kit success uses ACE's own formula
 * (Healer.cs DoSkillCheck + SkillCheck.GetSkillChance).
 *
 * Caster items (2026-10-11): an Items-tab caster whose own spell (its Spell
 * data id) is a recharge counts beside the spells you know, as VTank's spell
 * handlers do (MOSS `VitalRecharge.TrySpell`, facts only): the best level
 * wins, a spell you know wins a tie. It is used on you in magic mode,
 * wielded first when the item must be (itemUse.ts). With UseHealersHeart on,
 * the Helper heals a fellow with an Items-tab caster whose spell heals
 * another (The Healer's Heart, Legendary Seed of Mornings) before any spell.
 */
import {
  PropertyFloat,
  PropertyInt,
  SkillId,
  roundHalfToEven,
  vtOption,
  vtStoredValue,
  type PlanItem,
  type PlanSkill,
  type PlanSpell,
  type Stance,
} from '@ac/shared';
import { itemSpellId, mustWield, outOfMana, useRequirementProblem } from './itemUse.ts';
import { pctBelowText } from '../format.ts';

export type Vital = 'health' | 'stamina' | 'mana';
export const VITALS: readonly Vital[] = ['health', 'stamina', 'mana'];

export type RechargeKind =
  | 'heal' | 'revitalize' | 'mana'                    // boosts (self or other)
  | 'stam-to-health' | 'mana-to-health' | 'stam-to-mana' | 'mana-to-stam' | 'health-to-stam' | 'health-to-mana' // your own vital to another
  | 'infuse'                                          // your vital to a target's same vital (Infuse X Other)
  | 'drain';                                         // a target's vital to you (an attack; never a recharge)

export interface RechargeFamily {
  kind: RechargeKind;
  /** Cast on yourself (SpellFlags.SelfTargeted); otherwise on a target. */
  self: boolean;
  /** The vital that gains. */
  dest: Vital;
  /** Transfers: the vital drained. */
  source?: Vital;
  /** Boosts: ACE Boost .. Boost + BoostVariance. */
  boost?: { min: number; max: number };
  /** Transfers: ACE Proportion, 1 − LossPercent, TransferCap (0 = none). */
  transfer?: { proportion: number; give: number; cap: number };
  category: number;
  /** The spell's difficulty and name (buildRechargeFamilies), so an item's spell can be ranked against the spells you know. */
  power?: number;
  name?: string;
}

export interface RechargeFamilies {
  /** Spell id → its recharge family (only boosts and transfers that move vitals). */
  bySpell: Map<number, RechargeFamily>;
}

export interface VitalValue { cur: number; max: number }
export interface Vitals { health: VitalValue; stamina: VitalValue; mana: VitalValue }

/** A fellow for the Helper (DoHelp): heal / restam / infuse others. */
export interface HelperTarget extends Vitals {
  guid: number;
  name: string;
  /** Metres from you. */
  distance: number;
}

export interface RechargeInput {
  vitals: Vitals;
  stance: Stance;
  /** A combat target now (else the Top-off levels apply). */
  hasTarget: boolean;
  /** VTank option names (any case), our units; missing names take VTank's defaults. */
  settings: Record<string, string | number | boolean>;
  spells: PlanSpell[];
  skills: PlanSkill[];
  /** The Consumables-tab items you carry (examined props when known). Nothing else is used. */
  consumables: PlanItem[];
  rechargeFamilies: RechargeFamilies;
  /** Fellows the Helper may help (VTank: fellowship panel open / VI2 fellows). */
  fellows?: HelperTarget[];
  /**
   * Recharge boost, in vital points (RechargeBoostAmount), while it is on: the
   * macro switched to magic mode to recharge, and VTank then "prefers to
   * recharge" (the wiki's Advanced Options). A vital within this many points of
   * its level still counts as due, so a stance change paid for is not wasted
   * when the vital regenerated past the level during the switch. The caller
   * keeps the timing (RechargeBoostTimeSeconds, ClearLevelBoostFlagOnCast).
   */
  boost?: number;
  /**
   * Items-tab casters (examined: their Spell data id, ItemUseable and use requirements), whose own
   * spell may recharge you or (UseHealersHeart) heal a fellow.
   */
  casterItems?: PlanItem[];
  /** Your level, for an item's UseRequiresLevel. */
  level?: number;
}

export type RechargeAction =
  | { kind: 'cast'; spell: PlanSpell; why: string; target?: number }
  /**
   * A carried item used from the pack. `onYou`: a healing kit, used with you as its target; otherwise (food, a potion, an
   * elixir) a plain use, which is what the item takes (ACE refuses a use-with-target of an item with no TargetType).
   */
  | { kind: 'use'; item: PlanItem; why: string; onYou?: boolean }
  /** A caster item's own spell, used on you (no target) or a fellow, in magic mode; `wield`: it must be wielded first. */
  | { kind: 'item'; item: PlanItem; spellName: string; wield: boolean; why: string; target?: number }
  | { kind: 'stance'; to: Stance; why: string };

// ── RechargeHandlerSet (USD default, docs §3) ──

export type RechargeHandler = 'Stamina to Health' | 'Mana to Health' | 'Regular Spell' | 'Recharge With Food' | 'Kit Recharge';
export interface RechargeRow { vital: Vital; handler: RechargeHandler; minPct: number; maxPct: number; magic: boolean }

const row = (vital: Vital, handler: RechargeHandler, minPct: number, maxPct: number, magic: boolean): RechargeRow => ({ vital, handler, minPct, maxPct, magic });

/** VTank's default RechargeHandlerSet, in its order (magic = Stance 1; else Stance 2: peace / melee / missile). */
export const RECHARGE_HANDLER_SET: readonly RechargeRow[] = [
  // Health, magic: the 15 % tier, then any %.
  row('health', 'Stamina to Health', 0, 15, true),
  row('health', 'Mana to Health', 0, 15, true),
  row('health', 'Regular Spell', 0, 15, true),
  row('health', 'Recharge With Food', 0, 15, true),
  row('health', 'Kit Recharge', 0, 100, true),
  row('health', 'Stamina to Health', 0, 100, true),
  row('health', 'Mana to Health', 0, 100, true),
  row('health', 'Regular Spell', 0, 100, true),
  row('health', 'Recharge With Food', 0, 100, true),
  // Health, other stances.
  row('health', 'Recharge With Food', 0, 15, false),
  row('health', 'Kit Recharge', 0, 100, false),
  row('health', 'Recharge With Food', 0, 100, false),
  row('health', 'Stamina to Health', 0, 10, false),
  row('health', 'Regular Spell', 0, 100, false),
  // Stamina.
  row('stamina', 'Kit Recharge', 0, 100, true),
  row('stamina', 'Regular Spell', 0, 100, true),
  row('stamina', 'Recharge With Food', 0, 100, true),
  row('stamina', 'Kit Recharge', 0, 100, false),
  row('stamina', 'Recharge With Food', 0, 100, false),
  row('stamina', 'Regular Spell', 0, 100, false),
  // Mana.
  row('mana', 'Kit Recharge', 0, 100, true),
  row('mana', 'Recharge With Food', 0, 100, true),
  row('mana', 'Regular Spell', 0, 100, true),
  row('mana', 'Kit Recharge', 0, 100, false),
  row('mana', 'Recharge With Food', 0, 100, false),
  row('mana', 'Regular Spell', 0, 100, false),
];

// ── families from the spell table ──

/** ACE SpellFlags.SelfTargeted. */
const SELF_TARGETED = 0x8;
/** ACE PropertyAttribute2nd current-value ids, as BoosterEnum holds them. */
export const BOOSTER_VITAL: Record<Vital, number> = { health: 2, stamina: 4, mana: 6 };

const VITAL_WORD = '(Health|Stamina|Mana)';
const vitalOf = (w: string): Vital => w.toLowerCase() as Vital;
const BOOST_RE = new RegExp(`^Restores (\\d+)-(\\d+) points of the (caster|target)'s ${VITAL_WORD}\\b`, 'i');
const TRANSFER_RE = new RegExp(`^Drains (one-half|one-quarter|\\d+%) of the (caster|target)'s ${VITAL_WORD} and gives (\\d+%) of (?:that|it) to (his/her ${VITAL_WORD}|the caster|the target)`, 'i');
const CAP_RE = /maximum of (\d+)/i;
const FRACTION: Record<string, number> = { 'one-half': 0.5, 'one-quarter': 0.25 };
const pctOf = (s: string): number => FRACTION[s.toLowerCase()] ?? Number(s.replace('%', '')) / 100;

const TRANSFER_KIND: Partial<Record<`${Vital}>${Vital}`, RechargeKind>> = {
  'stamina>health': 'stam-to-health', 'mana>health': 'mana-to-health', 'stamina>mana': 'stam-to-mana',
  'mana>stamina': 'mana-to-stam', 'health>stamina': 'health-to-stam', 'health>mana': 'health-to-mana',
};
const BOOST_KIND: Record<Vital, RechargeKind> = { health: 'heal', stamina: 'revitalize', mana: 'mana' };

/** One spell's recharge family from its spell-table entry, or null (not an instant vital boost / transfer). */
export function rechargeFamilyOf(s: { category: number; bitfield: number; duration?: number; desc?: string }): RechargeFamily | null {
  if (s.duration && s.duration > 0) return null; // enchantments (Healing Mastery shares Heal Self's category)
  const desc = (s.desc ?? '').trim();
  const self = (s.bitfield & SELF_TARGETED) !== 0;
  const b = BOOST_RE.exec(desc);
  if (b) {
    const dest = vitalOf(b[4]);
    return { kind: BOOST_KIND[dest], self, dest, boost: { min: Number(b[1]), max: Number(b[2]) }, category: s.category };
  }
  const t = TRANSFER_RE.exec(desc);
  if (!t) return null;
  const from = t[2].toLowerCase(); // whose vital is drained
  const source = vitalOf(t[3]);
  const to = t[5].toLowerCase();
  const cap = Number(CAP_RE.exec(desc)?.[1] ?? 0);
  const transfer = { proportion: pctOf(t[1]), give: pctOf(t[4]), cap };
  if (to.startsWith('his/her')) {
    const dest = vitalOf(t[6]);
    const kind = TRANSFER_KIND[`${source}>${dest}`];
    // "the caster's X ... to his/her Y" is a self transfer; "the target's" is the same spell on another.
    return kind ? { kind, self: from === 'caster' ? true : self, dest, source, transfer, category: s.category } : null;
  }
  if (from === 'caster' && to === 'the target') return { kind: 'infuse', self: false, dest: source, source, transfer, category: s.category };
  if (from === 'target' && to === 'the caster') return { kind: 'drain', self: false, dest: source, source, transfer, category: s.category };
  return null;
}

export function buildRechargeFamilies(spellTable: { spells: Map<number, { name: string; category: number; school: number; bitfield: number; power: number; duration?: number; desc?: string }> }): RechargeFamilies {
  const bySpell = new Map<number, RechargeFamily>();
  for (const [id, s] of spellTable.spells) {
    const f = rechargeFamilyOf(s);
    if (f) bySpell.set(id, { ...f, power: s.power, name: s.name });
  }
  return { bySpell };
}

// ── settings ──

function setting(settings: RechargeInput['settings'], name: string): string | number | boolean {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(settings)) {
    if (k.toLowerCase() === want || vtOption(k)?.name.toLowerCase() === want) return vtStoredValue(name, v);
  }
  const d = vtOption(name)?.default;
  if (d === undefined) throw new Error(`unknown VTank option ${name}`);
  return d;
}
const num = (s: RechargeInput['settings'], n: string): number => Number(setting(s, n));
const bool = (s: RechargeInput['settings'], n: string): boolean => setting(s, n) === true;

const VITAL_SUFFIX: Record<Vital, string> = { health: 'HitP', stamina: 'Stam', mana: 'Mana' };

// ── ACE formulas ──

/** ACE SkillCheck.GetSkillChance (ACE.Server/WorldObjects/SkillCheck.cs:7-12). */
export function skillChance(skill: number, difficulty: number, factor = 0.03): number {
  const chance = 1 - 1 / (1 + Math.exp(factor * (skill - difficulty)));
  return Math.min(1, Math.max(0, chance));
}

/**
 * A kit's success chance, ACE Healer.DoSkillCheck (Healer.cs:240-255):
 * effective = round((Healing + kit BoostValue) × (1.5 specialized | 1.1 trained)),
 * difficulty = round(missing × 2 × (1.0 peace | 1.1 combat stances)). C# Math.Round is half-to-even.
 */
export function kitSuccessChance(healing: PlanSkill | undefined, kitBoost: number, missing: number, stance: Stance): number {
  if (!healing || healing.training === 'untrained') return 0; // Healer.cs:51 YouArentTrainedInHealing
  const trainedMod = healing.training === 'specialized' ? 1.5 : 1.1;
  const combatMod = stance === 'peace' ? 1.0 : 1.1;
  const effective = roundHalfToEven((healing.buffed + kitBoost) * trainedMod);
  const difficulty = roundHalfToEven(missing * 2 * combatMod);
  return skillChance(effective, difficulty);
}

/** A boost's mean (ACE WorldObject_Magic HandleCastSpell_Boost: random in Boost..MaxBoost). */
function boostGain(f: RechargeFamily): number {
  return f.boost ? (f.boost.min + f.boost.max) / 2 : 0;
}

/** A self transfer's gain (ACE WorldObject_Magic.cs:719-747: src = round(cur × Proportion), capped; dest = round(src × (1 − Loss)), capped). */
function transferGain(f: RechargeFamily, sourceCur: number): number {
  if (!f.transfer) return 0;
  let src = roundHalfToEven(sourceCur * f.transfer.proportion);
  if (f.transfer.cap && src > f.transfer.cap) src = f.transfer.cap;
  let dest = roundHalfToEven(src * f.transfer.give);
  if (f.transfer.cap && dest > f.transfer.cap) dest = f.transfer.cap;
  return dest;
}

// ── the planner ──

const SCHOOL_SKILL: Record<string, number> = {
  'War Magic': SkillId.WarMagic, 'Life Magic': SkillId.LifeMagic, 'Item Enchantment': SkillId.ItemEnchantment,
  'Creature Enchantment': SkillId.CreatureEnchantment, 'Void Magic': SkillId.VoidMagic,
};

const pct = (v: VitalValue): number => (v.max > 0 ? (v.cur / v.max) * 100 : 100);
const fmt = (n: number): string => `${Math.round(n)}%`;

interface Ctx {
  input: RechargeInput;
  threshold: number; // SpellDiffExcessThreshold-Hunt
}

/** The highest-power spell of `kind` you can cast (power + Hunt threshold ≤ buffed skill), self or other. */
function bestSpell(ctx: Ctx, kind: RechargeKind, self: boolean, dest?: Vital): { spell: PlanSpell; fam: RechargeFamily } | null {
  const { spells, skills, rechargeFamilies } = ctx.input;
  let best: { spell: PlanSpell; fam: RechargeFamily } | null = null;
  for (const spell of spells) {
    const fam = rechargeFamilies.bySpell.get(spell.id);
    if (!fam || fam.kind !== kind || fam.self !== self || (dest && fam.dest !== dest)) continue;
    const skill = skills.find((k) => k.id === SCHOOL_SKILL[spell.school]);
    if (!skill || skill.training === 'untrained') continue;
    if (spell.power + ctx.threshold > skill.buffed) continue;
    if (!best || spell.power > best.spell.power) best = { spell, fam };
  }
  return best;
}

/** A spell to cast or a caster item to use: the best of `kind` you know, or an Items-tab caster's spell of a higher level. */
type Source = { spell: PlanSpell; fam: RechargeFamily; item?: undefined } | { item: PlanItem; fam: RechargeFamily; spell?: undefined };

function bestItem(ctx: Ctx, kind: RechargeKind, self: boolean, dest?: Vital): { item: PlanItem; fam: RechargeFamily } | null {
  const { casterItems, rechargeFamilies, skills, level } = ctx.input;
  let best: { item: PlanItem; fam: RechargeFamily } | null = null;
  for (const item of casterItems ?? []) {
    if (((item.itemType ?? 0) & 0x8000) === 0 || outOfMana(item)) continue;
    const sid = itemSpellId(item);
    const fam = sid !== undefined ? rechargeFamilies.bySpell.get(sid) : undefined;
    if (!fam || fam.kind !== kind || fam.self !== self || (dest && fam.dest !== dest)) continue;
    if (useRequirementProblem(item, skills, level)) continue;
    if (!best || (fam.power ?? 0) > (best.fam.power ?? 0)) best = { item, fam };
  }
  return best;
}

function bestSource(ctx: Ctx, kind: RechargeKind, self: boolean, dest?: Vital): Source | null {
  const spell = bestSpell(ctx, kind, self, dest);
  const item = bestItem(ctx, kind, self, dest);
  // A higher level wins; on a tie, the spell you know (MOSS VitalRecharge.Better).
  if (item && (!spell || (item.fam.power ?? 0) > spell.spell.power)) return item;
  return spell;
}

const sourceName = (s: Source): string => (s.spell ? s.spell.name : `${s.item.name} (${s.fam.name ?? 'its spell'})`);

function isKit(it: PlanItem): boolean {
  // Healers carry HealkitMod and a targeted ItemUseable (SourceContainedTargetRemoteOrSelf); food is ItemUseable Contained.
  return it.floats?.[PropertyFloat.HealkitMod] !== undefined || ((it.ints?.[PropertyInt.ItemUseable] ?? 0) >>> 16) !== 0;
}
const boosts = (it: PlanItem, v: Vital): boolean => it.ints?.[PropertyInt.BoosterEnum] === BOOSTER_VITAL[v];

function bestKit(ctx: Ctx, v: Vital, useStance: Stance): { item: PlanItem; chance: number } | null {
  const { consumables, skills, vitals, settings } = ctx.input;
  const healing = skills.find((k) => k.id === SkillId.Healing);
  const missing = vitals[v].max - vitals[v].cur;
  const floor = num(settings, 'MinimumHealKitSuccessChance') / 100;
  const ok: Array<{ item: PlanItem; chance: number; mod: number; uses: number }> = [];
  for (const item of consumables) {
    if (!isKit(item) || !boosts(item, v)) continue;
    const uses = item.ints?.[PropertyInt.Structure] ?? Infinity; // unlimited kits carry no Structure
    if (uses <= 0) continue;
    const chance = kitSuccessChance(healing, item.ints?.[PropertyInt.BoostValue] ?? 0, missing, useStance);
    if (chance < floor) continue;
    ok.push({ item, chance, mod: item.floats?.[PropertyFloat.HealkitMod] ?? 1, uses });
  }
  // Highest restoration bonus; on a tie, the fewest charges left (FAQ).
  ok.sort((a, b) => b.mod - a.mod || a.uses - b.uses);
  return ok[0] ?? null;
}

function bestFood(ctx: Ctx, v: Vital): PlanItem | null {
  const { consumables, vitals } = ctx.input;
  const missing = vitals[v].max - vitals[v].cur;
  const foods = consumables.filter((it) => !isKit(it) && boosts(it, v) && (it.ints?.[PropertyInt.BoostValue] ?? 0) > 0 && (it.stack ?? 1) > 0);
  if (!foods.length) return null;
  const val = (it: PlanItem): number => it.ints![PropertyInt.BoostValue];
  // The smallest that covers what is missing, else the largest (least waste).
  const covering = foods.filter((it) => val(it) >= missing).sort((a, b) => val(a) - val(b));
  return covering[0] ?? [...foods].sort((a, b) => val(b) - val(a))[0];
}

/** Stamina / Mana to Health is used only when it beats a normal heal by its multiplier (StaminaToHealthMultiplier, ManaToHealthMultiplier). */
function drainToHealth(ctx: Ctx, kind: 'stam-to-health' | 'mana-to-health'): { source: Source; why: string } | null {
  const pick = bestSource(ctx, kind, true);
  if (!pick) return null;
  const sourceCur = ctx.input.vitals[pick.fam.source!].cur;
  const gain = transferGain(pick.fam, sourceCur);
  if (gain <= 0) return null;
  const heal = bestSource(ctx, 'heal', true);
  const healGain = heal ? boostGain(heal.fam) : 0;
  const multName = kind === 'stam-to-health' ? 'StaminaToHealthMultiplier' : 'ManaToHealthMultiplier';
  const mult = num(ctx.input.settings, multName);
  if (gain < healGain * mult) return null;
  return { source: pick, why: `${sourceName(pick)} gives ~${gain} vs heal ~${healGain} × ${multName} ${mult}` };
}

function regularSpell(ctx: Ctx, v: Vital): { source: Source; why: string } | null {
  if (v === 'health') { const p = bestSource(ctx, 'heal', true); return p && { source: p, why: sourceName(p) }; }
  if (v === 'stamina') { const p = bestSource(ctx, 'revitalize', true); return p && { source: p, why: sourceName(p) }; }
  // Mana: Stamina to Mana (Mana Boost Self costs more mana than it restores).
  const p = bestSource(ctx, 'stam-to-mana', true);
  if (!p || transferGain(p.fam, ctx.input.vitals.stamina.cur) <= 0) return null;
  return { source: p, why: sourceName(p) };
}

/** A caster item's spell: the item goes in your hands first when it must be wielded, then it is used in magic mode. */
function itemAction(item: PlanItem, fam: RechargeFamily, why: string, target?: number): RechargeAction {
  return { kind: 'item', item, spellName: fam.name ?? '', wield: mustWield(item) && !item.equipped, why, ...(target !== undefined ? { target } : {}) };
}

function tryRow(ctx: Ctx, r: RechargeRow, why: string): RechargeAction | null {
  const { stance, settings } = ctx.input;
  const castOrStance = (c: { source: Source; why: string } | null): RechargeAction | null => {
    if (!c) return null;
    const w = `${why}: ${r.handler} (${c.why})`;
    // An item that must be wielded is wielded before the switch to magic mode (it is then the caster in hand).
    if (c.source.item && mustWield(c.source.item) && !c.source.item.equipped) return itemAction(c.source.item, c.source.fam, w);
    if (stance !== 'magic') return { kind: 'stance', to: 'magic', why: `${w} needs magic stance` };
    return c.source.item ? itemAction(c.source.item, c.source.fam, w) : { kind: 'cast', spell: c.source.spell, why: w };
  };
  switch (r.handler) {
    case 'Kit Recharge': {
      if (r.magic && !bool(settings, 'UseKitsInMagicMode')) return null;
      const toPeace = bool(settings, 'GoToPeaceModeToUseKits') && stance !== 'peace';
      const kit = bestKit(ctx, r.vital, toPeace ? 'peace' : stance);
      if (!kit) return null;
      const what = `${kit.item.name} ${Math.floor(kit.chance * 100)}% success`;
      if (toPeace) return { kind: 'stance', to: 'peace', why: `${why}: ${r.handler} (${what}) in peace mode (GoToPeaceModeToUseKits)` };
      return { kind: 'use', item: kit.item, why: `${why}: ${r.handler} (${what})`, onYou: true };
    }
    case 'Recharge With Food': {
      const food = bestFood(ctx, r.vital);
      return food && { kind: 'use', item: food, why: `${why}: ${r.handler} (${food.name})` };
    }
    case 'Stamina to Health': return castOrStance(drainToHealth(ctx, 'stam-to-health'));
    case 'Mana to Health': return castOrStance(drainToHealth(ctx, 'mana-to-health'));
    case 'Regular Spell': return castOrStance(regularSpell(ctx, r.vital));
  }
}

function helperAction(ctx: Ctx): RechargeAction | null {
  const { fellows, settings, stance } = ctx.input;
  if (!fellows?.length || !bool(settings, 'DoHelp')) return null;
  for (const v of VITALS) {
    const at = num(settings, `Recharge-Helper-${VITAL_SUFFIX[v]}`);
    const range = num(settings, `HelperDistance${VITAL_SUFFIX[v]}`);
    for (const f of fellows) {
      if (f.distance > range || f[v].max <= 0 || pct(f[v]) >= at) continue;
      // UseHealersHeart: an Items-tab caster that heals another goes first (MOSS TryHealersHeart).
      if (v === 'health' && bool(settings, 'UseHealersHeart')) {
        const heart = bestItem(ctx, 'heal', false, 'health');
        if (heart) {
          const why = `${f.name} health ${pctBelowText(pct(f.health), at)} < ${at}% (Recharge-Helper-HitP): ${heart.item.name} (UseHealersHeart)`;
          if (mustWield(heart.item) && !heart.item.equipped) return itemAction(heart.item, heart.fam, why, f.guid);
          if (stance !== 'magic') return { kind: 'stance', to: 'magic', why: `${why} needs magic stance` };
          return itemAction(heart.item, heart.fam, why, f.guid);
        }
      }
      const pick = bestSpell(ctx, BOOST_KIND[v], false) ?? bestSpell(ctx, 'infuse', false, v);
      if (!pick) continue;
      const why = `${f.name} ${v} ${pctBelowText(pct(f[v]), at)} < ${at}% (Recharge-Helper-${VITAL_SUFFIX[v]})`;
      if (stance !== 'magic') return { kind: 'stance', to: 'magic', why: `${why}: ${pick.spell.name} needs magic stance` };
      return { kind: 'cast', spell: pick.spell, target: f.guid, why: `${why}: ${pick.spell.name}` };
    }
  }
  return null;
}

/** The next recharge step, or null when every vital is above its level and no fellow needs help. */
export function planRecharge(input: RechargeInput): RechargeAction | null {
  const ctx: Ctx = { input, threshold: num(input.settings, 'SpellDiffExcessThreshold-Hunt') };
  const magic = input.stance === 'magic';
  for (const v of VITALS) {
    const value = input.vitals[v];
    if (value.max <= 0) continue;
    const p = pct(value);
    // In combat: below "Heal at" (Norm). With no target, VTank also tops off up to the Top-off level
    // (NoTarg), so it recharges below whichever is higher (INF: "Top-off" raises the bar, it doesn't lower it).
    const norm = `Recharge-Norm-${VITAL_SUFFIX[v]}`;
    const top = `Recharge-NoTarg-${VITAL_SUFFIX[v]}`;
    const name = input.hasTarget || num(input.settings, norm) >= num(input.settings, top) ? norm : top;
    const level = num(input.settings, name);
    // Recharge boost: within RechargeBoostAmount points of the level (and not full) still counts.
    const boost = magic ? Math.max(0, input.boost ?? 0) : 0;
    const boosted = p >= level && boost > 0 && value.cur < value.max && value.cur < (level / 100) * value.max + boost;
    if (p >= level && !boosted) continue;
    const why = boosted
      ? `${v} ${fmt(p)}, within ${boost} points of ${level}% (${name}; recharge boost, RechargeBoostAmount)`
      : `${v} ${pctBelowText(p, level)} < ${level}% (${name})`;
    for (const r of RECHARGE_HANDLER_SET) {
      if (r.vital !== v || r.magic !== magic || p < r.minPct || p > r.maxPct) continue;
      const a = tryRow(ctx, r, why);
      if (a) return a;
    }
  }
  return helperAction(ctx);
}
