/**
 * STATS.enchantments-never-populated / STATS.runrate-uses-unbuffed-run /
 * STATS.burden-capacity-augs-buffs / STATS.regen-prediction-diverges —
 * the player's CURRENT (buffed) stats computed the way ACE does.
 *
 * Pre-fix, playerState.enchantments was never filled from the wire, so every
 * displayed max vital / attribute / skill (and the run rate, jump, carry
 * capacity) was the UNBUFFED base; vitae, StartingValue and augmentations
 * were ignored, and setCurrent clamped a server-sent buffed current down to
 * the unbuffed max. These drive the real EnchantmentManager registry,
 * CreatureStats helpers, VitalSystem, PlayerState, InventoryController and
 * GameUI.syncFromPlayerState.
 *
 * References: ACE CreatureAttribute.cs:141-155, CreatureVital.cs:127-174,
 * CreatureSkill.cs:136-243, EnchantmentManager.cs:680-790/944-956/1104-1123,
 * PropertiesEnchantmentRegistryExtensions.cs:197-237, Player_Inventory.cs:
 * 46-51; retail CEnchantmentRegistry::PurgeEnchantments @ 00594de0,
 * CACQualities::InqLoad @ 0058f130.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EnchantmentManager, StatModType, VITAE_SPELL_ID, EnchantmentCategory, EnchantmentStatDomain,
  AttributeSystem, AttributeId, VitalSystem, VitalId, SkillSystem, SkillId, SkillAdvancementClass,
  RegenStance, PropertyInt,
  getAttributeCurrent, getSkillCurrent, getSkillBaseValue, playerStatModsFromIntProps,
  type EnchantmentRegistryEntry, type PlayerStatMods,
} from '@ac/shared';
import type { SkillBase, SkillFormula } from '@ac/dat-parser';
import { DatDatabase, DatReader, SecondaryAttributeTable } from '@ac/dat-parser';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { InventoryController } from '../packages/renderer/src/controllers/InventoryController.js';
import { openDat } from './_harness/dat.js';

const { Attribute, SecondAtt, Skill, Float, SingleStat, MultipleStat, Multiplicative, Additive, DefenseSkills, Vitae, Cooldown, Beneficial } = StatModType;

let nextCategory = 1000;
function ench(p: Partial<EnchantmentRegistryEntry> & { statModType: number; statModKey: number; statModValue: number }): EnchantmentRegistryEntry {
  return {
    spellId: p.spellId ?? nextCategory,
    layer: p.layer ?? 1,
    spellCategory: p.spellCategory ?? nextCategory++,
    powerLevel: p.powerLevel ?? 100,
    startTime: p.startTime ?? 0,
    duration: p.duration ?? 1800,
    casterGuid: p.casterGuid ?? 0x50000001,
    statModType: p.statModType,
    statModKey: p.statModKey,
    // statModValue arrives as a wire float32 (parseEnchantmentFromReader readFloat32)
    statModValue: Math.fround(p.statModValue),
    spellSetId: p.spellSetId ?? 0,
  };
}
const attrBuff = (attr: number, v: number, extra: Partial<EnchantmentRegistryEntry> = {}): EnchantmentRegistryEntry =>
  ench({ statModType: Attribute | SingleStat | Additive | Beneficial, statModKey: attr, statModValue: v, ...extra });
const vitae = (v: number): EnchantmentRegistryEntry =>
  ench({ spellId: VITAE_SPELL_ID, layer: 0, spellCategory: 204, statModType: Vitae | SecondAtt | Skill | Multiplicative, statModKey: 0, statModValue: v });

const NO_MODS: PlayerStatMods = playerStatModsFromIntProps(() => undefined);

// ─── Registry: ACE top-layer stacking ────────────────────────────────────

describe('EnchantmentManager registry — ACE GetEnchantments_TopLayer stacking', () => {
  it('only the TOP layer of a SpellCategory counts (highest PowerLevel)', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(attrBuff(AttributeId.Strength, 10, { spellId: 2, spellCategory: 1, powerLevel: 100 }));
    m.upsertRegistryEntry(attrBuff(AttributeId.Strength, 20, { spellId: 3, spellCategory: 1, powerLevel: 200 }));
    expect(m.getAttributeModAdditive(AttributeId.Strength)).toBe(20); // not 30
  });

  it('equal PowerLevel ties go to the latest StartTime (retail Enchantment::Duel @ 005cace0)', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(attrBuff(AttributeId.Strength, 10, { spellId: 2, spellCategory: 1, startTime: -50 }));
    m.upsertRegistryEntry(attrBuff(AttributeId.Strength, 12, { spellId: 3, spellCategory: 1, startTime: -10 }));
    expect(m.getAttributeModAdditive(AttributeId.Strength)).toBe(12);
  });

  it('different categories stack (a buff and a debuff of one stat)', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(attrBuff(AttributeId.Strength, 20, { spellId: 2 }));
    m.upsertRegistryEntry(ench({ spellId: 3, statModType: Attribute | SingleStat | Additive, statModKey: AttributeId.Strength, statModValue: -5 }));
    expect(m.getAttributeModAdditive(AttributeId.Strength)).toBe(15);
  });

  it('additive attribute/skill values truncate per entry ((int)StatModValue)', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(attrBuff(AttributeId.Focus, 7.9));
    expect(m.getAttributeModAdditive(AttributeId.Focus)).toBe(7);
  });

  it('MultipleStat key-0 entries hit every key of the type (handleMultiple)', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(ench({ statModType: Attribute | MultipleStat | Additive, statModKey: 0, statModValue: 5 }));
    expect(m.getAttributeModAdditive(AttributeId.Self)).toBe(5);
    expect(m.getAttributeModAdditive(AttributeId.Strength)).toBe(5);
  });

  it('a key match needs the SingleStat bit when multiples are handled (ACE :214)', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(ench({ statModType: Attribute | Additive, statModKey: AttributeId.Strength, statModValue: 9 }));
    expect(m.getAttributeModAdditive(AttributeId.Strength)).toBe(0);
  });

  it('multipliers multiply in float (e.g. 1.1 × 0.9)', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(ench({ statModType: SecondAtt | SingleStat | Multiplicative, statModKey: 1, statModValue: 1.1 }));
    m.upsertRegistryEntry(ench({ statModType: SecondAtt | SingleStat | Multiplicative, statModKey: 1, statModValue: 0.9 }));
    expect(m.getVitalModMultiplier(1)).toBe(Math.fround(Math.fround(1.1) * Math.fround(0.9)));
    expect(m.getVitalModMultiplier(3)).toBe(1.0);
  });

  it('Dirty Fighting defense debuff (key 0) hits defense skills only, Math.Round half-to-even', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(ench({ statModType: Skill | Additive | DefenseSkills, statModKey: 0, statModValue: -10.5 }));
    expect(m.getSkillModAdditive(SkillId.MeleeDefense)).toBe(-10);
    expect(m.getSkillModAdditive(SkillId.Run)).toBe(0);
  });

  it('regeneration spells are Float multipliers on the rate key (GetRegenerationMod)', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(ench({ statModType: Float | SingleStat | Multiplicative, statModKey: 3, statModValue: 1.5 }));
    expect(m.getRegenerationMod(3)).toBe(1.5);
    expect(m.getRegenerationMod(4)).toBe(1.0);
  });
});

describe('EnchantmentManager registry — add / remove / purge / vitae slot', () => {
  it('vitae lives in its own slot; getVitae is its StatModValue, 1.0 without', () => {
    const m = new EnchantmentManager();
    expect(m.getVitae()).toBe(1.0);
    m.upsertRegistryEntry(vitae(0.9));
    expect(m.getVitae()).toBe(Math.fround(0.9));
    // vitae never joins the stat lookups themselves
    expect(m.getVitalModMultiplier(1)).toBe(1.0);
    // ACE sends vitae's removal with layer forced to 0 (EnchantmentManager.cs:327)
    expect(m.removeRegistryEntry(VITAE_SPELL_ID, 0)).toBe(true);
    expect(m.getVitae()).toBe(1.0);
  });

  it('remove / dispel by spellId + layer', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(attrBuff(AttributeId.Strength, 10, { spellId: 2, layer: 1 }));
    m.upsertRegistryEntry(attrBuff(AttributeId.Strength, 5, { spellId: 2, layer: 2 }));
    m.removeRegistryEntry(2, 1);
    expect(m.getAttributeModAdditive(AttributeId.Strength)).toBe(5);
  });

  it('purge keeps vitae + cooldowns (retail PurgeEnchantments @ 00594de0); purge-bad keeps beneficial', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(attrBuff(AttributeId.Strength, 10, { spellId: 2 }));
    m.upsertRegistryEntry(ench({ spellId: 3, statModType: Attribute | SingleStat | Additive, statModKey: AttributeId.Strength, statModValue: -4 }));
    m.upsertRegistryEntry(ench({ spellId: 0x8005, statModType: Cooldown, statModKey: 0, statModValue: 0 }));
    m.upsertRegistryEntry(vitae(0.95));

    m.purgeBadRegistry();
    expect(m.getAttributeModAdditive(AttributeId.Strength)).toBe(10);

    m.purgeRegistry();
    expect(m.getAttributeModAdditive(AttributeId.Strength)).toBe(0);
    expect(m.getVitae()).toBe(Math.fround(0.95));
    expect(m.getRegistryEntries().some((e) => e.spellId === 0x8005)).toBe(true);
  });

  it('loadRegistry replaces the previous character\'s registry', () => {
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(attrBuff(AttributeId.Strength, 10));
    m.upsertRegistryEntry(vitae(0.8));
    m.loadRegistry([attrBuff(AttributeId.Self, 3)]);
    expect(m.getAttributeModAdditive(AttributeId.Strength)).toBe(0);
    expect(m.getAttributeModAdditive(AttributeId.Self)).toBe(3);
    expect(m.getVitae()).toBe(1.0);
  });
});

describe('EnchantmentManager.computeEffectiveStat — top layer per category, not a sum', () => {
  it('two same-category entries for one key do not stack', () => {
    const m = new EnchantmentManager();
    const base = { spellName: 'x', buffAttribute: 1, duration: 60, remaining: 60, casterId: 0 };
    // bypass apply()'s dedup: entries that arrive by any other path
    const list = m.getAll() as unknown as Array<Record<string, unknown>>;
    list.push({ ...base, spellId: 1, category: EnchantmentCategory.AttributeBuff, magnitude: 10, spellLevel: 3 });
    list.push({ ...base, spellId: 2, category: EnchantmentCategory.AttributeBuff, magnitude: 25, spellLevel: 6 });
    expect(m.computeEffectiveStat(100, 1, EnchantmentStatDomain.Attribute)).toBe(125);
  });
});

// ─── Attributes / skills / vitals ────────────────────────────────────────

function attrs(v: Partial<Record<'strength' | 'endurance' | 'coordination' | 'quickness' | 'focus' | 'self', number>> = {}): AttributeSystem {
  return new AttributeSystem({ strength: 100, endurance: 100, coordination: 100, quickness: 100, focus: 100, self: 100, ...v });
}
const formula = (attr1: number, attr2: number, z: number): SkillFormula => ({ w: 0, x: 1, y: attr2 ? 1 : 0, z, attr1, attr2 });
const skillDef = (f: SkillFormula, minLevel: number): SkillBase => ({
  description: '', name: '', iconId: 0, trainedCost: 0, specializedCost: 0, category: 0, chargenUse: 0,
  minLevel, formula: f, upperBound: 0, lowerBound: 0, learnMod: 0,
});
// DAT SkillTable shapes: Run = Quickness (attr 3); Melee Defense = (Coord+Quick)/3; War = (Focus+Self)/4.
const SKILL_TABLE = new Map<number, SkillBase>([
  [SkillId.Run, skillDef(formula(3, 0, 1), 1)],
  [SkillId.MeleeDefense, skillDef(formula(4, 3, 3), 1)],
  [SkillId.WarMagic, skillDef(formula(5, 6, 4), 2)],
]);

describe('getAttributeCurrent — ACE CreatureAttribute.GetCurrent', () => {
  it('adds buffs; a debuff floors at 10 (1 when Base < 10)', () => {
    const a = attrs({ strength: 50, focus: 8 });
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(attrBuff(AttributeId.Strength, 30));
    expect(getAttributeCurrent(a, AttributeId.Strength, m)).toBe(80);
    m.loadRegistry([ench({ statModType: Attribute | SingleStat | Additive, statModKey: AttributeId.Strength, statModValue: -100 })]);
    expect(getAttributeCurrent(a, AttributeId.Strength, m)).toBe(10);
    m.loadRegistry([ench({ statModType: Attribute | SingleStat | Additive, statModKey: AttributeId.Focus, statModValue: -100 })]);
    expect(getAttributeCurrent(a, AttributeId.Focus, m)).toBe(1);
  });
});

describe('getSkillCurrent — ACE CreatureSkill.Current', () => {
  it('uses BUFFED attributes in the formula (a Quickness buff raises Run)', () => {
    const a = attrs();
    const s = new SkillSystem(new Map());
    const m = new EnchantmentManager();
    expect(getSkillCurrent(s, SkillId.Run, SKILL_TABLE, a, m, NO_MODS)).toBe(100);
    m.upsertRegistryEntry(attrBuff(AttributeId.Quickness, 50));
    expect(getSkillCurrent(s, SkillId.Run, SKILL_TABLE, a, m, NO_MODS)).toBe(150);
    // Base stays unbuffed
    expect(getSkillBaseValue(s, SkillId.Run, SKILL_TABLE, a, NO_MODS)).toBe(100);
  });

  it('multiplier × vitae, then the post-vitae aug bonus, then additives (float, Round)', () => {
    const a = attrs();
    const s = new SkillSystem(new Map());
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(attrBuff(AttributeId.Quickness, 50));
    m.upsertRegistryEntry(ench({ statModType: Skill | SingleStat | Additive, statModKey: SkillId.Run, statModValue: 40 }));
    m.upsertRegistryEntry(vitae(0.9));
    const mods = { ...NO_MODS, augmentationJackOfAllTrades: 1 };
    // 150 × 0.9f = 135 (float), + 5 (Jack of All Trades, not vitae-scaled), + 40
    expect(getSkillCurrent(s, SkillId.Run, SKILL_TABLE, a, m, mods)).toBe(180);
  });

  it('aug base bonuses: LumAugAllSkills + Master of the Five Fold Path + Enlightenment (trained)', () => {
    const a = attrs();
    const s = new SkillSystem(new Map());
    s.setSkill(SkillId.WarMagic, SkillAdvancementClass.Specialized, 10, 10);
    const mods = { ...NO_MODS, lumAugAllSkills: 2, augmentationSkilledMagic: 1, enlightenment: 1, lumAugSkilledSpec: 3 };
    // formula (100+100)/4 = 50, + InitLevel 10 + Ranks 10 = 70; base augs +2 +10 +1 = 83
    expect(getSkillBaseValue(s, SkillId.WarMagic, SKILL_TABLE, a, mods)).toBe(83);
    // current adds the specialized aura: +3×2
    expect(getSkillCurrent(s, SkillId.WarMagic, SKILL_TABLE, a, new EnchantmentManager(), mods)).toBe(89);
  });

  it('a skill cannot be debuffed below 0', () => {
    const a = attrs();
    const s = new SkillSystem(new Map());
    const m = new EnchantmentManager();
    m.upsertRegistryEntry(ench({ statModType: Skill | SingleStat | Additive, statModKey: SkillId.Run, statModValue: -500 }));
    expect(getSkillCurrent(s, SkillId.Run, SKILL_TABLE, a, m, NO_MODS)).toBe(0);
  });
});

describe('PlayerState vitals — ACE CreatureVital.GetMaxValue', () => {
  function player(): PlayerState {
    const ps = new PlayerState();
    ps.attributes.setInnate(AttributeId.Endurance, 200);
    ps.vitals.setRaises(VitalId.Health, 40);
    return ps;
  }

  it('StartingValue + Ranks + formula; Enlightenment×2 + GearMaxHealth join health', () => {
    const ps = player();
    expect(ps.health.max).toBe(140); // End 200 / 2 + 40
    ps.vitals.setStartingValue(VitalId.Health, 3);
    expect(ps.health.max).toBe(143);
    ps.serverIntProps.set(PropertyInt.Enlightenment, 2);
    ps.serverIntProps.set(PropertyInt.GearMaxHealth, 1);
    expect(ps.health.max).toBe(148);
  });

  it('an Endurance buff raises max health and stamina; a max-health buff adds after', () => {
    const ps = player();
    ps.enchantments.upsertRegistryEntry(attrBuff(AttributeId.Endurance, 20));
    expect(ps.health.max).toBe(150); // 220/2 + 40
    expect(ps.stamina.max).toBe(220);
    ps.enchantments.upsertRegistryEntry(ench({ statModType: SecondAtt | SingleStat | Additive, statModKey: 1, statModValue: 25 }));
    expect(ps.health.max).toBe(175);
  });

  it('vitae scales the max in single-precision float (150 × 0.95f = 142.5f → 143)', () => {
    const ps = player();
    ps.serverIntProps.set(PropertyInt.Enlightenment, 5); // 140 + 10 = 150
    ps.enchantments.upsertRegistryEntry(vitae(0.95));
    // double math would give 142.4999982 → 142; ACE's float gives 143
    expect(ps.health.max).toBe(143);
  });

  it('setCurrent keeps a server current above the unbuffed max when the buffed max allows it', () => {
    const ps = player();
    ps.enchantments.upsertRegistryEntry(attrBuff(AttributeId.Endurance, 20));
    ps.vitals.setCurrent(VitalId.Health, 150, ps.attributes);
    expect(ps.health.current).toBe(150);
    expect(ps.vitals.getMaxValue(VitalId.Health, ps.attributes, false)).toBe(140);
  });

  it('a max vital never falls below 5 from enchantments', () => {
    const ps = player();
    ps.enchantments.upsertRegistryEntry(ench({ statModType: SecondAtt | SingleStat | Additive, statModKey: 5, statModValue: -9999 }));
    expect(ps.mana.max).toBe(5);
  });
});

describe('regen prediction — STATS.regen-prediction-diverges', () => {
  it('a regeneration enchantment in the registry multiplies the predicted tick', () => {
    const ps = new PlayerState();
    const base = ps.vitals.getRegenPerTick(VitalId.Stamina, ps.attributes, RegenStance.Standing);
    expect(base).toBe(3); // player weenie StaminaRate 3
    ps.enchantments.upsertRegistryEntry(ench({ statModType: Float | SingleStat | Multiplicative, statModKey: 4, statModValue: 1.5 }));
    expect(ps.vitals.getRegenPerTick(VitalId.Stamina, ps.attributes, RegenStance.Standing)).toBe(4.5);
  });

  it('Innate Renewal applies while standing (no Sleeping gate in ACE)', () => {
    const vs = new VitalSystem();
    vs.setRegenRate(VitalId.Mana, 1);
    expect(vs.getRegenPerTick(VitalId.Mana, attrs(), RegenStance.Standing, 1.0, 1)).toBe(2);
  });
});

describe('carry capacity — STATS.burden-capacity-augs-buffs', () => {
  it('buffed Strength + Increased Carrying Capacity augs; the server snapshot is ignored', () => {
    const ps = new PlayerState();
    ps.attributes.setInnate(AttributeId.Strength, 100);
    expect(ps.encumbranceCapacity).toBe(15000);
    ps.enchantments.upsertRegistryEntry(attrBuff(AttributeId.Strength, 50));
    ps.serverIntProps.set(PropertyInt.AugmentationIncreasedCarryingCapacity, 2);
    ps.serverEncumbranceCapacity = 12000;
    // 150×150 + 150×60
    expect(ps.encumbranceCapacity).toBe(31500);
    const inv = new InventoryController();
    inv.setPlayerState(ps);
    expect(inv.maxBurden).toBe(31500);
  });
});

// ─── DAT SecondaryAttributeTable drives the vital formulas ───────────────

const PORTAL = resolve(__dirname, '..', 'dat', 'client_portal.dat');
describe.skipIf(!existsSync(PORTAL))('VitalSystem + DAT SecondaryAttributeTable (0x0E000003)', () => {
  let table: SecondaryAttributeTable;
  beforeAll(() => {
    const db = openDat(PORTAL);
    table = new SecondaryAttributeTable(new DatReader(db.getFileData(0x0E000003)!));
  });

  it('the DAT formulas give the same maxima as the built-in End/2, End, Self fallback', () => {
    for (const [end, self] of [[10, 10], [101, 57], [290, 333], [7, 3]]) {
      const a = attrs({ endurance: end, self });
      const withTable = new VitalSystem();
      withTable.setFormulaTable(table);
      const fallback = new VitalSystem();
      for (const id of [VitalId.Health, VitalId.Stamina, VitalId.Mana]) {
        expect(withTable.getMax(id, a)).toBe(fallback.getMax(id, a));
      }
    }
    expect(table.maxHealth).toMatchObject({ attr1: 2, z: 2 });
    expect(table.maxStamina).toMatchObject({ attr1: 2, z: 1 });
    expect(table.maxMana).toMatchObject({ attr1: 6, z: 1 });
  });
});

// ─── GameUI panels show the Current values ───────────────────────────────

const HAPPY_DOM_PKG = ['happy', 'dom'].join('-');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let domWindow: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ HAPPY_DOM_PKG);
  domWindow = new mod.Window({ innerWidth: 1024, innerHeight: 768 });
} catch { /* skip */ }
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe.skipIf(!domWindow)('GameUI.syncFromPlayerState shows buffed attributes / skills', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
    ui.skillTable = { skills: SKILL_TABLE };
  });
  afterAll(() => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) g[key] = saved[key];
  });

  it('attribute buffed column = CreatureAttribute.Current; skill effective/base = Current/Base; burdenMax untouched', () => {
    const ps = new PlayerState();
    ps.attributes.setInnate(AttributeId.Quickness, 100);
    ps.enchantments.upsertRegistryEntry(attrBuff(AttributeId.Quickness, 50));
    ui.setBurden(0, 31500);
    ui.syncFromPlayerState(ps);
    expect(ui.charInfo.attributes.quickness).toMatchObject({ base: 100, buffed: 150 });
    const run = ui.charInfo.skills.find((sk: { id: number }) => sk.id === SkillId.Run);
    expect(run).toMatchObject({ base: 100, effective: 150 });
    // the old `STR * 150` override no longer clobbers the real capacity
    expect(ui.burdenMax).toBe(31500);
  });

  it('syncFromPlayerState keeps the server EncumbranceVal (playwebac.com showed a new character at 300%)', () => {
    const ps = new PlayerState();
    // A stack whose burden is already its whole-stack EncumbranceVal: the
    // client-side sum multiplies it by stackSize again.
    ps.inventory.addItem({ weenieClassId: 273, name: 'Pyreal', burden: 1200, value: 1, stackable: true, stackSize: 25000, maxStackSize: 25000, containerId: 0 });
    expect(ps.totalBurden).toBeGreaterThan(15000 * 3);
    ui.setBurden(1500, 15000); // server EncumbranceVal / capacity
    ui.syncFromPlayerState(ps);
    expect(ui.burdenCurrent).toBe(1500);
    expect(ui.burdenMax).toBe(15000);
  });
});
