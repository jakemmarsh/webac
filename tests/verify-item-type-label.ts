/**
 * itemTypeLabel helper for ItemType bitfield (FAITHFUL.283).
 *
 * Pre-fix the (since-deleted) AssessmentSystem.ts had a 9-entry inline map covering only
 * MeleeWeapon/Armor/Clothing/Jewelry/Food/Money/Misc/MissileWeapon/Caster.
 * The retail AC ItemType enum has 30 named bits + composite aliases per
 * `reference/ACE/Source/ACE.Entity/Enum/ItemType.cs`. So 17+ named-bit
 * items (Container, Gem, SpellComponents, Key, Portal, ManaStone,
 * Writable, etc.) were labeled "Unknown" on the appraisal panel —
 * even though they have well-known display names.
 *
 * Worse: ItemType is a [Flags] enum and real world objects often have
 * multiple bits set (a sword is `MeleeWeapon | Weapon | Item`). The
 * pre-fix code used the multi-flag value as a direct map key — which
 * never matched a single-bit entry. So even Common cases like swords
 * fell through to "Unknown" when their `itemType` was a composite value.
 *
 * The new helper checks bits in priority order (specific weapon/equipment
 * BEFORE generic container/item bits) so composite values resolve to the
 * most specific primary label.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { itemTypeLabel, ItemType } from '@ac/shared';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const ACE_ITEMTYPE = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ItemType.cs');

describe('itemTypeLabel — single-bit values (FAITHFUL.283)', () => {
  it('the pre-fix 9 cases still resolve correctly', () => {
    expect(itemTypeLabel(ItemType.MeleeWeapon)).toBe('Melee Weapon');
    expect(itemTypeLabel(ItemType.Armor)).toBe('Armor');
    expect(itemTypeLabel(ItemType.Clothing)).toBe('Clothing');
    expect(itemTypeLabel(ItemType.Jewelry)).toBe('Jewelry');
    expect(itemTypeLabel(ItemType.Food)).toBe('Food');
    expect(itemTypeLabel(ItemType.Money)).toBe('Money');
    expect(itemTypeLabel(ItemType.Misc)).toBe('Misc');
    expect(itemTypeLabel(ItemType.MissileWeapon)).toBe('Missile Weapon');
    expect(itemTypeLabel(ItemType.Caster)).toBe('Caster');
  });

  it('the 17 pre-fix-misslabeled cases now resolve to canonical names', () => {
    expect(itemTypeLabel(ItemType.Container)).toBe('Container');
    expect(itemTypeLabel(ItemType.Useless)).toBe('Useless');
    expect(itemTypeLabel(ItemType.Gem)).toBe('Gem');
    expect(itemTypeLabel(ItemType.SpellComponents)).toBe('Spell Components');
    expect(itemTypeLabel(ItemType.Writable)).toBe('Writable');
    expect(itemTypeLabel(ItemType.Key)).toBe('Key');
    expect(itemTypeLabel(ItemType.Portal)).toBe('Portal');
    expect(itemTypeLabel(ItemType.Lockable)).toBe('Lockable');
    expect(itemTypeLabel(ItemType.PromissoryNote)).toBe('Promissory Note');
    expect(itemTypeLabel(ItemType.ManaStone)).toBe('Mana Stone');
    expect(itemTypeLabel(ItemType.Service)).toBe('Service');
    expect(itemTypeLabel(ItemType.MagicWieldable)).toBe('Magic Wieldable');
    expect(itemTypeLabel(ItemType.CraftCookingBase)).toBe('Cooking Base');
    expect(itemTypeLabel(ItemType.CraftAlchemyBase)).toBe('Alchemy Base');
    expect(itemTypeLabel(ItemType.LifeStone)).toBe('Lifestone');
    expect(itemTypeLabel(ItemType.TinkeringTool)).toBe('Tinkering Tool');
    expect(itemTypeLabel(ItemType.TinkeringMaterial)).toBe('Tinkering Material');
  });

  it('Gameboard (high bit 0x80000000) resolves correctly despite JS signed coercion', () => {
    // 0x80000000 as a 32-bit signed int is negative — the helper must
    // coerce to unsigned before the bitwise AND.
    expect(itemTypeLabel(ItemType.Gameboard)).toBe('Gameboard');
    expect(itemTypeLabel(0x80000000)).toBe('Gameboard');
  });
});

describe('itemTypeLabel — flag combinations (FAITHFUL.283)', () => {
  it('a sword (MeleeWeapon | Weapon | Item composite) resolves to "Melee Weapon"', () => {
    // ItemType.Item is the composite alias for many types; a real sword's
    // itemType has the MeleeWeapon bit plus the Item composite bit.
    const composite = ItemType.MeleeWeapon | ItemType.Misc;
    expect(itemTypeLabel(composite)).toBe('Melee Weapon');
  });

  it('a bow (MissileWeapon | composite) resolves to "Missile Weapon"', () => {
    const composite = ItemType.MissileWeapon | ItemType.Misc;
    expect(itemTypeLabel(composite)).toBe('Missile Weapon');
  });

  it('priority: specific weapon/armor BEFORE generic Container or Misc', () => {
    // A bag of holding might have both Container + Misc bits set —
    // Container should win, not the catch-all Misc.
    expect(itemTypeLabel(ItemType.Container | ItemType.Misc)).toBe('Container');
    // Armor + Lockable (rare but possible) — Armor wins.
    expect(itemTypeLabel(ItemType.Armor | ItemType.Lockable)).toBe('Armor');
  });
});

describe('itemTypeLabel — degenerate cases (FAITHFUL.283)', () => {
  it('returns "Unknown" for None (0)', () => {
    expect(itemTypeLabel(0)).toBe('Unknown');
    expect(itemTypeLabel(ItemType.None)).toBe('Unknown');
  });

  it('returns "Unknown" for never-defined bits', () => {
    // 0x01000000 has no ACE name — sits between CraftFletchingBase (0x02000000)
    // and CraftAlchemyBase (0x00800000).
    expect(itemTypeLabel(0x01000000)).toBe('Unknown');
  });
});

describe.skipIf(!aceReferenceExists(ACE_ITEMTYPE))('ACE source faithfulness (FAITHFUL.283)', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_ITEMTYPE, 'utf8');
  });
  it('the canonical 30 named bits exist in ACE source', () => {
    // Pin a representative sample — the helper must cover at least these.
    expect(src).toMatch(/MeleeWeapon\s*=\s*0x00000001/);
    expect(src).toMatch(/Container\s*=\s*0x00000200/);
    expect(src).toMatch(/SpellComponents\s*=\s*0x00001000/);
    expect(src).toMatch(/ManaStone\s*=\s*0x00080000/);
    expect(src).toMatch(/Gameboard\s*=\s*0x80000000/);
  });
  it('ACE source declares ItemType as a [Flags] enum', () => {
    expect(src).toMatch(/\[Flags\]/);
  });
});
