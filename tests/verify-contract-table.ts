/**
 * FAITHFUL.206 — ContractTable (0x0E00001D) parser.
 *
 * Pre-FAITHFUL.206 the Contracts panel showed entries as "Contract #N"
 * because we only had the ContractTracker's contractId. The DAT file
 * 0x0E00001D contains the authoritative quest metadata: name, description,
 * NPC names, world positions of start/end/quest-area.
 *
 * 322 retail quests including "The Shadows of Bitter Winter", "Reign of
 * Terror", etc. Now resolved via contractTable.nameFor(id) at publish time.
 */
import { describe, it, expect } from 'vitest';
import { ContractTable } from '@ac/dat-parser';
import { DatReader } from '@ac/dat-parser/DatReader.js';

/**
 * Helper: build a minimal ContractTable buffer with one quest entry.
 * Layout: id (uint32) + numContracts (uint16) + tableSize (uint16)
 *         + N × [ key (uint32) + Contract record ]
 *
 * Contract record fields (per ACE Entity/Contract.cs):
 *   uint32 version + uint32 contractId
 *   12× PString (each followed by align(4))
 *   3× Position (uint32 cellId + Frame{vec3 origin + quat wxyz} = 32 bytes each)
 */
function buildContractTableDat(): ArrayBuffer {
  const buf = new ArrayBuffer(4096);
  const view = new DataView(buf);
  let off = 0;

  const writePString = (s: string): void => {
    view.setUint16(off, s.length, true); off += 2;
    for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i));
    while (off % 4 !== 0) view.setUint8(off++, 0);
  };
  const writePosition = (): void => {
    view.setUint32(off, 0xA9B40034, true); off += 4; // objCellId
    // Frame: 3 floats origin + 4 floats quaternion (w, x, y, z)
    for (let i = 0; i < 7; i++) { view.setFloat32(off, 0, true); off += 4; }
  };

  view.setUint32(off, 0x0E00001D, true); off += 4; // id
  view.setUint16(off, 1, true); off += 2; // numContracts
  view.setUint16(off, 0, true); off += 2; // tableSize
  view.setUint32(off, 1, true); off += 4; // key
  view.setUint32(off, 1, true); off += 4; // version
  view.setUint32(off, 1, true); off += 4; // contractId
  writePString('Test Quest');
  writePString('Find the lost shard.');
  writePString('You have found 1 of 5 shards.');
  writePString('Aerlinthe');
  writePString('Asheron');
  writePString('TestQuestStamp');
  writePString('TestQuestStarted');
  writePString('TestQuestFinished');
  writePString('TestQuestProgress');
  writePString('TestQuestTimer');
  writePString('TestQuestRepeat');
  writePosition();
  writePosition();
  writePosition();

  return buf.slice(0, off);
}

describe('ContractTable — binary parser', () => {
  it('decodes id + count + a single contract record', () => {
    const buf = buildContractTableDat();
    const t = ContractTable.read(new DatReader(buf));
    expect(t.id).toBe(0x0E00001D);
    expect(t.contracts.size).toBe(1);
    const c = t.contracts.get(1);
    expect(c).toBeDefined();
    expect(c!.contractName).toBe('Test Quest');
    expect(c!.description).toBe('Find the lost shard.');
    expect(c!.descriptionProgress).toBe('You have found 1 of 5 shards.');
    expect(c!.nameNpcStart).toBe('Aerlinthe');
    expect(c!.nameNpcEnd).toBe('Asheron');
    expect(c!.questflagStamped).toBe('TestQuestStamp');
    expect(c!.locationNpcStart.objCellId).toBe(0xA9B40034);
  });

  it('nameFor(id) returns the contract name', () => {
    const buf = buildContractTableDat();
    const t = ContractTable.read(new DatReader(buf));
    expect(t.nameFor(1)).toBe('Test Quest');
    expect(t.nameFor(999)).toBe(null);
  });

  it('descriptionFor(id) returns the contract description', () => {
    const buf = buildContractTableDat();
    const t = ContractTable.read(new DatReader(buf));
    expect(t.descriptionFor(1)).toBe('Find the lost shard.');
    expect(t.descriptionFor(999)).toBe(null);
  });
});

describe('ContractTable — module surface', () => {
  it('is re-exported from @ac/dat-parser', () => {
    expect(typeof ContractTable).toBe('function');
  });
});
