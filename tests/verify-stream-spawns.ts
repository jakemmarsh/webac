import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatSpawns, parseGenProfiles, parseSpawnPlaces, parseSpawnsQuery, placesText, profileShares, shareText, spawnParentSql, spawnPlaceSql, spawnSources,
  type GenProfile,
} from '../tools/stream/spawns.ts';
import { pickLoreNames } from '../tools/stream/lore.ts';
import { WORLD_QUERY_USAGE, worldQueryRefusal } from '../tools/stream/world-query.ts';
import { parseStreamConfig } from '../tools/stream/config.ts';
import { playerToolNames, systemPrompt } from '../tools/stream/prompt.ts';
import { parseStreamJsonLine } from '../tools/stream/feed.ts';
import { TOOLS } from '../tools/ac-agent/tools.ts';

// 2026-10-16: Claude Bulwark joined landblock_instance with weenie_properties_generator for the landblocks round 0xA3AD
// (36.7N 29.1E) and found nothing, though monsters spawn there: outdoor monsters come from the encounter table and
// generator chains. `./world-query spawns "<monster>"` follows all three.

const tsv = (rows: (string | number)[][]) => rows.map((r) => r.join('\t')).join('\n');

// The local ACE world DB's shapes (trimmed): Aluvian Newbie Forest Mix Generator 23174 (an encounter generator) picks
// Mite Scion 943 at cumulative 0.11 after 0.08, and the Mite Scion Camp Generator 4346 at 0.08 after 0.05; the camp
// generator makes Mite Scion always (−1). Mite Scion Generator 9000 is placed in a dungeon with its own profile spot.
const PROFILES = tsv([
  [23174, 1, 27255, 0.05, 1, 'NULL', 'NULL', 'NULL'],
  [23174, 2, 4346, 0.08, 1, 'NULL', 'NULL', 'NULL'],
  [23174, 3, 943, 0.11, 1, 'NULL', 'NULL', 'NULL'],
  [23174, 4, 10, 1, 1, 'NULL', 'NULL', 'NULL'],
  [4346, 10, 943, -1, 3, 'NULL', 'NULL', 'NULL'],
  [9000, 20, 943, 1, 2, 0x01a40100, 10, 20],
]);
const PLACES = tsv([
  ['e', 23174, 0xa3ad, 0, 7],
  ['e', 23174, 0xa3ad, 1, 3],
  ['e', 23174, 0xa3ad, 1, 3], // the same spot twice
  ['e', 23174, 0xa4ad, 8, 8],
  ['p', 9000, 0x01a40105, 50, 60],
  ['p', 943, 0xa9b4001c, 100, 100],
  ['n', 23174, 'Aluvian Newbie Forest Mix Generator'],
  ['n', 4346, 'Mite Scion Camp Generator'],
  ['n', 9000, 'Mite Scion Generator'],
  ['n', 943, 'Mite Scion'],
]);
const name = (p: ReturnType<typeof parseSpawnPlaces>) => (w: number) => p.names.get(w) ?? `wcid ${w}`;

describe('spawns: the SQL', () => {
  it('reads parents\' whole profile lists, placements, encounters and names; every statement is read-only', () => {
    const parent = spawnParentSql([943, 943, -1, NaN]);
    expect(parent).toContain('WHERE weenie_Class_Id IN (943)');
    expect(worldQueryRefusal(parent)).toBeNull();
    const places = spawnPlaceSql([943, 23174]);
    expect(places).toHaveLength(3);
    expect(places[1]).toContain('FROM encounter WHERE weenie_Class_Id IN (943,23174)');
    for (const s of places) expect(worldQueryRefusal(s)).toBeNull();
  });
});

