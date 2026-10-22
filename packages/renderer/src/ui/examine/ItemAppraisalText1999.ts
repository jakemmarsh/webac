/**
 * ItemAppraisalText1999 — the AC1999 item examine text (BUG.ac1999-appraisal-details).
 *
 * The 1999 client.exe builds the whole item page in one function,
 * ItemExaminePanel::SetAppraiseInfo @ 0x0050b6c0 (2005 split it into the
 * Appraisal_Show* methods ItemAppraisalText.ts ports, and end of retail added
 * and reworded most lines). This is that function, read from the disassembly of
 * the 1999 release client.exe (reference: ~/.acjs-ac1999/drive_c/AsheronsCall/
 * client.exe, md5 aef6b20d4b73ce766d105db312e4b0d6; reference/ac1999 kb
 * client-behavior/missile-weapon-panel-lines, structures/AppraisalProfile).
 * Every string below is the client's literal.
 *
 * ── The page ──────────────────────────────────────────────────────────────
 * Two header elements (panel +0x210 value, +0x214 burden) and one body text
 * (+0x224). Each body line goes through ItemExaminePanel::AddItemInfo
 * @ 0x0050d600: when the body already holds more than one glyph it appends
 * "\n\n" first, so every line is its own paragraph (no single-newline joins,
 * no blank-line spacers, unlike end of retail).
 *  - Value (vtable +0x100 @ 0x0050b040, key 0x13): "Value: " + the amount
 *    (commas when > 0) + " p"; absent: "Value: ???".
 *  - Burden: "<n> Burden Units"; absent: "Unknown Mass".
 * The floaty end-of-retail window our 1999 era opens has no header elements,
 * so (hasValueBurdenElements false) the two header strings open the body.
 *
 * ── Body order (SetAppraiseInfo) ─────────────────────────────────────────
 *  1. Long description (String 0x10), else short description (0xf).
 *  2. The Use string (0xe) + "Created by %s." (0x19).
 *  3. Weapons (valid locations & 0x1f00000), else armor & clothing (& 0x1ff
 *     or & 0x7e00): see showWeapon / showArmor.
 *  4. The magic block's range fallback ("Range: %d yds.").
 *  5. Armor protections, when the profile has one and the armor/shield level > 0.
 *  6. Jewelry (& 0xf8000).
 *  7. With no Use string: food "Use this item to eat it.", else a book
 *     "Use this item to read it or write in it." (+ "Created by %s.").
 *  8. Boosts (0x5a amount + 0x59 kind), container capacity, book pages.
 *  9. Locks / lockpicks, level restriction, magic, mana stone, uses, enchantments.
 */

import type { IdentifyResponseData } from '../../network/ServerMessageHandler.js';
import { APPRAISAL_1999_FLOAT, APPRAISAL_1999_STRING } from '@ac/shared';
import { ftol, insertCommas } from './appraisalFormat.js';
import {
  finishAppraisalText, type AppraisalFontColor, type AppraisalRun, type ItemAppraisalContext, type ItemAppraisalText,
} from './ItemAppraisalText.js';

// ─── 1999 client tables (AppraisalSystem, 0x005e2f00–0x005e3c00) ───────────

/** AppraisalSystem::WeaponTimeToString @ 0x005e3410: < 11 / < 31 / < 50 / < 80 / else. */
export function weaponTimeToString1999(t: number): string {
  if (t < 11) return 'Very Fast';
  if (t < 31) return 'Fast';
  if (t < 50) return 'Average';
  if (t < 80) return 'Slow';
  return 'Very Slow';
}

/** AppraisalSystem::SkillToString @ 0x005e3490 — a 13-case switch; 6 / 7 (the defenses) have no name. */
export const WEAPON_SKILL_NAMES_1999: Readonly<Record<number, string>> = {
  1: 'Axe', 2: 'Bow', 3: 'Crossbow', 4: 'Dagger', 5: 'Mace', 8: 'Sling', 9: 'Spear', 10: 'Staff', 11: 'Sword',
  12: 'Thrown Weapon', 13: 'Unarmed Combat',
};

