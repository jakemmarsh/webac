/**
 * BUG.second-tab-login-refusal — production 2026-11-04 (Reefcull, GDLE, end
 * of retail, Edge): a tab in the world on an account, a second tab logged in
 * to the same world and account. GDLE refused it with the NetError
 * STR_LOGIN_ACCOUNT_ONLINE ("Player already logged on"); the player got that
 * text and "Close any other window…" over the launcher, logged out in the
 * first tab by hand and got in 36 s later.
 *
 * Drives the real modules:
 *  - ClientConnection (GDLE bytes) and Connection1999 (the AC1999 server's
 *    bytes) under a real AccountTabGuard on a shared fake BroadcastChannel:
 *    a login refused with a NetError never claims the account, so the tab
 *    holding it is not logged out unasked; ACE's CharacterError.Logon and an
 *    accepted login still claim (BUG.multi-tab-login-pingpong unchanged);
 *  - AccountTabGuard's account query and login logout request: the exact
 *    key only, any stage, only with an open session;
 *  - LoginHolderWait (session/LoginHolder.ts): none / Yes / No / spent /
 *    resume / other refusals / the player leaving;
 *  - the texts, and GameUI's Yes / No over the connecting screen (happy-dom).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  ClientConnection, type ConnectionEvent, PacketHeaderFlags, type PacketHeaderData,
  PACKET_HEADER_SIZE, FRAGMENT_HEADER_SIZE, writePacketHeader, fragmentMessage, writeFragment, GameMessageGroup,
} from '@ac/network';
import { Connection1999, VERSION_1999 } from '../packages/network/src/era1999/Connection1999.js';
import { buildPacket1999, F1999 } from '../packages/network/src/era1999/Packet1999.js';
import {
  AccountTabGuard, accountSessionKey, type SessionChannelLike, type WorldHolder, type LogoutReason,
} from '../packages/renderer/src/session/AccountTabGuard';
import {
  LoginHolderWait, LOGON_FAILED_LOGIN_TOKEN, LOGIN_HOLDER_LEAVING_STATUS, LOGGED_OUT_FOR_LOGIN_TEXT, ACCOUNT_IN_USE_LOGIN_TOKENS, loginHolderOfferText, loginHolderKeptText, stoodDownForOtherTabText, type LoginHolderReport,
} from '../packages/renderer/src/session/LoginHolder';
import { serverNetErrorNotice, characterErrorNotice, ACCOUNT_IN_USE_HINT } from '../packages/renderer/src/ui/ConnectionNotices';
import { loginFailureText } from '../packages/renderer/src/launcher/worldDirectory';
import { CharacterError } from '@ac/shared';
import { PreworldReporter } from '../packages/renderer/src/telemetry/PreworldReporter';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { LOGIN_HOLDER_RETRY_DELAYS_MS } from '../packages/renderer/src/session/RetryPolicy';

// reference/classic/ClassicDereth/Source/NetworkDefs.h, reference/ac1999/Server/Source/NetworkDefs.h
const BT_NETERROR = 0x00100000;
const ST_SERVER_ERRORS = 8;
const STR_LOGIN_ACCOUNT_ONLINE = 0x0C559B1E;
const STR_LOGIN_FAILED = 0x04DF9C54;
const SERVER_ID = 0x0b;
const CHARACTER_ERROR = 0xF659;
const CHARACTER_LIST = 0xF658;

/** GDLE's CNetwork::SendConnectLoginFailure (crc left 0: ClientConnection does not check a connectionless NetError's). */
function gdleRefusal(error: number): Uint8Array {
  const p = new Uint8Array(PACKET_HEADER_SIZE + 8);
  const v = new DataView(p.buffer);
  v.setUint32(4, BT_NETERROR, true);
  v.setUint16(12, SERVER_ID, true);
  v.setUint16(16, 8, true);
  v.setUint16(18, 0x01, true);
  v.setUint32(20, error >>> 0, true);
  v.setUint32(24, ST_SERVER_ERRORS, true);
  return p;
}
/** The AC1999 server's SendConnectLoginFailure (Network.cpp:555). */
function refusal1999(error: number): Uint8Array {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setUint32(0, error >>> 0, true);
  new DataView(body.buffer).setUint32(4, ST_SERVER_ERRORS, true);
  return buildPacket1999({ sequence: 0, flags: BT_NETERROR, recipient: SERVER_ID, time: 0, body });
}
/** The AC1999 connect grant (0x202): the login got in. */
function grant1999(version: string): Uint8Array {
  const vb = new TextEncoder().encode(version);
  const body = new Uint8Array(16 + 4 + 4 + vb.length + 8);
  const v = new DataView(body.buffer);
  v.setUint32(16, 3, true);
  v.setUint32(20, vb.length, true);
  body.set(vb, 24);
  return buildPacket1999({ sequence: 0, flags: F1999.Connect | F1999.Checksum, recipient: SERVER_ID, time: 0, body });
}
function opcodePacket(seq: number, opcode: number, arg?: number): Uint8Array {
  const msg = new Uint8Array(8);
  const v = new DataView(msg.buffer);
  v.setUint32(0, opcode, true);
  if (arg !== undefined) v.setUint32(4, arg, true);
  const [frag] = fragmentMessage(msg, seq, GameMessageGroup.WeenieQueue, 0);
  const payload = new Uint8Array(FRAGMENT_HEADER_SIZE + frag.data.length);
  writeFragment(frag, payload, 0);
  const buf = new Uint8Array(PACKET_HEADER_SIZE + payload.length);
  const header: PacketHeaderData = { sequence: seq, flags: PacketHeaderFlags.BlobFragments, checksum: 0, id: 0x42, time: 0, size: payload.length, iteration: 1 };
  writePacketHeader(header, buf, 0);
  buf.set(payload, PACKET_HEADER_SIZE);
  return buf;
}

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: FakeSocket[] = [];
  readyState = 0;
  binaryType = '';
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: ((ev?: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  send(): void { /* scripted server */ }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(b: Uint8Array): void { this.onmessage?.({ data: b.slice().buffer }); }
}

/** BroadcastChannel semantics: every other channel on the hub gets the message (not the sender). */
class FakeChannelHub {
  private channels: FakeChannel[] = [];
  open(): FakeChannel { const c = new FakeChannel(this); this.channels.push(c); return c; }
  deliver(from: FakeChannel, data: unknown): void {
    for (const c of this.channels) if (c !== from) c.listeners.forEach(l => l({ data: structuredClone(data) }));
  }
}
class FakeChannel implements SessionChannelLike {
  listeners: ((ev: { data: unknown }) => void)[] = [];
  constructor(private hub: FakeChannelHub) {}
  postMessage(m: unknown): void { this.hub.deliver(this, m); }
  addEventListener(_t: 'message', l: (ev: { data: unknown }) => void): void { this.listeners.push(l); }
}

const REEF = 'wss://bridge.example/connect?server=a7502ac9-0cec-4caf-b81c-b3eb40a4689a';
const OTHER_WORLD = 'wss://bridge.example/connect?server=1f069f0d-1b2a-421b-a723-297486a82cd7';

interface Tab {
  guard: AccountTabGuard;
  world: { name: string | null } | null;
  live: boolean;
  stoodDown: number;
  loggedOut: LogoutReason[];
}

/** A page's guard: whether its character is in the world, whether its session is open, its handlers. */
function makeTab(hub: FakeChannelHub, id: string): Tab {
  const tab: Tab = { world: null, live: true, stoodDown: 0, loggedOut: [], guard: undefined as unknown as AccountTabGuard };
  tab.guard = new AccountTabGuard({
    channel: hub.open(),
    tabId: id,
    onStandDown: () => { tab.stoodDown++; },
    onLogoutRequested: (_key, reason) => { tab.loggedOut.push(reason); },
    worldCharacter: () => tab.world,
    sessionLive: () => tab.live,
    setTimeout: (fn) => { fn(); return 0; },
  });
  return tab;
}

const g = globalThis as { WebSocket?: unknown };
let savedWs: unknown;
beforeAll(() => { savedWs = g.WebSocket; g.WebSocket = FakeSocket; });
afterAll(() => { g.WebSocket = savedWs; });
afterEach(() => { FakeSocket.sockets = []; vi.useRealTimers(); vi.restoreAllMocks(); });
const quiet = (): void => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
};

