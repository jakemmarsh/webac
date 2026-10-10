/**
 * tools/perf-ratchet-lib — the mechanical half of the perf ratchet.
 * Guards the two ways the ratchet has been fooled: comparing runs from
 * different map locations, and having no real-GPU-flavoured number at all.
 */
import { describe, it, expect } from 'vitest';
import {
  compareRuns, droppedFrameWarnings, estimateRealGpu, findBaseline, isSoftwareRenderer,
  landblockOf, parseDrawDistance, sameLocation, summarizeInfoSamples,
  REAL_GPU_US_PER_DRAW_CALL, type PerfInfoSample, type PerfRun,
} from '../tools/perf-ratchet-lib.js';

const holtburg = { x: 32592, y: 34586, z: 94, landblock: landblockOf(32592, 34586) };
const eastham = { x: 33500, y: 40000, z: 20, landblock: landblockOf(33500, 40000) };

function run(utc: string, drawCalls: number, extra: Partial<PerfRun> = {}): PerfRun {
  return {
    utc, renderer: 'SwiftShader', location: holtburg,
    phases: [{ phase: 'idle', avgFps: 0.4, p95Ms: 2400, hitch50: 7, hitch100: 7 }],
    render: { idle: { drawCalls, triangles: 500_000, geometries: 7000, textures: 200, programs: 18 } },
    ...extra,
  };
}

describe('perf ratchet: location comparability', () => {
  it('derives the 0xXXYYFFFF landblock from world x/y (192m cells)', () => {
    expect(landblockOf(32592, 34586)).toBe('0xa9b4ffff');
    expect(landblockOf(0, 0)).toBe('0x0000ffff');
  });
  it('same spot within 50m is comparable; another landblock or >50m away is not', () => {
    expect(sameLocation(holtburg, { ...holtburg, x: holtburg.x + 30 })).toBe(true);
    expect(sameLocation(holtburg, { ...holtburg, x: holtburg.x + 80 })).toBe(false);
    expect(sameLocation(holtburg, eastham)).toBe(false);
    expect(sameLocation(undefined, holtburg)).toBe(false);
  });
  it('picks the latest prior run at the same renderer + location, never a different location or an unlocated run', () => {
    const cur = run('2026-08-29T12:00:00Z', 10_000);
    const runs = [
      run('2026-08-29T09:00:00Z', 12_500),
      run('2026-08-29T11:00:00Z', 39_000, { location: eastham }),
      run('2026-08-29T11:30:00Z', 12_400, { location: undefined }),
      run('2026-08-29T10:00:00Z', 12_600, { renderer: 'Apple M2' }),
      run('2026-08-29T13:00:00Z', 9_000),
    ];
    expect(findBaseline(runs, cur)?.utc).toBe('2026-08-29T09:00:00Z');
  });
  it('never compares runs of different phase lengths — phases end at different headings (absent phaseSecs = legacy 15s)', () => {
    const runs = [
      run('2026-09-04T09:00:00Z', 12_500), // legacy JSON, no phaseSecs
      { ...run('2026-09-04T10:00:00Z', 11_000), phaseSecs: 6 },
    ];
    expect(findBaseline(runs, { ...run('2026-09-04T12:00:00Z', 10_000), phaseSecs: 6 })?.utc).toBe('2026-09-04T10:00:00Z');
    expect(findBaseline(runs, { ...run('2026-09-04T12:00:00Z', 10_000), phaseSecs: 15 })?.utc).toBe('2026-09-04T09:00:00Z');
  });
  it('never compares across Landscape Draw Distance — radius 8 loads a different world than 3 (absent = the shipped 3)', () => {
    const runs = [
      run('2026-09-26T09:00:00Z', 420), // pre-field JSON: ran at the shipped 3
      { ...run('2026-09-26T10:00:00Z', 1_900), landscapeDrawDistance: 8 },
    ];
    expect(findBaseline(runs, { ...run('2026-09-26T12:00:00Z', 2_000), landscapeDrawDistance: 8 })?.utc).toBe('2026-09-26T10:00:00Z');
    expect(findBaseline(runs, { ...run('2026-09-26T12:00:00Z', 430), landscapeDrawDistance: 3 })?.utc).toBe('2026-09-26T09:00:00Z');
    expect(findBaseline(runs, { ...run('2026-09-26T12:00:00Z', 430), landscapeDrawDistance: 12 })).toBeNull();
  });
  it('never adopts a run whose own ratchet verdict was regression as a baseline (OPS.gpu-perf-job-safety)', () => {
    const runs = [
      { ...run('2026-09-26T04:10:00Z', 800), ratchetVerdict: 'ok' as const },
      { ...run('2026-09-27T04:10:00Z', 1_200), ratchetVerdict: 'regression' as const },
      { ...run('2026-09-27T05:00:00Z', 810), ratchetVerdict: 'no-baseline' as const },
    ];
    const cur = run('2026-09-28T04:10:00Z', 1_250);
    expect(findBaseline(runs, cur)?.utc).toBe('2026-09-27T05:00:00Z');
    expect(findBaseline(runs.slice(0, 2), cur)?.utc).toBe('2026-09-26T04:10:00Z');
    // So the second regressed night still fails against the good baseline.
    expect(compareRuns(findBaseline(runs.slice(0, 2), cur)!, cur).verdict).toBe('regression');
  });
  it('--draw-distance must be an integer 1..max (retail menu max 25); NaN, 0, fractions, missing are errors', () => {
    expect(parseDrawDistance('8', 25)).toBe(8);
    expect(parseDrawDistance('25', 25)).toBe(25);
    expect(parseDrawDistance('1', 25)).toBe(1);
    for (const bad of ['0', '-3', '2.5', 'abc', '', ' ', '26', 'NaN', 'Infinity', undefined]) {
      expect(() => parseDrawDistance(bad, 25)).toThrow(/--draw-distance must be an integer 1\.\.25/);
    }
  });
  it('never compares across sampling modes — a phase mean and an end-of-phase point sample are different statistics (CORE.14.e)', () => {
    const runs = [
      run('2026-09-04T09:00:00Z', 12_500), // legacy point-sample JSON, no renderSampling
      { ...run('2026-09-04T10:00:00Z', 11_000), renderSampling: 'phase-mean-1s' },
    ];
    const meanRun = { ...run('2026-09-04T12:00:00Z', 10_000), renderSampling: 'phase-mean-1s' };
    expect(findBaseline(runs, meanRun)?.utc).toBe('2026-09-04T10:00:00Z');
    expect(findBaseline(runs, run('2026-09-04T12:00:00Z', 10_000))?.utc).toBe('2026-09-04T09:00:00Z');
  });
});

