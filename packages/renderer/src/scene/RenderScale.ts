/**
 * PERF.render-adapt — how the 3D drawing buffer adapts to the machine.
 *
 * Production first-minute telemetry (2026-10-14) showed a regular on
 * software WebGL (hardware acceleration off or the GPU blocklisted:
 * SwiftShader, llvmpipe, "Microsoft Basic Render Driver") at ~12 FPS (80 ms
 * median frame) on a 2500×1200 canvas. Some players have no usable GPU at
 * all, so the client never asks them to change settings; it adapts:
 *
 *  - every browser: dynamic resolution (scene/DynamicResolution.ts) scales
 *    the world's WebGL buffer between a floor and full size from measured
 *    frame times; the canvas keeps its CSS size and the DOM UI/HUD is not in
 *    that buffer, so it stays crisp. A healthy GPU stays at full size.
 *  - software rendering: the world context is created without MSAA, the
 *    buffer STARTS at about 1280×720's pixel count, and portal space's
 *    context is capped the same way.
 *
 * Since 2026-11-15 (PERF.render-adapt-cpu-bound, a Reddit "blurry on my old
 * Mac" report) the controller also reads each frame's CPU work: frames the CPU
 * sets step draw distance before resolution and probe the resolution back up,
 * a fast machine jumps back to full instead of climbing 12 % per step, and a
 * hardware GPU's floor is 0.75 of the CSS resolution (software keeps 0.5).
 *
 * Browser UX (CLAUDE.md: rendering resolution adapts to the browser
 * environment); nothing retail changes.
 *
 * Automation (Playwright: the capture and agent tools, navigator.webdriver)
 * runs on SwiftShader on purpose and its pixel captures assume today's full
 * buffer, so all of this stays off there unless `?renderAdapt=1` forces it (a
 * harmless param: it changes only the buffer). `?renderAdapt=0` turns it off
 * for anyone.
 */

/** About 1280×720 of drawn pixels: where a software-rendered buffer starts. */
export const SOFTWARE_START_BUFFER_PIXELS = 1280 * 720;

/** The lowest effective pixel ratio dynamic resolution goes to with software rendering (half the CSS resolution). */
export const MIN_RENDER_PIXEL_RATIO = 0.5;

/**
 * PERF.render-adapt-cpu-bound — the floor on a hardware GPU: three quarters of
 * the CSS resolution (56 % of the pixels). Prod first-minute 2026-11-15: every
 * hardware session at the 0.5 floor that week was not pixel-bound (an Intel
 * HD 5000 at dpr 1 drew its render phase in 17.4 ms at half size against 13 ms
 * at full size elsewhere, 28 of its 33 ms frame CPU work; RTX 4070 / 5080 and
 * Apple GPUs at 8–16 ms frames), so going below this only blurred. Software
 * rendering (SwiftShader ~12 FPS at 2500×1200, 2026-10-14) is truly fill-bound
 * and keeps MIN_RENDER_PIXEL_RATIO.
 */
export const HARDWARE_MIN_RENDER_PIXEL_RATIO = 0.75;

/** Dynamic resolution's floor for this device (never above the device ratio itself). */
export function minRenderPixelRatio(dpr: number, software: boolean): number {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.min(d, software ? MIN_RENDER_PIXEL_RATIO : HARDWARE_MIN_RENDER_PIXEL_RATIO);
}

/**
 * The pixel ratio for a canvas of `cssW`×`cssH` CSS px. Without the cap it is
 * `dpr` unchanged; with it, the largest ratio (never above `dpr`) whose buffer
 * holds at most SOFTWARE_START_BUFFER_PIXELS.
 */
export function renderPixelRatio(dpr: number, cssW: number, cssH: number, softwareCap: boolean): number {
  if (!softwareCap) return dpr;
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const area = Math.max(1, cssW) * Math.max(1, cssH);
  return Math.min(d, Math.sqrt(SOFTWARE_START_BUFFER_PIXELS / area));
}

export interface RenderAdaptInputs {
  /** classifyGpu(unmaskedRenderer(gl)) === 'software' (boot/Capability.ts probe). */
  software: boolean;
  /** navigator.webdriver: an automated browser (the repo's tools). */
  webdriver: boolean;
  /** `?renderAdapt=` from the page URL ('1' forces on, '0' forces off), or null. */
  override: string | null;
}

export interface RenderAdaptConfig {
  /** Dynamic resolution runs. */
  dynamic: boolean;
  /** Software rendering under adaptation: no MSAA, start at ~720p, cap portal space. */
  software: boolean;
}

/** What applies for this page. Off entirely under automation unless forced. */
export function renderAdaptConfigFor(i: RenderAdaptInputs): RenderAdaptConfig {
  const on = i.override === '1' ? true : i.override === '0' ? false : !i.webdriver;
  return { dynamic: on, software: on && i.software };
}

const OFF: RenderAdaptConfig = { dynamic: false, software: false };
let config: RenderAdaptConfig = OFF;

/** Set once at boot (main.ts, from the capability probe), before any renderer exists. */
export function setRenderAdaptConfig(c: RenderAdaptConfig): void { config = { ...c }; }

export function renderAdaptConfig(): RenderAdaptConfig { return config; }

/** The world / portal-space contexts are created with MSAA (WebGLRenderer `antialias`). */
export function contextAntialias(c: RenderAdaptConfig = config): boolean { return !c.software; }
