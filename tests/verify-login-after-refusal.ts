/**
 * OBS.login-after-refusal — Seedsow (GDL, Dark Majesty era) 2026-11-06,
 * trace 29fd587793b6f738: a first-time login refused with "Client logon
 * failed", its two first_time retries refused too, left_for_launcher, then
 * the same page got in 10–80 s later with char_list count=0. Was it the same
 * account and password (a server flake), or a changed one (a taken name, a
 * typo)? char_list now carries afterRefusal { sameAccount, samePassword,
 * sinceRefusedMs, refusals } from in-memory salted digests.
 *
 * The tests drive the real connections of all three eras (ACE and GDLE on
 * ClientConnection, the AC1999 server on Connection1999) through the real
 * reportConnectAttempts wrapper main.ts uses, the real LoginRefusalMemory,
 * PreworldReporter and the bridge sanitizer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientConnection } from '../packages/network/src/index.js';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import {
  LoginRefusalMemory, AFTER_REFUSAL_WINDOW_MS,
} from '../packages/renderer/src/session/LoginRefusalMemory.js';
import { webCryptoDigest } from '../packages/renderer/src/session/ProvenLoginRetry.js';
import { PreworldReporter, reportConnectAttempts, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld, afterRefusalField } from '../services/ws-tcp-bridge/src/clientPreworld.js';

const STR_LOGIN_FAILED = 0x04DF9C54;
const ST_SERVER_ERRORS = 8;
const LOGON_FAILED = 'ID_ConnectionError_ClientLogOnFailed';
const ACCOUNT = 'SeedsowNewbie';
/** AC1999's LoginRequest keeps 20 bytes of "account:password" (Login1999.ts): short enough to stay whole. */
const SHORT_ACCOUNT = 'Newb';
const PASSWORD = 'correct-horse-77';
const SEEDSOW = 'wss://bridge.example/?server=394c58d0';
const OTHER_WORLD = 'wss://bridge.example/?server=coldeve';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: FakeSocket[] = [];
  readyState = 1;
  binaryType = '';
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer | string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.sockets.push(this); }
  send(b: Uint8Array): void { this.sent.push(new Uint8Array(b)); }
  close(): void { this.readyState = 3; this.onclose?.(); }
}

