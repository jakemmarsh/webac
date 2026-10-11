/**
 * SEC.url-overrides — whether the page URL may redirect the client's
 * connection or data, or log it in.
 *
 * `?bridge=` (where the password goes), `?datSet=` / `?eraDatSet=` (whose
 * bytes draw every string and texture) and URL login (`?account=` +
 * `?password=`, `?server=`, `?autoenter=`) are tooling conveniences. On a
 * public page they hand whoever writes a link a way to send the player's
 * login to their own bridge, or to draw a fake screen on our origin. The
 * deployed CSP blocks the bridge case today, but a fork hosted without it
 * would not, so they are honored only where the tooling runs:
 *
 *   - the Vite dev server (`import.meta.env.DEV`), which every probe and
 *     capture harness drives;
 *   - a build made with `VITE_ACJS_URL_OVERRIDES=1` (a local
 *     `vite build && vite preview` for production-shaped probes). The
 *     deployed image never sets it.
 *
 * `?debug` does NOT open them: anyone writing a link can add it. It is
 * itself gated here: acDebug and the debug hooks install only in dev, or with
 * `?debug` on a URL-overrides build (utils/debugTools.ts; Jake, 2026-10-11).
 * Harmless params (`?era`, `?rawDats`, `?nocache`, `?networker=0`, and
 * `?account=` as a launcher pre-fill) work everywhere.
 */

/** The build env fields the gate reads (import.meta.env's shape). */
export interface UrlOverrideEnv {
  DEV?: boolean;
  VITE_ACJS_URL_OVERRIDES?: string;
}

export function urlOverridesEnabled(env: UrlOverrideEnv = import.meta.env ?? {}): boolean {
  return env.DEV === true || env.VITE_ACJS_URL_OVERRIDES === '1';
}
