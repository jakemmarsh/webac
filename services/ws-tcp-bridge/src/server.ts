/**
 * createBridgeServer: the WS↔UDP bridge as a module (bridge.ts is the CLI
 * entry). One HTTP server carries the WebSocket upgrades plus /healthz and
 * /metrics. Each WebSocket session owns one UDP socket, so the game server
 * tells sessions apart by source port.
 *
 * Port routing (ACE + GDLE): ConnectResponse (flag 0x00080000) → the world
 * port (base + 1); every other client packet → the base port, where the
 * server routes it by header Id. Replies are accepted from the target's IP
 * on either port (GDLE sends everything from the base port; ACE from both).
 *
 * Each session has a wire protocol (protocol.ts). End of retail is the
 * default and takes the routing above. A 1999 session (its server's era is a
 * 1999 era, or `?proto=ac1999`) uses the one base port both ways, takes its
 * id from the server's connect grant, and closes with a 1999 Disconnect.
 *
 * Modes (BridgeConfig.mode):
 *   pinned  one fixed target (CLI args, BRIDGE_TARGET, or 127.0.0.1:9000);
 *           any path, ?server ignored. Local dev and operator-run bridges.
 *   multi   `?server=<id>` picks a server from the allowlist (ServerRegistry);
 *           the host is resolved at connect time and must be a public IPv4
 *           address. A connection without ?server is a probe-only session
 *           (answers the text "health" message, forwards nothing).
 *
 * Admission, in order (rejections answer the upgrade with an HTTP status and
 * count in /metrics rejects{reason}): origin → global cap → per-IP new
 * connection rate → per-IP concurrent cap → [multi] server id → per-server
 * cap → DNS + public-address check.
 */
import * as http from 'http';
import type { Duplex } from 'stream';
import * as dgram from 'dgram';
import * as dns from 'dns';
import * as fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import {
  type BridgeConfig,
  FLAG_CONNECT_RESPONSE,
  WS_BACKPRESSURE_LIMIT,
  shouldDropForBackpressure,
  makeImpairedLink,
  readPacketFlags,
  readPacketId,
  readConnectRequestClientId,
  buildDisconnectPacket,
  isOriginAllowed,
  isFromAce,
  initialAceAddresses,
  normalizeAddress,
  automationAllowed,
} from './bridgeUtil.js';
import { type Logger, makeLogger, rateLimitedLog } from './log.js';
import { AbuseMeter, KeyedCounter, SlidingWindowCounter, TokenBucket, clientIp, isLoopbackAddress } from './limits.js';
import { BridgeMetrics, type BridgeSnapshot, makeHttpHandler } from './metrics.js';
import type { ServerRegistry } from './serverList.js';
import type { ServerDirectory } from './serverDirectory.js';
import { sanitizeClientError } from './clientErrors.js';
import { sanitizeClientPreworld, traceFromUrl } from './clientPreworld.js';
import { isWorldOutcome, sanitizeClientWorld } from './clientWorld.js';
import { RecentEventIds } from './eventIds.js';
import { type LookupFn, resolveTarget } from './targets.js';
import { encodeSppHeader, stripSppHeader } from './spp.js';
import { compatFor } from './serverCompat.js';
import { RoutineTokens, handleRoutines, readCharacterListAccount, readCharacterListAccount1999 } from './routines.js';
import { AgentRelay, accountKey, type RelayPeer } from './relay.js';
import { handleMcp, parseMcpTokens } from './mcpHttp.js';
import { OAuthServer } from './oauth.js';
import { handleOAuth } from './oauthHttp.js';
import { RoutineStore } from './routineStore.js';
import {
  type SessionProtocol, sessionProtocol, readGrant1999Ids, readTime1999, buildDisconnectPacket1999,
} from './protocol.js';

/** Where a session's datagrams go. */
interface Target {
  /** Stable key for per-server accounting ('pinned' in pinned mode, else the server id). */
  key: string;
  name: string;
  /** Address the UDP socket sends to (a resolved IP in multi mode). */
  sendHost: string;
  authPort: number;
  worldPort: number;
  /** Source addresses replies are accepted from. */
  sourceAddrs: Set<string>;
  /** The server trusts the bridge and takes each player's address in a Simple Proxy Protocol header (spp.ts). */
  spp: boolean;
}

