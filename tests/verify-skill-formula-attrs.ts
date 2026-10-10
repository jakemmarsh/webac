/**
 * Regression + audit for skill-formula attribute mapping.
 *
 * The DAT SkillTable's SkillFormula stores attr1/attr2 as raw uint32 values
 * using ACE PropertyAttribute.cs convention (1=Strength, 2=Endurance,
 * 3=Quickness, 4=Coordination, 5=Focus, 6=Self).
 *
 * FAITHFUL.91 fix-anchor: SkillSystem.FORMULA_ATTR_MAP previously swapped
 * 3 and 4 (mapping 3→Coordination, 4→Quickness). Effect: every
 * Sword/Mace/Spear/Staff/Axe/HeavyWeapons skill base computed
 * Strength + Quickness instead of Strength + Coordination — significant
 * skill-base error for melee builds (since Coord usually ≠ Quickness).
 *
 * Pins:
 *   - Sword formula (Str + Coord, /3) produces the expected base.
 *   - Dagger formula (Quick + Coord, /3) is commutative — masked the bug
 *     historically but is now explicitly verified.
 *   - PropertyAttribute + PropertyAttribute2nd ACE source values match
 *     the canonical wire-format conventions used by this client.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AttributeSystem, AttributeId } from '../packages/shared/src/character/AttributeSystem.js';
import { computeSkillBase } from '../packages/shared/src/character/SkillSystem.js';
import type { SkillFormula } from '@ac/dat-parser';

const REPO = resolve(__dirname, '..');
const PA_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyAttribute.cs');
const PA2_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyAttribute2nd.cs');

interface AceEntry { name: string; value: number; }

function parseAceNumeric(path: string, enumName: string): AceEntry[] {
  const src = readFileSync(path, 'utf8');
  const lines = src.split('\n');
  const out: AceEntry[] = [];
  let inside = false;
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  const re = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|-?\d+)\s*,?\s*(\/\/.*)?$/;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inside) { if (open.test(line)) inside = true; continue; }
    if (/^\s*}/.test(line)) break;
    const m = re.exec(line);
    if (m) {
      const value = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
      out.push({ name: m[1], value });
    }
  }
  return out;
}

/**
 * Build an AttributeSystem with distinct, non-coincidental per-attribute
 * values so that any attr1/attr2 mix-up surfaces as an arithmetic mismatch.
 */
function buildAttrs(): AttributeSystem {
  // STR=100, END=60, COORD=80, QUICK=50, FOCUS=40, SELF=70 — note STR > COORD
  // > QUICK so a Quickness-instead-of-Coordination bug would deflate the base.
  return new AttributeSystem({
    strength: 100, endurance: 60, coordination: 80, quickness: 50, focus: 40, self: 70,
  });
}

const sword: SkillFormula = { w: 0, x: 1, y: 1, z: 3, attr1: 1 /* Strength */, attr2: 4 /* Coordination per ACE PropertyAttribute */ };
const dagger: SkillFormula = { w: 0, x: 1, y: 1, z: 3, attr1: 3 /* Quickness */, attr2: 4 /* Coordination */ };
const bow: SkillFormula = { w: 0, x: 1, y: 0, z: 2, attr1: 4 /* Coordination */, attr2: 0 /* undef */ };
const lifeMagic: SkillFormula = { w: 0, x: 1, y: 1, z: 4, attr1: 5 /* Focus */, attr2: 6 /* Self */ };

describe('FAITHFUL.91 — skill-formula attribute mapping (ACE PropertyAttribute convention)', () => {
  it('Sword formula (Str + Coord, /3) — pins the FAITHFUL.91 fix', () => {
    const attrs = buildAttrs();
    // ACE PropertyAttribute.Strength=1 → STR; PropertyAttribute.Coordination=4 → COORD.
    // Expected: floor((100 + 80) / 3) = 60. Pre-fix (4→Quickness): floor((100+50)/3) = 50.
    expect(computeSkillBase(sword, attrs)).toBe(60);
    expect(computeSkillBase(sword, attrs)).not.toBe(50);
  });

  it('Dagger formula (Quick + Coord, /3) — commutative; masks bugs historically', () => {
    const attrs = buildAttrs();
    expect(computeSkillBase(dagger, attrs)).toBe(Math.floor((50 + 80) / 3));
  });

  it('Bow formula (Coord, /2) — single-attr; pins 4→Coordination', () => {
    const attrs = buildAttrs();
    // Expected: floor(80 / 2) = 40. Pre-fix (4→Quickness): floor(50/2) = 25.
    expect(computeSkillBase(bow, attrs)).toBe(40);
    expect(computeSkillBase(bow, attrs)).not.toBe(25);
  });

  it('LifeMagic formula (Focus + Self, /4) — pins 5→Focus, 6→Self', () => {
    const attrs = buildAttrs();
    // (40 + 70) / 4 = 27.5 — ACE's AttributeFormula.GetFormula rounds this
    // half-away-from-zero (FloatExtensions.cs `.Round()`), not floor: 28, not 27.
    expect(computeSkillBase(lifeMagic, attrs)).toBe(28);
  });

  it('BUG.skill-base-floor-vs-round: non-midpoint fractional quotient (x.75) rounds, not floors', () => {
    const attrs = buildAttrs(); // self=70
    // 70 / 8 = 8.75 — a non-exact-midpoint fraction >= 0.5. ACE rounds this to 9;
    // the pre-fix floor() implementation would have returned 8.
    const formula: SkillFormula = { w: 0, x: 1, y: 0, z: 8, attr1: 6, attr2: 0 };
    expect(computeSkillBase(formula, attrs)).toBe(9);
    expect(computeSkillBase(formula, attrs)).not.toBe(Math.floor(70 / 8));
  });
});

