/**
 * RELEASE.preworld-outcomes — the page reports how a pre-world flow ended
 * (telemetry/PreworldReporter.ts → POST /client-preworld on the bridge).
 *
 * Drives the real reporter with the real connection classes of all three
 * eras producing the outcome: ACE's CharacterError (ClientConnection), GDLE's
 * NetError login refusal (ClientConnection, the server's bytes), the AC1999
 * server's NetError refusal, version-reject grant and CharacterError
 * (Connection1999), a socket that never opened, and chargen replies through
 * each connection. The reporter is fed the same calls main.ts makes at those
 * points. Every payload must hold exactly the schema's fields, and nothing a
 * player typed (account, password, character name) may appear in any of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientConnection, PACKET_HEADER_SIZE, BinaryWriter, deserializeMessage, type ConnectionEvent } from '../packages/network/src/index.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { Connection1999, VERSION_1999 } from '../packages/network/src/era1999/Connection1999.js';
import { buildPacket1999, F1999 } from '../packages/network/src/era1999/Packet1999.js';
import { characterErrorNotice, netErrorNotice, serverNetErrorNotice } from '../packages/renderer/src/ui/ConnectionNotices.js';
import {
  PreworldReporter, MAX_PREWORLD_EVENTS, reportConnectAttempts, chargenStepName, serverIdFromUrl, bootReasonToken, preworldScreenFor, RELOAD_REASONS,
  type PreworldEvent, type PreworldScreenState, type PreworldScreen, type ChargenStepName,
} from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { CreateStep } from '../packages/renderer/src/ui/CharacterCreate.js';
import { CharacterError, CharacterGenerationVerificationResponse, characterCreateErrorToken } from '../packages/shared/src/index.js';

const ACCOUNT = 'secretacct77';
const PASSWORD = 'hunter2pw';
const CHAR_NAME = 'Secretname Of Dereth';

const SCHEMA_KEYS = [
  'build', 'code', 'count', 'era', 'outcome', 'pageMs', 'screen', 'screenMs', 'server', 'sinceEnterMs', 'sinceLoginMs',
  'step', 'table', 'token', 'trace',
  // RELEASE.preworld-boot-stage (null off the boot screen; verify-preworld-boot-stage.ts)
  'stage', 'progress', 'doneKB', 'totalKB', 'cache', 'caps',
].sort();

// NetworkDefs.h (GDLE and the AC1999 server share them)
const BT_NETERROR = 0x00100000;
const ST_SERVER_ERRORS = 8;
const STR_LOGIN_FAILED = 0x04DF9C54;
const STR_LOGIN_SERVER_FULL = 0x00F9982C;
const SERVER_ID = 0x0b;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
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

/** crc.cpp GetMagicNumber (GDLE's GenericCRC). */
function magic(b: Uint8Array, size: number): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let cs = (size << 16) >>> 0;
  let i = 0;
  for (; i < size >> 2; i++) cs = (cs + v.getUint32(i * 4, true)) >>> 0;
  let shift = 3;
  for (i <<= 2; i < size; i++) { cs = (cs + (b[i] << (shift * 8))) >>> 0; shift--; }
  return cs;
}

/** GDLE CNetwork::SendConnectLoginFailure + SendConnectlessBlob, byte for byte (verify-gdle-login-neterror.ts). */
function gdleLoginFailure(error: number): Uint8Array {
  const p = new Uint8Array(PACKET_HEADER_SIZE + 8);
  const v = new DataView(p.buffer);
  v.setUint32(4, BT_NETERROR, true);
  v.setUint16(12, SERVER_ID, true);
  v.setUint16(16, 8, true);
  v.setUint16(18, 0x01, true);
  v.setUint32(20, error >>> 0, true);
  v.setUint32(24, ST_SERVER_ERRORS, true);
  v.setUint32(8, 0xBADD70DD, true);
  v.setUint32(8, (magic(p.subarray(0, 20), 20) + magic(p.subarray(20), 8)) >>> 0, true);
  return p;
}

/** The AC1999 server's SendConnectLoginFailure (verify-ac1999-login-refusal.ts). */
function refusal1999(error: number): Uint8Array {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setUint32(0, error >>> 0, true);
  new DataView(body.buffer).setUint32(4, ST_SERVER_ERRORS, true);
  return buildPacket1999({ sequence: 0, flags: BT_NETERROR, recipient: SERVER_ID, time: 0, body });
}

