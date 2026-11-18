/**
 * BUG.agent-undelivered-property-reads: the automation reads an examined object's properties from where an ACE
 * server sends them. ACE appraises only [AssessmentProperty] ids (packages/shared aceDeliveredProperties.ts); the
 * weapon numbers come in the WeaponProfile and ItemType / ValidLocations / StackSize / ItemUseable / Spell only in
 * CreateObject. Fixtures are built by aceRecord (tests/_harness/aceAppraisal.ts), which refuses a table ACE could
 * not have sent, the PetClass-266 shape that kept Summon Pets' tests green while it was dead on ACE.
 */
import { describe, expect, it } from 'vitest';
import { DECAL_INT_KEYS, PropertyDataId, PropertyInt, SkillId, utlToLoot, type PlanSkill } from '@ac/shared';
import { withPublicDescription } from '../packages/renderer/src/agent/itemRecord.ts';
import { generateLoadout } from '../packages/renderer/src/agent/macro/defaultLoadout.ts';
import { itemSpellId, mustWield, useRequirementProblem } from '../packages/renderer/src/agent/macro/itemUse.ts';
import { doorLock } from '../packages/renderer/src/agent/routeNodes.ts';
import { lootRuleFor } from '../packages/renderer/src/agent/RoutineEngine.ts';
import { aceRecord } from './_harness/aceAppraisal.ts';

const skill = (id: number, name: string, training: PlanSkill['training'], buffed = 200): PlanSkill => ({ id, name, training, base: buffed, buffed });
const tables = (r: ReturnType<typeof aceRecord>) => ({ ints: r.int, floats: r.float, dids: r.did });

describe('the fixture builder', () => {
  it('refuses an examination table ACE could not have sent', () => {
    expect(() => aceRecord({ appraisal: { int: { 266: 49052 } } })).toThrow(/int 266/);
    expect(() => aceRecord({ appraisal: { int: { 48: 11 } } })).toThrow(/int 48/);
    expect(() => aceRecord({ appraisal: { int: { 16: 8 } } })).toThrow(/int 16/);
    expect(() => aceRecord({ appraisal: { did: { 28: 1234 } } })).toThrow(/did 28/);
    expect(() => aceRecord({ appraisal: { int: { 366: 54, 92: 50 }, did: { 55: 4 } } })).not.toThrow();
  });
});

describe('the record adds the public description (agent/itemRecord.ts withPublicDescription)', () => {
  it('where the tables have nothing; Structure 0 of a MaxStructure is kept, other 0s are absent fields', () => {
    const base = { int: { 92: 7 }, float: {}, string: {}, bool: {}, did: {}, spells: [], spellIds: [], activeSpellIds: [] };
    const r = withPublicDescription(base, { itemType: 0x8000, usable: 0x600004, validLocations: 0x1000000, stackSize: 0, structure: 3, maxStructure: 50, spellDid: 1234, iconDid: 0x06001234, cooldownDuration: 45 });
    expect(r.int).toEqual({ 1: 0x8000, 16: 0x600004, 9: 0x1000000, 91: 50, 92: 7 });
    expect(r.did).toEqual({ 28: 1234, 8: 0x06001234 });
    expect(r.float).toEqual({ 167: 45 });
    expect(withPublicDescription({ ...base, int: {} }, { structure: 0, maxStructure: 50 }).int[92]).toBe(0);
    expect(withPublicDescription({ ...base, int: {} }, { structure: 0 }).int[92]).toBeUndefined();
    expect(withPublicDescription(base, null)).toBe(base);
  });
});