// ─── PropertyAttribute audit ────────────────────────────────

describe('ACE PropertyAttribute coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(PA_PATH, 'PropertyAttribute');

  it('parses ACE source successfully', () => {
    expect(existsSync(PA_PATH)).toBe(true);
    expect(aceEntries.length).toBe(7);
  });

  it('canonical attr-id order: Strength=1, Endurance=2, Quickness=3, Coordination=4, Focus=5, Self=6', () => {
    const byName = Object.fromEntries(aceEntries.map((e) => [e.name, e.value]));
    expect(byName.Undef).toBe(0);
    expect(byName.Strength).toBe(1);
    expect(byName.Endurance).toBe(2);
    expect(byName.Quickness).toBe(3);
    expect(byName.Coordination).toBe(4);
    expect(byName.Focus).toBe(5);
    expect(byName.Self).toBe(6);
  });

  it('FAITHFUL.91 fix anchor: FORMULA_ATTR_MAP matches PropertyAttribute order', () => {
    // Re-verify via computeSkillBase: a formula with attr1=PropertyAttribute.Quickness=3
    // must consume the Quickness attribute, not Coordination.
    const attrs = buildAttrs(); // quickness=50, coordination=80
    const justQuickness: SkillFormula = { w: 0, x: 1, y: 0, z: 1, attr1: 3, attr2: 0 };
    const justCoordination: SkillFormula = { w: 0, x: 1, y: 0, z: 1, attr1: 4, attr2: 0 };
    expect(computeSkillBase(justQuickness, attrs)).toBe(50);
    expect(computeSkillBase(justCoordination, attrs)).toBe(80);
  });
});

// ─── PropertyAttribute2nd audit ─────────────────────────────

describe('ACE PropertyAttribute2nd coverage (runtime audit)', () => {
  const aceEntries = parseAceNumeric(PA2_PATH, 'PropertyAttribute2nd');

  it('parses ACE source successfully', () => {
    expect(existsSync(PA2_PATH)).toBe(true);
    expect(aceEntries.length).toBe(7);
  });

  it('canonical vital-id order: MaxHealth=1, Health=2, MaxStamina=3, Stamina=4, MaxMana=5, Mana=6', () => {
    const byName = Object.fromEntries(aceEntries.map((e) => [e.name, e.value]));
    expect(byName.Undef).toBe(0);
    expect(byName.MaxHealth).toBe(1);
    expect(byName.Health).toBe(2);
    expect(byName.MaxStamina).toBe(3);
    expect(byName.Stamina).toBe(4);
    expect(byName.MaxMana).toBe(5);
    expect(byName.Mana).toBe(6);
  });

  // No symbolic enum in TS port — the client uses a local VitalId (Health=1,
  // Stamina=2, Mana=3) and translates from PropertyAttribute2nd at the wire
  // boundary via main.ts:3531-3552 (maxVitalMap + curVitalMap + vitalMap).
  // These ACE-source pins guard against the wire-side ordering shifting.
  it('AttributeId enum is internal-only — wire mapping happens at the network boundary', () => {
    // Internal AttributeId values are local conventions; do not assume wire
    // alignment. PropertyAttribute is the canonical wire ID for the 6 attrs.
    expect(AttributeId.Strength).toBeDefined();
    expect(AttributeId.Endurance).toBeDefined();
    expect(AttributeId.Quickness).toBeDefined();
    expect(AttributeId.Coordination).toBeDefined();
    expect(AttributeId.Focus).toBeDefined();
    expect(AttributeId.Self).toBeDefined();
  });
});

/**
 * MOVE.combination-sweep (era research) — SkillFormula::Calculate @ 00591960:
 * `z == 0` fails (0) and the constant W is part of the sum,
 * floor((x·a1 + y·a2 + w) / z + 0.5). The end-of-retail tables all have
 * W = 0; ClassicACE CustomDM's Run is Quickness + 20 and its Armor + 30, which
 * ran our CustomDM characters ~6 % slow.
 */
describe('SkillFormula::Calculate — W and a zero divisor', () => {
  it('adds W', () => {
    const attrs = buildAttrs();
    const run: SkillFormula = { w: 20, x: 1, y: 1, z: 1, attr1: 3 /* Quickness */, attr2: 0 };
    expect(computeSkillBase(run, attrs)).toBe(50 + 20);
    const armor: SkillFormula = { w: 30, x: 1, y: 1, z: 4, attr1: 1, attr2: 2 /* Endurance */ };
    expect(computeSkillBase(armor, attrs)).toBe(Math.floor((100 + 60 + 30) / 4 + 0.5));
  });

  it('a zero divisor gives 0, not the undivided sum', () => {
    const attrs = buildAttrs();
    expect(computeSkillBase({ w: 0, x: 1, y: 0, z: 0, attr1: 3, attr2: 0 }, attrs)).toBe(0);
  });

  const CUSTOMDM = resolve(__dirname, '../dat/sets/classicace-customdm/client_portal.dat');
  it.skipIf(!existsSync(CUSTOMDM))('the real CustomDM SkillTable: Run = Quickness + 20; end of retail\'s: Quickness', async () => {
    const { openDat, DAT_PATHS } = await import('./_harness/dat.js');
    const { SkillTable, DatReader } = await import('@ac/dat-parser');
    const run = (path: string) => {
      const t = new SkillTable(new DatReader(openDat(path).getFileData(0x0E000004)!));
      return t.skills.get(24)!.formula;
    };
    const attrs = buildAttrs();
    expect(computeSkillBase(run(CUSTOMDM), attrs)).toBe(50 + 20);
    expect(computeSkillBase(run(DAT_PATHS.portal), attrs)).toBe(50);
  });
});
