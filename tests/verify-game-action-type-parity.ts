/**
 * FAITHFUL.163 — GameActionType enum parity with ACE.
 *
 * Our `@ac/network` GameActionType enum is supposed to be a faithful port of
 * `reference/ACE/Source/ACE.Server/Network/GameAction/GameActionType.cs`. This
 * test pins the invariant: every (name → numeric value) pair ACE defines must
 * exist in our enum.
 *
 * Pre-FAITHFUL.163 audit, 8 entries were missing:
 *   ApplySoundEffect, ApplyVisualEffect, AutonomyLevel, ForceObjectDescSend,
 *   JumpNonAutonomous, MovementEvent, ObjectCreate, ObjectDelete
 *
 * Most are aliases of GameMessageOpcode values for the same protocol routing
 * (e.g. ApplySoundEffect = 0xF750 = Sound) — they exist in the enum so callers
 * can reference them symbolically in either direction.
 *
 * The test compares ACE's enum source line-by-line. If ACE rebases and adds a
 * new GameActionType, this test fails until we add it too.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GameActionType } from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACE_FILE = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/GameActionType.cs');

const aceExists = aceReferenceExists(ACE_FILE);

function parseACEEnum(): Map<string, number> {
  const src = readFileSync(ACE_FILE, 'utf8');
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

describe.skipIf(!aceExists)('GameActionType ACE parity', () => {
  const aceMap = parseACEEnum();

  it('found a reasonable number of ACE GameActionType entries (>= 160)', () => {
    expect(aceMap.size).toBeGreaterThanOrEqual(160);
  });

  it('every ACE GameActionType name maps to the same numeric value in our enum', () => {
    const ourEnum = GameActionType as unknown as Record<string, number | string>;
    const mismatches: string[] = [];
    const missing: string[] = [];
    for (const [name, value] of aceMap) {
      const ours = ourEnum[name];
      if (ours === undefined) {
        missing.push(`${name} (= 0x${value.toString(16).toUpperCase()})`);
      } else if (typeof ours === 'number' && ours !== value) {
        mismatches.push(
          `${name}: ACE=0x${value.toString(16).toUpperCase()} ours=0x${ours.toString(16).toUpperCase()}`
        );
      }
    }
    expect({ missing, mismatches }).toEqual({ missing: [], mismatches: [] });
  });

  it('all 8 previously-missing FAITHFUL.163 entries are now present with correct values', () => {
    const ourEnum = GameActionType as unknown as Record<string, number>;
    expect(ourEnum.ForceObjectDescSend).toBe(0xF6EA);
    expect(ourEnum.ObjectCreate).toBe(0xF745);
    expect(ourEnum.ObjectDelete).toBe(0xF747);
    expect(ourEnum.MovementEvent).toBe(0xF74C);
    expect(ourEnum.ApplySoundEffect).toBe(0xF750);
    expect(ourEnum.AutonomyLevel).toBe(0xF752);
    expect(ourEnum.ApplyVisualEffect).toBe(0xF755);
    expect(ourEnum.JumpNonAutonomous).toBe(0xF7C9);
  });
});

describe('Numeric-value clash check (entries with the same value should be intentional aliases)', () => {
  it('newly-added entries that share a value with an existing one are aliases (acceptable)', () => {
    // Several of the FAITHFUL.163 additions intentionally share numeric values
    // with other enum members or with GameMessageOpcode entries (the same
    // numeric ID is used for both a server→client message and a client→server
    // action, e.g. 0xF750 is both GameMessageOpcode.Sound and
    // GameActionType.ApplySoundEffect). This test merely documents the
    // expected aliases so a future contributor sees them.
    const aliases: Array<[string, string, number]> = [
      ['ApplySoundEffect', 'Sound (in GameMessageOpcode)', 0xF750],
      ['AutonomousPosition', 'AutonomousPosition (in GameMessageOpcode)', 0xF753],
      ['ApplyVisualEffect', 'PlayEffect (in GameMessageOpcode)', 0xF755],
      ['ObjectCreate', 'ObjectCreate (in GameMessageOpcode)', 0xF745],
      ['ObjectDelete', 'ObjectDelete (in GameMessageOpcode)', 0xF747],
      ['MovementEvent', 'MovementEvent (in GameMessageOpcode)', 0xF74C],
      ['ForceObjectDescSend', 'ForceObjectDescSend (in GameMessageOpcode)', 0xF6EA],
    ];
    const ourEnum = GameActionType as unknown as Record<string, number>;
    for (const [name, , value] of aliases) {
      expect(ourEnum[name]).toBe(value);
    }
  });
});
