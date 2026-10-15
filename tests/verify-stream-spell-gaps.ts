/**
 * The readiness block's spells line (tools/stream/spellGaps.ts). Jake 2026-10-15: "is arcanist using item magic?
 * armor doesnt seem buffed": Claude Arcanist trained Item Enchantment (166) and knew no Item Enchantment spell.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.js';
import { spellLevelFromPower } from '../packages/shared/src/magic/SpellFormula.ts';
import { readinessBrief } from '../tools/stream/prompt.ts';
import { type KnownSpell, type TableSpell, STAPLES, SCHOOLS, learnableLevel, magicSchools, spellFamily, spellGaps } from '../tools/stream/spellGaps.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

/** GameUI.agentCharacterSheet's skill lines, shaped like Arcanist's on 2026-10-15. */
const SHEET = [
  'Claude Arcanist  level 26  Aluvian Male  NPK',
  'XP 4,100,000 total, 0 unassigned, 400,000 to next level; 0 skill credits',
  'Attributes: Strength 10, Endurance 40, Coordination 40, Quickness 60, Focus 100, Self 100',
  'Specialized skills: War Magic 230 (base 220) [+1: 12,345 xp], Mana Conversion 150 [+1: 3,000 xp]',
  'Trained skills: Item Enchantment 166 [+1: 1,234 xp, then 2,000], Life Magic 140 [+1: 2,222 xp], Arcane Lore 90',
].join('\n');

/** A spell the way the agent API's `spells` reports it: the school by its short name ("War", "Item"), level from power. */
const SHORT: Record<string, string> = { 'War Magic': 'War', 'Life Magic': 'Life', 'Item Enchantment': 'Item', 'Creature Enchantment': 'Creature', 'Void Magic': 'Void' };
const k = (name: string, school: string, power: number): KnownSpell => ({ name, school: SHORT[school] ?? school, level: spellLevelFromPower(power) });
const ALL_LEVELS = (base: string, school: string, maxLevel: number): KnownSpell[] =>
  [1, 50, 100, 150, 200, 250].slice(0, maxLevel).map((p, i) => k(`${base} ${['I', 'II', 'III', 'IV', 'V', 'VI'][i]}`, school, p));

/** War at level VI (skill 230 → 280 → VI), Life staples at level V (140 → 190 → IV), no Item spell. */
function arcanistSpells(): KnownSpell[] {
  return [
    ...STAPLES['War Magic'].flatMap((f) => ALL_LEVELS(f, 'War Magic', 6)),
    ...['Heal Self', 'Revitalize Self', 'Stamina to Mana Self', 'Armor Self', ...STAPLES['Life Magic'].slice(4).map((p) => `${p} Self`)].flatMap((f) => ALL_LEVELS(f, 'Life Magic', 4)),
  ];
}

