/**
 * Pixel-diff and verdict logic for tools/screen-regression.ts (the standing
 * all-screens regression pass). Pure functions over PNG bytes and capture
 * lists, so tests/verify-screen-regression.ts drives them directly.
 */
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

/**
 * `hud` = the DOM/HUD layer of a scene, captured with the WebGL world canvas
 * hidden (capture-ui-screens.ts --no-world writes `scenes/<name>.hud.png`
 * next to each whole-frame scene). It is judged like a panel, so a HUD
 * regression cannot hide inside a moving world's frame-wide noise.
 */
export type CaptureKind = 'panel' | 'preworld' | 'scene' | 'hud';

export interface PairDiff {
  name: string;
  kind: CaptureKind;
  /** 'changed' | 'unchanged' decided by the kind's threshold; 'missing-*' when one side has no capture. */
  status: 'changed' | 'unchanged' | 'missing-base' | 'missing-head' | 'size-mismatch';
  changedPixels: number;
  totalPixels: number;
  ratio: number;
  /** Changed pixels in the largest connected changed region (see largestChangedCluster). */
  largestCluster: number;
  /** Which bar a 'changed' capture failed: the frame-wide ratio or the largest cluster. */
  reason?: 'ratio' | 'cluster';
  /** Red-on-grey diff image, when both sides exist and sizes match. */
  diffPng?: Buffer;
}

/**
 * Fraction of pixels that may differ before a capture counts as changed.
 * Panels/preworld are DOM over a hidden (or static) world and measured
 * EXACTLY 0 same-code noise (2026-09-26 calibration, 25 of 27 captures), so the bar
 * is ~12 pixels of a 1568x775 frame. A 0.05% bar missed a deliberate 4 px red
 * outline on a toolbar button (276 px). Scenes are WebGL on SwiftShader with
 * pinned time/weather/day group, but still carry sub-percent raster noise.
 * A scene's HUD layer is DOM with the world hidden: panel-grade.
 */
export const DEFAULT_THRESHOLDS: Record<CaptureKind, number> = {
  panel: 0.00001,
  preworld: 0.00001,
  scene: 0.01,
  hud: 0.00001,
};

/**
 * Largest connected changed region (in changed PIXELS) a capture may show
 * before it counts as changed, whatever its frame-wide ratio. The ratio alone
 * let scenes hide whole-panel regressions: world-running's calibrated floor
 * made the bar 26.7% of the frame and portal space 14.1% (2026-09-26 review),
 * while a panel that vanishes or moves is one solid region of thousands of
 * pixels. Raster noise is speckle: many tiny regions. 1000 px is a ~32x32
 * patch; `--calibrate` raises a capture's floor where its own noise forms
 * bigger regions (a running player's moving world).
 */
export const DEFAULT_CLUSTER_FLOORS: Record<CaptureKind, number> = {
  panel: 16,
  preworld: 16,
  scene: 1000,
  hud: 16,
};

/**
 * Clusters are found on a grid of CLUSTER_CELL x CLUSTER_CELL cells (a cell
 * is changed when any pixel in it is), 8-connected, so the separate strokes
 * of one changed text label or icon join into one region instead of reading
 * as dozens of specks.
 */
export const CLUSTER_CELL = 4;

/** pixelmatch's per-pixel colour tolerance (0..1); absorbs AA/dither noise. */
const PIXEL_TOLERANCE = 0.1;

/**
 * Size (changed pixels) of the largest 8-connected region of changed
 * CLUSTER_CELL cells in a changed-pixel mask (1 = changed), row-major w*h.
 */
export function largestChangedCluster(mask: Uint8Array, w: number, h: number, cell = CLUSTER_CELL): number {
  const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell);
  const count = new Int32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    const row = y * w, crow = ((y / cell) | 0) * cw;
    for (let x = 0; x < w; x++) if (mask[row + x]) count[crow + ((x / cell) | 0)]++;
  }
  const seen = new Uint8Array(cw * ch);
  const stack = new Int32Array(cw * ch);
  let best = 0;
  for (let start = 0; start < count.length; start++) {
    if (!count[start] || seen[start]) continue;
    let sp = 0, size = 0;
    stack[sp++] = start; seen[start] = 1;
    while (sp) {
      const c = stack[--sp];
      size += count[c];
      const cx = c % cw, cy = (c / cw) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= ch) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= cw) continue;
          const n = ny * cw + nx;
          if (count[n] && !seen[n]) { seen[n] = 1; stack[sp++] = n; }
        }
      }
    }
    if (size > best) best = size;
  }
  return best;
}

