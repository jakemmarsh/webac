/**
 * houseTypeName helper (FAITHFUL.289).
 *
 * Pre-fix main.ts had THREE separate inline duplications of
 * `['', 'Cottage', 'Villa', 'Mansion', 'Apartment']` at the
 * onHouseProfile / onHouseData / onHouseAvailableHouses event handlers.
 * Same pattern as FAITHFUL.288 (magic school names), .283 (item type
 * labels), .281 (character titles), etc — promote to a single helper
 * in @ac/shared.
 *
 * Per ACE HouseType.cs: Undef=0, Cottage=1, Villa=2, Mansion=3,
 * Apartment=4. The empty-string for Undef matches the pre-fix arrays'
 * positional-padding behavior — the value 0 was never expected as a
 * real input but the array slot existed so the index lookup was safe.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { availableHouseTypeWord } from '../packages/renderer/src/chat/ServerReplyLines.js';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { HouseType, houseTypeName } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const ACE_ENUM = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/HouseType.cs');

describe('HouseType enum (FAITHFUL.289)', () => {
  it('matches ACE numeric values', () => {
    expect(HouseType.Undef).toBe(0);
    expect(HouseType.Cottage).toBe(1);
    expect(HouseType.Villa).toBe(2);
    expect(HouseType.Mansion).toBe(3);
    expect(HouseType.Apartment).toBe(4);
  });
});

describe.skipIf(!aceReferenceExists(ACE_ENUM))('ACE source faithfulness (FAITHFUL.289)', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_ENUM, 'utf8');
  });
  it('ACE HouseType.cs has the 5-entry enum', () => {
    expect(src).toMatch(/enum HouseType/);
    expect(src).toMatch(/Undef\b/);
    expect(src).toMatch(/Cottage\b/);
    expect(src).toMatch(/Villa\b/);
    expect(src).toMatch(/Mansion\b/);
    expect(src).toMatch(/Apartment\b/);
  });
});

describe('houseTypeName helper (FAITHFUL.289)', () => {
  it('returns canonical retail labels for the 4 actual house types', () => {
    expect(houseTypeName(HouseType.Cottage)).toBe('Cottage');
    expect(houseTypeName(HouseType.Villa)).toBe('Villa');
    expect(houseTypeName(HouseType.Mansion)).toBe('Mansion');
    expect(houseTypeName(HouseType.Apartment)).toBe('Apartment');
  });

  it('returns empty string for Undef (0) — matches pre-fix array padding', () => {
    expect(houseTypeName(HouseType.Undef)).toBe('');
    expect(houseTypeName(0)).toBe('');
  });

  it('returns empty string for unknown values — caller uses fallback', () => {
    expect(houseTypeName(99)).toBe('');
    expect(houseTypeName(-1)).toBe('');
  });
});

describe('main.ts wiring (FAITHFUL.289)', () => {
  it('imports houseTypeName from @ac/shared', () => {
    expect(MAIN).toMatch(/import\s*\{[^}]*houseTypeName[^}]*\}\s*from\s*'@ac\/shared'/);
  });

  it('the 3 inline duplications are gone', () => {
    // Pre-fix had `['', 'Cottage', 'Villa', 'Mansion', 'Apartment']` literal three times.
    const matches = MAIN.match(/\[''\s*,\s*'Cottage'\s*,\s*'Villa'\s*,\s*'Mansion'\s*,\s*'Apartment'\]/g);
    expect(matches).toBeNull();
  });

  // SWEEP1006 available houses — the AvailableHouses reply uses retail's own
  // lowercase plurals (Handle_House__Recv_AvailableHouses @ 00585d50), not
  // houseTypeName; behavioural now (was a main.ts call-count pin).
  it('the available-houses reply words are retail\'s plurals', () => {
    expect([1, 2, 3, 4, 9].map(availableHouseTypeWord)).toEqual(['cottages', 'villas', 'mansions', 'apartments', '']);
  });
});
