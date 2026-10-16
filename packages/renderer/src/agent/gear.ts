/**
 * The paperdoll as text: every gear slot with what is worn there or EMPTY, and what a pack item would do if worn.
 * Information, not a decision (docs/agent-play.md, "What a player sees that the agent is told"): a player sees bare
 * hands on the paperdoll and reads an item's Armor Level off its examine window; the agent reads this.
 *
 * Data, all from the client's own object data (the same in every era: AC1999's ObjectCreate carries ValidLocations,
 * Location and Priority, its appraisal ArmorLevel 28; Objects1999.ts / Inventory1999.ts):
 *  - EquipMask (ACE ACE.Entity/Enum/EquipMask.cs): where an item goes (ValidLocations) and where it is worn
 *    (CurrentWieldedLocation). Clothing goes in the *Wear bits, armor in the *Armor bits, so a shirt and a breastplate
 *    are worn together; anything overlapping a worn item's bits replaces it (ACE Player_Inventory.TryEquipObject).
 *  - CoverageMask (ClothingPriority, ACE CoverageMask.cs): which body parts it covers. ACE Creature_BodyPart
 *    GetArmorLayers adds the ArmorLevel of every worn Clothing whose ClothingPriority overlaps the part that was hit.
 *  - ArmorLevel (PropertyInt 28) from the appraisal (ACE AppraiseInfo adds the item's armor enchantments).
 */
import type { AgentItem } from './types.ts';

interface BodyPart {
  name: string;
  /** CoverageMask bits for this part (under- and outerwear). */
  cov: number;
  /** EquipMask bits that put an item on this part: the clothing (under) bit and, where there is one, the armor bit. */
  wear: number;
  armor: number;
  /** What a player calls the thing that goes here, for "no gloves". */
  thing: string;
}

/** The paperdoll's body slots, in retail's ClothingPriorityToString order (AppraisalSystem @ 005b4f30). */
export const BODY_PARTS: readonly BodyPart[] = [
  { name: 'head', cov: 0x4000, wear: 0x1, armor: 0, thing: 'helm or hat' },
  { name: 'chest', cov: 0x8 | 0x400, wear: 0x2, armor: 0x200, thing: 'chest armor' },
  { name: 'abdomen', cov: 0x10 | 0x800, wear: 0x4, armor: 0x400, thing: 'abdomen armor' },
  { name: 'upper arms', cov: 0x20 | 0x1000, wear: 0x8, armor: 0x800, thing: 'upper arm armor' },
  { name: 'lower arms', cov: 0x40 | 0x2000, wear: 0x10, armor: 0x1000, thing: 'bracers' },
  { name: 'hands', cov: 0x8000, wear: 0x20, armor: 0, thing: 'gloves' },
  { name: 'upper legs', cov: 0x2 | 0x100, wear: 0x40, armor: 0x2000, thing: 'upper leg armor' },
  { name: 'lower legs', cov: 0x4 | 0x200, wear: 0x80, armor: 0x4000, thing: 'greaves' },
  { name: 'feet', cov: 0x10000, wear: 0x100, armor: 0, thing: 'boots' },
];

/** Every EquipMask bit that dresses the body (HeadWear 0x1 … LowerLegArmor 0x4000). */
const BODY_BITS = 0x7fff;

interface OtherSlot {
  name: string;
  /** Its EquipMask bits; a group of one-of slots (the two rings) lists each. */
  bits: number[];
  /** Shown only when something is worn there or a pack item fits it (later eras' cloak, trinket, sigil slots). */
  optional?: boolean;
}

/** The paperdoll's other slots (EquipMask). A weapon of any kind takes the one weapon hand. */
const OTHER_SLOTS: readonly OtherSlot[] = [
  { name: 'neck', bits: [0x8000] },
  { name: 'wrists', bits: [0x10000, 0x20000] },
  { name: 'rings', bits: [0x40000, 0x80000] },
  { name: 'shield', bits: [0x200000] },
  { name: 'weapon', bits: [0x100000 | 0x400000 | 0x1000000 | 0x2000000] },
  { name: 'ammo', bits: [0x800000] },
  { name: 'cloak', bits: [0x8000000], optional: true },
  { name: 'trinket', bits: [0x4000000], optional: true },
  { name: 'sigils', bits: [0x10000000, 0x20000000, 0x40000000], optional: true },
];

const worn = (items: readonly AgentItem[]): AgentItem[] => items.filter((i) => i.where === 'equipped');

