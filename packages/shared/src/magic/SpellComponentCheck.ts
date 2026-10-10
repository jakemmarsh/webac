/**
 * SpellComponentCheck — the retail client's local component pre-check
 * before a spell cast goes on the wire (BUG.spellcast-cost-components).
 *
 * Decompiled EoL client, ClientMagicSystem::CastSpell @ 00568040
 * (acclient-decompiled.annotated.c:350208):
 *
 *   if (AreSpellComponentsRequired(s_pMagicSystem)) {          // :350240
 *     GetAppropriateSpellFormula(&formula, &spellBase);        // account-customized formula
 *     for (i = 0; i < formula.GetNumSpellComponents(); i++)
 *       if (!ComponentTracker::ComponentIsOwned(SCIDtoWCID(formula[i])))
 *         SendNotice_DisplayStringInfo(0x1a,
 *           "You do not have all of this spell's components");  // :350254
 *         return;                                              // nothing sent
 *   }
 *   … target checks, then CM_Magic::Event_Cast{Untargeted,Targeted}Spell
 *
 * - AreSpellComponentsRequired @ 00567b90 reads PlayerDesc bool 0x44
 *   (PropertyBool.SpellComponentsRequired = 68) via CBaseQualities::InqBool
 *   @ 0058fe70, which leaves its `false` default when the key is absent —
 *   retail's meaning, which we follow (PlayerState.spellComponentsRequired,
 *   seeded `?? false` per PlayerDescription). ACE stores the bool inverted
 *   (absent = true, Player_Properties.cs:286-290) and so never sends `true`
 *   at login; a retail client on ACE skips this local check unless
 *   `@requirecomps on` broadcasts an explicit true, and a missing component
 *   comes back as ACE's WeenieError 0x0400 "You don't have all the
 *   components for this spell." instead.
 * - ComponentTracker::ComponentIsOwned @ 00586480 is a pure ownership test
 *   (the WCID is in the tracker's class-id set) — ONE of each component is
 *   enough client-side; exact counts are the server's job (ACE
 *   Player_Magic.cs:1227 HasComponentsForSpell → YouDontHaveAllTheComponents).
 * - SpellComponentTable::SCIDtoWCID @ 005bc2f0 maps component id → weenie
 *   class; ACE reads the same map from DualDidMapper 0x27000002
 *   ClientEnumToID (Spell.cs:203-215). An unmapped id resolves to
 *   INVALID_DID (0), which is never owned → the check fails.
 *
 * Mana is NOT pre-checked by the retail client: CastSpell has no vital read.
 * ACE rejects server-side (Player_Magic.cs:581 → YouDontHaveEnoughManaToCast).
 */

/** DualDidMapper holding the spell-component id → WCID map (ACE Spell.SpellComponentDIDs). */
export const SPELL_COMPONENT_DID_MAPPER_ID = 0x27000002;

/** Verbatim retail text, ClientMagicSystem::CastSpell @ 350254 (spew 0x1a). */
export const SPELL_COMPONENTS_MISSING_TEXT = "You do not have all of this spell's components";

/**
 * Retail CastSpell's component gate. Returns true when the cast may proceed:
 * components are not required, or every (non-zero) component of the
 * player's customized formula maps to a WCID the player owns.
 */
export function spellComponentsSatisfied(
  componentsRequired: boolean,
  playerFormula: readonly number[],
  componentIdToWcid: ReadonlyMap<number, number>,
  ownsWcid: (wcid: number) => boolean,
): boolean {
  if (!componentsRequired) return true;
  for (const componentId of playerFormula) {
    if (!componentId) continue; // empty formula slot — not a component
    const wcid = componentIdToWcid.get(componentId) ?? 0;
    if (wcid === 0 || !ownsWcid(wcid)) return false;
  }
  return true;
}

