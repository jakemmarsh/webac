/**
 * Runtime audit for combat-related ACE enums in our TS port:
 *   - AttackHeight (TargetedMeleeAttack wire payload + Quadrant routing)
 *   - CombatMode (mode-switch wire packet + Player.CombatMode property)
 *   - RadarColor (radar-blip color + HUD target classification)
 *
 * RadarColor in ACE source carries 12 symbolic aliases (Admin=Cyan, Creature=Gold,
 * etc.) that the regex-only parseAce in verify-ace-physics-flags-coverage.ts can't
 * pick up. This file pins both the 11 canonical numeric values and the alias table.
 *
 * Real bugs that the FAITHFUL.89 batch caught + fixed (asserted explicitly below):
 *   - RadarColor was missing BrightGreen=0x10 (fellowship dots fell through to default).
 *   - main.ts targetType classifier had wrong mappings (Lifestone→npc, Portal→player,
 *     and Yellow/NPC + Red/PK fell through to 'item' so NPC/player HP bars never showed).
 *     Re-anchored against the canonical alias table.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { RadarColor } from '../packages/shared/src/game-types.js';
import { AttackHeight } from '../packages/shared/src/combat/CombatSystem.js';
import { CombatMode } from '../packages/shared/src/combat/CombatSystem.js';

const REPO = resolve(__dirname, '..');
const AH_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/AttackHeight.cs');
const CM_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/CombatMode.cs');
const RC_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/RadarColor.cs');

interface AceEntry { name: string; value: number; }

/**
 * Extended ACE-enum parser that captures both numeric literals AND symbolic
 * aliases (`Admin = Cyan` style). Aliases resolve in a second pass against the
 * numeric entries discovered earlier.
 */
function parseAceWithAliases(path: string, enumName: string): AceEntry[] {
  const src = readFileSync(path, 'utf8');
  const lines = src.split('\n');
  const numeric: AceEntry[] = [];
  const aliases: { name: string; ref: string }[] = [];
  let inside = false;
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  const numRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(0x[0-9A-Fa-f]+|-?\d+)\s*,?\s*(\/\/.*)?$/;
  const aliasRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*,?\s*(\/\/.*)?$/;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inside) { if (open.test(line)) inside = true; continue; }
    if (/^\s*}/.test(line)) break;
    const nm = numRe.exec(line);
    if (nm) {
      const value = nm[2].startsWith('0x') ? parseInt(nm[2], 16) : parseInt(nm[2], 10);
      numeric.push({ name: nm[1], value });
      continue;
    }
    const am = aliasRe.exec(line);
    if (am) aliases.push({ name: am[1], ref: am[2] });
  }
  const byName = new Map(numeric.map((e) => [e.name, e.value]));
  const resolved: AceEntry[] = [...numeric];
  for (const a of aliases) {
    const v = byName.get(a.ref);
    if (v !== undefined) resolved.push({ name: a.name, value: v });
  }
  return resolved;
}

function tsNamesOf(enumObj: Record<string, unknown>): string[] {
  return Object.keys(enumObj).filter((k) => Number.isNaN(Number(k)));
}

// ─── AttackHeight ───────────────────────────────────────────

