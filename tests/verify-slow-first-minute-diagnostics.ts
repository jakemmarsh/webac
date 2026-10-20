/**
 * PERF.slow-first-minute-diagnostics (2026-10-20). About 10% of end-of-retail first minutes ran at 3-4 fps
 * (frameMedianMs / p95 pinned at the then 250 ms histogram cap, now 2000 ms), discrete GPUs included, while the same build ran
 * 120 fps here at Holtburg on local and streamed DATs. The event had nothing to say why, so it now carries
 * the uncapped mean interval, our own per-frame JS time, long tasks, draw calls / triangles, the landblock,
 * the browser / OS family, the WebGL renderer string, cores and memory, and the bridge keeps them.
 *
 * Drives the real WorldReporter with a fake clock (as verify-first-minute-telemetry.ts) and the real bridge
 * sanitizer.
 */
import { describe, it, expect } from 'vitest';
import {
  WorldReporter, browserOf, gpuNameOf, HIST_MAX_MS, type WorldEvent, type FirstMinuteEvent,
} from '../packages/renderer/src/telemetry/WorldReporter';
import { FRAME_HIST_MAX_MS, sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld';
import { CLIENT_PREWORLD_MAX_BODY } from '../services/ws-tcp-bridge/src/clientPreworld';

const CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const RTX = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)';

function rig(draw = { calls: 900, triangles: 250_000 }, landblock: number | null = 0xa9b4) {
  const events: WorldEvent[] = [];
  const clock = { t: 1000 };
  const r = new WorldReporter({
    endpoint: 'http://x/client-preworld', build: 'abc1234', trace: 'feedc0de12345678', era: () => 'eor', server: () => 'levistras',
    now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b) as WorldEvent); },
  });
  r.setSources({ screen: () => 'world', drawStats: () => draw, landblock: () => landblock, canvas: () => ({ width: 2500, height: 1200 }), dpr: () => 1 });
  r.setGpu('discrete', RTX);
  r.setDevice({ userAgent: CHROME_WIN, hardwareConcurrency: 8, deviceMemory: 8 });
  return { r, events, clock };
}

const first = (events: WorldEvent[]) => events.find((e) => e.outcome === 'first_minute') as FirstMinuteEvent;

