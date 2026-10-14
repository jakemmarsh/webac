/**
 * ERA.ac1999 — the bridge lists the AC1999 (Nov 1999) worlds itself (they are
 * not in Servers.xml), tags them with era `ac1999-retail`, and never runs the
 * end-of-retail login probe against them (another protocol; a probe login
 * would create an account). Drives the real serverList / serverCompat /
 * serverDirectory / eraDetect modules; no network.
 */
import { describe, it, expect } from 'vitest';
import {
  ac1999Overlay, AC1999_PUBLIC_SERVER, AC1999_LOCAL_ID, ServerRegistry, mergeOverlays, parseOverlay, type ServerEntry,
} from '../services/ws-tcp-bridge/src/serverList';
import { compatFor, AC1999_COMPAT, AC1999_ERA, AC1999_ERA_NOTE, AC1999_PUBLIC_COMPAT, NO_PROBE_ERAS, SERVER_COMPAT } from '../services/ws-tcp-bridge/src/serverCompat';
import { buildDirectory, ServerDirectory } from '../services/ws-tcp-bridge/src/serverDirectory';
import { EraDetector, type Detection } from '../services/ws-tcp-bridge/src/eraDetect';
import type { ProbeLogin } from '../services/ws-tcp-bridge/src/loginProbe';

const registry = (env: Record<string, string | undefined>, operator = '{}') => new ServerRegistry({
  url: null, refreshMs: 0, cachePath: null,
  overlay: mergeOverlays(parseOverlay(operator), ac1999Overlay(env)),
});

describe('AC1999 rows (not in Servers.xml)', () => {
  it('the public server is always listed; the local one only when BRIDGE_AC1999_LOCAL names it', () => {
    expect(ac1999Overlay({}).servers).toEqual([{ ...AC1999_PUBLIC_SERVER }]);
    expect(AC1999_PUBLIC_SERVER).toMatchObject({ id: 'ac1999', emu: 'AC1999', host: 'ac1999.cobradragon.com', port: 9110 });
    const withLocal = ac1999Overlay({ BRIDGE_AC1999_LOCAL: '127.0.0.1:9310' }).servers;
    expect(withLocal.map((s) => s.id)).toEqual(['ac1999', AC1999_LOCAL_ID]);
    expect(withLocal[1]).toMatchObject({ name: 'AC1999 (local)', emu: 'AC1999', host: '127.0.0.1', port: 9310, source: 'overlay' });
    expect(ac1999Overlay({ BRIDGE_AC1999_LOCAL: '  ' }).servers).toHaveLength(1);
  });

  it('a malformed BRIDGE_AC1999_LOCAL is loud at startup', () => {
    for (const bad of ['127.0.0.1', 'host:abc', 'bad host:9310', 'h:0', 'h:65535']) {
      expect(() => ac1999Overlay({ BRIDGE_AC1999_LOCAL: bad })).toThrow(/BRIDGE_AC1999_LOCAL/);
    }
  });

  it('the registry resolves them; an operator overlay can deny or replace them', () => {
    const r = registry({ BRIDGE_AC1999_LOCAL: '127.0.0.1:9310' });
    expect(r.lookup('AC1999')?.host).toBe('ac1999.cobradragon.com');
    expect(r.lookup(AC1999_LOCAL_ID)?.port).toBe(9310);
    expect(r.all().map((s) => s.id)).toEqual(['ac1999', AC1999_LOCAL_ID]);
    expect(registry({}, '{"deny":["ac1999"]}').all()).toEqual([]);
    const moved = registry({}, '{"servers":[{"id":"ac1999","name":"AC1999","emu":"AC1999","host":"new.example.org","port":9110}]}');
    expect(moved.lookup('ac1999')?.host).toBe('new.example.org');
    expect(moved.all()).toHaveLength(1);
  });

  it('their directory rows carry era ac1999-retail, beta, with the "1999 launch era" chip', () => {
    expect(AC1999_ERA_NOTE).toBe('1999 launch era');
    expect(compatFor('ac1999', 'AC1999')).toMatchObject({ compat: 'beta', note: '1999 launch era', era: AC1999_ERA });
    expect(compatFor(AC1999_LOCAL_ID, 'AC1999')).toEqual({ compat: 'beta', note: '1999 launch era', era: AC1999_ERA });
    expect(AC1999_ERA).toBe('ac1999-retail');
    const rows = buildDirectory(registry({ BRIDGE_AC1999_LOCAL: '127.0.0.1:9310' }).all(), new Map(), new Map(), { now: 0 });
    for (const row of rows) {
      expect(row).toMatchObject({ era: 'ac1999-retail', compat: 'beta', compatNote: '1999 launch era', online: null });
    }
    // A stray detection result (say an operator labelled it ACE) never overrides the 1999 era.
    const stray: Detection = { kind: 'era', era: null, version: '1802', note: null, at: 0 };
    expect(buildDirectory([{ ...AC1999_PUBLIC_SERVER }], new Map(), new Map(), { now: 0, detected: () => stray })[0].era).toBe('ac1999-retail');
  });
});

