/**
 * DECOMP.channel-broadcast-self-echo — ChannelBroadcast (0x0147) lines match
 * ClientCommunicationSystem::Handle_Communication__ChannelBroadcast @ 00570b90.
 * The sprintf formats were read from the exe (.rdata 0x7d0bfc–0x7d0e10);
 * the channel names from ChannelSystem::GetChannelName @ 005cfd80.
 *
 * Squelch: retail calls IsSquelched(0, "", type), so only the global
 * per-type squelch applies. A per-sender /squelch does not hide channel chat.
 * (This replaces the FAITHFUL.347 source-text pins.)
 */
import { describe, it, expect } from 'vitest';
import { Channel, ChatMessageType, SquelchMask, squelchMaskForChatType } from '@ac/shared';
import { channelBroadcastToShow, channelName, formatChannelBroadcast } from '../packages/renderer/src/chat/ChannelBroadcastLine.js';
import { SquelchState } from '../packages/renderer/src/session/SquelchState.js';

const fmt = (ch: number, sender: string) => formatChannelBroadcast(ch, sender, 'hi');

describe('ChannelBroadcast self echo (empty sender)', () => {
  it('Vassals / Patron / Monarch: "You say to your <channel>", OutgoingSocial (0x0B)', () => {
    expect(fmt(Channel.Vassals, '')).toEqual({ text: 'You say to your Vassals, "hi"', type: ChatMessageType.SocialSend });
    expect(fmt(Channel.Patron, '')).toEqual({ text: 'You say to your Patron, "hi"', type: ChatMessageType.SocialSend });
    expect(fmt(Channel.Monarch, '')).toEqual({ text: 'You say to your Monarch, "hi"', type: ChatMessageType.SocialSend });
  });

  it('Fellow, Co-Vassals, Allegiance Broadcast use their bracketed formats', () => {
    expect(fmt(Channel.Fellow, '')).toEqual({ text: '[Fellowship] You say, "hi"', type: ChatMessageType.Fellowship });
    expect(fmt(Channel.CoVassals, '')).toEqual({ text: '[Co-Vassals] You say, "hi"', type: ChatMessageType.Social });
    expect(fmt(Channel.AllegianceBroadcast, '')).toEqual({ text: '[Allegiance Broadcast] You say, "hi"', type: ChatMessageType.Social });
  });

  it('FellowBroadcast is the bare message, type 0x13', () => {
    expect(fmt(Channel.FellowBroadcast, '')).toEqual({ text: 'hi', type: ChatMessageType.Fellowship });
  });

  it('other channels: "You say on the <name> channel"; Help 0x0F, Abuse 0x0E, else 0x09', () => {
    expect(fmt(Channel.Help, '')).toEqual({ text: 'You say on the Help channel, "hi"', type: ChatMessageType.Help });
    expect(fmt(Channel.Abuse, '')).toEqual({ text: 'You say on the Abuse channel, "hi"', type: ChatMessageType.Abuse });
    expect(fmt(Channel.Audit, '')).toEqual({ text: 'You say on the Audit channel, "hi"', type: ChatMessageType.ChannelSend });
    expect(fmt(Channel.Olthoi, '').text).toBe('You say on the Olthoi channel, "hi"');
  });
});

describe('ChannelBroadcast from another player', () => {
  it('allegiance chain lines are addressed to you, Social (0x0A)', () => {
    expect(fmt(Channel.Monarch, 'Bob')).toEqual({ text: 'Your follower Bob says to you, "hi"', type: ChatMessageType.Social });
    expect(fmt(Channel.Patron, 'Bob')).toEqual({ text: 'Your vassal Bob says to you, "hi"', type: ChatMessageType.Social });
    expect(fmt(Channel.Vassals, 'Bob')).toEqual({ text: 'Your patron Bob says to you, "hi"', type: ChatMessageType.Social });
  });

  it('bracketed channels', () => {
    expect(fmt(Channel.Fellow, 'Bob')).toEqual({ text: '[Fellowship] Bob says, "hi"', type: ChatMessageType.Fellowship });
    expect(fmt(Channel.CoVassals, 'Bob')).toEqual({ text: '[Co-Vassals] Bob says, "hi"', type: ChatMessageType.Social });
    expect(fmt(Channel.AllegianceBroadcast, 'Bob')).toEqual({ text: '[Allegiance Broadcast] Bob says, "hi"', type: ChatMessageType.Social });
  });

  it('other channels: "<name> says on the <channel> channel"; Help 0x0F, Abuse 0x0E, else 0x08', () => {
    expect(fmt(Channel.Help, 'Bob')).toEqual({ text: 'Bob says on the Help channel, "hi"', type: ChatMessageType.Help });
    expect(fmt(Channel.Abuse, 'Bob')).toEqual({ text: 'Bob says on the Abuse channel, "hi"', type: ChatMessageType.Abuse });
    expect(fmt(Channel.FellowBroadcast, 'Bob')).toEqual({ text: 'Bob says on the FellowBroadcast channel, "hi"', type: ChatMessageType.Channel });
  });

  it('GetChannelName table, with "<unknown>" for an unnamed channel', () => {
    expect(channelName(Channel.CoVassals)).toBe('Co-vassals');
    expect(channelName(Channel.AllegianceBroadcast)).toBe('Allegiance');
    expect(channelName(Channel.SocietyEldWebBroadcast)).toBe('Eldrytch Web');
    expect(channelName(Channel.Debug)).toBe('<unknown>');
  });
});

describe('channelBroadcastToShow squelch + filters', () => {
  it('a per-sender squelch does not hide channel chat (IsSquelched(0, "", type))', () => {
    const s = new SquelchState();
    s.set('bob', 'Bob', SquelchMask.AllChannels);
    expect(channelBroadcastToShow({ channel: Channel.Fellow, senderName: 'Bob', message: 'hi' }, s, [])?.text)
      .toBe('[Fellowship] Bob says, "hi"');
  });

  it('the global per-type squelch hides that type, self echo included', () => {
    const s = new SquelchState();
    s.globalMask = squelchMaskForChatType(ChatMessageType.Fellowship);
    expect(channelBroadcastToShow({ channel: Channel.Fellow, senderName: 'Bob', message: 'hi' }, s, [])).toBeNull();
    expect(channelBroadcastToShow({ channel: Channel.Fellow, senderName: '', message: 'hi' }, s, [])).toBeNull();
    expect(channelBroadcastToShow({ channel: Channel.Patron, senderName: 'Bob', message: 'hi' }, s, [])).not.toBeNull();
  });

  it('chat filters hide others’ lines but never our own echo', () => {
    const s = new SquelchState();
    const filters = [/spam/];
    expect(channelBroadcastToShow({ channel: Channel.Fellow, senderName: 'Bob', message: 'spam' }, s, filters)).toBeNull();
    expect(channelBroadcastToShow({ channel: Channel.Fellow, senderName: '', message: 'spam' }, s, filters)?.text)
      .toBe('[Fellowship] You say, "spam"');
  });
});
