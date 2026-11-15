/**
 * PERF.render-adapt-cpu-bound — a Reddit player on an old Mac: "the graphics
 * often appear blurry". Prod first_minute 2026-11-15 (build 6b7d0512c398):
 * a MacBook Air (Intel HD 5000, dpr 1) sat at the 50 % floor with a 33 ms
 * median frame and 28 ms of CPU work, its render phase dearer at half size
 * than at full size elsewhere: draw-call bound, not pixel bound. And fast
 * machines (RTX 4070 at 8 ms frames, RTX 5080 / Apple GPU / Intel HD 520 at
 * 16 ms) were at the floor at the 60 s mark after loading.
 *
 * Drives the real DynamicResolution with a fake clock and a vsync-paced
 * machine model (CPU and GPU pipelined; each interval is the next refresh
 * after the slower of the two; the host reports the CPU part as the frame's
 * work, as main.ts does). Both directions: a CPU-set or fast machine comes
 * back to full, and a fill-bound one (software GL, high dpr, weak GPU) still
 * steps down. Era-independent: the scene renderer is shared by end of retail,
 * Dark Majesty and AC1999.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  DynamicResolution, DOWN_MS, UP_MS, VSYNC_MS,
} from '../packages/renderer/src/scene/DynamicResolution.js';
import {
  minRenderPixelRatio, MIN_RENDER_PIXEL_RATIO, HARDWARE_MIN_RENDER_PIXEL_RATIO, setRenderAdaptConfig,
} from '../packages/renderer/src/scene/RenderScale.js';
import { SceneManager } from '../packages/renderer/src/scene/SceneManager.js';

afterEach(() => setRenderAdaptConfig({ dynamic: false, software: false }));

interface Sim { ctrl: DynamicResolution; t: number; changes: Array<[number, number, number]> }

function sim(opts: { max?: number; min?: number; start?: number; distanceSteps?: number }): Sim {
  const s: Sim = { ctrl: null as unknown as DynamicResolution, t: 0, changes: [] };
  s.ctrl = new DynamicResolution({
    max: opts.max ?? 1, min: opts.min ?? 0.5, start: opts.start, maxDistanceSteps: opts.distanceSteps ?? 0,
    onChange: (r, d) => s.changes.push([s.t, r, d]),
  });
  return s;
}

type Model = (ratio: number, steps: number, t: number) => { cpu: number; gpu: number };

/** `ms` of vsync-paced frames; returns the ratio over time as [t, ratio] at every frame. */
function runPaced(s: Sim, ms: number, model: Model, refreshMs = VSYNC_MS): Array<[number, number]> {
  const trace: Array<[number, number]> = [];
  const end = s.t + ms;
  while (s.t < end) {
    const { cpu, gpu } = model(s.ctrl.ratio, s.ctrl.distanceSteps, s.t);
    s.t += Math.ceil(Math.max(cpu, gpu) / refreshMs - 1e-9) * refreshMs;
    s.ctrl.frame(s.t, true, cpu);
    trace.push([s.t, s.ctrl.ratio]);
  }
  return trace;
}

/** Share of the trace's time spent at or below `ratio`. */
function shareAtOrBelow(trace: Array<[number, number]>, ratio: number): number {
  let below = 0;
  for (let i = 1; i < trace.length; i++) if (trace[i][1] <= ratio + 1e-9) below += trace[i][0] - trace[i - 1][0];
  return below / (trace.at(-1)![0] - trace[0][0]);
}

