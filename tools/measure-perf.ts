/**
 * measure-perf — in-world frame-time measurement harness.
 *
 * Logs into the ACE stack headlessly (same path as capture-ui-screens.ts),
 * waits for world entry, then samples requestAnimationFrame deltas across
 * phases:
 *   idle    — standing still at the spawn point
 *   turning — holding ArrowRight (camera + scene churn, worst-case redraw)
 *
 * Prints a summary table and writes verification/perf/perf-<utc>.json.
 *
 * IMPORTANT: absolute numbers are only comparable on the same renderer.
 * Headless containers render on SwiftShader (CPU) — an order of magnitude
 * slower than real GPUs. The JSON records the UNMASKED_RENDERER string;
 * compare runs only within the same renderer. Regression tracking in the
 * cloud loop compares against prior SwiftShader runs on scene-cost metrics;
 * on a real GPU the ratchet ALSO compares measured per-phase avgFps
 * (perf-ratchet-lib isSoftwareRenderer decides which mode a run is in).
 *
 * Real-GPU runs on the dev machine — three paths:
 *   --gpu             HEADLESS on the real GPU (Playwright's `chromium`
 *                     channel = new headless mode, which on macOS renders
 *                     through ANGLE Metal; verified "Apple M3 Max" 2026-09-26).
 *                     No window, no attention needed, and it works from inside
 *                     the Claude harness, so it's the path for scheduled runs
 *                     (tools/local-gpu-perf.sh). Exits 3 if the page still
 *                     reports a software renderer.
 *   --headed          launches a visible Chromium via Playwright. Known to
 *                     HANG when driven from inside the local Claude harness
 *                     (sandboxed launch); works from a plain terminal.
 *   --attach [url]    attaches over CDP to a Chrome YOU started, e.g.
 *                       /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *                         --remote-debugging-port=9222
 *                     (default endpoint http://localhost:9222). Reuses the
 *                     game tab if one is open, else opens one. Keep that tab
 *                     visible and frontmost — hidden tabs throttle rAF and
 *                     the fps numbers become garbage. Your browser and tab
 *                     stay open afterwards. This is the harness-safe path.
 *
 * Usage:  npx tsx tools/measure-perf.ts [--headed | --attach [url]] [--secs N] [--ratchet] [--no-reset] [--program-keys] [--throttle N]
 *   --throttle N  (PERF.integrated-gpu-cpu-bound, 2026-11-15) after the normal
 *                 phases, re-park and run idle / turning / running again under
 *                 CDP Emulation.setCPUThrottlingRate N; recorded as `throttled`
 *                 in the same JSON and ratcheted only against earlier throttled
 *                 passes at the same rate (perf-ratchet-lib throttledView). The
 *                 nightly real-GPU run passes --throttle 4: the stand-in for the
 *                 low-end CPU-bound laptops (~20 fps on Intel HD 5000).
 * Every phase also records `work`: the game's own CPU time per frame
 * (frameStep through render, from __ac.framePhases), p50 / p95 / mean and the
 * mean per frameStep phase; work p50 ratchets at the renderJs tolerance (25%).
 * URL override: AC_URL=http://localhost:<port>/?ace&bridge=… (default :3000).
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack.
 * NOTE: uses the testacjs account — close other clients on that account first.
 *
 * Beyond frame times the JSON also records (2026-08-29, after the real-GPU
 * check showed 11 fps behind a "no regression" SwiftShader ratchet):
 *   location   — player x/y/z + landblock, so runs are only ever compared at
 *                the same map spot (Eastham vs Holtburg landmine).
 *   census     — mesh counts by category / world distance / visibility,
 *                InstancedMesh count: WHAT the scene holds.
 *   draws      — idle draw calls per frame by category and blend class
 *                (renderBufferDirect counted over 60 frames): what each
 *                bucket actually costs (tools/lib/scene-census.ts).
 *   renderJs   — JS-side `renderer.render()` time per frame (draw-call
 *                submission cost; not rasterization-bound like total frame
 *                time, so it moves with the real bottleneck even on
 *                SwiftShader).
 *   estimated  — calibrated real-GPU frame time / fps from draw calls
 *                (tools/perf-ratchet-lib.ts REAL_GPU_US_PER_DRAW_CALL).
 * With --ratchet it compares against the latest same-renderer, same-location
 * run and exits 2 on a >10% regression — the cloud loop's mechanical gate.
 * Metrics: draw calls, geometries, triangles, renderJs p50 always; avgFps
 * and hitch100 only between real-GPU runs (on SwiftShader every frame is
 * >100ms, so hitch100 just counts frames and fps is rasterizer noise).
 *
 * CORE.14.e — heading-stable scene costs. Two sources of pure measurement
 * noise (same code, same landblock: idle.drawCalls 93/239/929 across three
 * runs) are removed:
 *   1. Deterministic start: the run parks the character at the Holtburg POI
 *      (@telepoi, skipped within 10m — a same-position telepoi breaks
 *      client-side CreateObject registration) and resets heading to yaw 0
 *      via acDebug.setPlayerYaw before EVERY phase, so idle faces the same
 *      scene, turning sweeps the same arc, and running goes the same way.
 *      After parking it waits for the scene to PLATEAU (mesh count stable
 *      ±1% across 4 polls, 120s cap) — a fixed 20s wait measured a
 *      still-streaming scene 22.7% thinner than the settled one.
 *      --no-reset opts out (numbers then may not be ratchet-comparable).
 *   2. Phase-mean sampling: renderer.info is read ~once/second DURING each
 *      phase and render[phase] carries the phase MEAN of draw calls /
 *      triangles / geometries (textures/programs stay point-sampled — they
 *      are memory counters, not per-frame). Raw samples land in the JSON
 *      under renderSamples. The ratchet never compares across sampling modes.
 *   3. PERF.6 — every frame is sampled with its camera yaw and the mean is
 *      taken over 30° heading sectors (renderSampling 'frame-heading-binned';
 *      the old 1/s schedule, 'phase-mean-1s', aliased with the turn), and
 *      --ratchet compares against the median of the last 3 comparable runs,
 *      reporting a value inside those runs' own range as noise.
 */

