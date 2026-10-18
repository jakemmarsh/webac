/**
 * Vitae (the death penalty) as facts for the agent's observe, `character` and the stream opening: how much it costs
 * and how XP works it off, from the Vitae enchantment the server sent (spell 666; its StatModValue is ACE's
 * Player.Vitae multiplier, 0.82 = 18% lower). Facts only: what a retail player reads in the Vitae panel and the
 * effects list, with the numbers worked out.
 *
 * The server's rules (ACE):
 *  - Each death takes 5% (PropertyManager vitae_penalty 0.05; EnchantmentManager.UpdateVitae subtracts it from the
 *    StatModValue), floored at GetMinVitae: at most (level − 1) × 3 % and never past 40% (vitae_penalty_max 0.40).
 *  - Player.Vitae scales every vital's max (CreatureVital.GetMaxValue: base and multiplier buffs × vitae, additive
 *    buffs after it) and every skill (CreatureSkill.Current, the same), not attributes (CreatureAttribute has no
 *    vitae). Retail's panel says the same: "your health, stamina, mana, and skills are temporarily reduced by N%".
 *  - Earned XP works it off (Player.GrantXP → UpdateXpAndLevel → UpdateXpVitae, every XP type but Allegiance): each
 *    VitaeCPPoolThreshold(vitae, DeathLevel) = (DeathLevel^2.5 × 2.5 + 20) × vitae^5 + 0.5 XP regains 1%
 *    (EnchantmentManager.ReduceVitae: StatModValue += 0.01f), and at 100% the enchantment is removed. The pool
 *    already earned is PropertyInt VitaeCpPool (129); DeathLevel (139) is your level at the last death.
 *  - A fellow's kill XP reaches you through Fellowship.SplitXp → member.GrantXP(…, XpType.Fellowship), the same
 *    UpdateXpVitae path, so it works vitae off too.
 */
import { vitaeCpPoolThreshold } from '@ac/shared';

/** The Vitae enchantment as the client holds it, with the two PropertyInts the panel reads. */
export interface VitaeState {
  /** The enchantment's StatModValue (ACE Player.Vitae): 1.0 = none, 0.95 = 5% lower, 0.60 = the 40% cap. */
  multiplier: number;
  /** PropertyInt VitaeCpPool (129): XP already earned toward the next 1%. */
  cpPool: number;
  /** PropertyInt DeathLevel (139), else your level (retail gmVitaeUI::Update's 0x8b → 0x19 fallback). */
  deathLevel: number;
  /** Your max health / stamina / mana as they would be without vitae (same buffs). */
  maxWithout?: { health: number; stamina: number; mana: number };
}

/** Your fellowship's XP split as the client has it (GameEventFellowshipFullUpdate's ShareXP / EvenShare, each fellow's level). */
export interface FellowshipXpState {
  shareXP: boolean;
  evenShare: boolean;
  members: Array<{ name: string; level: number; self: boolean }>;
  /** The era's XpTable characterLevelXpList (total XP per level), for a proportional split. */
  levelXpTable?: readonly bigint[] | null;
}

/** The retail Vitae panel's percentage (VitaePanelText.vitaePenaltyPercent). */
export function vitaePercent(multiplier: number): number {
  return Math.round((1 - multiplier) * 100);
}

/** XP still to earn to regain the next 1% (gmVitaeUI::Update: trunc(VitaeCPPoolThreshold) − VitaeCpPool). */
export function vitaeXpToNext(v: VitaeState): number {
  return Math.max(0, Math.trunc(vitaeCpPoolThreshold(Math.fround(v.multiplier), v.deathLevel)) - v.cpPool);
}

/**
 * XP still to earn until the penalty is gone: ACE Player.UpdateXpVitae's loop run to the end. Each step costs
 * (int)VitaeCPPoolThreshold(vitae, DeathLevel) and raises the float StatModValue by 0.01f (ReduceVitae), until it
 * reaches 1.0 (EpsilonEquals 0.0001, or above). The pool already earned counts against the first step.
 */
export function vitaeXpToClear(v: VitaeState): number {
  let m = Math.fround(v.multiplier);
  if (Math.abs(m - 1) < 0.0001 || m > 1) return 0;
  let total = 0;
  for (let i = 0; i < 100; i++) {
    total += Math.trunc(vitaeCpPoolThreshold(m, v.deathLevel));
    m = Math.fround(m + Math.fround(0.01));
    if (Math.abs(Math.fround(m - 1)) < 0.0001 || m > 1) break;
  }
  return Math.max(0, total - v.cpPool);
}

/** ACE Fellowship.GetMemberSharePercent: each fellow's cut of an even split, by fellowship size. */
export function aceEvenSharePercent(count: number): number {
  return ({ 1: 1, 2: 0.75, 3: 0.6, 4: 0.55, 5: 0.5, 6: 0.45, 7: 0.4, 8: 0.35, 9: 0.3 } as Record<number, number>)[count] ?? 1;
}

