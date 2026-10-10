/**
 * FAITHFUL.273 — Vitae penalty applied from authoritative server state
 * via the Vitae-flagged MagicUpdateEnchantment.
 *
 * Pre-fix the client's vitae penalty was set only by the solo-mode
 * fallback path (`playerState.vitae.applyDeath()` at main.ts:2136) and
 * never updated from the actual ACE-server signal. In ACE mode the
 * vitae HUD indicator + death-screen percentage stayed at 0% even
 * after real deaths. Per ACE Player_Death.InflictVitaePenalty +
 * EnchantmentManager.UpdateVitae, the server applies vitae via a
 * MagicUpdateEnchantment carrying SpellId.Vitae (=666) whose
 * `statModType` has the Vitae flag set in EnchantmentTypeFlags and
 * whose `statModValue` is the multiplier — 0.95 = 5% penalty,
 * 0.60 = 40% max. The wire parser already populates
 * EnchantmentData.isVitae for us.
 *
 * The fix wires the existing `isVitae` flag into the existing
 * `VitaeSystem` via a new `setVitaePenalty(penalty)` method, with
 * Math.min(MAX_VITAE) and Math.max(0) clamping so a malformed payload
 * can't drive the UI to negative or super-cap. Removal of the vitae
 * enchantment (full decay via XP) resets the penalty to 0 + drops the
 * HUD indicator.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { VitaeSystem } from '../packages/shared/src/systems/DeathSystem.js';

const REPO = resolve(__dirname, '..');
const DEATH_TS = readFileSync(resolve(REPO, 'packages/shared/src/systems/DeathSystem.ts'), 'utf-8');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.273 — vitae penalty applied from server enchantment', () => {
  describe('VitaeSystem.setVitaePenalty', () => {
    it('exists with correct signature', () => {
      const v = new VitaeSystem();
      expect(typeof v.setVitaePenalty).toBe('function');
    });

    it('writes the penalty when in valid range', () => {
      const v = new VitaeSystem();
      v.setVitaePenalty(0.05);
      expect(v.vitaePenalty).toBeCloseTo(0.05, 5);
    });

    it('clamps to MAX_VITAE = 0.40', () => {
      const v = new VitaeSystem();
      v.setVitaePenalty(0.99);
      expect(v.vitaePenalty).toBeCloseTo(0.40, 5);
    });

    it('clamps negative payloads to 0', () => {
      const v = new VitaeSystem();
      v.setVitaePenalty(-0.5);
      expect(v.vitaePenalty).toBe(0);
    });
  });

  describe('main.ts wiring', () => {
    it('onMagicUpdateEnchantment branches on enchantment.isVitae', () => {
      const block = MAIN_TS.match(/onMagicUpdateEnchantment: \(data\) => \{[\s\S]+?\n      \},/)?.[0] ?? '';
      expect(block).toContain('if (data.enchantment.isVitae)');
      expect(block).toContain('const penalty = 1.0 - data.enchantment.statModValue');
      expect(block).toContain('playerState.vitae.setVitaePenalty(penalty)');
      expect(block).toMatch(/setIndicatorActive\('vitae',\s*playerState\.vitae\.vitaePenalty > 0\)/);
      expect(block).toContain('syncFromPlayerState');
    });

    it('onMagicUpdateMultipleEnchantments (login bulk replay) handles isVitae too', () => {
      const block = MAIN_TS.match(/onMagicUpdateMultipleEnchantments: \(data\) => \{[\s\S]+?\n      \},/)?.[0] ?? '';
      expect(block).toContain('if (enchantment.isVitae)');
      expect(block).toContain('playerState.vitae.setVitaePenalty(penalty)');
      // syncFromPlayerState is called once after the loop (not per-enchantment).
      // Count actual call sites — `gameUI.syncFromPlayerState(`, not the
      // mention in the explanatory comment.
      const callMatches = (block.match(/gameUI\.syncFromPlayerState\(/g) ?? []).length;
      expect(callMatches).toBe(1);
    });

    it('onMagicRemoveEnchantment resets vitae when spellId === 666 (SpellId.Vitae)', () => {
      const block = MAIN_TS.match(/onMagicRemoveEnchantment: \(data\) => \{[\s\S]+?\n      \},/)?.[0] ?? '';
      expect(block).toContain('data.spellId === 666');
      expect(block).toContain('playerState.vitae.setVitaePenalty(0)');
      expect(block).toMatch(/setIndicatorActive\('vitae',\s*false\)/);
    });

    it('onMagicRemoveMultipleEnchantments resets vitae per-entry when spellId === 666', () => {
      const block = MAIN_TS.match(/onMagicRemoveMultipleEnchantments: \(data\) => \{[\s\S]+?\n      \},/)?.[0] ?? '';
      expect(block).toContain('e.spellId === 666');
      expect(block).toContain('playerState.vitae.setVitaePenalty(0)');
    });

    it('onMagicPurgeEnchantments PRESERVES vitae (CORE.5.b.a premise correction)', () => {
      // ACE sends PurgeEnchantments during the death sequence right AFTER
      // InflictVitaePenalty (Player_Death.cs:209-216), and its
      // RemoveAllEnchantments excludes vitae ("Removes all enchantments
      // except for vitae and item spells"). Retail client agrees:
      // CEnchantmentRegistry::PurgeEnchantments @ 00594de0 purges only
      // mult_list + add_list — the vitae slot survives. The pre-fix
      // handler zeroed the freshly applied penalty on every death.
      const block = MAIN_TS.match(/onMagicPurgeEnchantments: \(\) => \{[\s\S]+?\n      \},/)?.[0] ?? '';
      expect(block).not.toContain('playerState.vitae.setVitaePenalty(0)');
      expect(block).not.toMatch(/setIndicatorActive\('vitae',\s*false\)/);
      expect(block).toContain('gameUI.purgeEnchantments()');
    });

    it('penalty formula matches ACE convention: penalty = 1.0 - statModValue', () => {
      // The convention is anchored in ACE EnchantmentManager.UpdateVitae:
      // statModValue holds the MULTIPLIER (0.95 means 5% off), so
      // penalty = 1 - statModValue. This is the only correct mapping.
      expect(MAIN_TS).toMatch(/const penalty = 1\.0 - data\.enchantment\.statModValue/);
      expect(MAIN_TS).toMatch(/const penalty = 1\.0 - enchantment\.statModValue/);
    });

    it('setVitaePenalty exists in DeathSystem.ts with the right shape', () => {
      expect(DEATH_TS).toMatch(/setVitaePenalty\(penalty: number\): void/);
      expect(DEATH_TS).toMatch(/Math\.max\(0,\s*Math\.min\(MAX_VITAE,\s*penalty\)\)/);
    });
  });
});
