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
 * cap → DNS + public-address check → [egress world] an egress slot (egress.ts).
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
  WsLiveness, WS_PING_INTERVAL_MS,
} from './bridgeUtil.js';
import { type Logger, makeLogger, rateLimitedLog } from './log.js';
import { AbuseMeter, KeyedCounter, SlidingWindowCounter, TokenBucket, clientIp, isLoopbackAddress } from './limits.js';
import { BridgeMetrics, type BridgeSnapshot, makeHttpHandler } from './metrics.js';
import type { ServerRegistry } from './serverList.js';
import type { ServerDirectory } from './serverDirectory.js';
import { sanitizeClientError } from './clientErrors.js';
import { sanitizeClientPreworld, traceFromUrl } from './clientPreworld.js';
import { isWorldOutcome, sanitizeClientWorld } from './clientWorld.js';
import { isAutomationOutcome, sanitizeClientAutomation } from './clientAutomation.js';
import { RecentEventIds } from './eventIds.js';
import { type LookupFn, resolveTarget } from './targets.js';
import { encodeSppHeader, stripSppHeader } from './spp.js';
import { compatFor } from './serverCompat.js';
import { RoutineTokens, handleRoutines, readCharacterList, readCharacterList1999 } from './routines.js';
import { AgentRelay, accountKey, type RelayPeer } from './relay.js';
import { handleMcp, parseMcpTokens } from './mcpHttp.js';
import { OAuthServer } from './oauth.js';
import { handleOAuth } from './oauthHttp.js';
import { RoutineStore } from './routineStore.js';
import {
  type SessionProtocol, sessionProtocol, readGrant1999Ids, readTime1999, buildDisconnectPacket1999,
} from './protocol.js';
import { EARLY_RESEND_MS, type EgressLease, type EgressManager, NO_REPLY_MOVE_MS, readLoginAccount, readLoginRefusal } from './egress.js';
import { HANDOVER_RELEASE, HANDOVER_TICKET_REQUEST, HandoverTickets, bindWhenFree, type HandoverTicket } from './handover.js';

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
  /**
   * The bridge started draining: tell this session's tab, so it hands the session over to the new
   * deployment at a safe moment (handover.ts) and links its relay there.
   */
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
  /** Per-session egress addresses for BRIDGE_EGRESS_SERVERS worlds (egress.ts startEgress), already started. */
  egress?: EgressManager | null;
  /** An egress session the server never answers moves after this long (default NO_REPLY_MOVE_MS; tests shorten it). */
  egressNoReplyMs?: number;
  /** An egress session with no server byte resends its last datagram at these offsets from its first (default EARLY_RESEND_MS). */
  egressEarlyResendMs?: readonly number[];
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
/** The same, from a bridge that can hand its sessions over (a handover secret is set; handover.ts). */
export const DRAINING_HANDOVER_FRAME = JSON.stringify({ bridgeDraining: true, handover: true });

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
/**
 * An egress world (egress.ts) has no slot for this session: every egress
 * address already carries the world's per-address session limit, or the
 * cloud refused a new address. The client says the world is full through
 * webAC right now (@ac/network BRIDGE_CLOSE_WORLD_FULL).
 */
export const CLOSE_WORLD_FULL = 4503;
export const CLOSE_WORLD_FULL_REASON = 'world_full';
/**
 * An egress world's login named an account the bridge has never seen reach
 * the character list (the server would create it), and the player's real
 * address has already introduced the world's limit of new accounts. The login
 * is not forwarded (@ac/network BRIDGE_CLOSE_NEW_ACCOUNT_CAP).
 */
export const CLOSE_NEW_ACCOUNT_CAP = 4403;
export const CLOSE_NEW_ACCOUNT_CAP_REASON = 'new_account_cap';
/**
 * An egress world's login named a new account, and no egress address the
 * world still lets create accounts (accountsPerAddress) could be had: every
 * slot's address has made its creations and no fresh one could be allocated.
 * The login is not forwarded (@ac/network BRIDGE_CLOSE_NEW_ACCOUNT_UNAVAILABLE).
 */
export const CLOSE_NEW_ACCOUNT_UNAVAILABLE = 4504;
export const CLOSE_NEW_ACCOUNT_UNAVAILABLE_REASON = 'new_account_unavailable';

