/**
 * Bridge counters + the HTTP ops endpoints (`GET /healthz`, `GET /metrics`),
 * served on the same port as the WebSocket server.
 *
 * Byte directions (all counted at the bridge):
 *   ws_in   browser → bridge (WebSocket payload bytes received)
 *   udp_out bridge → game server (datagram bytes sent)
 *   udp_in  game server → bridge (datagram bytes received from the target)
 *   ws_out  bridge → browser (WebSocket payload bytes sent)
 * Hosting egress ≈ udp_out + ws_out.
 */
import { CLIENT_ERROR_MAX_BODY } from './clientErrors.js';
import { CLIENT_PREWORLD_MAX_BODY } from './clientPreworld.js';
import type { IncomingMessage, ServerResponse } from 'http';

export type ByteDirection = 'ws_in' | 'udp_out' | 'udp_in' | 'ws_out';
export type DropReason = 'rate_limited' | 'backpressure' | 'foreign_udp' | 'spp_missing';

export class BridgeMetrics {
  readonly startedAt: number;
  connects = 0;
  sessionsClosed = 0;
  readonly rejects = new Map<string, number>();
  readonly bytes: Record<ByteDirection, number> = { ws_in: 0, udp_out: 0, udp_in: 0, ws_out: 0 };
  readonly drops: Record<DropReason, number> = { rate_limited: 0, backpressure: 0, foreign_udp: 0, spp_missing: 0 };
  readonly closes = new Map<string, number>();
  /** RELEASE.error-reporting — accepted client crash reports by kind. */
  readonly clientErrors = new Map<string, number>();

  constructor(now: () => number = Date.now) { this.startedAt = now(); }

  reject(reason: string): void { this.rejects.set(reason, (this.rejects.get(reason) ?? 0) + 1); }
  close(reason: string): void { this.sessionsClosed++; this.closes.set(reason, (this.closes.get(reason) ?? 0) + 1); }
  addBytes(dir: ByteDirection, n: number): void { this.bytes[dir] += n; }
  drop(reason: DropReason): void { this.drops[reason]++; }
  clientError(kind: string): void { this.clientErrors.set(kind, (this.clientErrors.get(kind) ?? 0) + 1); }
  /** RELEASE.preworld-outcomes — accepted pre-world outcome events by outcome. */
  readonly clientPreworld = new Map<string, number>();
  clientPreworldEvent(outcome: string): void { this.clientPreworld.set(outcome, (this.clientPreworld.get(outcome) ?? 0) + 1); }
}

export interface ServerSessionCount { id: string; name: string; sessions: number }

export interface BridgeSnapshot {
  mode: 'pinned' | 'multi';
  /** Pinned mode: the server's era profile (BRIDGE_ERA); null = end of retail. */
  era?: string | null;
  sessions: number;
  perServer: ServerSessionCount[];
  serversList: { source: string; servers: number; ageSeconds: number | null; lastError: string | null } | null;
  uptimeSeconds: number;
  /** Handing over to a new deployment: no new connections, open sessions continue. */
  draining?: boolean;
}

export function healthzBody(s: BridgeSnapshot): Record<string, unknown> {
  return {
    up: true,
    mode: s.mode,
    ...(s.era ? { era: s.era } : {}),
    sessions: s.sessions,
    perServer: Object.fromEntries(s.perServer.map(p => [p.id, { name: p.name, sessions: p.sessions }])),
    serversList: s.serversList,
    uptimeSeconds: s.uptimeSeconds,
    ...(s.draining ? { draining: true } : {}),
  };
}

function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Prometheus text exposition format (version 0.0.4). */
export function renderPrometheus(m: BridgeMetrics, s: BridgeSnapshot): string {
  const out: string[] = [];
  const metric = (name: string, type: 'counter' | 'gauge', help: string, rows: [Record<string, string>, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of rows) {
      const l = Object.entries(labels).map(([k, val]) => `${k}="${esc(val)}"`).join(',');
      out.push(`${name}${l ? `{${l}}` : ''} ${v}`);
    }
  };
  metric('acbridge_sessions_active', 'gauge', 'Open WebSocket sessions.', [[{}, s.sessions]]);
  metric('acbridge_server_sessions_active', 'gauge', 'Open sessions per target server.',
    s.perServer.map(p => [{ server: p.id, name: p.name }, p.sessions]));
  metric('acbridge_connects_total', 'counter', 'Accepted WebSocket sessions.', [[{}, m.connects]]);
  metric('acbridge_client_errors_total', 'counter', 'Crash reports accepted from web clients, by kind.',
    [...m.clientErrors].map(([kind, n]) => [{ kind }, n]));
  metric('acbridge_client_preworld_total', 'counter', 'Pre-world outcome events accepted from web clients, by outcome.',
    [...m.clientPreworld].map(([outcome, n]) => [{ outcome }, n]));
  metric('acbridge_sessions_closed_total', 'counter', 'Closed sessions by reason.',
    [...m.closes.entries()].map(([r, v]) => [{ reason: r }, v]));
  metric('acbridge_rejects_total', 'counter', 'Rejected connection attempts by reason.',
    [...m.rejects.entries()].map(([r, v]) => [{ reason: r }, v]));
  metric('acbridge_bytes_total', 'counter', 'Payload bytes by direction (ws_in browser->bridge, udp_out bridge->server, udp_in server->bridge, ws_out bridge->browser).',
    (Object.keys(m.bytes) as ByteDirection[]).map(d => [{ direction: d }, m.bytes[d]]));
  metric('acbridge_dropped_messages_total', 'counter', 'Messages/datagrams dropped by reason.',
    (Object.keys(m.drops) as DropReason[]).map(r => [{ reason: r }, m.drops[r]]));
  if (s.serversList) {
    metric('acbridge_servers_list_servers', 'gauge', 'Allowlisted servers.', [[{}, s.serversList.servers]]);
    if (s.serversList.ageSeconds !== null) {
      metric('acbridge_servers_list_age_seconds', 'gauge', 'Age of the loaded server list.', [[{}, s.serversList.ageSeconds]]);
    }
  }
  metric('acbridge_uptime_seconds', 'gauge', 'Seconds since start.', [[{}, s.uptimeSeconds]]);
  return out.join('\n') + '\n';
}

