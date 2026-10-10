/**
 * FAITHFUL.575 — HouseUpdateRestrictions sequence prefix is ONE byte, not four.
 *
 * ACE source:
 *   reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventHouseUpdateRestrictions.cs:11-15
 *     Writer.Write(obj.Sequences.GetNextSequence(SequenceType.UpdateRestrictionDB));
 *     Writer.Write(obj.Guid.Full);
 *     Writer.Write(restrictions);
 *
 *   reference/ACE/Source/ACE.Server/Network/Sequence/SequenceManager.cs:17-19
 *     public byte[] GetNextSequence(SequenceType type) =>
 *         GetSequence(type, 0).NextBytes;
 *
 *   reference/ACE/Source/ACE.Server/Network/Sequence/SequenceManager.cs:160-181
 *     switch (type) {
 *         case ObjectPosition..ObjectInstance: sequence = new UShortSequence(); break;
 *         case Motion:  sequence = new UShortSequence(1, 0x7FFF); break;
 *         default:      sequence = new ByteSequence(false); break;
 *     }
 *
 *   reference/ACE/Source/ACE.Server/Network/Sequence/ByteSequence.cs:42-44
 *     public byte[] CurrentBytes => new byte[] { CurrentValue };
 *     public byte[] NextBytes    => new byte[] { NextValue };
 *
 *   reference/ACE/Source/ACE.Server/Network/Sequence/SequenceType.cs
 *     UpdateRestrictionDB is at position 24 — NOT in the UShortSequence
 *     list (only ObjectPosition through ObjectInstance, enum values 0-8,
 *     are UShortSequence). It defaults to ByteSequence → ONE byte on
 *     the wire.
 *
 * Pre-fix the parser read `sequence = r.readUInt32()` — drifting the
 * cursor 3 bytes and silently corrupting `objectGuid` (3 bytes from
 * the real guid + 1 byte from RestrictionDB.Version), the raw payload
 * offset, and then every downstream RestrictionDB field. The structured
 * parse would either throw a RangeError caught by the try/catch (silent
 * console.warn) or render zero/garbage permission entries. Either way
 * the house permission UI showed wrong state on every restrictions
 * update — open/closed flag wrong, monarch wrong, guest list empty or
 * wildly oversized.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode, GameEventType } from '@ac/network';

function event(eventType: number, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    objectGuid: 0,
    sequence: 1,
    eventType,
    payload,
  };
}

const ACE_ROOT = join(__dirname, '..', 'reference', 'ACE', 'Source');
const HAS_ACE_SRC = aceReferenceExists(ACE_ROOT);

describe('FAITHFUL.575 — ACE source anchors for HouseUpdateRestrictions sequence width', () => {
  it.skipIf(!HAS_ACE_SRC)('GameEventHouseUpdateRestrictions.cs prefixes with GetNextSequence(UpdateRestrictionDB)', () => {
    const src = readFileSync(
      join(ACE_ROOT, 'ACE.Server', 'Network', 'GameEvent', 'Events', 'GameEventHouseUpdateRestrictions.cs'),
      'utf8',
    );
    // Sequence write is the first writer call inside the constructor body.
    expect(src).toMatch(/Writer\.Write\(obj\.Sequences\.GetNextSequence\(SequenceType\.UpdateRestrictionDB\)\)/);
    // Followed by the guid + RestrictionDB writes.
    expect(src).toMatch(/Writer\.Write\(obj\.Guid\.Full\)/);
    expect(src).toMatch(/Writer\.Write\(restrictions\)/);
  });

  it.skipIf(!HAS_ACE_SRC)('SequenceType.cs places UpdateRestrictionDB OUTSIDE the UShortSequence list', () => {
    const src = readFileSync(
      join(ACE_ROOT, 'ACE.Server', 'Network', 'Sequence', 'SequenceType.cs'),
      'utf8',
    );
    // Only ObjectPosition..ObjectInstance (positions 0..8) get UShortSequence
    // per SequenceManager.cs:160-181. UpdateRestrictionDB is declared later
    // in the enum so it falls into the `default: new ByteSequence(false)` arm.
    const lines = src.split('\n');
    const ushortNames = ['ObjectPosition', 'ObjectMovement', 'ObjectState',
      'ObjectVector', 'ObjectTeleport', 'ObjectServerControl',
      'ObjectForcePosition', 'ObjectVisualDesc', 'ObjectInstance'];
    const restrictionIdx = lines.findIndex(l => /\bUpdateRestrictionDB\b/.test(l));
    expect(restrictionIdx).toBeGreaterThan(-1);
    for (const name of ushortNames) {
      const idx = lines.findIndex(l => new RegExp(`\\b${name}\\b`).test(l));
      expect(idx).toBeGreaterThan(-1);
      // UShort entries are all declared BEFORE UpdateRestrictionDB.
      expect(idx).toBeLessThan(restrictionIdx);
    }
  });

  it.skipIf(!HAS_ACE_SRC)('ByteSequence.NextBytes returns byte[1] — one byte on the wire', () => {
    const src = readFileSync(
      join(ACE_ROOT, 'ACE.Server', 'Network', 'Sequence', 'ByteSequence.cs'),
      'utf8',
    );
    expect(src).toMatch(/NextBytes\s*=>\s*new\s+byte\[\]\s*{\s*NextValue\s*}/);
  });
});

describe('FAITHFUL.575 — parser reads sequence as u8, then objectGuid + RestrictionDB align correctly', () => {
  it('byte-exact 25-byte synthetic payload roundtrips cleanly', () => {
    const h = new ServerMessageHandler();
    let raw: any = null;
    let structured: any = null;
    h.setHandlers({
      onHouseUpdateRestrictionsRaw: (d) => { raw = d; },
      onHouseUpdateRestrictions: (d) => { structured = d; },
    });

    // 1 (seq) + 4 (guid) + 12 (Version+OpenStatus+MonarchID) + 4 (count+buckets) + 16 (2×perm)
    // = 37 bytes mimicking exactly what ACE would write.
    const w = new BinaryWriter(64);
    w.writeUInt8(0x2A);             // sequence (ByteSequence: ONE byte)
    w.writeUInt32(0x60001234);      // obj.Guid.Full (the house)
    // RestrictionDB
    w.writeUInt32(0x10000002);      // Version
    w.writeUInt32(0);                // OpenStatus = closed
    w.writeUInt32(0x80007777);      // MonarchID
    w.writeUInt16(2);                // perm count
    w.writeUInt16(768);              // headerNumBuckets (matches RestrictionDBExtensions.cs)
    w.writeUInt32(0x80001001); w.writeUInt32(0);  // guest, dwelling only
    w.writeUInt32(0x80001002); w.writeUInt32(1);  // guest, with storage

    h.handleMessage(event(GameEventType.HouseUpdateRestrictions, w.toBuffer()));

    expect(raw.sequence).toBe(0x2A);
    expect(raw.objectGuid).toBe(0x60001234);
    // rawPayload starts at offset 5 (1-byte seq + 4-byte guid) — 32 bytes
    // remain (RestrictionDB: 12 base fields + 4 hash-header + 16 perm entries).
    expect(raw.rawPayload.length).toBe(32);

    expect(structured.sequence).toBe(0x2A);
    expect(structured.objectGuid).toBe(0x60001234);
    expect(structured.version).toBe(0x10000002);
    expect(structured.openStatus).toBe(false);
    expect(structured.monarchId).toBe(0x80007777);
    expect(structured.permissions.length).toBe(2);
    expect(structured.permissions[0]).toEqual({ playerGuid: 0x80001001, storageAccess: false });
    expect(structured.permissions[1]).toEqual({ playerGuid: 0x80001002, storageAccess: true });
  });

  it('pre-fix wire encoding (u32 sequence) NO LONGER decodes correctly — proves the fix is real', () => {
    // Writing the OLD (wrong) layout — u32 sequence + u32 guid + RestrictionDB —
    // must now produce garbage from the fixed parser. This is the proof that
    // the fix actually changed behavior, not just shuffled bytes around.
    const h = new ServerMessageHandler();
    let cap: any = null;
    h.setHandlers({ onHouseUpdateRestrictions: (d) => { cap = d; } });

    const w = new BinaryWriter(64);
    w.writeUInt32(0x2A);            // OLD: full u32 sequence
    w.writeUInt32(0x60001234);      // OLD: guid at offset 4 (real ACE puts it at offset 1)
    w.writeUInt32(0x10000002);      // Version
    w.writeUInt32(0);                // OpenStatus
    w.writeUInt32(0x80007777);      // MonarchID
    w.writeUInt16(1);                // count=1
    w.writeUInt16(768);
    w.writeUInt32(0x80001001); w.writeUInt32(0);

    h.handleMessage(event(GameEventType.HouseUpdateRestrictions, w.toBuffer()));

    // With the corrected u8 parse, this old-format payload shifts everything
    // by 3 bytes — `objectGuid` should NOT equal what we put at offset 4.
    expect(cap?.objectGuid ?? 0).not.toBe(0x60001234);
  });

  it('multiple consecutive sequence values (0, 1, 2 — typical client-primed start) all roundtrip', () => {
    // ByteSequence rolls 0..255 then resets. Sanity-check the parser handles
    // any byte value, not just an arbitrary mid-range pick.
    for (const seqVal of [0x00, 0x01, 0xFF, 0x80, 0x7F]) {
      const h = new ServerMessageHandler();
      let cap: any = null;
      h.setHandlers({ onHouseUpdateRestrictions: (d) => { cap = d; } });

      const w = new BinaryWriter(32);
      w.writeUInt8(seqVal);
      w.writeUInt32(0x60000001);
      w.writeUInt32(0x10000002);
      w.writeUInt32(1);
      w.writeUInt32(0xDEADBEEF);
      w.writeUInt16(0);  // empty perm table
      w.writeUInt16(768);

      h.handleMessage(event(GameEventType.HouseUpdateRestrictions, w.toBuffer()));
      expect(cap.sequence).toBe(seqVal);
      expect(cap.objectGuid).toBe(0x60000001);
      expect(cap.monarchId).toBe(0xDEADBEEF);
      expect(cap.openStatus).toBe(true);
      expect(cap.permissions.length).toBe(0);
    }
  });
});
