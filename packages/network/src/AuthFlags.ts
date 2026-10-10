/**
 * AuthFlags — bitfield sent in the LoginRequest packet header alongside
 * NetAuthType. We currently send `None` (0) since we don't negotiate
 * crypto or admin-account-override at this layer.
 *
 * Source: reference/ACE/Source/ACE.Entity/Enum/AuthFlags.cs
 *
 *   None                 = 0x0
 *   EnableCrypto         = 0x1
 *   AdminAccountOverride = 0x2  — admin logging in as another account
 *   ExtraData            = 0x4
 *   LastDefault          = 0x4  — sentinel; same value as ExtraData
 *
 * Wire format: uint32 at offset 12 of the LoginRequest payload (after
 * NetAuthType).
 */
export enum AuthFlags {
  None                 = 0x0,
  EnableCrypto         = 0x1,
  AdminAccountOverride = 0x2,
  ExtraData            = 0x4,
}