/**
 * Refusals the browser must be able to read (it can't see an HTTP status on
 * a refused upgrade): accepted only to be closed at once with these codes.
 * An egress world's per-real-IP session cap reads as the bridge's own ip_cap.
 */
const READABLE_REFUSALS: Readonly<Record<string, readonly [number, string]>> = {
  ip_cap: [CLOSE_IP_CAP, CLOSE_IP_CAP_REASON],
  egress_ip_cap: [CLOSE_IP_CAP, CLOSE_IP_CAP_REASON],
  egress_full: [CLOSE_WORLD_FULL, CLOSE_WORLD_FULL_REASON],
};

type Admission =
  | { ok: true; target: Target | null; protocol: SessionProtocol; egress: EgressLease | null; handover: boolean; release: () => void }
  | { ok: false; status: number; reason: string; message: string };

export function createBridgeServer(config: BridgeConfig, deps: BridgeDeps = {}): BridgeServer {
  const log = deps.log ?? makeLogger(config.debug);
  const now = deps.now ?? Date.now;
  const metrics = new BridgeMetrics(now);
  const registry = deps.registry;
  if (config.mode === 'multi' && !registry) throw new Error('multi mode needs a ServerRegistry');
  const egress = deps.egress ?? null;

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
  // OBS.automation-usage — a page sends at most 30 automation events (AutomationReporter); its own budget, so a
  // busy automation session never spends the pre-world events' one. 40 per 10 minutes per address.
  const clientAutomationRate = new SlidingWindowCounter(40, 10 * 60_000, now);
  // BUG.telemetry-duplicate-resend — a page resends an event whose send failed after delivery
  // (TelemetryOutbox); each event id is logged once.
  const recentEventIds = new RecentEventIds(now);
  const sweepTimer = setInterval(() => { connectRate.sweep(); clientErrorRate.sweep(); clientPreworldRate.sweep(); clientAutomationRate.sweep(); }, limits.connectRateWindowMs);
  sweepTimer.unref?.();
  const sessions = new Set<Session>();
  /** Admitted-but-not-yet-open upgrades count against the global cap too. */
  let pending = 0;
  let sessionCounter = 0;
  const lastServerResponse = new Map<string, number>();
  let shuttingDown = false;
  let draining = false;
  // Planned handovers between deployments (handover.ts): needs the secret both share.
  const handoverTickets = config.handoverSecret ? new HandoverTickets(config.handoverSecret, now) : null;

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
      // OBS.automation-usage — the page's automation usage events share the route (clientAutomation.ts): one client_automation line.
      if (body && typeof body === 'object' && isAutomationOutcome((body as { outcome?: unknown }).outcome)) {
        if (!clientAutomationRate.hit(ip)) return 429;
        const aev = sanitizeClientAutomation(body);
        if (!aev) return 400;
        if (recentEventIds.repeat(aev.eid)) return 204;
        metrics.clientAutomationEvent(aev.outcome);
        log('info', 'client_automation', { ip, ...Object.fromEntries(Object.entries(aev).filter(([, v]) => v !== null)) });
        return 204;
      }
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

    // An egress world: a slot of its own address, attached before the upgrade completes, so the
    // session's first datagram already leaves from it. The world's per-address rules apply per real IP.
    let lease: EgressLease | null = null;
    const protocol = sessionProtocol(era, req.url);
    // A planned handover's socket (handover.ts): it carries nothing until a ticket hands it a session,
    // whose egress lease comes with it, so it takes no slot of its own.
    const handover = !!target && new URL(req.url ?? '/', 'http://bridge.local').searchParams.get('handover') === '1';
    if (egress && target && egress.isEgressWorld(target.key) && !handover) {
      perIp.inc(ip);
      if (serverKey) perServer.inc(serverKey);
      pending++;
      // The session's real destination: a fresh address must get an answer from it (egress.ts pathProbeFor).
      const got = await egress.acquire(target.key, ip, { protocol, host: target.sendHost, port: target.authPort, spp: target.spp });
      pending--;
      perIp.dec(ip);
      if (serverKey) perServer.dec(serverKey);
      if (!got.ok) {
        return got.refusal === 'ip_cap'
          ? { ok: false, status: 429, reason: 'egress_ip_cap', message: 'Too many sessions to this server from this address' }
          : { ok: false, status: 503, reason: 'egress_full', message: 'No free egress address for this server' };
      }
      lease = got.lease;
      if (shuttingDown || draining) {
        lease.release();
        return { ok: false, status: 503, reason: shuttingDown ? 'shutting_down' : 'draining', message: 'Bridge is not taking new sessions' };
      }
    }

    perIp.inc(ip);
    if (serverKey) perServer.inc(serverKey);
    let released = false;
    return {
      ok: true,
      target,
      protocol,
      egress: lease,
      handover,
      release: () => {
        if (released) return;
        released = true;
        perIp.dec(ip);
        if (serverKey) perServer.dec(serverKey);
        lease?.release();
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
        const readable = READABLE_REFUSALS[a.reason];
        if (readable && !socket.destroyed) {
          // Accepted only to say why: closed at once, never counted as a session.
          try {
            wss.handleUpgrade(req, socket, head, (ws) => ws.close(readable[0], readable[1]));
          } catch { rejectUpgrade(socket, a.status, a.message); }
          return;
        }
        rejectUpgrade(socket, a.status, a.message);
        return;
      }
      if (socket.destroyed) { a.release(); return; }
      // An upgrade that never completes (ws aborts it on a bad request) frees what admission took,
      // the egress slot included; once the session opened, its cleanup does (release is idempotent).
      socket.once('close', a.release);
      const proxy = { address: req.socket.localAddress ?? '', port: req.socket.localPort ?? 0 };
      const trace = traceFromUrl(req.url);
      wss.handleUpgrade(req, socket, head, (ws) => openSession(ws, ip, proxy, a.target, a.protocol, a.release, trace, a.egress, a.handover));
    }, (err) => {
      metrics.reject('internal');
      log('error', 'admit_failed', { ip, error: err as Error });
      rejectUpgrade(socket, 500, 'Internal error');
    });
  });

  // ─── Session ───────────────────────────────────────

  function openSession(
    ws: WebSocket, ip: string, proxy: { address: string; port: number }, target: Target | null, protocol: SessionProtocol, release: () => void,
    trace: string | null = null, lease: EgressLease | null = null, handoverOnly = false,
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
    // A pong or any browser message proves the socket (WsLiveness).
    const liveness = new WsLiveness();

    const session: Session = {
      id, ip, ws, target, udp: null, closed: false, openedAt: now(), aceSessionId: null, protocol, time1999: 0, account: null, relayLinkKey: null,
      packetsUp: 0, packetsDown: 0, bytesFromBrowser: 0, bytesToServer: 0, bytesFromServer: 0, bytesToBrowser: 0, dropped: 0,
      close: (reason, code) => cleanup(reason, code),
      // Every game session hears it (its tab hands the session over at a safe moment); a probe has nothing to hand over.
      notifyDraining: () => { if (session.target && !isProbe && ws.readyState === WebSocket.OPEN) ws.send(handoverTickets ? DRAINING_HANDOVER_FRAME : DRAINING_FRAME); },
    };
    // The relay's handle on this session's tab (text frames on the game WebSocket).
    const relayPeer: RelayPeer = { send: (t) => { if (ws.readyState === WebSocket.OPEN) ws.send(t); } };
    /** The relay account this session answers for: its logged-in account, or the one its relay link was vouched for. */
    const relayKeyOf = (): string | null => (session.target && session.account ? accountKey(routinesServer(session.target), session.account) : session.relayLinkKey);
    /** The server named the account: register the tab, and if this bridge is already draining, say so (it logged in late). */
    const accountRead = (account: string, characters: number): void => {
      session.account = account;
      log('info', 'session_account', { session: id });
      // An egress world's new-account rule: the account is known now (and counts against the real IP if this login made it).
      if (lease?.accountRule) {
        try { egress!.accountConfirmed(lease, account, characters); } catch (err) { egressFailure('account_confirm', err); }
      }
      if (!relayOn || !session.target) return;
      relay.register(relayPeer, accountKey(routinesServer(session.target), account));
      if (draining) session.notifyDraining();
    };
    sessions.add(session);
    metrics.connects++;
    // trace: the page's random id (RELEASE.preworld-outcomes), also on its client_preworld lines.
    // egressIp: the address the game server sees for this session (an operator's report names it; this line maps it to `ip`).
    const egressFields = () => (lease ? { egressSlot: lease.localAddress, egressIp: lease.publicIp ?? lease.localAddress } : {});
    log('info', 'session_open', { session: id, ip, server: target?.key ?? null, protocol, active: sessions.size, ...egressFields(), ...(trace ? { trace } : {}) });
    const is1999 = protocol === 'ac1999';
    // The player's address for a server that trusts the bridge (spp.ts). The
    // browser's own source port never reaches the bridge (the edge proxies it), so 0.
    const sppHeader = target?.spp ? encodeSppHeader({ address: ip, port: 0 }, proxy) : null;
    const withSpp = (buf: Buffer): Buffer => (sppHeader ? Buffer.concat([sppHeader, buf]) : buf);

    ws.on('pong', () => { liveness.heard(); });
    const pingInterval = setInterval(() => {
      if (liveness.tick() === 'dead') {
        log('info', 'session_ping_timeout', { session: id });
        ws.terminate();
        return;
      }
      ws.ping();
    }, WS_PING_INTERVAL_MS);

    const sendUdp = (buf: Buffer, port: number) => {
      const t = session.target!;
      upLink.send(() => {
        // The session's socket when it goes (an early resend or a move may have replaced it meanwhile).
        const udp = session.udp;
        if (session.closed || !udp) return;
        session.bytesToServer += buf.length;
        metrics.addBytes('udp_out', buf.length);
        try { udp.send(withSpp(buf), port, t.sendHost); } catch { /* closed under a delayed send */ }
      });
    };

    const ensureUdp = (): dgram.Socket => {
      if (session.udp) return session.udp;
      const udp = dgram.createSocket('udp4');
      session.udp = udp;
      // An egress session leaves from its slot's address (sends queue until the bind completes).
      const bound = () => log('debug', 'udp_bound', { session: id, address: udp.address().address, port: udp.address().port });
      if (lease) udp.bind({ port: 0, address: lease.localAddress }, bound);
      else udp.bind(0, bound);
      return wireUdp(udp);
    };

    /** The session's socket: what the server sends goes to the tab. */
    function wireUdp(udp: dgram.Socket): dgram.Socket {
      const t = session.target!;
      // A 1999 server speaks from its one port only.
      const sourcePorts = is1999 ? [t.authPort] : [t.authPort, t.worldPort];
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
        // An egress world's new-account rule: the server refused the login outright (no account made), so
        // the pending markers that login left are dropped. Only before the character list.
        if (lease?.accountRule && session.account === null && readLoginRefusal(msg, protocol)) {
          try { egress!.loginRefused(lease); } catch (err) { egressFailure('login_refused', err); }
        }
        if (lease && session.packetsDown === 0 && firstUpAt) {
          clearEarlyResends();
          log('info', 'egress_first_reply', { session: id, ms: now() - firstUpAt, earlyResends, ...egressFields() });
        }
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
          if (session.account === null && (routineStore || config.automationAccounts.length || relayOn || lease?.accountRule)) {
            const list = readCharacterList1999(msg);
            if (list) accountRead(list.account, list.characters);
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
          if (session.account === null && (routineStore || config.automationAccounts.length || relayOn || lease?.accountRule)) {
            const list = readCharacterList(msg);
            if (list) accountRead(list.account, list.characters);
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
    }

    // ── Planned handover (handover.ts) ──
    /** This (draining) bridge gave the tab a ticket for the session. */
    let ticketIssued = false;
    /** The tab moved the session to the new deployment: the socket closes without the server's Disconnect. */
    let handedOver = false;
    /** A handover socket: the ticket it presented is being taken over, or was. */
    let adopting = false;
    let adopted = false;

    /** Old bridge: a ticket that lets the new deployment take this session's UDP socket over. */
    function handoverTicket(): void {
      const reply = (ticket: string | null, reason?: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ handoverTicket: { ticket, ...(reason ? { reason } : {}) } }));
      };
      if (!handoverTickets) { reply(null, 'no_secret'); return; }
      if (!draining) { reply(null, 'not_draining'); return; }
      const udp = session.udp;
      if (!udp || !session.target || session.closed) { reply(null, 'no_session'); return; }
      // A login check may still move an egress session to another address: hand it over once settled.
      if (loginCheck) { reply(null, 'busy'); return; }
      let addr: { address: string; port: number };
      try { addr = udp.address(); } catch { reply(null, 'no_session'); return; }
      ticketIssued = true;
      log('info', 'handover_ticket', { session: id, port: addr.port, ...egressFields(), ...(trace ? { trace } : {}) });
      reply(handoverTickets.issue({
        target: session.target.key, protocol, address: addr.address, port: addr.port,
        aceSessionId: session.aceSessionId, time1999: session.time1999, account: session.account,
        egress: lease?.sessionId ?? null, trace,
      }));
    }

    /** Old bridge: the new deployment holds the ticket; let go of the socket (no Disconnect: the session lives on). */
    function handoverRelease(): void {
      if (!ticketIssued || session.closed || handedOver) return;
      handedOver = true;
      if (lease && egress) egress.handOff(lease);
      void cleanup('handover');
    }

    /** New bridge: take over the session a ticket names, binding its socket's address and port once the old bridge lets go. */
    async function adoptSession(text: string): Promise<void> {
      const refuse = (reason: string) => {
        log('warn', 'handover_refused', { session: id, reason, ...(trace ? { trace } : {}) });
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ adopt: { ok: false, reason } }));
      };
      if (!handoverOnly || adopting || adopted || session.closed || !session.target) { refuse('not_a_handover_socket'); return; }
      if (!handoverTickets) { refuse('no_secret'); return; }
      let tok = '';
      try { tok = String((JSON.parse(text) as { adopt?: unknown }).adopt ?? ''); } catch { /* not JSON */ }
      const opened = handoverTickets.open(tok);
      if (!opened.ok) { refuse(opened.reason); return; }
      const t: HandoverTicket = opened.ticket;
      if (t.target !== session.target.key) { refuse('other_server'); return; }
      if (t.protocol !== protocol) { refuse('other_protocol'); return; }
      let taken: EgressLease | null = null;
      if (t.egress) {
        taken = egress ? egress.adopt(t.egress, session.target.key) : null;
        if (!taken) { refuse('egress_lease'); return; }
        if (taken.localAddress !== t.address) { taken.release(); refuse('egress_slot'); return; }
      } else if (egress?.isEgressWorld(session.target.key)) {
        refuse('egress_lease');
        return;
      }
      adopting = true;
      const started = now();
      ws.send(JSON.stringify({ adopt: { ok: true } }));
      const udp = await bindWhenFree(t.address, t.port);
      if (session.closed) {
        try { udp?.close(); } catch { /* closed */ }
        taken?.release();
        return;
      }
      if (!udp) {
        taken?.release();
        log('warn', 'handover_bind_failed', { session: id, port: t.port, ms: now() - started, ...(trace ? { trace } : {}) });
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ adopted: { ok: false, reason: 'port_busy' } }));
        void cleanup('handover_failed');
        return;
      }
      lease = taken;
      session.aceSessionId = t.aceSessionId;
      session.time1999 = t.time1999;
      // The session is answered already: no early resends, no no-reply move (those are for a new login).
      firstUpAt = now();
      noReplyMoved = true;
      if (t.account) {
        session.account = t.account;
        if (relayOn) relay.register(relayPeer, accountKey(routinesServer(session.target), t.account));
      }
      adopted = true;
      const ms = now() - started;
      log('info', 'handover_adopted', { session: id, port: t.port, ms, ...egressFields(), ...(t.trace ? { fromTrace: t.trace } : {}), ...(trace ? { trace } : {}) });
      ws.send(JSON.stringify({ adopted: { ok: true, ms } }));
      session.udp = udp;
      wireUdp(udp);
    }

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (session.closed) return;
      const buf = data instanceof ArrayBuffer ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : data;
      liveness.heard();
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
        const head = buf.length <= 32 ? buf.toString('utf8') : '';
        // Planned handover (handover.ts): the old bridge's ticket and release, the new bridge's adopt.
        if (head === HANDOVER_TICKET_REQUEST) { handoverTicket(); return; }
        if (head === HANDOVER_RELEASE) { handoverRelease(); return; }
        if (buf.subarray(0, 9).toString('utf8') === '{"adopt":') { void adoptSession(buf.toString('utf8')); return; }
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
      if (handoverOnly && !adopted) return; // a handover socket carries nothing of its own
      if (buf.length < 20) return;
      handleGame(buf);
    });

    /**
     * Egress state failed under this session (the state dir, a lock held too
     * long): close only this session, as a full world, never the bridge.
     */
    function egressFailure(step: string, err: unknown): void {
      log('error', 'egress_session_error', { session: id, step, error: err as Error });
      void cleanup('egress_error', CLOSE_WORLD_FULL);
    }

    // An egress world's new-account rule runs before a login reaches the server (which would
    // create the account). The check is async (a cross-process lock): packets behind it wait,
    // in order, and go once it allows the login.
    let loginCheck = false;
    const waiting: Buffer[] = [];
    const MAX_WAITING = 64;

    function handleGame(buf: Buffer): void {
      if (session.closed || !session.target) return;
      if (loginCheck) {
        if (waiting.length < MAX_WAITING) waiting.push(buf);
        return;
      }
      if (lease?.accountRule) {
        const login = readLoginAccount(buf, protocol);
        if (login.login && login.account !== null && !egress!.loginAllowed(lease, login.account)) {
          const account = login.account;
          loginCheck = true;
          egress!.checkLogin(lease, account).then((verdict) => {
            loginCheck = false;
            if (session.closed) return;
            if (verdict === 'new_account_cap' || verdict === 'new_account_unavailable') {
              metrics.reject(`egress_${verdict}`);
              log('warn', 'connect_rejected', { session: id, ip, reason: `egress_${verdict}`, server: session.target?.key ?? null });
              void cleanup(verdict, verdict === 'new_account_cap' ? CLOSE_NEW_ACCOUNT_CAP : CLOSE_NEW_ACCOUNT_UNAVAILABLE);
              return;
            }
            if (verdict === 'moved') {
              // The session's address had made the world's account creations: it is on another slot
              // now. Nothing of this login has left yet, so a socket bound to the old address is
              // replaced (ensureUdp binds the new one).
              dropUdp();
              log('info', 'session_egress_moved', { session: id, ip, ...egressFields() });
            }
            forwardGame(buf);
            for (const b of waiting.splice(0)) handleGame(b);
          }, (err) => {
            loginCheck = false;
            egressFailure('login_check', err);
          });
          return;
        }
      }
      forwardGame(buf);
    }

    /** Close the session's socket; the next forwarded datagram binds a new one at the lease's (current) address. */
    function dropUdp(): void {
      const old = session.udp;
      session.udp = null;
      if (old) { old.removeAllListeners('error'); old.on('error', () => {}); try { old.close(); } catch { /* closed */ } }
    }

    // An egress session the server never answers (no byte NO_REPLY_MOVE_MS after its first datagram)
    // moves once to another address (egress.ts moveForNoReply); the browser keeps resending its login,
    // and the last datagram goes again at once. Never after a reply: AC1999 answers only the address
    // that logged in.
    let noReplyTimer: ReturnType<typeof setTimeout> | null = null;
    let firstUpAt = 0;
    let noReplyMoved = false;
    let lastUp: Buffer | null = null;
    function noReplyCheck(): void {
      noReplyTimer = null;
      if (session.closed || !lease || noReplyMoved || session.bytesFromServer > 0) return;
      // A login check (it may be moving the session itself) finishes first.
      if (loginCheck) { noReplyTimer = setTimeout(noReplyCheck, 1000); noReplyTimer.unref?.(); return; }
      noReplyMoved = true;
      clearEarlyResends();
      const from = { slot: lease.localAddress, publicIp: lease.publicIp };
      egress!.moveForNoReply(lease, () => !session.closed && session.bytesFromServer === 0).then((r) => {
        if (session.closed) return;
        const fields = { session: id, ip, from: from.slot, fromIp: from.publicIp, ms: now() - firstUpAt };
        if ('stay' in r) {
          // A reply came in meanwhile ('answered'), or no address could take it (no_slot, aws:…).
          log(r.stay === 'answered' ? 'info' : 'warn', 'egress_no_reply_stay', { ...fields, reason: r.stay, attached: r.attached });
          return;
        }
        log('info', 'egress_no_reply_move', { ...fields, to: r.to, toIp: r.publicIp });
        dropUdp();
        if (lastUp) forwardGame(lastUp);
      });
    }

    // Early resends (EARLY_RESEND_MS): an egress session with no server byte yet sends its last
    // datagram again 1, 2, 3 and 4 s after its first (before the 5 s no-reply move), each from a NEW
    // socket on the same slot and lease. A login whose grant was lost on the way back is ignored from
    // the same port (AC1999 AcceptClientLogin: same endpoint while Connecting); from a new port the
    // server drops the stale session and answers. The old socket is closed (its late datagrams are
    // never read); the new one is the session's from then on (replies, grant parsing, counters, the
    // disconnect at cleanup). Counted as normal upstream packets. They stop at the first server byte,
    // a close, a move or a slot change, and skip a beat while a login check holds the session.
    const earlyResendTimers: ReturnType<typeof setTimeout>[] = [];
    let earlyResends = 0;
    function clearEarlyResends(): void {
      for (const t of earlyResendTimers.splice(0)) clearTimeout(t);
    }
    function scheduleEarlyResends(): void {
      const slot = lease!.localAddress;
      for (const ms of deps.egressEarlyResendMs ?? EARLY_RESEND_MS) {
        const t = setTimeout(() => {
          if (session.closed || !lease || noReplyMoved || session.bytesFromServer > 0 || lease.localAddress !== slot) { clearEarlyResends(); return; }
          // A login check holds the session's datagrams (and may move it): skip this one.
          if (loginCheck || !lastUp) return;
          earlyResends++;
          const n = earlyResends;
          dropUdp();
          const udp = ensureUdp();
          udp.once('listening', () => log('debug', 'egress_early_resend', { session: id, n, port: udp.address().port }));
          forwardGame(lastUp);
        }, ms);
        t.unref?.();
        earlyResendTimers.push(t);
      }
    }

    function forwardGame(buf: Buffer): void {
      if (session.closed || !session.target) return;
      ensureUdp();
      if (lease) {
        lastUp = buf;
        if (!firstUpAt) {
          firstUpAt = now();
          noReplyTimer = setTimeout(noReplyCheck, deps.egressNoReplyMs ?? NO_REPLY_MOVE_MS);
          noReplyTimer.unref?.();
          scheduleEarlyResends();
        }
      }
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
    }

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
      if (noReplyTimer) { clearTimeout(noReplyTimer); noReplyTimer = null; }
      clearEarlyResends();
      routineTokens.sessionEnded(id);
      release();
      // A lease this session adopted in a handover (release() frees only admission's; handed over: a no-op).
      lease?.release();
      clearInterval(pingInterval);
      upLink.close();
      downLink.close();
      metrics.close(reason);
      log('info', 'session_close', {
        session: id, ip, server: session.target?.key ?? null, reason, ...egressFields(), ...(trace ? { trace } : {}),
        durationMs: now() - session.openedAt,
        bytesFromBrowser: session.bytesFromBrowser, bytesToServer: session.bytesToServer,
        bytesFromServer: session.bytesFromServer, bytesToBrowser: session.bytesToBrowser,
        packetsUp: session.packetsUp, packetsDown: session.packetsDown, dropped: session.dropped,
        ...(typeof peerCloseCode === 'number' ? { peerCloseCode } : {}),
        active: sessions.size,
      });
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        const reasonText = code === CLOSE_NEW_ACCOUNT_CAP ? CLOSE_NEW_ACCOUNT_CAP_REASON
          : code === CLOSE_NEW_ACCOUNT_UNAVAILABLE ? CLOSE_NEW_ACCOUNT_UNAVAILABLE_REASON : undefined;
        try { ws.close(code ?? 1000, reasonText); } catch { /* ignore */ }
      }
      const udp = session.udp;
      if (!udp) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const done = () => { try { udp.close(); } catch { /* ignore */ } resolve(); };
        // Tell the server to free the session now instead of after its 60 s
        // timeout. Needs the right session id + a valid checksum. Not after a
        // handover: the session lives on through the new deployment's socket.
        if (session.aceSessionId !== null && session.target && !handedOver) {
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
      // Waits for AWS work under way and gives back the addresses no process uses (egress.ts stop).
      await egress?.stop().catch((err) => log('error', 'egress_stop_failed', { error: err as Error }));
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      });
      if (capture) await new Promise<void>(r => capture!.end(() => r()));
    },
  };
}
