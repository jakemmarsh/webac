/**
 * RELEASE.remove-test-defaults — which login parameters the page URL may
 * carry.
 *
 * The test / probe tooling (tools/lib/game-session.ts) logs in straight from
 * the URL: `?ace&bridge=…&account=…&password=…&autoenter=…`. That stays
 * working where the tooling runs: where URL overrides are enabled (the Vite
 * dev server, or a VITE_ACJS_URL_OVERRIDES=1 build; config/urlOverrides.ts).
 * A deployed page never reads `?password=` (a credential in a URL ends up in
 * history, logs and referrers; a link would log the player into someone
 * else's account), not even with `?debug`, which any link can carry, and
 * never falls back to the old testacjs default. `?account=` only pre-fills
 * the launcher's field.
 */

export interface UrlLogin {
  /** Log in immediately with these credentials (dev / debug only). */
  autoLogin: { account: string; password: string } | null;
  /** Pre-fill for the launcher's Account field. */
  prefillAccount: string | null;
  /** `?server=<id>` for an auto-login through a multi-mode bridge. */
  server: string | null;
}

/** The dev-tooling default password when `?account=` comes without `?password=`. */
const DEV_DEFAULT_PASSWORD = 'testacjs';

/** `overridesEnabled`: urlOverridesEnabled() (config/urlOverrides.ts). */
export function resolveUrlLogin(search: string, overridesEnabled: boolean): UrlLogin {
  const p = new URLSearchParams(search);
  const account = p.get('account')?.trim() || null;
  const server = p.get('server')?.trim() || null;
  if (overridesEnabled && account) {
    return { autoLogin: { account, password: p.get('password') ?? DEV_DEFAULT_PASSWORD }, prefillAccount: account, server };
  }
  return { autoLogin: null, prefillAccount: account, server: null };
}
