/**
 * RELEASE.ac1999-login-refusal-reasons — the AC1999 server's login refusals
 * reach the player with their own reason, not "The account you specified
 * doesn't exist." for every one (live, 2026-10-12: four refused logins in a
 * row, 28 bytes from the server each, and the player gave up).
 *
 * Server side (reference/ac1999/Server/Source):
 *  - CNetwork::SendConnectLoginFailure (Network.cpp:555): an 8-byte blob
 *    {u32 error, u32 ST_SERVER_ERRORS = 8} sent by SendConnectlessBlob
 *    (Network.cpp:149: seq 0, flags BT_NETERROR 0x00100000, recid = server
 *    id, time 0, table 0, GenericCRC) — 20 + 8 = 28 bytes.
 *  - The errors (NetworkDefs.h:139-142): STR_LOGIN_FAILED (wrong password,
 *    a failed account query or auto-create: Network.cpp:1199, 1236),
 *    STR_LOGIN_SERVER_FULL (Network.cpp:692), STR_LOGIN_ACCOUNT_ONLINE
 *    (Network.cpp:661), STR_LOGIN_INVALID_AUTH (no credential,
 *    Network.cpp:1216). Each is compute_str_hash of an ID_ConnectionError_*
 *    token (table 0x23000010).
 *  - A wrong client build gets a grant carrying the server's own version
 *    (SendVersionRejectGrant, Network.cpp:576).
 *
 * The tests drive the real Connection1999 over a fake bridge socket with
 * those bytes, then the real ConnectionNotices / launcher text the page
 * shows. The end-of-retail lane is pinned in verify-gdle-login-neterror.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Connection1999, VERSION_1999 } from '../packages/network/src/era1999/Connection1999.js';
import { buildPacket1999, F1999, HEADER_SIZE_1999, readHeader1999 } from '../packages/network/src/era1999/Packet1999.js';
import type { ConnectionEvent } from '../packages/network/src/index.js';
import { serverNetErrorNotice, netErrorNotice, characterErrorNotice } from '../packages/renderer/src/ui/ConnectionNotices.js';
import {
  loginFailureText, LOGON_FAILED_HINT, perIpLimitsFrom, perIpLogonFailedText, perIpServerFullText, worldFromEntry,
} from '../packages/renderer/src/launcher/worldDirectory.js';
import { buildDirectory } from '../services/ws-tcp-bridge/src/serverDirectory.js';
import { AC1999_PUBLIC_SERVER, AC1999_LOCAL_ID } from '../services/ws-tcp-bridge/src/serverList.js';
import {
  SessionLifecycle, IN_WORLD_RETRY_BUDGET, IN_WORLD_RETRY_DELAY_MS,
} from '../packages/renderer/src/session/SessionLifecycle.js';
import { acStringHash } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { CharacterError } from '../packages/shared/src/index.js';

// reference/ac1999/Server/Source/NetworkDefs.h:100, 137-142
const BT_NETERROR = 0x00100000;
const ST_SERVER_ERRORS = 8;
const STR_LOGIN_FAILED = 0x04DF9C54;
const STR_LOGIN_SERVER_FULL = 0x00F9982C;
const STR_LOGIN_ACCOUNT_ONLINE = 0x0C559B1E;
const STR_LOGIN_INVALID_AUTH = 0x082E3779;
const SERVER_ID = 0x0b;

/** SendConnectLoginFailure → SendConnectlessBlob: seq 0, flags exactly BT_NETERROR, {error, ST_SERVER_ERRORS}. */
function refusal1999(error: number, table = ST_SERVER_ERRORS): Uint8Array {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setUint32(0, error >>> 0, true);
  new DataView(body.buffer).setUint32(4, table, true);
  return buildPacket1999({ sequence: 0, flags: BT_NETERROR, recipient: SERVER_ID, time: 0, body });
}

/** A connect grant (0x202 + body, Login1999 readGrant1999): f64 0, f64 delta, u32 slot, u32 len, version, u32 seed × 2. */
function grant1999(version: string): Uint8Array {
  const vb = new TextEncoder().encode(version);
  const body = new Uint8Array(16 + 4 + 4 + vb.length + 8);
  const v = new DataView(body.buffer);
  v.setUint32(16, 3, true);
  v.setUint32(20, vb.length, true);
  body.set(vb, 24);
  return buildPacket1999({ sequence: 0, flags: F1999.Connect | F1999.Checksum, recipient: SERVER_ID, time: 0, body });
}

