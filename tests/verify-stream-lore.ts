import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BANE, DEFENSE_SCHOOL, PROTECTION, bestWarElements, castChance, castsAtYou, damageTaken, defenseFor, escapeSqlLike, formatLore, loreDetailSql, loreNameSql, maxHealth, parseLoreRows, pickLoreNames,
} from '../tools/stream/lore.ts';
import { worldQueryRefusal } from '../tools/stream/world-query.ts';
import { parseStreamConfig } from '../tools/stream/config.ts';
import { playerToolNames, systemPrompt } from '../tools/stream/prompt.ts';
import { parseStreamJsonLine } from '../tools/stream/feed.ts';
import { TOOLS } from '../tools/ac-agent/tools.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { MagicSchool, SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.js';

// Jake (2026-10-14), watching the stream: "its still using fire what is going on". Claude Arcanist fought Olthoi with
// Flame Bolt; Olthoi take 75% fire but 100% pierce/bludgeon. `./world-query lore "<monster>"` is the players' wiki.

const tsv = (rows: (string | number)[][]) => rows.map((r) => r.join('\t')).join('\n');

// The local ACE world DB's rows for two Olthoi Gardener versions (ResistFire 0.75 … ResistAcid 0.25; types 64–70)
// plus a made-up caster with a wielded bow.
const GARDENER_ROWS = tsv([
  ['n', 11479, 'olthoigardener-xp', 'Olthoi Gardener'],
  ['n', 25746, 'olthoigardener', 'Olthoi Gardener'],
  ['i', 11479, 25, 30], ['i', 11479, 146, 5000],
  ['i', 25746, 25, 26], ['i', 25746, 146, 2555],
  ...[11479, 25746].flatMap((id) => [[64, 0.75], [65, 1], [66, 1], [67, 0.75], [68, 0.75], [69, 0.25], [70, 0.4]].map(([t, v]) => ['f', id, t, v])),
  ['a', 11479, 2, 130], ['v', 11479, 1, 50],
  ['a', 25746, 2, 120], ['v', 25746, 1, 50],
  ['b', 11479, 4, 15, 0.5], ['b', 11479, 2, 15, 0.75], ['b', 11479, 32, 15, 0.5],
  ['b', 25746, 4, 15, 0.5], ['b', 25746, 2, 15, 0.75], ['b', 25746, 32, 15, 0.5],
  ['p', 11479, 61, 0], ['p', 11479, 3, 0],
]);

// The DAT SpellTable bitfields world-query adds (0x4 Beneficial): Flame Bolt II 0x3, Heal Self II 0xc, Vulnerability Other II 0x13.
const SHAMAN_FLAGS = new Map([[81, 0x3], [1157, 0xc], [230, 0x13]]);
const withFlags = (cs: ReturnType<typeof parseLoreRows>, flags: Map<number, number>) => {
  for (const c of cs) for (const sp of c.spells) if (sp.id !== undefined && flags.has(sp.id)) sp.flags = flags.get(sp.id);
  return cs;
};

// A pure war caster: Frost Bolt and Lightning Bolt (no body-part damage, no weapons).
const BOLTER_ROWS = tsv([
  ['n', 901, 'testbolter', 'Test Bolter'], ['i', 901, 25, 30],
  ['s', 901, 2.2, 'Frost Bolt III', 70, 8, 40, 20, 'NULL', 'NULL', 'NULL'],
  ['s', 901, 2.2, 'Lightning Bolt III', 76, 64, 40, 20, 'NULL', 'NULL', 'NULL'],
]);

const SHAMAN_ROWS = tsv([
  ['n', 900, 'testshaman', 'Test Shaman'],
  ['i', 900, 25, 15], ['i', 900, 146, 2000],
  ['f', 900, 67, 1.42], ['f', 900, 69, 0.6],
  ['v', 900, 1, 40],
  // spell rows: probability, name, id, e_Type, base_Intensity, variance, damage_Type, boost, boost_Variance (as the DB has them)
  ['s', 900, 2.07, 'Flame Bolt II', 81, 16, 26, 26, 'NULL', 'NULL', 'NULL'],
  ['s', 900, 2.08, 'Heal Self II', 1157, 'NULL', 'NULL', 'NULL', 128, 8, 4],
  ['s', 900, 2.05, 'Vulnerability Other II', 230, 'NULL', 'NULL', 'NULL', 'NULL', 'NULL', 'NULL'],
  ['s', 900, 2, 'Odd Base Spell'],
  // wielded rows: WeenieType, name, Damage (int 44), DamageType (int 45), DamageVariance (float 22)
  ['w', 900, 3, 'Shortbow', 'NULL', 'NULL', 'NULL'], ['w', 900, 6, 'Spear', 10, 2, 0.5],
  ['p', 900, 2, 0],
]);

