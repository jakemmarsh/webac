/**
 * PrivateUpdateSkill wire format audit (FAITHFUL.159).
 *
 * The pre-iteration parser had a 2-byte misalignment bug:
 *   Read u16 advancementClass, then u32 "points"
 * vs ACE's actual layout:
 *   Read u16 ranks, then u16 adjustPP, then u32 advancementClass
 *
 * Concretely, the old parser consumed `adjustPP + first 2 bytes of advancementClass`
 * into a single "points" u32, then continued reading every subsequent field shifted
 * by 2 bytes — ExperienceSpent, InitLevel, ResistanceAtLastCheck, LastUsedTime
 * all got garbage values silently. This message is sent every time the server
 * pushes a skill update to the player (raise skill, gain skill from XP, learn
 * a new skill from training, etc.).
 *
 * Root cause: CreatureSkill.cs:109 declares `public ushort Ranks` (2 bytes), and
 * the C# writer does `Writer.Write(creatureSkill.Ranks)` which dispatches to the
 * BinaryWriter.Write(ushort) overload. Our parser was reading as u32.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { BinaryReader, GameMessageOpcode } from '@ac/network';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

const REPO = resolve(__dirname, '..');
const ACE_PUS = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessagePrivateUpdateSkill.cs');
const ACE_CS  = resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/Entity/CreatureSkill.cs');

describe.skipIf(!aceReferenceExists(ACE_PUS))('ACE wire format', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_PUS, 'utf8');
  });
  it('writes 8 fields in this exact order', () => {
    const positions = {
      skill:      src.search(/Writer\.Write\(\(uint\)creatureSkill\.Skill\)/),
      ranks:      src.search(/Writer\.Write\(creatureSkill\.Ranks\)/),
      adjustPP:   src.search(/Writer\.Write\(adjustPP\)/),
      advClass:   src.search(/Writer\.Write\(\(uint\)creatureSkill\.AdvancementClass\)/),
      xpSpent:    src.search(/Writer\.Write\(creatureSkill\.ExperienceSpent\)/),
      initLevel:  src.search(/Writer\.Write\(creatureSkill\.InitLevel\)/),
      resistance: src.search(/Writer\.Write\(creatureSkill\.PropertiesSkill\.ResistanceAtLastCheck\)/),
      lastUsed:   src.search(/Writer\.Write\(creatureSkill\.PropertiesSkill\.LastUsedTime\)/),
    };
    // All positions must be found (positive numbers).
    Object.values(positions).forEach(p => expect(p).toBeGreaterThan(0));
    // And the wire order must be strict: each subsequent field is later in the source.
    const ordered = ['skill', 'ranks', 'adjustPP', 'advClass', 'xpSpent', 'initLevel', 'resistance', 'lastUsed'] as const;
    for (let i = 1; i < ordered.length; i++) {
      expect(positions[ordered[i]]).toBeGreaterThan(positions[ordered[i - 1]]);
    }
  });
  it('declares adjustPP as ushort with the documented client-trigger comment', () => {
    expect(src).toMatch(/ushort adjustPP\s*=\s*1/);
    expect(src).toMatch(/trigger the initLevel to be treated as extra XP/);
  });
});

describe.skipIf(!aceReferenceExists(ACE_CS))('CreatureSkill field widths (the source of the bug)', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_CS, 'utf8');
  });
  it('declares Ranks as ushort', () => {
    expect(src).toMatch(/public ushort Ranks/);
  });
});

describe('Round-trip parse — exactly 33 bytes', () => {
  it('matches ACE byte layout precisely', () => {
    // Build a 33-byte buffer mirroring ACE's writer output and confirm
    // we read every field at the correct offset.
    const buf = new Uint8Array(33);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0x05);                  // seq
    dv.setUint32(1, 1234, true);            // skill (key)
    dv.setUint16(5, 100, true);             // ranks
    dv.setUint16(7, 1, true);               // adjustPP literal
    dv.setUint32(9, 2, true);               // advancementClass (e.g. Trained)
    dv.setUint32(13, 5_000_000, true);      // ExperienceSpent
    dv.setUint32(17, 50, true);             // InitLevel (bonus points)
    dv.setUint32(21, 0, true);              // ResistanceAtLastCheck
    dv.setFloat64(25, 123456.789, true);    // LastUsedTime

    const r = new BinaryReader(buf);
    expect(r.readUInt8()).toBe(0x05);
    expect(r.readUInt32()).toBe(1234);
    expect(r.readUInt16()).toBe(100);
    expect(r.readUInt16()).toBe(1);
    expect(r.readUInt32()).toBe(2);
    expect(r.readUInt32()).toBe(5_000_000);
    expect(r.readUInt32()).toBe(50);
    expect(r.readUInt32()).toBe(0);
    expect(r.readFloat64()).toBeCloseTo(123456.789, 3);
    // Consumed exactly 33 bytes — no remaining data.
    expect(r.position).toBe(33);
  });
});

// DEBT.test-harness-hygiene: behavioural — the real ServerMessageHandler
// decodes a hand-built 33-byte PrivateUpdateSkill (was a source pin).
describe('Integration (FAITHFUL.159)', () => {
  function decode(): Record<string, unknown> {
    const buf = new Uint8Array(33);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0x05);                  // seq
    dv.setUint32(1, 34, true);             // skill (War Magic)
    dv.setUint16(5, 100, true);            // ranks (u16)
    dv.setUint16(7, 1, true);              // adjustPP literal (u16)
    dv.setUint32(9, 3, true);              // advancementClass (u32, Specialized)
    dv.setUint32(13, 5_000_000, true);     // ExperienceSpent
    dv.setUint32(17, 10, true);            // InitLevel
    dv.setUint32(21, 7, true);             // ResistanceAtLastCheck
    dv.setFloat64(25, 123456.789, true);   // LastUsedTime
    const got: Array<Record<string, unknown>> = [];
    const h = new ServerMessageHandler();
    h.setHandlers({ onPrivateUpdateSkill: (d: Record<string, unknown>) => { got.push(d); } } as never);
    h.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdateSkill, payload: buf });
    expect(got.length).toBe(1);
    return got[0];
  }

  it('reads ranks as u16, then adjustPP as u16, then advancementClass as u32 — every later field aligned', () => {
    const d = decode();
    expect(d.key).toBe(34);
    expect(d.points).toBe(100);            // ranks
    expect(d.advancementClass).toBe(3);
    expect(d.cpSpent).toBe(5_000_000);
    expect(d.initLevel).toBe(10);
    expect(d.resistanceOfLastCheck).toBe(7);
    expect(d.lastUsedTime).toBeCloseTo(123456.789, 3);
  });

  it('does NOT use the pre-FAITHFUL.159 mis-read (advancementClass as u16 + points as u32)', () => {
    // The old read would have produced advancementClass = adjustPP (1) and a
    // 2-byte shift in every later field.
    const d = decode();
    expect(d.advancementClass).not.toBe(1);
    expect(d.levelFromCP).toBe(0);
  });
});
