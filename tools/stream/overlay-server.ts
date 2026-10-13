/**
 * Stream overlay server: serves tools/stream/overlay/ (an OBS browser source) and streams the
 * supervisor's JSONL event feed to it over Server-Sent Events. Local only; no external network calls.
 *
 *   npx tsx tools/stream/overlay-server.ts                 # tail $TMPDIR/acjs-agent/stream/feed.jsonl
 *   npx tsx tools/stream/overlay-server.ts --demo          # loop tools/stream/sample-feed.jsonl
 *   options: --port 7311 --host 127.0.0.1 --feed <path> --replay 300 --demo [file] --speed 1
 *
 * Then point OBS at http://localhost:7311/ (1920x1080). http://localhost:7311/?layout shows the
 * two game-capture rectangles to line the window captures up with.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import ts from 'typescript';
import { defaultFeedPath, type FeedEvent } from './feed-types.ts';
import { FeedTailer, ReplayBuffer, feedFrame, formatSse, parseFeedLine, parseLastEventId } from './feed-tail.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OVERLAY_DIR = join(HERE, 'overlay');
export const SAMPLE_FEED = join(HERE, 'sample-feed.jsonl');

export interface OverlayServerOptions {
  port: number;
  host?: string;
  /** JSONL feed to tail (ignored in demo mode). */
  feedPath?: string;
  /** Events replayed to a newly connected page. */
  replay?: number;
  /** Demo mode: loop this JSONL file instead of tailing the feed. */
  demoFile?: string;
  /** Demo playback speed multiplier. */
  demoSpeed?: number;
  pollMs?: number;
  heartbeatMs?: number;
  log?: (msg: string) => void;
}

export interface OverlayServer {
  server: Server;
  port: number;
  url: string;
  runId: string;
  buffer: ReplayBuffer;
  /** Inject an event as if it came from the feed. */
  push(ev: FeedEvent): void;
  close(): Promise<void>;
}

/** Static files the page needs; .ts entries are transpiled to JS on request. Nothing else is served. */
const STATIC: Record<string, { file: string; type: string; transpile?: boolean }> = {
  '/': { file: join(OVERLAY_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/index.html': { file: join(OVERLAY_DIR, 'index.html'), type: 'text/html; charset=utf-8' },
  '/overlay.css': { file: join(OVERLAY_DIR, 'overlay.css'), type: 'text/css; charset=utf-8' },
  '/app.ts': { file: join(OVERLAY_DIR, 'app.ts'), type: 'text/javascript; charset=utf-8', transpile: true },
  '/model.ts': { file: join(OVERLAY_DIR, 'model.ts'), type: 'text/javascript; charset=utf-8', transpile: true },
};

const transpileCache = new Map<string, { mtimeMs: number; js: string }>();

/** TS → browser JS (type-only imports erased; `./model.ts` specifiers kept, the server serves them). */
export function transpileForBrowser(source: string, fileName = 'module.ts'): string {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false,
      isolatedModules: true, sourceMap: false, inlineSourceMap: false,
    },
  }).outputText;
}

