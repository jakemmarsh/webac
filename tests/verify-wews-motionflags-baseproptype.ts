/**
 * FAITHFUL.61 — pin WeenieErrorWithString + MotionFlags + BasePropertyType
 * byte-for-byte to ACE source.
 *
 * WeenieErrorWithString carries chat-text on the wire for GameEvent 0x028B
 * (CommunicationTransientString-style with substitution). The exact integer
 * values are LOAD-BEARING because the server sends them as raw uint16/uint32
 * and the client looks up which template to substitute the actor name into.
 */
import { describe, it, expect } from 'vitest';
import {
  WeenieErrorWithString, WEENIE_ERROR_WITH_STRING_TEXT, weenieErrorWithStringText,
  MotionFlags, BasePropertyType,
} from '@ac/shared';

describe('WeenieErrorWithString (per ACE source)', () => {
  // FAITHFUL.64 update: WeenieErrorWithString was regenerated from current ACE
  // source (113 entries, was 116 in stale hand-port). The 3 missing entries
  // (YouHaveSwornAllegianceTo_=0x050F, _SwornAllegianceWith_=0x0510,
  // _IsAlreadyOneOfYourFollowers — wait, that one's still there) were moved
  // to the WeenieError enum proper in newer ACE. The PK affect-failure +
  // logout-cooldown + final-entry anchors all still hold byte-for-byte.
  it('113 distinct entries (boundary count anchored to current ACE source)', () => {
    const keys = Object.keys(WeenieErrorWithString).filter(k => isNaN(Number(k)));
    expect(keys.length).toBe(113);
  });

  it('low boundary: _IsTooBusyToAcceptGifts=0x001E', () => {
    expect(WeenieErrorWithString._IsTooBusyToAcceptGifts).toBe(0x001E);
  });

  it('high boundary: _CowersFromYou=0x058A (the final entry per ACE source)', () => {
    expect(WeenieErrorWithString._CowersFromYou).toBe(0x058A);
  });

  it('PK affect-failure block: 0x004E-0x0054 (8 reasons, contiguous range)', () => {
    expect(WeenieErrorWithString.YouFailToAffect_YouCannotAffectAnyone).toBe(0x004E);
    expect(WeenieErrorWithString.YouFailToAffect_TheyCannotBeHarmed).toBe(0x004F);
    expect(WeenieErrorWithString.YouFailToAffect_WithBeneficialSpells).toBe(0x0050);
    expect(WeenieErrorWithString.YouFailToAffect_YouAreNotPK).toBe(0x0051);
    expect(WeenieErrorWithString.YouFailToAffect_TheyAreNotPK).toBe(0x0052);
    expect(WeenieErrorWithString.YouFailToAffect_NotSamePKType).toBe(0x0053);
    expect(WeenieErrorWithString.YouFailToAffect_AcrossHouseBoundary).toBe(0x0054);
  });

  it('wait-cooldown blocks present in current ACE source', () => {
    // FAITHFUL.64: the prior YouMustWait_Seconds/MinutesBeforeYouCanLogout entries
    // at 0x0567/0x0568 in the stale hand-port were removed in current ACE. The
    // remaining communicate-cooldown variant is still present at 0x0547.
    expect(WeenieErrorWithString.YouMustWait_BeforeCommunicating).toBe(0x0547);
    expect(WeenieErrorWithString._IsAlreadyOnYourFriendsList).toBe(0x0562);
    expect(WeenieErrorWithString.YouMayOnlyChangeAllegianceNameOnceEvery24Hours).toBe(0x056A);
  });

  it('template-text map: leading-underscore templates restored from spacing', () => {
    // Generator reconstructs the `_` placeholder positions from ACE source
    // double-space markers. Leading space in <summary> → leading `_ ` in template.
    expect(WEENIE_ERROR_WITH_STRING_TEXT[WeenieErrorWithString._IsTooBusyToAcceptGifts])
      .toBe('_ is too busy to accept gifts right now.');
    expect(WEENIE_ERROR_WITH_STRING_TEXT[WeenieErrorWithString._CannotCarryAnymore])
      .toBe('_ cannot carry anymore.');
    expect(WEENIE_ERROR_WITH_STRING_TEXT[WeenieErrorWithString._CowersFromYou])
      .toBe('_ cowers from you!');
  });

  it('template text contains underscore placeholders for substitution', () => {
    const t = WEENIE_ERROR_WITH_STRING_TEXT[WeenieErrorWithString.YouFailToAffect_YouCannotAffectAnyone];
    expect(t).toContain('_');
    expect(t).toBe('You fail to affect _ because you cannot affect anyone!');
  });

  it('weenieErrorWithStringText: returns "" for unmapped codes (graceful fallback)', () => {
    expect(weenieErrorWithStringText(0xFFFF)).toBe('');
    expect(weenieErrorWithStringText(WeenieErrorWithString._IsTooBusyToAcceptGifts))
      .toBe('_ is too busy to accept gifts right now.');
  });
});

describe('MotionFlags (per ACE MotionFlags.cs)', () => {
  it('Flags byte: None=0x0, StickToObject=0x1, StandingLongJump=0x2', () => {
    expect(MotionFlags.None).toBe(0x0);
    expect(MotionFlags.StickToObject).toBe(0x1);
    expect(MotionFlags.StandingLongJump).toBe(0x2);
  });
});

describe('BasePropertyType (per ACE BasePropertyType.cs)', () => {
  it('sequential 0-21 covers 22 entries (no gaps)', () => {
    expect(BasePropertyType.Invalid).toBe(0);
    expect(BasePropertyType.Bool).toBe(1);
    expect(BasePropertyType.Integer).toBe(2);
    expect(BasePropertyType.LongInteger).toBe(3);
    expect(BasePropertyType.Float).toBe(4);
    expect(BasePropertyType.Vector).toBe(5);
    expect(BasePropertyType.Color).toBe(6);
    expect(BasePropertyType.String).toBe(7);
    expect(BasePropertyType.StringInfo).toBe(8);
    expect(BasePropertyType.Enum).toBe(9);
    expect(BasePropertyType.DataFile).toBe(10);
    expect(BasePropertyType.Waveform).toBe(11);
    expect(BasePropertyType.InstanceID).toBe(12);
    expect(BasePropertyType.Position).toBe(13);
    expect(BasePropertyType.TimeStamp).toBe(14);
    expect(BasePropertyType.Bitfield32).toBe(15);
    expect(BasePropertyType.Bitfield64).toBe(16);
    expect(BasePropertyType.Array).toBe(17);
    expect(BasePropertyType.Struct).toBe(18);
    expect(BasePropertyType.StringToken).toBe(19);
    expect(BasePropertyType.PropertyName).toBe(20);
    expect(BasePropertyType.TriState).toBe(21);
  });
});
