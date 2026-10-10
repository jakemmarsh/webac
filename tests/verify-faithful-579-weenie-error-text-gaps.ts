/**
 * FAITHFUL.579 — Fill WeenieError text gaps for codes ACE actively emits.
 *
 * Audit summary: comparing the 369 WeenieError enum entries in
 * `reference/ACE/Source/ACE.Entity/Enum/WeenieError.cs` against the codes
 * actually referenced anywhere in `reference/ACE/Source/ACE.Server/` yielded
 * 27 codes that ACE emits but our `weenieErrorText` map had no user-visible
 * string for. 17 of those have a meaningful user-facing message (the rest
 * are internal/silent codes like NoMem, NoPhysicsObject, ITeleported, etc.,
 * intentionally left null so the chat stream isn't polluted with engine state).
 *
 * Each entry's docblock cites the ACE call site that proves the code is live
 * and the user-facing wording that matches retail UX. Some codes (LevelTooLow,
 * SkillTooLow, FullInventoryLocation, ConflictingInventoryLocation) flow
 * through GameEventInventoryServerSaveFailed — the
 * `onInventoryServerSaveFailed` handler at main.ts:7448 already routes
 * `weenieErrorText(errorType)` into the chat stream, so adding texts here
 * upgrades the user feedback from the generic "Inventory action failed" to
 * a specific actionable message.
 *
 * Goal anchor: GOAL.md > Wire-format faithfulness > "Every WeenieError code
 * has user-visible text anchored to its ACE summary."
 */
import { describe, it, expect } from 'vitest';
import { WeenieError, weenieErrorText } from '@ac/shared';

describe('FAITHFUL.579 — newly mapped WeenieError texts (motion + combat-mode rejections)', () => {
  it('CantCrouchInCombat surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.CantCrouchInCombat))
      .toBe("You can't crouch while in combat mode.");
  });

  it('CantSitInCombat surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.CantSitInCombat))
      .toBe("You can't sit while in combat mode.");
  });

  it('CantLieDownInCombat surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.CantLieDownInCombat))
      .toBe("You can't lie down while in combat mode.");
  });

  it('CantChatEmoteInCombat surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.CantChatEmoteInCombat))
      .toBe("You can't chat-emote while in combat mode.");
  });

  it('CantChatEmoteNotStanding surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.CantChatEmoteNotStanding))
      .toBe('You must be standing to use chat-emotes.');
  });

  it('CantJumpLoadedDown surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.CantJumpLoadedDown))
      .toBe("You're too encumbered to jump!");
  });

  it('TooManyActions surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.TooManyActions))
      .toBe('Too many actions queued.');
  });

  it('GeneralMovementFailure surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.GeneralMovementFailure))
      .toBe('Movement failed.');
  });

  it('ActionCancelled is the retail "Action cancelled!" spew text (CORE.17.k.c)', () => {
    // HandleFailureEvent @ 00571990 :360046 prints it at text type 0x1a; the
    // AttackDone per-swing 0x36 is never printed (onAttackDone has no text),
    // so the COMBAT.2 spam cannot come back through this entry.
    expect(weenieErrorText(WeenieError.ActionCancelled)).toBe('Action cancelled!');
  });
});

describe('FAITHFUL.579 — inventory-equip failures (routed via InventoryServerSaveFailed)', () => {
  it('SkillTooLow surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.SkillTooLow))
      .toBe('You are not skilled enough to use that.');
  });

  it('LevelTooLow surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.LevelTooLow))
      .toBe('You are not powerful enough to use that.');
  });

  it('FullInventoryLocation surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.FullInventoryLocation))
      .toBe('Your inventory is full.');
  });

  it('ConflictingInventoryLocation surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.ConflictingInventoryLocation))
      .toBe('Conflicting inventory placement.');
  });
});

describe('FAITHFUL.579 — magic + housing + targeting', () => {
  it('TargetNotAcquired surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.TargetNotAcquired))
      .toBe("You don't have a target selected.");
  });

  it('MagicInvalidSpellType surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.MagicInvalidSpellType))
      .toBe('Invalid spell type for this action.');
  });

  it('HouseAlreadyOwned matches ACE Player_House.cs:41 GameMessageSystemChat text', () => {
    // ACE Player_House.cs:40-41 ships "You already own a house!" via
    // GameMessageSystemChat at the call site. The WeenieError code is the
    // canonical type; we restore the user-visible text exactly.
    expect(weenieErrorText(WeenieError.HouseAlreadyOwned))
      .toBe('You already own a house!');
  });

  it('HouseRentFailed surfaces a useful message', () => {
    expect(weenieErrorText(WeenieError.HouseRentFailed))
      .toBe('House rent payment failed.');
  });
});

describe('FAITHFUL.579 — coverage count check', () => {
  it('weenieErrorText returns non-null for at least 16 of the 17 mapped codes', () => {
    const newCodes = [
      WeenieError.CantCrouchInCombat,
      WeenieError.CantSitInCombat,
      WeenieError.CantLieDownInCombat,
      WeenieError.CantChatEmoteInCombat,
      WeenieError.CantChatEmoteNotStanding,
      WeenieError.CantJumpLoadedDown,
      WeenieError.TooManyActions,
      WeenieError.GeneralMovementFailure,
      WeenieError.SkillTooLow,
      WeenieError.LevelTooLow,
      WeenieError.FullInventoryLocation,
      WeenieError.ConflictingInventoryLocation,
      WeenieError.TargetNotAcquired,
      WeenieError.MagicInvalidSpellType,
      WeenieError.HouseAlreadyOwned,
      WeenieError.HouseRentFailed,
    ];
    // All 16 should have text. ActionCancelled is the deliberate exception.
    for (const code of newCodes) {
      const text = weenieErrorText(code);
      expect(text, `WeenieError 0x${code.toString(16)} should have text`).not.toBeNull();
      expect(text!.length).toBeGreaterThan(3);
    }
  });
});
