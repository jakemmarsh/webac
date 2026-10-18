/**
 * RELEASE.preworld-boot-stage — while the page is still on screen 'boot'
 * (main() before the launcher), every pre-world event says which boot step
 * main() is in, how far the download got, whether the DAT cache was warm,
 * and which capability problems the probe found; a boot that passes 20 s
 * sends one boot_slow, and main()'s catch sends boot_failed.
 *
 * Evidence (2026-10-13, production bridge): `client_preworld outcome=page_left
 * screen=boot pageMs=54297` — a visitor sat 53 s on boot and left, with no way
 * to tell a slow download from a stall.
 *
 * Drives the real PreworldReporter through its real install() (pagehide,
 * visibilitychange, the 1 s tick), feeds it the patch meter's own PatchEvent
 * values (checked against the real PatchStatus meter), and runs its payloads
 * through the bridge's real sanitizer and POST route.
 */
import { describe, it, expect } from 'vitest';
import {
  PreworldReporter, BOOT_STAGES, BOOT_CACHE_STATES, CAPABILITY_ISSUES, BOOT_SLOW_MS, bootCacheVerdict,
  streamedBootStage, BOOT_STREAM_SCOPES, BOOT_STREAM_MAX_BYTES,
  type PreworldEvent, type PreworldScreen,
} from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { PatchStatus, type PatchEvent } from '../packages/renderer/src/ui/PatchScreen.js';
import { capabilityProblems } from '../packages/renderer/src/boot/Capability.js';
import {
  sanitizeClientPreworld, BOOT_STAGES as BRIDGE_BOOT_STAGES, BOOT_CACHE_STATES as BRIDGE_CACHE_STATES,
  CAPABILITY_ISSUES as BRIDGE_CAPS, PREWORLD_OUTCOMES, BOOT_STREAM_SCOPES as BRIDGE_STREAM_SCOPES,
} from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { resolveBridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil.js';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server.js';

function harness() {
  const sent: PreworldEvent[] = [];
  const clock = { t: 1000 };
  const state: { screen: PreworldScreen } = { screen: 'boot' };
  const r = new PreworldReporter({
    endpoint: 'https://bridge.example/client-preworld', build: 'abc1234', era: () => 'eor', server: () => null,
    screen: () => state.screen, now: () => clock.t, trace: 'feedc0de12345678',
    send: (_url, raw) => sent.push(JSON.parse(raw) as PreworldEvent),
  });
  const winL = new Map<string, () => void>();
  const docL = new Map<string, () => void>();
  const ticks: Array<() => void> = [];
  const win = { addEventListener: (t: string, l: () => void) => { winL.set(t, l); }, setInterval: (f: () => void) => { ticks.push(f); return 1; } };
  const doc = { visibilityState: 'visible', addEventListener: (t: string, l: () => void) => { docL.set(t, l); } };
  r.install(win as never, doc as never);
  /** Advance the clock one second at a time, running the reporter's interval like the browser. */
  const advance = (ms: number) => { for (let i = 0; i < ms; i += 1000) { clock.t += Math.min(1000, ms - i); ticks.forEach(f => f()); } };
  return { r, sent, clock, state, winL, docL, doc, advance };
}

describe('boot fields on boot events', () => {
  it('a page left mid-download says the stage, the percent and KiB of the announced bytes, and the cache verdict', () => {
    const h = harness();
    // main(): capability → era → patch_check → interrogation → patch_download.
    h.r.bootStage('capability');
    h.r.capabilityIssues([]);
    h.r.bootStage('era');
    h.r.bootStage('patch_check');
    const meter = new PatchStatus();
    const events: PatchEvent[] = [{ kind: 'interrogation' }, { kind: 'begin', expected: 40 * 1024 * 1024 }, { kind: 'downloaded', bytes: 10 * 1024 * 1024 }, { kind: 'downloaded', bytes: 3 * 1024 * 1024 + 7 }];
    h.r.bootStage('patch_download');
    for (const e of events) { meter.onEvent(e); h.r.bootPatchEvent(e); }
    h.r.bootCache(bootCacheVerdict({ storage: true, fromNetwork: 120_000, fromCache: 0 }));
    h.advance(53_000);
    h.winL.get('pagehide')!();
    const left = h.sent.find(e => e.outcome === 'page_left')!;
    expect(left).toMatchObject({
      screen: 'boot', stage: 'patch_download', progress: 32, doneKB: 13 * 1024, totalKB: 40 * 1024, cache: 'cold', caps: null,
    });
    // The same percent the patch meter shows (gmDataPatchUI's token_percent = trunc(level * 100)).
    expect(left.progress).toBe(Math.trunc(meter.level * 100));
  });

  it('before the patch announces a total, progress / KiB are null; the end event is 100%', () => {
    const h = harness();
    h.r.bootStage('patch_download');
    h.doc.visibilityState = 'hidden';
    h.docL.get('visibilitychange')!();
    expect(h.sent[0]).toMatchObject({ outcome: 'page_hidden', stage: 'patch_download', progress: null, doneKB: null, totalKB: null, cache: null });
    h.r.bootPatchEvent({ kind: 'end' }); // nothing to download (all cached): Interrogation → End
    h.r.bootCache(bootCacheVerdict({ storage: true, fromNetwork: 0, fromCache: 4 }));
    h.r.bootStage('dat_parse');
    h.r.bootFailed('TypeError');
    expect(h.sent[1]).toMatchObject({ outcome: 'boot_failed', stage: 'dat_parse', progress: 100, doneKB: 0, totalKB: 0, cache: 'warm', token: 'TypeError' });
  });

  it('the soft capability prompt is its own stage and carries the problem ids', () => {
    const h = harness();
    const problems = capabilityProblems({ webgl2: true, websocket: true, deviceMemoryGb: 2, finePointer: false });
    h.r.capabilityIssues(problems.map(p => p.id));
    h.r.bootStage('capability_prompt');
    h.winL.get('pagehide')!();
    expect(h.sent[0]).toMatchObject({ outcome: 'page_left', stage: 'capability_prompt', caps: ['memory', 'pointer'] });
  });

  it('off the boot screen the boot fields are null; an unknown stage / cache value is ignored', () => {
    const h = harness();
    h.r.bootStage('ui_init');
    h.r.bootStage('nope' as never);
    h.r.bootCache('lukewarm' as never);
    h.r.capabilityIssues(['webgl2', '<script>']);
    h.state.screen = 'char-select';
    h.r.characterList(2);
    expect(h.sent[0]).toMatchObject({ screen: 'char-select', stage: null, progress: null, doneKB: null, totalKB: null, cache: null, caps: null });
    expect(h.r.bootSnapshot()).toMatchObject({ stage: 'ui_init', cache: null, caps: ['webgl2'] });
    // boot_failed after boot (main() threw on a later screen) carries no boot fields either.
    h.r.bootFailed('Error: secretacct77 was here');
    expect(h.sent[1]).toMatchObject({ outcome: 'boot_failed', stage: null, token: null });
  });
});

describe('boot_slow', () => {
  it('goes out once, at 20 s on boot, with the stage and progress of that moment', () => {
    const h = harness();
    h.r.bootStage('patch_download');
    h.r.bootPatchEvent({ kind: 'begin', expected: 1000 * 1024 });
    h.r.bootPatchEvent({ kind: 'downloaded', bytes: 250 * 1024 });
    h.advance(BOOT_SLOW_MS - 1000);
    expect(h.sent).toHaveLength(0);
    h.advance(1000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ outcome: 'boot_slow', screen: 'boot', stage: 'patch_download', progress: 25, doneKB: 250, totalKB: 1000, pageMs: BOOT_SLOW_MS });
    h.r.bootPatchEvent({ kind: 'downloaded', bytes: 750 * 1024 });
    h.advance(60_000);
    h.winL.get('pagehide')!();
    expect(h.sent.map(e => [e.outcome, e.progress])).toEqual([['boot_slow', 25], ['page_left', 100]]);
  });

  it('a boot that reaches the launcher in time never sends it', () => {
    const h = harness();
    h.advance(5000);
    h.state.screen = 'server-select';
    h.advance(120_000);
    expect(h.sent).toHaveLength(0);
  });

  it('a page left before 20 s sends page_left only', () => {
    const h = harness();
    h.advance(8000);
    h.winL.get('pagehide')!();
    h.advance(30_000);
    expect(h.sent.map(e => e.outcome)).toEqual(['page_left']);
  });
});

