/**
 * Gender map fix (FAITHFUL.279).
 *
 * GameUI.ts syncFromPlayerState() rendered the character panel's gender
 * field via a hardcoded `genderMap: Record<number, string>`. Pre-fix:
 *   { 0: 'Female', 1: 'Male' }
 *
 * That was wrong against ACE Gender.cs (Invalid=0, Male=1, Female=2):
 *   - value 0 (Invalid) → labeled 'Female' (wrong)
 *   - value 1 (Male) → labeled 'Male' (correct by accident)
 *   - value 2 (Female) → no entry → 'Unknown' fallback
 *
 * So EVERY female character displayed as "Unknown" on the char panel.
 * This is the highest-impact fidelity bug a player would notice on the
 * very first frame after login.
 *
 * Wire confirmation: main.ts:4318 and main.ts:4493 set
 *   `playerState.gender = val` directly from PropertyInt.Gender,
 * which carries the ACE Gender enum value verbatim (no remap).
  *
 * DEBT.test-harness-hygiene: the genderMap pins are behavioural — the real
 * GameUI.syncFromPlayerState turns a real PlayerState's gender into charInfo.gender.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Gender } from '@ac/shared';
import { PlayerState } from '../packages/renderer/src/player/PlayerState.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const REPO = resolve(__dirname, '..');
const ACE_ENUM = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/Gender.cs');

describe('Gender enum (FAITHFUL.279)', () => {
  it('matches ACE Gender.cs numeric values', () => {
    expect(Gender.Invalid).toBe(0);
    expect(Gender.Male).toBe(1);
    expect(Gender.Female).toBe(2);
  });
});

describe.skipIf(!aceReferenceExists(ACE_ENUM))('ACE source faithfulness', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_ENUM, 'utf8');
  });
  it('ACE Gender.cs has Invalid=0, Male=1, Female=2', () => {
    expect(src).toMatch(/Invalid\s*=\s*0/);
    expect(src).toMatch(/Male\s*=\s*1/);
    expect(src).toMatch(/Female\s*=\s*2/);
  });
});

describe('GameUI gender display (FAITHFUL.279, behavioural)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H.teardown());

  function genderLabel(gender: number): string {
    const state = new PlayerState();
    state.gender = gender;
    H.ui.syncFromPlayerState(state);
    return H.ui.charInfo.gender;
  }

  it('Male (1) displays as "Male" — the inverted pre-fix map showed it for 1 only by accident', () => {
    expect(genderLabel(Gender.Male)).toBe('Male');
  });

  it('a Female player (gender=2) displays "Female", no longer the "Unknown" fallback', () => {
    expect(genderLabel(Gender.Female)).toBe('Female');
  });

  it('Invalid (0) is NOT Female (the pre-fix { 0: \'Female\' } literal) — it falls back to "Unknown"', () => {
    expect(genderLabel(Gender.Invalid)).toBe('Unknown');
  });
});
