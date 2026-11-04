/**
 * BUG.gdl-account-name-rule — GDL / GDLE / AC1999 auto-create only takes
 * account names of letters, digits, '-' and '_', 1 to 32 characters
 * (CDatabaseIO::CreateAccount → IsUserNameValid, MAX_USERNAME_LENGTH;
 * reference/classic/ClassicDereth/Source/DatabaseIO.cpp, reference/ac1999
 * Server/Source/DatabaseIO.cpp). Any other new name is refused with
 * STR_LOGIN_FAILED ("Client logon failed") every time, while ACE takes it.
 *
 * Production: a player auto-created accounts with the same credentials on
 * eight ACE worlds and was refused on Seedsow six times (2026-10-30, again
 * 2026-11-04 from another address); the quiet first-time retries never
 * helped. Live 2026-11-04 through bridge.playwebac.com: a fresh "acjs.q…"
 * refused twice, the same name without the dot created at once.
 *
 * Driven through the real code: the server's NetError bytes into
 * ClientConnection → serverNetErrorNotice → loginFailureText (main.ts
 * raiseNetError), and ProvenLoginRetry's retry decision (main.ts passes the
 * launcher world and the account it logged in with).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientConnection, PACKET_HEADER_SIZE, type ConnectionEvent } from '../packages/network/src/index.js';
import { serverNetErrorNotice } from '../packages/renderer/src/ui/ConnectionNotices.js';
import {
  autoCreateNameProblem, autoCreateNameText, loginFailureText, perIpLogonFailedText, LOGON_FAILED_HINT,
  AUTO_CREATE_NAME_MAX_LENGTH, type World,
} from '../packages/renderer/src/launcher/worldDirectory.js';
import { ProvenLoginRetry, firstTimeLoginRetryAllowed, type CredentialDigest } from '../packages/renderer/src/session/ProvenLoginRetry.js';

type W = Pick<World, 'name' | 'emu' | 'registration' | 'registrationUrl' | 'perIpLimits'>;
const SEEDSOW: W = { name: 'Seedsow', emu: 'GDL', registration: null, registrationUrl: null, perIpLimits: null };
const GDLE_OPEN: W = { name: 'Frostcull', emu: 'GDLE', registration: null, registrationUrl: null, perIpLimits: null };
const REEFCULL: W = { name: 'Reefcull', emu: 'GDLE', registration: 'Register on the Reefcull website first.', registrationUrl: 'http://reefcull.gdleac.com/', perIpLimits: null };
const COLDEVE: W = { name: 'Coldeve', emu: 'ACE', registration: null, registrationUrl: null, perIpLimits: null };
const AC1999_PUBLIC: W = { name: 'AC1999', emu: 'AC1999', registration: null, registrationUrl: null, perIpLimits: { accounts: 2, sessions: 2 } };
const AC1999_LOCAL: W = { name: 'AC1999 (local)', emu: 'AC1999', registration: null, registrationUrl: null, perIpLimits: null };

const BT_NETERROR = 0x00100000;
const ST_SERVER_ERRORS = 8;
const STR_LOGIN_FAILED = 0x04DF9C54;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  send(b: Uint8Array): void { this.sent.push(new Uint8Array(b)); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(b: Uint8Array): void { this.onmessage?.({ data: b.slice().buffer }); }
}

const g = globalThis as { WebSocket?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = g.WebSocket; g.WebSocket = FakeSocket; FakeSocket.sockets = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { g.WebSocket = saved; vi.restoreAllMocks(); });

/** GDLE CNetwork::SendConnectLoginFailure: flags NetError, {error, ST_SERVER_ERRORS}. */
function gdleRefusal(error: number): Uint8Array {
  const p = new Uint8Array(PACKET_HEADER_SIZE + 8);
  const v = new DataView(p.buffer);
  v.setUint32(4, BT_NETERROR, true);
  v.setUint16(12, 0x0b, true);
  v.setUint16(16, 8, true);
  v.setUint16(18, 0x01, true);
  v.setUint32(20, error >>> 0, true);
  v.setUint32(24, ST_SERVER_ERRORS, true);
  return p;
}

