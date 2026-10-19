/**
 * RELEASE.login-name-taken-hint — a wrong-password refusal before the world
 * tells a newcomer why (playwebac.com, 2026-10-12/13: new visitors on
 * Coldeve were booted with ACE's "password ... was not correct" 3-4 times in
 * a row; the launcher says most worlds create the account on first login, so
 * a name someone else already owns reads as nonsense).
 *
 * Every era's refusal is driven through the real code with the server's
 * bytes, then through the launcher text main.ts shows:
 *  - ACE / ClassicACE: AccountBoot 0xF7DC with the wrong-password reason
 *    (AuthenticationHandler.cs:174) through ServerMessageHandler →
 *    accountBootLoginText;
 *  - GDLE (Dark Majesty): the STR_LOGIN_FAILED NetError through
 *    ClientConnection → serverNetErrorNotice → loginFailureText;
 *  - AC1999: the same NetError through Connection1999.
 * GDLE and the AC1999 server auto-create unknown names
 * (auto_create_accounts defaults to 1, AuthenticateUserQuery::PerformQuery),
 * so STR_LOGIN_FAILED there is a wrong password for an existing name too.
 * A register-first world keeps its registration line instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientConnection, PACKET_HEADER_SIZE, BinaryWriter, deserializeMessage, type ConnectionEvent } from '../packages/network/src/index.js';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { buildPacket1999 } from '../packages/network/src/era1999/Packet1999.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { serverNetErrorNotice } from '../packages/renderer/src/ui/ConnectionNotices.js';
import {
  accountBootLoginText, loginFailureText, ACCOUNT_NAME_TAKEN_HINT, LOGON_FAILED_HINT, type World,
} from '../packages/renderer/src/launcher/worldDirectory.js';
import { PASSWORD_MISMATCH_BOOT_REASON } from '../packages/renderer/src/session/AccountBoot.js';
import { bootReasonToken } from '../packages/renderer/src/telemetry/PreworldReporter.js';

type W = Pick<World, 'name' | 'registration' | 'registrationUrl'>;
const COLDEVE: W = { name: 'Coldeve', registration: null, registrationUrl: null };
const REEF: W = { name: 'Reefcull', registration: 'Register on the Reefcull website first.', registrationUrl: 'http://reefcull.gdleac.com/' };
const REEF_HINT = '\n\nNew account? Register on the Reefcull website first. http://reefcull.gdleac.com/';

const BT_NETERROR = 0x00100000;
const ST_SERVER_ERRORS = 8;
const STR_LOGIN_FAILED = 0x04DF9C54;
const STR_LOGIN_ACCOUNT_ONLINE = 0x0C559B1E;

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

const g = globalThis as { WebSocket?: unknown };
let saved: unknown;
beforeEach(() => {
  saved = g.WebSocket; g.WebSocket = FakeSocket; FakeSocket.sockets = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { g.WebSocket = saved; vi.useRealTimers(); vi.restoreAllMocks(); });

/** ACE GameMessageBootAccount: u32 0xF7DC, String16L reason. */
function aceBoot(reason: string | null): Uint8Array {
  const w = new BinaryWriter(128);
  w.writeUInt32(0xF7DC);
  if (reason !== null) w.writeString16(reason);
  return w.toBuffer();
}

/** main.ts's onAccountBoot: the boot reason → accountBootLoginText(reason, launcherWorld, gameStarted). */
function aceBootText(reason: string | null, world: W | null, inWorld = false): string {
  let text = '';
  const smh = new ServerMessageHandler();
  smh.setHandlers({ onAccountBoot: (d) => { text = accountBootLoginText(d.reason, world, inWorld); } });
  smh.handleMessage(deserializeMessage(aceBoot(reason)));
  return text;
}

/** GDLE CNetwork::SendConnectLoginFailure: seq 0, flags NetError, {error, 8} (checksum unchecked on NetError). */
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

/** main.ts: a connection error event → serverNetErrorNotice → loginFailureText (raiseNetError). */
function shownFor(events: ConnectionEvent[], world: W | null): string {
  const e = events.filter((x) => x.type === 'error');
  expect(e).toHaveLength(1);
  const n = serverNetErrorNotice(e[0].serverNetError!.stringId, e[0].serverNetError!.tableId);
  return loginFailureText(n, world, false);
}

function gdleLogin(error: number): ConnectionEvent[] {
  const conn = new ClientConnection('ws://bridge');
  conn.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  conn.connect('commonname', 'pw');
  const sock = FakeSocket.sockets[0];
  sock.open();
  sock.deliver(gdleRefusal(error));
  return events;
}

