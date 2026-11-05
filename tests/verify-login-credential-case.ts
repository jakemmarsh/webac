/**
 * BUG.login-credential-case — players on Reefcull (GDL) reported that
 * mixed-case credentials that work through ThwargLauncher failed in webAC,
 * while the same ones typed lowercase worked.
 *
 * Retail lowercases its whole `-a` argument (end of retail: `_strlwr` in
 * Client::EvaluateCommandLineArg @ 0x004124f0; 1999: the tolower copy @
 * 0x00402380) and keeps `-v` as typed. ThwargLauncher launches GDL / GDLE as
 * "-a user:password" and ACE as "-a user -v password". So:
 *   - every world gets the account lowercased;
 *   - GDL / GDLE worlds and the "account:password" eras (Seedsow's classic
 *     profile, AC1999) get the password lowercased too;
 *   - ACE / ClassicACE keep the password as typed.
 * A lowercased password refused with "Client logon failed" is tried once more
 * as typed (a named browser-UX exception), before the existing quiet retries.
 *
 * Each case drives the shipped connections (ClientConnection,
 * Connection1999) and reads the bytes they send the way the servers do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClientConnection, PACKET_HEADER_SIZE, EOR_LOGIN_PROFILE, loginWireCredentials, retailLowercase,
  type ConnectionEvent, type LoginProfile,
} from '../packages/network/src/index.js';
import { Connection1999 } from '../packages/network/src/era1999/Connection1999.js';
import { buildPacket1999 } from '../packages/network/src/era1999/Packet1999.js';
import { connectionFailureNotice } from '../packages/renderer/src/ui/ConnectionNotices.js';
import {
  LoginCaseFallback, passwordCaseFor, CASE_VERBATIM_REFUSAL_TOKEN,
} from '../packages/renderer/src/session/LoginCredentialCase.js';
import { ProvenLoginRetry, firstTimeLoginRetryAllowed, type LoginCredentials } from '../packages/renderer/src/session/ProvenLoginRetry.js';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { EOR_ERA_ID, eraProfile, type EraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { launcherLogin, eraSwitchLogin } from '../packages/renderer/src/launcher/launcherLogin.js';
import { buildDirectory } from '../services/ws-tcp-bridge/src/serverDirectory.js';
import type { ServerEntry } from '../services/ws-tcp-bridge/src/serverList.js';
import { worldFromEntry, type World } from '../packages/renderer/src/launcher/worldDirectory.js';

const BT_NETERROR = 0x00100000;
const ST_SERVER_ERRORS = 8;
const STR_LOGIN_FAILED = 0x04DF9C54;
const STR_LOGIN_SERVER_FULL = 0x00F9982C;
const SERVER_ID = 0x0b;

const era = (id: string): EraProfile => eraProfile(id)!;
const EOR = era(EOR_ERA_ID);
const SEEDSOW_ERA = era('classic-dereth');
const CUSTOMDM = era('classicace-customdm');
const AC1999 = era('ac1999-retail');

// ─── Wire readers ──────────────────────────────────────────────────────

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
  send(b: Uint8Array | string): void { if (typeof b !== 'string') this.sent.push(new Uint8Array(b)); }
  close(): void { this.readyState = 3; this.onclose?.(); }
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

/** GDL's BinaryReader over a LoginRequest payload (after the 20-byte header). */
class Reader {
  private off = 0;
  private readonly v: DataView;
  constructor(private readonly b: Uint8Array) { this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u32(): number { const x = this.v.getUint32(this.off, true); this.off += 4; return x; }
  str(): string {
    const len = this.v.getUint16(this.off, true);
    const s = new TextDecoder('latin1').decode(this.b.subarray(this.off + 2, this.off + 2 + len));
    this.off += Math.ceil((2 + len) / 4) * 4;
    return s;
  }
  /** String32L with ACE's packed-word length byte. */
  str32(): string {
    const n = this.u32();
    const len = this.b[this.off];
    const s = new TextDecoder('utf-8').decode(this.b.subarray(this.off + 1, this.off + 1 + len)); // ClientConnection's TextEncoder
    this.off += n;
    return s;
  }
}

/** What the server reads from an end-of-retail LoginRequest. */
function readEorLogin(packet: Uint8Array): { account: string; password: string } {
  const r = new Reader(packet.subarray(PACKET_HEADER_SIZE));
  r.str(); // version
  r.u32(); // DataLength
  const authType = r.u32();
  r.u32(); // flags
  r.u32(); // timestamp
  const first = r.str();
  if (authType === 1) {
    const i = first.indexOf(':');
    return { account: first.slice(0, i), password: first.slice(i + 1) };
  }
  r.str(); // AccountToLoginAs
  return { account: first, password: r.str32() };
}

/** The AC1999 server's read of the 20-byte credential field after the 0xBEEFBEEF marker. */
function read1999Login(packet: Uint8Array): { account: string; password: string } {
  for (let i = 0; i + 24 <= packet.length; i++) {
    if (packet[i] === 0xef && packet[i + 1] === 0xbe && packet[i + 2] === 0xef && packet[i + 3] === 0xbe) {
      const field = new TextDecoder('latin1').decode(packet.subarray(i + 4, i + 24)).replace(/\0+$/, '');
      const c = field.indexOf(':');
      if (c > 0) return { account: field.slice(0, c), password: field.slice(c + 1) };
    }
  }
  throw new Error('no credential field');
}

/** The LoginRequest a connection sends for `account` / `password` under `profile`. */
function loginBytes(kind: 'eor' | '1999', profile: LoginProfile, account: string, password: string): { account: string; password: string } {
  FakeSocket.sockets = [];
  const conn = kind === 'eor' ? new ClientConnection('ws://bridge', { loginProfile: profile }) : new Connection1999('ws://bridge', { loginProfile: profile });
  if (conn instanceof ClientConnection) conn.autoReconnect = false;
  conn.connect(account, password);
  const sock = FakeSocket.sockets[0];
  sock.onopen?.();
  const sent = sock.sent[0];
  conn.disconnect();
  return kind === 'eor' ? readEorLogin(sent) : read1999Login(sent);
}

// ─── The worlds, through the real directory pipeline ──────────────────

const SERVERS: ServerEntry[] = [
  { id: 'a7502ac9-0cec-4caf-b81c-b3eb40a4689a', name: 'Reefcull', emu: 'GDL', host: 'reefcull.example', port: 9000, source: 'list' },
  { id: 'harvestbud', name: 'Harvestbud', emu: 'GDLE', host: 'harvestbud.example', port: 9010, source: 'list' },
  { id: '394c58d0-885d-466b-b17f-d7e0b96fe3e2', name: 'Seedsow', emu: 'GDL', host: 'seedsow.example', port: 9000, source: 'list' },
  { id: 'coldeve', name: 'Coldeve', emu: 'ACE', host: 'coldeve.example', port: 9000, source: 'list' },
  { id: 'ac1999', name: 'AC1999', emu: 'AC1999', host: 'ac1999.example', port: 9000, source: 'overlay' },
];
const WORLDS = new Map<string, World>(
  buildDirectory(SERVERS, new Map(), new Map(), { now: 0 })
    .map((row) => worldFromEntry(JSON.parse(JSON.stringify(row))))
    .filter((w): w is World => w !== null)
    .map((w) => [w.name, w]),
);
const world = (name: string): World => WORLDS.get(name)!;
const enter = (w: World, account: string, password: string) => ({ world: w, account, password, connectUrl: `wss://bridge.example/?server=${w.id}` });

describe('BUG.login-credential-case — what goes on the wire', () => {
  it('ASCII-only lowercase, as _strlwr / tolower in the C locale', () => {
    expect(retailLowercase('JaKe_Marsh-99')).toBe('jake_marsh-99');
    expect(retailLowercase('ÅÉÎ ünïcode ΣΑΣ')).toBe('ÅÉÎ ünïcode ΣΑΣ');
    expect(loginWireCredentials('Jake', 'Hunter2', null)).toEqual({ account: 'jake', password: 'Hunter2' });
    expect(loginWireCredentials('Jake', 'Hunter2', { passwordCase: 'lower' })).toEqual({ account: 'jake', password: 'hunter2' });
  });

  it('end of retail on ACE (and ClassicACE): the account lowercased, the password exactly as typed', () => {
    const login = launcherLogin(EOR, enter(world('Coldeve'), 'JakeMarsh', 'Hunter2!X'));
    expect(login.passwordCase).toBe('verbatim');
    expect(login.account).toBe('JakeMarsh'); // the page keeps what was typed; only the wire is folded
    expect(loginBytes('eor', { ...EOR.login, passwordCase: login.passwordCase }, login.account, login.password))
      .toEqual({ account: 'jakemarsh', password: 'Hunter2!X' });
    // The default profile (URL logins, tools) is the same.
    expect(loginBytes('eor', EOR_LOGIN_PROFILE, 'JakeMarsh', 'Hunter2!X')).toEqual({ account: 'jakemarsh', password: 'Hunter2!X' });
    expect(passwordCaseFor(CUSTOMDM.login, 'ACE')).toBe('verbatim');
    expect(loginBytes('eor', { ...CUSTOMDM.login, passwordCase: passwordCaseFor(CUSTOMDM.login, 'ACE') }, 'Jake', 'Hunter2'))
      .toEqual({ account: 'jake', password: 'Hunter2' });
  });

  it('GDL / GDLE end-of-retail worlds (Reefcull, Harvestbud): both lowercased, as ThwargLauncher\'s "-a user:password" delivered them', () => {
    for (const name of ['Reefcull', 'Harvestbud']) {
      const login = launcherLogin(EOR, enter(world(name), 'JakeMarsh', 'Hunter2'));
      expect(login.passwordCase).toBe('lower');
      expect(loginBytes('eor', { ...EOR.login, passwordCase: login.passwordCase }, login.account, login.password))
        .toEqual({ account: 'jakemarsh', password: 'hunter2' });
    }
  });

  it('Dark Majesty on GDL (Seedsow, auth type 1 "account:password"): both lowercased', () => {
    const login = launcherLogin(SEEDSOW_ERA, enter(world('Seedsow'), 'Jake', 'Pa:SS'));
    expect(login.passwordCase).toBe('lower');
    expect(loginBytes('eor', { ...SEEDSOW_ERA.login, passwordCase: login.passwordCase }, login.account, login.password))
      .toEqual({ account: 'jake', password: 'pa:ss' });
    // An era switch stashed by an older build (no world): the era's auth style still decides.
    expect(eraSwitchLogin(SEEDSOW_ERA, { era: SEEDSOW_ERA.id, worldKey: 'x', worldName: null, connectUrl: 'wss://b', account: 'Jake', password: 'P', at: 0 }).passwordCase).toBe('lower');
  });

  it('AC1999: the 1999 client lowercased the whole 20-character "-a account:password" field (0x00402380)', () => {
    const login = launcherLogin(AC1999, enter(world('AC1999'), 'JakeM', 'PwProbe12'));
    expect(login.passwordCase).toBe('lower');
    expect(loginBytes('1999', { ...AC1999.login, passwordCase: login.passwordCase }, login.account, login.password))
      .toEqual({ account: 'jakem', password: 'pwprobe12' });
    // Truncated to the 20-byte field after folding, as retail did.
    expect(loginBytes('1999', { ...AC1999.login, passwordCase: 'lower' }, 'LenProbeAB', 'PwProbe123'))
      .toEqual({ account: 'lenprobeab', password: 'pwprobe12' });
  });

  it('nothing else is folded: non-ASCII passwords keep their bytes, and verbatim stays verbatim on every connection', () => {
    expect(loginBytes('eor', { ...EOR.login, passwordCase: 'lower' }, 'Jake', 'ÆBC')).toEqual({ account: 'jake', password: 'Æbc' });
    expect(loginBytes('1999', { ...AC1999.login, passwordCase: 'verbatim' }, 'Jake', 'Hunter2')).toEqual({ account: 'jake', password: 'Hunter2' });
  });
});

// ─── The page's refusal flow (main.ts minus the DOM) ───────────────────

/** GDLE CNetwork::SendConnectLoginFailure (end-of-retail framing). */
function magic(b: Uint8Array, size: number): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let cs = (size << 16) >>> 0;
  let i = 0;
  for (; i < size >> 2; i++) cs = (cs + v.getUint32(i * 4, true)) >>> 0;
  let shift = 3;
  for (i <<= 2; i < size; i++) { cs = (cs + (b[i] << (shift * 8))) >>> 0; shift--; }
  return cs;
}
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
function refusal1999(error: number): Uint8Array {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setUint32(0, error >>> 0, true);
  new DataView(body.buffer).setUint32(4, ST_SERVER_ERRORS, true);
  return buildPacket1999({ sequence: 0, flags: BT_NETERROR, recipient: SERVER_ID, time: 0, body });
}

