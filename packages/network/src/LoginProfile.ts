/**
 * What a server expects in the LoginRequest beyond the account itself: the
 * client version string and the credential encoding (docs/dark-majesty-support.md).
 *
 * Every live classic (Dark Majesty) server runs the end-of-retail client and
 * protocol; only these two values differ per server:
 *
 * - clientVersion: the 4-character literal ClientNet::SendLoginRequest sends.
 *   Retail sends "1802". ClassicACE boots any other string than its ruleset's
 *   (DatManager.cs: CustomDM "c118", Infiltration "i104"), and the classic
 *   client exe is the retail one with only this literal patched.
 * - authStyle: retail NetAuthenticator::StreamPack @ 00540a10 packs
 *   authType, authFlags, timestamp, the Account string, then the CryptoData and
 *   ExtraData buffers. Auth type 2 ("-a user -v password") carries the password
 *   in CryptoData; auth type 1 ("-a user:password") carries both in the Account
 *   string with both buffers empty. Seedsow accepts only type 1
 *   (Network.cpp ConnectionRequest); GDL-Classic, GDLE and ACE accept type 2,
 *   and GDL-Classic also accepts type 1.
 */
export type AuthStyle = 'account-password' | 'account-colon-password';

/**
 * Which wire protocol the server speaks. Absent = 'eor' (end of retail, every
 * ACE / GDLE / classic server). 'ac1999' = the Nov 1999 retail protocol
 * (AC1999 servers; packages/network/src/era1999, docs/ac1999-support.md),
 * which createConnection() serves with Connection1999 instead of ClientConnection.
 */
export type WireProtocol = 'eor' | 'ac1999';

export interface LoginProfile {
  clientVersion: string;
  authStyle: AuthStyle;
  protocol?: WireProtocol;
}

/** End of retail: what ACE and GDLE expect, and what we always sent before profiles. */
export const EOR_LOGIN_PROFILE: Readonly<LoginProfile> = Object.freeze({
  clientVersion: '1802',
  authStyle: 'account-password',
});

/** A version literal is 1–16 printable ASCII characters (retail's is 4). */
export function isValidClientVersion(v: string): boolean {
  return /^[\x21-\x7e]{1,16}$/.test(v);
}
