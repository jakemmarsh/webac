/**
 * FAITHFUL.240 — fellowship + allegiance sub-channel chat uses
 * GameAction.ChatChannel, not GameAction.Talk.
 *
 * Pre-fix `/fellowship <msg>` and `/f <msg>` sent via GameAction.Talk
 * (0x0015) — which broadcasts to nearby players, not fellowship members.
 * Per ACE GameActionChatChannel.cs each Channel enum value gets routed
 * to its membership set; the server then echoes via GameEventChannelBroadcast.
 *
 * Aliases per Microsoft KB Q243622:
 *   /f /fellow /fellowship → Channel.Fellow      (0x00000800)
 *   /v /vassals            → Channel.Vassals     (0x00001000)
 *   /p /patron             → Channel.Patron      (0x00002000)
 *   /m /monarch            → Channel.Monarch     (0x00004000)
 *   /c /covassals          → Channel.CoVassals   (0x01000000)
 *
 * Display side: onChannelBroadcast now routes per channel — Fellow uses
 * Fellowship color + "says to your fellowship" verb (confirmed AC retail
 * format); Vassals/Patron/Monarch/CoVassals/AllegianceBroadcast use the
 * Allegiance color.
 *
 * The /f /v /p /m /c commands themselves are now the retail
 * DoStupidChannelHack port (chat/commands/ChatCommands.ts), driven in
 * verify-retail-commands-chat.ts.
 */
import { describe, it, expect } from 'vitest';
import { Channel, ChatMessageType, chatColorFor } from '@ac/shared';
import { buildChatChannelPayload, parseChatChannelPayload, BinaryReader } from '@ac/network';

describe('FAITHFUL.240 — fellowship + allegiance sub-channel chat → ChatChannel', () => {
  it('buildChatChannelPayload writes channel (u32) then message (String16L) — behavioral, byte-exact', () => {
    const payload = buildChatChannelPayload(Channel.Fellow, 'party up?');
    expect(parseChatChannelPayload(payload)).toEqual({ channel: Channel.Fellow, message: 'party up?' });

    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(Channel.Fellow); // channel first
    expect(reader.readString16()).toBe('party up?');  // message second
  });

  it('Channel enum values are the wire-correct flags from Channel.cs', () => {
    expect(Channel.Fellow).toBe(0x00000800);
    expect(Channel.Vassals).toBe(0x00001000);
    expect(Channel.Patron).toBe(0x00002000);
    expect(Channel.Monarch).toBe(0x00004000);
    expect(Channel.CoVassals).toBe(0x01000000);
    expect(Channel.AllegianceBroadcast).toBe(0x02000000);
  });

  // The per-channel line wording + text type is behaviour-tested in
  // tests/verify-channel-broadcast-squelch.ts (DECOMP.channel-broadcast-self-echo).

  it('Fellowship and Allegiance chat colors are distinct (not generic Channel pink) — retail colorYellow / colorOrange / colorPink (CORE.17.s)', () => {
    expect(chatColorFor(ChatMessageType.Fellowship)).toBe('#ffff3f');
    expect(chatColorFor(ChatMessageType.Allegiance)).toBe('#ee921e');
    expect(chatColorFor(ChatMessageType.Channel)).toBe('#ff9696');
  });
});
