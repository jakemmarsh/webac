/**
 * FAITHFUL.106 — Pin tests for `damageTypeName` (canonical helper in @ac/shared).
 *
 * Anchored to ACE source `DamageType.GetName` in
 * `reference/ACE/Source/ACE.Entity/Enum/DamageType.cs:30-50`.
 *
 * History: Pre-FAITHFUL.106 there were 3 local copies of this table in
 *   - main.ts (`getDamageTypeName`)
 *   - controllers/CombatController.ts (`damageTypeName`)
 *   - inventory/AssessmentSystem.ts (inline `damageTypeNames` map)
 *
 * Each disagreed with ACE source AND with each other:
 *   - AssessmentSystem used short forms ("Slash" / "Pierce" / "Bludgeon")
 *     instead of ACE's "Slashing" / "Piercing" / "Bludgeoning".
 *   - CombatController also used short forms AND was missing Health,
 *     Stamina, Mana — drain damage rendered as "unknown damage" in chat.
 *   - main.ts had the lowercase adjective forms but was a separate copy.
 *
 * Consolidated to one helper in @ac/shared returning the ACE-source name.
 * Callers that need the lowercase-adjective form do `.toLowerCase()`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { damageTypeName, DamageType } from '../packages/shared/src/index.js';

const REPO = resolve(__dirname, '..');
const ACE_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/DamageType.cs');

describe('damageTypeName — ACE GetName parity', () => {
  // 11 active damage types + Undef + Base; physical types use gerund forms.
  it('Slash → "Slashing" (gerund, matches ACE GetName)', () => {
    expect(damageTypeName(DamageType.Slash)).toBe('Slashing');
  });

  it('Pierce → "Piercing"', () => {
    expect(damageTypeName(DamageType.Pierce)).toBe('Piercing');
  });

  it('Bludgeon → "Bludgeoning"', () => {
    expect(damageTypeName(DamageType.Bludgeon)).toBe('Bludgeoning');
  });

  it('elemental types use single-word names', () => {
    expect(damageTypeName(DamageType.Cold)).toBe('Cold');
    expect(damageTypeName(DamageType.Fire)).toBe('Fire');
    expect(damageTypeName(DamageType.Acid)).toBe('Acid');
    expect(damageTypeName(DamageType.Electric)).toBe('Electric');
  });

  it('drain damage types covered (FAITHFUL.106 anchor — were missing in CombatController copy)', () => {
    // Pre-fix CombatController.damageTypeName had no entry for Health/Stamina/
    // Mana — drain damage from spells / weapons rendered as "unknown damage"
    // in the chat hit message.
    expect(damageTypeName(DamageType.Health)).toBe('Health');
    expect(damageTypeName(DamageType.Stamina)).toBe('Stamina');
    expect(damageTypeName(DamageType.Mana)).toBe('Mana');
  });

  it('Nether → "Nether"', () => {
    expect(damageTypeName(DamageType.Nether)).toBe('Nether');
  });

  it('Undef and Base both have ACE names', () => {
    expect(damageTypeName(DamageType.Undef)).toBe('Undefined');
    expect(damageTypeName(DamageType.Base)).toBe('Base');
  });

  it('unrecognized flag falls back to "DamageType #<n>" instead of empty string', () => {
    // 0x800 isn't a valid DamageType; helper should surface this rather than
    // silently rendering empty.
    expect(damageTypeName(0x800)).toBe('DamageType #2048');
  });

  it('lowercase form via .toLowerCase() matches AC chat sentence convention', () => {
    // "for 25 points of slashing damage" — AC retail uses lowercase adjective
    // in the middle of chat sentences.
    expect(damageTypeName(DamageType.Slash).toLowerCase()).toBe('slashing');
    expect(damageTypeName(DamageType.Fire).toLowerCase()).toBe('fire');
    expect(damageTypeName(DamageType.Health).toLowerCase()).toBe('health');
  });
});

describe('damageTypeName — ACE source audit', () => {
  it('ACE DamageType.GetName covers exactly 13 cases (Undef + 11 active + Base)', () => {
    const src = readFileSync(ACE_PATH, 'utf8');
    // Count `case DamageType.X: return "..."` entries inside GetName.
    const matches = src.match(/case\s+DamageType\.\w+:\s*return\s+"[^"]+";/g) || [];
    expect(matches.length).toBe(13);
  });

  it('every ACE GetName entry has a matching TS damageTypeName mapping', () => {
    const src = readFileSync(ACE_PATH, 'utf8');
    // Build the ACE name table from source.
    const re = /case\s+DamageType\.(\w+):\s*return\s+"([^"]+)";/g;
    const aceEntries: Array<[string, string]> = [];
    let m;
    while ((m = re.exec(src)) !== null) aceEntries.push([m[1], m[2]]);

    expect(aceEntries.length).toBeGreaterThan(0);

    // Resolve each ACE symbol → numeric DamageType value, then assert.
    const symMap: Record<string, number> = {
      Undef: DamageType.Undef,
      Slash: DamageType.Slash,
      Pierce: DamageType.Pierce,
      Bludgeon: DamageType.Bludgeon,
      Cold: DamageType.Cold,
      Fire: DamageType.Fire,
      Acid: DamageType.Acid,
      Electric: DamageType.Electric,
      Health: DamageType.Health,
      Stamina: DamageType.Stamina,
      Mana: DamageType.Mana,
      Nether: DamageType.Nether,
      Base: DamageType.Base,
    };
    for (const [sym, aceName] of aceEntries) {
      const flag = symMap[sym];
      expect(flag).toBeDefined();
      expect(damageTypeName(flag)).toBe(aceName);
    }
  });
});
