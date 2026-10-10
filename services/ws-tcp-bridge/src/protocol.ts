/**
 * Per-session wire protocol (docs/ac1999-support-scope.md, Phase 3 "The
 * bridge"). The bridge reads a few header fields to route and to say goodbye,
 * and those fields sit in different places per protocol:
 *
 *   eor     end of retail (ACE, GDLE, every classic server): two UDP ports,
 *           ConnectResponse 0x80000 → port+1, session id from the server's
 *           ConnectRequest, EoL Disconnect on close. THE DEFAULT: a session
 *           whose protocol is not named takes this path, byte for byte as before.
 *   ac1999  the Nov 1999 retail protocol (AC1999 server): ONE UDP port for
 *           everything, the session's slot from the server's connect grant
 *           (flags 0x202 with a body; slot = u32 at body offset 16), a 1999
 *           Disconnect (0x8000|0x2, recipient = slot) on close.
 *
 * A session is 1999 when its server's era is a 1999 era (the directory row in
 * multi mode, BRIDGE_ERA when pinned) or the WebSocket URL says
 * `?proto=ac1999` (a Custom… world the bridge has no row for).
 */
import {
  F1999, HEADER_SIZE_1999, buildPacket1999,
} from '../../../packages/network/src/era1999/Packet1999.js';
import { AC1999_ERA } from './serverCompat.js';

export type SessionProtocol = 'eor' | 'ac1999';

/** Era profile ids that speak the 1999 protocol (serverCompat AC1999_ERA, the directory rows' era). */
export const AC1999_ERAS: ReadonlySet<string> = new Set([AC1999_ERA]);

export function isAc1999Era(era: string | null | undefined): boolean {
  return era !== null && era !== undefined && AC1999_ERAS.has(era);
}

/**
 * The session's protocol: a 1999 era, or an explicit `?proto=ac1999`, makes
 * it 1999; everything else (no era, a classic era, any other or missing
 * query) is end of retail.
 */
export function sessionProtocol(era: string | null | undefined, reqUrl: string | undefined): SessionProtocol {
  if (isAc1999Era(era)) return 'ac1999';
  const proto = new URL(reqUrl ?? '/', 'http://bridge.local').searchParams.get('proto');
  return proto !== null && proto.trim().toLowerCase() === 'ac1999' ? 'ac1999' : 'eor';
}

export interface Grant1999Ids {
  /** Our slot: the recipient the client stamps on every packet (grant body offset 16). */
  slot: number;
  /** The server's own recipient id (grant header @0x08). */
  serverRecipient: number;
}

/**
 * The ids in a server connect grant: flags 0x200 (Connect), sequence 0, a body
 * of at least 24 bytes (f64, f64, u32 slot, u32 versionLength, …; Login1999
 * readGrant1999). Bare 0x202 keepalives and everything else → null.
 */
export function readGrant1999Ids(buf: Buffer): Grant1999Ids | null {
  if (buf.length < HEADER_SIZE_1999 + 24) return null;
  if (buf.readUInt32LE(0) !== 0) return null;
  const flags = buf.readUInt32LE(4);
  if ((flags & F1999.Connect) === 0 || (flags & F1999.NetError) !== 0) return null;
  return { slot: buf.readUInt32LE(HEADER_SIZE_1999 + 16), serverRecipient: buf.readUInt32LE(8) };
}

/** A 1999 Disconnect for `slot`, as the client sends it (Connection1999.disconnect): sequence 0, flags 0x8002, no body. */
export function buildDisconnectPacket1999(slot: number, time = 0): Buffer {
  return Buffer.from(buildPacket1999({ sequence: 0, flags: F1999.Disconnect | F1999.Checksum, recipient: slot, time }));
}

/** The 1999 header's time byte (u8 @0x12), echoed back on our Disconnect. */
export function readTime1999(buf: Buffer): number | null {
  return buf.length >= HEADER_SIZE_1999 ? buf[0x12] : null;
}
