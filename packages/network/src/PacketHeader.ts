/**
 * PacketHeader — 20-byte AC network packet header.
 *
 * Layout (all little-endian):
 *   Offset  Size  Field
 *   0       4     Sequence   (uint32)
 *   4       4     Flags      (uint32, PacketHeaderFlags)
 *   8       4     Checksum   (uint32)
 *   12      2     Id         (uint16)
 *   14      2     Time       (uint16)
 *   16      2     Size       (uint16, payload size excluding header)
 *   18      2     Iteration  (uint16)
 *
 * Ported from ACE.Server.Network.PacketHeader.
 */

import { PacketHeaderFlags } from './PacketHeaderFlags.js';
import { hash32, CHECKSUM_SENTINEL } from './Hash32.js';

export const PACKET_HEADER_SIZE = 20;

export interface PacketHeaderData {
  sequence: number;
  flags: PacketHeaderFlags;
  checksum: number;
  id: number;
  time: number;
  size: number;
  iteration: number;
}

/**
 * Parse a packet header from a buffer at the given offset.
 */
export function readPacketHeader(data: Uint8Array, offset: number = 0): PacketHeaderData {
  const view = new DataView(data.buffer, data.byteOffset + offset, PACKET_HEADER_SIZE);
  return {
    sequence:  view.getUint32(0, true),
    flags:     view.getUint32(4, true) as PacketHeaderFlags,
    checksum:  view.getUint32(8, true),
    id:        view.getUint16(12, true),
    time:      view.getUint16(14, true),
    size:      view.getUint16(16, true),
    iteration: view.getUint16(18, true),
  };
}

/**
 * Write a packet header to a buffer at the given offset.
 */
export function writePacketHeader(header: PacketHeaderData, data: Uint8Array, offset: number = 0): void {
  const view = new DataView(data.buffer, data.byteOffset + offset, PACKET_HEADER_SIZE);
  view.setUint32(0, header.sequence, true);
  view.setUint32(4, header.flags, true);
  view.setUint32(8, header.checksum, true);
  view.setUint16(12, header.id, true);
  view.setUint16(14, header.time, true);
  view.setUint16(16, header.size, true);
  view.setUint16(18, header.iteration, true);
}

/**
 * Calculate the header checksum by setting checksum field to sentinel,
 * hashing the 20 bytes, then restoring original checksum.
 */
export function calculateHeaderChecksum(header: PacketHeaderData): number {
  const buf = new Uint8Array(PACKET_HEADER_SIZE);
  const copy = { ...header, checksum: CHECKSUM_SENTINEL };
  writePacketHeader(copy, buf, 0);
  return hash32(buf, 0, PACKET_HEADER_SIZE);
}

/**
 * Check if a flag is set on the header.
 */
export function hasFlag(header: PacketHeaderData, flag: PacketHeaderFlags): boolean {
  return (header.flags & flag) !== 0;
}
