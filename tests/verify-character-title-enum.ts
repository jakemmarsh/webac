/**
 * CharacterTitle enum + titleDisplayName helper (FAITHFUL.281).
 *
 * Pre-fix main.ts had a hardcoded 19-entry TITLE_NAMES map for a 873-entry
 * enum. Worse, the map was wrong on 7 of those 19 entries — title IDs
 * 39/49/63/114/119/125/137 referred to ENTIRELY DIFFERENT enum entries
 * in ACE than the map claimed. So:
 *   - A player with title 39 (ACE: DaggerFighter) saw "Champion of Dereth"
 *     in the title list.
 *   - A player with title 49 (ACE: Evoker) saw "Diplomat".
 *   - A player with title 114 (ACE: RehirKiller) saw "Master Alchemist"
 *     — a title that doesn't even exist in the ACE enum.
 *   - And 850+ valid titles fell through to "Title <n>" fallback.
 *
 * This test pins:
 *   1. Full 873-entry enum was ported correctly (canonical entries match
 *      ACE source positions).
 *   2. titleDisplayName produces the right output for the canonical
 *      camel-case → spaced-words transformations.
 *   3. Specific pre-fix-wrong IDs now return the actual ACE-enum name.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CharacterTitle, titleDisplayName } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const ACE_ENUM = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CharacterTitle.cs');

describe('CharacterTitle enum coverage (FAITHFUL.281)', () => {
  it('includes the first 14 standard titles (Adventurer..Wayfarer)', () => {
    expect(CharacterTitle.Invalid).toBe(0);
    expect(CharacterTitle.Adventurer).toBe(1);
    expect(CharacterTitle.Archer).toBe(2);
    expect(CharacterTitle.Blademaster).toBe(3);
    expect(CharacterTitle.Enchanter).toBe(4);
    expect(CharacterTitle.LifeMage).toBe(5);
    expect(CharacterTitle.Sorcerer).toBe(6);
    expect(CharacterTitle.Vagabond).toBe(7);
    expect(CharacterTitle.Warrior).toBe(8);
    expect(CharacterTitle.BowHunter).toBe(9);
    expect(CharacterTitle.LifeCaster).toBe(10);
    expect(CharacterTitle.Soldier).toBe(11);
    expect(CharacterTitle.Swashbuckler).toBe(12);
    expect(CharacterTitle.WarMage).toBe(13);
    expect(CharacterTitle.Wayfarer).toBe(14);
  });

  it('the pre-fix-wrong IDs are pinned to the correct ACE values', () => {
    // These were all WRONG in the pre-fix TITLE_NAMES map.
    expect(CharacterTitle.ChampionofDereth).toBe(34);   // pre-fix claimed 39
    expect(CharacterTitle.DaggerFighter).toBe(39);       // pre-fix claimed Champion of Dereth here
    expect(CharacterTitle.Diplomat).toBe(44);            // pre-fix claimed 49
    expect(CharacterTitle.Evoker).toBe(49);              // pre-fix claimed Diplomat here
    expect(CharacterTitle.GuardianofDereth).toBe(63);    // pre-fix claimed "Guard"
    expect(CharacterTitle.MasterFletcher).toBe(89);      // pre-fix claimed 125
    expect(CharacterTitle.MasterTinkerer).toBe(295);     // +1 from the UNKNOWNGUESSEDNAME161 gap (sweep 2026-06-11)
    // And there's NO MasterAlchemist or MasterChef in ACE.
    expect((CharacterTitle as Record<string, unknown>)['MasterAlchemist']).toBeUndefined();
    expect((CharacterTitle as Record<string, unknown>)['MasterChef']).toBeUndefined();
  });

  it('the enum has 895 numeric entries (873 named + 22 ACE placeholders)', () => {
    // TS enums populate both name→value AND value→name keys.
    const entries = Object.entries(CharacterTitle).filter(
      ([_, v]) => typeof v === 'number',
    );
    expect(entries.length).toBe(895);
  });
});

// Sweep 2026-06-11: ACE reserves 22 UNKNOWNGUESSEDNAME placeholder ids; dropping
// them made every title id >= 162 drift +1..22 vs the server, so most players
// saw the wrong title. Pin the gapped ids so the placeholders can't be dropped
// again, and confirm placeholders render as the neutral "Title N" fallback.
describe('CharacterTitle preserves ACE placeholder gaps (server id parity)', () => {
  it('the first gap shifts PestControl to 162 (not 161) and accumulates by the end', () => {
    expect(CharacterTitle.PerforatedKnight).toBe(160);
    expect(CharacterTitle.PestControl).toBe(162);       // was 161 before the gap
    expect(CharacterTitle.CosmicConscious).toBe(893);   // was 871 — full +22 drift
  });

  it('reserved placeholder ids resolve to the neutral fallback, not the raw name', () => {
    expect(titleDisplayName(161)).toBe('Title 161');
    expect(CharacterTitle[161]).toBe('UNKNOWNGUESSEDNAME161');
  });
});

describe('titleDisplayName helper (FAITHFUL.281)', () => {
  it('returns "Title N" for invalid/unknown IDs', () => {
    expect(titleDisplayName(99999)).toBe('Title 99999');
    expect(titleDisplayName(0)).toBe('Title 0');  // Invalid sentinel
    expect(titleDisplayName(-1)).toBe('Title -1');
  });

  it('renders single-word titles verbatim', () => {
    expect(titleDisplayName(CharacterTitle.Adventurer)).toBe('Adventurer');
    expect(titleDisplayName(CharacterTitle.Archer)).toBe('Archer');
    expect(titleDisplayName(CharacterTitle.Sorcerer)).toBe('Sorcerer');
  });

  it('splits standard camel-case', () => {
    expect(titleDisplayName(CharacterTitle.WarMage)).toBe('War Mage');
    expect(titleDisplayName(CharacterTitle.LifeMage)).toBe('Life Mage');
    expect(titleDisplayName(CharacterTitle.BowHunter)).toBe('Bow Hunter');
    expect(titleDisplayName(CharacterTitle.LifeCaster)).toBe('Life Caster');
    expect(titleDisplayName(CharacterTitle.MasterFletcher)).toBe('Master Fletcher');
    expect(titleDisplayName(CharacterTitle.DaggerFighter)).toBe('Dagger Fighter');
  });

  it('splits embedded "of" connector', () => {
    expect(titleDisplayName(CharacterTitle.ChampionofDereth)).toBe('Champion of Dereth');
    expect(titleDisplayName(CharacterTitle.GuardianofDereth)).toBe('Guardian of Dereth');
    expect(titleDisplayName(CharacterTitle.FriendofSanamar)).toBe('Friend of Sanamar');
    expect(titleDisplayName(CharacterTitle.HeroofDereth)).toBe('Hero of Dereth');
  });

  it('splits embedded "ofthe" multi-word connector', () => {
    expect(titleDisplayName(CharacterTitle.BaneoftheRemoran)).toBe('Bane of the Remoran');
  });
});

describe.skipIf(!aceReferenceExists(ACE_ENUM))('ACE source faithfulness (FAITHFUL.281)', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_ENUM, 'utf8');
  });

  it('ACE source has the expected sequential order for the canonical 15 titles', () => {
    // Anchor a few non-adjacent positions to detect any silent re-ordering
    // in a future ACE rebase.
    const lines = src.split('\n');
    // Find the line containing each identifier and assert relative positions.
    const findPos = (name: string) => lines.findIndex(l => new RegExp(`\\b${name}\\b`).test(l));
    expect(findPos('Invalid')).toBeLessThan(findPos('Adventurer'));
    expect(findPos('Adventurer')).toBeLessThan(findPos('WarMage'));
    expect(findPos('WarMage')).toBeLessThan(findPos('Wayfarer'));
    expect(findPos('Wayfarer')).toBeLessThan(findPos('ChampionofDereth'));
    expect(findPos('ChampionofDereth')).toBeLessThan(findPos('DaggerFighter'));
    expect(findPos('DaggerFighter')).toBeLessThan(findPos('Diplomat'));
  });

  it('the canonical pre-fix-wrong ACE entries exist in the source', () => {
    expect(src).toMatch(/\bChampionofDereth\b/);
    expect(src).toMatch(/\bDaggerFighter\b/);
    expect(src).toMatch(/\bGuardianofDereth\b/);
    expect(src).toMatch(/\bMasterFletcher\b/);
    expect(src).toMatch(/\bMasterTinkerer\b/);
    expect(src).toMatch(/\bDiplomat\b/);
    expect(src).toMatch(/\bEvoker\b/);
  });

  it('ACE source does NOT have entries the pre-fix map invented', () => {
    // The pre-fix map had "Master Alchemist" and "Master Chef" — ACE has neither.
    expect(src).not.toMatch(/\bMasterAlchemist\b/);
    expect(src).not.toMatch(/\bMasterChef\b/);
    expect(src).not.toMatch(/\bMasterTinker\b/);  // ACE has Tinkerer not Tinker
  });
});

describe('main.ts wiring (FAITHFUL.281)', () => {
  const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

  it('imports titleDisplayName from @ac/shared', () => {
    expect(MAIN).toMatch(/import\s*\{[^}]*titleDisplayName[^}]*\}\s*from\s*'@ac\/shared'/);
  });

  it('the pre-fix hardcoded TITLE_NAMES map is gone', () => {
    expect(MAIN).not.toMatch(/TITLE_NAMES:\s*Record<number,\s*string>\s*=\s*\{/);
    // Pre-fix specific wrong entries that should no longer be in the file
    expect(MAIN).not.toMatch(/39:\s*'Champion of Dereth'/);
    expect(MAIN).not.toMatch(/49:\s*'Diplomat'/);
    expect(MAIN).not.toMatch(/114:\s*'Master Alchemist'/);
  });

  it('titleIdToName now aliases titleDisplayName', () => {
    expect(MAIN).toMatch(/const\s+titleIdToName\s*=\s*titleDisplayName/);
  });
});