/**
 * The magic-school augmentations ClientMagicSystem::GetAppropriateSpellFormula
 * @ 00567d50 reads from PlayerDesc, by CSpellBase::_school: War 0x129,
 * Life 0x128, Item 0x127, Creature 0x126, Void 0x148 (ACE PropertyInt
 * AugmentationInfused{War,Life,Item,Creature,Void}Magic).
 */
export const INFUSED_MAGIC_AUGMENTATION_INT: Readonly<Record<number, number>> = Object.freeze({
  1: 0x129, 2: 0x128, 3: 0x127, 4: 0x126, 5: 0x148,
});

/** Prismatic Taper, the taper CSpellBase::InqScarabOnlyFormula appends. */
export const PRISMATIC_TAPER_COMPONENT_ID = 0xbc;

/**
 * MagicSystem::DeterminePowerLevelOfComponent @ 005bd240: the scarabs' power
 * (Lead 1 … Pyreal 6, Diamond 0x6e 7, Platinum 0x70 8, Dark 0xc0 9,
 * Mana 0xc1 10); every other component is 0.
 */
export function componentPowerLevel(componentId: number): number {
  if (componentId >= 1 && componentId <= 6) return componentId;
  switch (componentId) {
    case 0x6e: return 7;
    case 0x70: return 8;
    case 0xc0: return 9;
    case 0xc1: return 10;
    default: return 0;
  }
}

/** The ids InqScarabOnlyFormula keeps from the spell's own formula. */
const SCARAB_ONLY_KEPT: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 0x6e, 0x6f, 0x70, 0xc0, 0xc1]);

/**
 * CSpellBase::InqScarabOnlyFormula @ 00597050 — the formula a foci (or
 * Infused-augmented) caster needs: the spell's scarabs (from its base
 * formula, not the account-customized one, up to the first empty slot),
 * then Prismatic Tapers by the strongest scarab's power
 * (SpellFormula::FindMostPowerfulPowerComponent): power 1 → 1, 2 → 2,
 * 3 / 4 / 7 → 3, 5 / 6 / 8 / 9 / 10 → 4. At most 8 slots.
 */
export function scarabOnlyFormula(baseFormula: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 8 && i < baseFormula.length && baseFormula[i]; i++) {
    if (SCARAB_ONLY_KEPT.has(baseFormula[i])) out.push(baseFormula[i]);
  }
  const power = Math.max(0, ...out.map(componentPowerLevel));
  const tapers = power === 1 ? 1 : power === 2 ? 2 : (power === 3 || power === 4 || power === 7) ? 3 : power >= 5 ? 4 : 0;
  for (let i = 0; i < tapers && out.length < 8; i++) out.push(PRISMATIC_TAPER_COMPONENT_ID);
  return out;
}

/**
 * ClientMagicSystem::GetAppropriateSpellFormula @ 00567d50 — the formula
 * CastSpell's component check walks: the scarab-only formula when the
 * player has the school's Infused augmentation (≥ 1) or owns the school's
 * foci (SchoolOfMagic2WCID → ACCWeenieObject::MagicPackIsOwned), else the
 * account-customized formula. The school → foci map is DidMapper
 * 0x27000003 (master 0x25000005 [4 "SchoolOfMagic"]: War 15271, Life
 * 15270, Item 15269, Creature 15268, Void 43173).
 */
export function appropriateSpellFormula(opts: {
  school: number;
  baseFormula: readonly number[];
  customizedFormula: () => number[];
  fociWcidBySchool: ReadonlyMap<number, number>;
  ownsWcid: (wcid: number) => boolean;
  intProperty: (key: number) => number | undefined;
}): number[] {
  const augKey = INFUSED_MAGIC_AUGMENTATION_INT[opts.school];
  const augmented = augKey !== undefined && (opts.intProperty(augKey) ?? 0) >= 1;
  const foci = opts.fociWcidBySchool.get(opts.school) ?? 0;
  if (augmented || (foci !== 0 && opts.ownsWcid(foci))) return scarabOnlyFormula(opts.baseFormula);
  return opts.customizedFormula();
}