type Lane = { name: string; era: EraProfile; world: string; kind: 'eor' | '1999'; refusal: (e: number) => Uint8Array };
const LANES: Lane[] = [
  { name: 'Reefcull (GDL, end of retail)', era: EOR, world: 'Reefcull', kind: 'eor', refusal: gdleRefusal },
  { name: 'Seedsow (GDL, Dark Majesty)', era: SEEDSOW_ERA, world: 'Seedsow', kind: 'eor', refusal: gdleRefusal },
  { name: 'AC1999', era: AC1999, world: 'AC1999', kind: '1999', refusal: refusal1999 },
];

/**
 * main.ts's order: the case retry first (LoginCaseFallback → the profile
 * synced → connect again), then ProvenLoginRetry with the credentials as
 * sent. `accepts(password on the wire)` is the server's verdict. Returns the
 * passwords each attempt sent, the retry kinds, and whether it got in.
 */
async function drive(lane: Lane, typed: { account: string; password: string }, accepts: (wirePassword: string, attempt: number) => boolean, helpers?: { proven: ProvenLoginRetry; loginCase: LoginCaseFallback }) {
  const w = world(lane.world);
  const login = launcherLogin(lane.era, enter(w, typed.account, typed.password));
  const loginCase = helpers?.loginCase ?? new LoginCaseFallback();
  loginCase.reset(login.passwordCase);
  const proven = helpers?.proven ?? new ProvenLoginRetry();
  const conn = lane.kind === 'eor'
    ? new ClientConnection('ws://bridge', { loginProfile: loginCase.profile(lane.era.login) })
    : new Connection1999('ws://bridge', { loginProfile: loginCase.profile(lane.era.login) });
  if (conn instanceof ClientConnection) conn.autoReconnect = false;
  const events: ConnectionEvent[] = [];
  conn.on((e) => events.push(e));
  const sync = () => { if (conn.loginProfile.passwordCase !== loginCase.current) conn.loginProfile = loginCase.profile(lane.era.login); };
  const wireCreds = (): LoginCredentials => ({ world: login.connectUrl, ...loginWireCredentials(login.account, login.password, { passwordCase: loginCase.current }) });
  const sentPasswords: string[] = [];
  const kinds: string[] = [];
  let accepted = false;
  let shown: string | null = null;
  conn.connect(login.account, login.password);
  for (let attempt = 0; attempt < 10; attempt++) {
    const sock = FakeSocket.sockets[FakeSocket.sockets.length - 1];
    sock.onopen?.();
    const wire = lane.kind === 'eor' ? readEorLogin(sock.sent[0]) : read1999Login(sock.sent[0]);
    sentPasswords.push(wire.password);
    if (accepts(wire.password, attempt)) {
      accepted = true;
      await proven.noteAccepted(wireCreds());
      loginCase.noteAccepted();
      break;
    }
    const before = events.length;
    sock.deliver(lane.refusal(STR_LOGIN_FAILED));
    const notice = connectionFailureNotice(events.slice(before).find((e) => e.type === 'error')!)!;
    if (loginCase.onRefused(notice.token, login.password)) {
      sync();
      kinds.push('case_verbatim');
      conn.connect(login.account, login.password);
      continue;
    }
    sync();
    const verdict = await proven.onRefused(wireCreds(), notice.token, { firstTime: firstTimeLoginRetryAllowed(w, login.account) });
    if (!verdict.retry) { shown = notice.token; break; }
    kinds.push(verdict.kind);
    conn.connect(login.account, login.password);
  }
  return { conn, sentPasswords, kinds, accepted, shown, loginCase, proven };
}

