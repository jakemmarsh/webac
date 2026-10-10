/**
 * FAITHFUL.522 — Strip the Olthoi suffix appended by ACE
 * `Player_Properties.cs:GetNameWithSuffix()`:
 *   `Name + "&"` for an Olthoi player who can talk
 *   `Name + "^"` for an Olthoi player who cannot talk (NoOlthoiTalk)
 * The suffix is a server-side marker the retail client used to drive
 * Olthoi-speak text garbling for non-Olthoi observers; we don't
 * implement the garbling, but the bare marker leaking into the visible
 * sender name + breaking string-keyed downstream paths (squelch, /reply)
 * is itself a defect. GetNameWithSuffix() is invoked by every chat
 * broadcast path that needs the rendered name:
 *   Player.cs:796 HearSpeech (HandleActionTalk)
 *   Player.cs:826 EmoteText (HandleActionEmote)
 *   EmoteManager.cs:1124 Say/SayDirected (NPC-Olthoi monologue)
 *   GameActionTell.cs:11 Tell (explicit Olthoi branch)
 * FAITHFUL.521 covered only the /tell case; this helper centralizes
 * the strip and powers it in HearSpeech, HearRangedSpeech, EmoteText,
 * SoulEmote, ChannelBroadcast, and Tell handlers.
 */
export function stripOlthoiSuffix(name: string): string {
  if (!name) return name;
  const last = name.charCodeAt(name.length - 1);
  return (last === 0x26 /* & */ || last === 0x5E /* ^ */)
    ? name.slice(0, -1) : name;
}
