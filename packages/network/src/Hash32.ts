/**
 * Hash32 — AC's custom checksum algorithm for packet verification.
 *
 * Ported from ACE.Common.Cryptography.Hash32.
 * This is NOT a standard CRC32 — it's AC's own sum-based hash.
 */

/**
 * Calculate the AC Hash32 checksum over a byte range.
 *
 * Algorithm:
 * 1. Start with (length << 16)
 * 2. Add all aligned 32-bit words (little-endian)
 * 3. Add remaining 1-3 bytes shifted into high positions
 * 4. Return as uint32 (mask to 32 bits)
 */
export function hash32(data: Uint8Array, offset: number = 0, length?: number): number {
  const len = length ?? (data.length - offset);
  let checksum = (len << 16) >>> 0;

  // Add 32-bit chunks (little-endian)
  const view = new DataView(data.buffer, data.byteOffset + offset, len);
  const fullWords = Math.floor(len / 4);
  for (let i = 0; i < fullWords; i++) {
    checksum = (checksum + view.getUint32(i * 4, true)) >>> 0;
  }

  // Add remaining bytes (1-3), shifted into high byte positions
  let shift = 3;
  let j = fullWords * 4;
  while (j < len) {
    checksum = (checksum + ((data[offset + j] << (8 * shift)) >>> 0)) >>> 0;
    j++;
    shift--;
  }

  return checksum >>> 0;
}

/** Sentinel value placed in the checksum field when computing header hash. */
export const CHECKSUM_SENTINEL = 0xBADD70DD;
