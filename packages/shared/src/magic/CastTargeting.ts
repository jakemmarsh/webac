/**
 * CastTargeting — DAT-driven wire-target resolution for player spell casts.
 *
 * The retail client routes casts onto two GameActions — CastTargetedSpell
 * (0x004A, guid + spell) and CastUntargetedSpell (0x0048, spell only) — and
 * the choice is data-driven from the spell's DAT record, not from whatever
 * happens to be selected:
 *
 *  - SpellFlags.SelfTargeted (0x8, SpellFlags.cs): the spell can only ever
 *    apply to the caster, and retail ALWAYS sends it as CastTargetedSpell at
 *    the player's own id, whatever is selected — ClientMagicSystem::CastSpell
 *    @ 00568040: `if (bitfield & 8) FreeHandsAndCastSpell(spell,
 *    smartbox->player_id)`, and FreeHandsAndCastSpell @ 00566ef0 only falls
 *    back to CastUntargetedSpell when that id is 0 (no SmartBox). All
 *    recalls / summons / Self buffs carry this flag in the EoL DAT (2,083 of
 *    6,266 spells). The difference is visible: ACE's untargeted path
 *    (Player_Magic.cs CreatePlayerSpell(uint) → SetCastParams(…, target
 *    null, …)) reaches WorldObject_Magic.cs DoSpellEffects with a null
 *    target, so the spell's TargetEffect PlayScript (Heal Self's
 *    HealthUpRed, Strength Self's glow) is never broadcast; a targeted cast
 *    at self (TargetCategory.Self, Player_Magic.cs GetTargetCategory) plays
 *    it (BUG.heal-self-playscript-missing).
 *
 *  - Target type 0: untargeted war spells — rings, waves, walls. Retail
 *    derives the target type from the spell FORMULA, not from the DAT
 *    NonComponentTargetType field (SWEEP1006B.magic-casting.cast-targeting-
 *    uses-dat-noncomponenttargettype): CastSpell @ 00568040 reads
 *    CSpellBase::InqTargetType @ 00597230 = SpellFormula::Complete ?
 *    SpellFormula::GetTargetingType : 0, and GetTargetingType @ 005bc910
 *    maps the formula's last talisman through SpellComponentTable::
 *    GetTargetTypeFromComponentID @ 005bbf50 (see spellFormulaTargetingType
 *    below). _non_component_target_type is never read by any retail cast
 *    or UI decision (only its ctor / copy / pack / unpack). Always sent
 *    untargeted; the geometry is caster-relative.
 *
 *  - Everything else (Other buffs, bolts, Tie spells at portals/lifestones)
 *    requires an explicit selection. With nothing selected the retail client
 *    fails locally ("You must select a suitable target before casting this
 *    spell", same function) — sending untargeted instead would reach ACE's
 *    HandleCastSpell with a null target (server-side error), and sending
 *    guid 0 round-trips to the same TargetNotAcquired reply.
 *
 * GAP.17 ground truth: only THREE Tie spells exist in the EoL DAT —
 * Primary Portal Tie (47), Lifestone Tie (2644), Secondary Portal Tie
 * (2646), all SpellType.PortalLink, none self-targeted (a "Lifestone Tie
 * Other" does not exist). They are plain targeted casts at the portal /
 * lifestone WORLD OBJECT; ACE resolves everything else server-side
 * (WorldObject_Magic.cs:955 HandleCastSpell_PortalLink).
 */

/** SpellFlags.SelfTargeted — ACE SpellFlags.cs. */
export const SPELL_FLAG_SELF_TARGETED = 0x8;

/** SpellFormula's fixed slot count (SpellFormula._comps[8]). */
const SPELL_FORMULA_SLOTS = 8;

/**
 * The era client's talisman → ItemType table: the target type a formula's
 * last targeting component selects (component ids not listed → 0,
 * untargeted). A fact of each era's executable, so it rides the era's client
 * profile (EraClientRules.talismanTargetTypes).
 */
export type TalismanTargetTypes = Readonly<Record<number, number>>;

const CREATURE_TALISMANS = [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38] as const;

/**
 * End of retail: SpellComponentTable::GetTargetTypeFromComponentID @ 005bbf50.
 * 0x31-0x38, 0x3c-0x3e and 0xbe → 0x10 (Creature); 0x39 (Ashwood) →
 * 0x88b8f (item enchantments); 0x3b (Hazel) → 0x10010000 (portal /
 * lifestone ties); 0x3a (Elder) and anything else → 0 (untargeted).
 */
export const TALISMAN_TARGET_TYPES_EOR: TalismanTargetTypes = Object.freeze({
  ...Object.fromEntries(CREATURE_TALISMANS.map((c) => [c, 0x10])),
  0x3c: 0x10, 0x3d: 0x10, 0x3e: 0x10, 0xbe: 0x10,
  0x39: 0x88b8f,
  0x3b: 0x10010000,
});

