/**
 * CharacterError enum + retail-text helper (FAITHFUL.278).
 *
 * Pre-fix ClientConnection.ts held a local `errorNames: Record<number,string>`
 * map that mismapped or omitted most of the 21 codes ACE actually sends.
 * The most user-impacting drift:
 *   - code 0x01 was labeled "Server full or not available" — but the
 *     ACE-canonical text (and original AC executable) is "Cannot have two
 *     accounts logged on at the same time." 0x15 is the actual "server full".
 *   - codes 0x09, 0x0A, 0x0C, 0x11, 0x12, 0x13, 0x14, 0x17, 0x18 were
 *     entirely missing, so a player hitting them saw a useless
 *     `Character error code 18` instead of the actual AC text.
 *
 * The fix moves the table to a real enum + helper in @ac/shared, with
 * wording sourced from ACE CharacterError.cs xmldoc which preserves the
 * original AC executable's ID_CHAR_ERROR_* string resources.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CharacterError, characterErrorMessage } from '@ac/shared';
import {
  ClientConnection, type ConnectionEvent,
  PacketHeaderFlags, type PacketHeaderData,
  PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE,
  writePacketHeader, fragmentMessage, writeFragment,
  GameMessageGroup,
} from '../packages/network/src/index.js';

const REPO = resolve(__dirname, '..');
const ACE_ENUM = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Enum/CharacterError.cs');

describe('CharacterError enum (FAITHFUL.278)', () => {
  it('all 21 ACE codes have the right numeric value', () => {
    expect(CharacterError.Logon).toBe(0x01);
    expect(CharacterError.AccountLogin).toBe(0x03);
    expect(CharacterError.ServerCrash1).toBe(0x04);
    expect(CharacterError.Logoff).toBe(0x05);
    expect(CharacterError.Delete).toBe(0x06);
    expect(CharacterError.ServerCrash2).toBe(0x08);
    expect(CharacterError.AccountInvalid).toBe(0x09);
    expect(CharacterError.AccountDoesntExist).toBe(0x0A);
    expect(CharacterError.EnterGameGeneric).toBe(0x0B);
    expect(CharacterError.EnterGameStressAccount).toBe(0x0C);
    expect(CharacterError.EnterGameCharacterInWorld).toBe(0x0D);
    expect(CharacterError.EnterGamePlayerAccountMissing).toBe(0x0E);
    expect(CharacterError.EnterGameCharacterNotOwned).toBe(0x0F);
    expect(CharacterError.EnterGameCharacterInWorldServer).toBe(0x10);
    expect(CharacterError.EnterGameOldCharacter).toBe(0x11);
    expect(CharacterError.EnterGameCorruptCharacter).toBe(0x12);
    expect(CharacterError.EnterGameStartServerDown).toBe(0x13);
    expect(CharacterError.EnterGameCouldntPlaceCharacter).toBe(0x14);
    expect(CharacterError.LogonServerFull).toBe(0x15);
    expect(CharacterError.EnterGameCharacterLocked).toBe(0x17);
    expect(CharacterError.SubscriptionExpired).toBe(0x18);
  });

  it('skips the gap values (0x02, 0x07, 0x16) — they are unused in ACE', () => {
    // No CharacterError[0x02] / [0x07] / [0x16] entries should exist.
    expect(CharacterError[0x02]).toBeUndefined();
    expect(CharacterError[0x07]).toBeUndefined();
    expect(CharacterError[0x16]).toBeUndefined();
  });
});

describe('characterErrorMessage — canonical retail wording (FAITHFUL.278)', () => {
  // Spot-check the wording that was actually WRONG in the pre-fix map.
  it('0x01 says "two accounts" — NOT "server full" (pre-fix bug)', () => {
    const text = characterErrorMessage(CharacterError.Logon);
    expect(text).toMatch(/two accounts/i);
    expect(text).not.toMatch(/server full/i);
  });

  it('0x15 says "server full" — the ACTUAL server-full code', () => {
    const text = characterErrorMessage(CharacterError.LogonServerFull);
    expect(text).toMatch(/Asheron's Call server is full/i);
  });

  it('0x04 and 0x08 (both ServerCrash) share the same text', () => {
    const t1 = characterErrorMessage(CharacterError.ServerCrash1);
    const t2 = characterErrorMessage(CharacterError.ServerCrash2);
    expect(t1).toBe(t2);
    expect(t1).toMatch(/server has disconnected/i);
  });

  it('0x12 (CorruptCharacter) gives the retail "delete and create new" wording', () => {
    const text = characterErrorMessage(CharacterError.EnterGameCorruptCharacter);
    expect(text).toMatch(/data has been corrupted/i);
    expect(text).toMatch(/delete it/i);
    expect(text).toMatch(/create a new character/i);
  });

  it('0x18 (SubscriptionExpired) — was MISSING from pre-fix map', () => {
    const text = characterErrorMessage(CharacterError.SubscriptionExpired);
    expect(text).toMatch(/subscription/i);
    expect(text).toMatch(/expired/i);
  });

  it('unknown codes get a hex-formatted fallback so the player sees SOMETHING', () => {
    const text = characterErrorMessage(0xDEAD);
    expect(text).toMatch(/0xDEAD/);
  });

  it('every defined code returns non-empty text', () => {
    for (const v of Object.values(CharacterError)) {
      if (typeof v === 'number') {
        const text = characterErrorMessage(v);
        expect(text).toBeTruthy();
        expect(text.length).toBeGreaterThan(5);
      }
    }
  });
});

describe.skipIf(!aceReferenceExists(ACE_ENUM))('ACE source faithfulness (FAITHFUL.278)', () => {
  let src: string;
  beforeAll(() => { src = readFileSync(ACE_ENUM, 'utf8'); });

  // Pin our enum numeric values against the ACE source's literal hex.
  // ACE writes each value as e.g. `Logon = 0x00000001`.
  it('ACE source preserves the original ID_CHAR_ERROR_* xmldoc anchors', () => {
    expect(src).toMatch(/ID_CHAR_ERROR_LOGON/);
    expect(src).toMatch(/ID_CHAR_ERROR_LOGON_SERVER_FULL/);
    expect(src).toMatch(/ID_CHAR_ERROR_SUBSCRIPTION_EXPIRED/);
  });

  it('every named ACE enum value matches our TS port', () => {
    // Extract `Name = 0xVALUE` pairs from the ACE source body
    const re = /(\w+)\s*=\s*0x([0-9A-Fa-f]+),?/g;
    let m: RegExpExecArray | null;
    const tsEnum = CharacterError as Record<string, number | string>;
    const pairs: Array<[string, number]> = [];
    while ((m = re.exec(src)) !== null) {
      pairs.push([m[1], parseInt(m[2], 16)]);
    }
    expect(pairs.length).toBeGreaterThanOrEqual(20);
    for (const [name, value] of pairs) {
      // Some ACE entries use the same name pattern we use; verify they
      // exist with the same numeric value.
      expect(tsEnum[name]).toBe(value);
    }
  });

  // Sanity check: ACE retail wording for at least one canonical case
  // appears verbatim in our helper.
  it('"Cannot have two accounts logged on" wording matches ACE xmldoc', () => {
    expect(src).toMatch(/Cannot have two accounts logged on/);
    expect(characterErrorMessage(CharacterError.Logon))
      .toMatch(/Cannot have two accounts logged on/);
  });
});

// DEBT.test-harness-hygiene: behavioural — a real ClientConnection is fed a
// hand-built CharacterError (0xF659) packet and the emitted error event is
// checked (was a set of ClientConnection.ts source pins).
describe('Wire integration — ClientConnection (FAITHFUL.278)', () => {
  function buildCharacterErrorPacket(seq: number, code: number): Uint8Array {
    const msg = new Uint8Array(8);
    const v = new DataView(msg.buffer);
    v.setUint32(0, 0xF659, true);
    v.setUint32(4, code, true);
    const [frag] = fragmentMessage(msg, seq, GameMessageGroup.WeenieQueue, 0);
    const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + frag.data.length);
    writeFragment(frag, payload, 0);
    const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
    const header: PacketHeaderData = { sequence: seq, flags: PacketHeaderFlags.BlobFragments, checksum: 0, id: 0x42, time: 0, size: payload.length, iteration: 1 };
    writePacketHeader(header, buf, 0);
    buf.set(payload, PACKET_HEADER_SIZE);
    return buf;
  }

  function errorFor(code: number, seq: number): ConnectionEvent | undefined {
    const conn = new ClientConnection('ws://test-not-connected');
    const events: ConnectionEvent[] = [];
    conn.on((e) => events.push(e));
    (conn as unknown as { handlePacket(p: Uint8Array): void }).handlePacket(buildCharacterErrorPacket(seq, code));
    return events.find((e) => e.type === 'error');
  }

  beforeAll(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterAll(() => { vi.restoreAllMocks(); });

  it('the emitted error text is the ACE-canonical characterErrorMessage() for the code', () => {
    const codes = [CharacterError.LogonServerFull, CharacterError.SubscriptionExpired, CharacterError.EnterGameCorruptCharacter];
    codes.forEach((code) => {
      const e = errorFor(code, 2);
      expect(e?.characterError).toBe(code);
      expect(e?.error).toBe(`Server: ${characterErrorMessage(code)}`);
    });
  });

  it('the pre-fix wrong mappings are gone: 0x15 is server-full, not "Character already logged on"', () => {
    const full = errorFor(CharacterError.LogonServerFull, 2);
    expect(full?.error).not.toContain('Character already logged on');
    expect(full?.error).toBe(`Server: ${characterErrorMessage(0x15)}`);
    expect(characterErrorMessage(0x01)).not.toBe('Server full or not available');
  });
});
