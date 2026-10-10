/**
 * itemTypeLabel — render an ItemType bitfield as a single primary-type
 * display label for the appraisal/assessment UI.
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/ItemType.cs. ItemType is
 * a [Flags] enum with 30 named bits + several composite aliases. A real
 * world object's ItemType field can have multiple bits set (e.g. a sword
 * is `MeleeWeapon | Weapon | Item`); the retail AC appraisal panel
 * surfaces a SINGLE primary category label.
 *
 * Priority order (per retail behavior reverse-engineered from the appraisal
 * panel): specific weapon/equipment bits BEFORE the generic Item/Container
 * bits, because the latter overlap with everything.
 *
 * FAITHFUL.283 — replaces a 9-entry inline map in AssessmentSystem.ts.
 * The pre-fix map covered MeleeWeapon/Armor/Clothing/Jewelry/Food/Money/
 * Misc/MissileWeapon/Caster — but **omitted 17 other ItemType bits with
 * canonical AC names** (Container, Gem, SpellComponents, Key, Portal,
 * ManaStone, Writable, etc.) which the assessment panel then mislabeled
 * as "Unknown" for any item carrying one of those primary bits. The
 * pre-fix comment ("less-common ItemType bits don't have a single
 * canonical AC display name") was a cop-out — they DO have canonical
 * names, derived from the C# enum identifier.
 */
import { ItemType } from '../game-types.js';

export function itemTypeLabel(itemType: number): string {
  if (!itemType) return 'Unknown';

  // The order below is intentional — specific category bits are checked
  // first. ItemType.Item is a composite alias for MeleeWeapon | Armor |
  // ... | MagicWieldable, so a sword's itemType has BOTH MeleeWeapon and
  // Item bits set; we want "Melee Weapon" not "Item".
  const checks: Array<[number, string]> = [
    [ItemType.MeleeWeapon,                'Melee Weapon'],
    [ItemType.MissileWeapon,              'Missile Weapon'],
    [ItemType.Caster,                     'Caster'],
    [ItemType.Armor,                      'Armor'],
    [ItemType.Clothing,                   'Clothing'],
    [ItemType.Jewelry,                    'Jewelry'],
    [ItemType.SpellComponents,            'Spell Components'],
    [ItemType.ManaStone,                  'Mana Stone'],
    [ItemType.Gem,                        'Gem'],
    [ItemType.Food,                       'Food'],
    [ItemType.Money,                      'Money'],
    [ItemType.Key,                        'Key'],
    [ItemType.Container,                  'Container'],
    [ItemType.Portal,                     'Portal'],
    [ItemType.LifeStone,                  'Lifestone'],
    [ItemType.PromissoryNote,             'Promissory Note'],
    [ItemType.Writable,                   'Writable'],
    [ItemType.MagicWieldable,             'Magic Wieldable'],
    [ItemType.Service,                    'Service'],
    [ItemType.Gameboard,                  'Gameboard'],
    [ItemType.TinkeringTool,              'Tinkering Tool'],
    [ItemType.TinkeringMaterial,          'Tinkering Material'],
    [ItemType.CraftAlchemyBase,           'Alchemy Base'],
    [ItemType.CraftAlchemyIntermediate,   'Alchemy Intermediate'],
    [ItemType.CraftCookingBase,           'Cooking Base'],
    [ItemType.CraftFletchingBase,         'Fletching Base'],
    [ItemType.CraftFletchingIntermediate, 'Fletching Intermediate'],
    [ItemType.Lockable,                   'Lockable'],
    [ItemType.Creature,                   'Creature'],
    [ItemType.Useless,                    'Useless'],
    [ItemType.Misc,                       'Misc'],
  ];

  // ItemType.Gameboard is the high bit (0x80000000) — JS bit-and against it
  // returns a negative int because of 32-bit signed coercion. Coerce to
  // unsigned before the bitwise check.
  const unsigned = (itemType >>> 0);
  for (const [bit, label] of checks) {
    if ((unsigned & (bit >>> 0)) !== 0) return label;
  }
  return 'Unknown';
}
