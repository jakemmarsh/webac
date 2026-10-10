/**
 * Weapon speed word on examine (VISUAL.examine-speed-row-missing-word).
 *
 * Ground truth — retail `AppraisalSystem::WeaponTimeToString` @ 005b4970
 * (reference/client-eol/decomp/acclient-decompiled.c:422765):
 *
 *   if (t < 0xb)       "Very Fast"     // t <= 10
 *   else if (t < 0x1f) "Fast"          // 11..30
 *   else if (t <= 0x31)"Average"       // 31..49  (decomp: !(0x31 < t))
 *   else if (t < 0x50) "Slow"          // 50..79
 *   else               "Very Slow"     // >= 80
 *
 * The examine row itself is built at acclient-decompiled.c:174839-174850:
 * "Speed: " + WeaponTimeToString(weapon_time), then sprintf "%s (%d)" —
 * so the visible value is "<word> (N)", never the bare number the client
 * rendered pre-fix. A negative weapon_time short-circuits at the call site
 * to "Speed:  Unknown" before WeaponTimeToString runs.
 *
 * Visual corroboration: reference/images/hud/examine-bow.jpg — Lilitha's
 * Bow (WeaponTime 40) shows "Speed: Average (40)".
 */
import { describe, it, expect } from 'vitest';
import { weaponTimeToString } from '@ac/shared';

describe('weaponTimeToString — retail thresholds @ 005b4970', () => {
  it('t <= 10 → "Very Fast"', () => {
    expect(weaponTimeToString(0)).toBe('Very Fast');
    expect(weaponTimeToString(10)).toBe('Very Fast');
  });

  it('11..30 → "Fast" (Sword of Lost Light, WeaponTime 30, reads "Fast (30)")', () => {
    expect(weaponTimeToString(11)).toBe('Fast');
    expect(weaponTimeToString(30)).toBe('Fast');
  });

  it('31..49 → "Average" (Lilitha\'s Bow, WeaponTime 40 — examine-bow.jpg)', () => {
    expect(weaponTimeToString(31)).toBe('Average');
    expect(weaponTimeToString(40)).toBe('Average');
    expect(weaponTimeToString(49)).toBe('Average');
  });

  it('50..79 → "Slow"', () => {
    expect(weaponTimeToString(50)).toBe('Slow');
    expect(weaponTimeToString(79)).toBe('Slow');
  });

  it('t >= 80 → "Very Slow"', () => {
    expect(weaponTimeToString(80)).toBe('Very Slow');
    expect(weaponTimeToString(200)).toBe('Very Slow');
  });

  it('negative input mirrors the decomp signed-long compare ("Very Fast"); the "Unknown" gate is the caller\'s', () => {
    // Retail's function takes a signed long: t < 0xb is true for negatives.
    // ItemExamineUI never reaches it with a negative (call-site "Unknown"
    // short-circuit) — GameUI mirrors that gate before calling this helper.
    expect(weaponTimeToString(-1)).toBe('Very Fast');
  });
});
