/**
 * Spell level (I-VIII) derivation from SpellBase.power (FAITHFUL.331).
 *
 * Pre-FAITHFUL.331 two call sites in `packages/renderer/src/main.ts`
 * (PlayerDescription bulk-learn at L4504 + onMagicUpdateSpell at L6138)
 * computed spell level as:
 *
 *     Math.min(8, Math.max(1, Math.ceil(power / 50)))
 *
 * That formula buckets power into [1..8] but mis-assigns every canonical
 * mid-tier spell (power = 50/100/150/200/250/300) one Roman numeral
 * lower than retail. ACE's authoritative server formula at
 * `reference/ACE/Source/ACE.Server/Entity/Spell.cs:92-105` walks down
 * from MaxSpellLevel and returns the first level whose MinPower threshold
 * is <= power. Thresholds are at
 * `reference/ACE/Source/ACE.Server/Entity/SpellFormula.cs:95-105`:
 *   { L1=1, L2=50, L3=100, L4=150, L5=200, L6=250, L7=300, L8=400 }.
 *
 * The fix exposes `spellLevelFromPower(power)` from
 * `@ac/shared/magic/SpellFormula.ts` and the two main.ts sites call it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spellLevelFromPower, MIN_POWER_BY_LEVEL, MAX_SPELL_LEVEL } from '@ac/shared';
import type { SpellDefinition } from '@ac/shared';
import { handleMagicUpdateSpell } from '../packages/renderer/src/magic/SpellLearn.js';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const SPELL_FORMULA = readFileSync(resolve(REPO, 'packages/shared/src/magic/SpellFormula.ts'), 'utf8');

describe('spellLevelFromPower — ACE-faithful tier mapping (FAITHFUL.331)', () => {
  describe('canonical retail power values', () => {
    // Per SpellFormula.cs MinPower the canonical L1..L8 power values are
    // 1, 50, 100, 150, 200, 250, 300, 400 — every retail spell sits on one
    // of these (give or take the rare custom-content spell).
    it.each([
      [1, 1], [50, 2], [100, 3], [150, 4],
      [200, 5], [250, 6], [300, 7], [400, 8],
    ])('power=%i → level %i', (power, expected) => {
      expect(spellLevelFromPower(power)).toBe(expected);
    });

    it('demonstrates the pre-fix Math.ceil(power/50) bug at canonical values', () => {
      const old = (p: number) => Math.min(8, Math.max(1, Math.ceil(p / 50)));
      // Every L2..L7 canonical value used to be one tier too low.
      expect(old(50)).toBe(1);   // ACE: 2
      expect(old(100)).toBe(2);  // ACE: 3
      expect(old(150)).toBe(3);  // ACE: 4
      expect(old(200)).toBe(4);  // ACE: 5
      expect(old(250)).toBe(5);  // ACE: 6
      expect(old(300)).toBe(6);  // ACE: 7
      // L1 (power=1) and L8 (power=400) happened to match by luck.
      expect(old(1)).toBe(spellLevelFromPower(1));
      expect(old(400)).toBe(spellLevelFromPower(400));
    });
  });

  describe('boundary behavior — picks the highest matching tier', () => {
    it('values just below a threshold bucket into the lower tier', () => {
      expect(spellLevelFromPower(49)).toBe(1);
      expect(spellLevelFromPower(99)).toBe(2);
      expect(spellLevelFromPower(149)).toBe(3);
      expect(spellLevelFromPower(199)).toBe(4);
      expect(spellLevelFromPower(249)).toBe(5);
      expect(spellLevelFromPower(299)).toBe(6);
      expect(spellLevelFromPower(399)).toBe(7);
    });

    it('values above L8 threshold still cap at MAX_SPELL_LEVEL', () => {
      expect(spellLevelFromPower(401)).toBe(8);
      expect(spellLevelFromPower(500)).toBe(8);
      expect(spellLevelFromPower(10_000)).toBe(8);
    });

    it('power=0 returns 0 (no level — matches ACE early-out)', () => {
      expect(spellLevelFromPower(0)).toBe(0);
    });
  });

  it('thresholds match ACE SpellFormula.cs MinPower verbatim', () => {
    expect(MIN_POWER_BY_LEVEL).toEqual({
      1: 1, 2: 50, 3: 100, 4: 150,
      5: 200, 6: 250, 7: 300, 8: 400,
    });
    expect(MAX_SPELL_LEVEL).toBe(8);
  });
});

describe('main.ts call sites use the helper (FAITHFUL.331)', () => {
  it('does not reintroduce the buggy Math.ceil(sb.power / 50) formula', () => {
    expect(MAIN).not.toMatch(/Math\.ceil\(sb\.power\s*\/\s*50\)/);
  });

  it('PlayerDescription bulk-learn calls spellLevelFromPower(sb.power)', () => {
    // Anchor near the surrounding bulk-learn fields so this catches
    // accidental deletion or move of this call site.
    expect(MAIN).toMatch(
      /school: sb\.school as MagicSchool,\s*\n\s*level: spellLevelFromPower\(sb\.power\),/,
    );
  });

  it('the MagicUpdateSpell learn path derives level via spellLevelFromPower', () => {
    // Behavioral: drive the shipped handler and check the level it stores
    // against the ACE tier table (which the old Math.ceil(power/50) formula
    // disagrees with at every tier boundary — see the cases above).
    for (const power of [1, 50, 51, 100, 101, 150, 200, 250, 300, 350, 400]) {
      const learned: SpellDefinition[] = [];
      handleMagicUpdateSpell(7, {
        spellTable: {
          spells: new Map([[7, {
            name: 'Test Spell', school: 2, power, baseMana: 10, formula: [], duration: 0,
          }]]),
        },
        isSpellKnown: () => false,
        learnSpell: (s) => { learned.push(s); },
        refreshSpellbook: () => {},
      });
      expect(learned).toHaveLength(1);
      expect(learned[0].level).toBe(spellLevelFromPower(power));
    }
  });
});

describe('SpellFormula.ts pins ACE source citation (FAITHFUL.331)', () => {
  it('helper cites both Spell.cs Level getter and SpellFormula.cs MinPower', () => {
    expect(SPELL_FORMULA).toMatch(/Spell\.cs:\d+-\d+/);
    expect(SPELL_FORMULA).toMatch(/SpellFormula\.cs:\d+-\d+/);
  });
});
