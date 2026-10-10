/**
 * PacketBuilder — constructs complete AC network packets ready for transmission.
 *
 * A complete packet consists of:
 *   1. PacketHeader (20 bytes)
 *   2. Optional headers (variable, based on flags)
 *   3. Fragment data (variable, if BlobFragments flag set)
 *
 * Checksum calculation:
 *   headerChecksum = Hash32(header with checksum=0xBADD70DD)
 *   payloadChecksum = Hash32(optional headers) + Sum(Hash32(each fragment))
 *   Header.Checksum = headerChecksum + payloadChecksum
 *
 * Ported from ACE.Server.Network.ServerPacket / ClientPacket.
 */

import { PacketHeaderFlags } from './PacketHeaderFlags.js';
import { hash32, CHECKSUM_SENTINEL } from './Hash32.js';
import {
  PacketHeaderData,
  PACKET_HEADER_SIZE,
  writePacketHeader,
  readPacketHeader,
  calculateHeaderChecksum,
  hasFlag,
} from './PacketHeader.js';
import {
  Fragment,
  FRAGMENT_HEADER_SIZE,
  readFragment,
  writeFragment,
  hashFragment,
} from './PacketFragment.js';
import { GameMessageGroup } from './GameMessageGroup.js';

/** Max total packet size for server→client. */
export const MAX_SERVER_PACKET_SIZE = 464;

/** Max total packet size for client→server. */
export const MAX_CLIENT_PACKET_SIZE = 1024;

// ─── Optional Header Parsing ───────────────────────────────

export interface OptionalHeaders {
  /** ServerSwitch (0x100): 8 bytes */
  serverSwitch?: Uint8Array;
  /** RequestRetransmit (0x1000): sequence numbers to retransmit */
  retransmitSequences?: number[];
  /** RejectRetransmit (0x2000): rejected sequence numbers */
  rejectSequences?: number[];
  /** AckSequence (0x4000): acknowledged sequence number */
  ackSequence?: number;
  /** LoginRequest (0x10000): login data */
  loginData?: Uint8Array;
  /** WorldLoginRequest (0x20000): 8 bytes */
  worldLogin?: Uint8Array;
  /** ConnectResponse (0x80000): 8 bytes */
  connectResponse?: Uint8Array;
  /** CICMDCommand (0x400000): 8 bytes */
  cicmdData?: Uint8Array;
  /** TimeSync (0x1000000): 64-bit double */
  timeSync?: number;
  /** EchoRequest (0x2000000): 32-bit float client time */
  echoRequestTime?: number;
  /** EchoResponse (0x4000000): 32-bit float + 64-bit double */
  echoResponseClientTime?: number;
  echoResponseServerTime?: number;
  /** Flow (0x8000000): 4-byte bytes + 2-byte interval */
  flowBytes?: number;
  flowInterval?: number;
}

/**
 * Calculate the byte size of optional headers for a given set of flags.
 */
export function optionalHeadersSize(flags: PacketHeaderFlags, opts: OptionalHeaders): number {
  let size = 0;
  if ((flags & PacketHeaderFlags.ServerSwitch) !== 0) size += 8;
  if ((flags & PacketHeaderFlags.RequestRetransmit) !== 0) {
    size += 4 + (opts.retransmitSequences?.length ?? 0) * 4;
  }
  if ((flags & PacketHeaderFlags.RejectRetransmit) !== 0) {
    size += 4 + (opts.rejectSequences?.length ?? 0) * 4;
  }
  if ((flags & PacketHeaderFlags.AckSequence) !== 0) size += 4;
  if ((flags & PacketHeaderFlags.LoginRequest) !== 0) size += opts.loginData?.length ?? 0;
  if ((flags & PacketHeaderFlags.WorldLoginRequest) !== 0) size += 8;
  if ((flags & PacketHeaderFlags.ConnectResponse) !== 0) size += 8;
  if ((flags & PacketHeaderFlags.CICMDCommand) !== 0) size += 8;
  if ((flags & PacketHeaderFlags.TimeSync) !== 0) size += 8;
  if ((flags & PacketHeaderFlags.EchoRequest) !== 0) size += 4;
  if ((flags & PacketHeaderFlags.EchoResponse) !== 0) size += 12;
  if ((flags & PacketHeaderFlags.Flow) !== 0) size += 6;
  return size;
}

/**
 * Write optional headers to a buffer.
 */