/** A Seedsow-style login (auth type 1, "account:password") refused with STR_LOGIN_FAILED; returns the LoginRequest and the shown text. */
function refusedLogin(account: string, world: W | null): { login: Uint8Array; text: string } {
  const conn = new ClientConnection('ws://bridge', { loginProfile: { clientVersion: '1802', authStyle: 'account-colon-password' } });
  conn.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  conn.connect(account, 'hunter2');
  const sock = FakeSocket.sockets[FakeSocket.sockets.length - 1];
  sock.open();
  sock.deliver(gdleRefusal(STR_LOGIN_FAILED));
  const err = events.filter((e) => e.type === 'error');
  expect(err).toHaveLength(1);
  const n = serverNetErrorNotice(err[0].serverNetError!.stringId, err[0].serverNetError!.tableId);
  expect(n.token).toBe('ID_ConnectionError_ClientLogOnFailed');
  return { login: sock.sent[0], text: loginFailureText(n, world, false, account) };
}

/** The server's IsUserNameValid, ported character for character. */
function serverIsUserNameValid(name: string): boolean {
  for (const c of name) {
    if (c >= 'a' && c <= 'z') continue;
    if (c >= 'A' && c <= 'Z') continue;
    if (c >= '0' && c <= '9') continue;
    if (c === '_' || c === '-') continue;
    return false;
  }
  return true;
}

describe('autoCreateNameProblem matches the servers\' CreateAccount', () => {
  it('every printable ASCII character is judged as IsUserNameValid judges it', () => {
    for (let code = 0x20; code < 0x7f; code++) {
      const name = `ab${String.fromCharCode(code)}cd`;
      expect(autoCreateNameProblem(SEEDSOW, name) === null, name).toBe(serverIsUserNameValid(name));
    }
  });

  it('names the offending characters, at most once each', () => {
    expect(autoCreateNameProblem(SEEDSOW, 'first.last')).toEqual({ kind: 'chars', chars: ['.'] });
    expect(autoCreateNameProblem(SEEDSOW, 'me@mail.example.com')).toEqual({ kind: 'chars', chars: ['@', '.'] });
    expect(autoCreateNameProblem(SEEDSOW, 'John Smith')).toEqual({ kind: 'chars', chars: [' '] });
    expect(autoCreateNameProblem(SEEDSOW, 'Zoë')).toEqual({ kind: 'chars', chars: ['ë'] });
  });

  it('32 characters is the most (MAX_USERNAME_LENGTH)', () => {
    expect(AUTO_CREATE_NAME_MAX_LENGTH).toBe(32);
    expect(autoCreateNameProblem(SEEDSOW, 'a'.repeat(32))).toBeNull();
    expect(autoCreateNameProblem(SEEDSOW, 'a'.repeat(33))).toEqual({ kind: 'length', length: 33 });
  });

  it('applies to GDL, GDLE and AC1999 worlds that auto-create, not to ACE, register-first worlds or URL logins', () => {
    expect(autoCreateNameProblem(GDLE_OPEN, 'first.last')).not.toBeNull();
    expect(autoCreateNameProblem(AC1999_LOCAL, 'first.last')).not.toBeNull();
    expect(autoCreateNameProblem({ ...SEEDSOW, emu: 'gdl' }, 'first.last')).not.toBeNull();
    expect(autoCreateNameProblem(COLDEVE, 'first.last')).toBeNull();
    expect(autoCreateNameProblem(REEFCULL, 'first.last')).toBeNull();
    expect(autoCreateNameProblem(null, 'first.last')).toBeNull();
    expect(autoCreateNameProblem(SEEDSOW, 'plain_Name-1')).toBeNull();
    expect(autoCreateNameProblem(SEEDSOW, '')).toBeNull();
  });
});