describe('perf ratchet: phase-mean scene-cost sampling (CORE.14.e)', () => {
  const sample = (atMs: number, drawCalls: number, triangles = drawCalls * 100, geometries = 7000): PerfInfoSample =>
    ({ atMs, drawCalls, triangles, geometries });
  it('collapses in-phase samples to the rounded mean with per-metric spread', () => {
    // The CORE.14.e evidence shape: heading-dependent draw calls swinging
    // 228→1144 within one turning phase — the mean is the stable statistic.
    const s = summarizeInfoSamples([sample(0, 228), sample(1000, 1144), sample(2000, 500)]);
    expect(s).not.toBeNull();
    expect(s!.drawCalls).toBe(Math.round((228 + 1144 + 500) / 3));
    expect(s!.sampleCount).toBe(3);
    expect(s!.spread.drawCalls).toEqual({ min: 228, max: 1144 });
    expect(s!.triangles).toBe(Math.round((22_800 + 114_400 + 50_000) / 3));
    expect(s!.geometries).toBe(7000);
  });
  it('returns null for an empty sample list (renderer info unavailable → legacy point semantics)', () => {
    expect(summarizeInfoSamples([])).toBeNull();
  });
  it('a single sample degenerates to that sample (mean = point)', () => {
    const s = summarizeInfoSamples([sample(0, 929)]);
    expect(s!.drawCalls).toBe(929);
    expect(s!.spread.drawCalls).toEqual({ min: 929, max: 929 });
  });
});

describe('perf ratchet: verdicts', () => {
  it('flags >10% draw-call growth as a regression and reports the delta', () => {
    const v = compareRuns(run('a', 10_000), run('b', 11_500));
    expect(v.verdict).toBe('regression');
    expect(v.findings[0]).toMatchObject({ metric: 'idle.drawCalls', baseline: 10_000, current: 11_500 });
    expect(v.findings[0].delta).toBeCloseTo(0.15, 5);
  });
  it('passes improvements and small drifts', () => {
    expect(compareRuns(run('a', 10_000), run('b', 10_500)).verdict).toBe('ok');
    expect(compareRuns(run('a', 10_000), run('b', 1_200)).verdict).toBe('ok');
  });
  it('hitch counts need more than the slack to count (0→1 hitch is not a 100% regression)', () => {
    // Real-GPU runs: hitch100 carries signal there (see the SwiftShader test below).
    const gpu = (utc: string, hitch100: number) => run(utc, 10_000, {
      renderer: 'NVIDIA GeForce RTX 4070/PCIe/SSE2',
      phases: [{ phase: 'idle', avgFps: 60, p95Ms: 16, hitch50: 0, hitch100 }],
    });
    expect(compareRuns(gpu('a', 0), gpu('b', 1)).verdict).toBe('ok');
    expect(compareRuns(gpu('a', 0), gpu('c', 5)).verdict).toBe('regression');
  });
  it('ignores hitch100 between SwiftShader runs — every software frame is >100ms, so it just counts frames', () => {
    // 2026-09-04: a run with 35% BETTER renderJs sampled more frames per
    // phase and ratcheted as a hitch100 "regression" (30 → 52). Frame-time
    // metrics are real-GPU-only.
    const base = run('a', 10_000, { phases: [{ phase: 'running', avgFps: 2, p95Ms: 400, hitch50: 30, hitch100: 30 }] });
    const faster = run('b', 10_000, { phases: [{ phase: 'running', avgFps: 3.5, p95Ms: 333, hitch50: 52, hitch100: 52 }] });
    const v = compareRuns(base, faster);
    expect(v.verdict).toBe('ok');
    expect([...v.findings, ...v.within].some(f => f.metric.includes('hitch'))).toBe(false);
  });
  it('compares JS-side render time when both runs recorded it, at its own 25% tolerance (CORE.14.e: ±18% same-code jitter on ~10 SwiftShader frames)', () => {
    const base = run('a', 10_000, { renderJs: { idle: { frames: 100, p50Ms: 40, p95Ms: 55 } } });
    const jitter = run('b', 10_000, { renderJs: { idle: { frames: 100, p50Ms: 48, p95Ms: 60 } } }); // +20% — inside noise floor
    const worse = run('c', 10_000, { renderJs: { idle: { frames: 100, p50Ms: 52, p95Ms: 66 } } }); // +30% — real movement
    expect(compareRuns(base, jitter).verdict).toBe('ok');
    const v = compareRuns(base, worse);
    expect(v.verdict).toBe('regression');
    expect(v.findings.map(f => f.metric)).toContain('idle.renderJs.p50Ms');
  });
});