/** AppraisalSystem::DamageTypeToString @ 0x005e2f00: every set bit's name, joined by "/". */
export function damageTypeToString1999(type: number): string {
  const names: Array<[number, string]> = [
    [0x1, 'Slashing'], [0x2, 'Piercing'], [0x4, 'Bludgeoning'], [0x8, 'Cold'], [0x10, 'Fire'], [0x20, 'Acid'], [0x40, 'Electrical'],
  ];
  return names.filter(([bit]) => (type & bit) !== 0).map(([, n]) => n).join('/');
}

/** @ 0x005e35b0: "Covers " + the body parts of the item's valid locations (worn-armor and clothing bits). */
export function coverageToString1999(validLocations: number): string | null {
  const parts: Array<[number, string]> = [
    [0x1, 'Head'], [0x200 | 0x2, 'Chest'], [0x400 | 0x4, 'Abdomen'], [0x800 | 0x8, 'Upper Arms'], [0x1000 | 0x10, 'Lower Arms'],
    [0x20, 'Hands'], [0x2000 | 0x40, 'Upper Legs'], [0x4000 | 0x80, 'Lower Legs'], [0x100, 'Feet'],
  ];
  const got = parts.filter(([bits]) => (validLocations & bits) !== 0).map(([, n]) => n);
  return got.length ? `Covers ${got.join(', ')}` : null;
}

/** @ 0x005e37e0: armor modifier → "<adjective> protection against <type> Damage."; a negative modifier has no line. */
export function armorProtectionToString1999(damageType: number, mod: number): string | null {
  if (mod < 0) return null;
  const adjective = mod === 0 ? 'No' : mod <= 0.4 ? 'Poor' : mod <= 0.8 ? 'Below average' : mod < 1.2 ? 'Average'
    : mod < 1.6 ? 'Above average' : mod < 2.0 ? 'Excellent' : 'Unparalleled';
  const against: Readonly<Record<number, string>> = {
    0x1: 'Slashing', 0x2: 'Piercing', 0x4: 'Bludgeon', 0x8: 'Cold', 0x10: 'Fire', 0x20: 'Acid', 0x40: 'Electrical',
  };
  const t = against[damageType];
  return t ? `${adjective} protection against ${t} Damage.` : null;
}

/** AppraisalSystem::LockpickSuccessPercentToString @ 0x005e3a40. */
export function lockpickSuccessPercentToString1999(pct: number): string | null {
  if (pct < 0) return null;
  if (pct === 0) return 'impossible';
  if (pct < 5) return 'ridiculously difficult';
  if (pct < 15) return 'extremely difficult';
  if (pct < 35) return 'quite difficult';
  if (pct < 50) return 'difficult';
  if (pct < 70) return 'challenging';
  if (pct < 85) return 'mildly challenging';
  if (pct < 95) return 'easy';
  return 'trivial';
}

/** The missile range SetAppraiseInfo prints: under 10 yards ceil, else truncated down to a multiple of 10 (no cap). */
export function rangeYards1999(range: number): number {
  if (range < 10) return ftol(Math.ceil(range));
  const r = ftol(range);
  return r - (r % 10);
}

// ─── Builder ─────────────────────────────────────────────────────────────

/** Property ids the 1999 panel reads (STypes; the same numbers as end of retail). */
const I = {
  Encumb: 5, Value: 0x13, ArmorLevel: 0x1c, ResistLockpick: 0x26, MinLevel: 0x56, MaxLevel: 0x57, BoosterEnum: 0x59,
  BoostValue: 0x5a, Structure: 0x5c, Spellcraft: 0x6a, CurMana: 0x6b, MaxMana: 0x6c, Difficulty: 0x6d, RankLimit: 0x6e,
  SkillLevelLimit: 0x73, ManaCost: 117, LockpickSuccessPercent: 173, Pages: 174, MaxPages: 175,
} as const;
const STR = { Use: 0xe, ShortDesc: 0xf, LongDesc: 0x10, HeritageRestriction: 0x13, Craftsman: 0x19, PortalDestination: 38 } as const;
const F = { WeaponDefense: 29, ItemEfficiency: 87 } as const;
const B = { Locked: 3 } as const;
const DID_ITEM_SKILL_LIMIT = 37;

