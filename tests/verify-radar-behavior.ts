/**
 * RadarBehavior enum audit.
 *
 * Wire value is a uint8 in the WeenieHeader block per ACE
 *   reference/ACE/Source/ACE.Entity/Enum/RadarBehavior.cs
 * Drift in the numeric values would mis-cull radar dots (ShowNever vs
 * ShowAlways swap would either hide every radar dot or display objects
 * the original game hid).
 *
 * FAITHFUL.139 ported the enum + replaced `obj.radarBehavior === 1`
 * in main.ts's radar-dot loop with the symbolic `RadarBehavior.ShowNever`.
 * This test locks both the enum values and the call-site usage.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { RadarBehavior } from '../packages/shared/src/enums/RadarBehavior.js';

const REPO = resolve(__dirname, '..');
const ACE_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/RadarBehavior.cs');

describe.skipIf(!aceReferenceExists(ACE_PATH))('ACE RadarBehavior coverage (FAITHFUL.139)', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_PATH, 'utf8');
  });

  it('TS port matches ACE source 1:1', () => {
    expect(src).toMatch(/Undefined\s*=\s*0/);
    expect(src).toMatch(/ShowNever\s*=\s*1/);
    expect(src).toMatch(/ShowMovement\s*=\s*2/);
    expect(src).toMatch(/ShowAttacking\s*=\s*3/);
    expect(src).toMatch(/ShowAlways\s*=\s*4/);

    expect(RadarBehavior.Undefined).toBe(0);
    expect(RadarBehavior.ShowNever).toBe(1);
    expect(RadarBehavior.ShowMovement).toBe(2);
    expect(RadarBehavior.ShowAttacking).toBe(3);
    expect(RadarBehavior.ShowAlways).toBe(4);
  });

  it('is a byte enum (wire format is uint8)', () => {
    expect(src).toMatch(/:\s*byte/);
  });
});

describe('radar-dot culling behavior (retail ACCWeenieObject::InqShowableOnRadar @ 0058c250)', () => {
  // _radar_enum ShowMovement / ShowAttacking / ShowAlways → showable;
  // Undefined (the PublicWeenieDesc default when the wire omits the
  // RadarBehavior header field) and ShowNever → no blip.
  it('shows exactly ShowMovement, ShowAttacking and ShowAlways', async () => {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const base = { uiHidden: false };
    for (const rb of [RadarBehavior.Undefined, RadarBehavior.ShowNever]) {
      expect(ServerObjectManager.radarDotEligible({ ...base, radarBehavior: rb })).toBe(false);
    }
    for (const rb of [RadarBehavior.ShowMovement, RadarBehavior.ShowAttacking, RadarBehavior.ShowAlways]) {
      expect(ServerObjectManager.radarDotEligible({ ...base, radarBehavior: rb })).toBe(true);
    }
  });
});
