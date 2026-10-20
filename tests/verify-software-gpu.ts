/**
 * PERF.render-adapt — the client adapts its 3D buffer to the machine instead
 * of asking the player to change settings (production first minute
 * 2026-10-14: gpu="software", 2500×1200 canvas, 80 ms median frame).
 *
 * Drives the real boot/Capability.ts probe (a fake window whose WebGL context
 * reports a SwiftShader / hardware renderer), the real DynamicResolution
 * controller with a fake clock and a frame-cost model, the real
 * SceneManager.resize against a fake WebGLRenderer, the draw-distance ladder,
 * the real WorldReporter and both bridge sanitizers. Era-independent: boot
 * and the scene renderer are shared by every era (end of retail, Dark
 * Majesty, AC1999), so nothing here is keyed on an era.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { capabilityProblems, probeCapabilities, renderAdaptFor } from '../packages/renderer/src/boot/Capability.js';
import {
  renderPixelRatio, renderAdaptConfigFor, setRenderAdaptConfig, renderAdaptConfig, contextAntialias,
  SOFTWARE_START_BUFFER_PIXELS, MIN_RENDER_PIXEL_RATIO,
} from '../packages/renderer/src/scene/RenderScale.js';
import { DynamicResolution, DOWN_MS, UP_MS, STALL_MS, LONG_FRAME_CAP_MS } from '../packages/renderer/src/scene/DynamicResolution.js';
import { SceneManager } from '../packages/renderer/src/scene/SceneManager.js';
import { adaptedDrawDistance, adaptiveDrawDistanceSteps } from '../packages/renderer/src/world/LandscapeDrawDistance.js';
import { WorldReporter, type FirstMinuteEvent } from '../packages/renderer/src/telemetry/WorldReporter.js';
import { PreworldReporter, CAPABILITY_ISSUES } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld.js';
import { sanitizeClientPreworld, CAPABILITY_ISSUES as BRIDGE_CAPS } from '../services/ws-tcp-bridge/src/clientPreworld.js';

const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const BASIC_RENDER = 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const NVIDIA = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)';

type ProbeWindow = Parameters<typeof probeCapabilities>[0];

/** A window whose canvas gives a WebGL 2 context reporting `renderer`. */
function fakeWindow(renderer: string | null, opts: { webdriver?: boolean; search?: string } = {}): ProbeWindow {
  const gl = {
    getExtension: (name: string) => {
      if (name === 'WEBGL_debug_renderer_info') return renderer === null ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 };
      if (name === 'WEBGL_lose_context') return { loseContext: () => {} };
      return null;
    },
    getParameter: (p: number) => (p === 0x9246 ? renderer : null),
  };
  return {
    document: { createElement: () => ({ getContext: (kind: string) => (kind === 'webgl2' ? gl : null) }) },
    navigator: { webdriver: opts.webdriver ?? false, deviceMemory: 8 },
    location: { search: opts.search ?? '' },
    WebSocket: function WebSocket() {},
    matchMedia: () => ({ matches: true }),
  } as unknown as ProbeWindow;
}

afterEach(() => setRenderAdaptConfig({ dynamic: false, software: false }));

describe('PERF.render-adapt — detection at boot (no prompt)', () => {
  it('software WebGL is detected but never shown to the player', () => {
    for (const r of [SWIFTSHADER, BASIC_RENDER, 'llvmpipe (LLVM 15.0.7, 256 bits)']) {
      const env = probeCapabilities(fakeWindow(r));
      expect(env.softwareGpu).toBe(true);
      expect(capabilityProblems(env)).toEqual([]);
      expect(renderAdaptFor(env)).toEqual({ dynamic: true, software: true });
    }
    const hw = probeCapabilities(fakeWindow(NVIDIA));
    expect(hw.softwareGpu).toBe(false);
    expect(renderAdaptFor(hw)).toEqual({ dynamic: true, software: false });
    // A browser that hides the renderer string is not assumed software.
    expect(probeCapabilities(fakeWindow(null)).softwareGpu).toBe(false);
  });

  it('automation (navigator.webdriver: the capture / agent tools on SwiftShader) keeps today\'s buffer unless ?renderAdapt=1; ?renderAdapt=0 turns it off', () => {
    expect(renderAdaptFor(probeCapabilities(fakeWindow(SWIFTSHADER, { webdriver: true })))).toEqual({ dynamic: false, software: false });
    expect(renderAdaptFor(probeCapabilities(fakeWindow(SWIFTSHADER, { webdriver: true, search: '?ace&renderAdapt=1' }))))
      .toEqual({ dynamic: true, software: true });
    expect(renderAdaptFor(probeCapabilities(fakeWindow(SWIFTSHADER, { search: '?renderAdapt=0' })))).toEqual({ dynamic: false, software: false });
    expect(renderAdaptConfigFor({ software: false, webdriver: false, override: 'yes' })).toEqual({ dynamic: true, software: false });
  });

  it('context options: MSAA off only for software rendering', () => {
    expect(contextAntialias({ dynamic: true, software: true })).toBe(false);
    expect(contextAntialias({ dynamic: true, software: false })).toBe(true);
    expect(contextAntialias({ dynamic: false, software: false })).toBe(true);
    setRenderAdaptConfig({ dynamic: true, software: true });
    expect(contextAntialias()).toBe(false);
  });
});

