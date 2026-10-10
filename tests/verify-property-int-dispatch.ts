/**
 * FAITHFUL.225 — onPrivateUpdatePropertyInt routes server-tracked totals.
 *
 * ACE emits PrivateUpdatePropertyInt for many PropertyInt keys; pre-fix
 * the client handled only Level / EncumbranceVal / TotalSkillCredits /
 * AvailableSkillCredits / HeritageGroup / Gender / CombatMode and just
 * console.log'd everything else. Several user-visible totals were dropped:
 *
 *   PropertyInt.CoinValue (20)             — pyreals total, sent by
 *                                            Player_Commerce on every change
 *   PropertyInt.NumDeaths (43)             — death counter, sent on death
 *   PropertyInt.EncumbranceCapacity (96)   — mirrored only (see below)
 *   PropertyInt.VitaeCpPool (129)          — current vitae penalty pool
 *
 * This test pins the dispatch wiring against future regressions where the
 * cases get accidentally dropped during a refactor.
 *
 * Reference: reference/ACE/Source/ACE.Server/WorldObjects/Player_Commerce.cs
 *            reference/ACE/Source/ACE.Server/WorldObjects/Player_Death.cs
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PropertyInt } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.225 — PrivateUpdatePropertyInt routes server totals', () => {
  it('PropertyInt.CoinValue updates playerState.coinValue', () => {
    expect(MAIN_TS).toMatch(/PropertyInt\.CoinValue[\s\S]{0,500}playerState\.coinValue\s*=/);
  });

  it('PropertyInt.NumDeaths updates playerState.numDeaths', () => {
    expect(MAIN_TS).toMatch(/PropertyInt\.NumDeaths[\s\S]{0,500}playerState\.numDeaths\s*=/);
  });

  it('PropertyInt.VitaeCpPool updates playerState.vitaeCpPool', () => {
    expect(MAIN_TS).toMatch(/PropertyInt\.VitaeCpPool[\s\S]{0,500}playerState\.vitaeCpPool\s*=/);
  });

  // STATS.burden-capacity-augs-buffs — retired pin: PropertyInt.
  // EncumbranceCapacity is ACE's one-off augmentation-time snapshot
  // (AugmentationDevice.cs:122-123) that retail never reads (CACQualities::
  // InqLoad @ 0058f130 recomputes from enchanted Strength), so it no longer
  // sets the capacity. The recomputed capacity is asserted behaviourally
  // against PlayerState / InventoryController in verify-stats-buffed-stats.ts.

  it('PropertyInt key numeric values match ACE source', () => {
    expect(PropertyInt.CoinValue).toBe(20);
    expect(PropertyInt.NumDeaths).toBe(43);
    expect(PropertyInt.EncumbranceCapacity).toBe(96);
    expect(PropertyInt.VitaeCpPool).toBe(129);
  });

  // FAITHFUL.229 — augmentation pack/inventory slots + character age
  it('PropertyInt.ContainersCapacity updates playerState.containersCapacity', () => {
    expect(MAIN_TS).toMatch(/PropertyInt\.ContainersCapacity[\s\S]{0,200}playerState\.containersCapacity\s*=/);
    expect(PropertyInt.ContainersCapacity).toBe(7);
  });

  it('PropertyInt.ItemsCapacity updates playerState.itemsCapacity', () => {
    expect(MAIN_TS).toMatch(/PropertyInt\.ItemsCapacity[\s\S]{0,200}playerState\.itemsCapacity\s*=/);
    expect(PropertyInt.ItemsCapacity).toBe(6);
  });

  it('PropertyInt.Age updates playerState.ageSeconds', () => {
    expect(MAIN_TS).toMatch(/PropertyInt\.Age[\s\S]{0,200}playerState\.ageSeconds\s*=/);
    expect(PropertyInt.Age).toBe(125);
  });

  // FAITHFUL.233 — Faction1Bits + 3 society ranks
  it('PropertyInt.Faction1Bits updates playerState.faction1Bits', () => {
    expect(MAIN_TS).toMatch(/PropertyInt\.Faction1Bits[\s\S]{0,200}playerState\.faction1Bits\s*=/);
    expect(PropertyInt.Faction1Bits).toBe(281);
  });

  it('PropertyInt.SocietyRankCelhan updates playerState.societyRankCelhan', () => {
    expect(MAIN_TS).toMatch(/PropertyInt\.SocietyRankCelhan[\s\S]{0,200}playerState\.societyRankCelhan\s*=/);
    expect(PropertyInt.SocietyRankCelhan).toBe(287);
  });

  it('PropertyInt.SocietyRankEldweb updates playerState.societyRankEldweb', () => {
    expect(MAIN_TS).toMatch(/PropertyInt\.SocietyRankEldweb[\s\S]{0,200}playerState\.societyRankEldweb\s*=/);
    expect(PropertyInt.SocietyRankEldweb).toBe(288);
  });

  it('PropertyInt.SocietyRankRadblo updates playerState.societyRankRadblo', () => {
    expect(MAIN_TS).toMatch(/PropertyInt\.SocietyRankRadblo[\s\S]{0,200}playerState\.societyRankRadblo\s*=/);
    expect(PropertyInt.SocietyRankRadblo).toBe(289);
  });

  // FAITHFUL.234 — additional server-tracked totals (11 keys)
  describe('FAITHFUL.234 — additional server-tracked totals', () => {
    const FIELDS: Array<{ key: keyof typeof PropertyInt; field: string; value: number }> = [
      { key: 'AllegianceRank',          field: 'allegianceRank',          value: 30  },
      { key: 'AdvocateLevel',           field: 'advocateLevel',           value: 112 },
      { key: 'DeathLevel',              field: 'deathLevel',              value: 139 },
      { key: 'ChessRank',               field: 'chessRank',               value: 181 },
      { key: 'ChessTotalGames',         field: 'chessTotalGames',         value: 182 },
      { key: 'ChessGamesWon',           field: 'chessGamesWon',           value: 183 },
      { key: 'ChessGamesLost',          field: 'chessGamesLost',          value: 184 },
      { key: 'HousePurchaseTimestamp',  field: 'housePurchaseTimestamp',  value: 199 },
      { key: 'AetheriaBitfield',        field: 'aetheriaBitfield',        value: 322 },
      { key: 'GearMaxHealth',           field: 'gearMaxHealth',           value: 379 },
      { key: 'Enlightenment',           field: 'enlightenment',           value: 390 },
      // FAITHFUL.235 — Luminance Augmentation ratings
      { key: 'LumAugDamageRating',          field: 'lumAugDamageRating',          value: 333 },
      { key: 'LumAugDamageReductionRating', field: 'lumAugDamageReductionRating', value: 334 },
      { key: 'LumAugCritDamageRating',      field: 'lumAugCritDamageRating',      value: 335 },
      { key: 'LumAugCritReductionRating',   field: 'lumAugCritReductionRating',   value: 336 },
      { key: 'LumAugSurgeEffectRating',     field: 'lumAugSurgeEffectRating',     value: 337 },
      { key: 'LumAugSurgeChanceRating',     field: 'lumAugSurgeChanceRating',     value: 338 },
      { key: 'LumAugItemManaUsage',         field: 'lumAugItemManaUsage',         value: 339 },
      { key: 'LumAugItemManaGain',          field: 'lumAugItemManaGain',          value: 340 },
      { key: 'LumAugVitality',              field: 'lumAugVitality',              value: 341 },
      { key: 'LumAugHealingRating',         field: 'lumAugHealingRating',         value: 342 },
      { key: 'LumAugSkilledCraft',          field: 'lumAugSkilledCraft',          value: 343 },
      { key: 'LumAugSkilledSpec',           field: 'lumAugSkilledSpec',           value: 344 },
      { key: 'LumAugNoDestroyCraft',        field: 'lumAugNoDestroyCraft',        value: 345 },
      { key: 'LumAugAllSkills',             field: 'lumAugAllSkills',             value: 365 },
    ];
    for (const { key, field, value } of FIELDS) {
      it(`PropertyInt.${key} (${value}) updates playerState.${field}`, () => {
        // Match the dispatch line via a regex that requires both the
        // property name and the matching playerState field within close range.
        const pattern = new RegExp(`PropertyInt\\.${key}[\\s\\S]{0,200}playerState\\.${field}\\s*=`);
        expect(MAIN_TS).toMatch(pattern);
        expect((PropertyInt as unknown as Record<string, number>)[key]).toBe(value);
      });
    }
  });
});