describe('PERF.slow-first-minute-diagnostics — the reporter', () => {
  it('a 3 fps minute: the real median and p95 (no 250 ms cap), the mean, our JS time, draw stats, landblock, device', () => {
    const { r, events, clock } = rig();
    r.enteredWorld();
    for (let i = 0; i < 180; i++) { clock.t += 333; r.frame(clock.t, true, 40); if (i % 3 === 0) r.tick(); }
    clock.t += 1000; r.tick();
    const ev = first(events);
    expect(ev.frameMedianMs).toBe(333);           // was 250, the old histogram cap, for every slow minute
    expect(ev.frameP95Ms).toBe(333);
    expect(ev.frameMeanMs).toBe(333);             // the real interval
    expect(ev.workMedianMs).toBe(40);             // JS took 40 of 333 ms: the time is spent outside our frame code
    expect(ev.drawCalls).toBe(900);
    expect(ev.triangles).toBe(250_000);
    expect(ev.landblock).toBe('a9b4');
    expect(ev.gpuName).toBe(RTX);
    expect(ev).toMatchObject({ browser: 'chrome', browserMajor: 141, os: 'windows', cores: 8, memGb: 8 });
    expect(ev.longTaskMs).toBeNull();             // no PerformanceObserver here: unknown, not zero
  });

  it('long tasks count inside the first minute only', () => {
    const { r, events, clock } = rig();
    (r as unknown as { longTasksSupported: boolean }).longTasksSupported = true;
    r.enteredWorld();
    r.longTask(120); r.longTask(80);
    for (let i = 0; i < 70; i++) { clock.t += 1000; r.frame(clock.t, true, 5); r.tick(); }
    r.longTask(500);                              // after the event
    expect(first(events).longTaskMs).toBe(200);
  });

  it('draw stats come only from frames that drew the world; a missing landblock or hidden GPU string reads null', () => {
    const { r, events, clock } = rig({ calls: 400, triangles: 10 }, null);
    r.setGpu('unknown', '');
    r.enteredWorld();
    for (let i = 0; i < 70; i++) { clock.t += 1000; r.frame(clock.t, false, 2); r.tick(); }
    const ev = first(events);
    expect(ev.drawCalls).toBeNull();
    expect(ev.landblock).toBeNull();
    expect(ev.gpuName).toBeNull();
  });

  it('browserOf: families and majors from real user agents', () => {
    expect(browserOf(CHROME_WIN)).toEqual({ browser: 'chrome', browserMajor: 141, os: 'windows' });
    expect(browserOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'))
      .toEqual({ browser: 'edge', browserMajor: 141, os: 'windows' });
    expect(browserOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0'))
      .toEqual({ browser: 'firefox', browserMajor: 144, os: 'mac' });
    expect(browserOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'))
      .toEqual({ browser: 'safari', browserMajor: 26, os: 'mac' });
    expect(browserOf('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36').os).toBe('chromeos');
    expect(browserOf(undefined)).toEqual({ browser: 'other', browserMajor: null, os: 'other' });
  });

  it('gpuNameOf keeps printable ASCII, at most 96 characters', () => {
    expect(gpuNameOf('Apple M3 Max')).toBe('Apple M3 Max');
    expect(gpuNameOf('x'.repeat(200))).toHaveLength(96);
    expect(gpuNameOf('Radeon™ Graphics\n')).toBe('Radeon Graphics');
    expect(gpuNameOf(null)).toBeNull();
  });
});

describe('PERF.slow-first-minute-diagnostics — the bridge keeps the fields', () => {
  it('a real event passes the sanitizer whole and fits the body limit', () => {
    const { r, events, clock } = rig();
    r.enteredWorld();
    for (let i = 0; i < 70; i++) { clock.t += 1000; r.frame(clock.t, true, 7); r.tick(); }
    const ev = first(events);
    expect(sanitizeClientWorld(ev)).toEqual(ev);
    expect(JSON.stringify({ ...ev, gpuName: 'x'.repeat(96) }).length).toBeLessThan(CLIENT_PREWORLD_MAX_BODY);
  });

  it('a 3 fps minute passes whole: medians and p95s over the old 250 ms cap are kept, up to FRAME_HIST_MAX_MS', () => {
    const { r, events, clock } = rig();
    r.enteredWorld();
    for (let i = 0; i < 180; i++) { clock.t += 333; r.frame(clock.t, true, 300); if (i % 3 === 0) r.tick(); }
    clock.t += 1000; r.tick();
    const ev = first(events);
    expect(ev.frameMedianMs).toBe(333);
    expect(ev.workMedianMs).toBe(300);
    expect(sanitizeClientWorld(ev)).toEqual(ev);
    expect(sanitizeClientWorld({ ...ev, frameP95Ms: FRAME_HIST_MAX_MS })).toMatchObject({ frameP95Ms: FRAME_HIST_MAX_MS });
    expect(sanitizeClientWorld({ ...ev, frameP95Ms: FRAME_HIST_MAX_MS + 1 })).toMatchObject({ frameP95Ms: null });
    expect(FRAME_HIST_MAX_MS).toBe(HIST_MAX_MS);
  });

  it('out-of-range or free-text values are nulled; an older page that sends none gets none added', () => {
    const { r, events, clock } = rig();
    r.enteredWorld();
    for (let i = 0; i < 70; i++) { clock.t += 1000; r.frame(clock.t, true, 7); r.tick(); }
    const ev = first(events) as unknown as Record<string, unknown>;
    const bad = sanitizeClientWorld({ ...ev, landblock: 'zz', browser: 'netscape', gpuName: 'a\u0001b', memGb: 3, cores: 9999, workMedianMs: 4000 })!;
    expect(bad).toMatchObject({ landblock: null, browser: null, gpuName: null, memGb: null, cores: null, workMedianMs: null });
    const older = { ...ev };
    for (const k of ['frameMeanMs', 'workMedianMs', 'workP95Ms', 'longTaskMs', 'drawCalls', 'triangles', 'landblock', 'browser', 'browserMajor', 'os', 'gpuName', 'cores', 'memGb']) delete older[k];
    expect(Object.keys(sanitizeClientWorld(older)!)).not.toContain('gpuName');
  });
});