describe('PERF.render-adapt-cpu-bound — a CPU-set (draw-call bound) machine does not sit at a blurry buffer', () => {
  it('05:13Z shape: HD 5000 at the floor, 33 ms vsync-quantized frames, 28 ms CPU work: probes back up to full', () => {
    const s = sim({ max: 1, min: 0.5, start: 0.5, distanceSteps: 2 });
    s.ctrl.setMaxDistanceSteps(2);
    // Put it where prod saw it: floor and two distance steps (a heavy scene did it).
    runPaced(s, 30_000, () => ({ cpu: 45, gpu: 10 }));
    expect(s.ctrl.distanceSteps).toBe(2);
    // The normal scene: 28 ms of CPU, a GPU that is fine at any size (render 13 ms at full size).
    const model: Model = (r) => ({ cpu: 28, gpu: 5 + 8 * r * r });
    const trace = runPaced(s, 3 * 60_000, model);
    expect(33).toBeGreaterThan(UP_MS);
    expect(33).toBeLessThan(DOWN_MS);
    expect(s.ctrl.ratio).toBe(1);
    // Within the first minute of the scene, not eventually.
    const full = trace.find(([, r]) => r === 1)!;
    expect(full[0] - trace[0][0]).toBeLessThan(75_000);
    // Draw distance (the real cost) is not given back while the CPU still sets the frame.
    expect(s.ctrl.distanceSteps).toBe(2);
  });

  it('a heavy moment on a CPU-set machine takes draw distance, not resolution; the ratio never stays low', () => {
    const s = sim({ max: 1, min: 0.5, distanceSteps: 2 });
    // 40 ms of CPU (50 ms intervals) for a minute: draw calls are the cost, pixels free.
    const trace = runPaced(s, 60_000, () => ({ cpu: 40, gpu: 8 }));
    expect(s.ctrl.distanceSteps).toBe(2);
    // Any ratio step tried (distance exhausted) was undone: the frame did not get faster.
    expect(s.ctrl.ratio).toBe(1);
    expect(shareAtOrBelow(trace, 0.95)).toBeLessThan(0.15);
  });

  it('when distance does help, the CPU-set heavy moment is fixed by distance alone', () => {
    const s = sim({ max: 1, min: 0.5, distanceSteps: 2 });
    runPaced(s, 60_000, (_r, d) => ({ cpu: d === 0 ? 40 : 28, gpu: 8 }));
    expect(s.ctrl.distanceSteps).toBe(1);
    expect(s.changes.every(([, r]) => r === 1)).toBe(true);
  });
});

describe('PERF.render-adapt-cpu-bound — a fast machine comes back to full quickly after loading drove it down', () => {
  it('dcae632b shape: RTX 4070, 120 Hz, 8 ms frames, 3 ms work: a load burst that ends just after the step (a false gain) costs under 10 s of blur', () => {
    const s = sim({ max: 1, min: 0.5, distanceSteps: 2 });
    // 2.5 s of 120 ms frames (streaming in): the first window steps straight to the floor (a FAR step)...
    const burst: Model = (_r, _d, t) => (t < 2500 ? { cpu: 3, gpu: 120 } : { cpu: 3, gpu: 6 });
    const trace = runPaced(s, 40_000, burst, 1000 / 120);
    expect(s.changes[0][1]).toBe(0.5);
    // ...and the next window, fast because the load ended, counts as a gain: the step stays.
    expect(s.changes[1][1]).toBeGreaterThan(0.5);
    expect(s.changes[1][0] - s.changes[0][0]).toBeGreaterThan(4_000);
    // Back at full within 10 s of the step (one UP_FACTOR step per ~3 s took ~23 s).
    expect(trace.find(([t, r]) => t > s.changes[0][0] && r === 1)![0] - s.changes[0][0]).toBeLessThan(10_000);
    expect(s.ctrl.ratio).toBe(1);
    expect(s.ctrl.distanceSteps).toBe(0);
  });

  it('9caddc3e / a5d94cbf shape: vsync-capped 16.7 ms frames at the floor climb to full within 15 s', () => {
    for (const work of [3, 12]) {
      const s = sim({ max: 1, min: 0.5, start: 0.5, distanceSteps: 2 });
      s.ctrl.setMaxDistanceSteps(2);
      runPaced(s, 5_000, () => ({ cpu: 3, gpu: 150 })); // the loading that put it here
      const at = s.t;
      const trace = runPaced(s, 30_000, () => ({ cpu: work, gpu: 4 }));
      expect(s.ctrl.ratio).toBe(1);
      expect(s.ctrl.distanceSteps).toBe(0);
      expect(trace.find(([, r]) => r === 1)![0] - at).toBeLessThan(15_000);
    }
  });

  it('1472a502 shape: Apple GPU at dpr 2, 17 ms frames at 48 %: back to dpr 2', () => {
    const s = sim({ max: 2, min: minRenderPixelRatio(2, false), start: 0.95 });
    const trace = runPaced(s, 20_000, (r) => ({ cpu: 3, gpu: 2 + 2 * r * r }));
    expect(s.ctrl.ratio).toBe(2);
    expect(trace.find(([, r]) => r === 2)![0]).toBeLessThan(10_000);
  });
});