function grant1999(version: string): Uint8Array {
  const vb = new TextEncoder().encode(version);
  const body = new Uint8Array(16 + 4 + 4 + vb.length + 8);
  const v = new DataView(body.buffer);
  v.setUint32(16, 3, true);
  v.setUint32(20, vb.length, true);
  body.set(vb, 24);
  return buildPacket1999({ sequence: 0, flags: F1999.Connect | F1999.Checksum, recipient: SERVER_ID, time: 0, body });
}

/** A direct game message: u32 opcode, then the payload. */
function message(opcode: number, ...words: number[]): Uint8Array {
  const b = new Uint8Array(4 + words.length * 4);
  const v = new DataView(b.buffer);
  v.setUint32(0, opcode, true);
  words.forEach((w, i) => v.setUint32(4 + i * 4, w >>> 0, true));
  return b;
}

/** CharacterCreateResponse Ok: code 1, guid, String16L name (padded to 4). */
function createOk(guid: number, name: string): Uint8Array {
  const nb = new TextEncoder().encode(name);
  const strLen = 2 + nb.length;
  const padded = strLen + ((4 - (strLen % 4)) % 4);
  const b = new Uint8Array(12 + padded);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0xF643, true);
  v.setUint32(4, 1, true);
  v.setUint32(8, guid, true);
  v.setUint16(12, nb.length, true);
  b.set(nb, 14);
  return b;
}

interface Harness {
  r: PreworldReporter;
  sent: Array<{ url: string; body: PreworldEvent; raw: string }>;
  clock: { t: number };
  state: { screen: PreworldScreen; step: ChargenStepName | null; era: string; server: string | null };
}

function harness(endpoint: string | null = 'https://bridge.example/client-preworld'): Harness {
  const sent: Harness['sent'] = [];
  const clock = { t: 1000 };
  const state: Harness['state'] = { screen: 'connecting', step: null, era: 'eor', server: 'coldeve' };
  const r = new PreworldReporter({
    endpoint, build: 'abc1234', era: () => state.era, server: () => state.server,
    screen: () => state.screen, chargenStep: () => state.step, now: () => clock.t, trace: 'feedc0de12345678',
    send: (url, raw) => sent.push({ url, body: JSON.parse(raw) as PreworldEvent, raw }),
  });
  return { r, sent, clock, state };
}

/** What main.ts does with a connection's events (onSessionEvent), minus the UI. */
function wireLikeMain(conn: { on(cb: (e: ConnectionEvent) => void): void }, r: PreworldReporter): void {
  conn.on((e) => {
    if (e.type === 'connected') r.loginStarted();
    if (e.type === 'characterCreateResponse') r.chargenResult((e.data as { responseCode: number }).responseCode);
    if (e.type === 'error') {
      if (e.characterError !== undefined) {
        if (e.characterError === CharacterError.Logon && e.loginRetryScheduled) return;
        r.connectionError(e, characterErrorNotice(e.characterError).token || null);
      } else if (e.netErrorId || e.serverNetError) {
        const n = e.serverNetError ? serverNetErrorNotice(e.serverNetError.stringId, e.serverNetError.tableId) : netErrorNotice(e.netErrorId!);
        r.connectionError(e, n.token || null);
      }
    }
  });
}

function expectClean(h: Harness): void {
  for (const s of h.sent) {
    expect(Object.keys(s.body).sort()).toEqual(SCHEMA_KEYS);
    expect(s.raw).not.toContain(ACCOUNT);
    expect(s.raw).not.toContain(PASSWORD);
    expect(s.raw).not.toContain('Secretname');
    expect(s.body.trace).toBe('feedc0de12345678');
    expect(s.body.build).toBe('abc1234');
  }
}

