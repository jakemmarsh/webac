/**
 * DEBT.acdebug-production-coupling — whether the `window.acDebug` console
 * helper (~2k lines of admin / probe / seeding tools) is installed.
 *
 * On in the Vite dev server (`import.meta.env.DEV`), which is what every
 * tools/ probe and capture harness drives (localhost:3000 — no tool runs
 * against a production bundle), and on any page whose URL carries a
 * `debug` query parameter (`?debug` / `&debug` / `debug=1`), so a
 * production build can still be inspected on demand. Off otherwise:
 * production features never route through acDebug (network/GameActions.ts
 * is the send path), so a production page without `debug` loses nothing.
 */
export function debugToolsEnabled(isDev: boolean, search: string): boolean {
  if (isDev) return true;
  return new URLSearchParams(search).has('debug');
}

/**
 * VISUAL.town-scenery-gaps — the deg_mul a harness session pins the Adaptive
 * Degrade controller to (DegMulController.pin), or null for retail's
 * framerate-driven CalcDegLevel.
 *
 * Only with the debug tools on (the dev server every tools/ harness drives,
 * or `?debug`); a production page always runs the real controller.
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