const SHIELD_BIT = 0x200000;
/**
 * The wielded weapon that takes the shield hand too, or null: a caster (ItemType Caster 0x8000: an orb, wand or
 * staff, wielded Held 0x1000000), a two-handed weapon (TwoHanded 0x2000000), or a launcher (MissileWeapon 0x400000
 * with an AmmoType; a thrown weapon has none). Retail's BlocksUseOfShield @ 0055d3e0 (AutoWield dequips a shield for
 * one of these), and ACE CheckWeaponCollision refuses a shield beside one: "The Large Round Shield can't be wielded"
 * with an Orb held (stream, 2026-10-15). AutoWield's shield branch doesn't check (retail), so the server answers.
 */
export function shieldHandTakenBy(items: readonly AgentItem[]): AgentItem | null {
  return worn(items).find((w) => {
    const m = w.mask ?? 0;
    if (m & 0x2000000) return true;
    if ((w.itemType ?? 0) & 0x8000) return true;
    return (m & 0x400000) !== 0 && (w.ammoType ?? 0) > 0;
  }) ?? null;
}

/** "Orb #800012ab (a caster)" */
function shieldBlockerText(b: AgentItem): string {
  const m = b.mask ?? 0;
  const what = (b.itemType ?? 0) & 0x8000 ? 'a caster' : m & 0x2000000 ? 'a two-handed weapon' : 'a bow or launcher';
  return `${b.name} #${b.guid.toString(16)} (${what})`;
}

/** Why a shield can't go on now (the weapon that takes its hand), or null. */
export function shieldRefusal(it: AgentItem, items: readonly AgentItem[]): string | null {
  const vl = it.validLocations ?? 0;
  if (!(vl & SHIELD_BIT) || (vl & (0x100000 | 0x400000 | 0x1000000 | 0x2000000))) return null;
  const b = shieldHandTakenBy(items);
  return b ? `your ${shieldBlockerText(b)} takes the shield hand too, and the server refuses a shield beside it; equip a one-handed weapon first (it replaces the ${b.name}), then the shield` : null;
}

/** The tab knows gear slots (an older tab's items carry no EquipMask numbers). */
export function hasGearData(items: readonly AgentItem[]): boolean {
  return items.some((i) => (i.where === 'equipped' && i.mask !== undefined) || i.validLocations !== undefined);
}

/** The body parts an item covers: its ClothingPriority when sent, else the parts its EquipMask bits dress. */
function partsOf(it: AgentItem, mask: number): BodyPart[] {
  if (it.coverage) {
    const byCov = BODY_PARTS.filter((p) => (it.coverage! & p.cov) !== 0);
    if (byCov.length) return byCov;
  }
  return BODY_PARTS.filter((p) => (mask & (p.wear | p.armor)) !== 0);
}

const alText = (it: AgentItem): string => (it.armorLevel !== undefined ? `AL ${it.armorLevel}` : 'AL ?');

/** "Leather Gauntlets #80000d74" */
const tag = (it: AgentItem): string => `${it.name} #${it.guid.toString(16)}`;

export interface GearView {
  /** One line per slot. */
  lines: string[];
  /** Body parts nothing covers. */
  emptyParts: string[];
  /** Other slots with nothing in them (a ring hand counts once each). */
  emptyOther: string[];
  /** Two-layer body parts with only clothing on them (a shirt, no armor over it). */
  clothingOnly: string[];
  /** Slots with an EMPTY place and the pack items that would go there ("Chevron Cloak #…"). */
  packFills: Array<{ slot: string; items: string[] }>;
  /** Worn armor (body pieces and a shield) whose armor level is unknown: never appraised. */
  unknownArmor: string[];
}