const g = globalThis as { WebSocket?: unknown };
let savedWs: unknown;
beforeEach(() => {
  savedWs = g.WebSocket; g.WebSocket = FakeSocket; FakeSocket.sockets = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { g.WebSocket = savedWs; vi.useRealTimers(); vi.restoreAllMocks(); });

describe('end of retail (ACE) — ClientConnection', () => {
  function startAce(h: Harness): { conn: ClientConnection; sock: FakeSocket } {
    const conn = new ClientConnection(h.r.tagUrl('wss://bridge.example/connect?server=coldeve'));
    conn.autoReconnect = false;
    wireLikeMain(conn, h.r);
    conn.connect(ACCOUNT, PASSWORD);
    const sock = FakeSocket.sockets[0];
    h.clock.t += 120;
    sock.open();
    return { conn, sock };
  }

  it('the socket URL carries the trace id beside the server id', () => {
    const h = harness();
    const { sock } = startAce(h);
    const u = new URL(sock.url);
    expect(u.searchParams.get('server')).toBe('coldeve');
    expect(u.searchParams.get('trace')).toBe('feedc0de12345678');
    expect(serverIdFromUrl(sock.url)).toBe('coldeve');
    expect(serverIdFromUrl('ws://localhost:9090')).toBeNull();
  });

  it('a CharacterError before the character list is a login refusal with the code and the retail notice token', () => {
    const h = harness();
    const { conn } = startAce(h);
    h.clock.t += 1800;
    (conn as unknown as { processMessage(d: Uint8Array): void }).processMessage(message(0xF659, CharacterError.AccountDoesntExist));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].url).toBe('https://bridge.example/client-preworld');
    expect(h.sent[0].body).toMatchObject({
      outcome: 'login_refused', era: 'eor', server: 'coldeve', screen: 'connecting',
      code: CharacterError.AccountDoesntExist, token: characterErrorNotice(CharacterError.AccountDoesntExist).token, sinceLoginMs: 1800,
    });
    expectClean(h);
  });

  it('the list, a refused name, a created character, a refused enter, then the world', () => {
    const h = harness();
    const { conn } = startAce(h);
    const feed = (d: Uint8Array) => (conn as unknown as { processMessage(d: Uint8Array): void }).processMessage(d);
    const anyConn = conn as unknown as { awaitingCharacterCreateResponse: boolean };
    h.clock.t += 900;
    h.r.characterList(2);
    h.state.screen = 'chargen'; h.state.step = 'summary';
    anyConn.awaitingCharacterCreateResponse = true;
    feed(message(0xF643, CharacterGenerationVerificationResponse.NameInUse));
    anyConn.awaitingCharacterCreateResponse = true;
    feed(createOk(0x50000001, CHAR_NAME));
    h.r.enterRequested();
    h.state.screen = 'char-select'; h.state.step = null;
    h.clock.t += 400;
    feed(message(0xF659, CharacterError.EnterGameCharacterNotOwned));
    // A refusal at char select with no enter pending (e.g. a delete): its own outcome.
    feed(message(0xF659, CharacterError.Delete));
    h.r.enterRequested();
    h.clock.t += 2500;
    h.r.enteredWorld();
    expect(h.sent.map(s => [s.body.outcome, s.body.code, s.body.token])).toEqual([
      ['char_list', null, null],
      // The string-table token retail shows for it (ID_Character_Err_NameReserved).
      ['chargen_refused', CharacterGenerationVerificationResponse.NameInUse, characterCreateErrorToken(CharacterGenerationVerificationResponse.NameInUse)],
      ['chargen_ok', CharacterGenerationVerificationResponse.Ok, null],
      ['enter_refused', CharacterError.EnterGameCharacterNotOwned, characterErrorNotice(CharacterError.EnterGameCharacterNotOwned).token],
      ['char_error', CharacterError.Delete, characterErrorNotice(CharacterError.Delete).token || 'Delete'],
      ['enter_ok', null, null],
    ]);
    expect(h.sent[0].body.count).toBe(2);
    expect(h.sent[1].body).toMatchObject({ screen: 'chargen', step: 'summary' });
    expect(h.sent.at(-1)!.body).toMatchObject({ sinceEnterMs: 2500, sinceLoginMs: 900 + 400 + 2500 });
    expectClean(h);
  });

  it('a Logon refusal with a fresh login scheduled is not an outcome (main.ts waits it out)', () => {
    vi.useFakeTimers();
    const h = harness();
    const { conn } = startAce(h);
    (conn as unknown as { processMessage(d: Uint8Array): void }).processMessage(message(0xF659, CharacterError.Logon));
    expect(h.sent).toHaveLength(0);
  });

  it('a bridge that never opens is a connection failure (ID_NetError_CantSocket)', () => {
    const h = harness();
    const conn = new ClientConnection('ws://nowhere');
    wireLikeMain(conn, h.r);
    conn.connect(ACCOUNT, PASSWORD);
    FakeSocket.sockets[0].onerror?.();
    expect(h.sent.map(s => [s.body.outcome, s.body.token, s.body.sinceLoginMs])).toEqual([['connect_failed', 'ID_NetError_CantSocket', null]]);
    expectClean(h);
  });
});

