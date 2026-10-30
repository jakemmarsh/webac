/**
 * BUG.gdle-transient-login-failed — production 2026-10-17 (Seedsow, Dark
 * Majesty era): GDLE answered a CORRECT login with STR_LOGIN_FAILED
 * ("Client logon failed", 0x04DF9C54 in table 8). One player logged out at
 * 16:52:31, was refused at 16:52:35 and got in at 16:52:43 with the same
 * credentials; another was refused twice, then got in a minute later. GDLE
 * sends it whenever VerifyAccount fails (ClassicDereth Network.cpp
 * AuthenticateUserQuery::PerformQuery), its own database query included.
 *
 * Now a login this page already got in with (same world + account +
 * password) retries on its own at 3 s and 6 s behind the connecting screen
 * (session/ProvenLoginRetry.ts); a first-time login is refused at once. Each
 * retry sends login_retry, which the bridge keeps.
 *
 * The tests drive the real connections (ClientConnection for GDLE,
 * Connection1999 for the AC1999 server) with the servers' refusal bytes, the
 * real ConnectionNotices resolution the page uses, and the real helper, the
 * reporter and the bridge sanitizer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientConnection, PACKET_HEADER_SIZE, type ConnectionEvent } from '../packages/network/src/index.js';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { buildPacket1999 } from '../packages/network/src/era1999/Packet1999.js';
import { connectionFailureNotice, characterErrorNotice, netErrorNotice } from '../packages/renderer/src/ui/ConnectionNotices.js';
import {
  ProvenLoginRetry, provenLoginRetryDelay, webCryptoDigest, firstTimeLoginRetryAllowed,
  PROVEN_LOGIN_RETRY_DELAYS_MS, RETRYABLE_LOGIN_REFUSAL_TOKENS,
  type LoginCredentials,
} from '../packages/renderer/src/session/ProvenLoginRetry.js';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld, PREWORLD_OUTCOMES, LOGIN_RETRY_KINDS } from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { buildDirectory } from '../services/ws-tcp-bridge/src/serverDirectory.js';
import type { ServerEntry } from '../services/ws-tcp-bridge/src/serverList.js';
import {
  worldFromEntry, loginFailureText, localWorld, LOGON_FAILED_HINT, type World,
} from '../packages/renderer/src/launcher/worldDirectory.js';
import { CharacterError } from '../packages/shared/src/index.js';

// NetworkDefs.h (GDLE and the AC1999 server)
const BT_NETERROR = 0x00100000;
const ST_SERVER_ERRORS = 8;
const STR_LOGIN_FAILED = 0x04DF9C54;
const STR_LOGIN_SERVER_FULL = 0x00F9982C;
const STR_LOGIN_ACCOUNT_ONLINE = 0x0C559B1E;
const SERVER_ID = 0x0b;

/** crc.cpp GetMagicNumber. */
function magic(b: Uint8Array, size: number): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let cs = (size << 16) >>> 0;
  let i = 0;
  for (; i < size >> 2; i++) cs = (cs + v.getUint32(i * 4, true)) >>> 0;
  let shift = 3;
  for (i <<= 2; i < size; i++) { cs = (cs + (b[i] << (shift * 8))) >>> 0; shift--; }
  return cs;
}