function ac1999Login(error: number): ConnectionEvent[] {
  const conn = new Connection1999('ws://bridge');
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  conn.connect('commonname', 'pw');
  const sock = FakeSocket.sockets[0];
  sock.open();
  const body = new Uint8Array(8);
  new DataView(body.buffer).setUint32(0, error >>> 0, true);
  new DataView(body.buffer).setUint32(4, ST_SERVER_ERRORS, true);
  sock.deliver(buildPacket1999({ sequence: 0, flags: BT_NETERROR, recipient: 0x0b, time: 0, body }));
  return events;
}

describe('the hint text', () => {
  it('names both causes, briefly: a taken name and a browser-saved password from another world', () => {
    expect(ACCOUNT_NAME_TAKEN_HINT).toMatch(/new to this world/);
    expect(ACCOUNT_NAME_TAKEN_HINT).toMatch(/different account name/);
    expect(ACCOUNT_NAME_TAKEN_HINT).toMatch(/browser .*password saved for another world/);
    expect(LOGON_FAILED_HINT.startsWith('That usually means a wrong password for this account name. ')).toBe(true);
    expect(LOGON_FAILED_HINT).toContain(ACCOUNT_NAME_TAKEN_HINT);
  });

  it('GDLE sends the same refusal when its own account query fails: a returning player is told to wait and retry', () => {
    // STR_LOGIN_FAILED also comes from CDatabaseIO::VerifyAccount's QUERY_FAILED (Snowreap 2026-10-17:
    // a returning player refused twice, a brand-new account once, each accepted minutes later).
    expect(LOGON_FAILED_HINT.endsWith('If this name and password worked before, the server may be having trouble: wait a minute and try again.')).toBe(true);
  });
});

describe("ACE / ClassicACE: the wrong-password AccountBoot's bytes to the shown text", () => {
  const BOOT = "You have been booted from Asheron's Call because the password entered for this account was not correct.";

  it('the reason the telemetry codes boot_password_mismatch is the one the hint keys on', () => {
    expect(bootReasonToken(PASSWORD_MISMATCH_BOOT_REASON)).toBe('boot_password_mismatch');
  });

  it("an auto-create world (Coldeve) keeps the server's text and adds the hint", () => {
    expect(aceBootText(PASSWORD_MISMATCH_BOOT_REASON, COLDEVE)).toBe(`${BOOT}\n\n${ACCOUNT_NAME_TAKEN_HINT}`);
    // A URL login (no launcher world) is an auto-create world by default too.
    expect(aceBootText(PASSWORD_MISMATCH_BOOT_REASON, null)).toBe(`${BOOT}\n\n${ACCOUNT_NAME_TAKEN_HINT}`);
  });

  it('a register-first world, an in-world boot and other boot reasons show the text alone', () => {
    expect(aceBootText(PASSWORD_MISMATCH_BOOT_REASON, REEF)).toBe(BOOT);
    expect(aceBootText(PASSWORD_MISMATCH_BOOT_REASON, COLDEVE, true)).toBe(BOOT);
    expect(aceBootText(' because the world is now closed', COLDEVE)).toBe("You have been booted from Asheron's Call because the world is now closed.");
    expect(aceBootText(null, COLDEVE)).toBe("You have been booted from Asheron's Call for Code of Conduct Violations.");
  });
});

describe('GDLE (Dark Majesty): the STR_LOGIN_FAILED NetError bytes through ClientConnection to the shown text', () => {
  it('an auto-create world gets the taken-name hint', () => {
    expect(shownFor(gdleLogin(STR_LOGIN_FAILED), COLDEVE)).toBe(`Client logon failed\n\n${LOGON_FAILED_HINT}`);
  });
  it('a register-first world gets its registration line instead', () => {
    expect(shownFor(gdleLogin(STR_LOGIN_FAILED), REEF)).toBe(`Client logon failed${REEF_HINT}`);
  });
  it('another refusal (account already online) gets neither', () => {
    expect(shownFor(gdleLogin(STR_LOGIN_ACCOUNT_ONLINE), COLDEVE)).toBe('Player already logged on\n\nClose any other window logged in to this account, or wait a minute and try again.');
  });
});

describe('AC1999: the STR_LOGIN_FAILED NetError bytes through Connection1999 to the shown text', () => {
  const AC1999: W = { name: 'AC1999', registration: null, registrationUrl: null };
  it('auto_create_accounts=1: the taken-name hint', () => {
    expect(shownFor(ac1999Login(STR_LOGIN_FAILED), AC1999)).toBe(`Client logon failed\n\n${LOGON_FAILED_HINT}`);
  });
  it('a register-first world: its registration line; another refusal: its own plain next step', () => {
    FakeSocket.sockets = [];
    expect(shownFor(ac1999Login(STR_LOGIN_FAILED), REEF)).toBe(`Client logon failed${REEF_HINT}`);
    FakeSocket.sockets = [];
    expect(shownFor(ac1999Login(STR_LOGIN_ACCOUNT_ONLINE), AC1999)).toBe('Player already logged on\n\nClose any other window logged in to this account, or wait a minute and try again.');
  });
});