describe('BUG.second-tab-login-refusal — a refused login never claims the account', () => {
  it('GDLE: "Player already logged on" leaves the tab in the world in, holding its key', () => {
    quiet();
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    const key = accountSessionKey(REEF, 'jake');
    a.guard.claim(key);
    a.world = { name: 'Mira' };
    const b = makeTab(hub, 'tab-b');
    const conn = new ClientConnection(REEF);
    const events: ConnectionEvent[] = [];
    conn.on((e) => events.push(e));
    b.guard.watch(conn, () => accountSessionKey(REEF, 'Jake'));
    conn.connect('Jake', 'pw');
    FakeSocket.sockets[0].open();
    FakeSocket.sockets[0].deliver(gdleRefusal(STR_LOGIN_ACCOUNT_ONLINE));
    const err = events.find((e) => e.type === 'error');
    expect(err?.serverNetError).toEqual({ stringId: STR_LOGIN_ACCOUNT_ONLINE, tableId: ST_SERVER_ERRORS });
    expect(serverNetErrorNotice(err!.serverNetError!.stringId, err!.serverNetError!.tableId).token).toBe('ID_ConnectionError_PlayerAlreadyLoggedOn');
    expect(events.some((e) => e.type === 'serverReached')).toBe(true);
    // Pre-fix: B claimed on that first frame and A stood down (logged out unasked) while B stayed refused.
    expect(b.guard.heldKey).toBeNull();
    expect(a.stoodDown).toBe(0);
    expect(a.guard.heldKey).toBe(key);
  });

  it('GDLE: the same tab\'s login that gets in claims as before (the other tab stands down)', () => {
    quiet();
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    const b = makeTab(hub, 'tab-b');
    const conn = new ClientConnection(REEF);
    b.guard.watch(conn, () => accountSessionKey(REEF, 'jake'));
    conn.connect('jake', 'pw');
    FakeSocket.sockets[0].open();
    FakeSocket.sockets[0].deliver(opcodePacket(2, CHARACTER_LIST));
    expect(b.guard.heldKey).toBe(accountSessionKey(REEF, 'jake'));
    expect(a.stoodDown).toBe(1);
    conn.disconnect();
  });

  it('ACE: CharacterError.Logon (the server booted the other session) still claims; a ClientLogOnFailed NetError does not', () => {
    vi.useFakeTimers();
    quiet();
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    const b = makeTab(hub, 'tab-b');
    const conn = new ClientConnection(REEF);
    b.guard.watch(conn, () => accountSessionKey(REEF, 'jake'));
    conn.connect('jake', 'typo');
    FakeSocket.sockets[0].open();
    FakeSocket.sockets[0].deliver(gdleRefusal(STR_LOGIN_FAILED));
    expect(a.stoodDown).toBe(0); // a wrong password in B never displaced A

    conn.connect('jake', 'pw');
    FakeSocket.sockets[1].open();
    FakeSocket.sockets[1].deliver(opcodePacket(2, CHARACTER_ERROR, CharacterError.Logon));
    expect(a.stoodDown).toBe(1);
    expect(b.guard.heldKey).toBe(accountSessionKey(REEF, 'jake'));
    conn.disconnect();
  });

  it('AC1999: the server\'s STR_LOGIN_ACCOUNT_ONLINE does not claim; its connect grant does', () => {
    quiet();
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    const key = accountSessionKey('wss://bridge.example/connect?server=ac1999', 'jake');
    a.guard.claim(key);
    a.world = { name: 'Mira' };
    const b = makeTab(hub, 'tab-b');
    const refused = new Connection1999('wss://bridge.example/connect?server=ac1999');
    const events: ConnectionEvent[] = [];
    refused.on((e) => events.push(e));
    b.guard.watch(refused, () => key);
    refused.connect('jake', 'pw');
    FakeSocket.sockets[0].open();
    FakeSocket.sockets[0].deliver(refusal1999(STR_LOGIN_ACCOUNT_ONLINE));
    expect(events.find((e) => e.type === 'error')?.serverNetError).toEqual({ stringId: STR_LOGIN_ACCOUNT_ONLINE, tableId: ST_SERVER_ERRORS });
    expect(a.stoodDown).toBe(0);
    expect(b.guard.heldKey).toBeNull();

    // The AC1999 server normally drops the old session and admits the new login (Network.cpp:665-680):
    // the grant claims, and the old tab stands down instead of resuming into B.
    const admitted = new Connection1999('wss://bridge.example/connect?server=ac1999');
    b.guard.watch(admitted, () => key);
    admitted.connect('jake', 'pw');
    const sock = FakeSocket.sockets[FakeSocket.sockets.length - 1];
    sock.open();
    sock.deliver(grant1999(VERSION_1999));
    expect(a.stoodDown).toBe(1);
    expect(b.guard.heldKey).toBe(key);
    admitted.disconnect();
  });
});