describe('AccountBoot / AccountBanned — the real bytes through ServerMessageHandler', () => {
  /** ACE GameMessageBootAccount: u32 0xF7DC, then String16L reason when there is one. GDLE KickClient: u32 0 after the opcode. */
  function boot(reason: string | null): Uint8Array {
    const w = new BinaryWriter(128);
    w.writeUInt32(0xF7DC);
    if (reason !== null) w.writeString16(reason);
    return w.toBuffer();
  }
  /** ACE / ClassicACE GameMessageAccountBanned; GDLE KickBannedClient has the same shape. */
  function banned(seconds: number, reason: string): Uint8Array {
    const w = new BinaryWriter(256);
    w.writeUInt32(0xF7C1);
    w.writeUInt32(seconds);
    w.writeString16(reason);
    return w.toBuffer();
  }
  /** main.ts's onAccountBoot / onAccountBanned hooks (before the world). */
  function wired(h: Harness): ServerMessageHandler {
    const smh = new ServerMessageHandler();
    smh.setHandlers({
      onAccountBoot: (d) => h.r.accountBoot(d.reason),
      onAccountBanned: (d) => h.r.accountBanned(d.secondsUntilExpiry),
    });
    return smh;
  }

  const PASSWORD_BOOT = ' because the password entered for this account was not correct';

  it("ACE's wrong-password boot is a login refusal coded boot_password_mismatch; the text never leaves", () => {
    const h = harness();
    h.r.loginStarted();
    h.clock.t += 3200;
    wired(h).handleMessage(deserializeMessage(boot(PASSWORD_BOOT)));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].body).toMatchObject({ outcome: 'login_refused', token: 'boot_password_mismatch', code: null, sinceLoginMs: 3200 });
    expect(h.sent[0].raw).not.toMatch(/because|entered for this account| /);
    expectClean(h);
  });

  it('every known server reason has its own token; free text (an admin reason) is never sent', () => {
    const cases: Array<[string | null, string]> = [
      [null, 'boot_no_reason'], // ACE sentinel boot with no reason
      [PASSWORD_BOOT, 'boot_password_mismatch'],
      [' because your client is not the correct version for this server. Please visit http://play.emu.ac/ to update to latest client', 'boot_client_version'],
      [' because you are not running the correct executable file version for this server', 'boot_client_version'],
      [' because Your DAT files are newer than expected.\nPlease visit https://emulator.ac/how-to-play to download the correct DAT files', 'boot_dat_newer'],
      [' because Your DAT files are incomplete.\nThis server does not support dynamic DAT updating at this time', 'boot_dat_incomplete'],
      [' because the world is now closed', 'boot_world_closed'],
      [' because the character was forced to log off by system', 'boot_forced_logoff_system'],
      [' because the character was forced to log off by an admin', 'boot_forced_logoff_admin'],
      [' Connections from VPN / proxy disallowed by server policy', 'boot_vpn_blocked'],
      [` - ${ACCOUNT} was rude to Secretname`, 'boot_admin'],
      [`something ${PASSWORD} else`, 'boot_other'],
    ];
    for (const [reason, token] of cases) {
      const h = harness();
      wired(h).handleMessage(deserializeMessage(boot(reason)));
      expect(h.sent.map(s => [s.body.outcome, s.body.token]), String(reason)).toEqual([['login_refused', token]]);
      expectClean(h);
      expect(bootReasonToken(reason)).toBe(token);
    }
    // GDLE / AC1999 KickClient: the opcode then a u32 0 (an empty String16L).
    const gdle = new Uint8Array(8);
    new DataView(gdle.buffer).setUint32(0, 0xF7DC, true);
    const h = harness();
    wired(h).handleMessage(deserializeMessage(gdle));
    expect(h.sent[0].body.token).toBe('boot_no_reason');
  });

  it('a boot after the list / after the enter request is classified by phase', () => {
    const h = harness();
    const smh = wired(h);
    h.r.characterList(1);
    smh.handleMessage(deserializeMessage(boot(' because the world is now closed')));
    h.r.enterRequested();
    smh.handleMessage(deserializeMessage(boot(' because the character was forced to log off by system')));
    expect(h.sent.slice(1).map(s => [s.body.outcome, s.body.token])).toEqual([
      ['char_error', 'boot_world_closed'], ['enter_refused', 'boot_forced_logoff_system'],
    ]);
  });

  it('AccountBanned is a login refusal coded boot_banned with the seconds left; its reason (ACE " - <why>", GDLE ban string) is not sent', () => {
    const h = harness();
    wired(h).handleMessage(deserializeMessage(banned(86_400, ` - ${ACCOUNT} cheating, ask Secretname`)));
    expect(h.sent[0].body).toMatchObject({ outcome: 'login_refused', token: 'boot_banned', code: 86_400 });
    expect(h.sent[0].raw).not.toMatch(/cheating/);
    expectClean(h);
  });
});

