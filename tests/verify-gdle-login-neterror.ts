/**
 * RELEASE.gdle-login-neterror — a GDLE / ClassicDereth world that refuses a
 * login answers with a NetError packet; the login ends at once with the
 * server's text ("Client logon failed") instead of sitting out the 25 s
 * LoginRequest budget and showing "Client timed out the connection".
 *
 * Server side (reference/classic/ClassicDereth/Source): AuthenticateUserQuery::
 * PerformQuery → CNetwork::SendConnectLoginFailure (Network.cpp) builds an
 * 8-byte blob {error, ST_SERVER_ERRORS = 8} and SendConnectlessBlob sends it
 * with seq 0, flags BT_NETERROR 0x00100000, recID = server id, time 0,
 * table 1 and the GenericCRC checksum (crc.cpp). STR_LOGIN_FAILED =
 * 0x04DF9C54 (NetworkDefs.h). The live Reefcull refusal was five of these
 * (28 bytes each, one per LoginRequest resend = the "~140 bytes").
 *
 * Retail (decompiled EoL client): ClientNet::ProcessOptionalHeader @ 005451a0
 * case 0x100000 — in the logon context EndState @ 00543380 fails the logon
 * with the NetError (NetError::UnPack @ 004114a0: u32 string id, u32 table
 * enum), which Client::Init shows through PopupError; outside it,
 * LogOffServer + ServerDied. (0, 0) is ID_NetError_None → EndStateOK.
 *
 * The tests drive the real ClientConnection over a fake socket with that
 * packet built byte for byte, the real ConnectionNotices resolution (DAT
 * table 0x23000010 when dat/ is present) and the launcher's text rule. The
 * AC1999 lane (Connection1999) now reports the same serverNetError
 * (tests/verify-ac1999-login-refusal.ts has its server's bytes); a short pin
 * is at the end.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import {
  ClientConnection, type ConnectionEvent, PacketHeaderFlags, PACKET_HEADER_SIZE,
  netErrorPayloadOffset, readServerNetError,
} from '../packages/network/src/index.js';
import { SessionState } from '../packages/network/src/ConnectionData.js';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import {
  serverNetErrorNotice, netErrorNotice, LOGIN_REFUSED_TOKENS, NET_ERROR_STRING_TABLE, NET_ERROR_TABLE_ENUMS,
} from '../packages/renderer/src/ui/ConnectionNotices.js';
import { loginFailureText, LOGON_FAILED_HINT } from '../packages/renderer/src/launcher/worldDirectory.js';
import { acStringHash, getStringFromTable, parseStringTable, registerStringTable } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { CharacterError } from '../packages/shared/src/index.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';

// NetworkDefs.h
const BT_NETERROR = 0x00100000;
const ST_SERVER_ERRORS = 8;
const STR_LOGIN_FAILED = 0x04DF9C54;
const STR_LOGIN_SERVER_FULL = 0x00F9982C;
const STR_LOGIN_CLIENT_VERSION = 0x00A7E948;
const STR_LOGIN_ACCOUNT_ONLINE = 0x0C559B1E;
const STR_LOGIN_INVALID_AUTH = 0x082E3779;
const GDLE_SERVER_ID = 0x0b;

/** crc.cpp GetMagicNumber: size << 16, then little-endian u32 words, then the tail bytes high-first. */
function magic(b: Uint8Array, size: number): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let cs = (size << 16) >>> 0;
  let i = 0;
  for (; i < size >> 2; i++) cs = (cs + v.getUint32(i * 4, true)) >>> 0;
  let shift = 3;
  for (i <<= 2; i < size; i++) { cs = (cs + (b[i] << (shift * 8))) >>> 0; shift--; }
  return cs;
}

/** CNetwork::SendConnectLoginFailure + SendConnectlessBlob + GenericCRC, byte for byte. */
function gdleLoginFailure(error: number, table = ST_SERVER_ERRORS): Uint8Array {
  const p = new Uint8Array(PACKET_HEADER_SIZE + 8);
  const v = new DataView(p.buffer);
  v.setUint32(0, 0, true);             // dwSequence
  v.setUint32(4, BT_NETERROR, true);   // dwFlags
  v.setUint16(12, GDLE_SERVER_ID, true); // wRecID
  v.setUint16(14, 0, true);            // wTime
  v.setUint16(16, 8, true);            // wSize
  v.setUint16(18, 0x01, true);         // wTable
  v.setUint32(20, error >>> 0, true);
  v.setUint32(24, table, true);
  v.setUint32(8, 0xBADD70DD, true);
  const crc1 = magic(p.subarray(0, 20), 20);
  const crc2 = magic(p.subarray(20), 8);
  v.setUint32(8, (crc1 + crc2) >>> 0, true);
  return p;
}

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: FakeSocket[] = [];
  readyState = 1;
  binaryType = '';
  sent: Uint8Array[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  send(b: Uint8Array): void { this.sent.push(new Uint8Array(b)); }
  close(): void { this.closed = true; this.readyState = 3; this.onclose?.(); }
  deliver(b: Uint8Array): void { this.onmessage?.({ data: b.slice().buffer }); }
}