describe('the refusal the player sees', () => {
  it('Seedsow, a dotted name: the server\'s text, then what the server needs (not "wrong password")', () => {
    const { login, text } = refusedLogin('first.last', SEEDSOW);
    // The name reaches the server as typed: "first.last:hunter2" in the LoginRequest.
    expect(Buffer.from(login).toString('latin1')).toContain('first.last:hunter2');
    expect(text).toBe(`Client logon failed\n\n${autoCreateNameText('Seedsow', { kind: 'chars', chars: ['.'] })}`);
    expect(text).toContain('Seedsow only creates accounts named with letters, numbers, - and _ (up to 32 characters), and this account name has ".".');
    expect(text).toContain('If you already have this account, check its password.');
    expect(text).not.toContain(LOGON_FAILED_HINT);
  });

  it('an email address and a space read plainly', () => {
    expect(refusedLogin('me@mail.example.com', SEEDSOW).text).toContain('this account name has "@", ".".');
    expect(refusedLogin('John Smith', GDLE_OPEN).text).toContain('Frostcull only creates accounts');
    expect(refusedLogin('John Smith', GDLE_OPEN).text).toContain('this account name has a space.');
    expect(refusedLogin('a'.repeat(40), SEEDSOW).text).toContain('this account name is 40 characters long.');
  });

  it('a name the rule takes keeps the wrong-password hint', () => {
    expect(refusedLogin('plainname', SEEDSOW).text).toBe(`Client logon failed\n\n${LOGON_FAILED_HINT}`);
  });

  it('other worlds are unchanged: register-first keeps its registration line, AC1999 with an account cap keeps the cap text, no world keeps the hint', () => {
    expect(refusedLogin('first.last', REEFCULL).text).toBe('Client logon failed\n\nNew account? Register on the Reefcull website first. http://reefcull.gdleac.com/');
    expect(refusedLogin('first.last', AC1999_PUBLIC).text).toBe(`Client logon failed\n\n${perIpLogonFailedText({ accounts: 2, sessions: 2 })}`);
    expect(refusedLogin('first.last', AC1999_LOCAL).text).toContain('AC1999 (local) only creates accounts');
    expect(refusedLogin('first.last', null).text).toBe(`Client logon failed\n\n${LOGON_FAILED_HINT}`);
    expect(refusedLogin('first.last', COLDEVE).text).toBe(`Client logon failed\n\n${LOGON_FAILED_HINT}`);
  });

  it('in the world the notice is the server text alone, as before', () => {
    const n = serverNetErrorNotice(STR_LOGIN_FAILED, ST_SERVER_ERRORS);
    expect(loginFailureText(n, SEEDSOW, true, 'first.last')).toBe('Client logon failed');
  });
});

describe('no quiet retries for a name that can never be created', () => {
  const digest: CredentialDigest = async (t) => `d:${t}`;
  const TOKEN = 'ID_ConnectionError_ClientLogOnFailed';

  it('firstTimeLoginRetryAllowed: a dotted or over-long name on Seedsow is shown at once; a plain one still retries', () => {
    expect(firstTimeLoginRetryAllowed(SEEDSOW, 'first.last')).toBe(false);
    expect(firstTimeLoginRetryAllowed(SEEDSOW, 'a'.repeat(33))).toBe(false);
    expect(firstTimeLoginRetryAllowed(SEEDSOW, 'plainname')).toBe(true);
    // Without an account (older callers) the world alone decides, as before.
    expect(firstTimeLoginRetryAllowed(SEEDSOW)).toBe(true);
  });

  it('the main.ts sequence: refused once, shown at once (no 3 s / 6 s wait)', async () => {
    const r = new ProvenLoginRetry({ digest });
    const creds = { world: 'wss://bridge/connect?server=seedsow', account: 'first.last', password: 'hunter2' };
    const v = await r.onRefused(creds, TOKEN, { firstTime: firstTimeLoginRetryAllowed(SEEDSOW, creds.account) });
    expect(v).toEqual({ retry: false });
    const plain = { ...creds, account: 'plainname' };
    const v2 = await r.onRefused(plain, TOKEN, { firstTime: firstTimeLoginRetryAllowed(SEEDSOW, plain.account) });
    expect(v2).toEqual({ retry: true, attempt: 1, delayMs: 3000, kind: 'first_time' });
  });
});
