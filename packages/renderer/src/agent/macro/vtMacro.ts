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
import { vtOption, vtStoredValue, type PlanItem, type PlanSkill, type PlanSpell, type RoutineProfile, type Stance, type VtankProfileData } from '@ac/shared';
import type { AgentApi } from '../AgentApi.ts';
import type { AgentResult } from '../types.ts';
import { buildBuffFamilies, planBuffs, type BuffFamilies } from './buffPlan.ts';
import { blowPoints, buildCombatFamilies, indexMonsterTable, planCombat, planPet, type CombatFamilies, type CombatInput, type CombatMonster, type MonsterFacts } from './combatPlan.ts';
import { FellowManager } from './fellowManager.ts';
import { buildRechargeFamilies, planRecharge, type RechargeFamilies } from './rechargePlan.ts';
import { planPeaSplit, type SplitTier } from './peaPlan.ts';
import { idleCraftCategory, indexRecipes, planCraft, type CraftRow } from './craftPlan.ts';
import { autoAttackPower } from './attackPower.ts';
import { castConfirmed, castTargetsNamed, COMPONENTS_MISSING } from './castReply.ts';
import { ItemBuffLedger, type ItemRef } from './itemBuffLedger.ts';

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
  /** The last blow you landed on each monster you fought (combat text), by guid, and how far the chat has been read. */
  private blows = new Map<number, number>();
  private blowMark = 0;

  /** Loads the monster table on first use, and reads new combat lines for the blows you landed (the streak finisher's bar). */
  private noteFights(): void {
    if (!this.monstersAsked) {
      this.monstersAsked = true;
      this.monstersLoading = this.api.monsterTable().then((t) => { if (t) this.monsterFacts = indexMonsterTable(t); }, () => undefined).finally(() => { this.monstersLoading = null; });
    }
    for (const e of this.api.eventsSince(this.blowMark)) {
      this.blowMark = Math.max(this.blowMark, e.seq);
      if (e.type !== 'chat') continue;
      // The line names a monster, not a guid: the one of that name fought most recently.
      let best: { guid: number; at: number; pts: number } | null = null;
      for (const [guid, f] of this.fought) {
        const pts = blowPoints(e.text, f.name);
        if (pts !== null && (!best || f.at > best.at)) best = { guid, at: f.at, pts };
      }
      if (best) this.blows.set(best.guid, best.pts);
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
    const names = [...p.vtank.consumables, ...p.vtank.items.map((x) => x.name)].filter((n) => !/ Pea$/i.test(n) && n !== '[All Peas]');
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
    if (stance !== 'peace') return { label: `craft: to make ${step.result}: switching to peace mode`, run: async () => this.api.combatMode('peace') };
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
      return this.api.combatMode('magic');
    } };
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
  }

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
    const res = await this.api.cast(spellId, target);
    if (!res.ok && COMPONENTS_MISSING.test(res.message)) this.componentsRequired = true;
    return res;
  }

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
    }]));
  }

  private skills(): PlanSkill[] { return this.api.skillList(); }

  /** Carried items as the planners read them (examined ints / floats when known). */
  private items(names?: string[]): PlanItem[] {
    const want = names ? new Set(names.map((n) => n.toLowerCase())) : null;
    return this.api.inventory().filter((i) => !want || want.has(i.name.toLowerCase())).map((i) => {
      const d = this.api.itemData(i.guid);
      // Listed items, and carried ammunition and wielded launchers (their AmmoType / DamageType pick the arrows), are examined quietly once.
      // So are wielded melee weapons: their DamageType / AttackType / WeaponType set the power bar (attackPower.ts).
      const wantsData = want || /MissileAmmo/.test(i.fits ?? i.slot ?? '') || ((i.itemType ?? 0) & 0x100) !== 0 || (i.where === 'equipped' && ((i.itemType ?? 0) & 0x1) !== 0);
      if (!d && wantsData && !this.asked.has(i.guid)) { this.asked.add(i.guid); void this.api.appraise(i.guid, { quiet: true }); }
      return {
        guid: i.guid, name: i.name, ...(i.stack !== undefined ? { stack: i.stack } : {}), ...(d ? { ints: d.int, floats: d.float } : {}), ...(i.where === 'equipped' ? { equipped: true } : {}),
        ...(i.uiEffects ? { uiEffects: i.uiEffects } : {}), ...(i.itemType ? { itemType: i.itemType } : {}), ...(i.fits ? { fits: i.fits } : {}), ...(i.slot ? { slot: i.slot } : {}), ...(i.ammoType ? { ammoType: i.ammoType } : {}),
      };
    });
  }

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
  private lastSummonAt = -Infinity;

  /**
   * VirindiTank's RefillWornMana (with M. Charges When Off also while the
   * macro is switched off): a worn item below RefillWornMana-Item-ManaPercent
   * of its mana gets a charged mana stone or charge from the Consumables tab
   * used on you, which pours mana into everything you wear (ACE
   * ManaStone.HandleActionUseOnTarget). Worn items' mana is read from their
   * examination (ItemCurMana 107 / ItemMaxMana 108), refreshed every 90 s.
   */
  manaStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>): VtStep | null {
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
   * VirindiTank's Summon Pets: with at least Pet Min. Monsters (counted for
   * summoning: PetDmg not None) within pet range, use the pet device from the
   * Items tab (one with PetClass, PropertyInt 266, when examined) whose element
   * the highest-priority monster's PetDmg asks for (combatPlan planPet). The
   * monsters passed are every one within pet range, which may reach past
   * Monster Range. One summon per 45 s: ACE refuses a second while one is out.
   * Summoning only exists where the era's skill table has it: an era without
   * essences simply has no device, and the window hides the controls.
   */
  private petStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>, base: Omit<CombatInput, 'monsters'>, monsters: CombatMonster[]): VtStep | null {
    if (!(settings.SummonPets === true || settings.SummonPets === 'true')) return null;
    if (this.now() - this.lastSummonAt < 45_000) return null;
    const range = VtMacro.petRange(settings);
    const devices = this.items(p.vtank.items.map((x) => x.name)).filter((i) => i.ints?.[266] !== undefined);
    const pet = planPet({ ...base, monsters }, { range, minMonsters: Math.max(1, Number(settings.PetMonsterDensity) || 1), devices });
    if (!pet) return null;
    this.lastSummonAt = this.now();
    return { label: `pet: ${pet.why}`, run: () => this.api.use(pet.device.guid) };
  }
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
  decide(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>, ctx: { combat: boolean; buffing: boolean; idle: boolean }): VtStep | null {
    const fam = this.families();
    const range = num(settings.AttackDistance, vtOption('AttackDistance')!.default as number);
    const petRange = VtMacro.petRange(settings);
    const snap = this.api.snapshot({ radius: Math.max(range, petRange, 60), max: 40 });
    const me = snap.me;
    if (!me) return null;
    // Death strips item enchantments (VTank's death handler clears its item timers too).
    if (me.dead) { this.itemTimers.clear(); return null; }
    this.itemTimers.bind({ guid: me.guid, name: me.name });
    this.itemTimers.expire();
    // Auto Fellow Mgmt needs no spell data: before the spell table is loaded it is all there is to do.
    if (!fam) return this.fellowStep(settings);
    const stance: Stance = me.combatMode === 'unknown' ? 'peace' : me.combatMode;
    // Magic mode refused (no wand): spells are left out for a while (toMagic).
    const spells = this.now() < this.noMagicUntil ? [] : this.spells(p.vtank.excludedScarabs);
    const skills = this.skills();
    for (const [g, until] of this.blocked) if (until <= this.now()) this.blocked.delete(g);
    this.noteFights();
    const near: CombatMonster[] = snap.nearby.filter((o) => o.kind === 'monster' && !o.dying && !this.blocked.has(o.guid)).map((o) => {
      const blow = this.blows.get(o.guid);
      return { guid: o.guid, name: o.name, dist: o.dist, relBearing: o.relBearing, ...(o.health !== undefined ? { health: o.health } : {}), ...(blow !== undefined ? { lastDamage: blow } : {}) };
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
      fellows: this.api.fellowsNear(), boost: this.boostPoints(settings, stance),
    });
    if (r) {
      if (r.kind === 'cast') return { label: `recharge: ${r.why}`, run: () => { this.castSpent(settings); return this.cast(r.spell.id, r.target ?? 'self'); } };
      if (r.kind === 'use') return { label: `recharge: ${r.why}`, run: async () => this.api.useOn(r.item.guid, 'self') };
      // Switching to magic mode to recharge starts the recharge boost.
      if (r.to === 'magic') return this.toMagic(p, `recharge: ${r.why}`, () => { this.boostUntil = this.now() + Math.max(0, Number(opt(settings, 'RechargeBoostTimeSeconds')) || 0) * 1000; });
      return { label: `recharge: ${r.why}`, run: async () => this.api.combatMode(r.to) };
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

    // 6. Auto Fellow Mgmt: a /tell command while you lead the fellowship.
    const fellow = this.fellowStep(settings);
    if (fellow) return fellow;

    // 7. A pet when the fight is big enough, then combat.
    const combatBase = (): Omit<CombatInput, 'monsters'> => {
      const wieldedItems = this.api.inventory().filter((i) => i.where === 'equipped');
      return {
        rows: p.vtank.monsters, spells, skills, items: this.items(), itemNames: p.vtank.items.map((x) => x.name),
        wielded: { weapon: wieldedItems.find((i) => /weapon|wand|staff|orb|caster/i.test(`${i.type ?? ''} ${i.slot ?? ''}`))?.name, offhand: wieldedItems.find((i) => /shield/i.test(`${i.type ?? ''} ${i.slot ?? ''}`))?.name },
        stance, settings, castLog: this.castLog, now: this.now(), selectedGuid: this.api.selectedGuid(), families: fam.combat,
        ...(this.monsterFacts ? { monsterFacts: this.monsterFacts } : {}),
      };
    };
    // A pet counts every monster within pet range, which may reach past Monster Range.
    if (ctx.combat && petMonsters.length) { const pet = this.petStep(p, settings, combatBase(), petMonsters); if (pet) return pet; }

    if (hasTarget) {
      const loading = this.monstersLoading;
      if (loading) return { label: 'combat: reading the monster table', run: async () => { await loading; return { ok: true, message: 'monster table read' }; } };
      const c = planCombat({ ...combatBase(), monsters });
      if (c) {
        const name = monsters.find((m) => m.guid === (c as { target?: number }).target)?.name;
        if (name && 'target' in c) this.fought.set(c.target, { name, at: this.now() });
        if (c.kind === 'cast') return { label: `combat: ${c.why}`, run: async () => {
          this.castSpent(settings);
          const res = await this.cast(c.spell.id, c.target);
          // A wall or the ground in the way: leave this one for 15 s rather than casting into the wall again.
          if (!res.ok && /no line of fire/i.test(res.message)) this.blocked.set(c.target, this.now() + 15_000);
          // A debuff counts only once the server says it went on ("You cast Imperil Other I on Drudge
          // Skulker"): a resist, a fizzle or no answer leaves it due, so it is cast again (VTank
          // DebuffScheduler records only a success). Before 2026-10-11 a resisted debuff was logged for
          // its whole duration and never recast.
          if (c.spell.duration > 0 && castConfirmed(res, c.spell.name)) this.castLog.push({ guid: c.target, category: c.spell.category, at: this.now(), duration: c.spell.duration });
          if (this.castLog.length > 200) this.castLog.splice(0, this.castLog.length - 200);
          return res;
        } };
        if (c.kind === 'attack') return { label: `combat: ${c.why}`, run: async () => {
          // One attack order per target: sending it again restarts the run-up. Then wait for it to end
          // (or 10 s, so recharging gets a look in); a fresh decision on the same target just waits on.
          const since = this.api.currentSeq();
          const same = this.lastAttack && this.lastAttack.guid === c.target && this.now() - this.lastAttack.at < 60_000;
          // AutoAttackPower / UseRecklessness: the bar for the row's element and the wielded weapon (attackPower.ts).
          const power = same ? 'bar' : autoAttackPower({ element: c.element ?? null, items: this.items(), settings, skills });
          const res = same ? { ok: true, message: `still fighting #${c.target.toString(16)}` } : this.api.attack(c.target, { height: vtAttackHeight(settings), power });
          if (!same && res.ok) this.lastAttack = { guid: c.target, at: this.now() };
          if (!res.ok) return res;
          const ev = await this.api.waitFor({ types: ['target-died', 'target-lost', 'death', 'vitals-low'] }, 10_000);
          const end = ev.find((e) => e.seq > since && (e.guid === c.target || e.type === 'death' || e.type === 'vitals-low'));
          if (end && end.type !== 'vitals-low') this.lastAttack = null;
          return res;
        } };
        if (c.kind === 'equip') return { label: `combat: ${c.why}`, run: async () => this.api.equip(c.item.guid) };
        if (c.to === 'magic') return this.toMagic(p, `combat: ${c.why}`);
        return { label: `combat: ${c.why}`, run: async () => this.api.combatMode(c.to) };
      }
    }

    // 8. Nothing to fight: crafting (AutoCraftItems, in peace mode), SpellCompMin-Idle pea splitting and
    // the idle buff top-off (IdleBuffTopoff: VTank's BuffSelfIdle, after Attack).
    if (hasTarget) return null;
    const craft = this.craftStep(p, settings, stance, ctx.idle);
    if (craft) return craft;
    if (!ctx.idle) return null;
    return this.splitStep(p, settings, 'idle') ?? this.buffStep(p, settings, ctx, fam, spells, skills, me.level, stance, true);
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
      itemRemaining: (target, spell) => (target === 'weapon'
        ? (weaponRef ? this.itemTimers.remainingOn(weaponRef, spell.category, spell.power) : null)
        : this.itemTimers.remainingOnAll(this.wornVestments(), spell.category, spell.power)),
    });
    // Add (no buffs) on the Items tab: that weapon gets no auras (a Force Buff round included).
    const noBuffs = new Set(p.vtank.items.filter((x) => x.noBuffs).map((x) => x.name.toLowerCase()));
    if (weapon && noBuffs.has(weapon.name.toLowerCase())) { b.due = b.due.filter((x) => x.target !== 'weapon'); b.wanted = b.wanted.filter((x) => x.target !== 'weapon'); }
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
          const res = await this.cast(nx.spell.id, target);
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
    if (!next) return null;
    const mode = toMagicFirst(`buff: ${next.why}`);
    if (mode) return mode;
    const target = next.target === 'weapon' && weapon && !next.spell.self ? weapon.guid : 'self';
    const item = onItem(next);
    return { label: `buff: ${next.why}`, run: async () => {
      this.castSpent(settings);
      const res = await this.cast(next.spell.id, target);
      const ok = item ? this.noteItemBuff(res, next.spell, item, weaponRef) : castConfirmed(res, next.spell.name);
      const cat = next.spell.category;
      if (ok) this.buffMisses.delete(cat);
      else {
        const m = this.buffMisses.get(cat) ?? { n: 0, until: 0 };
        m.n++;
        if (m.n >= BUFF_TRIES) { m.n = 0; m.until = this.now() + 60_000; }
        this.buffMisses.set(cat, m);
      }
      return res;
    } };
  }
  /** Buff families whose casts didn't take, by category: misses in a row, and when it may be tried again. */
  private buffMisses = new Map<number, { n: number; until: number }>();

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