describe('spawns: rows → sources', () => {
  it('turns an encounter into ACE\'s spot (cell_X × 24, clamped to 0.5 … 191.5) in its landblock, once per spot', () => {
    const p = parseSpawnPlaces(PLACES);
    expect(p.encounters.get(23174)).toEqual([
      { cell: 0xa3ad0001, x: 0.5, y: 168, viaGenerator: true },
      { cell: 0xa3ad0001, x: 24, y: 72, viaGenerator: true },
      { cell: 0xa4ad0001, x: 191.5, y: 191.5, viaGenerator: true },
    ]);
    expect(p.placed.get(9000)).toEqual([{ cell: 0x01a40105, x: 50, y: 60, viaGenerator: false }]);
    expect(p.names.get(4346)).toBe('Mite Scion Camp Generator');
  });

  it('shares a roll as ACE does: cumulative probabilities in id order, −1 always, a drop restarts the count', () => {
    const profs = parseGenProfiles(PROFILES).filter((p) => p.gen === 23174);
    const s = profileShares(profs);
    expect(s.get(2)).toBeCloseTo(0.03, 6);
    expect(s.get(3)).toBeCloseTo(0.03, 6);
    expect(s.get(4)).toBeCloseTo(0.89, 6);
    const always = profileShares([{ gen: 1, id: 1, wcid: 5, probability: -1, maxCreate: 1 }]);
    expect(always.get(1)).toBe('always');
    const reset: GenProfile[] = [{ gen: 1, id: 1, wcid: 5, probability: 0.5, maxCreate: 1 }, { gen: 1, id: 2, wcid: 6, probability: 0.25, maxCreate: 1 }];
    expect([...profileShares(reset).values()]).toEqual([0.5 / 0.75, 0.25 / 0.75]);
    expect([shareText(0.03), shareText(0.004), shareText(0.5), shareText('always')]).toEqual(['3%', '0.4%', '50%', 'always']);
  });

  it('follows a creature up through generator chains to where each one is placed or rolled outdoors', () => {
    const places = parseSpawnPlaces(PLACES);
    const sources = spawnSources([943], parseGenProfiles(PROFILES), places, name(places));
    expect(sources.map((s) => [s.how, s.chain.join(' > '), s.shares.map(shareText).join(' > ')])).toEqual([
      ['placed', 'Mite Scion', ''],
      ['encounter', 'Aluvian Newbie Forest Mix Generator > Mite Scion', '3%'],
      ['encounter', 'Aluvian Newbie Forest Mix Generator > Mite Scion Camp Generator > Mite Scion', '3% > always'],
      ['generator', 'Mite Scion Generator > Mite Scion', '100%'],
    ]);
    // A profile with its own obj_Cell_Id puts the creature there, not round the generator.
    expect(sources[3].places).toEqual([{ cell: 0x01a40100, x: 10, y: 20, viaGenerator: true }]);
  });

  it('merges versions of one creature (one name, several wcids) into one chain, adding their shares', () => {
    const profs = parseGenProfiles(tsv([[50, 1, 7, 0.6, 1, 'NULL', 'NULL', 'NULL'], [50, 2, 8, 1, 1, 'NULL', 'NULL', 'NULL']]));
    const places = parseSpawnPlaces(tsv([['p', 50, 0x54560246, 1, 1], ['n', 50, 'Scuttling Grievver Gen A'], ['n', 7, 'Scuttling Grievver'], ['n', 8, 'Scuttling Grievver']]));
    const sources = spawnSources([7, 8], profs, places, name(places));
    expect(sources).toHaveLength(1);
    expect(sources[0].shares.map(shareText)).toEqual(['100%']);
  });
});