describe('PERF.render-adapt-cpu-bound — the inverse: fill-bound machines still step down', () => {
  it('vsync-quantized 30 FPS that the GPU sets (5 ms CPU) at full: never moves', () => {
    const s = sim({ max: 1, min: 0.5, distanceSteps: 2 });
    runPaced(s, 5 * 60_000, () => ({ cpu: 5, gpu: 25 }));
    expect(s.changes).toEqual([]);
  });

  it('GPU-bound at 50 ms (18 ms CPU): steps down to 30 FPS and holds; probes that cost frames are undone and get rarer', () => {
    const s = sim({ max: 1, min: 0.5 });
    const model: Model = (r) => ({ cpu: 18, gpu: 40 * r * r });
    runPaced(s, 10_000, model);
    expect(s.ctrl.ratio).toBeLessThan(1);
    const settled = s.ctrl.ratio;
    expect(Math.max(18, 40 * settled * settled)).toBeLessThanOrEqual(DOWN_MS);
    const before = s.changes.length;
    const trace = runPaced(s, 10 * 60_000, model);
    // Most of the time at the settled ratio, with only a few probes (each undone).
    expect(shareAtOrBelow(trace, settled)).toBeGreaterThan(0.97);
    const probes = s.changes.slice(before).filter(([, r], i, a) => r > (i > 0 ? a[i - 1][1] : settled));
    expect(probes.length).toBeLessThanOrEqual(4);
    expect(s.ctrl.ratio).toBe(settled);
  });

  it('software GL whose submission blocks (work = the whole frame): distance first, then still reaches its floor', () => {
    const s = sim({ max: 1, min: MIN_RENDER_PIXEL_RATIO, distanceSteps: 2 });
    const model: Model = (r) => { const c = 8 + 140 * r * r; return { cpu: c, gpu: c }; };
    runPaced(s, 60_000, model);
    expect(s.ctrl.distanceSteps).toBe(2);
    expect(s.ctrl.ratio).toBe(0.5);
    // And it stays low: a probe up costs frames and is undone.
    const trace = runPaced(s, 5 * 60_000, model);
    expect(shareAtOrBelow(trace, 0.5)).toBeGreaterThan(0.95);
  });

  it('31fde75e / UHD 630 at dpr 2: 300 ms frames at full size step down within seconds and settle under the threshold', () => {
    const s = sim({ max: 2, min: minRenderPixelRatio(2, false) });
    // Calibrated to prod: ~300 ms at ratio 2, ~33 ms (24 ms work) at ratio 1.
    const model: Model = (r) => ({ cpu: 24, gpu: 300 * (r / 2) ** 3.1 });
    runPaced(s, 15_000, model);
    expect(s.changes[0][0]).toBeLessThan(4_000);
    expect(s.ctrl.ratio).toBeLessThanOrEqual(1.25);
    const trace = runPaced(s, 5 * 60_000, model);
    const slow = trace.filter(([, r]) => Math.max(24, 300 * (r / 2) ** 3.1) > DOWN_MS).length;
    expect(slow / trace.length).toBeLessThan(0.1);
  });

  it('frames without work samples (a host that does not measure) keep the frame-interval-only rules', () => {
    const s = sim({ max: 1, min: 0.5 });
    let t = 0;
    for (let i = 0; i < 2000; i++) { t += 4 + 76 * s.ctrl.ratio * s.ctrl.ratio; s.ctrl.frame(t, true); }
    expect(s.ctrl.ratio).toBeLessThan(1);
  });
});

describe('PERF.render-adapt-cpu-bound — the floor: hardware 0.75, software 0.5', () => {
  it('minRenderPixelRatio', () => {
    expect(minRenderPixelRatio(1, false)).toBe(HARDWARE_MIN_RENDER_PIXEL_RATIO);
    expect(minRenderPixelRatio(2, false)).toBe(0.75);
    expect(minRenderPixelRatio(1, true)).toBe(MIN_RENDER_PIXEL_RATIO);
    expect(minRenderPixelRatio(0.6, false)).toBe(0.6); // never above the device ratio
    expect(minRenderPixelRatio(NaN, true)).toBe(0.5);
  });

  for (const software of [false, true]) {
    it(`SceneManager: a ${software ? 'software' : 'hardware'} GPU's slowest frames stop at ${software ? 0.5 : 0.75}`, () => {
      setRenderAdaptConfig({ dynamic: true, software });
      const sm = new SceneManager();
      sm.renderer = { setPixelRatio: () => {}, setSize: () => {} } as never;
      sm.resize(1400, 900);
      const dyn = sm.dynamicResolution!;
      let t = 0;
      for (let i = 0; i < 3000; i++) { t += 200 * dyn.ratio * dyn.ratio + 30; dyn.frame(t, true, 2); }
      expect(dyn.ratio).toBe(software ? 0.5 : 0.75);
    });
  }
});
