/**
 * The 1999 client's LoginRequest body and the server's connect grant
 * (docs/ac1999-support.md; byte-for-byte against the real client's capture,
 * tests/verify-ac1999-transport.ts). Sent connectionless as sequence 1,
 * flags 0x2, recipient 0, before any grant.
 *
 *   u32 0x075BCD15
 *   u16 versionLength (counting the NUL), the version + NUL, zero pad to 4
 *   u32 0xBEEFBEEF
 *   char[20] the first 20 characters of "account:password": NUL-padded when
 *            shorter, no terminator when 20 or longer, the rest dropped
 *   u32 0, u32 0xBEEFBEEF, 24 zero bytes, u32 1, u32 0
 *   u32 portal iteration, u32 cell iteration   (the DAT headers', 102/67 on the retail CD)
 *   u32 0, u32 0xFFFFFFFF
 */

const LOGIN_MAGIC = 0x075bcd15;
const BEEF = 0xbeefbeef;
/**
 * The credential field's size. The retail client truncates silently: measured
 * 2026-10-12 (client.exe 4.35752 under Wine against the local 1999 server),
 * `-a "lenprobeab:pwprobe123"` (21 characters) sent exactly the first 20,
 * "lenprobeab:pwprobe12", no NUL, and the server stored the password
 * "pwprobe12". So an account made with longer credentials HAS the truncated
 * password, and logging in means truncating the same way every time; a
 * refusal here locked those players out (player report, 2026-10-12).
 *
 * The server (reference/ac1999 Network.cpp) copies the 20 bytes into a
 * 21-byte zeroed buffer and splits on the first ':'. An account name of 20
 * or more characters leaves no ':' in the field; the server then skips that
 * 0xBEEFBEEF marker, finds no credential and logs "no 0xBEEFBEEF credential
 * found", so the login fails there, exactly as it did for the retail client.
 */
export const CREDENTIAL_BYTES_1999 = 20;

export function buildLoginBody1999(opts: {
  version: string; account: string; password: string; portalIteration: number; cellIteration: number;
}): Uint8Array {
  const creds = `${opts.account}:${opts.password}`;
  const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const out: number[] = [];
  const u32 = (v: number): void => { out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); };
  u32(LOGIN_MAGIC);
  const version = [...ascii(opts.version), 0];
  out.push(version.length & 0xff, version.length >>> 8, ...version);
  while (out.length % 4) out.push(0);
  u32(BEEF);
  const credBytes = ascii(creds);
  for (let i = 0; i < CREDENTIAL_BYTES_1999; i++) out.push(credBytes[i] ?? 0);
  u32(0);
  u32(BEEF);
  for (let i = 0; i < 24; i++) out.push(0);
  u32(1);
  u32(0);
  u32(opts.portalIteration);
  u32(opts.cellIteration);
  u32(0);
  u32(0xffffffff);
  return Uint8Array.from(out);
}

export interface Grant1999 {
  /** Seconds to add to our clock for the world (day/night) clock: time_zero_start_delta. */
  worldClockDelta: number;
  /** Our slot: the recipient id we stamp on every packet we send. */
  adoptRecipient: number;
  /** The server's version string; the 1999 client requires exact (strtod) equality with its own. */
  version: string;
}

/** The connect grant body (flags 0x202 with a body): f64 0, f64 delta, u32 slot, u32 versionLength, version, u32 seed ×2. */
export function readGrant1999(body: Uint8Array): Grant1999 | null {
  if (body.length < 24) return null;
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const len = v.getUint32(20, true);
  if (24 + len > body.length) return null;
  const version = String.fromCharCode(...body.subarray(24, 24 + len)).replace(/\0.*$/, '');
  return { worldClockDelta: v.getFloat64(8, true), adoptRecipient: v.getUint32(16, true), version };
}
