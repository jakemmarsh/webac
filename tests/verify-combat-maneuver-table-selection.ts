/**
 * BUG.combat-table-did-login-ignored — resolveCombatManeuverTableDid must
 * honor the server-sourced CombatTable DID (login PlayerDescription
 * propertiesDataId, key=4 per
 * `reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyDataId.cs:16`)
 * instead of hardcoding the humanoid table for every heritage.
 *
 * Pre-fix, main.ts's loadPlayerCombatManeuvers() always loaded DID
 * 0x30000000 — correct only for the 11 humanoid heritages. Olthoi
 * (heritage 12) and OlthoiAcid (heritage 13) ship their own
 * CombatManeuverTable via CharacterGenerator.Sex.CombatTable
 * (0x30000001 / 0x30000038 respectively, set at character creation by
 * `reference/ACE/Source/ACE.Server/Factories/PlayerFactory.cs:59`), so
 * those characters got the wrong swing-animation table entirely.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveCombatManeuverTableDid, DEFAULT_COMBAT_TABLE_DID } from '@ac/shared';
import { openDat } from './_harness/dat.js';

describe('BUG.combat-table-did-login-ignored — resolveCombatManeuverTableDid', () => {
  it('falls back to the humanoid default (0x30000000) when unset', () => {
    expect(resolveCombatManeuverTableDid(undefined)).toBe(DEFAULT_COMBAT_TABLE_DID);
    expect(resolveCombatManeuverTableDid(0)).toBe(DEFAULT_COMBAT_TABLE_DID);
  });

  it('passes through a server-sourced heritage-specific DID unchanged', () => {
    expect(resolveCombatManeuverTableDid(0x30000001)).toBe(0x30000001); // Olthoi
    expect(resolveCombatManeuverTableDid(0x30000038)).toBe(0x30000038); // OlthoiAcid
  });

  it('DEFAULT_COMBAT_TABLE_DID is the documented humanoid table', () => {
    expect(DEFAULT_COMBAT_TABLE_DID).toBe(0x30000000);
  });
});

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');

describe.skipIf(!existsSync(PORTAL))('BUG.combat-table-did-login-ignored — real per-heritage DAT tables differ', () => {
  let humanoid: unknown[];
  let olthoi: unknown[];
  let olthoiAcid: unknown[];

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase');
    const { CombatManeuverTable } = await import('../packages/dat-parser/src/file-types/CombatManeuverTable');
    const db = openDat(PORTAL);
    humanoid = new CombatManeuverTable(db.getReader(resolveCombatManeuverTableDid(undefined))).maneuvers;
    olthoi = new CombatManeuverTable(db.getReader(resolveCombatManeuverTableDid(0x30000001))).maneuvers;
    olthoiAcid = new CombatManeuverTable(db.getReader(resolveCombatManeuverTableDid(0x30000038))).maneuvers;
  });

  it('the humanoid default table has 102 maneuvers', () => {
    expect(humanoid.length).toBe(102);
  });

  it("Olthoi's table (0x30000001) is real and distinct from the humanoid default", () => {
    expect(olthoi.length).toBeGreaterThan(0);
    expect(olthoi.length).not.toBe(humanoid.length);
  });

  it("OlthoiAcid's table (0x30000038) is real and distinct from the humanoid default", () => {
    expect(olthoiAcid.length).toBeGreaterThan(0);
    expect(olthoiAcid.length).not.toBe(humanoid.length);
  });
});