describe('Dark Majesty / GDLE — the NetError login refusal', () => {
  it("the server's string id and table, with the notice token", () => {
    const h = harness();
    h.state.era = 'dark-majesty'; h.state.server = 'gdle-reefcull';
    const conn = new ClientConnection('ws://bridge');
    conn.autoReconnect = false;
    wireLikeMain(conn, h.r);
    conn.connect(ACCOUNT, PASSWORD);
    const sock = FakeSocket.sockets[0];
    sock.readyState = 1;
    sock.onopen?.();
    sock.deliver(gdleLoginFailure(STR_LOGIN_FAILED));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].body).toMatchObject({
      outcome: 'login_refused', era: 'dark-majesty', server: 'gdle-reefcull', code: STR_LOGIN_FAILED, table: ST_SERVER_ERRORS,
      token: 'ID_ConnectionError_ClientLogOnFailed',
    });
    expectClean(h);
  });
});

describe('AC1999 — Connection1999', () => {
  function start1999(h: Harness): { conn: Connection1999; sock: FakeSocket } {
    h.state.era = 'ac1999'; h.state.server = 'ac1999';
    const conn = new Connection1999(h.r.tagUrl('wss://bridge.example/connect?server=ac1999'));
    wireLikeMain(conn, h.r);
    conn.connect(ACCOUNT, PASSWORD);
    const sock = FakeSocket.sockets[0];
    sock.open();
    return { conn, sock };
  }

  it("the server's refusal (server full) is a login refusal with its id", () => {
    const h = harness();
    const { sock } = start1999(h);
    expect(new URL(sock.url).searchParams.get('trace')).toBe('feedc0de12345678');
    sock.deliver(refusal1999(STR_LOGIN_SERVER_FULL));
    expect(h.sent.map(s => [s.body.outcome, s.body.era, s.body.code, s.body.table, s.body.token])).toEqual([
      ['login_refused', 'ac1999', STR_LOGIN_SERVER_FULL, ST_SERVER_ERRORS, 'ID_ConnectionError_ServerFull'],
    ]);
    expectClean(h);
  });

  it('a version-reject grant is a login refusal (bad version); a silent server is a login timeout', () => {
    const h = harness();
    const { sock } = start1999(h);
    sock.deliver(grant1999('4.0063'));
    expect(h.sent.at(-1)!.body).toMatchObject({ outcome: 'login_refused', token: 'ID_ConnectionError_NetVersionMismatch' });
    vi.useFakeTimers();
    FakeSocket.sockets = [];
    const h2 = harness();
    start1999(h2);
    vi.advanceTimersByTime(60_000);
    expect(h2.sent.map(s => [s.body.outcome, s.body.token])).toEqual([['connect_failed', 'ID_ConnectionError_ClientTimedOutServer']]);
    expectClean(h); expectClean(h2);
  });

  it('a CharacterError after the enter request is an enter refusal; chargen replies come through too', () => {
    const h = harness();
    const { conn, sock } = start1999(h);
    sock.deliver(grant1999(VERSION_1999));
    const anyConn = conn as unknown as { dispatchEoL(d: Uint8Array): void; awaitingCreate: boolean };
    h.r.characterList(0);
    anyConn.awaitingCreate = true;
    anyConn.dispatchEoL(message(0xF643, CharacterGenerationVerificationResponse.NameBanned));
    anyConn.awaitingCreate = true;
    anyConn.dispatchEoL(createOk(0x50000002, CHAR_NAME));
    h.r.enterRequested();
    anyConn.dispatchEoL(message(0xF659, CharacterError.EnterGameCharacterInWorld));
    expect(h.sent.map(s => [s.body.outcome, s.body.code])).toEqual([
      ['char_list', null],
      ['chargen_refused', CharacterGenerationVerificationResponse.NameBanned],
      ['chargen_ok', CharacterGenerationVerificationResponse.Ok],
      ['enter_refused', CharacterError.EnterGameCharacterInWorld],
    ]);
    expect(h.sent[0].body.count).toBe(0);
    expectClean(h);
  });
});