describe('BUG.second-tab-login-refusal — who holds this account, asked across tabs', () => {
  it('answers: the exact key, at character select or in the world, only with an open session', async () => {
    const hub = new FakeChannelHub();
    const key = accountSessionKey(REEF, 'jake');
    const atSelect = makeTab(hub, 'tab-select');
    atSelect.guard.claim(key);
    const otherAcct = makeTab(hub, 'tab-other');
    otherAcct.guard.claim(accountSessionKey(REEF, 'someone'));
    otherAcct.world = { name: 'Cobalt' };
    const otherWorld = makeTab(hub, 'tab-elsewhere');
    otherWorld.guard.claim(accountSessionKey(OTHER_WORLD, 'jake'));
    otherWorld.world = { name: 'Mira' };
    const asker = makeTab(hub, 'tab-b');
    expect(await asker.guard.queryAccountHolders(key)).toEqual([{ tab: 'tab-select', character: null, sameAccount: true, inWorld: false }]);

    atSelect.world = { name: 'Mira' };
    expect(await asker.guard.queryAccountHolders(key)).toEqual([{ tab: 'tab-select', character: 'Mira', sameAccount: true, inWorld: true }]);
    // Left on a Disconnected screen: the key is still held, the session is not.
    atSelect.live = false;
    expect(await asker.guard.queryAccountHolders(key)).toEqual([]);
    // The world query of the enter path is unchanged: in-world tabs on this server, any account.
    atSelect.live = true;
    expect((await asker.guard.queryWorldHolders(key)).map((h) => [h.tab, h.sameAccount]))
      .toEqual(expect.arrayContaining([['tab-select', true], ['tab-other', false]]));
  });

  it('a login logout request logs out the exact key\'s holder at any stage; never another account, world, or a closed session', () => {
    quiet();
    const hub = new FakeChannelHub();
    const key = accountSessionKey(REEF, 'jake');
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(key);
    const c = makeTab(hub, 'tab-c');
    c.guard.claim(accountSessionKey(REEF, 'someone'));
    const d = makeTab(hub, 'tab-d');
    d.guard.claim(accountSessionKey(OTHER_WORLD, 'jake'));
    const b = makeTab(hub, 'tab-b');
    // Not a same-account holder: nothing sent.
    expect(b.guard.requestLogoutForLogin({ tab: 'tab-c', character: null, sameAccount: false }, key)).toBe(false);
    // Addressed to the wrong tab, or under another key: nobody acts.
    expect(b.guard.requestLogoutForLogin({ tab: 'tab-c', character: null, sameAccount: true }, key)).toBe(true);
    expect(b.guard.requestLogoutForLogin({ tab: 'tab-a', character: null, sameAccount: true }, accountSessionKey(REEF, 'someone'))).toBe(true);
    expect(b.guard.requestLogoutForLogin({ tab: 'tab-d', character: null, sameAccount: true }, key)).toBe(true);
    expect([a.loggedOut, c.loggedOut, d.loggedOut]).toEqual([[], [], []]);
    // A closed session: nothing to log out.
    a.live = false;
    b.guard.requestLogoutForLogin({ tab: 'tab-a', character: null, sameAccount: true }, key);
    expect(a.loggedOut).toEqual([]);
    // At character select, session open: it logs out, once, for the login.
    a.live = true;
    expect(b.guard.requestLogoutForLogin({ tab: 'tab-a', character: null, sameAccount: true }, key)).toBe(true);
    expect(a.loggedOut).toEqual(['login']);
    expect(a.guard.heldKey).toBeNull();
    b.guard.requestLogoutForLogin({ tab: 'tab-a', character: null, sameAccount: true }, key);
    expect(a.loggedOut).toEqual(['login']);
  });

  it('the enter path\'s request still acts only from the world', () => {
    quiet();
    const hub = new FakeChannelHub();
    const key = accountSessionKey(REEF, 'jake');
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(key);
    const sender = hub.open();
    sender.postMessage({ kind: 'webac-logout-request', key, to: 'tab-a', from: 'tab-b' });
    expect(a.loggedOut).toEqual([]);
    a.world = { name: 'Mira' };
    sender.postMessage({ kind: 'webac-logout-request', key, to: 'tab-a', from: 'tab-b' });
    expect(a.loggedOut).toEqual(['enter']);
  });
});

