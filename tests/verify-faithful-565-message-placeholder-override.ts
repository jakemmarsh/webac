/**
 * FAITHFUL.565 — three WeenieErrorWithString templates carry the literal
 * ACE `{message}` placeholder rather than `_`, so the substitution
 * pipeline (split('_').join(value)) leaves `{message}` in the chat
 * output. Plus the FAITHFUL.555 heuristic injects a spurious `_` before
 * the opening quote of `"@allegiance chat on"` on 0x0533. Extends the
 * FAITHFUL.552 MANUAL_OVERRIDES list to restore the authentic AC client
 * wording with `_` at the substitution slot.
 *
 * Anchored to ACE reference/ACE/Source/ACE.Entity/Enum/WeenieErrorWithString.cs:
 *   YouHaveBeenBootedFromAllegianceChat (0x0533)
 *   YouMayOnlyChangeAllegianceNameOnceEvery24Hours (0x056A)
 *   ThatLevelOfAllegianceOfficerIsNowKnownAs_ (0x056E)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatWeenieErrorWithString, WeenieErrorWithString, WEENIE_ERROR_WITH_STRING_TEXT } from '@ac/shared';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const ACE_ENUM = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/WeenieErrorWithString.cs');
const GEN = resolve(REPO, 'tools/generate-weenie-error-with-string.ts');
const TEXT = resolve(REPO, 'packages/shared/src/combat/WeenieErrorWithStringText.ts');

describe('FAITHFUL.565 — {message} placeholder override', () => {
  describe('YouHaveBeenBootedFromAllegianceChat (0x0533)', () => {
    it('template substitutes a reason value cleanly with no literal {message}', () => {
      const out = formatWeenieErrorWithString(
        WeenieErrorWithString.YouHaveBeenBootedFromAllegianceChat,
        'spamming chat',
      );
      expect(out).toBe(
        'You have been booted from your allegiance chat room. Use "@allegiance chat on" to rejoin. (spamming chat).',
      );
    });

    it('template no longer carries the spurious _ before "@allegiance chat on"', () => {
      // The pre-fix template was:
      //   'You have been booted from your allegiance chat room. Use _"@allegiance chat on" to rejoin. ({message}).'
      // Both defects (spurious _ + literal {message}) must be gone.
      const template = WEENIE_ERROR_WITH_STRING_TEXT[0x0533];
      expect(template).not.toMatch(/Use _"/);
      expect(template).not.toMatch(/\{message\}/);
      expect(template).toMatch(/Use "@allegiance chat on"/);
      expect(template).toMatch(/\(_\)/);
    });

    it('value is interpolated at the parenthesized slot only', () => {
      const out = formatWeenieErrorWithString(
        WeenieErrorWithString.YouHaveBeenBootedFromAllegianceChat,
        'X',
      );
      // The single `_` lives in `(X)` — no other substitutions.
      expect(out.match(/X/g)?.length).toBe(1);
      expect(out).toContain('(X).');
    });
  });

  describe('YouMayOnlyChangeAllegianceNameOnceEvery24Hours (0x056A)', () => {
    it('template substitutes a duration value cleanly with no literal {message}', () => {
      const out = formatWeenieErrorWithString(
        WeenieErrorWithString.YouMayOnlyChangeAllegianceNameOnceEvery24Hours,
        '5 hours, 23 minutes',
      );
      expect(out).toBe(
        'You may only change your allegiance name once every 24 hours. You may change your allegiance name again in 5 hours, 23 minutes.',
      );
    });

    it('template has no literal {message} marker', () => {
      const template = WEENIE_ERROR_WITH_STRING_TEXT[0x056A];
      expect(template).not.toMatch(/\{message\}/);
      expect(template).toMatch(/again in _\./);
    });
  });

  describe('ThatLevelOfAllegianceOfficerIsNowKnownAs_ (0x056E)', () => {
    it('template substitutes a title cleanly with no literal {message}', () => {
      const out = formatWeenieErrorWithString(
        WeenieErrorWithString.ThatLevelOfAllegianceOfficerIsNowKnownAs_,
        'Highest Voice',
      );
      expect(out).toBe('That level of allegiance officer is now known as: Highest Voice.');
    });

    it('template has no literal {message} marker', () => {
      const template = WEENIE_ERROR_WITH_STRING_TEXT[0x056E];
      expect(template).not.toMatch(/\{message\}/);
      expect(template).toMatch(/known as: _\./);
    });
  });

  describe('No regression — other templates that previously had {message} are still clean', () => {
    it('no surviving template carries a literal {message} marker', () => {
      // Sweep the full text table — any literal `{message}` left would
      // mean another entry slipped through the generator + override
      // pipeline.
      for (const [code, text] of Object.entries(WEENIE_ERROR_WITH_STRING_TEXT)) {
        expect(text, `code ${code} carries literal {message}`).not.toMatch(/\{message\}/);
      }
    });
  });

  describe('ACE source still anchors the fix', () => {
    const aceSource = readFileSync(ACE_ENUM, 'utf-8');

    it('ACE 0x0533 summary still uses {message} marker (override stays load-bearing)', () => {
      // If ACE rebases away from {message} to a real `_` placeholder, the
      // override becomes redundant — but until then it's load-bearing.
      const idx = aceSource.indexOf('YouHaveBeenBootedFromAllegianceChat');
      const before = aceSource.slice(Math.max(0, idx - 400), idx);
      expect(before).toMatch(/\{message\}/);
    });

    it('ACE 0x056A summary still uses {message} marker', () => {
      const idx = aceSource.indexOf('YouMayOnlyChangeAllegianceNameOnceEvery24Hours');
      const before = aceSource.slice(Math.max(0, idx - 400), idx);
      expect(before).toMatch(/\{message\}/);
    });

    it('ACE 0x056E summary still uses {message} marker', () => {
      const idx = aceSource.indexOf('ThatLevelOfAllegianceOfficerIsNowKnownAs_');
      const before = aceSource.slice(Math.max(0, idx - 400), idx);
      expect(before).toMatch(/\{message\}/);
    });
  });

  describe('Generator override metadata is wired correctly', () => {
    const genSource = readFileSync(GEN, 'utf-8');

    it('FAITHFUL.565 block precedes the 3 override entries', () => {
      // The shared FAITHFUL.565 docblock lives once, ahead of the three
      // entry blocks. Pin that block AND each entry below it.
      const block = genSource.match(/\/\/ FAITHFUL\.565[\s\S]+?0x056E:[\s\S]+?},/);
      expect(block).not.toBeNull();
      expect(block![0]).toContain('0x0533:');
      expect(block![0]).toContain('0x056A:');
      expect(block![0]).toContain('0x056E:');
    });

    it('0x0533 override text restores the canonical AC client wording', () => {
      expect(genSource).toMatch(/0x0533:[\s\S]+?Use "@allegiance chat on"[\s\S]+?\(_\)/);
    });

    it('0x056A override anchors to YouMayOnlyChangeAllegianceNameOnceEvery24Hours', () => {
      expect(genSource).toMatch(/0x056A:[\s\S]+?YouMayOnlyChangeAllegianceNameOnceEvery24Hours/);
    });

    it('0x056E override anchors to ThatLevelOfAllegianceOfficerIsNowKnownAs_', () => {
      expect(genSource).toMatch(/0x056E:[\s\S]+?ThatLevelOfAllegianceOfficerIsNowKnownAs_/);
    });

    it('all 3 override texts contain exactly one `_` placeholder slot', () => {
      // Each substituted value should land in exactly one slot per
      // template; multiple `_`s would duplicate the value confusingly.
      for (const code of [0x0533, 0x056A, 0x056E]) {
        const template = WEENIE_ERROR_WITH_STRING_TEXT[code];
        const count = (template.match(/_/g) ?? []).length;
        expect(count, `code 0x${code.toString(16)} has ${count} _ slots`).toBe(1);
      }
    });
  });

  describe('Generated file carries the override comment', () => {
    const textSource = readFileSync(TEXT, 'utf-8');

    it('0x0533 line carries an OVERRIDE marker', () => {
      const line = textSource.split('\n').find(l => l.includes('[0x0533]:'));
      expect(line).toBeDefined();
      expect(line).toMatch(/OVERRIDE/);
    });

    it('0x056A line carries an OVERRIDE marker', () => {
      const line = textSource.split('\n').find(l => l.includes('[0x056A]:'));
      expect(line).toBeDefined();
      expect(line).toMatch(/OVERRIDE/);
    });

    it('0x056E line carries an OVERRIDE marker', () => {
      const line = textSource.split('\n').find(l => l.includes('[0x056E]:'));
      expect(line).toBeDefined();
      expect(line).toMatch(/OVERRIDE/);
    });
  });
});
