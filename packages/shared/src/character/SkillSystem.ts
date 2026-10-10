/**
 * SkillSystem — all skills with advancement classes and XP-based raising.
 *
 * Each skill has:
 *  - advancementClass: Untrained/Trained/Specialized
 *  - raises: number of XP-purchased bonus points
 *  - base: computed from attribute formula
 *  - total: base + raises
 *
 * Reference: ACE.Server/WorldObjects/Player_Skills.cs
 */

import { SkillAdvancementClass } from './Heritage.js';
import { AttributeId, type AttributeSystem } from './AttributeSystem.js';
import type { SkillBase, SkillFormula } from '@ac/dat-parser';
import { roundHalfAwayFromZero } from '../util/round.js';

export interface Skill {
  id: number;
  advancementClass: SkillAdvancementClass;
  raises: number;
  /**
   * ACE CreatureSkill.InitLevel — a flat creation/specialization bonus folded
   * into the skill's Base. ACE sets InitLevel = 10 when a skill is specialized
   * (Player_Skills.cs:236 SpecializeSkill) and writes it per-skill in
   * GameEventPlayerDescription.cs:317. FAITHFUL.590: previously parsed off the
   * wire but silently dropped here, so specialized skills read 10 points low.
   */
  initLevel: number;
  /**
   * RECON.skill-raise-ignores-pp — the XP spent on the skill (CreatureSkill
   * ExperienceSpent, the client's Skill::_pp): retail's raise cost is
   * ExperienceToSkillLevel(level + 1) - _pp (gmSkillUI::GetCostToRaise @
   * 0049b680), so partial progress from skill use lowers it. Absent until
   * the server has sent it.
   */
  experienceSpent?: number;
}

/**
 * Map DAT SkillFormula attr1/attr2 raw values (1-6) to internal AttributeId.
 *
 * ACE PropertyAttribute.cs convention (used by both DAT SkillTable and ACE
 * wire formats): 1=Strength, 2=Endurance, 3=Quickness, 4=Coordination,
 * 5=Focus, 6=Self. The "order of quickness and coordination corresponds to
 * the client" per ACE comments.
 *
 * FAITHFUL.91 fix: previously mapped 3→Coordination, 4→Quickness (swapped).
 * Effect: every Sword/Mace/Spear/Staff/Axe/HeavyWeapons skill base computed
 * Strength + Quickness instead of Strength + Coordination, dropping skill
 * base by ~5-20 for typical builds (Coord usually > Quickness for melee).
 * Dagger (Quickness + Coordination) was masked by formula commutativity.
 */
const FORMULA_ATTR_MAP: Record<number, AttributeId> = {
  1: AttributeId.Strength,
  2: AttributeId.Endurance,
  3: AttributeId.Quickness,
  4: AttributeId.Coordination,
  5: AttributeId.Focus,
  6: AttributeId.Self,
};

/**
 * Compute a skill's base value from its formula and attribute values.
 *
 * Formula: round-half-away-from-zero((attr1 * x + attr2 * y) / z)
 * [ACE AttributeFormula.GetFormula's `.Round()`, FloatExtensions.cs AwayFromZero]
 * The formula struct has { w, x, y, z, attr1, attr2 }:
 *  - w = unused (often 0)
 *  - x = multiplier for attr1
 *  - y = multiplier for attr2
 *  - z = divisor
 *  - attr1 = first attribute ID (1-6)
 *  - attr2 = second attribute ID (1-6)
 */
export function computeSkillBase(formula: SkillFormula, attributes: AttributeSystem): number {
  return computeSkillFormula(formula, (id) => attributes.getCurrent(id));
}

/**
 * The same formula over caller-supplied attribute values — ACE
 * AttributeFormula.GetFormula(creature, formula, current) (AttributeFormula.cs:
 * 55-71) reads `Attributes[attr].Current` (buffed) for a skill/vital's Current
 * and `.Base` for its Base, so the attribute source has to be pluggable.
 * Shared by the DAT SecondaryAttributeTable vital formulas (0x0E000003).
 */
