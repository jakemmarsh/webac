/**
 * AGENT.vtank-window — VirindiTank's macro from its tabs: what the routine
 * engine's macro does for a profile with VirindiTank data (`profile.vtank`).
 * Each step asks the planners in VTank's order and does the first thing one
 * of them wants (docs/vtank-macro-behavior.md):
 *
 * 1. Recharge (Vitals tab; spells, kits and food on the Consumables tab).
 * 2. Combat within Monster Range (Monsters tab: target, debuffs, attack; Items tab: the weapon).
 * 3. Buffs (VTank's automatic list, Extra Buff Spells, Blacklisted Buff Families).
 *
 * The planners are pure (buffPlan / rechargePlan / combatPlan); this reads
 * the agent API into their inputs and turns their answer into one action
 * through the UI's own paths. Spell families are built once per spell table,
 * so each era's own table decides what exists.
 */
import { vtOption, type PlanItem, type PlanSkill, type PlanSpell, type RoutineProfile, type Stance, type VtankProfileData } from '@ac/shared';
import type { AgentApi } from '../AgentApi.ts';
import type { AgentResult } from '../types.ts';
import { buildBuffFamilies, planBuffs, type BuffFamilies } from './buffPlan.ts';
import { buildCombatFamilies, planCombat, type CombatFamilies, type CombatMonster } from './combatPlan.ts';
import { buildRechargeFamilies, planRecharge, type RechargeFamilies } from './rechargePlan.ts';

/** One thing to do, and doing it. */
export interface VtStep { label: string; run: () => Promise<AgentResult> }

