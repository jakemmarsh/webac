/**
 * GAP.9 — ACE-exact melee swing-animation selection
 * (shared/combat/SwingAnimation.ts + the real DAT CombatManeuverTable).
 *
 * Port parity targets:
 *  - Player_Melee.cs:440 GetSwingAnimation (subdivision 0.33 / 0.66
 *    thrust-slash; unarmed Kick > 0.75; motions[1] below subdivision)
 *  - WorldObject_Weapon.cs:1050 GetAttackType / :1097 GetOffhandAttackType
 *    (ThrustThreshold 0.33 + stance special cases)
 *  - Creature_Combat.cs:294 GetWeaponStance / :348 AddShieldStance
 *
 * DAT pins use the REAL CombatManeuverTable 0x30000000 (the player table:
 * world DB weenie 1, PropertyDataId.CombatTable) — including ACE's own
 * documented example: SwordCombat/Medium/Slash → [SlashMed, BackhandMed].
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getSwingAnimation, getWeaponAttackType, getUnarmedAttackType, selectSwingMotion,
  isThrustSlash, getWeaponStance, addShieldStance,
  THRUST_THRESHOLD, KICK_THRESHOLD, SWING_STANCE,
  AttackType, CombatStyle,
} from '@ac/shared';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

const MOTION = {
  ThrustMed: 0x10000058, SlashMed: 0x1000005c, SlashLow: 0x1000005d,
  BackhandMed: 0x1000005f, AttackMed1: 0x10000063, AttackHigh2: 0x10000065,
  AttackMed2: 0x10000066, AttackMed3: 0x10000069,
};

describe('GAP.9 — weapon AttackType resolution (WorldObject_Weapon.cs:1050)', () => {
  const TS = AttackType.Thrust | AttackType.Slash;

  it('thrust/slash weapon splits on ThrustThreshold 0.33', () => {
    expect(getWeaponAttackType(TS, SWING_STANCE.SwordCombat, 0.32, false)).toBe(AttackType.Thrust);
    expect(getWeaponAttackType(TS, SWING_STANCE.SwordCombat, 0.33, false)).toBe(AttackType.Slash);
    expect(getWeaponAttackType(TS, SWING_STANCE.SwordCombat, 1.0, false)).toBe(AttackType.Slash);
  });

  it('SwordCombat forces slash animation for multi-strike weapons', () => {
    const tripleBoth = AttackType.Thrust | AttackType.TripleSlash;
    expect(getWeaponAttackType(tripleBoth, SWING_STANCE.SwordCombat, 0.9, false)).toBe(AttackType.TripleSlash);
    expect(getWeaponAttackType(tripleBoth, SWING_STANCE.SwordCombat, 0.1, false)).toBe(AttackType.Thrust);
    // old bugged stiletto: DoubleThrust only → Thrust in SwordCombat
    expect(getWeaponAttackType(AttackType.DoubleThrust, SWING_STANCE.SwordCombat, 0.9, false)).toBe(AttackType.Thrust);
  });

  it('SwordShieldCombat forces thrust animation for multi-strike weapons', () => {
    const doubleThrustOnly = AttackType.DoubleThrust;
    expect(getWeaponAttackType(doubleThrustOnly, SWING_STANCE.SwordShieldCombat, 0.9, false)).toBe(AttackType.DoubleThrust);
    const withThrust = AttackType.Thrust | AttackType.DoubleThrust;
    expect(getWeaponAttackType(withThrust, SWING_STANCE.SwordShieldCombat, 0.1, false)).toBe(AttackType.Thrust);
    expect(getWeaponAttackType(withThrust, SWING_STANCE.SwordShieldCombat, 0.5, false)).toBe(AttackType.DoubleThrust);
    // poniard/tachi: Thrust + DoubleSlash → Thrust with a shield
    expect(getWeaponAttackType(AttackType.Thrust | AttackType.DoubleSlash, SWING_STANCE.SwordShieldCombat, 0.9, false)).toBe(AttackType.Thrust);
  });

  it('DualWieldCombat picks double/triple by power', () => {
    const dbl = AttackType.DoubleThrust | AttackType.DoubleSlash;
    expect(getWeaponAttackType(dbl, SWING_STANCE.DualWieldCombat, 0.1, false)).toBe(AttackType.DoubleThrust);
    expect(getWeaponAttackType(dbl, SWING_STANCE.DualWieldCombat, 0.5, false)).toBe(AttackType.DoubleSlash);
  });

  it('offhand maps to the Offhand* variants', () => {
    const TSflags = AttackType.Thrust | AttackType.Slash;
    expect(getWeaponAttackType(TSflags, SWING_STANCE.DualWieldCombat, 0.9, true)).toBe(AttackType.OffhandSlash);
    expect(getWeaponAttackType(TSflags, SWING_STANCE.DualWieldCombat, 0.1, true)).toBe(AttackType.OffhandThrust);
    const dbl = AttackType.DoubleThrust | AttackType.DoubleSlash;
    expect(getWeaponAttackType(dbl, SWING_STANCE.DualWieldCombat, 0.9, true)).toBe(AttackType.OffhandDoubleSlash);
  });

  it('unarmed: Kick above 0.75 power, never while dual-wielding', () => {
    expect(getUnarmedAttackType(0.75, false)).toBe(AttackType.Punch);
    expect(getUnarmedAttackType(0.76, false)).toBe(AttackType.Kick);
    expect(getUnarmedAttackType(0.9, true)).toBe(AttackType.Punch);
    expect(KICK_THRESHOLD).toBe(0.75);
    expect(THRUST_THRESHOLD).toBe(0.33);
  });

  it('isThrustSlash: thrust/slash pairs and the stiletto special case', () => {
    expect(isThrustSlash(AttackType.Thrust | AttackType.Slash)).toBe(true);
    expect(isThrustSlash(AttackType.DoubleSlash)).toBe(true); // stiletto
    expect(isThrustSlash(AttackType.Slash)).toBe(false);
    expect(isThrustSlash(AttackType.Punch)).toBe(false);
  });
});

describe('GAP.9 — motion slot selection (Player_Melee.cs:466)', () => {
  const rows = [
    { style: 1, attackHeight: 2, attackType: AttackType.Slash, motion: 111 }, // high-power slot
    { style: 1, attackHeight: 2, attackType: AttackType.Slash, motion: 222 }, // low-power slot
    { style: 1, attackHeight: 1, attackType: AttackType.Slash, motion: 333 },
  ];

  it('two entries: below subdivision → second slot; at/above → first', () => {
    expect(selectSwingMotion(rows, 1, 2, AttackType.Slash, 0.32, 0.33)).toBe(222);
    expect(selectSwingMotion(rows, 1, 2, AttackType.Slash, 0.34, 0.33)).toBe(111);
  });

  it('single entry: always that motion; missing entry: null (ACE Invalid)', () => {
    expect(selectSwingMotion(rows, 1, 1, AttackType.Slash, 0.1, 0.33)).toBe(333);
    expect(selectSwingMotion(rows, 1, 3, AttackType.Slash, 0.5, 0.33)).toBe(null);
    expect(selectSwingMotion(rows, 9, 2, AttackType.Slash, 0.5, 0.33)).toBe(null);
  });
});

describe('GAP.9 — stance resolution (Creature_Combat.cs:294/:348)', () => {
  it('CombatStyle → MotionStance table', () => {
    expect(getWeaponStance(CombatStyle.OneHanded)).toBe(SWING_STANCE.SwordCombat);
    expect(getWeaponStance(CombatStyle.TwoHanded)).toBe(SWING_STANCE.TwoHandedSwordCombat);
    expect(getWeaponStance(CombatStyle.Bow)).toBe(SWING_STANCE.BowCombat);
    expect(getWeaponStance(CombatStyle.Crossbow)).toBe(SWING_STANCE.CrossbowCombat);
    expect(getWeaponStance(CombatStyle.Atlatl)).toBe(SWING_STANCE.AtlatlCombat);
    expect(getWeaponStance(CombatStyle.Sling)).toBe(SWING_STANCE.SlingCombat);
    expect(getWeaponStance(CombatStyle.ThrownWeapon)).toBe(SWING_STANCE.ThrownWeaponCombat);
    expect(getWeaponStance(CombatStyle.Unarmed)).toBe(SWING_STANCE.HandCombat);
    expect(getWeaponStance(0)).toBe(SWING_STANCE.HandCombat);
  });

  it('shield upgrades Sword→SwordShield and Thrown→ThrownShield only', () => {
    expect(addShieldStance(SWING_STANCE.SwordCombat)).toBe(SWING_STANCE.SwordShieldCombat);
    expect(addShieldStance(SWING_STANCE.ThrownWeaponCombat)).toBe(SWING_STANCE.ThrownShieldCombat);
    expect(addShieldStance(SWING_STANCE.TwoHandedSwordCombat)).toBe(SWING_STANCE.TwoHandedSwordCombat);
    expect(addShieldStance(SWING_STANCE.HandCombat)).toBe(SWING_STANCE.HandCombat);
  });
});

describe.skipIf(!existsSync(PORTAL))('GAP.9 — real CombatManeuverTable 0x30000000 (DAT)', () => {
  async function loadCMT() {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { CombatManeuverTable } = await import('../packages/dat-parser/src/file-types/CombatManeuverTable');
    const db = openDat(PORTAL);
    return new CombatManeuverTable(db.getReader(0x30000000)).maneuvers;
  }

  it("pins ACE's documented example: SwordCombat/Medium/Slash = [SlashMed, BackhandMed]", async () => {
    const rows = await loadCMT();
    expect(rows.length).toBe(102);
    const motions = rows
      .filter(m => m.style === SWING_STANCE.SwordCombat && m.attackHeight === 2 && m.attackType === AttackType.Slash)
      .map(m => m.motion);
    expect(motions).toEqual([MOTION.SlashMed, MOTION.BackhandMed]);
  });

  it('unarmed end-to-end: punch slots by power, kick above 0.75', async () => {
    const rows = await loadCMT();
    const swing = (power: number) => getSwingAnimation({
      maneuvers: rows, stance: SWING_STANCE.HandCombat, attackHeight: 2,
      powerLevel: power, weaponAttackType: null,
    });
    expect(swing(0.5)).toBe(MOTION.AttackMed2);  // high-power punch slot — the old hardcode played AttackMed1 here
    expect(swing(0.2)).toBe(MOTION.AttackMed1);  // low-power punch slot
    expect(swing(0.9)).toBe(MOTION.AttackMed3);  // kick
  });

  it('thrust/slash sword end-to-end: Thrust low, Backhand mid (0.66 subdivision), Slash high', async () => {
    const rows = await loadCMT();
    const swing = (power: number) => getSwingAnimation({
      maneuvers: rows, stance: SWING_STANCE.SwordCombat, attackHeight: 2,
      powerLevel: power, weaponAttackType: AttackType.Thrust | AttackType.Slash,
    });
    expect(swing(0.2)).toBe(MOTION.ThrustMed);   // below ThrustThreshold → thrust
    expect(swing(0.5)).toBe(MOTION.BackhandMed); // slash, but below the 0.66 thrust-slash subdivision → slot 2
    expect(swing(0.9)).toBe(MOTION.SlashMed);    // full-power slash
  });
});
