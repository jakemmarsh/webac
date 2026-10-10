/**
 * BUG.hearrangedspeech-range-gate-missing — retail's client-side range gate
 * for HearRangedSpeech (opcode 0x02BC).
 *
 * ACE broadcasts ranged speech to everyone within LocalBroadcastRange = 96m
 * (WorldObject.cs:1018) while writing the emote's much smaller Extent
 * (commonly 12-30m) as the wire `range` float (EmoteManager.cs:1127) — the
 * client is expected to enforce it. The retail client does exactly that:
 * gmCCommunicationSystem::HandleRangedTalkEvent @ 00589f60 only displays the
 * line when ACCWeenieObject::ObjectsInRange(player_id, sender, range, false,
 * false) returns nonzero. ObjectsInRange @ 0058c1a0 with both flags false is
 * a plain 3D Position::distance between the two object origins tested
 * `distance <= range`, returning 0 (suppress) when either object is unknown
 * to the client's CObjectMaint.
 */
export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * Mirror of retail ObjectsInRange for the ranged-speech gate: true when the
 * sender is known and its 3D distance from the player is within `range`
 * (inclusive — retail tests `dist <= range`). An unknown sender (null) is
 * out of range, matching ObjectsInRange's null-object early return.
 */
export function rangedSpeechInRange(
  player: WorldPoint,
  sender: WorldPoint | null,
  range: number,
): boolean {
  if (!sender || !Number.isFinite(range)) return false;
  const dx = sender.x - player.x;
  const dy = sender.y - player.y;
  const dz = sender.z - player.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) <= range;
}