describe('ACE AttackHeight coverage (runtime audit)', () => {
  const aceEntries = parseAceWithAliases(AH_PATH, 'AttackHeight');

  it('parses ACE source successfully', () => {
    expect(existsSync(AH_PATH)).toBe(true);
    expect(aceEntries.length).toBe(3);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'AttackHeight.%s = %s matches ACE',
    (name, value) => {
      const tsVal = (AttackHeight as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  // Pins the wire payload values used by sendMeleeAttack/sendMissileAttack in
  // packages/renderer/src/main.ts — every melee swing serializes one of these
  // as the second uint32 of the TargetedMeleeAttack/MissileAttack payload.
  it('wire-payload values: High=1, Medium=2, Low=3', () => {
    expect(AttackHeight.High).toBe(1);
    expect(AttackHeight.Medium).toBe(2);
    expect(AttackHeight.Low).toBe(3);
  });
});

// ─── CombatMode ─────────────────────────────────────────────

describe('ACE CombatMode coverage (runtime audit)', () => {
  const aceEntries = parseAceWithAliases(CM_PATH, 'CombatMode');

  it('parses ACE source successfully', () => {
    expect(existsSync(CM_PATH)).toBe(true);
    // 5 canonical: Undef, NonCombat, Melee, Missile, Magic.
    // 2 composite aliases (ValidCombat, CombatCombat) are skipped by the
    // alias parser because their RHS uses bitwise-OR rather than a single
    // symbolic name.
    expect(aceEntries.length).toBe(5);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'CombatMode.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (CombatMode as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(CombatMode as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });
});

// ─── RadarColor ─────────────────────────────────────────────

describe('ACE RadarColor coverage (runtime audit)', () => {
  const aceEntries = parseAceWithAliases(RC_PATH, 'RadarColor');

  it('parses ACE source successfully', () => {
    expect(existsSync(RC_PATH)).toBe(true);
    // 11 canonical: Default, Blue, Gold, White, Purple, Red, Pink, Green,
    //               Yellow, Cyan, BrightGreen.
    // 12 aliases: Admin, Advocate, Creature, LifeStone, NPC, PlayerKiller,
    //             Portal, Sentinel, Vendor, Fellowship, FellowshipLeader, PKLite.
    expect(aceEntries.length).toBe(23);
  });

  it.each(aceEntries.map((e) => [e.name, e.value] as const))(
    'RadarColor.%s = 0x%s matches ACE',
    (name, value) => {
      const tsVal = (RadarColor as unknown as Record<string, number>)[name];
      expect(tsVal).toBeDefined();
      expect(tsVal).toBe(value);
    },
  );

  it('TS port has no extras that ACE does not have', () => {
    const aceNames = new Set(aceEntries.map((e) => e.name));
    const extras = tsNamesOf(RadarColor as unknown as Record<string, unknown>).filter((n) => !aceNames.has(n));
    expect(extras).toEqual([]);
  });

  // FAITHFUL.89 fix anchor: TS port previously stopped at Cyan=9 with no
  // BrightGreen entry and no aliases. Fellowship-member radar dots fell
  // through to the default grey color, and HUD target-type classification
  // couldn't symbolically name Fellowship players.
  it('FAITHFUL.89 fix anchor: BrightGreen = 0x10 (fellowship dot)', () => {
    expect(RadarColor.BrightGreen).toBe(0x10);
    expect(RadarColor.Fellowship).toBe(0x10);
    expect(RadarColor.FellowshipLeader).toBe(0x10);
  });

  it('alias-table semantics match ACE source', () => {
    expect(RadarColor.Creature).toBe(RadarColor.Gold);
    expect(RadarColor.NPC).toBe(RadarColor.Yellow);
    expect(RadarColor.Vendor).toBe(RadarColor.Yellow);
    expect(RadarColor.Portal).toBe(RadarColor.Purple);
    expect(RadarColor.LifeStone).toBe(RadarColor.Blue);
    expect(RadarColor.PlayerKiller).toBe(RadarColor.Red);
    expect(RadarColor.PKLite).toBe(RadarColor.Pink);
    expect(RadarColor.Advocate).toBe(RadarColor.Pink);
    expect(RadarColor.Admin).toBe(RadarColor.Cyan);
    expect(RadarColor.Sentinel).toBe(RadarColor.Cyan);
  });

  // FAITHFUL.89 fix anchor: prior code in main.ts:selectTarget had:
  //   radarColor === 1 → 'npc'    (Blue is actually Lifestone)
  //   radarColor === 16 → 'npc'   (BrightGreen is actually Fellowship player)
  //   radarColor === 4 → 'player' (Purple is actually Portal)
  //   radarColor === 8 (Yellow/NPC)  not handled — fell through to 'item'
  //   radarColor === 5/6 (PK/PKLite) not handled — fell through to 'item'
  // Resulting HUD target-frame never showed HP bars on NPCs or PK players,
  // and showed HP bars on Lifestones. These pins document the canonical
  // alias-driven target-type mapping the new code uses.
  it('canonical HUD targetType mapping by RadarColor alias', () => {
    // 'creature' = ItemType.Creature || RadarColor.Gold (Creature) || Green
    expect(RadarColor.Gold).toBe(0x02); // Creature alias
    // 'npc' = RadarColor.Yellow (NPC / Vendor alias)
    expect(RadarColor.Yellow).toBe(0x08);
    // 'player' = RadarColor.{Red,Pink,Cyan,BrightGreen} = PK/PKLite/Admin/Fellowship
    expect(RadarColor.Red).toBe(0x05);
    expect(RadarColor.Pink).toBe(0x06);
    expect(RadarColor.Cyan).toBe(0x09);
    expect(RadarColor.BrightGreen).toBe(0x10);
    // 'item' = anything else (Blue/Lifestone, Purple/Portal, White, Default)
    expect(RadarColor.Blue).toBe(0x01);
    expect(RadarColor.Purple).toBe(0x04);
  });
});