const g = globalThis as { WebSocket?: unknown };
let savedWs: unknown;
beforeAll(() => { savedWs = g.WebSocket; g.WebSocket = FakeSocket; });
afterAll(() => { g.WebSocket = savedWs; });
afterEach(() => { FakeSocket.sockets = []; vi.useRealTimers(); vi.restoreAllMocks(); });

function startLogin(): { conn: ClientConnection; events: ConnectionEvent[]; sock: FakeSocket } {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const conn = new ClientConnection('ws://bridge');
  conn.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  conn.connect('acjsprobe5679', 'pw');
  const sock = FakeSocket.sockets[0];
  sock.onopen?.();
  return { conn, events, sock };
}

describe('the GDLE refusal packet', () => {
  it('is 28 bytes, flags exactly NetError, and its payload reads as {STR_LOGIN_FAILED, 8}', () => {
    const p = gdleLoginFailure(STR_LOGIN_FAILED);
    expect(p.length).toBe(28);
    expect(new DataView(p.buffer).getUint32(4, true)).toBe(PacketHeaderFlags.NetError);
    expect(netErrorPayloadOffset(p)).toBe(PACKET_HEADER_SIZE);
    expect(readServerNetError(p)).toEqual({ stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS });
  });

  it('steps over the optional headers that precede 0x00100000 (ascending flag order)', () => {
    const build = (flags: number, prefix: number[]): Uint8Array => {
      const p = new Uint8Array(PACKET_HEADER_SIZE + prefix.length * 4 + 8);
      const v = new DataView(p.buffer);
      v.setUint32(4, flags, true);
      prefix.forEach((w, i) => v.setUint32(PACKET_HEADER_SIZE + i * 4, w, true));
      v.setUint32(PACKET_HEADER_SIZE + prefix.length * 4, STR_LOGIN_SERVER_FULL, true);
      v.setUint32(PACKET_HEADER_SIZE + prefix.length * 4 + 4, 8, true);
      return p;
    };
    // AckSequence (4 bytes) first.
    expect(readServerNetError(build(BT_NETERROR | PacketHeaderFlags.AckSequence, [77])))
      .toEqual({ stringId: STR_LOGIN_SERVER_FULL, tableId: 8 });
    // A RequestRetransmit list of two, then AckSequence.
    expect(readServerNetError(build(BT_NETERROR | PacketHeaderFlags.RequestRetransmit | PacketHeaderFlags.AckSequence, [2, 5, 6, 9])))
      .toEqual({ stringId: STR_LOGIN_SERVER_FULL, tableId: 8 });
    // ServerSwitch (8 bytes).
    expect(readServerNetError(build(BT_NETERROR | PacketHeaderFlags.ServerSwitch, [1, 2])))
      .toEqual({ stringId: STR_LOGIN_SERVER_FULL, tableId: 8 });
    // No NetError flag, or a truncated payload: nothing.
    expect(readServerNetError(build(PacketHeaderFlags.AckSequence, [1]))).toBeNull();
    expect(readServerNetError(gdleLoginFailure(STR_LOGIN_FAILED).subarray(0, 22))).toBeNull();
    // NetError::UnPack: a lone string id leaves the table 0.
    expect(readServerNetError(gdleLoginFailure(STR_LOGIN_FAILED).subarray(0, 24))).toEqual({ stringId: STR_LOGIN_FAILED, tableId: 0 });
  });
});