// ── The controller, against a fake clock and a frame-cost model ──────────────

interface Sim { ctrl: DynamicResolution; t: number; changes: Array<[number, number, number]> }

function sim(opts: { max?: number; min?: number; start?: number; distanceSteps?: number } = {}): Sim {
  const s: Sim = { ctrl: null as unknown as DynamicResolution, t: 0, changes: [] };
  s.ctrl = new DynamicResolution({
    max: opts.max ?? 1, min: opts.min ?? 0.5, start: opts.start, maxDistanceSteps: opts.distanceSteps ?? 0,
    onChange: (r, d) => s.changes.push([s.t, r, d]),
  });
  return s;
}

/** Run `ms` of frames whose length is `cost(ratio, distanceSteps, t)`. */
function run(s: Sim, ms: number, cost: (ratio: number, steps: number, t: number) => number, eligible: (t: number) => boolean = () => true): void {
  const end = s.t + ms;
  while (s.t < end) {
    s.t += cost(s.ctrl.ratio, s.ctrl.distanceSteps, s.t);
    s.ctrl.frame(s.t, eligible(s.t));
  }
}

/** A pixel-bound machine: `fullMs` at ratio 1, cost following the pixel count, plus a fixed CPU part. */
const fillBound = (fullMs: number, cpuMs = 4) => (r: number) => cpuMs + (fullMs - cpuMs) * r * r;

