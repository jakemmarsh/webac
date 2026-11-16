/**
 * RELEASE.capability-check — can this browser run the client?
 *
 * Retail had a minimum-spec list on the box; a browser needs the check at
 * boot, before the patch screen starts downloading. A hard problem (no WebGL
 * 2, no WebSocket) stops with an explanation; a soft one (little memory, no
 * mouse) explains and lets the player continue. This screen is browser UX,
 * not a retail screen (CLAUDE.md, browser-UX exception). It draws before any
 * DAT is loaded, on the boot notice plate (boot/BootNotice.ts): the retail OK
 * dialog's look reproduced in CSS from its DAT values.
 */
import { classifyGpu } from '../telemetry/WorldReporter.js';
import { probeWebGl2, canCreateWebGl2, detectHelpPlatform, webgl2HelpText, type WebGlFailure, type HelpPlatform } from './WebGlDiagnosis.js';
import { renderAdaptConfigFor, type RenderAdaptConfig } from '../scene/RenderScale.js';
import { showBootNotice } from './BootNotice.js';

export interface CapabilityProblem {
  id: 'webgl2' | 'websocket' | 'decompression' | 'memory' | 'pointer';
  hard: boolean;
  text: string;
}

export interface CapabilityEnv {
  /** A WebGL 2 context can be created. */
  webgl2: boolean;
  websocket: boolean;
  /**
   * COMPAT.decompression-stream-gate — DecompressionStream exists (the streamed DAT objects are
   * gzip, inflated by it: dat/streaming/DatStore.ts). Safari only from 16.4, Firefox from 113
   * (https://caniuse.com/mdn-api_decompressionstream). Absent = true.
   */
  decompressionStream?: boolean;
  /** navigator.deviceMemory in GB (Chromium; capped at 8), or null when the browser doesn't say. */
  deviceMemoryGb: number | null;
  /** A mouse or trackpad is present (`(pointer: fine)` or `(any-pointer: fine)`). */
  finePointer: boolean;
  /**
   * PERF.render-adapt — the probe context draws without the graphics card
   * (classifyGpu 'software': SwiftShader / llvmpipe / Basic Render Driver).
   * Not a problem shown to the player (some have no GPU at all): the client
   * adapts instead (scene/RenderScale.ts) and reports it. Absent = false.
   */
  softwareGpu?: boolean;
  /** navigator.webdriver (an automated browser). Absent = false. */
  webdriver?: boolean;
  /** `?renderAdapt=` from the page URL, or null. */
  renderAdapt?: string | null;
  /** BOOT.webgl2-diagnosis — why WebGL 2 failed (null / absent when it worked or wasn't probed). */
  webgl2Failure?: WebGlFailure | null;
  /** OS + browser family, for the fix the message gives. Absent = unknown. */
  platform?: HelpPlatform;
}

/** The render adaptation this browser gets (scene/RenderScale.ts). */
export function renderAdaptFor(env: CapabilityEnv): RenderAdaptConfig {
  return renderAdaptConfigFor({ software: env.softwareGpu === true, webdriver: env.webdriver === true, override: env.renderAdapt ?? null });
}

/** Below this the streamed client (~1–2 GB in world) is likely to be killed by the browser. */
export const MIN_DEVICE_MEMORY_GB = 4;

export function capabilityProblems(env: CapabilityEnv): CapabilityProblem[] {
  const out: CapabilityProblem[] = [];
  if (!env.webgl2) {
    // BOOT.webgl2-diagnosis: the text names the fix for the cause the probe found, on this OS and browser
    // (boot/WebGlDiagnosis.ts). Unknown cause: the general advice, including the restart after a graphics
    // crash (live 2026-10-13: Chrome 155 on Windows, minutes after playing).
    out.push({ id: 'webgl2', hard: true, text: webgl2HelpText(env.webgl2Failure ?? null, env.platform ?? { os: 'other', browser: 'other' }) });
  }
  if (!env.websocket) {
    out.push({ id: 'websocket', hard: true, text: 'This browser cannot open the connection the game uses (WebSocket). Use a current desktop browser.' });
  }
  if (env.decompressionStream === false) {
    out.push({ id: 'decompression', hard: true, text: 'This browser is too old to load the game\'s data. Update to a current Chrome, Edge, Firefox or Safari (16.4 or later).' });
  }
  if (env.deviceMemoryGb !== null && env.deviceMemoryGb < MIN_DEVICE_MEMORY_GB) {
    out.push({
      id: 'memory', hard: false,
      text: `This device reports ${env.deviceMemoryGb} GB of memory. The game needs about ${MIN_DEVICE_MEMORY_GB} GB and may close or run slowly.`,
    });
  }
  if (!env.finePointer) {
    out.push({
      id: 'pointer', hard: false,
      text: 'Asheron\'s Call is played with a keyboard and mouse. Phones and tablets are not supported.',
    });
  }
  return out;
}