const num = (v: unknown, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

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
  /** Force Buff: the families already recast in this forced round (null: not forcing). */
  private forced: Set<number> | null = null;
  /** VirindiTank's Force Buff: recast every buff in the list now, whatever time is left; pausing holds the round. */
  forceBuff(): void { this.forced = new Set(); }
  cancelForceBuff(): void { this.forced = null; }
  get forcing(): boolean { return this.forced !== null; }
  /** The target the last attack order went to (not sent again while that fight goes on). */
  private lastAttack: { guid: number; at: number } | null = null;

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

  constructor(private readonly api: AgentApi, private readonly now: () => number) {}

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

  /** Spells you know, less those that need an Excluded Scarab Type (the Consumables tab: such spells are not cast). */
  private spells(excluded: string[] = []): PlanSpell[] {
    const no = new Set(excluded.map((x) => x.trim().toLowerCase()).filter(Boolean));
    return this.api.spells('', 1000).flatMap((s) => (s.category === undefined || s.power === undefined || (no.size && this.api.spellComponents(s.id).some((c) => no.has(c.toLowerCase()))) ? [] : [{
      id: s.id, name: s.name, school: s.school, category: s.category, power: s.power, self: !!s.self, buff: !!s.buff, duration: s.duration ?? 0,
    }]));
  }

  private skills(): PlanSkill[] { return this.api.skillList(); }

  /** Carried items as the planners read them (examined ints / floats when known). */
  private items(names?: string[]): PlanItem[] {
    const want = names ? new Set(names.map((n) => n.toLowerCase())) : null;
    return this.api.inventory().filter((i) => !want || want.has(i.name.toLowerCase())).map((i) => {
      const d = this.api.itemData(i.guid);
      if (!d && want && !this.asked.has(i.guid)) { this.asked.add(i.guid); void this.api.appraise(i.guid); }
      return { guid: i.guid, name: i.name, ...(i.stack !== undefined ? { stack: i.stack } : {}), ...(d ? { ints: d.int, floats: d.float } : {}), ...(i.where === 'equipped' ? { equipped: true } : {}) };
    });
  }

  private tellMark = 0;
  private manaLookAt = -Infinity;
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
    const worn = this.api.inventory().filter((i) => i.where === 'equipped');
    if (this.now() - this.manaLookAt > 90_000) { this.manaLookAt = this.now(); for (const w of worn) void this.api.appraise(w.guid); }
    const low = worn.find((w) => { const d = this.api.itemData(w.guid); const cur = d?.int[107]; const max = d?.int[108]; return cur !== undefined && max ? (cur / max) * 100 < pct : false; });
    if (!low) return null;
    const stone = this.items(p.vtank.consumables).find((i) => !i.equipped && (i.ints?.[107] ?? 0) > 0);
    if (!stone) return null;
    // Its mana will change: look again soon.
    this.manaLookAt = this.now() - 85_000;
    return { label: `mana: ${low.name} is low, using ${stone.name}`, run: async () => this.api.useOn(stone.guid, 'self') };
  }

  /**
   * VirindiTank's Summon Pets: with at least Pet Min. Monsters within pet
   * range (Monster Range, or Custom Pet Range with PetRangeMode 1), use a pet
   * device from the Items tab (one with PetClass, PropertyInt 266, when
   * examined). One summon per 45 s: ACE refuses a second while one is out.
   * (The PetDmg column's element choice is not built: the first device is used.)
   */
  private petStep(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>, monsters: Array<{ dist: number }>): VtStep | null {
    if (!(settings.SummonPets === true || settings.SummonPets === 'true')) return null;
    if (this.now() - this.lastSummonAt < 45_000) return null;
    const range = Number(settings.PetRangeMode) === 1 ? Number(settings.PetCustomRange) || 5 : Number(settings.AttackDistance) || 5;
    const need = Math.max(1, Number(settings.PetMonsterDensity) || 1);
    if (monsters.filter((m) => m.dist <= range).length < need) return null;
    const device = this.items(p.vtank.items.map((x) => x.name)).find((i) => i.ints?.[266] !== undefined);
    if (!device) return null;
    this.lastSummonAt = this.now();
    return { label: `pet: summoning with ${device.name}`, run: () => this.api.use(device.guid) };
  }
  private fellowAsks: Array<{ name: string; at: number; tries: number }> = [];
  private fellowSent: number[] = [];

  /**
   * VirindiTank's Auto Fellow Mgmt (its Fellowship Commands): while you lead
   * the fellowship, a /tell "xp" recruits the teller; one out of reach gets
   * another try 20 s later; "help" answers with the commands. At most 8 of
   * these in 3 minutes, as VTank. (Its waiting line and leader votes are not
   * built; "help" lists only what is.)
   */
  private fellowStep(settings: Record<string, string | number | boolean>): VtStep | null {
    const on = settings.AutoFellowManagement === true || settings.AutoFellowManagement === 'true';
    const ev = this.api.eventsSince(this.tellMark);
    if (ev.length) this.tellMark = ev[ev.length - 1].seq;
    if (!on) return null;
    const info = this.api.fellowshipInfo();
    for (const e of ev) {
      const m = /^\(tell\) (.+?) tells you, "\s*(xp|help)\s*"$/i.exec(e.text);
      if (!m) continue;
      if (!info?.leader) continue;
      this.fellowAsks.push({ name: m[1], at: this.now(), tries: m[2].toLowerCase() === 'help' ? -1 : 0 });
    }
    const t = this.now();
    this.fellowSent = this.fellowSent.filter((x) => t - x < 180_000);
    if (this.fellowSent.length >= 8) return null;
    const ask = this.fellowAsks.find((a) => a.tries < 0 || (a.tries === 0) || (a.tries === 1 && t - a.at >= 20_000));
    if (!ask) return null;
    if (ask.tries < 0) {
      this.fellowAsks.splice(this.fellowAsks.indexOf(ask), 1);
      this.fellowSent.push(t);
      return { label: `fellow: help for ${ask.name}`, run: async () => this.api.say(`/tell ${ask.name}, Tell me "xp" to join the fellowship.`) };
    }
    if ((info?.count ?? 0) >= 9) {
      this.fellowAsks.splice(this.fellowAsks.indexOf(ask), 1);
      this.fellowSent.push(t);
      return { label: `fellow: ${ask.name} asked, full`, run: async () => this.api.say(`/tell ${ask.name}, The fellowship is full.`) };
    }
    const near = this.api.snapshot({ radius: 60, max: 80 }).nearby.find((o) => o.kind === 'player' && o.name.toLowerCase() === ask.name.toLowerCase());
    if (!near) {
      if (ask.tries === 0) { ask.tries = 1; ask.at = t; return null; }
      this.fellowAsks.splice(this.fellowAsks.indexOf(ask), 1);
      return null;
    }
    this.fellowAsks.splice(this.fellowAsks.indexOf(ask), 1);
    this.fellowSent.push(t);
    return { label: `fellow: recruiting ${ask.name}`, run: () => this.api.fellowship('recruit', near.name) };
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
    const isDispel = (desc: string) => /dispels?\b[^.]*\bnegative\b[^.]*\blife magic\b/i.test(desc);
    if (castSelf) {
      const life = skills.find((s) => /^life magic$/i.test(s.name));
      const th = Number(settings['SpellDiffExcessThreshold-Hunt']) || 25;
      const best = spells.filter((s) => s.self && isDispel(t.spells.get(s.id)?.desc ?? '') && (!life || s.power + th <= life.buffed)).sort((a, b) => b.power - a.power)[0];
      if (best) return { label: `dispel: ${bad.name} on you`, run: () => this.api.cast(best.id, 'self') };
    }
    if (useItems) {
      for (const i of this.api.inventory()) {
        if (i.where === 'equipped') continue;
        const d = this.api.itemData(i.guid);
        if (!d) { if (/gem|food|potion|misc/i.test(i.type ?? '') && !this.asked.has(i.guid)) { this.asked.add(i.guid); void this.api.appraise(i.guid); } continue; }
        const sid = d.did?.[28];
        if (sid && isDispel(t.spells.get(sid)?.desc ?? '')) return { label: `dispel: ${bad.name} on you, using ${i.name}`, run: async () => this.api.useOn(i.guid, 'self') };
      }
    }
    return null;
  }

  /** What the macro should do now, or null. `range`: Monster Range (metres). */
  decide(p: RoutineProfile & { vtank: VtankProfileData }, settings: Record<string, string | number | boolean>, ctx: { combat: boolean; buffing: boolean; idle: boolean }): VtStep | null {
    // 0. Auto Fellow Mgmt: someone told you "xp" while you lead the fellowship (needs no spell data).
    const fellow = this.fellowStep(settings);
    if (fellow) return fellow;
    const fam = this.families();
    const snap = this.api.snapshot({ radius: Math.max(num(settings.AttackDistance, 5), 60), max: 40 });
    const me = snap.me;
    if (!fam || !me || me.dead) return null;
    const stance: Stance = me.combatMode === 'unknown' ? 'peace' : me.combatMode;
    const spells = this.spells(p.vtank.excludedScarabs);
    const skills = this.skills();
    const range = num(settings.AttackDistance, vtOption('AttackDistance')!.default as number);
    const monsters: CombatMonster[] = snap.nearby.filter((o) => o.kind === 'monster' && !o.dying && o.dist <= range).map((o) => ({ guid: o.guid, name: o.name, dist: o.dist, relBearing: o.relBearing, ...(o.health !== undefined ? { health: o.health } : {}) }));
    const hasTarget = ctx.combat && monsters.length > 0;

    // 0. A level-7 vuln on you (Use Dispel Items / Cast Dispel Self).
    const dispel = this.dispelStep(fam, settings, spells, skills);
    if (dispel) return dispel;

    // 1. Recharge.
    const r = planRecharge({
      vitals: { health: { cur: me.health.cur, max: me.health.max }, stamina: { cur: me.stamina.cur, max: me.stamina.max }, mana: { cur: me.mana.cur, max: me.mana.max } },
      stance, hasTarget, settings, spells, skills, consumables: this.items(p.vtank.consumables), rechargeFamilies: fam.recharge,
      fellows: this.api.fellowsNear(),
    });
    if (r) {
      if (r.kind === 'cast') return { label: `recharge: ${r.why}`, run: () => this.api.cast(r.spell.id, r.target ?? 'self') };
      if (r.kind === 'use') return { label: `recharge: ${r.why}`, run: async () => this.api.useOn(r.item.guid, 'self') };
      return { label: `recharge: ${r.why}`, run: async () => this.api.combatMode(r.to) };
    }

    // Worn items' mana, then a pet when the fight is big enough.
    const mana = this.manaStep(p, settings);
    if (mana) return mana;
    if (hasTarget) { const pet = this.petStep(p, settings, monsters); if (pet) return pet; }

    // 2. Combat.
    if (hasTarget) {
      const inv = this.items();
      const wieldedItems = this.api.inventory().filter((i) => i.where === 'equipped');
      const c = planCombat({
        monsters, rows: p.vtank.monsters, spells, skills, items: inv, itemNames: p.vtank.items.map((x) => x.name),
        wielded: { weapon: wieldedItems.find((i) => /weapon|wand|staff|orb|caster/i.test(`${i.type ?? ''} ${i.slot ?? ''}`))?.name, offhand: wieldedItems.find((i) => /shield/i.test(`${i.type ?? ''} ${i.slot ?? ''}`))?.name },
        stance, settings, castLog: this.castLog, now: this.now(), selectedGuid: this.api.selectedGuid(), families: fam.combat,
      });
      if (c) {
        const name = monsters.find((m) => m.guid === (c as { target?: number }).target)?.name;
        if (name && 'target' in c) this.fought.set(c.target, { name, at: this.now() });
        if (c.kind === 'cast') return { label: `combat: ${c.why}`, run: async () => {
          const res = await this.api.cast(c.spell.id, c.target);
          if (res.ok && c.spell.duration > 0) this.castLog.push({ guid: c.target, category: c.spell.category, at: this.now(), duration: c.spell.duration });
          if (this.castLog.length > 200) this.castLog.splice(0, this.castLog.length - 200);
          return res;
        } };
        if (c.kind === 'attack') return { label: `combat: ${c.why}`, run: async () => {
          // One attack order per target: sending it again restarts the run-up. Then wait for it to end
          // (or 10 s, so recharging gets a look in); a fresh decision on the same target just waits on.
          const since = this.api.currentSeq();
          const same = this.lastAttack && this.lastAttack.guid === c.target && this.now() - this.lastAttack.at < 60_000;
          const res = same ? { ok: true, message: `still fighting #${c.target.toString(16)}` } : this.api.attack(c.target);
          if (!same && res.ok) this.lastAttack = { guid: c.target, at: this.now() };
          if (!res.ok) return res;
          const ev = await this.api.waitFor({ types: ['target-died', 'target-lost', 'death', 'vitals-low'] }, 10_000);
          const end = ev.find((e) => e.seq > since && (e.guid === c.target || e.type === 'death' || e.type === 'vitals-low'));
          if (end && end.type !== 'vitals-low') this.lastAttack = null;
          return res;
        } };
        if (c.kind === 'equip') return { label: `combat: ${c.why}`, run: async () => this.api.equip(c.item.guid) };
        return { label: `combat: ${c.why}`, run: async () => this.api.combatMode(c.to) };
      }
    }

    // 3. Buffs (a Force Buff round first: every family once, whatever is left on it).
    if ((ctx.buffing || this.forced) && !hasTarget) {
      const weapon = this.api.inventory().find((i) => i.where === 'equipped' && /weapon|wand|staff|orb|caster/i.test(`${i.type ?? ''} ${i.slot ?? ''}`));
      const wielded = !weapon ? null : /missile|bow/i.test(`${weapon.type ?? ''} ${weapon.slot ?? ''}`) ? 'missile' : /wand|staff|orb|caster/i.test(`${weapon.type ?? ''} ${weapon.slot ?? ''}`) ? 'caster' : 'melee';
      const b = planBuffs({
        spells, skills, settings, idle: ctx.idle, families: fam.buff, level: me.level, wielded,
        active: this.api.activeSpellsNow(), extraBuffs: p.vtank.extraBuffs, blacklistedBuffs: p.vtank.blacklistedBuffs,
      });
      if (this.forced) {
        const f = this.forced;
        const nx = b.wanted.find((w) => !f.has(w.spell.category));
        if (!nx) this.forced = null;
        else {
          f.add(nx.spell.category);
          const target = nx.target === 'weapon' && weapon && !nx.spell.self ? weapon.guid : 'self';
          return { label: `force buff: ${nx.why}`, run: () => this.api.cast(nx.spell.id, target) };
        }
      }
      // Add (no buffs) on the Items tab: that weapon gets no auras.
      const noBuffs = new Set(p.vtank.items.filter((x) => x.noBuffs).map((x) => x.name.toLowerCase()));
      if (weapon && noBuffs.has(weapon.name.toLowerCase())) { b.due = b.due.filter((x) => x.target !== 'weapon'); b.wanted = b.wanted.filter((x) => x.target !== 'weapon'); }
      const next = ctx.buffing ? b.due[0] : undefined;
      if (next) {
        const target = next.target === 'weapon' && weapon && !next.spell.self ? weapon.guid : 'self';
        return { label: `buff: ${next.why}`, run: () => this.api.cast(next.spell.id, target) };
      }
    }
    return null;
  }
}