describe('lore: name matching', () => {
  const rows = [
    { wcid: 1, name: 'Olthoi Gardener' }, { wcid: 2, name: 'Olthoi Gardener' }, { wcid: 3, name: 'Olthoi Harvester' },
    { wcid: 4, name: 'Olthoi Gardener Elite' }, { wcid: 5, name: 'Drudge Skulker' }, { wcid: 6, name: 'Olthoi Nymph' },
    { wcid: 7, name: 'Olthoi Noble' },
  ];
  it('an exact name (any case) wins, its versions all kept, and the longer names that start with it are mentioned', () => {
    const p = pickLoreNames('olthoi gardener', rows);
    expect(p.names).toEqual(['Olthoi Gardener']);
    expect(p.wcids).toEqual([1, 2]);
    expect(p.note).toBe('Also: Olthoi Gardener Elite.');
  });
  it('a prefix picks the name it starts and says it was not exact', () => {
    const p = pickLoreNames('Drudge Sk', rows);
    expect(p.names).toEqual(['Drudge Skulker']);
    expect(p.note).toMatch(/nothing called exactly "Drudge Sk"; showing Drudge Skulker/);
  });
  it('several names: up to three are shown with a line saying so; more are listed to choose from', () => {
    const three = pickLoreNames('Olthoi N', rows);
    expect(three.names).toEqual(['Olthoi Noble', 'Olthoi Nymph']);
    expect(three.note).toBe('2 creatures starting with "Olthoi N": Olthoi Noble, Olthoi Nymph.');
    const many = pickLoreNames('olthoi', rows);
    expect(many.wcids).toEqual([]);
    expect(many.note).toMatch(/^5 creatures starting with "olthoi": Olthoi Gardener, Olthoi Gardener Elite, Olthoi Harvester, Olthoi Noble, Olthoi Nymph\. Give more of the name\.$/);
  });
  it('falls back to a substring; nothing and empty say what to do', () => {
    expect(pickLoreNames('skulker', rows).names).toEqual(['Drudge Skulker']);
    expect(pickLoreNames('banderling', rows).note).toMatch(/no creature called "banderling"/);
    expect(pickLoreNames('  ', rows).note).toMatch(/give a monster name/);
  });
  it('the SQL it runs is read-only by the world-query rules, the name escaped, the wcids numbers only', () => {
    const name = loreNameSql("Ma'ar 100%_x");
    expect(name).toContain("LIKE LOWER('%Ma''ar 100\\%\\_x%')");
    expect(escapeSqlLike('a\\b')).toBe('a\\\\\\\\b');
    for (const s of [name, ...loreDetailSql([11479, 25746])]) expect(worldQueryRefusal(s)).toBeNull();
    expect(loreDetailSql([Number.NaN, -1])[0]).toContain('IN (0)');
  });
});

describe('lore: weaknesses and the best war element', () => {
  it('damage taken best-first, absent resistances count as 100%', () => {
    expect(damageTaken({ fire: 0.75, cold: 0.75, acid: 0.25, electric: 0.4, slash: 0.75, pierce: 1, bludgeon: 1 }).map((x) => `${x.pct} ${x.element}`))
      .toEqual(['100 pierce', '100 bludgeon', '75 slash', '75 fire', '75 cold', '40 electric', '25 acid']);
    expect(damageTaken({ fire: 1.42 })[0]).toEqual({ element: 'fire', pct: 142 });
    expect(damageTaken({}).every((x) => x.pct === 100)).toBe(true);
  });
  it('names every element tied for the top and the bottom; one even spread has no "least"', () => {
    const olthoi = bestWarElements({ fire: 0.75, cold: 0.75, acid: 0.25, electric: 0.4, slash: 0.75, pierce: 1, bludgeon: 1 });
    expect(olthoi).toEqual({ best: ['pierce', 'bludgeon'], bestPct: 100, worst: ['acid'], worstPct: 25 });
    expect(bestWarElements({}).worst).toEqual([]);
  });
  it('cast chance and max health as ACE computes them', () => {
    expect(castChance(2.07)).toBeCloseTo(0.07);
    expect(castChance(2)).toBeCloseTo(0.02);
    const [c] = parseLoreRows(tsv([['n', 1, 'x', 'X'], ['v', 1, 1, 50], ['a', 1, 2, 121]]));
    expect(maxHealth(c)).toBe(111); // 50 + round(121 / 2)
  });
});