describe('bootCacheVerdict', () => {
  it('off without storage; null before anything loaded; warm / cold / partial by source', () => {
    expect(bootCacheVerdict({ storage: false, fromNetwork: 0, fromCache: 0 })).toBe('off');
    expect(bootCacheVerdict({ storage: true, fromNetwork: 0, fromCache: 0 })).toBeNull();
    expect(bootCacheVerdict({ storage: true, fromNetwork: 0, fromCache: 9 })).toBe('warm');
    expect(bootCacheVerdict({ storage: true, fromNetwork: 9, fromCache: 0 })).toBe('cold');
    expect(bootCacheVerdict({ storage: true, fromNetwork: 9, fromCache: 9 })).toBe('partial');
  });
});

describe('bridge: the boot fields', () => {
  it('the page and the bridge share the closed lists', () => {
    expect([...BRIDGE_BOOT_STAGES]).toEqual([...BOOT_STAGES]);
    expect([...BRIDGE_CACHE_STATES]).toEqual([...BOOT_CACHE_STATES]);
    expect([...BRIDGE_CAPS]).toEqual([...CAPABILITY_ISSUES]);
    expect(PREWORLD_OUTCOMES).toContain('boot_slow');
    expect(PREWORLD_OUTCOMES).toContain('boot_failed');
  });

  it("keeps a real boot payload whole and bounds every new field", () => {
    const h = harness();
    h.r.capabilityIssues(['memory']);
    h.r.bootStage('patch_download');
    h.r.bootPatchEvent({ kind: 'begin', expected: 2048 });
    h.r.bootPatchEvent({ kind: 'downloaded', bytes: 1024 });
    h.r.bootCache('partial');
    h.advance(BOOT_SLOW_MS);
    expect(sanitizeClientPreworld(h.sent[0])).toEqual(h.sent[0]);

    const ev = sanitizeClientPreworld({
      ...h.sent[0], stage: 'hacking', progress: 101, doneKB: -1, totalKB: 1.5, cache: 'hot', caps: ['memory', 'Bob', 'memory'],
    })!;
    expect(ev).toMatchObject({ stage: null, progress: null, doneKB: null, totalKB: null, cache: null, caps: ['memory'] });
    expect(sanitizeClientPreworld({ outcome: 'boot_slow', caps: 'memory' })!.caps).toBeNull();
    expect(sanitizeClientPreworld({ outcome: 'boot_slow', caps: ['Bob'] })!.caps).toBeNull();
  });

  it('POST /client-preworld logs boot_slow with its stage, progress and cache', async () => {
    const c = resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
    c.wsPort = 0;
    const lines: Array<[string, string, Record<string, unknown>]> = [];
    const bridge = createBridgeServer(c, { log: (level, event, fields) => { lines.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const h = harness();
      h.r.bootStage('patch_download');
      h.r.bootPatchEvent({ kind: 'begin', expected: 30 * 1024 * 1024 });
      h.r.bootPatchEvent({ kind: 'downloaded', bytes: 3 * 1024 * 1024 });
      h.r.bootCache('cold');
      h.advance(BOOT_SLOW_MS);
      const res = await fetch(`http://127.0.0.1:${port}/client-preworld`, { method: 'POST', body: JSON.stringify(h.sent[0]), headers: { 'content-type': 'text/plain' } });
      expect(res.status).toBe(204);
      const line = lines.find(l => l[1] === 'client_preworld')!;
      expect(line[2]).toMatchObject({ outcome: 'boot_slow', screen: 'boot', stage: 'patch_download', progress: 10, doneKB: 3072, totalKB: 30720, cache: 'cold' });
      expect(line[2]).not.toHaveProperty('caps'); // nulls are left out of the line
    } finally {
      await bridge.shutdown();
    }
  });
});

/**
 * Production (2026-10-18): a returning player on a slow laptop sat 20 s+ on
 * the patch screen at 100% twice; boot_slow said stage=patch_download
 * progress=100 cache=warm. That was StreamingDats.open() loading a warm
 * profile's world + terrain packs and UI art from the object cache. It now
 * has its own stage (world_cache), and each set's bootReport rides along.
 */
describe('world_cache: the warm-cache world load', () => {
  const warmAll = { netBytes: 0, netObjects: 0, cacheBytes: 98_765_432, cacheObjects: 4321, preWorldArtFiles: 77, ms: 23_456.4, worldCached: true, worldCacheMs: 21_000.2 };

  it('comes straight after patch_download, in both lists', () => {
    expect(BOOT_STAGES.indexOf('world_cache')).toBe(BOOT_STAGES.indexOf('patch_download') + 1);
    expect([...BRIDGE_BOOT_STAGES]).toEqual([...BOOT_STAGES]);
    expect([...BRIDGE_STREAM_SCOPES]).toEqual([...BOOT_STREAM_SCOPES]);
    expect(PREWORLD_OUTCOMES).toContain('boot_done');
  });

  it('streamedBootStage: download wins, then any set loading its world from the cache, then back to patch_download', () => {
    expect(streamedBootStage([])).toBe('patch_download');
    expect(streamedBootStage(['download'])).toBe('patch_download');
    expect(streamedBootStage(['world_cache'])).toBe('world_cache');
    // AC1999: the world set reached its cache wait while the interface set still downloads.
    expect(streamedBootStage(['download', 'world_cache'])).toBe('patch_download');
    expect(streamedBootStage(['world_cache', 'done'])).toBe('world_cache');
    expect(streamedBootStage(['done', 'done'])).toBe('patch_download');
  });

  it('boot_slow in the cache wait says world_cache at 100%, and the boot_done that follows carries the set report', () => {
    const h = harness();
    h.r.bootStage('patch_download');
    h.r.bootPatchEvent({ kind: 'begin', expected: 512 * 1024 });
    h.r.bootPatchEvent({ kind: 'downloaded', bytes: 512 * 1024 });
    h.r.bootCache('warm');
    h.r.bootStage(streamedBootStage(['world_cache']));
    h.advance(BOOT_SLOW_MS);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ outcome: 'boot_slow', screen: 'boot', stage: 'world_cache', progress: 100, cache: 'warm' });
    expect(h.sent[0]).not.toHaveProperty('stream'); // open() has not resolved yet

    h.advance(3000);
    h.r.bootStream('all', warmAll);
    h.r.bootStage('side_tables');
    h.advance(2000);
    h.state.screen = 'server-select';
    h.advance(1000);
    expect(h.sent.map((e) => e.outcome)).toEqual(['boot_slow', 'boot_done']);
    expect(h.sent[1]).toMatchObject({
      outcome: 'boot_done', screen: 'server-select', stage: null, pageMs: BOOT_SLOW_MS + 6000,
      stream: [{ scope: 'all', ms: 23_456, worldCacheMs: 21_000, worldCached: true, netBytes: 0, cacheBytes: 98_765_432, cacheObjects: 4321 }],
    });
    expect(Object.keys(h.sent[1].stream![0]).sort()).toEqual(['cacheBytes', 'cacheObjects', 'ms', 'netBytes', 'scope', 'worldCacheMs', 'worldCached']);
    h.advance(60_000);
    expect(h.sent).toHaveLength(2); // once
  });

  it('a fast boot sends no boot_done; its first char_list carries the reports, later ones do not', () => {
    const h = harness();
    h.r.bootStream('interface', { ...warmAll, worldCached: false, worldCacheMs: 0, netBytes: 5_000_000 });
    h.r.bootStream('world', warmAll);
    h.advance(4000);
    h.state.screen = 'server-select';
    h.advance(5000);
    expect(h.sent).toHaveLength(0);
    h.state.screen = 'char-select';
    h.r.characterList(3);
    h.r.characterList(3);
    expect(h.sent[0].stream!.map((r) => [r.scope, r.worldCached, r.netBytes])).toEqual([['interface', false, 5_000_000], ['world', true, 0]]);
    expect(h.sent[1]).not.toHaveProperty('stream');
  });

  it('a boot-screen event carries the reports known so far; out-of-range values are clamped, an unknown scope dropped', () => {
    const h = harness();
    h.r.bootStream('everything', warmAll);
    h.r.bootStream('all', { ms: -5, worldCacheMs: Number.NaN, worldCached: 'yes', netBytes: 1e15, cacheBytes: Infinity, cacheObjects: 1e12 });
    h.winL.get('pagehide')!();
    expect(h.sent[0]).toMatchObject({ outcome: 'page_left', screen: 'boot' });
    expect(h.sent[0].stream).toEqual([{ scope: 'all', ms: 0, worldCacheMs: 0, worldCached: false, netBytes: BOOT_STREAM_MAX_BYTES, cacheBytes: 0, cacheObjects: 10_000_000 }]);
  });

  it('bridge: keeps a real report whole, drops a bad entry whole, dedups scopes and caps the list', () => {
    const h = harness();
    h.r.bootStage('world_cache');
    h.r.bootStream('all', warmAll);
    h.advance(BOOT_SLOW_MS);
    const real = h.sent[0];
    expect(real).toMatchObject({ outcome: 'boot_slow', stage: 'world_cache' });
    expect(sanitizeClientPreworld(real)).toEqual(real);

    const good = real.stream![0];
    const ev = sanitizeClientPreworld({
      ...real,
      stream: [
        { ...good, scope: 'secret' },
        { ...good, ms: 1.5 },
        { ...good, netBytes: BOOT_STREAM_MAX_BYTES + 1 },
        { ...good, worldCached: 1 },
        'junk', null, [good],
        good, { ...good, ms: 7 }, // a second 'all' is dropped
        { ...good, scope: 'world', name: 'secretacct77' },
        { ...good, scope: 'interface' }, // past MAX_BOOT_STREAMS
      ],
    })!;
    expect(ev.stream).toEqual([good, { ...good, scope: 'world' }]);
    expect(sanitizeClientPreworld({ outcome: 'boot_done', stream: 'all' })).not.toHaveProperty('stream');
    expect(sanitizeClientPreworld({ outcome: 'boot_done', stream: [{ scope: 'all' }] })).not.toHaveProperty('stream');
    expect(sanitizeClientPreworld({ outcome: 'boot_slow', stage: 'world_cache' })!.stage).toBe('world_cache');
  });

  it('POST /client-preworld logs boot_done with its stream reports', async () => {
    const c = resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
    c.wsPort = 0;
    const lines: Array<[string, string, Record<string, unknown>]> = [];
    const bridge = createBridgeServer(c, { log: (level, event, fields) => { lines.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const h = harness();
      h.r.bootStage('world_cache');
      h.advance(BOOT_SLOW_MS);
      h.r.bootStream('all', warmAll);
      h.state.screen = 'server-select';
      h.advance(1000);
      const done = h.sent.find((e) => e.outcome === 'boot_done')!;
      const res = await fetch(`http://127.0.0.1:${port}/client-preworld`, { method: 'POST', body: JSON.stringify(done), headers: { 'content-type': 'text/plain' } });
      expect(res.status).toBe(204);
      const line = lines.find((l) => l[1] === 'client_preworld')!;
      expect(line[2]).toMatchObject({ outcome: 'boot_done', stream: [{ scope: 'all', ms: 23_456, worldCacheMs: 21_000, worldCached: true, cacheObjects: 4321 }] });
    } finally {
      await bridge.shutdown();
    }
  });
});
