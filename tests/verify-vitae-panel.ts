/**
 * CORE.5.b.a — the EoL Vitae panel (gmVitaeUI, element class 0x10000020,
 * layout 0x21000020) text builder.
 *
 * Ground truth (reference/client-eol build ac1_sep13):
 *   gmVitaeUI::Update @ 004a7400 —
 *     vitae full  → ID_Vitae_Text_Full
 *     penalty     → ID_Vitae_Text_Vitae + ID_Vitae_Text_Skills +
 *                   ID_Vitae_Text_Experience, where the XP variable is
 *                   VitaeSystem::VitaeCPPoolThreshold(vitae, level) −
 *                   InqInt(0x81 VitaeCpPool); level = InqInt(0x8b DeathLevel)
 *                   falling back to InqInt(0x19 Level).
 *   VitaeSystem::VitaeCPPoolThreshold @ 005c8fd0 == ACE Player_Xp.cs:433:
 *     (level^2.5 * 2.5 + 20) * vitae^5 + 0.5, (int)-truncated by callers.
 *
 * String ids resolved from client_local_English.dat StringTable 0x23000001,
 * and independently confirmed: acStringHash("ID_Vitae_Text_*") — the retail
 * client's compute_str_hash of the decompiled symbolic tokens — equals the
 * DAT entry ids used here.
 *
 * These tests drive the REAL shipped builder (buildVitaePanelText et al.),
 * both through its built-in verbatim-DAT fallbacks and through registered
 * string-table fragments (the same interleave pipeline the panel uses at
 * runtime with the live DAT).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { acStringHash, registerStringTable } from '@ac/dat-parser/file-types/LayoutDesc.js';
import type { StringTableData } from '@ac/dat-parser/file-types/LayoutDesc.js';
import {
  buildVitaePanelText, vitaePenaltyPercent, vitaeXpRemaining, VITAE_STRING_IDS,
} from '@ac/renderer/ui/VitaePanelText.js';
import { vitaeCpPoolThreshold } from '@ac/shared';

// ─── String ids: decompiled symbolic tokens ↔ DAT entry ids ──────────────
describe('CORE.5.b.a — vitae string ids match retail compute_str_hash', () => {
  it('ID_Vitae_Text_* tokens hash to the StringTable 0x23000001 entry ids', () => {
    expect(acStringHash('ID_Vitae_Text_Full')).toBe(VITAE_STRING_IDS.full);
    expect(acStringHash('ID_Vitae_Text_Vitae')).toBe(VITAE_STRING_IDS.vitae);
    expect(acStringHash('ID_Vitae_Text_Skills')).toBe(VITAE_STRING_IDS.skills);
    expect(acStringHash('ID_Vitae_Text_Experience')).toBe(VITAE_STRING_IDS.experience);
  });
});

// ─── Percentage + XP-remaining math (retail Update / ACE threshold) ──────
describe('CORE.5.b.a — vitae panel math', () => {
  it('vitaePenaltyPercent rounds the float32 5% penalty to 5, not 6', () => {
    // Server sends multiplier as float32: 0.95f = 0.949999988... →
    // penalty = 0.0500000119...; the panel must show 5%.
    const statModValue = Math.fround(0.95);
    expect(vitaePenaltyPercent(1 - statModValue)).toBe(5);
  });

  it('vitaePenaltyPercent covers the 40% cap', () => {
    expect(vitaePenaltyPercent(1 - Math.fround(0.60))).toBe(40);
  });

  it('vitaeXpRemaining = trunc(threshold(vitae, deathLevel)) − pool', () => {
    const s = { vitaePenalty: 1 - Math.fround(0.95), vitaeCpPool: 100, deathLevel: 20, level: 21 };
    const expected = Math.trunc(vitaeCpPoolThreshold(1 - s.vitaePenalty, 20)) - 100;
    expect(vitaeXpRemaining(s)).toBe(expected);
    // ACE formula spot-check: (20^2.5*2.5+20)*0.95^5+0.5
    expect(vitaeCpPoolThreshold(0.95, 20)).toBeCloseTo(
      (Math.pow(20, 2.5) * 2.5 + 20) * Math.pow(0.95, 5) + 0.5, 6);
  });

  it('falls back to Level when DeathLevel is unset (retail InqInt 0x8b → 0x19)', () => {
    const withDeath = vitaeXpRemaining({ vitaePenalty: 0.05, vitaeCpPool: 0, deathLevel: 10, level: 50 });
    const fallback = vitaeXpRemaining({ vitaePenalty: 0.05, vitaeCpPool: 0, deathLevel: 0, level: 50 });
    expect(withDeath).toBe(Math.trunc(vitaeCpPoolThreshold(0.95, 10)));
    expect(fallback).toBe(Math.trunc(vitaeCpPoolThreshold(0.95, 50)));
  });

  it('never returns a negative XP remaining', () => {
    expect(vitaeXpRemaining({ vitaePenalty: 0.05, vitaeCpPool: 10_000_000, deathLevel: 5, level: 5 })).toBe(0);
  });
});

// ─── Body text via built-in verbatim-DAT fallbacks (no tables loaded) ────
describe('CORE.5.b.a — panel text (fallback fragments)', () => {
  it('full-strength text matches ID_Vitae_Text_Full verbatim', () => {
    const text = buildVitaePanelText({ vitaePenalty: 0, vitaeCpPool: 0, deathLevel: 0, level: 10 });
    expect(text).toBe('Your Vitae, or life force, is at full strength.');
  });

  it('penalty text interleaves both percentages and the XP figure', () => {
    const s = { vitaePenalty: 1 - Math.fround(0.95), vitaeCpPool: 0, deathLevel: 20, level: 20 };
    const xp = vitaeXpRemaining(s); // trunc((20^2.5*2.5+20)*0.95^5+0.5) = 3476
    const text = buildVitaePanelText(s);
    expect(xp).toBe(3476);
    expect(text).toContain('Due to your recent death, you have temporarily lost 5% of your Vitae, or life force.');
    expect(text).toContain('your health, stamina, mana, and skills are temporarily reduced by 5%.');
    expect(text).toContain('You will regain 1% of your Vitae once you earn 3,476 more experience.');
    // Retail appends the three StringInfos in this exact order.
    expect(text.indexOf('Due to your recent death'))
      .toBeLessThan(text.indexOf('This means that your health'));
    expect(text.indexOf('This means that your health'))
      .toBeLessThan(text.indexOf('You will regain 1%'));
  });

  it('comma-groups the XP figure (retail PStringBase::InsertCommas)', () => {
    // Level 100 death, fresh 5% vitae: trunc((100^2.5*2.5+20)*0.95^5+0.5)
    const s = { vitaePenalty: 1 - Math.fround(0.95), vitaeCpPool: 0, deathLevel: 100, level: 100 };
    const text = buildVitaePanelText(s);
    const expected = Math.trunc(vitaeCpPoolThreshold(Math.fround(0.95), 100));
    expect(text).toContain(`${expected.toLocaleString('en-US')} more experience.`);
    expect(expected).toBeGreaterThan(100_000); // ensures a comma actually appears
    expect(text).toMatch(/\d{1,3}(,\d{3})+ more experience\./);
  });
});

// ─── Body text via registered string-table fragments (DAT pipeline) ──────
describe('CORE.5.b.a — panel text (registered StringTable fragments)', () => {
  beforeAll(() => {
    // The real 0x23000001 fragment lists, registered under their real ids —
    // exercises the getStringParts interleave path the live client uses.
    const TABLE: StringTableData = {
      id: 0x23000001,
      language: 1,
      entries: [
        { id: VITAE_STRING_IDS.full, varNames: [], vars: [],
          strings: ['Your Vitae, or life force, is at full strength.'], comments: [], unknown: 0 },
        { id: VITAE_STRING_IDS.vitae, varNames: [], vars: [],
          strings: ['Due to your recent death, you have temporarily lost ', '% of your Vitae, or life force.'], comments: [], unknown: 0 },
        { id: VITAE_STRING_IDS.skills, varNames: [], vars: [],
          strings: ['\\n\\nThis means that your health, stamina, mana, and skills are temporarily reduced by ', '%.  A reduction of less than 15% will not hinder you much, but beware losing much more than that.'], comments: [], unknown: 0 },
        { id: VITAE_STRING_IDS.experience, varNames: [], vars: [],
          strings: ['\\n\\nYou will regain 1% of your Vitae once you earn ', ' more experience.'], comments: [], unknown: 0 },
      ],
    } as unknown as StringTableData;
    registerStringTable(TABLE);
  });

  it('builds the identical assembled body from table fragments', () => {
    const s = { vitaePenalty: 1 - Math.fround(0.95), vitaeCpPool: 476, deathLevel: 20, level: 20 };
    const text = buildVitaePanelText(s);
    expect(text).toBe(
      'Due to your recent death, you have temporarily lost 5% of your Vitae, or life force.' +
      '\n\nThis means that your health, stamina, mana, and skills are temporarily reduced by 5%.' +
      '  A reduction of less than 15% will not hinder you much, but beware losing much more than that.' +
      '\n\nYou will regain 1% of your Vitae once you earn 3,000 more experience.',
    );
  });

  it('full-strength text still resolves through the table', () => {
    const text = buildVitaePanelText({ vitaePenalty: 0, vitaeCpPool: 0, deathLevel: 0, level: 1 });
    expect(text).toBe('Your Vitae, or life force, is at full strength.');
  });
});
