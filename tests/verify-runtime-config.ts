import { describe, it, expect } from 'vitest';
import {
  DEV_RUNTIME_CONFIG,
  RUNTIME_CONFIG_PATH,
  assetUrl,
  datSetForEra,
  loadRuntimeConfig,
  resolveRuntimeConfig,
} from '../packages/renderer/src/config/RuntimeConfig.js';
import { urlOverridesEnabled } from '../packages/renderer/src/config/urlOverrides.js';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('RuntimeConfig (release Phase 1)', () => {
  it('no config file and no query → dev defaults (same-origin DATs, local bridge)', () => {
    expect(resolveRuntimeConfig(null, '')).toEqual(DEV_RUNTIME_CONFIG);
  });

  it('config file sets the asset base and bridge URL; trailing slashes are trimmed', () => {
    const cfg = resolveRuntimeConfig(
      { assetBase: 'https://dats.example.org/eol/', bridgeUrl: 'wss://bridge.example.org/connect' },
      '',
    );
    expect(cfg).toEqual({ assetBase: 'https://dats.example.org/eol', bridgeUrl: 'wss://bridge.example.org/connect', datSet: null, sourceUrl: null, siteLinks: false, eraAssetBases: {}, eraDatSets: {} });
    expect(assetUrl(cfg, '/client_portal.dat')).toBe('https://dats.example.org/eol/client_portal.dat');
    expect(assetUrl(cfg, 'weenie-setups.json')).toBe('https://dats.example.org/eol/weenie-setups.json');
  });

  it('?bridge= overrides the config file', () => {
    const cfg = resolveRuntimeConfig({ bridgeUrl: 'wss://a.example/connect' }, '?bridge=ws://localhost:9091');
    expect(cfg.bridgeUrl).toBe('ws://localhost:9091');
  });

  it('invalid values are ignored rather than fatal', () => {
    const cfg = resolveRuntimeConfig(
      { assetBase: 'javascript:alert(1)', bridgeUrl: 'https://not-a-websocket.example' },
      '?bridge=nonsense',
    );
    expect(cfg).toEqual(DEV_RUNTIME_CONFIG);
    expect(resolveRuntimeConfig('not an object', '')).toEqual(DEV_RUNTIME_CONFIG);
  });

  it('same-origin path bases are allowed', () => {
    const cfg = resolveRuntimeConfig({ assetBase: '/dat' }, '');
    expect(assetUrl(cfg, '/client_cell_1.dat')).toBe('/dat/client_cell_1.dat');
    expect(assetUrl(DEV_RUNTIME_CONFIG, '/client_cell_1.dat')).toBe('/client_cell_1.dat');
  });

  it('loadRuntimeConfig fetches /config.json uncached and falls back on 404 or network errors', async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const ok = await loadRuntimeConfig(async (url, init) => {
      seen.push([String(url), init]);
      return jsonResponse({ bridgeUrl: 'wss://bridge.example.org/connect' });
    }, '');
    expect(seen).toEqual([[RUNTIME_CONFIG_PATH, { cache: 'no-store' }]]);
    expect(ok.bridgeUrl).toBe('wss://bridge.example.org/connect');

    const missing = await loadRuntimeConfig(async () => jsonResponse({}, 404), '');
    expect(missing).toEqual(DEV_RUNTIME_CONFIG);

    const offline = await loadRuntimeConfig(async () => { throw new TypeError('network'); }, '?bridge=wss://x.example');
    expect(offline).toEqual({ ...DEV_RUNTIME_CONFIG, bridgeUrl: 'wss://x.example' });
  });

  it('siteLinks: only a literal true turns the launcher\'s site links on; dev has none', () => {
    expect(DEV_RUNTIME_CONFIG.siteLinks).toBe(false);
    expect(resolveRuntimeConfig({ siteLinks: true }, '').siteLinks).toBe(true);
    for (const bad of ['true', 1, null, false, {}]) expect(resolveRuntimeConfig({ siteLinks: bad }, '').siteLinks).toBe(false);
  });

  it('AGPL §13: sourceUrl takes an https URL; anything else means no source link', () => {
    expect(resolveRuntimeConfig({ sourceUrl: 'https://github.com/example/acjs' }, '').sourceUrl).toBe('https://github.com/example/acjs');
    expect(DEV_RUNTIME_CONFIG.sourceUrl).toBeNull();
    for (const bad of ['javascript:alert(1)', 'http://plain.example', 42, null]) {
      expect(resolveRuntimeConfig({ sourceUrl: bad }, '').sourceUrl).toBeNull();
    }
  });

  it('RELEASE.dat-streaming: datSet names the set pointer to stream; absent or invalid keeps whole DATs', () => {
    const url = 'https://dats.example.org/v1/sets/eol-p2072-c982-h497-l994.json';
    expect(resolveRuntimeConfig({ assetBase: 'https://dats.example.org/v1/raw/x', datSet: { manifestUrl: url } }, '').datSet).toEqual({ manifestUrl: url });
    expect(DEV_RUNTIME_CONFIG.datSet).toBeNull();
    for (const bad of [{ manifestUrl: 'javascript:alert(1)' }, { manifestUrl: 'https://x.example/not-a-set.json' }, 'str', null]) {
      expect(resolveRuntimeConfig({ datSet: bad }, '').datSet).toBeNull();
    }
    // ?datSet= streams a set from a dev page; ?rawDats forces the whole-DAT path.
    expect(resolveRuntimeConfig(null, `?datSet=${encodeURIComponent(url)}`).datSet).toEqual({ manifestUrl: url });
    expect(resolveRuntimeConfig({ datSet: { manifestUrl: url } }, '?rawDats').datSet).toBeNull();
  });
});

