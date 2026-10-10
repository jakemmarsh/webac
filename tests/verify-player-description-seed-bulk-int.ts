/**
 * FAITHFUL.402 — Bulk-seed PrivateUpdatePropertyInt-tracked PlayerState
 * fields at login, restricted to ACE's actual [SendOnLogin] set.
 *
 * Pre-fix FAITHFUL.400 only covered 9 PropertyInt seeds; FAITHFUL.402 added
 * a bulk seedInt array in main.ts for AllegianceRank / chess stats /
 * aetheria / luminance augs, all of which stayed at local defaults until
 * ACE sent a PrivateUpdatePropertyInt delta (which only happens on change,
 * so an unchanging value could stay at the default forever).
 *
 * BUG.chess-stat-lumaug-login-seed-unreachable: the original FAITHFUL.402
 * array included ChessTotalGames(182)/ChessGamesWon(183)/ChessGamesLost(184)/
 * LumAugNoDestroyCraft(345) — none of which ACE's server actually includes
 * in the login PlayerDescription event. Building the cross-reference check
 * below (rather than hand-copying an expected-keys list) also caught a fifth,
 * previously-unfiled instance of the same defect: AdvocateLevel(112) carries
 * no [SendOnLogin] attribute either, so it was removed too. ACE's
 * GameEventPlayerDescription.cs
 * builds `_propertiesInt` via Session.Player.GetAllPropertyIntWhere
 * (SendOnLoginProperties.PropertiesInt), a reflection-built HashSet of only
 * the [SendOnLogin]-tagged PropertyInt fields (PropertyInt.cs's own leading
 * comment: "No properties are sent to the client unless they featured an
 * attribute. SendOnLogin gets sent to players in the PlayerDescription
 * event."). An untagged key in the seedInt array is therefore permanently
 * dead code at login — desc.propertiesInt.get(...) is always undefined for
 * it, so the `if (v !== undefined) set(v)` guard never fires.
 *
 * Rather than pin a hand-copied expected-keys list (the pre-fix version of
 * this file), this test derives the [SendOnLogin] tag set directly from the
 * real reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs enum
 * and asserts every key in main.ts's seedInt array is drawn from that set —
 * so ANY future re-addition of an untagged key (not just today's four) fails
 * this test, not only the specific keys removed today.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const PROPERTY_INT_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyInt.cs'),
  'utf8',
);

/**
 * Parses the real ACE PropertyInt enum, returning name -> hasSendOnLogin.
 * Attributes always sit on their own line(s) directly above the field they
 * gate (verified: no `[Attr] Name = n,` single-line form appears in this
 * file), so a simple "did any preceding attribute-only line mention
 * SendOnLogin since the last field" scan is exact.
 */
function parseSendOnLogin(src: string): Map<string, boolean> {
  const result = new Map<string, boolean>();
  const lines = src.split('\n');
  let inside = false;
  let pendingSendOnLogin = false;
  const fieldRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|-?\d+)\s*,?/;
  const attrRe = /^\s*(\[[A-Za-z]+\])+\s*$/;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!inside) {
      if (/enum\s+PropertyInt\b/.test(line)) inside = true;
      continue;
    }
    if (/^\s*}/.test(line)) break;
    if (attrRe.test(line)) {
      if (line.includes('SendOnLogin')) pendingSendOnLogin = true;
      continue;
    }
    const m = fieldRe.exec(line);
    if (m) {
      result.set(m[1], pendingSendOnLogin);
      pendingSendOnLogin = false;
    }
  }
  return result;
}

