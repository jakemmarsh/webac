/**
 * verify-session-character-delete-wire.ts — byte-exact C2S wire format for
 * CharacterDelete (0xF655) and CharacterRestore (0xF7D9). (ASSESS: pre-fix
 * the char-select Delete button only filtered a local array; no packet was
 * ever sent.)
 *
 * ACE anchoring (reference/ACE/Source/ACE.Server/Network/Handlers/CharacterHandler.cs):
 *   CharacterDelete (lines 273-277):
 *     string clientString = message.Payload.ReadString16L();  // account name
 *     uint characterSlot  = message.Payload.ReadUInt32();     // session.Characters index
 *   CharacterRestore (lines 331-334):
 *     uint guid = message.Payload.ReadUInt32();
 *
 * ReadString16L (ACE Network/Extensions.cs) = u16 length + Windows-1252
 * bytes + pad to a 4-byte boundary (counted from the length prefix).
 */

import { describe, it, expect } from 'vitest';
import { buildCharacterDelete, buildCharacterRestore } from '@ac/network/MessageSerializer.js';
import { GameMessageOpcode } from '@ac/network';

function u32At(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset).getUint32(offset, true);
}

function u16At(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset).getUint16(offset, true);
}

describe('buildCharacterDelete (0xF655 C2S) — CharacterHandler.cs:273-277', () => {
  it('byte-exact layout for "testacjs" slot 2', () => {
    const msg = buildCharacterDelete('testacjs', 2);
    // opcode u32 + (len u16 + 8 chars + 2 pad) + slot u32 = 4 + 12 + 4
    expect(msg.length).toBe(20);
    expect(u32At(msg, 0)).toBe(0xF655);
    expect(u32At(msg, 0)).toBe(GameMessageOpcode.CharacterDelete);
    // String16L: u16 length...
    expect(u16At(msg, 4)).toBe(8);
    // ...ASCII bytes...
    expect(Array.from(msg.slice(6, 14))).toEqual(
      Array.from('testacjs').map(c => c.charCodeAt(0)),
    );
    // ...padded to a 4-byte boundary (2+8=10 → 2 zero pad bytes)...
    expect(msg[14]).toBe(0);
    expect(msg[15]).toBe(0);
    // ...then the slot index as u32.
    expect(u32At(msg, 16)).toBe(2);
  });

  it('simulated ACE-side read (ReadString16L + ReadUInt32) round-trips', () => {
    const account = 'someaccount'; // 11 chars → 13 raw → 3 pad bytes
    const msg = buildCharacterDelete(account, 7);
    const view = new DataView(msg.buffer, msg.byteOffset);
    let offset = 4; // past opcode
    const len = view.getUint16(offset, true);
    offset += 2;
    const str = String.fromCharCode(...msg.slice(offset, offset + len));
    offset += len;
    // ReadString16L aligns to 4 counting from the length prefix.
    const consumed = 2 + len;
    if (consumed % 4 !== 0) offset += 4 - (consumed % 4);
    const slot = view.getUint32(offset, true);
    expect(str).toBe(account);
    expect(slot).toBe(7);
    expect(offset + 4).toBe(msg.length); // nothing trailing
  });

  it('slot 0 (first character) serializes as zero u32', () => {
    const msg = buildCharacterDelete('a', 0); // 1 char → 3 raw → pad 1... (2+1=3 → 1 pad)
    expect(u32At(msg, msg.length - 4)).toBe(0);
  });
});

describe('buildCharacterRestore (0xF7D9 C2S) — CharacterHandler.cs:331-334', () => {
  it('byte-exact: opcode + guid', () => {
    const msg = buildCharacterRestore(0x50000005);
    expect(msg.length).toBe(8);
    expect(u32At(msg, 0)).toBe(0xF7D9);
    expect(u32At(msg, 0)).toBe(GameMessageOpcode.CharacterRestore);
    expect(u32At(msg, 4)).toBe(0x50000005);
  });

  it('high-bit guids stay unsigned on the wire', () => {
    const msg = buildCharacterRestore(0xDEADBEEF);
    expect(u32At(msg, 4)).toBe(0xDEADBEEF);
  });
});