describe('lore: rows → the wiki block', () => {
  it('Olthoi Gardener: one line per version, the shared weaknesses once, Force Bolt / Shock Wave best and Acid Stream worst', () => {
    const pick = pickLoreNames('Olthoi Gardener', [{ wcid: 11479, name: 'Olthoi Gardener' }, { wcid: 25746, name: 'Olthoi Gardener' }]);
    expect(formatLore(pick, parseLoreRows(GARDENER_ROWS))).toBe([
      'Olthoi Gardener: 2 versions',
      'Olthoi Gardener: level 30, 5,000 XP per kill, 115 health  [wcid 11479 64 spawn points]',
      'Olthoi Gardener: level 26, 2,555 XP per kill, 110 health  [wcid 25746 no spawns found]',
      '  takes 100% pierce, 100% bludgeon, 75% slash, 75% fire, 75% cold, 40% electric, 25% acid',
      '  war magic: Force Bolt / Shock Wave (100%) hurts most; Acid Stream (25%) least',
      '  attacks: melee (pierce, bludgeon, acid); casts nothing',
      '  defend with (share of its damage each covers): Armor 100% (Life), Invulnerability 100% (Creature), Bludgeoning Protection 35%, Acid Protection 35%, Piercing Protection 29% (Life)',
      '  Item Enchantment on your armor: Bludgeon Bane, Acid Bane, Piercing Bane, Impenetrability',
    ].join('\n'));
  });
  it('a caster: its spells by cast chance, a wielded bow marked MISSILE, its weapon', () => {
    const pick = pickLoreNames('test shaman', [{ wcid: 900, name: 'Test Shaman' }]);
    const out = formatLore(pick, withFlags(parseLoreRows(SHAMAN_ROWS), SHAMAN_FLAGS));
    // Per attack: a spell 20% of the time (8 + 7 + 5 + 2 %), else the Spear (10 × (1 − 0.5/2) = 7.5 pierce);
    // Flame Bolt II at you 7% × (26 + 26/2) fire; Vulnerability Other is a debuff; Heal Self is beneficial.
    expect(out).toBe([
      'Test Shaman: level 15, 2,000 XP per kill, 40 health  [wcid 900 2 spawn points]',
      '  takes 142% fire, 100% slash, 100% pierce, 100% bludgeon, 100% cold, 100% electric, 60% acid',
      '  war magic: Flame Bolt (142%) hurts most; Acid Stream (60%) least',
      '  attacks: melee (pierce) with Spear; MISSILE: Shortbow (it shoots from range); CASTS (chance per attack): Heal Self II 8%, Flame Bolt II 7%, Vulnerability Other II 5%, Odd Base Spell 2%',
      '  defend with (share of its damage each covers): Piercing Protection 69%, Armor 69% (Life), Invulnerability 69% (Creature), Fire Protection 31% (Life), Magic Resistance 31% (Creature); Magic Resistance also resists its Vulnerability Other II',
      '  Item Enchantment on your armor: Piercing Bane, Flame Bane, Impenetrability',
    ].join('\n'));
  });
  it('a war caster: its bolts\' elements and Magic Resistance, no Armor (spells ignore it)', () => {
    const [c] = parseLoreRows(BOLTER_ROWS);
    const d = defenseFor(c);
    expect(d.buffs).toEqual([
      { name: 'Magic Resistance', school: 'Creature', pct: 100 },
      { name: 'Cold Protection', school: 'Life', pct: 50 },
      { name: 'Lightning Protection', school: 'Life', pct: 50 },
    ]);
    expect(d.item).toEqual(['Frost Bane', 'Lightning Bane']);
    expect(formatLore(pickLoreNames('test bolter', [{ wcid: 901, name: 'Test Bolter' }]), [c]).split('\n')).toContain(
      '  defend with (share of its damage each covers): Magic Resistance 100% (Creature), Cold Protection 50%, Lightning Protection 50% (Life)');
  });
  it('a spell is cast at you unless the DAT marks it Beneficial; without the DAT, by its kind and name', () => {
    expect(castsAtYou({ name: 'Heal Other II', probability: 2.1, flags: 0x6 })).toBe(false);
    expect(castsAtYou({ name: 'Harm Other II', probability: 2.1, flags: 0x13 })).toBe(true);
    expect(castsAtYou({ name: 'Frost Bolt II', probability: 2.1, element: 8, damage: 30 })).toBe(true);
    expect(castsAtYou({ name: 'Vulnerability Other II', probability: 2.1 })).toBe(true);
    expect(castsAtYou({ name: 'Armor Self II', probability: 2.1 })).toBe(false);
  });
  it('versions that differ in attacks keep their own attack and defense lines, the shared lines first', () => {
    const rows = tsv([['n', 1, 'a', 'Skulk'], ['n', 2, 'b', 'Skulk'], ['i', 1, 25, 8], ['i', 2, 25, 4], ['b', 1, 4, 5, 0], ['w', 2, 4, 'Throwing Dart', 6, 2, 0]]);
    const out = formatLore(pickLoreNames('skulk', [{ wcid: 1, name: 'Skulk' }, { wcid: 2, name: 'Skulk' }]), parseLoreRows(rows)).split('\n');
    expect(out.slice(0, 3)).toEqual(['Skulk: 2 versions', '  takes 100% slash, 100% pierce, 100% bludgeon, 100% fire, 100% cold, 100% acid, 100% electric', '  war magic: every element does the same (100%)']);
    expect(out[3]).toMatch(/^Skulk: level 4, XP per kill not set/);
    expect(out[4]).toBe('  attacks: MISSILE: Throwing Dart (it shoots from range); casts nothing');
    expect(out[5]).toBe('  defend with (share of its damage each covers): Piercing Protection 100%, Armor 100% (Life), Impregnability 100% (Creature)');
    expect(out[6]).toBe('  Item Enchantment on your armor: Piercing Bane, Impenetrability');
    expect(out[7]).toMatch(/^Skulk: level 8/);
    expect(out[8]).toBe('  attacks: melee (bludgeon); casts nothing');
    expect(out[9]).toMatch(/Bludgeoning Protection 100%, Armor 100% \(Life\), Invulnerability 100% \(Creature\)$/);
  });
});

