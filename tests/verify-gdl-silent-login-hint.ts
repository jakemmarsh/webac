/**
 * UX.gdl-silent-login-hint — production 2026-11-09 00:58Z (Seedsow, GDL, Dark
 * Majesty): one player had the same account in three browsers. While the
 * first was in the world, the other two logged in; the server never answered
 * (GDL / GDLE ignore a login for an account online from another endpoint),
 * our telemetry said login_held silent_none (no tab of THAT browser held it),
 * and after the 40 s resend budget each showed "Client timed out the
 * connection" with "Try again in a minute, or pick another world.", twice.
 * The first browser logged out and the next login went straight in.
 *
 * Drives the real modules: ClientConnection (fake timers, a silent server)
 * to its loginUnanswered point and its 40 s ClientTimedOutServer, the real
 * LoginHolderWait asking a real AccountTabGuard over a fake BroadcastChannel,
 * and loginFailureText (what main.ts raiseNetError shows) with the wait's
 * silentUnansweredNoTab. Pins: retail's line unchanged, only the next step
 * differs, and only on GDL / GDLE worlds; ACE, ClassicACE, the AC1999 server,
 * a URL login, a register-first world, a world known offline, a tab of this
 * browser holding the account, and the in-world text are unchanged.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { ClientConnection, type ConnectionEvent } from '@ac/network';
import { AccountTabGuard, accountSessionKey, type SessionChannelLike } from '../packages/renderer/src/session/AccountTabGuard';
import { LoginHolderWait, type LoginHolderReport } from '../packages/renderer/src/session/LoginHolder';
import {
  netErrorNotice, NET_ERROR_NEXT_STEP, RETRY_OR_OTHER_WORLD_HINT,
} from '../packages/renderer/src/ui/ConnectionNotices';
import {
  loginFailureText, silentAccountOnlineWorld, ACCOUNT_ONLINE_ELSEWHERE_HINT, SILENT_ACCOUNT_ONLINE_EMUS,
  type World,
} from '../packages/renderer/src/launcher/worldDirectory';
import { ERA_PROFILES } from '../packages/renderer/src/era/EraProfiles';

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
  send(): void { /* a server that never answers */ }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
}

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

const SEEDSOW_URL = 'wss://bridge.example/connect?server=5eed5ow0-0000-4000-8000-000000000001';
const TIMEOUT = 'ID_ConnectionError_ClientTimedOutServer';
const IN_USE_RETAIL = 'Player already logged on';

function makeGuard(hub: FakeChannelHub, id: string, world: { name: string | null } | null = null): AccountTabGuard {
  return new AccountTabGuard({
    channel: hub.open(), tabId: id,
    onStandDown: () => {}, onLogoutRequested: () => {},
    worldCharacter: () => world, sessionLive: () => true,
    setTimeout: (fn) => { fn(); return 0; },
  });
}

function makeWait(guard: AccountTabGuard, key: string) {
  const out = { reports: [] as LoginHolderReport[], refused: [] as (string | null)[], offers: 0 };
  const wait = new LoginHolderWait({
    resuming: () => false,
    queryHolders: () => guard.queryAccountHolders(key),
    requestLogout: (h) => guard.requestLogoutForLogin(h, key),
    confirm: () => { out.offers++; return () => {}; },
    login: () => {},
    schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
    setStatus: () => {},
    refuse: (t) => { out.refused.push(t); },
    stillWaiting: () => true,
    report: (k) => { out.reports.push(k); },
  });
  return { wait, out };
}

