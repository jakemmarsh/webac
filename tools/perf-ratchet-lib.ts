/**
 * perf-ratchet-lib — pure helpers behind tools/measure-perf.ts.
 *
 * The cloud loop measures on SwiftShader, where frame time says nothing
 * about a real GPU (0.4 fps regardless). What IS comparable across renderers
 * is the scene cost the renderer is asked to submit — draw calls, geometry
 * count, JS-side `renderer.render()` time — plus a calibrated estimate of
 * what those draw calls cost on real hardware. This module turns two runs
 * into a verdict so the ratchet is mechanical, not a judgement call.
 */

export interface PerfLocation {
  x: number;
  y: number;
  z: number;
  /** 0xXXYYFFFF outdoor landblock derived from x/y (192m cells). */
  landblock: string;
}

export interface PerfRenderInfo {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
}

export interface PerfPhaseStats {
  phase: string;
  avgFps: number;
  p95Ms: number;
  hitch50: number;
  hitch100: number;
}

/** Cumulative frame-pacing counters from acDebug.frameStats(). */
export interface PerfFrameStats {
  frames: number;
  rawDtTotal: number;
  droppedFrames: number;
}

export interface PerfRenderJsStats {
  frames: number;
  p50Ms: number;
  p95Ms: number;
}

/** One in-phase renderer.info read (CORE.14.e phase-mean sampling). */
export interface PerfInfoSample {
  /** ms since phase start */
  atMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
}

export interface PerfInfoSummary {
  drawCalls: number;
  triangles: number;
  geometries: number;
  sampleCount: number;
  /** per-metric min/max across the phase, for the JSON evidence trail */
  spread: Record<'drawCalls' | 'triangles' | 'geometries', { min: number; max: number }>;
}

/**
 * CORE.14.e — collapse a phase's ~1/s renderer.info samples into the phase
 * MEAN. A single end-of-phase read is point-sampled at whatever camera
 * heading the phase happened to end on (back-to-back identical runs swung
 * turning.drawCalls 1046→228→1144 on heading alone); the mean over the whole
 * phase is heading-stable — for the turning phase it averages the full swept
 * arc, which is rotation-invariant given the same start heading and length.
 */
export function summarizeInfoSamples(samples: PerfInfoSample[]): PerfInfoSummary | null {
  if (!samples.length) return null;
  const metrics = ['drawCalls', 'triangles', 'geometries'] as const;
  const out = { sampleCount: samples.length, spread: {} } as PerfInfoSummary;
  for (const m of metrics) {
    const vals = samples.map(s => s[m]);
    out[m] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    out.spread[m] = { min: Math.min(...vals), max: Math.max(...vals) };
  }
  return out;
}

export interface PerfRun {
  utc: string;
  renderer: string;
  location?: PerfLocation;
  /** Seconds per phase (--secs). Runs of different lengths end phases at
   *  different camera headings/positions and never compare. Absent in
   *  pre-2026-09-04 JSON — those all used the 15s default. */
  phaseSecs?: number;
  /** How render[phase] scene-cost numbers were captured. Absent = legacy
   *  end-of-phase point sample; 'phase-mean-1s' = CORE.14.e in-phase mean.
   *  A mean and a point sample of the same scene are different statistics —
   *  runs only compare within the same sampling mode. */
  renderSampling?: string;
  /** Options "Landscape Draw Distance" in effect for the run. Different grid
   *  radii load different worlds and never compare. Absent = not recorded
   *  (pre-2026-09-26; those ran at the shipped default, 3 since 2026-09-10). */
  landscapeDrawDistance?: number;
  /** The --ratchet verdict measure-perf recorded for THIS run against its own
   *  baseline. A 'regression' run is never used as a later baseline: comparing
   *  against it would bless the regression (OPS.gpu-perf-job-safety,
   *  2026-09-26). Absent = run without --ratchet, or pre-field JSON. */
  ratchetVerdict?: 'ok' | 'regression' | 'no-baseline';
  phases: PerfPhaseStats[];
  render: Record<string, PerfRenderInfo | null>;
  renderJs?: Record<string, PerfRenderJsStats | null>;
}

/**
 * Real-GPU cost per draw call, calibrated 2026-08-29 on the dev machine
 * (Apple M-series, Chrome, visible tab): 10,704 draw calls/frame measured
 * 11 fps ≈ 91 ms/frame → ~8.5 µs per call. Triangles were only ~500k, so the
 * frame is draw-call-submission bound and this linear model is the honest
 * first-order estimate. Re-calibrate (and note the date) when the scenery
 * pipeline changes shape — e.g. once instancing lands, per-call cost rises
 * (fatter calls) while count collapses.
 */
