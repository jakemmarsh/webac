/**
 * FAITHFUL.237 — server-sent PropertyBool updates route 4 admin/option flags
 * into PlayerState (PlayerState.applyServerBool, used by main.ts's
 * onPrivateUpdatePropertyBool and — for our own guid — onPublicUpdatePropertyBool).
 *
 * Pre-fix the handler only routed Afk; IsAdvocate / IsPsr /
 * SpellComponentsRequired / IgnoreHouseBarriers were logged but dropped.
 * BUG.spellcast-cost-components: ACE's `@requirecomps` sends
 * SpellComponentsRequired as a PUBLIC update (DeveloperCommands.cs:2543/2549),
 * so the same routing applies to public updates addressed to the player.
 *
 * (Converted from a main.ts source-text pin to a behavioral test.)
 */
import { describe, it, expect } from 'vitest';
import { PropertyBool } from '@ac/shared';
import { PlayerState } from '../packages/renderer/src/player/PlayerState';

describe('FAITHFUL.237 — PlayerState.applyServerBool routes 4 server-tracked flags', () => {
  const FIELDS = [
    { key: PropertyBool.IgnoreHouseBarriers, value: 25, read: (p: PlayerState) => p.ignoreHouseBarriers },
    { key: PropertyBool.IsAdvocate, value: 47, read: (p: PlayerState) => p.isAdvocate },
    { key: PropertyBool.SpellComponentsRequired, value: 68, read: (p: PlayerState) => p.spellComponentsRequired },
    { key: PropertyBool.IsPsr, value: 97, read: (p: PlayerState) => p.isPsr },
  ];

  for (const { key, value, read } of FIELDS) {
    it(`PropertyBool ${value} flips its PlayerState field both ways`, () => {
      expect(key).toBe(value);
      const p = new PlayerState();
      expect(p.applyServerBool(key, true)).toBe(true);
      expect(read(p)).toBe(true);
      expect(p.applyServerBool(key, false)).toBe(true);
      expect(read(p)).toBe(false);
    });
  }

  it('ignores unrelated keys (Afk is owned by main.ts playerAfk)', () => {
    const p = new PlayerState();
    expect(p.applyServerBool(PropertyBool.Afk, true)).toBe(false);
    expect(PropertyBool.Afk).toBe(110);
    expect(p.spellComponentsRequired).toBe(false); // the retail InqBool default, untouched
  });
});