describe('classic eras stream their own DAT set (eraDatSets / datSetForEra, 2026-10-06)', () => {
  const EOR_SET = 'https://dats.example.org/v1/sets/eol-p2072-c982-h497-l994.json';
  const INF_SET = 'https://dats.example.org/v1/sets/classicace-infiltration-1.9.json';
  const file = { datSet: { manifestUrl: EOR_SET }, eraDatSets: { 'classicace-infiltration': INF_SET, 'Bad Id': INF_SET, 'classic-dereth': 'https://x.org/not-a-pointer' } };

  it('parses valid era → pointer entries only', () => {
    const cfg = resolveRuntimeConfig(file, '');
    expect(cfg.eraDatSets).toEqual({ 'classicace-infiltration': INF_SET });
  });

  it('end of retail streams datSet; a classic era streams its own set or none — never end of retail\'s', () => {
    const cfg = resolveRuntimeConfig(file, '');
    expect(datSetForEra(cfg, 'eor')).toEqual({ manifestUrl: EOR_SET });
    expect(datSetForEra(cfg, 'classicace-infiltration')).toEqual({ manifestUrl: INF_SET });
    expect(datSetForEra(cfg, 'classic-dereth')).toBeNull();
    expect(datSetForEra(cfg, 'constructor')).toBeNull();
  });

  it('?eraDatSet=<era>:<url> adds one (a locally staged set); ?rawDats turns every set off', () => {
    const local = 'http://localhost:8000/v1/sets/classic-dereth-1.1.json';
    expect(datSetForEra(resolveRuntimeConfig(file, `?eraDatSet=classic-dereth:${encodeURIComponent(local)}`), 'classic-dereth')).toEqual({ manifestUrl: local });
    const raw = resolveRuntimeConfig(file, '?rawDats');
    expect(datSetForEra(raw, 'eor')).toBeNull();
    expect(datSetForEra(raw, 'classicace-infiltration')).toBeNull();
  });
});

describe('URL overrides are dev-only (SEC.url-overrides)', () => {
  const SET = 'https://evil.example/v1/sets/fake.json';
  const file = { bridgeUrl: 'wss://bridge.example.org/connect', datSet: { manifestUrl: 'https://dats.example.org/v1/sets/eol.json' } };
  const hostile = `?bridge=${encodeURIComponent('wss://evil.example/connect')}&datSet=${encodeURIComponent(SET)}`
    + `&eraDatSet=${encodeURIComponent(`classic-dereth:${SET}`)}&debug`;

  it('the gate: dev server or a VITE_ACJS_URL_OVERRIDES=1 build; a deployed build is off', () => {
    expect(urlOverridesEnabled({ DEV: true })).toBe(true);
    expect(urlOverridesEnabled({ DEV: false, VITE_ACJS_URL_OVERRIDES: '1' })).toBe(true);
    expect(urlOverridesEnabled({ DEV: false })).toBe(false);
    expect(urlOverridesEnabled({ DEV: false, VITE_ACJS_URL_OVERRIDES: '0' })).toBe(false);
    expect(urlOverridesEnabled({})).toBe(false);
  });

  it('a deployed page keeps its own bridge and DAT sets, even with ?debug', () => {
    const cfg = resolveRuntimeConfig(file, hostile, false);
    expect(cfg.bridgeUrl).toBe('wss://bridge.example.org/connect');
    expect(cfg.datSet).toEqual({ manifestUrl: 'https://dats.example.org/v1/sets/eol.json' });
    expect(cfg.eraDatSets).toEqual({});
  });

  it('with overrides on, the same query applies (the probe tooling path)', () => {
    const cfg = resolveRuntimeConfig(file, hostile, true);
    expect(cfg.bridgeUrl).toBe('wss://evil.example/connect');
    expect(cfg.datSet).toEqual({ manifestUrl: SET });
    expect(cfg.eraDatSets).toEqual({ 'classic-dereth': SET });
  });

  it('?rawDats still works on a deployed page (same hosts, whole files)', () => {
    expect(resolveRuntimeConfig(file, '?rawDats', false).datSet).toBeNull();
  });

  it('loadRuntimeConfig passes the gate through', async () => {
    const off = await loadRuntimeConfig(async () => jsonResponse(file), hostile, false);
    expect(off.bridgeUrl).toBe('wss://bridge.example.org/connect');
    const on = await loadRuntimeConfig(async () => jsonResponse(file), hostile, true);
    expect(on.bridgeUrl).toBe('wss://evil.example/connect');
  });
});
