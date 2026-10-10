/**
 * BUG.chat-nonascii-question-mark — a /f line "The rule says ±3" came back
 * "The rule says ?3" (agent report, end-of-retail local ACE, 2026-10-10).
 *
 * Cause: ACE (and ClassicACE) read every client String16L through
 * BinaryReaderExtensions.ReadString16L = `new string(reader.ReadChars(length))`
 * on ClientMessage's `new BinaryReader(Data)`, whose encoding is UTF-8; the
 * length is a character count and the pad is computed from it. Retail's
 * Windows-1252 byte 0xB1 is invalid UTF-8, so "±" became U+FFFD, and
 * WriteString16L's Windows-1252 GetBytes sent that back as "?". Our encoder
 * was right for retail; ACE isn't. The ACE-family eras now write non-ASCII
 * strings the way ACE reads them; GDLE-family servers (Classic Dereth, the
 * 1999 server: PhatSDK BinaryReader::ReadString keeps raw bytes) stay 1252.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  BinaryWriter, buildChatChannelPayload, buildTellPayload, getString16Wire, setString16Wire,
  encodeWindows1252, decodeWindows1252,
} from '../packages/network/src/MessageSerializer.ts';
import { ERA_PROFILES } from '../packages/renderer/src/era/EraProfiles.ts';

/** ACE's read of a String16L: u16 char count, that many UTF-8 characters, then pad on 2 + count (BinaryReaderExtensions.cs:41). */
function aceReadString16L(buf: Uint8Array, at: number): { s: string; next: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getUint16(at, true);
  let pos = at + 2;
  const dec = new TextDecoder('utf-8');
  let s = '';
  while (s.length < count) {
    // One UTF-8 sequence at a time, as ReadChars decodes (an invalid byte is one U+FFFD).
    const b = buf[pos];
    const len = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc2 ? 2 : 1;
    s += dec.decode(buf.subarray(pos, pos + len));
    pos += len;
  }
  pos += (4 - ((2 + count) % 4)) % 4;
  return { s, next: pos };
}

/** ACE's WriteString16L of what it read, as every client decodes it (Windows-1252 both ways). */
const aceEcho = (s: string): string => decodeWindows1252(encodeWindows1252(s));

describe('BUG.chat-nonascii-question-mark', () => {
  afterEach(() => setString16Wire('windows-1252'));

  it('reproduces the report: Windows-1252 bytes through ACE\'s UTF-8 reader come back as "?"', () => {
    setString16Wire('windows-1252');
    const p = buildChatChannelPayload(0x800, 'The rule says ±3');
    expect(aceEcho(aceReadString16L(p, 4).s)).toBe('The rule says ?3');
  });

  it('with the ACE wire, ±, é, € and smart quotes reach ACE and come back intact', () => {
    setString16Wire('ace');
    for (const text of ['The rule says ±3', 'Café Müller', 'costs 5€', '“quoted” – dash']) {
      const p = buildChatChannelPayload(0x800, text);
      expect(aceEcho(aceReadString16L(p, 4).s)).toBe(text);
      // /say (GameActionTalk: a String16L written by main.ts with the same writer).
      const w = new BinaryWriter(64);
      w.writeString16(text);
      expect(aceEcho(aceReadString16L(w.toBuffer(), 0).s)).toBe(text);
    }
  });

  it('a field after a non-ASCII string is where ACE looks for it (a tell: message, then the name)', () => {
    setString16Wire('ace');
    const p = buildTellPayload('±3 to hit, ok?', 'Bulwark');
    const msg = aceReadString16L(p, 0);
    expect(msg.s).toBe('±3 to hit, ok?');
    expect(aceReadString16L(p, msg.next).s).toBe('Bulwark');
  });

  it('pure ASCII is byte-identical in both wires', () => {
    setString16Wire('windows-1252');
    const a = buildTellPayload('hello there', 'Bulwark');
    setString16Wire('ace');
    expect(buildTellPayload('hello there', 'Bulwark')).toEqual(a);
  });

  it('the ACE-family eras use the ACE wire; Classic Dereth and 1999 (GDLE readers) stay Windows-1252', () => {
    expect(ERA_PROFILES.eor.stringWire).toBe('ace');
    expect(ERA_PROFILES['classicace-customdm'].stringWire).toBe('ace');
    expect(ERA_PROFILES['classicace-infiltration'].stringWire).toBe('ace');
    expect(ERA_PROFILES['classic-dereth'].stringWire).toBeUndefined();
    expect(ERA_PROFILES['ac1999-retail'].stringWire).toBeUndefined();
    expect(getString16Wire()).toBe('windows-1252');
  });
});
