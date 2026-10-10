/**
 * FAITHFUL.57 — pin CharacterOptions1 + CharacterOptions2 byte-for-byte.
 *
 * Sources:
 *   reference/ACE/Source/ACE.Entity/Enum/CharacterOptions1.cs
 *   reference/ACE/Source/ACE.Entity/Enum/CharacterOptions2.cs
 *
 * The Default expression in ACE source has a comment with the exact integer
 * value (1355064650 and 9733888 respectively). Pinning these guards against
 * any future change to either the bit positions or the Default membership.
 */
import { describe, it, expect } from 'vitest';
import {
  CharacterOptions1, CHARACTER_OPTIONS1_DEFAULT,
  CharacterOptions2, CHARACTER_OPTIONS2_DEFAULT,
} from '@ac/shared';

describe('CharacterOptions1 (per ACE source)', () => {
  it('boundary bits: NotUsed1=0x1, AutoRepeatAttack=0x2, UseCraftSuccessDialog=0x80000000', () => {
    expect(CharacterOptions1.NotUsed1).toBe(0x00000001);
    expect(CharacterOptions1.AutoRepeatAttack).toBe(0x00000002);
    expect(CharacterOptions1.UseCraftSuccessDialog).toBe(0x80000000);
  });

  it('gameplay flags: AutoTarget=0x2000, ToggleRun=0x400, ShowTooltips=0x100', () => {
    expect(CharacterOptions1.AutoTarget).toBe(0x00002000);
    expect(CharacterOptions1.ToggleRun).toBe(0x00000400);
    expect(CharacterOptions1.ShowTooltips).toBe(0x00000100);
  });

  it('fellowship flags: ShareXP=0x40000, ShareLoot=0x100000, AutoAccept=0x20000000', () => {
    expect(CharacterOptions1.FellowshipShareXP).toBe(0x00040000);
    expect(CharacterOptions1.FellowshipShareLoot).toBe(0x00100000);
    expect(CharacterOptions1.AutoAcceptFellowRequest).toBe(0x20000000);
  });

  it('chat flags: HearAllegianceChat=0x40000000, DisplayAllegianceLogonNotifications=0x08000000', () => {
    expect(CharacterOptions1.HearAllegianceChat).toBe(0x40000000);
    expect(CharacterOptions1.DisplayAllegianceLogonNotifications).toBe(0x08000000);
  });

  it('reserved NotUsedN slots: 0x01, 0x10, 0x20, 0x4000, 0x01000000 (5 slots)', () => {
    expect(CharacterOptions1.NotUsed1).toBe(0x00000001);
    expect(CharacterOptions1.NotUsed2).toBe(0x00000010);
    expect(CharacterOptions1.NotUsed3).toBe(0x00000020);
    expect(CharacterOptions1.NotUsed4).toBe(0x00004000);
    expect(CharacterOptions1.NotUsed5).toBe(0x01000000);
  });

  it('Default = 1355064650 (per ACE inline comment)', () => {
    expect(CHARACTER_OPTIONS1_DEFAULT).toBe(1355064650);
  });

  it('Default is the OR of the 12 ACE-listed flags (no others)', () => {
    const expected =
      CharacterOptions1.AutoRepeatAttack | CharacterOptions1.IgnoreFellowshipRequests |
      CharacterOptions1.AllowGive | CharacterOptions1.ShowTooltips |
      CharacterOptions1.ToggleRun | CharacterOptions1.AutoTarget |
      CharacterOptions1.VividTargetingIndicator | CharacterOptions1.FellowshipShareXP |
      CharacterOptions1.CoordinatesOnRadar | CharacterOptions1.SpellDuration |
      CharacterOptions1.UseChargeAttack | CharacterOptions1.HearAllegianceChat;
    expect(CHARACTER_OPTIONS1_DEFAULT).toBe(expected >>> 0);
  });
});

describe('CharacterOptions2 (per ACE source)', () => {
  it('boundary bits: PersistentAtDay=0x1, HearPKDeath=0x02000000', () => {
    expect(CharacterOptions2.PersistentAtDay).toBe(0x00000001);
    expect(CharacterOptions2.HearPKDeath).toBe(0x02000000);
  });

  it('HUD flags: ShowHelm=0x100000, ShowCloak=0x800000, LockUI=0x01000000', () => {
    expect(CharacterOptions2.ShowHelm).toBe(0x00100000);
    expect(CharacterOptions2.ShowCloak).toBe(0x00800000);
    expect(CharacterOptions2.LockUI).toBe(0x01000000);
    expect(CharacterOptions2.DisableDistanceFog).toBe(0x00200000);
  });

  it('chat filter flags: HearGeneralChat=0x100 through HearSocietyChat=0x80000', () => {
    expect(CharacterOptions2.HearGeneralChat).toBe(0x00000100);
    expect(CharacterOptions2.HearTradeChat).toBe(0x00000200);
    expect(CharacterOptions2.HearLFGChat).toBe(0x00000400);
    expect(CharacterOptions2.HearRoleplayChat).toBe(0x00000800);
    expect(CharacterOptions2.HearSocietyChat).toBe(0x00080000);
  });

  it('display flags: DisplayDateOfBirth=0x2, DisplayAge=0x20, DisplayNumberCharacterTitles=0x2000', () => {
    expect(CharacterOptions2.DisplayDateOfBirth).toBe(0x00000002);
    expect(CharacterOptions2.DisplayChessRank).toBe(0x00000004);
    expect(CharacterOptions2.DisplayFishingSkill).toBe(0x00000008);
    expect(CharacterOptions2.DisplayNumberDeaths).toBe(0x00000010);
    expect(CharacterOptions2.DisplayAge).toBe(0x00000020);
    expect(CharacterOptions2.DisplayNumberCharacterTitles).toBe(0x00002000);
  });

  it('missile flags: LeadMissileTargets=0x8000, UseFastMissiles=0x10000', () => {
    expect(CharacterOptions2.LeadMissileTargets).toBe(0x00008000);
    expect(CharacterOptions2.UseFastMissiles).toBe(0x00010000);
  });

  it('Default = 9733888 (per ACE inline comment)', () => {
    expect(CHARACTER_OPTIONS2_DEFAULT).toBe(9733888);
  });

  it('Default is HearGeneralChat | HearTradeChat | HearLFGChat | LeadMissileTargets | ConfirmVolatileRareUse | ShowHelm | ShowCloak', () => {
    const expected =
      CharacterOptions2.HearGeneralChat | CharacterOptions2.HearTradeChat |
      CharacterOptions2.HearLFGChat | CharacterOptions2.LeadMissileTargets |
      CharacterOptions2.ConfirmVolatileRareUse | CharacterOptions2.ShowHelm |
      CharacterOptions2.ShowCloak;
    expect(CHARACTER_OPTIONS2_DEFAULT).toBe(expected >>> 0);
  });
});