/** GDLE CNetwork::SendConnectLoginFailure (end-of-retail framing). */
function gdleRefusal(error: number): Uint8Array {
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

/** The AC1999 server's SendConnectLoginFailure (1999 framing). */
function refusal1999(error: number): Uint8Array {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setUint32(0, error >>> 0, true);
  new DataView(body.buffer).setUint32(4, ST_SERVER_ERRORS, true);
  return buildPacket1999({ sequence: 0, flags: BT_NETERROR, recipient: SERVER_ID, time: 0, body });
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
beforeEach(() => {
  savedWs = g.WebSocket; g.WebSocket = FakeSocket; FakeSocket.sockets = [];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { g.WebSocket = savedWs; vi.restoreAllMocks(); });

const WORLD = 'wss://bridge.example/?server=seedsow';
const GOOD: LoginCredentials = { world: WORLD, account: 'jake', password: 'hunter2' };

type Lane = { name: string; make: () => ClientConnection | Connection1999; refusal: (e: number) => Uint8Array };
const LANES: Lane[] = [
  { name: 'GDLE (Dark Majesty, ClientConnection)', make: () => { const c = new ClientConnection('ws://bridge'); c.autoReconnect = false; return c; }, refusal: gdleRefusal },
  { name: 'AC1999 server (Connection1999)', make: () => new Connection1999('ws://bridge'), refusal: refusal1999 },
];

/**
 * main.ts's loop, minus the DOM: each login attempt opens a socket, the server
 * answers with `answers[i]` (a NetError id, or 'ok'), a refusal goes through
 * connectionFailureNotice → ProvenLoginRetry.onRefused, and a retry verdict
 * connects again. Returns what the player ends up with. `world` is the
 * launcher world (main.ts launcherWorld): it decides the first-time retry
 * (firstTimeLoginRetryAllowed) and the shown dialog's text (loginFailureText).
 */
async function drive(lane: Lane, helper: ProvenLoginRetry, creds: LoginCredentials, answers: Array<number | 'ok'>, world: World | null = null) {
  const conn = lane.make();
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  const delays: number[] = [];
  const kinds: string[] = [];
  let shown: string | null = null;
  let text: string | null = null;
  let accepted = false;
  const firstTime = firstTimeLoginRetryAllowed(world);
  conn.connect(creds.account, creds.password);
  for (let i = 0; ; i++) {
    const sock = FakeSocket.sockets[FakeSocket.sockets.length - 1];
    sock.onopen?.();
    const answer = answers[Math.min(i, answers.length - 1)];
    if (answer === 'ok') {
      accepted = true;
      await helper.noteAccepted(creds);
      break;
    }
    const before = events.length;
    sock.deliver(lane.refusal(answer));
    const err = events.slice(before).find((e) => e.type === 'error');
    expect(err?.serverNetError).toEqual({ stringId: answer >>> 0, tableId: ST_SERVER_ERRORS });
    const notice = connectionFailureNotice(err!)!;
    const verdict = await helper.onRefused(creds, notice.token, { firstTime });
    if (!verdict.retry) { shown = notice.token; text = loginFailureText(notice, world, false); break; }
    expect(verdict.attempt).toBe(delays.length + 1);
    delays.push(verdict.delayMs);
    kinds.push(verdict.kind);
    conn.connect(creds.account, creds.password); // the page's timer firing
  }
  conn.disconnect();
  return { delays, kinds, shown, text, accepted, sockets: FakeSocket.sockets.length };
}

describe('BUG.gdle-transient-login-failed — the decision', () => {
  it('retries only the ClientLogOnFailed refusal of a proven login, at 3 s then 6 s', () => {
    expect(PROVEN_LOGIN_RETRY_DELAYS_MS).toEqual([3000, 6000]);
    expect([...RETRYABLE_LOGIN_REFUSAL_TOKENS]).toEqual(['ID_ConnectionError_ClientLogOnFailed']);
    const t = 'ID_ConnectionError_ClientLogOnFailed';
    expect(provenLoginRetryDelay({ token: t, proven: true, retriesSoFar: 0 })).toBe(3000);
    expect(provenLoginRetryDelay({ token: t, proven: true, retriesSoFar: 1 })).toBe(6000);
    expect(provenLoginRetryDelay({ token: t, proven: true, retriesSoFar: 2 })).toBeNull();
    // A first-time login (a typo) is never delayed.
    expect(provenLoginRetryDelay({ token: t, proven: false, retriesSoFar: 0 })).toBeNull();
    // Account in use, server full, timeouts, ACE's CharacterErrors: shown as before.
    for (const token of [
      netErrorNotice('ID_ConnectionError_PlayerAlreadyLoggedOn').token,
      netErrorNotice('ID_ConnectionError_ServerFull').token,
      netErrorNotice('ID_ConnectionError_ClientTimedOutServer').token,
      netErrorNotice('ID_NetError_CantSocket').token,
      characterErrorNotice(CharacterError.Logon).token,
      characterErrorNotice(CharacterError.AccountDoesntExist).token,
      null,
    ]) {
      expect(provenLoginRetryDelay({ token, proven: true, retriesSoFar: 0 })).toBeNull();
    }
  });

  it('keeps no password: only a salted digest, different per page', async () => {
    const a = webCryptoDigest('salt-a');
    const b = webCryptoDigest('salt-b');
    const da = await a('x\u0000jake\u0000hunter2');
    expect(da).toMatch(/^[0-9a-f]{64}$/);
    expect(da).not.toContain('hunter2');
    expect(await a('x\u0000jake\u0000hunter2')).toBe(da);
    expect(await b('x\u0000jake\u0000hunter2')).not.toBe(da);
  });

  it('without WebCrypto nothing is proven: every refusal is shown at once', async () => {
    const h = new ProvenLoginRetry({ digest: async () => null });
    await h.noteAccepted(GOOD);
    expect(await h.onRefused(GOOD, 'ID_ConnectionError_ClientLogOnFailed')).toEqual({ retry: false });
  });
});

describe.each(LANES)('BUG.gdle-transient-login-failed — $name', (lane) => {
  it('a first-time login refused with STR_LOGIN_FAILED is shown at once (one socket, no retry)', async () => {
    const r = await drive(lane, new ProvenLoginRetry(), GOOD, [STR_LOGIN_FAILED]);
    expect(r).toMatchObject({ delays: [], shown: 'ID_ConnectionError_ClientLogOnFailed', accepted: false, sockets: 1 });
  });

  it('a proven login refused once retries after 3 s and gets in (the 16:52:35 → 16:52:43 case)', async () => {
    const h = new ProvenLoginRetry();
    expect((await drive(lane, h, GOOD, ['ok'])).accepted).toBe(true);
    FakeSocket.sockets = [];
    const r = await drive(lane, h, GOOD, [STR_LOGIN_FAILED, 'ok']);
    expect(r).toMatchObject({ delays: [3000], shown: null, accepted: true, sockets: 2 });
    expect(h.retriesSoFar).toBe(0);
  });

  it('a proven login refused three times retries at 3 s and 6 s, then shows today\'s error; the next try is not delayed', async () => {
    const h = new ProvenLoginRetry();
    await drive(lane, h, GOOD, ['ok']);
    FakeSocket.sockets = [];
    const r = await drive(lane, h, GOOD, [STR_LOGIN_FAILED, STR_LOGIN_FAILED, STR_LOGIN_FAILED]);
    expect(r).toMatchObject({ delays: [3000, 6000], shown: 'ID_ConnectionError_ClientLogOnFailed', accepted: false, sockets: 3 });
    FakeSocket.sockets = [];
    const again = await drive(lane, h, GOOD, [STR_LOGIN_FAILED]);
    expect(again).toMatchObject({ delays: [], shown: 'ID_ConnectionError_ClientLogOnFailed', sockets: 1 });
  });

  it('a different password, account or world is not proven: a typo after a good login is shown at once', async () => {
    const h = new ProvenLoginRetry();
    await drive(lane, h, GOOD, ['ok']);
    for (const creds of [
      { ...GOOD, password: 'hunter3' },
      { ...GOOD, account: 'jake2' },
      { ...GOOD, world: 'wss://bridge.example/?server=snowreap' },
    ]) {
      FakeSocket.sockets = [];
      expect(await drive(lane, h, creds, [STR_LOGIN_FAILED])).toMatchObject({ delays: [], sockets: 1 });
    }
    // The proven one still retries.
    FakeSocket.sockets = [];
    expect((await drive(lane, h, GOOD, [STR_LOGIN_FAILED, 'ok'])).delays).toEqual([3000]);
  });

  it('server full and account online are never retried, even for a proven login', async () => {
    const h = new ProvenLoginRetry();
    await drive(lane, h, GOOD, ['ok']);
    for (const err of [STR_LOGIN_SERVER_FULL, STR_LOGIN_ACCOUNT_ONLINE]) {
      FakeSocket.sockets = [];
      expect(await drive(lane, h, GOOD, [err])).toMatchObject({ delays: [], sockets: 1 });
    }
  });
});

describe('BUG.gdle-transient-login-failed — a cancelled cycle starts counting afresh', () => {
  it('cancel() after one retry gives the next refusal both retries again', async () => {
    const h = new ProvenLoginRetry();
    await h.noteAccepted(GOOD);
    expect(await h.onRefused(GOOD, 'ID_ConnectionError_ClientLogOnFailed')).toEqual({ retry: true, attempt: 1, delayMs: 3000, kind: 'proven' });
    h.cancel();
    expect(await h.onRefused(GOOD, 'ID_ConnectionError_ClientLogOnFailed')).toEqual({ retry: true, attempt: 1, delayMs: 3000, kind: 'proven' });
    expect(await h.onRefused(GOOD, 'ID_ConnectionError_ClientLogOnFailed')).toEqual({ retry: true, attempt: 2, delayMs: 6000, kind: 'proven' });
  });

  it('a refusal that lands while the acceptance is still being digested waits for it', async () => {
    const h = new ProvenLoginRetry();
    void h.noteAccepted(GOOD); // not awaited: main.ts fires and forgets
    expect((await h.onRefused(GOOD, 'ID_ConnectionError_ClientLogOnFailed')).retry).toBe(true);
  });
});

describe('BUG.gdle-transient-login-failed — telemetry', () => {
  function rig() {
    const sent: PreworldEvent[] = [];
    const r = new PreworldReporter({
      endpoint: 'http://x/client-preworld', build: 'eb3bcb5e', era: () => 'classic-dereth-1-0', server: () => 'seedsow',
      screen: () => 'connecting', chargenStep: () => null, now: () => 10_000, trace: 'feedc0de12345678',
      send: (_u, raw) => { sent.push(JSON.parse(raw) as PreworldEvent); },
    });
    return { r, sent };
  }

  it('login_retry per retry with the attempt, the last refusal login_refused, and the bridge keeps both', () => {
    const { r, sent } = rig();
    const ev = { serverNetError: { stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS } };
    r.loginStarted();
    r.loginRetry(ev, 'ID_ConnectionError_ClientLogOnFailed', 1);
    r.loginStarted();
    r.loginRetry(ev, 'ID_ConnectionError_ClientLogOnFailed', 2);
    r.loginStarted();
    r.connectionError(ev, 'ID_ConnectionError_ClientLogOnFailed');
    expect(sent.map((e) => [e.outcome, e.count])).toEqual([['login_retry', 1], ['login_retry', 2], ['login_refused', null]]);
    expect(PREWORLD_OUTCOMES).toContain('login_retry');
    for (const e of sent) {
      expect(sanitizeClientPreworld(e)).toMatchObject({
        outcome: e.outcome, code: STR_LOGIN_FAILED, table: ST_SERVER_ERRORS, token: 'ID_ConnectionError_ClientLogOnFailed',
        count: e.count, server: 'seedsow', screen: 'connecting',
      });
    }
  });
});

/**
 * UX.gdle-first-login-retry — production 2026-10-26 (Seedsow): a player was
 * refused four times with STR_LOGIN_FAILED and got in on the fifth, the same
 * LoginRequest each time. Nothing was proven on that page, so every refusal
 * was shown. Now a first-time login on a GDL / GDLE world retries quietly at
 * 3 s and 6 s too; register-first GDLE worlds, the AC1999 server, ACE and
 * Custom… / URL logins keep showing it at once.
 *
 * The worlds come through the real pipeline: the bridge's buildDirectory
 * (its compat overlay: Reefcull's registration, AC1999's per-IP caps) → the
 * /servers row → the launcher's worldFromEntry.
 */
describe('UX.gdle-first-login-retry', () => {
  const SERVERS: ServerEntry[] = [
    { id: '394c58d0-885d-466b-b17f-d7e0b96fe3e2', name: 'Seedsow', emu: 'GDLE', host: 'seedsow.example', port: 9000, source: 'list' },
    { id: 'eea962c0-cf9f-481e-9736-0eb058acc1d8', name: 'Snowreap', emu: 'GDLE', host: 'snowreap.example', port: 9000, source: 'list' },
    { id: 'gdl-world', name: 'Some GDL', emu: 'GDL', host: 'gdl.example', port: 9000, source: 'list' },
    { id: 'a7502ac9-0cec-4caf-b81c-b3eb40a4689a', name: 'Reefcull', emu: 'GDLE', host: 'reefcull.example', port: 9000, source: 'list' },
    { id: 'ace-world', name: 'Some ACE', emu: 'ACE', host: 'ace.example', port: 9000, source: 'list' },
    { id: 'ac1999', name: 'AC1999', emu: 'AC1999', host: 'ac1999.example', port: 9000, source: 'overlay' },
  ];
  const WORLDS = new Map<string, World>(
    buildDirectory(SERVERS, new Map(), new Map(), { now: 0 })
      .map((row) => worldFromEntry(JSON.parse(JSON.stringify(row))))
      .filter((w): w is World => w !== null)
      .map((w) => [w.name, w]),
  );
  const world = (name: string): World => WORLDS.get(name)!;
  const GDLE_LANE = LANES[0];
  const LANE_1999 = LANES[1];

  it('the directory gives the worlds what decides it: emu, Reefcull\'s registration, AC1999\'s caps', () => {
    expect(world('Seedsow')).toMatchObject({ emu: 'GDLE', registration: null, registrationUrl: null });
    expect(world('Reefcull').registrationUrl).toMatch(/reefcull/);
    expect(world('AC1999').perIpLimits?.accounts).toBeGreaterThan(0);
    expect(firstTimeLoginRetryAllowed(world('Seedsow'))).toBe(true);
    expect(firstTimeLoginRetryAllowed(world('Snowreap'))).toBe(true);
    expect(firstTimeLoginRetryAllowed(world('Some GDL'))).toBe(true);
    expect(firstTimeLoginRetryAllowed(world('Reefcull'))).toBe(false);
    expect(firstTimeLoginRetryAllowed(world('Some ACE'))).toBe(false);
    expect(firstTimeLoginRetryAllowed(world('AC1999'))).toBe(false);
    expect(firstTimeLoginRetryAllowed(localWorld())).toBe(false);
    expect(firstTimeLoginRetryAllowed(null)).toBe(false);
    // A GDLE world that caps accounts per address: the refusal can be the cap, so no retry.
    expect(firstTimeLoginRetryAllowed({ ...world('Seedsow'), perIpLimits: { accounts: 2, sessions: 0 } })).toBe(false);
  });

  it('a GDLE first-time login refused every time retries at 3 s and 6 s, then shows today\'s error and hint', async () => {
    const r = await drive(GDLE_LANE, new ProvenLoginRetry(), GOOD, [STR_LOGIN_FAILED], world('Seedsow'));
    expect(r).toMatchObject({
      delays: [3000, 6000], kinds: ['first_time', 'first_time'], shown: 'ID_ConnectionError_ClientLogOnFailed', accepted: false, sockets: 3,
    });
    // Exactly today's dialog text for that refusal on that world.
    const notice = netErrorNotice('ID_ConnectionError_ClientLogOnFailed');
    expect(r.text).toBe(loginFailureText(notice, world('Seedsow'), false));
    expect(r.text).toContain(LOGON_FAILED_HINT);
  });

  it('a GDLE first-time login that gets in on a retry enters with no error (the 2026-10-26 Seedsow case)', async () => {
    const h = new ProvenLoginRetry();
    const once = await drive(GDLE_LANE, h, GOOD, [STR_LOGIN_FAILED, 'ok'], world('Seedsow'));
    expect(once).toMatchObject({ delays: [3000], kinds: ['first_time'], shown: null, text: null, accepted: true, sockets: 2 });
    FakeSocket.sockets = [];
    const twice = await drive(GDLE_LANE, h, { ...GOOD, account: 'other' }, [STR_LOGIN_FAILED, STR_LOGIN_FAILED, 'ok'], world('Snowreap'));
    expect(twice).toMatchObject({ delays: [3000, 6000], shown: null, accepted: true, sockets: 3 });
    // Now proven: its next refusal retries as a proven login.
    FakeSocket.sockets = [];
    expect((await drive(GDLE_LANE, h, GOOD, [STR_LOGIN_FAILED, 'ok'], world('Seedsow'))).kinds).toEqual(['proven']);
  });

  it('each of the player\'s own attempts gets the retries again (the player tried five times)', async () => {
    const h = new ProvenLoginRetry();
    expect((await drive(GDLE_LANE, h, GOOD, [STR_LOGIN_FAILED], world('Seedsow'))).delays).toEqual([3000, 6000]);
    FakeSocket.sockets = [];
    expect(await drive(GDLE_LANE, h, GOOD, [STR_LOGIN_FAILED, 'ok'], world('Seedsow'))).toMatchObject({ delays: [3000], accepted: true });
  });

  it('server full and account online are still never retried on a GDLE world', async () => {
    for (const err of [STR_LOGIN_SERVER_FULL, STR_LOGIN_ACCOUNT_ONLINE]) {
      FakeSocket.sockets = [];
      expect(await drive(GDLE_LANE, new ProvenLoginRetry(), GOOD, [err], world('Seedsow'))).toMatchObject({ delays: [], sockets: 1 });
    }
  });

  it('register-first GDLE (Reefcull): a first-time refusal shows the registration hint at once', async () => {
    const r = await drive(GDLE_LANE, new ProvenLoginRetry(), GOOD, [STR_LOGIN_FAILED], world('Reefcull'));
    expect(r).toMatchObject({ delays: [], shown: 'ID_ConnectionError_ClientLogOnFailed', sockets: 1 });
    expect(r.text).toContain('New account? Register on the Reefcull website first');
    // A proven login there still retries, as before.
    const h = new ProvenLoginRetry();
    FakeSocket.sockets = [];
    await drive(GDLE_LANE, h, GOOD, ['ok'], world('Reefcull'));
    FakeSocket.sockets = [];
    expect((await drive(GDLE_LANE, h, GOOD, [STR_LOGIN_FAILED, 'ok'], world('Reefcull'))).kinds).toEqual(['proven']);
  });

  it('AC1999: a first-time refusal shows at once with its per-address text (unchanged)', async () => {
    const r = await drive(LANE_1999, new ProvenLoginRetry(), GOOD, [STR_LOGIN_FAILED], world('AC1999'));
    expect(r).toMatchObject({ delays: [], shown: 'ID_ConnectionError_ClientLogOnFailed', sockets: 1 });
    expect(r.text).toContain('per network address');
  });

  it('ACE, Custom… and URL logins: a first-time refusal shows at once (unchanged)', async () => {
    for (const w of [world('Some ACE'), localWorld(), null]) {
      FakeSocket.sockets = [];
      expect(await drive(GDLE_LANE, new ProvenLoginRetry(), GOOD, [STR_LOGIN_FAILED], w)).toMatchObject({ delays: [], sockets: 1 });
    }
  });

  it('telemetry: login_retry carries retry=first_time, and the bridge keeps it (and drops anything else)', () => {
    const sent: PreworldEvent[] = [];
    const r = new PreworldReporter({
      endpoint: 'http://x/client-preworld', build: 'eb3bcb5e', era: () => 'classic-dereth-1-0', server: () => '394c58d0-885d-466b-b17f-d7e0b96fe3e2',
      screen: () => 'connecting', chargenStep: () => null, now: () => 10_000, trace: 'feedc0de12345678',
      send: (_u, raw) => { sent.push(JSON.parse(raw) as PreworldEvent); },
    });
    const ev = { serverNetError: { stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS } };
    r.loginStarted();
    r.loginRetry(ev, 'ID_ConnectionError_ClientLogOnFailed', 1, 'first_time');
    r.loginRetry(ev, 'ID_ConnectionError_ClientLogOnFailed', 2, 'proven');
    r.connectionError(ev, 'ID_ConnectionError_ClientLogOnFailed');
    expect(sent.map((e) => [e.outcome, e.count, e.retry])).toEqual([
      ['login_retry', 1, 'first_time'], ['login_retry', 2, 'proven'], ['login_refused', null, undefined],
    ]);
    expect([...LOGIN_RETRY_KINDS]).toEqual(['proven', 'first_time']);
    expect(sanitizeClientPreworld(sent[0])).toMatchObject({ outcome: 'login_retry', retry: 'first_time', count: 1, code: STR_LOGIN_FAILED });
    expect(sanitizeClientPreworld(sent[1])).toMatchObject({ retry: 'proven' });
    expect(sanitizeClientPreworld(sent[2])).not.toHaveProperty('retry');
    expect(sanitizeClientPreworld({ ...sent[0], retry: 'hunter2' })).not.toHaveProperty('retry');
    expect(sanitizeClientPreworld({ ...sent[2], retry: 'first_time' })).not.toHaveProperty('retry');
  });
});
