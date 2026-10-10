/**
 * PublicUpdateInstanceId handler audit (FAITHFUL.160).
 *
 * Sister to FAITHFUL.158. PublicUpdateInstanceId (opcode 0x02DA) is the public
 * counterpart to PrivateUpdatePropertyInstanceID. ACE fires it heavily from:
 *   - Player_Inventory.cs (Container/Wielder InstanceId for visible peer
 *     items being equipped/unequipped/moved)
 *   - Creature_Death.cs (corpse looting: item.Wielder → Invalid, then
 *     item.Container → corpse.Guid)
 *   - House.cs (HouseOwner instance id flips)
 *   - AdminCommands.cs (admin-driven inventory state changes)
 *
 * Pre-FAITHFUL.160 the client had NO case for 0x02DA → every such message
 * dropped into `logUnhandled`. The cursor wasn't advanced, but because
 * GameEvent-style nested messages don't reuse the parser's buffer position
 * within a single fragment, the immediate symptom was silent peer-state drift:
 *   - other players visibly wielding/unwielding items didn't update
 *   - corpses appearing nearby never reflected loot transfers
 *   - house ownership flips weren't propagated
 *
 * Wire format (ACE GameMessagePublicUpdateInstanceID.cs):
 *   u8  sequence (ByteSequence per SequenceManager.cs:178 default)
 *   u32 worldObject.Guid
 *   u32 (uint)property
 *   u32 instanceGuid
 * Total = 13 bytes.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryReader, GameMessageOpcode } from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACE_DIR = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages');
const aceFile = (name: string) => resolve(ACE_DIR, name);

describe('Opcode numeric pinning', () => {
  it('PublicUpdateInstanceId opcode is 0x02DA', () => {
    expect(GameMessageOpcode.PublicUpdateInstanceId).toBe(0x02DA);
  });
  it('matches the Private sister opcode placement (0x02D9 → 0x02DA)', () => {
    expect(GameMessageOpcode.PublicUpdateInstanceId).toBe(
      GameMessageOpcode.PrivateUpdatePropertyInstanceID + 1
    );
  });
});

describe.skipIf(!existsSync(aceFile('GameMessagePublicUpdateInstanceID.cs')))(
  'ACE wire format',
  () => {
    let src: string;
    // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
    beforeAll(() => {
      src = readFileSync(aceFile('GameMessagePublicUpdateInstanceID.cs'), 'utf8');
    });

    it('writes sequence via UpdatePropertyInstanceID SequenceType (ByteSequence)', () => {
      // The sequence is ByteSequence per SequenceManager.cs:178 default — 1 byte on wire.
      expect(src).toMatch(/GetNextSequence\(SequenceType\.UpdatePropertyInstanceID/);
    });

    it('field order is seq → worldObject.Guid → (uint)property → instanceGuid', () => {
      const sequencePos = src.search(/Writer\.Write\(.*GetNextSequence/);
      const guidPos = src.search(/Writer\.WriteGuid\(worldObject\.Guid\)/);
      const propPos = src.search(/Writer\.Write\(\(uint\)property\)/);
      const instGuidPos = src.search(/Writer\.WriteGuid\(instanceGuid\)/);
      expect(sequencePos).toBeGreaterThan(0);
      expect(guidPos).toBeGreaterThan(sequencePos);
      expect(propPos).toBeGreaterThan(guidPos);
      expect(instGuidPos).toBeGreaterThan(propPos);
    });

    it('base ctor size hint is 17 = 13 payload + 4 opcode prefix', () => {
      // ACE base GameMessage stores opcode + payload; the 3rd arg is the
      // buffer hint. Public variant ships 13 bytes after the 4-byte opcode,
      // so the hint is 17 (cf. private variant's 13 = 9 payload + 4 opcode).
      expect(src).toMatch(/GameMessageGroup\.UIQueue,\s*17\)/);
    });
  }
);

describe('Round-trip parse on a hand-built ACE-faithful buffer', () => {
  it('reads 13 bytes: seq + guid + property + instanceGuid', () => {
    const buf = new Uint8Array(13);
    const dv = new DataView(buf.buffer);
    // Pretend ACE just wrote: seq=0x42, guid=0xDEADBEEF, property=PropertyInstanceId.Wielder (8),
    // instanceGuid=0xCAFEBABE.
    dv.setUint8(0, 0x42);
    dv.setUint32(1, 0xDEADBEEF, true);
    dv.setUint32(5, 8, true);           // PropertyInstanceId.Wielder
    dv.setUint32(9, 0xCAFEBABE, true);

    const r = new BinaryReader(buf);
    expect(r.readUInt8()).toBe(0x42);
    expect(r.readUInt32()).toBe(0xDEADBEEF);
    expect(r.readUInt32()).toBe(8);
    expect(r.readUInt32()).toBe(0xCAFEBABE);
    // Cursor must consume exactly 13 bytes, no more, no less.
    expect(r.position).toBe(13);
  });
});

describe('Integration (FAITHFUL.160, behavioural — real ServerMessageHandler)', () => {
  function dispatch(payload: Uint8Array): Array<{ guid: number; key: number; value: number }> {
    const h = new ServerMessageHandler();
    const got: Array<{ guid: number; key: number; value: number }> = [];
    h.setHandlers({ onPublicUpdatePropertyInstanceID: (d) => { got.push(d as { guid: number; key: number; value: number }); } });
    h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PublicUpdateInstanceId, payload });
    return got;
  }

  it('PublicUpdateInstanceId is dispatched to onPublicUpdatePropertyInstanceID', () => {
    const buf = new Uint8Array(13);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0x07);                 // ByteSequence (1 byte)
    dv.setUint32(1, 0xDEADBEEF, true);    // object guid
    dv.setUint32(5, 8, true);             // PropertyInstanceId key
    dv.setUint32(9, 0xCAFEBABE, true);    // value guid
    expect(dispatch(buf)).toEqual([{ guid: 0xDEADBEEF, key: 8, value: 0xCAFEBABE }]);
  });

  it('reads the sequence as ONE byte (ByteSequence trap) — a 4-byte read would shift every field', () => {
    const buf = new Uint8Array(13);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0xFF);
    dv.setUint32(1, 0x50000001, true);
    dv.setUint32(5, 0x0000000B, true);
    dv.setUint32(9, 0x80001234, true);
    const [d] = dispatch(buf);
    expect(d.guid).toBe(0x50000001);
    expect(d.key).toBe(0x0B);
    expect(d.value).toBe(0x80001234);
  });
});