const RETAIL = 'Player already logged on';

/** The page around LoginHolderWait as main.ts wires it: a real guard on the hub, fake timers, a recording UI. */
function makeLoginPage(hub: FakeChannelHub, account = 'jake', world = REEF) {
  const tab = makeTab(hub, 'tab-b');
  const key = accountSessionKey(world, account);
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const page = {
    tab, logins: 0, passed: 0, resuming: false, waiting: true,
    status: [] as (string | null)[],
    refused: [] as (string | null)[],
    reports: [] as LoginHolderReport[],
    offers: [] as { text: string; answer: (yes: boolean) => void; open: boolean }[],
    wait: undefined as unknown as LoginHolderWait,
    fire(): number {
      const t = timers.find((x) => x.live);
      if (!t) return -1;
      t.live = false;
      t.fn();
      return t.ms;
    },
    get pending(): number { return timers.filter((x) => x.live).length; },
  };
  page.wait = new LoginHolderWait({
    resuming: () => page.resuming,
    queryHolders: () => tab.guard.queryAccountHolders(key),
    requestLogout: (h: WorldHolder) => tab.guard.requestLogoutForLogin(h, key),
    confirm: (text, answer) => { const o = { text, answer, open: true }; page.offers.push(o); return () => { o.open = false; }; },
    login: () => { page.logins++; },
    schedule: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; },
    setStatus: (text) => { page.status.push(text); },
    refuse: (text) => { page.refused.push(text); },
    stillWaiting: () => page.waiting,
    passOn: () => { page.passed++; },
    report: (kind) => { page.reports.push(kind); },
  });
  return page;
}
const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const TOKEN = 'ID_ConnectionError_PlayerAlreadyLoggedOn';

describe('BUG.second-tab-login-refusal — the refused login\'s wait', () => {
  it('no tab of this browser holds the account: retail\'s text and hint, unchanged', async () => {
    const hub = new FakeChannelHub();
    // Another account, and this account on another world, do not count.
    const other = makeTab(hub, 'tab-other');
    other.guard.claim(accountSessionKey(REEF, 'someone'));
    other.world = { name: 'Cobalt' };
    const elsewhere = makeTab(hub, 'tab-elsewhere');
    elsewhere.guard.claim(accountSessionKey(OTHER_WORLD, 'jake'));
    const b = makeLoginPage(hub);
    expect(b.wait.onRefused(TOKEN, RETAIL)).toBe(true);
    await flush();
    expect(b.reports).toEqual(['none']);
    expect(b.refused).toEqual([null]);
    expect(b.offers).toEqual([]);
    expect([other.loggedOut, elsewhere.loggedOut]).toEqual([[], []]);
    // What null shows (main.ts raiseNetError): retail's text and today's hint.
    const notice = serverNetErrorNotice(STR_LOGIN_ACCOUNT_ONLINE, ST_SERVER_ERRORS);
    expect(loginFailureText(notice, null, false)).toBe(`${RETAIL}\n\n${ACCOUNT_IN_USE_HINT}`);
  });

  it('a tab holds it in the world: Yes logs out only that tab and logs in again until the server lets it in', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    a.world = { name: 'Mira' };
    const c = makeTab(hub, 'tab-c');
    c.guard.claim(accountSessionKey(REEF, 'someone'));
    c.world = { name: 'Cobalt' };
    const b = makeLoginPage(hub, 'Jake');
    b.wait.onRefused(TOKEN, RETAIL);
    await flush();
    expect(b.offers).toHaveLength(1);
    expect(b.offers[0].text).toBe('This account is already logged in in another tab of this browser, in the world as Mira.\n\nLog out that tab and log in here?');
    expect(b.wait.offerOpen).toBe(true);
    // Nothing is logged out before the player answers, and nothing logs in.
    expect(a.loggedOut).toEqual([]);
    expect(b.pending).toBe(0);
    b.offers[0].answer(true);
    expect(a.loggedOut).toEqual(['login']);
    expect(c.loggedOut).toEqual([]);
    expect(b.status.at(-1)).toBe(LOGIN_HOLDER_LEAVING_STATUS);
    expect(b.fire()).toBe(LOGIN_HOLDER_RETRY_DELAYS_MS[0]);
    expect(b.logins).toBe(1);
    // GDLE still holds the account for a moment: refused again, quietly.
    expect(b.wait.onRefused(TOKEN, RETAIL)).toBe(true);
    expect(b.fire()).toBe(LOGIN_HOLDER_RETRY_DELAYS_MS[1]);
    expect(b.logins).toBe(2);
    expect(b.refused).toEqual([]);
    // The next one gets in: nothing pending, asked once.
    b.wait.end();
    expect(b.pending).toBe(0);
    expect(b.reports).toEqual(['offer-logout', 'logged-out']);
    expect(LOGGED_OUT_FOR_LOGIN_TEXT).toMatch(/another tab/);
  });

  it('a tab at character select: the offer says so; Yes logs it out', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    const b = makeLoginPage(hub);
    b.wait.onRefused(TOKEN, RETAIL);
    await flush();
    expect(b.offers[0].text).toContain('in another tab of this browser, at character select.');
    b.offers[0].answer(true);
    expect(a.loggedOut).toEqual(['login']);
  });

  it('Yes, and the server never lets go: bounded logins, then retail\'s text and hint (no loop)', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    a.world = { name: 'Mira' };
    const b = makeLoginPage(hub);
    b.wait.onRefused(TOKEN, RETAIL);
    await flush();
    b.offers[0].answer(true);
    const delays: number[] = [];
    for (;;) {
      const ms = b.fire();
      if (ms < 0) break;
      delays.push(ms);
      b.wait.onRefused(TOKEN, RETAIL);
    }
    expect(delays).toEqual([...LOGIN_HOLDER_RETRY_DELAYS_MS]);
    expect(b.logins).toBe(LOGIN_HOLDER_RETRY_DELAYS_MS.length);
    expect(b.refused).toEqual([null]);
    expect(b.reports.at(-1)).toBe('spent');
    expect(b.offers).toHaveLength(1); // never asked again
    expect(a.loggedOut).toEqual(['login']);
    expect(b.wait.retrying).toBe(false);
  });

  it('No: retail\'s text and a line naming that tab; the tab stays, nothing logs in', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    a.world = { name: 'Mira' };
    const b = makeLoginPage(hub);
    b.wait.onRefused(TOKEN, RETAIL);
    await flush();
    b.offers[0].answer(false);
    expect(a.loggedOut).toEqual([]);
    expect(a.guard.heldKey).not.toBeNull();
    expect(b.refused).toEqual([`${RETAIL}\n\nThis account is logged in in another tab of this browser, in the world as Mira: log out there, then log in again.`]);
    expect(b.refused[0]).toBe(loginHolderKeptText(RETAIL, { tab: 'tab-a', character: 'Mira', sameAccount: true, inWorld: true }));
    expect(b.pending).toBe(0);
    expect(b.logins).toBe(0);
    expect(b.reports).toEqual(['offer-logout', 'kept']);
  });

  it('a resume of our own dropped session never asks (its refusal is our own session logging out)', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    const b = makeLoginPage(hub);
    b.resuming = true;
    expect(b.wait.onRefused(TOKEN, RETAIL)).toBe(false);
    await flush();
    expect([b.offers, b.refused, b.reports, a.loggedOut]).toEqual([[], [], [], []]);
  });

  it('other refusals are not this wait\'s; one arriving during the logins ends them and goes the usual way', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    const b = makeLoginPage(hub);
    expect(ACCOUNT_IN_USE_LOGIN_TOKENS.has('ID_ConnectionError_ClientLogOnFailed')).toBe(false);
    expect(b.wait.onRefused('ID_ConnectionError_BadCryptoKey', 'Bad crypto key')).toBe(false);
    expect(b.wait.onRefused(null, '')).toBe(false);
    b.wait.onRefused(TOKEN, RETAIL);
    await flush();
    b.offers[0].answer(true);
    b.fire();
    expect(b.wait.onRefused('ID_ConnectionError_ClientLogOnFailed', 'Client logon failed')).toBe(false);
    expect(b.wait.retrying).toBe(false);
    expect(b.pending).toBe(0);
  });

  it('the player left (the launcher) before the answer or the dialog: nothing shows, nothing logs out or in', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    const b = makeLoginPage(hub);
    b.wait.onRefused(TOKEN, RETAIL);
    b.waiting = false;
    await flush();
    expect([b.offers, b.refused]).toEqual([[], []]);

    b.waiting = true;
    b.wait.onRefused(TOKEN, RETAIL);
    await flush();
    expect(b.offers[1]?.open ?? b.offers[0].open).toBe(true);
    // The connect cycle ended (main.ts cancelProvenLoginRetry): the offer closes; a late Yes does nothing.
    b.wait.cancel();
    const offer = b.offers.at(-1)!;
    expect(offer.open).toBe(false);
    offer.answer(true);
    expect(a.loggedOut).toEqual([]);
    expect(b.pending).toBe(0);
  });
});