describe('lore: what the player is told and what viewers see', () => {
  const cfg = parseStreamConfig(JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'stream', 'cast.json'), 'utf8')));
  const sys = systemPrompt(readFileSync(join(__dirname, '..', 'tools', 'stream', 'brief.md'), 'utf8'), cfg.characters[0], 'Claude Bulwark', playerToolNames(TOOLS.map((t) => t.name)));
  it('the tactics rule says to look a new kind of monster up first, like a wiki; the old float-types clause is gone', () => {
    const tactics = sys.slice(sys.indexOf('**Tactics.**'), sys.indexOf('6. **Progression.**'));
    expect(tactics).toContain('Before fighting a kind of monster you haven\'t looked up: `./world-query lore "<name>"` (level, XP per kill, the damage types it takes least and most, its spells, and which protections to put up), like checking a wiki.');
    expect(tactics.indexOf('./world-query lore')).toBeLessThan(tactics.indexOf('Pull one at a time'));
    expect(sys).not.toMatch(/types 64–70|weenie_properties_float/);
  });
  it('the player is told how Impenetrability and the Banes land on someone else (ACE: only their shield), so it isn\'t reported as a bug', () => {
    expect(sys).toContain('Impenetrability and the Banes cast on yourself cover every piece of armor you wear, but cast on anyone else they land only on that person\'s shield (retail rules, not a bug)');
  });
  it('the feed says "looks up <name>" for a lookup, and still "checks the world database" for a query', () => {
    const call = (command: string) => parseStreamJsonLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }), 'mage').drafts[0];
    expect(call('./world-query lore "Olthoi Gardener"')).toMatchObject({ tool: 'bash', summary: 'looks up Olthoi Gardener' });
    expect(call('npx tsx tools/stream/world-query.ts lore Drudge Skulker')).toMatchObject({ summary: 'looks up Drudge Skulker' });
    expect(call('./world-query "SELECT 1"')).toMatchObject({ summary: 'checks the world database' });
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('lore: the protection names are the spell table\'s', () => {
  let byName: Map<string, number>;
  beforeAll(() => {
    const st = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!));
    byName = new Map([...st.spells.values()].map((sp) => [sp.name, sp.school]));
  });
  const SCHOOL = { Life: MagicSchool.LifeMagic, Creature: MagicSchool.CreatureEnchantment } as const;
  it('every buff exists as "<name> Self I" and "<name> Other I" in its school', () => {
    for (const [name, school] of Object.entries(DEFENSE_SCHOOL)) {
      for (const v of ['Self', 'Other']) expect([`${name} ${v} I`, byName.get(`${name} ${v} I`)]).toEqual([`${name} ${v} I`, SCHOOL[school as 'Life' | 'Creature']]);
    }
    expect(Object.keys(DEFENSE_SCHOOL)).toEqual(expect.arrayContaining([...Object.values(PROTECTION), 'Armor', 'Invulnerability', 'Impregnability', 'Magic Resistance']));
  });
  it('every bane and Impenetrability exists as "<name> I" in Item Enchantment', () => {
    for (const name of [...Object.values(BANE), 'Impenetrability']) expect([name, byName.get(`${name} I`)]).toEqual([name, MagicSchool.ItemEnchantment]);
  });
});