const g = globalThis as { WebSocket?: unknown };
let savedWs: unknown;
beforeEach(() => {
  savedWs = g.WebSocket; g.WebSocket = FakeSocket; FakeSocket.sockets = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { g.WebSocket = savedWs; vi.restoreAllMocks(); });

type Conn = ClientConnection | Connection1999;
type Lane = { name: string; era: string; make: () => Conn; refuse: (r: PreworldReporter) => void };
const netRefusal = (r: PreworldReporter): void => {
  r.connectionError({ serverNetError: { stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS } }, LOGON_FAILED);
};
const LANES: Lane[] = [
  {
    name: 'end of retail (ACE, ClientConnection: a wrong password is an AccountBoot)', era: 'end-of-retail',
    make: () => { const c = new ClientConnection('ws://bridge'); c.autoReconnect = false; return c; },
    refuse: (r) => r.accountBoot('Account password mismatch'),
  },
  {
    name: 'Dark Majesty (GDL / GDLE, ClientConnection)', era: 'classic-dereth-1-0',
    make: () => { const c = new ClientConnection('ws://bridge'); c.autoReconnect = false; return c; },
    refuse: netRefusal,
  },
  { name: 'AC1999 (Connection1999)', era: 'ac1999', make: () => new Connection1999('ws://bridge'), refuse: netRefusal },
];

/** main.ts's wiring minus the DOM: the wrapper digests each attempt, the reporter tells the memory of refusals. */
function rig(lane: Lane, opts: { endpoint?: string | null } = {}) {
  let clock = 1_000_000;
  let world = SEEDSOW;
  const memory = new LoginRefusalMemory({ digest: webCryptoDigest('page-salt'), now: () => clock });
  const raw: string[] = [];
  const reporter = new PreworldReporter({
    endpoint: opts.endpoint === undefined ? 'http://x/client-preworld' : opts.endpoint,
    build: 'b1', era: () => lane.era, server: () => '394c58d0', screen: () => 'connecting',
    now: () => clock, trace: 'feedc0de12345678', loginRefusals: memory,
    send: (_u, body) => { raw.push(body); },
  });
  const conn = lane.make();
  const pending: Promise<void>[] = [];
  reportConnectAttempts(conn, (account, password) => {
    reporter.connectAttempt();
    pending.push(memory.attempt(world, account, password));
  });
  /** One login: connect with these credentials, open the socket (the LoginRequest goes out). */
  const login = async (account: string, password: string): Promise<void> => {
    conn.connect(account, password);
    FakeSocket.sockets[FakeSocket.sockets.length - 1].onopen?.();
    reporter.loginStarted();
    await Promise.all(pending);
  };
  const charList = (count = 0): PreworldEvent => {
    reporter.characterList(count);
    return JSON.parse(raw[raw.length - 1]) as PreworldEvent;
  };
  /** The password case the connection puts on the wire (main.ts syncLoginProfile, LoginCaseFallback). */
  const setCase = (passwordCase: 'lower' | 'verbatim'): void => { conn.loginProfile = { ...conn.loginProfile, passwordCase }; };
  /** Whether the latest socket's LoginRequest carries `text` (ASCII) anywhere. */
  const wireHas = (text: string): boolean => {
    const sock = FakeSocket.sockets[FakeSocket.sockets.length - 1];
    const needle = Buffer.from(text, 'latin1');
    return sock.sent.some((b) => Buffer.from(b).includes(needle));
  };
  return {
    reporter, raw, conn, login, charList, setCase, wireHas,
    advance: (ms: number) => { clock += ms; },
    setWorld: (w: string) => { world = w; },
    refuse: () => lane.refuse(reporter),
  };
}

describe.each(LANES)('OBS.login-after-refusal — $name', (lane) => {
  it('the trace shape: refused three times, then the same credentials get in → same account and password', async () => {
    const t = rig(lane);
    for (let i = 0; i < 3; i++) {
      await t.login(ACCOUNT, PASSWORD);
      t.refuse();
      t.advance(i < 2 ? 3000 : 0);
    }
    t.advance(20_000);
    await t.login(ACCOUNT, PASSWORD);
    const ev = t.charList(0);
    expect(ev.outcome).toBe('char_list');
    expect(ev.afterRefusal).toEqual({ sameAccount: true, samePassword: true, sinceRefusedMs: 20_000, refusals: 3 });
    expect(sanitizeClientPreworld(ev)?.afterRefusal).toEqual(ev.afterRefusal);
    t.conn.disconnect();
  });

  it('the account compares case-insensitively; a changed account reads sameAccount false', async () => {
    const t = rig(lane);
    await t.login(ACCOUNT, PASSWORD);
    t.refuse();
    t.advance(5000);
    await t.login(ACCOUNT.toUpperCase(), PASSWORD);
    expect(t.charList().afterRefusal).toMatchObject({ sameAccount: true, samePassword: true, refusals: 1 });

    await t.login(ACCOUNT, PASSWORD);
    t.refuse();
    t.advance(5000);
    await t.login('SeedsowNewbie2', PASSWORD);
    expect(t.charList().afterRefusal).toEqual({ sameAccount: false, samePassword: true, sinceRefusedMs: 5000, refusals: 1 });
    t.conn.disconnect();
  });

  it('a changed password reads samePassword false (case matters for the password)', async () => {
    const t = rig(lane);
    await t.login(ACCOUNT, PASSWORD);
    t.refuse();
    t.advance(40_000);
    await t.login(ACCOUNT, PASSWORD.toUpperCase());
    expect(t.charList().afterRefusal).toEqual({ sameAccount: true, samePassword: false, sinceRefusedMs: 40_000, refusals: 1 });
    t.conn.disconnect();
  });

  it('compares against the latest refused attempt, counting all of them', async () => {
    const t = rig(lane);
    await t.login(ACCOUNT, 'typo');
    t.refuse();
    t.advance(1000);
    await t.login(ACCOUNT, PASSWORD);
    t.refuse();
    t.advance(1000);
    await t.login(ACCOUNT, PASSWORD);
    expect(t.charList().afterRefusal).toEqual({ sameAccount: true, samePassword: true, sinceRefusedMs: 1000, refusals: 2 });
    t.conn.disconnect();
  });

  it('a refusal more than 10 minutes before the character list: no field', async () => {
    const t = rig(lane);
    await t.login(ACCOUNT, PASSWORD);
    t.refuse();
    t.advance(AFTER_REFUSAL_WINDOW_MS + 1);
    await t.login(ACCOUNT, PASSWORD);
    const ev = t.charList();
    expect(ev).not.toHaveProperty('afterRefusal');
    expect(sanitizeClientPreworld(ev)).not.toHaveProperty('afterRefusal');
    t.conn.disconnect();
  });

  it('a refusal on another world: no field', async () => {
    const t = rig(lane);
    t.setWorld(OTHER_WORLD);
    await t.login(ACCOUNT, PASSWORD);
    t.refuse();
    t.advance(5000);
    t.setWorld(SEEDSOW);
    await t.login(ACCOUNT, PASSWORD);
    expect(t.charList()).not.toHaveProperty('afterRefusal');
    t.conn.disconnect();
  });

  it('reported once: a later character list (after a logoff, or the next login) has no field', async () => {
    const t = rig(lane);
    await t.login(ACCOUNT, PASSWORD);
    t.refuse();
    await t.login(ACCOUNT, PASSWORD);
    expect(t.charList()).toHaveProperty('afterRefusal');
    expect(t.charList()).not.toHaveProperty('afterRefusal');
    await t.login(ACCOUNT, PASSWORD);
    expect(t.charList()).not.toHaveProperty('afterRefusal');
    t.conn.disconnect();
  });

  it('BUG.login-credential-case: a case_verbatim retry that gets in is not "after a refusal" (its refusal is the page trying the case)', async () => {
    const t = rig(lane);
    t.setCase('lower');
    await t.login(SHORT_ACCOUNT, 'HunterTwo');
    expect(t.wireHas('huntertwo')).toBe(true);
    t.reporter.loginRetry({ serverNetError: { stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS } }, LOGON_FAILED, 1, 'case_verbatim');
    t.setCase('verbatim');
    await t.login(SHORT_ACCOUNT, 'HunterTwo');
    expect(t.wireHas('HunterTwo')).toBe(true);
    expect(t.charList()).not.toHaveProperty('afterRefusal');
    t.conn.disconnect();
  });

  it('BUG.login-credential-case: samePassword compares the password as typed, not its wire case', async () => {
    const t = rig(lane);
    // Refused lowercased, the as-typed retry refused too (counted: login_refused), the page gives up.
    t.setCase('lower');
    await t.login(SHORT_ACCOUNT, 'HunterTwo');
    t.reporter.loginRetry({ serverNetError: { stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS } }, LOGON_FAILED, 1, 'case_verbatim');
    t.setCase('verbatim');
    await t.login(SHORT_ACCOUNT, 'HunterTwo');
    t.refuse();
    // A later ENTER starts lowercase again; the same typed password gets in with another wire form.
    t.advance(30_000);
    t.setCase('lower');
    await t.login(SHORT_ACCOUNT, 'HunterTwo');
    expect(t.wireHas('huntertwo')).toBe(true);
    expect(t.charList().afterRefusal).toEqual({ sameAccount: true, samePassword: true, sinceRefusedMs: 30_000, refusals: 1 });
    t.conn.disconnect();
  });

  it('BUG.login-credential-case: a case_lower retry is not counted either', async () => {
    const t = rig(lane);
    await t.login(ACCOUNT, PASSWORD);
    t.reporter.loginRetry({ serverNetError: { stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS } }, LOGON_FAILED, 1, 'case_lower');
    await t.login(ACCOUNT, PASSWORD);
    expect(t.charList()).not.toHaveProperty('afterRefusal');
    t.conn.disconnect();
  });

  it('no login without a refusal carries it', async () => {
    const t = rig(lane);
    await t.login(ACCOUNT, PASSWORD);
    expect(t.charList()).not.toHaveProperty('afterRefusal');
    t.conn.disconnect();
  });

  it('nothing sent contains the account or the password, in any case', async () => {
    const t = rig(lane);
    await t.login(ACCOUNT, PASSWORD);
    t.refuse();
    await t.login(ACCOUNT, 'other-pass-99');
    t.charList();
    expect(t.raw.length).toBeGreaterThanOrEqual(2);
    const all = t.raw.join('\n').toLowerCase();
    for (const secret of [ACCOUNT, PASSWORD, 'other-pass-99']) expect(all).not.toContain(secret.toLowerCase());
    t.conn.disconnect();
  });
});

describe('OBS.login-after-refusal — the memory', () => {
  it('a login_retry refusal counts too, and refusals are noted even with no endpoint', async () => {
    const t = rig(LANES[1], { endpoint: null });
    await t.login(ACCOUNT, PASSWORD);
    t.reporter.loginRetry({ serverNetError: { stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS } }, LOGON_FAILED, 1, 'first_time');
    t.advance(3000);
    await t.login(ACCOUNT, PASSWORD);
    t.refuse();
    t.advance(3000);
    const memory = (t.reporter as unknown as { opts: { loginRefusals: LoginRefusalMemory } }).opts.loginRefusals;
    await t.login(ACCOUNT, PASSWORD);
    expect(memory.accepted()).toEqual({ sameAccount: true, samePassword: true, sinceRefusedMs: 3000, refusals: 2 });
    expect(t.raw).toEqual([]);
    t.conn.disconnect();
  });

  it('without WebCrypto nothing is compared: no field', async () => {
    let clock = 0;
    const m = new LoginRefusalMemory({ digest: async () => null, now: () => clock });
    await m.attempt(SEEDSOW, ACCOUNT, PASSWORD);
    m.refused();
    clock += 1000;
    await m.attempt(SEEDSOW, ACCOUNT, PASSWORD);
    expect(m.accepted()).toBeNull();
  });

  it('a digest not finished when the list arrives: no field (never a wrong answer)', async () => {
    const m = new LoginRefusalMemory({ digest: webCryptoDigest('s'), now: () => 0 });
    await m.attempt(SEEDSOW, ACCOUNT, PASSWORD);
    m.refused();
    const late = m.attempt(SEEDSOW, ACCOUNT, PASSWORD);
    expect(m.accepted()).toBeNull();
    await late;
  });

  it('keeps no credential text: its state holds only digests', async () => {
    const m = new LoginRefusalMemory({ digest: webCryptoDigest('s'), now: () => 0 });
    await m.attempt(SEEDSOW, ACCOUNT, PASSWORD);
    m.refused();
    const state = JSON.stringify(m, (_k, v) => (typeof v === 'function' ? undefined : v)).toLowerCase();
    expect(state).not.toContain(ACCOUNT.toLowerCase());
    expect(state).not.toContain(PASSWORD.toLowerCase());
  });
});

describe('OBS.login-after-refusal — the bridge sanitizer', () => {
  const ok = { sameAccount: true, samePassword: false, sinceRefusedMs: 20_000, refusals: 3 };
  const base = { outcome: 'char_list', count: 0, trace: 'feedc0de12345678' };

  it('keeps a valid field on char_list only', () => {
    expect(sanitizeClientPreworld({ ...base, afterRefusal: ok })?.afterRefusal).toEqual(ok);
    expect(sanitizeClientPreworld({ ...base, outcome: 'login_refused', afterRefusal: ok })).not.toHaveProperty('afterRefusal');
  });

  it('drops malformed values whole', () => {
    for (const bad of [
      null, 'yes', [ok], 42,
      { ...ok, sameAccount: 'true' },
      { ...ok, samePassword: 1 },
      { ...ok, sinceRefusedMs: -1 },
      { ...ok, sinceRefusedMs: 1.5 },
      { ...ok, sinceRefusedMs: 16 * 60_000 },
      { ...ok, refusals: 0 },
      { ...ok, refusals: 1001 },
      { ...ok, refusals: '3' },
      { ...ok, account: 'SeedsowNewbie' },
      { sameAccount: true, samePassword: true, sinceRefusedMs: 5 },
    ]) {
      expect(afterRefusalField(bad)).toEqual({});
      expect(sanitizeClientPreworld({ ...base, afterRefusal: bad })).not.toHaveProperty('afterRefusal');
    }
  });
});
