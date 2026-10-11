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
  /** Total camera yaw (radians) at the sample (PERF.6 frame-yaw sampling). */
  yaw?: number;
}

export interface PerfInfoSummary {
  drawCalls: number;
  triangles: number;
  geometries: number;
  sampleCount: number;
  /** Heading sectors the samples covered (PERF.6); absent = unbinned (no yaw). */
  headingBins?: number;
  /** per-metric min/max across the phase, for the JSON evidence trail */
  spread: Record<'drawCalls' | 'triangles' | 'geometries', { min: number; max: number }>;
}

/**
 * CORE.14.e — collapse a phase's renderer.info samples into the phase MEAN.
 * A single end-of-phase read is point-sampled at whatever camera heading the
 * phase happened to end on (back-to-back identical runs swung
 * turning.drawCalls 1046→228→1144 on heading alone).
 *
 * PERF.6 — when the samples carry the camera yaw, the mean is taken over
 * HEADING_BINS equal heading sectors (each sector's mean, then the mean of
 * the sectors the phase visited). The 1/s wall-clock schedule aliased with
 * the turn: SwiftShader turns ~one revolution per 2.6 s, so 1.3 s samples
 * alternated between two headings (turning samples 422/868/439/867/427/1223…
 * on 2026-10-10) and which two depended on frame timing, swinging the
 * turning mean ±20% on the same code. Sampling every frame and weighting by
 * heading, not by time, makes the turning number "the average scene over the
 * circle" — and stops slow (heavy) headings being under-weighted because
 * they produce fewer frames. A phase that never turns lands in one sector,
 * where this is the plain mean.
 */
export function summarizeInfoSamples(samples: PerfInfoSample[]): PerfInfoSummary | null {
  if (!samples.length) return null;
  const metrics = ['drawCalls', 'triangles', 'geometries'] as const;
  const out = { sampleCount: samples.length, spread: {} } as PerfInfoSummary;
  const binned = samples.every(s => typeof s.yaw === 'number' && Number.isFinite(s.yaw));
  const groups: PerfInfoSample[][] = [];
  if (binned) {
    const bins = new Map<number, PerfInfoSample[]>();
    for (const smp of samples) {
      const b = headingBin(smp.yaw as number);
      let g = bins.get(b);
      if (!g) bins.set(b, g = []);
      g.push(smp);
    }
    groups.push(...bins.values());
  } else {
    groups.push(samples);
  }
  out.headingBins = binned ? groups.length : undefined;
  for (const m of metrics) {
    const vals = samples.map(s => s[m]);
    const binMeans = groups.map(g => g.reduce((a, s) => a + s[m], 0) / g.length);
    out[m] = Math.round(binMeans.reduce((a, b) => a + b, 0) / binMeans.length);
    out.spread[m] = { min: Math.min(...vals), max: Math.max(...vals) };
  }
  return out;
}

/** Heading sectors for summarizeInfoSamples (30° each). */
export const HEADING_BINS = 12;

/** Sector index 0..HEADING_BINS-1 of a yaw in radians (any winding). */
export function headingBin(yaw: number): number {
  const turn = 2 * Math.PI;
  const norm = ((yaw % turn) + turn) % turn;
  return Math.min(HEADING_BINS - 1, Math.floor((norm / turn) * HEADING_BINS));
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
  return findBaselines(runs, current, 1)[0] ?? null;
}

/**
 * PERF.6 — the `n` most recent comparable prior runs (same rules as
 * findBaseline), newest first. The ratchet compares against their median:
 * one same-code run is not a stable bar (two runs four minutes apart on
 * 34db9a9 read idle 523 vs 665 draw calls, and a day's outlier run became
 * the next cycle's baseline on 2026-10-10).
 */
export function findBaselines(runs: PerfRun[], current: PerfRun, n = RATCHET_HISTORY): PerfRun[] {
  const candidates = runs
    .filter(r => r.utc < current.utc && r.renderer === current.renderer && sameLocation(r.location, current.location)
      && r.ratchetVerdict !== 'regression'
      && (r.phaseSecs ?? 15) === (current.phaseSecs ?? 15)
      && (r.renderSampling ?? 'point') === (current.renderSampling ?? 'point')
      && (r.landscapeDrawDistance ?? 3) === (current.landscapeDrawDistance ?? 3))
    .sort((a, b) => (a.utc < b.utc ? 1 : -1));
  return candidates.slice(0, Math.max(1, n));
}

/**
 * PERF.6 — geometries is a cumulative GPU-upload counter (three.js uploads
 * lazily on first draw; docs/performance-budgets.md), not a per-frame cost,
 * and same-code consecutive runs moved it up to +32% (+56% against one
 * outlier baseline). It gates at 50%: a doubling still fails, upload-order
 * noise does not. Geometry STABILITY (leaks) is the memory soak's budget
 * (perf-soak: within 25% of start after the final GC).
 */
export const GEOMETRY_TOLERANCE = 0.5;

