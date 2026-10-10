/**
 * FAITHFUL.508 — No local "You are now level X!" echo from the
 *  PropertyInt(Level) update handler.
 *
 *  ACE `Player_Xp.cs:310-345` emits the canonical level-up
 *  GameMessageSystemChat alongside the PropertyInt(Level) update:
 *    "You are now level {Level}!\nYou have {N} experience points and
 *     {M} skill credits available to raise skills and attributes."
 *    (plus "You will earn another skill credit at level X." when
 *     applicable)
 *  At max level the line becomes "You have reached the maximum level
 *  of {Level}!"
 *
 *  Pre-fix our `onPrivateUpdatePropertyInt` for `Level` emitted a
 *  truncated local "You are now level X!" — duplicating the first line
 *  of the server's text AND clobbering the max-level variant.
 *
 *  Same anti-pattern as FAITHFUL.500-507. Trust the server.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const LEVEL_BLOCK = MAIN.match(/onPrivateUpdatePropertyInt:[\s\S]+?PropertyInt\.Level[\s\S]+?^        \}/m)?.[0] ?? '';

describe('FAITHFUL.508 — level-up local echo dropped', () => {
  it('Level branch was parsed (sanity check)', () => {
    expect(LEVEL_BLOCK.length).toBeGreaterThan(100);
  });

  it('no `You are now level X!` echo in the Level update handler', () => {
    expect(LEVEL_BLOCK).not.toMatch(/addSystemMessage\(`You are now level \$\{val\}!/);
  });

  it('playerState.level assignment still happens (HUD tracking)', () => {
    expect(LEVEL_BLOCK).toMatch(/playerState\.level = val/);
  });

  it('cites FAITHFUL.508 + ACE Player_Xp.cs', () => {
    expect(LEVEL_BLOCK).toMatch(/FAITHFUL\.508[\s\S]+?Player_Xp\.cs/);
  });
});