/** PublicWeenieDesc bitfield bits the panel tests (Food @ 0x0050d420, Book 0x004e4e10, Healer 0x0050d460, Lockpick 0x0050d4a0). */
const BF = { Book: 0x100, Food: 0x8000, Healer: 0x10000, Lockpick: 0x20000 } as const;

/** Valid-location masks of SetAppraiseInfo's branches. */
const LOC = {
  Weapon: 0x1f00000, Melee: 0x100000, Shield: 0x200000, Missile: 0x400000, Ammo: 0x800000,
  ArmorA: 0x1ff, ArmorB: 0x7e00, Jewelry: 0xf8000, Neck: 0x8000, Wrist: 0x30000, Finger: 0xc0000,
} as const;

class Body1999 {
  runs: AppraisalRun[] = [];
  private length = 0;
  /** ItemExaminePanel::AddItemInfo @ 0x0050d600. */
  add(section: string, text: string, color: AppraisalFontColor = 0): void {
    const separator: AppraisalRun['separator'] = this.length > 1 ? '\n\n' : '';
    this.runs.push({ separator, text, color, section });
    this.length += separator.length + text.length;
  }
}

/** InqInt/FloatEnchantmentMod (0x005dfa10 / 0x005dfad0): a highlighted stat takes panel colour +0x208 or +0x20c. */
function ench(pair: { highlight: number; color: number } | undefined, bit: number): AppraisalFontColor {
  if (!pair || !(pair.highlight & bit)) return 0;
  return pair.color & bit ? 1 : 2;
}