describe('leaving a pre-world screen', () => {
  function fakeWindow() {
    const winL = new Map<string, () => void>();
    const docL = new Map<string, () => void>();
    const ticks: Array<() => void> = [];
    const win = { addEventListener: (t: string, l: () => void) => { winL.set(t, l); }, setInterval: (f: () => void) => { ticks.push(f); return 1; } };
    const doc = { visibilityState: 'visible', addEventListener: (t: string, l: () => void) => { docL.set(t, l); } };
    return { win, doc, winL, docL, tick: () => ticks.forEach(f => f()) };
  }

  it('pagehide on chargen reports the screen, the step and the time on that screen, once', () => {
    const h = harness();
    const w = fakeWindow();
    h.r.install(w.win as never, w.doc as never);
    h.state.screen = 'char-select';
    w.tick();
    h.clock.t += 5000;
    h.state.screen = 'chargen'; h.state.step = chargenStepName(CreateStep.Appearance);
    w.tick();
    h.clock.t += 240_000;
    w.winL.get('pagehide')!();
    w.winL.get('pagehide')!();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].body).toMatchObject({ outcome: 'page_left', screen: 'chargen', step: 'appearance', screenMs: 240_000, pageMs: 245_000 });
    expectClean(h);
  });

  it('hiding the tab reports once per screen + step; nothing is reported from the world', () => {
    const h = harness();
    const w = fakeWindow();
    h.r.install(w.win as never, w.doc as never);
    h.state.screen = 'server-select';
    w.doc.visibilityState = 'hidden';
    w.docL.get('visibilitychange')!();
    w.docL.get('visibilitychange')!();
    w.doc.visibilityState = 'visible';
    w.docL.get('visibilitychange')!();
    h.state.screen = 'world';
    w.doc.visibilityState = 'hidden';
    w.docL.get('visibilitychange')!();
    w.winL.get('pagehide')!();
    expect(h.sent.map(s => [s.body.outcome, s.body.screen])).toEqual([['page_hidden', 'server-select']]);
  });

  it('the step names follow CreateStep', () => {
    expect([CreateStep.Heritage, CreateStep.Profession, CreateStep.Skills, CreateStep.Appearance, CreateStep.Town, CreateStep.Summary].map(chargenStepName))
      .toEqual(['heritage', 'profession', 'skills', 'appearance', 'town', 'summary']);
    expect(chargenStepName(99)).toBeNull();
  });
});