/** ACE Fellowship.MaxDistance: full share within this many metres of the fellow who earned it; none from twice it. */
export const FELLOW_SHARE_FULL_M = 600;

/**
 * Your cut (0..1) of the XP a fellow earns, at full range: ACE Fellowship.SplitXp. Even split: the size table; else
 * your XP-to-next-level over the sum of everyone's (GetXPToNextLevel); 0 when the fellowship doesn't share XP.
 */
export function fellowXpShare(f: FellowshipXpState): number {
  if (!f.shareXP || f.members.length < 2) return 0;
  if (f.evenShare) return aceEvenSharePercent(f.members.length);
  const t = f.levelXpTable;
  if (!t) return 0;
  const step = (lvl: number): number => (lvl >= 0 && lvl + 1 < t.length ? Math.max(0, Number(t[lvl + 1] - t[lvl])) : 0);
  const me = f.members.find((m) => m.self);
  const sum = f.members.reduce((a, m) => a + step(m.level), 0);
  return me && sum > 0 ? step(me.level) / sum : 0;
}

const n = (x: number): string => Math.round(x).toLocaleString('en-US');

/** "fellowship kills count too: …" for the vitae line; null when you're in no fellowship. */
export function fellowVitaeText(f: FellowshipXpState | null, fellowDist?: ReadonlyMap<string, number>): string | null {
  if (!f) return null;
  const others = f.members.filter((m) => !m.self);
  if (!others.length) return null;
  const names = others.map((m) => m.name).join(', ');
  const levels = f.members.map((m) => `${m.self ? 'you' : m.name} L${m.level}`).join(', ');
  if (!f.shareXP) return `fellowship kills don't count: your fellowship isn't sharing XP (${levels}; ACE shares only within 10 levels of the leader, or when all are level 50+, and only when its leader made it to share)`;
  const cut = fellowXpShare(f);
  const split = f.evenShare ? 'shared evenly' : 'shared by level (each by the XP their next level takes)';
  const where = others.map((m) => { const d = fellowDist?.get(m.name); return d !== undefined ? `${m.name} is ${n(d)} m away now` : `${m.name} is out of sight now`; }).join('; ');
  return `fellowship kills count too: XP is ${split} (${levels}), so each kill ${names} makes gives you ${Math.round(cut * 100)}% of its XP while you're within ${FELLOW_SHARE_FULL_M} m of ${others.length === 1 ? others[0].name : 'the fellow who made it'} (both outdoors, or inside the same landblock; less out to ${n(FELLOW_SHARE_FULL_M * 2)} m, none past), and that XP works vitae off like your own (${where})`;
}

/**
 * Observe's header line: "VITAE −18%: max health, stamina and mana and every skill 18% lower (max health 158, not
 * 193); 4,512 more XP regains 1%, about 470,331 XP clears it; fellowship kills count too: …". Null without vitae.
 */
export function vitaeHeadline(v: VitaeState | null, me: { health: number; stamina: number; mana: number }, fellow: string | null, brief = false): string | null {
  if (!v) return null;
  const pct = vitaePercent(v.multiplier);
  if (pct <= 0) return null;
  const w = v.maxWithout;
  const maxes = w ? ` (max health ${n(me.health)}, not ${n(w.health)}; stamina ${n(me.stamina)}, not ${n(w.stamina)}; mana ${n(me.mana)}, not ${n(w.mana)})` : '';
  const parts = [
    `VITAE −${pct}%: max health, stamina, mana and every skill ${pct}% lower${maxes}; attributes are not lowered`,
    `${n(vitaeXpToNext(v))} more XP regains 1%, about ${n(vitaeXpToClear(v))} XP clears it all (kill, quest and fellowship XP all count; set at your level at death, ${v.deathLevel})`,
    `each death adds 5% more (up to ${vitaeCapPercent(v.deathLevel)}% at your level)`,
  ];
  // `brief`: what it costs and what clears it; the rules were said at a look a moment ago.
  if (brief) return `${parts[0]}; ${parts[1]} (the rest: ac_observe full=true)`;
  if (fellow) parts.push(fellow);
  return parts.join('; ');
}

/** ACE EnchantmentManager.GetMinVitae: the most vitae a death can leave, in % ((level − 1) × 3, at least 1, at most vitae_penalty_max 40). */
export function vitaeCapPercent(level: number): number {
  return Math.min(40, Math.max(1, (level - 1) * 3));
}

/** The vitae buff row's name: "Vitae −18%" (the effects list's bare "Vitae" with the percentage it costs). */
export function vitaeBuffName(v: VitaeState | null): string {
  return v && vitaePercent(v.multiplier) > 0 ? `Vitae −${vitaePercent(v.multiplier)}%` : 'Vitae';
}

/** ACE SpellId.Vitae. */
export const VITAE_SPELL = 666;
