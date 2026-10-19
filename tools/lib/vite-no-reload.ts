/**
 * A dev server whose pages must never reload themselves: the agent daemon's game pages (a live stream's
 * players), and the headless pages of the GPU worker and the screen regression.
 *
 * `server.hmr: false` alone does not do it. Vite 6 still runs its WebSocket server and still injects
 * /@vite/client, whose socket, when it closes for any reason, pings the server and calls
 * `location.reload()` the moment the ping answers (client.mjs, "server connection lost. Polling for
 * restart..."). Closing a Mac's lid on AC power puts it into DarkWake ("Clamshell Sleep") while caffeinate
 * keeps it running, and Chrome answers the sleep notice by closing every TCP socket it holds: the game's
 * WebSocket (which the client resumes on its own) and Vite's (which reloaded the page 30-80 ms later).
 * On 2026-10-18 that broke both stream players' sessions four times in 21 minutes (23:16:43Z, 23:23:31Z,
 * 23:35:27Z, 23:37:57Z, each at a pmset "Entering DarkWake state due to 'Clamshell Sleep'"): the routine
 * stopped, the fellowship broke, the agent API went away. `server.ws: false` removes Vite's socket, so
 * nothing in the page reloads it; a dropped game socket goes through the client's own resume.
 */

/** Set to 1 in a dev server's environment to turn off HMR and Vite's WebSocket (vite.config.ts reads it). */
export const NO_RELOAD_ENV = 'ACJS_VITE_NO_RELOAD';

/** The `server` options vite.config.ts adds for {@link NO_RELOAD_ENV}: none unless it is 1. */
export function noReloadServerOptions(env: Record<string, string | undefined> = process.env): { hmr?: false; ws?: false } {
  return env[NO_RELOAD_ENV] === '1' ? { hmr: false, ws: false } : {};
}

/**
 * The config the agent daemon writes beside a snapshot's vite.config.ts (tree-<sha>/vite.agent.config.mjs):
 * that config with HMR and Vite's WebSocket off. It wraps the snapshot's own config, so it works for a
 * snapshot whose vite.config.ts predates {@link NO_RELOAD_ENV}.
 */
export const AGENT_VITE_CONFIG_SOURCE =
  "import base from './vite.config.ts';\n" +
  'export default async (env) => { const c = typeof base === \'function\' ? await base(env) : base; ' +
  'return { ...c, server: { ...(c.server ?? {}), hmr: false, ws: false } }; };\n';