/** The server's connect-progress ServerSwitch (CPacketController::SendConnectProgress): seq 0, flags 0x102, an 8-byte 0.0. */
function serverSwitch1999(): Uint8Array {
  return buildPacket1999({ sequence: 0, flags: F1999.ServerSwitch | F1999.Checksum, recipient: SERVER_ID, time: 0, body: new Uint8Array(8) });
}

/** The server→client datagrams of the real client's captured session (tests/fixtures/ac1999-session-001.jsonl.gz), in order. */
function capturedS2C(): Uint8Array[] {
  return gunzipSync(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')))
    .toString().trim().split('\n').map((l) => JSON.parse(l))
    .filter((j) => j.d === 's2c').map((j) => new Uint8Array(Buffer.from(j.b, 'base64')));
}

class FakeSocket {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  send(b: Uint8Array): void { this.sent.push(new Uint8Array(b)); }
  close(): void { this.closed = true; this.readyState = 3; this.onclose?.(); }
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
afterEach(() => { g.WebSocket = saved; vi.useRealTimers(); vi.restoreAllMocks(); });

function start(account = 'acct', password = 'pw'): { conn: Connection1999; events: ConnectionEvent[]; sock: FakeSocket } {
  const conn = new Connection1999('ws://bridge');
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  conn.connect(account, password);
  const sock = FakeSocket.sockets[0];
  sock.open();
  return { conn, events, sock };
}

const errors = (events: ConnectionEvent[]): ConnectionEvent[] => events.filter((e) => e.type === 'error');

describe('the AC1999 server refusal packet', () => {
  it('is 28 bytes: a 20-byte header with flags exactly NetError, then {error, 8}', () => {
    const p = refusal1999(STR_LOGIN_FAILED);
    expect(p.length).toBe(28);
    const h = readHeader1999(p);
    expect(h).toMatchObject({ sequence: 0, flags: F1999.NetError, size: 8, table: 0 });
    const v = new DataView(p.buffer);
    expect([v.getUint32(HEADER_SIZE_1999, true), v.getUint32(HEADER_SIZE_1999 + 4, true)]).toEqual([STR_LOGIN_FAILED, 8]);
  });

  it('each server error id is the hash of the ID_ConnectionError_* token it means', () => {
    expect(acStringHash('ID_ConnectionError_ClientLogOnFailed')).toBe(STR_LOGIN_FAILED);
    expect(acStringHash('ID_ConnectionError_ServerFull')).toBe(STR_LOGIN_SERVER_FULL);
    expect(acStringHash('ID_ConnectionError_PlayerAlreadyLoggedOn')).toBe(STR_LOGIN_ACCOUNT_ONLINE);
    expect(acStringHash('ID_ConnectionError_BadCryptoKey')).toBe(STR_LOGIN_INVALID_AUTH);
  });
});

describe('Connection1999: a refused login names the server reason', () => {
  const cases: Array<[number, string, string]> = [
    [STR_LOGIN_FAILED, 'ID_ConnectionError_ClientLogOnFailed', 'Client logon failed'],
    [STR_LOGIN_SERVER_FULL, 'ID_ConnectionError_ServerFull', 'Server Full'],
    [STR_LOGIN_ACCOUNT_ONLINE, 'ID_ConnectionError_PlayerAlreadyLoggedOn', 'Player already logged on'],
    [STR_LOGIN_INVALID_AUTH, 'ID_ConnectionError_BadCryptoKey', 'Invalid or corrupted authentication'],
  ];
  for (const [id, token, text] of cases) {
    it(`${token}: the server's id and table, not a CharacterError; the login ends`, () => {
      const { events, sock } = start();
      expect(sock.sent.length).toBe(1); // the LoginRequest
      sock.deliver(refusal1999(id));
      const errs = errors(events);
      expect(errs).toHaveLength(1);
      expect(errs[0].serverNetError).toEqual({ stringId: id, tableId: ST_SERVER_ERRORS });
      expect(errs[0].characterError).toBeUndefined();
      expect(sock.closed).toBe(true);
      // The page's notice: the dialog with that reason's text.
      const notice = serverNetErrorNotice(errs[0].serverNetError!.stringId, errs[0].serverNetError!.tableId);
      expect(notice).toMatchObject({ surface: 'dialog', token, text });
      expect(notice.text).not.toMatch(/doesn't exist/);
    });
  }

  it('no further login resends after the refusal, and its disconnect is deliberate (no ServerDied on top)', () => {
    vi.useFakeTimers();
    const { events, sock } = start();
    sock.deliver(refusal1999(STR_LOGIN_FAILED));
    const sent = sock.sent.length;
    vi.advanceTimersByTime(30_000);
    expect(sock.sent.length).toBe(sent);
    const d = events.filter((e) => e.type === 'disconnected');
    expect(d).toHaveLength(1);
    expect(d[0].deliberate).toBe(true);
    expect(errors(events)).toHaveLength(1); // no timeout on top
  });

  it('a login-failed refusal on a world with a registration line carries the registration hint; an auto-create world (auto_create_accounts=1) the taken-name hint', () => {
    const { events, sock } = start();
    sock.deliver(refusal1999(STR_LOGIN_FAILED));
    const n = serverNetErrorNotice(errors(events)[0].serverNetError!.stringId, ST_SERVER_ERRORS);
    expect(loginFailureText(n, { name: 'AC1999', registration: null, registrationUrl: null }, false)).toBe(`Client logon failed\n\n${LOGON_FAILED_HINT}`);
    expect(loginFailureText(n, { name: 'W', registration: 'Register first.', registrationUrl: null }, false))
      .toBe('Client logon failed\n\nNew account? Register first.');
  });

  it('a NetError of (0, 0) is ID_NetError_None: ignored, the login goes on', () => {
    const { events, sock } = start();
    sock.deliver(refusal1999(0, 0));
    expect(errors(events)).toHaveLength(0);
    expect(sock.closed).toBe(false);
  });
});

/**
 * The public AC1999 server caps accounts created and sessions online per IP
 * address at two each (upstream 11e7463f), and every webAC player reaches it
 * from the bridge's one address. Its STR_LOGIN_FAILED is then a refused new
 * account as often as a wrong password, and its STR_LOGIN_SERVER_FULL the
 * session cap: the launcher says so (2026-10-13: three visitors retried other
 * names after "that account name may already belong to someone else" and
 * gave up). The world comes from the bridge's real /servers row, through
 * JSON, as the page receives it.
 */
describe('a refusal on a world whose per-IP caps every webAC player shares', () => {
  const rows = buildDirectory(
    [{ ...AC1999_PUBLIC_SERVER }, { id: AC1999_LOCAL_ID, name: 'AC1999 (local)', emu: 'AC1999', host: '127.0.0.1', port: 9310, source: 'overlay' }],
    new Map(), new Map(), { now: 0 },
  );
  const fromRow = (id: string) => worldFromEntry(JSON.parse(JSON.stringify(rows.find((r) => r.id === id))))!;
  const LOGON_TEXT = "This server allows two accounts per network address, and every webAC player shares ours, so new accounts can't be created through webAC here yet. If this is an account you already have, check its password.";
  const FULL_TEXT = 'Two webAC players are already on this server; it allows two per network address, and every webAC player shares ours. Try again later.';

  const refusedWith = (id: number) => {
    FakeSocket.sockets = []; // a fresh login each time (start() drives sockets[0])
    const { events, sock } = start();
    sock.deliver(refusal1999(id));
    const e = errors(events)[0].serverNetError!;
    return serverNetErrorNotice(e.stringId, e.tableId);
  };

  it('the public world arrives with its caps and its warning', () => {
    const pub = fromRow('ac1999');
    expect(pub.perIpLimits).toEqual({ accounts: 2, sessions: 2 });
    expect(pub.compatWarning).toBe("Existing accounts only: webAC can't create new ones here yet.");
    expect(fromRow(AC1999_LOCAL_ID).perIpLimits).toBeNull();
  });

  it('ClientLogOnFailed: no new accounts through webAC here (or a wrong password), not "that name may belong to someone else"', () => {
    const text = loginFailureText(refusedWith(STR_LOGIN_FAILED), fromRow('ac1999'), false);
    expect(text).toBe(`Client logon failed\n\n${LOGON_TEXT}`);
    expect(text).not.toContain(LOGON_FAILED_HINT);
    expect(text).not.toMatch(/different account name/);
    // The local server (no caps) keeps the taken-name hint.
    expect(loginFailureText(refusedWith(STR_LOGIN_FAILED), fromRow(AC1999_LOCAL_ID), false)).toBe(`Client logon failed\n\n${LOGON_FAILED_HINT}`);
  });

  it('ServerFull: two webAC players are already on; the local server keeps the bare "Server Full"', () => {
    expect(loginFailureText(refusedWith(STR_LOGIN_SERVER_FULL), fromRow('ac1999'), false)).toBe(`Server Full\n\n${FULL_TEXT}`);
    expect(loginFailureText(refusedWith(STR_LOGIN_SERVER_FULL), fromRow(AC1999_LOCAL_ID), false)).toBe('Server Full');
  });

  it('the other refusals, and anything once in the world, are unchanged there', () => {
    const pub = fromRow('ac1999');
    expect(loginFailureText(refusedWith(STR_LOGIN_ACCOUNT_ONLINE), pub, false)).toBe('Player already logged on');
    expect(loginFailureText(refusedWith(STR_LOGIN_INVALID_AUTH), pub, false)).toBe('Invalid or corrupted authentication');
    expect(loginFailureText(refusedWith(STR_LOGIN_FAILED), pub, true)).toBe('Client logon failed');
    expect(loginFailureText(refusedWith(STR_LOGIN_SERVER_FULL), pub, true)).toBe('Server Full');
    expect(loginFailureText(netErrorNotice('ID_ConnectionError_ClientTimedOutServer'), pub, false)).toBe('Client timed out the connection');
  });

  it('the caps drive the wording (another server adopting the rule is flagged in the bridge only); a 0 cap is unlimited', () => {
    expect(perIpLogonFailedText({ accounts: 1, sessions: 3 })).toMatch(/^This server allows one account per network address,/);
    expect(perIpServerFullText({ accounts: 1, sessions: 3 })).toMatch(/^Three webAC players are already on this server; it allows three per network address/);
    expect(perIpServerFullText({ accounts: 0, sessions: 1 })).toMatch(/^One webAC player is already on this server; it allows one per/);
    expect(perIpServerFullText({ accounts: 0, sessions: 12 })).toMatch(/^12 webAC players are .* allows 12 per/);
    const sessionsOnly = { name: 'S', registration: null, registrationUrl: null, perIpLimits: { accounts: 0, sessions: 2 } };
    expect(loginFailureText(refusedWith(STR_LOGIN_FAILED), sessionsOnly, false)).toBe(`Client logon failed\n\n${LOGON_FAILED_HINT}`);
    expect(loginFailureText(refusedWith(STR_LOGIN_SERVER_FULL), sessionsOnly, false)).toBe(`Server Full\n\n${FULL_TEXT}`);
  });

  it('perIpLimitsFrom keeps only whole, non-negative caps', () => {
    expect(perIpLimitsFrom({ accounts: 2, sessions: 2 })).toEqual({ accounts: 2, sessions: 2 });
    for (const bad of [null, undefined, 'x', {}, { accounts: 2 }, { accounts: -1, sessions: 2 }, { accounts: 1.5, sessions: 2 }, { accounts: '2', sessions: 2 }, { accounts: 0, sessions: 0 }]) {
      expect(perIpLimitsFrom(bad)).toBeNull();
    }
  });
});

describe('Connection1999: the other login outcomes', () => {
  it('a server that never answers: six LoginRequests, then ClientTimedOutServer (it used to sit silent)', () => {
    vi.useFakeTimers();
    const { events, sock } = start();
    vi.advanceTimersByTime(60_000);
    const logins = sock.sent.filter((p) => readHeader1999(p).sequence === 1);
    expect(logins).toHaveLength(6);
    const errs = errors(events);
    expect(errs).toHaveLength(1);
    expect(errs[0].netErrorId).toBe('ID_ConnectionError_ClientTimedOutServer');
    expect(netErrorNotice(errs[0].netErrorId!).text).toBe('Client timed out the connection');
    expect(sock.closed).toBe(true);
  });

  it('a grant answered in time stops the resends and raises no timeout', () => {
    vi.useFakeTimers();
    const { events, sock } = start();
    sock.deliver(grant1999(VERSION_1999));
    expect(events.some((e) => e.type === 'handshakeComplete')).toBe(true);
    sock.deliver(serverSwitch1999()); // the session goes on (the post-grant wait is pinned below)
    vi.advanceTimersByTime(20_000);
    expect(sock.sent.filter((p) => readHeader1999(p).sequence === 1)).toHaveLength(1);
    expect(errors(events)).toHaveLength(0);
  });

  it("the server's version-reject grant (another build's version) is NetVersionMismatch (it used to show nothing)", () => {
    const { events, sock } = start();
    sock.deliver(grant1999('4.0063'));
    const errs = errors(events);
    expect(errs).toHaveLength(1);
    expect(errs[0].netErrorId).toBe('ID_ConnectionError_NetVersionMismatch');
    expect(netErrorNotice(errs[0].netErrorId!).text).toBe('You do not have the current version of the client installed.');
    expect(events.some((e) => e.type === 'handshakeComplete')).toBe(false);
    expect(sock.closed).toBe(true);
  });

  it('credentials past the 20-byte field are sent truncated, as the retail client did (player report 2026-10-12)', () => {
    const { events, sock } = start('tencharact', 'tencharpwd');
    expect(errors(events)).toHaveLength(0);
    expect(sock.sent).toHaveLength(1);
    // The credential field: header 20 + magic 4 + version (u16 len + "4.35752\0", padded to 12) + marker 4.
    const field = String.fromCharCode(...sock.sent[0].subarray(HEADER_SIZE_1999 + 20, HEADER_SIZE_1999 + 40));
    expect(field).toBe('tencharact:tencharpw');
    sock.deliver(grant1999(VERSION_1999));
    expect(events.some((e) => e.type === 'handshakeComplete')).toBe(true);
  });

  it('a NetError after the grant ends the session as a server drop (no login-refusal notice)', () => {
    const { events, sock } = start();
    sock.deliver(grant1999(VERSION_1999));
    sock.deliver(refusal1999(STR_LOGIN_FAILED));
    expect(errors(events).some((e) => e.serverNetError)).toBe(false);
    const d = events.filter((e) => e.type === 'disconnected');
    expect(d).toHaveLength(1);
    expect(d[0].deliberate).toBe(false);
  });
});

// BUG.ac1999-post-grant-silence. Live 2026-10-13 (playwebac.com, the public AC1999 server): a returning
// player's three logins each got the 59-byte grant and nothing more; the page sat on the connecting screen
// until the 60 s server timeout, then the player gave up after 6 s. Reproduced on the local server with
// accounts.banned = 1: CNetwork::AcceptClientLogin sends the grant, then its ban check's KickBannedClient
// kills the session before the 0xF7C1 can flush (reference/ac1999 Network.cpp:768-782), and our ack is
// discarded ("[NET-DROP] ... no matching session"). Upstream's deploy/disable-extra-ip-accounts.sql
// (2026-10-12) bans every account past the first two created from one IP, and every account made through
// the bridge has the bridge's IP.
describe('Connection1999: a grant followed by silence ends in a clear notice, not a 60 s hang', () => {
  const isAck = (p: Uint8Array): boolean => { const h = readHeader1999(p); return h.sequence === 0 && h.flags === (F1999.Connect | F1999.Checksum) && p.length === HEADER_SIZE_1999; };

  it("the captured grant (59 bytes, flags 0x202), then nothing: the ack is resent every 2 s, then at 8 s ServerClosedConnection", () => {
    vi.useFakeTimers();
    const grant = capturedS2C()[0];
    expect(grant.length).toBe(59); // the prod session's one datagram, and the local server's 'TX connect-grant ... len= 59'
    expect(readHeader1999(grant).flags).toBe(F1999.Connect | F1999.Checksum);
    const { events, sock } = start();
    sock.deliver(grant);
    expect(events.some((e) => e.type === 'handshakeComplete')).toBe(true);
    expect(sock.sent.filter(isAck)).toHaveLength(1);
    vi.advanceTimersByTime(7_900);
    expect(sock.sent.filter(isAck)).toHaveLength(4); // 0, 2, 4, 6 s
    expect(errors(events)).toHaveLength(0);
    vi.advanceTimersByTime(200);
    const errs = errors(events);
    expect(errs).toHaveLength(1);
    expect(errs[0].netErrorId).toBe('ID_ConnectionError_ServerClosedConnection');
    expect(netErrorNotice(errs[0].netErrorId!)).toMatchObject({ surface: 'dialog', text: 'Server has closed this connection' });
    // The session ends deliberately (no Disconnected screen on top), telling the server to free the slot.
    expect(sock.closed).toBe(true);
    expect(readHeader1999(sock.sent.at(-1)!).flags & F1999.Disconnect).toBeTruthy();
    const d = events.filter((e) => e.type === 'disconnected');
    expect(d).toHaveLength(1);
    expect(d[0].deliberate).toBe(true);
    // Nothing more: no server timeout later.
    vi.advanceTimersByTime(120_000);
    expect(errors(events)).toHaveLength(1);
    expect(events.some((e) => e.type === 'serverTimeout')).toBe(false);
  });

  it('a lost ack recovers: the server answers a resent ack, the resends stop and no notice is raised', () => {
    vi.useFakeTimers();
    const { events, sock } = start();
    sock.deliver(grant1999(VERSION_1999));
    vi.advanceTimersByTime(3_000);
    expect(sock.sent.filter(isAck)).toHaveLength(2);
    sock.deliver(serverSwitch1999());
    const acks = sock.sent.filter(isAck).length;
    vi.advanceTimersByTime(30_000);
    expect(sock.sent.filter(isAck)).toHaveLength(acks);
    expect(errors(events)).toHaveLength(0);
  });

  it("the server's keepalive (a bare 0x202) counts as the session answering", () => {
    vi.useFakeTimers();
    const { events, sock } = start();
    sock.deliver(grant1999(VERSION_1999));
    sock.deliver(buildPacket1999({ sequence: 0, flags: F1999.Connect | F1999.Checksum, recipient: SERVER_ID, time: 0 }));
    vi.advanceTimersByTime(30_000);
    expect(errors(events)).toHaveLength(0);
  });

  it('a repeated grant does not count as the session answering', () => {
    vi.useFakeTimers();
    const { events, sock } = start();
    sock.deliver(grant1999(VERSION_1999));
    vi.advanceTimersByTime(1_000);
    sock.deliver(grant1999(VERSION_1999));
    vi.advanceTimersByTime(7_100);
    expect(errors(events).map((e) => e.netErrorId)).toEqual(['ID_ConnectionError_ServerClosedConnection']);
  });

  it('the captured session after the grant (sequenced data, then the ServerSwitch) raises nothing', () => {
    vi.useFakeTimers();
    const { events, sock } = start();
    const s2c = capturedS2C();
    for (const b of s2c.slice(0, 6)) sock.deliver(b);
    vi.advanceTimersByTime(30_000);
    expect(errors(events)).toHaveLength(0);
    expect(sock.sent.filter(isAck)).toHaveLength(1);
  });
});

describe('"character still in the world" retries are bounded (AC1999 LoginError(13) also means never)', () => {
  it(`retries ${IN_WORLD_RETRY_BUDGET} times ${IN_WORLD_RETRY_DELAY_MS} ms apart, then the retail dialog; the player's next try starts a fresh budget`, () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(0x50000001);
    for (let i = 0; i < IN_WORLD_RETRY_BUDGET; i++) {
      expect(s.characterInWorldRefusal()).toBe('retry');
      expect(s.mayRetryEnterWorld()).toBe(true);
    }
    expect(s.characterInWorldRefusal()).toBe('dialog');
    expect(characterErrorNotice(CharacterError.EnterGameCharacterInWorld).surface).toBe('dialog');
    // The enter is over: no pending retry fires, and the player may press Enter again.
    expect(s.mayRetryEnterWorld()).toBe(false);
    expect(s.mayRequestEnterWorld()).toBe(true);
    s.noteEnterWorldRequested(0x50000001);
    expect(s.characterInWorldRefusal()).toBe('retry');
    // The budget outlasts the longest the AC1999 server holds a character after its
    // session ends: BeginLogout 5 s, +2 s from portal space, +15 s for a PK (Player.cpp:172-188).
    expect(IN_WORLD_RETRY_BUDGET * IN_WORLD_RETRY_DELAY_MS).toBeGreaterThan(5_000 + 2_000 + 15_000);
  });

  it('a fresh enter-world request resets the budget', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(1);
    for (let i = 0; i < IN_WORLD_RETRY_BUDGET; i++) s.characterInWorldRefusal();
    s.noteEnterWorldRequested(2);
    for (let i = 0; i < IN_WORLD_RETRY_BUDGET; i++) expect(s.characterInWorldRefusal()).toBe('retry');
  });
});

// BUG.ac1999-in-world-enter-retry. Measured on the local AC1999 server 2026-10-13
// (account agentl99): the enter at 00:19:16.485 went in, a second 0xF657 at 17.470
// (the post-create CharacterList's auto-enter) got LoginError(13) "character already
// logged in", and the page re-sent 0xF657 every 3 s from inside the world until the
// budget ran out at 75 s and retail's "still in the world" dialog covered the world.
describe('a "still in the world" refusal that answers a duplicate enter is ignored', () => {
  it('from the world: no retry, no dialog, however many arrive', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(0x50000023);
    s.noteWorldEntered();
    for (let i = 0; i < IN_WORLD_RETRY_BUDGET + 5; i++) expect(s.characterInWorldRefusal()).toBe('ignore');
    expect(s.inWorld).toBe(true);
  });

  it('a retry scheduled before the world arrived does not go out after it', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(0x50000023);
    expect(s.characterInWorldRefusal()).toBe('retry'); // the stale session, a 3 s wait
    s.noteWorldEntered(); // another chain's enter got in meanwhile
    expect(s.mayRetryEnterWorld()).toBe(false);
  });

  it('a second enter is refused while one is under way and from the world', () => {
    const s = new SessionLifecycle();
    expect(s.mayRequestEnterWorld()).toBe(true);
    s.noteEnterWorldRequested(0x50000023);
    expect(s.mayRequestEnterWorld()).toBe(false); // the post-create CharacterList's auto-enter
    s.noteWorldEntered();
    expect(s.mayRequestEnterWorld()).toBe(false);
    s.noteLoggedOut();
    expect(s.mayRequestEnterWorld()).toBe(true); // character select again: Enter works
  });

  it('a drop or a refusal ends the enter, so a resume or the next click can enter', () => {
    const s = new SessionLifecycle();
    s.noteEnterWorldRequested(7);
    s.noteDisconnected();
    expect(s.mayRequestEnterWorld()).toBe(true);
    s.noteEnterWorldRequested(7);
    s.noteEnterRefused();
    expect(s.mayRequestEnterWorld()).toBe(true);
    // A refusal with no enter under way (a late answer to an abandoned request) is ignored.
    expect(s.characterInWorldRefusal()).toBe('ignore');
  });
});

// The real session (tests/fixtures/ac1999-session-001.jsonl.gz) still logs in through the new paths.
describe('the captured 1999 session still logs in', () => {
  it('reaches the character list with no error', () => {
    const s2c = capturedS2C();
    const conn = new Connection1999('ws://bridge');
    conn.datIterations = { portal: 102, cell: 67, language: 0 };
    const events: ConnectionEvent[] = [];
    conn.on((e) => events.push(e));
    conn.connect('acjsdbja', 'acjsdbja');
    const sock = FakeSocket.sockets[0];
    sock.open();
    for (const b of s2c) {
      sock.deliver(b);
      if (events.some((e) => e.type === 'characterList')) break;
    }
    expect(events.some((e) => e.type === 'characterList')).toBe(true);
    expect(errors(events)).toHaveLength(0);
    conn.disconnect();
  });
});
