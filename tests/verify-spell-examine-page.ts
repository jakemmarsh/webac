/**
 * The examination window's spell page — SpellExamineUI::ExamineSpell
 * @ 004b6210 (SetManaText @ 004b5e40, DetermineSpellRange @ 004ad450,
 * UpdateComponents @ 004abe20). Behavioral over the shipped builder, plus the
 * real EoL spell table when the DAT is present.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import {
  buildSpellExamineModel, spellManaText, spellDurationText, spellRangeText, schoolName,
  skillForSchool, spellComponentListRect,
} from '../packages/renderer/src/ui/examine/SpellExamine.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.js';
import { SpellComponentTable } from '../packages/dat-parser/src/file-types/SpellComponentTable.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { scarabOnlyFormula } from '../packages/shared/src/magic/SpellComponentCheck.js';

/** A caster with no focus and no augmentation: the formula as given. */
const plain = (f: readonly number[]) => ({
  baseFormula: f, customizedFormula: () => [...f], fociWcidBySchool: new Map<number, number>(),
  ownsWcid: () => false, intProperty: () => undefined,
});

describe('spell page text', () => {
  it('SetManaText: commas, "0" below 1, the per-target suffix only for mana_mod > 0', () => {
    expect(spellManaText(1500, 0)).toBe('Mana: 1,500');
    expect(spellManaText(0, 0)).toBe('Mana: 0');
    expect(spellManaText(20, 5)).toBe('Mana: 20 + 5 per target');
  });

  it('duration: minutes at 60 s and up, seconds below, nothing for non-enchantments', () => {
    expect(spellDurationText(1800)).toBe('Duration: 30 min.');
    expect(spellDurationText(45.9)).toBe('Duration: 45 sec.');
    expect(spellDurationText(undefined)).toBe('');
    expect(spellDurationText(-1)).toBe('');
  });

  it('DetermineSpellRange: mod × skill + constant, capped at 75 m, in yards; 0 → no line', () => {
    expect(spellRangeText(0.25, 5, 100)).toBe(`Range: ${(30 / 0.9144).toFixed(1)} yds.`);
    expect(spellRangeText(1, 0, 500)).toBe(`Range: ${(75 / 0.9144).toFixed(1)} yds.`);
    expect(spellRangeText(0, 0, 300)).toBe('');
  });

  it('schools and their casting skills', () => {
    expect(schoolName(1)).toBe('War Magic');
    expect(schoolName(5)).toBe('Void Magic');
    expect(schoolName(9)).toBe('None');
    expect(skillForSchool(2)).toBe(0x21);
  });

  it('the component list re-centres on x = 150', () => {
    expect(spellComponentListRect(1)).toEqual({ x: 134, width: 32 });
    expect(spellComponentListRect(5)).toEqual({ x: 70, width: 160 });
  });

  // DECOMP.spell-examine-appropriate-formula — SpellExamineUI::ExamineSpell @ 004b6210 lists
  // ClientMagicSystem::GetAppropriateSpellFormula @ 00567d50, not always the customized formula.
  const BASE = [1, 2, 0x31, 0x40];
  const CUSTOM = [0x40, 1, 0x31, 2];
  const listed = (formula: Parameters<typeof buildSpellExamineModel>[0]['formula']) => buildSpellExamineModel({
    spellId: 7,
    spell: { name: 'Flame Bolt I', desc: '', school: 1, icon: 0x06001234, baseMana: 15, manaMod: 0, baseRangeConstant: 5, baseRangeMod: 0.25 },
    formula,
    skillLevel: () => 0,
    component: (scid) => ({ name: `Comp ${scid}`, icon: 0x06000100 + scid }),
    carriedObject: () => 0,
  }).components.map((c) => c.scid);
  const inputs = (over: Partial<Parameters<typeof buildSpellExamineModel>[0]['formula']>) => ({
    baseFormula: BASE, customizedFormula: () => [...CUSTOM], fociWcidBySchool: new Map([[1, 15268]]),
    ownsWcid: () => false, intProperty: () => undefined, ...over,
  });

  it('lists the account-customized formula for a caster with no focus or augmentation', () => {
    expect(listed(inputs({}))).toEqual(CUSTOM);
  });

  it('lists the scarab-only formula while the school\'s focus is carried (before: the customized one)', () => {
    expect(listed(inputs({ ownsWcid: (w) => w === 15268 }))).toEqual(scarabOnlyFormula(BASE));
    expect(scarabOnlyFormula(BASE)).not.toEqual(CUSTOM);
  });

  it('lists the scarab-only formula with the school\'s Infused augmentation (War = 0x129)', () => {
    expect(listed(inputs({ intProperty: (k) => (k === 0x129 ? 1 : undefined) }))).toEqual(scarabOnlyFormula(BASE));
    // Another school's augmentation leaves War's list alone.
    expect(listed(inputs({ intProperty: (k) => (k === 0x128 ? 1 : undefined) }))).toEqual(CUSTOM);
  });

  it('builds the body (description, COMPONENTS block) and marks the uncarried components', () => {
    const model = buildSpellExamineModel({
      spellId: 7,
      spell: { name: 'Flame Bolt I', desc: 'Shoots a bolt of flame.', school: 1, icon: 0x06001234, baseMana: 15, manaMod: 0, baseRangeConstant: 5, baseRangeMod: 0.25 },
      formula: plain([1, 2, 3]),
      skillLevel: (id) => (id === 0x22 ? 100 : 0),
      component: (scid) => (scid === 3 ? { name: 'No Icon', icon: 0 } : { name: `Comp ${scid}`, icon: 0x06000100 + scid }),
      carriedObject: (scid) => (scid === 1 ? 0x80000001 : 0),
    });
    expect(model.school).toBe('School: War Magic');
    expect(model.mana).toBe('Mana: 15');
    expect(model.range).toBe(`Range: ${(30 / 0.9144).toFixed(1)} yds.`);
    expect(model.body).toEqual(['Shoots a bolt of flame.', '', 'COMPONENTS:', '     Comp 1', '     Comp 2']);
    expect(model.components.map(c => [c.scid, c.owned, c.objectId])).toEqual([[1, true, 0x80000001], [2, false, 0]]);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('spell page — the EoL spell table', () => {
  let spells: SpellTable;
  let comps: SpellComponentTable;
  beforeAll(() => {
    const db = openDat(DAT_PATHS.portal);
    spells = new SpellTable(new DatReader(db.getFileData(0x0e00000e)!));
    comps = new SpellComponentTable(new DatReader(db.getFileData(0x0e00000f)!));
  });

  it('a real enchantment fills every line and lists its components by name', () => {
    const entry = [...spells.spells.entries()].find(([, s]) => s.duration && s.duration > 0 && s.formula.length > 0 && s.desc)!;
    const [id, spell] = entry;
    const model = buildSpellExamineModel({
      spellId: id, spell, formula: plain(spell.formula),
      skillLevel: () => 200,
      component: (scid) => { const c = comps.components.get(scid); return c ? { name: c.name, icon: c.icon } : null; },
      carriedObject: () => 0,
    });
    expect(model.title).toBe(spell.name);
    expect(model.duration).toMatch(/^Duration: \d+ (min|sec)\.$/);
    expect(model.body[0]).toBe(spell.desc);
    expect(model.body).toContain('COMPONENTS:');
    expect(model.components.length).toBeGreaterThan(0);
    expect(model.components.every(c => !c.owned && c.name.length > 0)).toBe(true);
  });
});