/** Probe the real browser. */
export function probeCapabilities(win: Window & typeof globalThis): CapabilityEnv {
  const probe = probeWebGl2(() => win.document.createElement('canvas'));
  const webgl2 = probe.webgl2;
  const rendererString = probe.renderer;
  let renderAdapt: string | null = null;
  try { renderAdapt = new URLSearchParams(win.location?.search ?? '').get('renderAdapt'); } catch { renderAdapt = null; }
  const mem = (win.navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const mq = (q: string) => { try { return win.matchMedia(q).matches; } catch { return true; } };
  return {
    webgl2,
    websocket: typeof win.WebSocket === 'function',
    decompressionStream: typeof (win as unknown as { DecompressionStream?: unknown }).DecompressionStream === 'function',
    deviceMemoryGb: typeof mem === 'number' && mem > 0 ? mem : null,
    finePointer: mq('(pointer: fine)') || mq('(any-pointer: fine)'),
    softwareGpu: webgl2 && classifyGpu(rendererString) === 'software',
    webdriver: win.navigator.webdriver === true,
    renderAdapt,
    webgl2Failure: probe.failure,
    platform: detectHelpPlatform(win.navigator as Navigator & { userAgentData?: { platform?: string; brands?: Array<{ brand: string }> } }),
  };
}

/**
 * Show the problems over the page on the boot notice plate (boot/BootNotice.ts,
 * the retail OK dialog's look in CSS), above the boot loading overlay
 * (ZLayer.BOOT_NOTICE over #loading-overlay's DEBUG_OVERLAY), which stays up
 * underneath and is what the page shows again after a soft prompt's Continue.
 * Resolves when the player chooses to continue (soft problems only); never
 * resolves when a problem is hard — that plate's only button reloads the page,
 * for after the player has fixed the cause (hardware acceleration, a newer
 * browser) the text names. The one exception: `recovered` resolving true (the
 * crash-block wait, runCapabilityGate) closes a hard screen and resolves.
 */
export function showCapabilityScreen(
  doc: Document, problems: CapabilityProblem[], reload: () => void = () => doc.defaultView?.location.reload(),
  recovered?: Promise<boolean>,
): Promise<void> {
  const hard = problems.some(p => p.hard);
  const paragraphs = problems.map(p => ({ text: p.text, className: `capability-problem capability-${p.id}` }));
  const title = hard ? 'This browser can\'t run the game' : 'Before you continue';
  if (hard) {
    const notice = showBootNotice(doc, {
      id: 'capability-screen', title, paragraphs,
      buttons: [{ label: 'Reload', className: 'capability-reload', onClick: reload }],
    });
    // BUG.webgl-crash-block-wait — a hard screen resolves only when its problem went away by itself
    // (runCapabilityGate's quiet WebGL 2 wait); otherwise it stays until Reload.
    return new Promise((resolve) => {
      void recovered?.then((ok) => { if (ok) { notice.close(); resolve(); } }, () => { /* stays up */ });
    });
  }
  return new Promise((resolve) => {
    const notice = showBootNotice(doc, {
      id: 'capability-screen', title, paragraphs,
      buttons: [{ label: 'Continue anyway', className: 'capability-continue', onClick: () => { notice.close(); resolve(); } }],
    });
  });
}

// ── BUG.webgl-crash-block-wait ────────────────────────────────────────
//
// Prod 2026-11-16: a GPU reset took both of a player's webAC tabs' contexts at once, and every reload
// for ~75 s stopped on this screen ("Web page caused context loss and was blocked") until one worked.
// Chromium blocks 3D for a site with two or more recorded context losses, and each loss expires after
// kBlockedDomainExpirationPeriod = base::Minutes(2) (content/browser/gpu/gpu_data_manager_impl_private.cc,
// Are3DAPIsBlockedAtTime, checked when a context is created). So for that cause alone the screen stays
// up while the page quietly tries a WebGL 2 context every WEBGL_CRASH_BLOCK_PROBE_MS for
// WEBGL_CRASH_BLOCK_WAIT_MS (the 2 minutes plus margin), and the boot carries on when one works.
// A browser-UX exception (CLAUDE.md): retail had no such screen.

/** How often the page tries WebGL 2 again while a crash block holds. */
export const WEBGL_CRASH_BLOCK_PROBE_MS = 10_000;
/** How long it keeps trying: Chromium's 2-minute block plus margin. Then the screen stays as it is. */
export const WEBGL_CRASH_BLOCK_WAIT_MS = 150_000;

export interface WaitTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  now(): number;
}

