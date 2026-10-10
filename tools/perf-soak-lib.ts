/**
 * The decisions of tools/perf-soak.ts's session soak (2026-10-03 resource
 * sweep), split out so tests/verify-perf-soak-lib.ts drives them without a
 * browser: frame-time statistics per sample window, and the session budgets
 * (docs/performance-budgets.md "Session soak").
 */

export interface FrameStats {
  /** Frames in the window. */
  n: number;
  /** 99th-percentile frame time, ms. */
  p99: number;
  /** Worst frame, ms. */
  max: number;
  /** Frames longer than 50 ms: a visible hitch (under 20 fps for that frame). */
  over50: number;
}

/** Stats over the rAF deltas of one sample window. */
export function frameStats(frameMs: readonly number[]): FrameStats {
  const f = frameMs.filter((x) => Number.isFinite(x) && x > 0);
  if (!f.length) return { n: 0, p99: 0, max: 0, over50: 0 };
  const sorted = [...f].sort((a, b) => a - b);
  const p99 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)];
  return { n: f.length, p99: +p99.toFixed(1), max: +sorted[sorted.length - 1].toFixed(1), over50: f.filter((x) => x > 50).length };
}

/**
 * Real-GPU frame budgets per phase, ms. `arrived` has none: a teleport streams
 * a landblock in. Set at about 2x the first session soak on the M3 Max
 * (2026-10-03, soak-2026-10-03T15-14-39): worst-window p99 running 24.8 /
 * ui 18.2 / combat 17.7 / chat 17.5 ms; worst single frame 41.0 / 50.8 / 18.3
 * / 26.6 ms. One long frame is the hitch a player feels, so it gets a budget too.
 */
export const HITCH_P99_MS: Readonly<Record<string, number>> = { running: 50, ui: 50, combat: 50, chat: 50 };
export const MAX_FRAME_MS: Readonly<Record<string, number>> = { running: 100, ui: 100, combat: 100, chat: 100 };

interface BudgetSample {
  phase: string;
  nodes: number; listeners: number; domCanvases: number;
  webglLost: number; canvas2dLost: number;
  frames: FrameStats;
}

/**
 * Session-soak budget breaches (each a one-line reason). `firstStop` is the
 * first stop's settled idle sample and `last` the end-of-route sample taken
 * back there after the sweep + GC, so the two are compared like for like.
 *  - Any GPU context loss (the 2026-10-03 IOSurface exhaustion blanked the UI).
 *  - DOM nodes, event listeners, canvases in the page outside the chat log
 *    (which its own 100-line cap bounds): end within +25% (+20 slack for small
 *    counts) of the first stop. UI churn must not pile up.
 *  - On the real GPU only (`gpu`): every phase's worst-window p99 frame time
 *    within HITCH_P99_MS, and its worst single frame within MAX_FRAME_MS.
 *    SwiftShader frame times mean nothing.
 */
export function sessionBudgetBreaches(samples: readonly BudgetSample[], ref: { firstStop: BudgetSample; last: BudgetSample }, gpu = true): string[] {
  const out: string[] = [];
  const lost = samples.reduce((m, s) => Math.max(m, s.webglLost + s.canvas2dLost), 0);
  if (lost > 0) out.push(`graphics context lost ${lost} time(s) during the session`);
  for (const k of ['nodes', 'listeners', 'domCanvases'] as const) {
    const base = ref.firstStop[k];
    if (ref.last[k] > base * 1.25 + 20) out.push(`${k} ${base} → ${ref.last[k]} (> +25%)`);
  }
  if (gpu) {
    for (const [phase, limit] of Object.entries(HITCH_P99_MS)) {
      const ph = samples.filter((s) => s.phase === phase && s.frames.n > 0);
      if (!ph.length) continue;
      const worst = Math.max(...ph.map((s) => s.frames.p99));
      if (worst > limit) out.push(`${phase} frame p99 ${worst} ms (> ${limit} ms)`);
      const maxFrame = Math.max(...ph.map((s) => s.frames.max));
      const maxLimit = MAX_FRAME_MS[phase];
      if (maxLimit !== undefined && maxFrame > maxLimit) out.push(`${phase} worst frame ${maxFrame} ms (> ${maxLimit} ms)`);
    }
  }
  return out;
}

/** The part of a host-contention reading kept per sample (gpu-queue-lib hostContention). */
export interface SampleHost { load1: number; otherBrowsers: number; retailClients: number; reason: string | null }

export function sampleHost(h: { load1: number; otherBrowsers: number; retailClients: number; reason: string | null } | undefined): SampleHost | undefined {
  return h ? { load1: h.load1, otherBrowsers: h.otherBrowsers, retailClients: h.retailClients, reason: h.reason } : undefined;
}

/**
 * One summary line about what else ran during the soak, or null when nothing
 * was measured. Frame-time budgets measured beside another browser, the retail
 * client or a loaded CPU are that work's numbers too: the line starts
 * "HOST CONTENDED" so the GPU worker's headline carries it
 * (PERF.gpu-soak-hitch-ee124a12: four of the five 2026-10-04 soaks that broke
 * the hitch budget ran beside another Playwright browser, which the old RSS
 * probe measured instead of their own).
 */
export function hostSummary(samples: ReadonlyArray<{ phase: string; host?: SampleHost }>): string | null {
  const hs = samples.map((s) => s.host).filter((h): h is SampleHost => !!h);
  if (!hs.length) return null;
  const load = Math.max(...hs.map((h) => h.load1));
  const browsers = Math.max(...hs.map((h) => h.otherBrowsers));
  const retail = hs.some((h) => h.retailClients > 0);
  const contended = hs.filter((h) => h.reason);
  const facts = `load1 max ${load.toFixed(1)}, other Playwright browsers max ${browsers}, retail client ${retail ? 'seen' : 'not seen'}`;
  if (!contended.length) return `host quiet: ${facts}`;
  const reasons = [...new Set(contended.map((h) => h.reason))].slice(0, 3).join(' | ');
  return `HOST CONTENDED in ${contended.length}/${hs.length} samples (${reasons}): ${facts}; frame budgets are not this build's alone`;
}

/**
 * The character a dedicated probe account (AC_ACCOUNT set, e.g. fxprobe3)
 * creates when a fresh DB gives it none, so the soak can enter the world.
 * Letters only (ACE rejects digits in names): fxprobe3 → "Soakfxprobed".
 * The default shared account (AC_ACCOUNT unset) never creates one.
 */
export function soakCharacterName(account: string | undefined): string | undefined {
  if (!account) return undefined;
  const letters = account.toLowerCase().replace(/[0-9]/g, (d) => String.fromCharCode(97 + Number(d))).replace(/[^a-z]/g, '');
  return 'Soak' + letters;
}