/** The paperdoll as text lines. */
export function gearView(items: readonly AgentItem[]): GearView {
  const on = worn(items);
  const lines: string[] = [];
  const emptyParts: string[] = [];
  const clothingOnly: string[] = [];
  const packFills: Array<{ slot: string; items: string[] }> = [];
  const unknownArmor = new Set<AgentItem>();
  const described = new Set<number>();
  const pad = (s: string): string => `${s}:`.padEnd(12);
  for (const part of BODY_PARTS) {
    const here = on.filter((w) => partsOf(w, w.mask ?? 0).includes(part));
    if (!here.length) {
      emptyParts.push(part.name);
      const fits = items.filter((i) => i.where !== 'equipped' && ((i.validLocations ?? 0) & BODY_BITS) !== 0 && partsOf(i, i.validLocations ?? 0).includes(part));
      lines.push(`  ${pad(part.name)}EMPTY${fits.length ? `  (in your pack: ${fits.map(tag).join(', ')})` : ''}`);
      if (fits.length) packFills.push({ slot: part.name, items: fits.map(tag) });
      continue;
    }
    for (const w of here) if (w.armorLevel === undefined && !w.appraised) unknownArmor.add(w);
    const bits = here.map((w) => {
      if (described.has(w.guid)) return `${w.name} (above)`;
      described.add(w.guid);
      const parts = partsOf(w, w.mask ?? 0).map((p) => p.name);
      const al = w.armorLevel !== undefined ? `AL ${w.armorLevel}` : w.appraised ? 'no armor level' : 'AL ? (appraise it to see)';
      return `${tag(w)} (${al}${parts.length > 1 ? `; covers ${parts.join(', ')}` : ''})`;
    });
    // A part with two layers and only clothing on it (a shirt, no armor over it).
    const onlyUnder = part.armor !== 0 && here.every((w) => ((w.mask ?? 0) & part.armor) === 0 && ((w.coverage ?? 0) & part.cov & ~0xff) === 0);
    if (onlyUnder) clothingOnly.push(part.name);
    lines.push(`  ${pad(part.name)}${bits.join(' + ')}${onlyUnder ? '  (clothing only: no armor over it)' : ''}`);
  }
  const emptyOther: string[] = [];
  for (const slot of OTHER_SLOTS) {
    const cells = slot.bits.map((b) => on.find((w) => ((w.mask ?? 0) & b) !== 0));
    const anyBits = slot.bits.reduce((a, b) => a | b, 0);
    const fits = items.filter((i) => i.where !== 'equipped' && ((i.validLocations ?? 0) & anyBits) !== 0);
    if (slot.optional && !cells.some(Boolean) && !fits.length) continue;
    // An empty shield slot beside a caster, two-hander or launcher is not free: that weapon takes the hand.
    const blocker = slot.name === 'shield' && !cells.some(Boolean) ? shieldHandTakenBy(items) : null;
    if (blocker) {
      lines.push(`  ${pad(slot.name)}none: your ${shieldBlockerText(blocker)} takes this hand too (no shield beside it)`);
      continue;
    }
    const empties = cells.filter((c) => !c).length;
    if (empties) emptyOther.push(slot.name);
    if (empties && fits.length) packFills.push({ slot: slot.name, items: fits.map(tag) });
    if (slot.name === 'shield') for (const c of cells) if (c && c.armorLevel === undefined && !c.appraised) unknownArmor.add(c);
    // Two rings show "Copper Ring #…, EMPTY"; a shield its armor level.
    const display = cells.map((c) => (c ? (c.armorLevel !== undefined ? `${tag(c)} (AL ${c.armorLevel})` : tag(c)) : 'EMPTY')).join(', ');
    lines.push(`  ${pad(slot.name)}${display}${empties && fits.length ? `  (in your pack: ${fits.map(tag).join(', ')})` : ''}`);
  }
  return { lines, emptyParts, emptyOther, clothingOnly, packFills, unknownArmor: [...unknownArmor].map((w) => w.name) };
}

/** What wearing a pack item would do: the slots it fills (EMPTY ones named), what it replaces, armor levels, requirements. */
export function gearNote(it: AgentItem, items: readonly AgentItem[]): string {
  const vl = it.validLocations ?? 0;
  if (!vl || it.where === 'equipped') return '';
  const on = worn(items);
  const out: string[] = [];
  let armorish = false;
  if (vl & BODY_BITS) {
    armorish = true;
    // Clothing and armor are worn on all their bits at once (ACE: ValidLocations is the wielded location).
    const parts = partsOf(it, vl);
    const bare = parts.filter((p) => !on.some((w) => partsOf(w, w.mask ?? 0).includes(p))).map((p) => p.name);
    const replaced = on.filter((w) => ((w.mask ?? 0) & vl) !== 0);
    out.push(`covers ${parts.map((p) => p.name).join(', ')}`);
    if (bare.length) out.push(`fills your EMPTY ${bare.join(', ')}`);
    if (replaced.length) {
      out.push(`replaces your ${replaced.map((w) => `${tag(w)} (${alText(w)})`).join(', ')}`);
      // Taking off a robe for a breastplate bares the rest of what the robe covered.
      const kept = on.filter((w) => !replaced.includes(w));
      const bared = BODY_PARTS.filter((p) => replaced.some((w) => partsOf(w, w.mask ?? 0).includes(p)) && !parts.includes(p) && !kept.some((w) => partsOf(w, w.mask ?? 0).includes(p)));
      if (bared.length) out.push(`leaves bare: ${bared.map((p) => p.name).join(', ')}`);
    }
    else if (!bare.length) out.push('worn alongside what you have on (its slots are free)');
  } else {
    const groups = OTHER_SLOTS.filter((s) => s.bits.some((b) => (vl & b) !== 0));
    for (const g of groups) {
      const cells = g.bits.filter((b) => (vl & b) !== 0).map((b) => on.find((w) => ((w.mask ?? 0) & b) !== 0));
      const blocked = g.name === 'shield' ? shieldRefusal(it, items) : null;
      if (blocked) out.push(`can't go on now: ${blocked}`);
      else if (cells.some((c) => !c)) out.push(`fills your EMPTY ${g.name} slot`);
      else out.push(`replaces your ${[...new Set(cells.map((c) => tag(c!)))].join(' or ')}`);
      if (g.name === 'shield') armorish = true;
    }
  }
  if (armorish) {
    if (it.armorLevel !== undefined) {
      const vs = on.filter((w) => ((w.mask ?? 0) & vl) !== 0);
      const known = vs.filter((w) => w.armorLevel !== undefined);
      out.push(`AL ${it.armorLevel}${known.length ? ` vs your ${known.length === 1 && vs.length === 1 ? known[0].armorLevel : known.map((w) => `${w.name} ${w.armorLevel}`).join(', ')}` : ''}`);
    } else if (!it.appraised) out.push('appraise it to see its armor level and wield requirements');
  } else if (!it.appraised) out.push('appraise it to see its wield requirements');
  for (const r of it.wieldReqs ?? []) out.push(`${r.text}${r.met === false ? ' (you do NOT meet it yet)' : r.met ? ' (you meet it)' : ''}`);
  return out.join('; ');
}