export const REAL_GPU_US_PER_DRAW_CALL = 8.5;

export function estimateRealGpu(drawCalls: number): { frameMs: number; fps: number } {
  const frameMs = (drawCalls * REAL_GPU_US_PER_DRAW_CALL) / 1000;
  return { frameMs: Math.round(frameMs * 10) / 10, fps: frameMs > 0 ? Math.round((1000 / frameMs) * 10) / 10 : Infinity };
}

/**
 * Software rasterizers (headless containers): frame time there says nothing
 * about a real GPU, so the ratchet compares scene-cost metrics only. On a
 * real GPU (Jake's machine, visible tab) measured fps is the truth the
 * budgets are written against, and the ratchet compares it directly.
 */
export function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|llvmpipe|softpipe|swrast|software/i.test(renderer);
}

/**
 * Frozen-camera landmine (2026-08-29, pre-CORE.14 SwiftShader runs): when a
 * phase's every frame delta exceeded HugeQuantum, physicsQuantumSteps
 * returned no substeps, and camera input — rotation and movement both apply
 * inside the substep loop — never moved the view. The turning/running phases
 * then silently re-measure the idle scene (identical render info across
 * phases was the tell). frameStats counters are cumulative, so warnings come
 * from deltas between successive per-phase snapshots.
 *
 * @param start counters snapshotted before the first phase (null → treat as 0)
 * @param snapshots per-phase cumulative counters, in phase order
 */
export function droppedFrameWarnings(
  start: PerfFrameStats | null | undefined,
  snapshots: Array<{ phase: string; frameStats?: PerfFrameStats | null }>,
): string[] {
  const warnings: string[] = [];
  let prev: PerfFrameStats = start ?? { frames: 0, rawDtTotal: 0, droppedFrames: 0 };
  for (const s of snapshots) {
    const fs = s.frameStats;
    if (!fs) continue;
    const frames = fs.frames - prev.frames;
    const dropped = fs.droppedFrames - prev.droppedFrames;
    prev = fs;
    if (frames > 0 && dropped >= frames) {
      warnings.push(
        `${s.phase}: all ${frames} frames dropped their physics substeps (dt > HugeQuantum) — ` +
        'camera input never applied, so this phase measured a static scene; its numbers are not trustworthy',
      );
    }
  }
  return warnings;
}

export function landblockOf(x: number, y: number): string {
  const lbx = Math.max(0, Math.min(0xff, Math.floor(x / 192)));
  const lby = Math.max(0, Math.min(0xff, Math.floor(y / 192)));
  return `0x${(((((lbx << 8) | lby) << 16) | 0xffff) >>> 0).toString(16).padStart(8, '0')}`;
}

/** Same map spot: same landblock and within `toleranceM` metres. */
export function sameLocation(a: PerfLocation | undefined, b: PerfLocation | undefined, toleranceM = 50): boolean {
  if (!a || !b) return false;
  if (a.landblock !== b.landblock) return false;
  return Math.hypot(a.x - b.x, a.y - b.y) <= toleranceM;
}

/**
 * The most recent prior run that is actually comparable: same renderer
 * string and same location. Runs without a recorded location (pre-2026-08-29
 * JSON) are never used as baselines — the 2026-08-29 Eastham-vs-Holtburg
 * landmine (39k vs 15k draw calls, pure scene difference) came from exactly
 * that. A run whose own ratchet verdict was 'regression' is skipped too, so
 * one regressed run cannot become the bar the next run is held to.
 */
export function findBaseline(runs: PerfRun[], current: PerfRun): PerfRun | null {
  const candidates = runs
    .filter(r => r.utc < current.utc && r.renderer === current.renderer && sameLocation(r.location, current.location)
      && r.ratchetVerdict !== 'regression'
      && (r.phaseSecs ?? 15) === (current.phaseSecs ?? 15)
      && (r.renderSampling ?? 'point') === (current.renderSampling ?? 'point')
      && (r.landscapeDrawDistance ?? 3) === (current.landscapeDrawDistance ?? 3))
    .sort((a, b) => (a.utc < b.utc ? 1 : -1));
  return candidates[0] ?? null;
}

export interface RatchetFinding {
  metric: string;
  baseline: number;
  current: number;
  /** current/baseline − 1, positive = worse */
  delta: number;
}

