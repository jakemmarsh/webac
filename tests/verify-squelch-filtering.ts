/**
 * FAITHFUL.227 — /squelch command actually filters incoming chat.
 *
 * Pre-FAITHFUL.227, the `/squelch add Foo` chat command added "foo" to a
 * `squelchedNames` Set but the chat-event handlers (onHearSpeech,
 * onHearRangedSpeech, onTell, onTurbineChat) never consulted that Set.
 * Squelched players' speech, ranged speech, tells, and channel chat
 * still appeared in the chat window.
 *
 * Fix: each chat handler now early-returns when the sender's name (lower-
 * cased) is in squelchedNames. (The client-side regex chatFilters were
 * removed with the retail command port: retail @filter is
 * ModifyGlobalSquelch by message type.)
 *
 * Self-cast exemption: onHearSpeech excludes data.senderGuid === aceCharGuid
 * from squelch so a player can't accidentally squelch themselves (which
 * would also break FAITHFUL.219's cast-incantation projectile consumer).
 *
 * Reference: ACE retail squelch behavior — squelched players' chat is
 * silently filtered client-side; the server still delivers it because
 * squelch was a client-only setting.
 *
 * BUG.squelch-mask-per-channel-discarded — onHearSpeech/onHearRangedSpeech/
 * onTell moved from a blanket `squelchedNames.has(name)` presence check to
 * `squelchedNames.blocksChannel(name, squelchMaskForChatType(...))`, mirroring
 * ACE's per-channel SquelchDB.Contains() (WorldObject_Networking.cs:1393 for
 * HearSpeech/RangedSpeech's `squelchType`, GameActionTell.cs:39 for Tell's
 * fixed ChatMessageType.Tell). The mask math itself (per-name bit OR global
 * bit) is behaviorally tested in tests/verify-set-squelch-db.ts against the
 * real SquelchState class; this file only pins that each main.ts call site
 * still routes through that check (main.ts isn't unit-callable in isolation
 * — it's a top-level `main()` that boots the whole app on import).
 * onTurbineChat stays a blanket `.has()` — ACE's own General/Trade/LFG/
 * Olthoi/Society recipient filter (TurbineChatHandler.cs:203,240,314) always
 * tests ChatMessageType.AllChannels, not a per-channel bit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.227 — /squelch filters incoming chat', () => {
  it('onHearSpeech early-returns when sender is squelched for this channel', () => {
    expect(MAIN_TS).toMatch(/onHearSpeech[\s\S]{0,500}squelchedNames\.blocksChannel\(senderName\.toLowerCase\(\), squelchMaskForChatType\(data\.chatType\)\)/);
  });

  it('onHearRangedSpeech early-returns when sender is squelched for this channel', () => {
    // FAITHFUL.522 — squelch lookup uses the locally-stripped senderName
    // (Olthoi "&"/"^" suffix removed) and the helper push past 300 chars.
    expect(MAIN_TS).toMatch(/onHearRangedSpeech[\s\S]{0,800}squelchedNames\.blocksChannel\(senderName\.toLowerCase\(\), squelchMaskForChatType\(data\.chatType\)\)/);
  });

  it('onTell early-returns when sender is squelched on the Tell channel', () => {
    // FAITHFUL.245 added a tellsEnabled gate ahead of the squelch check, so
    // the squelch is no longer within 300 chars of the onTell signature.
    // Widen the window — squelch still gates Tell display.
    // FAITHFUL.521 — onTell first strips the Olthoi "&" suffix into a
    // local `senderName`, then squelch-checks against the cleaned name
    // so squelched "bob" still matches an incoming "bob&".
    expect(MAIN_TS).toMatch(/onTell[\s\S]{0,1200}squelchedNames\.blocksChannel\(senderName\.toLowerCase\(\), squelchMaskForChatType\(ChatMessageType\.Tell\)\)/);
  });

  it('onTurbineChat (channel chat) early-returns when sender is squelched', () => {
    expect(MAIN_TS).toMatch(/onTurbineChat[\s\S]{0,800}squelchedNames\.has\(data\.senderName\.toLowerCase\(\)\)/);
  });
});
