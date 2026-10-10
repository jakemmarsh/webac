/**
 * FAITHFUL.164 — GameMessageOpcode + GameEventType enum parity with ACE.
 *
 * Continuation of FAITHFUL.163 (which did the same for GameActionType).
 *
 * NOTE on intentional name divergences: our enums use cleaner names than
 * ACE's source in a handful of cases where ACE has typos or redundant
 * prefixes. The divergent-name map below documents each one. The parity
 * invariant is on NUMERIC VALUES, not exact names.
 *
 * Example: ACE has `MiscPortalstormSubsided` (lowercase 's' in 'storm') —
 * an obvious typo. We use `MiscPortalStormSubsided`. The numeric value
 * 0x02CC is identical and the test verifies that.
 *
 * Example: ACE has `AllegianceAllegianceUpdateDone` — duplicated word due to
 * the way the namespace was originally collapsed. We use `AllegianceUpdateDone`.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GameMessageOpcode, GameEventType } from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACE_MSG = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameMessages/GameMessageOpcode.cs');
const ACE_EVT = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameEvent/GameEventType.cs');

const msgExists = aceReferenceExists(ACE_MSG);
const evtExists = aceReferenceExists(ACE_EVT);

function parseEnum(path: string): Map<string, number> {
  const src = readFileSync(path, 'utf8');
  const re = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s+=\s+(0x[0-9A-Fa-f]+|\d+)\s*,?/gm;
  const out = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const value = m[2].startsWith('0x') ? parseInt(m[2], 16) : Number(m[2]);
    out.set(name, value);
  }
  return out;
}

/**
 * Intentional name divergences: ACE uses these names; we use the value on the
 * right. Numeric values must still match exactly.
 */
const MSG_ALIAS_MAP: Record<string, string> = {
  // (none currently — Motion + CharacterRestoreResponse added as ACE-name aliases in our enum)
};

const EVT_ALIAS_MAP: Record<string, string> = {
  // ACE name (typo/verbose)               → our name (clean)
  AllegianceAllegianceUpdateDone:         'AllegianceUpdateDone',
  CharacterConfirmationDone:               'ConfirmationDone',
  CharacterConfirmationRequest:            'ConfirmationRequest',
  FellowshipFellowStatsDone:               'FellowshipStatsDone',
  FellowshipFellowUpdateDone:              'FellowshipUpdateDone',
  MiscPortalstormSubsided:                 'MiscPortalStormSubsided',  // ACE has lowercase 's' typo
  VendorInfoEvent:                         'ApproachVendor',           // ACE has both names for 0x0062
};

describe.skipIf(!msgExists)('GameMessageOpcode ACE parity', () => {
  const aceMap = parseEnum(ACE_MSG);

  it('found a reasonable number of ACE GameMessageOpcode entries (>= 80)', () => {
    expect(aceMap.size).toBeGreaterThanOrEqual(80);
  });

  it('every ACE name→value pair exists in our enum (modulo documented aliases)', () => {
    const ours = GameMessageOpcode as unknown as Record<string, number | string>;
    const missing: string[] = [];
    const mismatches: string[] = [];
    for (const [name, value] of aceMap) {
      const ourName = MSG_ALIAS_MAP[name] ?? name;
      const ourValue = ours[ourName];
      if (ourValue === undefined) {
        missing.push(`${name} (= 0x${value.toString(16).toUpperCase()})`);
      } else if (typeof ourValue === 'number' && ourValue !== value) {
        mismatches.push(
          `${name}: ACE=0x${value.toString(16).toUpperCase()} ours[${ourName}]=0x${ourValue.toString(16).toUpperCase()}`
        );
      }
    }
    expect({ missing, mismatches }).toEqual({ missing: [], mismatches: [] });
  });

  it('CharacterRestoreResponse alias maps to the same value as CharacterCreateResponse', () => {
    const ours = GameMessageOpcode as unknown as Record<string, number>;
    expect(ours.CharacterRestoreResponse).toBe(0xF643);
    expect(ours.CharacterRestoreResponse).toBe(ours.CharacterCreateResponse);
  });

  it('Motion alias maps to the same value as MovementEvent', () => {
    const ours = GameMessageOpcode as unknown as Record<string, number>;
    expect(ours.Motion).toBe(0xF74C);
    expect(ours.Motion).toBe(ours.MovementEvent);
  });
});

describe.skipIf(!evtExists)('GameEventType ACE parity', () => {
  const aceMap = parseEnum(ACE_EVT);

  it('found a reasonable number of ACE GameEventType entries (>= 95)', () => {
    expect(aceMap.size).toBeGreaterThanOrEqual(95);
  });

  it('every ACE name→value pair exists in our enum (modulo documented aliases)', () => {
    const ours = GameEventType as unknown as Record<string, number | string>;
    const missing: string[] = [];
    const mismatches: string[] = [];
    for (const [name, value] of aceMap) {
      const ourName = EVT_ALIAS_MAP[name] ?? name;
      const ourValue = ours[ourName];
      if (ourValue === undefined) {
        missing.push(`${name} (= 0x${value.toString(16).toUpperCase()})`);
      } else if (typeof ourValue === 'number' && ourValue !== value) {
        mismatches.push(
          `${name}: ACE=0x${value.toString(16).toUpperCase()} ours[${ourName}]=0x${ourValue.toString(16).toUpperCase()}`
        );
      }
    }
    expect({ missing, mismatches }).toEqual({ missing: [], mismatches: [] });
  });

  it('our clean-name aliases preserve the ACE numeric value', () => {
    const ours = GameEventType as unknown as Record<string, number>;
    // Spot-check the typo fix: MiscPortalStormSubsided (correct caps) must = 0x02CC.
    expect(ours.MiscPortalStormSubsided).toBe(0x02CC);
    expect(ours.AllegianceUpdateDone).toBe(0x01C8);
    expect(ours.ConfirmationRequest).toBe(0x0274);
    expect(ours.ConfirmationDone).toBe(0x0276);
    expect(ours.FellowshipStatsDone).toBe(0x01CA);
    expect(ours.FellowshipUpdateDone).toBe(0x01C9);
    expect(ours.ApproachVendor).toBe(0x0062);
  });
});
