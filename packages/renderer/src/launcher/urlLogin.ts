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

/**
 * `?world=<id or name>`: a shareable link that preselects a world in the
 * launcher's list (playwebac.com/?world=Coldeve), as a click on its row
 * would. A browser-UX addition (docs/release-plan.md, "Login form"). Unlike
 * the login parameters above it is honoured on deployed builds, because it
 * carries no credential: it never logs in, never fills the Account or
 * Password field, and an unknown or incompatible world changes nothing.
 */
export function resolveUrlWorld(search: string): string | null {
  return new URLSearchParams(search).get('world')?.trim() || null;
}

/**
 * The directory world `query` names: an exact Servers.xml id first, then a
 * case-insensitive name. null when none matches or the match is
 * `incompatible` (nobody can play there from webAC).
 */
export function matchUrlWorld<W extends { id: string | null; name: string; compat: string }>(worlds: readonly W[], query: string | null): W | null {
  const q = query?.trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  const w = worlds.find((x) => x.id !== null && x.id === q) ?? worlds.find((x) => x.name.trim().toLowerCase() === lower) ?? null;
  return w && w.compat !== 'incompatible' ? w : null;
}

/**
 * `href` without its `world` parameter. The link is consumed once: a later
 * launcher (after a logout, or the era reload an ENTER can trigger) keeps the
 * player's own choice instead of jumping back to the linked world.
 */
export function withoutUrlWorld(href: string): string {
  try {
    const u = new URL(href);
    if (!u.searchParams.has('world')) return href;
    u.searchParams.delete('world');
    return u.toString();
  } catch {
    return href;
  }
}