/** Extracts the PropertyInt.* keys referenced inside main.ts's seedInt array literal. */
function extractSeedIntKeys(src: string): string[] {
  const block = src.match(/const seedInt: Array<\[number, \(v: number\) => void\]>[\s\S]+?\];/)?.[0];
  if (!block) throw new Error('seedInt array literal not found in main.ts');
  return [...block.matchAll(/PropertyInt\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

describe('PropertyInt.cs [SendOnLogin] parser sanity', () => {
  const tags = parseSendOnLogin(PROPERTY_INT_CS);

  it('parses a representative slice of known-tagged and known-untagged fields', () => {
    // Ground truth spot-checks against the raw source (not hand-copied lists
    // — these mirror lines read directly from the file for the assertions below).
    expect(tags.get('ChessRank')).toBe(true); // [SendOnLogin][AssessmentProperty]
    expect(tags.get('ChessTotalGames')).toBe(false); // no attribute
    expect(tags.get('ChessGamesWon')).toBe(false);
    expect(tags.get('ChessGamesLost')).toBe(false);
    expect(tags.get('LumAugDamageRating')).toBe(true); // [SendOnLogin]
    expect(tags.get('LumAugSkilledSpec')).toBe(true); // [SendOnLogin]
    expect(tags.get('LumAugNoDestroyCraft')).toBe(false); // no attribute
    expect(tags.get('AdvocateLevel')).toBe(false); // no attribute
    expect(tags.get('AllegianceRank')).toBe(true);
  });
});

describe('FAITHFUL.402 bulk-seed structure', () => {
  it('declares the seedInt mapping array', () => {
    expect(MAIN).toMatch(/const seedInt: Array<\[number, \(v: number\) => void\]> = \[/);
  });

  it('iterates the seed array applying values to playerState', () => {
    expect(MAIN).toMatch(/for \(const \[key, set\] of seedInt\) \{\s*\n\s*const v = desc\.propertiesInt\.get\(key\);\s*\n\s*if \(v !== undefined\) set\(v\);/);
  });
});

describe('Society rank coverage (FAITHFUL.402)', () => {
  it('seeds SocietyRankEldweb', () => {
    expect(MAIN).toMatch(/PropertyInt\.SocietyRankEldweb[\s\S]+?playerState\.societyRankEldweb = initialEldwebRank/);
  });

  it('seeds SocietyRankRadblo', () => {
    expect(MAIN).toMatch(/PropertyInt\.SocietyRankRadblo[\s\S]+?playerState\.societyRankRadblo = initialRadbloRank/);
  });
});

describe('BUG.chess-stat-lumaug-login-seed-unreachable — seedInt is restricted to [SendOnLogin] keys', () => {
  const tags = parseSendOnLogin(PROPERTY_INT_CS);
  const seedKeys = extractSeedIntKeys(MAIN);

  it('extracted at least the known FAITHFUL.402 keys (sanity on the extraction itself)', () => {
    expect(seedKeys.length).toBeGreaterThanOrEqual(20);
    expect(seedKeys).toContain('ChessRank');
    expect(seedKeys).toContain('AllegianceRank');
  });

  it.each([...new Set(seedKeys)])('seedInt key PropertyInt.%s carries [SendOnLogin] in ACE', (key) => {
    expect(tags.has(key)).toBe(true); // fails loudly if the key doesn't even exist in ACE's enum
    expect(tags.get(key)).toBe(true);
  });

  it('does not include the five keys ACE never sends at login', () => {
    expect(seedKeys).not.toContain('ChessTotalGames');
    expect(seedKeys).not.toContain('ChessGamesWon');
    expect(seedKeys).not.toContain('ChessGamesLost');
    expect(seedKeys).not.toContain('LumAugNoDestroyCraft');
    expect(seedKeys).not.toContain('AdvocateLevel');
  });

  it('still seeds ChessRank, which IS [SendOnLogin]-tagged', () => {
    expect(seedKeys).toContain('ChessRank');
  });
});

describe('CombatMode seed (FAITHFUL.402)', () => {
  it('reads PropertyInt.CombatMode and syncs combatController + HUD + stance', () => {
    expect(MAIN).toMatch(/initialCombatMode = desc\.propertiesInt\.get\(PropertyInt\.CombatMode\)/);
    expect(MAIN).toMatch(/initialCombatMode[\s\S]+?combatController\.setCombatMode\(serverMode\)/);
    expect(MAIN).toMatch(/initialCombatMode[\s\S]+?gameUI\.hudState\.combatMode = serverMode/);
  });
});
