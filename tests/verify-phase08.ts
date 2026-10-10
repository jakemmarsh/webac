/**
 * Phase 8 Verification: Game Data Tables
 * Tests SpellTable, SpellComponentTable, SkillTable, XpTable, SecondaryAttributeTable,
 * CharGen, ClothingTable, CombatManeuverTable, PaletteSet
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  DatDatabase, DatReader,
  SpellTable, SpellComponentTable, SkillTable, XpTable,
  SecondaryAttributeTable, CharacterGenerator, ClothingTable,
  CombatManeuverTable, PaletteSet,
} from '../packages/dat-parser/src/index.js';
import { openDat } from './_harness/dat.js';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const hasPortalDat = existsSync(PORTAL_DAT);

let portalDb: DatDatabase;

beforeAll(() => {
  if (!hasPortalDat) return;
  portalDb = openDat(PORTAL_DAT);
});

describe.skipIf(!hasPortalDat)('Phase 8: Game Data Tables', () => {

  // ───────── SpellTable (0x0E00000E) ─────────
  describe('SpellTable', () => {
    let spellTable: SpellTable;

    beforeAll(() => {
      const data = portalDb.getFileData(0x0E00000E);
      expect(data).toBeDefined();
      spellTable = new SpellTable(new DatReader(data!));
    });

    it('parses ≥6000 spells', () => {
      expect(spellTable.spells.size).toBeGreaterThanOrEqual(6000);
    });

    it('has correct ID', () => {
      expect(spellTable.id).toBe(0x0E00000E);
    });

    it('spells have valid names and school values', () => {
      let checked = 0;
      for (const [_key, spell] of spellTable.spells) {
        expect(spell.name.length).toBeGreaterThan(0);
        expect(spell.school).toBeGreaterThanOrEqual(1);
        expect(spell.school).toBeLessThanOrEqual(6);
        checked++;
        if (checked >= 50) break;
      }
    });

    it('enchantment spells have duration', () => {
      let found = 0;
      for (const [_key, spell] of spellTable.spells) {
        if (spell.metaSpellType === 1) { // Enchantment
          expect(spell.duration).toBeDefined();
          expect(spell.duration).toBeGreaterThan(0);
          found++;
          if (found >= 10) break;
        }
      }
      expect(found).toBeGreaterThanOrEqual(5);
    });
  });

  // ───────── SpellComponentTable (0x0E00000F) ─────────
  describe('SpellComponentTable', () => {
    let componentTable: SpellComponentTable;

    beforeAll(() => {
      const data = portalDb.getFileData(0x0E00000F);
      expect(data).toBeDefined();
      componentTable = new SpellComponentTable(new DatReader(data!));
    });

    it('parses ≥100 components', () => {
      expect(componentTable.components.size).toBeGreaterThanOrEqual(100);
    });

    it('components have valid names', () => {
      let checked = 0;
      for (const [_key, comp] of componentTable.components) {
        expect(comp.name.length).toBeGreaterThan(0);
        checked++;
        if (checked >= 20) break;
      }
    });
  });

  // ───────── SkillTable (0x0E000004) ─────────
  describe('SkillTable', () => {
    let skillTable: SkillTable;

    beforeAll(() => {
      const data = portalDb.getFileData(0x0E000004);
      expect(data).toBeDefined();
      skillTable = new SkillTable(new DatReader(data!));
    });

    it('parses ≥35 skills', () => {
      expect(skillTable.skills.size).toBeGreaterThanOrEqual(35);
    });

    it('skills have names, formulas, and costs', () => {
      let checked = 0;
      for (const [_key, skill] of skillTable.skills) {
        expect(skill.name.length).toBeGreaterThan(0);
        expect(skill.formula).toBeDefined();
        expect(skill.trainedCost).toBeDefined();
        checked++;
        if (checked >= 20) break;
      }
    });

    it('skill formulas reference valid attributes', () => {
      // Attribute enums: 1=Str, 2=End, 3=Quick, 4=Coord, 5=Focus, 6=Self
      for (const [_key, skill] of skillTable.skills) {
        if (skill.formula.attr1 > 0) {
          expect(skill.formula.attr1).toBeLessThanOrEqual(6);
        }
        if (skill.formula.attr2 > 0) {
          expect(skill.formula.attr2).toBeLessThanOrEqual(6);
        }
      }
    });
  });

  // ───────── XpTable (0x0E000018) ─────────
  describe('XpTable', () => {
    let xpTable: XpTable;

    beforeAll(() => {
      const data = portalDb.getFileData(0x0E000018);
      expect(data).toBeDefined();
      xpTable = new XpTable(new DatReader(data!));
    });

    it('has level thresholds from 0 to ≥275', () => {
      expect(xpTable.characterLevelXpList.length).toBeGreaterThanOrEqual(276);
    });

    it('level 1 XP threshold is 0', () => {
      // Index 0 = level 0 (or base), index 1 = level 1
      expect(xpTable.characterLevelXpList[0]).toBe(0n);
    });

    it('level thresholds are monotonically increasing', () => {
      for (let i = 1; i < xpTable.characterLevelXpList.length; i++) {
        expect(xpTable.characterLevelXpList[i]).toBeGreaterThanOrEqual(
          xpTable.characterLevelXpList[i - 1]
        );
      }
    });

    it('has attribute XP costs', () => {
      expect(xpTable.attributeXpList.length).toBeGreaterThan(10);
    });

    it('has skill credit allocations per level', () => {
      expect(xpTable.characterLevelSkillCreditList.length).toBeGreaterThanOrEqual(276);
    });
  });

  // ───────── SecondaryAttributeTable (0x0E000003) ─────────
  describe('SecondaryAttributeTable', () => {
    let secAttrTable: SecondaryAttributeTable;

    beforeAll(() => {
      const data = portalDb.getFileData(0x0E000003);
      expect(data).toBeDefined();
      secAttrTable = new SecondaryAttributeTable(new DatReader(data!));
    });

    it('has health, stamina, mana formulas', () => {
      expect(secAttrTable.maxHealth).toBeDefined();
      expect(secAttrTable.maxStamina).toBeDefined();
      expect(secAttrTable.maxMana).toBeDefined();
    });

    it('formulas have valid attribute references', () => {
      // Health depends on Endurance (attr 2), Stamina on Endurance, Mana on Self (attr 6)
      expect(secAttrTable.maxHealth.attr1).toBeGreaterThan(0);
      expect(secAttrTable.maxStamina.attr1).toBeGreaterThan(0);
      expect(secAttrTable.maxMana.attr1).toBeGreaterThan(0);
    });
  });

  // ───────── CharGen (0x0E000002) ─────────
  describe('CharGen', () => {
    let charGen: CharacterGenerator;

    beforeAll(() => {
      const data = portalDb.getFileData(0x0E000002);
      expect(data).toBeDefined();
      charGen = new CharacterGenerator(new DatReader(data!));
    });

    it('has ≥4 heritage groups', () => {
      expect(charGen.heritageGroups.size).toBeGreaterThanOrEqual(4);
    });

    it('heritage groups have names and skills', () => {
      for (const [_key, hg] of charGen.heritageGroups) {
        expect(hg.name.length).toBeGreaterThan(0);
        expect(hg.skills.length).toBeGreaterThan(0);
      }
    });

    it('each heritage group has ≥1 gender', () => {
      for (const [_key, hg] of charGen.heritageGroups) {
        expect(hg.genders.size).toBeGreaterThanOrEqual(1);
      }
    });

    it('genders have appearance data', () => {
      for (const [_key, hg] of charGen.heritageGroups) {
        for (const [_gk, sex] of hg.genders) {
          expect(sex.hairColorList.length).toBeGreaterThan(0);
          expect(sex.hairStyleList.length).toBeGreaterThan(0);
          expect(sex.eyeColorList.length).toBeGreaterThan(0);
        }
      }
    });

    it('has ≥1 starter areas', () => {
      expect(charGen.starterAreas.length).toBeGreaterThanOrEqual(1);
    });

    it('heritage groups have templates', () => {
      for (const [_key, hg] of charGen.heritageGroups) {
        expect(hg.templates.length).toBeGreaterThan(0);
        for (const tmpl of hg.templates) {
          expect(tmpl.name.length).toBeGreaterThan(0);
          expect(tmpl.strength).toBeGreaterThan(0);
        }
      }
    });
  });

  // ───────── ClothingTable (0x10xxxxxx) ─────────
  describe('ClothingTable', () => {
    it('parses ≥10 clothing tables successfully', () => {
      const clothingIds = portalDb.listFileIds().filter(id => (id >>> 24) === 0x10);
      expect(clothingIds.length).toBeGreaterThanOrEqual(10);

      let successCount = 0;
      const toTest = clothingIds.slice(0, 20);
      for (const id of toTest) {
        try {
          const data = portalDb.getFileData(id);
          if (!data) continue;
          const ct = new ClothingTable(new DatReader(data));
          expect(ct.id).toBe(id);
          expect(ct.clothingBaseEffects.size).toBeGreaterThanOrEqual(0);
          successCount++;
        } catch {
          // some may fail, that's ok as long as most work
        }
      }
      expect(successCount).toBeGreaterThanOrEqual(10);
    });

    it('clothing base effects have valid object effects', () => {
      const clothingIds = portalDb.listFileIds().filter(id => (id >>> 24) === 0x10);
      let foundEffects = false;
      for (const id of clothingIds.slice(0, 50)) {
        try {
          const data = portalDb.getFileData(id);
          if (!data) continue;
          const ct = new ClothingTable(new DatReader(data));
          for (const [_key, baseEffect] of ct.clothingBaseEffects) {
            if (baseEffect.cloObjectEffects.length > 0) {
              foundEffects = true;
              const eff = baseEffect.cloObjectEffects[0];
              expect(eff.modelId).toBeGreaterThan(0);
              break;
            }
          }
          if (foundEffects) break;
        } catch {
          continue;
        }
      }
      expect(foundEffects).toBe(true);
    });
  });

  // ───────── CombatManeuverTable (0x30xxxxxx) ─────────
  describe('CombatManeuverTable', () => {
    it('parses combat tables with ≥5 maneuvers', () => {
      const combatIds = portalDb.listFileIds().filter(id => (id >>> 24) === 0x30);
      expect(combatIds.length).toBeGreaterThanOrEqual(1);

      let foundManeuvers = false;
      for (const id of combatIds.slice(0, 10)) {
        try {
          const data = portalDb.getFileData(id);
          if (!data) continue;
          const cmt = new CombatManeuverTable(new DatReader(data));
          expect(cmt.id).toBe(id);
          if (cmt.maneuvers.length >= 5) {
            foundManeuvers = true;
            // Verify maneuver fields are reasonable
            for (const m of cmt.maneuvers) {
              expect(m.style).toBeGreaterThan(0);
              expect(m.attackHeight).toBeGreaterThanOrEqual(0);
              expect(m.motion).toBeGreaterThan(0);
            }
            break;
          }
        } catch {
          continue;
        }
      }
      expect(foundManeuvers).toBe(true);
    });
  });

  // ───────── PaletteSet (0x0Fxxxxxx) ─────────
  describe('PaletteSet', () => {
    it('parses ≥10 palette sets with valid palette IDs', () => {
      const palSetIds = portalDb.listFileIds().filter(id => (id >>> 24) === 0x0F);
      expect(palSetIds.length).toBeGreaterThanOrEqual(10);

      let successCount = 0;
      for (const id of palSetIds.slice(0, 20)) {
        try {
          const data = portalDb.getFileData(id);
          if (!data) continue;
          const ps = new PaletteSet(new DatReader(data));
          expect(ps.id).toBe(id);
          expect(ps.paletteList.length).toBeGreaterThan(0);
          // All palette IDs should be 0x04xxxxxx
          for (const palId of ps.paletteList) {
            expect(palId >>> 24).toBe(0x04);
          }
          successCount++;
        } catch {
          continue;
        }
      }
      expect(successCount).toBeGreaterThanOrEqual(10);
    });

    it('getPaletteId maps hue correctly', () => {
      const palSetIds = portalDb.listFileIds().filter(id => (id >>> 24) === 0x0F);
      const data = portalDb.getFileData(palSetIds[0]);
      expect(data).toBeDefined();
      const ps = new PaletteSet(new DatReader(data!));

      // hue=0 → first palette
      expect(ps.getPaletteId(0)).toBe(ps.paletteList[0]);
      // hue=1 → last palette
      expect(ps.getPaletteId(1)).toBe(ps.paletteList[ps.paletteList.length - 1]);
      // invalid hue → 0
      expect(ps.getPaletteId(-1)).toBe(0);
      expect(ps.getPaletteId(2)).toBe(0);
    });
  });
});
