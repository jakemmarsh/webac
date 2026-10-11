/**
 * VirindiTank's automatic weapon choice: what a Monsters-tab row whose Weapon
 * is <AUTO> fights with (docs/vtank-parity-gaps.md §1.3; facts from MOSS
 * `VtankWeaponLadder` and `VtankWeaponElement`, no code copied; CHG .168:
 * "With weapon Auto and the target already vulned, it prefers armor-rending /
 * crit-strike / crushing-blow weapons over rend weapons").
 *
 * Only weapons and casters on the Items tab are considered, in its order, and
 * a later one of a kind replaces an earlier one. The ladder:
 * 1. A slayer for the monster's species (SlayerCreatureType, PropertyInt 166,
 *    against the era's monster table's CreatureType).
 * 2. For each wanted element in order (the monster's weak elements, or the
 *    row's one element), one the monster already carries that element's
 *    vulnerability for: the best-rated weapon of that element.
 * 3. The first wanted element a weapon gets from its imbue or its cleave.
 * 4. A void caster whose imbue makes it one (none exist in retail data; kept
 *    for the order).
 * 5. The first wanted element a rated weapon deals.
 * 6. A rated caster with no element.
 * 7. The first wanted element any weapon deals.
 * 8. Any launcher.
 * 9. The last weapon on the Items tab (a caster whose school you lack only if
 *    nothing else is listed).
 * A caster counts only when you have its school trained (War Magic, or Void
 * Magic for a nether one); a launcher only for elements you carry ammunition
 * of (canDeliver). A plain launcher with a rating stands in for every wanted
 * element it can be fed.
 *
 * Rating (MOSS RatingOf): Armor Rend 4000, Critical Strike 2000, Crippling
 * Blow 1000 (ImbuedEffect bits 0x4, 0x1, 0x2), Armor Cleaving 400 (IgnoreArmor
 * set), Crushing Blow 200 (CriticalMultiplier set), Biting Strike 100
 * (CriticalFrequency set): the same properties the appraisal panel names.
 *
 * Every property comes from the item's own examination, so each era's own
 * items decide (1999 has no imbues or slayers, so its ladder is elements only).
 */
import { PropertyFloat, PropertyInt, type PlanItem } from '@ac/shared';

export type LadderElement = 'pierce' | 'bludgeon' | 'slash' | 'acid' | 'lightning' | 'cold' | 'fire' | 'nether';

/** ImbuedEffect bits (ACE ImbuedEffectType). */
const CRITICAL_STRIKE = 0x1, CRIPPLING_BLOW = 0x2, ARMOR_REND = 0x4;
const REND: Array<[number, LadderElement]> = [[0x40, 'acid'], [0x20, 'bludgeon'], [0x80, 'cold'], [0x200, 'fire'], [0x100, 'lightning'], [0x10, 'pierce'], [0x8, 'slash']];
const REND_MASK = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x200;
/** DamageType bits in the order VTank reads a weapon's element (acid, bludgeon, cold, fire, lightning, slash, pierce, then nether). */
const DAMAGE_ORDER: Array<[number, LadderElement]> = [[0x20, 'acid'], [0x4, 'bludgeon'], [0x8, 'cold'], [0x10, 'fire'], [0x40, 'lightning'], [0x1, 'slash'], [0x2, 'pierce'], [0x400, 'nether']];
/** Cleaving is read the same way, without nether. */
const CLEAVE_ORDER = DAMAGE_ORDER.slice(0, 7);

const IT_MELEE = 0x1, IT_MISSILE = 0x100, IT_CASTER = 0x8000;

/**
 * The element a weapon strikes with: a single rend imbue (exactly one rend
 * bit and no critical imbue), else the resistance it cleaves
 * (ResistanceModifierType, PropertyInt 263), else its DamageType (45).
 * `damage: false` asks only the imbue and the cleave. Null: none says.
 */
export function weaponElement(item: Pick<PlanItem, 'ints'>, damage = true): LadderElement | null {
  const imbue = (item.ints?.[PropertyInt.ImbuedEffect] ?? 0) & REND_MASK;
  for (const [bit, el] of REND) if (imbue === bit) return el;
  const cleave = item.ints?.[PropertyInt.ResistanceModifierType] ?? 0;
  for (const [bit, el] of CLEAVE_ORDER) if (cleave & bit) return el;
  if (!damage) return null;
  const dt = item.ints?.[PropertyInt.DamageType] ?? 0;
  for (const [bit, el] of DAMAGE_ORDER) if (dt & bit) return el;
  return null;
}

