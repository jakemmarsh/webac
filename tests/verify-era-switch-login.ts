/**
 * ERA.switch-login — a launcher ENTER on a world of another era stashes the
 * login, reloads into that era and resumes it. Every direction between end of
 * retail, Dark Majesty (classic) and AC1999 is driven through the real
 * functions the page uses: the bridge's /servers rows → worldFromEntry →
 * connectUrlFor (LauncherScreen's ENTER) → launcherEraTarget → eraSwitchFor →
 * stashEraSwitch → (reload) takeEraSwitch → resolveBootEra →
 * resumableEraSwitch → eraSwitchLogin, and the resumed login must equal the
 * one the launcher's own ENTER would have produced on a page of that era.
 *
 * playwebac.com 2026-10-13 16:11: an AC1999 page's ENTER reloaded into end of
 * retail and failed ID_NetError_CantSocket with no server id and no bridge
 * session: a Custom… bridge whose era probe never answered was read as an
 * end-of-retail world (reload) and then could not be opened either.
 */
import { describe, it, expect } from 'vitest';
import {
  connectUrlFor, worldFromEntry, parseCustomBridge, probeCustomBridge, type World,
} from '../packages/renderer/src/launcher/worldDirectory';
import {
  eraSwitchFor, eraSwitchLogin, launcherEraTarget, launcherLogin, resumableEraSwitch,
} from '../packages/renderer/src/launcher/launcherLogin';
import {
  ERA_SWITCH_KEY, eraSwitchReloadUrl, resolveBootEra, stashEraSwitch, takeEraSwitch,
} from '../packages/renderer/src/era/EraBoot';
import { EOR_ERA_ID, eraProfile, string16WireFor, type EraProfile } from '../packages/renderer/src/era/EraProfiles';
import { CUSTOM_BRIDGE_SERVER, preworldServerFor, serverIdFromUrl } from '../packages/renderer/src/telemetry/PreworldReporter';

class MemSession {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
  removeItem(k: string) { this.data.delete(k); }
}

const BRIDGE = 'wss://bridge.playwebac.com/';

/** The production directory's shapes: a Servers.xml GUID world (ACE / GDLE), a classic overlay, the 1999 overlay. */
const ROWS = {
  eorAce: { id: '59544be2-9435-400d-a589-30b2a39ed071', name: 'Coldeve', emu: 'ACE', online: true, compat: 'ok' },
  eorGdle: {
    id: 'a7502ac9-0cec-4caf-b81c-b3eb40a4689a', name: 'Reefcull', emu: 'GDLE', online: true, compat: 'beta',
    registration: 'Register on the website first.', registrationUrl: 'https://reefcull.example.org/register',
  },
  dm: { id: '394C58D0-885D-466B-B17F-D7E0B96FE3E2', name: 'Seedsow', emu: 'GDLE', online: true, compat: 'beta', era: 'classic-dereth-1-0' },
  dmAce: { id: '4db379b0-587a-4775-9b7f-879e0f15ba4b', name: 'Dekarutide', emu: 'ACE', online: true, compat: 'beta', era: 'classicace-customdm' },
  ac1999: {
    id: 'ac1999', name: 'AC1999', emu: 'AC1999', online: true, compat: 'beta', era: 'ac1999-retail',
    compatWarning: "Existing accounts only: webAC can't create new ones here yet.", perIpLimits: { accounts: 2, sessions: 2 },
  },
};
const world = (row: Record<string, unknown>): World => worldFromEntry(row)!;
const era = (id: string): EraProfile => eraProfile(id)!;

/**
 * One ENTER on `w` from a page booted in `pageEra`, through the reload when
 * the world needs another era. Returns the login the next page connects with.
 */
function enterAcrossReload(pageEra: EraProfile, w: World, opts: { search?: string; now?: number } = {}) {
  const now = opts.now ?? 5_000_000;
  const enter = { world: w, account: 'bael', password: 'pw', connectUrl: connectUrlFor(BRIDGE, w) };
  const target = launcherEraTarget(w, pageEra);
  if (target.id === pageEra.id) return { reloaded: false, booted: pageEra, login: launcherLogin(pageEra, enter), enter };
  const session = new MemSession();
  expect(stashEraSwitch(eraSwitchFor(enter, target, now), session)).toBe(true);
  // The reload: the next page reads the stash once, boots its era, resumes the login.
  const pending = takeEraSwitch(session, now + 1500);
  expect(session.getItem(ERA_SWITCH_KEY)).toBeNull();
  const booted = resolveBootEra({ search: eraSwitchReloadUrl(`https://playwebac.com/${opts.search ?? ''}`).replace(/^[^?]*/, ''), pending });
  const sw = resumableEraSwitch(pending, booted);
  expect(sw).not.toBeNull();
  return { reloaded: true, booted, login: eraSwitchLogin(booted, sw!), enter };
}

