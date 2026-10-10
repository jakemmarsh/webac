/**
 * FAITHFUL.165 — ObjDescEvent (0xF625) parser was missing the trailing
 * Align() + 2 sequence numbers per ACE WorldObject_Networking.cs:48-54.
 *
 * Per ACE source (WorldObject_Networking.cs):
 *   public virtual void SerializeUpdateModelData(BinaryWriter writer)
 *   {
 *       writer.WriteGuid(Guid);
 *       SerializeModelData(writer);                                    ← ends with writer.Align()
 *       writer.Write(Sequences.GetCurrentSequence(SequenceType.ObjectInstance));     // u16
 *       writer.Write(Sequences.GetNextSequence(SequenceType.ObjectVisualDesc));      // u16
 *   }
 *
 * And SerializeModelData line 255:
 *   writer.Align();   ← 4-byte alignment after the variable-size sub-blocks
 *
 * Our pre-FAITHFUL.165 parser stopped at the animPartChanges loop and never
 * read the trailing 4 bytes. Effect: byte-inaccurate parse (cursor stopped
 * 4-8 bytes short of payload end), and consumers had no access to the
 * sequence numbers — preventing any future client-side sequence-aware logic
 * (e.g. ignoring out-of-order desc updates).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BinaryReader, GameMessageOpcode } from '@ac/network';
import { ServerMessageHandler, type ObjDescEventData } from '../packages/renderer/src/network/ServerMessageHandler.js';

const REPO = resolve(__dirname, '..');
const ACE_NET = resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/WorldObject_Networking.cs');

describe.skipIf(!aceReferenceExists(ACE_NET))('ACE source pin: SerializeUpdateModelData layout', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_NET, 'utf8');
  });

  it('SerializeUpdateModelData writes guid → ModelData → ObjectInstance seq → ObjectVisualDesc seq', () => {
    // Slice to just the SerializeUpdateModelData function body, then check
    // each line's relative position within that block.
    const block = src.match(/public virtual void SerializeUpdateModelData\([\s\S]+?\n\s*\}/);
    expect(block).not.toBeNull();
    const body = block![0];
    const guidPos = body.search(/writer\.WriteGuid\(Guid\)/);
    const modelDataPos = body.search(/SerializeModelData\(writer\)/);
    const instSeqPos = body.search(/GetCurrentSequence\(SequenceType\.ObjectInstance\)/);
    const visualSeqPos = body.search(/GetNextSequence\(SequenceType\.ObjectVisualDesc\)/);
    expect(guidPos).toBeGreaterThan(0);
    expect(modelDataPos).toBeGreaterThan(guidPos);
    expect(instSeqPos).toBeGreaterThan(modelDataPos);
    expect(visualSeqPos).toBeGreaterThan(instSeqPos);
  });

  it('SerializeModelData ends with writer.Align()', () => {
    // Pin the alignment invariant our parser depends on.
    expect(src).toMatch(/private void SerializeModelData[\s\S]+?writer\.Align\(\);\s*\n\s*}/);
  });
});

describe('Round-trip parse on a hand-built ACE-faithful ObjDescEvent', () => {
  // Build a minimal ObjDescEvent payload using only the no-sub-data path:
  //   guid (u32) + 0x11 byte + 0 sub-palettes + 0 tex changes + 0 anim parts
  //   = 8 bytes pre-align. 8 mod 4 = 0, so align(4) is a no-op here.
  //   Then 2 trailing u16 sequence numbers.
  it('parses the trailing instance + visualDesc sequence numbers', () => {
    const buf = new Uint8Array(12);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x12345678, true);  // guid
    dv.setUint8(4, 0x11);                // model byte
    dv.setUint8(5, 0);                   // numSubPalettes
    dv.setUint8(6, 0);                   // numTexChanges
    dv.setUint8(7, 0);                   // numAnimParts
    // align(4) — already at byte 8 which is 0 mod 4, no-op
    dv.setUint16(8, 0xABCD, true);       // instanceSequence
    dv.setUint16(10, 0x1234, true);      // visualDescSequence

    const r = new BinaryReader(buf);
    expect(r.readUInt32()).toBe(0x12345678);
    expect(r.readUInt8()).toBe(0x11);
    expect(r.readUInt8()).toBe(0);
    expect(r.readUInt8()).toBe(0);
    expect(r.readUInt8()).toBe(0);
    r.align(4);
    expect(r.readUInt16()).toBe(0xABCD);
    expect(r.readUInt16()).toBe(0x1234);
    expect(r.position).toBe(12);
  });

  it('align(4) does its job when the model-data section has odd length', () => {
    // Build a payload where model data ends on a non-4-aligned offset.
    // numAnimParts=1, each entry = 1 byte partIndex + 1 byte packed partId (small).
    // After u32 guid + 4-byte header + 0 subs + 0 tex + 1 anim (2 bytes) = byte 10.
    // Align to 12 (skip 2 pad bytes). Then 2 u16s at 12, 14.
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xAABBCCDD, true);
    dv.setUint8(4, 0x11);
    dv.setUint8(5, 0);     // numSubPalettes
    dv.setUint8(6, 0);     // numTexChanges
    dv.setUint8(7, 1);     // numAnimParts (1)
    dv.setUint8(8, 0);     // partIndex
    dv.setUint8(9, 0x42);  // packed partId (single byte: high bit clear)
    // bytes 10, 11 are pad to reach 12
    dv.setUint16(12, 0xDEAD, true);   // instanceSeq
    dv.setUint16(14, 0xBEEF, true);   // visualDescSeq

    const r = new BinaryReader(buf);
    r.readUInt32();   // guid
    r.readUInt8();    // 0x11
    r.readUInt8();    // numSubPalettes
    r.readUInt8();    // numTexChanges
    const numAnim = r.readUInt8();
    expect(numAnim).toBe(1);
    r.readUInt8();    // partIndex
    r.readUInt8();    // packed partId (1-byte form)
    expect(r.position).toBe(10);
    r.align(4);
    expect(r.position).toBe(12);
    expect(r.readUInt16()).toBe(0xDEAD);
    expect(r.readUInt16()).toBe(0xBEEF);
  });
});

// DEBT.test-harness-hygiene: behavioural — the real ServerMessageHandler
// decodes hand-built ObjDescEvent (0xF625) payloads (was a source pin).
describe('Integration (FAITHFUL.165)', () => {
  function decode(payload: Uint8Array): ObjDescEventData {
    const got: ObjDescEventData[] = [];
    const h = new ServerMessageHandler();
    h.setHandlers({ onObjDescEvent: (d: ObjDescEventData) => { got.push(d); } } as never);
    h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.ObjDescEvent, payload } as never);
    expect(got.length).toBe(1);
    return got[0];
  }

  it('delivers instanceSequence + visualDescSequence (u16s) when the model data is already aligned', () => {
    const buf = new Uint8Array(12);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0x12345678, true);
    dv.setUint8(4, 0x11);
    dv.setUint16(8, 0xABCD, true);
    dv.setUint16(10, 0x1234, true);
    const d = decode(buf);
    expect(d.guid).toBe(0x12345678);
    expect(d.instanceSequence).toBe(0xABCD);
    expect(d.visualDescSequence).toBe(0x1234);
  });

  it('align(4)s past the pad before the trailers when the model data ends unaligned', () => {
    // guid(4) + header(4) + 1 anim part: partIndex u8 + packed u16 partId → ends at 11; pad 1 → 12.
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 0xAABBCCDD, true);
    dv.setUint8(4, 0x11);
    dv.setUint8(7, 1);                  // numAnimParts
    dv.setUint8(8, 3);                  // partIndex
    dv.setUint16(9, 0x0042, true);      // packed partId (short form)
    dv.setUint8(11, 0x99);              // pad byte (junk — must be skipped)
    dv.setUint16(12, 0xDEAD, true);
    dv.setUint16(14, 0xBEEF, true);
    const d = decode(buf);
    expect(d.animPartChanges).toEqual([{ partIndex: 3, partId: 0x01000042 }]);
    expect(d.instanceSequence).toBe(0xDEAD);
    expect(d.visualDescSequence).toBe(0xBEEF);
  });
});
