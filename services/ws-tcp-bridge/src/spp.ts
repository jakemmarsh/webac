/**
 * Simple Proxy Protocol (SPP): how a game server behind this bridge learns
 * each player's real address (docs/operators.md, "Seeing players' real IP
 * addresses").
 *
 * Every browser player reaches a world from the bridge's one address, so a
 * world's per-IP rules (ACE MaximumAllowedSessionsPerIPAddress, IP bans,
 * account IPs) see the bridge instead of the player. A server that trusts
 * the bridge's address reads the player's address from a 38-byte header on
 * every datagram and echoes the same header on its replies, which the bridge
 * strips. Stock ACE can't do this: it needs `TrustedProxyAddresses`, proposed
 * in ACEmulator/ACE#4508 (not merged as of 2026-10-12), so the bridge sends the
 * header only to servers named in BRIDGE_SPP_SERVERS / BRIDGE_SPP.
 *
 * Wire format (Cloudflare Spectrum's SPP, network byte order):
 *   uint16 magic 0x56EC | 16 B client address | 16 B proxy address |
 *   uint16 client port | uint16 proxy port | payload
 * IPv4 addresses are IPv4-mapped IPv6 (::ffff:a.b.c.d).
 * https://developers.cloudflare.com/spectrum/reference/simple-proxy-protocol-header/
 */
import * as net from 'net';

export const SPP_MAGIC = 0x56ec;
export const SPP_HEADER_SIZE = 38;

/** 16-byte IPv6 form of an address; IPv4 (or ::ffff:-mapped) → ::ffff:a.b.c.d. Unparseable → all zeros. */
export function sppAddressBytes(address: string): Buffer {
  const out = Buffer.alloc(16);
  let a = address.trim();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    out[10] = 0xff; out[11] = 0xff;
    a.split('.').forEach((o, i) => { out[12 + i] = Number(o); });
    return out;
  }
  if (!net.isIPv6(a)) return out;
  // Expand "::" and any trailing dotted quad into eight 16-bit groups.
  let groups: string[];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    a = a.slice(0, -dotted[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = a.split('::');
  if (tail === undefined) groups = head.split(':');
  else {
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  }
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16) & 0xffff, i * 2));
  return out;
}

/** The header the bridge prepends to a player's datagrams. */
export function encodeSppHeader(client: { address: string; port: number }, proxy: { address: string; port: number }): Buffer {
  const h = Buffer.alloc(SPP_HEADER_SIZE);
  h.writeUInt16BE(SPP_MAGIC, 0);
  sppAddressBytes(client.address).copy(h, 2);
  sppAddressBytes(proxy.address).copy(h, 18);
  h.writeUInt16BE(client.port & 0xffff, 34);
  h.writeUInt16BE(proxy.port & 0xffff, 36);
  return h;
}

/** The payload of a server reply, or null when it carries no SPP header (dropped: a trusting server always echoes it). */
export function stripSppHeader(datagram: Buffer): Buffer | null {
  if (datagram.length < SPP_HEADER_SIZE || datagram.readUInt16BE(0) !== SPP_MAGIC) return null;
  return datagram.subarray(SPP_HEADER_SIZE);
}
