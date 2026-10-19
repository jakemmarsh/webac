/**
 * BUG.world-list-unreachable — failures the bridge never sees, reported to the
 * page's own origin: the report payload and its host gate
 * (packages/renderer/src/telemetry/WebReport.ts), and the Worker that logs
 * them (deploy/web/cloudflare/report-worker.mjs) driven with real Request
 * objects and a fake ASSETS binding.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildWebReport, webReportUrl, sendWebReport, worldListFailedReport, launcherConnectFailedReport, browserBrand,
  WEB_REPORT_PATH, type WebReport,
} from '../packages/renderer/src/telemetry/WebReport';
import { WorldDirectoryError, loadWorldDirectory } from '../packages/renderer/src/launcher/worldDirectory';
import worker, { MAX_REPORT_BYTES, REPORT_PATH, validateReport } from '../deploy/web/cloudflare/report-worker.mjs';

const BRIDGE = 'wss://bridge.playwebac.com/';
const CHROME_NAV = {
  onLine: true, language: 'en-US', userAgent: 'Mozilla/5.0 (Macintosh) Chrome/141',
  userAgentData: { brands: [{ brand: 'Google Chrome', version: '141' }, { brand: 'Chromium', version: '141' }] },
};

describe('the report payload', () => {
  it('a blocked world-list fetch: kind, step, the browser error, host only, brand list, language — nothing else', async () => {
    const failed = await loadWorldDirectory(BRIDGE, (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(WorldDirectoryError);
    const r = buildWebReport(worldListFailedReport({ attempts: 3, elapsedMs: 7012.4, error: failed }, BRIDGE, 'abc123def456'), CHROME_NAV);
    expect(r).toEqual({
      kind: 'world_list_failed', build: 'abc123def456', attempts: 3, elapsedMs: 7012, failedStep: 'healthz',
      errorName: 'TypeError', errorMessage: 'Failed to fetch', online: true, bridgeHost: 'bridge.playwebac.com',
      ua: 'Google Chrome/141, Chromium/141', lang: 'en-US',
    } satisfies WebReport);
  });

  it('bounds the strings: message 120, ua 160 (userAgent when there is no brand list)', () => {
    const long = 'x'.repeat(500);
    const r = buildWebReport({
      kind: 'world_list_failed', build: 'b', attempts: 1, elapsedMs: 1, failedStep: 'servers', error: new Error(long), bridgeUrl: BRIDGE,
    }, { userAgent: long, onLine: false });
    expect(r.errorMessage?.length).toBe(120);
    expect(r.ua.length).toBe(160);
    expect(r.online).toBe(false);
    expect(r.lang).toBeNull();
    expect(browserBrand(null)).toBe('');
  });

  it('a non-WorldDirectoryError still reports, with no step', () => {
    const input = worldListFailedReport({ attempts: 3, elapsedMs: 5, error: new Error('boom') }, BRIDGE, 'b');
    expect(input.failedStep).toBeNull();
    expect(buildWebReport(input, {}).errorMessage).toBe('boom');
  });

  it('a launcher login: only CantSocket to our own bridge is reported (never a custom bridge, never a server refusal)', () => {
    const base = { connectUrl: `${BRIDGE}?server=c0ldeve`, bridgeUrl: BRIDGE, sinceLoginMs: 840, build: 'b' };
    const r = launcherConnectFailedReport({ ...base, netErrorId: 'ID_NetError_CantSocket' });
    expect(r).not.toBeNull();
    expect(buildWebReport(r!, CHROME_NAV)).toMatchObject({
      kind: 'launcher_connect_failed', attempts: 1, elapsedMs: 840, failedStep: 'websocket', errorMessage: 'ID_NetError_CantSocket', bridgeHost: 'bridge.playwebac.com',
    });
    expect(launcherConnectFailedReport({ ...base, netErrorId: 'ID_ConnectionError_ClientTimedOutServer' })).toBeNull();
    expect(launcherConnectFailedReport({ ...base, netErrorId: null })).toBeNull();
    expect(launcherConnectFailedReport({ ...base, connectUrl: 'wss://their-bridge.example.net/', netErrorId: 'ID_NetError_CantSocket' })).toBeNull();
  });
});

describe('where reports go (the origin gate)', () => {
  it('playwebac.com and next.playwebac.com post to their own /__webac/report; anywhere else nothing is sent', () => {
    expect(webReportUrl('https://playwebac.com/?world=coldeve')).toBe('https://playwebac.com/__webac/report');
    expect(webReportUrl('https://next.playwebac.com/')).toBe(`https://next.playwebac.com${WEB_REPORT_PATH}`);
    expect(webReportUrl('http://localhost:5173/?ace')).toBeNull();
    expect(webReportUrl('https://evil-playwebac.com/')).toBeNull();
    expect(webReportUrl('http://playwebac.com/')).toBeNull();
    expect(webReportUrl('not a url')).toBeNull();
    expect(webReportUrl('https://web.example.org/', ['web.example.org'])).toBe('https://web.example.org/__webac/report');
  });

  const report = buildWebReport(worldListFailedReport({ attempts: 3, elapsedMs: 7000, error: new WorldDirectoryError('healthz', new TypeError('Failed to fetch')) }, BRIDGE, 'b'), CHROME_NAV);

  it('sendBeacon first, with the JSON body', async () => {
    const beacons: Array<[string, Blob]> = [];
    const fetchSpy = vi.fn();
    expect(sendWebReport(report, 'https://playwebac.com/', { sendBeacon: (u, d) => { beacons.push([u, d]); return true; }, fetch: fetchSpy })).toBe(true);
    expect(beacons.map(b => b[0])).toEqual(['https://playwebac.com/__webac/report']);
    expect(JSON.parse(await beacons[0][1].text())).toEqual(report);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetch keepalive when the beacon is refused or missing', () => {
    const calls: Array<[string, RequestInit]> = [];
    const f = async (u: string, i: RequestInit) => { calls.push([u, i]); return new Response(null, { status: 204 }); };
    expect(sendWebReport(report, 'https://next.playwebac.com/', { sendBeacon: () => false, fetch: f })).toBe(true);
    expect(sendWebReport(report, 'https://next.playwebac.com/', { fetch: f })).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toBe('https://next.playwebac.com/__webac/report');
    expect(calls[0][1]).toMatchObject({ method: 'POST', keepalive: true });
    expect(JSON.parse(String(calls[0][1].body))).toEqual(report);
  });

  it('local dev sends nothing (no 404 spam); a throwing transport never throws', () => {
    const beacon = vi.fn(() => true);
    const f = vi.fn(async () => new Response(null));
    expect(sendWebReport(report, 'http://localhost:5173/', { sendBeacon: beacon, fetch: f })).toBe(false);
    expect(beacon).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
    expect(sendWebReport(report, 'https://playwebac.com/', { sendBeacon: () => { throw new Error('x'); }, fetch: () => { throw new Error('y'); } })).toBe(false);
  });
});

describe('the report Worker (deploy/web/cloudflare/report-worker.mjs)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function assets() {
    const seen: string[] = [];
    return { seen, env: { ASSETS: { fetch: async (r: Request) => { seen.push(new URL(r.url).pathname); return new Response('asset', { status: 200 }); } } } };
  }
  const reportBody = JSON.stringify({
    kind: 'world_list_failed', build: 'abc', attempts: 3, elapsedMs: 7000, failedStep: 'healthz', errorName: 'TypeError',
    errorMessage: 'Failed to fetch', online: true, bridgeHost: 'bridge.playwebac.com', ua: 'Chromium/141', lang: 'en-US',
    account: 'should-never-be-logged',
  });
  function post(body: string, headers: Record<string, string> = {}) {
    const req = new Request(`https://playwebac.com${REPORT_PATH}`, { method: 'POST', body, headers: { 'content-type': 'text/plain', 'cf-connecting-ip': '203.0.113.9', ...headers } });
    Object.defineProperty(req, 'cf', { value: { country: 'US', asn: 7922, colo: 'ORD', city: 'Chicago' } });
    return req;
  }

  it('POST /__webac/report → 204 and one web_report line with the validated fields, cf and the IP', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = assets();
    const res = await worker.fetch(post(reportBody), a.env);
    expect(res.status).toBe(204);
    expect(a.seen).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(log.mock.calls[0][0]));
    expect(line).toEqual({
      event: 'web_report', kind: 'world_list_failed', build: 'abc', attempts: 3, elapsedMs: 7000, failedStep: 'healthz',
      errorName: 'TypeError', errorMessage: 'Failed to fetch', online: true, bridgeHost: 'bridge.playwebac.com', ua: 'Chromium/141', lang: 'en-US',
      cf: { country: 'US', asn: 7922, colo: 'ORD' }, ip: '203.0.113.9',
    });
    expect(JSON.stringify(line)).not.toContain('should-never-be-logged');
  });

  it('GET /__webac/report → 405; nothing logged', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await worker.fetch(new Request(`https://playwebac.com${REPORT_PATH}`), assets().env);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect(log).not.toHaveBeenCalled();
  });

  it('a body over 4 KB → 413 (declared or not); not JSON / not a report → 400', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const big = JSON.stringify({ kind: 'world_list_failed', pad: 'x'.repeat(MAX_REPORT_BYTES) });
    expect((await worker.fetch(post(big), assets().env)).status).toBe(413);
    // A stream body carries no content-length: the read size decides.
    const stream = new Request(`https://playwebac.com${REPORT_PATH}`, {
      method: 'POST', body: new Blob([big]).stream(), duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect((await worker.fetch(stream, assets().env)).status).toBe(413);
    expect((await worker.fetch(post('not json'), assets().env)).status).toBe(400);
    expect((await worker.fetch(post(JSON.stringify({ kind: 'something_else' })), assets().env)).status).toBe(400);
    expect((await worker.fetch(post('[1,2]'), assets().env)).status).toBe(400);
    expect(log).not.toHaveBeenCalled();
  });

  it('any other path goes to ASSETS.fetch unchanged', async () => {
    const a = assets();
    const res = await worker.fetch(new Request('https://playwebac.com/__webac/other'), a.env);
    expect(await res.text()).toBe('asset');
    await worker.fetch(new Request('https://playwebac.com/index.html'), a.env);
    expect(a.seen).toEqual(['/__webac/other', '/index.html']);
  });

  it('validateReport keeps only the closed field set, bounded', () => {
    expect(validateReport({ kind: 'launcher_connect_failed', failedStep: 'websocket', attempts: -4, bridgeHost: 'bad host/x', errorMessage: 'm'.repeat(300) }))
      .toMatchObject({ kind: 'launcher_connect_failed', failedStep: 'websocket', attempts: null, bridgeHost: null });
    expect((validateReport({ kind: 'world_list_failed', errorMessage: 'm'.repeat(300) }) as { errorMessage: string }).errorMessage.length).toBe(120);
    expect(validateReport({ kind: 'world_list_failed', failedStep: 'dns' })).toMatchObject({ failedStep: null });
    expect(validateReport(null)).toBeNull();
  });

  it('wrangler.jsonc runs the Worker only for /__webac/*, binds ASSETS, keeps logs, and env.production inherits it', () => {
    // JSONC: drop // comments (none sit inside a string value here) and parse.
    const raw = readFileSync(new URL('../deploy/web/cloudflare/wrangler.jsonc', import.meta.url), 'utf8');
    const cfg = JSON.parse(raw.split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '')).join('\n'));
    expect(cfg.main).toBe('./report-worker.mjs');
    expect(cfg.assets.binding).toBe('ASSETS');
    expect(cfg.assets.run_worker_first).toEqual(['/__webac/*']);
    expect(cfg.observability).toEqual({ enabled: true });
    // Inheritable keys stay top-level only, so production gets the same Worker.
    for (const k of ['main', 'assets', 'observability']) expect(cfg.env.production[k]).toBeUndefined();
  });
});