interface Session {
  id: number;
  ip: string;
  ws: WebSocket;
  target: Target | null;
  udp: dgram.Socket | null;
  closed: boolean;
  openedAt: number;
  /** The id the server knows this session by: the EoL ConnectRequest clientId, or the 1999 grant's slot. */
  aceSessionId: number | null;
  /** Wire protocol (protocol.ts); 'eor' unless the server's era or ?proto says 1999. */
  protocol: SessionProtocol;
  /** 1999: the last server header time byte, echoed on our Disconnect. */
  time1999: number;
  /** The account the server's CharacterList named (proof of login; AGENT.routine-store-auth). */
  account: string | null;
  /**
   * A relay link (no game traffic): the account key another bridge vouched for with a relay-link ticket
   * (oauth.ts relayTicket). The tab opens one when its game session's bridge drains (docs/hosted-agent-connector.md §4.5).
   */
  relayLinkKey: string | null;
  /** The bridge started draining: tell this session's tab, so it links its relay to the new deployment. */
  notifyDraining(): void;
  packetsUp: number;
  packetsDown: number;
  bytesFromBrowser: number;
  bytesToServer: number;
  bytesFromServer: number;
  bytesToBrowser: number;
  dropped: number;
  close(reason: string, code?: number): Promise<void>;
}

export interface BridgeDeps {
  /** Required in multi mode. */
  registry?: ServerRegistry;
  /** Multi mode: the launcher's GET /servers body (world list + live status). */
  directory?: ServerDirectory;
  log?: Logger;
  lookup?: LookupFn;
  now?: () => number;
}

export interface BridgeServer {
  httpServer: http.Server;
  /** Start listening; resolves with the bound port (config.wsPort may be 0). */
  listen(): Promise<number>;
  /** Send each session's Disconnect to its game server, close everything. */
  shutdown(): Promise<void>;
  /**
   * Deploys without dropping players: refuse new connections (503
   * `draining`), keep every open session running, and resolve once the last
   * one ends ('empty') or `maxMs` passes ('timeout'). The caller then runs
   * shutdown() for whatever is left. A new deployment takes the new logins.
   */
  drain(maxMs: number): Promise<'empty' | 'timeout'>;
  metrics: BridgeMetrics;
  snapshot(): BridgeSnapshot;
}

/** Bridge → tab when it starts draining (docs/hosted-agent-connector.md §4.5). */
export const DRAINING_FRAME = JSON.stringify({ bridgeDraining: true });

/**
 * BUG.multi-tab-login-pingpong — the WebSocket close code (and reason) for a
 * connection refused because its address already holds maxSessionsPerIp
 * sessions. A browser cannot read an HTTP 429 on a refused upgrade (it sees
 * only a failed socket, which the client reported as retail's "Couldn't create
 * local socket" — a player locked out by their own open tabs had no idea why),
 * so the bridge accepts the upgrade and closes it at once with this code. The
 * client maps it to a plain message (@ac/network BRIDGE_CLOSE_IP_CAP, the same
 * value). Only the cap: the per-IP connect-rate refusal stays a bare 429 so a
 * flood never costs a handshake.
 */
export const CLOSE_IP_CAP = 4429;
export const CLOSE_IP_CAP_REASON = 'ip_cap';

type Admission =
  | { ok: true; target: Target | null; protocol: SessionProtocol; release: () => void }
  | { ok: false; status: number; reason: string; message: string };

