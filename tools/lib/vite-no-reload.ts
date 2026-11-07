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
 * What a no-reload dev server serves as /@vite/client (the live gate's first run, 2026-11-07).
 *
 * `server.ws: false` leaves Vite 6 injecting /@vite/client anyway, and the client still opens
 * ws://<host>/?token=…, which the HTTP server answers 200: two "WebSocket connection … failed: Unexpected
 * response code: 200" console errors and "[vite] failed to connect to websocket" on every page load. The
 * play-through counts console errors as problems, so every era's enter-world failed with the character in
 * the world. Serving this module in place of the real client removes the socket and its reload logic
 * altogether. It keeps what dev modules import from the client: CSS modules call updateStyle /
 * removeStyle (the same <style data-vite-dev-id> handling as Vite's), modules with import.meta.hot call
 * createHotContext (inert: nothing is ever hot-updated), and injectQuery is Vite's own.
 */
export const NO_RELOAD_CLIENT_SOURCE = `// acjs no-reload /@vite/client stand-in (tools/lib/vite-no-reload.ts): no socket, no reloads.
const sheets = new Map();
let lastInserted;
export function updateStyle(id, content) {
  let style = sheets.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    if (!lastInserted) { document.head.appendChild(style); setTimeout(() => { lastInserted = undefined; }, 0); }
    else lastInserted.insertAdjacentElement('afterend', style);
    lastInserted = style;
  } else style.textContent = content;
  sheets.set(id, style);
}
export function removeStyle(id) {
  const style = sheets.get(id);
  if (style) { document.head.removeChild(style); sheets.delete(id); }
}
export function createHotContext() {
  const noop = () => {};
  return { data: {}, accept: noop, acceptExports: noop, dispose: noop, prune: noop, decline: noop, invalidate: noop, on: noop, off: noop, send: noop };
}
export function injectQuery(url, queryToInject) {
  if (url[0] !== '.' && url[0] !== '/') return url;
  const pathname = url.replace(/[?#].*$/, '');
  const { search, hash } = new URL(url, 'http://vite.dev');
  return pathname + '?' + queryToInject + (search ? '&' + search.slice(1) : '') + (hash || '');
}
export class ErrorOverlay extends (globalThis.HTMLElement || class {}) {}
`;

/** Whether a request is for Vite's client module (any query string). */
export const isViteClientRequest = (url: string | undefined): boolean => (url ?? '').split(/[?#]/)[0] === '/@vite/client';

interface MiddlewareHost { middlewares: { use(fn: (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(body: string): void }, next: () => void) => void): void } }

/**
 * The Vite plugin that serves {@link NO_RELOAD_CLIENT_SOURCE} as /@vite/client, ahead of Vite's own
 * middlewares; nothing unless {@link NO_RELOAD_ENV} is 1. vite.config.ts adds it.
 */
export function noReloadClientPlugin(env: Record<string, string | undefined> = process.env): { name: string; apply: 'serve'; configureServer(server: MiddlewareHost): void } | null {
  if (env[NO_RELOAD_ENV] !== '1') return null;
  return {
    name: 'acjs-no-reload-client',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!isViteClientRequest(req.url)) { next(); return; }
        res.setHeader('Content-Type', 'text/javascript');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(NO_RELOAD_CLIENT_SOURCE);
      });
    },
  };
}

/**
 * The config the agent daemon writes beside a snapshot's vite.config.ts (tree-<sha>/vite.agent.config.mjs):
 * that config with HMR and Vite's WebSocket off and the client stand-in served. It wraps the snapshot's
 * own config, so it works for a snapshot whose vite.config.ts predates {@link NO_RELOAD_ENV}.
 */
export const AGENT_VITE_CONFIG_SOURCE =
  "import base from './vite.config.ts';\n" +
  `const CLIENT = ${JSON.stringify(NO_RELOAD_CLIENT_SOURCE)};\n` +
  "const client = { name: 'acjs-no-reload-client', apply: 'serve', configureServer(s) { s.middlewares.use((req, res, next) => {\n" +
  "  if ((req.url || '').split(/[?#]/)[0] !== '/@vite/client') return next();\n" +
  "  res.setHeader('Content-Type', 'text/javascript'); res.setHeader('Cache-Control', 'no-cache'); res.end(CLIENT); }); } };\n" +
  'export default async (env) => { const c = typeof base === \'function\' ? await base(env) : base; ' +
  "const plugins = (c.plugins ?? []).flat().filter((p) => !(p && p.name === 'acjs-no-reload-client')); " +
  'return { ...c, plugins: [...plugins, client], server: { ...(c.server ?? {}), hmr: false, ws: false } }; };\n';