export function computeSkillFormula(formula: SkillFormula, attrValue: (id: AttributeId) => number): number {
  // SkillFormula::Calculate @ 00591960: a zero divisor fails (0), and the
  // constant W is part of the sum — floor((x·a1 + y·a2 + w) / z + 0.5). The
  // end-of-retail tables all have W = 0; a classic set's need not (CustomDM's
  // Run is Quickness + 20, its Armor + 30).
  if (formula.z === 0) return 0;

  const a1 = formula.attr1 > 0 ? attrValue(FORMULA_ATTR_MAP[formula.attr1] ?? AttributeId.Strength) : 0;
  const a2 = formula.attr2 > 0 ? attrValue(FORMULA_ATTR_MAP[formula.attr2] ?? AttributeId.Strength) : 0;

  return roundHalfAwayFromZero((a1 * formula.x + a2 * formula.y + (formula.w ?? 0)) / formula.z);
}

export class SkillSystem {
  private skills: Map<number, Skill> = new Map();

  /**
   * Initialize skills from character creation data.
   * @param skillAdvClasses - skill ID → advancement class from creation
   */
  constructor(skillAdvClasses: Map<number, SkillAdvancementClass>) {
    for (const [id, advClass] of skillAdvClasses) {
      this.skills.set(id, {
        id,
        advancementClass: advClass,
        raises: 0,
        initLevel: 0,
      });
    }
  }

  /** Get a skill's advancement class. */
  getAdvancementClass(skillId: number): SkillAdvancementClass {
    return this.skills.get(skillId)?.advancementClass ?? SkillAdvancementClass.Untrained;
  }

  /** Get a skill's raises (XP-purchased bonus). */
  getRaises(skillId: number): number {
    return this.skills.get(skillId)?.raises ?? 0;
  }

  /** The XP spent on a skill (Skill::_pp), undefined when not yet received. */
  getExperienceSpent(skillId: number): number | undefined {
    return this.skills.get(skillId)?.experienceSpent;
  }

  /** Get a skill's InitLevel (specialization bonus — see Skill.initLevel). */
  getInitLevel(skillId: number): number {
    return this.skills.get(skillId)?.initLevel ?? 0;
  }

  /**
   * Get a skill's base value.
   *
   * FAITHFUL.590 — matches ACE CreatureSkill.Base (CreatureSkill.cs:136-151):
   *   Base = (IsUsable ? AttributeFormula : 0) + InitLevel + Ranks
   * IsUsable (CreatureSkill.cs:48-65): true for Trained/Specialized; for
   * Untrained only when the DAT SkillTable record has MinLevel == 1.
   * Pre-fix this returned the attribute formula alone — no InitLevel (so
   * specialized skills read 10 low), no Ranks, and Untrained skills got the
   * formula regardless of MinLevel. Aug bonuses (GetAugBonus_Base) are not
   * modeled in SkillSystem.
   */
  getBase(skillId: number, skillTable: Map<number, SkillBase>, attributes: AttributeSystem): number {
    return this.getBaseWith(skillId, skillTable, (id) => attributes.getCurrent(id));
  }

  /**
   * getBase over caller-supplied attribute values: pass BUFFED attributes to
   * get the pre-enchantment part of ACE CreatureSkill.Current
   * (CreatureSkill.cs:160-163 — AttributeFormula.GetFormula(creature, Skill)
   * with current = true), base attributes for CreatureSkill.Base.
   */
  getBaseWith(skillId: number, skillTable: Map<number, SkillBase>, attrValue: (id: AttributeId) => number): number {
    const skill = this.skills.get(skillId);
    const skillDef = skillTable.get(skillId);
    const advClass = this.getAdvancementClass(skillId);

    const usable =
      advClass === SkillAdvancementClass.Trained ||
      advClass === SkillAdvancementClass.Specialized ||
      (advClass === SkillAdvancementClass.Untrained && skillDef?.minLevel === 1);

    const formula = usable && skillDef ? computeSkillFormula(skillDef.formula, attrValue) : 0;
    return formula + (skill?.initLevel ?? 0) + (skill?.raises ?? 0);
  }

  /**
   * Get a skill's current (effective) value.
   *
   * FAITHFUL.590 — matches ACE CreatureSkill.Current (CreatureSkill.cs:153-193):
   * Current = Base, then enchantment multiplier, vitae scaling, aug bonuses,
   * and enchantment additives. None of those layers live in SkillSystem, so
   * this is the UNBUFFED value; the real Current is CreatureStats.
   * getSkillCurrent (PlayerState.getSkillCurrent) — STATS.enchantments-never-
   * populated. Ranks are folded into getBase per ACE — pre-fix this
   * added raises on top of a formula-only base, which produced the same number
   * for trained skills but omitted InitLevel for specialized ones and
   * mis-valued unusable Untrained skills.
   */
  getTotal(skillId: number, skillTable: Map<number, SkillBase>, attributes: AttributeSystem): number {
    return this.getBase(skillId, skillTable, attributes);
  }

