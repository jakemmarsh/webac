/**
 * PacketFragment — 16-byte fragment header + variable-length data.
 *
 * Fragment header layout (all little-endian):
 *   Offset  Size  Field
 *   0       4     Sequence   (uint32, fragment sequence number)
 *   4       4     Id         (uint32, message/fragment group ID)
 *   8       2     Count      (uint16, total fragments for this message)
 *   10      2     Size       (uint16, total fragment size including header)
 *   12      2     Index      (uint16, 0-based fragment index)
 *   14      2     Queue      (uint16, GameMessageGroup)
 *
 * Ported from ACE.Server.Network.PacketFragmentHeader / PacketFragment.
 */

import { GameMessageGroup } from './GameMessageGroup.js';
import { hash32 } from './Hash32.js';

export const FRAGMENT_HEADER_SIZE = 16;
export const MAX_FRAGMENT_SIZE = 464;
export const MAX_FRAGMENT_DATA_SIZE = MAX_FRAGMENT_SIZE - FRAGMENT_HEADER_SIZE; // 448

export interface FragmentHeaderData {
  sequence: number;
  id: number;
  count: number;
  size: number;
  index: number;
  queue: GameMessageGroup;
}

export interface Fragment {
  header: FragmentHeaderData;
  data: Uint8Array;
}

/**
 * Parse a fragment header from a buffer at the given offset.
 */
export function readFragmentHeader(data: Uint8Array, offset: number = 0): FragmentHeaderData {
  const view = new DataView(data.buffer, data.byteOffset + offset, FRAGMENT_HEADER_SIZE);
  return {
    sequence: view.getUint32(0, true),
    id:       view.getUint32(4, true),
    count:    view.getUint16(8, true),
    size:     view.getUint16(10, true),
    index:    view.getUint16(12, true),
    queue:    view.getUint16(14, true) as GameMessageGroup,
  };
}

/**
 * Write a fragment header to a buffer at the given offset.
 */
export function writeFragmentHeader(header: FragmentHeaderData, data: Uint8Array, offset: number = 0): void {
  const view = new DataView(data.buffer, data.byteOffset + offset, FRAGMENT_HEADER_SIZE);
  view.setUint32(0, header.sequence, true);
  view.setUint32(4, header.id, true);
  view.setUint16(8, header.count, true);
  view.setUint16(10, header.size, true);
  view.setUint16(12, header.index, true);
  view.setUint16(14, header.queue, true);
}

/**
 * Write a complete fragment (header + data) to a buffer.
 */
export function writeFragment(fragment: Fragment, buf: Uint8Array, offset: number = 0): void {
  writeFragmentHeader(fragment.header, buf, offset);
  buf.set(fragment.data, offset + FRAGMENT_HEADER_SIZE);
}

/**
 * Read a complete fragment (header + data) from a buffer.
 */
export function readFragment(data: Uint8Array, offset: number = 0): Fragment {
  const header = readFragmentHeader(data, offset);
  const dataSize = header.size - FRAGMENT_HEADER_SIZE;
  const fragData = data.slice(offset + FRAGMENT_HEADER_SIZE, offset + FRAGMENT_HEADER_SIZE + dataSize);
  return { header, data: fragData };
}

/**
 * Calculate Hash32 checksum over a complete fragment (header + data).
 */
export function hashFragment(fragment: Fragment): number {
  const totalSize = FRAGMENT_HEADER_SIZE + fragment.data.length;
  const buf = new Uint8Array(totalSize);
  writeFragment(fragment, buf, 0);
  return hash32(buf, 0, totalSize);
}

/**
 * Split a message payload into fragments suitable for transmission.
 *
 * @param payload   The full message bytes to fragment
 * @param id        The message/fragment group ID
 * @param queue     The GameMessageGroup queue
 * @param startSeq  The starting fragment sequence number
 * @returns Array of fragments
 */
export function fragmentMessage(
  payload: Uint8Array,
  id: number,
  queue: GameMessageGroup,
  startSeq: number,
): Fragment[] {
  const fragments: Fragment[] = [];
  const count = Math.max(1, Math.ceil(payload.length / MAX_FRAGMENT_DATA_SIZE));

  for (let i = 0; i < count; i++) {
    const dataStart = i * MAX_FRAGMENT_DATA_SIZE;
    const dataEnd = Math.min(dataStart + MAX_FRAGMENT_DATA_SIZE, payload.length);
    const data = payload.slice(dataStart, dataEnd);

    fragments.push({
      header: {
        // BUG.8 — ALL fragments of one message share ONE fragment sequence:
        // ACE MessageFragment.cs:93 stamps every piece with the message's
        // Sequence (allocated once per message via FragmentSequence++,
        // NetworkSession.cs:821), and ACE's receive side buckets partials
        // by that sequence (NetworkSession.cs:495). Pre-fix we stamped
        // startSeq+i per piece, so a count>1 outbound message would land in
        // N different server-side buckets and never reassemble.
        sequence: startSeq >>> 0,
        id,
        count,
        size: FRAGMENT_HEADER_SIZE + data.length,
        index: i,
        queue,
      },
      data,
    });
  }

  return fragments;
}

/**
 * Reassemble fragments into a complete message payload.
 * Fragments must all have the same `id` and complete set of indices.
 *
 * @param fragments Array of fragments (need not be in order)
 * @returns The reassembled payload, or null if fragments are incomplete
 */
export function reassembleFragments(fragments: Fragment[]): Uint8Array | null {
  if (fragments.length === 0) return null;

  const count = fragments[0].header.count;
  if (fragments.length !== count) return null;

  // Sort by index
  const sorted = [...fragments].sort((a, b) => a.header.index - b.header.index);

  // Verify all indices are present
  for (let i = 0; i < count; i++) {
    if (sorted[i].header.index !== i) return null;
  }

  // Calculate total size
  let totalSize = 0;
  for (const frag of sorted) {
    totalSize += frag.data.length;
  }

  // Concatenate
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const frag of sorted) {
    result.set(frag.data, offset);
    offset += frag.data.length;
  }

  return result;
}
