/**
 * AttackConditions — flag bitfield on AttackerNotification / DefenderNotification
 * GameEvents. Server emits which condition flags applied to the swing; the
 * retail client folds them INTO the one hit line (CombatDialog.ts
 * formatAttackerChat / formatDefenderChat — DECOMP.hit-chat-lines).
 *
 * Wire format: ulong (8 bytes) on the wire, but only the low 4 bits are used.
 *
 * Sources (authoritative):
 * - reference/ACE/Source/ACE.Entity/Enum/AttackConditions.cs
 *   — defines the bit values:
 *       None                           = 0x0
 *       CriticalProtectionAugmentation = 0x1
 *       Recklessness                   = 0x2
 *       SneakAttack                    = 0x4
 *       Overpower                      = 0x8
 *
 * Retail text (decompiled EoL client, HandleAttackerNotificationEvent @
 * 0056b420 / HandleDefenderNotificationEvent @ 0056c920): bit 0x4 "Sneak
 * Attack! " prefix, bit 0x2 "Recklessness! " (attacker) / "Reckless! "
 * (defender) prefix, bit 0x1 the Critical Protection suffix. Overpower
 * (0x8) is an ACE addition the client never tests — it prints nothing.
 */
export enum AttackConditions {
  None                            = 0x0,
  CriticalProtectionAugmentation  = 0x1,
  Recklessness                    = 0x2,
  SneakAttack                     = 0x4,
  Overpower                       = 0x8,
}
