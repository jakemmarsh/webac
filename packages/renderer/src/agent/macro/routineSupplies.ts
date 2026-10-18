/**
 * What a routine profile's recharge uses up, against what you carry: each vital the macro restores from its
 * Consumables list (VTank's Consumables tab: healing kits and health potions at Heal at, stamina elixirs and potions at
 * Restam at, mana potions at Get Mana at), how many of the listed names you hold. The macro matches a Consumables entry
 * by its exact name, case aside (VtMacro.items), so a "Potion of Healing" in the pack is not a listed "Health Potion".
 *
 * "Bulwark fights" drinks a Stamina Elixir at 20% stamina; Bulwark carried none and found out mid-hunt, exhausted at
 * 0/277 with a Dread on him (stream, 2026-10-18 03:04Z). The segment opening (tools/stream/prompt.ts readinessBrief) and
 * observe (while a routine runs) say it. Facts only.
 */
import { vtOption, type RoutineProfile } from '@ac/shared';
import type { AgentItem } from '../types.ts';

export type SupplyVital = 'health' | 'stamina' | 'mana';

export interface RoutineSupply {
  vital: SupplyVital;
  /** Kits (bandaging) or drinks (potions, elixirs, food). */
  kind: 'kits' | 'drinks';
  /** The profile's Consumables names for it, as listed. */
  names: string[];
  /** The macro's mark (Recharge-Norm-HitP / -Stam / -Mana), percent of the vital. */
  at: number;
  /** How many of those you carry (stacks counted), and of which name. */
  carried: number;
  byName: Array<{ name: string; count: number }>;
}

const SETTING: Record<SupplyVital, string> = { health: 'Recharge-Norm-HitP', stamina: 'Recharge-Norm-Stam', mana: 'Recharge-Norm-Mana' };

/** The vital a Consumables name restores and whether it is a kit, by its words; null for anything else (mana stones, peas, food for buffs). */
export function supplyOf(name: string): { vital: SupplyVital; kind: 'kits' | 'drinks' } | null {
  if (/\bmana (stone|charge)\b|\bpeas?\b|\bscarab\b/i.test(name)) return null;
  if (/\b(?:Healing|Health|Herbal) Kit\b|\bHealing Tissue\b|\bkit\b/i.test(name)) return { vital: 'health', kind: 'kits' };
  if (/\bstamina\b/i.test(name)) return { vital: 'stamina', kind: 'drinks' };
  if (/\bmana\b/i.test(name)) return { vital: 'mana', kind: 'drinks' };
  if (/\b(?:health|healing|heal)\b/i.test(name)) return { vital: 'health', kind: 'drinks' };
  return null;
}

/** The mark a setting holds: the profile's value, else VTank's default. */
function mark(settings: Record<string, string | number | boolean> | undefined, name: string): number {
  const key = settings ? Object.keys(settings).find((k) => k.toLowerCase() === name.toLowerCase()) : undefined;
  const v = key !== undefined ? settings![key] : vtOption(name)?.default;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Each kind of supply the profile's recharge uses (its vital's mark above 1%: 1 is the profiles' "off"), with what you
 * carry of it. Empty when the profile has no vitals module, or lists no consumables.
 */
export function routineSupplies(profile: Pick<RoutineProfile, 'settings' | 'vtank' | 'modules'>, items: readonly AgentItem[]): RoutineSupply[] {
  if (profile.modules && profile.modules.vitals === false) return [];
  const names = profile.vtank?.consumables ?? [];
  const out: RoutineSupply[] = [];
  for (const vital of ['health', 'stamina', 'mana'] as const) {
    const at = mark(profile.settings, SETTING[vital]);
    if (at <= 1) continue;
    for (const kind of ['kits', 'drinks'] as const) {
      const listed = names.filter((n) => { const s = supplyOf(n); return s?.vital === vital && s.kind === kind; });
      if (!listed.length) continue;
      const want = new Set(listed.map((n) => n.toLowerCase()));
      const byName = new Map<string, number>();
      for (const it of items) {
        if (it.where === 'equipped' || !want.has(it.name.toLowerCase())) continue;
        byName.set(it.name, (byName.get(it.name) ?? 0) + (it.stack ?? 1));
      }
      const carried = [...byName.values()].reduce((a, b) => a + b, 0);
      out.push({ vital, kind, names: listed, at, carried, byName: [...byName].map(([name, count]) => ({ name, count })) });
    }
  }
  return out;
}

/** "Stamina Elixir, Stamina Potion or Stamina Tincture" */
const anyOf = (names: readonly string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`);

/**
 * "your routine drinks one at 20% stamina" / "your routine uses one at 55% health". With Life Magic (`spellsFirst`), a
 * health or stamina drink comes after the spell in magic mode: VTank's RechargeHandlerSet tries Regular Spell before
 * Recharge With Food there (rechargePlan.RECHARGE_HANDLER_SET), so Arcanist's potions are for when no Heal or Revitalize
 * of hers does it.
 */
function useText(s: RoutineSupply, spellsFirst: boolean): string {
  const after = spellsFirst && s.kind === 'drinks' && s.vital !== 'mana' ? `, in magic mode only when no ${s.vital === 'health' ? 'Heal' : 'Revitalize'} spell of yours does it` : '';
  return `your routine ${s.kind === 'kits' ? 'uses one' : 'drinks one'} at ${s.at}% ${s.vital}${after}`;
}

/** One supply as a readiness fact: "Stamina Elixir 0 (… ) " or "Excellent Healing Kit 3 (…)". */
export function supplyText(s: RoutineSupply, spellsFirst = false): string {
  if (!s.carried) return `${anyOf(s.names)}: NONE carried (${useText(s, spellsFirst)})`;
  return `${s.byName.map((b) => `${b.name} ${b.count}`).join(', ')} (${useText(s, spellsFirst)})`;
}

/**
 * The segment opening's line: every supply the routine uses, the empty ones first; null with none. "- routine supplies
 * (routine.json): Stamina Elixir, Stamina Potion or Stamina Tincture: NONE carried (your routine drinks one at 20%
 * stamina); Excellent Healing Kit 3 (your routine uses one at 55% health)".
 */
export function routineSuppliesLine(profile: Pick<RoutineProfile, 'settings' | 'vtank' | 'modules'>, items: readonly AgentItem[], opts: { where?: string; spellsFirst?: boolean } = {}): string | null {
  const s = routineSupplies(profile, items);
  if (!s.length) return null;
  const ordered = [...s.filter((x) => !x.carried), ...s.filter((x) => x.carried)];
  return `routine supplies (${opts.where ?? 'routine.json'}): ${ordered.map((x) => supplyText(x, !!opts.spellsFirst)).join('; ')}`;
}

/** Observe's fact while a routine runs: only the supplies it uses that you carry none of; null when every one is there. */
export function routineSuppliesMissing(profile: Pick<RoutineProfile, 'name' | 'settings' | 'vtank' | 'modules'>, items: readonly AgentItem[]): string | null {
  const none = routineSupplies(profile, items).filter((x) => !x.carried);
  if (!none.length) return null;
  return `"${profile.name}" needs what you don't carry: ${none.map((x) => supplyText(x)).join('; ')}`;
}