describe('ClientConnection: a NetError during logon ends the login at once (ClientNet::EndState)', () => {
  it('the refusal is an error event with the string id + table, the socket closes, and no 25 s timeout follows', () => {
    vi.useFakeTimers();
    const { events, sock } = startLogin();
    const loginsSent = sock.sent.length;
    expect(loginsSent).toBe(1);
    sock.deliver(gdleLoginFailure(STR_LOGIN_FAILED));

    const err = events.filter((e) => e.type === 'error');
    expect(err).toHaveLength(1);
    expect(err[0].serverNetError).toEqual({ stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS });
    expect(err[0].netErrorId).toBeUndefined();
    expect(err[0].characterError).toBeUndefined();
    expect(sock.closed).toBe(true);
    // The close is ours and ends nothing in the world: no ServerDied 'disconnected'.
    expect(events.some((e) => e.type === 'disconnected')).toBe(false);

    // Pre-fix: more LoginRequests, then 'Login timed out' (at 40 s now: ClientNet::LogonUseTime).
    vi.advanceTimersByTime(60_000);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(events.some((e) => e.netErrorId === 'ID_ConnectionError_ClientTimedOutServer')).toBe(false);
    expect(sock.sent.length).toBe(loginsSent);
    expect(FakeSocket.sockets).toHaveLength(1); // nothing reconnects
  });

  it('a relaunched connect cycle logs in afresh on a new socket', () => {
    vi.useFakeTimers();
    const { conn, events, sock } = startLogin();
    sock.deliver(gdleLoginFailure(STR_LOGIN_FAILED));
    events.length = 0;
    conn.connect('acjsprobe5679', 'pw');
    const second = FakeSocket.sockets[1];
    second.onopen?.();
    expect(second.sent).toHaveLength(1);
    expect(new DataView(second.sent[0].buffer).getUint32(4, true) & PacketHeaderFlags.LoginRequest).toBeTruthy();
    // A late refusal on the old socket (the server answers every resend) is ignored.
    sock.deliver(gdleLoginFailure(STR_LOGIN_FAILED));
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(second.closed).toBe(false);
    conn.disconnect();
  });

  it('ID_NetError_None (0, 0) is EndStateOK: the login keeps waiting', () => {
    vi.useFakeTimers();
    const { conn, events, sock } = startLogin();
    sock.deliver(gdleLoginFailure(0, 0));
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(sock.closed).toBe(false);
    vi.advanceTimersByTime(ClientConnection.LOGIN_RETRY_INTERVAL);
    expect(sock.sent.length).toBe(2); // the LoginRequest resend still runs
    conn.disconnect();
  });

  it('outside the logon context it is LogOffServer + ServerDied: a non-deliberate drop of the open socket', () => {
    const { events, conn, sock } = startLogin();
    (conn as unknown as { connectionData: { state: SessionState } }).connectionData.state = SessionState.AuthConnected;
    events.length = 0;
    sock.deliver(gdleLoginFailure(STR_LOGIN_FAILED));
    const d = events.filter((e) => e.type === 'disconnected');
    expect(d).toHaveLength(1);
    expect(d[0].everOpened).toBe(true);
    expect(d[0].deliberate).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe('ConnectionNotices: the server NetError text', () => {
  it('table enum 8 is 0x23000010; each GDLE login error is an ID_ConnectionError_* hash with its retail wording', () => {
    expect(NET_ERROR_TABLE_ENUMS.get(ST_SERVER_ERRORS)).toBe(NET_ERROR_STRING_TABLE);
    const cases: Array<[number, string, string]> = [
      [STR_LOGIN_FAILED, 'ID_ConnectionError_ClientLogOnFailed', 'Client logon failed'],
      [STR_LOGIN_SERVER_FULL, 'ID_ConnectionError_ServerFull', 'Server Full'],
      [STR_LOGIN_CLIENT_VERSION, 'ID_ConnectionError_NetVersionMismatch', 'You do not have the current version of the client installed.'],
      [STR_LOGIN_ACCOUNT_ONLINE, 'ID_ConnectionError_PlayerAlreadyLoggedOn', 'Player already logged on'],
      [STR_LOGIN_INVALID_AUTH, 'ID_ConnectionError_BadCryptoKey', 'Invalid or corrupted authentication'],
    ];
    for (const [id, token, text] of cases) {
      expect(acStringHash(token), token).toBe(id);
      const n = serverNetErrorNotice(id, ST_SERVER_ERRORS);
      expect(n).toMatchObject({ surface: 'dialog', token, stringId: id, text });
    }
  });

  it('an id no table resolves shows ID_ConnectionError_Generic instead of a blank box', () => {
    const n = serverNetErrorNotice(0x0123456, ST_SERVER_ERRORS);
    expect(n.token).toBe('');
    expect(n.text).toBe('There was an error with this connection');
    expect(serverNetErrorNotice(0x0123456, 99).text).toBe('There was an error with this connection');
  });

  it('the client-side tokens keep their notices', () => {
    expect(netErrorNotice('ID_ConnectionError_ClientTimedOutServer').text).toBe('Client timed out the connection');
    expect(netErrorNotice('ID_NetError_CantSocket').token).toBe('ID_NetError_CantSocket');
  });
});

describe('the registration hint on register-first worlds', () => {
  const reef = { name: 'Reefcull', registration: 'Register on the Reefcull website first.', registrationUrl: 'http://reefcull.gdleac.com/' };
  const plain = { name: 'Local', registration: null, registrationUrl: null };
  const hint = '\n\nNew account? Register on the Reefcull website first. http://reefcull.gdleac.com/';

  it('the login-failed NetError carries it, like the timeout', () => {
    expect([...LOGIN_REFUSED_TOKENS].sort()).toEqual(['ID_ConnectionError_ClientLogOnFailed', 'ID_ConnectionError_ClientTimedOutServer']);
    expect(loginFailureText(serverNetErrorNotice(STR_LOGIN_FAILED, 8), reef, false)).toBe(`Client logon failed${hint}`);
    expect(loginFailureText(netErrorNotice('ID_ConnectionError_ClientTimedOutServer'), reef, false)).toBe(`Client timed out the connection${hint}`);
  });

  it('on an auto-create world the login-failed NetError is a taken name / wrong password and says so', () => {
    expect(loginFailureText(serverNetErrorNotice(STR_LOGIN_FAILED, 8), plain, false)).toBe(`Client logon failed\n\n${LOGON_FAILED_HINT}`);
    expect(loginFailureText(serverNetErrorNotice(STR_LOGIN_FAILED, 8), null, false)).toBe(`Client logon failed\n\n${LOGON_FAILED_HINT}`);
    expect(loginFailureText(netErrorNotice('ID_ConnectionError_ClientTimedOutServer'), plain, false)).toBe('Client timed out the connection');
  });

  it('other errors and in-world failures keep the plain text', () => {
    expect(loginFailureText(serverNetErrorNotice(STR_LOGIN_SERVER_FULL, 8), reef, false)).toBe('Server Full');
    expect(loginFailureText(serverNetErrorNotice(STR_LOGIN_SERVER_FULL, 8), plain, false)).toBe('Server Full');
    expect(loginFailureText(serverNetErrorNotice(STR_LOGIN_FAILED, 8), plain, true)).toBe('Client logon failed');
    expect(loginFailureText(netErrorNotice('ID_ConnectionError_ClientTimedOutServer'), reef, true)).toBe('Client timed out the connection');
    expect(loginFailureText(netErrorNotice('ID_NetError_CantSocket'), reef, false)).toBe(netErrorNotice('ID_NetError_CantSocket').text);
  });
});

describe.skipIf(!existsSync(DAT_PATHS.local))('DAT: table 0x23000010 holds the GDLE login errors', () => {
  beforeAll(() => {
    const lang = openDat(DAT_PATHS.local);
    registerStringTable(parseStringTable(lang.getReader(NET_ERROR_STRING_TABLE)));
  });

  it('the table-bound strings are the retail wording', () => {
    expect(getStringFromTable(NET_ERROR_STRING_TABLE, STR_LOGIN_FAILED)).toBe('Client logon failed');
    expect(getStringFromTable(NET_ERROR_STRING_TABLE, STR_LOGIN_SERVER_FULL)).toBe('Server Full');
    expect(getStringFromTable(NET_ERROR_STRING_TABLE, STR_LOGIN_ACCOUNT_ONLINE)).toBe('Player already logged on');
    expect(serverNetErrorNotice(STR_LOGIN_FAILED, ST_SERVER_ERRORS).text).toBe('Client logon failed');
  });
});

describe('AC1999 lane: Connection1999 reports the same serverNetError (RELEASE.ac1999-login-refusal-reasons)', () => {
  it('a 1999 NetError packet is the server string id + table, not a CharacterError, + disconnect', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const conn = new Connection1999('ws://bridge');
    const events: ConnectionEvent[] = [];
    conn.on((e) => events.push(e));
    conn.connect('acct', 'pw');
    const sock = FakeSocket.sockets[0];
    sock.onopen?.();
    const p = new Uint8Array(24);
    const v = new DataView(p.buffer);
    v.setUint32(4, 0x100000, true);
    v.setUint32(20, STR_LOGIN_FAILED, true);
    sock.deliver(p);
    const err = events.find((e) => e.type === 'error');
    expect(err?.characterError).toBeUndefined();
    expect(err?.serverNetError).toEqual({ stringId: STR_LOGIN_FAILED, tableId: 0 });
    expect(CharacterError.AccountDoesntExist).toBe(0x0a); // no longer what a refusal reads as
    expect(sock.closed).toBe(true);
  });
});
