/**
 * WeenieErrorText — pure unit test for combat-feedback string mapping.
 *
 * Anchors the codes against ACE C# (reference/ACE/Source/ACE.Entity/Enum/WeenieError.cs)
 * so a future refactor cannot silently desync the user-visible text from the
 * server's actual error code.
 */
import { describe, it, expect } from 'vitest';
import * as shared from '@ac/shared';
import { WeenieError, weenieErrorText } from '@ac/shared';

describe('weenieErrorText', () => {
  it('returns null for None (success)', () => {
    expect(weenieErrorText(WeenieError.None)).toBeNull();
  });

  it('returns null for unknown codes (fallback to no chat noise)', () => {
    expect(weenieErrorText(0xDEAD)).toBeNull();
    expect(weenieErrorText(0xFFFF)).toBeNull();
  });

  it('maps the combat-loop errors to AC client-style strings', () => {
    // Each string here is the verbatim ACE <summary> tag — never paraphrased.
    expect(weenieErrorText(WeenieError.YoureTooBusy)).toBe("You're too busy!");
    expect(weenieErrorText(WeenieError.YouAreTooFatiguedToAttack)).toBe('You are too fatigued to attack!');
    expect(weenieErrorText(WeenieError.YouChargedTooFar)).toBe('You charged too far!');
    expect(weenieErrorText(WeenieError.YouAreOutOfAmmunition)).toBe('You are out of ammunition!');
    expect(weenieErrorText(WeenieError.YouCantDoThatWhileInTheAir)).toBe("You can't do that while in the air!");
  });

  it('ActionCancelled carries the retail "Action cancelled!" (CORE.17.k.c)', () => {
    // The decompiled client's HandleFailureEvent @ 00571990 prints it on the
    // spew box (:360046) for a 0x028A WeenieError — ACE Player_Combat.cs:744.
    // The AttackDone event's 0x36 (ACE Player_Melee.cs:226, "not displayed to
    // the client") is a different message: retail's HandleAttackDoneEvent has
    // no text and main.ts onAttackDone prints nothing, so the COMBAT.2
    // per-swing spam cannot return through this entry.
    expect(weenieErrorText(WeenieError.ActionCancelled)).toBe('Action cancelled!');
  });

  it('maps mode-change rejection so wand-equipped Melee fails are visible', () => {
    // ACE source <summary>: "You failed to go to non-combat mode." — the
    // enum name says "ChangeCombatModeFailure" but the displayed text is the
    // non-combat-specific phrasing. Generator pulls it verbatim.
    expect(weenieErrorText(WeenieError.ChangeCombatModeFailure)).toBe('You failed to go to non-combat mode.');
  });

  it('exposes the exact ACE C# codes (not paraphrased)', () => {
    // Anchored to reference/ACE/Source/ACE.Entity/Enum/WeenieError.cs
    expect(WeenieError.None).toBe(0x0000);
    expect(WeenieError.YoureTooBusy).toBe(0x001D);
    expect(WeenieError.ActionCancelled).toBe(0x0036);
    expect(WeenieError.Dead).toBe(0x003A);
    expect(WeenieError.ChangeCombatModeFailure).toBe(0x03F1);
    expect(WeenieError.YouAreOutOfAmmunition).toBe(0x03F8);
    expect(WeenieError.YouCantDoThatWhileInTheAir).toBe(0x04EB);
  });

  // FAITHFUL.8 — expanded WeenieError table now covers the top-frequency codes
  // from ACE source. These were silently dropped before, leaving the player
  // confused why an action failed.
  //
  // FAITHFUL.62 update: Stuck text was paraphrased ("You are stuck!") in the
  // hand-port. The actual ACE <summary> for Stuck=0x0029 is "You cannot pick
  // that up!" — the enum *name* is the AC C-side variable, not the displayed
  // string. The generator now pulls the authoritative summary verbatim.
  it('maps common inventory/trade/movement errors', () => {
    expect(weenieErrorText(WeenieError.Stuck)).toBe('You cannot pick that up!');
    expect(weenieErrorText(WeenieError.TheContainerIsClosed)).toBe('The container is closed!');
    expect(weenieErrorText(WeenieError.YouHaveMovedTooFar)).toBe('You have moved too far!');
    // FAITHFUL.540 — Trade* WeenieErrors had no <summary> in ACE source
    // (the ACE devs left them blank because the original AC client
    // resolved them from its hard-coded TextMaster.dat lookup). Pre-fix
    // these returned null and chat was silent on real server emissions.
    // Now provided via the manual override block in the generator —
    // wording derived from the ACE emit-site semantic + enum name.
    expect(weenieErrorText(WeenieError.TradeNonCombatMode)).toBe('You cannot trade while in combat mode.');
    expect(weenieErrorText(WeenieError.TradeItemBeingTraded)).toBe('That item is being traded. You must close the trade window first.');
    // FAITHFUL.579: SkillTooLow (0x0468) is now mapped. ACE Player_Inventory.cs:2138/2146
    // returns it from CheckWieldRequirements; the result flows through
    // GameEventInventoryServerSaveFailed with errorType=SkillTooLow. The
    // ServerMessageHandler's onInventoryServerSaveFailed call site uses
    // weenieErrorText(errorType) to compose the user message — so pre-fix
    // it fell back to the generic "Inventory action failed" string. The
    // explicit text "You are not skilled enough to use that." is far more
    // actionable for a wield-equip failure. Anchor: enum name semantic.
    expect(weenieErrorText(WeenieError.SkillTooLow)).toBe('You are not skilled enough to use that.');
  });

  // FAITHFUL.540 — additional trade WeenieError overrides covering all
  // emit sites in ACE Player_Trade.cs. Anchored to ACE source lines.
  it('FAITHFUL.540: trade WeenieErrors all have user-facing text', () => {
    expect(weenieErrorText(WeenieError.TradeIgnoringRequests))
      .toBe('That person is ignoring trade requests.');
    expect(weenieErrorText(WeenieError.TradeMaxDistanceExceeded))
      .toBe('You are too far away to trade with that person.');
    expect(weenieErrorText(WeenieError.TradeAlreadyTrading))
      .toBe('You are already trading with someone.');
    expect(weenieErrorText(WeenieError.TradeClosed))
      .toBe('Trade closed.');
  });

  it('maps allegiance/channel/crafting errors per ACE source', () => {
    // Verbatim from ACE source — many entries differ from intuition.
    expect(weenieErrorText(WeenieError.YouAreNotInAllegiance)).toBe('You are not in an allegiance!');
    expect(weenieErrorText(WeenieError.YouDoNotHaveAuthorityInAllegiance))
      .toBe('You do not have the authority within your allegiance to do that.');
    expect(weenieErrorText(WeenieError.YouCantUseThatChannel)).toBe("You can't use that channel.");
    expect(weenieErrorText(WeenieError.YouDoNotPassCraftingRequirements))
      .toBe('Either you or one of the items involved does not pass the requirements for this craft interaction.');
  });

  it('expanded codes match ACE numeric values', () => {
    expect(WeenieError.NoPhysicsObject).toBe(0x0008);
    expect(WeenieError.Stuck).toBe(0x0029);
    expect(WeenieError.TheContainerIsClosed).toBe(0x03EE);
    expect(WeenieError.YouAreNotInAllegiance).toBe(0x0414);
    expect(WeenieError.TradeItemBeingTraded).toBe(0x0453);
    expect(WeenieError.SkillTooLow).toBe(0x0468);
    expect(WeenieError.YouMustOwnHouseToUseCommand).toBe(0x047F);
    expect(WeenieError.YouHaveMovedTooFar).toBe(0x0498);
    expect(WeenieError.YouMustLinkToPortalToRecall).toBe(0x04A3);
    expect(WeenieError.YouDoNotHaveAuthorityInAllegiance).toBe(0x0535);
  });

  // FAITHFUL.19 second-tier expansion: another 15 entries from the next-most-thrown
  // server codes (fellowship leadership, jump positioning, spell fizzle, PK transitions,
  // trade peace-mode requirement, etc.).
  it('FAITHFUL.19 expanded codes — exact ACE numerics', () => {
    expect(WeenieError.NoObject).toBe(0x0038);
    expect(WeenieError.YouCantJumpFromThisPosition).toBe(0x0048);
    expect(WeenieError.YourSpellFizzled).toBe(0x0402);
    expect(WeenieError.YouMustBeLeaderOfFellowship).toBe(0x041D);
    expect(WeenieError.YourFellowshipIsFull).toBe(0x041E);
    expect(WeenieError.YouMustBeInPeaceModeToTrade).toBe(0x043A);
    expect(WeenieError.YouCannotLinkToThatPortal).toBe(0x043D);
    expect(WeenieError.YouCannotLockOrUnlockThat).toBe(0x04B0);
    expect(WeenieError.YouDoNotOwnThatItem).toBe(0x04BE);
    expect(WeenieError.YouAreNowPKLite).toBe(0x0508);
    expect(WeenieError.YouAreNotPermittedToUseThatHook).toBe(0x0516);
    expect(WeenieError.TradeComplete).toBe(0x0529);
    expect(WeenieError.MissileOutOfRange).toBe(0x0550);
    expect(WeenieError.OnlyHouseOwnerCanUseCommand).toBe(0x0564);
  });

  it('FAITHFUL.19 second-tier maps display strings verbatim from ACE source', () => {
    expect(weenieErrorText(WeenieError.YourSpellFizzled)).toBe('Your spell fizzled.');
    expect(weenieErrorText(WeenieError.YouMustBeLeaderOfFellowship)).toBe('You must be the leader of a Fellowship');
    expect(weenieErrorText(WeenieError.YourFellowshipIsFull)).toBe('Your Fellowship is full');
    expect(weenieErrorText(WeenieError.YouMustBeInPeaceModeToTrade)).toBe('You must be at rest in peace mode to do trade skills.');
    expect(weenieErrorText(WeenieError.YouCannotLinkToThatPortal)).toBe('You cannot link to that portal!');
    expect(weenieErrorText(WeenieError.TradeComplete)).toBe('Trade Complete!');
    expect(weenieErrorText(WeenieError.MissileOutOfRange)).toBe('Out of Range!');
    expect(weenieErrorText(WeenieError.YouAreNowPKLite))
      .toBe('A cold wind touches your heart. You are now a Player Killer Lite.');
  });
});

describe('DECOMP.invented-combat-mode-refusal', () => {
  // Retail has no text for a refused combat-mode change (ACE reverts it with a
  // silent PropertyInt(CombatMode, NonCombat)); the invented helper is gone.
  it('@ac/shared no longer exports the invented combatModeRejectionReason helper', () => {
    expect('combatModeRejectionReason' in shared).toBe(false);
  });
});
