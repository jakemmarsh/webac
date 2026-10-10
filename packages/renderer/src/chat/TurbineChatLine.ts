/**
 * SWEEP1006 channel lines — a TurbineChat room line as retail draws it.
 *
 * ChatRoomTracker::GetChatFormat @ 005cd7c0 (annotated decomp :446954)
 * formats every room message with `[%ws] <Tell:IIDString:0:%ws>%ws<\Tell>
 * says, "%ws"` (acclient.exe .rdata; the tell link draws as the name) and
 * picks its text type: the allegiance room 0x12, General 0x1b, Trade 0x1c,
 * LFG 0x1d, Roleplay 0x1e, Olthoi 0x12, the Society / Celestial Hand /
 * Eldrytch Web / Radiant Blood rooms 0x20. uiChatInterfaceProvider::
 * OnSendToRoom adds it to the scroll with that type, so the colour follows
 * the type (BuildChatColorLookupTable: 0x1b-0x1e and 0x20 blue-grey, 0x12
 * orange). Pre-fix: `[General] Name: msg`, every room in Channel pink.
 */
export function formatTurbineChatLine(roomLabel: string, senderName: string, message: string): string {
  return `[${roomLabel}] ${senderName} says, "${message}"`;
}