export function metricsJson(m: BridgeMetrics, s: BridgeSnapshot): Record<string, unknown> {
  return {
    ...healthzBody(s),
    connects: m.connects,
    sessionsClosed: Object.fromEntries(m.closes),
    rejects: Object.fromEntries(m.rejects),
    bytes: { ...m.bytes },
    drops: { ...m.drops },
    clientErrors: Object.fromEntries(m.clientErrors),
    clientPreworld: Object.fromEntries(m.clientPreworld),
  };
}

/**
 * The HTTP handler for non-upgrade requests: /healthz (always public — the
 * Railway health check; the launcher reads its `mode`), /servers (the
 * launcher's world list: ServerDirectory's body in multi mode, an empty
 * pinned list otherwise), /metrics (Prometheus text; `?format=json` for JSON;
 * guarded by `Authorization: Bearer <metricsToken>` when one is configured).
 * /healthz and /servers are public data and answer with CORS `*`, since the
 * web client is served from a different origin than the bridge.
 */
export function makeHttpHandler(
  metrics: BridgeMetrics,
  snapshot: () => BridgeSnapshot,
  opts: {
    metricsToken: string | null;
    servers?: (() => unknown) | null;
    /**
     * RELEASE.error-reporting — POST /client-errors: called with the parsed
     * JSON body and the request; returns the HTTP status to answer (204
     * accepted, 400 not a report, 429 rate-limited). Absent = 404.
     */
    clientErrors?: ((body: unknown, req: IncomingMessage) => number) | null;
    /** RELEASE.preworld-outcomes — POST /client-preworld, the same contract (clientPreworld.ts). */
    clientPreworld?: ((body: unknown, req: IncomingMessage) => number) | null;
  },
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://bridge.local');
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const cors = { 'access-control-allow-origin': '*' };
    // Small JSON reports from the web client: CORS-open POST, a size cap, the route's own verdict.
    const postRoute = (maxBody: number, handle: (body: unknown, req: IncomingMessage) => number): void => {
      const corsPost = { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' };
      if (req.method === 'OPTIONS') { res.writeHead(204, corsPost); res.end(); return; }
      if (req.method !== 'POST') return send(405, 'text/plain', 'method not allowed\n', corsPost);
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBody) { tooBig = true; return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return send(413, 'text/plain', 'too large\n', corsPost);
        let body: unknown = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
        const status = handle(body, req);
        res.writeHead(status, { 'cache-control': 'no-store', ...corsPost });
        res.end();
      });
    };
    if (url.pathname === '/client-errors' && opts.clientErrors) return postRoute(CLIENT_ERROR_MAX_BODY, opts.clientErrors);
    if (url.pathname === '/client-preworld' && opts.clientPreworld) return postRoute(CLIENT_PREWORLD_MAX_BODY, opts.clientPreworld);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'method not allowed\n');
    if (url.pathname === '/healthz') {
      return send(200, 'application/json', JSON.stringify(healthzBody(snapshot())), cors);
    }
    if (url.pathname === '/servers') {
      const body = opts.servers ? opts.servers() : { mode: snapshot().mode, updatedAt: null, servers: [] };
      return send(200, 'application/json', JSON.stringify(body), cors);
    }
    if (url.pathname === '/metrics') {
      if (opts.metricsToken && req.headers.authorization !== `Bearer ${opts.metricsToken}`) {
        return send(401, 'text/plain', 'unauthorized\n');
      }
      if (url.searchParams.get('format') === 'json') {
        return send(200, 'application/json', JSON.stringify(metricsJson(metrics, snapshot())));
      }
      return send(200, 'text/plain; version=0.0.4', renderPrometheus(metrics, snapshot()));
    }
    if (url.pathname === '/' || url.pathname === '/connect') {
      return send(426, 'text/plain', 'WebSocket upgrade required\n');
    }
    return send(404, 'text/plain', 'not found\n');
  };
}