describe('BUG.second-tab-login-refusal — the silent form (a login the server never answers)', () => {
  it('ClientConnection: loginUnanswered once, at the 2nd resend (4 s); the resends and the 40 s timeout are unchanged', () => {
    vi.useFakeTimers();
    quiet();
    const conn = new ClientConnection(REEF);
    const events: ConnectionEvent[] = [];
    conn.on((e) => events.push(e));
    conn.connect('jake', 'pw');
    FakeSocket.sockets[0].open();
    const unanswered = (): number => events.filter((e) => e.type === 'loginUnanswered').length;
    vi.advanceTimersByTime(ClientConnection.LOGIN_RETRY_INTERVAL);
    expect(unanswered()).toBe(0);
    vi.advanceTimersByTime(ClientConnection.LOGIN_RETRY_INTERVAL);
    expect(ClientConnection.LOGIN_UNANSWERED_AFTER_RETRIES * ClientConnection.LOGIN_RETRY_INTERVAL).toBe(4000);
    expect(unanswered()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(unanswered()).toBe(1);
    expect(events.filter((e) => e.type === 'error').map((e) => e.netErrorId)).toEqual(['ID_ConnectionError_ClientTimedOutServer']);
  });

  it('ClientConnection: a login the server answers in time never counts as unanswered', () => {
    vi.useFakeTimers();
    quiet();
    const conn = new ClientConnection(REEF);
    const events: ConnectionEvent[] = [];
    conn.on((e) => events.push(e));
    conn.connect('jake', 'pw');
    FakeSocket.sockets[0].open();
    vi.advanceTimersByTime(1500);
    FakeSocket.sockets[0].deliver(gdleRefusal(STR_LOGIN_ACCOUNT_ONLINE));
    vi.advanceTimersByTime(30_000);
    expect(events.some((e) => e.type === 'loginUnanswered')).toBe(false);
  });

  it('Connection1999: unanswered at its first resend (6 s); a grant before it, never', () => {
    vi.useFakeTimers();
    quiet();
    const silent = new Connection1999('wss://bridge.example/connect?server=ac1999');
    const events: ConnectionEvent[] = [];
    silent.on((e) => events.push(e));
    silent.connect('jake', 'pw');
    FakeSocket.sockets[0].open();
    vi.advanceTimersByTime(5_999);
    expect(events.some((e) => e.type === 'loginUnanswered')).toBe(false);
    vi.advanceTimersByTime(1);
    expect(events.filter((e) => e.type === 'loginUnanswered')).toHaveLength(1);
    vi.advanceTimersByTime(12_000);
    expect(events.filter((e) => e.type === 'loginUnanswered')).toHaveLength(1);
    silent.disconnect();

    const granted = new Connection1999('wss://bridge.example/connect?server=ac1999');
    const ev2: ConnectionEvent[] = [];
    granted.on((e) => ev2.push(e));
    granted.connect('jake', 'pw');
    const sock = FakeSocket.sockets[FakeSocket.sockets.length - 1];
    sock.open();
    sock.deliver(grant1999(VERSION_1999));
    vi.advanceTimersByTime(20_000);
    expect(ev2.some((e) => e.type === 'loginUnanswered')).toBe(false);
    granted.disconnect();
  });

  it('no tab holds the account: nothing shows, nothing is refused (a server that is down still times out as down)', async () => {
    const hub = new FakeChannelHub();
    const other = makeTab(hub, 'tab-other');
    other.guard.claim(accountSessionKey(REEF, 'someone'));
    other.world = { name: 'Cobalt' };
    const b = makeLoginPage(hub);
    b.wait.onUnanswered(RETAIL);
    await flush();
    expect([b.offers, b.refused, b.status]).toEqual([[], [], []]);
    expect(b.reports).toEqual(['silent-none']);
    expect(b.logins).toBe(0);
  });

  it('a tab holds it: the offer over the running resends; Yes logs out only that tab and logs in afresh, once', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    a.world = { name: 'Gdletab' };
    const b = makeLoginPage(hub);
    b.wait.onUnanswered(RETAIL);
    b.wait.onUnanswered(RETAIL); // asked once
    await flush();
    expect(b.offers).toHaveLength(1);
    expect(b.offers[0].text).toBe(loginHolderOfferText({ tab: 'tab-a', character: 'Gdletab', sameAccount: true, inWorld: true }));
    expect(b.reports).toEqual(['silent-offer']);
    b.offers[0].answer(true);
    expect(a.loggedOut).toEqual(['login']);
    expect(b.status.at(-1)).toBe(LOGIN_HOLDER_LEAVING_STATUS);
    expect(b.fire()).toBe(LOGIN_HOLDER_RETRY_DELAYS_MS[0]);
    expect(b.logins).toBe(1);
    // The fresh login's own unanswered point is not asked again.
    b.wait.onUnanswered(RETAIL);
    await flush();
    expect(b.offers).toHaveLength(1);
    expect(b.pending).toBe(0);
    b.wait.end();
  });

  it('No ends the login with the NetError form\'s No text; a resume never asks', async () => {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    a.world = { name: 'Gdletab' };
    const b = makeLoginPage(hub);
    b.wait.onUnanswered(RETAIL);
    await flush();
    b.offers[0].answer(false);
    expect(b.refused).toEqual([loginHolderKeptText(RETAIL, { tab: 'tab-a', character: 'Gdletab', sameAccount: true, inWorld: true })]);
    expect(a.loggedOut).toEqual([]);

    const r = makeLoginPage(hub);
    r.resuming = true;
    r.wait.onUnanswered(RETAIL);
    await flush();
    expect([r.offers, r.reports]).toEqual([[], []]);
  });

  it('end to end: a silent GDLE login (real ClientConnection, fake timers) brings the offer up at ~4 s', async () => {
    vi.useFakeTimers();
    quiet();
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(REEF, 'jake'));
    a.world = { name: 'Gdletab' };
    const b = makeLoginPage(hub);
    const conn = new ClientConnection(REEF);
    b.tab.guard.watch(conn, () => accountSessionKey(REEF, 'jake'));
    conn.on((e) => { if (e.type === 'loginUnanswered') b.wait.onUnanswered(RETAIL); });
    conn.connect('jake', 'pw');
    FakeSocket.sockets[0].open();
    vi.advanceTimersByTime(3_999);
    await flush();
    expect(b.offers).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await flush();
    expect(b.offers).toHaveLength(1);
    expect(a.stoodDown).toBe(0); // the unanswered login claimed nothing
    expect(b.tab.guard.heldKey).toBeNull();
    conn.disconnect();
  });
});

