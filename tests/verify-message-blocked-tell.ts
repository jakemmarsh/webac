/**
 * FAITHFUL.554 — MessageBlocked_ template restores `_` placeholder
 * so /tell + /talkdirect to a squelching player shows the actual
 * "Name has you squelched." reason instead of literally
 * `"Message Blocked: "` (quotes + empty body).
 *
 *  ACE emit sites:
 *    GameActionTell.cs:41 — value=$"{target} has you squelched."
 *    GameActionTalkDirect.cs:41 — value=$"{targetPlayer.Name} has you squelched."
 *
 *  ACE WeenieErrorWithString.cs <summary> for MessageBlocked_ (0x051F)
 *  is `"Message Blocked: "_` (the placeholder follows a colon+space).
 *  The generator's spacing-heuristic reconstructor missed it — landed
 *  the template as `"Message Blocked: "` (no `_`) with the wrapping
 *  quotes preserved. Override restores the canonical form
 *  `Message Blocked: _`.
 */
import { describe, it, expect } from 'vitest';
import { formatWeenieErrorWithString, WeenieErrorWithString } from '@ac/shared';

describe('FAITHFUL.554 — MessageBlocked_ template restores placeholder', () => {
  it('formats the /tell-squelched scenario with the actual squelcher name', () => {
    const out = formatWeenieErrorWithString(
      WeenieErrorWithString.MessageBlocked_,
      'TestPartner has you squelched.',
    );
    expect(out).toBe('Message Blocked: TestPartner has you squelched.');
  });

  it('formats the /talkdirect-squelched scenario the same way', () => {
    const out = formatWeenieErrorWithString(
      WeenieErrorWithString.MessageBlocked_,
      'OtherPlayer has you squelched.',
    );
    expect(out).toBe('Message Blocked: OtherPlayer has you squelched.');
  });

  it('does not include the malformed quoted-empty `"Message Blocked: "` text', () => {
    const out = formatWeenieErrorWithString(WeenieErrorWithString.MessageBlocked_, 'X has you squelched.');
    expect(out).not.toMatch(/"Message Blocked: "/);
  });
});