export function writeOptionalHeaders(
  flags: PacketHeaderFlags,
  opts: OptionalHeaders,
  buf: Uint8Array,
  offset: number,
): number {
  const view = new DataView(buf.buffer, buf.byteOffset);
  let pos = offset;

  if ((flags & PacketHeaderFlags.ServerSwitch) !== 0 && opts.serverSwitch) {
    buf.set(opts.serverSwitch, pos); pos += 8;
  }
  if ((flags & PacketHeaderFlags.RequestRetransmit) !== 0) {
    const seqs = opts.retransmitSequences ?? [];
    view.setUint32(pos, seqs.length, true); pos += 4;
    for (const s of seqs) { view.setUint32(pos, s, true); pos += 4; }
  }
  if ((flags & PacketHeaderFlags.RejectRetransmit) !== 0) {
    const seqs = opts.rejectSequences ?? [];
    view.setUint32(pos, seqs.length, true); pos += 4;
    for (const s of seqs) { view.setUint32(pos, s, true); pos += 4; }
  }
  if ((flags & PacketHeaderFlags.AckSequence) !== 0) {
    view.setUint32(pos, opts.ackSequence ?? 0, true); pos += 4;
  }
  if ((flags & PacketHeaderFlags.LoginRequest) !== 0 && opts.loginData) {
    buf.set(opts.loginData, pos); pos += opts.loginData.length;
  }
  if ((flags & PacketHeaderFlags.WorldLoginRequest) !== 0 && opts.worldLogin) {
    buf.set(opts.worldLogin, pos); pos += 8;
  }
  if ((flags & PacketHeaderFlags.ConnectResponse) !== 0 && opts.connectResponse) {
    buf.set(opts.connectResponse, pos); pos += 8;
  }
  if ((flags & PacketHeaderFlags.CICMDCommand) !== 0 && opts.cicmdData) {
    buf.set(opts.cicmdData, pos); pos += 8;
  }
  if ((flags & PacketHeaderFlags.TimeSync) !== 0) {
    view.setFloat64(pos, opts.timeSync ?? 0, true); pos += 8;
  }
  if ((flags & PacketHeaderFlags.EchoRequest) !== 0) {
    view.setFloat32(pos, opts.echoRequestTime ?? 0, true); pos += 4;
  }
  if ((flags & PacketHeaderFlags.EchoResponse) !== 0) {
    view.setFloat32(pos, opts.echoResponseClientTime ?? 0, true); pos += 4;
    view.setFloat64(pos, opts.echoResponseServerTime ?? 0, true); pos += 8;
  }
  if ((flags & PacketHeaderFlags.Flow) !== 0) {
    view.setUint32(pos, opts.flowBytes ?? 0, true); pos += 4;
    view.setUint16(pos, opts.flowInterval ?? 0, true); pos += 2;
  }

  return pos - offset;
}

/**
 * Read optional headers from a buffer based on flags.
 */
export function readOptionalHeaders(
  flags: PacketHeaderFlags,
  buf: Uint8Array,
  offset: number,
): { opts: OptionalHeaders; bytesRead: number } {
  const view = new DataView(buf.buffer, buf.byteOffset);
  let pos = offset;
  const opts: OptionalHeaders = {};

  if ((flags & PacketHeaderFlags.ServerSwitch) !== 0) {
    opts.serverSwitch = buf.slice(pos, pos + 8); pos += 8;
  }
  if ((flags & PacketHeaderFlags.RequestRetransmit) !== 0) {
    const count = view.getUint32(pos, true); pos += 4;
    opts.retransmitSequences = [];
    for (let i = 0; i < count; i++) {
      opts.retransmitSequences.push(view.getUint32(pos, true)); pos += 4;
    }
  }
  if ((flags & PacketHeaderFlags.RejectRetransmit) !== 0) {
    const count = view.getUint32(pos, true); pos += 4;
    opts.rejectSequences = [];
    for (let i = 0; i < count; i++) {
      opts.rejectSequences.push(view.getUint32(pos, true)); pos += 4;
    }
  }
  if ((flags & PacketHeaderFlags.AckSequence) !== 0) {
    opts.ackSequence = view.getUint32(pos, true); pos += 4;
  }
  if ((flags & PacketHeaderFlags.LoginRequest) !== 0) {
    // Login data extends to end of optional header area (variable length).
    // In practice, the remaining optional header size is known from the packet size minus
    // fragment data. For now, we'll read what remains as login data in higher-level code.
    // Mark as present but empty — caller fills in based on packet structure.
    opts.loginData = new Uint8Array(0);
  }
  if ((flags & PacketHeaderFlags.WorldLoginRequest) !== 0) {
    opts.worldLogin = buf.slice(pos, pos + 8); pos += 8;
  }
  if ((flags & PacketHeaderFlags.ConnectResponse) !== 0) {
    opts.connectResponse = buf.slice(pos, pos + 8); pos += 8;
  }
  if ((flags & PacketHeaderFlags.CICMDCommand) !== 0) {
    opts.cicmdData = buf.slice(pos, pos + 8); pos += 8;
  }
  if ((flags & PacketHeaderFlags.TimeSync) !== 0) {
    opts.timeSync = view.getFloat64(pos, true); pos += 8;
  }
  if ((flags & PacketHeaderFlags.EchoRequest) !== 0) {
    opts.echoRequestTime = view.getFloat32(pos, true); pos += 4;
  }
  if ((flags & PacketHeaderFlags.EchoResponse) !== 0) {
    opts.echoResponseClientTime = view.getFloat32(pos, true); pos += 4;
    opts.echoResponseServerTime = view.getFloat64(pos, true); pos += 8;
  }
  if ((flags & PacketHeaderFlags.Flow) !== 0) {
    opts.flowBytes = view.getUint32(pos, true); pos += 4;
    opts.flowInterval = view.getUint16(pos, true); pos += 2;
  }

  return { opts, bytesRead: pos - offset };
}