describe('ERA.switch-login: every direction resumes the chosen world after the era reload', () => {
  const pages: Array<[string, EraProfile]> = [
    ['end of retail', era(EOR_ERA_ID)], ['Dark Majesty (Classic Dereth)', era('classic-dereth-1-0')],
    ['Dark Majesty (ClassicACE)', era('classicace-customdm')], ['AC1999', era('ac1999-retail')],
  ];
  const worlds: Array<[string, Record<string, unknown>]> = [
    ['end-of-retail ACE', ROWS.eorAce], ['end-of-retail GDLE', ROWS.eorGdle], ['Dark Majesty GDLE', ROWS.dm], ['Dark Majesty ClassicACE', ROWS.dmAce], ['AC1999', ROWS.ac1999],
  ];
  for (const [pageName, pageEra] of pages) {
    for (const [worldName, row] of worlds) {
      it(`${pageName} page → ${worldName} world`, () => {
        const w = world(row);
        const worldEra = era(w.era ?? EOR_ERA_ID);
        const r = enterAcrossReload(pageEra, w);
        expect(r.reloaded).toBe(worldEra.id !== pageEra.id);
        expect(r.booted.id).toBe(worldEra.id);
        // The socket goes to the multi bridge with the world's id: what the bridge routes on and the telemetry names.
        expect(r.login.connectUrl).toBe(`${BRIDGE}?server=${row.id}`);
        expect(serverIdFromUrl(r.login.connectUrl)).toBe(row.id);
        expect(preworldServerFor(r.login.connectUrl, r.login.world)).toBe(row.id);
        // Identical to the ENTER a page of the world's own era makes (no stale or era-shaped field).
        expect(r.login).toEqual(launcherLogin(worldEra, r.enter));
        expect(r.login).toMatchObject({ account: 'bael', password: 'pw', worldName: row.name });
        expect(r.login.wire).toBe(string16WireFor(worldEra, w.emu));
        expect(r.login.world?.registration ?? null).toBe((row as { registration?: string }).registration ?? null);
        // The per-address caps survive the reload, so a refused login there still explains itself.
        expect(r.login.world?.perIpLimits ?? null).toEqual((row as { perIpLimits?: unknown }).perIpLimits ?? null);
        expect(r.login.world?.compatWarning ?? null).toBe((row as { compatWarning?: string }).compatWarning ?? null);
      });
    }
  }

  it('an end-of-retail GDLE world entered from AC1999 sends Windows-1252 strings, as from an end-of-retail page', () => {
    const r = enterAcrossReload(era('ac1999-retail'), world(ROWS.eorGdle));
    expect(r.reloaded).toBe(true);
    // Before ERA.switch-login the resumed login skipped string16WireFor and kept end of retail's UTF-8 (ACE) wire.
    expect(r.login.wire).toBe('windows-1252');
    expect(enterAcrossReload(era('ac1999-retail'), world(ROWS.eorAce)).login.wire).toBe(string16WireFor(era(EOR_ERA_ID), 'ACE'));
  });

  it('a page opened with ?era= reloads without it, so the stashed era boots instead of the URL\'s', () => {
    expect(eraSwitchReloadUrl('https://playwebac.com/?era=ac1999-retail')).toBe('https://playwebac.com/');
    expect(eraSwitchReloadUrl('https://playwebac.com/?x=1&era=ac1999-retail#h')).toBe('https://playwebac.com/?x=1#h');
    expect(eraSwitchReloadUrl('https://playwebac.com/?x=1')).toBe('https://playwebac.com/?x=1');
    // Without the strip, ?era wins the boot and the end-of-retail login is dropped (the launcher again, forever).
    const session = new MemSession();
    const w = world(ROWS.eorAce);
    stashEraSwitch(eraSwitchFor({ world: w, account: 'a', password: 'p', connectUrl: connectUrlFor(BRIDGE, w) }, era(EOR_ERA_ID), 1000), session);
    const pending = takeEraSwitch(session, 1001);
    const unstripped = resolveBootEra({ search: '?era=ac1999-retail', pending });
    expect(resumableEraSwitch(pending, unstripped)).toBeNull();
    const r = enterAcrossReload(era('ac1999-retail'), w, { search: '?era=ac1999-retail' });
    expect(r.booted.id).toBe(EOR_ERA_ID);
    expect(r.login.connectUrl).toBe(`${BRIDGE}?server=${ROWS.eorAce.id}`);
  });

  it('a switch stashed by an older build (no world) still resumes its login', () => {
    const session = new MemSession();
    session.setItem(ERA_SWITCH_KEY, JSON.stringify({
      era: EOR_ERA_ID, worldKey: ROWS.eorAce.id, worldName: 'Coldeve', connectUrl: `${BRIDGE}?server=${ROWS.eorAce.id}`,
      account: 'bael', password: 'pw', at: 1000,
    }));
    const pending = takeEraSwitch(session, 2000);
    const booted = resolveBootEra({ search: '', pending });
    const login = eraSwitchLogin(booted, resumableEraSwitch(pending, booted)!);
    expect(login).toMatchObject({ connectUrl: `${BRIDGE}?server=${ROWS.eorAce.id}`, worldName: 'Coldeve', world: null, account: 'bael' });
  });

  it('a malformed stashed world is dropped, not trusted', () => {
    const session = new MemSession();
    session.setItem(ERA_SWITCH_KEY, JSON.stringify({
      era: EOR_ERA_ID, worldKey: 'x', worldName: 'X', connectUrl: `${BRIDGE}?server=x`, account: 'a', password: 'p', at: 1000,
      world: { name: 'X', kind: 'evil' },
    }));
    expect(takeEraSwitch(session, 2000)?.world).toBeNull();
  });
});

