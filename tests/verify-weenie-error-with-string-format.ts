/**
 * FAITHFUL.341 — WeenieErrorWithString event substitutes the wire-format
 * value into the canonical AC client template.
 *
 * ACE `GameEventWeenieErrorWithString.cs:11` ships ONLY the substitution
 * value (typically a player or skill name) — the original AC client
 * looked up the template by errorType in its baked-in string table and
 * inserted the value at each `_` placeholder. Pre-FAITHFUL.341 the
 * consumer at `main.ts onWeenieErrorWithString` rendered bare
 * `data.message`, so error lines like:
 *   "Bob is too busy to accept gifts right now."
 * rendered as just "Bob" — losing the entire sentence.
 *
 * Templates in `WEENIE_ERROR_WITH_STRING_TEXT` (113 entries — see
 * `packages/shared/src/combat/WeenieErrorWithStringText.ts`) carry one or
 * more `_` placeholders per ACE source `<summary>` documentation. All
 * occurrences are replaced with the same value.
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { findGnuObjdump } from '../tools/lib/gnu-objdump.ts';
import {
  WeenieErrorWithString,
  WEENIE_ERROR_WITH_STRING_TEXT,
  formatWeenieErrorWithString,
} from '@ac/shared';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('formatWeenieErrorWithString substitutes ALL `_` placeholders (FAITHFUL.341)', () => {
  it('single-`_` template: "_ is too busy to accept gifts right now."', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString._IsTooBusyToAcceptGifts, 'Bob');
    expect(out).toBe('Bob is too busy to accept gifts right now.');
  });

  it('multi-`_` template: "_ ... _ is not a player killer!" (both filled)', () => {
    // YouFailToAffect_TheyAreNotPK = 0x0052
    //   template: "You fail to affect _ because _ is not a player killer!"
    const out = formatWeenieErrorWithString(WeenieErrorWithString.YouFailToAffect_TheyAreNotPK, 'Drudge');
    expect(out).toBe('You fail to affect Drudge because Drudge is not a player killer!');
  });

  it('substitutes a skill name correctly into "Your _ skill must be trained..."', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString.Your_SkillMustBeTrained, 'Heavy Weapons');
    expect(out).toBe('Your Heavy Weapons skill must be trained, not untrained or specialized, in order to be altered in this way!');
  });

  it('falls back to the raw value when no template is mapped', () => {
    // Pick a code not in the enum range.
    expect(formatWeenieErrorWithString(0xFFFE as number, 'Custom message')).toBe('Custom message');
  });

  it('handles empty-string substitution gracefully', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString._IsTooBusyToAcceptGifts, '');
    expect(out).toBe(' is too busy to accept gifts right now.');
  });

  it('templates have at least one `_` (sanity — codes mapped without one would be buggy)', () => {
    // Spot-check a few. The codes with no underscore are intentionally
    // sentence-only (e.g. NotEnoughSkillCreditsToSpecialize 0x04D2 — but
    // that one does have an `_`). Audit a sampling of known-`_`-carrying
    // codes.
    const codes = [0x001E, 0x002B, 0x0488, 0x0489, 0x048B, 0x04D1];
    for (const c of codes) {
      expect(WEENIE_ERROR_WITH_STRING_TEXT[c]).toContain('_');
    }
  });
});

// RECON.weenie-error-templates — every template checked against the retail
// client's literals in ClientCommunicationSystem::HandleFailureEvent @ 00571990
// (tools/check-weenie-error-templates.ts). These six were wrong: the spacing
// heuristic read retail's two-space sentence break as a stripped `_`, or kept
// the ACE <summary>'s quotes / a stray `_`.
describe('templates match the retail HandleFailureEvent literals (RECON.weenie-error-templates)', () => {
  it('0x04D5: two placeholders and two-space sentence breaks, no extra `_`', () => {
    expect(formatWeenieErrorWithString(WeenieErrorWithString.CannotLowerSkillWhileWieldingItem, 'Sword')).toBe(
      'You are currently wielding items which require a certain level of Sword.  Your Sword skill cannot be lowered while you are wielding these items.  Please remove these items and try again.',
    );
  });

  it('0x0510 / 0x0514 / 0x0515: hook-limit lines fill exactly two slots', () => {
    expect(formatWeenieErrorWithString(WeenieErrorWithString.MaxNumberOf_Hooked, 'trophies')).toBe(
      'You may not hook any more trophies on your house.  You already have the maximum number of trophies hooked or you are not permitted to hook any on your type of house.',
    );
    expect(formatWeenieErrorWithString(WeenieErrorWithString.MaxNumberOf_HookedUntilOneIsRemoved, 'trophies')).toBe(
      'You now have the maximum number of trophies hooked.  You cannot hook any additional trophies until you remove one or more from your house.',
    );
    expect(formatWeenieErrorWithString(WeenieErrorWithString.NoLongerMaxNumberOf_Hooked, 'trophies')).toBe(
      'You no longer have the maximum number of trophies hooked.  You may hook additional trophies.',
    );
  });

  it("0x04E9: the value goes only after 'The', not before '@house hooks on'", () => {
    expect(formatWeenieErrorWithString(WeenieErrorWithString.ItemUnusableOnHook_CanOpen, 'Chest')).toBe(
      "The Chest cannot be used while on a hook, use the '@house hooks on' command to make the hook openable.",
    );
  });

  it('0x04BF: no quotes, and an empty value reads "item" as in retail', () => {
    expect(formatWeenieErrorWithString(WeenieErrorWithString.The_WasNotSuitableForSalvaging, 'Gold Ring')).toBe(
      'The Gold Ring was not suitable for salvaging.',
    );
    expect(formatWeenieErrorWithString(WeenieErrorWithString.The_WasNotSuitableForSalvaging, '')).toBe(
      'The item was not suitable for salvaging.',
    );
    // The fallback belongs to that arm alone.
    expect(formatWeenieErrorWithString(WeenieErrorWithString.The_ContainseTheWrongMaterial, '')).toBe(
      'The  contains the wrong material.',
    );
  });

  it('no template keeps a heuristic artifact: a `_` standing alone after a sentence end', () => {
    for (const [code, t] of Object.entries(WEENIE_ERROR_WITH_STRING_TEXT)) {
      expect(t, `0x${Number(code).toString(16)}`).not.toMatch(/[.!?] _ /);
      expect(t, `0x${Number(code).toString(16)}`).not.toMatch(/_'@/);
      expect(t, `0x${Number(code).toString(16)}`).not.toMatch(/^".*"$/);
    }
  });

  const exe = resolve(REPO, 'reference/client-eol/acclient.exe');
  it('the checker only accepts GNU objdump (macOS objdump is LLVM, which it cannot parse)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'objdump-'));
    const fake = (name: string, banner: string) => {
      const p = resolve(dir, name);
      writeFileSync(p, `#!/bin/sh\necho '${banner}'\n`);
      chmodSync(p, 0o755);
      return p;
    };
    const llvm = fake('objdump', 'Apple LLVM version 15.0.0\n  Optimized build.');
    const gnu = fake('gobjdump', 'GNU objdump (GNU Binutils) 2.43');
    expect(findGnuObjdump([llvm])).toBeUndefined();
    expect(findGnuObjdump([llvm, gnu])).toBe(gnu);
    expect(findGnuObjdump([resolve(dir, 'missing')])).toBeUndefined();
  });

  // GNU objdump only: macOS's `objdump` is LLVM's, whose syntax the checker cannot parse.
  const objdump = findGnuObjdump() !== undefined;
  describe.skipIf(!existsSync(exe) || !objdump)('against the retail binary (needs reference/client-eol)', () => {
    it('all 113 templates equal the literal their HandleFailureEvent arm prints', () => {
      const out = execFileSync('npx', ['tsx', resolve(REPO, 'tools/check-weenie-error-templates.ts')], { cwd: REPO, encoding: 'utf8' });
      expect(out).toContain('113/113 templates match retail');
    }, 60_000);
  });
});

describe('main.ts onWeenieErrorWithString routes through the new formatter (FAITHFUL.341)', () => {
  it('imports formatWeenieErrorWithString from @ac/shared', () => {
    expect(MAIN).toMatch(/formatWeenieErrorWithString[\s\S]*?from '@ac\/shared'/);
  });

  it('handler body calls formatWeenieErrorWithString(data.errorType, data.message)', () => {
    expect(MAIN).toMatch(/onWeenieErrorWithString:[\s\S]*?formatWeenieErrorWithString\(data\.errorType,\s*data\.message\)/);
  });

  it('does NOT regress to rendering bare data.message', () => {
    const block = MAIN.match(/onWeenieErrorWithString:[\s\S]+?^      \},/m)?.[0] ?? '';
    // Strip comments so the FAITHFUL.341 docblock that quotes the
    // pre-fix call doesn't poison the regex.
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/addSystemMessage\(data\.message,/);
  });
});