/** How many recent comparable runs the ratchet's baseline is the median of. */
export const RATCHET_HISTORY = 3;

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
  /** Every run the baseline was built from (compareToHistory), newest first. */
  baselineUtcs?: string[];
  findings: RatchetFinding[];
  /** Metrics that moved but stayed inside tolerance, for the log. */
  within: RatchetFinding[];
  /** Past tolerance against the median, but no worse than a value one of the
   *  baseline runs itself recorded: inside the measured same-code spread
   *  (PERF.6), so not a regression. Listed so the log still shows them. */
  noise?: RatchetFinding[];
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
export function compareRuns(
  baseline: PerfRun, current: PerfRun, tolerance = 0.10, hitchSlack = 2, renderJsTolerance = 0.25,
  geometryTolerance = tolerance,
): RatchetVerdict {
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
    check(`${phase}.geometries`, base.geometries, cur.geometries, false, geometryTolerance);
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

const median = (vals: number[]): number => {
  const s = [...vals].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Numbers present in every baseline, else undefined (no partial medians). */
const all = (vals: Array<number | undefined>): number[] | undefined =>
  vals.every(v => typeof v === 'number') ? vals as number[] : undefined;

/**
 * PERF.6 — a synthetic run whose every metric is the per-metric median of
 * `baselines` (newest first; utc and the comparability fields come from the
 * newest). A metric missing from any baseline is left out, so it is not
 * compared rather than compared against a partial median.
 */
export function medianRun(baselines: PerfRun[]): PerfRun {
  const [newest] = baselines;
  const render: PerfRun['render'] = {};
  for (const phase of Object.keys(newest.render)) {
    const infos = baselines.map(b => b.render[phase]);
    if (infos.some(i => !i)) { render[phase] = null; continue; }
    const pick = (k: keyof PerfRenderInfo) => median((infos as PerfRenderInfo[]).map(i => i[k]));
    render[phase] = {
      drawCalls: pick('drawCalls'), triangles: pick('triangles'), geometries: pick('geometries'),
      textures: pick('textures'), programs: pick('programs'),
    };
  }
  const phases: PerfPhaseStats[] = [];
  for (const p of newest.phases) {
    const ps = baselines.map(b => b.phases.find(x => x.phase === p.phase));
    if (ps.some(x => !x)) continue;
    const pick = (k: 'avgFps' | 'p95Ms' | 'hitch50' | 'hitch100') => median((ps as PerfPhaseStats[]).map(x => x[k]));
    phases.push({ phase: p.phase, avgFps: pick('avgFps'), p95Ms: pick('p95Ms'), hitch50: pick('hitch50'), hitch100: pick('hitch100') });
  }
  let renderJs: PerfRun['renderJs'];
  if (newest.renderJs) {
    renderJs = {};
    for (const phase of Object.keys(newest.renderJs)) {
      const p50 = all(baselines.map(b => b.renderJs?.[phase]?.p50Ms));
      const p95 = all(baselines.map(b => b.renderJs?.[phase]?.p95Ms));
      const frames = all(baselines.map(b => b.renderJs?.[phase]?.frames));
      renderJs[phase] = p50 && p95 && frames ? { frames: median(frames), p50Ms: median(p50), p95Ms: median(p95) } : null;
    }
  }
  return { ...newest, render, phases, renderJs };
}

/** The value a finding's metric name (`turning.drawCalls`, `idle.renderJs.p50Ms`, `idle.avgFps`) had in `run`. */
function metricValue(run: PerfRun, metric: string): number | undefined {
  const [phase, ...rest] = metric.split('.');
  const key = rest.join('.');
  if (key === 'renderJs.p50Ms') return run.renderJs?.[phase]?.p50Ms ?? undefined;
  if (key === 'avgFps' || key === 'hitch100') return run.phases.find(p => p.phase === phase)?.[key];
  const info = run.render[phase];
  return info ? info[key as keyof PerfRenderInfo] : undefined;
}

/**
 * PERF.6 — the ratchet verdict against recent history rather than one run.
 * Same-code SwiftShader runs spread wider than the 10% ratchet (measured over
 * the 2026-09-26..10-10 LDD-8 Holtburg runs, consecutive pairs: geometries up
 * to +32%, turning draw calls +19%, renderJs p50 +72%), so a single-run
 * baseline fired REGRESSION on noise nearly every cycle and the verdict
 * stopped meaning anything. Two rules make it robust without loosening the
 * budget:
 *  1. compare against the per-metric MEDIAN of the last RATCHET_HISTORY
 *     comparable runs (one outlier baseline no longer sets the bar);
 *  2. a metric past tolerance against that median still counts as noise when
 *     it is no worse than a value one of those runs itself recorded — the
 *     same code has already produced it. A real regression clears every
 *     recent run and still fails.
 * With one baseline both rules reduce to compareRuns exactly.
 */
export function compareToHistory(
  baselines: PerfRun[], current: PerfRun,
  tolerance = 0.10, hitchSlack = 2, renderJsTolerance = 0.25, geometryTolerance = GEOMETRY_TOLERANCE,
): RatchetVerdict {
  if (!baselines.length) return { verdict: 'no-baseline', findings: [], within: [] };
  const v = compareRuns(medianRun(baselines), current, tolerance, hitchSlack, renderJsTolerance, geometryTolerance);
  const findings: RatchetFinding[] = [];
  const noise: RatchetFinding[] = [];
  for (const f of v.findings) {
    const seen = baselines.map(b => metricValue(b, f.metric)).filter((x): x is number => typeof x === 'number');
    // avgFps is higher-is-better: "no worse than a recorded value" is ≥ the lowest.
    const higherIsBetter = f.metric.endsWith('.avgFps');
    const insideSpread = baselines.length > 1 && seen.length === baselines.length
      && (higherIsBetter ? f.current >= Math.min(...seen) : f.current <= Math.max(...seen));
    (insideSpread ? noise : findings).push(f);
  }
  return {
    verdict: findings.length ? 'regression' : 'ok',
    baselineUtc: baselines[0].utc,
    baselineUtcs: baselines.map(b => b.utc),
    findings, within: v.within, noise,
  };
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