describe('PERF.render-adapt — DynamicResolution', () => {
  it('a healthy GPU stays at full resolution: 60 FPS with hitches, stalls, portal space and a hidden tab never move it', () => {
    const s = sim();
    run(s, 10 * 60_000, (_r, _d, t) => {
      if (t % 7000 < 17) return 180; // a hitch (streamed landblock / GC) every 7 s
      if (t % 30_000 < 17) return 2000; // a stall (tab switched): over STALL_MS, dropped
      return 16.7;
    }, (t) => !(t % 60_000 < 8000)); // 8 s of portal space every minute, frames there are ineligible
    // Portal space's own frames are slow; they are never measured.
    run(s, 20_000, () => 120, () => false);
    expect(STALL_MS).toBe(250);
    expect(s.ctrl.ratio).toBe(1);
    expect(s.changes).toEqual([]);
  });

  it('a 40 FPS machine (25 ms frames) also stays at full: inside the hysteresis band', () => {
    const s = sim();
    run(s, 5 * 60_000, () => 25);
    expect(25).toBeLessThan(DOWN_MS);
    expect(25).toBeGreaterThan(UP_MS);
    expect(s.changes).toEqual([]);
  });

  it('slow frames step down until frames are under the threshold, then hold still (no oscillation)', () => {
    const s = sim();
    const cost = fillBound(80);
    run(s, 60_000, cost);
    expect(s.ctrl.ratio).toBeLessThan(1);
    expect(cost(s.ctrl.ratio)).toBeLessThanOrEqual(DOWN_MS);
    const settled = s.ctrl.ratio;
    const n = s.changes.length;
    run(s, 10 * 60_000, cost);
    expect(s.ctrl.ratio).toBe(settled);
    expect(s.changes.length).toBe(n);
    // Each step went down; no step ever went back up.
    for (let i = 1; i < s.changes.length; i++) expect(s.changes[i][1]).toBeLessThan(s.changes[i - 1][1]);
  });

  it('recovers when frames get cheap again, back to full resolution, without overshooting into slow frames', () => {
    const s = sim();
    run(s, 60_000, fillBound(80));
    expect(s.ctrl.ratio).toBeLessThan(0.8);
    const cheap = fillBound(14, 3);
    run(s, 10 * 60_000, cheap);
    expect(s.ctrl.ratio).toBe(1);
    // A second slowdown steps down again.
    run(s, 60_000, fillBound(70));
    expect(s.ctrl.ratio).toBeLessThan(1);
  });

  it('a machine just over budget at full settles once (raise predicted too expensive), no pumping', () => {
    const s = sim();
    const cost = fillBound(44);
    run(s, 20 * 60_000, cost);
    expect(s.changes.length).toBe(1);
    expect(s.ctrl.ratio).toBeGreaterThanOrEqual(0.8);
  });

  it('software rendering starts at ~1280×720 of pixels', () => {
    const start = renderPixelRatio(1, 2500, 1200, true);
    expect(Math.floor(2500 * start) * Math.floor(1200 * start)).toBeLessThanOrEqual(SOFTWARE_START_BUFFER_PIXELS);
    expect(start).toBeGreaterThan(MIN_RENDER_PIXEL_RATIO);
    const s = sim({ start });
    expect(s.ctrl.ratio).toBeCloseTo(start, 9);
    expect(s.ctrl.scale).toBeCloseTo(start, 9);
    // Without the cap the ratio is the device's, and a small window is not upscaled.
    expect(renderPixelRatio(2.5, 2500, 1200, false)).toBe(2.5);
    expect(renderPixelRatio(1, 1000, 600, true)).toBe(1);
  });

  it('never below the floor; at the floor and still slow, draw distance steps down; it comes back first on recovery', () => {
    const s = sim({ distanceSteps: 2 });
    // Pixel-bound but very slow, and distance helps too.
    const cost = (r: number, d: number) => (8 + 140 * r * r) * (d === 0 ? 1 : d === 1 ? 0.75 : 0.6);
    run(s, 3 * 60_000, cost);
    expect(s.ctrl.ratio).toBe(0.5);
    expect(s.ctrl.distanceSteps).toBeGreaterThan(0);
    run(s, 10 * 60_000, () => 10);
    expect(s.ctrl.distanceSteps).toBe(0);
    expect(s.ctrl.ratio).toBe(1);
    const firstUp = s.changes.findIndex(([, , d], i) => i > 0 && d < s.changes[i - 1][2]);
    const ratioUpAfterDistance = s.changes.findIndex(([, r], i) => i > 0 && r > s.changes[i - 1][1]);
    expect(firstUp).toBeGreaterThan(-1);
    expect(ratioUpAfterDistance).toBeGreaterThan(firstUp);
  });

  it('frames not bound by pixels: a step down that buys nothing is undone; draw distance is used instead', () => {
    const s = sim({ distanceSteps: 3 });
    run(s, 60_000, (_r, d) => 60 - d * 8);
    expect(s.ctrl.ratio).toBe(1);
    expect(s.ctrl.distanceSteps).toBeGreaterThan(0);
    expect(s.changes[0][1]).toBeLessThan(1); // the one tried step
    expect(s.changes[1][1]).toBe(1); // undone
  });

  it('a new display (devicePixelRatio) keeps a full-resolution machine at full', () => {
    const s = sim({ max: 1 });
    s.ctrl.setBounds(0.5, 2);
    expect(s.ctrl.ratio).toBe(2);
    expect(s.changes).toEqual([]);
  });
});

