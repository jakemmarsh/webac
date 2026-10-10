/**
 * ContactLongJump — bitfield byte trailing the position + sequence block in
 * the MoveToState (GameAction 0xF61C) and AutonomousPosition packets.
 *
 * Source: reference/ACE/Source/ACE.Server/Network/Motion/MoveToState.cs:43-47
 *
 *   ContactLongJump = reader.ReadByte();
 *   if ((ContactLongJump & 0x1) != 0)
 *       Contact = true;
 *   if ((ContactLongJump & 0x2) != 0)
 *       StandingLongJump = true;
 *
 * AutonomousPosition treats the byte as a boolean — non-zero = on ground
 * (see GameActionAutonomousPosition.cs:25 LastContact assignment), so the
 * Contact bit alone is sufficient for the steady-state walking case.
 *
 * Wire format: single uint8 followed by DWORD alignment padding.
 */
export enum ContactLongJump {
  None              = 0x0,
  Contact           = 0x1,  // player is on the ground
  StandingLongJump  = 0x2,  // standing long-jump windup is active
}
