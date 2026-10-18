/**
 * The weapon in your hand, and its kind, from the agent's inventory rows.
 *
 * The page's worn rows (main.ts `inventory`) carry the EquipMask slot names (`slot: 'Held'` for a wand, staff or orb)
 * and the ACE ItemType bits (`itemType`), but no `type` label: only items in a pack get one. The macro read the kind
 * off `type` and `slot` text (/weapon|wand|staff|orb|caster/), which a worn wand ("Held", no type) never matched, so
 * Claude Arcanist's routine had no wielded weapon: it wanted none of the caster auras (Aura of Hermetic Link Self V,
 * Aura of Spirit Drinker Self V) and let both run out (2026-10-18 05:45Z, Aerbax Laboratory). The tests' fakes gave
 * the wand `type: 'Caster'`, so they passed.
 *
 * By the numbers first (ACE ItemType: MeleeWeapon 0x1, MissileWeapon 0x100, Caster 0x8000; EquipMask: MeleeWeapon
 * 0x00100000, MissileWeapon 0x00400000, MissileAmmo 0x00800000, Held 0x01000000, TwoHanded 0x02000000), then the text.
 */
import type { AgentItem } from '../types.ts';

export type WieldedKind = 'melee' | 'missile' | 'caster';

const IT_MELEE = 0x1, IT_MISSILE = 0x100, IT_CASTER = 0x8000;
const EM_MELEE = 0x00100000, EM_SHIELD = 0x00200000, EM_MISSILE = 0x00400000, EM_AMMO = 0x00800000, EM_HELD = 0x01000000, EM_TWO_HANDED = 0x02000000;
const EM_WEAPON = EM_MELEE | EM_MISSILE | EM_HELD | EM_TWO_HANDED;

const text = (i: AgentItem): string => `${i.type ?? ''} ${i.slot ?? ''}`;

/** The kind of a wielded item, or null when it is no weapon (armor, a shield, ammunition). */
export function weaponKind(i: AgentItem): WieldedKind | null {
  const mask = i.mask ?? 0;
  const t = text(i);
  // Ammunition in its slot and a shield are no weapon, whatever their ItemType (arrows are MissileWeapon in ACE).
  if (mask & (EM_AMMO | EM_SHIELD) && !(mask & EM_WEAPON)) return null;
  if (!mask && /ammo|shield/i.test(i.slot ?? '')) return null;
  const it = i.itemType ?? 0;
  const inHand = (mask & EM_WEAPON) !== 0 || /weapon|held|twohanded|wand|staff|orb|caster|missile|bow/i.test(t);
  if (!inHand) return null;
  if (it & IT_CASTER) return 'caster';
  if (it & IT_MISSILE) return 'missile';
  if (it & IT_MELEE) return 'melee';
  if (mask & EM_HELD) return 'caster';
  if (mask & EM_MISSILE) return 'missile';
  if (mask & (EM_MELEE | EM_TWO_HANDED)) return 'melee';
  if (/missile|bow/i.test(t)) return 'missile';
  if (/wand|staff|orb|caster|held/i.test(t)) return 'caster';
  if (/weapon|twohanded/i.test(t)) return 'melee';
  return null;
}

/** The weapon you wield (a caster, launcher or melee weapon), or null with none in hand. */
export function wieldedWeapon(items: AgentItem[]): { item: AgentItem; kind: WieldedKind } | null {
  for (const i of items) {
    if (i.where !== 'equipped') continue;
    const kind = weaponKind(i);
    if (kind) return { item: i, kind };
  }
  return null;
}

/** The shield you wear, or undefined. */
export function wornShield(items: AgentItem[]): AgentItem | undefined {
  return items.find((i) => i.where === 'equipped' && (((i.mask ?? 0) & EM_SHIELD) !== 0 || /shield/i.test(text(i))));
}
