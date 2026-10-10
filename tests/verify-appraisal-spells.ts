/**
 * Item appraisal intrinsic spells + active enchantments (FAITHFUL.297).
 *
 * The IdentifyResponse SpellBook section carries the item's intrinsic spells
 * (`data.spellBook`) and its active enchantments (`data.activeEnchantments`,
 * the `(ID | 0x80000000)` entries — ServerMessageHandler parses both).
 *
 * Now verifies the end-of-retail wording the shipped builder
 * `packages/renderer/src/ui/examine/ItemAppraisalText.ts` produces:
 *  - Appraisal_ShowShortMagicInfo @ 004b2c90: "Spells: a, b" — intrinsic
 *    spells only (entries with the 0x80000000 bit are skipped);
 *  - Appraisal_ShowMagicInfo @ 004b2e10: "Spell Descriptions:" with one
 *    "~ <name>: <description>" line per intrinsic spell, and a separate
 *    "Enchantments:" block for the active enchantments. Retail has no
 *    "Active Enchantments: a, b" summary line (the old invented row).
 *  - the spell names come from the DAT SpellTable 0x0E00000E through
 *    createExamineResolvers (ui/examine/examineResolvers.ts), which main.ts
 *    hands the builder.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { buildItemAppraisalText, type SpellInfo } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import { createExamineResolvers } from '../packages/renderer/src/ui/examine/examineResolvers.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');

const SPELLS: Record<number, SpellInfo> = {
  2: { name: 'Strength Self I', description: 'Increases the caster\'s Strength by 10 points.' },
  7: { name: 'Blood Drinker I', description: 'Increases a weapon\'s damage value by 2 points.' },
  8: { name: 'Defender I', description: 'Increases the wielder\'s melee defense by 3%.' },
};
const appraise = (data: Partial<IdentifyResponseData>) =>
  buildItemAppraisalText({ guid: 0x80001111, flags: 0, ...data }, { hasValueBurdenElements: true, resolvers: { spell: (id) => SPELLS[id] } });

describe('Appraisal — Spells line + spell/enchantment descriptions (FAITHFUL.297)', () => {
  it("data.spellBook renders 'Spells: <names>' joined with ', ' and one description line per spell", () => {
    const out = appraise({ spellBook: [2, 8] });
    const lines = out.text.split('\n');
    expect(lines).toContain('Spells: Strength Self I, Defender I');
    const d = lines.indexOf('Spell Descriptions:');
    expect(d).toBeGreaterThan(lines.indexOf('Spells: Strength Self I, Defender I'));
    expect(lines.slice(d + 1, d + 3)).toEqual([
      "~ Strength Self I: Increases the caster's Strength by 10 points.",
      "~ Defender I: Increases the wielder's melee defense by 3%.",
    ]);
    expect(out.text).not.toContain('Enchantments:');
  });

  it('data.activeEnchantments are listed under "Enchantments:", never in the Spells line', () => {
    const out = appraise({ activeEnchantments: [7, 8] });
    // ShowShortMagicInfo skips 0x80000000 entries; ShowMagicInfo writes the Enchantments block.
    expect(out.text).not.toMatch(/Spells: /);
    expect(out.text).not.toContain('Active Enchantments');
    expect(out.text).toContain(
      "Enchantments:\n\n~ Blood Drinker I: Increases a weapon's damage value by 2 points.\n~ Defender I: Increases the wielder's melee defense by 3%.",
    );
  });

  it('both lists: intrinsic spells in Spells + Spell Descriptions, enchantments in their own block after', () => {
    const t = appraise({ spellBook: [2], activeEnchantments: [7] }).text;
    expect(t).toContain('Spells: Strength Self I\n');
    expect(t.indexOf('Spell Descriptions:')).toBeLessThan(t.indexOf('Enchantments:'));
  });

  it('empty lists write no spell names, descriptions or enchantments', () => {
    const t = appraise({ spellBook: [], activeEnchantments: [] }).text;
    expect(t).not.toContain('Spells:');
    expect(t).not.toContain('Spell Descriptions:');
    expect(t).not.toContain('Enchantments:');
  });

  it('an unsuccessful appraisal hides the names: both magic sections read "Spells: unknown."', () => {
    const out = buildItemAppraisalText({ guid: 1, flags: 0, spellBook: [2] }, { hasValueBurdenElements: true, appraisalSuccess: false, resolvers: { spell: (id) => SPELLS[id] } });
    expect(out.text.match(/Spells: unknown\./g)).toHaveLength(2);
    expect(out.text).not.toContain('Strength Self I');
  });
});

describe('createExamineResolvers — spell names/descriptions come from the SpellTable entry', () => {
  it('maps a SpellTable {name, desc} entry to {name, description}; unknown ids resolve to null', () => {
    const r = createExamineResolvers({
      portalDb: { getFileData: () => null },
      spell: (id) => (id === 2 ? { name: 'Strength Self I', desc: 'Increases Strength.' } : null),
      skillName: () => null,
    });
    expect(r.item.spell!(2)).toEqual({ name: 'Strength Self I', description: 'Increases Strength.' });
    expect(r.item.spell!(3)).toBeNull();
  });
});

describe.skipIf(!existsSync(PORTAL_DAT))('DAT SpellTable (0x0E00000E) names the appraisal Spells line (FAITHFUL.297)', () => {
  let line = '';
  let expected = '';
  beforeAll(async () => {
    const { DatDatabase, DatReader, SpellTable } = await import('../packages/dat-parser/src/index.js');
    const portalDb = openDat(PORTAL_DAT);
    const table = new SpellTable(new DatReader(portalDb.getFileData(0x0e00000e)!));
    const r = createExamineResolvers({ portalDb, spell: (id) => table.spells.get(id) ?? null, skillName: () => null });
    const ids = [...table.spells.keys()].slice(0, 2);
    expected = `Spells: ${ids.map((id) => table.spells.get(id)!.name).join(', ')}`;
    line = buildItemAppraisalText({ guid: 1, flags: 0, spellBook: ids }, { hasValueBurdenElements: true, resolvers: r.item })
      .text.split('\n').find((l) => l.startsWith('Spells: '))!;
  }, 120_000);

  it('the Spells line carries the real DAT spell names', () => {
    expect(line).toBe(expected);
    expect(line).not.toMatch(/Spells: ,|Spell #/);
  });
});
