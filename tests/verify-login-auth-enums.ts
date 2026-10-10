/**
 * NetAuthType + AuthFlags enum audit (FAITHFUL.151).
 *
 * Both enums appear in the LoginRequest payload header. Drift in either
 * value would mean the ACE server rejects the auth attempt (or worse,
 * mis-interprets credentials).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NetAuthType, AuthFlags, ClientConnection, BinaryReader, PacketHeaderFlags } from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACE_NAT  = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Enum/NetAuthType.cs');
const ACE_AF   = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/AuthFlags.cs');

describe.skipIf(!aceReferenceExists(ACE_NAT))('ACE NetAuthType coverage', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_NAT, 'utf8');
  });
  it('TS port matches ACE 1:1', () => {
    expect(src).toMatch(/Undef\s*=\s*0x00000000/);
    expect(src).toMatch(/Account\s*=\s*0x00000001/);
    expect(src).toMatch(/AccountPassword\s*=\s*0x00000002/);
    expect(src).toMatch(/GlsTicket\s*=\s*0x40000002/);
    expect(NetAuthType.Undef).toBe(0x00000000);
    expect(NetAuthType.Account).toBe(0x00000001);
    expect(NetAuthType.AccountPassword).toBe(0x00000002);
    expect(NetAuthType.GlsTicket).toBe(0x40000002);
  });
});

describe.skipIf(!aceReferenceExists(ACE_AF))('ACE AuthFlags coverage', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_AF, 'utf8');
  });
  it('TS port matches ACE 1:1', () => {
    expect(src).toMatch(/None\s*=\s*0x0/);
    expect(src).toMatch(/EnableCrypto\s*=\s*0x1/);
    expect(src).toMatch(/AdminAccountOverride\s*=\s*0x2/);
    expect(src).toMatch(/ExtraData\s*=\s*0x4/);
    expect(AuthFlags.None).toBe(0x0);
    expect(AuthFlags.EnableCrypto).toBe(0x1);
    expect(AuthFlags.AdminAccountOverride).toBe(0x2);
    expect(AuthFlags.ExtraData).toBe(0x4);
  });
  it('declared as [Flags]', () => {
    expect(src).toMatch(/\[Flags\]/);
  });
});

describe('ClientConnection LoginRequest wire (FAITHFUL.151, behavioural)', () => {
  // Drive the real private sendLoginRequest and capture the payload it hands
  // to sendPacket (ACE PacketInboundLoginRequest.cs field order).
  function loginPayload(account: string, password: string): { flags: number; payload: Uint8Array } {
    const conn = new ClientConnection('ws://test-not-connected');
    let captured: { flags: number; payload: Uint8Array } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).sendPacket = (flags: number, payload: Uint8Array) => { captured = { flags, payload }; };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).sendLoginRequest(account, password);
    expect(captured).not.toBeNull();
    return captured!;
  }

  it('LoginRequest header carries ClientVersion "1802", DataLength, NetAuthType.AccountPassword, AuthFlags.None, Timestamp 0', () => {
    const { flags, payload } = loginPayload('testacjs', 'secret');
    expect(flags).toBe(PacketHeaderFlags.LoginRequest);
    const r = new BinaryReader(payload);
    expect(r.readString16()).toBe('1802');
    const dataLength = r.readUInt32();
    const afterLen = r.position;
    expect(r.readUInt32()).toBe(NetAuthType.AccountPassword);
    expect(r.readUInt32()).toBe(AuthFlags.None);
    expect(r.readUInt32()).toBe(0); // timestamp
    expect(r.readString16()).toBe('testacjs');
    expect(r.readString16()).toBe(''); // AccountToLoginAs — retail leaves it empty (admin-only field)
    expect(dataLength).toBe(payload.length - afterLen);
  });

  it('ACE parse order (PacketInboundLoginRequest) recovers account + password', () => {
    const { payload } = loginPayload('acjsprobe1234', 'pa55word!');
    const r = new BinaryReader(payload);
    r.readString16(); r.readUInt32(); r.readUInt32(); r.readUInt32(); r.readUInt32();
    expect(r.readString16()).toBe('acjsprobe1234');
    expect(r.readString16()).toBe('');
    // ReadString32L: u32 byte count, packed-word length, chars
    const total = r.readUInt32();
    const len = r.readUInt8();
    expect(total).toBe(len + 1);
    const bytes = payload.subarray(r.position, r.position + len);
    expect(new TextDecoder().decode(bytes)).toBe('pa55word!');
  });

  it('GDLE parse order (AuthenticateUserQuery, auth type 2) recovers the same password', () => {
    // GDLE Network.cpp: ReadString version; u32; u32 auth_type; u32; u32 timestamp;
    // ReadString username; u32 "nothing" (the empty AccountToLoginAs);
    // u32 dataLen; ReadCompressedUInt16 len; char[len] password.
    for (const account of ['a', 'ab', 'abc', 'acjsprobe1234', 'longer_account_name_x']) {
      const { payload } = loginPayload(account, 'pa55word!');
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const r = new BinaryReader(payload);
      expect(r.readString16()).toBe('1802');
      r.readUInt32();
      expect(r.readUInt32()).toBe(2);
      r.readUInt32(); r.readUInt32();
      expect(r.readString16()).toBe(account);
      expect(view.getUint32(r.position, true)).toBe(0); // GDLE's fixed "nothing" u32
      let p = r.position + 4;
      const dataLen = view.getUint32(p, true); p += 4;
      const b0 = payload[p];
      const len = b0 & 0x80 ? (((b0 & 0x7f) << 8) | payload[p + 1]) : b0;
      p += b0 & 0x80 ? 2 : 1;
      expect(dataLen).toBe(len + 1);
      expect(new TextDecoder().decode(payload.subarray(p, p + len))).toBe('pa55word!');
    }
  });

  it('a zero byte always follows the password (GDLE reads it as a C string up to the first NUL)', () => {
    // GDLE AuthenticateUserQuery: m_password = (char*)ReadArray(len) — a
    // std::string from the bare pointer. Model its reused receive buffer:
    // the packet copied over non-zero garbage, then read up to the first NUL.
    for (const password of ['p', 'pw', 'pwd', 'pw12', 'betapw1', 'pa55word!', 'eleven_char', 'exactly_15_char']) {
      const { payload } = loginPayload('gdlebeta1', password);
      const buffer = new Uint8Array(payload.length + 64).fill(0x41);
      buffer.set(payload);
      const r = new BinaryReader(payload);
      r.readString16(); r.readUInt32(); r.readUInt32(); r.readUInt32(); r.readUInt32(); r.readString16(); r.readString16();
      const p = r.position + 4 + 1; // String32L byte count, packed length
      let end = p;
      while (buffer[end] !== 0) end++;
      expect(new TextDecoder().decode(buffer.subarray(p, end))).toBe(password);
      expect(payload.length % 4).toBe(0);
    }
  });

  it('NetAuthType on the wire is 0x00000002 and AuthFlags 0 (the values ACE accepts)', () => {
    const { payload } = loginPayload('a', 'b');
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const r = new BinaryReader(payload);
    r.readString16();
    const at = r.position + 4; // skip DataLength
    expect(view.getUint32(at, true)).toBe(0x00000002);
    expect(view.getUint32(at + 4, true)).toBe(0);
  });
});
