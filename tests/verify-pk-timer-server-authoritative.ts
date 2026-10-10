/**
 * GAP.67 — [PK/PvP] PK timer.
 *
 * PREMISE CORRECTION: "No PK timer logic of any kind" is CORRECT, faithful
 * behavior — the PK timer is entirely SERVER-SIDE, and it is not something the
 * client can or should compute. The reconciliation flagged that only property
 * constants exist client-side; that is exactly right.
 *
 * ACE ground truth (Player_Combat.cs:1019-1023, Player_Death.cs:945-992):
 *   - PKTimerActive  => IsPKType && now - LastPkAttackTimestamp < pk_timer
 *   - PKLogoutActive => IsPKType && now - LastPkAttackTimestamp < PKLogoffTimer
 *   - MinimumTimeSincePk — the NPK↔PK respite timer, heartbeat-incremented
 *     server-side against pk_respite_timer.
 * All are computed with Time.GetUnixTime() + PropertyManager config. The
 * timestamp PropertyFloats (PkTimestamp 46, MinimumTimeSincePk 50,
 * LastPkAttackTimestamp 145) are plain server-side props — NOT flagged for
 * sending to the client (no [SendOnLogin]/[AssessmentProperty]), so the client
 * receives no timestamp to build a countdown from, and must not invent one.
 *
 * The ONLY client-visible surface of the PK timer is the error the server
 * sends when the timer BLOCKS an action — WeenieError.YouHaveBeenInPKBattle-
 * TooRecently (0x04CC), fired from portal recall (Portal.cs:161), melee
 * (Player_Melee.cs:84), item use (Player_Use.cs:33,180) and spellcasting
 * (WorldObject_Magic.cs). The client renders it via the shipped weenieErrorText
 * map. This test proves that surface is faithful (no code change needed — a
 * client-side PK-timer FORMULA would be UNFAITHFUL; the server owns it).
 */
import { describe, it, expect } from 'vitest';
import { WeenieError, weenieErrorText } from '@ac/shared';

const PK_BATTLE_ERR = 0x04CC;
const CANONICAL = 'You have been involved in a player killer battle too recently to do that!';

describe('GAP.67 — the PK-timer block error is the only client-visible surface, and it is faithful', () => {
  it('WeenieError.YouHaveBeenInPKBattleTooRecently matches the ACE enum value (0x04CC)', () => {
    expect(WeenieError.YouHaveBeenInPKBattleTooRecently).toBe(PK_BATTLE_ERR);
  });

  it('the client renders the canonical retail PK-timer block message', () => {
    // This is what the player sees when a portal recall / melee / item use /
    // spell is blocked because the server-side PK timer is still active.
    expect(weenieErrorText(PK_BATTLE_ERR)).toBe(CANONICAL);
    expect(weenieErrorText(WeenieError.YouHaveBeenInPKBattleTooRecently)).toBe(CANONICAL);
  });

  it('the message is a plain (no-placeholder) string — server sends it ready to display', () => {
    // Unlike name-substituted errors, this one carries no {name}/%s token, so
    // the client renders it verbatim with no formatting step.
    const text = weenieErrorText(PK_BATTLE_ERR)!;
    expect(text).not.toMatch(/%s|\{[a-zA-Z]/);
    expect(text.endsWith('!')).toBe(true);
  });
});