describe('the readers, on what an ACE server sends', () => {
  it('the generated profile lists a weapon by the WeaponSkill of its WeaponProfile (no 48 in an ACE table)', () => {
    const sword = aceRecord({ appraisal: { int: { 45: 1, 158: 2, 159: 45, 160: 100 } }, weaponProfile: { weaponSkill: SkillId.LightWeapons, weaponTime: 30, damage: 20, damageType: 1 }, header: { itemType: 0x1 } });
    const bow = aceRecord({ appraisal: { int: { 45: 2 } }, weaponProfile: { weaponSkill: SkillId.MissileWeapons, weaponTime: 50 }, header: { itemType: 0x100, ammoType: 1 } });
    const out = generateLoadout({
      items: [{ guid: 1, name: 'Sword', itemType: 0x1, ints: sword.int }, { guid: 2, name: 'Bow', itemType: 0x100, ints: bow.int }],
      skills: [skill(SkillId.LightWeapons, 'Light Weapons', 'specialized'), skill(SkillId.MissileWeapons, 'Missile Weapons', 'untrained')],
    });
    expect(out.items.map((i) => i.name)).toEqual(['Sword']);
    expect(out.unexamined).toEqual([]);
  });

  it("a wielded-use item: ItemUseable and Spell from CreateObject, the activation skill from AppraisalItemSkill 176", () => {
    // The Healer's Heart on ACE: ItemSkillLevelLimit 115 and AppraisalItemSkill 176 in the tables (no ItemSkillLimit
    // data id 37, which GDLE and the AC1999 server send); ItemUseable and its Spell only in the header.
    const heart = aceRecord({
      appraisal: { int: { [PropertyInt.ItemSkillLevelLimit]: 245, [PropertyInt.AppraisalItemSkill]: SkillId.LifeMagic, [PropertyInt.WieldRequirements]: 7, [PropertyInt.WieldDifficulty]: 50 } },
      header: { usable: 0x600004, itemType: 0x8000, spellDid: 2345 },
    });
    const item = { name: "The Healer's Heart", ...tables(heart) };
    expect(heart.did[PropertyDataId.ItemSkillLimit]).toBeUndefined();
    expect(mustWield(item)).toBe(true);
    expect(itemSpellId(item)).toBe(2345);
    const life = (b: number) => [skill(SkillId.LifeMagic, 'Life Magic', 'trained', b)];
    expect(useRequirementProblem(item, life(200), 100)).toMatch(/245 Life Magic/);
    expect(useRequirementProblem(item, life(300), 40)).toMatch(/wield requirement/);
    expect(useRequirementProblem(item, life(300), 100)).toBeNull();
  });

  it("a door's lock: the difficulty is ResistLockpick 38, not the success percent 173; GDLE's unlocked door with 38 is not locked", () => {
    expect(doorLock(aceRecord({ appraisal: { bool: { 3: true }, int: { 38: 220, 173: 35 } } }))).toEqual({ locked: true, difficulty: 220 });
    // ACE drops ResistLockpick on an unlocked door; a DefaultLocked one says Locked false.
    expect(doorLock(aceRecord({ appraisal: { bool: { 3: false } } }))).toEqual({ locked: false });
    // GDLE: ResistLockpick on an unlocked door too, no Locked bool; the percent only for a locked one.
    expect(doorLock({ int: { 38: 120 } })).toEqual({ locked: false });
    expect(doorLock({ int: { 38: 120, 173: 60 } })).toEqual({ locked: true, difficulty: 120 });
  });

  it("VTClassic rules on Decal's CreateObject keys (Type, EquipableSlots, StackCount, Icon) match an ACE item", () => {
    const axe = aceRecord({
      appraisal: { int: { 19: 900, 5: 400 } },
      weaponProfile: { damage: 30, damageVariance: 0.4, weaponSkill: SkillId.HeavyWeapons, weaponTime: 40, damageType: 1 },
      header: { itemType: 0x1, validLocations: 0x100000, stackSize: 1, iconDid: 0x06001234 },
    });
    const props = { int: axe.int, float: axe.float, did: axe.did, string: axe.string, bool: axe.bool };
    // Decal keys: Type 218103808 → ItemType 1, EquipableSlots 218103822 → ValidLocations 9, MaxDamage → 44, Icon → did 8.
    const req = (type: number, a: string, b: string) => ({ type, lines: [a, b] });
    const { value: rules } = utlToLoot([{ name: 'axe', action: 1, reqs: [
      req(12, '1', '218103808'), req(11, String(0x100000), '218103822'), req(3, '30', '218103842'), req(12, String(0x1234), '218103809'),
    ] }] as never);
    expect(rules[0].match.props?.length).toBe(4);
    expect(lootRuleFor(rules, { name: 'Axe', props })).not.toBeNull();
    expect(lootRuleFor(rules, { name: 'Axe', props: { ...props, int: { ...props.int, 9: 0x200000 } } })).toBeNull();
    // Minimum damage reads the folded WeaponProfile (30 × (1 − 0.4) = 18).
    expect(lootRuleFor([{ action: 'keep', match: { minDamageAtLeast: 18 } }] as never, { name: 'Axe', props })).not.toBeNull();
    expect(lootRuleFor([{ action: 'keep', match: { minDamageAtLeast: 19 } }] as never, { name: 'Axe', props })).toBeNull();
    expect(DECAL_INT_KEYS[218103808]).toEqual({ kind: 'int', key: 1 });
  });
});