describe('which screen the player is on (preworldScreenFor), and deliberate reloads', () => {
  const base: PreworldScreenState = {
    gameStarted: false, disconnected: false, launcherActive: false, eraSwitchPending: false,
    uiScreen: 'character-select', portalSpace: false, charListReceived: false,
  };

  it("char select / chargen only once this session's character list arrived; before that it is connecting", () => {
    // GameUI's screen defaults to 'character-select' before any list: a wrong password used to read char-select.
    expect(preworldScreenFor(base)).toBe('connecting');
    expect(preworldScreenFor({ ...base, uiScreen: 'character-create' })).toBe('connecting');
    expect(preworldScreenFor({ ...base, charListReceived: true })).toBe('char-select');
    expect(preworldScreenFor({ ...base, charListReceived: true, uiScreen: 'character-create' })).toBe('chargen');
    expect(preworldScreenFor({ ...base, charListReceived: true, portalSpace: true })).toBe('portal-space');
    expect(preworldScreenFor({ ...base, portalSpace: true })).toBe('portal-space');
    expect(preworldScreenFor({ ...base, launcherActive: true, charListReceived: true })).toBe('server-select');
    // The launcher closed on another era's world: still the server select until the reload.
    expect(preworldScreenFor({ ...base, eraSwitchPending: true })).toBe('server-select');
    expect(preworldScreenFor({ ...base, disconnected: true, launcherActive: true })).toBe('disconnected');
    expect(preworldScreenFor({ ...base, gameStarted: true, disconnected: true })).toBe('world');
  });

  /** A reporter whose screen is main.ts's: preworldScreenFor over a state that reads the reporter's own char-list flag. */
  function mainLike() {
    const sent: Array<{ body: PreworldEvent; raw: string }> = [];
    const clock = { t: 1000 };
    const st = { ...base };
    let r: PreworldReporter;
    r = new PreworldReporter({
      endpoint: 'https://bridge.example/client-preworld', build: 'abc1234', era: () => 'eor', server: () => 'coldeve',
      screen: () => preworldScreenFor({ ...st, charListReceived: r.characterListReceived }),
      now: () => clock.t, trace: 'feedc0de12345678', send: (_u, raw) => sent.push({ body: JSON.parse(raw) as PreworldEvent, raw }),
    });
    return { r, sent, clock, st };
  }

  it('a wrong-password refusal (ACE AccountBoot) is reported from connecting, not char-select', () => {
    const h = mainLike();
    h.r.loginStarted();
    h.clock.t += 9;
    h.r.accountBoot(' because the password entered for this account was not correct');
    expect(h.sent.map(s => [s.body.outcome, s.body.screen, s.body.token])).toEqual([['login_refused', 'connecting', 'boot_password_mismatch']]);
    // The list arrives on a later login: now it is char select; a fresh login resets it to connecting.
    h.r.loginStarted();
    h.r.characterList(2);
    expect(h.sent[1].body).toMatchObject({ outcome: 'char_list', screen: 'char-select' });
    h.r.loginStarted();
    h.r.connectionError({ characterError: CharacterError.AccountLogin });
    expect(h.sent[2].body).toMatchObject({ outcome: 'login_refused', screen: 'connecting' });
  });

  // Live 2026-10-13 (build ddd6bf5e, every era): char select → World box → launcher → Custom… wss://nothing.invalid →
  // ENTER showed CantSocket but reported screen="char-select": the last session's list leaked into the new attempt,
  // because only 'connected' (which a never-opened socket never fires) reset it.
  for (const era of ['eor', 'dm', 'ac1999'] as const) {
    it(`${era}: a reconnect whose socket never opens reports from connecting, not the previous session's char select`, () => {
      const h = mainLike();
      const conn = reportConnectAttempts(
        era === 'ac1999' ? new Connection1999(h.r.tagUrl('wss://bridge.example/connect?server=ac1999'))
          : new ClientConnection(h.r.tagUrl(`wss://bridge.example/connect?server=${era === 'dm' ? 'classic' : 'coldeve'}`)),
        () => h.r.connectAttempt());
      conn.autoReconnect = false;
      wireLikeMain(conn, h.r);
      // The first session reaches char select.
      conn.connect(ACCOUNT, PASSWORD);
      h.clock.t += 50;
      FakeSocket.sockets[0].open();
      h.clock.t += 400;
      h.r.characterList(2);
      expect(h.sent[0].body).toMatchObject({ outcome: 'char_list', screen: 'char-select', sinceLoginMs: 400 });
      // leaveForLauncher: log off, the launcher picks a custom world, ENTER connects there.
      conn.disconnect();
      h.st.launcherActive = true;
      h.clock.t += 30_000;
      h.st.launcherActive = false;
      conn.setUrl(h.r.tagUrl('wss://nothing.invalid'));
      conn.connect(ACCOUNT, PASSWORD);
      FakeSocket.sockets[1].onerror?.();
      const failed = h.sent.at(-1)!.body;
      // No login went out on this attempt: sinceLoginMs is null, not the time since the first session's login.
      expect([failed.outcome, failed.screen, failed.token, failed.sinceLoginMs]).toEqual(['connect_failed', 'connecting', 'ID_NetError_CantSocket', null]);
      expectClean(h as unknown as Harness);
    });
  }

  it('connectAttempt resets only per-session state; an attempt that opens times its login from the open', () => {
    const h = mainLike();
    const conn = reportConnectAttempts(new ClientConnection('wss://bridge.example/connect?server=coldeve'), () => h.r.connectAttempt());
    conn.autoReconnect = false;
    wireLikeMain(conn, h.r);
    conn.connect(ACCOUNT, PASSWORD);
    FakeSocket.sockets[0].open();
    h.r.characterList(1);
    h.r.enterRequested();
    conn.disconnect();
    conn.connect(ACCOUNT, PASSWORD);
    expect(h.r.characterListReceived).toBe(false);
    h.clock.t += 70;
    FakeSocket.sockets[1].open();
    h.clock.t += 30;
    h.r.connectionError({ characterError: CharacterError.AccountLogin });
    // Before this attempt's list: a login refusal (not the old session's enter refusal), timed from this socket's open.
    expect(h.sent.at(-1)!.body).toMatchObject({ outcome: 'login_refused', screen: 'connecting', sinceLoginMs: 30 });
  });

  it("an era switch's reload sends one page_reload from the server select, never page_left / page_hidden", () => {
    const h = mainLike();
    const winL = new Map<string, () => void>();
    const docL = new Map<string, () => void>();
    const doc = { visibilityState: 'visible', addEventListener: (t: string, l: () => void) => { docL.set(t, l); } };
    h.r.install({ addEventListener: (t: string, l: () => void) => { winL.set(t, l); }, setInterval: () => 1 } as never, doc as never);
    h.st.launcherActive = true;
    h.clock.t += 100_000;
    // runLauncher: the launcher closes on an AC1999 world, switchEraFor checks its DATs, then reloads.
    h.st.launcherActive = false;
    h.st.eraSwitchPending = true;
    h.r.leavingForReload('era_switch');
    doc.visibilityState = 'hidden';
    docL.get('visibilitychange')!();
    winL.get('pagehide')!();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].body).toMatchObject({ outcome: 'page_reload', token: 'era_switch', screen: 'server-select' });
    expect(Object.keys(h.sent[0].body).sort()).toEqual(SCHEMA_KEYS);
  });

  it('a reload from the world sends nothing and still suppresses page_left; only the closed reasons exist', () => {
    const h = mainLike();
    h.st.gameStarted = true;
    h.r.leavingForReload('update');
    h.st.gameStarted = false;
    h.r.pageLeft();
    expect(h.sent).toHaveLength(0);
    expect([...RELOAD_REASONS]).toEqual(['era_switch', 'update', 'epilogue']);
    const h2 = mainLike();
    h2.st.launcherActive = true;
    h2.r.leavingForReload('update');
    h2.r.leavingForReload('epilogue');
    expect(h2.sent.map(s => [s.body.outcome, s.body.token, s.body.screen])).toEqual([['page_reload', 'update', 'server-select']]);
  });
});

