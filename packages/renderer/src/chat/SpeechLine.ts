/**
 * BUG.own-say-rendered-third-person — retail speech-line formatting.
 *
 * The retail client's ClientCommunicationSystem::Handle_Communication__HearSpeech
 * (acclient @ 005712a0) branches on sender==smartbox->player_id FIRST — before
 * CanHear/squelch — and formats own speech with the dedicated string-table
 * entry `"You say, \"%s\"\n"` (demangled.txt:19347). Everyone else's speech
 * uses `"%s says, \"%s\"\n"` (demangled.txt:19365).
 *
 * ACE never sends a pre-formatted "You say" line for /say: its only echo of
 * your own speech is the self-inclusive HearSpeech broadcast
 * (Player.cs HandleActionTalk → EnqueueBroadcast, which EnqueueSends to self
 * before iterating known players). Spell-cast incantations arrive the same
 * way (Player_Magic.cs DoSpellWords, ChatMessageType.Spellcasting), so the
 * self-branch covers cast words too — retail keys purely on the guid, not
 * the chat type.
 */
export function formatSpeechLine(senderName: string, message: string, isSelf: boolean): string {
  return isSelf
    ? `You say, "${message}"`
    : `${senderName} says, "${message}"`;
}