/**
 * The 1999 client.exe (Oct 1999 4.35752): its component → target type
 * switch @ 0x5e4150, reached from SpellFormula::GetTargetingType @ 0x5d92c0
 * (the last talisman, @ 0x5d9270) and CSpellBase::InqTargetType @ 0x5401e0.
 * Jump table 0x5e41b9 / index bytes 0x5e41d5: 0x31-0x38, 0x3a and 0x3c-0x3e
 * → 0x10 (TYPE_CREATURE); 0x39 (Ashwood) → 0xa090f (TYPE_ITEM_ENCHANTABLE_TARGET:
 * melee, armour, clothing, jewellery, missile, gem, lockable, manastone; no
 * caster, misc or container bits); 0x3b (Hazel) → 0x10000 (portals only: no
 * lifestone bit, the 1999 Portal Tie is the only tie). The AC1999 server's
 * ITEM_TYPE (GameEnums.h TYPE_ITEM_ENCHANTABLE_TARGET / TYPE_PORTAL_MAGIC_TARGET)
 * carries the same two masks, and the 1999 SpellTable transcoder writes them
 * as the NonComponentTargetType the 1999 DAT lacks.
 */
export const TALISMAN_TARGET_TYPES_1999: TalismanTargetTypes = Object.freeze({
  ...Object.fromEntries(CREATURE_TALISMANS.map((c) => [c, 0x10])),
  0x3a: 0x10, 0x3c: 0x10, 0x3d: 0x10, 0x3e: 0x10,
  0x39: 0xa090f,
  0x3b: 0x10000,
});

/** The ItemType mask a targeting talisman selects in `table`'s era (end of retail's by default). */
export function targetTypeFromComponentId(componentId: number, table: TalismanTargetTypes = TALISMAN_TARGET_TYPES_EOR): number {
  return table[componentId] ?? 0;
}

/** The formula padded back to SpellFormula's 8 slots (our parser keeps only the non-zero comps; raw zeros are trailing). */
function formulaSlots(formula: readonly number[]): number[] {
  const comps = formula.slice(0, SPELL_FORMULA_SLOTS);
  while (comps.length < SPELL_FORMULA_SLOTS) comps.push(0);
  return comps;
}

/**
 * SpellFormula::GetTargetingType @ 005bc910 (1999: @ 0x5d92c0 / 0x5d9270,
 * the same walk): walk from slot 5 while the slot is non-zero (to 8), then
 * map the LAST one walked past — the last non-zero of comps[5..7], or
 * comps[4] when comps[5] is 0. CSpellBase::IsUntargeted @ 005974a0 (the
 * Cast-button tooltip's test) is this === 0.
 */
export function spellFormulaTargetingType(formula: readonly number[], table: TalismanTargetTypes = TALISMAN_TARGET_TYPES_EOR): number {
  const comps = formulaSlots(formula);
  let i = 5;
  while (i < SPELL_FORMULA_SLOTS && comps[i] !== 0) i++;
  return targetTypeFromComponentId(comps[i - 1], table);
}

/**
 * CSpellBase::InqTargetType @ 00597230 (1999: @ 0x5401e0) on the BASE
 * decrypted formula (InqSpellFormula @ 00596eb0 — not the per-account
 * randomized one): 0 unless SpellFormula::Complete @ 005bc880 (comps[0..4]
 * all non-zero), else GetTargetingType. Used by CastSpell @ 00568040 and
 * ObjectCompatibleWithSpell @ 00567c30.
 */
export function inqSpellTargetType(formula: readonly number[], table: TalismanTargetTypes = TALISMAN_TARGET_TYPES_EOR): number {
  const comps = formulaSlots(formula);
  for (let i = 0; i < 5; i++) if (comps[i] === 0) return 0;
  return spellFormulaTargetingType(comps, table);
}

export type CastTargetResolution =
  /** Send CastTargetedSpell at this guid. */
  | { kind: 'targeted'; targetGuid: number }
  /** Send CastUntargetedSpell. */
  | { kind: 'untargeted' }
  /** Do not send — show the retail TargetNotAcquired transient. */
  | { kind: 'no-target' };

/**
 * Resolve the wire target for a player-initiated cast.
 *
 * @param bitfield spell bitfield from the DAT SpellBase record
 * @param targetType CSpellBase::InqTargetType — inqSpellTargetType(spell.formula), the formula-derived ItemType mask
 * @param selectedGuid the player's current selection, or null
 * @param selfGuid the player's own guid, or null before world entry
 */
export function resolveCastTarget(
  bitfield: number,
  targetType: number,
  selectedGuid: number | null,
  selfGuid: number | null,
): CastTargetResolution {
  if ((bitfield & SPELL_FLAG_SELF_TARGETED) !== 0) {
    // Self spells ignore the selection: targeted at our own id (retail
    // CastSpell @ 00568040 → FreeHandsAndCastSpell(spell, player_id)),
    // untargeted only when there is no player id yet (@ 00566ef0).
    return selfGuid !== null && selfGuid !== 0
      ? { kind: 'targeted', targetGuid: selfGuid }
      : { kind: 'untargeted' };
  }

  if (targetType === 0) return { kind: 'untargeted' };

  if (selectedGuid === null) return { kind: 'no-target' };

  return { kind: 'targeted', targetGuid: selectedGuid };
}