describe('perf ratchet: real-GPU fps comparison (CORE.14.d)', () => {
  const realRenderer = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)';
  const gpuRun = (utc: string, avgFps: number): PerfRun =>
    run(utc, 10_000, {
      renderer: realRenderer,
      phases: [{ phase: 'idle', avgFps, p95Ms: 20, hitch50: 0, hitch100: 0 }],
    });

  it('classifies software rasterizers vs real GPUs by renderer string', () => {
    expect(isSoftwareRenderer('WebKit WebGL — SwiftShader Device (Subzero)')).toBe(true);
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer(realRenderer)).toBe(false);
    expect(isSoftwareRenderer('NVIDIA GeForce RTX 4070/PCIe/SSE2')).toBe(false);
  });
  it('flags a >10% measured-fps drop as a regression on real-GPU runs', () => {
    const v = compareRuns(gpuRun('a', 60), gpuRun('b', 48));
    expect(v.verdict).toBe('regression');
    const f = v.findings.find(x => x.metric === 'idle.avgFps');
    expect(f).toMatchObject({ baseline: 60, current: 48 });
    expect(f!.delta).toBeCloseTo(0.2, 5);
  });
  it('passes small fps drift and improvements on real-GPU runs', () => {
    expect(compareRuns(gpuRun('a', 60), gpuRun('b', 57)).verdict).toBe('ok');
    expect(compareRuns(gpuRun('a', 48), gpuRun('b', 60)).verdict).toBe('ok');
  });
  it('never compares fps between SwiftShader runs (frame time is rasterizer noise there)', () => {
    const base = run('a', 10_000, { phases: [{ phase: 'idle', avgFps: 0.4, p95Ms: 2400, hitch50: 7, hitch100: 7 }] });
    const worse = run('b', 10_000, { phases: [{ phase: 'idle', avgFps: 0.2, p95Ms: 4800, hitch50: 7, hitch100: 7 }] });
    const v = compareRuns(base, worse);
    expect(v.verdict).toBe('ok');
    expect([...v.findings, ...v.within].some(f => f.metric === 'idle.avgFps')).toBe(false);
  });
});

describe('perf ratchet: dropped-frame warnings (frozen-camera landmine)', () => {
  const fs = (frames: number, droppedFrames: number) => ({ frames, rawDtTotal: 0, droppedFrames });
  it('warns per phase when EVERY frame in the phase dropped its physics substeps', () => {
    // Cumulative counters: idle dropped 2/50 (fine), turning dropped 30/30 (frozen).
    const w = droppedFrameWarnings(fs(100, 10), [
      { phase: 'idle', frameStats: fs(150, 12) },
      { phase: 'turning', frameStats: fs(180, 42) },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^turning:/);
    expect(w[0]).toContain('all 30 frames');
  });
  it('is quiet when frames survived, with a null start treated as zero counters', () => {
    expect(droppedFrameWarnings(null, [{ phase: 'idle', frameStats: fs(50, 49) }])).toHaveLength(0);
    expect(droppedFrameWarnings(null, [{ phase: 'idle', frameStats: fs(50, 50) }])).toHaveLength(1);
  });
  it('skips phases with no frameStats snapshot and empty phases', () => {
    const w = droppedFrameWarnings(fs(10, 0), [
      { phase: 'idle', frameStats: null },
      { phase: 'turning', frameStats: fs(10, 0) }, // 0 new frames — not a warning
    ]);
    expect(w).toHaveLength(0);
  });
});

describe('perf ratchet: real-GPU estimate', () => {
  it('reproduces the 2026-08-29 calibration point (10,704 calls ≈ 11 fps)', () => {
    const est = estimateRealGpu(10_704);
    expect(est.frameMs).toBeCloseTo(10_704 * REAL_GPU_US_PER_DRAW_CALL / 1000, 0);
    expect(est.fps).toBeGreaterThan(10);
    expect(est.fps).toBeLessThan(12);
  });
  it('puts the 1,500 draw-call budget comfortably above 60 fps', () => {
    expect(estimateRealGpu(1_500).fps).toBeGreaterThan(60);
  });
});
