/**
 * NetAuthType — auth-method identifier sent in the LoginRequest packet
 * header. The client tells the server how it intends to authenticate;
 * ACE only accepts AccountPassword (0x00000002) for our purposes here.
 *
 * Source: reference/ACE/Source/ACE.Server/Network/Enum/NetAuthType.cs
 *
 *   Undef            = 0x00000000
 *   Account          = 0x00000001  — account name only (no password)
 *   AccountPassword  = 0x00000002  — what we use
 *   GlsTicket        = 0x40000002  — retail GLS ticket (unused for ACE)
 *
 * Wire format: uint32 at offset 8 (after PacketSize + DataLength) of the
 * LoginRequest payload.
 */
export enum NetAuthType {
  Undef           = 0x00000000,
  Account         = 0x00000001,
  AccountPassword = 0x00000002,
  GlsTicket       = 0x40000002,
}