// ─── Packet Building ──────────────────────────────────────

export interface PacketData {
  header: PacketHeaderData;
  optionalHeaders: OptionalHeaders;
  fragments: Fragment[];
}

/**
 * Build a complete packet buffer ready for transmission.
 *
 * Calculates the correct checksum over header + optional headers + fragments.
 */
export function buildPacket(packet: PacketData): Uint8Array {
  const { header, optionalHeaders, fragments } = packet;

  // Calculate sizes
  const optsSize = optionalHeadersSize(header.flags, optionalHeaders);
  let fragmentsSize = 0;
  for (const frag of fragments) {
    fragmentsSize += FRAGMENT_HEADER_SIZE + frag.data.length;
  }

  const payloadSize = optsSize + fragmentsSize;
  const totalSize = PACKET_HEADER_SIZE + payloadSize;

  // Create buffer
  const buf = new Uint8Array(totalSize);

  // Write optional headers
  let offset = PACKET_HEADER_SIZE;
  if (optsSize > 0) {
    writeOptionalHeaders(header.flags, optionalHeaders, buf, offset);
    offset += optsSize;
  }

  // Write fragments
  for (const frag of fragments) {
    writeFragment(frag, buf, offset);
    offset += FRAGMENT_HEADER_SIZE + frag.data.length;
  }

  // Calculate payload checksum (optional headers + fragments)
  let payloadChecksum = 0;
  if (optsSize > 0) {
    payloadChecksum = (payloadChecksum + hash32(buf, PACKET_HEADER_SIZE, optsSize)) >>> 0;
  }
  for (const frag of fragments) {
    payloadChecksum = (payloadChecksum + hashFragment(frag)) >>> 0;
  }

  // Write header with correct size and checksum
  const finalHeader: PacketHeaderData = {
    ...header,
    size: payloadSize,
  };

  // Calculate header checksum (with sentinel in checksum field)
  const headerChecksum = calculateHeaderChecksum(finalHeader);

  // Final checksum = header + payload
  finalHeader.checksum = (headerChecksum + payloadChecksum) >>> 0;

  writePacketHeader(finalHeader, buf, 0);

  return buf;
}

/**
 * Parse a complete packet from a raw buffer.
 */
export function parsePacket(buf: Uint8Array): PacketData {
  const header = readPacketHeader(buf, 0);
  let offset = PACKET_HEADER_SIZE;

  // Read optional headers
  const { opts: optionalHeaders, bytesRead } = readOptionalHeaders(header.flags, buf, offset);
  offset += bytesRead;

  // Read fragments
  const fragments: Fragment[] = [];
  if (hasFlag(header, PacketHeaderFlags.BlobFragments)) {
    const endOffset = PACKET_HEADER_SIZE + header.size;
    while (offset < endOffset) {
      const frag = readFragment(buf, offset);
      fragments.push(frag);
      offset += frag.header.size;
    }
  }

  return { header, optionalHeaders, fragments };
}

/**
 * Verify packet checksum integrity.
 *
 * @returns true if checksum is valid (non-encrypted only)
 */
export function verifyPacketChecksum(buf: Uint8Array): boolean {
  const header = readPacketHeader(buf, 0);

  // Calculate header checksum
  const headerChecksum = calculateHeaderChecksum(header);

  // Calculate payload checksum
  let payloadChecksum = 0;
  if (header.size > 0) {
    // First get optional headers size to split payload correctly
    const { bytesRead: optsSize } = readOptionalHeaders(header.flags, buf, PACKET_HEADER_SIZE);

    if (optsSize > 0) {
      payloadChecksum = (payloadChecksum + hash32(buf, PACKET_HEADER_SIZE, optsSize)) >>> 0;
    }

    // Hash fragments
    if (hasFlag(header, PacketHeaderFlags.BlobFragments)) {
      let offset = PACKET_HEADER_SIZE + optsSize;
      const endOffset = PACKET_HEADER_SIZE + header.size;
      while (offset < endOffset) {
        const frag = readFragment(buf, offset);
        payloadChecksum = (payloadChecksum + hashFragment(frag)) >>> 0;
        offset += frag.header.size;
      }
    }
  }

  const expectedChecksum = (headerChecksum + payloadChecksum) >>> 0;
  return header.checksum === expectedChecksum;
}