function world(emu: string | null, extra: Partial<World> = {}): World {
  return {
    id: 'w', name: 'Seedsow', emu, type: null, description: '', website: null, discord: null,
    online: true, population: null, compat: 'ok', compatNote: null, compatReason: null,
    registration: null, registrationUrl: null, kind: 'listed', era: 'classic-dereth-1-0', ...extra,
  };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const g = globalThis as { WebSocket?: unknown };
let savedWs: unknown;
beforeAll(() => { savedWs = g.WebSocket; g.WebSocket = FakeSocket; });
afterAll(() => { g.WebSocket = savedWs; });
afterEach(() => { FakeSocket.sockets = []; vi.useRealTimers(); vi.restoreAllMocks(); });

/**
 * main.ts's path: a silent server, loginUnanswered → LoginHolderWait.onUnanswered,
 * then the 40 s timeout's error → raiseNetError's loginFailureText with the flag.
 */
async function silentLogin(opts: { holderTab: boolean }) {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const hub = new FakeChannelHub();
  const key = accountSessionKey(SEEDSOW_URL, 'jake');
  if (opts.holderTab) makeGuard(hub, 'tab-a', { name: 'Gdltab' }).claim(key);
  // Another account in this browser never counts.
  makeGuard(hub, 'tab-other', { name: 'Someone' }).claim(accountSessionKey(SEEDSOW_URL, 'someone'));
  const { wait, out } = makeWait(makeGuard(hub, 'tab-b'), key);
  const conn = new ClientConnection(SEEDSOW_URL);
  const events: ConnectionEvent[] = [];
  conn.on((e) => { events.push(e); if (e.type === 'loginUnanswered') wait.onUnanswered(IN_USE_RETAIL); });
  conn.connect('jake', 'pw');
  FakeSocket.sockets[0].open();
  vi.advanceTimersByTime(4_000);
  await flush();
  vi.advanceTimersByTime(40_000);
  await flush();
  const timeout = events.find((e) => e.type === 'error' && e.netErrorId === TIMEOUT);
  conn.disconnect();
  return { wait, out, timeout };
}

describe('UX.gdl-silent-login-hint — the timeout of a login a GDL / GDLE world left unanswered', () => {
  it('no tab of this browser holds the account: retail\'s line, then the account-elsewhere hint (Seedsow, GDL)', async () => {
    const { wait, out, timeout } = await silentLogin({ holderTab: false });
    expect(timeout).toBeDefined();
    expect(out.reports).toEqual(['silent-none']);
    expect(out.refused).toEqual([]); // the 40 s wait is untouched: nothing refused early, no retries
    expect(wait.silentUnansweredNoTab).toBe(true);
    const notice = netErrorNotice(TIMEOUT);
    const text = loginFailureText(notice, world('GDL'), false, 'jake', 'classic-dereth-1-0',
      { silentUnansweredNoTab: wait.silentUnansweredNoTab });
    expect(text).toBe(`Client timed out the connection\n\n${ACCOUNT_ONLINE_ELSEWHERE_HINT}`);
    expect(text.split('\n\n')[0]).toBe(notice.text);
    expect(text).not.toContain(RETRY_OR_OTHER_WORLD_HINT);
    // GDLE (ClassicDereth) ignores such a login the same way; any case of the emu name.
    expect(loginFailureText(notice, world('gdle', { era: null }), false, 'jake', 'eor', { silentUnansweredNoTab: true }))
      .toBe(`${notice.text}\n\n${ACCOUNT_ONLINE_ELSEWHERE_HINT}`);
  });

  it('without the silent-login flag (the server down, or the query never ran): today\'s hint', () => {
    const notice = netErrorNotice(TIMEOUT);
    const today = `${notice.text}\n\n${RETRY_OR_OTHER_WORLD_HINT}`;
    expect(NET_ERROR_NEXT_STEP[TIMEOUT]).toBe(RETRY_OR_OTHER_WORLD_HINT);
    expect(loginFailureText(notice, world('GDL'), false, 'jake', 'classic-dereth-1-0')).toBe(today);
    expect(loginFailureText(notice, world('GDL'), false, 'jake', 'classic-dereth-1-0', { silentUnansweredNoTab: false })).toBe(today);
  });

  it('a tab of this browser holds it: the offer comes up instead and the flag stays off', async () => {
    const { wait, out } = await silentLogin({ holderTab: true });
    expect(out.reports).toEqual(['silent-offer']);
    expect(out.offers).toBe(1);
    expect(wait.silentUnansweredNoTab).toBe(false);
  });

  it('servers that refuse in words or let the new login in are unchanged: ACE, ClassicACE, the AC1999 server, URL / custom logins', () => {
    const notice = netErrorNotice(TIMEOUT);
    const today = `${notice.text}\n\n${RETRY_OR_OTHER_WORLD_HINT}`;
    const ctx = { silentUnansweredNoTab: true };
    expect([...SILENT_ACCOUNT_ONLINE_EMUS].sort()).toEqual(['GDL', 'GDLE']);
    for (const emu of ['ACE', 'ClassicACE', 'AC1999']) {
      expect(silentAccountOnlineWorld({ emu })).toBe(false);
      expect(loginFailureText(notice, world(emu), false, 'jake', emu === 'AC1999' ? 'ac1999-retail' : 'eor', ctx)).toBe(today);
    }
    // The AC1999 server kills the old session instead (its era says so); the hint is not keyed on eras.
    expect(ERA_PROFILES['ac1999-retail'].reloginKillsSilently).toBe(true);
    // A URL login (no launcher world) and a Custom… world have no emu.
    expect(loginFailureText(notice, null, false, 'jake', 'eor', ctx)).toBe(today);
    expect(loginFailureText(notice, world(null, { kind: 'custom' }), false, 'jake', 'eor', ctx)).toBe(today);
  });

  it('a register-first GDLE world keeps its registration line; a world the directory knows is offline keeps today\'s hint; in the world, unchanged', () => {
    const notice = netErrorNotice(TIMEOUT);
    const ctx = { silentUnansweredNoTab: true };
    const reg = world('GDLE', { name: 'Reefcull', registrationUrl: 'https://reefcull.example/register' });
    expect(loginFailureText(notice, reg, false, 'jake', 'eor', ctx))
      .toBe(`${notice.text}\n\nNew account? Register on the Reefcull website first. https://reefcull.example/register`);
    expect(loginFailureText(notice, world('GDL', { online: false }), false, 'jake', 'classic-dereth-1-0', ctx))
      .toBe(`${notice.text}\n\n${RETRY_OR_OTHER_WORLD_HINT}`);
    // online null (status unknown) still gets the hint.
    expect(loginFailureText(notice, world('GDL', { online: null }), false, 'jake', 'classic-dereth-1-0', ctx))
      .toBe(`${notice.text}\n\n${ACCOUNT_ONLINE_ELSEWHERE_HINT}`);
    expect(loginFailureText(notice, world('GDL'), true, 'jake', 'classic-dereth-1-0', ctx))
      .toBe(`${notice.text}\n\n${RETRY_OR_OTHER_WORLD_HINT}`);
    // Only the timeout: another refusal on the same world keeps its own next step.
    const full = netErrorNotice('ID_ConnectionError_ServerFull');
    expect(loginFailureText(full, world('GDL'), false, 'jake', 'classic-dereth-1-0', ctx))
      .toBe(`${full.text}\n\n${NET_ERROR_NEXT_STEP.ID_ConnectionError_ServerFull}`);
  });

  it('the flag belongs to one login: the next unanswered login, cancel() and end() clear it', async () => {
    const hub = new FakeChannelHub();
    const key = accountSessionKey(SEEDSOW_URL, 'jake');
    const { wait } = makeWait(makeGuard(hub, 'tab-b'), key);
    wait.onUnanswered(IN_USE_RETAIL);
    await flush();
    expect(wait.silentUnansweredNoTab).toBe(true);
    wait.cancel();
    expect(wait.silentUnansweredNoTab).toBe(false);
    wait.onUnanswered(IN_USE_RETAIL);
    await flush();
    expect(wait.silentUnansweredNoTab).toBe(true);
    // The next login's unanswered point, with a tab now holding the account: no longer set.
    makeGuard(hub, 'tab-a', { name: 'Gdltab' }).claim(key);
    wait.onUnanswered(IN_USE_RETAIL);
    expect(wait.silentUnansweredNoTab).toBe(false);
    await flush();
    expect(wait.silentUnansweredNoTab).toBe(false);
    wait.end();
    expect(wait.silentUnansweredNoTab).toBe(false);
  });
});