export function createBridgeServer(config: BridgeConfig, deps: BridgeDeps = {}): BridgeServer {
  const log = deps.log ?? makeLogger(config.debug);
  const now = deps.now ?? Date.now;
  const metrics = new BridgeMetrics(now);
  const registry = deps.registry;
  if (config.mode === 'multi' && !registry) throw new Error('multi mode needs a ServerRegistry');

  const limits = config.limits;
  const perIp = new KeyedCounter();
  const perServer = new KeyedCounter();
  const serverNames = new Map<string, string>();
  const connectRate = new SlidingWindowCounter(limits.connectRatePerIp, limits.connectRateWindowMs, now);
  // RELEASE.error-reporting — a page sends at most a handful of reports; this
  // caps a broken or hostile client at 30 per 10 minutes per address.
  const clientErrorRate = new SlidingWindowCounter(30, 10 * 60_000, now);
  // RELEASE.preworld-outcomes — a pre-world visit sends a few events (list, create, enter, leave);
  // retried logins send more. 60 per 10 minutes per address.
  const clientPreworldRate = new SlidingWindowCounter(60, 10 * 60_000, now);
  // BUG.telemetry-duplicate-resend — a page resends an event whose send failed after delivery
  // (TelemetryOutbox); each event id is logged once.
  const recentEventIds = new RecentEventIds(now);
  const sweepTimer = setInterval(() => { connectRate.sweep(); clientErrorRate.sweep(); clientPreworldRate.sweep(); }, limits.connectRateWindowMs);
  sweepTimer.unref?.();
  const sessions = new Set<Session>();
  /** Admitted-but-not-yet-open upgrades count against the global cap too. */
  let pending = 0;
  let sessionCounter = 0;
  const lastServerResponse = new Map<string, number>();
  let shuttingDown = false;
  let draining = false;

  // ─── Capture (packet-replay corpus; never in production) ───
  let capture: fs.WriteStream | null = null;
  if (config.captureRefused) {
    log('error', 'capture_refused', { reason: 'BRIDGE_CAPTURE is ignored when NODE_ENV=production (it would record every player\'s traffic)' });
  } else if (config.capturePath) {
    capture = fs.createWriteStream(config.capturePath, { flags: 'a' });
    log('warn', 'capture_on', { path: config.capturePath });
  }
  const captureFrame = (frame: Buffer) => {
    if (!capture) return;
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(frame.length, 0);
    capture.write(Buffer.concat([prefix, frame]));
  };

  // ─── Pinned target (resolved addresses filled in asynchronously, as before) ───
  let pinned: Target | null = null;
  if (config.mode === 'pinned') {
    pinned = {
      key: 'pinned',
      name: `${config.aceHost}:${config.aceAuthPort}`,
      sendHost: config.aceHost,
      authPort: config.aceAuthPort,
      worldPort: config.aceWorldPort,
      sourceAddrs: initialAceAddresses(config.aceHost),
      spp: config.spp.pinned,
    };
    serverNames.set('pinned', pinned.name);
    const t = pinned;
    dns.lookup(config.aceHost, { all: true }, (err, addrs) => {
      if (err) { log('warn', 'target_resolve_failed', { host: config.aceHost, error: err.message }); return; }
      for (const a of addrs) t.sourceAddrs.add(normalizeAddress(a.address));
    });
  }

  const snapshot = (): BridgeSnapshot => {
    const counts = new Map(perServer.entries());
    const ids = new Set<string>([...counts.keys()]);
    if (pinned) ids.add(pinned.key);
    return {
      mode: config.mode,
      era: config.mode === 'pinned' ? config.era ?? null : null,
      sessions: sessions.size,
      perServer: [...ids].map(id => ({ id, name: serverNames.get(id) ?? id, sessions: counts.get(id) ?? 0 })),
      serversList: registry ? registry.status() : null,
      uptimeSeconds: Math.round((now() - metrics.startedAt) / 1000),
      draining,
    };
  };

  // ─── Routines (AGENT.routine-store-auth): pinned servers are local-<era>, the id agent tools use ───
  const routineStore = config.routinesDir ? new RoutineStore(config.routinesDir) : null;
  const routineTokens = new RoutineTokens(now);
  const routinesServer = (t: Target): string => (t.key === 'pinned' ? `local-${config.era ?? 'eor'}` : t.key);
  const tokenSweep = setInterval(() => routineTokens.sweep(), 60_000);
  tokenSweep.unref?.();

  const baseHandler = makeHttpHandler(metrics, snapshot, {
    metricsToken: config.metricsToken,
    clientErrors: (body, req) => {
      const ip = clientIp(req.socket.remoteAddress, req.headers, config.trustProxyHops, config.clientIpHeader);
      if (!clientErrorRate.hit(ip)) return 429;
      const report = sanitizeClientError(body);
      if (!report) return 400;
      if (recentEventIds.repeat(report.eid)) return 204;
      metrics.clientError(report.kind);
      log('warn', 'client_error', { ip, ...report });
      return 204;
    },
    clientPreworld: (body, req) => {
      const ip = clientIp(req.socket.remoteAddress, req.headers, config.trustProxyHops, config.clientIpHeader);
      if (!clientPreworldRate.hit(ip)) return 429;
      // RELEASE.first-minute — the page's in-world events share the route (clientWorld.ts): one client_world line.
      if (body && typeof body === 'object' && isWorldOutcome((body as { outcome?: unknown }).outcome)) {
        const wev = sanitizeClientWorld(body);
        if (!wev) return 400;
        if (recentEventIds.repeat(wev.eid)) return 204;
        metrics.clientPreworldEvent(wev.outcome);
        log('info', 'client_world', { ip, ...Object.fromEntries(Object.entries(wev).filter(([, v]) => v !== null)) });
        return 204;
      }
      const ev = sanitizeClientPreworld(body);
      if (!ev) return 400;
      if (recentEventIds.repeat(ev.eid)) return 204;
      metrics.clientPreworldEvent(ev.outcome);
      // One line, only the fields the event carries.
      log('info', 'client_preworld', { ip, ...Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== null)) });
      return 204;
    },
    servers: deps.directory ? () => deps.directory!.body() : null,
  });
  // AGENT.hosted-mcp-connector — /mcp relays an MCP client's tool calls to the account's own tab.
  const mcpTokens = parseMcpTokens(config.mcpTokens);
  const relay = new AgentRelay(now);
  // Step 3: OAuth pairing (BRIDGE_MCP=on). Tokens are sealed with BRIDGE_MCP_SECRET, so nothing is stored.
  const oauth = config.mcpOAuth ? new OAuthServer({ issuer: config.mcpPublicUrl || `http://127.0.0.1:${config.wsPort}`, allow: config.mcpAccounts, now, secret: config.mcpSecret, fetchJson: async (u) => (await fetch(u, { signal: AbortSignal.timeout(5000) })).json() }) : null;
  // Without the secret every pairing ends with this process (and isn't shared with the other bridge during a drain).
  if (oauth) log(oauth.persistent ? 'info' : 'warn', 'mcp_oauth_on', { tokens: oauth.persistent ? 'sealed' : 'this-process', allowlist: config.mcpAccounts.length });
  const relayOn = mcpTokens.size > 0 || !!oauth;
  const mcpAuth = (t: string) => { const dev = mcpTokens.get(t); if (dev) return { keys: [dev], scope: 'any' as const }; return oauth?.resolve(t) ?? null; };
  const httpServer = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://bridge.local').pathname;
    if (path === '/routines') return handleRoutines(req, res, routineTokens, routineStore);
    if (oauth && (path.startsWith('/.well-known/oauth') || path.startsWith('/oauth/'))) { void handleOAuth(req, res, oauth, config.mcpConnectPage).then((handled) => { if (!handled) baseHandler(req, res); }).catch((e) => { log('warn', 'oauth_error', { error: String((e as Error)?.message ?? e) }); if (!res.headersSent) { res.writeHead(500); res.end(); } }); return; }
    if (path === '/mcp' && relayOn) { void handleMcp(req, res, mcpAuth, relay, oauth ? `${oauth.resource.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource` : null).catch((e) => { log('warn', 'mcp_error', { error: String((e as Error)?.message ?? e) }); if (!res.headersSent) { res.writeHead(500); res.end(); } }); return; }
    return baseHandler(req, res);
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: config.maxPayload });

  // ─── Admission ─────────────────────────────────────

  async function admit(req: http.IncomingMessage, ip: string): Promise<Admission> {
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin || undefined, config.allowedOrigins)) {
      return { ok: false, status: 403, reason: 'origin', message: 'Origin not allowed' };
    }
    if (shuttingDown) return { ok: false, status: 503, reason: 'shutting_down', message: 'Bridge shutting down' };
    if (draining) return { ok: false, status: 503, reason: 'draining', message: 'Bridge is handing over to a new deployment' };
    if (sessions.size + pending >= config.maxConnections) {
      return { ok: false, status: 503, reason: 'global_cap', message: 'Too many connections' };
    }
    // Loopback peers (local dev tools) skip per-IP limits — unless the address
    // came from a trusted proxy header, where it is a real client address.
    const exempt = config.trustProxyHops === 0 && isLoopbackAddress(ip);
    if (!exempt) {
      if (!connectRate.hit(ip)) return { ok: false, status: 429, reason: 'ip_rate', message: 'Too many new connections' };
      if (perIp.get(ip) >= limits.maxSessionsPerIp) {
        return { ok: false, status: 429, reason: 'ip_cap', message: 'Too many sessions from this address' };
      }
    }

    let target: Target | null = pinned;
    // The server's era picks the session's wire protocol (pinned: BRIDGE_ERA).
    let era: string | null | undefined = config.mode === 'pinned' ? config.era : null;
    // Pinned mode counts its sessions under 'pinned' (for /healthz) but does
    // not apply the per-server cap: the operator chose that one server.
    let serverKey: string | null = pinned ? pinned.key : null;
    if (config.mode === 'multi') {
      const id = new URL(req.url ?? '/', 'http://bridge.local').searchParams.get('server');
      if (id !== null && id.trim() !== '') {
        const entry = registry!.lookup(id);
        if (!entry) return { ok: false, status: 404, reason: 'unknown_server', message: 'Unknown server id' };
        if (perServer.get(entry.id) >= limits.maxSessionsPerServer) {
          return { ok: false, status: 503, reason: 'server_cap', message: 'Too many sessions to this server' };
        }
        serverKey = entry.id;
        // Reserve before the async DNS step so concurrent upgrades can't overshoot the caps.
        perServer.inc(serverKey);
        perIp.inc(ip);
        pending++;
        const res = await resolveTarget(entry.host, { allowPrivate: config.allowPrivateTargets, lookup: deps.lookup });
        pending--;
        perIp.dec(ip);
        perServer.dec(serverKey);
        if (!res.ok) {
          log('warn', 'target_rejected', { server: entry.id, host: entry.host, reason: res.reason, detail: res.detail });
          return res.reason === 'private_target'
            ? { ok: false, status: 403, reason: 'private_target', message: 'Server address not allowed' }
            : { ok: false, status: 502, reason: res.reason, message: 'Server address could not be resolved' };
        }
        if (shuttingDown) return { ok: false, status: 503, reason: 'shutting_down', message: 'Bridge shutting down' };
        serverNames.set(entry.id, entry.name);
        // The launcher's directory row (overlay + live detection) names the era;
        // without a directory, the overlay alone.
        const row = deps.directory?.body().servers.find(s => s.id.toLowerCase() === entry.id.toLowerCase());
        era = row ? row.era : compatFor(entry.id, entry.emu).era;
        target = {
          key: entry.id,
          name: entry.name,
          sendHost: res.address,
          authPort: entry.port,
          worldPort: entry.port + 1,
          sourceAddrs: new Set([res.address]),
          spp: config.spp.servers.has(entry.id.toLowerCase()),
        };
      } else {
        target = null; // probe-only session
      }
    }

    perIp.inc(ip);
    if (serverKey) perServer.inc(serverKey);
    let released = false;
    return {
      ok: true,
      target,
      protocol: sessionProtocol(era, req.url),
      release: () => {
        if (released) return;
        released = true;
        perIp.dec(ip);
        if (serverKey) perServer.dec(serverKey);
      },
    };
  }

  function rejectUpgrade(socket: Duplex, status: number, message: string): void {
    const text = http.STATUS_CODES[status] ?? 'Error';
    try {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
    } catch { /* ignore */ }
    socket.destroy();
  }

  httpServer.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => { /* client vanished mid-handshake */ });
    const ip = clientIp(req.socket.remoteAddress, req.headers, config.trustProxyHops, config.clientIpHeader);
    void admit(req, ip).then((a) => {
      if (!a.ok) {
        metrics.reject(a.reason);
        log('warn', 'connect_rejected', { ip, reason: a.reason, status: a.status, origin: req.headers.origin, url: req.url });
        if (a.reason === 'ip_cap' && !socket.destroyed) {
          // Accepted only to say why: closed at once, never counted as a session.
          try {
            wss.handleUpgrade(req, socket, head, (ws) => ws.close(CLOSE_IP_CAP, CLOSE_IP_CAP_REASON));
          } catch { rejectUpgrade(socket, a.status, a.message); }
          return;
        }
        rejectUpgrade(socket, a.status, a.message);
        return;
      }
      if (socket.destroyed) { a.release(); return; }
      const proxy = { address: req.socket.localAddress ?? '', port: req.socket.localPort ?? 0 };
      const trace = traceFromUrl(req.url);
      wss.handleUpgrade(req, socket, head, (ws) => openSession(ws, ip, proxy, a.target, a.protocol, a.release, trace));
    }, (err) => {
      metrics.reject('internal');
      log('error', 'admit_failed', { ip, error: err as Error });
      rejectUpgrade(socket, 500, 'Internal error');
    });
  });

  // ─── Session ───────────────────────────────────────

  function openSession(
    ws: WebSocket, ip: string, proxy: { address: string; port: number }, target: Target | null, protocol: SessionProtocol, release: () => void,
    trace: string | null = null,
  ): void {
    const id = ++sessionCounter;
    const upLink = makeImpairedLink(config.impairment);
    const downLink = makeImpairedLink(config.impairment && { ...config.impairment, seed: config.impairment.seed + 1 });
    const msgBucket = new TokenBucket(limits.msgRatePerSec, limits.msgBurst, now);
    const byteBucket = new TokenBucket(limits.byteRatePerSec, limits.byteBurst, now);
    const abuse = new AbuseMeter(limits.abuseMaxDrops, limits.abuseWindowMs, now);
    const warnBackpressure = rateLimitedLog(log, 1000, now);
    const warnRate = rateLimitedLog(log, 1000, now);
    const warnForeign = rateLimitedLog(log, 5000, now);
    let isProbe = false;
    let isAlive = true;

    const session: Session = {
      id, ip, ws, target, udp: null, closed: false, openedAt: now(), aceSessionId: null, protocol, time1999: 0, account: null, relayLinkKey: null,
      packetsUp: 0, packetsDown: 0, bytesFromBrowser: 0, bytesToServer: 0, bytesFromServer: 0, bytesToBrowser: 0, dropped: 0,
      close: (reason, code) => cleanup(reason, code),
      notifyDraining: () => { if (relayOn && relayKeyOf() && ws.readyState === WebSocket.OPEN) ws.send(DRAINING_FRAME); },
    };
    // The relay's handle on this session's tab (text frames on the game WebSocket).
    const relayPeer: RelayPeer = { send: (t) => { if (ws.readyState === WebSocket.OPEN) ws.send(t); } };
    /** The relay account this session answers for: its logged-in account, or the one its relay link was vouched for. */
    const relayKeyOf = (): string | null => (session.target && session.account ? accountKey(routinesServer(session.target), session.account) : session.relayLinkKey);
    /** The server named the account: register the tab, and if this bridge is already draining, say so (it logged in late). */
    const accountRead = (account: string): void => {
      session.account = account;
      log('info', 'session_account', { session: id });
      if (!relayOn || !session.target) return;
      relay.register(relayPeer, accountKey(routinesServer(session.target), account));
      if (draining) session.notifyDraining();
    };
    sessions.add(session);
    metrics.connects++;
    // trace: the page's random id (RELEASE.preworld-outcomes), also on its client_preworld lines.
    log('info', 'session_open', { session: id, ip, server: target?.key ?? null, protocol, active: sessions.size, ...(trace ? { trace } : {}) });
    const is1999 = protocol === 'ac1999';
    // The player's address for a server that trusts the bridge (spp.ts). The
    // browser's own source port never reaches the bridge (the edge proxies it), so 0.
    const sppHeader = target?.spp ? encodeSppHeader({ address: ip, port: 0 }, proxy) : null;
    const withSpp = (buf: Buffer): Buffer => (sppHeader ? Buffer.concat([sppHeader, buf]) : buf);

    ws.on('pong', () => { isAlive = true; });
    const pingInterval = setInterval(() => {
      if (!isAlive) {
        log('info', 'session_ping_timeout', { session: id });
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, 20_000);

    const sendUdp = (buf: Buffer, port: number) => {
      const t = session.target!;
      const udp = session.udp!;
      upLink.send(() => {
        if (session.closed) return;
        session.bytesToServer += buf.length;
        metrics.addBytes('udp_out', buf.length);
        udp.send(withSpp(buf), port, t.sendHost);
      });
    };

    const ensureUdp = (): dgram.Socket => {
      if (session.udp) return session.udp;
      const t = session.target!;
      // A 1999 server speaks from its one port only.
      const sourcePorts = is1999 ? [t.authPort] : [t.authPort, t.worldPort];
      const udp = dgram.createSocket('udp4');
      session.udp = udp;
      udp.bind(0, () => log('debug', 'udp_bound', { session: id, port: udp.address().port }));
      udp.on('error', (err) => {
        log('error', 'udp_error', { session: id, error: err });
        void cleanup('udp_error');
      });
      udp.on('message', (datagram: Buffer, rinfo: dgram.RemoteInfo) => {
        if (!config.allowAnyUdpSource && !isFromAce(rinfo, t.sourceAddrs, sourcePorts)) {
          metrics.drop('foreign_udp');
          warnForeign('warn', 'udp_foreign_source', { session: id, from: `${rinfo.address}:${rinfo.port}` });
          return;
        }
        // A server that trusts the bridge echoes the SPP header on every reply.
        const msg = t.spp ? stripSppHeader(datagram) : datagram;
        if (!msg) {
          metrics.drop('spp_missing');
          warnForeign('warn', 'udp_spp_missing', { session: id, from: `${rinfo.address}:${rinfo.port}`, len: datagram.length });
          return;
        }
        lastServerResponse.set(t.key, now());
        if (session.closed) return;
        session.bytesFromServer += msg.length;
        session.packetsDown++;
        metrics.addBytes('udp_in', msg.length);
        if (config.debug) {
          log('debug', 'udp_in', { session: id, port: rinfo.port, seq: msg.length >= 4 ? msg.readUInt32LE(0) : 0, flags: readPacketFlags(msg), len: msg.length });
        }
        if (is1999) {
          // The slot comes from the server's connect grant body; its own id is the grant header's recipient.
          session.time1999 = readTime1999(msg) ?? session.time1999;
          const grant = readGrant1999Ids(msg);
          if (grant && grant.slot !== session.aceSessionId) {
            session.aceSessionId = grant.slot;
            log('info', 'session_server_id', { session: id, aceSessionId: grant.slot, serverRecipient: grant.serverRecipient, protocol });
          }
          // Read the account when something needs it: the routines store or the automation allowlist.
          if (session.account === null && (routineStore || config.automationAccounts.length || relayOn)) {
            const account = readCharacterListAccount1999(msg);
            if (account) accountRead(account);
          }
        } else {
          // The client's session id comes from the server's ConnectRequest
          // payload (server header Ids are always ServerId 0xB).
          const clientId = readConnectRequestClientId(msg);
          if (clientId !== null && clientId !== session.aceSessionId) {
            session.aceSessionId = clientId;
            log('info', 'session_server_id', { session: id, aceSessionId: clientId });
          }
          // Read the account when something needs it: the routines store or the automation allowlist.
          if (session.account === null && (routineStore || config.automationAccounts.length || relayOn)) {
            const account = readCharacterListAccount(msg);
            if (account) accountRead(account);
          }
        }
        // Backpressure: drop the datagram (UDP semantics; the client NAKs).
        downLink.send(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (shouldDropForBackpressure(ws.bufferedAmount)) {
            metrics.drop('backpressure');
            warnBackpressure('warn', 'ws_backpressure_drop', { session: id, buffered: ws.bufferedAmount, limit: WS_BACKPRESSURE_LIMIT });
            return;
          }
          captureFrame(msg);
          session.bytesToBrowser += msg.length;
          metrics.addBytes('ws_out', msg.length);
          ws.send(msg);
        });
      });
      return udp;
    };

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (session.closed) return;
      const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : data;
      session.bytesFromBrowser += buf.length;
      metrics.addBytes('ws_in', buf.length);

      // Per-session rate limits: drop over-limit messages; close on sustained abuse.
      if (!msgBucket.tryTake(1) || !byteBucket.tryTake(buf.length)) {
        session.dropped++;
        metrics.drop('rate_limited');
        warnRate('warn', 'session_rate_limited', { session: id, ip });
        if (abuse.recordDrop()) {
          log('warn', 'session_abuse_close', { session: id, ip, dropped: session.dropped });
          void cleanup('abuse', 1008);
        }
        return;
      }

      // Text "health" → JSON status, then close (probeBridgeHealth / check-stack).
      if (!isBinary) {
        // The relay's frames from the tab (agentResult / agentState).
        if (relayOn && relay.onText(relayPeer, buf.toString('utf8'), relayKeyOf())) return;
        const pairText = buf.toString('utf8');
        // Relay link (docs/hosted-agent-connector.md §4.5): a logged-in session asks for a ticket that vouches for
        // its account; the tab hands it to the new deployment over a second socket, which then carries the relay.
        if (pairText === 'relayTicket') {
          const key = session.target && session.account ? accountKey(routinesServer(session.target), session.account) : null;
          const ticket = key && oauth ? oauth.relayTicket(key) : null;
          ws.send(JSON.stringify({ relayTicket: { ticket, draining } }));
          return;
        }
        if (pairText.startsWith('{"relayHello"')) {
          let ticket = '';
          try { ticket = String((JSON.parse(pairText) as { relayHello?: unknown }).relayHello ?? ''); } catch { /* not JSON */ }
          const key = oauth && relayOn ? oauth.openRelayTicket(ticket) : null;
          if (key) { session.relayLinkKey = key; relay.register(relayPeer, key); }
          log('info', 'relay_link', { session: id, ok: !!key });
          ws.send(JSON.stringify({ relayLinked: key ? { ok: true } : { ok: false, message: 'the relay-link ticket was refused' } }));
          return;
        }
        // A pairing code typed in the game, or an unpair (step 3): only from a session the server has logged in (or a relay link it vouched for).
        if (pairText.startsWith('{"pair"') || pairText.startsWith('{"unpair"')) {
          const unpair = pairText.startsWith('{"unpair"');
          const key = relayKeyOf();
          let r: { ok: boolean; message: string; at?: number };
          if (!oauth) r = { ok: false, message: 'this server has no Claude connector' };
          else if (!key) r = { ok: false, message: 'log in first' };
          // `at` (this bridge's clock) is what the tab keeps as its revokedBefore.
          else if (unpair) { oauth.revokeAccount(key); r = { ok: true, message: 'every Claude connection for this account is revoked', at: now() }; }
          else {
            let code = '';
            try { code = String((JSON.parse(pairText) as { pair?: unknown }).pair ?? ''); } catch { /* not JSON */ }
            r = oauth.pair(code, key, relay.entry(key)?.character ?? null);
          }
          if (key) log('info', unpair ? 'mcp_unpair' : 'mcp_pair', { session: id, ok: r.ok });
          ws.send(JSON.stringify(unpair ? { unpaired: r } : { paired: r }));
          return;
        }
        if (buf.toString('utf8').trim().toLowerCase() === 'health') {
          isProbe = true;
          const key = session.target?.key;
          const last = key ? lastServerResponse.get(key) ?? 0 : Math.max(0, ...lastServerResponse.values());
          const recent = last > 0 && now() - last < 30_000;
          // ERA.dm-support: a pinned bridge names its server's era here too —
          // the web CSP allows wss: to any bridge but not its https /healthz.
          const era = config.mode === 'pinned' && config.era ? { era: config.era } : {};
          ws.send(JSON.stringify({ bridge: 'ok', ace: recent ? 'ok' : 'unknown', sessions: sessions.size, ...era }));
          ws.close();
        } else if (buf.toString('utf8').trim().toLowerCase() === 'routines') {
          // A token for /routines once the server has logged this session in (routines.ts).
          const reason = !routineStore ? 'routines are not kept on this bridge'
            : !session.target ? 'not connected to a server'
            : !session.account ? 'not logged in yet' : null;
          // AGENT.automation-allowlist — whether this (server-reported) account gets the automation UI.
          const automation = !!session.target && !!session.account && automationAllowed(config.automationAccounts, routinesServer(session.target), session.account);
          // Preview UI (BRIDGE_PREVIEW_ACCOUNTS): the same rule over its own list; an empty list is nobody.
          const preview = !!session.target && !!session.account && automationAllowed(config.previewAccounts, routinesServer(session.target), session.account);
          // A bridge that keeps no routines still names the logged-in account, so the page keeps them in
          // its own browser storage under it (AGENT.automation-allowlist; RoutineSync's local mode).
          const who = session.target && session.account ? { server: routinesServer(session.target), account: session.account } : {};
          ws.send(JSON.stringify(reason || !session.target || !session.account
            ? { routines: null, reason, automation, preview, ...who }
            : { routines: { token: routineTokens.issue(id, routinesServer(session.target), session.account), server: routinesServer(session.target), account: session.account }, automation, preview }));
        }
        return;
      }

      if (isProbe || !session.target) return; // probe-only session: forward nothing
      if (buf.length < 20) return;
      ensureUdp();
      const flags = readPacketFlags(buf);
      session.packetsUp++;
      if (config.debug) log('debug', 'ws_in', { session: id, seq: buf.readUInt32LE(0), flags, len: buf.length });

      if (is1999) {
        // One port for everything (no ConnectResponse / world port in 1999).
        sendUdp(buf, session.target.authPort);
      } else if (flags & FLAG_CONNECT_RESPONSE) {
        // ConnectResponse is the only packet for the world port.
        // Fallback only: the client stamps its header Id with the ConnectRequest's clientId.
        if (session.aceSessionId === null) session.aceSessionId = readPacketId(buf);
        log('info', 'session_connect_response', { session: id, worldPort: session.target.worldPort });
        sendUdp(buf, session.target.worldPort);
      } else {
        sendUdp(buf, session.target.authPort);
      }
    });

    /**
     * `peerCloseCode`: the browser socket's close code on a 'ws_close'
     * (BUG.hidden-tab-session-drop). 1005 = the page closed it (close() with
     * no code: ClientConnection's own end of a session), 1001 = the page went
     * away, 1006 = the connection dropped with no close frame (an edge proxy,
     * the network, our ping timeout's terminate()).
     */
    function cleanup(reason: string, code?: number, peerCloseCode?: number): Promise<void> {
      relay.remove(relayPeer);
      if (session.closed) return Promise.resolve();
      session.closed = true;
      sessions.delete(session);
      routineTokens.sessionEnded(id);
      release();
      clearInterval(pingInterval);
      upLink.close();
      downLink.close();
      metrics.close(reason);
      log('info', 'session_close', {
        session: id, ip, server: session.target?.key ?? null, reason, ...(trace ? { trace } : {}),
        durationMs: now() - session.openedAt,
        bytesFromBrowser: session.bytesFromBrowser, bytesToServer: session.bytesToServer,
        bytesFromServer: session.bytesFromServer, bytesToBrowser: session.bytesToBrowser,
        packetsUp: session.packetsUp, packetsDown: session.packetsDown, dropped: session.dropped,
        ...(typeof peerCloseCode === 'number' ? { peerCloseCode } : {}),
        active: sessions.size,
      });
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try { ws.close(code ?? 1000); } catch { /* ignore */ }
      }
      const udp = session.udp;
      if (!udp) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => { try { udp.close(); } catch { /* ignore */ } resolve(); };
        // Tell the server to free the session now instead of after its 60 s
        // timeout. Needs the right session id + a valid checksum.
        if (session.aceSessionId !== null && session.target) {
          const pkt = is1999
            ? buildDisconnectPacket1999(session.aceSessionId, session.time1999)
            : buildDisconnectPacket(session.aceSessionId);
          log('info', 'session_disconnect_sent', { session: id, aceSessionId: session.aceSessionId, protocol });
          try { udp.send(withSpp(pkt), session.target.authPort, session.target.sendHost, done); } catch { done(); }
        } else {
          done();
        }
      });
    }

    ws.on('close', (peerCloseCode: number) => { void cleanup('ws_close', undefined, peerCloseCode); });
    ws.on('error', (err) => {
      log('warn', 'ws_error', { session: id, error: err });
      void cleanup('ws_error');
    });
  }

  return {
    httpServer,
    metrics,
    snapshot,
    listen: () => new Promise<number>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(config.wsPort, config.wsHost, () => {
        httpServer.off('error', reject);
        const addr = httpServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : config.wsPort);
      });
    }),
    drain: (maxMs: number) => new Promise<'empty' | 'timeout'>((resolve) => {
      draining = true;
      const started = now();
      log('info', 'bridge_draining', { sessions: sessions.size, maxSeconds: Math.round(maxMs / 1000) });
      // The game keeps playing here, but /mcp now reaches the new deployment: each paired tab links its relay there.
      for (const s of sessions) s.notifyDraining();
      const check = () => {
        if (sessions.size === 0) { resolve('empty'); return; }
        if (now() - started >= maxMs) { resolve('timeout'); return; }
        setTimeout(check, Math.min(1000, Math.max(10, maxMs / 10))).unref?.();
      };
      check();
    }),
    shutdown: async () => {
      shuttingDown = true;
      clearInterval(sweepTimer); clearInterval(tokenSweep);
      registry?.stop();
      deps.directory?.stop();
      const closing = [...sessions].map(s => s.close('shutdown', 1001));
      await Promise.race([Promise.all(closing), new Promise(r => setTimeout(r, 3000))]);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
      if (capture) await new Promise<void>(r => capture!.end(() => r()));
    },
  };
}
