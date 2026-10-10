/**
 * CORE.17.t — how the retail client composes slash-emote chat lines.
 *
 * Ground truth (decompiled EoL client, docs/retail-client-symbols.md CORE.17.t):
 *
 * - ClientCommunicationSystem::Pose @ 00580480 resolves the typed command
 *   through ChatPoseTable::InqChatPoseCommand @ 00570ad0 (command → pose
 *   state → ChatEmoteData { myEmote, otherEmote }). It then
 *     1. runs the pose motion via the command interpreter,
 *     2. replaces "%p" in otherEmote with "his" (Gender == 1) / "her"
 *        (PropertyInt 0x71) and ships THAT text to the server with
 *        CM_Communication::Event_SoulEmote @ 006a4500 (GameAction 0x01E1),
 *     3. prints the self line locally through
 *        Handle_Communication__HearSoulEmote(0, "You", myEmote).
 * - Handle_Communication__HearSoulEmote @ 0057d020 returns without printing
 *   when the sender id is our own player_id — the server's echo of our own
 *   soul emote (ACE EnqueueBroadcast sends it back to the sender,
 *   WorldObject_Networking.cs:1384) is dropped; the self line is the local one.
 * - Handle_Communication__HearEmote @ 0057cbe0 composes
 *   name + (text[0] == '\'' ? "" : " ") + text and posts it as chat type
 *   0x0C (Emote).
 *
 * The EoL portal.dat ChatPoseTable (0x0E000007) strings carry no subject:
 * myEmote "wave." / otherEmote "waves.", myEmote "decide to rest for a
 * while." / otherEmote "decides to rest for a while." (74 states, none
 * starting with "You", none containing "%s", 15 otherEmotes with "%p").
 */

/** The speaker name retail passes for the local self line. */
export const SELF_EMOTE_SPEAKER = 'You';

/** ACE Gender enum (ACE.Entity/Enum/Gender.cs): Male = 1, Female = 2. */
const GENDER_MALE = 1;

/**
 * Retail Pose @ 00580480: "%p" in the 3rd-person text becomes the actor's
 * possessive pronoun — "his" when PropertyInt Gender == 1, "her" otherwise.
 */
export function substituteEmotePronoun(otherEmote: string, gender: number): string {
  const pronoun = gender === GENDER_MALE ? 'his' : 'her';
  return otherEmote.replace(/%p/g, pronoun);
}

/**
 * Retail Handle_Communication__HearEmote @ 0057cbe0: the printed line is
 * the speaker name, a single space unless the text starts with an
 * apostrophe (possessive/contraction forms attach directly), then the text.
 */
export function composeHeardEmoteLine(speakerName: string, text: string): string {
  const joiner = text.startsWith("'") ? '' : ' ';
  return `${speakerName}${joiner}${text}`;
}

/**
 * The self line for a slash emote: Pose @ 00580480 passes "You" + the DAT
 * myEmote to HearSoulEmote → HearEmote, so "wave." prints as "You wave.".
 */
export function composeSelfEmoteLine(myEmote: string): string {
  return composeHeardEmoteLine(SELF_EMOTE_SPEAKER, myEmote);
}

/**
 * Handle_Communication__HearSoulEmote @ 0057d020: a soul emote whose sender
 * is our own player id is not printed (the local self line already was).
 */
export function isOwnSoulEmoteEcho(senderId: number, playerId: number | null | undefined): boolean {
  return playerId != null && senderId === playerId;
}