import { chromium, type Page } from 'playwright';
import { LANDSCAPE_DRAW_DISTANCE_VALUES, SHIPPED_DEFAULT_LANDSCAPE_DRAW_DISTANCE } from '../packages/renderer/src/world/LandscapeDrawDistance.js';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSoftwareRenderer,
  compareThrottled, compareToHistory, droppedFrameWarnings, estimateRealGpu, findBaselines, landblockOf, parseDrawDistance, parseThrottle,
  summarizeInfoSamples, summarizeWork,
  type PerfFrameStats, type PerfInfoSample, type PerfInfoSummary, type PerfLocation, type PerfRun, type PerfRenderJsStats,
  type PerfThrottledPass, type PerfWorkStats, type RatchetVerdict,
} from './perf-ratchet-lib.js';
import { FRAME_PHASES } from '../packages/renderer/src/telemetry/MainThreadCost.js';
import { PROBE_CHARGEN_REOPEN_JS } from './lib/game-session.js';
import { DRAW_CENSUS_SRC, SCENE_CENSUS_SRC, type DrawCensus, type SceneCensus } from './lib/scene-census.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dir, '..', 'verification', 'perf');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=perf';
const VIEW = { width: 1568, height: 775 };
const HEADED = process.argv.includes('--headed');
const GPU = process.argv.includes('--gpu');
// --draw-distance N — seed the Options "Landscape Draw Distance" (an integer
// 1..25: retail's SetMidRadius takes any positive radius and the menu's top
// value is 25; retail default 8, which fresh profiles ship since
// CORE.17.h.g.a.a; 3 before 2026-09-26) before the page loads, so the
// 3-vs-8 tradeoff can be measured on any renderer. NaN/0/out of range is an
// error (exit 1), never a silently seeded bad value.
const ddIdx = process.argv.indexOf('--draw-distance');
let DRAW_DISTANCE: number | undefined;
if (ddIdx > -1) {
  const raw = process.argv[ddIdx + 1];
  try {
    DRAW_DISTANCE = parseDrawDistance(raw?.startsWith('--') ? undefined : raw, Math.max(...LANDSCAPE_DRAW_DISTANCE_VALUES));
  } catch (e) {
    console.error(`[perf] ${(e as Error).message}`);
    process.exit(1);
  }
}
const attachIdx = process.argv.indexOf('--attach');
const ATTACH = attachIdx > -1;
if (ATTACH && DRAW_DISTANCE !== undefined) {
  // The seed is an addInitScript on a page WE launch; an attached tab keeps
  // whatever its own Options say (recorded as landscapeDrawDistance).
  console.warn('[perf] WARNING: --draw-distance is ignored with --attach (set it in the attached tab\'s Options instead)');
}
const ATTACH_ENDPOINT =
  ATTACH && process.argv[attachIdx + 1] && !process.argv[attachIdx + 1].startsWith('--')
    ? process.argv[attachIdx + 1]
    : 'http://localhost:9222';
const RATCHET = process.argv.includes('--ratchet');
const NO_RESET = process.argv.includes('--no-reset');
// PERF.4 — --program-keys records every live WebGLProgram's cacheKey after
// settle / idle / turning (result.programKeys), so a first-look compile can be
// traced to the exact program parameter that differs from the warmed set.
const PROGRAM_KEYS = process.argv.includes('--program-keys');
async function programKeys(page: Page): Promise<string[] | null> {
  return page.evaluate(`(() => {
    const r = window.__ac && window.__ac.sceneManager && window.__ac.sceneManager.renderer;
    return r && r.info.programs ? r.info.programs.map(p => p.cacheKey) : null;
  })()`) as Promise<string[] | null>;
}
// --throttle N (PERF.integrated-gpu-cpu-bound) — after the normal phases,
// measure idle / turning / running AGAIN under CDP
// Emulation.setCPUThrottlingRate N (the main thread N× slower), re-parked at
// the same spot, and record it as result.throttled in the same JSON. The
// standing nightly run passes --throttle 4 (perf-ratchet-lib
// STANDING_CPU_THROTTLE): the stand-in for the low-end CPU-bound laptops.
const thIdx = process.argv.indexOf('--throttle');
let THROTTLE: number | undefined;
if (thIdx > -1) {
  const raw = process.argv[thIdx + 1];
  try {
    THROTTLE = parseThrottle(raw?.startsWith('--') ? undefined : raw);
  } catch (e) {
    console.error(`[perf] ${(e as Error).message}`);
    process.exit(1);
  }
}
const secsArg = process.argv.indexOf('--secs');
const PHASE_SECS = secsArg > -1 ? Number(process.argv[secsArg + 1]) : 15;

/**
 * CORE.14.e — the deterministic park spot: the Holtburg POI (same spot
 * tools/park-holtburg.ts uses, landblock 0xA9B4). The persistent testacjs
 * character keeps whatever heading/position the previous run's phases left
 * it with, so without a reset even the idle phase measures a different
 * scene every run (observed idle.drawCalls 93 / 239 / 929 across three
 * same-code runs). World coords: x = east, north = AC y (collisionState.z).
 */
const PARK = { x: 32532, north: 34567 };

interface PhaseStats {
  phase: string;
  durationMs: number;
  frames: number;
  avgFps: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** % of frames longer than 33.3ms (i.e. below 30fps) */
  longFramePct: number;
  /** hitches: frames over 50ms / 100ms — the "choppy" signal (real GPUs only; on SwiftShader every frame qualifies) */
  hitch50: number;
  hitch100: number;
}

/**
 * Renderer-independent scene-cost metrics. Three.js resets info.render each
 * frame, so a single read reflects the current frame's draw load. These (not
 * FPS) are the cloud-comparable budget numbers — SwiftShader inflates frame
 * time but draw calls/triangles/JS-side integration cost are the same load a
 * real GPU sees. See docs/performance-budgets.md.
 */