// PERF.slow-first-minute-diagnostics (prod 2026-10-20, build 55c0255e): an Intel
// UHD 630 Mac at dpr 2 (2600×1400 buffer) drew every frame in 250–330 ms for
// its whole first minute and renderScalePct stayed 100: every interval was
// over STALL_MS, dropped as a hitch, so the window never filled.
describe('PERF.render-adapt — DynamicResolution on a machine whose every frame is slow', () => {
  /** Deterministic 250–330 ms jitter around a frame cost. */
  const jitter = (base: number) => { let i = 0; return () => base * (0.85 + 0.25 * (((i++ * 7919) % 101) / 100)); };

  it('steady ~300 ms frames at dpr 2: the first step comes within a few seconds, and the floor is reached while frames stay slow', () => {
    const s = sim({ max: 2, min: 0.5 });
    const j = jitter(1);
    // GPU-bound: 300 ms at full size, still ~160 ms at the floor (frames stay slow).
    const cost = (r: number) => (150 + 150 * (r / 2) ** 2) * j();
    expect(cost(2)).toBeGreaterThan(STALL_MS);
    run(s, 6_000, cost);
    expect(s.changes.length).toBeGreaterThan(0);
    expect(s.changes[0][0]).toBeLessThan(4_000);
    // The first step from a 300 ms median is a big one (half the ratio: a quarter of the pixels).
    expect(s.changes[0][1]).toBeLessThanOrEqual(1);
    run(s, 9_000, cost);
    expect(s.ctrl.ratio).toBe(0.5);
    expect(s.changes.at(-1)![0]).toBeLessThan(12_000);
    // Each step went down; none was undone (each one helped).
    for (let i = 1; i < s.changes.length; i++) expect(s.changes[i][1]).toBeLessThan(s.changes[i - 1][1]);
    const n = s.changes.length;
    run(s, 60_000, cost);
    expect(s.changes.length).toBe(n);
  });

  it('a pixel-bound 300 ms machine settles where frames are under the threshold', () => {
    const s = sim({ max: 2, min: 0.5 });
    const cost = (r: number) => 4 + 296 * (r / 2) ** 2;
    run(s, 30_000, cost);
    expect(cost(s.ctrl.ratio)).toBeLessThanOrEqual(DOWN_MS);
    expect(s.changes[0][0]).toBeLessThan(4_000);
  });

  it('steady slow frames that pixels do not cause: the step is undone (no gain), and draw distance is used instead', () => {
    const s = sim({ max: 2, min: 0.5, distanceSteps: 2 });
    run(s, 30_000, (_r, d) => 300 - d * 60);
    expect(s.changes[0][1]).toBeLessThan(2); // the one tried step
    expect(s.changes[1][1]).toBe(2); // undone
    expect(s.ctrl.ratio).toBe(2);
    expect(s.ctrl.distanceSteps).toBe(2);
  });

  it('isolated 400 ms hitches (and back-to-back pairs) among 16 ms frames never move it', () => {
    const s = sim({ max: 2, min: 0.5 });
    let n = 0;
    run(s, 5 * 60_000, () => {
      n++;
      if (n % 180 === 0) return 400; // a lone hitch every ~3 s
      if (n % 600 === 1 || n % 600 === 2) return 400; // two in a row every ~10 s
      return 16.7;
    });
    expect(s.changes).toEqual([]);
    expect(s.ctrl.ratio).toBe(2);
  });

  it('steady 16 ms frames stay at full resolution', () => {
    const s = sim({ max: 2, min: 0.5 });
    run(s, 5 * 60_000, () => 16.7);
    expect(s.changes).toEqual([]);
    expect(s.ctrl.scale).toBe(1);
  });

  it('a slow run counts its long frames clamped: multi-second frames still step down, not a stall forever', () => {
    const s = sim({ max: 2, min: 0.5 });
    run(s, 20_000, (r) => 300 + 2700 * (r / 2) ** 2); // 3 s frames at full size
    expect(LONG_FRAME_CAP_MS).toBeLessThan(3000);
    expect(s.ctrl.ratio).toBeLessThan(2);
  });
});

describe('PERF.render-adapt — SceneManager sizing (fake renderer)', () => {
  function fakeRenderer() {
    const calls: Array<[string, ...number[]]> = [];
    return {
      calls,
      setPixelRatio: (r: number) => { calls.push(['setPixelRatio', r]); },
      setSize: (w: number, h: number) => { calls.push(['setSize', w, h]); },
    };
  }

  it('adaptation off (automation): resize never touches the pixel ratio and no controller exists (today\'s behaviour)', () => {
    const sm = new SceneManager();
    const r = fakeRenderer();
    sm.renderer = r as never;
    expect(renderAdaptConfig().dynamic).toBe(false);
    sm.resize(2500, 1200);
    expect(r.calls).toEqual([['setSize', 2500, 1200]]);
    expect(sm.dynamicResolution).toBeNull();
  });

  it('hardware GPU: the buffer starts at the device ratio, CSS size unchanged', () => {
    setRenderAdaptConfig({ dynamic: true, software: false });
    const sm = new SceneManager();
    const r = fakeRenderer();
    sm.renderer = r as never;
    sm.resize(2500, 1200);
    expect(r.calls).toEqual([['setPixelRatio', 1], ['setSize', 2500, 1200]]);
    expect(sm.dynamicResolution!.scale).toBe(1);
  });

  it('software: starts at ~720p of pixels; controller steps reach the renderer; draw-distance steps reach the host', () => {
    setRenderAdaptConfig({ dynamic: true, software: true });
    const sm = new SceneManager();
    const r = fakeRenderer();
    sm.renderer = r as never;
    const steps: number[] = [];
    sm.onDrawDistanceSteps = (n) => steps.push(n);
    sm.resize(2500, 1200);
    expect(r.calls[0][0]).toBe('setPixelRatio');
    expect(r.calls[0][1]).toBeCloseTo(renderPixelRatio(1, 2500, 1200, true), 9);
    expect(r.calls[1]).toEqual(['setSize', 2500, 1200]);
    const dyn = sm.dynamicResolution!;
    dyn.setMaxDistanceSteps(2);
    // Very slow, pixel-bound frames: down to the floor, then a draw-distance step.
    let t = 0;
    for (let i = 0; i < 4000; i++) { t += 30 + 300 * dyn.ratio * dyn.ratio; dyn.frame(t, true); }
    expect(dyn.ratio).toBe(0.5);
    expect(r.calls.filter(c => c[0] === 'setPixelRatio').at(-1)).toEqual(['setPixelRatio', 0.5]);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.at(-1)).toBe(dyn.distanceSteps);
  });
});

