/**
 * TinkeringSystem — imbue vocabulary for appraisal display.
 *
 * Tinkering/imbuing itself is server-authoritative (ACE RecipeManager.cs
 * TryMutateNative); the client only decodes PropertyInt.ImbuedEffect.
 */

/**
 * Imbue bit flags per reference/ACE/Source/ACE.Entity/Enum/ImbuedEffectType.cs.
 * Wire-format load-bearing: server packs these into PropertyInt.ImbuedEffect=179
 * and the high-bit entries (IgnoreSomeMagicProjectileDamage / AlwaysCritical /
 * IgnoreAllArmor) are at 0x20000000+ — NOT contiguous with the rending bits.
 */
export enum ImbuedEffectType {
  Undef = 0x0,
  CriticalStrike = 0x0001,
  CripplingBlow = 0x0002,
  ArmorRending = 0x0004,
  SlashRending = 0x0008,
  PierceRending = 0x0010,
  BludgeonRending = 0x0020,
  AcidRending = 0x0040,
  ColdRending = 0x0080,
  ElectricRending = 0x0100,
  FireRending = 0x0200,
  MeleeDefense = 0x0400,
  MissileDefense = 0x0800,
  MagicDefense = 0x1000,
  Spellbook = 0x2000,
  NetherRending = 0x4000,
  // FAITHFUL.67 — hand-port previously had IgnoreSomeMagicProjectileDamage =
  // 0x8000, which was a wire-format bug. The actual ACE values are
  // non-contiguous: a gap between the rending bits and these high-bit flags.
  IgnoreSomeMagicProjectileDamage = 0x20000000,
  AlwaysCritical = 0x40000000,
  IgnoreAllArmor = 0x80000000,
}

/**
 * Decode an ImbuedEffectType bitfield into a list of canonical retail
 * effect names (e.g. `0x9 = ArmorRending | CriticalStrike` →
 * ["Critical Strike", "Armor Rending"]).
 *
 * Per ACE `Network/Structure/AppraiseInfo.cs` (and the imbue tinker
 * system) the server packs these effect bits into PropertyInt.ImbuedEffect
 * = 179 (plus 4 more for 2nd-5th imbues). Retail rendered them as a
 * comma-joined list under "Imbued Effect:" / "Imbued Effects:" on the
 * appraisal panel.
 *
 * Order mirrors ACE source bit order — low bits first so the retail
 * "primary" imbue (typically the rending) reads first.
 */
export function imbuedEffectsLabels(mask: number): string[] {
  if (!mask) return [];
  const out: string[] = [];
  // Bit order per ImbuedEffectType enum + space-insertion convention.
  const entries: Array<[ImbuedEffectType, string]> = [
    [ImbuedEffectType.CriticalStrike, 'Critical Strike'],
    [ImbuedEffectType.CripplingBlow, 'Crippling Blow'],
    [ImbuedEffectType.ArmorRending, 'Armor Rending'],
    [ImbuedEffectType.SlashRending, 'Slash Rending'],
    [ImbuedEffectType.PierceRending, 'Pierce Rending'],
    [ImbuedEffectType.BludgeonRending, 'Bludgeon Rending'],
    [ImbuedEffectType.AcidRending, 'Acid Rending'],
    [ImbuedEffectType.ColdRending, 'Cold Rending'],
    [ImbuedEffectType.ElectricRending, 'Electric Rending'],
    [ImbuedEffectType.FireRending, 'Fire Rending'],
    [ImbuedEffectType.MeleeDefense, 'Melee Defense'],
    [ImbuedEffectType.MissileDefense, 'Missile Defense'],
    [ImbuedEffectType.MagicDefense, 'Magic Defense'],
    [ImbuedEffectType.Spellbook, 'Spellbook'],
    [ImbuedEffectType.NetherRending, 'Nether Rending'],
    [ImbuedEffectType.IgnoreSomeMagicProjectileDamage, 'Ignore Some Magic Projectile Damage'],
    [ImbuedEffectType.AlwaysCritical, 'Always Critical'],
    [ImbuedEffectType.IgnoreAllArmor, 'Ignore All Armor'],
  ];
  for (const [bit, label] of entries) {
    // JS `&` is signed-32-bit so high-bit flags (0x20000000+) require an
    // unsigned coerce via >>> 0 before the equality check. Without it,
    // `mask & 0x80000000 === 0x80000000` returns false because the LHS
    // becomes -2147483648 while the RHS stays 2147483648.
    if (bit !== 0 && ((mask & bit) >>> 0) === bit) out.push(label);
  }
  return out;
}