interface RenderInfo {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  frameStats?: { frames: number; rawDtTotal: number; droppedFrames: number };
}

async function renderInfo(page: Page): Promise<RenderInfo | null> {
  return page.evaluate(`(() => {
    const ac = window.__ac;
    const info = ac && ac.sceneManager && ac.sceneManager.renderer && ac.sceneManager.renderer.info;
    if (!info) return null;
    const fs = window.acDebug && window.acDebug.frameStats ? window.acDebug.frameStats() : undefined;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
      frameStats: fs ? { frames: fs.frames, rawDtTotal: fs.rawDtTotal, droppedFrames: fs.droppedFrames } : undefined,
    };
  })()`) as Promise<RenderInfo | null>;
}

function stats(phase: string, deltas: number[]): PhaseStats {
  const sorted = [...deltas].sort((a, b) => a - b);
  const total = deltas.reduce((s, d) => s + d, 0);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    phase,
    durationMs: Math.round(total),
    frames: deltas.length,
    avgFps: Math.round((deltas.length / total) * 1000 * 10) / 10,
    p50Ms: Math.round(q(0.5) * 100) / 100,
    p95Ms: Math.round(q(0.95) * 100) / 100,
    p99Ms: Math.round(q(0.99) * 100) / 100,
    maxMs: Math.round(sorted[sorted.length - 1] * 100) / 100,
    longFramePct: Math.round((deltas.filter(d => d > 33.34).length / deltas.length) * 1000) / 10,
    hitch50: deltas.filter(d => d > 50).length,
    hitch100: deltas.filter(d => d > 100).length,
  };
}

interface PhaseSamples {
  deltas: number[];
  /** renderer.info read ~once/second during the phase (CORE.14.e) */
  infoSamples: PerfInfoSample[];
  /** The game's CPU work (frameStep through render, ms) of each frame it ran during the phase. */
  works: number[];
  /** Total ms per FRAME_PHASES phase over the same frames; null when the page exposes no __ac.framePhases. */
  phaseSums: number[] | null;
}

/**
 * Frame deltas + in-phase renderer.info samples in one rAF loop. A single
 * end-of-phase info read is point-sampled at whatever camera heading the
 * phase ended on — back-to-back same-code runs swung turning.drawCalls
 * 1046→228→1144 on heading alone (CORE.14.e evidence). Sampling ~1/s and
 * taking the phase mean is heading-stable. three.js resets info.render at
 * the START of each render, so a read between frames holds the last
 * completed frame's counts.
 */
async function samplePhase(page: Page, ms: number): Promise<PhaseSamples> {
  // Passed as a source string, not a function: tsx/esbuild injects a __name
  // helper into named functions inside evaluate() callbacks, which doesn't
  // exist in the page context (ReferenceError: __name is not defined).
  return page.evaluate(`new Promise((resolve) => {
    const deltas = [];
    const infoSamples = [];
    const works = [];
    let phaseSums = null;
    let lastFpFrames = -1;
    let last = -1;
    const start = performance.now();
    requestAnimationFrame(function tick(t) {
      if (last >= 0) deltas.push(t - last);
      last = t;
      // PERF.integrated-gpu-cpu-bound — the frame's own CPU work, from the
      // page's FramePhaseTimer (telemetry/MainThreadCost.ts): the frame that
      // ran in this animation frame, counted once (fp.frames tells a new one).
      const fp = window.__ac && window.__ac.framePhases;
      if (fp && fp.frameMs && typeof fp.frames === 'number' && fp.frames !== lastFpFrames) {
        if (lastFpFrames >= 0) {
          if (!phaseSums) phaseSums = new Array(fp.frameMs.length).fill(0);
          let w = 0;
          for (let i = 0; i < fp.frameMs.length; i++) { w += fp.frameMs[i]; phaseSums[i] += fp.frameMs[i]; }
          works.push(w);
        }
        lastFpFrames = fp.frames;
      }
      // PERF.6 — every frame, with the camera yaw it was drawn at. The game's
      // own rAF callback was queued before this one, so this frame's render
      // has already run: info and yaw describe the same frame.
      const ac = window.__ac;
      const info = ac && ac.sceneManager && ac.sceneManager.renderer && ac.sceneManager.renderer.info;
      const cam = ac && ac.cameraController;
      if (info) infoSamples.push({
        atMs: Math.round(t - start),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        yaw: cam && typeof cam.yaw === 'number' ? cam.yaw : undefined,
      });
      if (t - start < ${ms}) requestAnimationFrame(tick);
      else resolve({ deltas, infoSamples, works, phaseSums });
    });
  })`) as Promise<PhaseSamples>;
}

/** Fixed heading before each phase — setPlayerYaw also zeroes the camera-orbit offset. */
async function setYaw(page: Page, yaw: number): Promise<boolean> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug;
    if (!dbg || typeof dbg.setPlayerYaw !== 'function') return false;
    dbg.setPlayerYaw(${yaw});
    return true;
  })()`) as Promise<boolean>;
}

/** World-plane position (x = east, north = AC y) from collisionState. */
async function worldPos(page: Page): Promise<{ x: number; north: number } | null> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug;
    const cs = dbg && dbg.collisionState ? dbg.collisionState() : null;
    return cs ? { x: cs.x, north: cs.z } : null;
  })()`) as Promise<{ x: number; north: number } | null>;
}

interface PerfReset {
  telepoi: 'sent' | 'skipped-near' | 'failed' | 'skipped-flag';
  distBefore?: number;
  yaw: number;
  /** scene-plateau wait after the reset (see waitForSceneSettle) */
  settle?: { meshes: number; settleMs: number; plateau: boolean };
}

/**
 * CORE.14.e — park the character at the Holtburg POI before sampling.
 * Skips the teleport when already within 10m: a same-position @telepoi
 * leaves the session in a state where subsequent CreateObjects never
 * register client-side (verify-pet-summoning.ts run 3), which would
 * silently thin the measured scene.
 */