describe('PERF.render-adapt — draw-distance ladder (the player\'s setting is the ceiling)', () => {
  it('steps down the menu ladder from the player\'s value, never below 3', () => {
    expect(adaptedDrawDistance(8, 0)).toBe(8);
    expect(adaptedDrawDistance(8, 1)).toBe(5);
    expect(adaptedDrawDistance(8, 2)).toBe(3);
    expect(adaptedDrawDistance(8, 5)).toBe(3);
    expect(adaptedDrawDistance(25, 1)).toBe(15);
    expect(adaptedDrawDistance(3, 2)).toBe(3);
    expect(adaptedDrawDistance(10, 1)).toBe(8); // a non-ladder value steps to the entry below it
    expect(adaptiveDrawDistanceSteps(8)).toBe(2);
    expect(adaptiveDrawDistanceSteps(3)).toBe(0);
    expect(adaptiveDrawDistanceSteps(25)).toBe(5);
    expect(adaptiveDrawDistanceSteps(10)).toBe(3);
  });
});

describe('PERF.render-adapt — telemetry', () => {
  function minute(src: { scale: number; msaaOff: boolean; steps: number }, gpu: 'software' | 'discrete'): FirstMinuteEvent {
    const sent: string[] = [];
    let t = 0;
    const r = new WorldReporter({
      endpoint: 'http://x/client-preworld', build: 'b1', trace: 'feedc0de12345678', era: () => 'eor', server: () => null,
      now: () => t, send: (_u, b) => { sent.push(b); },
    });
    r.setSources({
      renderScale: () => src.scale, msaaOff: () => src.msaaOff, drawDistanceSteps: () => src.steps,
      canvas: () => ({ width: 2500, height: 1200 }), dpr: () => 1,
    });
    r.setGpu(gpu);
    r.enteredWorld();
    for (; t < 2000; t += 80) r.frame(t, true);
    r.left('closed_tab');
    return JSON.parse(sent[0]) as FirstMinuteEvent;
  }

  it('first_minute carries the settled scale, MSAA off and draw-distance steps; the bridge keeps them in bounds', () => {
    const sw = minute({ scale: 0.554, msaaOff: true, steps: 1 }, 'software');
    expect(sw).toMatchObject({ gpu: 'software', renderScalePct: 55, msaaOff: true, drawDistanceSteps: 1 });
    expect(sanitizeClientWorld(sw)).toEqual(sw);
    const hw = minute({ scale: 1, msaaOff: false, steps: 0 }, 'discrete');
    expect(hw).toMatchObject({ renderScalePct: 100, msaaOff: false, drawDistanceSteps: 0 });
    expect(sanitizeClientWorld(hw)).toEqual(hw);
    expect(minute({ scale: NaN, msaaOff: false, steps: 99 }, 'discrete')).toMatchObject({ renderScalePct: 100, drawDistanceSteps: 5 });
    expect(sanitizeClientWorld({ ...sw, renderScalePct: 0, msaaOff: 'yes', drawDistanceSteps: 6 }))
      .toMatchObject({ renderScalePct: null, msaaOff: null, drawDistanceSteps: null });
    expect((sanitizeClientWorld({ ...sw, renderScalePct: 55.5 }) as FirstMinuteEvent).renderScalePct).toBeNull();
  });

  it('software_gpu is a closed capability id on both sides of the pre-world route (reported, not shown)', () => {
    expect([...CAPABILITY_ISSUES]).toContain('software_gpu');
    expect([...BRIDGE_CAPS]).toEqual([...CAPABILITY_ISSUES]);
    expect(sanitizeClientPreworld({ outcome: 'boot_slow', caps: ['software_gpu', 'Bob'] })!.caps).toEqual(['software_gpu']);
    const pr = new PreworldReporter({
      endpoint: 'http://x/client-preworld', build: 'b1', era: () => 'eor', server: () => null, screen: () => 'boot',
      send: () => {},
    } as never);
    pr.capabilityIssues(['software_gpu']);
    expect(pr.bootSnapshot().caps).toEqual(['software_gpu']);
  });
});
