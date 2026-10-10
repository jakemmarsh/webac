/**
 * FAITHFUL.400 — Seed playerState from PlayerDescription propertiesInt
 *  at login.
 *
 * Pre-fix the PlayerDescription handler extracted only Heritage,
 * Gender, AvailableSkillCredits, PlayerKillerStatus, and EncumbranceVal
 * from `desc.propertiesInt`. Everything else stayed at the
 * playerState defaults until the first PrivateUpdatePropertyInt
 * arrived — and ACE only sends those on CHANGE, so unchanged values
 * stayed wrong for the entire session.
 *
 * Affected fields:
 *  - CoinValue → playerState.coinValue (HUD coin counter)
 *  - NumDeaths → playerState.numDeaths
 *  - VitaeCpPool → playerState.vitaeCpPool (vitae penalty bar)
 *  - ContainersCapacity → playerState.containersCapacity (pack slots)
 *  - ItemsCapacity → playerState.itemsCapacity
 *  - Age → playerState.ageSeconds (/age response)
 *  - Faction1Bits → playerState.faction1Bits (society panel)
 *  - SocietyRankCelhan → playerState.societyRankCelhan
 *  - EncumbranceCapacity → playerState.serverEncumbranceCapacity (mirror
 *    only since STATS.burden-capacity-augs-buffs)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('PlayerDescription seeds playerState fields (FAITHFUL.400)', () => {
  // Pull the block that extracts initial values.
  const block = MAIN.match(/FAITHFUL\.400[\s\S]+?playerState\.serverEncumbranceCapacity = initialEncCap[\s\S]+?\}/)?.[0] ?? '';

  const seeds: Array<[string, string]> = [
    ['CoinValue', 'playerState.coinValue'],
    ['NumDeaths', 'playerState.numDeaths'],
    ['VitaeCpPool', 'playerState.vitaeCpPool'],
    ['ContainersCapacity', 'playerState.containersCapacity'],
    ['ItemsCapacity', 'playerState.itemsCapacity'],
    ['Age', 'playerState.ageSeconds'],
    ['Faction1Bits', 'playerState.faction1Bits'],
    ['SocietyRankCelhan', 'playerState.societyRankCelhan'],
    ['EncumbranceCapacity', 'playerState.serverEncumbranceCapacity'],
  ];

  for (const [propKey, stateField] of seeds) {
    it(`reads PropertyInt.${propKey} → ${stateField}`, () => {
      expect(block).toMatch(new RegExp(`PropertyInt\\.${propKey}`));
      expect(block).toMatch(new RegExp(stateField.replace('.', '\\.')));
    });
  }

  it('positive-value guards on capacity fields (avoid stomping default with 0)', () => {
    // ContainersCapacity / ItemsCapacity / EncumbranceCapacity should
    // only overwrite when the server sent a positive value, since 0
    // would un-equip the player's pack slots.
    expect(block).toMatch(/initialContainers !== undefined && initialContainers > 0/);
    expect(block).toMatch(/initialItems !== undefined && initialItems > 0/);
    expect(block).toMatch(/initialEncCap !== undefined && initialEncCap > 0/);
  });

  // STATS.burden-capacity-augs-buffs — the old "EncumbranceCapacity path also
  // updates gameUI.setBurden" pin is retired: the server's EncumbranceCapacity
  // is a one-off augmentation-time snapshot (ACE AugmentationDevice.cs:122-123,
  // not [SendOnLogin]) that retail never reads (CACQualities::InqLoad @
  // 0058f130), so it is mirrored only and no longer drives the burden bar.
  // The capacity behaviour is asserted against the real PlayerState /
  // InventoryController in tests/verify-stats-buffed-stats.ts.

  it('cites FAITHFUL.400 in the docblock', () => {
    expect(MAIN).toMatch(/FAITHFUL\.400/);
  });
});
