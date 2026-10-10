/**
 * FAITHFUL.348 — onEmoteText + onSoulEmote honor /squelch + chatFilters.
 *
 * Pre-fix both handlers in main.ts bypassed the FAITHFUL.227 squelch
 * wiring. Visible bugs:
 *   - `/squelch add Bob` then Bob types `/me waves rudely` — the chat
 *     line still appeared AND a speech bubble spawned over Bob.
 *   - Same gap for SoulEmote (item-channeled emotes).
 *
 * Now both handlers gate on squelchedNames before
 * rendering, with `senderGuid !== aceCharGuid` so own outgoing emotes
 * always appear (you shouldn't squelch your own /me).
 *
 * Sibling FAITHFUL.347 (onChannelBroadcast) closed the same gap for
 * allegiance / fellowship channel chat. This commit extends the
 * coverage to the EmoteText (0x01E0) + SoulEmote (0x01E2) opcodes.
 *
 * (The client-side regex chatFilters were removed with the retail command
 * port: retail @filter squelches message TYPES, ModifyGlobalSquelch.)
 *
 * BUG.squelch-mask-per-channel-discarded — both handlers now mask on
 * ChatMessageType.Emote via blocksChannel() instead of a blanket presence
 * check. The mask math is behaviorally tested against the real SquelchState
 * class in tests/verify-set-squelch-db.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

function emoteBlock(): string {
  return MAIN.match(/onEmoteText:[\s\S]+?^      \},/m)?.[0] ?? '';
}

function soulEmoteBlock(): string {
  return MAIN.match(/onSoulEmote:[\s\S]+?^      \},/m)?.[0] ?? '';
}

describe('onEmoteText applies /squelch (FAITHFUL.348)', () => {
  it('handler checks squelchedNames at the top', () => {
    const block = emoteBlock();
    // FAITHFUL.522 — squelch lookup uses the locally-stripped senderName
    // (Olthoi "&"/"^" suffix removed) instead of the raw data.senderName.
    expect(block).toMatch(/squelchedNames\.blocksChannel\(senderName\.toLowerCase\(\), squelchMaskForChatType\(ChatMessageType\.Emote\)\)/);
  });

  it('squelch checks gated on senderGuid !== aceCharGuid (own emote not squelched)', () => {
    const block = emoteBlock();
    expect(block).toMatch(/senderGuid !== aceCharGuid/);
  });

  it('citation comment present', () => {
    const block = emoteBlock();
    expect(block).toContain('FAITHFUL.348');
  });
});

describe('onSoulEmote applies /squelch (FAITHFUL.348)', () => {
  it('handler checks squelchedNames at the top', () => {
    const block = soulEmoteBlock();
    // FAITHFUL.522 — squelch lookup uses the locally-stripped senderName
    // (Olthoi "&"/"^" suffix removed) instead of the raw data.senderName.
    expect(block).toMatch(/squelchedNames\.blocksChannel\(senderName\.toLowerCase\(\), squelchMaskForChatType\(ChatMessageType\.Emote\)\)/);
  });

  it('squelch checks gated on senderGuid !== aceCharGuid', () => {
    const block = soulEmoteBlock();
    expect(block).toMatch(/senderGuid !== aceCharGuid/);
  });

  it('citation comment present', () => {
    const block = soulEmoteBlock();
    expect(block).toContain('FAITHFUL.348');
  });
});
