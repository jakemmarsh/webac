/**
 * FAITHFUL.377 — PrivateUpdatePropertyFloat for HealthRate (3),
 *  StaminaRate (4), ManaRate (5) updates the live regen rate.
 *
 * ACE Entity/CreatureVital.cs:35-46 sources `RegenRate` from these exact
 * PropertyFloat keys. VitalSystem keeps the server value per vital
 * (setRegenRate) and getRegenRate prefers it.
 *
 * STATS.regen-prediction-diverges — the prediction itself
 * (getRegenPerTick / regenTick) now reads getRegenRate; before, it read a
 * private constant table, so a server-sent rate changed nothing. The
 * unset fallback is the player weenies' HealthRate 0.3 / StaminaRate 3 /
 * ManaRate 1 (ACE-World 00001 Clay.sql:31-33 — the rates are not
 * [SendOnLogin], PropertyFloat.cs:14-17), not the invented 1 / 2 / 1.
 * The former source-text pins on VitalSystem.ts are converted to the
 * behavioural checks below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AttributeSystem } from '../packages/shared/src/character/AttributeSystem.js';
import { VitalSystem, VitalId, RegenStance, REGEN_INTERVAL } from '../packages/shared/src/character/VitalSystem.js';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

// Str 10 / End 80: Str + 2*End = 170 <= 200, so the health attribute mod is 1.0.
const attrs = (): AttributeSystem => new AttributeSystem({
  strength: 10, endurance: 80, coordination: 10, quickness: 10, focus: 10, self: 80,
});

describe('VitalSystem live regen-rate state (FAITHFUL.377)', () => {
  it('getRegenRate returns the live value when set', () => {
    const vs = new VitalSystem();
    expect(vs.getRegenRate(VitalId.Health)).toBe(0.3); // player-weenie fallback
    vs.setRegenRate(VitalId.Health, 7.5);
    expect(vs.getRegenRate(VitalId.Health)).toBe(7.5);
  });

  it('getRegenRate falls back to the player weenie rates when unset (0.3 / 3 / 1)', () => {
    const vs = new VitalSystem();
    expect(vs.getRegenRate(VitalId.Health)).toBe(0.3);
    expect(vs.getRegenRate(VitalId.Stamina)).toBe(3);
    expect(vs.getRegenRate(VitalId.Mana)).toBe(1);
  });

  it('setRegenRate(0) is honored (not treated as unset)', () => {
    const vs = new VitalSystem();
    vs.setRegenRate(VitalId.Mana, 0);
    expect(vs.getRegenRate(VitalId.Mana)).toBe(0);
  });

  it('the per-tick prediction uses the server-sent rate (STATS.regen-prediction-diverges)', () => {
    const vs = new VitalSystem();
    const a = attrs();
    expect(vs.getRegenPerTick(VitalId.Stamina, a, RegenStance.Standing)).toBe(3);
    vs.setRegenRate(VitalId.Stamina, 6);
    expect(vs.getRegenPerTick(VitalId.Stamina, a, RegenStance.Standing)).toBe(6);
    vs.setRegenRate(VitalId.Mana, 0);
    expect(vs.getRegenPerTick(VitalId.Mana, a, RegenStance.Standing)).toBe(0);
  });

  it('regenTick advances by the server-sent rate', () => {
    const vs = new VitalSystem();
    const a = attrs();
    vs.initToMax(a);
    vs.useMana(20); // 80 -> 60
    vs.setRegenRate(VitalId.Mana, 4);
    vs.regenTick(REGEN_INTERVAL, a, RegenStance.Standing);
    expect(vs.getCurrent(VitalId.Mana)).toBe(64);
  });
});

describe('main.ts wires PrivateUpdatePropertyFloat → setRegenRate (FAITHFUL.377)', () => {
  const block = MAIN.match(/onPrivateUpdatePropertyFloat:[\s\S]+?\},/)?.[0] ?? '';
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('handles HealthRate (key 3)', () => {
    expect(code).toMatch(/data\.key === 3/);
    expect(code).toMatch(/setRegenRate\(VitalId\.Health, val\)/);
  });

  it('handles StaminaRate (key 4)', () => {
    expect(code).toMatch(/data\.key === 4/);
    expect(code).toMatch(/setRegenRate\(VitalId\.Stamina, val\)/);
  });

  it('handles ManaRate (key 5)', () => {
    expect(code).toMatch(/data\.key === 5/);
    expect(code).toMatch(/setRegenRate\(VitalId\.Mana, val\)/);
  });

  it('guards against NaN values', () => {
    expect(code).toMatch(/Number\.isFinite\(val\)/);
  });
});
