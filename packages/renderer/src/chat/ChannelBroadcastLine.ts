/**
 * DECOMP.channel-broadcast-self-echo — retail ChannelBroadcast (0x0147) lines.
 *
 * ClientCommunicationSystem::Handle_Communication__ChannelBroadcast @ 00570b90
 * (annotated decomp ~358636; Ghidra drops the sprintf formats, so they were
 * read from the exe: objdump 570b90–5711d0, .rdata 0x7d0bfc–0x7d0e10). It
 * branches on an empty sender name (ACE's self-echo) first, then by channel.
 * The sender is a <Tell:IIDString:0:name>name<\Tell> link, which draws as
 * the name. Every line ends `"\n`, except FellowBroadcast's, which ends `\n`.
 *
 * Channel names come from ChannelSystem::GetChannelName @ 005cfd80; an
 * unnamed channel reads "<unknown>".
 */
import { Channel, ChatMessageType, squelchMaskForChatType } from '@ac/shared';

const CHANNEL_NAMES: ReadonlyMap<number, string> = new Map([
  [Channel.Abuse, 'Abuse'],
  [Channel.Admin, 'Admin'],
  [Channel.Audit, 'Audit'],
  [Channel.Advocate1, 'Advocate 1'],
  [Channel.Advocate2, 'Advocate 2'],
  [Channel.Advocate3, 'Advocate 3'],
  [Channel.Sentinel, 'Sentinel'],
  [Channel.Help, 'Help'],
  [Channel.Fellow, 'Fellowship'],
  [Channel.Vassals, 'Vassals'],
  [Channel.Patron, 'Patron'],
  [Channel.Monarch, 'Monarch'],
  [Channel.CoVassals, 'Co-vassals'],
  [Channel.AllegianceBroadcast, 'Allegiance'],
  [Channel.FellowBroadcast, 'FellowBroadcast'],
  [Channel.SocietyCelHanBroadcast, 'Celestial Hand'],
  [Channel.SocietyEldWebBroadcast, 'Eldrytch Web'],
  [Channel.SocietyRadBloBroadcast, 'Radiant Blood'],
  [Channel.Olthoi, 'Olthoi'],
]);

/** ChannelSystem::GetChannelName, with the handler's "<unknown>" fallback. */
export function channelName(channel: number): string {
  return CHANNEL_NAMES.get(channel) ?? '<unknown>';
}

export interface ChannelBroadcastLine {
  text: string;
  type: ChatMessageType;
}

export function formatChannelBroadcast(channel: number, senderName: string, message: string): ChannelBroadcastLine {
  if (!senderName) {
    switch (channel) {
      case Channel.Fellow:
        return { text: `[Fellowship] You say, "${message}"`, type: ChatMessageType.Fellowship };
      case Channel.Vassals:
      case Channel.Patron:
      case Channel.Monarch:
        return { text: `You say to your ${channelName(channel)}, "${message}"`, type: ChatMessageType.SocialSend };
      case Channel.CoVassals:
        return { text: `[Co-Vassals] You say, "${message}"`, type: ChatMessageType.Social };
      case Channel.AllegianceBroadcast:
        return { text: `[Allegiance Broadcast] You say, "${message}"`, type: ChatMessageType.Social };
      case Channel.FellowBroadcast:
        return { text: message, type: ChatMessageType.Fellowship };
      default:
        return {
          text: `You say on the ${channelName(channel)} channel, "${message}"`,
          type: channel === Channel.Help ? ChatMessageType.Help
            : channel === Channel.Abuse ? ChatMessageType.Abuse
            : ChatMessageType.ChannelSend,
        };
    }
  }
  switch (channel) {
    case Channel.Monarch:
      return { text: `Your follower ${senderName} says to you, "${message}"`, type: ChatMessageType.Social };
    case Channel.Patron:
      return { text: `Your vassal ${senderName} says to you, "${message}"`, type: ChatMessageType.Social };
    case Channel.Vassals:
      return { text: `Your patron ${senderName} says to you, "${message}"`, type: ChatMessageType.Social };
    case Channel.Fellow:
      return { text: `[Fellowship] ${senderName} says, "${message}"`, type: ChatMessageType.Fellowship };
    case Channel.CoVassals:
      return { text: `[Co-Vassals] ${senderName} says, "${message}"`, type: ChatMessageType.Social };
    case Channel.AllegianceBroadcast:
      return { text: `[Allegiance Broadcast] ${senderName} says, "${message}"`, type: ChatMessageType.Social };
    default:
      return {
        text: `${senderName} says on the ${channelName(channel)} channel, "${message}"`,
        type: channel === Channel.Help ? ChatMessageType.Help
          : channel === Channel.Abuse ? ChatMessageType.Abuse
          : ChatMessageType.Channel,
      };
  }
}

/**
 * The handler's whole decision: the line to show, or null when hidden.
 * Retail then calls gmCCommunicationSystem::IsSquelched(0, "", type)
 * (@ 005891d0 → SquelchDB::IsSquelched @ 006b1490). With no id and no name,
 * only the global per-type squelch can match, so a per-sender /squelch never
 * hides channel chat. Our client-side chat filters skip our own echo.
 */
export function channelBroadcastToShow(
  data: { channel: number; senderName: string; message: string },
  squelch: { blocksChannel(key: string, channelMask: number): boolean },
  filters: readonly RegExp[],
): ChannelBroadcastLine | null {
  const line = formatChannelBroadcast(data.channel, data.senderName, data.message);
  if (squelch.blocksChannel('', squelchMaskForChatType(line.type))) return null;
  if (data.senderName && filters.some((rx) => rx.test(data.message))) return null;
  return line;
}