function readStatic(entry: { file: string; transpile?: boolean }): string {
  if (!entry.transpile) return readFileSync(entry.file, 'utf8');
  const mtimeMs = statSync(entry.file).mtimeMs;
  const hit = transpileCache.get(entry.file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.js;
  const js = transpileForBrowser(readFileSync(entry.file, 'utf8'), entry.file);
  transpileCache.set(entry.file, { mtimeMs, js });
  return js;
}

/** Load a JSONL file into events (bad lines skipped). */
export function loadFeedFile(path: string): FeedEvent[] {
  return readFileSync(path, 'utf8').split('\n').map(parseFeedLine).filter((e): e is FeedEvent => e !== null);
}

/** Delay before replaying event i+1 in demo mode, from the recorded gap, clamped so the loop stays lively. */
export function demoDelay(prev: FeedEvent, next: FeedEvent, speed = 1): number {
  const gap = (next.t - prev.t) / (speed > 0 ? speed : 1);
  return Math.min(6000, Math.max(250, Number.isFinite(gap) ? gap : 1000));
}

export async function startOverlayServer(opts: OverlayServerOptions): Promise<OverlayServer> {
  const log = opts.log ?? ((m: string) => console.log(`[overlay] ${m}`));
  const runId = randomBytes(4).toString('hex');
  const buffer = new ReplayBuffer(Math.max(1, opts.replay ?? 300));
  const clients = new Set<ServerResponse>();
  const timers: ReturnType<typeof setTimeout>[] = [];

  const push = (ev: FeedEvent): void => {
    const item = buffer.push(ev);
    const frame = feedFrame(item, runId);
    for (const res of clients) res.write(frame);
  };

  const handleEvents = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const header = (req.headers['last-event-id'] as string | undefined) ?? url.searchParams.get('lastEventId');
    const lastSeq = parseLastEventId(header, runId);
    const catchUp = lastSeq === null ? null : buffer.since(lastSeq);
    let out = formatSse({ retry: 2000 });
    if (catchUp === null) {
      out += formatSse({ event: 'reset', data: JSON.stringify({ runId }) });
      for (const item of buffer.last()) out += feedFrame(item, runId);
    } else {
      for (const item of catchUp) out += feedFrame(item, runId);
    }
    res.write(out);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (url.pathname === '/events') { handleEvents(req, res, url); return; }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ok: true, runId, events: buffer.lastSeq, clients: clients.size, demo: !!opts.demoFile }));
      return;
    }
    const entry = STATIC[url.pathname];
    if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    try {
      const body = readStatic(entry);
      res.writeHead(200, { 'Content-Type': entry.type, 'Cache-Control': 'no-store' }).end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(e));
    }
  });

  const heartbeat = setInterval(() => { for (const res of clients) res.write(formatSse({ comment: 'ping' })); }, opts.heartbeatMs ?? 15000);

  let tailer: FeedTailer | null = null;
  if (opts.demoFile) {
    const events = loadFeedFile(opts.demoFile);
    if (!events.length) throw new Error(`demo feed ${opts.demoFile} has no valid events`);
    const speed = opts.demoSpeed ?? 1;
    let i = 0;
    const step = (): void => {
      const ev = events[i];
      push({ ...ev, t: Date.now() } as FeedEvent);
      const next = (i + 1) % events.length;
      const delay = next === 0 ? 4000 : demoDelay(ev, events[next], speed);
      i = next;
      timers[0] = setTimeout(step, delay);
    };
    timers[0] = setTimeout(step, 300);
    log(`demo: looping ${events.length} events from ${opts.demoFile} (speed ${speed})`);
  } else {
    const feedPath = opts.feedPath ?? defaultFeedPath();
    tailer = new FeedTailer(feedPath, { onEvent: push, onRotate: () => log(`feed rotated: ${feedPath}`) });
    tailer.start(opts.pollMs ?? 250);
    log(`tailing ${feedPath}`);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  const url = `http://${opts.host && opts.host !== '0.0.0.0' ? opts.host : 'localhost'}:${port}/`;

  return {
    server, port, url, runId, buffer, push,
    close: () => new Promise<void>((resolve) => {
      clearInterval(heartbeat);
      for (const t of timers) clearTimeout(t);
      tailer?.stop();
      for (const res of clients) res.end();
      clients.clear();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

export function parseArgs(argv: string[]): OverlayServerOptions {
  const opts: OverlayServerOptions = { port: 7311 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--port') opts.port = Number(val());
    else if (a === '--host') opts.host = val();
    else if (a === '--feed') opts.feedPath = val();
    else if (a === '--replay') opts.replay = Number(val());
    else if (a === '--speed') opts.demoSpeed = Number(val());
    else if (a === '--demo') opts.demoFile = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : SAMPLE_FEED;
    else if (a === '--help' || a === '-h') {
      console.log('usage: npx tsx tools/stream/overlay-server.ts [--port 7311] [--host 127.0.0.1] [--feed path] [--replay 300] [--demo [file]] [--speed 1]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) throw new Error(`bad --port ${opts.port}`);
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = parseArgs(process.argv.slice(2));
  startOverlayServer(opts).then((s) => {
    console.log(`[overlay] ${s.url}  (layout guides: ${s.url}?layout)`);
    const stop = (): void => { void s.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((e) => { console.error(`[overlay] ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