describe('AC1999 rows are never era-probed', () => {
  it('ServerDirectory hands the detector everything but never-probed eras, whatever their emu says', async () => {
    const calls: string[] = [];
    const probe: ProbeLogin = async (address, _port, version) => { calls.push(`${address}:${version}`); return { kind: 'accepted' }; };
    const detector = new EraDetector({ probe, resolve: async (h) => h, sleep: async () => {} });
    const ace = (id: string): ServerEntry => ({ id, name: id, emu: 'ACE', host: `${id}.example.org`, port: 9000, source: 'list' });
    // A 1999 server an operator listed with emu "ACE": byId names its era.
    const mislabelled = { ...ace('old'), host: 'old.example.org' };
    const compat = { byId: { old: { compat: 'beta' as const, era: AC1999_ERA } }, byEmu: { AC1999: compatFor('ac1999', 'AC1999') } };
    const servers = [ace('cold'), mislabelled, { ...AC1999_PUBLIC_SERVER }];
    const dir = new ServerDirectory({ servers: () => servers, statusUrl: null, countsUrl: null, fetchText: async () => '{}', detector, compat });
    expect(dir.probeable().map((s) => s.id)).toEqual(['cold']);
    await dir.refresh();
    await detector.sweep([], () => null); // joins the sweep refresh() started
    expect(calls).toEqual(['cold.example.org:1802']);
    expect(NO_PROBE_ERAS.has(AC1999_ERA)).toBe(true);
    expect(dir.body().servers.find((s) => s.id === 'old')?.era).toBe(AC1999_ERA);
  });
});

/**
 * Upstream 11e7463f "Enforce a two account limit" (reference/ac1999:
 * server.cfg.example max_accounts_per_ip=2 / max_sessions_per_ip=2,
 * DatabaseIO.cpp CreateAccount, Network.cpp AcceptClientLogin) runs on the
 * public server, and every webAC player shares the bridge's one egress
 * address: a fresh account through the production bridge was refused with
 * STR_LOGIN_FAILED on 2026-10-13 while existing accounts kept playing.
 */
describe('the public AC1999 server caps accounts and sessions per IP address', () => {
  const WARNING = "Existing accounts only: webAC can't create new ones here yet.";

  it('its compat entry: still enterable (beta, not incompatible), with the warning and the 2 / 2 caps', () => {
    expect(compatFor('ac1999', 'AC1999')).toBe(AC1999_PUBLIC_COMPAT);
    expect(compatFor('AC1999', 'AC1999')).toBe(AC1999_PUBLIC_COMPAT); // ids are case-insensitive
    expect(AC1999_PUBLIC_COMPAT).toEqual({
      compat: 'beta', note: '1999 launch era', era: AC1999_ERA, warning: WARNING, perIpLimits: { accounts: 2, sessions: 2 },
    });
    expect(AC1999_PUBLIC_COMPAT.reason).toBeUndefined();
    // Keyed by the listed server's id; our local server and any other AC1999 row keep the plain entry.
    expect(SERVER_COMPAT.byId[AC1999_PUBLIC_SERVER.id]).toBe(AC1999_PUBLIC_COMPAT);
    expect(compatFor(AC1999_LOCAL_ID, 'AC1999')).toBe(AC1999_COMPAT);
    expect(AC1999_COMPAT.perIpLimits).toBeUndefined();
    // Fits the launcher's 2-line details note (no longer than the Reefcull registration note, which does).
    expect(WARNING.length).toBeLessThanOrEqual('Register on the Reefcull website first (lower-case names only).'.length);
  });

  it('its /servers row carries compatWarning and perIpLimits; the local row and ordinary worlds carry null', () => {
    const rows = buildDirectory(registry({ BRIDGE_AC1999_LOCAL: '127.0.0.1:9310' }).all(), new Map(), new Map(), { now: 0 });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.ac1999).toMatchObject({
      compat: 'beta', compatNote: '1999 launch era', compatReason: null, era: AC1999_ERA,
      compatWarning: WARNING, perIpLimits: { accounts: 2, sessions: 2 },
    });
    // A copy: a consumer mutating the row never edits the overlay.
    expect(byId.ac1999.perIpLimits).not.toBe(AC1999_PUBLIC_COMPAT.perIpLimits);
    expect(byId[AC1999_LOCAL_ID]).toMatchObject({ compatWarning: null, perIpLimits: null });
    const ace: ServerEntry = { id: '59544be2-9435-400d-a589-30b2a39ed071', name: 'Coldeve', emu: 'ACE', host: 'c.example.org', port: 9000, source: 'list' };
    expect(buildDirectory([ace], new Map(), new Map(), { now: 0 })[0]).toMatchObject({ compatWarning: null, perIpLimits: null });
    // Through JSON as /servers sends it.
    expect(JSON.parse(JSON.stringify(byId.ac1999))).toMatchObject({ compatWarning: WARNING, perIpLimits: { accounts: 2, sessions: 2 } });
  });

  it('a refused world never carries the warning (its reason is what shows)', () => {
    const overlay = { byId: { x: { compat: 'incompatible' as const, reason: 'R.', warning: 'W.' } }, byEmu: {} };
    const row = buildDirectory([{ id: 'x', name: 'X', emu: 'ACE', host: 'h', port: 1, source: 'list' }], new Map(), new Map(), { now: 0, compat: overlay })[0];
    expect(row).toMatchObject({ compat: 'incompatible', compatReason: 'R.', compatWarning: null });
  });
});
