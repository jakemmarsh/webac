import { urlOverridesEnabled } from '../config/urlOverrides.js';

/**
 * DEBT.acdebug-production-coupling — whether the `window.acDebug` console
 * helper (~2k lines of admin / probe / seeding tools) and the `window.__*`
 * debug hooks (utils/debugGlobals.ts) are installed.
 *
 * On in the Vite dev server (`import.meta.env.DEV`), which every tools/
 * probe and capture harness drives. In any other build only with `?debug`
 * AND where URL overrides are enabled (`VITE_ACJS_URL_OVERRIDES=1`, a local
 * production-shaped `vite build && vite preview`; config/urlOverrides.ts).
 * The deployed page never installs them (Jake, 2026-10-11: dev only): the
 * hooks expose the raw connection and message builders (`__aceConnection`,
 * `__buildCharacterCreate`, …), a packet-level scripting API around the
 * automation allowlist, and anyone writing a link can add `?debug`.
 * Production features never route through acDebug (network/GameActions.ts
 * is the send path), so a production page loses nothing.
 */
export function debugToolsEnabled(isDev: boolean, search: string, overridesBuild: boolean = isDev): boolean {
  if (isDev) return true;
  return overridesBuild && new URLSearchParams(search).has('debug');
}

/**
 * VISUAL.town-scenery-gaps — the deg_mul a harness session pins the Adaptive
 * Degrade controller to (DegMulController.pin), or null for retail's
 * framerate-driven CalcDegLevel.
 *
 * Only with the debug tools on (the dev server every tools/ harness drives,
 * or `?debug` on a URL-overrides build); a deployed page always runs the real controller.
 * `degmul=<n>` pins n (clamped to −1..1), `degmul=auto` keeps the real
 * controller; with neither, a SwiftShader renderer pins 1. Retail ships
 * Automatic Degrades on and settles at deg_mul 1 above 25 fps, while
 * SwiftShader renders ~2 fps and would sink to −1 — so cloud captures show
 * the real-GPU steady state instead of a frame-rate accident.
 */
export function harnessDegMulPin(debugEnabled: boolean, search: string, rendererName: string): number | null {
  if (!debugEnabled) return null;
  const raw = new URLSearchParams(search).get('degmul');
  if (raw !== null) {
    if (raw === 'auto') return null;
    const v = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(v)) return Math.max(-1, Math.min(1, v));
  }
  return /swiftshader/i.test(rendererName) ? 1 : null;
}

/** debugToolsEnabled for this page: the build's own env (import.meta.env) and location. */
export function pageDebugToolsEnabled(search: string): boolean {
  return debugToolsEnabled(import.meta.env?.DEV === true, search, urlOverridesEnabled());
}