describe.each(LANES)('BUG.login-credential-case — the as-typed retry on $name', (lane) => {
  it('mixed case typed, account hashed lowercase (the Reddit reports): the first login gets in, no retry', async () => {
    const r = await drive(lane, { account: 'JakeM', password: 'HunterTwo' }, (pw) => pw === 'huntertwo');
    expect(r).toMatchObject({ sentPasswords: ['huntertwo'], kinds: [], accepted: true, shown: null });
    r.conn.disconnect();
  });

  it('an account whose password really has capitals: refused lowercased, then in as typed; resumes keep that form', async () => {
    const r = await drive(lane, { account: 'JakeM', password: 'HunterTwo' }, (pw) => pw === 'HunterTwo');
    expect(r).toMatchObject({ sentPasswords: ['huntertwo', 'HunterTwo'], kinds: ['case_verbatim'], accepted: true, shown: null });
    expect(r.loginCase.current).toBe('verbatim');
    // A reconnect / resume (main.ts connects with the same typed credentials) sends the form that got in.
    FakeSocket.sockets = [];
    r.conn.connect('JakeM', 'HunterTwo');
    FakeSocket.sockets[0].onopen?.();
    const again = lane.kind === 'eor' ? readEorLogin(FakeSocket.sockets[0].sent[0]) : read1999Login(FakeSocket.sockets[0].sent[0]);
    expect(again).toEqual({ account: 'jakem', password: 'HunterTwo' });
    // And it is the proven form: a transient refusal of it is a proven retry, not another case retry.
    expect(r.loginCase.onRefused(CASE_VERBATIM_REFUSAL_TOKEN, 'HunterTwo')).toBe(false);
    r.conn.disconnect();
  });

  it('a correct lowercase-typed password never retries, and a wrong lowercase one gets no case retry', async () => {
    const ok = await drive(lane, { account: 'jakem', password: 'huntertwo' }, (pw) => pw === 'huntertwo');
    expect(ok).toMatchObject({ sentPasswords: ['huntertwo'], kinds: [], accepted: true });
    ok.conn.disconnect();
    FakeSocket.sockets = [];
    const wrong = await drive(lane, { account: 'jakem', password: 'nope' }, () => false);
    expect(wrong.kinds).not.toContain('case_verbatim');
    expect(wrong.accepted).toBe(false);
    expect(wrong.shown).toBe('ID_ConnectionError_ClientLogOnFailed');
    wrong.conn.disconnect();
  });

  it('a wrong mixed-case password: one as-typed retry, then the world\'s rule again for the usual retries and the error', async () => {
    const r = await drive(lane, { account: 'JakeM', password: 'WrongOne' }, () => false);
    expect(r.kinds[0]).toBe('case_verbatim');
    expect(r.kinds.filter((k) => k === 'case_verbatim')).toHaveLength(1);
    expect(r.sentPasswords.slice(0, 2)).toEqual(['wrongone', 'WrongOne']);
    // Anything after (Seedsow's first-time retries) goes back to the lowercased form.
    for (const pw of r.sentPasswords.slice(2)) expect(pw).toBe('wrongone');
    expect(r).toMatchObject({ accepted: false, shown: 'ID_ConnectionError_ClientLogOnFailed' });
    expect(r.loginCase.current).toBe('lower');
    r.conn.disconnect();
  });
});