async function resetToParkSpot(page: Page): Promise<PerfReset> {
  const before = await worldPos(page);
  const distBefore = before ? Math.round(Math.hypot(before.x - PARK.x, before.north - PARK.north) * 10) / 10 : undefined;
  if (distBefore !== undefined && distBefore <= 10) {
    return { telepoi: 'skipped-near', distBefore, yaw: 0 };
  }
  await page.evaluate(`window.acDebug && window.acDebug.admin && window.acDebug.admin('@telepoi holtburg')`);
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const p = await worldPos(page);
    if (p && Math.hypot(p.x - PARK.x, p.north - PARK.north) < 150) {
      console.log('[perf] telepoi landed');
      return { telepoi: 'sent', distBefore, yaw: 0 };
    }
    await page.waitForTimeout(2_000);
  }
  return { telepoi: 'failed', distBefore, yaw: 0 };
}

/**
 * CORE.14.e follow-up (run-2 evidence): a fixed 20s post-teleport wait is
 * not enough — a run that logged in 34.8km away idled at 2784 draw calls
 * while the next run at the same spot+heading idled at 3416 (+22.7%
 * false regression), because landblock/scenery streaming was still filling
 * the scene during the first run's phases (census 7015 vs 7804 meshes).
 * Instead, wait until the scene PLATEAUS: mesh count unchanged (±1%)
 * across 4 consecutive 2s polls, capped at 120s.
 */
async function waitForSceneSettle(page: Page): Promise<{ meshes: number; settleMs: number; plateau: boolean }> {
  const countMeshes = () => page.evaluate(`(() => {
    const sm = window.__ac && window.__ac.sceneManager;
    if (!sm || !sm.scene) return -1;
    let n = 0;
    sm.scene.traverse((o) => { if (o.isMesh) n++; });
    return n;
  })()`) as Promise<number>;
  const start = Date.now();
  let prev = -1;
  let stablePolls = 0;
  while (Date.now() - start < 120_000) {
    await page.waitForTimeout(2_000);
    const n = await countMeshes();
    if (prev > 0 && n > 0 && Math.abs(n - prev) <= Math.max(1, prev * 0.01)) stablePolls++;
    else stablePolls = 0;
    prev = n;
    if (stablePolls >= 3) {
      return { meshes: n, settleMs: Date.now() - start, plateau: true };
    }
  }
  return { meshes: prev, settleMs: Date.now() - start, plateau: false };
}

/** Player world position + landblock — the run's comparability key. */
async function playerLocation(page: Page): Promise<PerfLocation | null> {
  const cs = await page.evaluate(`(() => {
    const dbg = window.acDebug;
    const cs = dbg && dbg.collisionState ? dbg.collisionState() : null;
    return cs ? { x: cs.x, y: cs.y, z: cs.z } : null;
  })()`) as { x: number; y: number; z: number } | null;
  if (!cs) return null;
  // collisionState is Three.js Y-up: cs.z is AC north (y), cs.y is height (z).
  const r = (n: number) => Math.round(n * 10) / 10;
  return { x: r(cs.x), y: r(cs.z), z: r(cs.y), landblock: landblockOf(cs.x, cs.z) };
}

/**
 * What the scene is made of (every Mesh bucketed by its named ancestor and
 * by world-space distance from the camera) and what each bucket draws per
 * frame. tools/lib/scene-census.ts has both halves and the distance fix.
 */
async function sceneCensus(page: Page): Promise<SceneCensus | null> {
  return page.evaluate(`(() => {
    const sm = window.__ac && window.__ac.sceneManager;
    if (!sm || !sm.scene || !sm.camera) return null;
    return (${SCENE_CENSUS_SRC})(sm.scene, sm.camera);
  })()`) as Promise<SceneCensus | null>;
}

async function drawCensus(page: Page, frames = 60): Promise<DrawCensus | null> {
  return page.evaluate(`(() => {
    const sm = window.__ac && window.__ac.sceneManager; const r = sm && sm.renderer;
    if (!r || typeof r.renderBufferDirect !== 'function') return null;
    return (${DRAW_CENSUS_SRC})(r, ${frames}, () => new Promise((res) => requestAnimationFrame(() => res())));
  })()`) as Promise<DrawCensus | null>;
}