/** The observe line's facts: bare body parts, and pack items that would cover one. */
export function gearEmptyFacts(items: readonly AgentItem[]): { slots: string[]; packFits: string[] } | null {
  if (!items.some((i) => i.where === 'equipped' && i.mask !== undefined)) return null;
  const on = worn(items);
  const bare = BODY_PARTS.filter((p) => !on.some((w) => partsOf(w, w.mask ?? 0).includes(p)));
  if (!bare.length) return null;
  const packFits = items.filter((i) => i.where !== 'equipped' && ((i.validLocations ?? 0) & BODY_BITS) !== 0 && partsOf(i, i.validLocations ?? 0).some((p) => bare.includes(p)));
  return { slots: bare.map((p) => p.name), packFits: packFits.map((i) => i.name) };
}

/** "no gloves (hands), no boots (feet)" */
export function emptySlotsText(slots: readonly string[]): string {
  return slots.map((s) => { const p = BODY_PARTS.find((b) => b.name === s); return p ? `no ${p.thing} (${s})` : `nothing on ${s}`; }).join(', ');
}

/** The equipment view: the paperdoll's slots, then each wearable pack item's note. */
export function formatGear(items: readonly AgentItem[], opts: { packList?: boolean } = {}): string {
  if (!hasGearData(items)) {
    return items.some((i) => i.where === 'equipped')
      ? '(this game tab is an older version and does not say which slots items are in: reload it to see the gear slots)'
      : '(nothing worn, and no item says where it can be worn)';
  }
  const v = gearView(items);
  const out = ['gear (the paperdoll; armor levels from your appraisals; a body part\'s armor is the AL of everything covering it, added up):', ...v.lines];
  const wearable = items.filter((i) => i.where !== 'equipped' && i.validLocations);
  if (wearable.length && opts.packList !== false) {
    out.push('wearable in your pack:');
    for (const it of wearable) out.push(`  #${it.guid.toString(16)} ${it.name}: ${gearNote(it, items)}`);
  }
  return out.join('\n');
}

/**
 * A mage with nothing to cast through: a trained or specialized magic school and no caster (ItemType 0x8000: a wand,
 * staff or orb) wielded, where the era's client needs one for magic mode (end of retail's CompatibleCombatMode
 * @ 0056a580; not 1999's). Says whether one is in the pack. Null when there is nothing to say, or the items carry no
 * item types to tell. Arcanist owned none and learned it from a refused heal (2026-10-16).
 */
export function casterGap(items: readonly AgentItem[] | null, trainedMagic: boolean, needsCaster: boolean): string | null {
  if (!items || !trainedMagic || !needsCaster || !items.some((i) => i.itemType !== undefined)) return null;
  const isCaster = (i: AgentItem): boolean => ((i.itemType ?? 0) & 0x8000) !== 0;
  if (items.some((i) => i.where === 'equipped' && isCaster(i))) return null;
  const inPack = items.find((i) => i.where !== 'equipped' && isCaster(i));
  return `no wand, staff or orb wielded: you can't enter magic mode or cast without one; ${inPack
    ? `${inPack.name} is in your pack: wield it (ac_equip ${inPack.name})`
    : 'you carry none: buy one (./world-query sells "Wand", or an Archmage or magic shop)'}`;
}