export function diffPair(
  name: string,
  kind: CaptureKind,
  base: Buffer | null,
  head: Buffer | null,
  threshold = DEFAULT_THRESHOLDS[kind],
  clusterFloor = DEFAULT_CLUSTER_FLOORS[kind],
): PairDiff {
  if (!base || !head) {
    return { name, kind, status: base ? 'missing-head' : 'missing-base', changedPixels: 0, totalPixels: 0, ratio: 1, largestCluster: 0 };
  }
  const a = PNG.sync.read(base);
  const b = PNG.sync.read(head);
  if (a.width !== b.width || a.height !== b.height) {
    return { name, kind, status: 'size-mismatch', changedPixels: 0, totalPixels: a.width * a.height, ratio: 1, largestCluster: 0 };
  }
  const out = new PNG({ width: a.width, height: a.height });
  const changedPixels = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: PIXEL_TOLERANCE });
  const totalPixels = a.width * a.height;
  const ratio = changedPixels / totalPixels;
  let largestCluster = 0;
  if (changedPixels > 0) {
    // pixelmatch paints counted differences pure diffColor red (255,0,0);
    // unchanged pixels are drawn greyscale (r=g=b) and AA pixels yellow.
    const mask = new Uint8Array(totalPixels);
    for (let i = 0, p = 0; i < totalPixels; i++, p += 4) {
      mask[i] = out.data[p] === 255 && out.data[p + 1] === 0 && out.data[p + 2] === 0 ? 1 : 0;
    }
    largestCluster = largestChangedCluster(mask, a.width, a.height);
  }
  const reason = ratio > threshold ? 'ratio' : largestCluster > clusterFloor ? 'cluster' : undefined;
  return {
    name, kind,
    status: reason ? 'changed' : 'unchanged',
    changedPixels, totalPixels, ratio, largestCluster,
    ...(reason ? { reason } : {}),
    diffPng: changedPixels > 0 ? PNG.sync.write(out) : undefined,
  };
}

/**
 * Same-code noise per capture, measured by `screen-regression.ts --calibrate`
 * (base = head) and committed as verification/screen-regression-noise.json.
 * Each entry is { ratio, cluster, date, renderer }; a bare number is the
 * pre-2026-09-26 ratio-only format (cluster never measured).
 *
 * A capture's thresholds are its kind defaults or, when calibration saw more
 * noise than that (a running-player scene, an animated paperdoll), 1.5x the
 * observed noise plus a small margin. Motion-heavy captures therefore only
 * flag changes clearly above their own run-to-run wobble.
 */
export interface NoiseEntry { ratio: number; cluster?: number; date?: string; renderer?: string }
export type NoiseFloor = Record<string, number | NoiseEntry>;

export function noiseEntry(v: number | NoiseEntry | undefined): NoiseEntry | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'number' ? { ratio: v } : v;
}

export function thresholdFor(name: string, kind: CaptureKind, noise: NoiseFloor = {}): number {
  const seen = noiseEntry(noise[name])?.ratio;
  const base = DEFAULT_THRESHOLDS[kind];
  return seen === undefined || seen <= base ? base : seen * 1.5 + 0.0005;
}

/**
 * The largest-cluster bar for a capture. Uncalibrated capture: the kind
 * default. A legacy ratio-only entry: Infinity (not judged by cluster) until
 * the next `--calibrate` measures it, because that capture is known to be
 * noisy and its cluster noise is unknown. Otherwise the default, or 1.5x the
 * calibrated cluster plus 64 px when that is larger.
 */
export function clusterThresholdFor(name: string, kind: CaptureKind, noise: NoiseFloor = {}): number {
  const e = noiseEntry(noise[name]);
  const base = DEFAULT_CLUSTER_FLOORS[kind];
  if (!e) return base;
  if (e.cluster === undefined) return Infinity;
  return e.cluster <= base ? base : Math.ceil(e.cluster * 1.5 + 64);
}

/**
 * Above this, a same-code difference is a broken capture (the world never
 * drew on one side, a panel failed to open), not noise. Recording it would
 * blind that capture for good, so calibration reports it instead.
 */
export const BROKEN_CAPTURE_RATIO = 0.25;

/**
 * Fold a calibration run into the stored floor. A capture measured this run
 * REPLACES its stored entry when that entry is stale: legacy ratio-only, or
 * recorded on another date or renderer. Floors used to be max-forever, so
 * one bad calibration (or noise that a later fix removed) loosened a capture
 * for good. Repeat calibrations on the same date + renderer keep the max of
 * the runs, so several same-day runs can be combined for a steadier floor.
 * Captures not measured this run keep their entries.
 */
