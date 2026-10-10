/**
 * FAITHFUL.340 — PrivateUpdatePropertyString parser honors ACE's Align(4)
 *  between the property uint32 and the string16L.
 *
 * ACE `GameMessagePrivateUpdatePropertyString.cs:11-14` writes:
 *   1 byte  sequence (ByteSequence)
 *   4 bytes (uint)property
 *   Align(4)  → 3 bytes of pad (position 5 → 8)
 *   String16L value
 *
 * Pre-FAITHFUL.340 parser read the string16 immediately after the property,
 * meaning the first 3 bytes of the string length prefix were sourced from
 * the alignment pad's zeros. For empty-string updates this happened to
 * yield length=0 (correctly empty) by luck — but any non-empty string
 * update (e.g. PropertyString.Name changes via Tailoring kits, allegiance
 * name set, fellowship name set) would yield mojibake.
 *
 * The sibling PublicUpdatePropertyString parser at the matching opcode
 * already applies `r.align(4)` correctly — same pattern.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameMessageOpcode } from '@ac/network';


function u8(v: number): Uint8Array {
  return new Uint8Array([v & 0xff]);
}

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

function string16L(s: string): Uint8Array {
  const bytes = Array.from(s, c => c.charCodeAt(0));
  const total = 2 + bytes.length;
  const pad = (4 - (total % 4)) % 4;
  const out = new Uint8Array(total + pad);
  out[0] = bytes.length & 0xff;
  out[1] = (bytes.length >> 8) & 0xff;
  for (let i = 0; i < bytes.length; i++) out[2 + i] = bytes[i];
  return out;
}

function pad(n: number): Uint8Array {
  return new Uint8Array(n);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('PrivateUpdatePropertyString aligns to 4 before reading string16 (FAITHFUL.340)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onPrivateUpdatePropertyString: d => calls.push(d) });
  });

  it('reads a non-empty string after the 3-byte alignment pad', () => {
    // Position after seq(1) + property(4) = 5; pad 3 → starts at 8.
    const payload = concat(
      u8(42),                       // sequence
      u32(0x10),                    // PropertyString.Name (key 16)
      pad(3),                       // ACE Align(4) inserts 3 pad bytes here
      string16L('Bob the Builder'), // value
    );
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.PrivateUpdatePropertyString,
      payload,
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ guid: 0, key: 0x10, value: 'Bob the Builder' });
  });

  it('handles property keys at high values (e.g. PropertyString.AllegianceName)', () => {
    const payload = concat(
      u8(255),                       // sequence rollover
      u32(0x40),                     // some larger property key
      pad(3),
      string16L('Hand of Asheron'),
    );
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.PrivateUpdatePropertyString,
      payload,
    } as any);
    expect(calls[0].value).toBe('Hand of Asheron');
    expect(calls[0].key).toBe(0x40);
  });

  it('empty-string update still parses correctly (this was the silent-pass-pre-fix case)', () => {
    const payload = concat(
      u8(1),
      u32(0x20),
      pad(3),
      string16L(''),
    );
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.PrivateUpdatePropertyString,
      payload,
    } as any);
    expect(calls[0].value).toBe('');
  });
});

// DEBT.test-harness-hygiene: the former source pins (align(4) between the
// property u32 and the string16) are proven behaviourally here — the pad bytes
// carry non-zero junk, so the string only decodes if the parser skips them.
describe('the 3 alignment bytes are skipped, not read as the length prefix (FAITHFUL.340)', () => {
  it('non-zero pad bytes do not leak into the string', () => {
    const calls: Array<{ key: number; value: string }> = [];
    const handler = new ServerMessageHandler();
    handler.setHandlers({ onPrivateUpdatePropertyString: (d: { key: number; value: string }) => calls.push(d) } as never);
    const payload = concat(u8(3), u32(0x10), new Uint8Array([0x7f, 0x7f, 0x7f]), string16L('Tailored'));
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PrivateUpdatePropertyString, payload } as never);
    expect(calls).toEqual([{ guid: 0, key: 0x10, value: 'Tailored' }]);
  });
});
