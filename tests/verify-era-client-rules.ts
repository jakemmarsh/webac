/**
 * MOVE.combination-sweep (era research) — the per-era client-code rules
 * (era/EraFeatures.ts eraClientRules): end of retail and every classic era
 * run the end-of-retail acclient.exe, whose cast and attack requests call
 * MaybeStopCompletely (CastSpell @ 00568040, StartAttackRequest @ 0056c040);
 * the 1999 client.exe never stops on a cast (PanelUI_FreeHandsAndCastSpell
 * @ 0x4fecc0) and always stops on an attack request
 * (PanelUI_StartAttackRequest @ 0x4f8850 → StopCompletely).
 */
import { describe, expect, it } from 'vitest';
import { ERA_PROFILES, eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';

describe('eraClientRules', () => {
  it('end of retail and the classic eras: a cast stops the player, an attack only when the player is its own', () => {
    for (const id of ['eor', 'classicace-customdm', 'classicace-infiltration', 'classic-dereth']) {
      expect(eraClientRules(eraProfile(id))).toEqual({ castStopsMovement: true, attackStopsAlways: false });
    }
    expect(eraClientRules(null)).toEqual({ castStopsMovement: true, attackStopsAlways: false });
  });

  it('1999: a cast never stops the player (run-casting), an attack always does', () => {
    expect(eraClientRules(eraProfile('ac1999-retail'))).toEqual({ castStopsMovement: false, attackStopsAlways: true });
  });

  it('every era profile has rules', () => {
    for (const p of Object.values(ERA_PROFILES)) expect(typeof eraClientRules(p).castStopsMovement).toBe('boolean');
  });
});