describe('transport limits and endpoint', () => {
  it('no endpoint sends nothing; a page sends at most MAX_PREWORLD_EVENTS; tokens that are not identifiers are dropped', () => {
    const none = harness(null);
    none.r.characterList(1);
    expect(none.sent).toHaveLength(0);
    const h = harness();
    h.r.connectionError({ characterError: 5 }, `${ACCOUNT} said hi`);
    expect(h.sent[0].body.token).toBe(CharacterError[5] ?? null);
    for (let i = 0; i < MAX_PREWORLD_EVENTS + 10; i++) h.r.characterList(i);
    expect(h.sent).toHaveLength(MAX_PREWORLD_EVENTS);
    expectClean(h);
  });

  it('the endpoint is the bridge host over http(s); a generated trace is 16 hex', () => {
    expect(PreworldReporter.endpointFor('wss://bridge.playwebac.com/connect?server=x')).toBe('https://bridge.playwebac.com/client-preworld');
    expect(PreworldReporter.endpointFor('ws://localhost:9090')).toBe('http://localhost:9090/client-preworld');
    expect(PreworldReporter.endpointFor('nope')).toBeNull();
    const r = new PreworldReporter({ endpoint: null, build: 'b', era: () => 'eor', server: () => null, screen: () => 'boot' });
    expect(r.trace).toMatch(/^[0-9a-f]{16}$/);
    expect(r.tagUrl('ws://localhost:9090')).toBe(`ws://localhost:9090/?trace=${r.trace}`);
  });

  it('without Web Crypto the trace still forms, from the clock, never Math.random (FAITHFUL.216)', () => {
    const grv = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => { throw new Error('no crypto'); });
    const rnd = vi.spyOn(Math, 'random');
    try {
      const r = new PreworldReporter({ endpoint: null, build: 'b', era: () => 'eor', server: () => null, screen: () => 'boot' });
      expect(r.trace).toMatch(/^[0-9a-f]{16}$/);
      expect(rnd).not.toHaveBeenCalled();
    } finally {
      grv.mockRestore();
      rnd.mockRestore();
    }
  });
});