export interface RatchetVerdict {
  verdict: 'ok' | 'regression' | 'no-baseline';
  baselineUtc?: string;
  findings: RatchetFinding[];
  /** Metrics that moved but stayed inside tolerance, for the log. */
  within: RatchetFinding[];
}

/**
 * Compare per-phase scene-cost metrics; anything more than `tolerance`
 * (default 10%) worse than baseline is a regression. Hitch counts compare on
 * an absolute floor (a 0→1 hitch is not a 100% regression) — they must grow
 * by more than `hitchSlack` frames to count. renderJs p50 is wall-clock CPU
 * time from ~10 frames/phase on SwiftShader — three same-code CORE.14.e
 * runs measured turning at 44.9/37/40.8ms (±18% jitter), so it gets its own
 * `renderJsTolerance` (default 25%) just above that observed noise floor;
 * the count metrics (draw calls/geometries/triangles) stay at 10%.
 */
export function compareRuns(baseline: PerfRun, current: PerfRun, tolerance = 0.10, hitchSlack = 2, renderJsTolerance = 0.25): RatchetVerdict {
  const findings: RatchetFinding[] = [];
  const within: RatchetFinding[] = [];
  const check = (metric: string, b: number | undefined, c: number | undefined, absolute = false, tol = tolerance) => {
    if (typeof b !== 'number' || typeof c !== 'number') return;
    if (absolute) {
      const f = { metric, baseline: b, current: c, delta: b > 0 ? c / b - 1 : (c > 0 ? 1 : 0) };
      (c - b > hitchSlack ? findings : within).push(f);
      return;
    }
    if (b <= 0) return;
    const delta = c / b - 1;
    const f = { metric, baseline: b, current: c, delta };
    (delta > tol ? findings : within).push(f);
  };
  for (const [phase, cur] of Object.entries(current.render)) {
    const base = baseline.render[phase];
    if (!cur || !base) continue;
    check(`${phase}.drawCalls`, base.drawCalls, cur.drawCalls);
    check(`${phase}.geometries`, base.geometries, cur.geometries);
    check(`${phase}.triangles`, base.triangles, cur.triangles);
  }
  // Higher-is-better metric: delta = 1 − current/baseline, positive = worse.
  const checkFps = (metric: string, b: number | undefined, c: number | undefined) => {
    if (typeof b !== 'number' || typeof c !== 'number' || b <= 0) return;
    const delta = 1 - c / b;
    const f = { metric, baseline: b, current: c, delta };
    (delta > tolerance ? findings : within).push(f);
  };
  const realGpu = !isSoftwareRenderer(current.renderer) && !isSoftwareRenderer(baseline.renderer);
  for (const cur of current.phases) {
    const base = baseline.phases.find(p => p.phase === cur.phase);
    if (!base) continue;
    // Frame-time-derived metrics are meaningful only on real GPUs. On
    // SwiftShader EVERY frame exceeds 100ms, so hitch100 ≡ frames sampled —
    // a 2026-09-04 run that improved renderJs p50 by 35% (more frames per
    // phase) ratcheted as a hitch100 "regression". Scene-cost metrics and
    // renderJs cover the software-renderer case.
    if (realGpu) {
      check(`${cur.phase}.hitch100`, base.hitch100, cur.hitch100, true);
      checkFps(`${cur.phase}.avgFps`, base.avgFps, cur.avgFps);
    }
  }
  if (current.renderJs && baseline.renderJs) {
    for (const [phase, cur] of Object.entries(current.renderJs)) {
      const base = baseline.renderJs[phase];
      if (!cur || !base) continue;
      check(`${phase}.renderJs.p50Ms`, base.p50Ms, cur.p50Ms, false, renderJsTolerance);
    }
  }
  return { verdict: findings.length ? 'regression' : 'ok', baselineUtc: baseline.utc, findings, within };
}

/**
 * Validate `measure-perf --draw-distance N`. Retail's `LScape::SetMidRadius`
 * accepts only a positive radius, and the Options menu tops out at
 * `maxRadius` (Render_LandscapeDrawDistance_Values, "Extreme" = 25; see
 * packages/renderer/src/world/LandscapeDrawDistance.ts). NaN, 0, negatives,
 * fractions and a missing value are errors, not a silent fallback.
 */
export function parseDrawDistance(raw: string | undefined, maxRadius: number): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > maxRadius) {
    throw new Error(`--draw-distance must be an integer 1..${maxRadius} (got ${raw ?? 'nothing'})`);
  }
  return n;
}