const LOGON_FAILED = 'ID_ConnectionError_ClientLogOnFailed';
const LOGON_FAILED_TEXT = 'Client logon failed';
const SEEDSOW = 'wss://bridge.example/connect?server=5eed5ow0-0000-4000-8000-000000000001';

/**
 * BUG.held-account-logon-failed — production 2026-11-07 (Seedsow, GDL, Dark
 * Majesty, one player): a tab in the world on an account; that player's other
 * pages tried ~7 logins to it and each was refused with STR_LOGIN_FAILED
 * ("Client logon failed", table 8), read as a wrong password, while their own
 * tab held the account. The same wait now asks the tabs about that refusal.
 */
describe('BUG.held-account-logon-failed — "Client logon failed" while a tab of this browser holds the account', () => {
  /** A tab in the world on Seedsow as jake (the holder), and the login page refused on the same key. */
  function seedsow(account = 'jake', world = SEEDSOW) {
    const hub = new FakeChannelHub();
    const a = makeTab(hub, 'tab-a');
    a.guard.claim(accountSessionKey(SEEDSOW, 'jake'));
    a.world = { name: 'Brakken' };
    const b = makeLoginPage(hub, account, world);
    return { hub, a, b };
  }

  it('the token is GDL / GDLE / the AC1999 server\'s STR_LOGIN_FAILED, apart from the in-use tokens', () => {
    expect(LOGON_FAILED_LOGIN_TOKEN).toBe(LOGON_FAILED);
    expect(serverNetErrorNotice(STR_LOGIN_FAILED, ST_SERVER_ERRORS).token).toBe(LOGON_FAILED);
    expect(ACCOUNT_IN_USE_LOGIN_TOKENS.has(LOGON_FAILED)).toBe(false);
  });

  it('a tab holds it: the Yes / No offer, before any case or quiet retry; nothing logs out unasked', async () => {
    const { a, b } = seedsow('Jake');
    expect(b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT)).toBe(true);
    await flush();
    expect(b.offers).toHaveLength(1);
    expect(b.offers[0].text).toBe('This account is already logged in in another tab of this browser, in the world as Brakken.\n\nLog out that tab and log in here?');
    expect(b.wait.heldByTab).toBe(true);
    expect(b.reports).toEqual(['offer-logon-failed']);
    expect([b.passed, b.refused, b.logins, b.pending, a.loggedOut]).toEqual([0, [], 0, 0, []]);
  });

  it('no tab holds it: passed on once (the case retry, the quiet retries, retail\'s text, as before); the cycle\'s later refusals are not asked about', async () => {
    const hub = new FakeChannelHub();
    const b = makeLoginPage(hub);
    expect(b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT)).toBe(true);
    await flush();
    expect([b.passed, b.offers, b.refused, b.reports, b.wait.heldByTab]).toEqual([1, [], [], [], false]);
    // The case retry's refusal and the first-time retries' refusals: the usual way at once.
    expect(b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT)).toBe(false);
    expect(b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT)).toBe(false);
    expect(b.passed).toBe(1);
    // The cycle ended (the launcher, the OK's relaunch): the next login asks again.
    b.wait.cancel();
    expect(b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT)).toBe(true);
    await flush();
    expect(b.passed).toBe(2);
  });

  it('another account, or this account on another world: unchanged (passed on, nothing offered or logged out)', async () => {
    for (const [account, world] of [['someone', SEEDSOW], ['jake', REEF]] as const) {
      const { a, b } = seedsow(account, world);
      expect(b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT)).toBe(true);
      await flush();
      expect([b.passed, b.offers, b.refused, b.reports, a.loggedOut, b.wait.heldByTab]).toEqual([1, [], [], [], [], false]);
    }
  });

  it('a holder whose session is closed (a Disconnected screen) does not answer: unchanged', async () => {
    const { a, b } = seedsow();
    a.live = false;
    b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT);
    await flush();
    expect([b.passed, b.offers, a.loggedOut]).toEqual([1, [], []]);
  });

  it('No: retail\'s text and the line naming that tab (not the wrong-password hint); the tab stays', async () => {
    const { a, b } = seedsow();
    b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT);
    await flush();
    b.offers[0].answer(false);
    expect(b.refused).toEqual([`${LOGON_FAILED_TEXT}\n\nThis account is logged in in another tab of this browser, in the world as Brakken: log out there, then log in again.`]);
    expect([a.loggedOut, b.logins, b.pending, b.passed]).toEqual([[], 0, 0, 0]);
    expect(b.reports).toEqual(['offer-logon-failed', 'kept']);
  });

  it('Yes: only that tab logs out, and the login retries until the server lets it in', async () => {
    const { hub, a, b } = seedsow();
    const other = makeTab(hub, 'tab-other');
    other.guard.claim(accountSessionKey(SEEDSOW, 'someone'));
    other.world = { name: 'Cobalt' };
    b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT);
    await flush();
    b.offers[0].answer(true);
    expect(a.loggedOut).toEqual(['login']);
    expect(other.loggedOut).toEqual([]);
    expect(b.status.at(-1)).toBe(LOGIN_HOLDER_LEAVING_STATUS);
    expect(b.fire()).toBe(LOGIN_HOLDER_RETRY_DELAYS_MS[0]);
    expect(b.logins).toBe(1);
    // Seedsow still holds the account a moment: refused the same way, quietly.
    expect(b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT)).toBe(true);
    expect(b.fire()).toBe(LOGIN_HOLDER_RETRY_DELAYS_MS[1]);
    expect(b.logins).toBe(2);
    b.wait.end();
    expect([b.pending, b.refused, b.passed]).toEqual([0, [], 0]);
    expect(b.reports).toEqual(['offer-logon-failed', 'logged-out']);
  });

  it('Yes, and the refusals go on (a wrong password after all): bounded, then the usual way (no loop, never asked again)', async () => {
    const { b } = seedsow();
    b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT);
    await flush();
    b.offers[0].answer(true);
    let handled = true;
    while (b.fire() >= 0) handled = b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT);
    expect(handled).toBe(false); // the last refusal: main.ts goes on with the case retry, quiet retries, retail's text
    expect(b.logins).toBe(LOGIN_HOLDER_RETRY_DELAYS_MS.length);
    expect(b.reports.at(-1)).toBe('spent');
    expect(b.wait.retrying).toBe(false);
    expect(b.wait.heldByTab).toBe(true); // for those refusals' telemetry
    expect(b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT)).toBe(false);
    expect([b.offers.length, b.refused, b.pending]).toEqual([1, [], 0]);
  });

  it('a resume of our own dropped session never asks', async () => {
    const { a, b } = seedsow();
    b.resuming = true;
    expect(b.wait.onRefused(LOGON_FAILED, LOGON_FAILED_TEXT)).toBe(false);
    await flush();
    expect([b.offers, b.passed, b.reports, a.loggedOut]).toEqual([[], 0, [], []]);
  });

  it('end to end: GDL\'s STR_LOGIN_FAILED (real ClientConnection) and the AC1999 server\'s (Connection1999) bring the offer up; neither claims', async () => {
    quiet();
    for (const era of ['gdl', 'ac1999'] as const) {
      const { a, b } = seedsow();
      const conn = era === 'gdl' ? new ClientConnection(SEEDSOW) : new Connection1999(SEEDSOW);
      b.tab.guard.watch(conn, () => accountSessionKey(SEEDSOW, 'jake'));
      const events: ConnectionEvent[] = [];
      conn.on((e) => events.push(e));
      conn.connect('jake', 'pw');
      const sock = FakeSocket.sockets[FakeSocket.sockets.length - 1];
      sock.open();
      sock.deliver(era === 'gdl' ? gdleRefusal(STR_LOGIN_FAILED) : refusal1999(STR_LOGIN_FAILED));
      const err = events.find((e) => e.type === 'error');
      const notice = serverNetErrorNotice(err!.serverNetError!.stringId, err!.serverNetError!.tableId);
      expect(b.wait.onRefused(notice.token, notice.text)).toBe(true);
      await flush();
      expect(b.offers).toHaveLength(1);
      expect([a.stoodDown, b.tab.guard.heldKey]).toEqual([0, null]);
      conn.disconnect();
    }
  });

  it('telemetry: heldByTab on login_refused / login_retry when a tab held it, kept by the bridge; absent otherwise', () => {
    const sent: unknown[] = [];
    const r = new PreworldReporter({
      endpoint: 'https://bridge.example/client-preworld', build: 'abc1234', era: () => 'classic-dereth-1-0', server: () => 'seedsow',
      screen: () => 'connecting', now: () => 1000, trace: 'feedc0de12345678', send: (_u, raw) => sent.push(JSON.parse(raw)),
    });
    const ev = { serverNetError: { stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS } };
    r.loginHeld('offer-logon-failed');
    r.loginRetry(ev, LOGON_FAILED, 1, 'case_verbatim', { heldByTab: true });
    r.connectionError(ev, LOGON_FAILED, { heldByTab: true });
    r.loginRetry(ev, LOGON_FAILED, 1, 'first_time');
    r.connectionError(ev, LOGON_FAILED);
    const kept = sent.map((x) => sanitizeClientPreworld(x));
    expect(kept.map((e) => [e?.outcome, e?.token, e?.heldByTab])).toEqual([
      ['login_held', 'offer_logon_failed', undefined],
      ['login_retry', LOGON_FAILED, true],
      ['login_refused', LOGON_FAILED, true],
      ['login_retry', LOGON_FAILED, undefined],
      ['login_refused', LOGON_FAILED, undefined],
    ]);
    expect(kept[2]).toMatchObject({ code: STR_LOGIN_FAILED, table: ST_SERVER_ERRORS });
    expect('heldByTab' in (sent[4] as object)).toBe(false);
    // The bridge keeps only exactly true, and only on those two outcomes.
    expect(sanitizeClientPreworld({ outcome: 'login_refused', heldByTab: 'yes' })?.heldByTab).toBeUndefined();
    expect(sanitizeClientPreworld({ outcome: 'login_refused', heldByTab: 1 })?.heldByTab).toBeUndefined();
    expect(sanitizeClientPreworld({ outcome: 'char_list', heldByTab: true })?.heldByTab).toBeUndefined();
    expect(sanitizeClientPreworld({ outcome: 'login_retry', heldByTab: true })?.heldByTab).toBe(true);
  });
});

