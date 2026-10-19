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
import { probeWebGl2, detectHelpPlatform, webgl2HelpText, type WebGlFailure, type HelpPlatform } from './WebGlDiagnosis.js';
import { renderAdaptConfigFor, type RenderAdaptConfig } from '../scene/RenderScale.js';
import { showBootNotice } from './BootNotice.js';

export interface CapabilityProblem {
  id: 'webgl2' | 'websocket' | 'memory' | 'pointer';
  hard: boolean;
  text: string;
}

export interface CapabilityEnv {
  /** A WebGL 2 context can be created. */
  webgl2: boolean;
  websocket: boolean;
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
 * browser) the text names.
 */
export function showCapabilityScreen(doc: Document, problems: CapabilityProblem[], reload: () => void = () => doc.defaultView?.location.reload()): Promise<void> {
  const hard = problems.some(p => p.hard);
  const paragraphs = problems.map(p => ({ text: p.text, className: `capability-problem capability-${p.id}` }));
  const title = hard ? 'This browser can\'t run the game' : 'Before you continue';
  if (hard) {
    showBootNotice(doc, {
      id: 'capability-screen', title, paragraphs,
      buttons: [{ label: 'Reload', className: 'capability-reload', onClick: reload }],
    });
    return new Promise(() => {});
  }
  return new Promise((resolve) => {
    const notice = showBootNotice(doc, {
      id: 'capability-screen', title, paragraphs,
      buttons: [{ label: 'Continue anyway', className: 'capability-continue', onClick: () => { notice.close(); resolve(); } }],
    });
  });
}