  /**
   * Raise a skill by spending XP.
   * Trained and Specialized have different XP cost tables.
   * @returns XP spent, or 0 if cannot afford or skill not trainable
   */
  raiseSkill(
    skillId: number,
    trainedXpTable: number[],
    specializedXpTable: number[],
    availableXp: number,
  ): number {
    const skill = this.skills.get(skillId);
    if (!skill) return 0;

    if (skill.advancementClass === SkillAdvancementClass.Inactive ||
        skill.advancementClass === SkillAdvancementClass.Untrained) {
      return 0; // Cannot raise untrained skills with XP
    }

    const xpTable = skill.advancementClass === SkillAdvancementClass.Specialized
      ? specializedXpTable
      : trainedXpTable;

    const nextIndex = skill.raises + 1;
    if (nextIndex >= xpTable.length) return 0; // maxed

    const cost = xpTable[nextIndex] - xpTable[skill.raises];
    if (cost > availableXp) return 0;

    skill.raises++;
    return cost;
  }

  /** Get the XP cost for the next raise of a skill. */
  getNextRaiseCost(
    skillId: number,
    trainedXpTable: number[],
    specializedXpTable: number[],
  ): number | null {
    const skill = this.skills.get(skillId);
    if (!skill) return null;
    if (skill.advancementClass !== SkillAdvancementClass.Trained &&
        skill.advancementClass !== SkillAdvancementClass.Specialized) {
      return null;
    }

    const xpTable = skill.advancementClass === SkillAdvancementClass.Specialized
      ? specializedXpTable
      : trainedXpTable;

    const nextIndex = skill.raises + 1;
    if (nextIndex >= xpTable.length) return null;

    return xpTable[nextIndex] - xpTable[skill.raises];
  }

  /**
   * Train a previously untrained skill (requires skill credits).
   * @returns true if successfully trained
   */
  trainSkill(skillId: number): boolean {
    const skill = this.skills.get(skillId);
    if (!skill) {
      // Create new entry
      this.skills.set(skillId, {
        id: skillId,
        advancementClass: SkillAdvancementClass.Trained,
        raises: 0,
        initLevel: 0,
      });
      return true;
    }
    if (skill.advancementClass !== SkillAdvancementClass.Untrained &&
        skill.advancementClass !== SkillAdvancementClass.Inactive) {
      return false; // Already trained or specialized
    }
    skill.advancementClass = SkillAdvancementClass.Trained;
    return true;
  }

  /**
   * Specialize a previously trained skill (requires skill credits).
   * @returns true if successfully specialized
   */
  specializeSkill(skillId: number): boolean {
    const skill = this.skills.get(skillId);
    if (!skill || skill.advancementClass !== SkillAdvancementClass.Trained) {
      return false;
    }
    skill.advancementClass = SkillAdvancementClass.Specialized;
    return true;
  }

  /** Check if a skill is at least trained. */
  isTrained(skillId: number): boolean {
    const advClass = this.getAdvancementClass(skillId);
    return advClass === SkillAdvancementClass.Trained || advClass === SkillAdvancementClass.Specialized;
  }

  /** Check if a skill is specialized. */
  isSpecialized(skillId: number): boolean {
    return this.getAdvancementClass(skillId) === SkillAdvancementClass.Specialized;
  }

  /** Get all skill IDs. */
  getAllSkillIds(): number[] {
    return [...this.skills.keys()];
  }

  /**
   * Set a skill's advancement class, raises, and InitLevel (used by save/load).
   * FAITHFUL.590 — initLevel param added; both wire paths (PlayerDescription
   * login snapshot and PrivateUpdateSkill) parse it but previously dropped it
   * here, leaving every specialized skill 10 points low.
   */
  setSkill(skillId: number, advancementClass: number, raises: number, initLevel: number = 0, experienceSpent?: number): void {
    const existing = this.skills.get(skillId);
    if (existing) {
      existing.advancementClass = advancementClass;
      existing.raises = raises;
      existing.initLevel = initLevel;
      if (experienceSpent !== undefined) existing.experienceSpent = experienceSpent;
    } else {
      this.skills.set(skillId, {
        id: skillId,
        advancementClass,
        raises,
        initLevel,
        ...(experienceSpent !== undefined ? { experienceSpent } : {}),
      });
    }
  }
}
