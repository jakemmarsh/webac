/**
 * BUG.9 — CreateObject for house objects must parse (PScript is a ushort).
 *
 * Real wire bytes captured live 2026-07-04 (BRIDGE_CAPTURE) from our native
 * ACE-master stack: CreateObject 0xF745 for guid 0x73b9c04e
 * ("housecottage1028" at the 0x3B9C cottage row). Weenie header
 * 0x0C210010 = Usable|ValidLocations|Burden|HouseRestrictions|PScript.
 *
 * ACE writes PScript as a USHORT (WorldObject_Properties.cs:1536
 * `public ushort? Script` → WorldObject_Networking.cs:150). Pre-fix we read
 * u32, drifting every later field by 2 bytes; the misaligned RestrictionDB
 * walk then ran off the buffer (RangeError) and house objects never spawned
 * client-side. Byte-exact decode check: script 0x98, burden 10, then
 * RestrictionDB Version 0x10000002 + OpenStatus 0 + Monarch 0 + count 0 +
 * headerNumBuckets 768 ends exactly at payload end.
 */
import { describe, it, expect } from 'vitest';
import { parseCreateObject } from '../packages/network/src/MessageSerializer.js';

const HEX = '45 f7 00 00 4e c0 b9 73 11 00 00 00 81 a0 02 00 34 00 00 00 65 00 00 00 02 01 9c 3b 51 ab a5 42 cf b7 d1 42 fa fe ff 41 5c 04 3e 3f 00 00 00 00 00 00 00 00 da 8c 2b bf 42 0a 00 02 cd cc cc 3d 98 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 10 00 21 0c 07 00 43 6f 74 74 61 67 65 00 00 00 32 30 81 21 80 00 00 00 94 00 00 00 01 00 00 00 00 00 00 00 98 00 0a 00 02 00 00 10 00 00 00 00 00 00 00 00 00 00 00 03';

function payloadFromHex(hex: string): Uint8Array {
  const bytes = hex.trim().split(/\s+/).map((h) => parseInt(h, 16));
  // strip the 4-byte opcode (0xF745) — parseCreateObject receives the body
  return new Uint8Array(bytes.slice(4));
}

describe('BUG.9 — house CreateObject parses (real captured bytes)', () => {
  it('parses the cottage without buffer overrun and lands byte-exact', () => {
    const obj = parseCreateObject(payloadFromHex(HEX));
    expect(obj).not.toBeNull();
    expect(obj!.guid).toBe(0x73b9c04e);
    expect(obj!.name).toBe('Cottage');
    expect(obj!.setupId).toBe(0x02000a42);
    expect(obj!.position).not.toBeNull();
    expect(obj!.position!.landblock).toBe(0x3b9c0102);
    expect(obj!.burden).toBe(10);
    // GAP.21 — WeenieHeaderFlag.Usable (0x10 in the 0x0C210010 header) is
    // CAPTURED, not skipped: cottage ItemUseable = 0x1 (Usable.No). The
    // target mask (high 16) drives use-with-target routing client-side.
    expect(obj!.usable).toBe(0x1);
  });
});
