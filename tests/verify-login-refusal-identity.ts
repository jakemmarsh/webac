/**
 * OBS.login-refusal-identity — production 2026-11-07 (Snowreap, GDL): logins
 * refused with ClientLogOnFailed while another tab of the player held an
 * account at chargen; the logs could not tell whether the refused login was
 * the same account, the same browser, or a wrong password.
 *
 * Drives the real modules: telemetry/LoginTags.ts (acct tag, browser id),
 * AccountTabGuard's account query with acks on a shared fake BroadcastChannel,
 * LoginHolderWait.telemetryFor, PreworldReporter's events, and the bridge's
 * sanitizeClientPreworld.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ACCOUNT_TAG_SALT, BROWSER_ID_STORAGE_KEY, accountTag, accountTagInput, browserId, realLocalStorage, wireTabId,
} from '../packages/renderer/src/telemetry/LoginTags';
import { AccountTabGuard, accountSessionKey, type SessionChannelLike } from '../packages/renderer/src/session/AccountTabGuard';
import { LoginHolderWait, LOGON_FAILED_LOGIN_TOKEN, type LoginHolderWaitDeps } from '../packages/renderer/src/session/LoginHolder';
import { PreworldReporter } from '../packages/renderer/src/telemetry/PreworldReporter';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld';
import { MemoryStorage } from '../packages/renderer/src/utils/pageStorage';

const SNOWREAP = 'wss://bridge.example/connect?server=snowreap&trace=aaaaaaaa11111111';
const OTHER_WORLD = 'wss://bridge.example/connect?server=seedsow';
const STR_LOGIN_FAILED = 0x04DF9C54;
const ST_SERVER_ERRORS = 8;

afterEach(() => { vi.restoreAllMocks(); });

describe('acct: a salted world + account tag', () => {
  it('is 8 hex, stable for the same account + world, case-folded and trimmed, and ignores the page trace', async () => {
    const t = await accountTag(SNOWREAP, 'Jakemarsh');
    expect(t).toMatch(/^[0-9a-f]{8}$/);
    expect(await accountTag(SNOWREAP, 'Jakemarsh')).toBe(t);
    expect(await accountTag(SNOWREAP, '  JAKEMARSH ')).toBe(t);
    expect(await accountTag(SNOWREAP.replace('aaaaaaaa11111111', 'bbbbbbbb22222222'), 'jakemarsh')).toBe(t);
  });

  it('differs across worlds and accounts', async () => {
    const t = await accountTag(SNOWREAP, 'jakemarsh');
    expect(await accountTag(OTHER_WORLD, 'jakemarsh')).not.toBe(t);
    expect(await accountTag(SNOWREAP, 'jakemarsh2')).not.toBe(t);
    const tags = new Set(await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map((a) => accountTag(SNOWREAP, a))));
    expect(tags.size).toBe(6);
  });

  it('carries no account substring, and its input is salt + world + folded account only', async () => {
    for (const acct of ['deadbeef', 'abc', 'cafe1234', '0']) {
      const t = await accountTag(SNOWREAP, acct);
      expect(t).not.toBeNull();
      if (acct.length >= 3) expect(t!.includes(acct)).toBe(false);
    }
    const key = accountSessionKey(SNOWREAP, 'Jake');
    expect(accountTagInput(SNOWREAP, 'Jake')).toBe(`${ACCOUNT_TAG_SALT}\u0000${key.slice(0, key.lastIndexOf('|'))}\u0000jake`);
  });

  it('is null without an account or without WebCrypto', async () => {
    expect(await accountTag(SNOWREAP, '')).toBeNull();
    expect(await accountTag(SNOWREAP, '   ')).toBeNull();
    expect(await accountTag(SNOWREAP, 'jake', async () => null)).toBeNull();
  });
});

describe('bid: a random id per browser profile', () => {
  it('without WebCrypto there is no bid (never a Math.random stand-in: FAITHFUL.216)', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => { throw new Error('no crypto'); });
    try {
      const store = new MemoryStorage();
      expect(browserId(store)).toBeNull();
      expect(store.getItem(BROWSER_ID_STORAGE_KEY)).toBeNull();
    } finally { spy.mockRestore(); }
  });

  it('is made once and kept: every tab of the profile reads the same id', () => {
    const store = new MemoryStorage();
    const id = browserId(store);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(store.getItem(BROWSER_ID_STORAGE_KEY)).toBe(id);
    expect(browserId(store)).toBe(id);
    expect(browserId(store, () => '11111111')).toBe(id);
    // Another profile (its own storage) gets its own.
    expect(browserId(new MemoryStorage(), () => '22222222')).toBe('22222222');
  });

  it('replaces a malformed stored value', () => {
    const store = new MemoryStorage();
    store.setItem(BROWSER_ID_STORAGE_KEY, 'not-an-id');
    expect(browserId(store, () => '0a0b0c0d')).toBe('0a0b0c0d');
  });

  it('is absent when storage is missing, or refuses the read or the write', () => {
    expect(browserId(null)).toBeNull();
    expect(browserId({ getItem: () => { throw new Error('SecurityError'); }, setItem: () => {} })).toBeNull();
    expect(browserId({ getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } })).toBeNull();
    // A write that silently does not stick (a store that drops it) is not a browser id either.
    expect(browserId({ getItem: () => null, setItem: () => {} })).toBeNull();
    const blocked = {};
    Object.defineProperty(blocked, 'localStorage', { get() { throw new Error('SecurityError'); } });
    expect(realLocalStorage(blocked)).toBeNull();
    expect(realLocalStorage({})).toBeNull();
  });

  it('tab ids go out only when well formed', () => {
    expect(wireTabId('3f2b8c1e-9d4a-4f7b-a1c2-0e5d6f7a8b9c')).toBe('3f2b8c1e-9d4a-4f7b-a1c2-0e5d6f7a8b9c');
    expect(wireTabId('x'.repeat(41))).toBeNull();
    expect(wireTabId('tab a')).toBeNull();
    expect(wireTabId(null)).toBeNull();
  });
});

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

function guard(channel: SessionChannelLike | null, id: string, live = { v: true }, at = 2000): AccountTabGuard {
  return new AccountTabGuard({
    channel, tabId: id, onStandDown: () => {}, worldCharacter: () => null, sessionLive: () => live.v, now: () => at,
    setTimeout: (fn) => { fn(); return 0; },
  });
}

describe('the account query says how many tabs heard it', () => {
  it('counts the holder, the tabs that ack, and a holder whose session is closed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const hub = new FakeChannelHub();
    const key = accountSessionKey(SNOWREAP, 'jake');
    const holder = guard(hub.open(), 'tab-holder');
    holder.claim(key); // at chargen: no character in the world
    const other = guard(hub.open(), 'tab-other');
    other.claim(accountSessionKey(SNOWREAP, 'someoneelse'));
    guard(hub.open(), 'tab-idle'); // holds nothing
    const closedLive = { v: false };
    // An older claim of the same key (a tab left on its Disconnected screen): the holder's later claim stands.
    const closed = guard(hub.open(), 'tab-closed', closedLive, 1000);
    closed.claim(key);
    expect(holder.heldKey).toBe(key);
    const asker = guard(hub.open(), 'tab-asker');
    const r = await asker.queryAccountHoldersDetailed(key);
    expect(r.holders.map((h) => [h.tab, h.inWorld])).toEqual([['tab-holder', false]]);
    expect([r.tabs, r.holdersClosed, r.channel]).toEqual([4, 1, true]);
    // The plain query is unchanged: only the holder.
    expect((await asker.queryAccountHolders(key)).map((h) => h.tab)).toEqual(['tab-holder']);
    // A world query (no key) gets no acks: only in-world tabs answer it, as before.
    expect(await asker.queryWorldHolders(key)).toEqual([]);
  });

  it('no channel: nothing asked', async () => {
    const r = await guard(null, 'solo').queryAccountHoldersDetailed(accountSessionKey(SNOWREAP, 'jake'));
    expect(r).toEqual({ holders: [], tabs: 0, holdersClosed: 0, channel: false });
  });
});

function holderWait(query: LoginHolderWaitDeps['queryHolders'], resuming = false): { w: LoginHolderWait; passed: number[] } {
  const passed: number[] = [];
  const w = new LoginHolderWait({
    resuming: () => resuming, queryHolders: query, requestLogout: () => true,
    confirm: () => () => {}, login: () => {}, schedule: () => () => {}, setStatus: () => {}, refuse: () => {},
    stillWaiting: () => true, passOn: () => passed.push(1),
  });
  return { w, passed };
}

describe('LoginHolderWait.telemetryFor', () => {
  it('ClientLogOnFailed: skipped before any query, ran with counts after, no_channel without a channel', async () => {
    const { w, passed } = holderWait(async () => ({ holders: [], tabs: 3, holdersClosed: 1, channel: true }));
    expect(w.telemetryFor(LOGON_FAILED_LOGIN_TOKEN)).toEqual({ heldByTab: false, holderQuery: 'skipped' });
    expect(w.onRefused(LOGON_FAILED_LOGIN_TOKEN, 'Client logon failed')).toBe(true);
    await Promise.resolve(); await Promise.resolve();
    expect(passed).toEqual([1]);
    expect(w.telemetryFor(LOGON_FAILED_LOGIN_TOKEN)).toEqual({ heldByTab: false, holderQuery: 'ran', holders: 0, tabs: 3, holdersClosed: 1 });
    // The cycle's later refusals (the case / quiet retries) are not asked again: the same answer rides on them.
    expect(w.onRefused(LOGON_FAILED_LOGIN_TOKEN, 'Client logon failed')).toBe(false);
    expect(w.telemetryFor(LOGON_FAILED_LOGIN_TOKEN).holderQuery).toBe('ran');
    // Another refusal ends the cycle; other tokens carry heldByTab alone.
    w.cancel();
    expect(w.telemetryFor('ID_NetError_CantSocket')).toEqual({ heldByTab: false });

    const none = holderWait(async () => ({ holders: [], tabs: 0, holdersClosed: 0, channel: false }));
    none.w.onRefused(LOGON_FAILED_LOGIN_TOKEN, 'x');
    await Promise.resolve(); await Promise.resolve();
    expect(none.w.telemetryFor(LOGON_FAILED_LOGIN_TOKEN)).toEqual({ heldByTab: false, holderQuery: 'no_channel' });
  });

  it('a resume of our own session never asks: skipped', () => {
    const { w } = holderWait(async () => [], true);
    expect(w.onRefused(LOGON_FAILED_LOGIN_TOKEN, 'x')).toBe(false);
    expect(w.telemetryFor(LOGON_FAILED_LOGIN_TOKEN)).toEqual({ heldByTab: false, holderQuery: 'skipped' });
  });

  it('a holder that answered: heldByTab and holders 1', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { w } = holderWait(async () => ({ holders: [{ tab: 'h', character: null, sameAccount: true, inWorld: false }], tabs: 2, holdersClosed: 0, channel: true }));
    w.onRefused(LOGON_FAILED_LOGIN_TOKEN, 'x');
    await Promise.resolve(); await Promise.resolve();
    expect(w.telemetryFor(LOGON_FAILED_LOGIN_TOKEN)).toEqual({ heldByTab: true, holderQuery: 'ran', holders: 1, tabs: 2, holdersClosed: 0 });
  });
});

function reporter(sent: Record<string, unknown>[], bid: string | null = '0a1b2c3d'): PreworldReporter {
  return new PreworldReporter({
    endpoint: 'https://bridge.example/client-preworld', build: 'abc1234', era: () => 'classic-dereth-1-0', server: () => 'snowreap',
    screen: () => 'connecting', now: () => 1000, trace: 'feedc0de12345678', send: (_u, raw) => { sent.push(JSON.parse(raw)); },
    browserId: bid,
  });
}

describe('PreworldReporter: acct / bid / tab / holder query on the login events, kept by the bridge', () => {
  it('login_retry / login_refused / char_list / login_held carry them; other outcomes do not', async () => {
    const sent: Record<string, unknown>[] = [];
    const r = reporter(sent);
    r.setTabId('3f2b8c1e-9d4a-4f7b-a1c2-0e5d6f7a8b9c');
    const tag = accountTag(SNOWREAP, 'Jake');
    r.connectAttempt(tag);
    await tag;
    const ev = { serverNetError: { stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS } };
    const held = { heldByTab: false, holderQuery: 'ran' as const, holders: 0, tabs: 2, holdersClosed: 1 };
    r.loginRetry(ev, LOGON_FAILED_LOGIN_TOKEN, 1, 'first_time', held);
    r.connectionError(ev, LOGON_FAILED_LOGIN_TOKEN, held);
    r.loginHeld('offer-logon-failed');
    r.characterList(2);
    r.connectionError({ netErrorId: 'ID_NetError_CantSocket' });
    r.pageHidden();
    const acct = await tag;
    const id = { acct, bid: '0a1b2c3d', tab: '3f2b8c1e-9d4a-4f7b-a1c2-0e5d6f7a8b9c' };
    expect(sent[0]).toMatchObject({ outcome: 'login_retry', ...id, holderQuery: 'ran', holders: 0, tabs: 2, holdersClosed: 1 });
    expect(sent[1]).toMatchObject({ outcome: 'login_refused', ...id, holderQuery: 'ran', holders: 0, tabs: 2, holdersClosed: 1 });
    expect(sent[2]).toMatchObject({ outcome: 'login_held', ...id });
    expect(sent[3]).toMatchObject({ outcome: 'char_list', ...id });
    expect('holderQuery' in sent[2]).toBe(false);
    expect('holderQuery' in sent[3]).toBe(false);
    for (const e of sent.slice(4)) for (const k of ['acct', 'bid', 'tab', 'holderQuery']) expect(k in e).toBe(false);
    // The bridge keeps exactly these on exactly these outcomes.
    const kept = sent.map((b) => sanitizeClientPreworld(b)!);
    expect(kept[1]).toMatchObject({ ...id, holderQuery: 'ran', holders: 0, tabs: 2, holdersClosed: 1 });
    expect(kept[3]).toMatchObject(id);
    expect(kept[3].holderQuery).toBeUndefined();
    // No account text anywhere on the wire.
    expect(JSON.stringify(sent).toLowerCase().includes('jake')).toBe(false);
  });

  it('skipped / no_channel go without counts; a new attempt drops the last tag until its own is in', async () => {
    const sent: Record<string, unknown>[] = [];
    const r = reporter(sent, null);
    const ev = { serverNetError: { stringId: STR_LOGIN_FAILED, tableId: ST_SERVER_ERRORS } };
    r.connectAttempt(await accountTag(SNOWREAP, 'jake'));
    r.connectionError(ev, LOGON_FAILED_LOGIN_TOKEN, { holderQuery: 'skipped', holders: 5 });
    let release!: (t: string | null) => void;
    r.connectAttempt(new Promise<string | null>((res) => { release = res; }));
    r.connectionError(ev, LOGON_FAILED_LOGIN_TOKEN, { holderQuery: 'no_channel' });
    // An older attempt's late digest never lands on the newer attempt.
    let releaseOld!: (t: string | null) => void;
    r.connectAttempt(new Promise<string | null>((res) => { releaseOld = res; }));
    const third = accountTag(OTHER_WORLD, 'jake');
    r.connectAttempt(third);
    await third;
    release('ffffffff'); releaseOld('eeeeeeee');
    await Promise.resolve();
    r.connectionError(ev, LOGON_FAILED_LOGIN_TOKEN);
    expect(sent[0]).toMatchObject({ holderQuery: 'skipped', acct: await accountTag(SNOWREAP, 'jake') });
    expect('holders' in sent[0]).toBe(false);
    expect('bid' in sent[0]).toBe(false); // no browser id (storage failed)
    expect(sent[1]).toMatchObject({ holderQuery: 'no_channel' });
    expect('acct' in sent[1]).toBe(false);
    expect(sent[2].acct).toBe(await third);
    expect('holderQuery' in sent[2]).toBe(false);
  });

  it('the bridge drops malformed or oversized values, and the fields on other outcomes', () => {
    const base = { outcome: 'login_refused', holderQuery: 'ran', holders: 1, tabs: 2, holdersClosed: 0 };
    expect(sanitizeClientPreworld({ ...base, acct: 'ABCDEF12', bid: '0a1b2c3d9', tab: 't'.repeat(41) })).not.toHaveProperty('acct');
    const bad = sanitizeClientPreworld({ ...base, acct: 'ABCDEF12', bid: '0a1b2c3d9', tab: 't'.repeat(41) })!;
    expect([bad.acct, bad.bid, bad.tab]).toEqual([undefined, undefined, undefined]);
    expect(sanitizeClientPreworld({ ...base, tab: 'a b' })!.tab).toBeUndefined();
    const big = sanitizeClientPreworld({ ...base, holders: 999 })!;
    expect([big.holderQuery, big.holders, big.tabs]).toEqual(['ran', undefined, undefined]);
    expect(sanitizeClientPreworld({ ...base, holderQuery: 'maybe' })!.holderQuery).toBeUndefined();
    const other = sanitizeClientPreworld({ outcome: 'connect_failed', acct: 'abcdef12', bid: '0a1b2c3d', tab: 'x', holderQuery: 'ran' })!;
    expect([other.acct, other.bid, other.tab, other.holderQuery]).toEqual([undefined, undefined, undefined, undefined]);
    const listed = sanitizeClientPreworld({ outcome: 'char_list', acct: 'abcdef12', bid: '0a1b2c3d', tab: 'x', holderQuery: 'ran', holders: 1 })!;
    expect([listed.acct, listed.bid, listed.tab, listed.holderQuery]).toEqual(['abcdef12', '0a1b2c3d', 'x', undefined]);
  });
});
