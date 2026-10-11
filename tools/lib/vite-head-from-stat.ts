/**
 * Dev server: answer HEAD for a public-dir file (the DATs) from stat
 * (OPS.vite-head-dat-stall, 2026-10-11).
 *
 * Vite serves publicDir through sirv, whose send() pipes
 * fs.createReadStream(file) into the response for HEAD too. Node drops the
 * body, but the whole file is still read: 2.2 s for the 926 MB portal DAT,
 * and the dev server answers nothing else meanwhile, so every dev launch's
 * DAT interrogation (fetchHeadMeta / headLooksLikeDat) stalled the patch
 * start. Production static hosting answers HEAD from stat already.
 *
 * The answer carries the headers sirv's dev mode sends (viaLocal + toHeaders:
 * Content-Length, Content-Type, Last-Modified, weak ETag, Cache-Control
 * no-cache, 304 on a matching If-None-Match) plus server.headers. The
 * middleware sits directly before viteServePublicMiddleware, so Vite's CORS,
 * host-check and base middlewares have already run, as they do for sirv.
 */
import { statSync, type Stats } from 'fs';
import { extname, join, normalize, sep } from 'path';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'http';
import type { Plugin, ViteDevServer } from 'vite';

type Next = (err?: unknown) => void;
export type HeadMiddleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

/** sirv's types (mrmime) for the files a dev public dir holds; anything else is '' as for a .dat. */
const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

/** The file under `dir` a request path names, or null (query, internal URL, traversal, not a file). */
export function resolvePublicFile(dir: string, url: string | undefined): { abs: string; stats: Stats } | null {
  if (!url || url.includes('?') || url.startsWith('/@')) return null;
  let pathname = url.split('#')[0];
  if (pathname.includes('%')) {
    try { pathname = decodeURI(pathname); } catch { return null; }
  }
  const root = dir.endsWith(sep) ? dir : dir + sep;
  const abs = normalize(join(root, pathname));
  if (!abs.startsWith(root)) return null;
  try {
    const stats = statSync(abs);
    return stats.isFile() ? { abs, stats } : null;
  } catch {
    return null;
  }
}

/** The headers sirv's dev mode sends for this file (toHeaders + viaLocal). */
export function statHeaders(abs: string, stats: Stats): Record<string, string | number> {
  return {
    'Content-Length': stats.size,
    'Content-Type': CONTENT_TYPES[extname(abs).toLowerCase()] ?? '',
    'Last-Modified': stats.mtime.toUTCString(),
    'ETag': `W/"${stats.size}-${stats.mtime.getTime()}"`,
    'Cache-Control': 'no-cache',
  };
}

export function headFromStatMiddleware(
  dir: string,
  extraHeaders: () => OutgoingHttpHeaders | undefined = () => undefined,
): HeadMiddleware {
  return (req, res, next) => {
    if (req.method !== 'HEAD') return next();
    const file = resolvePublicFile(dir, req.url);
    if (!file) return next();
    const headers = statHeaders(file.abs, file.stats);
    if (req.headers['if-none-match'] === headers['ETag']) {
      res.writeHead(304);
      res.end();
      return;
    }
    const extra = extraHeaders();
    if (extra) {
      for (const name in extra) {
        const value = extra[name];
        if (value !== undefined) res.setHeader(name, value);
      }
    }
    for (const name in headers) {
      const set = res.getHeader(name);
      if (set !== undefined) headers[name] = set as string | number;
    }
    res.writeHead(200, headers);
    res.end();
  };
}

/** Insert `handle` just before Vite's public-dir middleware (or first, if Vite renames it). */
export function insertBeforePublic(server: Pick<ViteDevServer, 'middlewares'>, handle: HeadMiddleware): void {
  const stack = (server.middlewares as unknown as { stack: { route: string; handle: unknown }[] }).stack;
  const at = stack.findIndex((layer) => (layer.handle as { name?: string })?.name === 'viteServePublicMiddleware');
  stack.splice(at < 0 ? 0 : at, 0, { route: '', handle });
}

export function headFromStatPlugin(): Plugin {
  return {
    name: 'acjs-head-from-stat',
    apply: 'serve',
    configureServer(server) {
      const dir = server.config.publicDir;
      if (!dir) return;
      // Returned hook = runs after Vite has installed its own middlewares.
      return () => insertBeforePublic(server, headFromStatMiddleware(dir, () => server.config.server.headers));
    },
  };
}
