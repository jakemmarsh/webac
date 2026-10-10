/**
 * FAITHFUL.335 — Align GameEventMagicUpdateSpell parser with ACE source.
 *
 * ACE `GameEventMagicUpdateSpell.cs` writes:
 *   ushort spellId
 *   ushort layer  (documented "unused?" in source comment)
 * = 4 bytes total payload.
 *
 * Pre-FAITHFUL.335 parser at `ServerMessageHandler.ts:1397-1400` read
 * `r.readUInt32()` and called it the spellId. For all current ACE
 * spells (layer=0, spellId < 65536), the lower 16 bits of the uint32
 * happened to equal the actual ushort spellId, so no visible bug fired
 * in production. But the wire format was misshaped and would silently
 * corrupt the spellId if a value ≥ 65536 ever appeared (e.g. custom
 * server with extended spell range).
 *
 * Sibling parsers `MagicRemoveSpell` and `MagicRemoveEnchantment` already
 * read `ushort + ushort` correctly — the inconsistency was the smoking
 * gun.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameEventType, GameMessageOpcode } from '@ac/network';

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('MagicUpdateSpell parser reads ushort + ushort (FAITHFUL.335)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onMagicUpdateSpell: d => calls.push(d) });
  });

  it('parses 2-byte spellId followed by ignored 2-byte layer', () => {
    // Lightning Bolt VII spellId = 2086 (0x826) per ACE SpellId.cs.
    const payload = concat(u16(2086), u16(0));
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 1,
      eventType: GameEventType.MagicUpdateSpell,
      objectGuid: 0,
      payload,
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ spellId: 2086 });
  });

  it('a high spellId (3500) does NOT get corrupted by reading layer bits', () => {
    // Pre-fix, if layer=1 ever appeared (uint16 0x0001), the uint32 read
    // would yield 0x00013500 (=78592 garbage). Verify the new parser
    // reads only the lower ushort and ignores layer.
    const payload = concat(u16(3500), u16(1));
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 2,
      eventType: GameEventType.MagicUpdateSpell,
      objectGuid: 0,
      payload,
    } as any);
    expect(calls[0]).toEqual({ spellId: 3500 });
  });

  it('handles spellId at the ushort boundary (65535)', () => {
    // Maximum representable ushort value. Pre-fix this still happened
    // to work, but pin the bound so any future regression of the
    // parser to uint32 trips this test.
    const payload = concat(u16(65535), u16(0));
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 3,
      eventType: GameEventType.MagicUpdateSpell,
      objectGuid: 0,
      payload,
    } as any);
    expect(calls[0]).toEqual({ spellId: 65535 });
  });
});