describe('ERA.switch-login: a custom bridge whose era is unknown never reloads the page', () => {
  it('reproduces the 2026-10-13 failure shape: unreachable Custom… from AC1999 used to reload into end of retail with no server id', async () => {
    // The probe the launcher runs for Custom… (CSP-blocked ws://localhost, or a host that does not answer).
    const dead = async () => { throw new Error('no socket'); };
    const deadFetch = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const custom = (parseCustomBridge('wss://ac1999.example.net:9000') as { world: World }).world;
    const probe = await probeCustomBridge(custom.bridgeUrl!, deadFetch, dead);
    expect(probe).toEqual({ reachable: false, era: null });
    // The old reading of that probe: era null = end of retail → a reload to a URL with no ?server=.
    expect(eraProfile(custom.era)!.id).toBe(EOR_ERA_ID);
    expect(serverIdFromUrl(connectUrlFor(BRIDGE, custom))).toBeNull();
    // Now: unknown stays in the page's era (no reload); the telemetry names a custom bridge.
    custom.eraUnknown = true;
    for (const page of ['ac1999-retail', 'classic-dereth', EOR_ERA_ID]) {
      const r = enterAcrossReload(era(page), custom);
      expect(r.reloaded).toBe(false);
      expect(r.login.connectUrl).toBe('wss://ac1999.example.net:9000/');
      expect(preworldServerFor(r.login.connectUrl, r.login.world)).toBe(CUSTOM_BRIDGE_SERVER);
    }
  });

  it('a reachable custom bridge still switches to the era it reports, and resumes on its own URL', async () => {
    const custom = (parseCustomBridge('wss://classic.example.net/bridge') as { world: World }).world;
    const probe = await probeCustomBridge(custom.bridgeUrl!, (async () => new Response('{}')) as unknown as typeof fetch,
      async () => ({ bridge: 'ok', era: 'classic-dereth' }));
    expect(probe).toEqual({ reachable: true, era: 'classic-dereth' });
    custom.era = probe.era;
    const r = enterAcrossReload(era('ac1999-retail'), custom);
    expect(r.reloaded).toBe(true);
    expect(r.booted.id).toBe('classic-dereth');
    expect(r.login.connectUrl).toBe('wss://classic.example.net/bridge');
    expect(r.login.worldName).toBe('classic.example.net');
    expect(preworldServerFor(r.login.connectUrl, r.login.world)).toBe(CUSTOM_BRIDGE_SERVER);
    // An end-of-retail custom bridge (no era) that answered is a real end-of-retail world: AC1999 → end of retail.
    const eor = (parseCustomBridge('wss://eor.example.net/') as { world: World }).world;
    eor.eraUnknown = false;
    expect(enterAcrossReload(era('ac1999-retail'), eor).booted.id).toBe(EOR_ERA_ID);
  });

  it('a bridge answering /healthz with an HTTP error is reachable (an answer), one with no answer is not', async () => {
    const noWs = async () => { throw new Error('no socket'); };
    const status = (code: number) => (async () => new Response('x', { status: code })) as unknown as typeof fetch;
    expect(await probeCustomBridge('wss://h.example.net/', status(500), noWs)).toEqual({ reachable: true, era: null });
    expect(await probeCustomBridge('not a url', status(200), noWs)).toEqual({ reachable: false, era: null });
  });
});