describe('spawns: the answer', () => {
  const places = parseSpawnPlaces(PLACES);
  const sources = spawnSources([943], parseGenProfiles(PROFILES), places, name(places));
  const pick = pickLoreNames('Mite Scion', [{ wcid: 943, name: 'Mite Scion' }]);
  const dat = { envCellFlags: (cell: number) => (cell >>> 16 === 0x01a4 ? 0 : 0x1) };

  it('one line per source: placed, generators with their shares, outdoor encounters counted by spot and landblock', () => {
    expect(formatSpawns('Mite Scion', pick, sources, dat).split('\n')).toEqual([
      '(n%) = the share of that generator\'s rolls that pick the next step; outdoor encounters spawn when the landblock loads (none on a cell with a building).',
      'placed: Mite Scion at 42.5N, 33.7E (Holtburg)',
      'generator: Mite Scion Generator (100%) → Mite Scion, the generator at dungeon 0x01A4, cell 0x01A40100',
      'outdoor encounter: Aluvian Newbie Forest Mix Generator (3%) → Mite Scion, on 3 spots in 2 landblocks: 37.2N, 28.5E (8 N of Glenden Wood) ×2; 37.2N, 30.0E (8 SW of Holtburg)',
      'outdoor encounter: Aluvian Newbie Forest Mix Generator (3%) → Mite Scion Camp Generator (always) → Mite Scion, on 3 spots in 2 landblocks: 37.2N, 28.5E (8 N of Glenden Wood) ×2; 37.2N, 30.0E (8 SW of Holtburg)',
    ]);
  });

  it('near <coords> sorts sources and places nearest first and says how far', () => {
    const q = parseSpawnsQuery('"Mite Scion" near 37.2N, 30.0E');
    expect(q).toEqual({ name: 'Mite Scion', near: { ns: 37.2, ew: 30 } });
    expect(parseSpawnsQuery('Drudge Skulker near 12.5S 40.0W')).toEqual({ name: 'Drudge Skulker', near: { ns: -12.5, ew: -40 } });
    expect(parseSpawnsQuery('Mite Scion')).toEqual({ name: 'Mite Scion' });
    const lines = formatSpawns(q.name, pick, sources, dat, q.near).split('\n');
    expect(lines[1]).toBe('outdoor encounter: Aluvian Newbie Forest Mix Generator (3%) → Mite Scion, on 3 spots in 2 landblocks: 37.2N, 30.0E (8 SW of Holtburg), here; 37.2N, 28.5E (8 N of Glenden Wood) ×2, 1.5 W of you');
    expect(placesText([{ cell: 0xa9b4001c, x: 100, y: 100, viaGenerator: false }], {}, 6, { ns: 37.2, ew: 30 })).toBe('42.5N, 33.7E (Holtburg), 6.5 NE of you');
  });

  it('says so when no source places the creature, and passes the name pick\'s note on', () => {
    expect(formatSpawns('Mite Scion', pick, [])).toMatch(/^Mite Scion: not placed in this world, and no generator .* makes it\. It may come from a quest, a summons or an event\.$/);
    expect(formatSpawns('Zzz', pickLoreNames('Zzz', []), [])).toMatch(/^no creature called "Zzz"/);
  });
});

describe('spawns: what the player is told and what viewers see', () => {
  it('the usage says how monsters spawn and the SQL dialect', () => {
    expect(WORLD_QUERY_USAGE).toMatch(/encounter table/);
    expect(WORLD_QUERY_USAGE).toMatch(/MySQL 8: CONCAT\(\), HEX\(\), LPAD\(\)/);
    expect(WORLD_QUERY_USAGE).toMatch(/no printf\(\)/);
  });
  it('the brief names the command, the encounter table and the dialect', () => {
    const cfg = parseStreamConfig(JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'stream', 'cast.json'), 'utf8')));
    const sys = systemPrompt(readFileSync(join(__dirname, '..', 'tools', 'stream', 'brief.md'), 'utf8'), cfg.characters[0], 'Claude Bulwark', playerToolNames(TOOLS.map((t) => t.name)));
    expect(sys).toContain('`./world-query spawns "<monster>"`');
    expect(sys).toContain('most outdoor monsters come from the `encounter` table');
    expect(sys).toContain('The SQL is MySQL 8 (CONCAT, HEX, LPAD; no printf).');
  });
  it('the feed says "looks up where <monster> spawn"', () => {
    const call = (command: string) => parseStreamJsonLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } }), 'soldier').drafts[0];
    expect(call('./world-query spawns "Mite Scion" near 37.3N 29.1E')).toMatchObject({ tool: 'bash', summary: 'looks up where Mite Scion spawn' });
  });
});
