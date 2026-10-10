/**
 * Era login profiles (docs/dark-majesty-support.md): the LoginRequest carries
 * the profile's version literal and credential encoding. Each case drives the
 * shipped ClientConnection and decodes the datagram the way the receiving
 * server's source does:
 *
 *   - end of retail (default): byte-identical to what we always sent, so ACE
 *     and GDLE are untouched;
 *   - ClassicACE CustomDM: "c118" (DatManager.CUSTOMDM_CLIENT_VERSION_STRING),
 *     auth type 2;
 *   - Classic Dereth (Seedsow / GDL-Classic): auth type 1 with
 *     "account:password" and two trailing zero dwords (Seedsow
 *     Network.cpp ConnectionRequest reads portal/cell stamps after the
 *     credentials and drops a short request; GDL-Classic Network.cpp
 *     AuthenticateUserQuery case 1 reads "two empty ints").
 */
import { describe, it, expect } from 'vitest';
import { ClientConnection, EOR_LOGIN_PROFILE, isValidClientVersion, type LoginProfile } from '@ac/network';

const g = globalThis as { WebSocket?: unknown };
if (typeof g.WebSocket === 'undefined') g.WebSocket = class { static readonly OPEN = 1; };

/** The LoginRequest payload (after the 20-byte packet header) for `profile`. */
function loginPayload(account: string, password: string, profile?: LoginProfile): Uint8Array {
  const conn = new ClientConnection('ws://unit-test-not-connected', profile ? { loginProfile: profile } : {});
  const sent: Uint8Array[] = [];
  (conn as unknown as { ws: unknown }).ws = { readyState: 1, send: (d: Uint8Array) => sent.push(new Uint8Array(d)) };
  (conn as unknown as { sendLoginRequest(a: string, p: string): void }).sendLoginRequest(account, password);
  expect(sent).toHaveLength(1);
  return sent[0].subarray(20);
}

/** A reader in the shape of GDL's BinaryReader: String16L (4-aligned) and dwords. */
class Reader {
  private off = 0;
  private readonly v: DataView;
  constructor(private readonly b: Uint8Array) { this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  get remaining(): number { return this.b.length - this.off; }
  u32(): number { const x = this.v.getUint32(this.off, true); this.off += 4; return x; }
  str(): string {
    const len = this.v.getUint16(this.off, true);
    const s = new TextDecoder('latin1').decode(this.b.subarray(this.off + 2, this.off + 2 + len));
    this.off += Math.ceil((2 + len) / 4) * 4;
    return s;
  }
}

describe('era login profiles', () => {
  it('the default profile is end of retail and its request is unchanged', () => {
    expect(EOR_LOGIN_PROFILE).toEqual({ clientVersion: '1802', authStyle: 'account-password' });
    const a = loginPayload('tester', 'pw123');
    const b = loginPayload('tester', 'pw123', EOR_LOGIN_PROFILE);
    expect(Array.from(a)).toEqual(Array.from(b));
    const r = new Reader(a);
    expect(r.str()).toBe('1802');
    r.u32(); // DataLength
    expect(r.u32()).toBe(2); // NetAuthType.AccountPassword
  });

  it('ClassicACE CustomDM sends "c118" with the auth type 2 layout', () => {
    const r = new Reader(loginPayload('tester', 'pw123', { clientVersion: 'c118', authStyle: 'account-password' }));
    expect(r.str()).toBe('c118');
    const dataLength = r.u32();
    expect(dataLength).toBe(r.remaining);
    expect(r.u32()).toBe(2);
    expect(r.u32()).toBe(0); // flags
    r.u32(); // timestamp
    expect(r.str()).toBe('tester');
  });

  it('Classic Dereth sends auth type 1 "account:password" plus two empty dwords', () => {
    const payload = loginPayload('tester', 'pw:x9', { clientVersion: '1802', authStyle: 'account-colon-password' });
    const r = new Reader(payload);
    expect(r.str()).toBe('1802');
    const dataLength = r.u32();
    expect(dataLength).toBe(r.remaining);
    expect(r.u32()).toBe(1); // NetAuthType.Account
    expect(r.u32()).toBe(0); // AuthFlags
    expect(r.u32()).toBe(0); // timestamp
    const creds = r.str();
    // Both servers split at the FIRST ':' (strstr), so a ':' in the password survives.
    expect(creds).toBe('tester:pw:x9');
    expect(creds.slice(0, creds.indexOf(':'))).toBe('tester');
    expect(creds.slice(creds.indexOf(':') + 1)).toBe('pw:x9');
    expect(r.u32()).toBe(0);
    expect(r.u32()).toBe(0);
    expect(r.remaining).toBe(0);
  });

  it('a malformed version falls back to "1802" instead of sending garbage', () => {
    expect(isValidClientVersion('c118')).toBe(true);
    expect(isValidClientVersion('')).toBe(false);
    expect(isValidClientVersion('has space')).toBe(false);
    const r = new Reader(loginPayload('tester', 'pw', { clientVersion: '', authStyle: 'account-password' }));
    expect(r.str()).toBe('1802');
  });

  it('the profile can be set after construction (the launcher picks the world later)', () => {
    const conn = new ClientConnection('ws://unit-test-not-connected');
    expect(conn.loginProfile).toBe(EOR_LOGIN_PROFILE);
    conn.loginProfile = { clientVersion: 'i104', authStyle: 'account-password' };
    const sent: Uint8Array[] = [];
    (conn as unknown as { ws: unknown }).ws = { readyState: 1, send: (d: Uint8Array) => sent.push(new Uint8Array(d)) };
    (conn as unknown as { sendLoginRequest(a: string, p: string): void }).sendLoginRequest('a', 'b');
    expect(new Reader(sent[0].subarray(20)).str()).toBe('i104');
  });
});