describe('BUG.second-tab-login-refusal — telemetry', () => {
  it('login_held carries what happened, and the bridge keeps it', () => {
    const sent: unknown[] = [];
    const r = new PreworldReporter({
      endpoint: 'https://bridge.example/client-preworld', build: 'abc1234', era: () => 'eor', server: () => 'reefcull',
      screen: () => 'connecting', now: () => 1000, trace: 'feedc0de12345678', send: (_u, raw) => sent.push(JSON.parse(raw)),
    });
    for (const kind of ['none', 'offer-logout', 'logged-out', 'kept', 'spent', 'silent-none', 'silent-offer'] as const) r.loginHeld(kind);
    const kept = sent.map((b) => sanitizeClientPreworld(b));
    expect(kept.map((e) => [e?.outcome, e?.token])).toEqual([
      ['login_held', 'none'], ['login_held', 'offer_logout'], ['login_held', 'logged_out'], ['login_held', 'kept'], ['login_held', 'spent'],
      ['login_held', 'silent_none'], ['login_held', 'silent_offer'],
    ]);
  });
});

describe('BUG.second-tab-login-refusal — texts', () => {
  it('offer, kept and stood-down texts', () => {
    expect(loginHolderOfferText({ tab: 't', character: null, sameAccount: true })).toContain(', in the world.');
    expect(loginHolderOfferText({ tab: 't', character: null, sameAccount: true, inWorld: false })).toContain(', at character select.');
    const retailLogon = characterErrorNotice(CharacterError.Logon).text.split('\n\n')[0];
    expect(stoodDownForOtherTabText(retailLogon)).toBe(`${retailLogon}\n\nThis account logged in in another tab of this browser.`);
    expect(stoodDownForOtherTabText(retailLogon)).not.toContain(ACCOUNT_IN_USE_HINT);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'requestAnimationFrame'] as const;

describe('BUG.second-tab-login-refusal — the Yes / No over the connecting screen (GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  beforeAll(() => installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions'));
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('shows the offer over Please Wait, answers once, and the status line says the other tab is logging out', async () => {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new mod.GameUI(container);
    ui.showConnectingScreen();
    const answers: boolean[] = [];
    const text = loginHolderOfferText({ tab: 't', character: 'Mira', sameAccount: true, inWorld: true });
    ui.showConfirmationDialog(text, (yes) => answers.push(yes));
    expect(domWindow.document.body.textContent).toContain('Log out that tab and log in here?');
    const yes = [...domWindow.document.querySelectorAll('*')].find((el: HTMLElement) => el.textContent === 'Yes' && el.children.length === 0);
    expect(yes).toBeTruthy();
    (yes as HTMLElement).click();
    expect(answers.length).toBe(1);
    expect(domWindow.document.body.textContent).not.toContain('Log out that tab and log in here?');
    ui.setConnectingStatus(LOGIN_HOLDER_LEAVING_STATUS);
    expect(domWindow.document.body.textContent).toContain('Logging out the other tab');
  });
});