export function buildItemAppraisalText1999(data: IdentifyResponseData, ctx: ItemAppraisalContext = {}): ItemAppraisalText {
  const pInt = (id: number) => data.propertiesInt?.get(id);
  const pStr = (id: number) => data.propertiesString?.get(id);
  const pFloat = (id: number) => data.propertiesFloat?.get(id);
  const pBool = (id: number) => data.propertiesBool?.get(id);
  const success = ctx.appraisalSuccess ?? true;
  const weenie = ctx.weenie ?? {};
  const valid = (weenie.validLocations ?? 0) >>> 0;
  const ammoType = weenie.ammoType ?? 0;
  const wielded = (weenie.location ?? 0) !== 0;
  const bitfield = weenie.objectDescriptionFlags ?? 0;
  const armorEnch = data.armorEnchantment;
  const weaponEnch = data.weaponEnchantment;

  const body = new Body1999();
  const add = body.add.bind(body);

  // Header elements.
  const v = pInt(I.Value);
  const b = pInt(I.Encumb);
  const header = {
    value: v === undefined ? 'Value: ???' : `Value: ${v > 0 ? insertCommas(v) : String(v)} p`,
    burden: b === undefined || b < 0 ? 'Unknown Mass' : `${b} Burden Units`,
  };
  if (!ctx.hasValueBurdenElements) {
    add('Header', header.value);
    add('Header', header.burden);
  }

  // 1. Description.
  const desc = pStr(STR.LongDesc) ?? pStr(STR.ShortDesc);
  if (desc !== undefined) add('Description', desc);

  // 2. The Use string.
  const use = pStr(STR.Use);
  const craftsman = pStr(STR.Craftsman);
  const createdBy = (section: string) => { if (craftsman !== undefined) add(section, `Created by ${craftsman}.`); };
  if (use !== undefined) {
    add('Use', use);
    createdBy('Use');
  }

  let armorOrShieldLevel = -1;
  let rangeShown = false;

  // 3. Weapons, else armor and clothing.
  if (valid & LOC.Weapon) showWeapon();
  else if ((valid & LOC.ArmorA) || (valid & LOC.ArmorB)) showArmor();

  // 4. The magic block's range fallback.
  if (!rangeShown) {
    const range = pFloat(APPRAISAL_1999_FLOAT.rangeFallback);
    if (range !== undefined) add('Range', `Range: ${rangeYards1999(range)} yds.`);
  }

  // 5. Armor protections.
  const ap = data.armorProfile;
  if (ap && armorOrShieldLevel > 0) {
    const S = 'Protections';
    const rows: Array<[number, number, number]> = [
      [0x1, ap.slashing, 0x2], [0x2, ap.piercing, 0x4], [0x4, ap.bludgeoning, 0x8], [0x10, ap.fire, 0x20],
      [0x8, ap.cold, 0x10], [0x20, ap.acid, 0x40], [0x40, ap.lightning, 0x80],
    ];
    for (const [type, mod, bit] of rows) {
      const line = armorProtectionToString1999(type, Math.fround(mod));
      if (line) add(S, line, ench(armorEnch, bit));
    }
  }

  // 6. Jewelry.
  if (valid & LOC.Jewelry) {
    const S = 'Jewelry';
    if (use === undefined) {
      add(S, wielded ? 'Use this item to take it off.'
        : 'Use this item, or drag it to the appropriate jewelry slot on the Inventory Panel, to wear it.');
      createdBy(S);
    }
    if (valid & LOC.Neck) add(S, 'Worn on neck.');
    if (valid & LOC.Wrist) add(S, 'Worn on wrist.');
    if (valid & LOC.Finger) add(S, 'Worn on finger.');
  }

  // 7. Food / books.
  if (use === undefined) {
    if (bitfield & BF.Food) { add('Food', 'Use this item to eat it.'); createdBy('Food'); }
    else if (bitfield & BF.Book) { add('Book', 'Use this item to read it or write in it.'); createdBy('Book'); }
  }

  // 8. Boosts, capacity, pages.
  const boost = pInt(I.BoostValue);
  const booster = pInt(I.BoosterEnum);
  if (boost !== undefined && booster !== undefined) {
    const S = 'Boost';
    if (booster === 2) {
      if (bitfield & BF.Healer) {
        if (success) {
          if (boost < 0) add(S, `Bonus to Healing Skill: ${boost}`);
          else if (boost > 0) add(S, `Bonus to Healing Skill: +${boost}`);
        }
      } else add(S, `Restores ${boost} Health when used.`);
    } else if (booster === 4) {
      add(S, bitfield & BF.Food ? `Restores ${boost} Stamina when consumed.` : `Restores ${boost} Stamina when used.`);
    } else if (booster === 6) add(S, `Restores ${boost} Mana when used.`);
  }
  const capacity = weenie.itemsCapacity ?? 0;
  if (capacity > 0) add('Capacity', `Can hold up to ${capacity} items.`);
  const pages = pInt(I.Pages);
  const maxPages = pInt(I.MaxPages);
  if (pages !== undefined && maxPages !== undefined && pages > -1 && maxPages > -1) add('Pages', `${pages} of ${maxPages} pages full.`);

  // 9a. Locks and lockpicks.
  const locked = pBool(B.Locked);
  const resist = pInt(I.ResistLockpick);
  if (locked !== undefined) {
    const S = 'Lock';
    if (locked) {
      add(S, 'Locked');
      if (resist !== undefined) {
        const word = lockpickSuccessPercentToString1999(pInt(I.LockpickSuccessPercent) ?? -1);
        if (word) add(S, `The lock looks ${word} to pick (Resistance ${resist}).`);
      } else add(S, "You can't tell how hard the lock is to pick.");
    } else add(S, 'Unlocked');
  } else if (resist !== undefined) {
    if (resist < 0) add('Lockpick', `Bonus to Lockpick Skill: ${resist}`);
    else if (resist > 0) add('Lockpick', `Bonus to Lockpick Skill: +${resist}`);
  }

  // 9b. Level restriction — drawn only when the restriction string is non-empty (gate 0x005df880).
  const dest = pStr(STR.PortalDestination);
  if (dest) {
    const S = 'LevelRestriction';
    const min = pInt(I.MinLevel) ?? -1;
    const max = pInt(I.MaxLevel) ?? -1;
    const hasMax = max > -1 && max < 0x7fffffff;
    let line: string;
    if (min > 0) {
      line = hasMax ? (min === max ? `Restricted to characters of Level ${min}.` : `Restricted to characters of Levels ${min} - ${max}.`)
        : `Restricted to characters of Level ${min} or greater.`;
    } else line = hasMax ? `Restricted to characters of Level ${max} or below.` : 'No level restrictions.';
    add(S, line);
    add(S, dest);
  }

  // 9c. Magic — gated on the spell names (0x005df8d0).
  const spells = pStr(APPRAISAL_1999_STRING.spellNames);
  if (spells) {
    const S = 'Magic';
    add(S, success ? `Casts the following spells: ${spells}.` : `Spells: ${spells}.`);
    if (success) {
      const spellcraft = pInt(I.Spellcraft);
      if (spellcraft !== undefined) add(S, `Spellcraft: ${spellcraft}.`);
      const cur = pInt(I.CurMana);
      const max = pInt(I.MaxMana);
      if (cur !== undefined && max !== undefined) add(S, `Mana: ${cur} / ${max}.`);
      const perSeconds = ftol(Math.abs(Math.fround(pFloat(APPRAISAL_1999_FLOAT.manaRate) ?? 0)));
      if (perSeconds !== 0) add(S, `Mana Cost: 1 point per ${perSeconds} seconds.`);
      else {
        const cost = pInt(I.ManaCost);
        if (cost !== undefined && cost > -1) add(S, `Mana Cost: ${cost}.`);
      }
      const difficulty = pInt(I.Difficulty);
      if (difficulty !== undefined) add(S, `Difficulty: ${difficulty}.`);
      const rank = pInt(I.RankLimit);
      if (rank !== undefined && rank > 1) add(S, `You must be of Allegiance Rank ${rank} or greater to use this item.`);
      const heritage = pStr(STR.HeritageRestriction);
      if (heritage !== undefined) add(S, `You must be ${heritage} to use this item's magic.`);
      const limit = pInt(I.SkillLevelLimit);
      const limitSkill = data.propertiesDataID?.get(DID_ITEM_SKILL_LIMIT) ?? 0;
      if (limit !== undefined && limit > 0 && limitSkill) {
        // SkillSystem::InqSkillName — the skill table's name.
        const name = ctx.resolvers?.skillName?.(limitSkill);
        if (name) add(S, `Your ${name} skill must be ${limit} or greater to use this item.`);
      }
      const descriptions = pStr(APPRAISAL_1999_STRING.spellDescriptions);
      if (descriptions) add(S, `Spell Descriptions:\n${descriptions}`);
    }
  }

  // 9d. Mana stone.
  const efficiency = pFloat(F.ItemEfficiency);
  const stored = pInt(I.CurMana);
  if (efficiency !== undefined && efficiency !== -1 && stored !== undefined) {
    if (success) {
      add('ManaStone', `Stored Mana: ${stored}`);
      add('ManaStone', `Efficiency: ${ftol(efficiency * 100)}%`);
    } else {
      add('ManaStone', 'Stored Mana:  Unknown');
      add('ManaStone', 'Efficiency:  Unknown');
    }
  }

  // 9e. Uses.
  const uses = pInt(I.Structure);
  if (uses !== undefined) add('Uses', `Number of uses remaining: ${uses}`);
  else if (!success && (bitfield & (BF.Lockpick | BF.Healer))) add('Uses', 'Number of uses remaining:  Unknown');

  // 9f. Enchantments.
  const enchantments = pStr(APPRAISAL_1999_STRING.enchantments);
  if (enchantments) add('Enchantments', `Enchantments:\n${enchantments}`);

  return finishAppraisalText(header, body.runs);

  // ── Weapons (0x0050b9ae–0x0050c23b) ─────────────────────────────────────
  function showWeapon(): void {
    const S = 'Weapon';
    if (use === undefined) {
      add(S, wielded ? 'Use this item to unwield it.'
        : valid & LOC.Ammo ? 'Use this item, or drag it to the ammunition slot on the Inventory Panel, to wield it.'
          : valid & LOC.Shield ? 'Use this item, or drag it onto the shield slot in the Inventory Panel, to wield it.'
            : 'Use this item, or drag it to the weapon slot on the Inventory Panel, to wield it.');
      createdBy(S);
    }
    if (valid & LOC.Shield) {
      const sl = pInt(I.ArmorLevel);
      if (sl === undefined) add(S, 'Shield Level: Unknown');
      else { armorOrShieldLevel = sl; add(S, `Shield Level: ${sl}`, ench(armorEnch, 0x1)); }
    }
    const w = data.weaponProfile;
    if (w) {
      // A launcher with ammunition has no damage line: the damage is the ammunition's.
      if (!((valid & LOC.Missile) && ammoType !== 0)) {
        if (w.damage > -1) {
          const type = w.damageType === 0 ? 'unknown type' : damageTypeToString1999(w.damageType);
          const min = ftol(Math.ceil((1.0 - w.damageVariance) * w.damage));
          const line = min === w.damage ? `Damage: ${w.damage}, ${type}` : `Damage: ${min} - ${w.damage}, ${type}`;
          let c = ench(weaponEnch, 0x8);
          if (!(weaponEnch && weaponEnch.highlight & 0x8)) c = ench(weaponEnch, 0x10);
          add(S, line, c);
        } else add(S, 'Damage:  Unknown');
      }
      const defense = pFloat(F.WeaponDefense) ?? 1.0;
      if (defense !== 1.0) {
        add(S, defense > 1.0 ? `Bonus to Melee Defense: +${ftol((defense - 1.0) * 100.0)}%.`
          : `Bonus to Melee Defense: -${ftol((1.0 - defense) * 100.0)}%.`, ench(weaponEnch, 0x2));
      }
      if (w.weaponOffense !== 1.0) {
        add(S, w.weaponOffense > 1.0 ? `Bonus to Attack Skill: +${ftol((w.weaponOffense - 1.0) * 100.0)}%.`
          : `Bonus to Attack Skill: -${ftol((1.0 - w.weaponOffense) * 100.0)}%.`, ench(weaponEnch, 0x1));
      }
      if (valid & (LOC.Melee | LOC.Missile)) {
        if (w.weaponTime > -1) {
          add(S, `Speed: ${weaponTimeToString1999(w.weaponTime)} (${w.weaponTime})`, ench(weaponEnch, 0x4));
          if (valid & LOC.Missile) {
            add(S, `Range: ${rangeYards1999((Math.pow(w.maxVelocity, 2) / 9.8) * 1.094)} yds.`);
            rangeShown = true;
          }
        } else {
          add(S, 'Speed:  Unknown');
          if (valid & LOC.Missile) add(S, 'Range:  Unknown');
        }
      }
      const skill = WEAPON_SKILL_NAMES_1999[w.weaponSkill];
      if (skill !== undefined) add(S, `Uses ${skill} Skill`);
    }
    if (valid & LOC.Missile) {
      add(S, 'Cannot be used with shields.');
      const t = ammoType === 1 ? 'Uses arrows as ammunition.' : ammoType === 2 ? 'Uses quarrels as ammunition.'
        : ammoType === 3 ? 'Uses slingstones as ammunition.' : null;
      if (t) add(S, t);
    } else if (valid & LOC.Ammo) {
      const t = ammoType === 1 ? 'Used as ammunition by bows.' : ammoType === 2 ? 'Used as ammunition by crossbows.'
        : ammoType === 3 ? 'Used as ammunition by slings.' : null;
      if (t) add(S, t);
    }
  }

  // ── Armor and clothing (0x0050c240–0x0050c3bf) ──────────────────────────
  function showArmor(): void {
    const S = 'Armor';
    if (use === undefined) {
      add(S, wielded ? 'Use this item to take it off.'
        : 'Use this item, or drag it onto the character in the Inventory Panel, to wear it.');
      createdBy(S);
    }
    const al = pInt(I.ArmorLevel);
    if (al === undefined) add(S, 'Armor Level:  Unknown');
    else {
      armorOrShieldLevel = al;
      if (al > 0) add(S, `Armor Level:  ${al}`, ench(armorEnch, 0x1));
    }
    const covers = coverageToString1999(valid);
    if (covers) add(S, covers);
  }
}