async function installRenderTimer(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const sm = window.__ac && window.__ac.sceneManager; const r = sm && sm.renderer;
    if (!r) return false;
    if (r.__perfPatched) return true;
    const orig = r.render.bind(r);
    window.__perfRenderMs = [];
    r.render = function (a, b) { const t = performance.now(); const out = orig(a, b); window.__perfRenderMs.push(performance.now() - t); return out; };
    r.__perfPatched = true;
    return true;
  })()`) as Promise<boolean>;
}

async function drainRenderTimer(page: Page): Promise<PerfRenderJsStats | null> {
  const samples = await page.evaluate(`(() => { const a = window.__perfRenderMs || []; window.__perfRenderMs = []; return a; })()`) as number[];
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return { frames: samples.length, p50Ms: Math.round(q(0.5) * 100) / 100, p95Ms: Math.round(q(0.95) * 100) / 100 };
}

function loadPriorRuns(): PerfRun[] {
  if (!existsSync(OUT_DIR)) return [];
  const runs: PerfRun[] = [];
  for (const f of readdirSync(OUT_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { runs.push(JSON.parse(readFileSync(join(OUT_DIR, f), 'utf8')) as PerfRun); } catch { /* skip malformed */ }
  }
  return runs;
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

/**
 * Virgin-account handling: with 0 characters on the account the client parks
 * at the character-create wizard (main.ts characterList handler) and no
 * amount of reloading ever reaches the world. Drive a scripted creation
 * through the same submit path the wizard's Finish button uses — the default
 * wizard state (Aluvian, base 10s, no skills) passes ACE's
 * ValidateAttributeCredits (each 10-100, total ≤ heritage credits). On
 * success the client auto-enters the world with the new character; on
 * NameInUse the next reload's character list auto-enters the existing one.
 */
async function driveCharacterCreate(page: Page): Promise<string> {
  // Source string, not a function — see samplePhase (__name landmine).
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ${PROBE_CHARGEN_REOPEN_JS}
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function rendererString(page: Page): Promise<string> {
  return page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!gl) return 'no-webgl';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'masked';
  });
}

/** True when `pageUrl` is the game client (has ?ace, or the dev-server origin). */
function isGameUrl(pageUrl: string): boolean {
  try {
    const u = new globalThis.URL(pageUrl);
    return u.searchParams.has('ace') || new globalThis.URL(URL).origin === u.origin;
  } catch {
    return false;
  }
}

interface PhaseRunResult {
  phases: PhaseStats[];
  render: Record<string, RenderInfo | null>;
  renderJs: Record<string, PerfRenderJsStats | null>;
  renderSamples: Record<string, PerfInfoSample[]>;
  work: Record<string, PerfWorkStats | null>;
  /** Per-phase cumulative frameStats snapshots, for droppedFrameWarnings. */
  frameStats: Array<{ phase: string; frameStats?: PerfFrameStats | null }>;
  /** Every phase's scene costs are in-phase means (false = legacy point-sample semantics). */
  allPhasesMeanSampled: boolean;
}

/**
 * idle / turning / running, each from yaw 0 (unless --no-reset): frame
 * times, scene costs, renderer.render() time and the game's CPU work. The
 * unthrottled pass and the --throttle pass both run through here, so the two
 * measure exactly the same phases. `after(phase)` runs once each phase's
 * numbers are read (census, program keys).
 */
async function runPhases(page: Page, label: string, after?: (phase: string) => Promise<void>): Promise<PhaseRunResult> {
  const out: PhaseRunResult = {
    phases: [], render: {}, renderJs: {}, renderSamples: {}, work: {}, frameStats: [], allPhasesMeanSampled: true,
  };
  // Point read still supplies textures/programs/frameStats (memory-side
  // counters, not per-frame); the three per-frame scene-cost metrics come
  // from the phase mean (CORE.14.e). If any phase had no in-phase samples
  // (renderer info unavailable) the run degrades to legacy point-sample
  // semantics and is marked so for the ratchet.
  const mergeInfo = (point: RenderInfo | null, mean: PerfInfoSummary | null): RenderInfo | null => {
    if (!mean) out.allPhasesMeanSampled = false;
    if (!point) return null;
    if (!mean) return point;
    return { ...point, drawCalls: mean.drawCalls, triangles: mean.triangles, geometries: mean.geometries };
  };
  const yawApplied = NO_RESET ? false : await setYaw(page, 0);
  if (!NO_RESET && !yawApplied) console.log('[perf] *** setPlayerYaw unavailable — headings not deterministic');
  await drainRenderTimer(page);
  // CORE.18 — the controls turned true-handed: ArrowRight now sweeps the
  // world-space arc (yaw increasing from 0) that ArrowLeft swept for every
  // pre-CORE.18 baseline, so the ratchet keeps comparing the same scene.
  // running: streams new landblocks/scenery while moving — the primary hitch
  // generator (synchronous DAT decode, texture upload, geometry build).
  const plan: Array<{ phase: string; key?: string }> = [
    { phase: 'idle' }, { phase: 'turning', key: 'ArrowRight' }, { phase: 'running', key: 'ArrowUp' },
  ];
  for (const { phase, key } of plan) {
    console.log(`[perf] ${label}phase: ${phase} (${PHASE_SECS}s)…`);
    // Same start heading → same swept arc / same run direction every time.
    if (phase !== 'idle' && !NO_RESET) await setYaw(page, 0);
    if (key) await page.keyboard.down(key);
    const s = await samplePhase(page, PHASE_SECS * 1000);
    if (key) await page.keyboard.up(key);
    out.phases.push(stats(phase, s.deltas));
    out.render[phase] = mergeInfo(await renderInfo(page), summarizeInfoSamples(s.infoSamples));
    out.renderSamples[phase] = s.infoSamples;
    out.renderJs[phase] = await drainRenderTimer(page);
    out.work[phase] = summarizeWork(s.works, s.phaseSums, FRAME_PHASES);
    out.frameStats.push({ phase, frameStats: out.render[phase]?.frameStats });
    if (after) await after(phase);
  }
  return out;
}

/** Whether dynamic resolution is running on the page (SceneManager.dynamicResolution exists only when it is on). */
async function dynamicResolutionOn(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const sm = window.__ac && window.__ac.sceneManager;
    return !!(sm && sm.dynamicResolution);
  })()`) as Promise<boolean>;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  let browser;
  let page: Page;
  let ownPage = true; // pages we opened get closed; an attached user tab stays
  if (ATTACH) {
    // Real-GPU path that survives the local harness: the user starts their
    // own Chrome with --remote-debugging-port=9222 and we only attach — no
    // headed launch to hang. See the header comment for the exact command.
    console.log(`[perf] attaching over CDP: ${ATTACH_ENDPOINT}`);
    browser = await chromium.connectOverCDP(ATTACH_ENDPOINT);
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const existing = ctx.pages().find(p => isGameUrl(p.url()));
    if (existing) {
      page = existing;
      ownPage = false;
      console.log(`[perf] reusing open game tab: ${page.url()}`);
    } else {
      page = await ctx.newPage();
    }
    console.log('[perf] keep the game tab visible/frontmost — hidden tabs throttle rAF');
  } else {
    browser = await chromium.launch(GPU
      ? { headless: true, channel: 'chromium', args: ['--ignore-gpu-blocklist'] }
      : {
        headless: !HEADED,
        // Software-WebGL opt-in is for headless containers only: a real-GPU
        // headed run must fail loudly rather than fall back to SwiftShader.
        args: HEADED ? [] : ['--enable-unsafe-swiftshader'],
        ...(existsSync(REMOTE_CHROMIUM) && !HEADED ? { executablePath: REMOTE_CHROMIUM } : {}),
      });
    if (GPU) {
      const probe = await browser.newPage();
      const gl = await probe.evaluate(() => {
        const g = document.createElement('canvas').getContext('webgl2');
        const e = g?.getExtension('WEBGL_debug_renderer_info');
        return e ? String(g!.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'unknown';
      });
      await probe.close();
      console.log(`[perf] --gpu renderer: ${gl}`);
      if (isSoftwareRenderer(gl)) {
        console.error('[perf] --gpu asked for the real GPU but got a software renderer; refusing to record it as a real-GPU run');
        await browser.close();
        process.exit(3);
      }
    }
    page = await browser.newPage({ viewport: VIEW });
    if (DRAW_DISTANCE !== undefined) {
      await page.addInitScript((dd) => {
        const key = 'ac_options_settings_v1';
        let cur: Record<string, unknown> = {};
        try { cur = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { /* fresh */ }
        localStorage.setItem(key, JSON.stringify({ ...cur, landscapeDrawDistance: dd }));
      }, DRAW_DISTANCE);
      console.log(`[perf] Landscape Draw Distance seeded to ${DRAW_DISTANCE}`);
    }
  }
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  if (!ATTACH || !isGameUrl(page.url()) || !(await inWorld(page))) {
    console.log(`[perf] navigating ${URL}`);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
  } else {
    console.log('[perf] attached tab is already in world — skipping navigation');
  }

  // Same phantom-session retry loop as capture-ui-screens.ts: reload every
  // 60s until world entry, up to 6 minutes.
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[perf] virgin account at character-create — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now(); // give world entry a full window before reloading
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[perf] not in world yet — reloading (phantom-session retry)');
      // Non-fatal: with the main thread jammed (SwiftShader + synchronous DAT
      // parsing) the unload handshake can outlast the navigation timeout —
      // keep polling and retry the reload next window instead of dying.
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (e) {
        console.log(`[perf] reload failed (${(e as Error).message.split('\n')[0]}) — continuing`);
      }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    if (ATTACH && ownPage) await page.close();
    await browser.close();
    throw new Error('never entered world within 360s');
  }
  console.log('[perf] in world — letting object streams settle (10s)…');
  await page.waitForTimeout(10_000);

  // CORE.14.e — deterministic starting state. Without this the persistent
  // character keeps the heading/position the previous run's turning+running
  // phases left it with, and every run measures a different scene.
  let reset: PerfReset;
  if (NO_RESET) {
    reset = { telepoi: 'skipped-flag', yaw: 0 };
    console.log('[perf] --no-reset: measuring wherever the character stands (runs may not be comparable)');
  } else {
    reset = await resetToParkSpot(page);
    console.log(`[perf] reset: telepoi=${reset.telepoi}${reset.distBefore !== undefined ? ` (was ${reset.distBefore}m from park spot)` : ''}`);
    if (reset.telepoi === 'failed') console.log('[perf] *** telepoi never landed — location comparability not guaranteed');
    // CORE.18.a — login and @telepoi now turn the camera to the server
    // heading (the POI's / the saved one), so settle facing yaw 0 like every
    // earlier baseline did: geometries/textures are GPU-upload counters, and
    // settling while facing elsewhere uploads a different set before idle.
    await setYaw(page, 0);
    const settle = await waitForSceneSettle(page);
    console.log(`[perf] scene settle: ${settle.meshes} meshes after ${(settle.settleMs / 1000).toFixed(0)}s${settle.plateau ? '' : ' *** never plateaued (120s cap) — streaming may still be filling the scene'}`);
    reset.settle = settle;
  }

  const renderer = await rendererString(page);
  console.log(`[perf] renderer: ${renderer}`);
  const landscapeDrawDistance = await page.evaluate(() => {
    try { const v = JSON.parse(localStorage.getItem('ac_options_settings_v1') ?? '{}').landscapeDrawDistance; return typeof v === 'number' ? v : undefined; } catch { return undefined; }
  }) ?? SHIPPED_DEFAULT_LANDSCAPE_DRAW_DISTANCE;
  console.log(`[perf] Landscape Draw Distance in effect: ${landscapeDrawDistance}`);
  const location = await playerLocation(page);
  console.log(`[perf] location: ${location ? `${location.landblock} (${location.x}, ${location.y}, ${location.z})` : 'unknown'}`);
  const timerOk = await installRenderTimer(page);
  if (!timerOk) console.log('[perf] renderer.render timer unavailable — renderJs will be null');
  // Dynamic resolution is off under automation (navigator.webdriver) unless
  // ?renderAdapt=1, so a launched run measures a fixed buffer; an --attach tab
  // in an ordinary Chrome has it on. Recorded, and a comparability key.
  const dynamicResolution = await dynamicResolutionOn(page);
  if (dynamicResolution) console.log('[perf] *** dynamic resolution is ON (add ?renderAdapt=0 to measure a fixed buffer); this run compares only with other such runs');

  // frameStats counters are cumulative since page load — snapshot before the
  // first phase so per-phase dropped-frame deltas exclude the loading screen.
  const frameStatsStart = (await renderInfo(page))?.frameStats ?? null;
  const keys: Record<string, string[] | null> = {};
  if (PROGRAM_KEYS) keys.settled = await programKeys(page);
  // What the idle scene holds and draws (read right after the idle phase).
  const idleScene: { census: SceneCensus | null; draws: DrawCensus | null } = { census: null, draws: null };
  const unthrottled = await runPhases(page, '', async (phase) => {
    if (phase === 'idle') {
      idleScene.census = await sceneCensus(page);
      idleScene.draws = await drawCensus(page);
    }
    if (PROGRAM_KEYS) keys[phase] = await programKeys(page);
  });
  const { census, draws } = idleScene;
  const { phases, render, renderJs, renderSamples, work, allPhasesMeanSampled } = unthrottled;

  // PERF.integrated-gpu-cpu-bound — the throttled pass: re-park (the running
  // phase carried the character off the spot), settle at full speed, then the
  // same three phases with the main thread N× slower. Scene costs are the
  // unthrottled pass's; this pass records frame times and CPU work.
  let throttled: PerfThrottledPass | undefined;
  let throttledStart: PerfFrameStats | null = null;
  let throttledSnapshots: PhaseRunResult['frameStats'] = [];
  if (THROTTLE !== undefined) {
    let parked = true;
    if (!NO_RESET) {
      const again = await resetToParkSpot(page);
      console.log(`[perf] throttled pass: re-park telepoi=${again.telepoi}${again.distBefore !== undefined ? ` (was ${again.distBefore}m from park spot)` : ''}`);
      if (again.telepoi === 'failed') {
        parked = false;
        console.log('[perf] *** telepoi never landed — skipping the throttled pass (it would measure another scene)');
      } else {
        await setYaw(page, 0);
        const settle = await waitForSceneSettle(page);
        console.log(`[perf] throttled pass: scene settle ${settle.meshes} meshes after ${(settle.settleMs / 1000).toFixed(0)}s${settle.plateau ? '' : ' *** never plateaued'}`);
      }
    }
    if (parked) {
      const cdp = await page.context().newCDPSession(page);
      throttledStart = (await renderInfo(page))?.frameStats ?? null;
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
      let t: PhaseRunResult;
      try {
        t = await runPhases(page, `${THROTTLE}x CPU `);
      } finally {
        // Always back to full speed: an --attach tab is the user's own.
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
        await cdp.detach().catch(() => {});
      }
      throttledSnapshots = t.frameStats;
      throttled = { rate: THROTTLE, phases: t.phases, renderJs: t.renderJs, work: t.work };
    }
  }

  // Attached tabs have whatever size the user's window has — record reality.
  const viewport = page.viewportSize() ?? VIEW;

  if (ATTACH) {
    if (ownPage) await page.close();
    await browser.close(); // connected over CDP: disconnects, user's Chrome stays up
  } else {
    await browser.close();
  }

  const estimated = Object.fromEntries(
    Object.entries(render).map(([k, ri]) => [k, ri ? estimateRealGpu(ri.drawCalls) : null]),
  );
  // Frozen-camera detection: a phase whose every frame dropped its physics
  // substeps never turned/moved — its numbers describe the idle scene.
  const warnings = droppedFrameWarnings(
    frameStatsStart,
    unthrottled.frameStats,
  );
  if (throttled) {
    throttled.warnings = droppedFrameWarnings(throttledStart, throttledSnapshots).map(w => `throttled ${throttled!.rate}x: ${w}`);
    warnings.push(...throttled.warnings);
  }
  const result = {
    utc: new Date().toISOString(),
    url: URL,
    viewport,
    headed: HEADED,
    attached: ATTACH || undefined,
    renderer,
    warnings,
    location: location ?? undefined,
    phaseSecs: PHASE_SECS,
    // CORE.14.e — sampling-mode + reset provenance. Absent renderSampling in
    // old JSON means end-of-phase point sample; the ratchet never compares
    // across sampling modes.
    // PERF.6 — every frame, mean over 30° heading sectors when every sample
    // carried a yaw ('phase-mean-1s' was a 1/s wall-clock mean that aliased
    // with the turn; the two never compare).
    renderSampling: !allPhasesMeanSampled ? undefined
      : Object.values(renderSamples).every(ss => ss.every(x => typeof x.yaw === 'number')) ? 'frame-heading-binned' : 'frame-mean',
    landscapeDrawDistance,
    dynamicResolution,
    reset,
    phases,
    render,
    renderJs,
    work,
    // PERF.integrated-gpu-cpu-bound — the --throttle pass (absent without it).
    throttled,
    renderSamples,
    census,
    draws,
    estimatedRealGpu: estimated,
    programKeys: PROGRAM_KEYS ? keys : undefined,
    // Filled below when --ratchet ran: the run's own verdict, so
    // perf-ratchet-lib findBaseline never adopts a regressed run as a baseline.
    ratchetVerdict: undefined as PerfRun['ratchetVerdict'],
  };
  // Ratchet BEFORE writing so the verdict lands in the JSON itself.
  let ratchet: { v: ReturnType<typeof compareToHistory> } | null = null;
  let throttledRatchet: RatchetVerdict | null = null;
  if (RATCHET) {
    // PERF.6 — the median of the last RATCHET_HISTORY comparable runs, with
    // in-spread excursions reported as noise (perf-ratchet-lib compareToHistory).
    const prior = loadPriorRuns();
    const baselines = findBaselines(prior, result as unknown as PerfRun);
    if (baselines.length) {
      ratchet = { v: compareToHistory(baselines, result as unknown as PerfRun) };
      result.ratchetVerdict = ratchet.v.verdict;
    } else {
      result.ratchetVerdict = 'no-baseline';
    }
    // The throttled pass ratchets only against earlier throttled passes at the
    // same rate (perf-ratchet-lib throttledView); its verdict is its own.
    throttledRatchet = compareThrottled(prior, result as unknown as PerfRun);
    if (throttled && throttledRatchet) throttled.ratchetVerdict = throttledRatchet.verdict;
  }
  const outFile = join(OUT_DIR, `perf-${result.utc.replace(/[:.]/g, '-')}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 2));

  console.log('\nphase     frames  avgFps  p50ms  p95ms  p99ms  maxms  >33ms%  >50ms  >100ms');
  for (const p of phases) {
    console.log(
      `${p.phase.padEnd(9)} ${String(p.frames).padStart(6)}  ${String(p.avgFps).padStart(6)}` +
      `  ${String(p.p50Ms).padStart(5)}  ${String(p.p95Ms).padStart(5)}  ${String(p.p99Ms).padStart(5)}` +
      `  ${String(p.maxMs).padStart(5)}  ${String(p.longFramePct).padStart(6)}` +
      `  ${String(p.hitch50).padStart(5)}  ${String(p.hitch100).padStart(6)}`,
    );
  }
  console.log(`\nphase     drawCalls  triangles  geoms  textures  programs  renderJs p50/p95  est.realGPU${allPhasesMeanSampled ? '   (scene costs = per-frame means over heading sectors)' : ''}`);
  for (const [name, ri] of Object.entries(render)) {
    if (!ri) { console.log(`${name.padEnd(9)} (renderer info unavailable)`); continue; }
    const rj = renderJs[name];
    const est = estimated[name];
    console.log(
      `${name.padEnd(9)} ${String(ri.drawCalls).padStart(9)}  ${String(ri.triangles).padStart(9)}` +
      `  ${String(ri.geometries).padStart(5)}  ${String(ri.textures).padStart(8)}  ${String(ri.programs).padStart(8)}` +
      `  ${rj ? `${rj.p50Ms}/${rj.p95Ms}ms`.padStart(16) : '—'.padStart(16)}` +
      `  ${est ? `${est.frameMs}ms ≈ ${est.fps} fps` : '—'}`,
    );
  }
  if (allPhasesMeanSampled) {
    for (const [name, samples] of Object.entries(renderSamples)) {
      const s = summarizeInfoSamples(samples);
      if (s) console.log(`  ${name.padEnd(9)} drawCalls spread ${s.spread.drawCalls.min}–${s.spread.drawCalls.max} over ${s.sampleCount} frames${s.headingBins ? `, ${s.headingBins} heading sector(s)` : ''}`);
    }
  }
  if (census) {
    console.log(`\nscene census: ${census.meshes} meshes, ${census.instanced} instanced`);
    const rows = Object.entries(census.categories).sort((a, b) => b[1].total - a[1].total).slice(0, 8);
    console.log('category        total  visible  >300m  >600m');
    for (const [cat, c] of rows) {
      console.log(`${cat.padEnd(14)} ${String(c.total).padStart(6)} ${String(c.visible).padStart(8)} ${String(c.beyond300).padStart(6)} ${String(c.beyond600).padStart(6)}`);
    }
  }
  if (draws) {
    console.log(`\nidle draws: ${draws.drawsPerFrame}/frame over ${draws.frames} frames; ${draws.distinctMaterials} materials, ${draws.distinctGeometries} geometries per frame`);
    console.log(`  by blend: ${Object.entries(draws.byBlend).map(([k, n]) => `${k} ${n}`).join(', ')}`);
    for (const [cat, n] of Object.entries(draws.byCategory).slice(0, 12)) console.log(`  ${cat.padEnd(22)} ${String(n).padStart(7)}`);
  }
  printWork('', work);
  if (throttled) {
    console.log(`\nthrottled ${throttled.rate}x CPU  frames  avgFps  p50ms  p95ms  >100ms   work p50/p95 ms`);
    for (const p of throttled.phases as PhaseStats[]) {
      const w = throttled.work?.[p.phase];
      console.log(
        `${p.phase.padEnd(9)}          ${String(p.frames).padStart(6)}  ${String(p.avgFps).padStart(6)}` +
        `  ${String(p.p50Ms).padStart(5)}  ${String(p.p95Ms).padStart(5)}  ${String(p.hitch100).padStart(6)}` +
        `   ${w ? `${w.p50Ms}/${w.p95Ms}` : '—'}`,
      );
    }
    printWork(`throttled ${throttled.rate}x `, throttled.work);
  } else if (THROTTLE !== undefined) {
    console.log(`\n[perf] *** the ${THROTTLE}x throttled pass did not run (re-park failed)`);
  }
  for (const w of warnings) console.log(`\n[perf] *** WARNING *** ${w}`);
  console.log(`\n[perf] wrote ${outFile}`);

  if (RATCHET) {
    let regressed = false;
    if (!ratchet) {
      console.log('[perf] ratchet: no comparable baseline (same renderer + same location) — nothing to compare, verdict: no-baseline');
    } else {
      regressed = printVerdict('ratchet', ratchet.v) || regressed;
    }
    if (throttledRatchet && throttled) {
      if (throttledRatchet.verdict === 'no-baseline') {
        console.log(`[perf] throttled ${throttled.rate}x ratchet: no comparable throttled baseline — verdict: no-baseline`);
      } else {
        regressed = printVerdict(`throttled ${throttled.rate}x ratchet`, throttledRatchet) || regressed;
      }
    }
    if (regressed) process.exit(2);
  }
}

/** The ratchet verdict's log lines; true when it regressed. */
function printVerdict(name: string, v: RatchetVerdict): boolean {
  console.log(`[perf] ${name} vs median of ${v.baselineUtcs?.length ?? 1} run(s) (${(v.baselineUtcs ?? [v.baselineUtc]).join(', ')}): ${v.verdict.toUpperCase()}`);
  for (const f of v.findings) console.log(`  REGRESSION ${f.metric}: ${f.baseline} → ${f.current} (${(f.delta * 100).toFixed(1)}%)`);
  for (const f of v.noise ?? []) console.log(`  noise      ${f.metric}: ${f.baseline} → ${f.current} (${(f.delta * 100).toFixed(1)}%, inside the baseline runs' own range)`);
  for (const f of v.within) console.log(`  ok         ${f.metric}: ${f.baseline} → ${f.current} (${(f.delta * 100).toFixed(1)}%)`);
  return v.verdict === 'regression';
}

/** Game CPU work per phase, with its five largest frameStep phases. */
function printWork(label: string, work: Record<string, PerfWorkStats | null> | undefined): void {
  if (!work || !Object.values(work).some(Boolean)) return;
  console.log(`\n${label}game CPU work (frameStep through render): p50 / p95 / mean ms, top phases (mean ms/frame)`);
  for (const [phase, w] of Object.entries(work)) {
    if (!w) { console.log(`${phase.padEnd(9)} (no __ac.framePhases on this page)`); continue; }
    const top = Object.entries(w.phaseMs ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, ms]) => `${k} ${ms}`).join(', ');
    console.log(`${phase.padEnd(9)} ${w.p50Ms} / ${w.p95Ms} / ${w.meanMs}   ${top}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