export interface WebGlWaitResult { recovered: boolean; waitedMs: number }

/** Whether the page waits this failure out: the crash block, with no other hard problem. */
export function crashBlockWaitable(env: CapabilityEnv, problems: readonly CapabilityProblem[]): boolean {
  return !env.webgl2 && env.webgl2Failure?.cause === 'context_lost_after_crash'
    && problems.every(p => !p.hard || p.id === 'webgl2');
}

/**
 * Try `probe` every `probeMs` until it works (recovered) or the next try would pass `maxMs` since the
 * start (gave up). Resolves once, with the time waited.
 */
export function waitForWebGl2(probe: () => boolean, timers: WaitTimers,
  probeMs = WEBGL_CRASH_BLOCK_PROBE_MS, maxMs = WEBGL_CRASH_BLOCK_WAIT_MS): Promise<WebGlWaitResult> {
  const start = timers.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      let ok = false;
      try { ok = probe(); } catch { ok = false; }
      const waitedMs = Math.max(0, timers.now() - start);
      if (ok) { resolve({ recovered: true, waitedMs }); return; }
      if (waitedMs + probeMs > maxMs) { resolve({ recovered: false, waitedMs }); return; }
      timers.setTimeout(tick, probeMs);
    };
    timers.setTimeout(tick, probeMs);
  });
}

export interface CapabilityGateDeps {
  /** Probe the browser (probeCapabilities). */
  probe(): CapabilityEnv;
  /** Every probe's result: render adaptation and the reporter's capability list. */
  probed(env: CapabilityEnv, problems: CapabilityProblem[]): void;
  /** Problems are about to be shown (console line, boot error report, boot stage). */
  showing(env: CapabilityEnv, problems: CapabilityProblem[]): void;
  /** showCapabilityScreen, with the wait's verdict when there is one. */
  show(problems: CapabilityProblem[], recovered?: Promise<boolean>): Promise<void>;
  /** One quiet WebGL 2 attempt (browserCanCreateWebGl2). */
  canCreateWebGl2(): boolean;
  timers: WaitTimers;
  /** The wait ended, recovered or not (telemetry). */
  waited(result: WebGlWaitResult): void;
}

/**
 * The boot's capability step: probe, and show the screen when something is wrong. Resolves with the
 * env the boot goes on with: at once when nothing is wrong, on Continue for soft problems, and after a
 * crash block lifted (probing again from the top, so a soft problem still asks; one wait per page).
 * Never resolves for any other hard problem: that screen's Reload is the way on.
 */
export async function runCapabilityGate(deps: CapabilityGateDeps): Promise<CapabilityEnv> {
  let waited = false;
  for (;;) {
    const env = deps.probe();
    const problems = capabilityProblems(env);
    deps.probed(env, problems);
    if (problems.length === 0) return env;
    deps.showing(env, problems);
    const wait = !waited && crashBlockWaitable(env, problems)
      ? waitForWebGl2(() => deps.canCreateWebGl2(), deps.timers) : null;
    if (wait) {
      waited = true;
      void wait.then((r) => { try { deps.waited(r); } catch { /* reporting must never throw */ } });
    }
    await deps.show(problems, wait?.then(r => r.recovered));
    if (!wait) return env;
  }
}

/** The real page's quiet WebGL 2 attempt. */
export function browserCanCreateWebGl2(doc: Document): boolean {
  return canCreateWebGl2(() => doc.createElement('canvas'));
}