/** What a weapon's imbues and properties are worth when weapons are compared (0: nothing beyond its element). */
export function weaponRating(item: Pick<PlanItem, 'ints' | 'floats'>): number {
  const imbue = item.ints?.[PropertyInt.ImbuedEffect] ?? 0;
  const f = item.floats ?? {};
  return ((imbue & ARMOR_REND) ? 4000 : 0) + ((imbue & CRITICAL_STRIKE) ? 2000 : 0) + ((imbue & CRIPPLING_BLOW) ? 1000 : 0)
    + (f[PropertyFloat.IgnoreArmor] !== undefined ? 400 : 0) + (f[PropertyFloat.CriticalMultiplier] !== undefined ? 200 : 0) + (f[PropertyFloat.CriticalFrequency] !== undefined ? 100 : 0);
}

export interface LadderInput {
  /** The Items-tab items you carry, in the tab's order. */
  items: PlanItem[];
  /** The elements the fight wants, best first. */
  wanted: LadderElement[];
  /** The monster's CreatureType, or undefined when the era's table doesn't list it. */
  species?: number;
  /** Whether a weapon of this kind can put the element on the monster (a launcher needs ammunition of it). */
  canDeliver: (item: PlanItem, el: LadderElement) => boolean;
  /** Whether the monster already carries that element's vulnerability. */
  vulnerable: (el: LadderElement) => boolean;
  warTrained: boolean;
  voidTrained: boolean;
  /** An item the row already took (its offhand). */
  exclude?: number;
}

const kindOf = (i: PlanItem): 'caster' | 'launcher' | 'melee' | null => {
  const t = i.itemType ?? 0;
  if (t & IT_CASTER) return 'caster';
  if (t & IT_MISSILE) return /(^|\+)MissileAmmo(\+|$)/.test(i.fits ?? '') ? null : 'launcher';
  if (t & IT_MELEE) return 'melee';
  return null;
};

/** The weapon VTank's ladder picks for an <AUTO> row, or undefined when the Items tab lists none. */
export function pickLadderWeapon(input: LadderInput): PlanItem | undefined {
  const byImbue = new Map<LadderElement, PlanItem>();
  const byRating = new Map<LadderElement, { item: PlanItem; rating: number }>();
  const byElement = new Map<LadderElement, PlanItem>();
  let slayer: PlanItem | undefined, casterFallback: PlanItem | undefined, anyLauncher: PlanItem | undefined;
  let last: PlanItem | undefined, lastUnusable: PlanItem | undefined;
  const isSlayer = (i: PlanItem): boolean => input.species !== undefined && input.species > 0 && i.ints?.[PropertyInt.SlayerCreatureType] === input.species;
  for (const item of input.items) {
    const kind = kindOf(item);
    if (!kind || item.guid === input.exclude) continue;
    if (kind === 'caster') {
      lastUnusable = item;
      if ((input.warTrained || input.voidTrained) && isSlayer(item)) slayer = item;
      const nether = ((item.ints?.[PropertyInt.DamageType] ?? 0) & 0x400) !== 0;
      if (nether ? !input.voidTrained : !input.warTrained) continue;
    }
    if (kind === 'launcher') anyLauncher = item;
    if (isSlayer(item)) slayer = item;
    const imbued = weaponElement(item, false);
    if (imbued && input.canDeliver(item, imbued)) byImbue.set(imbued, item);
    let element = weaponElement(item);
    const elementless = element === null;
    if (elementless && kind === 'launcher') element = 'pierce';
    if (element && input.canDeliver(item, element)) byElement.set(element, item);
    const rating = weaponRating(item);
    if (rating > 0) {
      if (element && input.canDeliver(item, element) && rating > (byRating.get(element)?.rating ?? 0)) byRating.set(element, { item, rating });
      // A plain launcher shoots whatever the quiver holds: a well-rated one stands in for every element it can be fed.
      if (kind === 'launcher' && elementless) {
        for (const el of input.wanted) if (el !== element && input.canDeliver(item, el) && rating > (byRating.get(el)?.rating ?? 0)) byRating.set(el, { item, rating });
      }
      if (kind === 'caster' && elementless) casterFallback = item;
    }
    last = item;
  }
  if (slayer) return slayer;
  for (const el of input.wanted) { const r = byRating.get(el); if (r && input.vulnerable(el)) return r.item; }
  for (const el of input.wanted) { const i = byImbue.get(el); if (i) return i; }
  const voidCaster = byImbue.get('nether');
  if (voidCaster) return voidCaster;
  for (const el of input.wanted) { const r = byRating.get(el); if (r) return r.item; }
  if (casterFallback) return casterFallback;
  for (const el of input.wanted) { const i = byElement.get(el); if (i) return i; }
  if (anyLauncher) return anyLauncher;
  return last ?? lastUnusable;
}
