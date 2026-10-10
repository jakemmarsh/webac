/**
 * FAITHFUL.236 — onPrivateUpdatePropertyInt64 routes Luminance + ItemTotalXp.
 *
 * Sister to verify-property-int-dispatch.ts. Pre-fix, only TotalExperience
 * and AvailableExperience were routed; AvailableLuminance / MaximumLuminance
 * / ItemTotalXp were logged but dropped — char panel displayed stale Lum.
 *
 * Reference: ACE.Server emit sites:
 *   `new GameMessagePrivateUpdatePropertyInt64(player, PropertyInt64.X, val)`
 *   for X in {AvailableLuminance, MaximumLuminance, ItemTotalXp, ...}.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyInt64 } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.236 — PrivateUpdatePropertyInt64 routes Luminance + ItemTotalXp', () => {
  const FIELDS: Array<{ key: keyof typeof PropertyInt64; field: string; value: number }> = [
    { key: 'ItemTotalXp',         field: 'itemTotalXp',         value: 4 },
    { key: 'AvailableLuminance',  field: 'availableLuminance',  value: 6 },
    { key: 'MaximumLuminance',    field: 'maximumLuminance',    value: 7 },
  ];

  for (const { key, field, value } of FIELDS) {
    it(`PropertyInt64.${key} (${value}) updates playerState.${field}`, () => {
      const pattern = new RegExp(`PropertyInt64\\.${key}[\\s\\S]{0,200}playerState\\.${field}\\s*=`);
      expect(MAIN_TS).toMatch(pattern);
      expect((PropertyInt64 as unknown as Record<string, number>)[key]).toBe(value);
    });
  }

  it('existing TotalExperience / AvailableExperience dispatch preserved', () => {
    // FAITHFUL.589 added an in-line floating-XP-delta computation between
    // the PropertyInt64.TotalExperience case and the playerState.totalXp
    // assignment, so the distance widened from ~200 to ~1500 chars.
    expect(MAIN_TS).toMatch(/PropertyInt64\.TotalExperience[\s\S]{0,1500}playerState\.totalXp\s*=/);
    expect(MAIN_TS).toMatch(/PropertyInt64\.AvailableExperience[\s\S]{0,200}playerState\.availableXp\s*=/);
  });
});