describe('BUG.login-credential-case — never on ACE, never for other refusals', () => {
  it('ACE: the password is already as typed, so a refusal never retries it', () => {
    const c = new LoginCaseFallback(passwordCaseFor(EOR.login, 'ACE'));
    expect(c.current).toBe('verbatim');
    expect(c.onRefused(CASE_VERBATIM_REFUSAL_TOKEN, 'Hunter2')).toBe(false);
    expect(c.current).toBe('verbatim');
  });

  it('server full, account online and the like are not a password\'s case', () => {
    const c = new LoginCaseFallback('lower');
    for (const token of ['ID_ConnectionError_ServerFull', 'ID_ConnectionError_PlayerAlreadyLoggedOn', null, undefined]) {
      expect(c.onRefused(token, 'Hunter2')).toBe(false);
    }
    expect(c.current).toBe('lower');
    expect(STR_LOGIN_SERVER_FULL).not.toBe(STR_LOGIN_FAILED);
  });

  it('a new launcher ENTER starts from the world\'s rule with the retry available again', () => {
    const c = new LoginCaseFallback('lower');
    expect(c.onRefused(CASE_VERBATIM_REFUSAL_TOKEN, 'Hunter2')).toBe(true);
    c.noteAccepted();
    expect(c.current).toBe('verbatim');
    c.reset('lower');
    expect(c.current).toBe('lower');
    expect(c.onRefused(CASE_VERBATIM_REFUSAL_TOKEN, 'Hunter2')).toBe(true);
  });

  it('telemetry: login_retry carries retry=case_verbatim and the bridge keeps it', () => {
    const sent: PreworldEvent[] = [];
    const r = new PreworldReporter({
      endpoint: 'http://x/client-preworld', build: 'eb3bcb5e', era: () => 'eor', server: () => 'a7502ac9-0cec-4caf-b81c-b3eb40a4689a',
      screen: () => 'connecting', chargenStep: () => null, now: () => 10_000, trace: 'feedc0de12345678',
      send: (_u, raw) => { sent.push(JSON.parse(raw) as PreworldEvent); },
    });
    r.loginStarted();
    r.loginRetry({ serverNetError: { stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS } }, 'ID_ConnectionError_ClientLogOnFailed', 1, 'case_verbatim');
    expect(sent[0]).toMatchObject({ outcome: 'login_retry', retry: 'case_verbatim', count: 1 });
    expect(sanitizeClientPreworld(sent[0])).toMatchObject({ outcome: 'login_retry', retry: 'case_verbatim', code: STR_LOGIN_FAILED });
    // No password in it.
    expect(JSON.stringify(sent[0])).not.toMatch(/hunter/i);
  });
});