describe('stream readiness: spells you could have', () => {
  it('reads each trained / specialized magic school and its effective skill from the sheet', () => {
    expect(magicSchools(SHEET)).toEqual([
      { school: 'War Magic', status: 'specialized', skill: 230 },
      { school: 'Life Magic', status: 'trained', skill: 140 },
      { school: 'Item Enchantment', status: 'trained', skill: 166 },
    ]);
    expect(magicSchools(null)).toEqual([]);
  });

  it('the scroll level a skill can learn: CanReadScroll power ≤ skill + 50, capped at VI', () => {
    expect([0, 49, 50, 100, 149, 150, 166, 199, 200, 400].map(learnableLevel)).toEqual([2, 2, 3, 4, 4, 5, 5, 5, 6, 6]);
  });

  it('family names drop Aura of, Self / Other and the level', () => {
    expect(['Aura of Blood Drinker Self III', 'Impenetrability IV', 'Heal Self I', 'Blade Protection Other VI', 'Impenetrability Incantation', 'Flame Bolt I'].map(spellFamily))
      .toEqual(['Blood Drinker', 'Impenetrability', 'Heal', 'Blade Protection', 'Impenetrability', 'Flame Bolt']);
  });

  it('Arcanist: Item Enchantment trained with no Item spells gives the buy-and-read line; complete War gives nothing', () => {
    const lines = spellGaps(SHEET, arcanistSpells(), null);
    expect(lines).toEqual([
      '- spells: Item Enchantment trained (166) but no Item Enchantment spells known: buy and read scrolls at a mage shop (Impenetrability, the Banes, Blood Drinker, Swift Killer…; you can learn up to level V)',
    ]);
    expect(lines.join('\n')).not.toMatch(/War Magic|Life Magic/);
  });

  it('a school with some spells: missing staples and ones below the learnable level', () => {
    const known = [
      ...arcanistSpells().filter((s) => !/^(?:Armor|Heal) /.test(s.name)),
      ...ALL_LEVELS('Heal Self', 'Life Magic', 2),
    ];
    const sheet = SHEET.replace('Life Magic 140', 'Life Magic 160');
    expect(spellGaps(sheet, known, null).filter((l) => l.includes('Life Magic'))).toEqual([
      `- spells: Life Magic trained (160): ${known.filter((s) => s.school === 'Life').length} Life Magic spells known; none of Armor; below your level: Heal (II), Revitalize (IV), Stamina to Mana (IV), Blade Protection (IV)…; you can learn up to level V from scrolls at a mage shop`,
    ]);
  });

  it('in the readiness block, after the credits; no line without the spell list', () => {
    const sheet = `${SHEET.split('\n').slice(0, 2).join('\n')}\nNext skill credits: level 29 (+1)\n${SHEET.split('\n').slice(2).join('\n')}`;
    expect(readinessBrief({ items: null, sheet, session: null, spells: arcanistSpells(), table: null })!.split('\n').slice(1)).toEqual([
      '- unspent: 0 XP',
      '- skill credits: 0 now; next at level 29 (+1)',
      '- spells: Item Enchantment trained (166) but no Item Enchantment spells known: buy and read scrolls at a mage shop (Impenetrability, the Banes, Blood Drinker, Swift Killer…; you can learn up to level V)',
    ]);
    expect(readinessBrief({ items: null, sheet, session: null })).not.toMatch(/spells:/);
  });

  it('with a spell table: only the era\'s families, by the era\'s names', () => {
    const table: TableSpell[] = [
      { name: 'Impenetrability I', school: 3, power: 1 },
      { name: 'Aura of Blood Drinker Self I', school: 3, power: 1 },
      { name: 'Aura of Blood Drinker Other I', school: 3, power: 1 },
      { name: 'Blade Bane I', school: 3, power: 1 },
    ];
    expect(spellGaps('Trained skills: Item Enchantment 100', [], table)).toEqual([
      '- spells: Item Enchantment trained (100) but no Item Enchantment spells known: buy and read scrolls at a mage shop (Impenetrability, Blade Bane, Aura of Blood Drinker; you can learn up to level IV)',
    ]);
    expect(spellGaps('Trained skills: Item Enchantment 100', [k('Impenetrability IV', 'Item Enchantment', 150), k('Blade Bane IV', 'Item Enchantment', 150), k('Aura of Blood Drinker Self IV', 'Item Enchantment', 150)], table)).toEqual([]);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('stream readiness: the staples are the DAT spell table\'s', () => {
  let table: TableSpell[];
  beforeAll(() => {
    const st = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!));
    table = [...st.spells.values()].map((s) => ({ name: s.name, school: s.school, power: s.power }));
  });
  it('every staple family has a level I spell in its school, at levels I–VI', () => {
    for (const s of SCHOOLS) {
      for (const f of STAPLES[s.name]) {
        const rows = table.filter((t) => t.school === s.id && t.power < 300 && spellFamily(t.name) === f);
        expect([s.name, f, rows.some((t) => t.power < 50)]).toEqual([s.name, f, true]);
      }
    }
  });
  it('Arcanist\'s line with the end-of-retail table names the auras', () => {
    expect(spellGaps('Trained skills: Item Enchantment 166', [], table)).toEqual([
      '- spells: Item Enchantment trained (166) but no Item Enchantment spells known: buy and read scrolls at a mage shop (Impenetrability, the Banes, Aura of Blood Drinker, Aura of Swift Killer…; you can learn up to level V)',
    ]);
  });

  it('reads the agent API\'s short school names, as the live `spells` reply gives them (a 2026-10-15 stream bug: every school read as empty)', () => {
    // Records shaped exactly like the live reply (main.ts schoolName), not the sheet's skill names.
    const live = [
      { id: 64, name: 'Shock Wave I', school: 'War', level: 1 },
      { id: 1024, name: 'Bludgeoning Protection Other I', school: 'Life', level: 1 },
      { id: 2, name: 'Strength Self I', school: 'Creature', level: 1 },
      { id: 1, name: 'Impenetrability III', school: 'Item', level: 3 },
    ];
    const lines = spellGaps('Trained skills: War Magic 100, Life Magic 100, Creature Enchantment 100, Item Enchantment 100', live, null);
    expect(lines.some((l) => l.includes('no War Magic spells known'))).toBe(false);
    expect(lines.some((l) => l.includes('no Item Enchantment spells known'))).toBe(false);
    expect(lines.find((l) => l.includes('Item Enchantment'))).toContain('1 Item Enchantment spell known');
  });
});