export function mergeNoise(prev: NoiseFloor, diffs: PairDiff[], run: { date: string; renderer: string }): NoiseFloor {
  const out: NoiseFloor = { ...prev };
  for (const d of diffs) {
    if (d.status === 'missing-base' || d.status === 'missing-head' || d.status === 'size-mismatch') continue;
    if (d.ratio > BROKEN_CAPTURE_RATIO) continue;
    const measured: NoiseEntry = { ratio: Number(d.ratio.toFixed(6)), cluster: d.largestCluster, date: run.date, renderer: run.renderer };
    const old = noiseEntry(prev[d.name]);
    const sameRun = old && old.date === run.date && old.renderer === run.renderer && old.cluster !== undefined;
    out[d.name] = sameRun
      ? { ...measured, ratio: Math.max(old.ratio, measured.ratio), cluster: Math.max(old.cluster!, measured.cluster!) }
      : measured;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Pre-world captures that animate every frame (portal space's swirl) judge
 * like scenes; a scene's `.hud` layer judges like a panel (kind 'hud').
 */
export function kindFor(sub: '' | 'preworld' | 'scenes', name: string): CaptureKind {
  if (sub === 'scenes' && name.endsWith('.hud')) return 'hud';
  if (sub === 'scenes' || name === 'portal-space') return 'scene';
  return sub === 'preworld' ? 'preworld' : 'panel';
}

export interface Verdict {
  /** Changed (or missing) captures the task did NOT declare — must be explained or fixed. */
  unexpected: PairDiff[];
  /** Changed captures the task declared with --expect. */
  expected: PairDiff[];
  /** Declared with --expect but did not change — the intended change may not have landed. */
  expectedButUnchanged: PairDiff[];
  unchanged: PairDiff[];
}

/**
 * Split diffs by the task's declared intent. `expect` entries match a capture
 * name exactly or as a prefix ending in '*' (`social-*`). Declaring a scene
 * declares its `.hud` layer too.
 */
export function judge(diffs: PairDiff[], expect: string[]): Verdict {
  // A pattern matches the capture name with or without its folder (preworld/,
  // scenes/): `--expect char-create*` covers preworld/char-create-skills. The
  // routine missed the prefix three times on 2026-10-03, and each miss
  // reported an intended change as undeclared.
  const declared = (n: string) => {
    const names = new Set<string>();
    for (const full of [n, n.endsWith('.hud') ? n.slice(0, -4) : n]) {
      names.add(full);
      names.add(full.replace(/^(preworld|scenes)\//, ''));
    }
    return expect.some((e) => [...names].some((x) => (e.endsWith('*') ? x.startsWith(e.slice(0, -1)) : x === e)));
  };
  const v: Verdict = { unexpected: [], expected: [], expectedButUnchanged: [], unchanged: [] };
  for (const d of diffs) {
    const moved = d.status !== 'unchanged';
    if (moved && declared(d.name)) v.expected.push(d);
    else if (moved) v.unexpected.push(d);
    else if (declared(d.name)) v.expectedButUnchanged.push(d);
    else v.unchanged.push(d);
  }
  return v;
}

export function formatReport(v: Verdict, baseRef: string, headRef: string): string {
  const row = (d: PairDiff) =>
    `| ${d.name} | ${d.kind} | ${d.status}${d.reason ? ` (${d.reason})` : ''} | ${(d.ratio * 100).toFixed(3)}% | ${d.changedPixels} | ${d.largestCluster} |`;
  const table = (title: string, ds: PairDiff[]) =>
    ds.length ? [`### ${title} (${ds.length})`, '', '| capture | kind | status | changed | pixels | largest cluster (px) |', '|---|---|---|---|---|---|', ...ds.map(row), ''] : [];
  return [
    `# Screen regression: ${baseRef} → ${headRef}`,
    '',
    v.unexpected.length
      ? `**${v.unexpected.length} capture(s) changed that the task did not declare.** Open each diff PNG; fix the regression or re-run with --expect after confirming the change is intended.`
      : '**No undeclared screen changes.**',
    '',
    ...table('UNEXPECTED changes', v.unexpected),
    ...table('Declared and changed', v.expected),
    ...table('Declared but UNCHANGED (did the change land?)', v.expectedButUnchanged),
    `Unchanged: ${v.unchanged.length} capture(s).`,
    '',
  ].join('\n');
}

/**
 * One screen-regression run at a time per checkout. Two concurrent runs both
 * log into the shared ACE account (ACE boots the older session) and, before
 * dynamic ports, one run's capture could silently hit the OTHER run's Vite
 * (a --strictPort server that failed to bind still left the port answering).
 * Returns null when the lock is taken by a live process, else the lock
 * contents to write. `isAlive(pid)` is injected for tests.
 */
export function acquireRunLock(
  existing: string | null,
  myPid: number,
  isAlive: (pid: number) => boolean,
): { holder: number } | null {
  const held = existing ? Number.parseInt(existing.trim(), 10) : NaN;
  if (Number.isFinite(held) && held > 0 && held !== myPid && isAlive(held)) return null;
  return { holder: myPid };
}
