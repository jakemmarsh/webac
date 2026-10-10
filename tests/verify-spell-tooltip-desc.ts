/**
 * Spell description in spell-bar tooltip (FAITHFUL.309).
 *
 * Pre-fix: the DAT SpellTable parses the spell `desc` string (via
 * `readObfuscatedString` per
 * `packages/dat-parser/src/file-types/SpellTable.ts:45,77`), but the
 * SpellDefinition interface in `@ac/shared/magic/SpellEngine.ts` didn't
 * carry the field through and the spell-bar slot tooltip never rendered
 * it. Retail showed the description on the spell tooltip alongside
 * school / mana / level — e.g. "Increases the target's Strength
 * attribute by N for the duration."
 *
 * Same parsed-but-not-displayed shape as FAITHFUL.295-308.
 *
 * Fix:
 *   1. Adds `desc?: string` to SpellDefinition interface.
 *   2. Both spell-construction sites in main.ts (PlayerDesc spell-list
 *      learn + UpdateSpell event) now copy `sb.desc` through.
 *   3. Spell-bar tooltip in GameUI.ts conditionally pushes the desc as
 *      a tooltip line right after the spell name.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SpellDefinition } from '@ac/shared';
import { handleMagicUpdateSpell } from '../packages/renderer/src/magic/SpellLearn.js';

const REPO = resolve(__dirname, '..');
const SPELL_ENGINE = readFileSync(resolve(REPO, 'packages/shared/src/magic/SpellEngine.ts'), 'utf8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
import { spellShortcutTooltip } from '../packages/renderer/src/ui/HudTooltips.js';
const SPELL_TABLE = readFileSync(resolve(REPO, 'packages/dat-parser/src/file-types/SpellTable.ts'), 'utf8');

describe('SpellDefinition has desc field (FAITHFUL.309)', () => {
  it('SpellEngine.ts SpellDefinition declares desc?: string', () => {
    // Anchor near the interface declaration to avoid matching unrelated `desc`.
    expect(SPELL_ENGINE).toMatch(/SpellDefinition\s*\{[\s\S]+?desc\?:\s*string/);
  });

  it("FAITHFUL.309 doc comment references SpellTable.ts:77 readObfuscatedString anchor", () => {
    expect(SPELL_ENGINE).toMatch(/readObfuscatedString/);
  });
});

describe('SpellTable parses desc (FAITHFUL.309 anchor)', () => {
  it("SpellBase declares desc: string", () => {
    expect(SPELL_TABLE).toMatch(/desc:\s*string/);
  });
  it('parser reads desc via readObfuscatedString', () => {
    expect(SPELL_TABLE).toMatch(/const desc\s*=\s*reader\.readObfuscatedString\(\)/);
  });
});

describe('main.ts spell construction copies desc through (FAITHFUL.309)', () => {
  it('PlayerDesc spell-list learn copies sb.desc', () => {
    // Look for the `desc: sb.desc` line near the learnSpell call from
    // the spell-list branch (around L4429-4441 in main.ts).
    const block = MAIN.match(/magicController\.learnSpell\(\{[\s\S]+?id:\s*spellId,[\s\S]+?\}\)/);
    expect(block).not.toBeNull();
    expect(block![0]).toMatch(/desc:\s*sb\.desc/);
  });

  it('MagicUpdateSpell learn path copies the DAT desc onto the spellbook entry', () => {
    // Behavioral: drive the shipped handler (magic/SpellLearn.ts) and read
    // back what it stored, rather than pinning main.ts source text.
    const DESC = "Increases the target's Strength attribute by 10 for the duration.";
    const learned: SpellDefinition[] = [];
    handleMagicUpdateSpell(157, {
      spellTable: {
        spells: new Map([[157, {
          name: 'Strength Self I', desc: DESC, school: 2,
          power: 1, baseMana: 10, formula: [], duration: 30,
        }]]),
      },
      isSpellKnown: () => false,
      learnSpell: (s) => { learned.push(s); },
      refreshSpellbook: () => {},
    });
    expect(learned).toHaveLength(1);
    expect(learned[0].desc).toBe(DESC);
  });
});

describe('Spell-bar tooltip does NOT surface desc — the FAITHFUL.309 tooltip claim was a wrong premise (CORE.17.k.b.b.a.g)', () => {
  // SpellCastSubMenu::UpdateFromPlayerModule @ 004c6570 sets the shortcut's
  // tooltip to CSpellBase::InqName alone; the desc stays in the spellbook's
  // detail panel. The behavioural check lives in
  // tests/verify-spell-tooltip-difficulty-duration.ts (renderSpellBarSlot
  // through happy-dom); here the pure rule.
  it('spellShortcutTooltip returns the name — never the desc', () => {
    expect(spellShortcutTooltip('Strength Other I')).toBe('Strength Other I');
    expect(spellShortcutTooltip('Strength Other I')).not.toContain('Increases');
  });
});
